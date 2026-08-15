# WebService (SOAP/WSDL) Mock 设计

- 日期：2026-08-15
- 状态：已确认（用户分节批准）
- 前置：在现有 HTTP mock（REST/JSON）之上新增经典企业级 WebService mock 能力

---

## 1. 需求边界（澄清结论）

| 议题 | 结论 |
|---|---|
| 协议范围 | 经典 SOAP/WSDL WebService（XML over HTTP），不是 gRPC/XML-RPC |
| WSDL 角色 | 导入（粘贴文本 / 本地 .wsdl 文件）+ 手工增删 operation 均可 |
| 端口关系 | 同端口可挂多个 WS 服务，按 path 区分（如 `/ws/UserService`、`/ws/OrderService`） |
| 端口类型 | 端口分类型：`http` / `ws`，创建时确定，之后不可改 |
| operation 路由 | SOAPAction 优先，Body 解析回退 |
| 响应配置 | 固定 XML + 现有动态值表达式（`{{$...}}`），支持 正常 / SOAP Fault 切换 |
| WSDL 分发 | 提供 `GET {servicePath}?wsdl` 端点 |
| WSDL 导入方式 | 粘贴文本 + 本地文件，**不做 URL 在线拉取** |

**非目标（YAGNI 明确排除）**：

- 按请求内容（XPath/字段值）的条件多响应
- 从 http(s) URL 在线拉取 WSDL
- 解析外部 `wsdl:import` / `xsd:import` 引用的文件（只认单文件内联定义；解析不到 operation 时返回空列表，UI 提示可手工添加）
- WSDL 在线编辑（只导入替换，不提供编辑器）
- gRPC、XML-RPC、MTOM/附件、WS-Security 等扩展协议

## 2. 入口方案决策

三个候选：

- **A. 单页树形侧栏**：WS 端口详情页侧栏改为「服务→operation」二级树。不加深路由，但树控件是零框架代码库里的全新组件（展开/选中/键盘导航都要手写），侧栏宽度对两级文本局促，服务级操作（导入 WSDL、复制 ?wsdl 链接）无处安放。
- **B. 顶级 Tab 分流**：首页加「HTTP mock / WebService」tab，WS 首页直接列服务卡片。与已确认的「端口一等实体 + 端口分类型」模型割裂——WS 端口的启用/改号/删除入口无处安放，工作量最大。
- **C. 路由分层，页面范式全部复用（选定）**：

```
#/                     端口卡片（不变，加 HTTP/WS 徽标；新建弹窗加类型选择）
#/port/:port           http → 现有详情页（不变）
#/port/:port (ws)      服务卡片网格（复用首页卡片范式）
#/port/:port/svc/:sid  operation 列表 + 编辑（复用 HTTP 详情布局）
```

选定理由：每层页面都是已有范式（卡片网格 / 侧栏列表+编辑器），零新组件类型；路由即状态，可刷新可分享；与 2026-08-04 端口卡片重构的交互一致性最好，实现风险最低。代价是多一级跳转，对「服务少、operation 多」的典型形态几乎无感。

## 3. 数据模型（data.json v2 → v3）

```jsonc
{
  "version": 3,
  "settings": { /* 不变 */ },
  "ports": [
    { "port": 8081, "enabled": true, "type": "http" },   // 新增 type 字段
    { "port": 8082, "enabled": true, "type": "ws" }
  ],
  "endpoints": [ /* 不变，仅属于 http 端口 */ ],
  "services": [                        // 新增，仅属于 ws 端口
    {
      "id": "uuid",
      "port": 8082,
      "path": "/ws/UserService",       // 端口内唯一（启用服务间）
      "name": "UserService",
      "enabled": true,
      "targetNamespace": "http://example.com/user",  // 导入带入；手工默认 urn:{name}
      "wsdl": "<definitions>…",        // 导入的原始 WSDL 原文；手工创建为 null
      "operations": [                  // 嵌套在服务内（WSDL 导入 = 合并此列表）
        {
          "id": "uuid",
          "name": "getUser",           // 服务内唯一
          "soapAction": "urn:getUser", // 可空
          "responseType": "normal",    // "normal" | "fault"
          "status": 200,
          "responseXml": "<soap:Envelope>…</soap:Envelope>",
          "enabled": true
        }
      ]
    }
  ]
}
```

**迁移**：`_migrate` 增加 v2→v3：所有端口补 `type:'http'`，补空 `services: []`，version 置 3。新装默认配置直接给 v3 形状。

**约束**：

