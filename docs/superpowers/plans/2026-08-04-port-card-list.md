# 端口卡片首页 + 端口详情页改版 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 WebUI 改成"端口卡片首页 → 端口详情页"两级结构，端口成为带启用开关的一等实体，接口新增 `name` 字段。

**Architecture:** 后端在 `data.json` v2 中新增 `ports` 实体（v1 自动迁移），新增 `/api/ports` CRUD，`MockEngine.start` 接受端口列表只绑定启用端口；前端引入约 40 行的 hash 路由，body 网格按视图切换，`public/app.js` 的详情页逻辑保留、新增首页卡片视图模块。

**Tech Stack:** Node ≥18 · Express 4 · 原生 ESM（零构建，import map）· vitest + supertest · Playwright（headed）

**Spec:** `docs/superpowers/specs/2026-08-04-port-card-list-design.md`

## Global Constraints

- 纯 JavaScript（无 TypeScript）；前端零构建，原生 ESM + import map
- E2E 必须前台运行：`playwright.config.js` 已固定 `headless: false` + `slowMo: 50`，**不要切 headless**
- `public/` 的任何改动最后必须同步到 `embed-assets/public/`（编译产物输入）
- `ConfigStore.update(mutator)` 是唯一写入入口；mutator 接 `structuredClone` 副本并返回新对象
- `(port, method, path)` 三元组在 `enabled !== false` 端点内唯一 —— 不变量不改
- mock 端口隔离：一个端口绑定失败不影响其他端口 —— 不变量不改
- 提交信息用简体中文，格式 `<type>: <描述>`（feat/fix/refactor/docs/test/chore）
- 现有代码风格：2 空格缩进、单引号、尾分号与现有文件保持一致（prettier 收尾统一）

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/config-store.js` | 修改 | v1→v2 迁移；默认模板带 `ports: []` |
| `src/api-ports.js` | **新建** | `/api/ports` CRUD（`registerPortRoutes(app, { configStore })`） |
| `src/api.js` | 修改 | 接入端口路由；`name` 校验；端点自动补建端口实体；runtime start 传 ports |
| `src/mock-engine.js` | 修改 | `start(endpoints, ports = null)` 端口感知 |
| `public/router.js` | **新建** | hash 路由解析与监听 |
| `public/views/port-cards.js` | **新建** | 首页卡片渲染 + 新建端口弹窗 |
| `public/views/port-detail.js` | **新建** | 详情页端口页头（开关/改号/删除） |
| `public/index.html` | 修改 | 新增首页区、端口页头、名称字段、新建端口弹窗；端口输入框只读 |
| `public/app.js` | 修改 | state 加 ports/route；视图切换；api 客户端加端口方法；列表/保存/日志过滤改造 |
| `public/styles.css` | 修改 | 视图切换网格、卡片、端口页头样式 |
| `test/unit/config-store-migration.test.js` | **新建** | 迁移单测 |
| `test/unit/mock-engine.test.js` | 修改 | 端口感知启动单测 |
| `test/integration/api-ports.test.js` | **新建** | 端口 CRUD 集成测试 |
| `test/integration/api-endpoints.test.js` | 修改 | `name` 字段测试 |
| `test/integration/api-runtime.test.js` | 修改 | 禁用端口不绑定测试 |
| `test/e2e/helpers.js` | 修改 | 新增 `enterPortDetail` |
| `test/e2e/*.spec.js` | 修改 | 适配套件进入详情页的方式 |
| `test/e2e/port-cards.spec.js` | **新建** | 首页卡片 E2E |
| `test/e2e/port-detail.spec.js` | **新建** | 详情页端口操作 E2E |
| `CLAUDE.md` | 修改 | 架构说明更新（Task 8） |

---

### Task 1: ConfigStore v1→v2 迁移

**Files:**
- Test: `test/unit/config-store-migration.test.js`（新建）
- Modify: `src/config-store.js`

**Interfaces:**
- Consumes: `ConfigStore({ storagePath })`、`store.load()`、`tempDir(prefix)` helper（`test/helpers/temp-dir.js`）
- Produces: 加载后的 `store.config` 保证含 `config.ports: [{port, enabled}]`（升序）与 `config.version === 2`。后续 Task 3/4 依赖该保证。

- [ ] **Step 1: 写失败测试**

新建 `test/unit/config-store-migration.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../../src/config-store.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir;

beforeEach(() => { dir = tempDir('mock-migrate-'); });
afterEach(() => dir.cleanup());

function writeV1() {
  const v1 = {
    version: 1,
    settings: { storagePath: dir.path, uiPort: 5050, maxBodyBytes: 4194304 },
    endpoints: [
      { id: 'a', method: 'GET', port: 9090, path: '/b', statusCode: 200, response: {}, enabled: true },
      { id: 'b', method: 'GET', port: 8080, path: '/a', statusCode: 200, response: {}, enabled: true },
      { id: 'c', method: 'POST', port: 8080, path: '/c', statusCode: 201, response: {}, enabled: true },
    ],
  };
  fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(v1));
}

describe('ConfigStore v1 → v2 迁移', () => {
  it('从端点派生去重升序的 ports，全部启用', async () => {
    writeV1();
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(2);
    expect(store.config.ports).toEqual([
      { port: 8080, enabled: true },
      { port: 9090, enabled: true },
    ]);
  });

  it('迁移结果落盘', async () => {
    writeV1();
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir.path, 'data.json'), 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.ports).toHaveLength(2);
  });

  it('已有 ports 的 v2 数据不动', async () => {
    const v2 = {
      version: 2,
      settings: { storagePath: dir.path, uiPort: 5050, maxBodyBytes: 4194304 },
      ports: [{ port: 9999, enabled: false }],
      endpoints: [],
    };
    fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(v2));
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.ports).toEqual([{ port: 9999, enabled: false }]);
  });

  it('全新存储直接是 version 2 + 空 ports', async () => {
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(2);
    expect(store.config.ports).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/config-store-migration.test.js`
Expected: FAIL（`store.config.ports` 为 undefined / version 为 1）

- [ ] **Step 3: 实现迁移**

修改 `src/config-store.js`：

a) `load()` 成功分支，把：

```js
      const parsed = JSON.parse(raw);
      if (typeof parsed.version !== 'number') throw new Error('missing version');
      this.config = parsed;
```

改为：

```js
      const parsed = JSON.parse(raw);
      if (typeof parsed.version !== 'number') throw new Error('missing version');
      this.config = this._migrate(parsed);
      if (this.config !== parsed) await this._writeAtomic();
```

b) `load()` catch 分支的默认模板：

```js
      this.config = {
        version: 2,
        settings: { storagePath: this.storagePath, uiPort: 5050, maxBodyBytes: 4 * 1024 * 1024 },
        ports: [],
        endpoints: [],
      };
```

c) 在 `checkUniqueness` 方法前新增：

```js
  _migrate(cfg) {
    if (Array.isArray(cfg.ports)) return cfg;
    const ports = [...new Set((cfg.endpoints || []).map((e) => e.port))]
      .sort((a, b) => a - b)
      .map((port) => ({ port, enabled: true }));
    return { ...cfg, ports, version: 2 };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/config-store-migration.test.js`
Expected: PASS（4 个用例）

再跑既有单测确认无回归：`pnpm vitest run test/unit/config-store.test.js test/unit/config-store-backup.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config-store.js test/unit/config-store-migration.test.js
git commit -m "feat(store): data.json v1→v2 迁移，派生 ports 实体"
```

---

### Task 2: 端点 name 字段

**Files:**
- Test: `test/integration/api-endpoints.test.js`（追加 describe）
- Modify: `src/api.js`

**Interfaces:**
- Consumes: Task 1 的 `config.ports` 保证（本任务不直接用，但 buildApp 的 store 已是 v2）
- Produces: `POST/PUT /api/endpoints` 接受并规范化 `name`；错误码 `INVALID_NAME`。前端 Task 7 依赖 `ep.name` 字段。

- [ ] **Step 1: 写失败测试**

在 `test/integration/api-endpoints.test.js` 末尾追加：

```js
describe('endpoint name 字段', () => {
  it('保存 trim 后的名称', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, name: '  用户登录 ' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('用户登录');
  });

  it('超过 50 字符拒绝', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, name: 'x'.repeat(51) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_NAME');
  });

  it('非字符串拒绝', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, name: 123 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_NAME');
  });

  it('空白名称视为未填，不存储', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, name: '   ' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBeUndefined();
  });

  it('PUT 可更新名称', async () => {
    const created = await ctx.request.post('/api/endpoints').send(validBody);
    const r = await ctx.request.put(`/api/endpoints/${created.body.id}`).send({ ...validBody, name: '改名' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('改名');
  });

  it('PUT 空白名称清除已有名称', async () => {
    const created = await ctx.request.post('/api/endpoints').send({ ...validBody, name: '原名' });
    const r = await ctx.request.put(`/api/endpoints/${created.body.id}`).send({ ...validBody, name: '  ' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/api-endpoints.test.js`
Expected: FAIL（name 被原样透传 / 无校验）

- [ ] **Step 3: 实现校验与规范化**

修改 `src/api.js`：

a) 在 `const METHODS = ...` 下方新增：

```js
const MAX_NAME_LENGTH = 50;

function validateName(body) {
  if (body.name === undefined) return;
  if (typeof body.name !== 'string') {
    throw new AppError(400, 'INVALID_NAME', 'name must be a string');
  }
  if (body.name.trim().length > MAX_NAME_LENGTH) {
    throw new AppError(400, 'INVALID_NAME', `name must be at most ${MAX_NAME_LENGTH} chars`);
  }
}

function withNormalizedName(ep) {
  if (typeof ep.name === 'string') {
    const trimmed = ep.name.trim();
    if (trimmed) ep.name = trimmed;
    else delete ep.name;
  }
  return ep;
}
```

b) `validateEndpointBody` 末尾（response 校验之后）加一行：

```js
  validateName(body);
```

c) POST 路由中 `const ep = { id, ...req.body, enabled: req.body.enabled !== false };` 改为：

```js
      const ep = withNormalizedName({ id, ...req.body, enabled: req.body.enabled !== false });
```

d) PUT 路由中 `const updated = { ...list[idx], ...req.body, id: list[idx].id };` 改为：

```js
      const updated = withNormalizedName({ ...list[idx], ...req.body, id: list[idx].id });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/api-endpoints.test.js`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/api.js test/integration/api-endpoints.test.js
git commit -m "feat(api): 端点新增 name 字段（可选，≤50 字符）"
```

---

### Task 3: /api/ports CRUD + 端点自动补建端口实体

**Files:**
- Create: `src/api-ports.js`
- Test: `test/integration/api-ports.test.js`（新建）
- Modify: `src/api.js`

**Interfaces:**
- Consumes: Task 1 的 `config.ports` 保证；`AppError`（`src/errors.js`）
- Produces: `registerPortRoutes(app, { configStore })`；API：
  - `GET /api/ports` → `[{port, enabled}]`
  - `POST /api/ports` `{port}` → 201 `{port, enabled: true}`；400 `INVALID_PORT` / `DUPLICATE_PORT`
  - `PUT /api/ports/:port` `{port?, enabled?}` → 200 更新后实体（改号级联 endpoints）；404 / 400
  - `DELETE /api/ports/:port` → 204（连带删除其下端点）；404
  - `POST/PUT /api/endpoints` 对未知端口自动补建 `{port, enabled: true}`

- [ ] **Step 1: 写失败测试**

新建 `test/integration/api-ports.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir, store, ctx;

beforeEach(async () => {
  dir = tempDir('mock-ports-');
  store = new ConfigStore({ storagePath: dir.path });
  await store.load();
  ctx = buildApp({
    storagePath: dir.path,
    configStore: store,
    logBuffer: { push: () => {}, subscribe: () => () => {} },
    mockEngine: { start: async () => ({ running: [], failed: [] }), stop: async () => {}, getStatus: () => ({}), servers: new Map() },
  });
});

afterEach(() => dir.cleanup());

describe('GET /api/ports', () => {
  it('初始返回空列表', async () => {
    const r = await ctx.request.get('/api/ports');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe('POST /api/ports', () => {
  it('创建端口，默认启用', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8080 });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ port: 8080, enabled: true });
    const list = await ctx.request.get('/api/ports');
    expect(list.body).toEqual([{ port: 8080, enabled: true }]);
  });

  it('按端口号升序保存', async () => {
    await ctx.request.post('/api/ports').send({ port: 9090 });
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const list = await ctx.request.get('/api/ports');
    expect(list.body.map((p) => p.port)).toEqual([8080, 9090]);
  });

  it.each([0, 70000, 'abc'])('拒绝非法端口号 %p', async (port) => {
    const r = await ctx.request.post('/api/ports').send({ port });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PORT');
  });

  it('重复端口拒绝', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const r = await ctx.request.post('/api/ports').send({ port: 8080 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_PORT');
  });
});

describe('PUT /api/ports/:port', () => {
  it('切换启用状态', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const r = await ctx.request.put('/api/ports/8080').send({ enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ port: 8080, enabled: false });
  });

  it('改号级联更新端点的 port 字段', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    await ctx.request.post('/api/endpoints').send({ port: 8080, method: 'GET', path: '/a', statusCode: 200, response: {} });
    const r = await ctx.request.put('/api/ports/8080').send({ port: 9090 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ port: 9090, enabled: true });
    const eps = await ctx.request.get('/api/endpoints');
    expect(eps.body.map((e) => e.port)).toEqual([9090]);
    const ports = await ctx.request.get('/api/ports');
    expect(ports.body.map((p) => p.port)).toEqual([9090]);
  });

  it('改号撞已有端口拒绝', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    await ctx.request.post('/api/ports').send({ port: 9090 });
    const r = await ctx.request.put('/api/ports/8080').send({ port: 9090 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_PORT');
  });

  it('未知端口 404', async () => {
    const r = await ctx.request.put('/api/ports/1234').send({ enabled: false });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/ports/:port', () => {
  it('连带删除其下所有端点，保留其他端口', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    await ctx.request.post('/api/ports').send({ port: 9090 });
    await ctx.request.post('/api/endpoints').send({ port: 8080, method: 'GET', path: '/a', statusCode: 200, response: {} });
    await ctx.request.post('/api/endpoints').send({ port: 9090, method: 'GET', path: '/b', statusCode: 200, response: {} });
    const r = await ctx.request.delete('/api/ports/8080');
    expect(r.status).toBe(204);
    const ports = await ctx.request.get('/api/ports');
    expect(ports.body.map((p) => p.port)).toEqual([9090]);
    const eps = await ctx.request.get('/api/endpoints');
    expect(eps.body.map((e) => e.path)).toEqual(['/b']);
  });

  it('未知端口 404', async () => {
    const r = await ctx.request.delete('/api/ports/1234');
    expect(r.status).toBe(404);
  });
});

describe('端点自动补建端口实体', () => {
  it('POST /api/endpoints 为未知端口补建 port', async () => {
    await ctx.request.post('/api/endpoints').send({ port: 7777, method: 'GET', path: '/x', statusCode: 200, response: {} });
    const r = await ctx.request.get('/api/ports');
    expect(r.body).toEqual([{ port: 7777, enabled: true }]);
  });

  it('PUT /api/endpoints 改到未知端口时补建', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const created = await ctx.request.post('/api/endpoints').send({ port: 8080, method: 'GET', path: '/x', statusCode: 200, response: {} });
    await ctx.request.put(`/api/endpoints/${created.body.id}`).send({ port: 7788, method: 'GET', path: '/x', statusCode: 200, response: {} });
    const r = await ctx.request.get('/api/ports');
    expect(r.body.map((p) => p.port).sort()).toEqual([7788, 8080]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/api-ports.test.js`
Expected: FAIL（404，路由不存在）

- [ ] **Step 3: 实现 src/api-ports.js**

新建 `src/api-ports.js`：

```js
// /api/ports CRUD —— 端口一等实体
import { AppError } from './errors.js';

function parsePortNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(400, 'INVALID_PORT', 'port must be 1..65535');
  }
  return port;
}

function sorted(ports) {
  return [...ports].sort((a, b) => a.port - b.port);
}

/**
 * @param {import('express').Express} app
 * @param {{ configStore: import('./config-store.js').ConfigStore }} deps
 */
