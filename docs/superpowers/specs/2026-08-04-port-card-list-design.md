# 端口卡片首页 + 端口详情页改版 — 设计

**日期**：2026-08-04
**状态**：待用户审查
**目标版本**：mock-server-webui v1 增量

---

## 1. 背景与目标

当前 WebUI 是单页布局：左侧接口列表 + 右侧编辑器 + 底部全局日志。接口一多，列表平铺、端口信息被压缩成每行一个小标签，用户很难按"端口"这个视角管理 mock 服务。同时接口没有名字字段，只能靠 `METHOD /path` 辨认。

**目标**：

1. 首页改为**端口卡片列表**：以端口号为视角，每张卡片展示该端口的启用状态、接口数量、最近请求时间与最近请求的接口名；点击卡片进入该端口的详情页
2. 详情页保持现有布局（左侧接口列表 + 右侧编辑器 + 底部日志），但：
   - 端口字段只读（新建与编辑接口时都不可改）
   - 日志面板只显示当前端口的请求
3. 接口新增 **`name`（接口名称）** 字段；左侧列表优先显示名称，未填时回落显示 `METHOD /path`

**非目标（本次不做）**：

- 不做端口搜索 / 排序切换（卡片固定按端口号升序）
- 不做单个接口跨端口移动（改端口号是端口维度整体改）
- 不做日志统计卡片（请求总数、成功率等），卡片只放本 spec 列出的四项
- 后端不校验"接口必须属于已存在的端口"（由 UI 保证，避免引入新不变量）

---

## 2. 已确认的需求决策

以下决策来自与用户的逐项澄清：

| # | 决策 |
|---|---|
| 1 | 端口升级为**一等实体**（`data.json` 新增 `ports` 列表），带独立启用开关；禁用端口点"启动"时不绑定 |
| 2 | 新建端口走**弹窗输入端口号**，输入框预填一个可用端口号 |
| 3 | 首页与详情页之间用 **hash 路由**（刷新、前进/后退保持位置） |
| 4 | 详情页端口字段**全程只读**（新建与编辑接口时都锁定） |
| 5 | **首页去掉日志面板**；详情页日志按当前端口过滤 |
| 6 | 删除端口 = **连同其下所有接口一起删**，二次确认 |
| 7 | 详情页支持**修改端口号**，级联更新该端口下所有接口的 port 字段，重启后生效 |

---

## 3. 数据模型（data.json v1 → v2）

```json
{
  "version": 2,
  "settings": { "storagePath": "...", "uiPort": 5050, "maxBodyBytes": 4194304 },
  "ports": [
    { "port": 8080, "enabled": true },
    { "port": 9090, "enabled": false }
  ],
  "endpoints": [
    { "id": "uuid", "name": "用户登录", "method": "POST", "port": 8080,
      "path": "/api/login", "statusCode": 200, "response": {}, "enabled": true }
  ]
}
```

### 迁移规则（ConfigStore.load 内）

- 成功读取的 v1 数据（无 `ports` 数组）：从现有 endpoints 的端口号**去重、升序**生成 `ports`，全部 `enabled: true`；`version` 置 2；立即原子写回
- 新建文件（ENOENT 分支）：默认模板直接带 `ports: []`，`version: 2`
- 已有 `ports` 的数据：不做任何迁移

### endpoint `name` 字段

- 可选字符串；提供时必须是字符串，trim 后长度 ≤ 50
- trim 后为空视为未填，**不存储**（保存时丢弃）
- 不参与 `(port, method, path)` 唯一性校验；该不变量本身不变

---

## 4. 后端 API

### 4.1 新增 `/api/ports`

