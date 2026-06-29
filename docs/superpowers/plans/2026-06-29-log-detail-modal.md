# 请求详情弹窗 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 mock-server-webui 请求日志面板点击行 → 弹窗显示该请求的请求头、查询参数、请求体；请求体取消 2048 字节截断，由 Settings 面板的 `maxBodyBytes` 配置上限（默认 4 MiB，无硬上限）。

**Architecture:** 详情数据全部已在 `state.logs` 内存里（`requestHeaders` / `query` / `requestBodyPreview`），点击 → 同步渲染到原生 `<dialog>` 模态，不发新 API。Body viewer 复用 `editor.js` 的 CodeMirror 6 实例，加 `EditorState.readOnly.of(true)`。Body 截断逻辑从 mock-engine 移到 `readBody(req, maxBytes)`，maxBytes 在每次请求时从 `configStore.config.settings.maxBodyBytes ?? 4 * 1024 * 1024` 读，实时生效。

**Tech Stack:** Node ≥18 · 原生 ESM（无 TS）· Express 4 · 原生 `node:http`（mock 引擎）· CodeMirror 6（ESM via importmap）· vitest + supertest（已有）· Playwright headed（已有）

## 文件总览

**新建**：
- `test/e2e/log-detail-modal.spec.js` — 端到端测试

**修改**：
- `src/mock-engine.js` — `readBody` 改造（不再截断、加 truncated 标记）+ 构造函数接收 `configStore` + log entry 加 `requestBodyTruncated` 字段
- `src/config-store.js` — `load()` 默认值加 `maxBodyBytes: 4 * 1024 * 1024`
- `src/api.js` — `PATCH /api/config` 加 `maxBodyBytes` 处理 + 校验
- `server.js` — 删除 `MOCK_MAX_BODY_PREVIEW` 环境变量；`new MockEngine({ logBuffer, bindHost, configStore })`
- `public/editor.js` — 新增 `mountReadonlyEditor(parent, text)` 工厂
- `public/index.html` — 加 `<dialog id="log-detail">` 结构 + Settings 弹窗加 `maxBodyBytes` input
- `public/app.js` — `renderLogEntry` click handler + `openLogDetail` / `closeLogDetail` / `renderLogDetail` + Settings 加 `maxBodyBytes` 处理
- `public/styles.css` — `.log-entry:hover` + `dialog.log-detail` + 表格样式
- `embed-assets/public/{index.html,app.js,editor.js,styles.css}` — 镜像 public/
- `test/unit/mock-engine.test.js` — 加 truncated / configStore 兜底用例
- `test/integration/api-config.test.js` — 加 `maxBodyBytes` 校验用例
- `test/integration/api-logs.test.js` — 加 `requestBodyTruncated` 字段验证
- `CLAUDE.md` — 删 `MOCK_MAX_BODY_PREVIEW` 文档

## Global Constraints

- Node ≥18，ESM 原生（package.json `"type": "module"`）
- 改 `public/` 任一文件 → 必须镜像到 `embed-assets/public/`（Bun 打包根，dev 与 packaged 一致性）
- TDD：每任务「先写失败测试 → 最小实现 → 测试通过 → 提交」
- 所有公共 API 用 JSDoc 标注类型；不可变更新；不写 `console.log`（生产代码）
- E2E 保持 `headless: false` + `slowMo: 50`（`playwright.config.js` 已固定）
- 提交格式：`<type>(scope): <subject>`（feat / fix / test / chore / docs）
- 提交消息用简体中文（项目约定）
- 错误经 `src/errors.js` 的 `AppError` / `toErrorResponse` / `statusFor` 信封
- 命名：函数 `camelCase`，常量 `SCREAMING_SNAKE_CASE`

---

## Task 1: mock-engine 数据层（readBody 改造 + entry 字段 + configStore 兜底）

**Files:**
- Modify: `src/mock-engine.js:5`（删除 `DEFAULT_MAX_BODY_PREVIEW`） + `:17-30`（重写 `readBody`） + `:32-39`（构造函数加 `configStore`） + `:60`（调用新 readBody） + `:88-105`（log entry 加 `requestBodyTruncated`）
- Modify: `src/config-store.js:42-46`（load 默认值加 `maxBodyBytes`）
- Modify: `test/unit/mock-engine.test.js`（加 4 个新用例）

**Interfaces（被本任务定义，下游消费方）：**
```js
// src/mock-engine.js exports:
class MockEngine {
  constructor({ logBuffer, bindHost?, configStore? })  // configStore 可选；缺则兜底 4MB
  async start(endpoints)
  async stop()
  getStatus()
}

// log entry (pushed to logBuffer) 加一个字段：
//   requestBodyTruncated: boolean  (true = body 超过配置上限，已停止累积)

// src/config-store.js default settings:
//   { storagePath, uiPort: 5050, maxBodyBytes: 4 * 1024 * 1024 }
```

### Step 1: 写失败测试

`test/unit/mock-engine.test.js` 末尾追加：

```js
describe('MockEngine body capture and truncation', () => {
  function postWith(port, path, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  function makeConfigStore(maxBodyBytes) {
    return { config: { settings: { maxBodyBytes } } };
  }

  it('captures full body below limit and marks requestBodyTruncated=false', async () => {
    const cs = makeConfigStore(4 * 1024 * 1024);
    engine = new MockEngine({ logBuffer, configStore: cs });
    await engine.start([
      { id: 'a', port: 19001, method: 'POST', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await postWith(19001, '/x', 'hello world');
    expect(pushedLogs).toHaveLength(1);
    expect(pushedLogs[0].requestBodyPreview).toBe('hello world');
    expect(pushedLogs[0].requestBodyTruncated).toBe(false);
  });

  it('truncates body above limit and marks requestBodyTruncated=true', async () => {
    const cs = makeConfigStore(10);
    engine = new MockEngine({ logBuffer, configStore: cs });
    await engine.start([
      { id: 'a', port: 19002, method: 'POST', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    const big = 'x'.repeat(100);
    await postWith(19002, '/x', big);
    expect(pushedLogs[0].requestBodyPreview).toBe('x'.repeat(10));
    expect(pushedLogs[0].requestBodyTruncated).toBe(true);
  });

  it('GET request with no body has empty preview and truncated=false', async () => {
    const cs = makeConfigStore(100);
    engine = new MockEngine({ logBuffer, configStore: cs });
    await engine.start([
      { id: 'a', port: 19003, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await get(19003, '/x');
    expect(pushedLogs[0].requestBodyPreview).toBe('');
    expect(pushedLogs[0].requestBodyTruncated).toBe(false);
  });

  it('falls back to 4 MiB when configStore is missing or settings.maxBodyBytes undefined', async () => {
    engine = new MockEngine({ logBuffer, configStore: { config: { settings: {} } } });
    await engine.start([
      { id: 'a', port: 19004, method: 'POST', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    // 1 KB body — well under 4 MiB fallback
    await postWith(19004, '/x', 'y'.repeat(1024));
    expect(pushedLogs[0].requestBodyPreview).toHaveLength(1024);
    expect(pushedLogs[0].requestBodyTruncated).toBe(false);
  });

  it('reads fresh maxBodyBytes on each request (no caching)', async () => {
    const cs = { config: { settings: { maxBodyBytes: 5 } } };
    engine = new MockEngine({ logBuffer, configStore: cs });
    await engine.start([
      { id: 'a', port: 19005, method: 'POST', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await postWith(19005, '/x', 'aaaaaa');
    expect(pushedLogs[0].requestBodyTruncated).toBe(true);

    // User updates setting live
    cs.config.settings.maxBodyBytes = 1000;
    pushedLogs = [];
    await postWith(19005, '/x', 'bbbbbb');
    expect(pushedLogs[0].requestBodyTruncated).toBe(false);
  });
});
```

