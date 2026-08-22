# Syslog 接收 Mock 设计

- 日期：2026-08-22
- 状态：已确认（用户 2026-08-22 批准设计草案）
- 前置：TCP/UDP 纯抓包能力（2026-08-22 spec，已落地）。本特性在其 UDP 捕获路径上叠加 syslog 协议解析与结构化展示。

---

## 1. 需求边界（澄清结论）

| 议题 | 结论 |
|---|---|
| 解析深度 | **结构化解析展示**：解析 RFC 3164/5424 头部，日志行显示 severity 着色徽标 + hostname + message 摘要，详情弹窗字段化 |
| 传输 | **仅 UDP**。一个 datagram = 一条 syslog 消息，天然分帧 |
| 报文格式 | **RFC 3164 与 RFC 5424 自动识别**（5424 在 PRI 后有版本号 `1 `，可区分）；解析失败兜底原文展示 |
| 响应 | 无任何回复（syslog 本为 fire-and-forget） |
| 默认端口 | 新建弹窗选 syslog 类型时预填 **514**（被占用则顺延到下一个空闲端口），仅为建议值可改 |

**非目标（YAGNI 明确排除）**：

- TCP syslog、RFC 6587 分帧（octet-counting / non-transparent）
- structured-data 深度解析（SD 原样字符串保留）
- syslog over TLS
- 任何响应/ACK

## 2. 架构决策

- **A. syslog 独立端口类型，复用 UDP 捕获 + 解析层（选定）**：`ports[].type` 加 `'syslog'`，引擎派发到同一个 `createUdpCaptureSocket`（仅加两个可选参数 `protocol`/`parse`），解析器独立为 `src/syslog.js` 纯函数模块。
- B. 作为 udp 端口的「解析模式」标志：破坏 type 单字段心智模型（徽标/视图分派都要看 type+mode），模式可切换导致历史日志一半 raw 一半结构化。
- C. 完全独立 syslog 模块：重复造 UDP socket/截断/错误处理逻辑，违反 DRY。

选定 A：与「type 决定一切」模型一致；capture.js 保持协议无关（syslog 解析由引擎注入），解析器可独立单测。

## 3. 数据模型

`data.json` 无迁移：`ports[].type` 枚举扩为 `'http'|'ws'|'tcp'|'udp'|'syslog'`。syslog 端口无 endpoints/services 实体；端口号全局唯一不变；`type` 创建后不可改不变。

类型互斥自动覆盖：`assertHttpPort` 已是 `type !== 'http'` 即拒；`ensureWsPortEntity` 已拒一切非 ws。

## 4. 解析器行为（`src/syslog.js`，纯函数）

```js
parseSyslog(buf: Buffer) → {
  ok: boolean,                    // 完整头部解析成功（3164/5424 任一）
  format: 'rfc5424' | 'rfc3164' | 'raw',
  facility: number | null,        // PRI 存在即有值
  severity: number | null,        // 0..7
  hostname: string | null,
  appName: string | null,         // 3164 的 tag / 5424 的 APP-NAME
  procId: string | null,
  msgId: string | null,           // 仅 5424
  timestamp: string | null,       // 原文时间字符串（不转 Date）
  structuredData: string | null,  // 仅 5424，原样保留（含方括号）
  message: string,                // 剩余报文；raw 时为全文 utf8
}
```

**解析链**（逐级回退，任何一步失败都不抛错）：

1. **PRI**：`<NNN>` 开头 → `facility = NNN >> 3`，`severity = NNN & 7`。无 PRI → `{ ok:false, format:'raw', message: 全文 }`，其余字段 null。
2. **5424 判定**：PRI 后匹配 `/^1 /` → 按 `TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD [SP MSG]` 切分；字段 `-`（nilvalue）→ null。字段不足 → 回退 3164。
3. **3164 判定**：`Mmm dd hh:mm:ss`（单-digit 日允许双空格）时间戳 + hostname + `tag[pid]:` 或裸文本。时间戳不匹配 → `{ ok:false, format:'raw' }`（PRI 字段仍保留）。
4. 全程 try/catch 兜底：解析器对任意字节输入**永不抛错**。

**常量导出**：`SEVERITY_NAMES = ['emerg','alert','crit','err','warning','notice','info','debug']`；`FACILITY_NAMES`（0 kern … 23 local7，RFC 5424 §6.2.1 表）。

## 5. 捕获层与引擎接线

`src/capture.js` 的 `createUdpCaptureSocket` 签名扩展（可选参数，向后兼容）：

```js
createUdpCaptureSocket({ port, logBuffer, getMax, protocol = 'udp', parse = null })
```

- 条目用 `protocol` 构建；`parse` 存在时对**截断后保留的 payload** 执行，结果 `ok` 则挂到 `entry.syslog`。
- `parse` 调用必须 try/catch（铁律：捕获路径任何异常不杀进程），异常 = 无 `syslog` 字段。

