# 数据生成器：millisecond 时间戳 + 本地格式日期 — 设计

**日期**：2026-07-07
**状态**：待用户审查
**目标版本**：mock-server-webui v1 增量

---

## 1. 背景与目标

mock 响应体里经常需要"看起来真"的时间字段（创建时间、更新时间、订单时间等）。现有 4 个 date 生成器（`date` / `date.recent` / `date.past` / `date.future`）全部输出 ISO 8601 字符串，缺少两类常见需求：

1. **Unix 毫秒时间戳**（number）— 后端 API 普遍用 ms 而不是 ISO
2. **本地格式 `yyyy-MM-dd hh:mm:ss`**（string）— 中文项目调试时最常见的展示格式

**目标**：在 `date` 分类下加 3 个新生成器，覆盖上面两个需求。

**非目标（v1 故意不做）**：
- 不加自定义时区参数（`date.format` 固定本地时区，需要 UTC 的人用 `date.now` 自己处理）
- 不加 locale 变体（`date.format` 固定数字格式 `yyyy-MM-dd hh:mm:ss`）
- 不加更多格式变体（`date.formatMs` / `date.formatUTC` 等）
- 不改前端 UI（生成器通过 `/api/generators` 自动可见，模态框多 3 个可选项）
- 不重构现有 date 生成器

---

## 2. 三个新生成器

| ID | outputType | 时间源 | 输出示例 |
|---|---|---|---|
| `timestamp` | `number` | faker 全域随机过去/未来 | `1720000000000` |
| `now` | `number` | `Date.now()` 当前时间 | `1720000000123` |
| `format` | `string` | `Date.now()` 当前时间 | `"2026-07-07 11:14:15"` |

`timestamp` 范围由 `faker.date.anytime()` 决定（公元 1970 至今），无参数。
`format` 输出**本地时区**的 `yyyy-MM-dd hh:mm:ss`，不是 UTC（与现有 `date.*` 的 UTC ISO 不同——后者是 ISO 标准；前者是调试可读性优先）。

---

## 3. 架构 / 数据流

```
用户编辑响应体：{ "createdAt": "{{$now}}", "updatedAt": "{{$format}}" }
                              ↓ 保存
                              ↓
mock 引擎收到请求 → resolve(response)
                              ↓
对每个 string value 扫到 {{$id:arg}} 表达式
                              ↓
runGenerator(id, args)：
  'now'      → Date.now()  → number  → resolver 看到 outputType='number' → 注入为 number
  'format'   → formatLocalDateTime(new Date()) → string  → 注入为 string
  'timestamp'→ faker.date.anytime().getTime()  → number  → 注入为 number
                              ↓
JSON.stringify(响应体)：
  { "createdAt": 1720000000123, "updatedAt": "2026-07-07 11:14:15" }
```

resolver 已有"纯 number 表达式保留 number 类型"逻辑（见 specs/2026-06-23 §3 类型规则），新生成器无需改 resolver。

---

## 4. 实现细节

### 4.1 `src/generators/index.js` 新增

```js
// ─── date 续 ────────────────────────────────────────────
'timestamp': {
  category: 'date', label: '毫秒时间戳（随机）', outputType: 'number', args: [],
  run: () => faker.date.anytime().getTime(),
},
'now': {
  category: 'date', label: '当前时间毫秒', outputType: 'number', args: [],
  run: () => Date.now(),
},
'format': {
  category: 'date', label: '本地格式 yyyy-MM-dd hh:mm:ss', outputType: 'string', args: [],
  run: () => formatLocalDateTime(new Date()),
},
```

### 4.2 `formatLocalDateTime` 手写格式化器

```js
function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/**
 * 把 Date 格式化为本地时区的 `yyyy-MM-dd hh:mm:ss`。
 * 不依赖 Intl / locale 库 — `getFullYear/getMonth/...` 返回本地数字。
 * @param {Date} date
 * @returns {string}
 */
function formatLocalDateTime(date) {
  return [
    date.getFullYear(),
    '-', pad(date.getMonth() + 1),
    '-', pad(date.getDate()),
    ' ', pad(date.getHours()),
    ':', pad(date.getMinutes()),
    ':', pad(date.getSeconds()),
  ].join('');
}
```

### 4.3 CATEGORIES 追加

```js
{ id: 'date', label: '日期/时间相关',
  generatorIds: ['date', 'date.recent', 'date.past', 'date.future', 'timestamp', 'now', 'format'] },
```

---

## 5. 边界情况

| 场景 | 行为 |
|---|---|
| `timestamp` 返回 0 | faker 不返回 1970 之前的日期；理论可能为 0，单测断言 `>= 0` 兜底 |
| `now` 在 `xx:59:59.999` 调，下一秒读 | 两次读格式差 1 秒 — 设计预期 |
| `format` 服务器时区切换 | 输出格式相同（数字无歧义），但 hour 数字随本地时区变 — 设计预期 |
| `format` 跨午夜 | 自动变成下一天 — 设计预期 |
| 单测断言 `format` 具体数字 | 不可写死（依赖时区）；只断言**格式正则** |
| `timestamp` mock 服务内连续调用 | 极小概率两值相同；mock 语义允许 |

---