export function registerPortRoutes(app, { configStore }) {
  app.get('/api/ports', (_req, res) => res.json(configStore.config.ports));

  app.post('/api/ports', async (req, res, next) => {
    try {
      const port = parsePortNumber(req.body?.port);
      if (configStore.config.ports.some((p) => p.port === port)) {
        throw new AppError(400, 'DUPLICATE_PORT', `port ${port} already exists`);
      }
      const entity = { port, enabled: true };
      await configStore.update((cfg) => {
        cfg.ports = sorted([...cfg.ports, entity]);
        return cfg;
      });
      res.status(201).json(entity);
    } catch (e) { next(e); }
  });

  app.put('/api/ports/:port', async (req, res, next) => {
    try {
      const oldPort = Number(req.params.port);
      const current = configStore.config.ports.find((p) => p.port === oldPort);
      if (!current) throw new AppError(404, 'NOT_FOUND', 'port not found');

      const { port: newPortRaw, enabled } = req.body || {};
      let newPort = oldPort;
      if (newPortRaw !== undefined) {
        newPort = parsePortNumber(newPortRaw);
        if (newPort !== oldPort && configStore.config.ports.some((p) => p.port === newPort)) {
          throw new AppError(400, 'DUPLICATE_PORT', `port ${newPort} already exists`);
        }
      }
      const newEnabled = enabled === undefined ? current.enabled : enabled !== false;

      let updated;
      await configStore.update((cfg) => {
        cfg.ports = sorted(cfg.ports.map((p) =>
          p.port === oldPort ? { port: newPort, enabled: newEnabled } : p));
        if (newPort !== oldPort) {
          cfg.endpoints = cfg.endpoints.map((e) =>
            e.port === oldPort ? { ...e, port: newPort } : e);
        }
        updated = cfg.ports.find((p) => p.port === newPort);
        return cfg;
      });
      res.json(updated);
    } catch (e) { next(e); }
  });

  app.delete('/api/ports/:port', async (req, res, next) => {
    try {
      const port = Number(req.params.port);
      if (!configStore.config.ports.some((p) => p.port === port)) {
        throw new AppError(404, 'NOT_FOUND', 'port not found');
      }
      await configStore.update((cfg) => {
        cfg.ports = cfg.ports.filter((p) => p.port !== port);
        cfg.endpoints = cfg.endpoints.filter((e) => e.port !== port);
        return cfg;
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });
}
```

- [ ] **Step 4: 接入 api.js + 端点自动补建**

修改 `src/api.js`：

a) 顶部 import：

```js
import { registerPortRoutes } from './api-ports.js';
```

b) 在 `registerPreviewRoutes(app);` 之前插入：

```js
  // Ports CRUD（端口一等实体）
  registerPortRoutes(app, { configStore });
```

c) 在 `validateEndpointBody` 附近新增 helper：

```js
function ensurePortEntity(cfg, port) {
  if (!cfg.ports.some((p) => p.port === port)) {
    cfg.ports = [...cfg.ports, { port, enabled: true }].sort((a, b) => a.port - b.port);
  }
}
```

d) POST `/api/endpoints` 路由的 update 改为：

```js
      await configStore.update((cfg) => {
        cfg.endpoints = all;
        ensurePortEntity(cfg, ep.port);
        return cfg;
      });
```

e) PUT `/api/endpoints/:id` 路由的 update 改为：

```js
      await configStore.update((cfg) => {
        cfg.endpoints = all;
        ensurePortEntity(cfg, updated.port);
        return cfg;
      });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run test/integration/api-ports.test.js test/integration/api-endpoints.test.js`
Expected: PASS（全部）

- [ ] **Step 6: 提交**

```bash
git add src/api-ports.js src/api.js test/integration/api-ports.test.js
git commit -m "feat(api): /api/ports CRUD + 端点自动补建端口实体"
```

---

### Task 4: MockEngine 端口感知启动

**Files:**
- Test: `test/unit/mock-engine.test.js`（追加 describe）、`test/integration/api-runtime.test.js`（追加用例）
- Modify: `src/mock-engine.js`、`src/api.js`

**Interfaces:**
- Consumes: `config.ports`（Task 1）；`/api/ports` PUT（Task 3）
- Produces: `MockEngine.start(endpoints, ports = null)`：
  - `ports` 为数组时 → 只绑定 `enabled !== false` 的端口；空端口也绑定（404）；不在列表中的端点端口被忽略
  - `ports` 为 null 时 → 旧行为（按端点分组全绑定），既有单测不受影响

- [ ] **Step 1: 写失败测试**

a) 在 `test/unit/mock-engine.test.js` 末尾追加（与现有 describe 平级）：

```js
describe('端口感知启动（ports 列表）', () => {
  it('只绑定启用端口，禁用端口不监听', async () => {
    engine = new MockEngine({ logBuffer });
    const endpoints = [
      { id: 'a', port: 18090, method: 'GET', path: '/on', statusCode: 200, response: { ok: 1 }, enabled: true },
      { id: 'b', port: 18091, method: 'GET', path: '/off', statusCode: 200, response: { ok: 2 }, enabled: true },
    ];
    const ports = [
      { port: 18090, enabled: true },
      { port: 18091, enabled: false },
    ];
    const { running, failed } = await engine.start(endpoints, ports);
    expect(running.map((r) => r.port)).toEqual([18090]);
    expect(failed).toEqual([]);
    const res = await get(18090, '/on');
    expect(res.status).toBe(200);
    await expect(get(18091, '/off')).rejects.toThrow();
  });

  it('启用但无端点的端口照常绑定，返回 404', async () => {
    engine = new MockEngine({ logBuffer });
    const { running } = await engine.start([], [{ port: 18092, enabled: true }]);
    expect(running.map((r) => r.port)).toEqual([18092]);
    const res = await get(18092, '/anything');
    expect(res.status).toBe(404);
  });

  it('端点引用的端口不在 ports 列表时忽略', async () => {
    engine = new MockEngine({ logBuffer });
    const endpoints = [
      { id: 'a', port: 18093, method: 'GET', path: '/x', statusCode: 200, response: {}, enabled: true },
    ];
    const { running, failed } = await engine.start(endpoints, []);
    expect(running).toEqual([]);
    expect(failed).toEqual([]);
  });
});
```

b) 在 `test/integration/api-runtime.test.js` 的 `describe('POST /api/runtime/start', ...)` 内追加：

```js
  it('禁用端口不随启动绑定', async () => {
    await ctx.request.post('/api/endpoints').send({ port: 19095, method: 'GET', path: '/a', statusCode: 200, response: { ok: 1 } });
    await ctx.request.put('/api/ports/19095').send({ enabled: false });
    const r = await ctx.request.post('/api/runtime/start');
    expect(r.body.running).toEqual([]);
    expect(r.body.failed).toEqual([]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/mock-engine.test.js test/integration/api-runtime.test.js`
Expected: FAIL（禁用端口仍被绑定 / 空端口未绑定）

- [ ] **Step 3: 实现**

a) 修改 `src/mock-engine.js` 的 `start` 方法签名与分组逻辑，把：

```js
  async start(endpoints) {
    const byPort = new Map();
    for (const e of endpoints) {
      if (!byPort.has(e.port)) byPort.set(e.port, []);
      byPort.get(e.port).push(e);
    }

    await this.stop();
```

改为：

```js
  async start(endpoints, ports = null) {
    const byPort = new Map();
    for (const e of endpoints) {
      if (!byPort.has(e.port)) byPort.set(e.port, []);
      byPort.get(e.port).push(e);
    }

    if (Array.isArray(ports)) {
      const allowed = new Set(ports.filter((p) => p.enabled !== false).map((p) => p.port));
      for (const key of [...byPort.keys()]) {
        if (!allowed.has(key)) byPort.delete(key);
      }
      for (const p of ports) {
        if (p.enabled !== false && !byPort.has(p.port)) byPort.set(p.port, []);
      }
    }

    await this.stop();
```

b) 修改 `src/api.js` 的 `/api/runtime/start` 路由：

```js
      const result = await mockEngine.start(configStore.config.endpoints, configStore.config.ports);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/mock-engine.test.js test/integration/api-runtime.test.js`
Expected: PASS（既有旧用例走 `ports = null` 分支，不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/mock-engine.js src/api.js test/unit/mock-engine.test.js test/integration/api-runtime.test.js
git commit -m "feat(engine): 启动只绑定启用端口，支持空端口"
```

---

### Task 5: 前端 hash 路由 + 视图骨架

**目标**：`#/` 显示首页（本任务中首页只有占位头），`#/port/<port>` 显示现有详情页；所有既有 E2E 保持绿色。

**Files:**
- Create: `public/router.js`
- Modify: `public/index.html`、`public/app.js`、`public/styles.css`、`test/e2e/helpers.js`、`test/e2e/happy-path.spec.js`、`test/e2e/json-editor.spec.js`、`test/e2e/log-detail-modal.spec.js`、`test/e2e/dynamic-response-generator.spec.js`

**Interfaces:**
- Consumes: `GET /api/ports`（Task 3）
- Produces:
  - `router.js` 导出 `parseRoute(hash) → {view:'home'} | {view:'port', port:number}`、`startRouter(onChange)`、`navigate(hash)`
  - `state.ports`、`state.route`（app.js）
  - DOM：`#viewHome`、`#portHeader`（含 `#backToHomeBtn`、`#portHeaderNumber`、`#portStatusLed`）、`#portNotFound`；`#sidebarPanel`（aside.sidebar）、`#logsPanel`（section.logs）
  - E2E helper：`enterPortDetail(page, baseURL, port)`
  - body 上的 `data-view="home" | "port"` 属性驱动 CSS 网格

- [ ] **Step 1: 新建 public/router.js**

```js
// hash 路由：#/ → 首页（端口卡片）；#/port/<port> → 端口详情页
export function parseRoute(hash) {
  const m = /^#\/port\/(\d+)$/.exec(hash || '');
  if (m) return { view: 'port', port: Number(m[1]) };
  return { view: 'home' };
}

export function startRouter(onChange) {
  const apply = () => onChange(parseRoute(location.hash));
  window.addEventListener('hashchange', apply);
  apply();
}

export function navigate(hash) {
  location.hash = hash;
}
```

- [ ] **Step 2: 改 index.html 结构**

a) `<aside class="sidebar" ...>` 加 id：`<aside class="sidebar" id="sidebarPanel" ...>`；`<section class="logs" ...>` 加 id：`<section class="logs" id="logsPanel" ...>`。

b) 在 `</header>`（topbar 结束）之后、`<main class="layout">` 之前插入：

```html
  <!-- 首页：端口卡片（卡片渲染见 port-cards.js） -->
  <section class="home-view" id="viewHome" hidden>
    <div class="home-header">
      <h2 class="section-label">端口列表</h2>
      <span class="sidebar-count" id="portCardCount">0</span>
      <span class="home-hint">点击卡片进入端口详情</span>
    </div>
    <div class="port-card-grid" id="portCardGrid"></div>
  </section>

  <!-- 端口详情页页头 -->
  <header class="port-header" id="portHeader" hidden>
    <button class="btn btn-ghost btn-sm" id="backToHomeBtn">← 返回端口列表</button>
    <span class="port-header-number mono" id="portHeaderNumber">:—</span>
    <div class="spacer"></div>
    <span class="led" id="portStatusLed" data-state="stopped" title="端口运行状态"></span>
  </header>

  <!-- hash 指向不存在端口时 -->
  <div class="port-not-found" id="portNotFound" hidden>
    <div class="editor-empty-inner">
      <div class="editor-empty-mark">//</div>
      <h3 class="editor-empty-title">端口不存在</h3>
      <p class="editor-empty-text">它可能已被删除。</p>
      <button class="btn btn-ghost" id="portNotFoundBack">返回端口列表</button>
    </div>
  </div>
```

- [ ] **Step 3: 改 styles.css 视图切换**

a) 把 body 网格规则改为（原 `body { display: grid; ... }` 块）：

```css
body {
  display: grid;
  grid-template-rows: 56px auto 1fr 260px;
  grid-template-columns: 320px 1fr;
  grid-template-areas:
    "topbar  topbar"
    "porthdr porthdr"
    "sidebar editor"
    "logs    logs";
  position: relative;
}

body[data-view='home'] {
  grid-template-rows: 56px 1fr;
  grid-template-columns: 1fr;
  grid-template-areas:
    "topbar"
    "home";
}
```

b) 文件末尾追加：

```css
/* ============================================================
   首页（端口卡片）与端口页头
   ============================================================ */
.home-view {
  grid-area: home;
  overflow-y: auto;
  padding: var(--s-6);
}

.home-header {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
}

.home-hint {
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 12px;
}

.port-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--s-4);
}

.port-header {
  grid-area: porthdr;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-2) var(--s-4);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}

.port-header-number {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.port-not-found {
  grid-area: home;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

- [ ] **Step 4: 改 app.js —— state、视图切换**

a) 顶部 import：

```js
import { startRouter, navigate } from './router.js';
```

b) `state` 对象新增两个键：

```js
  ports: [],
  route: { view: 'home' },
```

c) `els` 对象新增：

```js
  viewHome: $('#viewHome'),
  portCardGrid: $('#portCardGrid'),
  portCardCount: $('#portCardCount'),
  portHeader: $('#portHeader'),
  backToHomeBtn: $('#backToHomeBtn'),
  portHeaderNumber: $('#portHeaderNumber'),
  portStatusLed: $('#portStatusLed'),
  portNotFound: $('#portNotFound'),
  portNotFoundBack: $('#portNotFoundBack'),
  sidebarPanel: $('#sidebarPanel'),
  logsPanel: $('#logsPanel'),
```

d) `loadAll()` 中 `state.endpoints = await api.listEndpoints();` 之后加：

```js
  state.ports = await (await fetch('/api/ports')).json();
```

（正式 api 方法在 Task 6 统一补；此处先用内联 fetch 避免跨任务依赖。）

e) 在 `renderStatus()` 函数之后新增视图切换逻辑：

```js
// ============================================================
// 路由与视图切换
// ============================================================
let suppressHash = false;

function applyRoute(route) {
  if (state.dirty && state.route.view === 'port' && !confirm('有未保存的修改，是否放弃？')) {
    suppressHash = true;
    location.hash = `#/port/${state.route.port}`;
    return;
  }
  state.route = route;
  state.dirty = false;

  const home = route.view === 'home';
  const portKnown = !home && state.ports.some((p) => p.port === route.port);
  document.body.dataset.view = home ? 'home' : 'port';
  els.viewHome.hidden = !home;
  els.portHeader.hidden = home || !portKnown;
  els.portNotFound.hidden = home || portKnown;
  els.sidebarPanel.hidden = home || !portKnown;
  els.editor.hidden = home || !portKnown;
  els.logsPanel.hidden = home || !portKnown;

  if (!home && portKnown) {
    els.portHeaderNumber.textContent = `:${route.port}`;
    const st = state.runtimeStatus[String(route.port)];
    els.portStatusLed.dataset.state =
      st?.state === 'failed' ? 'failed' : st?.state === 'running' ? 'running' : 'stopped';
    // CodeMirror 在 hidden 容器里挂载过，显示后需要重新测量
    getEditorView()?.requestMeasure();
    renderEditor();
    renderLogsInitial();
  }
}
```

f) 事件区（`// Wire events` 段）追加：

```js
els.backToHomeBtn.addEventListener('click', () => navigate('#/'));
els.portNotFoundBack.addEventListener('click', () => navigate('#/'));
```

g) boot 段：把 `loadAll().then(() => {` 回调末尾（`setInterval(refreshRuntimeStatus, 5000);` 之后）追加：

```js
  startRouter((route) => {
    if (suppressHash) { suppressHash = false; return; }
    applyRoute(route);
  });
```

h) `appendLog(entry)` 与 `renderLogsInitial()` 暂时不变（Task 7 加端口过滤）。`renderEndpointList()` 中 LED 逻辑不变。

- [ ] **Step 5: 更新 E2E helpers**

在 `test/e2e/helpers.js` 末尾追加：

```js
export async function enterPortDetail(page, baseURL, port) {
  await page.goto(`${baseURL}/#/port/${port}`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.waitForSelector('#portHeader:not([hidden])');
}
```

- [ ] **Step 6: 更新既有 E2E spec**

统一改法：**"创建端点 → page.reload → 操作编辑器/日志"** 的段落，改为 **"创建端点 → `enterPortDetail(page, server.baseURL, <该端点的端口>)` → 原操作"**。逐个文件：

a) `test/e2e/happy-path.spec.js`：
- import 改为 `import { bootServer, hitMock, enterPortDetail } from './helpers.js';`
- `page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);`（"Reload the page..." 注释处）替换为：

```js
  // hash 路由下 reload 停留在详情页（同时验证 hash 持久性）
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
```

- 在 `expect(createResp.status).toBe(201);` 之后、`// Start the mock engine via API` 之前插入：