`src/mock-engine.js`：`type === 'udp' || type === 'syslog'` 走 UDP 分支；syslog 注入 `protocol: 'syslog', parse: parseSyslog`（引擎 import `src/syslog.js`）。record 仍为 `{ kind: 'udp', socket }`——stop/隔离/状态逻辑零改动。

## 6. 日志模型

捕获条目扩展（解析成功时多一个字段，其余不变）：

```jsonc
{
  "protocol": "syslog",            // 覆盖 capture 默认的 'udp'
  "port": 514, "remote": "192.168.1.10:41234", "bytes": 117,
  "payloadHex": "…", "payloadText": "…", "payloadTruncated": false,
  "syslog": {                      // parseSyslog 且 ok:true 时存在
    "format": "rfc3164", "facility": 16, "severity": 6,
    "hostname": "myhost", "appName": "myapp", "procId": "123",
    "msgId": null, "timestamp": "Aug 22 14:30:00", "structuredData": null,
    "message": "link up on eth0"
  }
}
```

LogBuffer / SSE / `/api/logs` 零改动；前端按 `entry.syslog` 有无决定结构化渲染。

## 7. API

- `POST /api/ports`：`type` 校验枚举 + `'syslog'`，非法值仍 400 `INVALID_VALUE`。
- 其余零改动（启停/状态/级联/日志/SSE）。

## 8. UI

- **新建弹窗**：类型下拉加 `Syslog 接收 (UDP)`；选中且 514 空闲时端口号预填 514（被占则 `nextFreePort` 顺延），切回其他类型恢复 `nextFreePort`。
- **端口卡片**：徽标 `SYSLOG`（`type.toUpperCase()` 天然成立）；stats 首行 `类型 / Syslog 接收`；「最近活动」对 syslog 条目显示 `severity 名 · hostname`（无 `syslog` 字段回退通用 `协议 · 字节数` 形式）。
- **详情视图**：`effectiveView` 加 `'syslog' → 'capture-port'`（页头 + 实时捕获日志区复用）。
- **日志行**（`renderCaptureLogEntry` 加 syslog 分支）：

  | 列 | 内容 |
  |---|---|
  | 协议 chip | `SYSLOG` |
  | 路径列 | `{hostname} · {message 摘要}`（无 syslog 字段时回退 remote） |
  | 状态列 | severity 着色徽标：err(≤3) 红 / warning(4) 黄 / notice·info(5-6) 蓝 / debug(7)·未解析 灰 |
  | 结果列 | `接收` |

- **详情弹窗**（`renderCaptureLogDetail` 加 syslog 分支）：meta 字段表追加 `facility`（如 `16 (local0)`）、`severity`（如 `6 (info)`）、`hostname`、`应用`、`进程 ID`、`消息 ID`、`对端时间戳`、`消息`；数据区仍展示完整原文 hex/文本（复用现有切换）。

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| 任意畸形报文 | 解析回退 raw，条目正常落日志（无 syslog 字段） |
| 解析器异常 | try/catch 吞掉 → 同 raw 处理；进程不受影响 |
| 其余 | 全部沿用捕获层既有语义（bind 隔离、socket error 静默、截断标记） |

## 10. 测试计划

**单元**（`test/unit/syslog.test.js`）：

- 3164：完整（`<134>Aug 22 14:30:00 myhost myapp[123]: hello` → facility 16 / severity 6 / appName myapp / procId 123）；无 pid；单-digit 日双空格
- 5424：带 SD / 无 SD（`-` nilvalue）/ 无 MSG；`<13>1 …` → facility 1 / severity 5
- 兜底：无 PRI、PRI 后垃圾（facility/severity 保留、ok:false、format:'raw'）、任意字节不抛错

**单元**（`test/unit/mock-engine.test.js` 或 capture 侧扩充）：

- syslog 端口收 RFC3164 datagram → `entry.protocol === 'syslog'` 且 `entry.syslog` 字段正确
- 畸形 datagram → 无 `syslog` 字段、条目照常落

**集成**（`api-ports.test.js` 扩充）：type `syslog` 201；非法 type 400；往 syslog 端口建端点 → `PORT_TYPE_MISMATCH`。

**E2E**（`capture.spec.js` 扩充）：UI 选 syslog 类型（预填 514 断言后改自定义端口）→ 建端口 → 启动 → dgram 发 RFC3164 报文 → 日志行含 severity 徽标 + hostname → 详情弹窗字段表正确。

## 11. 二期挂钩（不实现）

- TCP syslog + RFC 6587 分帧
- structured-data 解析为键值对
- 按 severity/facility 的日志筛选

## 12. 文档影响

- `CLAUDE.md` 不变量 #9 枚举 + `syslog`；模块职责表加 `src/syslog.js` 行。
- `embed-assets/public/` 同步（既有不变量）。
