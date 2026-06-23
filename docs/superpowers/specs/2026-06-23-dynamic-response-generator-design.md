# 动态响应体生成器 — 设计

**日期**：2026-06-23
**状态**：待用户审查
**目标版本**：mock-server-webui v1 增量

---

## 1. 背景与目标

mock-server-webui 当前响应体是单块 CodeMirror JSON 编辑器 + 静态存储 + 静态服务。开发者用 mock 时经常需要"看起来真"的字段值（UUID、姓名、随机整数等），手工编出来的列表既重复又不真。

**目标**：让响应体里的字段值既能写死（现状），也能声明为"动态生成"。两类可以混在同一响应里。

**非目标（v1 故意不做）**：
- 不支持任意代码注入（生成器是白名单，不是 `eval`）
- 不支持运行时切换生成器（白名单改了需重启服务）
- 不支持视觉回归基线截图（v1 靠行为测试 + 手测）
- 不做客户端 faker（浏览器不打包，生成器只在服务端）
- 不做 i18n（UI 文案硬编码中文；生成器 locale 用白名单 locale 列表切换）

---

## 2. 架构总览

四个组件，生成器逻辑只在**服务端**有一份：

| 组件 | 位置 | 职责 |
|---|---|---|
| 浮动按钮 | CodeMirror 内（光标定位） | 触发模态框 |
| 生成器模态框 | `public/app.js` + `index.html` | 拉服务端目录，选生成器，插入表达式 |
| 表达式解析器 | 新增 `src/expression-resolver.js` | 单一 `resolve(value)`，被 mock 引擎和预览 API 共用 |
| 预览 API | 新增 `src/api-preview.js` + route | 接 editor 文本 → 解析 JSON → 递归解析表达式 → 返回 |

**布局变化**：响应体从单块 CodeMirror 改成左右两栏（左 3fr 编辑、右 2fr 预览）。

---

## 3. 表达式语法

存为字符串值内的占位文本：

```
"{{$<id>[:<arg>:<arg>:...]}}"
```

- `$id`：生成器 ID，允许点分（如 `name.fullName`）
- `arg`：可选参数，按生成器定义顺序，`:` 分隔
- 示例：
  - `"{{$uuid}}"` → UUID v4 字符串
  - `"{{$int:1:100}}"` → 1-100 的整数（仍是字符串，**类型不变**，见 §8 限制）
  - `"{{$date.recent:7}}"` → 最近 7 天的 ISO 字符串
  - `"{{$person.fullName:zh_CN}}"` → 中文姓名

**作用域**：只解析 string 类型的 value。object 的 key 含 `{{...}}` 不解析。

---

## 4. 生成器注册表（服务端单一来源）

文件 `src/generators/index.js`：

```js
export const GENERATORS = {
  uuid: {
    category: 'string',
    label: 'UUID v4',
    args: [],
    run: () => faker.string.uuid(),
  },
  int: {
    category: 'number',
    label: '整数',
    args: [
      { name: 'min', type: 'int', default: 0 },
      { name: 'max', type: 'int', default: 100 },
    ],
    run: ({ min, max }) => faker.number.int({ min, max }),
  },
  'name.fullName': {
    category: 'person',
    label: '姓名',
    args: [
      { name: 'locale', type: 'locale', default: 'zh_CN' },
    ],
    run: ({ locale }) => faker.person.fullName({ locale }),
  },
  // ... ~30-50 条
};
```

**为什么白名单**：
- 用户在 UI 里看到的和能用的完全一致（不会因 faker 重命名方法而崩）
- 服务端 schema 单一来源，文档 / 校验 / 分类都自动一致
- 安全：禁止任意代码路径

**v1 覆盖范围**：图里 9 个分类每个 2-5 条，总计 ~30 条：

| Category | Generators（举例） |
|---|---|
| string | `uuid`, `string.alphanumeric`, `string.nanoid`, `string.symbol` |
| lorem | `lorem.word`, `lorem.sentence`, `lorem.paragraph` |
| number | `int`, `float` |
| date | `date`, `date.recent`, `date.past`, `date.future` |
| person | `person.fullName`, `person.firstName`, `person.lastName`, `person.gender`, `person.jobTitle` |
| phone | `phone.number` |
| internet | `internet.email`, `internet.url`, `internet.domainName`, `internet.ip`, `internet.userName`, `internet.password` |
| image | `image.url`, `image.avatar`, `image.dataUri` |
| location | `location.street`, `location.city`, `location.country`, `location.zipCode` |

