# TCP/UDP 抓包 Mock 设计

- 日期：2026-08-22
- 状态：已确认（用户 2026-08-22 批准）
- 前置：在现有 HTTP/SOAP mock 之上，为「设备/客户端向 mock 上报数据」场景新增 TCP/UDP 接收能力。一期为**纯抓包/验证**：收数据、落日志、可查看；响应（ACK）能力为二期。

---

## 1. 需求边界（澄清结论）

| 议题 | 结论 |
|---|---|
| 核心场景 | 纯抓包/验证：把数据收下来、在日志里看到；响应能力二期再加 |
| TCP 消息边界 | **空闲超时聚合**：连接上一小段时间（默认 200ms）无新数据 → 累积字节作为一条消息落日志；连接关闭时残余也落一条 |
| UDP 消息边界 | 天然边界：一个 datagram = 一条日志，无聚合 |
| 数据展示 | **hex + 文本双视图**：日志条目同时存 `payloadHex` / `payloadText`，UI 详情可切换（默认项，用户未异议） |
| 日志呈现 | **复用现有全局日志流**（LogBuffer + SSE + 日志页 + 详情弹窗），捕获条目带协议/远端地址字段 |
| 协议范围 | TCP 与 UDP 一期同做（UDP 在日志模型就绪后边际成本很低） |
| 端口模型 | 沿用「端口一等实体 + 类型创建后不可改」：`type` 扩为 `'http' \| 'ws' \| 'tcp' \| 'udp'` |

**非目标（YAGNI 明确排除，二期候选）**：

- 任何响应/ACK 能力（TCP 连接只收不发；UDP 不回包）
- 按内容的匹配规则、帧格式配置（分隔符/定长/长度前缀）
- 按连接/来源分组的会话视图
- 同一端口号 TCP + UDP 并存（见 §3 约束）
- TLS、多播、广播

## 2. 架构决策

三个候选：

- **A. 端口类型派发（选定）**：`ports[].type` 扩枚举，`MockEngine._doStart` 按类型派发：`http/ws` 走现有 `http.createServer` 路径（不动），`tcp` 走 `node:net`，`udp` 走 `node:dgram`。捕获逻辑落在新模块 `src/capture.js`。
- **B. 独立 CaptureEngine 类**：tcp/udp 由第二个引擎管理。职责更单一，但启停/运行状态/API 门控（`syncMockEngine`、`/api/runtime/status`）都要管两份生命周期，改动面反而更大。
- **C. 通用协议适配器抽象**：定义 adapter 接口并把 http/ws 重构进去。最干净的长远形态，但要求重构没坏的代码，违反 YAGNI 与精准修改原则。

选定 A 的理由：与 WS 能力（2026-08-15）同构的扩展先例；`MockEngine` 的端口隔离、状态上报、启停串行化全部免费继承；改动面最小。捕获协议特异的逻辑（空闲聚合、连接表）收敛在 `capture.js`，`mock-engine.js` 只多处一个 switch 分支。

## 3. 数据模型

`data.json` **无 schema 变化，不需要 version 迁移**（v3 的 `ports[].type` 本就是自由字符串存储，存量数据不受影响）。

```jsonc
{
  "ports": [
    { "port": 8081, "enabled": true, "type": "http" },   // 不变
    { "port": 9000, "enabled": true, "type": "tcp" },    // 新增枚举值
    { "port": 9001, "enabled": true, "type": "udp" }
  ]
  // endpoints / services 与 tcp/udp 端口无关（这两类端口没有规则实体）
}
```

**约束**：