- 唯一性：ws 端口内 `(port, path)` 在 `enabled !== false` 的服务间唯一（新增 `ConfigStore.checkServiceUniqueness`，不动现有 `checkUniqueness`）；服务内 operation `name` 唯一（在 service 写入路径上校验）。
- 级联：`PUT /api/ports/:port` 改号 → `services` 同步改（现有 endpoints 级联旁加一处）；`DELETE /api/ports/:port` → 连带删该端口 services。
- 类型不可变：端口 `type` 创建后不可改（`PUT` 传 `type` → 400 `FIELD_IMMUTABLE`）；服务 `port` 不可改（跨端口迁移语义混乱，要移就删了重建 → 400 `FIELD_IMMUTABLE`）。
- 类型约束：往 ws 端口建 endpoint、往 http 端口建 service → 400 `PORT_TYPE_MISMATCH`。`ensurePortEntity` 补建端口时按调用来源显式带 `type`。
- service `path` 不允许含 `?`（会破坏 `?wsdl` 判定）→ 400 `INVALID_PATH`。
- `responseXml` 允许保存空串，但命中时返回 500 Fault（见 §7），不静默返回空响应。
- 禁用语义与现有 endpoints 对齐：`enabled:false` 的 service 其 path 不提供服务（按「path 未命中」404）；`enabled:false` 的 operation 匹配时跳过（落入未命中 Fault）。
- operation 匹配（soapAction 与 name）均为大小写敏感的精确比较（XML 惯例）。

## 4. mock 引擎行为

`MockEngine.start(endpoints, ports, services)` 加第三个参数（调用方：`api.js` 的 runtime/start、`test/helpers/test-server.js`）。`start` 主循环不变（端口隔离、单端口 EADDRINUSE 不影响其他、`getStatus()` 不动），按 `port.type` 分流 handler：http 端口走现有 `buildRouter`；ws 端口走 SOAP handler。

**WS 端口请求处理流程**：

```
请求进 ws 端口
├─ GET  {servicePath} + ?wsdl（查询键大小写不敏感）
│    → 200 text/xml; charset=utf-8
│    → service.wsdl 存在：原文返回，仅正则重写 soap:address / soap12:address
│      的 location 属性值为 http://{请求Host头}{service.path}
│      （不重建整棵 XML 树，其余字节原样保留；多个 address 全重写）
│    → service.wsdl 为 null：用 targetNamespace + operations 生成最小
│      doc/lit 骨架 WSDL（类型占位 xsd:anyType，soapAction 有就写，
│      address 同样指向 mock 地址）
├─ GET  {servicePath}（无 ?wsdl）
│    → 404 JSON，body 带 hint："SOAP endpoint, POST requests only;
│      append ?wsdl for WSDL"
├─ POST {servicePath}
│    → 读 body（沿用 maxBodyBytes 截断）
│    → 判定 SOAP 版本：Content-Type 含 application/soap+xml → 1.2，否则 1.1
│    → 提取操作名：
│       ① SOAPAction 头（1.1）或 Content-Type action= 参数（1.2），
│         去引号、去空白；空字符串视为未提供
│       ② 解析 Body：fast-xml-parser 开 removeNSPrefix，取
│         Envelope > Body 下第一个子元素名（= localName，前缀无关）
│    → 匹配 operation（按序，第一条命中即止）：
│       a. action 非空 → 精确匹配 o.soapAction
│       b. action 非空 → 取 action 末段（最后一个 : 或 / 之后）匹配 o.name
│       c. 按 Body localName 匹配 o.name
│       d. 仍未命中 → SOAP Fault，faultstring = "no mock for operation X"
│    → 命中 → resolve(responseXml) 跑动态值替换（字符串混合模式，管线零改动；
│      resolve 失败沿用现有行为：保留原文 + warn 日志）
│       → responseType = fault → HTTP 500 + 用户自写 Fault XML
│       → responseType = normal → 用户 status（默认 200）+ responseXml
│       → responseXml 为空 → 500 Fault "operation X has no response configured"
│    → 响应 Content-Type 跟随请求版本（1.2 → application/soap+xml;
│      charset=utf-8，否则 text/xml; charset=utf-8）
│    → 请求体是畸形 XML（Body 都解析不出）→ Fault：
│      1.1 → 500 + faultcode soap:Client；1.2 → 400 + Code soap:Sender
└─ path 未命中任何 service → 404 JSON（沿用现有风格）
```

**未命中/畸形请求的 Fault 结构跟随请求 SOAP 版本**：

- 1.1：`<faultcode>soap:Server|soap:Client</faultcode><faultstring>…`
- 1.2：`<Code><Value>soap:Receiver|soap:Sender</Value></Code><Reason><Text>…</Text></Reason>`

