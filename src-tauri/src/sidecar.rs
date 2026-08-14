//! sidecar 生命周期：spawn、stdout 握手、状态机、终止
//! 协议见 spec docs/superpowers/specs/2026-08-14-tauri-desktop-design.md §4
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const READY_PREFIX: &str = "MOCK_READY ";
const ERROR_PREFIX: &str = "MOCK_ERROR ";
const HANDSHAKE_TIMEOUT_SECS: u64 = 10;
const TAIL_CAPACITY: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub enum Handshake {
    Ready { host: String, port: u16 },
    Error { message: String },
}

#[derive(Clone, serde::Serialize)]
pub struct SidecarStatus {
    pub phase: String, // starting | ready | failed | stopped
    pub url: Option<String>,
    pub message: Option<String>,
    pub tail: Vec<String>,
}

#[derive(Default)]
pub struct SidecarState {
    pub child: Mutex<Option<CommandChild>>,
    pub status: Mutex<SidecarStatus>,
    pub generation: AtomicU64,
    pub exiting: AtomicBool,
    /// 冷启动走事件（loading 页监听）；重启后页面不在 loading 页，需 eval 直接导航
    pub next_ready_via_eval: AtomicBool,
}

impl Default for SidecarStatus {
    fn default() -> Self {
        Self { phase: "starting".into(), url: None, message: None, tail: Vec::new() }
    }
}

// ─── 纯函数（cargo test 覆盖） ───────────────────────────────

/// 解析一行 stdout；非协议行返回 None
pub fn parse_handshake_line(line: &str) -> Option<Handshake> {
    let line = line.trim_end();
    if let Some(json) = line.strip_prefix(READY_PREFIX) {
        #[derive(serde::Deserialize)]
        struct Ready {
            host: String,
            port: u16,
        }
        let r: Ready = serde_json::from_str(json).ok()?;
        if r.host.is_empty() || r.port == 0 {
            return None;
        }
        return Some(Handshake::Ready { host: r.host, port: r.port });
    }
    if let Some(json) = line.strip_prefix(ERROR_PREFIX) {
        #[derive(serde::Deserialize)]
        struct Error {
            message: String,
        }
        let e: Error = serde_json::from_str(json).ok()?;
        return Some(Handshake::Error { message: e.message });
    }
    None
}

/// WebView 导航地址：通配/空 host 不可浏览，一律映射 127.0.0.1
pub fn webview_url(host: &str, port: u16) -> String {
    let h = match host {
        "" | "0.0.0.0" | "::" => "127.0.0.1",
        h => h,
    };
    format!("http://{h}:{port}")
}

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 在当前页面（任意 origin）内嵌一个全屏错误/状态覆盖层
pub fn overlay_js(title: &str, detail: &str) -> String {
    let html = format!(
        "<div style=\"font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0b1020;color:#e6e9f2;text-align:center;padding:24px;box-sizing:border-box\">\
<h1 style=\"font-size:20px;margin:0 0 12px\">{}</h1>\
<pre style=\"max-width:80%;max-height:40vh;overflow:auto;white-space:pre-wrap;color:#9aa3b2;font-size:12px;text-align:left;background:#11162a;padding:12px;border-radius:8px\">{}</pre>\
<p style=\"color:#9aa3b2;font-size:13px\">可从系统托盘菜单「重启服务」恢复</p></div>",
        html_escape(title),
        html_escape(detail)
    );
    format!("document.body.innerHTML = {};", serde_json::to_string(&html).unwrap())
}

// ─── 内部辅助 ────────────────────────────────────────────────

fn push_tail(app: &AppHandle, line: &str) {
    let state = app.state::<SidecarState>();
    let mut st = state.status.lock().unwrap();
    if st.tail.len() >= TAIL_CAPACITY {
        st.tail.remove(0);
    }
    st.tail.push(line.to_string());
}

/// 进入 failed：冷启动 emit 事件（loading 页渲染），重启流程走覆盖层
pub fn fail(app: &AppHandle, message: String) {
    let state = app.state::<SidecarState>();
    let tail = {
        let mut st = state.status.lock().unwrap();
        st.phase = "failed".into();
        st.message = Some(message.clone());
        st.tail.clone()
    };
    if state.next_ready_via_eval.load(Ordering::SeqCst) {
        show_overlay(app, &format!("服务启动失败：{message}"), &tail.join("\n"));
    } else {
        let _ = app.emit("sidecar-error", serde_json::json!({ "message": message, "tail": tail }));
    }
}

fn show_overlay(app: &AppHandle, title: &str, detail: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&overlay_js(title, detail));
    }
}

fn nav_to(app: &AppHandle, url: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("window.location.href = {};", serde_json::to_string(url).unwrap());
        let _ = w.eval(&js);
    }
}

// ─── 生命周期 ────────────────────────────────────────────────