### Step 2: 跑测试确认失败

Run:
```bash
pnpm vitest run test/unit/mock-engine.test.js
```

Expected: 4 个新 describe 内的 it 全部失败（"requestBodyPreview is undefined" / "requestBodyTruncated is undefined"）。

### Step 3: 实现 mock-engine 改造

`src/mock-engine.js` 全文替换为：

```js
import http from 'node:http';
import crypto from 'node:crypto';
import { resolve } from './expression-resolver.js';

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Read the request body up to maxBytes. Once the cumulative size exceeds
 * maxBytes, further chunks are dropped (and `truncated` is set to true).
 * Always resolves; never rejects.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ body: string, truncated: boolean }>}
 */
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0;
    let truncated = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        truncated = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated });
    });
    req.on('error', () => resolve({ body: '', truncated: false }));
  });
}

export class MockEngine {
  /**
   * @param {object} opts
   * @param {{ push: (e: object) => void }} opts.logBuffer
   * @param {string} [opts.bindHost='127.0.0.1']
   * @param {{ config: { settings: { maxBodyBytes?: number } } }} [opts.configStore]
   */
  constructor({ logBuffer, bindHost = '127.0.0.1', configStore }) {
    this.logBuffer = logBuffer;
    this.bindHost = bindHost;
    this.configStore = configStore;
    this.servers = new Map();
    this.statuses = new Map();
  }

  async start(endpoints) {
    const byPort = new Map();
    for (const e of endpoints) {
      if (!byPort.has(e.port)) byPort.set(e.port, []);
      byPort.get(e.port).push(e);
    }

    await this.stop();

    const running = [];
    const failed = [];

    for (const [port, eps] of byPort.entries()) {
      const router = buildRouter(eps);
      const server = http.createServer(async (req, res) => {
        const start = Date.now();
        const url = req.url || '/';
        const [pathOnly, queryStr = ''] = url.split('?');
        const matched = router.get(`${port}|${req.method}|${pathOnly}`);

        const max = this.configStore?.config?.settings?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        const { body, truncated } = await readBody(req, max);

        if (matched) {
          res.statusCode = matched.statusCode || 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          let responseBody;
          try {
            const { value } = resolve(matched.response);
            responseBody = JSON.stringify(value);
          } catch (err) {
            this.logBuffer?.push({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              level: 'warn',
              source: 'resolver',
              message: `resolver failed: ${err.message}`,
              endpointId: matched.id,
            });
            responseBody = JSON.stringify(matched.response ?? null);
          }
          res.end(responseBody);
        } else {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: `no mock for ${req.method} ${pathOnly}` }));
        }

        this.logBuffer?.push({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          method: req.method,
          path: pathOnly,
          query: queryStr,
          port,
          status: res.statusCode,
          durationMs: Date.now() - start,
          matched: !!matched,
          endpointId: matched?.id || null,
          requestHeaders: req.headers,
          requestBodyPreview: body,
          requestBodyTruncated: truncated,
          ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
              || req.socket.remoteAddress
              || '',
        });
      });

      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
          const onListening = () => { server.removeListener('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, this.bindHost);
        });
        this.servers.set(port, { server, router });
        this.statuses.set(port, { state: 'running' });
        running.push({ port });
      } catch (e) {
        this.statuses.set(port, { state: 'failed', reason: e.code || 'EADDRINUSE' });
        failed.push({ port, reason: e.code || 'EADDRINUSE' });
        try { server.close(); } catch {}
      }
    }

    return { running, failed };
  }

  async stop() {
    const promises = [];
    for (const { server } of this.servers.values()) {
      promises.push(new Promise((resolve) => server.close(() => resolve())));
    }
    await Promise.all(promises);
    this.servers.clear();
    for (const port of this.statuses.keys()) {
      this.statuses.set(port, { state: 'stopped' });
    }
  }

  getStatus() {
    const out = {};
    for (const [port, s] of this.statuses.entries()) {
      out[port] = { ...s };
    }
    return out;
  }
}

function buildRouter(endpoints) {
  const map = new Map();
  for (const e of endpoints) {
    if (e.enabled === false) continue;
    const key = `${e.port}|${e.method}|${e.path}`;
    map.set(key, e);
  }
  return map;
}
```

> 注意：把 `buildRouter` 移到文件底部（避免函数前置定义时和 `MockEngine` 形成 hoist 依赖混乱）。

### Step 4: ConfigStore 默认值

`src/config-store.js:42-46`：

```js
      this.config = {
        version: 1,
        settings: { storagePath: this.storagePath, uiPort: 5050, maxBodyBytes: 4 * 1024 * 1024 },
        endpoints: [],
      };
```

### Step 5: 跑测试确认通过

Run:
```bash
pnpm vitest run test/unit/mock-engine.test.js test/unit/config-store.test.js
```

Expected: 全部通过。

### Step 6: 跑全量单测确认无回归

Run:
```bash
pnpm vitest run
```

Expected: 全部通过。

### Step 7: 提交

```bash
git add src/mock-engine.js src/config-store.js test/unit/mock-engine.test.js
git commit -m "feat(mock-engine): 取消请求体 2KB 截断，按 settings.maxBodyBytes 限制

- readBody 改造：累积字节数超过上限时停止累积，标记 truncated
- MockEngine 构造函数接收 configStore，每次请求读最新 maxBodyBytes
- log entry 新增 requestBodyTruncated 字段
- ConfigStore load() 默认值加 maxBodyBytes: 4 MiB
- 老 data.json 缺 maxBodyBytes 时由 mock-engine ?? 兜底，不主动写回"
```

