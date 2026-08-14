# Tauri 桌面化（壳 + Bun sidecar）— 设计

**日期**：2026-08-14
**状态**：待用户审查
**目标版本**：mock-server-webui v1 增量

---

## 1. 背景与目标

当前分发形态是 Bun 单文件可执行：启动后监听 `127.0.0.1:5050` 并自动打开系统浏览器。用户期望它表现为一个**标准桌面软件**（类似 cc-switch）：双击打开有独立窗口、关窗后服务继续在后台跑、托盘可控、安装包分发。

**目标**：

1. 用 **Tauri 2** 做桌面壳，窗口加载本地 mock 服务的 WebUI，体验与浏览器模式一致
2. 复用现有 **Bun 单文件可执行作为 sidecar**（后端零重写），壳通过 stdout 行协议完成端口握手
3. 桌面标配能力：关窗最小化到托盘、托盘菜单（显示窗口 / 重启服务 / 退出）、单实例
4. CI 在现有 Bun 构建之上新增 Tauri 打包，4 平台出安装包；裸可执行继续发布，两条分发线共存
5. 现有 dev 工作流（`pnpm start` 浏览器模式）完全不变

**非目标（本次不做）**：

- 不做 macOS 开发者签名 / 公证（首次打开需右键→打开，Release 说明写明）
- 不做开机自启（后续可加 `tauri-plugin-autostart`）
- 不做后端 Rust 重写；sidecar 永远是现有 Bun 产物
- 不改 `public/` 前端与 `src/` 任何业务逻辑（`server.js` 仅加桌面模式分支）
- 不做 Windows MSI，只出 NSIS `.exe` 安装包

---

## 2. 已确认的需求决策

以下决策来自与用户的逐项澄清：

| # | 决策 |
|---|---|
| 1 | 平台：**macOS（arm64 + x64）+ Windows（x64 + arm64）4 平台全出** |
| 2 | macOS **不签名不公证**，首次打开走「右键→打开」绕过 Gatekeeper |
| 3 | 关窗行为：**最小化到托盘**，mock 服务持续运行 |
| 4 | **单实例**（`tauri-plugin-single-instance`，二次启动聚焦已有窗口）；**不做开机自启** |
| 5 | 壳 ↔ sidecar 握手采用 **stdout 行协议**（对比过「固定端口+健康轮询」「Tauri 自定义协议」，见 §9 取舍记录） |

---

## 3. 总体架构

```
┌────────────────────────────────────────────────────┐
│ Tauri 壳（新增 src-tauri/，Rust，约 200 行）        │
│  ├─ main.rs     入口、Setup、RunEvent 分发          │
│  ├─ sidecar.rs  spawn / stdout 握手 / 监视 / 终止   │
│  ├─ tray.rs     托盘菜单（显示窗口/重启服务/退出）  │
│  └─ ui/loading.html  内嵌加载页+错误页（壳本地资源）│
│        │ spawn，环境变量 MOCK_DESKTOP=1             │
│        ▼ stdout 行协议                              │
│ sidecar：现有 Bun 单文件可执行                       │
│   （server.js 加桌面模式分支，其余零改动）           │
│        │ listen 127.0.0.1:<port>（沿用 +50 回退）   │
│        ▼                                            │
│ WebView navigate 到 http://<host>:<port>            │
│   （public/ 前端零改动，API/SSE 全部走 HTTP 原样工作）│
└────────────────────────────────────────────────────┘
```

**边界原则**：壳只管进程生命周期与窗口，不碰任何 mock 业务逻辑；sidecar 不知道自己在桌面壳里，只是多一个"打印握手行 + 不开浏览器"的模式。

---

## 4. sidecar 握手协议

### 4.1 协议格式

stdout 单行 JSON，前缀路由：

