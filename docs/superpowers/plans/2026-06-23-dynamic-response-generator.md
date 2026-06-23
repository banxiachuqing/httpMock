# 动态响应体生成器 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 mock-server-webui 响应体里支持「固定值 / 动态生成」混合模式。CodeMirror 内嵌浮按钮 + 数据生成器模态框，响应体拆为左编辑 + 右实时预览两栏，mock 引擎在服务时解析表达式动态生成响应。

**Architecture:** 生成器逻辑只在服务端（白名单 + `@faker-js/faker`）；浏览器不打包 faker。表达式语法 `{{$id:arg:arg}}` 存在 string value 内；resolver 走「纯 vs 混合」分流 — 纯保留 `outputType`，混合 → string。三个新 API（`/api/generators`、`/api/preview`、`/api/generators/sample`）+ mock-engine 单点接入。

**Tech Stack:** Node ≥18 · 原生 ESM（无 TS）· Express 4 · `@faker-js/faker`（仅服务端）· CodeMirror 6（已有）· vitest + supertest（已有）· Playwright headed（已有）

## 文件总览

**新建**：
- `src/generators/index.js` — 生成器注册表 + `runGenerator` / `listGenerators` / `getSample`
- `src/expression-resolver.js` — `resolve(value)` + `parseExpression(text)` + 错误类
- `src/api-preview.js` — 三个新路由的 handler
- `test/unit/expression-resolver.test.js`
- `test/unit/generators.test.js`
- `test/integration/api-preview.test.js`
- `test/integration/api-generators.test.js`
- `test/e2e/dynamic-response-generator.spec.js`

**修改**：
- `package.json` — 加 `@faker-js/faker`
- `src/api.js` — 在 `createApi()` 末尾挂三个新路由
- `src/mock-engine.js` — 第 64 行接入 resolver
- `public/index.html` — 响应体拆双栏 + 模态框 markup
- `public/app.js` — 预览逻辑 + 模态框逻辑 + 3 个新 `api.*` 方法
- `public/editor.js` — `mountEditor` 加 `onSelectionChange` 回调
- `public/styles.css` — 双栏布局 + 模态框 + 浮按钮样式
- `embed-assets/public/{index.html,app.js,editor.js,styles.css}` — 镜像 public/
- `test/integration/mock-engine.test.js` — 加动态值用例

## Global Constraints

- Node ≥18，ESM 原生（package.json `"type": "module"`）
- 改 `public/` 任一文件 → 必须镜像到 `embed-assets/public/`（Bun 打包根，dev 与 packaged 一致性）
- `@faker-js/faker` 只在 `src/` 顶层 import；不进浏览器 bundle
- 所有新 API 路由挂 `createApi()` 末尾，错误经 `src/errors.js` 信封
- TDD：每任务「先写失败测试 → 最小实现 → 测试通过 → 提交」
- 所有公共 API 用 JSDoc 标注类型；不可变更新；不写 `console.log`（生产代码）
- E2E 保持 `headless: false` + `slowMo: 50`（`playwright.config.js` 已固定）
- 提交格式：`<type>(scope): <subject>`（feat / fix / test / chore / docs）

---

## Task 1: 添加 `@faker-js/faker` 依赖

**Files:**
- Modify: `package.json`
- Test: 无（依赖安装本身即验证）

**Step 1: 安装依赖**

Run:
```bash
pnpm add @faker-js/faker
```

Expected: 输出 `+ @faker-js/faker 9.x.x` 之类，`package.json` 的 `dependencies` 段新增一行，`pnpm-lock.yaml` 更新。

**Step 2: 验证可在 Node 内 import**

Run:
```bash
node -e "import('@faker-js/faker').then(m => console.log(typeof m.faker.string.uuid))"
```

Expected: 输出 `function`

**Step 3: 提交**

```bash
git add package.json pnpm-lock.yaml
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "chore(deps): add @faker-js/faker for dynamic response generators

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: GENERATORS 注册表 + 测试

**Files:**
- Create: `src/generators/index.js`
- Create: `test/unit/generators.test.js`

**Interfaces（被本任务定义，下游消费方）：**
```js
// src/generators/index.js exports:
export const GENERATORS      // { [id: string]: { category, label, outputType, args, run } }
export const CATEGORIES      // [{ id, label, generatorIds: string[] }]
export const LOCALES         // ['zh_CN', 'en']
export function runGenerator(id: string, args: object): string | number | boolean
export function listGenerators(): Array<{ category: string, generator: object, sample: any }>
export function getSample(id: string, partialArgs?: object): any
```

**Step 1: 写失败测试**

`test/unit/generators.test.js`：

```js
import { describe, it, expect } from 'vitest';
import {
  GENERATORS, CATEGORIES, LOCALES,
  runGenerator, listGenerators, getSample,
} from '../../src/generators/index.js';

describe('GENERATORS registry', () => {
  it('contains entries for all 9 categories from spec §4', () => {
    const cats = new Set(Object.values(GENERATORS).map((g) => g.category));
    expect(cats).toEqual(new Set(['string', 'lorem', 'number', 'date', 'person', 'phone', 'internet', 'image', 'location']));
  });

  it('every generator declares outputType', () => {
    for (const [id, g] of Object.entries(GENERATORS)) {
      expect(['string', 'number', 'boolean', 'date'], `generator ${id}`).toContain(g.outputType);
    }
  });

  it('every generator has label, args, run', () => {
    for (const [id, g] of Object.entries(GENERATORS)) {
      expect(typeof g.label, `label ${id}`).toBe('string');
      expect(Array.isArray(g.args), `args ${id}`).toBe(true);
      expect(typeof g.run, `run ${id}`).toBe('function');
    }
  });

  it('CATEGORIES lists each category once with generatorIds', () => {
    expect(CATEGORIES.length).toBe(9);
    for (const c of CATEGORIES) {
      expect(c.id).toBeTruthy();
      expect(c.label).toBeTruthy();
      expect(c.generatorIds.length).toBeGreaterThan(0);
      for (const gid of c.generatorIds) {
        expect(GENERATORS[gid], `missing generator ${gid}`).toBeDefined();
        expect(GENERATORS[gid].category).toBe(c.id);
      }
    }
  });

  it('LOCALES contains zh_CN and en', () => {
    expect(LOCALES).toEqual(['zh_CN', 'en']);
  });
});

