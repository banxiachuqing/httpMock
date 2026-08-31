# Mock Tools · 本地 HTTP 模拟工具

> 一个带 WebUI 的本地 mock 服务。配置多个接口、启动引擎、实时看请求日志。
> 支持浏览器模式、桌面应用（Tauri 壳 + Bun sidecar）与 MCP（AI 助手直接管理 mock）。

![version](https://img.shields.io/badge/version-2.0.0-7cffaf)

## ✨ 特性

- 🖥️ **桌面应用** —— Windows / macOS 安装包，独立窗口、关窗最小化到托盘、单实例、托盘菜单重启服务
- 🤖 **MCP 接入** —— 内置 MCP Server，Claude Desktop / Cursor / Qoder 等 AI 客户端可直接用自然语言创建/管理 mock 端点、查运行状态与请求日志；支持 stdio（客户端拉起轻代理）与 HTTP（设置页开关启用 `/mcp`）两种接入
- 🌐 **WebUI** —— 浏览器中配置接口、点击启动、看请求日志（浏览器模式同样可用）
- 🎨 **双主题** —— 暗色 / 亮色（浅色玻璃），设置面板三态切换：跟随系统 / 亮色 / 暗色，即时生效
- 📡 **多端口** —— 一个配置可触发多个端口同时监听，端口隔离（单个失败不影响其他）
- 🔍 **精确路由** —— `(method, path)` 完全匹配，支持任意 HTTP 状态码
- 🧬 **动态响应** —— 响应 JSON 内嵌 `{{$uuid}}`、`{{$int:1:100}}`、`{{$lorem.paragraph}}` 等生成器表达式，首次请求实时求值（faker 驱动）
- 📝 **JSON 编辑器** —— CodeMirror 6 语法高亮 + 实时校验 + 一键格式化，跟随主题切换
- 📊 **实时日志** —— SSE 推送，500 条环形 buffer，日志详情弹窗（pretty JSON 查看器）
- 💾 **跨平台持久化** —— 配置存到 `~/Documents/MockServer/data.json`（macOS / Windows）
- 🔌 **零构建** —— 原生 ESM + import map，无打包步骤

## 🚀 快速开始

**桌面版（推荐）**：到 [Releases](https://github.com/banxiachuqing/httpMock/releases) 下载对应平台安装包，双击安装启动。

| 平台 | 安装包 |
|---|---|
| macOS (Apple Silicon) | `Mock.Tools_2.0.0_aarch64.dmg` |
| macOS (Intel) | `Mock.Tools_2.0.0_x64.dmg` |
| Windows (x64) | `Mock.Tools_2.0.0_x64-setup.exe` |
| Windows (ARM) | `Mock.Tools_2.0.0_arm64-setup.exe` |

> macOS 未签名：首次打开请右键 App →「打开」。

**命令行版**（单文件可执行，无需安装）：

| 平台 | 文件 |
|---|---|
| macOS (Apple Silicon) | `mockserver-mac-arm64` |
| macOS (Intel) | `mockserver-mac-x64` |
| Windows (x64) | `mockserver-win-x64.exe` |
| Windows (ARM) | `mockserver-win-arm64.exe` |

```bash
# macOS
chmod +x mockserver-mac-arm64 && ./mockserver-mac-arm64
# Windows
mockserver-win-x64.exe
```

**从源码运行**：

```bash
pnpm install
pnpm start        # 浏览器模式，自动打开 http://localhost:5050
pnpm dev:desktop  # 桌面模式（Tauri 窗口）
```

配置存到 `~/Documents/MockServer/data.json`（可在设置中修改存储路径与 UI 端口）。

## 📖 使用

1. 点击右上 **⚙** 图标进入设置：存储路径、UI 端口、请求体上限、**主题**（跟随系统 / 亮色 / 暗色）
2. 左侧 **+ 新建** 添加 mock 接口
3. 填方法 / 端口 / 路径 / 状态码 / 响应 JSON；响应中可用 `{{$生成器:参数}}` 表达式实现动态数据（生成器面板可预览、选择）
4. 点击 **▶ 启动**，所有唯一端口的 mock 服务同时拉起
5. 任何地方调这些接口，请求出现在底部日志面板；点击日志行查看详情（pretty JSON）

> 端口冲突时：状态变“启动失败”，失败的端口标红，其他端口继续工作。

## 🤖 MCP（AI 助手接入）

内置 MCP Server（协议版本 2025-06-18，零依赖手写 JSON-RPC），提供 17 个工具全量管理 mock，两种接入方式共用同一套工具：

- **端口**：`list_ports` / `create_port` / `update_port` / `delete_port`
- **端点**：`list_endpoints` / `create_endpoint` / `update_endpoint` / `delete_endpoint`
- **运行时**：`runtime_start` / `runtime_stop` / `runtime_status`
- **日志**：`get_logs` / `clear_logs`
- **WS 服务**：`list_services` / `create_service` / `delete_service` / `update_operation`

### 方式一：设置页开关（HTTP，最简）

WebUI 设置页打开 **MCP Server** 开关（默认关，持久化），AI 客户端配 URL 即可：

```jsonc
{
  "mcpServers": {
    "mock-tools": {
      "url": "http://127.0.0.1:5050/mcp"
    }
  }
}
```

Streamable HTTP 无状态模式；关闭开关后端点下线（伪装 404）。

### 方式二：stdio 轻代理（客户端拉起）

MCP 进程优先连接已运行的 mock server；未运行时自动拉起 headless 实例（detached，AI 会话断开不影响服务）：

```jsonc
// 编译产物（推荐，路径换成本地可执行文件位置）
{
  "mcpServers": {
    "mock-tools": {
      "command": "/path/to/mockserver-mac-arm64",
      "args": ["mcp"]
    }
  }
}

// 从源码运行
{
  "mcpServers": {
    "mock-tools": {
      "command": "node",
      "args": ["/path/to/httpWork/server.js", "mcp"]
    }
  }
}
```

> Claude Desktop：`claude_desktop_config.json`；Cursor / Qoder：`mcp.json`，字段结构相同。
>
> 可选环境变量 `MOCK_MCP_URL`（如 `http://127.0.0.1:5050`）显式指定 server 地址，跳过自动发现（地址不可达时快速报错）。

配置好后在 AI 里直接说“帮我 mock 一个 GET /api/users 返回用户列表，端口 9001”即可。

## ⌨️ 快捷键

| 键 | 行为 |
|---|---|
| `Cmd/Ctrl + S` | 保存当前接口 |
| `Cmd/Ctrl + Shift + F` | 格式化 JSON |
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
| `pnpm dev:desktop` | 桌面模式调试（Tauri 窗口，自动构建 sidecar） |
| `pnpm build:desktop` | 本机打包桌面安装包（macOS 出 .dmg） |
| `pnpm sidecar:prepare` | 只重建桌面版内嵌的 Bun sidecar |

## 🏗️ 架构

```
httpWork/
├── server.js                # 进程入口（端口回退 + open 浏览器；MOCK_DESKTOP=1 桌面握手；`server.js mcp` 进入 MCP 模式）
├── src/
│   ├── api.js               # Express 路由（CRUD + runtime + logs + SSE + preview）
│   ├── mcp-server.js        # MCP stdio 入口：发现/自动拉起 mock server + REST 轻代理接线
│   ├── mcp-stdio.js         # MCP 协议核心（传输无关 createMcpCore + stdio 传输壳）
│   ├── mcp-http.js          # MCP HTTP 端点 /mcp（Streamable HTTP 无状态，设置开关门控）
│   ├── mcp-tools.js         # MCP 工具集（17 个，与 REST 路由 1:1 映射）
│   ├── api-ports.js         # /api/ports 端口一等实体 CRUD
│   ├── api-preview.js       # 生成器目录 / 采样 / 预览路由
│   ├── config-store.js      # data.json 读写 + 原子写 + 唯一性
│   ├── mock-engine.js       # 每端口 http.Server + 调度 + 404 + 动态响应求值
│   ├── expression-resolver.js # {{$generator:args}} 表达式解析（引擎与预览共用）
│   ├── generators/          # faker 生成器白名单注册表（uuid / int / lorem / date …）
│   ├── log-buffer.js        # 环形 buffer + 订阅 fan-out
│   ├── sse.js | errors.js | paths.js | version.js
├── public/                  # 零构建前端（原生 ESM + import map）
│   ├── index.html           # 入口（import map + 主题防闪烁引导）
│   ├── app.js               # 状态 + API client + 渲染
│   ├── theme.js             # 主题系统（system/light/dark + Tauri 联动）
│   ├── editor.js            # CodeMirror 6 bootstrap（双主题 Compartment 热切换）
│   ├── views/               # 首页端口卡片 / 详情页交互
│   └── styles.css           # CSS 变量双主题（暗色 + 浅色玻璃）
├── src-tauri/               # Tauri 桌面壳（Rust）
│   ├── src/sidecar.rs       # spawn Bun sidecar + stdout 握手协议 + 状态机
│   ├── src/tray.rs          # 托盘菜单（显示 / 重启服务 / 退出）
│   └── ui/loading.html      # 启动加载页 / 错误覆盖层
└── test/
    ├── unit/                # Vitest 单元
    ├── integration/         # Vitest + supertest 集成
    └── e2e/                 # Playwright headed
```

**桌面模式**：Tauri 壳 spawn Bun sidecar（`MOCK_DESKTOP=1`），sidecar listen 成功打印 `MOCK_READY {"host","port"}`，壳解析后 WebView 导航到该地址；关窗隐藏到托盘，托盘菜单负责显示 / 重启 / 退出。

## 🎨 设计方向

**Cinematic Dark Glass**（暗色默认）—— 深色渐变 + 玻璃面板 + 靛蓝主色 + 背景光斑；**浅色玻璃**（亮色）—— 与暗色互为姊妹的亮色变体，设置面板可即时切换、跟随系统外观。桌面版标题栏为标准原生空栏，应用名展示在界面顶栏。

## 📜 License

ISC