| 行 | 时机 | 含义 |
|---|---|---|
| `MOCK_READY {"host":"127.0.0.1","port":5050}` | listen 成功后打印**一次** | 就绪；`port` 是端口回退（+50 探测）后的**真实端口**；`MOCK_HOST` 被设置时 `host` 如实上报 |
| `MOCK_ERROR {"message":"..."}` | 启动致命错误 | 端口耗尽、存储目录不可写等；打印后以非零码退出 |

其他 stdout/stderr 行：壳保留**最近 50 行环形缓冲**，启动失败时展示在错误页。

### 4.2 server.js 改动

`server.js` 是唯一需要改动行为的现有源码文件（`package.json` 另加 script/devDependency、`.gitignore` 加条目，见 §6）。`MOCK_DESKTOP=1` 环境变量存在时：

1. `openBrowser = false`（不自动开浏览器）
2. listen 成功后打印 `MOCK_READY` 行（`host`/`port` 取实际值）
3. `startServer` 启动失败时打印 `MOCK_ERROR` 行再以非零码退出

`pnpm start`（无 `MOCK_DESKTOP`）行为逐字节不变。

### 4.3 启动时序

1. 壳 Setup → `tauri-plugin-shell` spawn sidecar（注入 `MOCK_DESKTOP=1`）
2. 主窗口先加载壳内嵌 `loading.html`（`frontendDist` 指向 `src-tauri/ui/`，仅含此页；`tauri.conf.json` 开 `withGlobalTauri`，页面用 `window.__TAURI__.event.listen`）
3. 壳解析到 `MOCK_READY` → emit `sidecar-ready {url}` → loading 页 `location.href = url`（`host` 为 `0.0.0.0` / `::` 时导航地址一律用 `127.0.0.1`，通配地址不可直接浏览）
4. 失败三通道任一触发 → emit `sidecar-error {message, tail}` → loading 页渲染错误 + 日志尾部：
   - 握手超时（10s）
   - 收到 `MOCK_ERROR`
   - 子进程在就绪前退出

### 4.4 运行时监视与重启

- 就绪后子进程意外退出：**不自动重启**（状态机复杂；端口冲突时盲目重试难排查）。改为：
  - 托盘菜单「重启服务」保持可用
  - 窗口开着时 emit `sidecar-stopped`，页面提示"服务已停止"
- 「重启服务」= kill 旧进程 + 重新走 §4.3 启动时序

### 4.5 退出清理

托盘「退出」/ Cmd+Q → 壳 `kill()` sidecar → 宽限 2s → 未退出则强杀 → `app.exit(0)`。保证不留孤儿进程占端口。

---

## 5. 窗口 / 托盘 / 单实例

- **关窗**：拦截 `CloseRequested` → `hide()` 而非关闭
- **托盘菜单**：「显示主窗口」「重启服务」「退出」三项；macOS 用 template 图标适配深浅色
- **Dock 重开**：macOS `RunEvent::Reopen` → 显示并聚焦主窗口
- **单实例**：`tauri-plugin-single-instance`；二次启动 → 显示 + 聚焦已有窗口
- **窗口默认**：1280×800，最小 960×600，标题 `MockServer`
- **应用标识**：名称 `MockServer`，bundle id `com.mockserver.desktop`
- **图标**：由现有 `public/favicon.svg` 经 `pnpm tauri icon` 生成全平台图标

---

## 6. CI 打包管线

现有 `build` job（Bun 4 平台交叉编译）**原样保留**，裸可执行继续发布。新增：

```
job: desktop（matrix，依赖 build job 产物）
  macos-14       → aarch64-apple-darwin        产物 .dmg
  macos-13       → x86_64-apple-darwin         产物 .dmg
  windows-latest → x86_64-pc-windows-msvc      产物 NSIS .exe
  windows-latest → aarch64-pc-windows-msvc     产物 NSIS .exe

  steps:
    1. 下载对应平台的 Bun sidecar artifact
    2. 重命名为 src-tauri/binaries/mockserver-<triple>[.exe]（Tauri sidecar 命名约定）
    3. rustup target add <triple> + pnpm i（Linux runner 不涉及）
    4. cargo test（壳单测）
    5. tauri build → 上传安装包 artifact

release job：附件追加 4 个安装包；body 加「桌面版（推荐）」下载表
            + macOS 未签名说明（首次右键→打开）
```

