# 接口列表增强（复制 + 拖拽排序 + 删撤销按钮）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HTTP 接口列表项增加一键复制（自动 `-copy` 避撞、插入源后方并选中），列表支持原生 HTML5 拖拽排序（新增 `PUT /api/endpoints/order` 持久化），删除 HTTP 编辑区的撤销按钮。

**Architecture:** 后端只加一条 order 路由（注册在 `PUT /api/endpoints/:id` **之前**，否则被 `:id` 吞掉）；复制为纯前端编排（算路径 → 现有 POST /api/endpoints）；拖拽用原生 HTML5 DnD，`renderEndpointList()` 加拖拽守卫规避 5s 轮询重建。删撤销按钮是纯减法。

**Tech Stack:** Express 4（node:http 控制平面）、原生 ESM 前端（零构建）、vitest + supertest（集成）、Playwright headed（E2E）。

**规格依据:** `docs/superpowers/specs/2026-08-17-endpoint-list-enhancements-design.md`（commit `1fae90d`）

## Global Constraints

- E2E 必须前台运行（`playwright.config.js` 固定 `headless: false`，不得切 headless）
- 每次修改 `public/` 后必须同步 `embed-assets/`（CLAUDE.md 不变量 #5），在 Task 5 统一执行
- 提交信息用 conventional commits（feat/fix/style/test/chore），不加 Attribution（全局禁用）
- 唯一性约束 `(port, method, path)` 仅对 `enabled !== false` 端点校验（`ConfigStore.checkUniqueness`），复制避撞用同一谓词
- 服务端错误信封字段是 `error`（见 `src/errors.js` 的 `toErrorResponse`），前端取 `json.error`
- WS 视图（`#operationList`、`wsRevertBtn`）零改动；`src-tauri/` 零改动
- 端口占用约定：E2E 新用例用 17510（复制）、17511（拖拽）——17501–17509 已被 port-detail.spec.js 占用，17601/18790/19xxx 被其他 spec 占用

## File Structure

| 文件 | 改动 | 责任 |
|---|---|---|
| `src/api.js` | 修改 | + `PUT /api/endpoints/order` 路由（Task 1） |
| `test/integration/api-endpoints.test.js` | 修改 | + order 路由用例（Task 1） |
| `public/index.html` | 修改 | 删 `#revertBtn`（Task 2） |
| `public/app.js` | 修改 | 删 revertBtn 接线（Task 2）；复制按钮 + `copyEndpointById`（Task 3）；DnD 接线 + 渲染守卫 + `api.reorderEndpoints`（Task 4） |
| `public/styles.css` | 修改 | `--cyan-wash` 双主题 token + `.endpoint-copy` 样式（Task 3）；拖拽态样式（Task 4） |
| `test/e2e/port-detail.spec.js` | 修改 | 布局用例追加 revert 断言（Task 2）；复制用例（Task 3）；拖拽用例（Task 4） |
| `embed-assets/public/{app.js,index.html,styles.css}` | 同步 | 编译产物一致性（Task 5） |

---

### Task 1: 排序 API 路由 `PUT /api/endpoints/order`

**Files:**
- Modify: `src/api.js`（在 `app.put('/api/endpoints/:id', ...)` 之前插入新路由）
- Modify: `test/integration/api-endpoints.test.js`（文件末尾追加 describe）

**Interfaces:**
- Consumes: `ConfigStore.update(mutator)`、`AppError(status, code, message)`
- Produces: `PUT /api/endpoints/order`，body `{ ids: string[] }`，成功返回 `200` + 重排后的端点数组；非排列返回 `400 INVALID_ORDER`。Task 4 的前端 `api.reorderEndpoints(ids)` 消费它

**关键：** Express 按注册顺序匹配，`/api/endpoints/order` 必须注册在 `/api/endpoints/:id` **之前**，否则 `order` 会被当成 `:id` 匹配走 404。

- [ ] **Step 1: 写失败测试**

在 `test/integration/api-endpoints.test.js` 文件末尾追加：

