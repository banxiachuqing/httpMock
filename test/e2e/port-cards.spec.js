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

  // .toggle 是自定义开关（input 被 pointer-events:none 隐藏），点击目标是 label
  await page.locator('.port-card[data-port="17404"] .port-card-toggle').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.port-card[data-port="17404"]')).toHaveAttribute('data-enabled', 'false');

  const status = await page.evaluate(async () => {
    await fetch('/api/runtime/start', { method: 'POST' });
    return (await fetch('/api/runtime/status')).json();
  });
  expect(status['17404']).toBeUndefined();
});