describe('runGenerator', () => {
  it('uuid returns a UUID v4 string', () => {
    const v = runGenerator('uuid', {});
    expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('int respects min/max', () => {
    for (let i = 0; i < 50; i++) {
      const v = runGenerator('int', { min: 5, max: 7 });
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('int uses defaults when args omitted', () => {
    const v = runGenerator('int', {});
    expect(Number.isInteger(v)).toBe(true);
  });

  it('float returns a number', () => {
    const v = runGenerator('float', {});
    expect(typeof v).toBe('number');
  });

  it('internet.email matches email regex', () => {
    const v = runGenerator('internet.email', {});
    expect(v).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  it('internet.ip matches IPv4', () => {
    const v = runGenerator('internet.ip', {});
    expect(v).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  it('internet.url matches http(s)://', () => {
    const v = runGenerator('internet.url', {});
    expect(v).toMatch(/^https?:\/\//);
  });

  it('phone.number returns a non-empty string', () => {
    const v = runGenerator('phone.number', {});
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('person.fullName with locale=zh_CN returns a string', () => {
    const v = runGenerator('person.fullName', { locale: 'zh_CN' });
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('person.fullName with locale=en returns a string', () => {
    const v = runGenerator('person.fullName', { locale: 'en' });
    expect(typeof v).toBe('string');
  });

  it('date.recent with days=7 returns a Date or ISO string', () => {
    const v = runGenerator('date.recent', { days: 7 });
    expect(typeof v === 'string' || v instanceof Date).toBe(true);
  });

  it('image.url returns a URL-like string', () => {
    const v = runGenerator('image.url', {});
    expect(v).toMatch(/^https?:\/\//);
  });

  it('location.city returns a string', () => {
    const v = runGenerator('location.city', { locale: 'zh_CN' });
    expect(typeof v).toBe('string');
  });

  it('throws for unknown id', () => {
    expect(() => runGenerator('does.not.exist', {})).toThrow(/未知生成器/);
  });

  it('throws when required arg missing', () => {
    expect(() => runGenerator('int', { min: 'not a number' })).toThrow();
  });
});

describe('listGenerators', () => {
  it('returns one entry per generator with computed sample', () => {
    const list = listGenerators();
    expect(list.length).toBe(Object.keys(GENERATORS).length);
    for (const entry of list) {
      expect(entry.category).toBeTruthy();
      expect(entry.generator.id).toBeTruthy();
      expect('sample' in entry).toBe(true);
    }
  });
});

describe('getSample', () => {
  it('returns a sample for known id', () => {
    const s = getSample('uuid');
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });

  it('merges partialArgs with defaults', () => {
    const s = getSample('int', { min: 100, max: 100 });
    expect(s).toBe(100);
  });

  it('returns null for unknown id (does not throw)', () => {
    const s = getSample('nope');
    expect(s).toBeNull();
  });
});
```

**Step 2: 运行测试，验证失败**

Run:
```bash
pnpm vitest run test/unit/generators.test.js
```

Expected: FAIL — `Cannot find module '../../src/generators/index.js'`

**Step 3: 实现 `src/generators/index.js`**

```js
// 生成器白名单注册表 —— 服务端单一来源
// 输出类型语义见 specs/2026-06-23-dynamic-response-generator-design.md §3、§4
import { faker, fakerEN, fakerZH_CN } from '@faker-js/faker';

/**
 * @typedef {'string' | 'number' | 'boolean' | 'date'} OutputType
 * @typedef {{ name: string, type: 'int'|'float'|'string'|'locale', default?: any, min?: number, max?: number }} ArgSpec
 * @typedef {{ category: string, label: string, outputType: OutputType, args: ArgSpec[], run: (a: Record<string, any>) => any }} GeneratorDef
 */

/** @type {Record<string, GeneratorDef>} */
export const GENERATORS = {
  // ─── string ────────────────────────────────────────────
  uuid: {
    category: 'string', label: 'UUID v4', outputType: 'string', args: [],
    run: () => faker.string.uuid(),
  },
  'string.alphanumeric': {
    category: 'string', label: '字母数字串', outputType: 'string',
    args: [{ name: 'length', type: 'int', default: 10, min: 1, max: 64 }],
    run: ({ length }) => faker.string.alphanumeric(length),
  },
  'string.nanoid': {
    category: 'string', label: 'Nano ID', outputType: 'string',
    args: [{ name: 'length', type: 'int', default: 21, min: 1, max: 64 }],
    run: ({ length }) => faker.string.nanoid(length),
  },
  'string.symbol': {
    category: 'string', label: '特殊符号', outputType: 'string',
    args: [{ name: 'count', type: 'int', default: 5, min: 1, max: 32 }],
    run: ({ count }) => faker.string.symbol(count),
  },

  // ─── lorem ─────────────────────────────────────────────
  'lorem.word': {
    category: 'lorem', label: '单词', outputType: 'string', args: [],
    run: () => faker.lorem.word(),
  },
  'lorem.sentence': {
    category: 'lorem', label: '句子', outputType: 'string',
    args: [{ name: 'words', type: 'int', default: 7, min: 1, max: 30 }],
    run: ({ words }) => faker.lorem.sentence(words),
  },
  'lorem.paragraph': {
    category: 'lorem', label: '段落', outputType: 'string',
    args: [{ name: 'sentences', type: 'int', default: 3, min: 1, max: 20 }],
    run: ({ sentences }) => faker.lorem.paragraph(sentences),
  },

  // ─── number ────────────────────────────────────────────
  int: {
    category: 'number', label: '整数', outputType: 'number',
    args: [
      { name: 'min', type: 'int', default: 0 },
      { name: 'max', type: 'int', default: 100 },
    ],
    run: ({ min, max }) => faker.number.int({ min, max }),
  },
  float: {
    category: 'number', label: '浮点数', outputType: 'number',
    args: [
      { name: 'min', type: 'float', default: 0 },
      { name: 'max', type: 'float', default: 1 },
      { name: 'fractionDigits', type: 'int', default: 2, min: 0, max: 10 },
    ],
    run: ({ min, max, fractionDigits }) =>
      faker.number.float({ min, max, fractionDigits }),
  },

  // ─── date ──────────────────────────────────────────────
  date: {
    category: 'date', label: 'ISO 日期时间', outputType: 'date', args: [],
    run: () => faker.date.anytime().toISOString(),
  },
  'date.recent': {
    category: 'date', label: '近期日期', outputType: 'date',
    args: [{ name: 'days', type: 'int', default: 7, min: 1, max: 365 }],
    run: ({ days }) => faker.date.recent({ days }).toISOString(),
  },
  'date.past': {
    category: 'date', label: '过去日期', outputType: 'date',
    args: [{ name: 'years', type: 'int', default: 1, min: 1, max: 100 }],
    run: ({ years }) => faker.date.past({ years }).toISOString(),
  },
  'date.future': {
    category: 'date', label: '未来日期', outputType: 'date',
    args: [{ name: 'years', type: 'int', default: 1, min: 1, max: 100 }],
    run: ({ years }) => faker.date.future({ years }).toISOString(),
  },

  // ─── person ────────────────────────────────────────────
  'person.fullName': {
    category: 'person', label: '姓名', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.fullName(),
  },
  'person.firstName': {
    category: 'person', label: '名', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.firstName(),
  },
  'person.lastName': {
    category: 'person', label: '姓', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.lastName(),
  },
  'person.gender': {
    category: 'person', label: '性别', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.gender(),
  },
  'person.jobTitle': {
    category: 'person', label: '职业', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).person.jobTitle(),
  },

  // ─── phone ─────────────────────────────────────────────
  'phone.number': {
    category: 'phone', label: '电话号码', outputType: 'string',
    args: [{ name: 'format', type: 'string', default: '###-###-####' }],
    run: ({ format }) => faker.phone.number({ style: 'national' }),
  },

  // ─── internet ──────────────────────────────────────────
  'internet.email': {
    category: 'internet', label: '邮箱', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).internet.email(),
  },
  'internet.url': {
    category: 'internet', label: 'URL', outputType: 'string', args: [],
    run: () => faker.internet.url(),
  },
  'internet.domainName': {
    category: 'internet', label: '域名', outputType: 'string', args: [],
    run: () => faker.internet.domainName(),
  },
  'internet.ip': {
    category: 'internet', label: 'IP 地址', outputType: 'string', args: [],
    run: () => faker.internet.ip(),
  },
  'internet.userName': {
    category: 'internet', label: '用户名', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).internet.userName(),
  },
  'internet.password': {
    category: 'internet', label: '密码', outputType: 'string',
    args: [
      { name: 'length', type: 'int', default: 12, min: 4, max: 64 },
      { name: 'memorable', type: 'string', default: 'false' },
    ],
    run: ({ length }) => faker.internet.password({ length }),
  },

  // ─── image ─────────────────────────────────────────────
  'image.url': {
    category: 'image', label: '图像 URL', outputType: 'string',
    args: [{ name: 'width', type: 'int', default: 640, min: 1, max: 4096 },
           { name: 'height', type: 'int', default: 480, min: 1, max: 4096 }],
    run: ({ width, height }) => faker.image.url({ width, height }),
  },
  'image.avatar': {
    category: 'image', label: '头像 URL', outputType: 'string', args: [],
    run: () => faker.image.avatar(),
  },
  'image.dataUri': {
    category: 'image', label: '图像 Data URI', outputType: 'string',
    args: [{ name: 'width', type: 'int', default: 100, min: 1, max: 1024 },
           { name: 'height', type: 'int', default: 100, min: 1, max: 1024 }],
    run: ({ width, height }) => faker.image.dataUri({ width, height }),
  },

  // ─── location ──────────────────────────────────────────
  'location.street': {
    category: 'location', label: '街道', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).location.street(),
  },
  'location.city': {
    category: 'location', label: '城市', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).location.city(),
  },
  'location.country': {
    category: 'location', label: '国家', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).location.country(),
  },
  'location.zipCode': {
    category: 'location', label: '邮编', outputType: 'string',
    args: [{ name: 'locale', type: 'locale', default: 'zh_CN' }],
    run: ({ locale }) => pickFaker(locale).location.zipCode(),
  },
};

/** @type {{ id: string, label: string, generatorIds: string[] }[]} */
export const CATEGORIES = [
  { id: 'string',   label: '字符串/UUID等',         generatorIds: ['uuid', 'string.alphanumeric', 'string.nanoid', 'string.symbol'] },
  { id: 'lorem',    label: '单词/句子/段落等',       generatorIds: ['lorem.word', 'lorem.sentence', 'lorem.paragraph'] },
  { id: 'number',   label: '数值',                  generatorIds: ['int', 'float'] },
  { id: 'date',     label: '日期/时间相关',           generatorIds: ['date', 'date.recent', 'date.past', 'date.future'] },
  { id: 'person',   label: '姓名/性别/职业等个人资料', generatorIds: ['person.fullName', 'person.firstName', 'person.lastName', 'person.gender', 'person.jobTitle'] },
  { id: 'phone',    label: '电话/手机',              generatorIds: ['phone.number'] },
  { id: 'internet', label: '邮箱/网址/域名/IP/...',   generatorIds: ['internet.email', 'internet.url', 'internet.domainName', 'internet.ip', 'internet.userName', 'internet.password'] },
  { id: 'image',    label: '图像相关',               generatorIds: ['image.url', 'image.avatar', 'image.dataUri'] },
  { id: 'location', label: '地址/区域相关',           generatorIds: ['location.street', 'location.city', 'location.country', 'location.zipCode'] },
];

export const LOCALES = ['zh_CN', 'en'];

function pickFaker(locale) {
  if (locale === 'en') return fakerEN;
  return fakerZH_CN;
}

/** @param {string} id @param {Record<string, any>} args */
export function runGenerator(id, args = {}) {
  const def = GENERATORS[id];
  if (!def) throw new Error(`未知生成器：${id}`);
  // 类型校验 + 默认值
  const merged = {};
  for (const spec of def.args) {
    const raw = args[spec.name] !== undefined ? args[spec.name] : spec.default;
    if (raw === undefined || raw === null) {
      if (spec.type === 'int') merged[spec.name] = 0;
      else if (spec.type === 'float') merged[spec.name] = 0;
      else merged[spec.name] = '';
      continue;
    }
    if (spec.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`参数 ${spec.name} 必须是整数，得到 ${raw}`);
      if (spec.min !== undefined && n < spec.min) throw new Error(`参数 ${spec.name} 必须 ≥ ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) throw new Error(`参数 ${spec.name} 必须 ≤ ${spec.max}`);
      merged[spec.name] = n;
    } else if (spec.type === 'float') {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`参数 ${spec.name} 必须是数字，得到 ${raw}`);
      merged[spec.name] = n;
    } else {
      merged[spec.name] = String(raw);
    }
  }
  try {
    return def.run(merged);
  } catch (err) {
    throw new Error(`生成器 ${id} 执行失败：${err.message}`);
  }
}

export function listGenerators() {
  const out = [];
  for (const cat of CATEGORIES) {
    for (const gid of cat.generatorIds) {
      const g = GENERATORS[gid];
      let sample = null;
      try { sample = runGenerator(gid, {}); } catch { sample = null; }
      out.push({ category: cat.id, generator: g, sample });
    }
  }
  return out;
}

export function getSample(id, partialArgs = {}) {
  try {
    return runGenerator(id, partialArgs);
  } catch {
    return null;
  }
}
```

**Step 4: 运行测试，验证通过**

Run:
```bash
pnpm vitest run test/unit/generators.test.js
```

Expected: 全过（约 22 个用例）。

**Step 5: 提交**

```bash
git add src/generators/index.js test/unit/generators.test.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(generators): white-list registry covering 9 categories

30+ generators from @faker-js/faker wrapped with explicit outputType.
Single source of truth for resolver, /api/generators, and modal UI.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 表达式解析器 + 测试

**Files:**
- Create: `src/expression-resolver.js`
- Create: `test/unit/expression-resolver.test.js`

**Interfaces（被本任务定义，下游消费方）：**
```js
// src/expression-resolver.js exports:
export class ResolverError extends Error
// 错误字段：{ message, code: 'UNKNOWN_GENERATOR'|'BAD_ARGS'|'BAD_EXPRESSION', generatorId?: string, from?: number, to?: number }

export function parseExpression(text: string): { id: string, args: Record<string, string>, start: number, end: number } | null
// text 内首个 {{...}} 表达式；未匹配返 null

export function resolve(value: unknown): { value: unknown, errors: ResolverError[] }
// 递归遍历 value，对 string 内 {{...}} 替换；返回处理后值 + 累积错误
```

**Step 1: 写失败测试**

`test/unit/expression-resolver.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { resolve, parseExpression, ResolverError } from '../../src/expression-resolver.js';

describe('parseExpression', () => {
  it('parses plain id', () => {
    const p = parseExpression('{{$uuid}}');
    expect(p).toEqual({ id: 'uuid', args: {}, start: 0, end: 9 });
  });

  it('parses id with single arg', () => {
    const p = parseExpression('{{$int:1}}');
    expect(p.id).toBe('int');
    expect(p.args).toEqual({ 0: '1' });
  });

  it('parses id with multiple args', () => {
    const p = parseExpression('{{$int:1:100}}');
    expect(p.args).toEqual({ 0: '1', 1: '100' });
  });

  it('parses id with dots', () => {
    const p = parseExpression('{{$person.fullName:zh_CN}}');
    expect(p.id).toBe('person.fullName');
    expect(p.args).toEqual({ 0: 'zh_CN' });
  });

  it('returns null when no expression', () => {
    expect(parseExpression('hello world')).toBeNull();
  });

  it('returns null on unclosed expression', () => {
    expect(parseExpression('{{$uuid')).toBeNull();
  });
});

describe('resolve — scalar no expression', () => {
  it('returns string as-is', () => {
    const r = resolve('hello');
    expect(r.value).toBe('hello');
    expect(r.errors).toEqual([]);
  });

  it('returns number as-is', () => {
    expect(resolve(42).value).toBe(42);
  });

  it('returns null as-is', () => {
    expect(resolve(null).value).toBeNull();
  });

  it('returns boolean as-is', () => {
    expect(resolve(true).value).toBe(true);
  });
});

describe('resolve — pure expression type preservation', () => {
  it('int pure expression returns number (not string)', () => {
    const r = resolve('{{$int:42:42}}');
    expect(r.value).toBe(42);
    expect(typeof r.value).toBe('number');
  });

  it('uuid pure expression returns string', () => {
    const r = resolve('{{$uuid}}');
    expect(typeof r.value).toBe('string');
    expect(r.value).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('email pure expression returns string', () => {
    const r = resolve('{{$internet.email}}');
    expect(typeof r.value).toBe('string');
    expect(r.value).toContain('@');
  });
});

describe('resolve — mixed expression stringification', () => {
  it('text + expression → string concat', () => {
    const r = resolve('id-{{$int:5:5}}');
    expect(r.value).toBe('id-5');
    expect(typeof r.value).toBe('string');
  });

  it('multiple expressions → string concat', () => {
    const r = resolve('{{$uuid}}-{{$uuid}}');
    expect(typeof r.value).toBe('string');
    expect(r.value).toMatch(/^[0-9a-f-]{36}-[0-9a-f-]{36}$/);
  });

  it('multiple expressions same int → string concat', () => {
    const r = resolve('{{$int:7:7}}-{{$int:8:8}}');
    expect(r.value).toBe('7-8');
  });
});

describe('resolve — nested structures', () => {
  it('walks nested objects', () => {
    const r = resolve({ a: { b: '{{$int:3:3}}' } });
    expect(r.value).toEqual({ a: { b: 3 } });
  });

  it('walks arrays', () => {
    const r = resolve(['{{$int:1:1}}', '{{$int:2:2}}']);
    expect(r.value).toEqual([1, 2]);
  });

  it('does not resolve object keys', () => {
    const r = resolve({ '{{$int:1:1}}': 'value' });
    expect(r.value).toEqual({ '{{$int:1:1}}': 'value' });
  });

  it('handles deeply mixed', () => {
    const r = resolve({
      id: '{{$uuid}}',
      meta: { count: '{{$int:5:5}}', label: 'item-{{$uuid}}' },
      tags: ['{{$lorem.word}}', 'static'],
    });
    expect(typeof r.value.id).toBe('string');
    expect(r.value.meta.count).toBe(5);
    expect(typeof r.value.meta.label).toBe('string');
    expect(r.value.meta.label.startsWith('item-')).toBe(true);
    expect(typeof r.value.tags[0]).toBe('string');
    expect(r.value.tags[1]).toBe('static');
  });
});

describe('resolve — error handling (soft failure)', () => {
  it('unknown generator in pure expression → null + error', () => {
    const r = resolve('{{$nonexistent}}');
    expect(r.value).toBeNull();
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toBeInstanceOf(ResolverError);
    expect(r.errors[0].code).toBe('UNKNOWN_GENERATOR');
  });

  it('unknown generator in mixed expression → keeps original string + error', () => {
    const r = resolve('pre-{{$nonexistent}}');
    expect(r.value).toBe('pre-{{$nonexistent}}');
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].code).toBe('UNKNOWN_GENERATOR');
  });

  it('bad arg type in pure expression → null + error', () => {
    const r = resolve('{{$int:notanumber:10}}');
    expect(r.value).toBeNull();
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].code).toBe('BAD_ARGS');
  });

  it('bad arg type in mixed expression → keeps original string + error', () => {
    const r = resolve('pre-{{$int:notanumber:10}}');
    expect(r.value).toBe('pre-{{$int:notanumber:10}}');
    expect(r.errors.length).toBe(1);
  });

  it('accumulate multiple errors', () => {
    const r = resolve({
      a: '{{$nope1}}',
      b: '{{$nope2}}',
      c: 'static',
    });
    expect(r.errors.length).toBe(2);
    expect(r.value.a).toBeNull();
    expect(r.value.b).toBeNull();
    expect(r.value.c).toBe('static');
  });
});

describe('resolve — whitespace tolerance', () => {
  it('pure expression with surrounding whitespace is mixed', () => {
    const r = resolve(' {{$int:3:3}}');
    expect(r.value).toBe(' 3');
  });

  it('pure expression exact match preserved as type', () => {
    const r = resolve('{{$int:3:3}}');
    expect(r.value).toBe(3);
  });
});
```

**Step 2: 运行测试，验证失败**

Run:
```bash
pnpm vitest run test/unit/expression-resolver.test.js
```

Expected: FAIL — `Cannot find module`

**Step 3: 实现 `src/expression-resolver.js`**

```js
// 表达式解析器 —— 单一来源，被 mock-engine 和 /api/preview 共用
// 类型规则见 specs/2026-06-23-dynamic-response-generator-design.md §3
import { runGenerator } from './generators/index.js';

export class ResolverError extends Error {
  /**
   * @param {string} message
   * @param {'UNKNOWN_GENERATOR'|'BAD_ARGS'|'BAD_EXPRESSION'} code
   * @param {{ generatorId?: string, from?: number, to?: number }} meta
   */
  constructor(message, code, meta = {}) {
    super(message);
    this.code = code;
    if (meta.generatorId !== undefined) this.generatorId = meta.generatorId;
    if (meta.from !== undefined) this.from = meta.from;
    if (meta.to !== undefined) this.to = meta.to;
  }
}

const EXPRESSION_RE = /\{\{\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)(?::([^}]*))?\}\}/g;

/**
 * 解析首个 {{...}} 表达式。
 * @param {string} text
 * @returns {{ id: string, args: Record<string, string>, start: number, end: number } | null}
 */
export function parseExpression(text) {
  const re = /\{\{\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)(?::([^}]*))?\}\}/;
  const m = re.exec(text);
  if (!m) return null;
  const id = m[1];
  const argStr = m[2] || '';
  const args = {};
  if (argStr) {
    const parts = argStr.split(':');
    parts.forEach((p, i) => { args[i] = p; });
  }
  return { id, args, start: m.index, end: m.index + m[0].length };
}

/**
 * 判断字符串是否为「纯表达式」（trim 后整个就是一个 {{...}}）。
 * @param {string} text
 */
function isPureExpression(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const m = /^\{\{\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)(?::([^}]*))?\}\}$/.exec(trimmed);
  return m !== null;
}

/**
 * 把 args 数组转成 named object（按顺序对齐 GENERATORS[id].args）。
 * @param {Record<string, string>} positional
 * @param {Array<{ name: string }>} argSpecs
 */
function bindArgs(positional, argSpecs) {
  const out = {};
  for (let i = 0; i < argSpecs.length; i++) {
    out[argSpecs[i].name] = positional[i] !== undefined ? positional[i] : undefined;
  }
  return out;
}

/**
 * 递归解析 value 中的 {{...}} 表达式。
 * 纯表达式按 outputType 原类型注入；混合 → String() 拼接；失败时纯 → null / 混合 → 原字符串。
 * @param {unknown} value
 * @returns {{ value: unknown, errors: ResolverError[] }}
 */
export function resolve(value) {
  const errors = [];
  const out = walk(value, errors);
  return { value: out, errors };
}

function walk(value, errors) {
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, errors));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // key 不解析
      out[k] = walk(v, errors);
    }
    return out;
  }
  if (typeof value !== 'string') {
    return value;
  }
  // string —— 检测表达式
  if (!value.includes('{{')) {
    return value;
  }

  const pure = isPureExpression(value);
  const re = /\{\{\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)(?::([^}]*))?\}\}/g;
  let m;
  const replacements = [];
  while ((m = re.exec(value)) !== null) {
    replacements.push({ match: m[0], id: m[1], argsStr: m[2] || '', from: m.index, to: m.index + m[0].length });
  }

  if (pure && replacements.length === 1) {
    // 纯表达式：尝试按 outputType 注入
    const r = replacements[0];
    try {
      const { GENERATORS } = require_generators();
      const def = GENERATORS[r.id];
      if (!def) {
        errors.push(new ResolverError(`未知生成器：${r.id}`, 'UNKNOWN_GENERATOR', { generatorId: r.id, from: r.from, to: r.to }));
        return null;
      }
      const positional = {};
      if (r.argsStr) {
        r.argsStr.split(':').forEach((p, i) => { positional[i] = p; });
      }
      const named = bindArgs(positional, def.args);
      const result = runGenerator(r.id, named);
      return result;
    } catch (err) {
      errors.push(new ResolverError(err.message, err.message.startsWith('未知生成器') ? 'UNKNOWN_GENERATOR' : 'BAD_ARGS', { generatorId: r.id, from: r.from, to: r.to }));
      return null;
    }
  }

  // 混合表达式：替换所有 {{...}}，失败保留原 match 字符串
  let result = '';
  let cursor = 0;
  for (const r of replacements) {
    result += value.slice(cursor, r.from);
    try {
      const { GENERATORS } = require_generators();
      const def = GENERATORS[r.id];
      if (!def) {
        errors.push(new ResolverError(`未知生成器：${r.id}`, 'UNKNOWN_GENERATOR', { generatorId: r.id, from: r.from, to: r.to }));
        result += r.match; // 保留原表达式字符串
      } else {
        const positional = {};
        if (r.argsStr) r.argsStr.split(':').forEach((p, i) => { positional[i] = p; });
        const named = bindArgs(positional, def.args);
        const out = runGenerator(r.id, named);
        result += String(out);
      }
    } catch (err) {
      errors.push(new ResolverError(err.message, 'BAD_ARGS', { generatorId: r.id, from: r.from, to: r.to }));
      result += r.match;
    }
    cursor = r.to;
  }
  result += value.slice(cursor);
  return result;
}

