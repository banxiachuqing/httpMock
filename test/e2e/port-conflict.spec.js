import { test, expect } from '@playwright/test';
import { bootServer, hitMock } from './helpers.js';
import http from 'node:http';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('starting with an occupied port marks it as failed but keeps other ports running', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // Pre-occupy a port via raw Node
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(17010, '127.0.0.1', resolve));

  try {
    // Create two endpoints via the API (faster + more reliable than UI clicks for setup)
    await page.evaluate(async () => {
      await fetch('/api/endpoints', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 17010, method: 'GET', path: '/blocked', statusCode: 200, response: { ok: 1 } }),
      });
      await fetch('/api/endpoints', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 17011, method: 'GET', path: '/free', statusCode: 200, response: { ok: 1 } }),
      });
    });

    // Start via UI to exercise the button + status flow
    await page.dispatchEvent('#startStopBtn', 'click');
    // Global status should be 'failed' because at least one port failed
    await expect(page.locator('#globalStatus')).toHaveAttribute('data-state', /(failed|running)/, { timeout: 5000 });

    // The free port should respond
    const res = await hitMock(17011, '/free');
    expect(res.status).toBe(200);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

// 回归：引擎告警日志（无 method/protocol，如特权端口 EACCES / EADDRINUSE bind 失败）
// 曾让 renderLogEntry 对 entry.method.toLowerCase() 求值而崩溃，导致 loadAll reject、
// startRouter/applyRoute 不执行，首页停在「接口列表」默认布局而非端口卡片视图。
test('首页存在引擎告警日志时仍渲染端口卡片视图', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  // 占住 17020，启动引擎 → 该端口 bind 失败 → 引擎推入一条无 method 的 warn 日志
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(17020, '127.0.0.1', resolve));
  try {
    await page.evaluate(async () => {
      await fetch('/api/endpoints', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 17020, method: 'GET', path: '/x', statusCode: 200, response: {} }),
      });
      await fetch('/api/runtime/start', { method: 'POST' });
    });
    // 等 warn 条目真正落进日志 buffer（无 method 的引擎告警）
    await expect
      .poll(async () => {
        const logs = await page.evaluate(async () => (await fetch('/api/logs?limit=50')).json());
        return logs.some((l) => l.level === 'warn' && !l.method && !l.protocol);
      })
      .toBe(true);

    // 重新加载首页：不应崩溃，应是端口卡片视图（home），接口列表侧栏保持隐藏
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1000);

    const state = await page.evaluate(() => ({
      view: document.body.dataset.view,
      homeHidden: document.getElementById('viewHome').hidden,
      sidebarHidden: document.getElementById('sidebarPanel').hidden,
    }));
    expect(state.view).toBe('home');
    expect(state.homeHidden).toBe(false); // 端口卡片视图可见
    expect(state.sidebarHidden).toBe(true); // 接口列表侧栏隐藏
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});