```js
  await enterPortDetail(page, server.baseURL, 17001);
```

（首次进入详情页靠 enterPortDetail；后面 reload 因 hash 保留仍在详情页。）

b) `test/e2e/json-editor.spec.js`：
- import 加 `enterPortDetail`
- 删除 `await page.reload(...); await page.waitForTimeout(1500);`（创建 17020 端点之后的那组），替换为 `await enterPortDetail(page, server.baseURL, 17020);`

c) `test/e2e/log-detail-modal.spec.js`：
- import 改为 `import { bootServer, hitMock, enterPortDetail } from './helpers.js';`
- 前 7 个测试用的端口依次是 **19601、19602、19603、19604、19605、19606、19607**。每个测试里，把创建端点之后的这两行：

  ```js
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  ```

  替换为（用该测试自己的端口号）：

  ```js
  await enterPortDetail(page, server.baseURL, 19601); // 按测试替换为对应端口
  ```

- 最后 2 个 Settings 测试（`Settings: change maxBodyBytes...`、`Settings: invalid maxBodyBytes...`）**不改**（只操作 topbar 的设置弹窗，首页视图下成立）
- `#startStopBtn` 在 topbar，详情页同样可见，点击逻辑不变

d) `test/e2e/dynamic-response-generator.spec.js`：
- import 加 `enterPortDetail`
- 4 个测试用的端口依次是 **19501、19502、19503、19504**。每个测试里，把创建端点之后的这两行：

  ```js
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  ```

  替换为（用该测试自己的端口号）：

  ```js
  await enterPortDetail(page, server.baseURL, 19501); // 按测试替换为对应端口
  ```