**locale 支持**：仅 `zh_CN` 和 `en` 两个值；模态框顶部可切换；person / location 类的生成器暴露 `locale` arg。

**库依赖**：`@faker-js/faker`（仅服务端 import，不进浏览器 bundle）。

---

## 5. UI 组件

### 5.1 响应体两栏布局（替换 `public/index.html:148-172`）

```
┌──────────────────────────┬────────────────────────┐
│ 响应体 · JSON    [校验]    │ 预览 · 已解析   [↻]      │
│ ┌──────────────────────┐ │ ┌────────────────────┐ │
│ │                      │ │ │ {                   │ │
│ │   CodeMirror 编辑器   │ │ │   "id": "a3f1-...", │ │
│ │   （3fr）             │ │ │   "age": 42,       │ │
│ │                      │ │ │   "name": "张三"   │ │
│ │      [动态值] ←浮按钮 │ │ │ }                   │ │
│ └──────────────────────┘ │ └────────────────────┘ │
│ 12 行 · 256 字符          │ 表达式: 3 · 错误: 1     │
└──────────────────────────┴────────────────────────┘
```

CSS grid：`grid-template-columns: 3fr 2fr`。两栏独立滚动。

工具栏分两组：左栏工具（校验、格式化、动态值），右栏工具（刷新、表达式统计）。

**v1 不做 resizer**（固定 3:2）。

### 5.2 浮动按钮

- CodeMirror `updateListener` 监听 cursor change
- 拿光标位置 → 在解析过的 JSON 树里查最深 string 节点
- 如果光标在 string token 的**字符范围**内（开闭引号之间，不含引号字符本身）：在该 token 右上方浮出小按钮「动态值」
- 定位用 `EditorView.coordsAtPos(from)`，绝对定位在 `.editor-body` 容器内
- **已含 `{{...}}` 的 string**：按钮变成「编辑表达式」，点击预填模态框

### 5.3 生成器模态框

按图 #1 1:1 复刻：

```
┌─────────────────────────────────────────┐
│ ← 数据生成器                       ×    │
├─────────────────────────────────────────┤
│ 类型                          简体中文 ▾│
│ ┌─────────────────────────────────────┐│
│ │ 选择一个动态值函数             🔍    ││
│ └─────────────────────────────────────┘│
│ › 字符串/UUID等               $string  │
│   UUID v4                      $uuid    │
│   字母数字串                   $string  │ ← 选中态高亮
│ › 数值                        $number  │
│   整数 (min:__ max:__)        $int     │ ← args 行内展开
│ › 日期/时间相关                 $date    │
│ › 姓名/性别/职业等             $person  │
│   姓名 (locale:__)            $name    │
│ › 电话/手机                   $phone   │
│ › 邮箱/网址/域名/IP/...        $internet│
│ › 图像相关                    $image   │
│ › 地址/区域相关                $location│
├─────────────────────────────────────────┤
│ 表达式: {{$int:1:100}}                  │
│ 预览: 42                       🔄       │
├─────────────────────────────────────────┤
│              [    插 入    ]              │
└─────────────────────────────────────────┘
```

**交互流程**：
1. 选类别 → 列表过滤
2. 搜 → 列表过滤（按 label 模糊匹配）
3. 选中某生成器 → 高亮 + args 行内展开（如有）
4. 调 args → 表达式 + 预览实时更新（防抖 200ms）
5. 点「插入」 → 替换编辑器 `from..to` 区间为 `"{{$expr}}"`（带引号），关闭

**插入未选生成器时「插入」按钮 disabled**。

---

## 6. API 端点

### 6.1 `GET /api/generators`

返回完整目录（含 categories / generators / args / sample）：

```json
{
  "locale": "zh_CN",
  "categories": [
    {
      "id": "string",
      "label": "字符串/UUID等",
      "generators": [
        { "id": "uuid", "label": "UUID v4", "args": [], "sample": "a3f1b2c4-..." }
      ]
    }
  ]
}
```

### 6.2 `POST /api/preview`

请求：

```json
{ "text": "{ \"id\": \"{{$uuid}}\" }" }
```

成功：

```json
{
  "ok": true,
  "resolved": { "id": "a3f1b2c4-...", "age": "42" },
  "exprCount": 1,
  "errors": []
}
```

