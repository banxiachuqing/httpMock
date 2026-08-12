# 日志按请求时间倒序展示（最新在前）设计

- 日期：2026-08-12
- 状态：已与用户确认，采用方案 A

## 背景与目标

用户要求：接口请求日志按请求时间倒序展示，最新的日志放在列表最前面。

当前行为：日志面板按正序（旧 → 新）渲染，最新一条在列表底部；`autoScroll` 开启时新日志到达会滚动到底部。

## 现状（关键事实）

- 后端 `GET /api/logs` 经 `LogBuffer.getRecent(limit)` 返回**正序**（旧 → 新），该行为被单元测试钉死（`test/unit/log-buffer.test.js:7` "newest last"），属 API 契约。
- 前端 `state.logs` 正序存储：
  - `renderLogsInitial()`（public/app.js:514）顺序 append，最新在底部；
  - `appendLog()`（public/app.js:529）SSE 新日志 `push` 到数组尾 + `appendChild` 到 DOM 尾 + `scrollTop = scrollHeight` 滚到底；
  - 500 条封顶：`splice(0, ...)` 从头部丢弃最旧条目。
- 首页端口卡片 `latestLogByPort()`（public/views/port-cards.js:12）按 **timestamp 比较**取每端口最新日志，与数组顺序无关 —— 倒序渲染不影响。
- 日志详情经 `state.logs.find(id)` 查找，与顺序无关。
- 日志面板仅在端口详情页显示（首页不显示日志列表）。

## 方案对比

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（采用）** | 存储保持正序，仅渲染层倒序 | 改动最小（约 10 行），后端零改动、零测试破坏 |
| B | `state.logs` 改为新→旧存储（unshift + pop 封顶） | 改动面更大，未来消费方需记住新顺序约定，无收益 |
| C | 后端/API 返回倒序 | 破坏单元测试与 API 契约，排除 |

## 改动点（均在 `public/app.js`）

1. `renderLogsInitial()`：倒序遍历 `visibleLogs()` 的结果渲染，最新条目在最上方。
2. `appendLog()`（SSE 新日志）：DOM 插入由 `appendChild` 改为 `prepend`，插到 `#logsBody` 顶部。
3. `autoScroll` 两处滚动：`scrollTop = scrollHeight`（滚到底）改为 `scrollTop = 0`（钉住顶部）。
4. `state.logs` 存储顺序与 500 条封顶逻辑保持不变。

## autoScroll 语义（方向翻转）

- 开启：新日志到达时视图钉在列表顶部（最新始终可见）。
- 关闭：不触碰滚动位置，用户可自由翻阅历史。
- 开关文案不变（"自动滚动"）。

## 测试

- E2E 新增断言：连续请求同一 mock 两次，`#logsBody` 第一行是最新一条日志。
- 排查现有 E2E（test/e2e/）是否依赖"最新在底部"的渲染顺序，有则同步更新。
- 单元 / 集成测试不变（后端未改动）。

## 非目标

- 不改后端返回顺序、不改 API 契约、不改 `LogBuffer`。
- 不处理"DOM 行数超过 500 后不裁剪"的既有行为（先于本次需求存在，与倒序无关）。