e) `test/e2e/port-conflict.spec.js`：**不改**（只断言 topbar 的 `#globalStatus` 和 hitMock，首页视图下全部成立）。

- [ ] **Step 7: 跑全部测试验证**

Run: `pnpm vitest run`（后端无变化，应全绿）
Run: `pnpm test:e2e`
Expected: 全部 PASS。重点确认 happy-path（含 reload 停留详情页）、json-editor、log-detail-modal、dynamic-response-generator、port-conflict。

- [ ] **Step 8: 提交**

```bash
git add public/ test/e2e/
git commit -m "refactor(ui): hash 路由 + 端口详情页视图骨架"
```

---

### Task 6: 首页端口卡片 + 新建端口弹窗

**Files:**
- Create: `public/views/port-cards.js`、`test/e2e/port-cards.spec.js`
- Modify: `public/app.js`、`public/index.html`、`public/styles.css`

**Interfaces:**
- Consumes: `state.ports`、`state.logs`、`state.runtimeStatus`、`parseRoute`/`navigate`（Task 5）；`POST/PUT /api/ports`（Task 3）
- Produces: `renderPortCards(state, { grid, countEl, api })`、`nextFreePort(ports, start = 8080)`、`initNewPortDialog({ els, state, api })`；app.js api 客户端新增 `listPorts/createPort/updatePort/deletePort`（deletePort 供 Task 7）