注意：所有动态值在 resolved 输出中**均为 string**（与 §8 限制一致）——即使 `int` 生成器产生数字，也会 `String()` 后注入。所以 `int` 表达式出现在 `"age"` 字段时，输出是 `"age": "42"` 而非 `"age": 42`。

JSON 语法错：

```json
{
  "ok": false,
  "stage": "json-parse",
  "error": "Unexpected token } at line 12",
  "lastResolved": { ... }
}
```

`lastResolved` 仅在服务端有缓存上一次成功结果时填充（per-endpoint 缓存，`Cache-Control: private, max-age=0` 由客户端传 `If-None-Match` 触发；v1 简化为：客户端每次请求都带 `etag`，服务端命中则回 `lastResolved`；v1 不做可只返 `null`，前端退化用本地缓存）。

含坏表达式（软失败，不阻塞）：

```json
{
  "ok": true,
  "resolved": { "id": "{{$nonexistent}}" },
  "exprCount": 1,
  "errors": [{ "from": 11, "to": 28, "message": "未知生成器：$nonexistent" }]
}
```

### 6.3 `POST /api/generators/sample`

请求：`{ "id": "int", "args": { "min": 1, "max": 100 } }`
响应：`{ "ok": true, "sample": 42 }`

**所有新路由挂在 `createApi()` 末尾**（`src/api.js:34`），错误经 `errors.js` 的统一信封。

---

## 7. Mock 引擎接入

单点改动 `src/mock-engine.js:64`：

```js
// 之前
res.end(JSON.stringify(matched.response ?? null));

// 之后
import { resolve } from './expression-resolver.js';
try {
  const resolved = resolve(matched.response);
  res.end(JSON.stringify(resolved));
} catch (err) {
  log.warn('resolver failed', { id: matched.id, err: err.message });
  res.end(JSON.stringify(matched.response ?? null));
}
```

**关键约束**：
- 不引入新依赖到 mock-engine.js 顶层（faker 在 resolver 内部 import）
- catch 一切错误 → 降级发原始 JSON → 永远不返回 500
- 失败可在 `/api/logs` 看到（已有 source IP / body preview 字段，加 warning 标记）

---

## 8. 已知限制（v1 故意接受）

| 限制 | 原因 | 后续路径 |
|---|---|---|
| 所有动态值最终都是 string | inline 表达式语法固化为 string | 加 typed expression：`{{int:1:100}}` 用前缀决定解析类型 |
| 单次响应表达式数无上限 | 解析是 O(n)，n 通常很小 | 上限 + warning |
| 生成器白名单热更新不支持 | 改 `src/generators/index.js` 要重启 | 加 file watcher + reload |
| locale 仅 zh_CN / en | faker 支持更多但 v1 用不到 | 扩 `GENERATORS.locales` |
| 模态框无 visual regression 测试 | 行为测试 + 手测足够 | 加 Playwright screenshot baseline |

---

## 9. 错误处理汇总

| 失败点 | 行为 | 用户可见 |
|---|---|---|
| 编辑器 JSON 语法错 | 防抖 300ms 内不发；超时仍错：保留上次成功 + 顶部红条 | 红条：`第 12 行：Unexpected token }` |
| 表达式语法错（`{{` 没闭合） | 单条原样保留，标红 | 预览里红底；右下 toast |
| 未知生成器 ID | 单条原样保留 + 标红 + errors 记录 | 红底 + toast「未知生成器：$xxx」 |
| 生成器参数类型错 | 单条 → `null`，标红 | 同上 |
| Faker 抛错 | catch → `null` + warn 日志 | 预览里 `null`；日志可查 |
| `POST /api/preview` 网络失败 | 灰条「预览暂不可用」 | 灰条；编辑器 / 保存正常 |
| Mock 引擎解析失败 | catch → 发原始；warn 日志 | 客户端拿到带 `{{}}` 的 JSON |
| 模态框未选生成器 | 「插入」disabled | 灰 |
| `MOCK_MAX_BODY_PREVIEW` 截断 | 预览只显示截断部分 | 底部 `...已截断` |

**核心原则**：浏览器侧一切软失败（不阻断编辑、不阻断保存）；mock 引擎侧永不返回 500。

---

## 10. 测试

TDD 工作流（`tdd-guide` skill）：测试先写，实现到通过，重构。

### 10.1 单元（vitest）