```js
describe('PUT /api/endpoints/order', () => {
  it('reorders endpoints by given id permutation and persists', async () => {
    const a = await ctx.request.post('/api/endpoints').send(validBody);
    const b = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/y' });
    const c = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/z' });
    const ids = [c.body.id, a.body.id, b.body.id];

    const r = await ctx.request.put('/api/endpoints/order').send({ ids });
    expect(r.status).toBe(200);
    expect(r.body.map((e) => e.id)).toEqual(ids);

    const list = await ctx.request.get('/api/endpoints');
    expect(list.body.map((e) => e.id)).toEqual(ids);
  });

  it('rejects ids that are not a permutation of endpoint ids', async () => {
    const a = await ctx.request.post('/api/endpoints').send(validBody);
    await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/y' });

    // 长度不对
    let r = await ctx.request.put('/api/endpoints/order').send({ ids: [a.body.id] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_ORDER');

    // 未知 id
    r = await ctx.request.put('/api/endpoints/order').send({ ids: [a.body.id, 'nope'] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_ORDER');

    // 重复 id
    r = await ctx.request.put('/api/endpoints/order').send({ ids: [a.body.id, a.body.id] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_ORDER');

    // ids 不是数组
    r = await ctx.request.put('/api/endpoints/order').send({ ids: 'nope' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_ORDER');
  });
});
```

- [ ] **Step 2: 运行测试，确认 RED**

Run: `pnpm vitest run test/integration/api-endpoints.test.js -t "order"`
Expected: FAIL——`PUT /api/endpoints/order` 被 `:id` 路由吞掉，返回 404 而非 200/400 INVALID_ORDER。

- [ ] **Step 3: 实现路由**

Edit `src/api.js`，找到（字符串唯一）：

```js
  app.put('/api/endpoints/:id', async (req, res, next) => {
```

在它**之前**插入：

```js
  // 列表排序：ids 必须是现有端点 id 的排列；顺序纯展示语义，不影响 mock 路由。
  // 注意：必须注册在 /api/endpoints/:id 之前，否则 "order" 被当作 :id。
  app.put('/api/endpoints/order', async (req, res, next) => {
    try {
      const { ids } = req.body || {};
      const list = configStore.config.endpoints;
      const invalid = () => new AppError(400, 'INVALID_ORDER', 'ids must be a permutation of endpoint ids');
      if (!Array.isArray(ids) || ids.length !== list.length) throw invalid();
      const byId = new Map(list.map((e) => [e.id, e]));
      const seen = new Set();
      const reordered = [];
      for (const id of ids) {
        if (seen.has(id) || !byId.has(id)) throw invalid();
        seen.add(id);
        reordered.push(byId.get(id));
      }
      await configStore.update((cfg) => {
        cfg.endpoints = reordered;
        return cfg;
      });
      res.json(configStore.config.endpoints);
    } catch (e) { next(e); }
  });

```

- [ ] **Step 4: 运行测试，确认 GREEN**

Run: `pnpm vitest run test/integration/api-endpoints.test.js`
Expected: 全部 PASS（含新增 2 条与既有用例）。

- [ ] **Step 5: Commit**

```bash
git add src/api.js test/integration/api-endpoints.test.js
git commit -m "feat: 端点排序 API（PUT /api/endpoints/order，排列为准否则 400）"
```

---

### Task 2: 删除撤销按钮（HTTP 页）

**Files:**
- Modify: `test/e2e/port-detail.spec.js`（布局意图用例追加 1 行断言）
- Modify: `public/index.html:200`（删按钮）
- Modify: `public/app.js:248`（删 els 登记）、`public/app.js:1136-1139`（删监听器）

**Interfaces:**
- Consumes: 无
- Produces: HTTP 编辑区 header 只剩 已保存 | 保存 | 分隔线 | 删除；`els.revertBtn` 不再存在（后续任务不得引用）

- [ ] **Step 1: 布局意图用例追加防复活断言（RED）**

Edit `test/e2e/port-detail.spec.js`，找到（字符串唯一）：