- [ ] **Step 1: 新建 public/views/port-cards.js（最终版，直接照抄）**

```js
// 首页：端口卡片渲染 + 新建端口弹窗
import { navigate } from '../router.js';

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function latestLogByPort(logs) {
  const latest = new Map();
  for (const entry of logs) {
    if (!entry.method) continue; // 过滤 resolver-warn 条目
    const prev = latest.get(entry.port);
    if (!prev || entry.timestamp > prev.timestamp) latest.set(entry.port, entry);
  }
  return latest;
}

function endpointLabel(entry, endpoints) {
  if (!entry.matched || !entry.endpointId) return `无路由 · ${entry.path}`;
  const ep = endpoints.find((e) => e.id === entry.endpointId);
  if (ep?.name) return ep.name;
  return ep ? `${ep.method} ${ep.path}` : entry.path;
}

function buildCard(p, state, lastEntry, api) {
  const card = document.createElement('article');
  card.className = 'port-card';
  card.dataset.port = String(p.port);
  card.dataset.enabled = String(p.enabled !== false);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `端口 ${p.port} 详情`);

  const eps = state.endpoints.filter((e) => e.port === p.port);
  const disabledCount = eps.filter((e) => e.enabled === false).length;
  const portStatus = state.runtimeStatus[String(p.port)];
  const ledState = portStatus?.state === 'failed' ? 'failed'
    : portStatus?.state === 'running' ? 'running' : 'stopped';

  const head = document.createElement('header');
  head.className = 'port-card-head';

  const num = document.createElement('span');
  num.className = 'port-card-number mono';
  num.textContent = `:${p.port}`;

  const led = document.createElement('span');
  led.className = 'led led-mini';
  led.dataset.state = ledState;

  const toggle = document.createElement('label');
  toggle.className = 'toggle port-card-toggle';
  toggle.addEventListener('click', (e) => e.stopPropagation());
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = p.enabled !== false;
  checkbox.setAttribute('aria-label', `启用端口 ${p.port}`);
  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    try {
      const updated = await api.updatePort(p.port, { enabled: checkbox.checked });
      Object.assign(p, updated);
      card.dataset.enabled = String(p.enabled !== false);
    } catch (e) {
      checkbox.checked = !checkbox.checked;
      alert('切换失败：' + (e?.message || '未知错误'));
    } finally {
      checkbox.disabled = false;
    }
  });
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'toggle-label';
  toggleLabel.textContent = '启用';
  toggle.append(checkbox, toggleLabel);

  head.append(num, led, toggle);

  const stats = document.createElement('dl');
  stats.className = 'port-card-stats';

  const epRow = document.createElement('div');
  const epDt = document.createElement('dt');
  epDt.textContent = '接口';
  const epDd = document.createElement('dd');
  epDd.textContent = disabledCount > 0
    ? `${eps.length} 个 · ${disabledCount} 个禁用`
    : `${eps.length} 个`;
  epRow.append(epDt, epDd);

  const lastRow = document.createElement('div');
  const lastDt = document.createElement('dt');
  lastDt.textContent = '最近请求';
  const lastDd = document.createElement('dd');
  lastDd.className = 'port-card-last';
  if (lastEntry) {
    const nameSpan = document.createElement('span');
    nameSpan.textContent = endpointLabel(lastEntry, state.endpoints);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'port-card-time';
    timeSpan.textContent = relativeTime(lastEntry.timestamp);
    lastDd.append(nameSpan, timeSpan);
  } else {
    lastDd.textContent = '—';
  }
  lastRow.append(lastDt, lastDd);

  stats.append(epRow, lastRow);
  card.append(head, stats);

  const open = () => navigate(`#/port/${p.port}`);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return card;
}

function buildNewCard() {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'port-card port-card-new';
  card.id = 'newPortCard';
  card.innerHTML = '<span class="plus">+</span><span>新建端口</span>';
  return card;
}

export function renderPortCards(state, { grid, countEl, api, onNewPort }) {
  grid.innerHTML = '';
  countEl.textContent = String(state.ports.length);
  if (state.ports.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'port-empty-hint';
    hint.textContent = '还没有端口。点击"+ 新建端口"创建第一个 mock 端口。';
    grid.appendChild(hint);
  }
  const latest = latestLogByPort(state.logs);
  for (const p of state.ports) {
    grid.appendChild(buildCard(p, state, latest.get(p.port), api));
  }
  const newCard = buildNewCard();
  newCard.addEventListener('click', onNewPort);
  grid.appendChild(newCard);
}

export function nextFreePort(ports, start = 8080) {
  const used = new Set(ports.map((p) => p.port));
  let port = start;
  while (used.has(port)) port++;
  return port;
}

export function initNewPortDialog({ els, state, api }) {
  const open = () => {
    els.newPortNumber.value = String(nextFreePort(state.ports));
    els.newPortError.hidden = true;
    els.newPortModal.hidden = false;
    els.newPortNumber.focus();
    els.newPortNumber.select();
  };
  const close = () => { els.newPortModal.hidden = true; };
  const fail = (msg) => {
    els.newPortError.textContent = msg;
    els.newPortError.hidden = false;
  };
  const submit = async () => {
    const port = Number(els.newPortNumber.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail('端口号必须是 1–65535 的整数');
    }
    if (state.ports.some((p) => p.port === port)) {
      return fail(`端口 ${port} 已存在`);
    }
    try {
      await api.createPort(port);
      state.ports = await api.listPorts();
      close();
      navigate(`#/port/${port}`);
    } catch (e) {
      fail(e?.message || '创建失败');
    }
  };

  els.newPortClose.addEventListener('click', close);
  els.newPortBackdrop.addEventListener('click', close);
  els.newPortCancel.addEventListener('click', close);
  els.newPortCreate.addEventListener('click', submit);
  els.newPortNumber.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  return { open, close };
}
```

说明：`#newPortCard` 是 `renderPortCards` 每次重渲染时重建的节点，所以它的点击事件在 `renderPortCards` 内通过 `onNewPort` 回调绑定（app.js 把 `newPortDialog.open` 传进去）；`initNewPortDialog` 只返回 `{ open, close }`，不自己绑卡片。

