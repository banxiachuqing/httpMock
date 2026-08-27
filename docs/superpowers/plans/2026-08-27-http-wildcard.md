# HTTP URL 通配符实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 http 类型端点引入段级 path 通配符（`*` 单段 / `**` 跨段），并支持响应内 `{{$path:N}}` 回显匹配值。

**Architecture:** 新增纯函数模块 `src/path-pattern.js`（编译/匹配/具体度排序）；`buildRouter` 把端点分两路——字面 path 进现有精确 Map（行为零变化），通配 path 编译后按 method 分桶并预排序；请求先查精确表，miss 后按序扫描通配桶。`{{$path:N}}` 复用生成器体系：resolver/runGenerator 加可选 ctx 参数透传，新增 `path` 生成器从 ctx 取捕获值。

**Tech Stack:** Node ≥18 纯 JavaScript（原生 ESM，无 TS）· vitest（单元）· supertest（集成）· ego-browser（E2E，本项目偏好）

**Spec:** `docs/superpowers/specs/2026-08-27-http-wildcard-design.md`

## Global Constraints

- 纯 JavaScript + 原生 ESM；**零新运行时依赖**
- 代码注释、文档、commit message 全部简体中文；commit 格式 `<type>: <描述>`，不加任何 attribution 尾注
- **不含 `*` 的 path 走精确 Map，现有行为零变化**（回归红线）
- 唯一性仍按 `port|method|path` 字符串**字面**比较（`ConfigStore.checkUniqueness` 不动）
- `*` / `**` 必须独占一段，否则 API 层 400 `INVALID_PATH`
- `resolve(value, ctx)` / `runGenerator(id, args, ctx)` 新参数必须向后兼容（现有调用不传 ctx 行为不变）
- 测试端口避开已用段（18080-18105、18920-18929、19001-19005），新增用 **182xx**
- E2E 验证用 ego-browser 场景（用户偏好），**不新增 Playwright spec**
- 每个任务结束跑 `pnpm test` 全绿再提交

---

### Task 1: `src/path-pattern.js` 纯函数模块

**Files:**
- Create: `src/path-pattern.js`
- Test: `test/unit/path-pattern.test.js`

**Interfaces:**
- Consumes: 无（纯函数，零依赖）
- Produces（后续任务依赖的签名）:
  - `isPattern(path: string) → boolean`
  - `splitPath(path: string) → string[]`（`split('/')` 后丢弃空段）
  - `validatePattern(path: string) → string | null`（非法返回中文原因）
  - `compilePattern(endpoint: object) → { segments: string[], endpoint: object }`
  - `compareSpecificity(a: compiled, b: compiled) → number`（sort 比较器；更具体者排前）
  - `matchSegments(compiled, pathSegs: string[]) → string[] | null`（命中返回捕获值数组，`**` 多段用 `/` 拼回、零段为 `''`）

- [ ] **Step 1: 写失败测试**

创建 `test/unit/path-pattern.test.js`：