| 路由 | 行为 |
|---|---|
| `GET /api/ports` | 返回 ports 数组 |
| `POST /api/ports` | body `{ port }`。校验：1..65535 整数；与现有端口不冲突（冲突 → 400 `DUPLICATE_PORT`）。创建后 `enabled: true`，返回 201 + 实体 |
| `PUT /api/ports/:port` | body `{ port?, enabled? }`。改号时校验 1..65535 且不与其他端口冲突；成功后**级联更新**该端口下所有 endpoints 的 `port` 字段（与 ports 数组更新在**同一次 `ConfigStore.update`** 内完成）。改号重启后生效 |
| `DELETE /api/ports/:port` | 删除端口**及其下所有 endpoints**（同一次 `ConfigStore.update`）。204；不存在 → 404 |

### 4.2 endpoints API 变更

- `POST/PUT /api/endpoints` 的校验增加 `name`（规则见 §3）
- 其余行为不变；后端继续接受 `port` 参数（前端锁定，API 不做"端口必须存在"约束）

### 4.3 运行时启动逻辑

`/api/runtime/start` → `mockEngine.start(config.ports, config.endpoints)`：

- 只遍历 `enabled !== false` 的端口做绑定
- 无接口的端口照常绑定（空路由，所有请求 404）
- 禁用端口不绑定；即使有 endpoints 引用它也不启动
- 端口隔离、`getStatus()`、日志结构全部不变

### 4.4 卡片统计数据来源

卡片的"最近请求时间 / 接口名"**不走后端**：前端已有全量日志（初始 `/api/logs` 拉取 500 条 + SSE 实时推送，每条含 `port/method/path/timestamp/endpointId`），在浏览器内按 port 分组取最新一条即可。局限：重启或清空日志后回到"无请求"状态，这是内存日志的固有行为，与现状一致。

---

## 5. 前端结构

### 5.1 文件拆分

```
public/
├── app.js        # 瘦身为 state + api client + SSE + 启动接线（约 400 行）
├── router.js     # 新增：hash 路由（约 40 行），解析 #/ 与 #/port/:port
├── views/
│   ├── port-cards.js    # 新增：首页卡片渲染 + 新建端口弹窗
│   └── port-detail.js   # 新增：详情页（承接现有列表/编辑器/日志逻辑）
├── editor.js     # 不变
└── styles.css    # 新增卡片样式，复用既有 token
```

`state` 新增：`ports: []`、`route: { view: 'home' } | { view: 'port', port: 8080 }`。

路由流程：`hashchange` → 更新 `state.route` → 渲染对应视图。详情页有未保存修改时切换路由复用现有 confirm 守卫（放弃则跳转，取消则还原 hash）。

### 5.2 首页（端口卡片）

- 顶栏不变（全局状态灯、启动/停止、设置）；**移除日志面板**
- 卡片区：响应式网格（`auto-fill, minmax(280px, 1fr)`），按端口号升序。每张卡片：
  - 端口号大字 `:8080`（mono）+ 运行状态灯（运行中/失败/停止，复用现有 LED 样式）
  - **启用开关**：toggle → `PUT /api/ports/:port { enabled }`，不加确认；禁用态卡片降低饱和度
  - **接口数**：`N 个接口`；存在禁用接口时注记 `N 个接口 · M 个禁用`
  - **最近请求**：相对时间（如"3 分钟前"）+ 接口名。名称解析顺序：endpoint `name` → `METHOD path`；未匹配请求显示 `无路由 · path`；无日志显示 `—`
  - 点击卡片 → `#/port/8080`；开关按钮阻止冒泡
- **新建端口**：网格末尾虚线"新建端口"占位卡 → 弹窗输入端口号（预填从 8080 起最小可用号），前端校验整数 1..65535 且不与现有端口重复；创建成功后**直接跳转该端口详情页**；后端返回 400（竞态重复）时弹窗内显示错误
- 空状态（无任何端口）：引导创建第一个端口
- 实时更新：现有 5s runtimeStatus 轮询刷新状态灯；SSE 日志到达时更新对应卡片的"最近请求"行（只重渲染该行）

### 5.3 详情页（`#/port/:port`）

布局同现在的主页面（左侧接口列表 + 右侧编辑器 + 底部日志），顶部新增端口页头：

