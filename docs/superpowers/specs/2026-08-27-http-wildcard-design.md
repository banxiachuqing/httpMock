# HTTP 接口 URL 通配符设计

- 日期：2026-08-27
- 状态：已评审（用户逐节确认）
- 范围：http 类型端点的 path 通配匹配 + 响应内路径参数回显；ws/tcp/udp/syslog 端口不受影响

---

## 1. 背景与目标

当前 mock 引擎按 `port|method|path` 拼字符串做 Map 精确查找（`src/mock-engine.js` `createHttpHandler`），请求 path 必须与配置一字不差，否则 404。RESTful 资源 ID（`/users/123`、`/users/456` 共用一个 mock）、前缀兜底（`/api/*` 下全部返回同一响应）等场景无法表达。

目标：为 http 端点 path 引入**段级通配符**，同时让响应能回显匹配到的路径值。

## 2. 语法与校验规则

仅两条通配规则，其余字符一律字面：

| Pattern 元素 | 语义 |
|---|---|
| 字面段 | 原样匹配该段 |
| `*`（独占一段） | 匹配任意**单个非空**段 |
| `**`（独占一段） | 匹配**零个或多个**段（跨段） |

匹配示例：

- pattern `/api/*/cmd`：✅ `/api/v1/cmd`；❌ `/api/cmd`（`*` 不匹配空）；❌ `/api/v1/v2/cmd`（`*` 不跨段）
- pattern `/api/**`：✅ `/api`（零段）✅ `/api/v1` ✅ `/api/v1/deep/x`
- 允许多个 `**`：pattern `/a/**/b/**` 合法

**拆段规则**：pattern 与请求 path 统一 `split('/')` 后丢弃空段——`/a/` 与 `/a` 在通配匹配中等价。注意：**不含通配符的 path 仍走现有 Map 原样精确匹配**（现有行为零变化），拆段只发生在通配候选判定里。

**入库校验**（`src/api.js` `validateEndpointBody` 新增，沿用 400 `INVALID_PATH`）：

- `*`、`**` 必须独占一段（两侧是 `/` 或字符串边界）；`fo*`、`*x`、`***`、`/a/*b/c` 一律拒绝
- 不做"段内部分通配"这类隐式语义——大声失败
- 其余校验不变（`/` 开头、无 `?` `#`）

**唯一性**：完全不动，仍按 `port|method|path` **字符串字面**精确比较（`ConfigStore.checkUniqueness`）。两个 pattern 字面相同才算冲突；语义重叠（`/a/*` vs `/a/**`）允许共存，由优先级裁决。

## 3. 匹配引擎

### 3.1 新模块 `src/path-pattern.js`（纯函数，无状态）

```
isPattern(path)                    → 是否含 * / **
validatePattern(path)              → 非法时返回原因（供 api.js 抛 INVALID_PATH）
compilePattern(path)               → { segments, endpoint }（编译为段数组）
compareSpecificity(a, b)           → 具体度比较器（排序用）
matchSegments(compiled, pathSegs)  → string[] | null（命中返回各通配段捕获值）
```

匹配用**拆段数组 + 回溯**（非正则）：`*` 消费恰好一段并记录；`**` 依次尝试消费 0..n 段（回溯）；字面段要求相等。捕获值按通配段从左到右出现顺序入数组。

### 3.2 `buildRouter` 改造（每端口一个 router）

```
router = {
  exact:    Map<`${method}|${path}`, endpoint>  // 字面 path，现状原样保留
  patterns: Map<method, compiledPattern[]>      // 通配端点按 method 分桶 + 预排序
}
```

### 3.3 请求匹配流程（`createHttpHandler`）

1. 查 `exact` Map —— 命中即返回（现有精确路径行为零变化）
2. miss → 取该 method 的通配桶（已按具体度排序），逐个 `matchSegments`，**第一个命中即赢**，捕获值存为 `pathParams`
3. 全 miss → 404（现状）

### 3.4 具体度比较器（`buildRouter` 时一次性排序，请求时零比较开销）

- 逐段从左到右打分：**字面段(2) > `*`(1) > `**`(0)**，第一处分出胜负即定
  - 例：`/a/*/c` 胜 `/*/b/c`；`/a/*/*` 胜 `/a/**`
- 逐段类型全同 → 段数多者胜（`/a/**/b` 胜 `/a/**`）
- 完全平手 → 依赖 JS 稳定排序，保持**配置顺序**（端点列表先配置者赢）

**优先级总纲：精确 > 具体度 > 配置顺序。**

### 3.5 日志

命中通配时日志条目加 `pathParams: string[]`（精确命中不带该字段），排查命中路径时一目了然。

## 4. `{{$path:N}}` 回显

**语法**：`{{$path:1}}`、`{{$path:2}}`……编号按 pattern 中通配段从左到右出现顺序（`*` 与 `**` 混编，1 起）。`**` 捕获多段时用 `/` 拼回。

- pattern `/a/*/b/**` 匹配 `/a/x/b/y/z` → `{{$path:1}}`=`x`，`{{$path:2}}`=`y/z`
- 选 `:N` 位置参数语法：现有表达式正则与 args 机制原样兼容，`expression-resolver.js` 解析正则、`api-preview.js` 的 `EXPR_RE` 零改动