```js
  // 意图 3：HTTP 底部按钮条已移除（限定 #editorForm，WS 表单共用 .editor-form 类）
  await expect(page.locator('#editorForm > .editor-footer')).toHaveCount(0);
```

在它**后面**追加：

```js

  // 意图 4：撤销按钮已从 HTTP 页移除（spec 2026-08-17 §5；WS 页 wsRevertBtn 不受影响）
  await expect(page.locator('#editorForm #revertBtn')).toHaveCount(0);
```

- [ ] **Step 2: 运行测试，确认 RED**

Run: `pnpm playwright test test/e2e/port-detail.spec.js -g "操作按钮在编辑区顶部"`
Expected: FAIL——`#revertBtn` 仍存在，toHaveCount(0) 断言失败。

- [ ] **Step 3: 删 DOM 与接线（GREEN）**

Edit `public/index.html`，删除这一行（字符串唯一）：

```html
            <button class="btn btn-ghost btn-sm" id="revertBtn">撤销</button>
```

Edit `public/app.js`，删除 els 登记这一行（字符串唯一）：

```js
  revertBtn: $("#revertBtn"),
```

Edit `public/app.js`，删除监听器块（字符串唯一）：

```js
els.revertBtn.addEventListener("click", () => {
  state.dirty = false;
  renderEditor();
});
```

- [ ] **Step 4: 运行测试，确认 GREEN**

Run: `pnpm playwright test test/e2e/port-detail.spec.js`
Expected: 全部 PASS。

Run: `pnpm playwright test test/e2e/ws-happy-path.spec.js`
Expected: PASS（WS 页撤销按钮与流程未受波及）。

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js test/e2e/port-detail.spec.js
git commit -m "feat: 移除接口管理页撤销按钮（保留未保存切换守卫，WS 页不动）"
```

---

### Task 3: 复制接口

**Files:**
- Modify: `test/e2e/port-detail.spec.js`（文件末尾追加用例）
- Modify: `public/app.js`（`renderEndpointList` 的 innerHTML 与监听器、新增 `nextCopyPath` / `copyEndpointById`）
- Modify: `public/styles.css:89`（暗色 token）、`public/styles.css:1973`（亮色 token）、`.endpoint-delete:focus-visible` 块之后（复制按钮样式）

**Interfaces:**
- Consumes: `api.createEndpoint(body)`（既有）、`renderEditorForCreate(ep)`（既有，与「新建」共用）
- Produces: 列表项内的 `.endpoint-copy` 按钮与 `copyEndpointById(id)`；Task 4 的拖拽接线叠加在同一 `renderEndpointList` 上

- [ ] **Step 1: 写失败测试**

在 `test/e2e/port-detail.spec.js` 文件末尾追加：

```js
test('复制接口：-copy 避撞、插入源后方并选中、响应体同源', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async (port) => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        port, method: 'GET', path: '/api/orig', statusCode: 200,
        name: '原接口', response: { marker: 42 },
      }),
    });
  }, 17510);
  await enterPortDetail(page, server.baseURL, 17510);

  // 第一次复制：路径 -copy 避撞，名称加 (副本)，插入源正后方并选中
  await page.locator('.endpoint-item').first().hover();
  await page.locator('.endpoint-item .endpoint-copy').first().click();
  await expect(page.locator('.endpoint-item')).toHaveCount(2);
  await expect(page.locator('.endpoint-item .endpoint-path').nth(1)).toHaveText('/api/orig-copy');
  await expect(page.locator('.endpoint-item .endpoint-name').nth(1)).toHaveText('原接口 (副本)');
  await expect(page.locator('.endpoint-item').nth(1)).toHaveClass(/selected/);
  await expect(page.locator('.cm-content')).toContainText('"marker": 42');

  // 第二次复制：-copy 已占用，避撞到 -copy-2
  await page.locator('.endpoint-item').first().hover();
  await page.locator('.endpoint-item .endpoint-copy').first().click();
  await expect(page.locator('.endpoint-item')).toHaveCount(3);
  await expect(page.locator('.endpoint-item .endpoint-path').nth(2)).toHaveText('/api/orig-copy-2');
});
```

- [ ] **Step 2: 运行测试，确认 RED**

Run: `pnpm playwright test test/e2e/port-detail.spec.js -g "复制接口"`
Expected: FAIL——`.endpoint-copy` 不存在，click 超时。

- [ ] **Step 3: 双主题加 `--cyan-wash` token**

Edit `public/styles.css`，暗色块中（字符串唯一，冒号后值与亮色不同）：

```css
  --danger-wash: rgba(255, 69, 58, 0.12);
