# 日志按请求时间倒序展示（最新在前）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 日志面板按请求时间倒序渲染，最新日志固定在列表顶部（含初始加载与 SSE 实时推送两条路径）。

**Architecture:** 方案 A —— `state.logs` 存储与后端 API 保持正序不变，仅翻转 `public/app.js` 渲染层：`renderLogsInitial()` 倒序遍历、`appendLog()` 改为 `prepend`、`autoScroll` 由"滚到底"翻转为"钉住顶部"（`scrollTop = 0`）。

**Tech Stack:** 原生 ESM 前端（无框架）、Playwright headed E2E、vitest + supertest（单元/集成，本次不变）。

**设计文档:** `docs/superpowers/specs/2026-08-12-logs-newest-first-design.md`

## Global Constraints

- E2E 必须前台 headed 运行 —— `playwright.config.js` 已固定 `headless: false` + `slowMo: 50`，**不得**切 headless。
- 改 `public/` 必须同步副本到 `embed-assets/public/`（关键不变量 #5；`build.mjs` 只扫描 `embed-assets/`，不自动拷贝）。
- 后端、`/api/logs`、`LogBuffer` 一律不改（spec 非目标；`test/unit/log-buffer.test.js:7` 钉死 "newest last"）。
- `state.logs` 存储顺序与 500 条 `splice` 封顶逻辑不变。
- 不处理"DOM 行数超 500 不裁剪"的既有行为（与本次无关）。
- commit message 用简体中文，遵循 conventional commits。
- 已排查：现有 E2E（happy-path / port-detail / log-detail-modal 等）只断言行数、可见性或点击首行，**无任何用例依赖"最新在底部"的渲染顺序**，无需改动既有测试。

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `test/e2e/logs-order.spec.js` | 倒序行为的 E2E 断言（初始加载 + SSE 实时两条路径） | 新建 |
| `public/app.js` | `renderLogsInitial()`(514-527) 与 `appendLog()`(529-544) 渲染方向 | 修改 |
| `embed-assets/public/app.js` | `public/app.js` 的打包副本 | 同步覆盖 |

**Interfaces（任务间契约，均来自 `test/e2e/helpers.js` 既有导出，签名不变）：**
- `bootServer()` → `{ baseURL, cleanup() }`
- `hitMock(port, path, opts?)` → `Promise<{status, body, headers}>`（默认 GET）
- `enterPortDetail(page, baseURL, port)` → 进入详情页并强制 reload
- `newEndpoint(page, { method = 'GET', port, path })` → `Promise<id>`
- 日志行选择器：`#logsBody .log-entry`；行内路径文本：`.log-path`

---

### Task 1: 新增 E2E 失败测试（倒序断言）

**Files:**
- Create: `test/e2e/logs-order.spec.js`

**Interfaces:**
- Consumes: `bootServer` / `hitMock` / `enterPortDetail` / `newEndpoint`（见上表）
- Produces: 无（测试文件）

- [ ] **Step 1: 编写失败测试**

创建 `test/e2e/logs-order.spec.js`：

```js
import { test, expect } from '@playwright/test';
import { bootServer, hitMock, enterPortDetail, newEndpoint } from './helpers.js';

let server;

test.beforeAll(async () => { server = await bootServer(); });
test.afterAll(async () => { await server.cleanup(); });

test('日志按请求时间倒序：最新一条在最上面', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await newEndpoint(page, { method: 'GET', port: 17601, path: '/first' });
  await newEndpoint(page, { method: 'GET', port: 17601, path: '/second' });
  await newEndpoint(page, { method: 'GET', port: 17601, path: '/third' });
  await page.evaluate(async () => {
    await fetch('/api/runtime/start', { method: 'POST' });
  });
  await hitMock(17601, '/first');
  await hitMock(17601, '/second');

  // 初始加载路径（GET /api/logs → renderLogsInitial）：最新在最上
  await enterPortDetail(page, server.baseURL, 17601);
  const rows = page.locator('#logsBody .log-entry');
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator('.log-path')).toHaveText('/second');
  await expect(rows.last().locator('.log-path')).toHaveText('/first');

  // SSE 实时推送路径（appendLog）：新条目插到顶部
  await hitMock(17601, '/third');
  await expect(rows).toHaveCount(3);
  await expect(rows.first().locator('.log-path')).toHaveText('/third', { timeout: 5000 });
});
```