```js
import { describe, it, expect } from 'vitest';
import {
  isPattern, splitPath, validatePattern,
  compilePattern, compareSpecificity, matchSegments,
} from '../../src/path-pattern.js';

const compiled = (path) => compilePattern({ path });
const match = (pattern, path) => matchSegments(compiled(pattern), splitPath(path));

describe('isPattern', () => {
  it('含 * 即视为 pattern，字面 path 不是', () => {
    expect(isPattern('/a/*')).toBe(true);
    expect(isPattern('/a/**')).toBe(true);
    expect(isPattern('/a/b')).toBe(false);
  });
});

describe('splitPath — 拆段丢弃空段（/a/ 与 /a 等价）', () => {
  it('尾斜杠、连续斜杠、根路径', () => {
    expect(splitPath('/a/')).toEqual(['a']);
    expect(splitPath('/a')).toEqual(['a']);
    expect(splitPath('/a//b')).toEqual(['a', 'b']);
    expect(splitPath('/')).toEqual([]);
  });
});

describe('validatePattern — * 与 ** 必须独占一段', () => {
  it('合法 pattern 返回 null', () => {
    expect(validatePattern('/a/*')).toBeNull();
    expect(validatePattern('/a/**/b/**')).toBeNull();
    expect(validatePattern('/a/b')).toBeNull();
  });
  it('段内部分通配返回原因（大声失败，不做隐式语义）', () => {
    expect(validatePattern('/api/fo*/cmd')).toContain('独占一段');
    expect(validatePattern('/api/*x/cmd')).toContain('独占一段');
    expect(validatePattern('/api/***/cmd')).toContain('独占一段');
  });
});

describe('matchSegments — * 单段', () => {
  it('匹配单段并捕获', () => {
    expect(match('/api/*/cmd', '/api/v1/cmd')).toEqual(['v1']);
  });
  it('不匹配零段、不跨段', () => {
    expect(match('/api/*/cmd', '/api/cmd')).toBeNull();
    expect(match('/api/*/cmd', '/api/v1/v2/cmd')).toBeNull();
  });
  it('字面段必须相等', () => {
    expect(match('/api/*/cmd', '/other/v1/cmd')).toBeNull();
    expect(match('/api/*/cmd', '/api/v1/other')).toBeNull();
  });
  it('尾斜杠等价：/a/* 匹配 /a/b/', () => {
    expect(match('/a/*', '/a/b/')).toEqual(['b']);
  });
});

describe('matchSegments — ** 跨段', () => {
  it('零段命中（捕获空串）', () => {
    expect(match('/api/**', '/api')).toEqual(['']);
  });
  it('多段命中并用 / 拼回', () => {
    expect(match('/api/**', '/api/v1/deep/x')).toEqual(['v1/deep/x']);
  });
  it('** 在中间：非贪婪取第一个可行解', () => {
    expect(match('/a/**/b', '/a/x/y/b')).toEqual(['x/y']);
  });
  it('多通配段按从左到右顺序收集捕获值', () => {
    expect(match('/a/*/b/**', '/a/x/b/y/z')).toEqual(['x', 'y/z']);
  });
});

describe('compareSpecificity — 字面(2) > *(1) > **(0)，逐段从左到右', () => {
  const cmp = (a, b) => compareSpecificity(compiled(a), compiled(b));

  it('首段字面胜 *', () => {
    expect(cmp('/a/*/c', '/*/b/c')).toBeLessThan(0);
  });
  it('* 胜 **', () => {
    expect(cmp('/a/*/*', '/a/**')).toBeLessThan(0);
  });
  it('逐段类型全同 → 段数多者胜', () => {
    expect(cmp('/a/**/b', '/a/**')).toBeLessThan(0);
  });
  it('综合排序：/users/* 胜 /users/** 胜 /**', () => {
    const sorted = ['/**', '/users/**', '/users/*'].map(compiled).sort(compareSpecificity);
    expect(sorted.map((p) => p.endpoint.path)).toEqual(['/users/*', '/users/**', '/**']);
  });
  it('完全平手 → 稳定排序保持配置顺序', () => {
    const list = ['/a/*', '/b/*'].map(compiled);
    list.sort(compareSpecificity);
    expect(list.map((p) => p.endpoint.path)).toEqual(['/a/*', '/b/*']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/path-pattern.test.js`
Expected: FAIL（模块不存在，`Failed to resolve import "../../src/path-pattern.js"`）

- [ ] **Step 3: 实现 `src/path-pattern.js`**

```js
// HTTP 端点 path 段级通配（spec 2026-08-27 §2/§3）：
//   *  独占一段 → 匹配任意单个非空段
//   ** 独占一段 → 匹配零个或多个段（跨段）
// 纯函数无状态；mock-engine 每端口 buildRouter 时编译+排序，请求时只做匹配。

/** path 是否含通配符（含 * 即视为 pattern；字面 path 走精确 Map） */
export function isPattern(path) {
  return path.includes('*');
}

/** 拆段：split('/') 后丢弃空段 —— /a/ 与 /a 在通配匹配中等价（spec §2） */
export function splitPath(path) {
  return path.split('/').filter((s) => s !== '');
}

/**
 * 校验 pattern：* / ** 必须独占一段（两侧是 / 或字符串边界）。
 * @returns {string | null} 合法返回 null，非法返回中文原因（供 api.js 抛 INVALID_PATH）
 */
export function validatePattern(path) {
  for (const seg of splitPath(path)) {
    if (!seg.includes('*')) continue;
    if (seg !== '*' && seg !== '**') {
      return `通配符 * / ** 必须独占一段（非法段："${seg}"）`;
    }
  }
  return null;
}

/**
 * 编译 pattern 为段数组结构。
 * @param {object} endpoint 端点实体（含 path）
 * @returns {{ segments: string[], endpoint: object }}
 */
export function compilePattern(endpoint) {
  return { segments: splitPath(endpoint.path), endpoint };
}

// 段类型打分：字面 2 > * 1 > ** 0（spec §3.4）
function segScore(seg) {
  if (seg === '**') return 0;
  if (seg === '*') return 1;
  return 2;
}

/**
 * 具体度比较器（Array.sort 用，更具体者排前）：
 * 逐段从左到右比类型分，第一处分出胜负即定；全同 → 段数多者胜；
 * 再平 → 返回 0，依赖 JS 稳定排序保持配置顺序。
 */
export function compareSpecificity(a, b) {
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const d = segScore(b.segments[i]) - segScore(a.segments[i]);
    if (d !== 0) return d;
  }
  return b.segments.length - a.segments.length;
}

/**
 * 匹配：pattern 段数组 vs 请求段数组（回溯，** 非贪婪尝试消费 0..n 段）。
 * @returns {string[] | null} 命中返回捕获值数组（按通配段从左到右顺序；
 *   ** 多段用 '/' 拼回、零段为 ''），未命中返回 null
 */
export function matchSegments(compiled, pathSegs) {
  const pat = compiled.segments;
  function walk(pi, si, captures) {
    if (pi === pat.length) return si === pathSegs.length ? captures : null;
    const seg = pat[pi];
    if (seg === '**') {
      for (let take = 0; si + take <= pathSegs.length; take++) {
        const r = walk(pi + 1, si + take, [...captures, pathSegs.slice(si, si + take).join('/')]);
        if (r) return r;
      }
      return null;
    }
    if (si >= pathSegs.length) return null;
    if (seg === '*') return walk(pi + 1, si + 1, [...captures, pathSegs[si]]);
    if (seg === pathSegs[si]) return walk(pi + 1, si, captures);
    return null;
  }
  return walk(0, 0, []);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/path-pattern.test.js`