---

## Task 2: api.js PATCH /api/config 校验 maxBodyBytes

**Files:**
- Modify: `src/api.js:35-75`（`createApi` 内 PATCH handler）
- Modify: `test/integration/api-config.test.js`（加 maxBodyBytes 校验用例）

**Interfaces（被本任务定义，下游消费方）：**
```js
// PATCH /api/config body:
//   { settings: { uiPort?, storagePath?, maxBodyBytes? } }
// 校验：maxBodyBytes 必须是正整数（Number.isInteger && > 0）
// 错误：400 + code 'INVALID_VALUE' + message 'maxBodyBytes must be a positive integer'
```

### Step 1: 写失败测试

打开 `test/integration/api-config.test.js`，在合适位置追加：

```js
describe('PATCH /api/config — maxBodyBytes', () => {
  it('accepts a positive integer and persists it', async () => {
    const { request } = buildApp({ storagePath: tmp, configStore, logBuffer, mockEngine });
    const r = await request
      .patch('/api/config')
      .send({ settings: { maxBodyBytes: 1024 * 1024 } });
    expect(r.status).toBe(200);
    expect(r.body.settings.maxBodyBytes).toBe(1024 * 1024);

    // 重新读取 configStore 也应看到
    expect(configStore.config.settings.maxBodyBytes).toBe(1024 * 1024);
  });

  it('rejects zero, negative, and non-integer values with 400 INVALID_VALUE', async () => {
    const { request } = buildApp({ storagePath: tmp, configStore, logBuffer, mockEngine });
    for (const bad of [0, -1, 1.5, NaN, 'lots', null, [], {}]) {
      const r = await request
        .patch('/api/config')
        .send({ settings: { maxBodyBytes: bad } });
      expect(r.status, `value ${JSON.stringify(bad)}`).toBe(400);
      expect(r.body.error?.code ?? r.body.code, `value ${JSON.stringify(bad)}`).toBe('INVALID_VALUE');
    }
  });

  it('omitting maxBodyBytes leaves existing value intact', async () => {
    configStore.config.settings.maxBodyBytes = 7777;
    const { request } = buildApp({ storagePath: tmp, configStore, logBuffer, mockEngine });
    const r = await request.patch('/api/config').send({ settings: { uiPort: 6060 } });
    expect(r.status).toBe(200);
    expect(r.body.settings.maxBodyBytes).toBe(7777);
    expect(r.body.settings.uiPort).toBe(6060);
  });
});
```

（如果 `test/integration/api-config.test.js` 顶部 import / setup 与示例不同，按现有风格补全 `beforeEach` 中的 `tmp` / `configStore` / `logBuffer` / `mockEngine` 创建。）

### Step 2: 跑测试确认失败

Run:
```bash
pnpm vitest run test/integration/api-config.test.js
```

Expected: 新加的 3 个 it 全部失败（response 缺少 maxBodyBytes，或不返回 400）。

### Step 3: 实现 PATCH 校验

`src/api.js:35-75` 替换为：

```js
export function createApi({ configStore, logBuffer, mockEngine }) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const sse = sseMiddleware();
  if (logBuffer && typeof logBuffer.subscribe === 'function') {
    logBuffer.subscribe((entry) => broadcast(sse.clients, 'log', entry));
  }

  // Health
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // SSE
  app.get('/events', (req, res) => sse.handler(req, res));

  // Config
  app.get('/api/config', (_req, res) => res.json(configStore.config));

  app.patch('/api/config', async (req, res, next) => {
    try {
      const { settings = {} } = req.body || {};
      if (settings.maxBodyBytes !== undefined) {
        if (!Number.isInteger(settings.maxBodyBytes) || settings.maxBodyBytes < 1) {
          throw new AppError(400, 'INVALID_VALUE', 'maxBodyBytes must be a positive integer');
        }
      }
      if (settings.storagePath !== undefined) {
        if (!isValidStoragePath(settings.storagePath)) {
          throw new AppError(400, 'INVALID_PATH', 'storagePath must be an absolute path');
        }
        const oldFile = `${configStore.storagePath}/data.json`;
        const newDir = settings.storagePath;
        await fs.mkdir(newDir, { recursive: true });
        try { await fs.copyFile(oldFile, `${newDir}/data.json`); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        try { await fs.unlink(oldFile); } catch {}
        configStore.storagePath = newDir;
      }
      await configStore.update((cfg) => {
        if (settings.uiPort !== undefined) cfg.settings.uiPort = settings.uiPort;
        if (settings.storagePath !== undefined) cfg.settings.storagePath = settings.storagePath;
        if (settings.maxBodyBytes !== undefined) cfg.settings.maxBodyBytes = settings.maxBodyBytes;
        return cfg;
      });
      res.json(configStore.config);
    } catch (e) { next(e); }
  });

  // ... 其余 CRUD/runtime/logs 路由保持不变

  // Error handler (must be last in createApi so API errors are formatted)
  app.use((err, _req, res, _next) => {
    res.status(statusFor(err)).json(toErrorResponse(err));
  });

  return app;
}
```

### Step 4: 跑测试确认通过

Run:
```bash
pnpm vitest run test/integration/api-config.test.js
```

Expected: 全部通过。

### Step 5: 跑全量集成测试确认无回归

Run:
```bash
pnpm vitest run
```

Expected: 全部通过。

### Step 6: 提交

```bash
git add src/api.js test/integration/api-config.test.js
git commit -m "feat(api): PATCH /api/config 校验 maxBodyBytes 必须为正整数

拒绝 0 / 负数 / 非整数 / 字符串。错误信封 400 INVALID_VALUE。"
```

---

## Task 3: server.js 集成 + 删除 MOCK_MAX_BODY_PREVIEW 环境变量

**Files:**
- Modify: `server.js:40-41`（删除 `maxBodyPreview` 解析 + 改 MockEngine 入参）
- Modify: `CLAUDE.md`（删除 `MOCK_MAX_BODY_PREVIEW` 文档）

### Step 1: 改 server.js

`server.js:40-41`：

```js
  // MockEngine reads maxBodyBytes dynamically from configStore on every request
  const mockEngine = new MockEngine({ logBuffer, bindHost: finalHost, configStore });
```

### Step 2: 跑全量测试确认无回归

Run:
```bash
pnpm vitest run
pnpm vitest run test/integration/server-startup.test.js
```