pub fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    {
        let mut st = state.status.lock().unwrap();
        st.phase = "starting".into();
        st.message = None;
        st.tail.clear();
    }
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let cmd = app
        .shell()
        .sidecar("mockserver")
        .map_err(|e| e.to_string())?
        .env("MOCK_DESKTOP", "1");
    let (rx, child) = cmd.spawn().map_err(|e| e.to_string())?;
    *state.child.lock().unwrap() = Some(child);

    let app_reader = app.clone();
    tauri::async_runtime::spawn(async move { read_loop(app_reader, gen, rx).await });

    // 握手超时看门狗
    let app_watchdog = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS)).await;
        let state = app_watchdog.state::<SidecarState>();
        if gen != state.generation.load(Ordering::SeqCst) {
            return; // 已被重启流程接管
        }
        let still_starting = state.status.lock().unwrap().phase == "starting";
        if still_starting {
            fail(&app_watchdog, format!("握手超时：sidecar {HANDSHAKE_TIMEOUT_SECS} 秒内未就绪"));
        }
    });
    Ok(())
}

async fn read_loop(
    app: AppHandle,
    gen: u64,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
) {
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                match parse_handshake_line(&line) {
                    Some(Handshake::Ready { host, port }) => {
                        let url = webview_url(&host, port);
                        let state = app.state::<SidecarState>();
                        {
                            let mut st = state.status.lock().unwrap();
                            st.phase = "ready".into();
                            st.url = Some(url.clone());
                            st.message = None;
                        }
                        if state.next_ready_via_eval.load(Ordering::SeqCst) {
                            nav_to(&app, &url); // 重启：页面不在 loading，直接导航
                        } else {
                            let _ = app.emit("sidecar-ready", serde_json::json!({ "url": url }));
                        }
                    }
                    Some(Handshake::Error { message }) => fail(&app, message),
                    None => push_tail(&app, &line),
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                push_tail(&app, &line);
            }
            CommandEvent::Terminated(_) => {
                let state = app.state::<SidecarState>();
                let expected = state.exiting.load(Ordering::SeqCst)
                    || gen != state.generation.load(Ordering::SeqCst);
                if expected {
                    break; // 用户退出 / 重启流程杀掉的旧进程
                }
                let phase = state.status.lock().unwrap().phase.clone();
                if phase == "ready" {
                    state.status.lock().unwrap().phase = "stopped".into();
                    let tail = state.status.lock().unwrap().tail.join("\n");
                    show_overlay(&app, "mock 服务已停止", &tail);
                } else if phase == "starting" {
                    fail(&app, "sidecar 意外退出".into());
                }
                break;
            }
            _ => {}
        }
    }
}

pub fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.exiting.store(true, Ordering::SeqCst);
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    };
}

pub fn restart_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    state.next_ready_via_eval.store(true, Ordering::SeqCst);
    if let Err(e) = spawn_sidecar(app) {
        fail(app, format!("sidecar 启动失败：{e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ready_line() {
        assert_eq!(
            parse_handshake_line("MOCK_READY {\"host\":\"127.0.0.1\",\"port\":5050}"),
            Some(Handshake::Ready { host: "127.0.0.1".into(), port: 5050 })
        );
    }

    #[test]
    fn parse_ready_strips_crlf() {
        assert_eq!(
            parse_handshake_line("MOCK_READY {\"host\":\"127.0.0.1\",\"port\":5051}\r\n"),
            Some(Handshake::Ready { host: "127.0.0.1".into(), port: 5051 })
        );
    }

    #[test]
    fn parse_error_line() {
        assert_eq!(
            parse_handshake_line("MOCK_ERROR {\"message\":\"端口耗尽\"}"),
            Some(Handshake::Error { message: "端口耗尽".into() })
        );
    }

    #[test]
    fn ignores_non_protocol_and_malformed_lines() {
        assert_eq!(parse_handshake_line("[mock-server] WebUI bound to http://127.0.0.1:5050"), None);
        assert_eq!(parse_handshake_line(""), None);
        assert_eq!(parse_handshake_line("MOCK_READY 这不是json"), None);
        assert_eq!(parse_handshake_line("MOCK_READY {\"host\":\"\",\"port\":5050}"), None);
        assert_eq!(parse_handshake_line("MOCK_READY {\"host\":\"127.0.0.1\",\"port\":0}"), None);
        // port 超出 u16 反序列化失败 → None
        assert_eq!(parse_handshake_line("MOCK_READY {\"host\":\"127.0.0.1\",\"port\":70000}"), None);
    }

    #[test]
    fn webview_url_maps_wildcard_host() {
        assert_eq!(webview_url("0.0.0.0", 5050), "http://127.0.0.1:5050");
        assert_eq!(webview_url("::", 5050), "http://127.0.0.1:5050");
        assert_eq!(webview_url("", 5050), "http://127.0.0.1:5050");
        assert_eq!(webview_url("127.0.0.1", 5050), "http://127.0.0.1:5050");
        assert_eq!(webview_url("10.100.2.31", 5050), "http://10.100.2.31:5050");
    }

    #[test]
    fn html_escape_basic() {
        assert_eq!(html_escape("a<b>&c"), "a&lt;b&gt;&amp;c");
    }

    #[test]
    fn overlay_js_escapes_injected_content() {
        let js = overlay_js("mock 服务已停止", "line <1> & \"two\"");
        assert!(js.starts_with("document.body.innerHTML = "));
        assert!(!js.contains("<1>"));
        assert!(js.contains("&lt;1&gt;"));
    }
}