// 延迟 import 避免循环依赖（虽然现在没有，但留口子）
function require_generators() {
  // eslint-disable-next-line global-require
  return import('./generators/index.js');
}
```

**Step 4: 运行测试，验证通过**

Run:
```bash
pnpm vitest run test/unit/expression-resolver.test.js
```

Expected: 全过（约 25 个用例）。如有失败，多半是 `import` 异步问题，把 `require_generators()` 改成同步 import：

```js
import { GENERATORS } from './generators/index.js';
// ... 然后在 walk 中直接用 GENERATORS
```

（实现中已用 sync import 形式最简。如果 async 出问题就这样改。）

**Step 5: 提交**

```bash
git add src/expression-resolver.js test/unit/expression-resolver.test.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(resolver): recursive expression resolver with type-preserving injection

Pure expression preserves outputType (int → number);
mixed expression stringifies with String().
Soft failure: pure → null, mixed → keeps original expression.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 三个新 API 路由 + 集成测试

**Files:**
- Create: `src/api-preview.js`
- Modify: `src/api.js:34`（在 createApi 末尾挂路由）
- Create: `test/integration/api-generators.test.js`
- Create: `test/integration/api-preview.test.js`

**Interfaces（被本任务定义，下游消费方）：**
```js
// src/api-preview.js exports:
export function registerPreviewRoutes(app: Express): void
// 挂三个路由：GET /api/generators、POST /api/preview、POST /api/generators/sample
```