Expected: 全部通过。`server-startup.test.js` 启动真实 server，应能看到 mock engine 正常工作。

### Step 3: 改 CLAUDE.md

`CLAUDE.md` 中"环境变量"一节，删除 `MOCK_MAX_BODY_PREVIEW` 这一行：

```diff
 **环境变量**（`server.js` 接受）：
-- `MOCK_HOST` — bind host（默认 `127.0.0.1`，LAN 访问用 `0.0.0.0`）
-- `MOCK_SERVER_DIR` — 编译产物的资源根目录（`launcher.js` 自动注入；dev 不需要）
- `MOCK_MAX_BODY_PREVIEW` — 请求体预览最大字节数（默认 2048）
```

### Step 4: 跑 server-startup E2E 模拟

Run:
```bash
pnpm start &
SERVER_PID=$!
sleep 2
curl -s http://127.0.0.1:5050/api/config | head -c 200
kill $SERVER_PID
```

Expected: 启动成功，config 返回含 `maxBodyBytes: 4194304`。

### Step 5: 提交

```bash
git add server.js CLAUDE.md
git commit -m "refactor(server): 删除 MOCK_MAX_BODY_PREVIEW 环境变量

请求体大小上限改为运行时配置（settings.maxBodyBytes），由 Settings 面板管理。"
```

---

## Task 4: editor.js 暴露 mountReadonlyEditor

**Files:**
- Modify: `public/editor.js`（追加 `mountReadonlyEditor` 工厂）

**Interfaces（被本任务定义，下游消费方）：**
```js
// public/editor.js exports (在 window 上暴露给 app.js):
window.mountReadonlyEditor(parent: HTMLElement, text: string): EditorView
//   - 创建只读 CodeMirror 实例，lang-json 语法高亮
//   - 主题与现有 mountEditor 一致
//   - 返回 EditorView 实例供调用方 destroy
```

### Step 1: 读现有 editor.js

Read: `public/editor.js`

找到现有 `mountEditor` 函数（接收 `{ initialValue, onChange, onSelectionChange }`），记下它的 `EditorState.create({ doc, extensions: [basicSetup, json(), EditorView.theme(...)] })` 部分。新函数复用同样的 `basicSetup` + `json()` + 主题，但**去掉 onChange，加 readOnly**。

### Step 2: 实现 mountReadonlyEditor

在 `public/editor.js` 末尾追加：

```js
// Read-only viewer for log detail body. Same theme + lang-json as mountEditor,
// but no onChange and editable=false. Caller is responsible for .destroy().
export function mountReadonlyEditor(parent, text) {
  const state = EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      json(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      // 主题与 mountEditor 一致——避免不一致的视觉
      EditorView.theme({}, { dark: true }),
    ],
  });
  return new EditorView({ state, parent });
}

window.mountReadonlyEditor = mountReadonlyEditor;
```

> **重要**：用 `EditorView.editable.of(false)` + `EditorState.readOnly.of(true)` 双保险（CM 6 文档建议两者并用）。`EditorView.theme({}, { dark: true })` 的 `dark: true` 参数与项目现有 mountEditor 保持一致（如果项目用的是其他 dark mode 标记，按 mountEditor 实际写法调整）。

### Step 3: 写 E2E 冒烟测试（在最终 E2E 文件里覆盖）

E2E 验证：`window.mountReadonlyEditor` 存在、返回的 `EditorView` 渲染到指定 parent。这一步在 Task 8 的 E2E 文件中执行。

### Step 4: 提交

```bash
git add public/editor.js
git commit -m "feat(editor): 暴露 mountReadonlyEditor 工厂用于 body viewer

复用 basicSetup + lang-json，加 EditorState.readOnly.of(true) 双保险。
调用方负责 destroy() 释放内存。"
```

---

## Task 5: Settings 面板加 maxBodyBytes

**Files:**
- Modify: `public/index.html`（Settings 弹窗加 input + 提示行）
- Modify: `public/app.js`（`openSettings` / `saveSettings` 加 maxBodyBytes 处理 + 新增 `formatBytes` 工具）
- Modify: `public/styles.css`（`.settings-hint` 样式）

**Interfaces（被本任务定义，下游消费方）：**
```js
// public/app.js:
//   els.maxBody              (HTMLInputElement)
//   els.maxBodyHint          (HTMLElement)
//   formatBytes(n) → "X.X KB" / "X.X MB" / "X.XX GB"
//   openSettings() 填充 maxBody 字段 + 监听 input 更新 hint
//   saveSettings() 校验 + 提交 maxBodyBytes，根据 storagePath/uiPort 是否变了决定 flash 文案
```

### Step 1: HTML — Settings 弹窗加 input

在 `public/index.html` 的 Settings 弹窗里（找 `<label for="settingsStoragePath">` 之类的位置），追加：

```html
<div class="settings-row">
  <label for="settingsMaxBody">请求体大小上限 (bytes)</label>
  <input id="settingsMaxBody" type="number" min="1" step="1" />
  <span class="settings-hint" id="settingsMaxBodyHint">4.0 MB</span>
  <p class="settings-help">mock 引擎接收请求时按此上限截断请求体。设为 1 MB 适合开发调试，更大适合文件上传场景。无固定上限，填多少就是多少。</p>
</div>
```

### Step 2: CSS — settings-hint 样式

`public/styles.css` 末尾追加：

```css
.settings-hint { color: var(--text-dim); font-size: 12px; margin-left: 8px; }
.settings-help { color: var(--text-dim); font-size: 11px; margin: 4px 0 0; line-height: 1.4; }
```

### Step 3: app.js — openSettings / saveSettings / formatBytes

读 `public/app.js`，找到 `els` 引用声明块（顶部），追加：

```js
els.maxBody = document.querySelector('#settingsMaxBody');
els.maxBodyHint = document.querySelector('#settingsMaxBodyHint');
```

找到 `openSettings` 函数（line 488 附近），在 `els.uiPort.value = ...` 行后追加：

```js
els.maxBody.value = state.config.settings.maxBodyBytes ?? 4194304;
els.maxBodyHint.textContent = formatBytes(Number(els.maxBody.value));
```

`input` 事件监听**不能放这里**（每次开 Settings 都会重复挂）。在 boot / 事件绑定区（找 `els.settingsSave.addEventListener('click', saveSettings);` 附近）一次性挂上：

```js
els.maxBody.addEventListener('input', () => {
  els.maxBodyHint.textContent = formatBytes(Number(els.maxBody.value)) || '—';
});
```

把现有 `saveSettings` 函数替换为：