```

改为：

```css
  --danger-wash: rgba(255, 69, 58, 0.12);
  --cyan-wash: rgba(10, 132, 255, 0.12);
```

亮色块中（字符串唯一）：

```css
  --danger-wash: rgba(255, 59, 48, 0.10);
```

改为：

```css
  --danger-wash: rgba(255, 59, 48, 0.10);
  --cyan-wash: rgba(0, 113, 227, 0.10);
```

- [ ] **Step 4: 列表项加复制按钮（innerHTML + 监听器）**

Edit `public/app.js`，`renderEndpointList` 内找到（字符串唯一）：

```js
        <button class="endpoint-delete" type="button" aria-label="删除" title="删除">
```

在它**之前**插入：

```js
        <button class="endpoint-copy" type="button" aria-label="复制接口" title="复制接口">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2"></rect>
            <path d="M5 15V5a2 2 0 0 1 2-2h10"></path>
          </svg>
        </button>
```

Edit `public/app.js`，找到（字符串唯一）：

```js
    li.addEventListener("click", (e) => {
      // Ignore clicks on the delete button
      if (e.target.closest(".endpoint-delete")) return;
      selectEndpoint(ep.id);
    });
```

改为：

```js
    li.addEventListener("click", (e) => {
      // Ignore clicks on the action buttons (delete / copy)
      if (e.target.closest(".endpoint-delete, .endpoint-copy")) return;
      selectEndpoint(ep.id);
    });
```

Edit `public/app.js`，找到（字符串唯一）：

```js
    li.querySelector(".endpoint-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteEndpointById(ep.id);
    });
```

在它**后面**追加：

```js
    li.querySelector(".endpoint-copy").addEventListener("click", (e) => {
      e.stopPropagation();
      copyEndpointById(ep.id);
    });