- 端口号全局唯一**维持不变**：`9000/tcp` 与 `9000/udp` 不能并存。协议栈层面虽合法，但全库以端口号为引用键（endpoints/services/级联/UI 路由），放开会引发连锁改键；一期记录为已知限制。
- `type` 创建后不可改（沿用 `FIELD_IMMUTABLE`）。
- 禁用端口不绑定；空 tcp/udp 端口绑定后正常接收（无规则概念，天然全收）。
- 改号/删除级联：`PUT/DELETE /api/ports/:port` 现有级联只碰 `endpoints`/`services`，对 tcp/udp 端口自然 no-op，无需新增代码。
- 类型互斥收紧：`api.js` 的 `assertHttpPort` 现仅拦 `type === 'ws'`，需放宽为 `type !== 'http'`（否则往 tcp/udp 端口能建 HTTP 端点，产生坏状态）；`api-services.js` 的 `ensureWsPortEntity` 已拦一切非 ws 类型，tcp/udp 方向天然被覆盖，无需改。
- TCP 空闲超时为代码常量 `DEFAULT_TCP_IDLE_MS = 200`（不落配置、不做 UI；真有多样需求时二期再提升为端口字段）。

## 4. 捕获引擎行为（`src/capture.js` + `mock-engine.js` 派发）

`MockEngine.start(endpoints, ports, services)` 签名不变。`_doStart` 主循环内按 `portEntity.type` 派发：

```
type http/ws → 现有路径（http.createServer + 对应 handler）—— 零改动
type tcp     → net.createServer(onConnection)
type udp     → dgram.createSocket('udp4')
```

**TCP 连接生命周期**：

```
connection（remote = ip:port，分配 connectionId）
├─ 落一条事件日志 { event: 'connect' }
├─ data → 追加进连接缓冲区；重置空闲定时器
│    缓冲区累计 > settings.maxBodyBytes（运行时读取，与 HTTP 一致）
│    → 截断保留前缀，标记 truncated，立即 flush（不等空闲）
├─ 空闲 200ms 无新数据 → flush 缓冲区为一条消息日志
├─ close（对端断开）→ 残余缓冲区 flush；落 { event: 'disconnect' }
└─ error（RST 等）→ 静默关闭连接，不杀进程、不污染 status
```

**限制**：

- 单端口活动连接上限 `MAX_TCP_CONNECTIONS = 200`：超出立即 destroy 新连接并落一条 warn 日志（`source: 'capture'`）。
- 已知行为：报文内部停顿超过 200ms 会把一条逻辑消息拆成两条日志——数据不丢，仅分条；一期接受。

**UDP**：每个 datagram 直接落一条消息日志（带 remote）。`maxBodyBytes` 同样截断（datagram 最大 64KB，实际很难触达，逻辑保持一致）。

**启停与隔离**（全部沿用现有不变量）：

- 单端口 bind 失败（EADDRINUSE 等）→ `statuses` 记 `{state:'failed', reason}`，不影响其他端口；`getStatus()` 形状不变。
- `stop()`：http/ws 走现有 close + closeIdleConnections；tcp 的 `net.Server` 需**显式跟踪活动 socket 并 destroy**（net 无 closeIdleConnections，`server.close()` 回调会等活动连接）；udp socket 直接 close。stop 后状态统一置 `stopped`。
- `syncMockEngine` 不变：任何端口 CRUD 触发全量重建，tcp/udp 端口同样即时生效。

## 5. 日志模型

`LogBuffer` 不变（环形 500 + subscribe fan-out）。捕获消息条目字段：

```jsonc
{
  "id": "uuid", "timestamp": 123,          // buildLogEntry 统一生成（沿用）
  "protocol": "tcp",                        // "tcp" | "udp"
  "port": 9000,                             // mock 端口
  "remote": "192.168.1.50:41234",           // 对端地址
  "connectionId": "uuid",                   // tcp 有，udp 为 null
  "bytes": 128,                             // 聚合字节数
  "payloadHex": "7e 01 02 ...",             // 预览（该字段自身上限 8192 字符，超出截断）
  "payloadText": "~ ...",        // utf8 预览（独立同样上限，语义对齐现有 previewBody）
  "payloadTruncated": false                 // 预览截断或 maxBodyBytes 截断
}
```

连接生命周期事件条目：`{ protocol, port, remote, connectionId, event: 'connect'|'disconnect' }`，无 payload 字段。