**新模块**（职责单一，可独立单测）：

| 模块 | 职责 |
|---|---|
| `src/wsdl.js` | `parseWsdl(xml)` → `{targetNamespace, serviceName?, operations:[{name, soapAction}]}`；`buildSkeletonWsdl(service, address)`；`rewriteAddress(wsdlText, address)`（纯正则改写 location 属性值） |
| `src/soap-router.js` | `detectSoapVersion(contentType)`；`extractAction(headers)`（1.1 头 + 1.2 action= 参数）；`extractBodyOperation(bodyText)`（removeNSPrefix 解析取 localName）；`matchOperation(service, action, bodyName)`（a>b>c 优先级）；`buildFaultXml(version, code, message)` |

**XML 解析依赖**：引入 `fast-xml-parser`（纯 JS、零原生依赖、Bun compile 兼容）。WSDL 解析与请求 Body 解析共用。不引入完整 SOAP 库（node-soap 等过重，我们只造响应不调服务）。

**WSDL 解析细则**（`parseWsdl`）：

- operation 名取自 `definitions > portType > operation[@name]`（多个 portType 全部合并）
- soapAction 取自 `binding > operation > soap:operation[@soapAction]`，`soap12:binding` 同样认；按 operation name 关联 portType；多个 binding 并存时按**文档序**取首个带 soapAction 的（解析统一开 `removeNSPrefix` 后无法可靠区分 soap/soap12 前缀，且实践中同一 portType 的两个 binding 的 soapAction 一致——此为对初版「1.1 优先」表述的修正）
- `targetNamespace` 取自 `definitions/@targetNamespace`，缺失时报 `INVALID_WSDL`
- 解析不出任何 operation → 返回空列表（不算错误，UI 提示可手工添加）
- 畸形 XML → 抛 `AppError(400, 'INVALID_WSDL', 解析器原始信息)`

**日志**：log 条目新增 `serviceId`、`operationName`（命中时写入）；未命中/Fault 照记，`matched:false`。请求体 XML 进 `requestBodyPreview`，现有日志详情弹窗直接可看。

## 5. API 面

新模块 `src/api-services.js`（仿 `api-ports.js` 的 `registerXxxRoutes` 风格），错误统一走 `AppError` 信封。

**Services CRUD**：

| 路由 | 行为 |
|---|---|
| `POST /api/services` | body `{port, path, name?, wsdl?}`。端口不存在 → 自动补建 `{port, enabled:true, type:'ws'}`；端口是 http 型 → 400 `PORT_TYPE_MISMATCH`；`(port,path)` 查重 → `DUPLICATE_SERVICE`。带 `wsdl` 时先 `parseWsdl`（失败 → `INVALID_WSDL`），用其结果初始化 `targetNamespace` + operations（默认响应模板，见下） |
| `PUT /api/services/:id` | 改 `name/path/enabled/targetNamespace`；path 查重；传 `port` → `FIELD_IMMUTABLE` |
| `DELETE /api/services/:id` | 删服务，不动端口实体（对齐「删 endpoint 不删端口」） |
| `POST /api/services/:id/wsdl` | 导入/替换 WSDL：`parseWsdl` → 更新 `wsdl/targetNamespace`，**合并** operations：同名保留响应配置（仅更新 soapAction）、新增补默认模板、WSDL 里没有的保留不删（手工加的 operation 不被导入冲掉） |

**Operations CRUD**（嵌套资源，不独立成表）：

| 路由 | 行为 |
|---|---|
| `POST /api/services/:id/operations` | `{name, soapAction?}`；name 服务内唯一 → `DUPLICATE_OPERATION`；默认响应模板 |
| `PUT /api/services/:id/operations/:opId` | 改 `name/soapAction/responseType/status/responseXml/enabled`；改名查重 |
| `DELETE /api/services/:id/operations/:opId` | 删 |

**operation 默认响应模板**（创建/导入时填充，方便用户直接改）：

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <tns:{name}Response xmlns:tns="{targetNamespace}">
      <!-- TODO: 响应字段 -->
    </tns:{name}Response>
  </soap:Body>