```

- [ ] **Step 5: 实现 `nextCopyPath` 与 `copyEndpointById`**

Edit `public/app.js`，在 `deleteEndpointById` 函数结束之后、`function renderEditor()` 之前（锚点字符串唯一）：

```js
function renderEditor() {
```

在它**之前**插入：

```js
// 复制避撞：与 checkUniqueness 同谓词——只看 enabled !== false 的端点
function nextCopyPath(source) {
  const taken = (candidate) =>
    state.endpoints.some(
      (e) =>
        e.enabled !== false &&
        e.port === source.port &&
        e.method === source.method &&
        e.path === candidate,
    );
  let candidate = `${source.path}-copy`;
  let n = 2;
  while (taken(candidate)) candidate = `${source.path}-copy-${n++}`;
  return candidate;
}

async function copyEndpointById(id) {
  const source = state.endpoints.find((e) => e.id === id);
  if (!source) return;
  try {
    const ep = await api.createEndpoint({
      method: source.method,
      port: source.port,
      path: nextCopyPath(source),
      statusCode: source.statusCode,
      response: structuredClone(source.response ?? null),
      name: source.name ? `${source.name} (副本)` : "",
      enabled: true,
    });
    // api.createEndpoint 不对非 2xx 抛错，这里自行校验（服务端 400 DUPLICATE_ENDPOINT 等）
    if (!ep?.id) throw new Error(ep?.error || "未知错误");
    const idx = state.endpoints.findIndex((e) => e.id === id);
    state.endpoints.splice(idx + 1, 0, ep);
    state.selectedId = ep.id;
    renderEndpointList();
    renderEditorForCreate(ep);
  } catch (e) {
    alert("复制失败：" + (e?.message || "未知错误"));
  }
}

```

- [ ] **Step 6: 复制按钮样式**

Edit `public/styles.css`，找到（字符串唯一）：

```css
.endpoint-delete:focus-visible {
  opacity: 1;
  outline: none;
  border-color: var(--red);
}
```

在它**后面**追加：

```css

/* 接口列表项：复制按钮（spec 2026-08-17 §3.1，显现逻辑与删除按钮一致） */
.endpoint-copy {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-faint);
  border: 1px solid transparent;
  border-radius: var(--r-1);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--d-fast) var(--ease), background var(--d-fast) var(--ease), color var(--d-fast) var(--ease), border-color var(--d-fast) var(--ease);
  flex-shrink: 0;
}
.endpoint-item:hover .endpoint-copy,
.endpoint-item:focus-within .endpoint-copy { opacity: 1; }
.endpoint-copy:hover {
  background: var(--cyan-wash);
  color: var(--cyan);
}
.endpoint-copy:focus-visible {
  opacity: 1;
  outline: none;
  border-color: var(--cyan);
}
```

- [ ] **Step 7: 运行测试，确认 GREEN**

Run: `pnpm playwright test test/e2e/port-detail.spec.js`
Expected: 全部 PASS（复制用例转绿；既有用例不受影响）。

- [ ] **Step 8: Commit**

```bash
git add public/app.js public/styles.css test/e2e/port-detail.spec.js
git commit -m "feat: 接口列表一键复制（-copy 自动避撞，插入源后方并选中）"
```

---

### Task 4: 拖拽排序

**Files:**
- Modify: `test/e2e/port-detail.spec.js`（文件末尾追加用例）
- Modify: `public/app.js`（`state` 加 `draggingId`、`api` 加 `reorderEndpoints`、`renderEndpointList` 守卫与 DnD 接线）
- Modify: `public/styles.css`（拖拽态样式，追加在 Task 3 的复制按钮样式块之后）

**Interfaces:**
- Consumes: Task 1 的 `PUT /api/endpoints/order`；Task 3 之后的 `renderEndpointList`（innerHTML 已含复制按钮）
- Produces: 列表可拖拽排序，顺序持久化

- [ ] **Step 1: 写失败测试**

在 `test/e2e/port-detail.spec.js` 文件末尾追加：

```js
test('拖拽排序：换序即时生效且刷新后保持', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async (port) => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    for (const path of ['/api/a', '/api/b']) {
      await fetch('/api/endpoints', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port, method: 'GET', path, statusCode: 200, response: {} }),
      });
    }
  }, 17511);
  await enterPortDetail(page, server.baseURL, 17511);

  const paths = () => page.locator('.endpoint-item .endpoint-path').allTextContents();
  expect(await paths()).toEqual(['/api/a', '/api/b']);

  // 把第一项拖到第二项下方 → 顺序反转
  await page.locator('.endpoint-item').nth(0).dragTo(page.locator('.endpoint-item').nth(1), {
    sourcePosition: { x: 60, y: 10 },
    targetPosition: { x: 60, y: 40 },
  });
  await expect(page.locator('.endpoint-item .endpoint-path').nth(0)).toHaveText('/api/b');
  await expect(page.locator('.endpoint-item .endpoint-path').nth(1)).toHaveText('/api/a');

  // 刷新后顺序保持（持久化意图）
  await enterPortDetail(page, server.baseURL, 17511);
  expect(await paths()).toEqual(['/api/b', '/api/a']);
});
```

（`targetPosition` 的 y=40 落在目标项下半区，触发「插入其后」。若列表项实际高度不足 40px，把 y 调整为 `项高 - 5`。）

- [ ] **Step 2: 运行测试，确认 RED**

Run: `pnpm playwright test test/e2e/port-detail.spec.js -g "拖拽排序"`
Expected: FAIL——列表项未设 `draggable`，dragTo 后顺序不变，toHaveText('/api/b') 断言失败。

- [ ] **Step 3: state 与 api 客户端**

Edit `public/app.js`，找到（字符串唯一）：

```js
  selectedOperationId: null,
```

改为：

```js
  selectedOperationId: null,
  draggingId: null,