**Step 1: 写失败测试**

`test/integration/api-generators.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tempDir } from '../helpers/temp-dir.js';
import { ConfigStore } from '../../src/config-store.js';
import { LogBuffer } from '../../src/log-buffer.js';
import { MockEngine } from '../../src/mock-engine.js';
import { buildApp } from '../helpers/test-server.js';

let td, store, logs, engine, ctx;

beforeEach(async () => {
  td = tempDir();
  store = new ConfigStore(td.path);
  await store.load();
  logs = new LogBuffer(10);
  engine = new MockEngine({ logBuffer: logs, bindHost: '127.0.0.1' });
  ctx = buildApp({ storagePath: td.path, configStore: store, logBuffer: logs, mockEngine: engine });
});

afterEach(async () => {
  await engine.stop();
  td.cleanup();
});

describe('GET /api/generators', () => {
  it('returns categories with generators and samples', async () => {
    const res = await ctx.request.get('/api/generators');
    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('zh_CN');
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories.length).toBe(9);
    const stringCat = res.body.categories.find((c) => c.id === 'string');
    expect(stringCat).toBeTruthy();
    const uuidGen = stringCat.generators.find((g) => g.id === 'uuid');
    expect(uuidGen).toBeTruthy();
    expect(uuidGen.args).toEqual([]);
    expect(typeof uuidGen.sample).toBe('string');
  });

  it('int generator sample is a number', async () => {
    const res = await ctx.request.get('/api/generators');
    const numberCat = res.body.categories.find((c) => c.id === 'number');
    const intGen = numberCat.generators.find((g) => g.id === 'int');
    expect(typeof intGen.sample).toBe('number');
  });
});

describe('POST /api/generators/sample', () => {
  it('returns sample for known id', async () => {
    const res = await ctx.request
      .post('/api/generators/sample')
      .send({ id: 'int', args: { min: 10, max: 10 } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sample).toBe(10);
  });

  it('returns 400 for unknown id', async () => {
    const res = await ctx.request
      .post('/api/generators/sample')
      .send({ id: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 for bad args', async () => {
    const res = await ctx.request
      .post('/api/generators/sample')
      .send({ id: 'int', args: { min: 'bad' } });
    expect(res.status).toBe(400);
  });
});
```

`test/integration/api-preview.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tempDir } from '../helpers/temp-dir.js';
import { ConfigStore } from '../../src/config-store.js';
import { LogBuffer } from '../../src/log-buffer.js';
import { MockEngine } from '../../src/mock-engine.js';
import { buildApp } from '../helpers/test-server.js';

let td, store, logs, engine, ctx;

beforeEach(async () => {
  td = tempDir();
  store = new ConfigStore(td.path);
  await store.load();
  logs = new LogBuffer(10);
  engine = new MockEngine({ logBuffer: logs, bindHost: '127.0.0.1' });
  ctx = buildApp({ storagePath: td.path, configStore: store, logBuffer: logs, mockEngine: engine });
});

afterEach(async () => {
  await engine.stop();
  td.cleanup();
});

describe('POST /api/preview', () => {
  it('returns resolved JSON with ok=true', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: '{ "id": "{{$uuid}}", "n": "{{$int:42:42}}" }' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.resolved.id).toBe('string');
    expect(res.body.resolved.n).toBe(42);
    expect(res.body.exprCount).toBe(2);
    expect(res.body.errors).toEqual([]);
  });

  it('returns ok=true with errors on unknown generator (soft fail)', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: '{ "x": "{{$nonexistent}}" }' });
    expect(res.body.ok).toBe(true);
    expect(res.body.resolved.x).toBeNull();
    expect(res.body.errors.length).toBe(1);
    expect(res.body.errors[0].code).toBe('UNKNOWN_GENERATOR');
  });

  it('returns ok=false on JSON syntax error', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: '{ broken' });
    expect(res.body.ok).toBe(false);
    expect(res.body.stage).toBe('json-parse');
    expect(res.body.error).toBeTruthy();
  });

  it('passes through plain JSON unchanged', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: '{ "a": 1, "b": [1,2,3] }' });
    expect(res.body.ok).toBe(true);
    expect(res.body.resolved).toEqual({ a: 1, b: [1, 2, 3] });
    expect(res.body.exprCount).toBe(0);
  });

  it('rejects non-JSON text body', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: 12345 });
    expect(res.status).toBe(400);
  });
});
```

**Step 2: 运行测试，验证失败**

Run:
```bash
pnpm vitest run test/integration/api-generators.test.js test/integration/api-preview.test.js
```

Expected: 404（路由未挂）

**Step 3: 实现 `src/api-preview.js`**

```js
// 三个预览 / 生成器 API 路由
import { AppError, toErrorResponse, statusFor } from './errors.js';
import { GENERATORS, runGenerator, CATEGORIES, LOCALES } from './generators/index.js';
import { resolve } from './expression-resolver.js';

/**
 * @param {import('express').Express} app
 */
export function registerPreviewRoutes(app) {
  app.get('/api/generators', (_req, res) => {
    const categories = CATEGORIES.map((cat) => ({
      id: cat.id,
      label: cat.label,
      generators: cat.generatorIds.map((gid) => {
        const def = GENERATORS[gid];
        let sample = null;
        try { sample = runGenerator(gid, {}); } catch { /* keep null */ }
        return {
          id: gid,
          label: def.label,
          outputType: def.outputType,
          args: def.args,
          sample,
        };
      }),
    }));
    res.json({ locale: 'zh_CN', locales: LOCALES, categories });
  });

  app.post('/api/generators/sample', (req, res, next) => {
    try {
      const { id, args = {} } = req.body || {};
      if (typeof id !== 'string' || !GENERATORS[id]) {
        throw new AppError(400, 'UNKNOWN_GENERATOR', `未知生成器：${id}`);
      }
      const sample = runGenerator(id, args);
      res.json({ ok: true, sample });
    } catch (e) { next(e); }
  });

  app.post('/api/preview', (req, res, next) => {
    try {
      const { text } = req.body || {};
      if (typeof text !== 'string') {
        throw new AppError(400, 'INVALID_TEXT', 'text must be a string');
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        return res.json({
          ok: false,
          stage: 'json-parse',
          error: parseErr.message,
          lastResolved: null,
        });
      }
      const exprCount = countExpressions(text);
      const { value, errors } = resolve(parsed);
      res.json({ ok: true, resolved: value, exprCount, errors });
    } catch (e) { next(e); }
  });

  // 错误处理（仅本组路由）
  app.use((err, _req, res, _next) => {
    res.status(statusFor(err)).json(toErrorResponse(err));
  });
}

function countExpressions(text) {
  const re = /\{\{\$[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*(?::[^}]*)?\}\}/g;
  return (text.match(re) || []).length;
}
```

**Step 4: 在 `src/api.js` 末尾挂上路由**

修改 `src/api.js`：
- 顶部加 import：`import { registerPreviewRoutes } from './api-preview.js';`
- 在 `createApi` 函数体末尾、`return app;` 之前加：`registerPreviewRoutes(app);`

具体位置：找到 `export function createApi(...)` 末尾的 `return app;`（约 160+ 行附近），在那行之前插入。

**Step 5: 运行测试，验证通过**

Run:
```bash
pnpm vitest run test/integration/api-generators.test.js test/integration/api-preview.test.js
```

Expected: 全过（约 8 个用例）。

**Step 6: 运行全量集成测试，确保没破坏现有路由**

Run:
```bash
pnpm vitest run test/integration/
```

Expected: 全过。

**Step 7: 提交**

```bash
git add src/api-preview.js src/api.js test/integration/api-generators.test.js test/integration/api-preview.test.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(api): preview + generators routes

GET  /api/generators          catalog
POST /api/generators/sample   single-arg sample
POST /api/preview             resolve editor text against resolver

Wired at end of createApi() in src/api.js.
Error envelopes use src/errors.js.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Mock 引擎接入 resolver

**Files:**
- Modify: `src/mock-engine.js:64`（服务时调用 resolver）
- Modify: `test/integration/mock-engine.test.js`（已有，加动态值用例）

**Interfaces（被本任务消费）：** `resolve(value)` from `src/expression-resolver.js`（Task 3 定义）

**Step 1: 写失败测试**

打开 `test/integration/mock-engine.test.js`（已存在），在文件末尾追加：

```js
import { resolve } from '../../src/expression-resolver.js';