**接入**（复用生成器体系，不旁路——resolver 是单一来源）：

1. `src/generators/index.js` 新增 `path` 生成器（新分类 `request`「请求上下文」）：`run({ index }, ctx)` 读 `ctx.pathParams[index-1]`；越界或无上下文 → 抛错，走既有 BAD_ARGS 路径（warn 日志 + 纯表达式→null / 混合→原文兜底）
2. `runGenerator(id, args, ctx)` 加第三参透传；`resolve(value, ctx)` 加第二参透传。现有生成器 `run(merged)` 只取一参，向后零影响
3. `createHttpHandler`：`resolve(matched.response, { pathParams })`；精确命中时 `pathParams: []`（写 `$path:1` 报越界，行为一致）；WS 的 `renderXmlResponse` 不传 ctx

**JSON 类型**：`path` 生成器 `outputType: 'string'`。纯表达式 `{"id": {{$path:1}}}` 按字符串原类型注入；混合 `"{{$path:1}}"` 字符串拼接——两种写法都对。

**预览 API**（无需改代码）：

- `/api/generators` 列表中 `path` 的 sample 为 `null`（现有 catch 兜底）
- `/api/preview` 无请求上下文 → `$path` 进 `errors` 数组（"无对应值"），预览值保留原文

## 5. 前端改动（轻量，无新组件）

1. **端点表单**（`public/index.html` + `public/app.js`）：path 输入框 placeholder/帮助文案——"`/` 开头；支持 `*` 匹配单段、`**` 跨段；响应中可用 `{{$path:1}}` 回显"
2. **端点列表**（`app.js` 端点条目渲染处）：path 含 `*` 的端点加「通配」徽标
3. **生成器面板**（`app.js` generatorModal）：分类数据驱动自动出现「请求上下文」；`path` 生成器 sample 为 `null` 时显示"请求时确定"

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 非法 pattern 入库（`fo*`、`*x`、`***`） | 400 `INVALID_PATH`，不入库 |
| `{{$path:N}}` 越界（通配段数不足）/ 无请求上下文 | 生成器抛错 → resolver warn 日志 + 兜底（纯表达式→null，混合→保留原文），请求正常返回 |
| 通配匹配过程 | 纯函数确定性计算，不抛错；全 miss → 404 |
| 存量保护 | statusCode 兜底、readBody 截断等现有机制不变 |

## 7. 测试策略

| 层 | 文件 | 覆盖点 |
|---|---|---|
| 单元（新） | `test/unit/path-pattern.test.js` | `isPattern`/`validatePattern`（`fo*`、`*x`、`***` 拒绝）；拆段（`/a/`≡`/a`）；`matchSegments`：`*` 不匹配空段/不跨段、`**` 零段/多段/多 `**`；`compareSpecificity`：字面>`*`>`**`、逐段、段数、稳定序 |
| 单元（追加） | `test/unit/mock-engine.test.js`、`test/unit/expression-resolver.test.js` | 精确优先于通配、通配命中与 404 兜底、`resolve(value, ctx)` 透传、`$path` 越界报错 |
| 集成（追加） | `test/integration/api-endpoints.test.js` | 非法 pattern → 400；通配端点 CRUD；唯一性仍按字面（`/a/*` 与 `/a/**` 可共存） |
| E2E | ego-browser 场景验证（**本项目 E2E 偏好用 ego-browser，不新增 Playwright spec**） | 建 `/api/*/cmd` → 请求 `/api/v1/cmd` 命中且响应含 `{{$path:1}}` 回显；再建精确 `/api/v1/cmd` 验证优先级反超；非法 pattern 表单报错 |

## 8. 文档同步

- `CLAUDE.md` 关键不变量第 1 条补注（唯一性仍按字面三元组）；新增不变量：通配优先级 = 精确 > 具体度 > 配置顺序
- `public/` 改动同步 `embed-assets/`（不变量 5）

## 9. 非目标（本期明确不做）

- `:id` 命名参数语法（位置编号已够用）
- 段内部分通配（`fo*`、`*.html`）
- method 通配、query 串匹配
- ws/tcp/udp/syslog 端口的任何通配语义
- 存量 Playwright E2E 迁移（继续可用，仅新场景用 ego-browser）

## 10. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/path-pattern.js` | 新建：isPattern / validatePattern / compilePattern / compareSpecificity / matchSegments |
| `src/mock-engine.js` | `buildRouter` 两路分发 + 预排序；`createHttpHandler` 通配匹配分支、`resolve` 传 ctx、日志加 `pathParams` |
| `src/api.js` | `validateEndpointBody` 加 pattern 校验一条 |
| `src/expression-resolver.js` | `resolve(value, ctx)` 第二参透传 |
| `src/generators/index.js` | `runGenerator` 第三参；新增 `path` 生成器 + `request` 分类 |
| `public/index.html`、`public/app.js` | 表单文案、通配徽标、生成器 sample null 显示 |
| `embed-assets/` | 同步 public 改动 |
| `CLAUDE.md` | 不变量补注 + 新增优先级不变量 |