```

Edit `public/app.js`，找到（字符串唯一）：

```js
  async deleteEndpoint(id) {
    return await fetch(`/api/endpoints/${id}`, { method: "DELETE" });
  },
```

在它**后面**追加：

```js
  async reorderEndpoints(ids) {
    const r = await fetch("/api/endpoints/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) {
      const json = await r.json().catch(() => ({}));
      throw new Error(json.error || "排序失败");
    }
    return r.json();
  },
```

- [ ] **Step 4: `renderEndpointList` 拖拽守卫**

Edit `public/app.js`，找到（字符串唯一）：

```js
function renderEndpointList() {
  els.endpointCount.textContent = state.endpoints.length;
```

改为：

```js
function renderEndpointList() {
  // 拖拽期间不重建列表：5s 轮询会整体重渲染 DOM，抽走拖动中的元素（spec 2026-08-17 §4.3）
  if (state.draggingId) return;
  els.endpointCount.textContent = state.endpoints.length;
```

- [ ] **Step 5: DnD 接线**

Edit `public/app.js`，找到（字符串唯一，Task 3 已追加过复制监听器）：

```js
    li.querySelector(".endpoint-copy").addEventListener("click", (e) => {
      e.stopPropagation();
      copyEndpointById(ep.id);
    });
```

在它**后面**追加：

```js

    // ---- 拖拽排序（原生 HTML5 DnD，spec 2026-08-17 §4.2） ----
    li.draggable = true;
    li.addEventListener("dragstart", (e) => {
      state.draggingId = ep.id;
      e.dataTransfer.setData("text/plain", ep.id);
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => li.classList.add("dragging"));
    });
    li.addEventListener("dragover", (e) => {
      if (!state.draggingId || state.draggingId === ep.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = li.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      li.classList.toggle("drop-above", before);
      li.classList.toggle("drop-below", !before);
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drop-above", "drop-below");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromId = state.draggingId;
      state.draggingId = null;
      if (!fromId || fromId === ep.id) {
        renderEndpointList();
        return;
      }
      const rect = li.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const ids = state.endpoints.map((x) => x.id).filter((x) => x !== fromId);
      ids.splice(ids.indexOf(ep.id) + (before ? 0 : 1), 0, fromId);
      const unchanged =
        ids.every((x, i) => x === state.endpoints[i].id);
      if (unchanged) {
        renderEndpointList();
        return;
      }
      const byId = new Map(state.endpoints.map((x) => [x.id, x]));
      state.endpoints = ids.map((x) => byId.get(x));
      renderEndpointList();
      api.reorderEndpoints(ids).catch(async (err) => {
        alert("排序失败：" + (err?.message || "未知错误"));
        state.endpoints = await api.listEndpoints();
        renderEndpointList();
      });
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      if (state.draggingId) {
        state.draggingId = null;
        renderEndpointList();
      }
    });
```

- [ ] **Step 6: 拖拽态样式**

Edit `public/styles.css`，找到（字符串唯一，Task 3 追加的块尾）：

```css
.endpoint-copy:focus-visible {
  opacity: 1;
  outline: none;
  border-color: var(--cyan);
}
```

在它**后面**追加：

```css

/* 接口列表：拖拽态（spec 2026-08-17 §4.2） */
.endpoint-item.dragging { opacity: 0.4; }
.endpoint-item.drop-above::after,
.endpoint-item.drop-below::after {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  border-radius: 1px;
  background: var(--cyan);
  box-shadow: var(--glow-cyan);
}
.endpoint-item.drop-above::after { top: -2px; }
.endpoint-item.drop-below::after { bottom: -2px; }
```

（`.endpoint-item` 已有 `position: relative`，`::after` 定位可用；`::before` 被 selected 指示条占用，故用 `::after`。）

- [ ] **Step 7: 运行测试，确认 GREEN**

Run: `pnpm playwright test test/e2e/port-detail.spec.js`
Expected: 全部 PASS。

若拖拽用例因 Playwright 与 HTML5 DnD 兼容问题不稳（dragTo 未触发 dragstart），先重试一次确认非偶发；仍不稳则把 Step 1 用例中的 `dragTo` 换成显式事件序列（`dispatchEvent('dragstart')` → 目标 `dispatchEvent('dragover', {clientY})` → `dispatchEvent('drop', {clientY})` → `dispatchEvent('dragend')`），断言不变。不得通过删断言「修复」。

- [ ] **Step 8: Commit**

```bash
git add public/app.js public/styles.css test/e2e/port-detail.spec.js
git commit -m "feat: 接口列表拖拽排序（原生 DnD + 轮询守卫 + order API 持久化）"
```

---

### Task 5: embed-assets 同步 + 全量回归 + 手工验收

**Files:**
- Modify（覆盖同步）: `embed-assets/public/app.js`、`embed-assets/public/index.html`、`embed-assets/public/styles.css`

**Interfaces:**
- Consumes: Task 2-4 的全部 `public/` 产物
- Produces: 编译产物一致性（CLAUDE.md 不变量 #5）；交付状态

- [ ] **Step 1: 同步三个文件**

```bash
cp public/app.js public/index.html public/styles.css embed-assets/public/
```

- [ ] **Step 2: 验证同步无漂移**

Run: `diff -rq public embed-assets/public`
Expected: 无输出（完全一致）。

- [ ] **Step 3: 全量自动化回归**

Run: `pnpm test`
Expected: 全部 PASS。

Run: `pnpm test:e2e`
Expected: 全部 PASS（headed，勿切 headless）。若出现瞬时失败，重跑一次；仍失败则定位修复，不得静默通过。

- [ ] **Step 4: 手工验收（启动 `pnpm start`，逐项过）**

1. hover 列表项：复制与删除按钮同时显现，复制 hover 蓝色 / 删除 hover 红色
2. 复制：新项出现在源正后方并选中，路径 `-copy`，名称带「(副本)」，编辑器响应体与源一致；编辑器聚焦在路径输入框
3. 连拷两次：第二个副本路径 `-copy-2`
4. 拖拽：拖动项半透明，目标位出现靛蓝指示线；放下即换序；刷新页面后顺序保持
5. 拖拽期间列表不闪跳（轮询守卫生效）
6. 编辑区 header 无撤销按钮；保存/删除布局不受影响；WS 服务详情撤销按钮仍在
7. 亮/暗双主题下复制按钮与拖拽指示线颜色正常

任何一项不过：回到对应 Task 修复并重跑 Step 3，不得静默跳过。

- [ ] **Step 5: Commit**

```bash
git add embed-assets/public/app.js embed-assets/public/index.html embed-assets/public/styles.css
git commit -m "chore: embed-assets 同步（接口列表增强：复制 + 拖拽排序 + 删撤销）"
```

---

## Self-Review 记录

- **规格覆盖**：§3.1 复制按钮（Task 3 Step 4/6）✓；§3.2 流程六步（Task 3 Step 5：避撞/副本名/POST/插入后方选中/错误 alert）✓；§4.1 order API（Task 1）✓；§4.2 DnD 交互（Task 4 Step 5/6）✓；§4.3 轮询守卫（Task 4 Step 4）✓；§5 删撤销（Task 2，含保留守卫与 WS 不动）✓；§7.1 文件清单（File Structure 一致，含 embed-assets）✓；§7.2 测试（Task 1 集成 / Task 2-4 E2E）✓；§7.3 手工验收（Task 5 Step 4，7 项逐条对应）✓
- **Placeholder 扫描**：无 TBD/TODO；所有代码步骤含完整代码
- **类型/命名一致性**：`reorderEndpoints` / `INVALID_ORDER` / `draggingId` / `nextCopyPath` / `copyEndpointById` / `--cyan-wash` / `.endpoint-copy` / `.drop-above` / `.drop-below` 在定义处与消费处名称一致；E2E 端口 17510/17511 无冲突
- **已知风险**：Playwright `dragTo` 对 HTML5 DnD 的兼容性——Task 4 Step 7 给出不削弱断言的退化方案