## 6. 错误处理

三个新生成器都无参数、无外部依赖（`faker` 已有、`Date` 平台内置），不会抛错。沿用 `runGenerator` 的统一 try/catch 包装即可。

---

## 7. 测试

### 7.1 Unit（`test/unit/generators.test.js`）

新增 describe `date — new generators`：

```js
describe('date — new generators (timestamp / now / format)', () => {
  it('timestamp returns a positive integer', () => {
    const v = runGenerator('timestamp', {});
    expect(typeof v).toBe('number');
    expect(v).toBeGreaterThan(0);
    expect(Number.isInteger(v)).toBe(true);
  });

  it('now returns current Date.now() within tolerance', () => {
    const before = Date.now();
    const v = runGenerator('now', {});
    const after = Date.now();
    expect(v).toBeGreaterThanOrEqual(before);
    expect(v).toBeLessThanOrEqual(after);
  });

  it('format outputs yyyy-MM-dd hh:mm:ss pattern (local TZ)', () => {
    const v = runGenerator('format', {});
    expect(typeof v).toBe('string');
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('format reflects current time (matches new Date components)', () => {
    const v = runGenerator('format', {});
    const d = new Date();
    expect(v).toContain(String(d.getFullYear()));
  });
});
```

### 7.2 Integration（`test/integration/api-generators.test.js`）

加 3 个 it：

```js
it('GET /api/generators lists timestamp / now / format in date category', async () => {
  const r = await request.get('/api/generators');
  const date = r.body.categories.find((c) => c.id === 'date');
  const ids = date.generators.map((g) => g.id);
  expect(ids).toContain('timestamp');
  expect(ids).toContain('now');
  expect(ids).toContain('format');
});

it('POST /api/generators/sample returns valid samples for new generators', async () => {
  for (const id of ['timestamp', 'now', 'format']) {
    const r = await request.post('/api/generators/sample').send({ id, args: {} });
    expect(r.status, `id=${id}`).toBe(200);
    expect(r.body.ok, `id=${id}`).toBe(true);
    expect(r.body.sample, `id=${id}`).not.toBeNull();
  }
});
```

### 7.3 E2E（`test/e2e/dynamic-response-generator.spec.js`，**可选**）

在现有 happy-path 测试加一个 case：响应体含 `{{$now}}` 和 `{{$format}}`，触发请求后验证响应是合法 JSON 且字段类型正确（number / string）。

> 此 E2E 加可不加（unit + integration 已覆盖核心）。优先不打断当前 E2E suite，待用户确认是否要加。

---

## 8. 数据流（端到端）

```
编辑器 → 响应体文本: '{"createdAt":"{{$now}}","display":"{{$format}}"}'
              ↓ 保存 → data.json
              ↓
GET /api/preview  → resolver
              ↓
  看到 {{$now}}      → runGenerator('now')      → 1720000000123 (number) → 注入 number
  看到 {{$format}}   → runGenerator('format')   → "2026-07-07 11:14:15" (string) → 注入 string
              ↓
预览面板: {"createdAt":1720000000123,"display":"2026-07-07 11:14:15"}
              ↓
真实 mock 请求触发 → 同样路径 → 响应体同上
```

---

## 9. 风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 三个新生成器在分类数组里顺序漂移导致快照测试碎 | 低 | 项目无快照测试，集成测试只用 `toContain` 检查存在性 |
| `format` 单测在 CI（UTC）和本地（其他时区）行为不同 | 低 | 单测只断言**格式正则**和**当前年份**，不写死 hour/minute |
| faker 升级后 `anytime()` 行为变化 | 低 | faker 锁定在 `package.json` 当前版本，API 稳定 |
| 大量 `{{$now}}` 在同一响应里被并发触发（同一 ms） | 低 | 设计预期：mock 场景允许同值 |
| 与现有 ISO 生成器（`date` / `date.recent` 等）混淆 | 低 | label 写明"本地格式"区分 |

---

## 10. 文件清单

```
src/generators/index.js                  改：3 个新生成器 + formatLocalDateTime + CATEGORIES 追加
test/unit/generators.test.js             改：3 个新生成器的单元测试
test/integration/api-generators.test.js  改：3 个新生成器在 /api/generators 列表中
```

无前端改动（生成器通过 `/api/generators` API 自动暴露）。无 embed-assets 改动。无 CLAUDE.md 改动。

---

## 11. 实施顺序

1. 后端：`src/generators/index.js` 加 3 个生成器 + `formatLocalDateTime`（**可独立 PR**）
2. 测试：`test/unit/generators.test.js` 加 4 个 it（依赖 1）
3. 测试：`test/integration/api-generators.test.js` 加 2 个 it（依赖 1）
4. （可选）E2E：扩 `test/e2e/dynamic-response-generator.spec.js`
5. 全量回归 + 提交

---

**自审**：
- ✅ 无占位符 / TBD / TODO
- ✅ 数据模型（输出类型）明确，无歧义
- ✅ 范围聚焦：3 个生成器、1 个 helper、3 个测试文件改动
- ✅ 与现有 date.* 区分清楚（label + outputType）
- ✅ 本地时区 vs UTC 在第 2 / 4.1 / 5 节三次明确说明