Expected: 全部 PASS（约 15 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/path-pattern.js test/unit/path-pattern.test.js
git commit -m "feat: path-pattern 纯函数模块 — 段级通配编译/匹配/具体度排序"
```

---

### Task 2: mock-engine 通配路由（两路 router + 匹配流程 + 日志 pathParams）

**Files:**
- Modify: `src/mock-engine.js`（`buildRouter` 258-266 行、`createHttpHandler` 269-322 行）
- Test: `test/unit/mock-engine.test.js`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `isPattern` / `splitPath` / `compilePattern` / `compareSpecificity` / `matchSegments`
- Produces:
  - `buildRouter(endpoints) → { exact: Map, patterns: Map<method, compiledPattern[]> }`（原返回单个 Map，签名变更，仅 `createHttpHandler` 一个调用方）
  - 通配命中时日志条目带 `pathParams: string[]` 字段（Task 7 E2E 会核对）

- [ ] **Step 1: 写失败测试**

在 `test/unit/mock-engine.test.js` 末尾（最后一个 `});` 之后）追加：

```js
describe('MockEngine 通配符路由', () => {
  it('* 单段通配命中', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w1', port: 18201, method: 'GET', path: '/api/*/cmd', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    const r = await get(18201, '/api/v1/cmd');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: 1 });
  });

  it('* 不匹配零段与多段', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w2', port: 18202, method: 'GET', path: '/api/*/cmd', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    expect((await get(18202, '/api/cmd')).status).toBe(404);
    expect((await get(18202, '/api/v1/v2/cmd')).status).toBe(404);
  });

  it('** 跨段通配：零段与多段均命中', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w3', port: 18203, method: 'GET', path: '/api/**', statusCode: 200, response: { ok: 3 }, enabled: true },
    ]);
    expect((await get(18203, '/api')).status).toBe(200);
    expect((await get(18203, '/api/v1/deep/x')).status).toBe(200);
  });

  it('精确端点优先于通配端点', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'wild', port: 18204, method: 'GET', path: '/users/*', statusCode: 200, response: { who: 'wild' }, enabled: true },
      { id: 'exact', port: 18204, method: 'GET', path: '/users/admin', statusCode: 200, response: { who: 'exact' }, enabled: true },
    ]);
    expect(JSON.parse((await get(18204, '/users/admin')).body)).toEqual({ who: 'exact' });
    expect(JSON.parse((await get(18204, '/users/123')).body)).toEqual({ who: 'wild' });
  });

  it('具体度：静态段多者优先，与配置顺序无关', async () => {
    engine = new MockEngine({ logBuffer });
    // 先配置更泛的 /*/b/c，验证排序生效而非顺序生效
    await engine.start([
      { id: 'less', port: 18205, method: 'GET', path: '/*/b/c', statusCode: 200, response: { who: '*-b-c' }, enabled: true },
      { id: 'more', port: 18205, method: 'GET', path: '/a/*/c', statusCode: 200, response: { who: 'a-*-c' }, enabled: true },
    ]);
    expect(JSON.parse((await get(18205, '/a/b/c')).body)).toEqual({ who: 'a-*-c' });
  });

  it('通配按 method 分桶，不跨 method 命中', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w7', port: 18207, method: 'POST', path: '/api/*', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    expect((await get(18207, '/api/x')).status).toBe(404);
    expect((await post(18207, '/api/x')).status).toBe(200);
  });

  it('命中通配时日志带 pathParams 与 endpointId', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w8', port: 18208, method: 'GET', path: '/a/*/b/**', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await get(18208, '/a/x/b/y/z');
    expect(pushedLogs[0].pathParams).toEqual(['x', 'y/z']);
    expect(pushedLogs[0].endpointId).toBe('w8');
    expect(pushedLogs[0].matched).toBe(true);
  });

  it('精确命中时日志不带 pathParams', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'e9', port: 18209, method: 'GET', path: '/a/b', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await get(18209, '/a/b');
    expect(pushedLogs[0].pathParams).toBeUndefined();
  });

  it('disabled 通配端点不参与匹配', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w10', port: 18210, method: 'GET', path: '/off/*', statusCode: 200, response: { ok: 1 }, enabled: false },
    ]);
    expect((await get(18210, '/off/x')).status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/mock-engine.test.js`
Expected: 新增 9 个用例 FAIL（通配 path 目前被当字面 key 存进 Map，请求全部 404）

- [ ] **Step 3: 改造 `src/mock-engine.js`**

① 文件头部 import 区（第 14 行后）追加：

```js
import {
  isPattern,
  splitPath,
  compilePattern,
  compareSpecificity,
  matchSegments,
} from './path-pattern.js';
```

② `buildRouter`（258-266 行）整体替换为：

```js
// 两路路由：字面 path 进 exact Map（精确查找，行为同旧版）；
// 含 * 的 path 编译后进 patterns，按 method 分桶 + 具体度预排序（spec 2026-08-27 §3.2）
function buildRouter(endpoints) {
  const exact = new Map();
  const patterns = new Map();
  for (const e of endpoints) {
    if (e.enabled === false) continue;
    if (isPattern(e.path)) {
      const bucket = patterns.get(e.method) || [];
      bucket.push(compilePattern(e));
      patterns.set(e.method, bucket);
    } else {
      exact.set(`${e.port}|${e.method}|${e.path}`, e);
    }
  }
  for (const bucket of patterns.values()) bucket.sort(compareSpecificity);
  return { exact, patterns };
}
```

③ `createHttpHandler` 的匹配行（274 行 `const matched = ...`）替换为：

```js
    // 优先级：精确 > 具体度 > 配置顺序（通配桶已预排序，第一个命中即赢）
    let matched = router.exact.get(`${port}|${req.method}|${pathOnly}`);
    let pathParams = null;
    if (!matched) {
      const bucket = router.patterns.get(req.method);
      if (bucket) {
        const segs = splitPath(pathOnly);
        for (const p of bucket) {
          const caps = matchSegments(p, segs);
          if (caps) {
            matched = p.endpoint;
            pathParams = caps;
            break;
          }
        }
      }
    }
```

④ 日志条目（304-320 行的 `logBuffer?.push(buildLogEntry({...}))`）在 `endpointId: matched?.id || null,` 之后追加一行：

```js
      ...(pathParams ? { pathParams } : {}),
```

⑤ 268 行 `createHttpHandler` 的注释更新为：

```js
// HTTP 端口请求处理：精确 > 通配（*单段/**跨段）两级路由；resolver 失败 → warn 日志 + 原文兜底
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/mock-engine.test.js`
Expected: 全部 PASS（含原有用例——精确路由回归零影响）

- [ ] **Step 5: 提交**

```bash
git add src/mock-engine.js test/unit/mock-engine.test.js
git commit -m "feat: mock 引擎通配路由 — 精确>具体度>顺序两级匹配 + 日志 pathParams"
```

---

### Task 3: resolver ctx 透传 + `$path` 生成器

**Files:**
- Modify: `src/expression-resolver.js`（`resolve` 70-74 行、`walk` 76-126 行、`resolvePure` 128-153 行）
- Modify: `src/generators/index.js`（GENERATORS 注册表、`runGenerator` 257-288 行、CATEGORIES 212-222 行）
- Test: `test/unit/expression-resolver.test.js`（追加）、`test/unit/generators.test.js`（追加）

**Interfaces:**
- Consumes: 无（本任务不接 mock-engine，纯 resolver 层）
- Produces:
  - `resolve(value, ctx?) → { value, errors }`，`ctx = { pathParams?: string[] }`
  - `runGenerator(id, args?, ctx?) → any`（第三参透传给 `def.run(merged, ctx)`）
  - 新生成器 id `path`：`args: [{ name: 'index', type: 'int', default: 1, min: 1 }]`；越界/无 ctx 抛错（走 BAD_ARGS 路径）
  - 新分类 `request`（label「请求上下文」），含 `path`

- [ ] **Step 1: 写失败测试**

`test/unit/expression-resolver.test.js` 末尾追加：

```js
describe('resolve — 请求上下文 $path（spec 2026-08-27 §4）', () => {
  it('纯表达式取路径参数（字符串原类型注入）', () => {
    const r = resolve('{{$path:1}}', { pathParams: ['v1'] });
    expect(r.value).toBe('v1');
    expect(r.errors).toEqual([]);
  });

  it('混合表达式拼接（** 多段已用 / 拼回）', () => {
    const r = resolve('id-{{$path:2}}', { pathParams: ['a', 'b/c'] });
    expect(r.value).toBe('id-b/c');
  });

  it('越界 → 纯表达式 null + BAD_ARGS', () => {
    const r = resolve('{{$path:2}}', { pathParams: ['only'] });
    expect(r.value).toBeNull();
    expect(r.errors[0].code).toBe('BAD_ARGS');
  });

  it('无 ctx → 纯表达式 null + BAD_ARGS', () => {
    const r = resolve('{{$path:1}}');
    expect(r.value).toBeNull();
    expect(r.errors[0].code).toBe('BAD_ARGS');
  });

  it('无 ctx → 混合表达式保留原文 + error', () => {
    const r = resolve('pre-{{$path:1}}');
    expect(r.value).toBe('pre-{{$path:1}}');
    expect(r.errors.length).toBe(1);
  });
});
```

`test/unit/generators.test.js` 末尾追加（先看该文件 import 行，保持同一 import 来源；若已 import `runGenerator` 则无需改 import）：

```js
describe('path 生成器（请求上下文，仅真实请求可用）', () => {
  it('取第 N 个通配段值', () => {
    expect(runGenerator('path', { index: 2 }, { pathParams: ['a', 'b/c'] })).toBe('b/c');
  });
  it('index 缺省为 1', () => {
    expect(runGenerator('path', {}, { pathParams: ['a'] })).toBe('a');
  });
  it('越界抛错（消息含「无对应值」）', () => {
    expect(() => runGenerator('path', { index: 5 }, { pathParams: ['a'] })).toThrow('无对应值');
  });
  it('无 ctx 抛错', () => {
    expect(() => runGenerator('path', { index: 1 })).toThrow('无对应值');
  });
  it('index 非整数走既有参数校验', () => {
    expect(() => runGenerator('path', { index: 'x' }, { pathParams: ['a'] })).toThrow('整数');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/expression-resolver.test.js test/unit/generators.test.js`
Expected: 新增用例 FAIL（`未知生成器：path` / `UNKNOWN_GENERATOR`）

- [ ] **Step 3: 实现 ctx 透传与 path 生成器**

① `src/expression-resolver.js` 三处签名透传（改动最小化，逻辑不变）：

- `resolve`（70-74 行）改为：

```js
/**
 * 递归解析 value 中的 {{...}} 表达式。
 * 纯表达式按 outputType 原类型注入；混合 → String() 拼接；失败时纯 → null / 混合 → 原字符串。
 * @param {unknown} value
 * @param {{ pathParams?: string[] }} [ctx] 请求上下文（通配捕获值；仅真实请求时由 mock-engine 注入）
 * @returns {{ value: unknown, errors: ResolverError[] }}
 */
export function resolve(value, ctx) {
  const errors = [];
  const out = walk(value, errors, ctx);
  return { value: out, errors };
}
```

- `walk(value, errors)` 签名改 `walk(value, errors, ctx)`，函数体内 4 处递归调用透传 ctx（`walk(v, errors, ctx)` 数组分支与对象分支各一处），`resolvePure(replacements[0], errors)` 与 `resolvePure(r, errors, true)` 两调用点加传 ctx：

```js
  if (pure && replacements.length === 1) {
    return resolvePure(replacements[0], errors, ctx);
  }
  // ...
    const sub = resolvePure(r, errors, ctx);
```

（注意：原 `resolvePure(r, errors, /* mixedMode */ true)` 的 mixedMode 参数本就无实际作用只作语义标注——直接移除该参数，调用点如上行所示；函数定义同步改为 `function resolvePure(r, errors, ctx)`，删掉末尾的 `void mixedMode;` 两行注释与语句。）

- `resolvePure` 内 `runGenerator(r.id, named)` 改为 `runGenerator(r.id, named, ctx)`。

② `src/generators/index.js`：

- GENERATORS 注册表末尾（`location.zipCode` 条目之后、`};` 之前）追加：

```js
  // ─── request（请求上下文，仅真实请求时可用）────────────
  path: {
    category: 'request', label: '路径参数（通配段值）', outputType: 'string',
    args: [{ name: 'index', type: 'int', default: 1, min: 1 }],
    // ctx.pathParams 由 mock-engine 在通配命中时注入；预览/取样场景无 ctx → 抛错走软失败
    run: ({ index }, ctx) => {
      const v = ctx?.pathParams?.[index - 1];
      if (v === undefined) {
        throw new Error(`路径参数 {{$path:${index}}} 无对应值（端点通配段不足或非请求上下文）`);
      }
      return v;
    },
  },
