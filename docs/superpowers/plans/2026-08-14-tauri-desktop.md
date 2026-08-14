# Tauri 桌面化（壳 + Bun sidecar）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 mock-server-webui 从"启动后自动开浏览器"桌面化为标准桌面软件：Tauri 2 壳 + 现有 Bun 单文件可执行 sidecar，4 平台安装包进 CI Release。

**Architecture:** Tauri 壳 spawn Bun sidecar（`MOCK_DESKTOP=1`），sidecar listen 成功后在 stdout 打印 `MOCK_READY {"host","port"}`，壳解析后让 WebView 导航到 `http://<host>:<port>`；前端 `public/` 与 `src/` 业务代码零改动。关窗隐藏到托盘，托盘菜单负责显示/重启/退出。

**Tech Stack:** Tauri 2（tauri-plugin-shell、tauri-plugin-single-instance）· Rust 1.77+ · Bun（sidecar 构建，已有）· vitest（server.js 测试）· cargo test（壳单测）

**Spec:** `docs/superpowers/specs/2026-08-14-tauri-desktop-design.md`（已获用户批准）

## Global Constraints

- **不改 `public/`、`src/` 任何文件**；唯一改动行为的现有源码文件是 `server.js`（加 `desktop` 分支）
- macOS **不签名不公证**；Windows 只出 NSIS `.exe`，不出 MSI
- 协议前缀严格为 `MOCK_READY ` / `MOCK_ERROR `（前缀后各一个空格 + 单行 JSON）
- WebView 导航地址规则：`host` 为 `0.0.0.0` / `::` / 空 时一律用 `127.0.0.1`
- sidecar 二进制按 Tauri 约定命名：`src-tauri/binaries/mockserver-<target-triple>[.exe]`
- 提交信息用**中文**，格式 `<type>: <描述>`
- 现有 `pnpm test` / `pnpm test:e2e` 保持全绿；E2E 依旧 headed，不切 headless
- 每个 Task 完成后按该 Task 的 commit 步骤单独提交

---

### Task 1: server.js 桌面模式（MOCK_READY / MOCK_ERROR 握手输出）

**Files:**
- Modify: `server.js`（`startServer` 签名与尾部 + `isMain` 块）
- Test: `test/integration/desktop-mode.test.js`（新建）

**Interfaces:**
- Consumes: 现有 `startServer({storagePath, uiPort, openBrowser, host, publicPath})`；`test/helpers/temp-dir.js` 的 `tempDir(prefix) → {path, cleanup}`
- Produces: `startServer` 新增可选参数 `desktop = false`；`desktop: true` 时 listen 成功后向 stdout 打印一行 `MOCK_READY {"host":"<finalHost>","port":<actualPort>}`。`isMain` 入口读取 `process.env.MOCK_DESKTOP`：置 `desktop: true, openBrowser: false`；启动失败时打印 `MOCK_ERROR {"message":"..."}` 再以退出码 1 退出。后续 Task 3 的 Rust 壳按此协议解析。

- [ ] **Step 1: 写失败的测试**

新建 `test/integration/desktop-mode.test.js`：