</soap:Envelope>
```

**WSDL 解析预览**（不落库，供导入弹窗第一步）：

- `POST /api/wsdl/parse` — body `{wsdl}` → `{targetNamespace, serviceName?, operations:[{name, soapAction}]}`；失败 → 400 `INVALID_WSDL`

**对现有 API 的改动（4 处）**：

1. `api-ports.js`：`POST /api/ports` 加可选 `type`（`'http'|'ws'`，默认 `'http'`）；`PUT` 改号级联 services、传 `type` → `FIELD_IMMUTABLE`；`DELETE` 连带删 services
2. `api.js`：`POST/PUT /api/endpoints` 校验目标端口不能是 ws 型 → `PORT_TYPE_MISMATCH`；`ensurePortEntity` 补建时显式 `type:'http'`
3. `api.js`：`GET /api/config` 响应层把 `services[].wsdl` strip 成 `hasWsdl: bool`（构建副本，不改 `configStore.config`；WSDL 可能几十 KB，不随全量配置往返。PATCH 只动 settings，不受影响）
4. `api-preview.js`：`POST /api/preview` 加 `format:'text'` 分支：跳过 `JSON.parse`，直接 `resolve(text)` 返回 `{ok, resolved: string, exprCount, errors}`——WS 编辑器预览复用同一路由

## 6. 前端

**路由**（`router.js` 加一条正则，其余不动）：

```
#/                     → home
#/port/:port           → port（按端口 type 分流渲染）
#/port/:port/svc/:sid  → service（新增；sid = service uuid）
```

**① 首页**（`views/port-cards.js` + `index.html` 新建端口弹窗）：

- 新建端口弹窗加类型 radio：「HTTP 接口」（默认）/「WebService (SOAP)」
- 端口卡片加 mono 小字类型徽标：`HTTP` 沿用靛蓝，`WS` 用琥珀色；计数行对 WS 端口显示「N 服务 · M 操作」

**② WS 端口详情页**（新 `views/ws-services.js`）：

- 页头完全复用现有 port-header（返回/端口号/启用 toggle/改号/删除/状态灯），`port-detail.js` 交互两类型通用
- 主体 = 服务卡片网格（复用 `port-card-grid` 样式体系）：
  - 卡片：服务名、`path`（mono）、operation 数、WSDL 状态（已导入/未导入）、启用态
  - 点击 → `#/port/:port/svc/:sid`；操作：复制服务地址、复制 `?wsdl` 地址、导入 WSDL、删除
- 「+ 新建服务」弹窗：仅名称 + 路径（WSDL 导入是独立弹窗）
- 空态引导卡片

**③ 服务详情页**（新 `views/ws-detail.js`）：

- 页头：← 返回服务列表、服务名 + path、启用 toggle、导入 WSDL、复制地址、删除服务
- 布局复用 HTTP 详情「侧栏 + 编辑区」：
  - 侧栏：operation 列表（名称 + soapAction 小字）+「+ 新建」
  - 编辑区：操作名 / SOAPAction（可空）/ 状态码 / 正常↔Fault 切换 + CodeMirror XML 编辑器
  - 工具栏复用：格式化、动态值（generator modal 挂到 XML 编辑器实例）、校验
  - 预览面板复用，调 `/api/preview` 的 `format:'text'` 分支
  - 页脚：删除 / 撤销 / 保存（沿用现有 dirty 模式）
- **导入 WSDL 弹窗**：粘贴 textarea + 本地文件选择 → `POST /api/wsdl/parse` 预览（operation 列表 + 「将新增 X、更新 Y、保留 Z」计数）→ 确认后提交

**④ CodeMirror XML**：新增 vendor `@codemirror/lang-xml`（+ `@lezer/xml`），importmap 加映射；`editor.js` bootstrap 参数化 `language: 'json'|'xml'`。

**⑤ 日志**：「结果」列对 WS 请求显示 operation 名（`✓ getUser` / `✗ Fault`）；详情弹窗不变。全局启停、状态 pill 不动。

**⑥ state 与接线**：`state` 新增 `services / selectedServiceId / selectedOperationId`；`render()` 在 `view:'port'` 时按端口 type 分流到 HTTP 详情或 WS 服务网格；`view:'service'` 渲染服务详情。

**⑦ embed-assets 同步（不变量 5）**：`views/ws-services.js`、`views/ws-detail.js`、vendor `lang-xml`/`@lezer/xml`、以及 `index.html`/`app.js`/`styles.css` 等所有改动文件同步到 `embed-assets/`。

## 7. 错误处理

新增 5 个错误码，全部走现有 `AppError` + 错误中间件信封：

| 码 | HTTP | 场景 |
|---|---|---|
| `INVALID_WSDL` | 400 | WSDL 解析失败（预览/导入/带 WSDL 建服务），message 带解析器原始信息 |
| `DUPLICATE_SERVICE` | 400 | `(port, path)` 冲突（启用服务间） |
| `DUPLICATE_OPERATION` | 400 | 服务内 operation name 冲突 |
| `PORT_TYPE_MISMATCH` | 400 | 端口类型与资源类型不符（双向） |
| `FIELD_IMMUTABLE` | 400 | 改端口 `type` / 改服务 `port` |

