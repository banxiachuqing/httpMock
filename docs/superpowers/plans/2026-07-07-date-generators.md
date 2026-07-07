# 数据生成器：millisecond 时间戳 + 本地格式日期 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `date` 分类下加 3 个新生成器（`timestamp` 随机毫秒 / `now` 当前毫秒 / `format` 本地 `yyyy-MM-dd hh:mm:ss`），覆盖常见 mock 时间字段需求。

**Architecture:** 三个新条目加入 `src/generators/index.js` 的 `GENERATORS` 注册表，沿用现有 date.* 的模式（faker `date.*` 或 `Date.now()`，加 `outputType`）。`format` 用一个 8 行的 `formatLocalDateTime(date)` 手写 helper（不用 `Intl` / `date-fns`），`pad(n, w=2)` 辅助。零依赖。`CATEGORIES.date.generatorIds` 追加三个新 ID。前端不动（`/api/generators` 自动暴露）。

**Tech Stack:** Node ≥18 · 原生 ESM（无 TS）· `@faker-js/faker`（已装）· vitest（已有）· Express 4（已有）

## 文件总览

**新建**：无

**修改**：
- `src/generators/index.js` — 加 3 个新生成器 + `formatLocalDateTime` helper + `CATEGORIES.date.generatorIds` 追加
- `test/unit/generators.test.js` — 加 `date — new generators` describe 块（4 个 it）
- `test/integration/api-generators.test.js` — 加 2 个 it

无前端改动、无 embed-assets 同步、无 CLAUDE.md 改动。

## Global Constraints

- Node ≥18，ESM 原生（package.json `"type": "module"`）
- TDD：每任务「先写失败测试 → 最小实现 → 测试通过 → 提交」
- 提交格式：`<type>(scope): <subject>`（feat / fix / test / chore / docs）
- 提交消息用简体中文（项目约定）
- 错误经 `src/errors.js` 的 `AppError` / `toErrorResponse` / `statusFor` 信封
- 命名：函数 `camelCase`，常量 `SCREAMING_SNAKE_CASE`
- 不写 `console.log`（生产代码）

---

## Task 1: 后端 — 3 个新生成器 + helper + 单元测试

**Files:**
- Modify: `src/generators/index.js`（在 date 块后追加 3 个条目 + 新 helper 函数 + `CATEGORIES.date.generatorIds` 追加）
- Modify: `test/unit/generators.test.js`（末尾追加新 describe 块）

**Interfaces（被本任务定义，下游消费方）：**
```js
// src/generators/index.js exports（既有 API 不变）：
GENERATORS['timestamp']  // { category: 'date', label: '毫秒时间戳（随机）', outputType: 'number', args: [], run: () => faker.date.anytime().getTime() }
GENERATORS['now']        // { category: 'date', label: '当前时间毫秒', outputType: 'number', args: [], run: () => Date.now() }
GENERATORS['format']     // { category: 'date', label: '本地格式 yyyy-MM-dd hh:mm:ss', outputType: 'string', args: [], run: () => formatLocalDateTime(new Date()) }
// CATEGORIES.find(c => c.id === 'date').generatorIds 末尾追加 ['timestamp', 'now', 'format']

// 新 helper（私有，不导出）：
function formatLocalDateTime(date: Date): string  // 'yyyy-MM-dd hh:mm:ss' 本地时区
```

### Step 1: 写失败测试

`test/unit/generators.test.js` 末尾追加：

```js
describe('date — new generators (timestamp / now / format)', () => {
  it('timestamp returns a positive integer', () => {
    const v = runGenerator('timestamp', {});
    expect(typeof v).toBe('number');
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });

  it('now returns Date.now() within tolerance', () => {
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

  it('format reflects current local time (contains current year)', () => {
    const v = runGenerator('format', {});
    expect(v).toContain(String(new Date().getFullYear()));
  });
});
```

### Step 2: 跑测试确认失败

Run:
```bash
pnpm vitest run test/unit/generators.test.js
```

Expected: 新加 describe 内的 4 个 it 全部失败（`未知生成器：timestamp` / `now` / `format`）。

### Step 3: 实现 — 加 helper + 3 个生成器 + CATEGORIES

`src/generators/index.js` 找到 `date.future` 条目（line 85-89），在它之后追加：

```js
  'date.timestamp': {
    category: 'date', label: '毫秒时间戳（随机）', outputType: 'number', args: [],
    run: () => faker.date.anytime().getTime(),
  },
  'date.now': {
    category: 'date', label: '当前时间毫秒', outputType: 'number', args: [],
    run: () => Date.now(),
  },
  'date.format': {
    category: 'date', label: '本地格式 yyyy-MM-dd hh:mm:ss', outputType: 'string', args: [],
    run: () => formatLocalDateTime(new Date()),
  },
```

> **注意 ID 命名**：spec 中用户视角是"毫秒时间戳/当前时间毫秒/本地格式"，在 `date` 分类下避免 ID 与 `date.recent` 等冲突 — 加 `date.` 前缀更清晰。**这里和 spec 文档的 `timestamp/now/format` 不一致** — 两种命名都说得通：
> - spec 用 `timestamp/now/format`（短）
> - 这里用 `date.timestamp/date.now/date.format`（一致 `date.*` 命名空间）
>
> 跟用户确认后选择其一。如未确认，先用 `date.*` 前缀版（更符合现有命名空间约定）。