现有 http/ws 条目字段完全不变；前端按 `protocol` 字段区分渲染（无该字段 = http/ws 条目，向后兼容）。

## 6. API

- `POST /api/ports`：`type` 校验由 `['http','ws']` 扩为 `['http','ws','tcp','udp']`，非法值仍 400 `INVALID_VALUE`。
- 其余 API **零改动**：端口 PUT/DELETE 及级联、`/api/runtime/status`、`/api/logs`、`/events`（SSE）、`/api/config`。
- 类型互斥：`assertHttpPort` 放宽为 `type !== 'http'` 即拒（`PORT_TYPE_MISMATCH`），见 §3 约束；services 方向现有校验已覆盖。

## 7. UI

- **新建端口弹窗**：类型选择加 TCP / UDP 两项。
- **端口卡片**：协议徽标（HTTP/WS/TCP/UDP）；卡片其余交互（启用/改号/删除）不变。
- **端口详情页**（`#/port/:port`，type 为 tcp/udp）：页头沿用现有交互；主体为**该端口的实时捕获列表**——复用日志条目渲染，按 `port` 过滤全局日志流（SSE 驱动，无需新数据源）。http 端点的列表/排序/复制交互对 tcp/udp 端口不展示。
- **日志详情弹窗**：捕获条目展示 remote、字节数、hex/文本双视图切换；connect/disconnect 事件条目展示事件标签。
- 视觉沿用 Cinematic Dark Glass 现有体系，不引入新组件类型。

`embed-assets/` 同步：凡改 `public/`，递归同步副本并 diff 验证零漂移（既有不变量）。

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| tcp/udp 端口 bind 失败 | `failed` + `reason`，端口隔离（沿用） |
| TCP 连接 error/RST | 静默关闭该连接，不影响服务与其他连接 |
| 聚合缓冲超 `maxBodyBytes` | 截断 + `payloadTruncated: true`，立即 flush |
| 连接数超上限 | destroy 新连接 + warn 日志 |
| 捕获路径任何异常 | 不得杀死进程（与现有 handler 同标准）；兜底 try/catch 落 warn 日志 |

## 9. 测试计划

**单元**（`test/unit/capture.test.js`，vitest）：

- 空闲超时聚合：两次 data 间隔 < 200ms 合并为一条；> 200ms 分两条
- 连接关闭 flush 残余；无残余则不落消息条目
- `maxBodyBytes` 截断 + 立即 flush
- 连接上限拒绝 + warn
- UDP datagram 一报一条、remote 正确
- connect/disconnect 事件条目

**集成**（`test/integration/api-ports*.test.js` 扩充）：

- `POST /api/ports` 接受 tcp/udp、拒绝非法 type；`PUT` 传 type 仍 `FIELD_IMMUTABLE`
- tcp/udp 端口改号/停用/删除后 runtime status 正确同步
- 引擎运行中创建 tcp 端口立即可连（net 客户端实测）

**E2E**（Playwright headless，新增 `test/e2e/capture.spec.js`）：

- UI 建 TCP 端口 → `net` 客户端发字节 → 全局日志流出现捕获条目 → 详情弹窗 hex/文本切换
- UI 建 UDP 端口 → `dgram` 发包 → 日志流出现条目
- 端口卡片徽标与详情页捕获列表渲染

## 10. 二期挂钩（不实现，仅预留）

- 响应能力：tcp/udp 端口的规则实体（匹配 + 回复 payload + ACK），届时仿 `services` 新增顶级数组与路由。
- 会话分组视图：详情页按 `connectionId`/`remote` 分组（日志字段已含分组键）。
- 空闲超时可配化：常量提升为端口字段。

## 11. 文档影响

- `CLAUDE.md` 关键不变量 #9（端口类型枚举）、架构表（新增 `src/capture.js`）、测试布局需在实现完成后更新。
- 本 spec 的「已知限制」：同端口号 tcp/udp 不并存；200ms 停顿拆条。
