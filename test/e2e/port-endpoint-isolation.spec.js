import { test, expect } from '@playwright/test';
import { bootServer, enterPortDetail } from './helpers.js';

// 回归：端口详情页的接口侧栏必须只显示当前端口的接口。
// 曾有的 bug：renderEndpointList 遍历跨端口全量 state.endpoints，未按 state.route.port
// 过滤，导致在 1000 端口详情页看到（并误删）9000 端口的接口。
let server;

test.beforeAll(async () => { server = await bootServer(); });
test.afterAll(async () => { if (server) await server.cleanup(); });

test('详情页接口侧栏只显示当前端口的接口', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  // 9000 端口建两个接口；1000 端口为空
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 9000 }),
    });
    for (const path of ['/a', '/b']) {
      await fetch('/api/endpoints', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 9000, method: 'GET', path, statusCode: 200, response: {} }),
      });
    }
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 1000 }),
    });
  });

  // 进入 1000 详情页：侧栏应为空（修复前会错误显示 9000 的两个接口）
  await enterPortDetail(page, server.baseURL, 1000);
  await expect(page.locator('.endpoint-item')).toHaveCount(0);
  await expect(page.locator('#endpointCount')).toHaveText('0');

  // 进入 9000 详情页：仍是那两个接口
  await enterPortDetail(page, server.baseURL, 9000);
  await expect(page.locator('.endpoint-item')).toHaveCount(2);
  await expect(page.locator('#endpointCount')).toHaveText('2');
  const paths = await page.locator('.endpoint-item .endpoint-path').allTextContents();
  expect([...paths].sort()).toEqual(['/a', '/b']);
});

test('跨端口切换后编辑器选中当前端口接口，不再残留其他端口', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  // 自包含数据：9001 有一个接口 /x；1001 为空
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 9001 }),
    });
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 9001, method: 'GET', path: '/x', statusCode: 200, response: {} }),
    });
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 1001 }),
    });
  });

  // 直接进入 9001：编辑器应自动选中 9001 的接口
  await enterPortDetail(page, server.baseURL, 9001);
  await expect(page.locator('#editorForm')).toBeVisible();
  await expect(page.locator('#path')).toHaveValue('/x');

  // 切到 1001：无接口 → 编辑器显示空态，不得残留 9001 的接口
  await enterPortDetail(page, server.baseURL, 1001);
  await expect(page.locator('#editorForm')).toBeHidden();
  await expect(page.locator('#editorEmpty')).toBeVisible();
});
