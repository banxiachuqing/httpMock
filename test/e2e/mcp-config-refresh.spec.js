import { test, expect } from '@playwright/test';
import { bootServer } from './helpers.js';

let server;

test.beforeAll(async () => { server = await bootServer(); });
test.afterAll(async () => { if (server) await server.cleanup(); });

// MCP / curl / 另一标签页等外部来源修改配置（REST），页面不刷新应自动跟随：
// 后端在配置变更时经 /events 广播 config 事件，前端监听后 refreshAll。
test('外部 REST 建端口后，首页卡片无需手动刷新自动出现', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  // 外部修改：不经页面 UI，直接打 REST（与 MCP tools/call 同一链路）
  const res = await page.request.post(`${server.baseURL}/api/ports`, {
    data: { port: 17301 },
  });
  expect(res.status()).toBe(201);

  // 不 reload —— 等 SSE config 事件触发的自动刷新把新卡片渲染出来
  const card = page.locator('.port-card[data-port="17301"]');
  await expect(card).toBeVisible({ timeout: 5000 });
});

test('外部 REST 建端点后，端口详情页侧栏自动出现', async ({ page }) => {
  await page.request.post(`${server.baseURL}/api/ports`, { data: { port: 17302 } });
  await page.goto(`${server.baseURL}/#/port/17302`, { waitUntil: 'load' });
  await page.waitForSelector('#portHeader:not([hidden])');

  // 外部（模拟 MCP create_endpoint）创建端点
  const res = await page.request.post(`${server.baseURL}/api/endpoints`, {
    data: { port: 17302, method: 'GET', path: '/from-mcp', statusCode: 200, response: { ok: 1 } },
  });
  expect(res.status()).toBe(201);

  const item = page.locator(`.endpoint-item:has-text("/from-mcp")`);
  await expect(item).toBeVisible({ timeout: 5000 });
});

test('首页视图下外部删除端口，卡片自动消失', async ({ page }) => {
  await page.request.post(`${server.baseURL}/api/ports`, { data: { port: 17304 } });
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await expect(page.locator('.port-card[data-port="17304"]')).toBeVisible({ timeout: 5000 });

  const res = await page.request.delete(`${server.baseURL}/api/ports/17304`);
  expect(res.status()).toBe(204);

  await expect(page.locator('.port-card[data-port="17304"]')).toHaveCount(0, { timeout: 5000 });
});