describe('mock-engine with dynamic response', () => {
  it('resolves {{$uuid}} at serve time', async () => {
    // 假设已有类似 fixture（参考文件原结构）
    // 这一段示意：起 mock 引擎，发请求，验证 body
    const port = 19001;
    await engine.start([{
      id: 'dyn-uuid', method: 'GET', port, path: '/uuid',
      statusCode: 200,
      response: { id: '{{$uuid}}' },
      enabled: true,
    }]);
    const r1 = await fetch(`http://127.0.0.1:${port}/uuid`).then((r) => r.json());
    const r2 = await fetch(`http://127.0.0.1:${port}/uuid`).then((r) => r.json());
    expect(r1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r2.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r1.id).not.toBe(r2.id);
  });

  it('preserves type for pure number expression', async () => {
    const port = 19002;
    await engine.start([{
      id: 'dyn-int', method: 'GET', port, path: '/n',
      statusCode: 200,
      response: { age: '{{$int:42:42}}' },
      enabled: true,
    }]);
    const r = await fetch(`http://127.0.0.1:${port}/n`).then((res) => res.json());
    expect(r.age).toBe(42);
    expect(typeof r.age).toBe('number');
  });

  it('falls back to original response when resolver throws', async () => {
    const port = 19003;
    // 注入一个会让 resolver 抛错的 response —— 但 resolver 自身不抛，
    // 它返回 errors[]。验证 fallback 路径需要 mock。
    // 简单方案：直接构造会让 runGenerator 失败的表达式
    await engine.start([{
      id: 'dyn-bad', method: 'GET', port, path: '/bad',
      statusCode: 200,
      response: { x: '{{$int:notanumber:10}}' },
      enabled: true,
    }]);
    const r = await fetch(`http://127.0.0.1:${port}/bad`).then((res) => res.json());
    // 软失败：纯表达式失败 → null
    expect(r.x).toBeNull();
  });
});
```

（根据 `test/integration/mock-engine.test.js` 现有 fixture 结构适当调整导入和 setup；保留原有所有测试。）

**Step 2: 运行测试，验证失败**

Run:
```bash
pnpm vitest run test/integration/mock-engine.test.js
```

Expected: 新增用例里，`dyn-uuid` 测试得到 `"{{$uuid}}"`（字面字符串） — 因为 mock-engine 还不会调 resolver。

**Step 3: 修改 `src/mock-engine.js`**

第 1 行附近加 import：

```js
import { resolve } from './expression-resolver.js';
```

第 64 行附近（`res.end(JSON.stringify(matched.response ?? null));`）替换为：

```js
        if (matched) {
          res.statusCode = matched.statusCode || 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          let body;
          try {
            const { value } = resolve(matched.response);
            body = JSON.stringify(value);
          } catch (err) {
            // resolver 永不抛（软失败），但兜底
            this.logBuffer?.push({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              level: 'warn',
              source: 'resolver',
              message: `resolver failed: ${err.message}`,
              endpointId: matched.id,
            });
            body = JSON.stringify(matched.response ?? null);
          }
          res.end(body);
        } else {
```

**Step 4: 运行测试，验证通过**

Run:
```bash
pnpm vitest run test/integration/mock-engine.test.js
```

Expected: 原有测试 + 新增 3 个动态值用例全过。

**Step 5: 运行全量测试确保没破坏其他模块**

Run:
```bash
pnpm test
```

Expected: 全过。

**Step 6: 提交**

```bash
git add src/mock-engine.js test/integration/mock-engine.test.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(mock-engine): resolve dynamic expressions at serve time

Single-line change in src/mock-engine.js: call resolve() before
JSON.stringify. Resolver is soft-fail (returns errors[]), engine never 500s.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 响应体两栏布局（HTML + CSS 结构骨架）

**Files:**
- Modify: `public/index.html:148-173`（响应体 section 改为双栏）
- Modify: `public/styles.css`（新增双栏 CSS）

**Step 1: 修改 `public/index.html`**

把第 148-173 行整段（`.editor-body`）替换为：

```html
        <div class="editor-body">
          <div class="editor-split">
            <div class="editor-pane editor-pane-edit">
              <div class="editor-toolbar">
                <div class="toolbar-left">
                  <span class="section-label">响应体</span>
                  <span class="format-hint mono">JSON</span>
                </div>
                <div class="toolbar-right">
                  <span class="validation-status" id="validationStatus">
                    <span class="val-mark">·</span>
                    <span class="val-text">空</span>
                  </span>
                  <button class="btn btn-ghost btn-sm" id="formatBtn">格式化</button>
                  <button class="btn btn-ghost btn-sm" id="validateBtn">校验</button>
                </div>
              </div>
              <div class="code-editor-wrap" id="editorWrap">
                <div id="responseEditorHost" class="code-editor"></div>
                <button class="floating-btn" id="dynamicValueBtn" hidden type="button">动态值</button>
              </div>
              <div class="editor-meta">
                <span class="mono" id="lineCount">0 行</span>
                <span class="meta-sep">·</span>
                <span class="mono" id="charCount">0 字符</span>
                <span class="meta-sep">·</span>
                <span class="mono">Tab 插入 2 空格</span>
              </div>
            </div>

            <div class="editor-pane editor-pane-preview">
              <div class="editor-toolbar">
                <div class="toolbar-left">
                  <span class="section-label">预览</span>
                  <span class="format-hint mono">已解析</span>
                </div>
                <div class="toolbar-right">
                  <span class="mono" id="previewStats">表达式: 0 · 错误: 0</span>
                  <button class="btn btn-ghost btn-sm" id="previewRefreshBtn" aria-label="刷新预览">↻</button>
                </div>
              </div>
              <div class="preview-banner" id="previewBanner" hidden></div>
              <pre class="preview-pane mono" id="previewPane">// 在左侧编辑响应体，此处显示解析结果</pre>
            </div>
          </div>
        </div>
```

在文件末尾（`</body>` 之前），加模态框 markup 占位（Task 9 才完整实现）：

```html
  <!-- Generator modal placeholder (Task 9 fills in the markup; current commit ships empty div so Task 8's openGeneratorModal stub can be tested) -->
  <div class="modal" id="generatorModal" hidden></div>
```

**Step 2: 修改 `public/styles.css`**

在文件末尾追加：

```css
/* ============================================================
   Response body: two-pane split (editor | preview)
   ============================================================ */
.editor-split {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 1px;
  background: var(--border, #d8d8d2);
  border: 1px solid var(--border, #d8d8d2);
  border-radius: 6px;
  overflow: hidden;
  min-height: 360px;
  height: 100%;
}

.editor-pane {
  display: flex;
  flex-direction: column;
  background: var(--surface, #fafaf7);
  min-height: 0;
}

.editor-pane-edit .code-editor-wrap { flex: 1; min-height: 0; position: relative; }
.editor-pane-edit .code-editor { height: 100%; min-height: 280px; }

.editor-pane-preview { background: var(--surface-2, #f4f4ef); }

.preview-banner {
  padding: 8px 12px;
  font-family: var(--font-sans);
  font-size: 12px;
  background: rgba(255, 92, 92, 0.12);
  color: #b22a2a;
  border-bottom: 1px solid rgba(255, 92, 92, 0.3);
}
.preview-banner.is-neutral {
  background: rgba(120, 120, 120, 0.1);
  color: var(--text-secondary, #555);
}

.preview-pane {
  flex: 1;
  margin: 0;
  padding: 12px 16px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-primary, #1a1a1a);
}
.preview-pane .expr-error {
  background: rgba(255, 92, 92, 0.18);
  border-radius: 2px;
  padding: 0 2px;
}

/* Floating action button inside the editor */
.floating-btn {
  position: absolute;
  z-index: 10;
  padding: 3px 9px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: #fff;
  background: var(--accent, #1a6fa8);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  transition: transform 120ms ease, background 120ms ease;
}
.floating-btn:hover { background: var(--accent-hover, #155a8a); transform: translateY(-1px); }
.floating-btn[hidden] { display: none; }
```

**Step 3: 视觉验证**

Run:
```bash
pnpm start
```

打开浏览器访问 `http://127.0.0.1:5050`，新建一个 endpoint：
- 响应体输入 `{ "hello": "world" }`
- 验证右栏显示 `// 在左侧编辑响应体，此处显示解析结果`（这是 Task 7 之前的占位文案）
- 验证左栏 CodeMirror 仍正常工作

Expected: 两栏布局正确，浮按钮隐藏（未在 string value 上时），预览栏显示占位文字。

**Step 4: 关闭服务，提交**

```bash
git add public/index.html public/styles.css
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(ui): split response body into edit + preview panes

CSS grid 3fr/2fr. Preview pane shows placeholder until Task 7.
Floating button DOM is present but hidden.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 编辑器 selection 回调（公开光标位置）

**Files:**
- Modify: `public/editor.js:12`（`mountEditor` 加 `onSelectionChange` 回调）

**Interfaces（被本任务定义，下游消费方）：**
```js
// mountEditor 现在的签名：
mountEditor({ initialValue, onChange, onSelectionChange })
//   onChange: (text: string) => void     // 文档变化时
//   onSelectionChange: (view: EditorView) => void  // 光标 / 选区变化时
```

**Step 1: 修改 `public/editor.js`**

替换整个文件内容：

```js
// CodeMirror 6 bootstrap
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';

const host = document.getElementById('responseEditorHost');
let view = null;

/**
 * @param {{ initialValue?: string, onChange?: (text: string) => void, onSelectionChange?: (view: any) => void }} opts
 */
export function mountEditor({ initialValue = '', onChange, onSelectionChange } = {}) {
  if (view) return view;
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && !window.__editorProgrammatic) onChange?.(u.state.doc.toString());
    if (u.selectionSet || u.docChanged) onSelectionChange?.(u.state);
  });

  const state = EditorState.create({
    doc: initialValue,
    extensions: [
      lineNumbers(),
      history(),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle),
      json(),
      linter(jsonParseLinter(), { delay: 200 }),
      lintGutter(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: 'transparent' },
        '.cm-scroller': { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '13px', lineHeight: '1.65' },
        '.cm-content': { padding: '12px 16px' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid #d8d8d2', color: '#8a8a82' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#1a1a1a' },
        '.cm-activeLine': { backgroundColor: 'rgba(26,111,168,0.06)' },
        '.cm-diagnostic-error': { borderLeft: '3px solid #ff5c5c' },
        '.cm-diagnostic-warning': { borderLeft: '3px solid #ffc857' },
      }, { dark: true }),
      updateListener,
    ],
  });

  view = new EditorView({ state, parent: host });
  return view;
}