```js
async function saveSettings() {
  const newMax = Number(els.maxBody.value);
  if (!Number.isInteger(newMax) || newMax < 1) {
    flash('请求体大小上限必须是正整数', 'red');
    return;
  }
  const newStoragePath = els.storagePath.value.trim();
  const newUiPort = Number(els.uiPort.value);
  const needsRestart =
    newStoragePath !== state.config.settings.storagePath ||
    newUiPort !== state.config.settings.uiPort;
  await api.patchConfig({
    storagePath: newStoragePath,
    uiPort: newUiPort,
    maxBodyBytes: newMax,
  });
  state.config = await api.getConfig();
  closeSettings();
  flash(needsRestart ? '已保存 · 重启后生效' : '已保存 · 立即生效', 'green');
}
```

在文件顶部 helpers 区（找 `formatJSON` 附近）追加：

```js
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 1) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
```

### Step 4: 跑 E2E 验证（Task 8 完整覆盖）

提交后由 Task 8 E2E 文件 `log-detail-modal.spec.js` 验证。

### Step 5: 提交

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(ui): Settings 面板加 maxBodyBytes 输入

- 数字输入 + 实时 hint 显示 KB/MB/GB
- 保存时区分 storagePath/uiPort（需重启）与 maxBodyBytes（立即生效）
- 新增 formatBytes 工具函数"
```

---

## Task 6: log-detail dialog（结构 + 样式 + 点击交互 + 渲染逻辑）

**Files:**
- Modify: `public/index.html`（`</body>` 前加 `<dialog id="log-detail">`）
- Modify: `public/styles.css`（`.log-entry:hover` + `dialog.log-detail` + 表格）
- Modify: `public/app.js`（`renderLogEntry` click handler + `openLogDetail` / `closeLogDetail` / `renderLogDetail` + 事件绑定 + 元素引用 + 状态变量）

**Interfaces（被本任务定义，下游消费方）：**
```js
// public/app.js:
els.logDetail, els.logDetailMethod, els.logDetailPath, els.logDetailStatus,
els.logDetailClose, els.logDetailMeta, els.logDetailQueryTable, els.logDetailQueryEmpty,
els.logDetailHeadersTable, els.logDetailHeadersEmpty,
els.logDetailBodyWarning, els.logDetailBody, els.logDetailBodyPlain, els.logDetailEmpty
let logDetailCM = null;

function openLogDetail(id)   // 同步：state.logs.find + render + showModal
function closeLogDetail()    // dialog.close + destroy CM
function renderLogDetail(e)  // 4 sections + body 解析/CodeMirror/纯文本 分流

// renderLogEntry: 仅当 entry.method 存在（HTTP 请求）时，加 click handler 和 cursor: pointer
```

### Step 1: HTML — dialog 结构

`public/index.html` `</body>` 前追加：

```html
<dialog id="log-detail" class="log-detail" aria-labelledby="log-detail-title">
  <header class="log-detail-header">
    <span class="log-detail-method" data-method="" id="logDetailMethod">METHOD</span>
    <span class="log-detail-path" id="logDetailPath">/path</span>
    <span class="log-detail-status" data-range="" id="logDetailStatus">200</span>
    <button class="log-detail-close" id="logDetailClose" type="button" aria-label="关闭">×</button>
  </header>

  <section class="log-detail-section">
    <h3>请求</h3>
    <dl class="log-detail-meta" id="logDetailMeta"></dl>
  </section>

  <section class="log-detail-section">
    <h3>查询参数 <span class="log-detail-count" id="logDetailQueryCount">0</span></h3>
    <table class="log-detail-table" id="logDetailQueryTable" hidden>
      <thead><tr><th>键</th><th>值</th></tr></thead>
      <tbody></tbody>
    </table>
    <p class="log-detail-empty" id="logDetailQueryEmpty">（无查询参数）</p>
  </section>

  <section class="log-detail-section">
    <h3>请求头 <span class="log-detail-count" id="logDetailHeadersCount">0</span></h3>
    <table class="log-detail-table" id="logDetailHeadersTable" hidden>
      <thead><tr><th>键</th><th>值</th></tr></thead>
      <tbody></tbody>
    </table>
    <p class="log-detail-empty" id="logDetailHeadersEmpty">（无请求头）</p>
  </section>

  <section class="log-detail-section">
    <h3>请求体</h3>
    <div class="log-detail-body-warning" id="logDetailBodyWarning" hidden>请求体已截断（超出配置上限）</div>
    <div class="log-detail-body" id="logDetailBody" hidden></div>
    <pre class="log-detail-body-plain" id="logDetailBodyPlain" hidden></pre>
    <p class="log-detail-empty" id="logDetailEmpty">（无请求体）</p>
  </section>
</dialog>
```

### Step 2: CSS

`public/styles.css` 末尾追加：

```css
/* log row hover (clickable) */
.log-entry { cursor: pointer; transition: background-color 80ms ease; }
.log-entry:hover { background: var(--surface-hover, rgba(255, 255, 255, 0.04)); }
.log-entry.missed:hover { background: var(--surface-hover-warn, rgba(255, 170, 0, 0.05)); }

