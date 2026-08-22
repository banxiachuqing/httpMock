# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 工作准则（来自 `/Users/zhangjie/Documents/cluade-template.md`，全局适用）

非平凡工作上，谨慎优先于速度。平凡任务自行判断。十一条规则浓缩为：

1. **先思考再编码** — 明确假设；不确定时提问而非猜测；存在歧义时给出多种解读；发现更简单方案时主动指出。
2. **简洁优先** — 最少代码解决问题；不为单次使用创建抽象；不做推测性开发。
3. **精准修改** — 只动必须动的；不"优化"相邻代码；不重构没坏的东西；与现有风格保持一致。
4. **目标驱动** — 定义成功标准；循环直到验证通过；按目标迭代，不僵化执行步骤。
5. **仅在需要判断时才用模型** — 路由、重试、确定性转换交给代码；只把分类、起草、摘要、提取交给我。
6. **暴露冲突，而非折中** — 两种模式矛盾时选其一并解释；不混合矛盾模式。
7. **先读后写** — 改代码前先读 exports、调用方、共享工具函数；"看起来互不干扰"是危险的。
8. **测试验证意图，而非仅是行为** — 业务逻辑变更时不会失败的测试是错的测试。
9. **每个重要步骤后做检查点** — 总结已完成/已验证/待完成；跟丢了就停下来重新梳理。
10. **遵循代码库的约定，即使不同意** — 一致性 > 个人偏好；认为有害时明确提出。
11. **大声失败** — 任何步骤被静默跳过，"已完成"就是错的；任何测试被跳过，"测试通过"就是错的。

> E2E 测试默认以无头（headless）模式运行 — `playwright.config.js` 已固定 `headless: true`（2026-08-17 起）；需要前台观察时设 `MOCK_E2E_HEADED=1`（此时自动启用 slowMo: 50）。

---

## 项目概述

**`mock-tools`（曾用名 mock-server-webui / Mock//Server，2026-08 正式更名）** — 本地 HTTP mock 服务，配 WebUI。零构建、原生 ESM + import map，单文件 Bun 可执行可打包。详细设计见 `docs/superpowers/specs/2026-06-08-mock-server-webui-design.md`。

**栈**：Node ≥18 · 纯 JavaScript（无 TS）· Express 4 · 原生 `node:http`（mock 引擎）· CodeMirror 6（ESM via importmap）· SSE · vitest + supertest（单元/集成）· Playwright headless（E2E，`MOCK_E2E_HEADED=1` 可切前台）· Bun（打包）。

---

## 常用命令

```bash
pnpm install              # 安装依赖
pnpm start                # 启动（默认端口 5050，自动开浏览器）
pnpm test                 # 跑单元 + 集成（vitest run）
pnpm test:watch           # vitest watch 模式
pnpm test:e2e             # Playwright headless（无头默认；MOCK_E2E_HEADED=1 转前台）
pnpm format               # Prettier write

# 发版（软件内版本号 = git tag 版本号，二者自动一致）
npm version 2.1.0 -m "release: v2.1.0"   # 同步 package.json + commit + 打 tag v2.1.0
git push --tags                          # 推送 tag
bun build.mjs                            # 交付产物，版本即 v2.1.0

# 打包单文件可执行（需 Bun）
bun build.mjs                                             # 当前平台，产物 mockserver
bun build.mjs bun-darwin-x64 mockserver-intel             # macOS x64
bun build.mjs bun-windows-x64 mockserver.exe              # Windows x64
bun build.mjs bun-windows-arm64 mockserver-arm.exe        # Windows ARM

# 桌面版（Tauri 壳 + Bun sidecar）
pnpm dev:desktop            # 构建本机 sidecar + tauri dev（窗口模式调试）
pnpm build:desktop          # 本机打包（macOS 出 .dmg）
pnpm sidecar:prepare        # 只重建 src-tauri/binaries/ 下的 sidecar
```

**环境变量**（`server.js` 接受）：
- `MOCK_HOST` — bind host（默认 `127.0.0.1`，LAN 访问用 `0.0.0.0`）
- `MOCK_SERVER_DIR` — 编译产物的资源根目录（`launcher.js` 自动注入；dev 不需要）

请求体大小上限（`settings.maxBodyBytes`，默认 4 MiB）由 Settings 面板运行时配置，mock-engine 每次请求实时读取；不再用环境变量。

## 版本号一致性（发版约定）

软件顶部栏版本（`v{{VERSION}}` 占位符）来源：

1. **dev（`node server.js`）**：最近 git tag（`git describe --tags --abbrev=0`，去 `v` 前缀）→ 无 tag 回落 `package.json` version
2. **打包（`bun build.mjs`）**：构建时 git tag 优先 → 回落 package.json → 版本固化进产物（分发后无 `.git` 也正确）

**因此：git 发版 = 打 tag，软件版本自动跟随，不需要手改任何文件。** 流程：`npm version <版本> -m "release: v<版本>"`（一键同步 package.json + commit + tag）→ `git push --tags` → `bun build.mjs`。