export function getValue() {
  return view ? view.state.doc.toString() : '';
}

export function setValue(text) {
  if (!view) return;
  window.__editorProgrammatic = true;
  try {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  } finally {
    queueMicrotask(() => { window.__editorProgrammatic = false; });
  }
}

export function getEditorView() {
  return view;
}
```

**Step 2: 验证现有 onChange 仍工作**

Run:
```bash
pnpm vitest run test/e2e/json-editor.spec.js test/e2e/happy-path.spec.js
```

Expected: 全过（如果之前 E2E 通过的话）。这里确认 mountEditor 签名改动向后兼容（onSelectionChange 可选）。

**Step 3: 提交**

```bash
git add public/editor.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(editor): expose selection changes via onSelectionChange callback

mountEditor now optionally accepts onSelectionChange(state).
Existing onChange behavior preserved.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 预览面板行为（app.js 内逻辑）

**Files:**
- Modify: `public/app.js`（加 api.preview 方法 + 预览渲染逻辑 + 浮按钮定位逻辑）

**Step 1: 修改 `public/app.js`**

在 `api` 对象内（约第 32 行末尾）追加：

```js
  async getGenerators() { return (await fetch('/api/generators')).json(); },
  async getGeneratorSample(id, args) {
    return (await fetch('/api/generators/sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, args }),
    })).json();
  },
  async preview(text) {
    return (await fetch('/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })).json();
  },
```

在 `mountEditor` 调用处（约第 525 行）改成：

```js
const view = mountEditor({
  initialValue: '',
  onChange: (text) => {
    state.dirty = true;
    updateSaveButton();
    schedulePreviewRefresh();
  },
  onSelectionChange: (state) => updateFloatingButton(state),
});
```

在文件顶部（DOM refs 区域）新增引用：

```js
const previewPane = $('#previewPane');
const previewBanner = $('#previewBanner');
const previewStats = $('#previewStats');
const previewRefreshBtn = $('#previewRefreshBtn');
const dynamicValueBtn = $('#dynamicValueBtn');
const editorWrap = $('#editorWrap');
```

新增预览刷新逻辑（找一个合适位置插入，例如紧跟 mountEditor 之后）：

```js
// ============================================================
// Preview pane
// ============================================================
let previewDebounceTimer = null;
let lastGoodPreview = null;

function schedulePreviewRefresh() {
  if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(refreshPreview, 300);
}

async function refreshPreview() {
  const text = getValue();
  if (!text.trim()) {
    previewPane.textContent = '// 在左侧编辑响应体，此处显示解析结果';
    previewStats.textContent = '表达式: 0 · 错误: 0';
    previewBanner.hidden = true;
    return;
  }
  let res;
  try {
    res = await api.preview(text);
  } catch (e) {
    previewBanner.textContent = '预览暂不可用';
    previewBanner.className = 'preview-banner';
    previewBanner.hidden = false;
    return;
  }
  if (!res.ok) {
    previewBanner.textContent = res.error || 'JSON 解析失败';
    previewBanner.className = 'preview-banner';
    previewBanner.hidden = false;
    if (lastGoodPreview !== null) {
      renderPreview(lastGoodPreview, []);
    }
    return;
  }
  previewBanner.hidden = true;
  renderPreview(res.resolved, res.errors);
  lastGoodPreview = res.resolved;
  previewStats.textContent = `表达式: ${res.exprCount} · 错误: ${res.errors.length}`;
}

function renderPreview(value, errors) {
  const json = JSON.stringify(value, null, 2);
  // 表达式错（混合 → 原 {{...}} 保留；纯 → null）—— 对混合情况在输出中找到
  // 残留的 {{...}} 包红色 span，纯情况无文本可标，仅追加错误文字
  const hasError = errors.length > 0;
  previewPane.textContent = '';
  if (hasError && json.includes('{{')) {
    const re = /\{\{[^}]*\}\}/g;
    let last = 0;
    let m;
    while ((m = re.exec(json)) !== null) {
      if (m.index > last) previewPane.appendChild(document.createTextNode(json.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'expr-error';
      span.textContent = m[0];
      previewPane.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < json.length) previewPane.appendChild(document.createTextNode(json.slice(last)));
  } else {
    previewPane.textContent = json;
  }
  if (hasError) {
    let errText = '\n\n';
    for (const e of errors) errText += `⚠ ${e.message}\n`;
    previewPane.appendChild(document.createTextNode(errText));
  }
}

previewRefreshBtn.addEventListener('click', refreshPreview);

// ============================================================
// Floating dynamic-value button
// ============================================================
function updateFloatingButton(state) {
  const doc = state.doc;
  const head = state.selection.main.head;
  const text = doc.toString();
  let range = findStringRangeAt(text, head);
  if (!range) {
    dynamicValueBtn.hidden = true;
    return;
  }
  // 已有 {{...}}？按钮变成「编辑表达式」
  const inner = text.slice(range.from, range.to);
  const hasExpr = /\{\{\$[a-zA-Z_]/.test(inner);
  dynamicValueBtn.textContent = hasExpr ? '编辑表达式' : '动态值';
  // 定位
  const coords = coordsAtPosForRange(range);
  if (!coords) {
    dynamicValueBtn.hidden = true;
    return;
  }
  dynamicValueBtn.style.top = `${coords.top}px`;
  dynamicValueBtn.style.left = `${coords.right + 4}px`;
  dynamicValueBtn.hidden = false;
  dynamicValueBtn.onclick = () => openGeneratorModal({
    from: range.from,
    to: range.to,
    currentValue: inner,
    initialExpr: hasExpr ? extractFirstExpr(inner) : null,
  });
}

function findStringRangeAt(text, pos) {
  // 简单 JSON 字符串范围搜索：找 pos 最近的左引号和右引号（成对）
  // 严格 JSON 解析更稳；v1 用启发式即可
  let left = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] === '"') {
      // 检查是否在 string 内（无前导 \）
      let bs = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) bs++;
      if (bs % 2 === 0) { left = i; break; }
    }
  }
  if (left < 0) return null;
  let right = -1;
  for (let i = left + 1; i < text.length; i++) {
    if (text[i] === '"' && text[i - 1] !== '\\') { right = i; break; }
  }
  if (right < 0 || pos < left || pos > right) return null;
  return { from: left + 1, to: right }; // 不含引号本身
}

function extractFirstExpr(s) {
  const m = /\{\{\$[a-zA-Z_][a-zA-Z0-9_.]*(?::[^}]*)?\}\}/.exec(s);
  return m ? m[0] : null;
}

function coordsAtPosForRange(range) {
  const view = getEditorView();
  if (!view) return null;
  try {
    const startCoords = view.coordsAtPos(range.from);
    // 找该行末
    const line = view.state.doc.lineAt(range.from);
    const endCoords = view.coordsAtPos(line.to);
    if (!startCoords || !endCoords) return null;
    const wrapRect = editorWrap.getBoundingClientRect();
    return {
      top: startCoords.top - wrapRect.top,
      right: endCoords.left - wrapRect.left,
    };
  } catch {
    return null;
  }
}

// Task 10 实现 openGeneratorModal —— 此处为中间态占位符（Task 10 整段替换）
window.__openGeneratorModal = (opts) => {
  // 占位：Task 10 替换。允许 console.warn 因为这是 dev-only 临时态，
  // 最终代码（Task 10）不出现 console 输出。
  console.warn('openGeneratorModal not implemented yet', opts);
};
```

在文件顶部 import 追加：

```js
import { mountEditor, getValue, setValue, getEditorView } from './editor.js';
```

**Step 2: 验证预览刷新**

Run:
```bash
pnpm start
```

打开浏览器 → 新建 endpoint → 响应体输入 `{ "id": "{{$uuid}}" }` → 停顿 300ms → 验证右栏显示 `{"id": "a3f1-..."}`（真 UUID）。

继续：响应体改为 `{ "n": "{{$int:42:42}}" }` → 右栏显示 `{"n": 42}`（数字，无引号）。

继续：响应体改为 `{ "x": "{{$nonexistent}}" }` → 右栏 JSON `{"x": null}` + 下方显示错误。

**Step 3: 关闭服务，提交**

```bash
git add public/app.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(preview): debounced live preview with error fallback

Right pane refreshes 300ms after edit. Soft-fail errors render in-place.
Last good preview persists on JSON parse error.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: 数据生成器模态框 — HTML + CSS

**Files:**
- Modify: `public/index.html`（替换 Task 6 的占位为完整模态框 markup）
- Modify: `public/styles.css`（追加模态框样式）

**Step 1: 修改 `public/index.html`**

替换 Task 6 末尾的占位 `<div class="modal" id="generatorModal" hidden></div>` 为：

```html
  <!-- Generator modal -->
  <div class="modal" id="generatorModal" hidden>
    <div class="modal-backdrop" id="generatorBackdrop"></div>
    <div class="modal-panel generator-panel" role="dialog" aria-labelledby="generatorTitle" aria-modal="true">
      <div class="modal-header">
        <button class="btn btn-icon" id="generatorBack" aria-label="返回">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2 class="section-label" id="generatorTitle">数据生成器</h2>
        <button class="btn btn-icon" id="generatorClose" aria-label="关闭">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="generator-locale">
        <span class="meta-label">类型</span>
        <select class="select select-sm" id="generatorLocale">
          <option value="zh_CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </div>

      <div class="generator-search">
        <input type="text" class="input mono" id="generatorSearch" placeholder="选择一个动态值函数" autocomplete="off" />
      </div>

      <div class="generator-categories" id="generatorCategories">
        <!-- populated by JS -->
      </div>

      <div class="generator-expr">
        <span class="meta-label">表达式:</span>
        <code class="mono" id="generatorExprText">—</code>
      </div>
      <div class="generator-preview">
        <span class="meta-label">预览:</span>
        <code class="mono" id="generatorSampleText">—</code>
      </div>

      <div class="modal-footer">
        <button class="btn btn-primary btn-wide" id="generatorInsertBtn" disabled>插 入</button>
      </div>
    </div>
  </div>
```

**Step 2: 修改 `public/styles.css`**

追加：

```css
/* ============================================================
   Generator modal
   ============================================================ */
