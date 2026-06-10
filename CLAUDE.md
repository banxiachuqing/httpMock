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

> E2E 测试必须以前台方式运行 — `playwright.config.js` 已固定 `headless: false` + `slowMo: 50`，所有项目通用，不要切到 headless。

---

## 项目概述

**`mock-server-webui`** — 本地 HTTP mock 服务，配 WebUI。零构建、原生 ESM + import map，单文件 Bun 可执行可打包。详细设计见 `docs/superpowers/specs/2026-06-08-mock-server-webui-design.md`。

**栈**：Node ≥18 · 纯 JavaScript（无 TS）· Express 4 · 原生 `node:http`（mock 引擎）· CodeMirror 6（ESM via importmap）· SSE · vitest + supertest（单元/集成）· Playwright headed（E2E）· Bun（打包）。

---

## 常用命令

```bash
pnpm install              # 安装依赖
pnpm start                # 启动（默认端口 5050，自动开浏览器）
pnpm test                 # 跑单元 + 集成（vitest run）
pnpm test:watch           # vitest watch 模式
pnpm test:e2e             # Playwright headed（不要切 headless）
pnpm format               # Prettier write

# 打包单文件可执行（需 Bun）
bun build.mjs                                             # 当前平台，产物 mockserver
bun build.mjs bun-darwin-x64 mockserver-intel             # macOS x64
bun build.mjs bun-windows-x64 mockserver.exe              # Windows x64
bun build.mjs bun-windows-arm64 mockserver-arm.exe        # Windows ARM
```

**环境变量**（`server.js` 接受）：
- `MOCK_HOST` — bind host（默认 `127.0.0.1`，LAN 访问用 `0.0.0.0`）
- `MOCK_SERVER_DIR` — 编译产物的资源根目录（`launcher.js` 自动注入；dev 不需要）
- `MOCK_MAX_BODY_PREVIEW` — 请求体预览最大字节数（默认 2048）

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

### 模块职责（核心）

| 文件 | 责任 | 关键点 |
|---|---|---|
| `server.js` | 进程入口、端口回退（+50 探测）、bind host 解析、自动开浏览器 | `__dirname` 接受 `MOCK_SERVER_DIR`（编译模式用） |
| `src/config-store.js` | `data.json` 持久化、原子写、损坏文件轮转（max 5）、唯一性校验 | `update(mutator)` 是唯一写入入口；`checkUniqueness(endpoints, excludeId)` 校验 `(port, method, path)` |
| `src/mock-engine.js` | 每端口 `http.createServer`，按 `port|method|path` 路由 | **端口隔离**：一个端口 EADDRINUSE 不影响其他端口；`getStatus()` 返回 `{port: {state, reason?}}` |
| `src/log-buffer.js` | 500 条环形 + `subscribe(fn)` fan-out | `push()` 同步通知所有订阅者 |
| `src/sse.js` | SSE helper + 客户端集合 | `sseMiddleware()` 返回 `{clients, handler}`；不调用 `next()` |
| `src/errors.js` | `AppError(status, code, message)` + 信封 | 所有 API 错误统一经 `toErrorResponse`/`statusFor` |
| `src/api.js` | Express 路由（CRUD + runtime + logs + SSE） | 末尾挂 `app.use((err,...)=>...)` 错误中间件 |
| `src/paths.js` | 跨平台存储路径 | 默认 `~/Documents/MockServer`，回退 `~/MockServer` |

### 前端（零构建）

- `public/index.html` — 用 import map 引入 CodeMirror 模块。
- `public/app.js` — `api` 客户端（10 个 fetch 包装） + `state` 单例 + 渲染层。无框架。
- `public/editor.js` — CodeMirror 6 bootstrap（lang-json + lint + commands）。
- `public/styles.css` — Mission Bridge 视觉方向（深色墨蓝面板、信号灯）。

**全局状态键**（`public/app.js` 的 `state`）：`config / endpoints / selectedId / dirty / runtime / runtimeStatus / logs / autoScroll`。`runtimeStatus` 是 `{port: {state, reason?}}` 字典，每 5s 轮询 `/api/runtime/status`（来自最近 commit）。

### 测试布局

```
test/
├── unit/           # vitest — 单模块 (config-store, log-buffer, errors, paths, sse, mock-engine)
├── integration/    # vitest + supertest — API 路由 (api.test, api-config, api-endpoints, api-logs, api-runtime)
├── e2e/            # Playwright headed (happy-path, json-editor, port-conflict)
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

---

## 文件指纹（变更前用 codegraph 查 blast radius）

- `MockEngine.start`（src/mock-engine.js:40）— 2 callers in `src/api.js`
- `ConfigStore.checkUniqueness`（src/config-store.js:67）— 在 `createApi` 里 2 处调用
- `createApi`（src/api.js:34）— 2 callers（server.js + test/helpers/test-server.js）
- `LogBuffer.subscribe`（src/log-buffer.js:23）— 1 caller in `src/api.js`

变更前先 `mcp__codegraph__codegraph_impact` 跑一下。