- **页头**：`← 返回端口列表` | 端口号大字 + **端口号内联编辑框**（保存时 `PUT /api/ports/:port` 改号，成功后提示"重启后生效"）| 启用开关 | **删除端口**按钮（二次确认，确认文案说明会连带删除 N 个接口）| 状态灯
- **改号成功后**：重新拉取 endpoints（port 字段已级联变化）、更新 `state.ports`、把 `location.hash` 改为新端口号（避免旧 hash 路由失效）
- **删除端口后**：跳回首页（`#/`）
- hash 中的端口在 `state.ports` 中不存在（如删除后的旧 hash）：显示"端口不存在"空状态 + 回首页链接
- **左侧接口列表**：每行显示 `name`（为空回落 `METHOD path`），保留状态灯与删除按钮；"新建"按钮位置不变
- **编辑器表单**：
  - 新增第一行字段 **接口名称**（text，≤50 字符，placeholder 提示"可选，留空时列表显示 URL"）
  - 端口字段 **disabled 只读**，固定为当前端口（新建与编辑都一样）
  - 新建接口：`POST /api/endpoints`，port 固定当前端口，path 默认 `/api/new`（延续现有默认）
  - 保存时携带 `name`
- **底部日志面板**：仅渲染 `entry.port === 当前端口` 的条目（`state.logs` 仍存全量，渲染时过滤）；计数文案 `N 条 / 共 M 条`；自动滚动、清空、SSE、点击行弹详情全部不变；清空仍清全量（语义与现状一致）

### 5.4 视觉

延续现有 Mission Bridge 方向（深色墨蓝面板、信号灯、mono 字体），卡片复用既有 design token（表面色、LED、status-pill 样式），不引入新设计体系。卡片带 hover 上浮 + 边框提亮态。

---

## 6. 测试计划

### 单元（vitest）

- `config-store`：v1 → v2 迁移（端口去重升序、默认启用、version 置 2、落盘）；已有 ports 的数据不重复迁移
- `mock-engine`：只绑定启用端口；禁用端口不绑定；空端口正常绑定返回 404

### 集成（vitest + supertest）

- 新增 `api-ports.test.js`：创建（校验 + 重复 400）、启用/禁用、改号（级联更新 endpoints + 冲突 400）、删除（连带 endpoints、404）
- `api-endpoints.test.js` 补充：`name` 校验（超长 400、trim 后为空不存储、正常存取）
- `api-runtime.test.js` 补充：禁用端口不随启动绑定

### E2E（Playwright headed，不切 headless）

新增 `port-cards.spec.js`：

- 首页卡片展示（数量、状态灯、接口数、最近请求）
- 弹窗建端口 → 跳详情页 → 新建接口（端口只读）→ 填名称 → 左侧列表显示名称 / 空名称回落 URL
- 详情页日志只显示本端口
- 改端口号、删端口（连带确认）、禁用端口后启动不绑定

### 存量 E2E 调整（最大测试成本，单独任务）

`happy-path`、`json-editor`、`port-conflict`、`log-detail-modal` 四个 spec 都假设"打开首页就是接口列表 + 编辑器"。改版后需先进入端口详情页。`test/e2e/helpers.js` 增加"进入端口详情页"公共步骤，四个 spec 跟随调整。

---

## 7. 兼容性与同步

- **数据兼容**：旧 `data.json` 自动迁移，用户无感
- **embed-assets 同步**：`public/` 所有改动必须同步到 `embed-assets/public/`（项目不变量 #5），收尾执行
- **浏览器前进/后退**：hash 路由天然支持；脏表单守卫在 `hashchange` 时拦截

---

## 8. 关键不变量（改后仍然成立）

1. `(port, method, path)` 三元组在启用接口内唯一 —— 不变
2. mock 端口隔离（一个端口绑定失败不影响其他端口）—— 不变
3. `ConfigStore.update(mutator)` 是唯一写入入口（改号级联、删端口级联都在单次 update 内）—— 不变
4. SSE 订阅一次性挂载 —— 不变
5. `public/` 与 `embed-assets/` 同步 —— 不变