说明：端口 `17601` 与现有 spec 占用端口（17001/17101/1750x/1950x/19604）均不冲突；`expect` 自动重试即项目约定的确定性等待方式，不加额外 `waitForTimeout`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm playwright test test/e2e/logs-order.spec.js`
Expected: FAIL —— `rows.first().locator('.log-path')` 期望 `'/second'`，实际为 `'/first'`（当前最新在底部）。headed 窗口会自动打开，属正常。

---

### Task 2: 实现倒序渲染（renderLogsInitial + appendLog）

**Files:**
- Modify: `public/app.js:514-527`（`renderLogsInitial`）
- Modify: `public/app.js:529-544`（`appendLog`）

**Interfaces:**
- Consumes: `visibleLogs()` 返回的正序数组、`renderLogEntry(entry)` 返回 DOM 节点（均不变）
- Produces: 渲染契约 —— `#logsBody` 第一行恒为最新日志；`state.autoScroll` 为 true 时新日志到达后 `scrollTop = 0`

- [ ] **Step 1: 修改 `renderLogsInitial()` 初始渲染为倒序**

`public/app.js` 中把：

```js
  } else {
    for (const e of vis) els.logsBody.appendChild(renderLogEntry(e));
  }
  updateLogsCount();
  if (state.autoScroll) els.logsBody.scrollTop = els.logsBody.scrollHeight;
```

改为：

```js
  } else {
    // 倒序渲染：最新请求显示在列表顶部
    for (let i = vis.length - 1; i >= 0; i--) els.logsBody.appendChild(renderLogEntry(vis[i]));
  }
  updateLogsCount();
  if (state.autoScroll) els.logsBody.scrollTop = 0;
```

- [ ] **Step 2: 修改 `appendLog()` SSE 新条目为顶部插入**

`public/app.js` 中把：

```js
    els.logsBody.appendChild(renderLogEntry(entry));
    if (state.autoScroll) els.logsBody.scrollTop = els.logsBody.scrollHeight;
```

改为：

```js
    els.logsBody.prepend(renderLogEntry(entry));
    if (state.autoScroll) els.logsBody.scrollTop = 0;
```

注意：`appendLog` 内移除空状态占位符的注释（"appears at the top of the log list…"，app.js:535-537）保留不动 —— 语义恰好与新行为一致。

- [ ] **Step 3: 运行 Task 1 的测试，确认通过**

Run: `pnpm playwright test test/e2e/logs-order.spec.js`
Expected: PASS（1 passed）

---

### Task 3: 同步 embed-assets + 全量回归 + 提交

**Files:**
- Sync: `embed-assets/public/app.js`（由 `public/app.js` 覆盖）

**Interfaces:**
- Consumes: Task 2 修改后的 `public/app.js`
- Produces: 与 `public/` 一致的打包副本

- [ ] **Step 1: 同步打包副本（不变量 #5）**

```bash
cp public/app.js embed-assets/public/app.js
diff -q public/app.js embed-assets/public/app.js && echo "副本一致"
```

Expected: 输出 `副本一致`

- [ ] **Step 2: 单元 + 集成回归（后端未动，应全绿）**

Run: `pnpm test`
Expected: 全部 PASS（尤其 `test/unit/log-buffer.test.js` "newest last" 不受影响）

- [ ] **Step 3: 全量 E2E 回归（headed，确认无既有用例依赖旧顺序）**

Run: `pnpm test:e2e`
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add public/app.js embed-assets/public/app.js test/e2e/logs-order.spec.js
git commit -m "feat: 日志按请求时间倒序展示，最新日志固定在列表顶部"
```

---

## Self-Review 记录

- **Spec 覆盖**：倒序渲染 ✓(Task 2 Step 1)、SSE prepend ✓(Task 2 Step 2)、autoScroll 翻转两处 ✓(Task 2 两步各一处)、E2E 新断言 ✓(Task 1)、现有 E2E 顺序依赖排查 ✓(Global Constraints 已记录结论：无)、单元/集成不变 ✓(Task 3 Step 2)、embed-assets 同步 ✓(Task 3 Step 1)。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **一致性**：helper 名称与 `test/e2e/helpers.js` 导出一致（`newEndpoint` 参数为 `{ method, port, path }` 单对象）；选择器 `.log-path` 与 `renderLogEntry`（app.js:378,385）一致。
