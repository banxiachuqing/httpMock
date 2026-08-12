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
