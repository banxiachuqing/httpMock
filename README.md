# Mock//Server · 本地 HTTP 模拟工具

> 一个带 WebUI 的本地 mock 服务。配置多个接口、启动引擎、实时看请求日志。

![status](https://img.shields.io/badge/status-MVP-7cffaf)

## ✨ 特性

- 🌐 **WebUI** —— 浏览器中配置接口、点击启动、看请求日志
- 📡 **多端口** —— 一个配置可触发多个端口同时监听
- 🔍 **精确路由** —— `(method, path)` 完全匹配，支持任意 HTTP 状态码
- 📝 **JSON 编辑器** —— CodeMirror 6 语法高亮 + 实时校验 + 一键格式化
- 📊 **实时日志** —— SSE 推送，500 条环形 buffer
- 💾 **跨平台持久化** —— 配置存到 `~/Documents/MockServer/data.json`（macOS / Windows）
- 🔌 **零构建** —— 原生 ESM + import map，无打包步骤

## 🚀 快速开始

```bash
pnpm install
pnpm start
```

浏览器自动打开 `http://localhost:5050`。配置存到 `~/Documents/MockServer/data.json`。

## 📖 使用

1. 点击右上 **⚙** 图标可改存储路径和 UI 端口
2. 左侧 **+ 新建** 添加 mock 接口
3. 填方法 / 端口 / 路径 / 状态码 / 响应 JSON
4. 点击 **▶ 启动**，所有唯一端口的 mock 服务同时拉起
5. 任何地方调这些接口，请求出现在底部日志面板

> 端口冲突时：状态变"启动失败"，失败的端口标红，其他端口继续工作。

## ⌨️ 快捷键

| 键 | 行为 |
|---|---|
| `Cmd/Ctrl + S` | 保存当前接口 |
| `Tab`（编辑器内） | 插入 2 空格 |
| `Esc`（弹窗内） | 关闭弹窗 |

## 🧪 脚本

| 命令 | 作用 |
|---|---|
| `pnpm start` | 启动服务（自动开浏览器） |
| `pnpm test` | 跑单元 + 集成测试 |
| `pnpm test:watch` | watch 模式 |
| `pnpm test:e2e` | 跑 E2E（headed） |
| `pnpm format` | Prettier write |

## 🏗️ 架构

```
httpWork/
├── server.js                # 进程入口（端口回退 + open 浏览器）
├── src/
│   ├── paths.js             # 跨平台 Documents 路径
│   ├── config-store.js      # data.json 读写 + 原子写 + 唯一性
│   ├── log-buffer.js        # 环形 buffer + 订阅 fan-out
│   ├── mock-engine.js       # 每端口 http.Server + 调度 + 404
│   ├── sse.js               # SSE helper
│   ├── errors.js            # AppError + JSON 信封
│   └── api.js               # Express 路由
├── public/
│   ├── index.html           # 入口（含 import map）
│   ├── app.js               # 状态 + API client + 渲染
│   ├── editor.js            # CodeMirror 6 bootstrap
│   └── styles.css           # Mission Bridge 风格
└── test/
    ├── unit/                # Vitest 单元
    ├── integration/         # Vitest + supertest 集成
    └── e2e/                 # Playwright headed
```

详细设计见 `docs/superpowers/specs/2026-06-08-mock-server-webui-design.md`。

## 🎨 设计方向

**Mission Bridge** —— 深色墨蓝面板、信号灯（绿/琥珀/红）、`Bricolage Grotesque` + `JetBrains Mono`、硬 1px 边框、状态语义驱动配色。视觉原型：`docs/superpowers/specs/2026-06-08-mock-server-webui-prototype/`。

## 📜 License

ISC