**单测 / 集成 / E2E**：
```bash
# 跑单个测试文件
pnpm vitest run test/unit/config-store.test.js
pnpm vitest run test/integration/api-logs.test.js

# 按名字过滤
pnpm vitest run -t "checkUniqueness"

# E2E 单文件
pnpm playwright test test/e2e/happy-path.spec.js
```

---

## 架构（需要跨多文件理解的大图）

**双服务架构** —— 一个 Express 控制平面 + N 个原生 `http.Server` 数据平面 mock 端口，两者共享同一个 `ConfigStore` + `LogBuffer` 单例。

### 进程启动链

```
server.js (startServer, listenWithFallback)
  ├─ ConfigStore.load()              ← src/config-store.js：data.json 原子读写 + 唯一性
  ├─ new LogBuffer(500)              ← src/log-buffer.js：环形 buffer + fan-out subscribe
  ├─ new MockEngine({bindHost})      ← src/mock-engine.js：每端口 http.Server
  └─ createApi(...)                  ← src/api.js：Express 路由
        ├─ /vendor/codemirror/*      ← 从 node_modules 静态提供 CodeMirror ESM
        ├─ /vendor/{crelt,...}       ← CodeMirror 传递依赖
        ├─ /events (SSE)             ← src/sse.js：实时日志推送
        ├─ /api/*                    ← CRUD + runtime + logs + health
        └─ /                         ← public/（index.html + app.js + editor.js + styles.css）
```

桌面模式：Tauri 壳（src-tauri/）spawn Bun sidecar（MOCK_DESKTOP=1），sidecar listen 成功打印
MOCK_READY {"host","port"}，壳解析后 WebView 导航到该地址；关窗隐藏到托盘，托盘菜单
负责显示/重启/退出。握手协议细节见 docs/superpowers/specs/2026-08-14-tauri-desktop-design.md。

### 模块职责（核心）

| 文件 | 责任 | 关键点 |
|---|---|---|
| `server.js` | 进程入口、端口回退（+50 探测）、bind host 解析、自动开浏览器 | `__dirname` 接受 `MOCK_SERVER_DIR`（编译模式用） |
| `src/config-store.js` | `data.json` 持久化、原子写、损坏文件轮转（max 5）、唯一性校验 | `update(mutator)` 是唯一写入入口；`checkUniqueness(endpoints, excludeId)` 校验 `(port, method, path)` |
| `src/mock-engine.js` | 每端口 `http.createServer`，按 `port|method|path` 路由；按 `port.type` 派发 http/ws/tcp/udp | `start(endpoints, ports, services)`：ports 列表模式下只绑定启用端口、空端口也绑定（404）；**端口隔离**：一个端口 EADDRINUSE 不影响其他端口；`getStatus()` 返回 `{port: {state, reason?}}` |
| `src/capture.js` | TCP/UDP 抓包数据平面（`node:net`/`node:dgram`） | TCP 空闲 200ms 聚合成一条日志、断连 flush、`maxBodyBytes` 截断、连接上限 200；UDP 一 datagram 一条；**纯抓包不响应**；connect/disconnect 落事件日志 |
| `src/log-buffer.js` | 500 条环形 + `subscribe(fn)` fan-out | `push()` 同步通知所有订阅者 |
| `src/sse.js` | SSE helper + 客户端集合 | `sseMiddleware()` 返回 `{clients, handler}`；不调用 `next()` |
| `src/errors.js` | `AppError(status, code, message)` + 信封 | 所有 API 错误统一经 `toErrorResponse`/`statusFor` |
| `src/api.js` | Express 路由（CRUD + runtime + logs + SSE） | 末尾挂 `app.use((err,...)=>...)` 错误中间件；端点自动补建端口实体 |
| `src/api-ports.js` | `/api/ports` CRUD（端口一等实体） | `registerPortRoutes(app, {configStore})`；改号级联 endpoints；删除连带 endpoints |
| `src/paths.js` | 跨平台存储路径 | 默认 `~/Documents/MockServer`，回退 `~/MockServer` |
| `src/wsdl.js` | WSDL 解析/骨架生成/地址重写 | `parseWsdl` 抛 `INVALID_WSDL`；`rewriteAddress` 纯正则改写 location，不重建 XML 树 |
| `src/soap-router.js` | SOAP 版本识别/操作名提取/operation 匹配/Fault 生成 | 纯函数；匹配优先级：action 精确 > action 末段 > Body localName |
| `src/api-services.js` | `/api/services` + `/api/wsdl` 路由 | `toPublicService` 剥 wsdl 原文换 `hasWsdl`；operations 路由返回整个 service |

### 前端（零构建）