- `test/unit/expression-resolver.test.js`
  - 标量无表达式：原样
  - 单表达式：解析
  - 多表达式：全部解析
  - 嵌套对象/数组：递归
  - object key 含 `{{}}`：不解析
  - 未知 ID：原样 + 错误对象
  - 参数类型错：null + 错误
  - Faker 抛错：catch → null
  - 空 / null / 非 string
- `test/unit/generators.test.js`
  - 每个注册生成器：`sampleArgs` 跑 → 输出符合 schema（UUID 格式、int 在范围、email 格式）
  - 缺省 args 能跑
  - locale 切换输出不同
- `test/unit/api-preview.test.js`
  - handler 各分支

### 10.2 集成（supertest）

- `test/integration/api-generators.test.js`
  - `GET /api/generators`：结构正确
  - `POST /api/generators/sample`：合法返回、非法返回 400
- `test/integration/api-preview.test.js`
  - 端到端：editor 文本 → resolved
  - 坏表达式：ok=true + errors
  - JSON 语法错：ok=false + lastResolved
- 扩展 `test/integration/mock-engine.test.js`
  - 端点 `response` 含 `{{$uuid}}`：hit mock port 两次，UUID 不同
  - 坏表达式：hit mock port → 原始 JSON，日志有 warning

### 10.3 E2E（Playwright headed — 保持 `headless: false`）

- `test/e2e/dynamic-response-generator.spec.js`
  - **happy path**：cursor 在 string → 浮按钮 → 模态框 → 搜 "uuid" → 选 → 插入 → 编辑器含 `"{{$uuid}}"` → 预览自动刷新
  - **multi expression**：插 `{{$uuid}}` 和 `{{$int:1:100}}` → 预览两边都解析
  - **JSON 语法错**：编辑到不合规 → 预览保留上次 + 红条
  - **表达式错**：写 `{{$nonexistent}}` → 预览红底
  - **端到端服务**：保存端点 → `hitMock()` → 返回 body 含真 UUID
  - **args**（int）：选 int → 调 min=1, max=100 → 表达式 + 预览实时更新

**不做**：视觉回归基线截图（v1 跳过）。

---

## 11. 实施 checklist（必须做）

- [ ] 改 `public/` 的任何文件（HTML / JS / CSS / SVG）**必须同步到 `embed-assets/public/`** —— 这是 Bun 打包的根（`build.mjs` 从 `./embed-assets` 扫描）。漏改会导致 dev 和 packaged 行为不一致。
- [ ] 不在浏览器 bundle 引入 faker：`@faker-js/faker` 只在 `src/` 内 import，且只在 `src/expression-resolver.js` 和 `src/generators/` 路径下。
- [ ] 改 `src/api.js` 后确认所有新路由挂在 `createApi()` 末尾、错误经 `errors.js` 信封。
- [ ] `pnpm test` 全过；`pnpm test:e2e` 全过（headed）；`bun build.mjs` 成功。

---

## 12. 决策记录

| 决策 | 选择 | 替代方案 | 理由 |
|---|---|---|---|
| UI 集成方式 | CodeMirror 内嵌浮按钮 | 字段表格 / 树视图 | 改动最小、复用现有 lint / 格式化 / 校验 |
| 存储模型 | 内嵌表达式字符串 `"{{...}}"` | 结构化 marker 对象 | 用户在编辑器里能看到占位、JSON 始终合法 |
| 预览触发 | 防抖 300ms 自动 + 手动刷新 | 仅按钮 | 「实时看到」是用户明确要求 |
| 表达式作用域 | 只解析 string value | 含 key | key 是字段名，不应动态 |
| 生成器机制 | 白名单 + 服务端注册表 | 直接 faker 方法名 | 用户可见=可用、不会因上游重命名崩、安全 |
| 生成器位置 | 服务端（resolver + API） | 客户端也打包 | 浏览器 bundle 不背 faker 体积 |
| 生成器数量 v1 | 全量覆盖图 9 类（~30 条） | 精选 5-6 条 | 用户明确要求「全量覆盖图上所有分类」 |
| 错误策略 | 浏览器侧软失败 / 引擎侧降级 | 任一失败即整体失败 | 编辑流不被打断；mock 服务永不 500 |
| i18n | v1 硬编码中文 | 走 i18n 字典 | 项目当前无 i18n 基础设施，引入不值 |
| 视觉回归 | v1 不做 | Playwright screenshot baseline | YAGNI |
| 热加载 | v1 不做（改注册表需重启） | file watcher reload | v1 不必要 |
