#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;
mod tray;

use sidecar::SidecarState;

#[tauri::command]
fn sidecar_status(state: tauri::State<'_, SidecarState>) -> sidecar::SidecarStatus {
    state.status.lock().unwrap().clone()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![sidecar_status])
        .setup(|app| {
            tray::setup_tray(app)?;
            if let Err(e) = sidecar::spawn_sidecar(app.handle()) {
                sidecar::fail(app.handle(), format!("sidecar 启动失败：{e}"));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // 关窗 → 隐藏到托盘，mock 服务持续运行
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            // Cmd+Q / 托盘退出：杀掉 sidecar，不留孤儿进程占端口（幂等）
            sidecar::kill_sidecar(handle);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            // macOS 点 Dock 图标重开主窗口
            tray::show_main(handle);
        }
        _ => {}
    });
}