- `public/index.html` — import map 引入 CodeMirror；body 网格双视图（首页卡片区 / 端口详情页）。
- `public/app.js` — `api` 客户端 + `state` 单例 + 详情页渲染层 + 路由接线。无框架。
- `public/router.js` — hash 路由（`#/` 首页，`#/port/<port>` 详情——ws 端口渲染服务网格，`#/port/<port>/svc/<id>` WS 服务详情）。
- `public/views/port-cards.js` — 首页端口卡片渲染 + 新建端口弹窗。
- `public/views/port-detail.js` — 详情页端口页头交互（启用/改号/删除）。
- `public/views/ws-services.js` — WS 端口详情页服务卡片网格 + 新建服务弹窗。
- `public/views/ws-import.js` — 导入 WSDL 弹窗（解析预览 + 合并确认）。
- `public/views/ws-detail.js` — WS 服务详情页（operation 侧栏 + XML 响应编辑）。
- `public/editor.js` — CodeMirror 6 bootstrap（lang-json + lint + commands）。
- `public/styles.css` — Cinematic Dark Glass 视觉方向（深色渐变 + 玻璃面板 + 靛蓝主色 + 背景光斑）。

**全局状态键**（`public/app.js` 的 `state`）：`config / ports / endpoints / selectedId / dirty / runtime / runtimeStatus / logs / autoScroll / route / services / selectedOperationId`。`runtimeStatus` 是 `{port: {state, reason?}}` 字典，每 5s 轮询 `/api/runtime/status`；`route` 是 `{view:'home'} | {view:'port', port}`，由 `router.js` 驱动。

### 测试布局

```
test/
├── unit/           # vitest — 单模块 (config-store, log-buffer, errors, paths, sse, mock-engine, capture)
├── integration/    # vitest + supertest — API 路由 (api.test, api-config, api-endpoints, api-logs, api-runtime)
├── e2e/            # Playwright headless（MOCK_E2E_HEADED=1 转前台）(happy-path, json-editor, port-conflict, port-cards, port-detail, capture)
└── helpers/
    ├── temp-dir.js     # tempDir(prefix) → {path, cleanup}
    └── test-server.js  # buildApp({storagePath, configStore, logBuffer, mockEngine}) → {app, request}
```

**E2E 约定**：`bootServer()` 起一个真实 `startServer()`，用 `page.evaluate(() => fetch(...))` 走 API（更快更稳），用 `hitMock(port, path)` 直连 mock 端口。

---

## 关键不变量（改前必须理解）

1. **`(port, method, path)` 三元组唯一性**（在 `enabled !== false` 的端点内）。`POST /api/endpoints` 与 `PUT /api/endpoints/:id` 都过 `ConfigStore.checkUniqueness`。
2. **mock 端口隔离**：启动时一个端口失败不影响其他端口；UI 通过 `/api/runtime/status` 的 `state: 'failed'` + `reason` 标记。
3. **`ConfigStore.update(mutator)` 是唯一写入入口**。`mutator` 接收 `structuredClone(this.config)`，返回新对象 —— 不要在外面就地改 `this.config`。
4. **SSE 客户端订阅**：`LogBuffer.subscribe(fn)` 返回 `unsubscribe`；`api.js` 启动时一次性挂上 broadcast，不要重复挂。
5. **`embed-assets/` 是 `build.mjs` 的输入**，内容是 `public/` 的副本（vendor 文件）。改 `public/` 必须同步到 `embed-assets/`，否则编译产物不一致。
6. **端口一等实体**：`data.json` v2 含 `ports: [{port, enabled}]`；v1 数据加载时自动迁移。禁用端口不随启动绑定；空端口绑定后全返回 404。
7. **端点自动补建端口**：`POST/PUT /api/endpoints` 引用未知端口时自动创建 `{port, enabled: true}`，保证不存在"有接口但端口实体缺失"的状态。
8. **桌面壳只碰进程生命周期**：src-tauri/ 不得引入 mock 业务逻辑；sidecar 协议行（MOCK_READY/MOCK_ERROR）改动必须同步更新 src-tauri/src/sidecar.rs 的 parse_handshake_line。
9. **端口分类型**：`type: 'http'|'ws'|'tcp'|'udp'` 创建后不可改；资源类型必须与端口类型匹配（`PORT_TYPE_MISMATCH`——`assertHttpPort` 对一切非 http 类型拒挂端点）。tcp/udp 为纯抓包端口：无 endpoints/services 实体，同端口号跨类型也不并存（端口号全局唯一）。
10. **WS 路由优先级**：`?wsdl` > SOAPAction 精确 > action 末段 > Body localName > Fault；匹配大小写敏感。
11. **WSDL 分发必须重写地址**：`?wsdl` 返回时 `soap:address location` 重写为 mock 自身地址（含骨架生成场景）。
12. **`GET /api/config` 不含 `services[].wsdl` 原文**（只有 `hasWsdl`）；存储层完整保留。

---

## 文件指纹（变更前用 codegraph 查 blast radius）

- `MockEngine.start`（src/mock-engine.js:66，签名 `start(endpoints, ports, services)`）— 1 caller in `src/api.js`
- `ConfigStore.checkUniqueness`（src/config-store.js:67）— 在 `createApi` 里 2 处调用
- `createApi`（src/api.js:34）— 2 callers（server.js + test/helpers/test-server.js）
- `LogBuffer.subscribe`（src/log-buffer.js:23）— 1 caller in `src/api.js`

变更前先 `mcp__codegraph__codegraph_impact` 跑一下。