- [ ] **Step 2: index.html 加新建端口弹窗**

在 Settings dialog 之后插入：

```html
  <!-- New port dialog -->
  <div class="modal" id="newPortModal" hidden>
    <div class="modal-backdrop" id="newPortBackdrop"></div>
    <div class="modal-panel" role="dialog" aria-labelledby="newPortTitle" aria-modal="true">
      <div class="modal-header">
        <h2 class="section-label" id="newPortTitle">新建端口</h2>
        <button class="btn btn-icon" id="newPortClose" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="field field-wide">
          <label for="newPortNumber">端口号</label>
          <input type="number" id="newPortNumber" class="input mono" min="1" max="65535" />
          <p class="field-hint">1–65535 的整数，不能与现有端口重复。</p>
          <p class="field-hint field-error" id="newPortError" hidden></p>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="newPortCancel">取消</button>
        <button class="btn btn-primary" id="newPortCreate">创建</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: app.js 接线**

a) api 对象新增（替换 Task 5 的内联 fetch）：

```js
  async listPorts() { return (await fetch('/api/ports')).json(); },
  async createPort(port) {
    const r = await fetch('/api/ports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.message || '创建端口失败');
    return body;
  },
  async updatePort(port, body) {
    const r = await fetch(`/api/ports/${port}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await r.json();
    if (!r.ok) throw new Error(json.message || '更新端口失败');
    return json;
  },
  async deletePort(port) {
    const r = await fetch(`/api/ports/${port}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) throw new Error('删除端口失败');
  },
```

`loadAll()` 中 Task 5 的内联 fetch 改为 `state.ports = await api.listPorts();`。

b) 顶部 import：

```js
import { renderPortCards, initNewPortDialog } from './views/port-cards.js';
```

c) `els` 新增：

```js
  newPortModal: $('#newPortModal'),
  newPortBackdrop: $('#newPortBackdrop'),
  newPortClose: $('#newPortClose'),
  newPortCancel: $('#newPortCancel'),
  newPortCreate: $('#newPortCreate'),
  newPortNumber: $('#newPortNumber'),
  newPortError: $('#newPortError'),
```

d) 在 `applyRoute` 之后新增：

```js
function renderHome() {
  renderPortCards(state, {
    grid: els.portCardGrid,
    countEl: els.portCardCount,
    api,
    onNewPort: () => newPortDialog.open(),
  });
}
```

并在 boot 段 `startRouter(...)` 之前初始化：

```js
  const newPortDialog = initNewPortDialog({ els, state, api });
```

（`renderHome` 引用 `newPortDialog` —— 把 `newPortDialog` 提升为模块级 `let newPortDialog = null;`，boot 中赋值。）

e) `applyRoute` 中 home 分支补渲染：在 `if (!home && portKnown) {` 之前加：

```js
  if (home) renderHome();
```

f) `appendLog(entry)` 末尾追加：

```js
  if (state.route.view === 'home') renderHome();
```

g) `refreshRuntimeStatus()` 中 `renderEndpointList();` 之后追加：

```js
  if (state.route.view === 'home') renderHome();
```

- [ ] **Step 4: styles.css 卡片样式**

文件末尾追加：

```css
.port-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  padding: var(--s-4) var(--s-5);
  box-shadow: var(--shadow-panel);
  cursor: pointer;
  text-align: left;
  transition: transform var(--d-fast) ease, border-color var(--d-fast) ease;
}

.port-card:hover {
  transform: translateY(-2px);
  border-color: var(--border-bright);
}

.port-card:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 2px;
}

.port-card[data-enabled='false'] {
  opacity: 0.55;
}

.port-card-head {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}

.port-card-number {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.port-card-toggle {
  margin-left: auto;
}

.port-card-stats {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  margin: 0;
}

.port-card-stats > div {
  display: flex;
  justify-content: space-between;
  gap: var(--s-3);
}

.port-card-stats dt {
  color: var(--text-tertiary);
}

.port-card-stats dd {
  margin: 0;
  color: var(--text-secondary);
  text-align: right;
  overflow-wrap: anywhere;
}

.port-card-last {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.port-card-time {
  color: var(--text-faint);
  font-size: 12px;
}

.port-card-new {
  align-items: center;
  justify-content: center;
  min-height: 120px;
  border-style: dashed;
  background: transparent;
  box-shadow: none;
  color: var(--text-tertiary);
  font-size: 14px;
}

.port-card-new:hover {
  color: var(--text-primary);
}

.port-empty-hint {
  grid-column: 1 / -1;
  color: var(--text-tertiary);
  padding: var(--s-6);
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--r-3);
}

.field-error {
  color: var(--red);
}
```

- [ ] **Step 5: 写 E2E**

新建 `test/e2e/port-cards.spec.js`：

```js
import { test, expect } from '@playwright/test';
import { bootServer, hitMock } from './helpers.js';

let server;

test.beforeAll(async () => { server = await bootServer(); });
test.afterAll(async () => { if (server) await server.cleanup(); });

async function createPort(page, port) {
  return page.evaluate(async (p) => {
    const r = await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: p }),
    });
    return { status: r.status, body: await r.json() };
  }, port);
}

test('首页卡片展示端口、接口数与最近请求', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  expect((await createPort(page, 17101)).status).toBe(201);
  await page.evaluate(async () => {
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17101, method: 'GET', path: '/api/card', statusCode: 200, response: { ok: 1 } }),
    });
    await fetch('/api/runtime/start', { method: 'POST' });
  });
  await hitMock(17101, '/api/card');

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const card = page.locator('.port-card[data-port="17101"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.port-card-stats dd').first()).toHaveText('1 个');
  await expect(card.locator('.port-card-last')).toContainText('GET /api/card');
  await expect(card.locator('.led-mini')).toHaveAttribute('data-state', 'running');
});

test('弹窗新建端口并跳转详情页', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await page.click('#newPortCard');
  await expect(page.locator('#newPortModal')).toBeVisible();
  await page.fill('#newPortNumber', '17202');
  await page.click('#newPortCreate');

  await page.waitForSelector('#portHeader:not([hidden])');
  expect(page.url()).toContain('#/port/17202');
  await expect(page.locator('#portHeaderNumber')).toHaveText(':17202');
});

test('重复端口号在弹窗内报错', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  expect((await createPort(page, 17303)).status).toBe(201);

  await page.click('#newPortCard');
  await page.fill('#newPortNumber', '17303');
  await page.click('#newPortCreate');

  await expect(page.locator('#newPortError')).toBeVisible();
  await expect(page.locator('#newPortModal')).toBeVisible(); // 未跳转
});

test('卡片开关禁用端口后启动不绑定', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  expect((await createPort(page, 17404)).status).toBe(201);
  await page.evaluate(async () => {
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17404, method: 'GET', path: '/x', statusCode: 200, response: {} }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await page.locator('.port-card[data-port="17404"] input[type="checkbox"]').uncheck();
  await page.waitForTimeout(300);
  await expect(page.locator('.port-card[data-port="17404"]')).toHaveAttribute('data-enabled', 'false');

  const status = await page.evaluate(async () => {
    await fetch('/api/runtime/start', { method: 'POST' });
    return (await fetch('/api/runtime/status')).json();
  });
  expect(status['17404']).toBeUndefined();
});
```

- [ ] **Step 6: 跑测试验证**

Run: `pnpm test:e2e`（重点 port-cards.spec.js + 既有 spec 无回归）
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add public/ test/e2e/port-cards.spec.js
git commit -m "feat(ui): 首页端口卡片 + 新建端口弹窗"
```

---

### Task 7: 详情页端口操作 + name 字段 + 端口锁定 + 日志过滤

**Files:**
- Create: `public/views/port-detail.js`、`test/e2e/port-detail.spec.js`
- Modify: `public/index.html`、`public/app.js`、`public/styles.css`

**Interfaces:**
- Consumes: Task 5 的 `#portHeader`/路由；Task 6 的 `api.updatePort/deletePort/listPorts`
- Produces: 端口页头全部交互（启用开关、改号级联、删除连带）；端点表单 `name` 字段；端口输入框只读；日志按当前端口过滤