dialog.log-detail {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 8px;
  max-width: 720px;
  width: 90vw;
  max-height: 80vh;
  padding: 0;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
}
dialog.log-detail::backdrop {
  background: rgba(8, 14, 24, 0.6);
  backdrop-filter: blur(2px);
}
.log-detail-header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.log-detail-header .log-detail-method {
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  font-weight: 600;
  font-size: 12px;
}
.log-detail-header .log-detail-path {
  flex: 1;
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 13px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.log-detail-header .log-detail-status {
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  font-weight: 600;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 3px;
  background: var(--status-bg, rgba(255, 255, 255, 0.06));
}
.log-detail-status[data-range="2xx"] { color: var(--green, #6c6); }
.log-detail-status[data-range="4xx"] { color: var(--amber, #fa8); }
.log-detail-status[data-range="5xx"] { color: var(--red, #f66); }
.log-detail-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; cursor: pointer; padding: 0 4px;
}
.log-detail-close:hover { color: var(--text); }

.log-detail-section {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.log-detail-section:last-child {
  border-bottom: none;
  overflow: auto;
}
.log-detail-section h3 {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--text-dim); margin: 0 0 8px; font-weight: 600;
}
.log-detail-count {
  color: var(--text-dim); font-weight: 400; margin-left: 4px;
}
.log-detail-meta { display: grid; grid-template-columns: 80px 1fr; gap: 4px 12px; margin: 0; font-size: 12px; }
.log-detail-meta dt { color: var(--text-dim); }
.log-detail-meta dd { margin: 0; font-family: var(--mono, ui-monospace, SFMono-Regular, monospace); }

.log-detail-table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: var(--mono, ui-monospace, SFMono-Regular, monospace); }
.log-detail-table th, .log-detail-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border-soft, rgba(255,255,255,0.05)); }
.log-detail-table th { color: var(--text-dim); font-weight: 500; width: 30%; word-break: break-all; }
.log-detail-table td { word-break: break-all; }

.log-detail-body { max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: 4px; }
.log-detail-body .cm-editor { max-height: 320px; }
.log-detail-body-plain {
  max-height: 320px; overflow: auto; padding: 8px 12px; margin: 0;
  background: var(--code-bg, rgba(0, 0, 0, 0.2));
  border: 1px solid var(--border); border-radius: 4px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 12px; white-space: pre-wrap; word-break: break-all;
}
.log-detail-body-warning {
  background: var(--amber-soft, rgba(255, 170, 0, 0.12));
  color: var(--amber, #fa8);
  padding: 6px 10px; border-radius: 4px; font-size: 12px;
  margin-bottom: 8px;
}
.log-detail-empty { color: var(--text-dim); font-size: 12px; margin: 0; }
```

### Step 3: app.js — 元素引用 + 状态变量

`public/app.js` 顶部 `els` 块（找 `els.logsBody` 附近）追加：

```js
els.logDetail = document.querySelector('#log-detail');
els.logDetailMethod = document.querySelector('#logDetailMethod');
els.logDetailPath = document.querySelector('#logDetailPath');
els.logDetailStatus = document.querySelector('#logDetailStatus');
els.logDetailClose = document.querySelector('#logDetailClose');
els.logDetailMeta = document.querySelector('#logDetailMeta');
els.logDetailQueryCount = document.querySelector('#logDetailQueryCount');
els.logDetailQueryTable = document.querySelector('#logDetailQueryTable');
els.logDetailQueryEmpty = document.querySelector('#logDetailQueryEmpty');
els.logDetailHeadersCount = document.querySelector('#logDetailHeadersCount');
els.logDetailHeadersTable = document.querySelector('#logDetailHeadersTable');
els.logDetailHeadersEmpty = document.querySelector('#logDetailHeadersEmpty');
els.logDetailBodyWarning = document.querySelector('#logDetailBodyWarning');
els.logDetailBody = document.querySelector('#logDetailBody');
els.logDetailBodyPlain = document.querySelector('#logDetailBodyPlain');
els.logDetailEmpty = document.querySelector('#logDetailEmpty');

let logDetailCM = null;
```

### Step 4: app.js — renderLogEntry click handler

`renderLogEntry` 函数（`public/app.js:235`）末尾（在 `return row;` 之前）追加：

```js
// 只有 HTTP 请求条目可点（过滤 resolver-warn）
if (entry.method) {
  row.addEventListener('click', () => openLogDetail(entry.id));
}
```

### Step 5: app.js — openLogDetail / closeLogDetail / renderLogDetail

在 `renderLogEntry` 函数定义后、`renderLogsInitial` 前，插入：

```js
function openLogDetail(id) {
  const entry = state.logs.find((e) => e.id === id);
  if (!entry || !entry.method) return;
  renderLogDetail(entry);
  els.logDetail.showModal();
}

function closeLogDetail() {
  if (els.logDetail.open) els.logDetail.close();
}

function renderLogDetail(entry) {
  // 1. Header
  els.logDetailMethod.textContent = entry.method;
  els.logDetailMethod.dataset.method = entry.method;
  els.logDetailPath.textContent = entry.path;
  els.logDetailStatus.textContent = entry.status;
  els.logDetailStatus.dataset.range = `${Math.floor(entry.status / 100)}xx`;

  // 2. Meta
  const time = new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false });
  els.logDetailMeta.innerHTML = '';
  const rows = [
    ['时间', time],
    ['端口', String(entry.port)],
    ['耗时', `${entry.durationMs} ms`],
    ['IP', entry.ip ? entry.ip.replace(/^::ffff:/, '') : '—'],
    ['路由', entry.matched ? '匹配' : '无路由'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    els.logDetailMeta.append(dt, dd);
  }

  // 3. Query
  const queryTbody = els.logDetailQueryTable.querySelector('tbody');
  queryTbody.innerHTML = '';
  const params = new URLSearchParams(entry.query || '');
  if ([...params.keys()].length === 0) {
    els.logDetailQueryTable.hidden = true;
    els.logDetailQueryEmpty.hidden = false;
    els.logDetailQueryCount.textContent = '0';
  } else {
    els.logDetailQueryTable.hidden = false;
    els.logDetailQueryEmpty.hidden = true;
    els.logDetailQueryCount.textContent = String([...params.keys()].length);
    for (const [k, v] of params) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = k;
      const td2 = document.createElement('td'); td2.textContent = v;
      tr.append(td1, td2);
      queryTbody.append(tr);
    }
  }

  // 4. Headers
  const headerTbody = els.logDetailHeadersTable.querySelector('tbody');
  headerTbody.innerHTML = '';
  const headerEntries = Object.entries(entry.requestHeaders || {});
  if (headerEntries.length === 0) {
    els.logDetailHeadersTable.hidden = true;
    els.logDetailHeadersEmpty.hidden = false;
    els.logDetailHeadersCount.textContent = '0';
  } else {
    els.logDetailHeadersTable.hidden = false;
    els.logDetailHeadersEmpty.hidden = true;
    els.logDetailHeadersCount.textContent = String(headerEntries.length);
    for (const [k, v] of headerEntries) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = k;
      const td2 = document.createElement('td');
      td2.textContent = Array.isArray(v) ? v.join(', ') : String(v);
      tr.append(td1, td2);
      headerTbody.append(tr);
    }
  }

  // 5. Body
  // 先 destroy 旧 CM 实例（避免内存累积）
  if (logDetailCM) { logDetailCM.destroy(); logDetailCM = null; }
  els.logDetailBody.innerHTML = '';

  const body = entry.requestBodyPreview || '';
  if (!body) {
    els.logDetailEmpty.hidden = false;
    els.logDetailBodyWarning.hidden = true;
    els.logDetailBody.hidden = true;
    els.logDetailBodyPlain.hidden = true;
  } else {
    els.logDetailEmpty.hidden = true;
    els.logDetailBodyWarning.hidden = !entry.requestBodyTruncated;
    let parsed;
    try { parsed = JSON.parse(body); } catch {}
    if (parsed !== undefined) {
      const formatted = JSON.stringify(parsed, null, 2);
      els.logDetailBody.hidden = false;
      els.logDetailBodyPlain.hidden = true;
      logDetailCM = window.mountReadonlyEditor(els.logDetailBody, formatted);
    } else {
      els.logDetailBody.hidden = true;
      els.logDetailBodyPlain.hidden = false;
      els.logDetailBodyPlain.textContent = body;
    }
  }
}
```

### Step 6: app.js — 事件绑定

在 `els.settingsSave.addEventListener('click', saveSettings);` 行附近（事件绑定区）追加：

```js
els.logDetailClose.addEventListener('click', closeLogDetail);
els.logDetail.addEventListener('click', (e) => {
  // 点 backdrop（dialog 自身）关闭；点内部内容不关
  if (e.target === els.logDetail) closeLogDetail();
});
els.logDetail.addEventListener('close', () => {
  if (logDetailCM) { logDetailCM.destroy(); logDetailCM = null; }
});
```

### Step 7: 跑 E2E 验证

本任务完成后 E2E 暂不跑，等 Task 8 写完整 spec 后统一验证。

### Step 8: 提交

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(ui): 请求详情弹窗 — 点击日志行查看头/查询/body

- 原生 <dialog> 居中模态，ESC + 点 backdrop 关闭
- 4 个 section：摘要 meta / 查询参数 / 请求头 / 请求体
- body 合法 JSON 用 CodeMirror 只读 viewer；非 JSON 纯文本展示
- 截断时顶部红字提示
- 关闭时 destroy CodeMirror 实例释放内存
- resolver-warn 条目（无 method）不可点"
```

---

## Task 7: api-logs 集成测试加 requestBodyTruncated 字段验证

**Files:**
- Modify: `test/integration/api-logs.test.js`（追加 truncated 验证用例）

### Step 1: 读 api-logs.test.js 找插入点

Read: `test/integration/api-logs.test.js`

找到 describe 块，看现有用例结构，找到一个用 `describe('GET /api/logs', ...)` 之类的地方。

### Step 2: 写失败测试

在合适位置追加：

```js
describe('GET /api/logs — requestBodyTruncated field', () => {
  it('includes requestBodyTruncated field on every log entry', async () => {
    const { app, request } = buildApp({ storagePath: tmp, configStore, logBuffer, mockEngine });
    logBuffer.push({
      id: 'a', timestamp: Date.now(), method: 'GET', path: '/x', port: 8080,
      status: 200, requestBodyPreview: '', requestBodyTruncated: false,
    });
    logBuffer.push({
      id: 'b', timestamp: Date.now(), method: 'POST', path: '/y', port: 8080,
      status: 200, requestBodyPreview: 'big...', requestBodyTruncated: true,
    });
    const r = await request.get('/api/logs');
    expect(r.status).toBe(200);
    expect(r.body[0].requestBodyTruncated).toBe(false);
    expect(r.body[1].requestBodyTruncated).toBe(true);
  });
});
```

### Step 3: 跑测试确认通过

Run:
```bash
pnpm vitest run test/integration/api-logs.test.js
```

Expected: 全部通过（logBuffer.push 直接写字段，不依赖 mock-engine，所以是直接通过的——这个测试的意义是**回归保护**）。

### Step 4: 提交

```bash
git add test/integration/api-logs.test.js
git commit -m "test(logs): 验证 /api/logs 返回 entry 含 requestBodyTruncated 字段"
```

---

## Task 8: 完整 E2E 测试 log-detail-modal.spec.js

**Files:**
- Create: `test/e2e/log-detail-modal.spec.js`
- Create: `test/e2e/helpers.js`（如果不存在——读 `test/e2e/dynamic-response-generator.spec.js:2` 看一下现有 import）

### Step 1: 确认 helpers.js 存在

Run:
```bash
ls test/e2e/helpers.js 2>/dev/null && echo "exists" || echo "missing"
```

如果 missing，参考 `test/e2e/dynamic-response-generator.spec.js` 顶部 import 从其它 spec 找到现有 helper，或用 `grep -r "bootServer" test/e2e/` 找到导出位置。

### Step 2: 写 E2E 测试

`test/e2e/log-detail-modal.spec.js`：

```js
import { test, expect } from '@playwright/test';
import { bootServer, hitMock } from './helpers.js';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.beforeEach(async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const list = await (await fetch('/api/endpoints')).json();
    for (const ep of list) await fetch(`/api/endpoints/${ep.id}`, { method: 'DELETE' });
    await fetch('/api/runtime/stop', { method: 'POST' }).catch(() => {});
    await fetch('/api/logs', { method: 'DELETE' }).catch(() => {});
  });
  await page.waitForTimeout(300);
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

async function createEndpointViaApi(page, ep) {
  await page.evaluate(async (endpoint) => {
    await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(endpoint),
    });
  }, ep);
}

test('click log row → dialog opens with 4 sections', async ({ page }) => {
  await createEndpointViaApi(page, {
    method: 'POST', port: 19601, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await hitMock(19601, '/x', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
  await page.waitForTimeout(500);

  // 点击日志行
  await page.locator('.log-entry').first().click();
  // dialog 出现
  await expect(page.locator('#log-detail')).toBeVisible();
  // 4 section 都在
  await expect(page.locator('.log-detail-section')).toHaveCount(4);
  // 关闭
  await page.keyboard.press('Escape');
  await expect(page.locator('#log-detail')).toBeHidden();
});

test('body is rendered in CodeMirror when valid JSON', async ({ page }) => {
  await createEndpointViaApi(page, {
    method: 'POST', port: 19602, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await hitMock(19602, '/x', { method: 'POST', body: '{"hello":"world"}', headers: { 'content-type': 'application/json' } });
  await page.waitForTimeout(500);
  await page.locator('.log-entry').first().click();
  // CodeMirror 渲染
  await expect(page.locator('#logDetailBody .cm-content')).toBeVisible();
  await expect(page.locator('#logDetailBody').textContent()).toContain('"hello"');
});

test('body is rendered as plain text when not JSON', async ({ page }) => {
  await createEndpointViaApi(page, {
    method: 'POST', port: 19603, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await hitMock(19603, '/x', { method: 'POST', body: 'just plain text', headers: { 'content-type': 'text/plain' } });
  await page.waitForTimeout(500);
  await page.locator('.log-entry').first().click();
  await expect(page.locator('#logDetailBodyPlain')).toBeVisible();
  await expect(page.locator('#logDetailBodyPlain').textContent()).toContain('just plain text');
});

test('GET with no body shows empty placeholder', async ({ page }) => {
  await createEndpointViaApi(page, {
    method: 'GET', port: 19604, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await hitMock(19604, '/x');
  await page.waitForTimeout(500);
  await page.locator('.log-entry').first().click();
  await expect(page.locator('#logDetailEmpty')).toBeVisible();
});

test('query parameters are parsed into a table', async ({ page }) => {
  await createEndpointViaApi(page, {
    method: 'GET', port: 19605, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await hitMock(19605, '/x?a=1&b=hello');
  await page.waitForTimeout(500);
  await page.locator('.log-entry').first().click();
  const queryText = await page.locator('#logDetailQueryTable').textContent();
  expect(queryText).toContain('a');
  expect(queryText).toContain('1');
  expect(queryText).toContain('b');
  expect(queryText).toContain('hello');
});

test('click on backdrop closes the dialog', async ({ page }) => {
  await createEndpointViaApi(page, {
    method: 'GET', port: 19606, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await hitMock(19606, '/x');
  await page.waitForTimeout(500);
  await page.locator('.log-entry').first().click();
  await expect(page.locator('#log-detail')).toBeVisible();
  // 点 backdrop（dialog 自身的边缘）
  await page.locator('#log-detail').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#log-detail')).toBeHidden();
});

test('truncated body shows warning banner', async ({ page }) => {
  // 把 maxBodyBytes 设为 10 字节
  await page.evaluate(async () => {
    await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { maxBodyBytes: 10 } }),
    });
  });
  await createEndpointViaApi(page, {
    method: 'POST', port: 19607, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await hitMock(19607, '/x', { method: 'POST', body: 'x'.repeat(50), headers: { 'content-type': 'text/plain' } });
  await page.waitForTimeout(500);
  await page.locator('.log-entry').first().click();
  await expect(page.locator('#logDetailBodyWarning')).toBeVisible();
  // 恢复默认
  await page.evaluate(async () => {
    await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { maxBodyBytes: 4194304 } }),
    });
  });
});

test('Settings: change maxBodyBytes saves and persists across reload', async ({ page }) => {
  await page.evaluate(async () => {
    await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { maxBodyBytes: 12345 } }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.locator('#settingsBtn').click();
  await page.waitForTimeout(300);
  const value = await page.locator('#settingsMaxBody').inputValue();
  expect(value).toBe('12345');
  const hint = await page.locator('#settingsMaxBodyHint').textContent();
  expect(hint).toMatch(/KB|MB/);
});

test('Settings: invalid maxBodyBytes is rejected with red flash', async ({ page }) => {
  await page.locator('#settingsBtn').click();
  await page.waitForTimeout(300);
  await page.locator('#settingsMaxBody').fill('0');
  await page.locator('#settingsSave').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#lastSaved')).toContainText('正整数');
});
```

### Step 3: 跑 E2E

Run:
```bash
pnpm test:e2e -- test/e2e/log-detail-modal.spec.js
```

Expected: 全部通过。如果有失败，按 `Test: <name>` 提示修代码（不修测试除非是测试本身错）。

### Step 4: 跑全量 E2E 确认无回归

Run:
```bash
pnpm test:e2e
```

Expected: 全部通过（如果其他 E2E 文件之前是绿的）。

### Step 5: 提交

```bash
git add test/e2e/log-detail-modal.spec.js
git commit -m "test(e2e): log-detail-modal 端到端覆盖

- 8 个场景：基本流程 / JSON body / 纯文本 body / GET 无 body / Query 解析 / 点 backdrop 关闭 / 截断 warning / Settings 持久化 / Settings 校验
- headed 模式（playwright.config.js 已固定）"
```

---

## Task 9: 同步 embed-assets/public/

**Files:**
- Sync: `embed-assets/public/index.html` ← `public/index.html`
- Sync: `embed-assets/public/app.js` ← `public/app.js`
- Sync: `embed-assets/public/editor.js` ← `public/editor.js`
- Sync: `embed-assets/public/styles.css` ← `public/styles.css`

### Step 1: 同步 4 个文件

Run:
```bash
cp public/index.html embed-assets/public/index.html
cp public/app.js embed-assets/public/app.js
cp public/editor.js embed-assets/public/editor.js
cp public/styles.css embed-assets/public/styles.css
```

### Step 2: 验证差异为零

Run:
```bash
diff -r public/ embed-assets/public/ 2>&1 | head -50
```

Expected: 无输出（两个目录内容一致）。

> 注：`embed-assets/public/` 是 Bun 打包的输入；保持与 `public/` 镜像。`build.mjs` 在打包时复制 `embed-assets/public/` → packaged server 的资源根。

### Step 3: 跑 E2E 确认 headed 模式 UI 正常

Run:
```bash
pnpm test:e2e
```

Expected: 全部通过。

### Step 4: 提交

```bash
git add embed-assets/public/index.html embed-assets/public/app.js embed-assets/public/editor.js embed-assets/public/styles.css
git commit -m "chore(embed): 同步 public/ → embed-assets/public/

保持 dev 与 packaged 构建一致。"
```

---

## 验收清单

- [ ] `pnpm test` 全部通过
- [ ] `pnpm test:e2e` 全部通过
- [ ] `pnpm start` 启动成功，config 含 `maxBodyBytes: 4194304`
- [ ] 点击日志行 → 弹窗打开
- [ ] 弹窗内 4 个 section 都有内容
- [ ] Body 是合法 JSON → CodeMirror 渲染
- [ ] Body 是非 JSON → `<pre>` 纯文本
- [ ] Body 超 maxBodyBytes → 顶部红字 warning
- [ ] ESC / 点 backdrop / 点 × 都关闭弹窗
- [ ] Settings 面板能改 maxBodyBytes 并保存
- [ ] Settings hint 实时更新（KB / MB / GB）
- [ ] 旧 `data.json` 缺 `maxBodyBytes` → 兜底 4MB，不报错
- [ ] `public/` 与 `embed-assets/public/` 内容一致
- [ ] CLAUDE.md 删除了 `MOCK_MAX_BODY_PREVIEW` 文档

---

**Plan 自审**：

- ✅ Spec 覆盖：§3 数据模型 → Task 1；§4 API 校验 → Task 2；§5 UI → Task 4/5/6；§8 测试 → Task 7/8
- ✅ 无 TBD / TODO / 占位符
- ✅ 类型一致：`requestBodyTruncated` / `maxBodyBytes` / `logDetailCM` 在引入处定义明确，使用点引用一致
- ✅ 文件路径全部 `public/` 与 `embed-assets/public/` 都覆盖
- ✅ TDD：每个 task 先写测试再实现
- ✅ 频繁提交：每个 task 一个 commit