**版本号同步**：CI 中 `tauri build` 前把 `package.json` 的 `version` 写入 `tauri.conf.json`（一条 node 命令）。

**本地 dev**：

```bash
pnpm dev:desktop   # bun build.mjs 出本机 sidecar → 拷入 src-tauri/binaries/ → tauri dev
```

**新增文件全部隔离**：`src-tauri/`、`package.json` 加 `@tauri-apps/cli` devDependency 与 `dev:desktop` / `build:desktop` script。`.gitignore` 增加 `src-tauri/target`、`src-tauri/binaries`（保留 `.gitkeep`）、`src-tauri/gen`。

---

## 7. 错误处理汇总

| 场景 | 检测点 | 落点 |
|---|---|---|
| sidecar 二进制缺失 | spawn 失败 | 错误页「sidecar 缺失」 |
| 握手超时（10s） | 壳定时器 | 错误页 + 日志尾部 |
| `MOCK_ERROR` | 协议解析 | 错误页显示 message |
| 端口耗尽 | sidecar 内部 → `MOCK_ERROR` | 同上 |
| 就绪后崩溃 | 子进程 exit 事件 | 托盘「重启服务」+ 页面「服务已停止」提示 |
| 退出清理 | 托盘退出/Cmd+Q | kill → 2s 宽限 → 强杀 → 退出 |

错误页统一由 `loading.html` 按事件渲染，不单独建页面。

---

## 8. 测试策略

**server.js 桌面模式（vitest 集成测试，新增）**：

- `MOCK_DESKTOP=1` 下启动：不调用 `open`、stdout 输出合法 `MOCK_READY` 且端口真实可连（`fetch /api/health` 200）
- 端口回退：`MOCK_READY` 上报回退后的真实端口
- `MOCK_ERROR` 路径：制造启动失败（如占用 5050–5099 全部端口），断言输出 `MOCK_ERROR` 且非零退出

**壳（cargo test，desktop job 中执行）**：

- `parse_handshake_line` 等纯函数单测：合法行解析、畸形行/空前缀容错、非协议行忽略

**不受影响**：现有 `pnpm test`（vitest 单元+集成）、`pnpm test:e2e`（Playwright headed，浏览器模式仍在）路径不动，保持全绿。

**桌面端手工验收清单**（实现完成后逐项过）：

1. 冷启动 → loading 页 → 自动进入首页
2. 关窗 → 窗口隐藏，mock 接口仍可请求，托盘菜单「显示主窗口」可恢复
3. 杀掉 sidecar 进程 → 托盘「重启服务」可恢复服务
4. 双击第二次 → 聚焦已有窗口，无第二个实例
5. 托盘「退出」→ 进程与端口无残留（`lsof -i :5050` 为空）
6. 5050 被占用时冷启动 → 页面正常（端口回退 + 握手上报真实端口）

---

## 9. 取舍记录（已否决的方案）

| 方案 | 否决原因 |
|---|---|
| 固定端口 + 健康轮询 | 5050 被其他程序占用时会轮询到错误程序；端口回退后壳找不到服务，需再引入端口发现，等于重做握手协议 |
| Tauri 自定义协议（`tauri://localhost`）+ Rust 代理 API | 前端所有相对路径 `fetch('/api/*')`、SSE、import map 全要改，违背"业务代码零改动"原则 |
| Electron | 包体积 ~150–200MB；Tauri 同能力 ~10–20MB |
| 后端 Rust 重写 | mock-engine/config-store/log-buffer 全重写，成本与风险远超收益 |
| sidecar 崩溃自动重启 | 状态机复杂；端口冲突场景盲目重试使问题难排查。首版手动重启，后续视反馈再加 |