- [ ] **Step 1: 新建 public/views/port-detail.js**

```js
// 端口详情页：页头交互（启用开关 / 改号 / 删除端口）
import { navigate } from '../router.js';

export function renderPortHeader(state, els) {
  const p = state.ports.find((x) => x.port === state.route.port);
  if (!p) return;
  els.portHeaderNumber.textContent = `:${p.port}`;
  els.portEnabledToggle.checked = p.enabled !== false;
  els.portNumberInput.value = String(p.port);
  const st = state.runtimeStatus[String(p.port)];
  els.portStatusLed.dataset.state =
    st?.state === 'failed' ? 'failed' : st?.state === 'running' ? 'running' : 'stopped';
}

export function initPortDetail({ els, state, api, refreshAll }) {
  els.portEnabledToggle.addEventListener('change', async () => {
    const port = state.route.port;
    try {
      const updated = await api.updatePort(port, { enabled: els.portEnabledToggle.checked });
      const local = state.ports.find((p) => p.port === port);
      if (local) Object.assign(local, updated);
    } catch (e) {
      els.portEnabledToggle.checked = !els.portEnabledToggle.checked;
      alert('切换失败：' + (e?.message || '未知错误'));
    }
  });

  els.portRenameBtn.addEventListener('click', async () => {
    if (state.dirty && !confirm('有未保存的修改，改号将放弃这些修改。继续？')) return;
    state.dirty = false;
    const oldPort = state.route.port;
    const newPort = Number(els.portNumberInput.value);
    if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
      return alert('端口号必须是 1–65535 的整数');
    }
    if (newPort === oldPort) return;
    if (state.ports.some((p) => p.port === newPort)) {
      return alert(`端口 ${newPort} 已存在`);
    }
    try {
      await api.updatePort(oldPort, { port: newPort });
      await refreshAll(); // 重新拉 ports + endpoints（port 字段已级联变化）
      navigate(`#/port/${newPort}`);
    } catch (e) {
      alert('改号失败：' + (e?.message || '未知错误'));
    }
  });

  els.deletePortBtn.addEventListener('click', async () => {
    if (state.dirty && !confirm('有未保存的修改，删除端口将放弃这些修改。继续？')) return;
    state.dirty = false;
    const port = state.route.port;
    const count = state.endpoints.filter((e) => e.port === port).length;
    const msg = count > 0
      ? `确认删除端口 ${port}？将连同 ${count} 个接口一起删除。`
      : `确认删除端口 ${port}？`;
    if (!confirm(msg)) return;
    try {
      await api.deletePort(port);
      await refreshAll();
      navigate('#/');
    } catch (e) {
      alert('删除失败：' + (e?.message || '未知错误'));
    }
  });
}
```

- [ ] **Step 2: index.html 增加详情页控件与 name 字段**

a) `#portHeader` 内 `<div class="spacer"></div>` 之前插入：

```html
    <label class="toggle">
      <input type="checkbox" id="portEnabledToggle" />
      <span class="toggle-label">启用</span>
    </label>
    <span class="port-rename">
      <input type="number" id="portNumberInput" class="input mono port-rename-input" min="1" max="65535" />
      <button class="btn btn-ghost btn-sm" id="portRenameBtn">改号</button>
    </span>
    <button class="btn btn-danger btn-sm" id="deletePortBtn">删除端口</button>
```

b) 编辑器 form-grid 内，`method` 字段之前插入：

```html
          <div class="field field-wide">
            <label for="endpointName">接口名称</label>
            <input type="text" id="endpointName" class="input" maxlength="50" placeholder="可选，留空时列表显示 URL" autocomplete="off" />
          </div>
```

c) 端口输入框 `<input type="number" id="port" ...>` 加 `disabled` 属性，并把外层 div 加 class 提示只读：

```html
          <div class="field">
            <label for="port">端口</label>
            <input type="number" id="port" class="input mono" min="1" max="65535" disabled title="端口由端口详情页统一管理" />
          </div>
```

- [ ] **Step 3: app.js 接线**

a) `els` 新增：

```js
  portEnabledToggle: $('#portEnabledToggle'),
  portNumberInput: $('#portNumberInput'),
  portRenameBtn: $('#portRenameBtn'),
  deletePortBtn: $('#deletePortBtn'),
  endpointName: $('#endpointName'),
```

b) import 与初始化：

```js
import { renderPortHeader, initPortDetail } from './views/port-detail.js';
```

boot 段（`startRouter(...)` 之前）：

```js
  initPortDetail({ els, state, api, refreshAll });
```

新增 `refreshAll`（放在 `loadAll` 之后）：

```js
async function refreshAll() {
  state.ports = await api.listPorts();
  state.endpoints = await api.listEndpoints();
  if (!state.endpoints.some((e) => e.id === state.selectedId)) {
    state.selectedId = state.endpoints[0]?.id || null;
    state.dirty = false;
  }
  render();
  if (state.route.view === 'port') renderPortHeader(state, els);
}
```

c) `applyRoute` 的 `if (!home && portKnown) {` 分支内追加：

```js
    renderPortHeader(state, els);
```

（替代该分支里手写 portHeaderNumber/portStatusLed 的两行 —— 删掉 Task 5 写的那两行，统一走 renderPortHeader。）

d) `renderEndpointList()` 中列表项文案：把

```js
    li.querySelector('.endpoint-path').textContent = ep.path;
```

改为：

```js
    li.querySelector('.endpoint-path').textContent = ep.name || `${ep.method} ${ep.path}`;
```

e) `renderEditor()` 的 `if (!state.dirty) {` 分支内，`els.method.value = ep.method;` 之后加：

```js
    els.endpointName.value = ep.name || '';
```

`renderEditorForCreate(ep)` 同样位置加同一行。

f) `saveEndpoint()` 的 body 构造加 name：

```js
  const body = {
    method: els.method.value,
    port: Number(els.port.value),
    path: els.path.value.trim(),
    statusCode: Number(els.status.value) || 200,
    name: els.endpointName.value.trim() || undefined,
    response: (() => { const v = getValue(); return v ? JSON.parse(v) : null; })(),
    enabled: ep.enabled !== false,
  };
```

（`JSON.stringify` 会丢弃 undefined 的 name。）

g) `createEndpoint()`：删除"找未用端口"的逻辑，端口固定为当前路由端口。整个函数替换为：

```js
async function createEndpoint() {
  if (state.route.view !== 'port') return;
  const ep = await api.createEndpoint({
    method: 'GET',
    port: state.route.port,
    path: '/api/new',
    statusCode: 200,
    response: { ok: true },
    enabled: true,
  });
  state.endpoints.push(ep);
  state.selectedId = ep.id;
  renderEndpointList();
  renderEditorForCreate(ep);
}
```

h) 脏标记监听列表：`for (const f of [els.method, els.port, els.path, els.status])` 改为：

```js
for (const f of [els.method, els.endpointName, els.path, els.status]) {
  f.addEventListener('input', markDirty);
}
```

（els.port 已 disabled，移除。）

i) 日志按端口过滤。新增：

```js
function visibleLogs() {
  if (state.route.view === 'port') {
    return state.logs.filter((e) => e.port === state.route.port);
  }
  return state.logs;
}

function updateLogsCount() {
  const vis = visibleLogs();
  els.logsCount.textContent = state.route.view === 'port'
    ? `${vis.length} 条 / 共 ${state.logs.length} 条`
    : `${state.logs.length} 条 · 最多 500`;
}
```

`renderLogsInitial()` 改为遍历 `visibleLogs()`，末尾 `els.logsCount.textContent = ...` 换成 `updateLogsCount();`。

`appendLog(entry)` 改为：

```js
function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
  const isPortView = state.route.view === 'port';
  const matches = !isPortView || entry.port === state.route.port;
  if (matches) {
    const empty = els.logsBody.querySelector('.logs-empty');
    if (empty) empty.remove();
    els.logsBody.appendChild(renderLogEntry(entry));
    if (state.autoScroll) els.logsBody.scrollTop = els.logsBody.scrollHeight;
  }
  updateLogsCount();
  if (state.route.view === 'home') renderHome();
}
```

- [ ] **Step 4: styles.css 追加**

```css
.port-rename {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}

.port-rename-input {
  width: 90px;
  padding: var(--s-1) var(--s-2);
}

#port:disabled {
  color: var(--text-tertiary);
  cursor: not-allowed;
}
```