```

- CATEGORIES 数组末尾追加：

```js
  { id: 'request',  label: '请求上下文',               generatorIds: ['path'] },
```

- `runGenerator`（257-288 行）签名与 run 调用改为：

```js
/**
 * 校验并合并参数，运行生成器。
 * @param {string} id
 * @param {Record<string, any>} args
 * @param {{ pathParams?: string[] }} [ctx] 请求上下文（仅 path 生成器使用，其余生成器忽略）
 */
export function runGenerator(id, args = {}, ctx) {
```

函数体内 `return def.run(merged);` 改为 `return def.run(merged, ctx);`

- 第 8 行 GeneratorDef typedef 的 run 签名更新为 `run: (a: Record<string, any>, ctx?: object) => any`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/expression-resolver.test.js test/unit/generators.test.js test/integration/api-generators.test.js test/integration/api-preview.test.js`
Expected: 全部 PASS（后两个是回归——`/api/generators` 列表对 path 取样失败被 catch 置 null、`/api/preview` 无 ctx 时 `$path` 进 errors）

- [ ] **Step 5: 提交**

```bash
git add src/expression-resolver.js src/generators/index.js test/unit/expression-resolver.test.js test/unit/generators.test.js
git commit -m "feat: resolver 请求上下文透传 + \$path 生成器（通配段值回显基础）"
```

---

### Task 4: mock-engine 接线 resolve ctx（`$path` 端到端回显）

**Files:**
- Modify: `src/mock-engine.js`（`createHttpHandler` 内 resolve 调用点，286 行附近）
- Test: `test/unit/mock-engine.test.js`（追加 describe）

**Interfaces:**
- Consumes: Task 2 的 `pathParams` 局部变量、Task 3 的 `resolve(value, ctx)`
- Produces: 通配端点响应中 `{{$path:N}}` 在真实请求时替换为捕获值

- [ ] **Step 1: 写失败测试**

`test/unit/mock-engine.test.js` 末尾追加：

```js
describe('MockEngine 通配 + $path 回显（spec 2026-08-27 §4）', () => {
  it('{{$path:1}} 回显单段捕获值（纯表达式注入字符串）', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'p1', port: 18220, method: 'GET', path: '/users/*', statusCode: 200,
        response: { id: '{{$path:1}}' }, enabled: true },
    ]);
    const r = await get(18220, '/users/123');
    expect(r.body).toBe('{"id":"123"}');
  });

  it('{{$path:2}} 回显 ** 多段（/ 拼回）', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'p2', port: 18221, method: 'GET', path: '/a/*/b/**', statusCode: 200,
        response: { first: '{{$path:1}}', rest: '{{$path:2}}' }, enabled: true },
    ]);
    const r = await get(18221, '/a/x/b/y/z');
    expect(JSON.parse(r.body)).toEqual({ first: 'x', rest: 'y/z' });
  });

  it('混合写法拼接：/prefix/{{$path:1}}', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'p3', port: 18222, method: 'GET', path: '/t/*', statusCode: 200,
        response: { msg: 'got-{{$path:1}}' }, enabled: true },
    ]);
    const r = await get(18222, '/t/abc');
    expect(r.body).toBe('{"msg":"got-abc"}');
  });

  it('精确端点写 {{$path:1}} → null + resolver warn（行为一致的软失败）', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'p4', port: 18223, method: 'GET', path: '/exact', statusCode: 200,
        response: { id: '{{$path:1}}' }, enabled: true },
    ]);
    const r = await get(18223, '/exact');
    expect(r.body).toBe('{"id":null}');
    expect(pushedLogs.some((e) => e.source === 'resolver' && e.level === 'warn')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/mock-engine.test.js`
Expected: 前 3 个用例 FAIL（`{{$path:1}}` 无 ctx → null/保留原文）；第 4 个用例此时已 PASS（行为巧合一致，保留作回归）

- [ ] **Step 3: 接线**

`src/mock-engine.js` `createHttpHandler` 内（286 行附近）：

```js
        const { value } = resolve(matched.response);
```

改为：

```js
        // pathParams：通配命中的捕获值（Task 2 注入）；精确命中为空数组，
        // 此时写 {{$path:N}} 走越界软失败（warn + null/原文），行为一致
        const { value } = resolve(matched.response, { pathParams: pathParams ?? [] });
```

（`renderXmlResponse` / WS 路径不动——WS 无通配概念。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/mock-engine.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/mock-engine.js test/unit/mock-engine.test.js
git commit -m "feat: mock 引擎注入 pathParams — \${{\$path:N}} 端到端回显"
```

（commit message 里的 `$` 在 zsh 双引号内需按上行转义；也可改用单引号 commit message。）

---

### Task 5: API 入库 pattern 校验

**Files:**
- Modify: `src/api.js`（`validateEndpointBody` 77-82 行 path 校验块）
- Test: `test/integration/api-endpoints.test.js`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `validatePattern`
- Produces: 非法 pattern → 400 `{ code: 'INVALID_PATH', message }`（含中文原因）

- [ ] **Step 1: 写失败测试**

`test/integration/api-endpoints.test.js` 末尾追加：

```js
describe('POST /api/endpoints — 通配 pattern 校验（spec 2026-08-27 §2）', () => {
  it('合法通配 pattern 创建成功', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/*/cmd' });
    expect(r.status).toBe(201);
    const r2 = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/**' });
    expect(r2.status).toBe(201);
  });

  it('段内部分通配 → 400 INVALID_PATH（大声失败）', async () => {
    for (const path of ['/api/fo*/cmd', '/api/*x/cmd', '/api/***']) {
      const r = await ctx.request.post('/api/endpoints').send({ ...validBody, path });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_PATH');
      expect(r.body.message).toContain('独占一段');
    }
  });

  it('唯一性按字面：/u/* 与 /u/** 可共存', async () => {
    expect((await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/u/*' })).status).toBe(201);
    expect((await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/u/**' })).status).toBe(201);
  });

  it('字面相同的 pattern 仍判重', async () => {
    await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/u/*' });
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/u/*' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_ENDPOINT');
  });

  it('PUT 更新为非法 pattern 同样拒绝', async () => {
    const created = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/put-ok' });
    const r = await ctx.request.put(`/api/endpoints/${created.body.id}`).send({ ...validBody, path: '/put/fo*' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PATH');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/api-endpoints.test.js`
Expected: 「段内部分通配」与「PUT 更新」用例 FAIL（当前 `/api/fo*/cmd` 会被 201 接受）

- [ ] **Step 3: 加校验**

`src/api.js` 头部 import 区追加：

```js
import { validatePattern } from './path-pattern.js';
```

`validateEndpointBody` 的 path 校验块（77-82 行）替换为：

```js
  if (!partial || body.path !== undefined) {
    // '?' 会破坏 mock 路由的 query 拆分（pathOnly 永远匹配不到），'#' 不会到达服务端——都在入库前拒绝
    if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.includes('?') || body.path.includes('#')) {
      throw new AppError(400, 'INVALID_PATH', 'path must start with / and contain no ? or #');
    }
    // 通配 pattern：* / ** 必须独占一段（spec 2026-08-27 §2；段内部分通配不做隐式语义）
    if (body.path.includes('*')) {
      const reason = validatePattern(body.path);
      if (reason) throw new AppError(400, 'INVALID_PATH', reason);
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/api-endpoints.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/api.js test/integration/api-endpoints.test.js
git commit -m "feat: 端点入库校验通配 pattern — * 与 ** 必须独占一段"
```

---

### Task 6: 前端（表单提示 + 通配徽标 + 生成器面板）+ embed-assets 同步

**Files:**
- Modify: `public/index.html`（226-229 行 path 字段）
- Modify: `public/app.js`（端点列表渲染 468-473 行、`updateGeneratorExprAndSample` 2204-2216 行）
- Modify: `public/styles.css`（徽标样式，追加在 `.port-type-badge` 区块 2108 行后）
- Sync: `embed-assets/public/{app.js,index.html,styles.css}`

**Interfaces:**
- Consumes: Task 3 的 `/api/generators` 输出（`path` 生成器 sample 为 null）
- Produces: UI 可见的通配语义提示；无新 JS 接口

- [ ] **Step 1: 表单提示（index.html）**

226-229 行的 `field-path` 块替换为（`.field-hint` 样式已存在于 styles.css:975，无需新增）：

```html
          <div class="field field-path">
            <label for="path">路径</label>
            <input type="text" id="path" class="input mono" placeholder="/api/example 或 /api/*/cmd" autocomplete="off" spellcheck="false" />
            <div class="field-hint">支持通配：<span class="mono">*</span> 匹配单段、<span class="mono">**</span> 跨段；响应里可用 <span class="mono">{{$path:1}}</span> 回显匹配值</div>
          </div>
```

- [ ] **Step 2: 端点列表通配徽标（app.js）**

468-473 行 `endpoint-meta` 块中，`<span class="endpoint-path"></span>` 一行之后插入徽标（模板字符串内）：

```js
        <span class="endpoint-path"></span>
        ${ep.path.includes("*") ? '<span class="wildcard-badge" title="通配符路径：* 匹配单段，** 跨段">通配</span>' : ""}
```

- [ ] **Step 3: 徽标样式（styles.css）**

2108 行 `.port-type-badge[data-type='syslog']` 一行之后追加：

```css

/* 通配端点徽标（spec 2026-08-27 §5）：path 含 * 的端点在列表里标识 */
.wildcard-badge {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 4px;
  opacity: 0.85;
  color: var(--cyan);
}
```

- [ ] **Step 4: 生成器面板「请求时确定」（app.js）**

`updateGeneratorExprAndSample`（2204-2216 行）中，`generatorExprText.textContent = expr;` 之后、`if (sampleTimer)` 之前插入：

```js
  // path 生成器依赖真实请求上下文，无 sample 可取（spec 2026-08-27 §5）
  if (id === "path") {
    if (sampleTimer) clearTimeout(sampleTimer);
    generatorSampleText.textContent = "请求时确定";
    return;
  }
```

- [ ] **Step 5: embed-assets 同步（不变量 5）**

```bash
cp public/app.js public/index.html public/styles.css embed-assets/public/
git diff --stat embed-assets/   # 确认恰好三文件变更
```

- [ ] **Step 6: 全量测试 + 提交**

```bash
pnpm test
git add public/ embed-assets/
git commit -m "feat: 前端通配支持 — 表单提示 + 列表徽标 + 生成器面板请求时确定"
```

---

### Task 7: CLAUDE.md 不变量更新 + ego-browser E2E 验证

**Files:**
- Modify: `CLAUDE.md`（关键不变量区、模块职责表 mock-engine 行）
- E2E: ego-browser 场景（不新增测试文件）

**Interfaces:**
- Consumes: Task 1-6 全部成果
- Produces: 更新后的项目文档；E2E 验证记录

- [ ] **Step 1: CLAUDE.md 更新**

① 关键不变量第 1 条末尾补一句：

```
（含通配符的 path 同样按字符串字面参与唯一性；语义重叠如 /a/* 与 /a/** 允许共存，由运行时优先级裁决）
```

② 不变量列表末尾（第 12 条之后）新增第 13 条：

```
13. **HTTP path 通配**：`*` 独占一段匹配单段、`**` 独占一段跨段（含零段）；路由优先级 = 精确 > 具体度（逐段从左到右：字面 > `*` > `**`，全同则段数多者胜）> 配置顺序；`{{$path:N}}` 按通配段从左到右编号回显，仅 http 端口有效；非法 pattern（段内部分通配）入库即 400。
```

③ 模块职责表 `src/mock-engine.js` 行的「关键点」列补充：`path-pattern.js` 两路路由（exact Map + 预排序通配桶）。

- [ ] **Step 2: ego-browser E2E 场景验证**

调用 ego-browser 技能，按以下清单逐项验证并留存截图：

1. `MOCK_HOST=127.0.0.1 node server.js` 启动（或 `pnpm start`），浏览器打开 UI
2. 新建 http 端口（如 18080）→ 在该端口新建端点：method GET、path `/api/*/cmd`、响应体 `{"id": "{{$path:1}}", "echo": "got-{{$path:1}}"}`
3. 端点列表该项显示「通配」徽标
4. 终端 `curl -s http://127.0.0.1:18080/api/v1/cmd` → 返回 `{"id":"v1","echo":"got-v1"}`；`curl -s http://127.0.0.1:18080/api/cmd` → 404
5. 同端口再建精确端点 GET `/api/v1/cmd` 响应 `{"exact": true}` → 再次 curl `/api/v1/cmd` 返回精确端点内容（优先级反超）；curl `/api/v2/cmd` 仍命中通配
6. 新建端点 path 填 `/api/fo*/cmd` → 表单/接口报错提示「独占一段」
7. 「动态值」面板出现「请求上下文」分类，选中「路径参数」时示例区显示「请求时确定」
8. 请求日志里通配命中的条目可见 `pathParams`

验证通过后停掉服务进程。

- [ ] **Step 3: 最终全量测试 + 提交**

```bash
pnpm test
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 通配不变量 + ego-browser E2E 验证通过"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §2 语法校验 → Task 1/5；§3 匹配引擎 → Task 1/2；§4 `$path` 回显 → Task 3/4；§5 前端 → Task 6；§6 错误处理 → Task 1（校验）/3（软失败）/5（400）；§7 测试 → 各 Task Step + Task 7 E2E；§8 文档 → Task 6（embed-assets）/7（CLAUDE.md）。无缺口。
- **类型一致性**：`compilePattern(endpoint)` 接收端点实体返回 `{segments, endpoint}`——Task 1 测试用 `compilePattern({path})`，Task 2 用 `compilePattern(e)`（完整端点），一致；`matchSegments(compiled, pathSegs)` 签名两处一致；`resolve(value, ctx)` / `runGenerator(id, args, ctx)` 在 Task 3/4 一致。
- **Placeholder 扫描**：无 TBD/TODO；所有步骤含完整代码或确切命令。