在 `LOCALES` 常量（line 212 附近）之后、`pickFaker` 函数之前，加 helper：

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

在 `CATEGORIES` 数组里找到 `id: 'date'` 的条目，把 `generatorIds` 改为：

```js
{ id: 'date', label: '日期/时间相关', generatorIds: ['date', 'date.recent', 'date.past', 'date.future', 'date.timestamp', 'date.now', 'date.format'] },
```

### Step 4: 跑测试确认通过

Run:
```bash
pnpm vitest run test/unit/generators.test.js
```

Expected: 全部通过（旧的 8 categories 不变，新增 3 个 generator 在 date 分类下不影响 category 计数）。

### Step 5: 跑全量单测确认无回归

Run:
```bash
pnpm vitest run
```

Expected: 全部通过（关注 `test/unit/generators.test.js` 的"CATEGORIES lists each category once" — 加了 3 个 generator 后 categories 数组 length 仍是 9，不变）。

### Step 6: 提交

```bash
git add src/generators/index.js test/unit/generators.test.js
git commit -m "feat(generators): 加 timestamp / now / format 三个日期生成器

- date.timestamp: faker 随机过去/未来时间的 getTime()（毫秒整数）
- date.now: Date.now()（毫秒整数）
- date.format: 本地时区 yyyy-MM-dd hh:mm:ss（手写格式化器，零依赖）
- 三个都加进 CATEGORIES.date.generatorIds
- 不动 resolver，outputType=number/string 走现有纯/混合表达式逻辑"
```

---

## Task 2: 集成测试 — /api/generators 暴露 3 个新生成器

**Files:**
- Modify: `test/integration/api-generators.test.js`（追加 2 个 it）

### Step 1: 写测试

`test/integration/api-generators.test.js` 末尾（在 `describe('POST /api/generators/sample', ...)` 块内）追加：

```js
it('GET /api/generators lists date.timestamp / date.now / date.format in date category', async () => {
  const res = await ctx.request.get('/api/generators');
  expect(res.status).toBe(200);
  const dateCat = res.body.categories.find((c) => c.id === 'date');
  const ids = dateCat.generators.map((g) => g.id);
  expect(ids).toContain('date.timestamp');
  expect(ids).toContain('date.now');
  expect(ids).toContain('date.format');
});

it('POST /api/generators/sample returns valid samples for new generators', async () => {
  for (const id of ['date.timestamp', 'date.now', 'date.format']) {
    const res = await ctx.request.post('/api/generators/sample').send({ id, args: {} });
    expect(res.status, `id=${id}`).toBe(200);
    expect(res.body.ok, `id=${id}`).toBe(true);
    expect(res.body.sample, `id=${id}`).not.toBeNull();
  }
  // date.format 必须是合法格式字符串
  const fmtRes = await ctx.request.post('/api/generators/sample').send({ id: 'date.format', args: {} });
  expect(fmtRes.body.sample).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // date.now 必须是合理毫秒（> 2020-01-01）
  const nowRes = await ctx.request.post('/api/generators/sample').send({ id: 'date.now', args: {} });
  expect(nowRes.body.sample).toBeGreaterThan(1577836800000);
});
```

### Step 2: 跑测试确认通过

Run:
```bash
pnpm vitest run test/integration/api-generators.test.js
```

Expected: 全部通过（Task 1 已实现，这步是回归保护）。

### Step 3: 跑全量集成测试确认无回归

Run:
```bash
pnpm vitest run
```

Expected: 全部通过。

### Step 4: 提交

```bash
git add test/integration/api-generators.test.js
git commit -m "test(generators): 验证 /api/generators 暴露 3 个新日期生成器

GET /api/generators 列表中 date 分类含 date.timestamp / date.now / date.format；
POST /api/generators/sample 三者都能正常 sample（now > 2020-01-01 ms、format 匹配本地格式正则）。"
```

---

## 验收清单

- [ ] `pnpm vitest run` 全部通过
- [ ] 单元测试：`timestamp` 返回正整数 / `now` 在 `Date.now()` 容差内 / `format` 匹配 `yyyy-MM-dd hh:mm:ss` 正则 / `format` 含当前年
- [ ] 集成测试：`/api/generators` date 分类含 3 个新 ID；`/api/generators/sample` 三者都返回合法 sample
- [ ] 编辑响应体输入 `{{$date.now}}` → 预览面板显示裸数字（无引号）
- [ ] 编辑响应体输入 `{{$date.format}}` → 预览面板显示 `2026-XX-XX hh:mm:ss` 字符串
- [ ] `CATEGORIES` length 仍是 9（不加 category，只加 generator）
- [ ] 提交 2 个 commit（Task 1 后端 + Task 2 测试）

---

**Plan 自审**：
- ✅ Spec §11 实施顺序覆盖：后端 → unit → integration
- ✅ Spec §2 / §4.1 / §4.2 全部对应到 Task 1 Step 3
- ✅ Spec §7.1 / §7.2 测试对应到 Task 1 Step 1 + Task 2 Step 1
- ✅ 无占位符 / TBD / TODO
- ✅ 类型一致：`formatLocalDateTime(Date) → string`、3 个生成器 `outputType` 与 spec 一致
- ✅ Step 3 显式标出 spec 中 `timestamp/now/format` 与现有 `date.*` 命名空间的两选分歧，需用户拍板（先用 `date.*` 前缀）