.generator-panel {
  width: min(560px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.generator-locale {
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border, #d8d8d2);
}

.generator-search {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border, #d8d8d2);
}

.generator-categories {
  flex: 1;
  overflow: auto;
  padding: 4px 0;
}

.gen-cat {
  border-bottom: 1px solid var(--border, #d8d8d2);
}
.gen-cat-header {
  padding: 8px 16px;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-tertiary, #888);
  cursor: pointer;
  user-select: none;
}
.gen-cat-header:hover { background: rgba(0, 0, 0, 0.02); }
.gen-cat-list { padding: 0 0 8px 0; }
.gen-item {
  padding: 6px 16px 6px 32px;
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  cursor: pointer;
}
.gen-item:hover { background: rgba(26, 111, 168, 0.06); }
.gen-item.is-selected { background: rgba(26, 111, 168, 0.14); color: var(--accent, #1a6fa8); }
.gen-item-label { font-family: var(--font-sans); }
.gen-item-type {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-tertiary, #888);
}

.gen-args {
  padding: 6px 16px 10px 32px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  background: rgba(26, 111, 168, 0.04);
}
.gen-args label { display: flex; flex-direction: column; gap: 2px; }
.gen-args input, .gen-args select {
  width: 80px;
  padding: 3px 6px;
  border: 1px solid var(--border, #d8d8d2);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--surface, #fafaf7);
  color: inherit;
}

.generator-expr, .generator-preview {
  padding: 8px 16px;
  font-size: 12px;
  border-top: 1px solid var(--border, #d8d8d2);
  display: flex;
  gap: 8px;
  align-items: center;
}
.generator-expr code, .generator-preview code { flex: 1; }
.meta-label {
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-tertiary, #888);
}

.btn-wide { width: 100%; }

.select-sm { padding: 2px 8px; font-size: 12px; }
```

**Step 3: 视觉验证**

Run:
```bash
pnpm start
```

打开浏览器 → 新建 endpoint → 响应体输入 `"hello"` → 在 `"hello"` 字符串内点击 → 应看到浮按钮「动态值」出现 → 点击 → 模态框弹出（目前为空，因为 Task 10 还没填 JS）。

**Step 4: 关闭服务，提交**

```bash
git add public/index.html public/styles.css
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(ui): generator modal markup and styles

Layout matches spec §5.3 (locale toggle, search, categories,
expression/sample preview, full-width insert button).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: 数据生成器模态框行为（app.js）

**Files:**
- Modify: `public/app.js`（替换 Task 8 的占位 `openGeneratorModal` 为完整实现）

**Step 1: 在 `public/app.js` 替换 Task 8 的 `__openGeneratorModal` 占位**

把 Task 8 末尾的：

```js
window.__openGeneratorModal = (opts) => {
  console.warn('openGeneratorModal not implemented yet', opts);
};
```

替换为完整实现：

```js
// ============================================================
// Generator modal
// ============================================================
const generatorModal = $('#generatorModal');
const generatorBackdrop = $('#generatorBackdrop');
const generatorCloseBtn = $('#generatorClose');
const generatorBackBtn = $('#generatorBack');
const generatorLocaleSelect = $('#generatorLocale');
const generatorSearchInput = $('#generatorSearch');
const generatorCategoriesEl = $('#generatorCategories');
const generatorExprText = $('#generatorExprText');
const generatorSampleText = $('#generatorSampleText');
const generatorInsertBtn = $('#generatorInsertBtn');

let generatorCatalog = null;        // { locale, categories }
let generatorState = {
  selectedId: null,
  args: {},                          // generator id → args map
  pendingRange: null,                // { from, to } in editor
  filterText: '',
};

async function openGeneratorModal({ from, to, currentValue, initialExpr }) {
  generatorState.pendingRange = { from, to };
  if (!generatorCatalog) {
    generatorCatalog = await api.getGenerators();
  }
  // 初始化选中：如果 currentValue 含 {{...}}，解析出 id+args 预填
  if (initialExpr) {
    const parsed = parseInlineExpression(initialExpr);
    if (parsed) {
      generatorState.selectedId = parsed.id;
      generatorState.args = { ...parsed.args };
    }
  } else {
    generatorState.selectedId = null;
    generatorState.args = {};
  }
  generatorSearchInput.value = '';
  generatorState.filterText = '';
  renderGeneratorCategories();
  updateGeneratorExprAndSample();
  generatorModal.hidden = false;
}

function parseInlineExpression(s) {
  const m = /^\{\{\$([a-zA-Z_][a-zA-Z0-9_.]*)(?::([^}]*))?\}\}$/.exec(s.trim());
  if (!m) return null;
  const args = {};
  if (m[2]) {
    m[2].split(':').forEach((p, i) => { args[i] = p; });
  }
  return { id: m[1], args };
}

function renderGeneratorCategories() {
  if (!generatorCatalog) return;
  generatorCategoriesEl.innerHTML = '';
  for (const cat of generatorCatalog.categories) {
    const filtered = cat.generators.filter((g) => {
      if (!generatorState.filterText) return true;
      return g.label.toLowerCase().includes(generatorState.filterText.toLowerCase())
        || g.id.toLowerCase().includes(generatorState.filterText.toLowerCase());
    });
    if (filtered.length === 0) continue;
    const catEl = document.createElement('div');
    catEl.className = 'gen-cat';
    const header = document.createElement('div');
    header.className = 'gen-cat-header';
    header.innerHTML = `<span>› ${cat.label}</span>`;
    const list = document.createElement('div');
    list.className = 'gen-cat-list';
    for (const g of filtered) {
      const item = document.createElement('div');
      item.className = 'gen-item' + (g.id === generatorState.selectedId ? ' is-selected' : '');
      item.innerHTML = `<span class="gen-item-label">${g.label}</span><span class="gen-item-type">$${g.id}</span>`;
      item.addEventListener('click', () => {
        generatorState.selectedId = g.id;
        // 重置 args 为生成器的默认值
        const def = findGeneratorDef(g.id);
        generatorState.args = {};
        for (const a of def.args) {
          generatorState.args[a.name] = a.default;
        }
        renderGeneratorCategories();
        updateGeneratorExprAndSample();
      });
      list.appendChild(item);
      // 已选中 → 渲染 args
      if (g.id === generatorState.selectedId) {
        const def = findGeneratorDef(g.id);
        if (def.args.length > 0) {
          const argsEl = document.createElement('div');
          argsEl.className = 'gen-args';
          for (const a of def.args) {
            const label = document.createElement('label');
            label.innerHTML = `<span>${a.name}</span>`;
            const input = a.type === 'locale'
              ? (() => {
                  const sel = document.createElement('select');
                  for (const loc of ['zh_CN', 'en']) {
                    const opt = document.createElement('option');
                    opt.value = loc;
                    opt.textContent = loc;
                    if (loc === (generatorState.args[a.name] || a.default)) opt.selected = true;
                    sel.appendChild(opt);
                  }
                  sel.addEventListener('change', () => {
                    generatorState.args[a.name] = sel.value;
                    updateGeneratorExprAndSample();
                  });
                  return sel;
                })()
              : (() => {
                  const inp = document.createElement('input');
                  inp.type = a.type === 'int' || a.type === 'float' ? 'number' : 'text';
                  inp.value = generatorState.args[a.name] ?? a.default;
                  inp.addEventListener('input', () => {
                    generatorState.args[a.name] = inp.value;
                    updateGeneratorExprAndSample();
                  });
                  return inp;
                })();
            label.appendChild(input);
            argsEl.appendChild(label);
          }
          list.appendChild(argsEl);
        }
      }
    }
    catEl.appendChild(header);
    catEl.appendChild(list);
    generatorCategoriesEl.appendChild(catEl);
  }
}

function findGeneratorDef(id) {
  for (const cat of generatorCatalog.categories) {
    const g = cat.generators.find((x) => x.id === id);
    if (g) return g;
  }
  return null;
}

function buildExprText(id, args) {
  const def = findGeneratorDef(id);
  if (!def) return '';
  const argVals = def.args.map((a) => args[a.name] ?? a.default);
  const allFilled = argVals.every((v) => v !== undefined && v !== '');
  if (!allFilled) return `{{$${id}}}`;
  return `{{$${id}:${argVals.join(':')}}}`;
}

let sampleTimer = null;
function updateGeneratorExprAndSample() {
  const id = generatorState.selectedId;
  if (!id) {
    generatorExprText.textContent = '—';
    generatorSampleText.textContent = '—';
    generatorInsertBtn.disabled = true;
    return;
  }
  generatorInsertBtn.disabled = false;
  const expr = buildExprText(id, generatorState.args);
  generatorExprText.textContent = expr;
  if (sampleTimer) clearTimeout(sampleTimer);
  sampleTimer = setTimeout(async () => {
    const res = await api.getGeneratorSample(id, normalizeArgs(id, generatorState.args));
    generatorSampleText.textContent = res.ok ? String(res.sample) : (res.error || '生成失败');
  }, 200);
}

function normalizeArgs(id, args) {
  const def = findGeneratorDef(id);
  if (!def) return {};
  const out = {};
  for (const a of def.args) {
    const v = args[a.name];
    if (v === undefined || v === '') continue;
    if (a.type === 'int') {
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) out[a.name] = n;
    } else if (a.type === 'float') {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) out[a.name] = n;
    } else {
      out[a.name] = String(v);
    }
  }
  return out;
}

function closeGeneratorModal() {
  generatorModal.hidden = true;
}

generatorCloseBtn.addEventListener('click', closeGeneratorModal);
generatorBackdrop.addEventListener('click', closeGeneratorModal);
generatorBackBtn.addEventListener('click', closeGeneratorModal);
generatorSearchInput.addEventListener('input', () => {
  generatorState.filterText = generatorSearchInput.value;
  renderGeneratorCategories();
});
generatorLocaleSelect.addEventListener('change', () => {
  // v1: locale 切换仅影响 person/location 类生成器显示的 label 提示；不强求刷新 catalog
  // 因为当前 API 不按 locale 差异化 catalog。空实现。
});

generatorInsertBtn.addEventListener('click', () => {
  const id = generatorState.selectedId;
  if (!id || !generatorState.pendingRange) return;
  const expr = buildExprText(id, generatorState.args);
  const view = getEditorView();
  const { from, to } = generatorState.pendingRange;
  const replacement = `"${expr}"`;
  view.dispatch({
    changes: { from, to, insert: replacement },
    selection: { anchor: from + 1, head: from + 1 + expr.length },
  });
  closeGeneratorModal();
});

// 暴露给浮按钮点击（Task 8 调用）
window.__openGeneratorModal = openGeneratorModal;
```

**Step 2: 端到端手测**

Run:
```bash
pnpm start
```

打开浏览器：
1. 新建 endpoint
2. 响应体输入 `{ "id": "old" }`
3. 在 `"old"` 字符串内点击 → 浮按钮「动态值」出现
4. 点浮按钮 → 模态框打开
5. 搜 "uuid" → 列表过滤
6. 选 UUID v4 → 表达式显示 `{{$uuid}}`、预览显示 UUID
7. 点「插入」→ 模态框关闭，编辑器内变为 `{ "id": "{{$uuid}}" }`
8. 右栏预览自动刷新显示 `{"id": "a3f1-..."}`

继续：
9. 响应体改为 `{ "n": "old" }`
10. 在 `"old"` 上点 → 浮按钮「动态值」
11. 模态框 → 选「整数」→ 调 min=42, max=42
12. 表达式 → `{{$int:42:42}}`；预览 → `42`
13. 点插入 → 编辑器变为 `{ "n": "{{$int:42:42}}" }`
14. 预览 → `{"n": 42}`（**数字，无引号**）

**Step 3: 关闭服务，提交**

```bash
git add public/app.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "feat(modal): data generator modal — catalog, search, args, insert

Modal pulls catalog from /api/generators, filters by search,
renders inline args panel for selected generator, fetches live sample,
inserts expression into editor at cursor range.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: 镜像到 embed-assets + bun build 验证

**Files:**
- Sync: `embed-assets/public/{index.html,app.js,editor.js,styles.css}` ← `public/`

**Step 1: 同步四个文件**

Run:
```bash
cp public/index.html embed-assets/public/index.html
cp public/app.js embed-assets/public/app.js
cp public/editor.js embed-assets/public/editor.js
cp public/styles.css embed-assets/public/styles.css
```

**Step 2: 确认 diff 一致**

Run:
```bash
diff -q public/index.html embed-assets/public/index.html
diff -q public/app.js embed-assets/public/app.js
diff -q public/editor.js embed-assets/public/editor.js
diff -q public/styles.css embed-assets/public/styles.css
```

Expected: 每个命令无输出（一致）。

**Step 3: 运行 bun build 验证打包**

Run:
```bash
bun build.mjs
```

Expected: `Embedding N files...` + 成功产物 `mockserver`（macOS arm64 当前平台）。

**Step 4: 运行 packaged binary 启动测试（可选 — 跑前先杀掉 pnpm start）**

Run:
```bash
pkill -f 'node server.js' || true
./mockserver &
sleep 2
curl -s http://127.0.0.1:5050/api/health
pkill -f mockserver || true
```

Expected: `{"ok":true}`

**Step 5: 提交**

```bash
git add embed-assets/public/
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "chore(build): sync public/ → embed-assets/public/ for Bun packaging

bun build.mjs successfully produces single-file executable.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: E2E 测试（Playwright headed）

**Files:**
- Create: `test/e2e/dynamic-response-generator.spec.js`

**Step 1: 创建测试文件**

```js
import { test, expect } from '@playwright/test';
import { bootServer, hitMock, newEndpoint } from './helpers.js';

let serverCtx;
test.beforeAll(async () => { serverCtx = await bootServer(); });
test.afterAll(async () => { await serverCtx.cleanup(); });

test('happy path: live preview shows resolved UUID + serve returns real UUID', async ({ page }) => {
  await page.goto('http://127.0.0.1:5050');
  const epId = await newEndpoint(page, { method: 'GET', port: 19501, path: '/dyn1' });

  // 通过 API 直接写入响应体（避开浮按钮点击的复杂交互；浮按钮本身已在 Task 10 手测）
  await page.evaluate(async (id) => {
    await fetch(`/api/endpoints/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: { id: '{{$uuid}}' } }),
    });
  }, epId);
  await page.reload();

  // 等预览刷新（防抖 300ms）
  await page.waitForTimeout(500);

  // 验证预览面板含 UUID
  const previewText = await page.locator('#previewPane').textContent();
  expect(previewText).toMatch(/"id":\s*"[0-9a-f-]{36}"/);

  // 启动 mock 引擎
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(500);

  // 验证 mock 端口返回的 body 含真 UUID
  const body = await hitMock(19501, '/dyn1');
  expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
});