```js
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server.js';
import { tempDir } from '../helpers/temp-dir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let handle, dir;

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  if (dir) dir.cleanup();
  dir = undefined;
});

/** 收集子进程 stdout 直到出现指定前缀的行（或退出/超时） */
function waitForLine(child, prefix, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`等待 ${prefix} 超时，已收到：${buf}`)), timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').map((l) => l.trim()).find((l) => l.startsWith(prefix));
      if (line) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`进程退出(${code})，未收到 ${prefix}，输出：${buf}`));
    });
  });
}

function spawnDesktop(extraEnv) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, MOCK_DESKTOP: '1', ...extraEnv },
  });
}

describe('desktop 模式（MOCK_DESKTOP）', () => {
  it('startServer({desktop:true}) 打印 MOCK_READY，端口为实际绑定端口且可服务', async () => {
    dir = tempDir('mock-desktop-');
    const lines = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
      lines.push(String(chunk));
      return origWrite(chunk, ...args);
    };
    try {
      handle = await startServer({ storagePath: dir.path, uiPort: 0, openBrowser: false, desktop: true });
    } finally {
      process.stdout.write = origWrite;
    }

    const readyLine = lines.map((l) => l.trim()).find((l) => l.startsWith('MOCK_READY '));
    expect(readyLine).toBeTruthy();
    const payload = JSON.parse(readyLine.slice('MOCK_READY '.length));
    expect(payload.host).toBe('127.0.0.1');
    expect(payload.port).toBe(handle.port);

    const res = await fetch(`http://127.0.0.1:${payload.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it('MOCK_DESKTOP=1 子进程经 isMain 入口启动，stdout 输出 MOCK_READY', async () => {
    dir = tempDir('mock-desktop-');
    const child = spawnDesktop({ HOME: dir.path });
    try {
      const readyLine = await waitForLine(child, 'MOCK_READY ');
      const payload = JSON.parse(readyLine.slice('MOCK_READY '.length));
      const res = await fetch(`http://127.0.0.1:${payload.port}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('启动失败时打印 MOCK_ERROR 并以非零码退出', async () => {
    dir = tempDir('mock-desktop-');
    // defaultStoragePath() 回退逻辑：~/Documents 不是目录 → 用 ~/MockServer；
    // 两个候选都做成"已存在的普通文件"，ensureDir 必然抛错
    fs.writeFileSync(path.join(dir.path, 'Documents'), 'not a dir');
    fs.writeFileSync(path.join(dir.path, 'MockServer'), 'not a dir');
    const child = spawnDesktop({ HOME: dir.path });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    const errLine = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('MOCK_ERROR '));
    expect(errLine).toBeTruthy();
    expect(JSON.parse(errLine.slice('MOCK_ERROR '.length)).message).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/desktop-mode.test.js`
Expected: FAIL — 3 个用例全败（`MOCK_READY` 行不存在；`MOCK_ERROR` 行不存在；第二个用例 `waitForLine` 超时）

- [ ] **Step 3: 实现 server.js 桌面模式**

`server.js` 第 27 行签名加 `desktop = false`：

```js
export async function startServer({ storagePath, uiPort, openBrowser = true, host, publicPath, desktop = false } = {}) {
```

在 `const port = server.address().port;`（第 89 行）之后、打印 connection hints 之前插入：

```js
  // 桌面壳握手协议（spec: docs/superpowers/specs/2026-08-14-tauri-desktop-design.md §4）
  // 必须打在 hints 之前，壳拿到就绪行即可导航，其余输出进入壳的 tail 缓冲
  if (desktop) {
    console.log(`MOCK_READY ${JSON.stringify({ host: finalHost, port })}`);
  }
```

`isMain` 块（第 147–153 行）改为：

```js
const isMain = import.meta.url === `file://${process.argv[1]}` || !!process.env.MOCK_SERVER_DIR;
if (isMain) {
  const desktop = !!process.env.MOCK_DESKTOP;
  startServer({ openBrowser: !desktop, desktop }).catch((e) => {
    if (desktop) console.log(`MOCK_ERROR ${JSON.stringify({ message: e.message })}`);
    console.error('Failed to start:', e.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/desktop-mode.test.js`
Expected: PASS（3 passed）

- [ ] **Step 5: 跑全量单测+集成确认无回归**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add server.js test/integration/desktop-mode.test.js
git commit -m "feat: server.js 桌面模式握手协议（MOCK_READY/MOCK_ERROR）"
```

---

### Task 2: Tauri 壳骨架（可打开的窗口 + loading 页 + sidecar 准备脚本）

**Files:**
- Create: `src-tauri/Cargo.toml`、`src-tauri/build.rs`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`src-tauri/src/main.rs`、`src-tauri/ui/loading.html`、`src-tauri/binaries/.gitkeep`
- Create: `src-tauri/icons/*`（由 `pnpm tauri icon` 生成）
- Create: `scripts/prepare-sidecar.mjs`
- Modify: `package.json`（devDependencies + scripts）
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 现有 `build.mjs`（`bun build.mjs` 当前平台产物 `mockserver`）；`public/favicon.svg`（图标源）
- Produces: `pnpm dev:desktop` / `pnpm build:desktop` / `pnpm sidecar:prepare` 三条 script；`src-tauri/binaries/mockserver-<host-triple>` 本机 sidecar；Task 3 将替换 `main.rs` 接入 sidecar spawn。`tauri.conf.json` 的 `bundle.externalBin: ["binaries/mockserver"]` 是壳与 sidecar 的契约。

- [ ] **Step 1: 安装 Tauri CLI**

Run: `pnpm add -D @tauri-apps/cli@^2`
Expected: package.json devDependencies 出现 `@tauri-apps/cli`（当前最新 2.x）

- [ ] **Step 2: 创建 src-tauri 骨架文件**

`src-tauri/Cargo.toml`：

```toml
[package]
name = "mockserver-desktop"
version = "1.1.0"
edition = "2021"
rust-version = "1.77"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["time"] }

[profile.release]
strip = true
lto = true
```

`src-tauri/build.rs`：

```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/tauri.conf.json`（`version` 由 CI 同步 package.json，本地先写当前版本）：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "MockServer",
  "version": "1.1.0",
  "identifier": "com.mockserver.desktop",
  "build": {
    "frontendDist": "./ui"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "label": "main",
        "title": "MockServer",
        "width": 1280,
        "height": 800,
        "minWidth": 960,
        "minHeight": 600
      }
    ]
  },
  "bundle": {
    "active": true,
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "externalBin": ["binaries/mockserver"]
  }
}
```

`src-tauri/capabilities/default.json`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "默认能力：主窗口 + sidecar 执行权限",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    {
      "identifier": "shell:allow-execute",
      "allow": [{ "name": "binaries/mockserver", "sidecar": true, "args": true }]
    }
  ]
}
```

`src-tauri/src/main.rs`（骨架 —— Task 3 接入 sidecar、Task 4 加托盘/单实例，均为整文件替换）：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`src-tauri/ui/loading.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MockServer</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0b1020; color: #e6e9f2; }
  .wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; text-align: center; }
  .spinner { width: 36px; height: 36px; border: 3px solid #2a3350; border-top-color: #6f7bf7; border-radius: 50%; animation: spin 0.9s linear infinite; margin-bottom: 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
  .sub { color: #9aa3b2; font-size: 13px; margin: 0; }
  pre { margin-top: 16px; max-width: 80%; max-height: 40vh; overflow: auto; white-space: pre-wrap; text-align: left; color: #9aa3b2; font-size: 12px; background: #11162a; padding: 12px; border-radius: 8px; }
</style>
</head>
<body>
  <main class="wrap">
    <div class="spinner" id="spinner"></div>
    <h1 id="title">MockServer 正在启动…</h1>
    <p class="sub" id="subtitle">等待 mock 服务就绪</p>
    <pre id="detail" hidden></pre>
  </main>
  <script>
    const { event, core } = window.__TAURI__;
    const $ = (id) => document.getElementById(id);
    function showError(title, detail) {
      $('spinner').style.display = 'none';
      $('title').textContent = title;
      $('subtitle').textContent = '可关闭窗口后从系统托盘菜单「重启服务」重试';
      if (detail) {
        const d = $('detail');
        d.hidden = false;
        d.textContent = detail;
      }
    }
    event.listen('sidecar-ready', (e) => { window.location.href = e.payload.url; });
    event.listen('sidecar-error', (e) => showError(e.payload.message || '服务启动失败', (e.payload.tail || []).join('\n')));
    // 兜底：事件先于本页加载到达时，主动拉一次状态
    core.invoke('sidecar_status').then((s) => {
      if (s.phase === 'ready') window.location.href = s.url;
      else if (s.phase === 'failed') showError(s.message, (s.tail || []).join('\n'));
    });
  </script>
</body>
</html>
```

`src-tauri/binaries/.gitkeep`：空文件。

- [ ] **Step 3: 生成应用图标**

Run: `pnpm tauri icon public/favicon.svg`
Expected: `src-tauri/icons/` 下生成 `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`、`icon.ico` 等

若 CLI 报 SVG 不支持，执行备选（macOS 自带 qlmanage 栅格化）：

```bash
qlmanage -t -s 1024 -o /tmp public/favicon.svg
pnpm tauri icon /tmp/favicon.svg.png
```

- [ ] **Step 4: 创建 sidecar 准备脚本**

`scripts/prepare-sidecar.mjs`：

```js
// 构建本机 sidecar 并按 Tauri 约定放入 src-tauri/binaries/mockserver-<host-triple>
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = process.platform === 'win32' ? '.exe' : '';

let triple;
try {
  triple = execSync('rustc --print host-tuple').toString().trim();
} catch {
  console.error('[prepare-sidecar] 未找到 rustc，请先安装 Rust：https://rustup.rs');
  process.exit(1);
}

console.log('[prepare-sidecar] bun build.mjs 构建本机 sidecar…');
execSync('bun build.mjs', { cwd: root, stdio: 'inherit' });

const built = [path.join(root, `mockserver${ext}`), path.join(root, 'mockserver')].find((p) => fs.existsSync(p));
if (!built) {
  console.error('[prepare-sidecar] 未找到构建产物 mockserver');
  process.exit(1);
}

const destDir = path.join(root, 'src-tauri', 'binaries');
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, `mockserver-${triple}${ext}`);
fs.copyFileSync(built, dest);
console.log(`[prepare-sidecar] sidecar → ${path.relative(root, dest)}`);
```

- [ ] **Step 5: package.json 加 scripts**

在 `scripts` 块追加（保持现有条目不变）：

```json
    "tauri": "tauri",
    "sidecar:prepare": "node scripts/prepare-sidecar.mjs",
    "dev:desktop": "node scripts/prepare-sidecar.mjs && pnpm tauri dev",
    "build:desktop": "node scripts/prepare-sidecar.mjs && pnpm tauri build"
```

- [ ] **Step 6: .gitignore 追加**

在 `.gitignore` 末尾追加：

```
# Tauri 壳
src-tauri/target/
src-tauri/gen/
src-tauri/binaries/*
!src-tauri/binaries/.gitkeep
```

- [ ] **Step 7: 验证编译与窗口**

Run: `pnpm sidecar:prepare`（产出 `src-tauri/binaries/mockserver-aarch64-apple-darwin`）
Expected: 输出 `sidecar → src-tauri/binaries/mockserver-aarch64-apple-darwin`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 编译成功（0 tests 也算通过，此时壳还没有测试）

Run: `pnpm tauri dev`
Expected: 弹出 MockServer 窗口，显示 loading 页「MockServer 正在启动…」（永不跳转是**预期行为** —— Task 3 才接入握手）。确认后 Ctrl+C 停止。

- [ ] **Step 8: Commit**

```bash
git add src-tauri scripts/prepare-sidecar.mjs package.json pnpm-lock.yaml .gitignore
git commit -m "feat: Tauri 壳骨架（窗口 + loading 页 + sidecar 准备脚本）"
```

---

### Task 3: sidecar.rs —— stdout 握手协议与状态管理

**Files:**
- Create: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/src/main.rs`（整文件替换）

**Interfaces:**
- Consumes: Task 1 的 `MOCK_READY {"host","port"}` / `MOCK_ERROR {"message"}` 协议；Task 2 的 `externalBin: ["binaries/mockserver"]`、capabilities 中的 `shell:allow-execute` sidecar 权限、loading.html 的 `sidecar-ready`/`sidecar-error` 事件监听与 `sidecar_status` command
- Produces（Task 4 依赖这些名字，不得改名）:
  - `SidecarState`（`tauri::Manager` manage 的状态；字段：`child: Mutex<Option<CommandChild>>`、`status: Mutex<SidecarStatus>`、`generation: AtomicU64`、`exiting: AtomicBool`、`next_ready_via_eval: AtomicBool`）
  - `SidecarStatus { phase: String, url: Option<String>, message: Option<String>, tail: Vec<String> }`（Clone + Serialize；phase 取值 `starting|ready|failed|stopped`）
  - `spawn_sidecar(app: &AppHandle) -> Result<(), String>`、`kill_sidecar(app: &AppHandle)`、`restart_sidecar(app: &AppHandle)`、`fail(app: &AppHandle, message: String)`
  - 纯函数：`parse_handshake_line(&str) -> Option<Handshake>`、`webview_url(host, port) -> String`、`overlay_js(title, detail) -> String`、`html_escape(&str) -> String`
  - 事件：`sidecar-ready {url}`、`sidecar-error {message, tail}`；command：`sidecar_status() -> SidecarStatus`

- [ ] **Step 1: 写 sidecar.rs（含 cargo 单测）**

`src-tauri/src/sidecar.rs`：

```rust
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
    }
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
```

- [ ] **Step 2: 整文件替换 main.rs，接入 sidecar**

`src-tauri/src/main.rs`：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use sidecar::SidecarState;

#[tauri::command]
fn sidecar_status(state: tauri::State<'_, SidecarState>) -> sidecar::SidecarStatus {
    state.status.lock().unwrap().clone()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![sidecar_status])
        .setup(|app| {
            if let Err(e) = sidecar::spawn_sidecar(app.handle()) {
                sidecar::fail(app.handle(), format!("sidecar 启动失败：{e}"));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: 跑壳单测**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS（7 个测试全过）

- [ ] **Step 4: 端到端验证握手跳转**

前置：`src-tauri/binaries/mockserver-aarch64-apple-darwin` 已存在（Task 2 Step 7 已产出；且该产物包含 Task 1 的桌面模式 —— 若 Task 1 之后未重新跑过 `pnpm sidecar:prepare`，先补跑）。

Run: `pnpm tauri dev`
Expected: 窗口先显示 loading 页，**1–2 秒内自动跳转到 MockServer 首页**（端口卡片页）。确认后 Ctrl+C。

再验证崩溃覆盖层：`pnpm tauri dev` 启动后，另开终端 `pkill -f mockserver-aarch64-apple-darwin` → 窗口应显示「mock 服务已停止」覆盖层。Ctrl+C 停止。

- [ ] **Step 5: 确认现有测试无回归**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/main.rs
git commit -m "feat: sidecar stdout 握手解析与生命周期状态机"
```

---

### Task 4: 托盘菜单、关窗隐藏、单实例与退出清理

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/main.rs`（整文件替换为终态）

**Interfaces:**
- Consumes: Task 3 的 `sidecar::{spawn_sidecar, kill_sidecar, restart_sidecar, fail, SidecarState}`、`sidecar_status` command
- Produces: `tray::setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>>`、`tray::show_main(app: &tauri::AppHandle)`；托盘菜单 id：`show` / `restart` / `quit`

- [ ] **Step 1: 写 tray.rs**

`src-tauri/src/tray.rs`：

```rust
//! 系统托盘：显示主窗口 / 重启服务 / 退出
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Manager};

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &restart, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true) // macOS 深浅色自适应；其他平台无效
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "restart" => crate::sidecar::restart_sidecar(app),
            "quit" => {
                crate::sidecar::kill_sidecar(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
```

- [ ] **Step 2: 整文件替换 main.rs 为终态**

`src-tauri/src/main.rs`：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;
mod tray;

use sidecar::SidecarState;
use tauri::Manager;

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
```

- [ ] **Step 3: 编译 + 单测**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS（7 个测试，编译无警告以外的错误）

- [ ] **Step 4: 手工验收（GUI 行为，逐项过）**

Run: `pnpm tauri dev`，然后逐项验证（对应 spec §8 手工清单）：

1. **冷启动**：loading 页 → 自动进入首页 ✓
2. **关窗到托盘**：点窗口红色关闭钮 → 窗口消失但进程仍在；终端 `curl -s http://127.0.0.1:<port>/api/health` 返回 `{"ok":true}`（port 取握手实际端口；若 5050 空闲即 5050）；托盘菜单「显示主窗口」恢复窗口
3. **崩溃与重启**：`pkill -f mockserver-aarch64-apple-darwin` → 覆盖层「mock 服务已停止」；托盘「重启服务」→ 窗口自动跳回应用首页
4. **单实例**：`pnpm tauri dev` 运行中，另开终端执行 `open -n "$(pwd)/src-tauri/target/debug/mockserver-desktop"`（或直接再点应用图标）→ 不启动第二个实例，已有窗口被聚焦
5. **退出清理**：托盘「退出」→ `pgrep -f mockserver-aarch64-apple-darwin` 无输出（sidecar 已死；注意不能用 `pgrep -f mockserver`，会匹配到壳自身 `mockserver-desktop`）、`lsof -i :<port>` 无输出
6. **端口回退**：先 `pnpm start` 占用 5050（浏览器模式，另开终端），再 `pnpm tauri dev` → 桌面版仍正常进入首页（sidecar 回退到 5051+，握手上报真实端口）。验证后停掉浏览器模式

注：3、4 中 GUI 部分若执行环境不便操作，至少完成 1、2、5、6 并在检查点向用户说明跳过项。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tray.rs src-tauri/src/main.rs
git commit -m "feat: 托盘菜单、关窗隐藏到托盘、单实例与退出清理"
```

---

### Task 5: CI 4 平台安装包管线 + 本地打包验证 + 文档更新

**Files:**
- Modify: `.github/workflows/release.yml`（新增 `desktop` job；`release` job 改 `needs`、附件与 body）
- Modify: `CLAUDE.md`（常用命令 + 架构一节）
- Modify: `README.md`（脚本表）

**Interfaces:**
- Consumes: 现有 `build` job 的 4 个 artifact（`mockserver-mac-arm64` / `mockserver-mac-x64` / `mockserver-win-x64.exe` / `mockserver-win-arm64.exe`）；Task 2–4 的 `src-tauri/`
- Produces: Release 追加 4 个安装包（2 dmg + 2 NSIS exe）；`pnpm build:desktop` 本地出 dmg

- [ ] **Step 1: 本地验证完整打包**

Run: `pnpm build:desktop`
Expected: 成功产出 `src-tauri/target/release/bundle/dmg/MockServer_1.1.0_aarch64.dmg`（版本号以 tauri.conf.json 为准）。双击 dmg 挂载、拖出 MockServer.app，右键→打开 → 走 Task 4 Step 4 的 1、2、5 冒烟一遍。

- [ ] **Step 2: 更新 release.yml**

在 `build` job 之后新增 `desktop` job，并把 `release` job 的 `needs: build` 改为 `needs: [build, desktop]`。新增 job 完整内容：

```yaml
  desktop:
    name: 桌面安装包 (${{ matrix.asset_name }})
    needs: build
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14
            sidecar_artifact: mockserver-mac-arm64
            triple: aarch64-apple-darwin
            bundles: dmg
            asset_name: mac-arm64
          - os: macos-13
            sidecar_artifact: mockserver-mac-x64
            triple: x86_64-apple-darwin
            bundles: dmg
            asset_name: mac-x64
          - os: windows-latest
            sidecar_artifact: mockserver-win-x64.exe
            triple: x86_64-pc-windows-msvc
            bundles: nsis
            asset_name: win-x64
          - os: windows-latest
            sidecar_artifact: mockserver-win-arm64.exe
            triple: aarch64-pc-windows-msvc
            bundles: nsis
            asset_name: win-arm64
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: 安装依赖
        run: pnpm install --frozen-lockfile

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.triple }}

      - name: 下载 sidecar 产物
        uses: actions/download-artifact@v4
        with:
          name: ${{ matrix.sidecar_artifact }}
          path: sidecar-stage

      - name: 放置 sidecar（按 target triple 命名）
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p src-tauri/binaries
          SRC=$(find sidecar-stage -type f | head -1)
          case "${{ matrix.triple }}" in
            *windows*) EXT=.exe ;;
            *) EXT= ;;
          esac
          cp "$SRC" "src-tauri/binaries/mockserver-${{ matrix.triple }}${EXT}"
          chmod +x "src-tauri/binaries/mockserver-${{ matrix.triple }}${EXT}" || true
          ls -la src-tauri/binaries

      - name: 同步版本号到 tauri.conf.json
        run: |
          node -e "const fs=require('fs');const v=JSON.parse(fs.readFileSync('package.json','utf8')).version;const p='src-tauri/tauri.conf.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.version=v;fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n')"

      - name: 壳单元测试
        run: cargo test --manifest-path src-tauri/Cargo.toml

      - name: tauri build
        run: pnpm tauri build --target ${{ matrix.triple }} --bundles ${{ matrix.bundles }}

      - name: 上传安装包
        uses: actions/upload-artifact@v4
        with:
          name: desktop-${{ matrix.asset_name }}
          path: |
            src-tauri/target/${{ matrix.triple }}/release/bundle/dmg/*.dmg
            src-tauri/target/${{ matrix.triple }}/release/bundle/nsis/*.exe
          if-no-files-found: error
```

`release` job 的改动：

1. `needs: build` → `needs: [build, desktop]`
2. `files:` 列表追加两行：

```yaml
            artifacts/*.dmg
            artifacts/*-setup.exe
```

3. body 的下载表上方插入桌面版表格，并把 macOS 未签名说明加进「运行」段。body 完整替换为：

```yaml
          body: |
            ## 桌面版（推荐）

            标准桌面应用：独立窗口、关窗最小化到托盘、托盘菜单可重启服务。

            | 平台 | 文件 |
            |---|---|
            | macOS (Apple Silicon) | `MockServer_*_aarch64.dmg` |
            | macOS (Intel) | `MockServer_*_x64.dmg` |
            | Windows (x64) | `MockServer_*_x64-setup.exe` |
            | Windows (ARM) | `MockServer_*_arm64-setup.exe` |

            > macOS 未签名：首次打开请右键 App →「打开」。

            ## 命令行版（单文件可执行）

            | 平台 | 文件 |
            |---|---|
            | macOS (Apple Silicon) | `mockserver-mac-arm64` |
            | macOS (Intel) | `mockserver-mac-x64` |
            | Windows (x64) | `mockserver-win-x64.exe` |
            | Windows (ARM) | `mockserver-win-arm64.exe` |

            ## 校验

            ```bash
            sha256sum -c SHA256SUMS
            ```

            ## 运行（命令行版）

            ```bash
            # macOS
            chmod +x mockserver-mac-arm64
            ./mockserver-mac-arm64

            # Windows
            mockserver-win-x64.exe
            ```

            首次启动会在 `~/Documents/mock-server-webui-trace.log` 写调试日志。
            默认监听 `http://127.0.0.1:5050`，自动打开浏览器。

            > LAN 访问：`MOCK_HOST=0.0.0.0 ./mockserver-mac-arm64`
```

同时把「生成 SHA256SUMS」步骤的 `sha256sum mockserver-* > SHA256SUMS` 改为：

```bash
          cd artifacts
          sha256sum mockserver-* *.dmg *-setup.exe > SHA256SUMS
          cat SHA256SUMS
```

- [ ] **Step 3: 校验 workflow YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('YAML OK')"`
Expected: 输出 `YAML OK`

注：CI 实际构建验证只能靠推送到 main 或 `workflow_dispatch` 手动触发（与现有 release 流程一致），在 PR/合并后观察 Actions。

- [ ] **Step 4: 更新 CLAUDE.md**

在「常用命令」的打包代码块后追加：

```bash
# 桌面版（Tauri 壳 + Bun sidecar）
pnpm dev:desktop            # 构建本机 sidecar + tauri dev（窗口模式调试）
pnpm build:desktop          # 本机打包（macOS 出 .dmg）
pnpm sidecar:prepare        # 只重建 src-tauri/binaries/ 下的 sidecar
```

在「架构」一节的进程启动链代码块后追加一段：

```
桌面模式：Tauri 壳（src-tauri/）spawn Bun sidecar（MOCK_DESKTOP=1），sidecar listen 成功打印
MOCK_READY {"host","port"}，壳解析后 WebView 导航到该地址；关窗隐藏到托盘，托盘菜单
负责显示/重启/退出。握手协议细节见 docs/superpowers/specs/2026-08-14-tauri-desktop-design.md。
```

在「关键不变量」末尾追加一条：

```
9. **桌面壳只碰进程生命周期**：src-tauri/ 不得引入 mock 业务逻辑；sidecar 协议行（MOCK_READY/MOCK_ERROR）改动必须同步更新 src-tauri/src/sidecar.rs 的 parse_handshake_line。
```

- [ ] **Step 5: 更新 README.md 脚本表**

在「🧪 脚本」表格末尾追加两行：

```markdown
| `pnpm dev:desktop` | 桌面模式调试（Tauri 窗口，自动构建 sidecar） |
| `pnpm build:desktop` | 本机打包桌面安装包（macOS 出 .dmg） |
```

- [ ] **Step 6: 最终回归**

Run: `pnpm test`
Expected: 全部 PASS

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 7 passed

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/release.yml CLAUDE.md README.md
git commit -m "ci: Tauri 桌面安装包四平台构建发布 + 文档更新"
```

---

## 自查记录（plan 作者填写）

- **Spec 覆盖**：spec §4.1/4.2 协议 → Task 1；§4.3/4.4/4.5 握手与生命周期 → Task 3；§5 窗口/托盘/单实例 → Task 4（图标在 Task 2 Step 3）；§6 CI/dev 共存 → Task 2（scripts）+ Task 5（CI）；§7 错误处理 → Task 3（fail/overlay/看门狗）；§8 server 测试 → Task 1，cargo 测试 → Task 3/4，手工清单 → Task 4 Step 4
- **与 spec 的有意偏差**：spec §4.4 说"emit sidecar-stopped 事件让页面提示"。实现改为壳用 `window.eval` 注入覆盖层（`overlay_js`）——页面可能停在业务页（非 loading 页），事件无人监听，eval 注入在任意 origin 都可达且无时序竞争。UX 结果一致（窗口显示"服务已停止"+托盘重启指引）
- **CommandChild::kill 说明**：tauri-plugin-shell 只暴露 kill（Unix SIGKILL / Windows TerminateProcess），无 SIGTERM 通道。mock 服务写入均走 ConfigStore 原子写，强杀无数据损坏风险，spec §4.5 的"2s 宽限后强杀"收敛为直接 kill