- [ ] **Step 5: 写 E2E**

新建 `test/e2e/port-detail.spec.js`：

```js
import { test, expect } from '@playwright/test';
import { bootServer, hitMock, enterPortDetail } from './helpers.js';

let server;

test.beforeAll(async () => { server = await bootServer(); });
test.afterAll(async () => { if (server) await server.cleanup(); });

async function setup(page, port, epPath = '/api/x') {
  await page.evaluate(async ({ port, epPath }) => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port, method: 'GET', path: epPath, statusCode: 200, response: { ok: 1 } }),
    });
  }, { port, epPath });
}

test('新建接口时端口字段只读且为当前端口', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17501);
  await enterPortDetail(page, server.baseURL, 17501);

  await page.click('#newEndpointBtn');
  await expect(page.locator('#port')).toBeDisabled();
  await expect(page.locator('#port')).toHaveValue('17501');
});

test('接口名称显示在列表，留空回落 URL', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17502);
  await enterPortDetail(page, server.baseURL, 17502);

  await page.locator('.endpoint-item').first().dispatchEvent('click');
  // 未填名称 → 显示 METHOD path
  await expect(page.locator('.endpoint-item .endpoint-path').first()).toHaveText('GET /api/x');

  await page.fill('#endpointName', '查询接口');
  await page.click('#saveBtn');
  await expect(page.locator('.endpoint-item .endpoint-path').first()).toHaveText('查询接口');

  // 清空名称 → 回落
  await page.fill('#endpointName', '');
  await page.click('#saveBtn');
  await expect(page.locator('.endpoint-item .endpoint-path').first()).toHaveText('GET /api/x');
});

test('详情页日志只显示本端口', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17503, '/a');
  await setup(page, 17504, '/b');
  await page.evaluate(async () => {
    await fetch('/api/runtime/start', { method: 'POST' });
  });
  await hitMock(17503, '/a');
  await hitMock(17504, '/b');

  await enterPortDetail(page, server.baseURL, 17503);
  const rows = page.locator('#logsBody .log-entry');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.log-port')).toHaveText('17503');
  await expect(page.locator('#logsCount')).toContainText('1 条 / 共 2 条');
});

test('改端口号级联更新接口并更新 hash', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17505);
  await enterPortDetail(page, server.baseURL, 17505);

  await page.fill('#portNumberInput', '17506');
  page.once('dialog', (d) => d.accept()); // 若有脏表单确认；无则无影响
  await page.click('#portRenameBtn');

  await page.waitForSelector('#portHeader:not([hidden])');
  expect(page.url()).toContain('#/port/17506');
  const ports = await page.evaluate(async () => (await fetch('/api/ports')).json());
  expect(ports.map((p) => p.port)).toContain(17506);
  const eps = await page.evaluate(async () => (await fetch('/api/endpoints')).json());
  expect(eps.every((e) => e.port === 17506)).toBe(true);
});

test('删除端口连带删除接口并回到首页', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17507);
  await enterPortDetail(page, server.baseURL, 17507);

  page.once('dialog', (d) => {
    expect(d.message()).toContain('1 个接口');
    d.accept();
  });
  await page.click('#deletePortBtn');

  await page.waitForSelector('#viewHome:not([hidden])');
  const ports = await page.evaluate(async () => (await fetch('/api/ports')).json());
  expect(ports.map((p) => p.port)).not.toContain(17507);
  const eps = await page.evaluate(async () => (await fetch('/api/endpoints')).json());
  expect(eps.filter((e) => e.port === 17507)).toHaveLength(0);
});
```

- [ ] **Step 6: 跑测试验证**

Run: `pnpm test:e2e`
Expected: 全部 PASS（含既有 spec 无回归）

Run: `pnpm vitest run`
Expected: PASS（前端改动不影响后端测试）

- [ ] **Step 7: 提交**

```bash
git add public/ test/e2e/port-detail.spec.js
git commit -m "feat(ui): 详情页端口操作、接口名称字段、端口锁定与日志过滤"
```

---

### Task 8: embed-assets 同步 + CLAUDE.md 更新 + 全量回归

**Files:**
- Modify: `embed-assets/public/*`（同步）、`CLAUDE.md`

**Interfaces:**
- Consumes: Task 1–7 的全部产物
- Produces: 编译产物输入与源码一致；项目文档与架构一致；全量测试绿色

- [ ] **Step 1: 同步 embed-assets**

```bash
rsync -a --delete public/ embed-assets/public/
git status --short embed-assets/   # 确认只有预期文件变化
```

- [ ] **Step 2: 更新 CLAUDE.md**

a) "模块职责（核心）"表格追加一行：

```markdown
| `src/api-ports.js` | `/api/ports` CRUD（端口一等实体） | `registerPortRoutes(app, {configStore})`；改号级联 endpoints；删除连带 endpoints |
```

b) "前端（零构建）"小节更新为：

```markdown
- `public/index.html` — import map 引入 CodeMirror；body 网格双视图（首页卡片区 / 详情页）。
- `public/app.js` — `api` 客户端 + `state` 单例 + 详情页渲染层 + 路由接线。无框架。
- `public/router.js` — hash 路由（`#/` 首页，`#/port/<port>` 详情）。
- `public/views/port-cards.js` — 首页端口卡片渲染 + 新建端口弹窗。
- `public/views/port-detail.js` — 详情页端口页头交互（启用/改号/删除）。
- `public/editor.js` — CodeMirror 6 bootstrap（lang-json + lint + commands）。
- `public/styles.css` — Mission Bridge 视觉方向。
```

c) "全局状态键"追加：`ports / route`。

d) "关键不变量"追加两条：

```markdown
6. **端口一等实体**：`data.json` v2 含 `ports: [{port, enabled}]`；v1 数据加载时自动迁移。禁用端口不随启动绑定；空端口绑定后全返回 404。
7. **端点自动补建端口**：`POST/PUT /api/endpoints` 引用未知端口时自动创建 `{port, enabled: true}`，保证不存在"有接口但端口实体缺失"的状态。
```

- [ ] **Step 3: 格式化**

```bash
pnpm format
git diff --stat   # 确认格式化只动了本次改过的文件
```

- [ ] **Step 4: 全量回归**

Run: `pnpm test`
Expected: PASS（unit + integration 全绿）

Run: `pnpm test:e2e`
Expected: PASS（headed，不要切 headless）

- [ ] **Step 5: 手工冒烟（可选但建议）**

```bash
pnpm start
```

浏览器验证：首页卡片 → 新建端口弹窗 → 详情页新建接口（端口只读）→ 填名称 → 首页卡片"最近请求"更新 → 禁用端口 → 启动验证不绑定 → 改号 → 删端口。

- [ ] **Step 6: 提交**

```bash
git add embed-assets/ CLAUDE.md
git commit -m "chore(embed): 同步 public/ → embed-assets/，更新架构文档"
```

---

## Self-Review 结果

**Spec 覆盖检查**（逐条对应）：

| Spec 条目 | 任务 |
|---|---|
| §3 数据模型 v2 + 迁移 + name 规则 | Task 1、Task 2 |
| §4.1 /api/ports CRUD | Task 3 |
| §4.2 name 校验 + 自动补建端口 | Task 2、Task 3 |
| §4.3 运行时只绑定启用端口 | Task 4 |
| §4.4 卡片统计前端聚合 | Task 6（latestLogByPort） |
| §5.1 文件拆分 + hash 路由 | Task 5 |
| §5.2 首页卡片 / 新建弹窗 / 开关 / 最近请求 | Task 6 |
| §5.3 详情页页头 / 改号 / 删除 / name / 端口锁定 / 日志过滤 | Task 7 |
| §5.4 视觉延续既有 token | Task 6/7 的 CSS 均用既有变量 |
| §6 测试计划 | 每个任务的 TDD 步骤 + Task 5 Step 6 存量 E2E 调整 |
| §7 embed-assets 同步 | Task 8 |

**已修复的规划缺口**：
1. 端点引用未知端口时自动补建端口实体（否则运行时静默跳过，违反"大声失败"）——已同步写入 spec §4.2 与 Task 3。
2. 改号/删端口前增加脏表单守卫（否则进行中的导航确认与已完成的配置变更会错位）——已写入 Task 7。

**与 spec 的微小偏差（已确认更优）**：spec §5.2 写"SSE 日志到达时只重渲染对应卡片的那一行"；实现采用 `renderHome()` 整体重渲染卡片区（卡片数量少，行为等价、代码更简单）。