test('number expression preserves type', async ({ page }) => {
  await page.goto('http://127.0.0.1:5050');
  const epId = await newEndpoint(page, { method: 'GET', port: 19502, path: '/n' });
  await page.evaluate(async (id) => {
    await fetch(`/api/endpoints/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: { age: '{{$int:42:42}}' } }),
    });
  }, epId);
  await page.reload();

  await page.waitForTimeout(500);
  const previewText = await page.locator('#previewPane').textContent();
  expect(previewText).toMatch(/"age":\s*42/);  // 无引号
  expect(previewText).not.toMatch(/"age":\s*"42"/);
});

test('JSON syntax error keeps last good preview + shows banner', async ({ page }) => {
  await page.goto('http://127.0.0.1:5050');
  const epId = await newEndpoint(page, { method: 'GET', port: 19503, path: '/err' });
  await page.evaluate(async (id) => {
    await fetch(`/api/endpoints/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: { ok: true } }),
    });
  }, epId);
  await page.reload();

  // 等首次预览渲染
  await page.waitForTimeout(500);
  const firstPreview = await page.locator('#previewPane').textContent();
  expect(firstPreview).toContain('"ok"');

  // 编辑器内破坏 JSON
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('{ broken');

  await page.waitForTimeout(500);
  // banner 应可见
  await expect(page.locator('#previewBanner')).toBeVisible();
  // 预览面板保留上次成功
  const stillThere = await page.locator('#previewPane').textContent();
  expect(stillThere).toContain('"ok"');
});

test('end-to-end serve: dynamic UUID appears in real mock response', async ({ page }) => {
  await page.goto('http://127.0.0.1:5050');
  const epId = await newEndpoint(page, { method: 'GET', port: 19504, path: '/e2e' });
  await page.evaluate(async (id) => {
    await fetch(`/api/endpoints/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: { id: '{{$uuid}}' } }),
    });
  }, epId);

  // 启动 mock
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(500);

  const body1 = await hitMock(19504, '/e2e');
  const body2 = await hitMock(19504, '/e2e');
  expect(body1.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(body2.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(body1.id).not.toBe(body2.id);
});
```

**Step 2: 检查 test/e2e/helpers.js 的导出（按需调整 import）**

Run:
```bash
grep -E "export (async )?function (bootServer|hitMock|newEndpoint)" test/e2e/helpers.js
```

如果没有 `newEndpoint` 或 `hitMock`，参考现有 E2E（`test/e2e/json-editor.spec.js`）的调用风格补 helper。最小可用版：

```js
// test/e2e/helpers.js —— 在末尾追加（如已存在则跳过）
export async function newEndpoint(page, { method = 'GET', port, path }) {
  return await page.evaluate(async ({ method, port, path }) => {
    const r = await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, port, path, response: {} }),
    });
    const ep = await r.json();
    return ep.id;
  }, { method, port, path });
}

export async function hitMock(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return await r.json();
}
```

**Step 3: 运行 E2E**

Run:
```bash
pnpm test:e2e -- test/e2e/dynamic-response-generator.spec.js
```

Expected: 全过（4 个用例）。headed 模式会开浏览器窗口。

**Step 4: 关闭服务器，提交**

```bash
git add test/e2e/dynamic-response-generator.spec.js test/e2e/helpers.js
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "test(e2e): dynamic response generator — happy path + type preservation + error fallback + serve

Playwright headed per project convention (headless: false).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: 最终验证

**Step 1: 全量单元 + 集成**

Run:
```bash
pnpm test
```

Expected: 全过（含所有新测试与所有旧测试）。

**Step 2: 全量 E2E**

Run:
```bash
pnpm test:e2e
```

Expected: 全过（含已有 E2E + 新增 4 个用例）。

**Step 3: Bun build**

Run:
```bash
bun build.mjs
```

Expected: 成功。

**Step 4: 检查 embed-assets 与 public 一致**

Run:
```bash
for f in index.html app.js editor.js styles.css; do
  diff -q public/$f embed-assets/public/$f || echo "MISMATCH: $f"
done
```

Expected: 无输出。

**Step 5: 检查无 console.log**

Run:
```bash
grep -rn 'console\.log' src/ public/ test/unit test/integration
```

Expected: 无匹配（项目规则：生产代码无 console.log；测试代码可用）。

**Step 6: 提交（如有改动）**

如有未提交改动：

```bash
git status
git add -A
git -c user.email=claude@anthropic.com -c user.name=Claude commit -m "chore: final verification pass

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 完成检查清单

跑完所有任务后，逐项验证：

- [ ] 13 个任务全部 commit
- [ ] `pnpm test` 全过
- [ ] `pnpm test:e2e` 全过
- [ ] `bun build.mjs` 成功
- [ ] `embed-assets/public/` 与 `public/` 4 个文件一致
- [ ] 响应体两栏布局正确（左 CodeMirror / 右预览）
- [ ] 浮按钮在 string value 内出现，点开模态框
- [ ] 模态框搜、选、args 实时更新、插入流程通畅
- [ ] 预览面板 300ms 防抖自动刷新
- [ ] 数字类型生成器（如 `int`）插入后预览/服务返回均为真数字（无引号）
- [ ] 表达式错误时预览软失败（pure → null，mixed → 原表达式），UI 给出错误计数
- [ ] JSON 语法错时预览保留上次成功 + 顶部红条
- [ ] mock 服务对含表达式的端点返回真生成值，两次调用不同
- [ ] 模态框生成的端点保存后启动 mock → hitMock 返回的 body 含真生成值

---

**任务依赖关系（无依赖可并行；以下为强依赖）**：

```
Task 1 ──► Task 2 ──► Task 3 ──► Task 4 ──► Task 5
                                          │
                                          ▼
                                  Task 6 ──► Task 7 ──► Task 8
                                                              │
                                                              ▼
                                                       Task 9 ──► Task 10
                                                                          │
                                                                          ▼
                                                                  Task 11
                                                                          │
                                                                          ▼
                                                                  Task 12
                                                                          │
                                                                          ▼
                                                                  Task 13
```