复用现有：`INVALID_PORT` / `INVALID_PATH`（含 `?` 校验）/ `INVALID_NAME` / `NOT_FOUND`。

运行时（mock 引擎侧，不经过 Express 错误中间件）：

| 场景 | 行为 |
|---|---|
| 未命中 operation | 500 Fault（版本跟随），`"no mock for operation X"` |
| 命中但 `responseXml` 为空 | 500 Fault `"operation X has no response configured"` |
| 请求体畸形 XML | 1.1 → 500 `soap:Client`；1.2 → 400 `soap:Sender` |
| 动态值 resolve 失败 | 保留原文 + warn 日志（沿用现有行为），请求不炸 |
| path 未命中 | 404 JSON（沿用现有风格） |

## 8. 测试策略

**单元**（vitest）：

- `test/unit/wsdl.test.js`：`parseWsdl` 各形态（soap12 binding、缺 soapAction、多 portType、命名空间前缀变体、缺 targetNamespace → INVALID_WSDL、畸形 XML）；`buildSkeletonWsdl`（含/不含 soapAction、targetNamespace 转义）；`rewriteAddress`（soap:address/soap12:address 都重写、多 port 全重写、无 address 原样）
- `test/unit/soap-router.test.js`：版本判定；action 提取（引号、空白、1.2 action= 参数）；Body localName（前缀变体、XML 声明、注释）；匹配优先级 a>b>c 及 action 末段兜底；Fault 两版本结构
- `test/unit/config-store.test.js` 补：v2→v3 迁移、`checkServiceUniqueness`

**集成**（vitest + supertest）：

- `test/integration/api-services.test.js`：CRUD、唯一性、`PORT_TYPE_MISMATCH` 双向、`FIELD_IMMUTABLE`、端口改号/删除级联 services、`GET /api/config` strip `wsdl`→`hasWsdl`、导入合并（同名保留响应配置）
- `test/integration/api-mock-ws.test.js`：起真引擎验证 `?wsdl`（导入的 → 地址重写；手工的 → 骨架）、POST 命中 1.1/1.2、SOAPAction 与 Body 回退、三类 Fault、404、`/api/preview` `format:'text'`

**E2E**（Playwright headed，不切 headless，沿用 `bootServer` + `page.evaluate(fetch)` 约定）：

- `test/e2e/ws-happy-path.spec.js`：新建 WS 端口（类型选择）→ 新建服务 → 粘贴 WSDL 导入（预览确认）→ operation 配响应 → 启动 → 发 SOAP 1.1 报文 → 断言响应 XML + 日志出现 operation 名

覆盖率目标 80%+（单元 + 集成）。

## 9. 文件清单

| | 文件 |
|---|---|
| 新增后端 | `src/wsdl.js`、`src/soap-router.js`、`src/api-services.js` |
| 修改后端 | `src/config-store.js`（v3 迁移 + checkServiceUniqueness）、`src/mock-engine.js`（start 第三参 + ws handler）、`src/api.js`（挂载/类型约束/config strip/runtime start 传参）、`src/api-ports.js`（type/级联）、`src/api-preview.js`（format:text）、`package.json`（+fast-xml-parser） |
| 新增前端 | `public/views/ws-services.js`、`public/views/ws-detail.js` |
| 修改前端 | `public/router.js`、`public/app.js`、`public/views/port-cards.js`、`public/views/port-detail.js`（如需）、`public/editor.js`（language 参数化）、`public/index.html`（importmap + 弹窗骨架）、`public/styles.css`（徽标等少量样式）、vendor 新增 `lang-xml`/`@lezer/xml` |
| 同步 | `embed-assets/`（不变量 5） |
| 测试 | 2 单元文件 + config-store 补充 + 2 集成文件 + 1 E2E 文件 |
| 文档 | 实现完成后更新 `CLAUDE.md`（不变量、文件指纹、架构表） |

## 10. 关键不变量更新（实现完成后写入 CLAUDE.md）

- 端口分类型 `http|ws`，创建后不可改；资源类型必须与端口类型匹配
- WS 路由优先级：`?wsdl` > SOAPAction 精确 > action 末段 > Body localName > Fault
- WSDL 返回必须重写 `soap:address location` 为 mock 自身地址
- `GET /api/config` 响应不含 `services[].wsdl` 原文（只有 `hasWsdl`）
