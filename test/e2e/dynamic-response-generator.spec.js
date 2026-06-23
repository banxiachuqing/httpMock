import { test, expect } from '@playwright/test';
import { bootServer, hitMock } from './helpers.js';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.beforeEach(async ({ page }) => {
  // 共享 server 需在每个 test 前清空端点和 mock
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    // 清空所有端点
    const list = await (await fetch('/api/endpoints')).json();
    for (const ep of list) await fetch(`/api/endpoints/${ep.id}`, { method: 'DELETE' });
    // 停止 mock 引擎（如果运行）
    await fetch('/api/runtime/stop', { method: 'POST' }).catch(() => {});
  });
  await page.waitForTimeout(300);
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('happy path: live preview shows resolved UUID + serve returns real UUID', async ({ page }) => {
  // beforeEach 已经访问页面 + 清空端点
  // 直接创建带正确响应的端点（PUT 需要完整 body，绕开）
  await page.evaluate(async () => {
    await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'GET', port: 19501, path: '/dyn1', statusCode: 200,
        response: { id: '{{$uuid}}' },
      }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.locator('.endpoint-item').first().dispatchEvent('click');
  await expect(page.locator('#editorForm')).toBeVisible();
  await page.waitForTimeout(500);

  // 等预览刷新（防抖 300ms）
  await page.waitForTimeout(500);

  // 验证预览面板含 UUID
  const previewText = await page.locator('#previewPane').textContent();
  expect(previewText).toMatch(/"id":\s*"[0-9a-f-]{36}"/);

  // 启动 mock 引擎
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(800);

  // 验证 mock 端口返回的 body 含真 UUID
  const res = await hitMock(19501, '/dyn1');
  const body = JSON.parse(res.body);
  expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
});

test('number expression preserves type (no quotes around int)', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  await page.evaluate(async () => {
    await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'GET', port: 19502, path: '/n', statusCode: 200,
        response: { age: '{{$int:42:42}}' },
      }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.locator('.endpoint-item').first().dispatchEvent('click');
  await expect(page.locator('#editorForm')).toBeVisible();

  await page.waitForTimeout(500);
  const previewText = await page.locator('#previewPane').textContent();
  expect(previewText).toMatch(/"age":\s*42/);
  expect(previewText).not.toMatch(/"age":\s*"42"/);

  // 启动 mock 验证服务时也保持 number 类型
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(800);
  const res = await hitMock(19502, '/n');
  expect(res.body).toBe('{"age":42}');
});

test('JSON syntax error keeps last good preview + shows banner', async ({ page }) => {
  await page.evaluate(async () => {
    await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'GET', port: 19503, path: '/err', statusCode: 200,
        response: { ok: true },
      }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.locator('.endpoint-item').first().dispatchEvent('click');
  await expect(page.locator('#editorForm')).toBeVisible();

  // 等首次预览渲染
  await page.waitForTimeout(500);
  const firstPreview = await page.locator('#previewPane').textContent();
  expect(firstPreview).toContain('"ok"');

  // 编辑器内破坏 JSON
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('{ broken');

  await page.waitForTimeout(500);
  // banner 应可见
  await expect(page.locator('#previewBanner')).toBeVisible();
  // 预览面板保留上次成功
  const stillThere = await page.locator('#previewPane').textContent();
  expect(stillThere).toContain('"ok"');
});

test('end-to-end serve: dynamic UUID appears in real mock response', async ({ page }) => {
  await page.evaluate(async () => {
    await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'GET', port: 19504, path: '/e2e', statusCode: 200,
        response: { id: '{{$uuid}}' },
      }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.locator('.endpoint-item').first().dispatchEvent('click');
  await expect(page.locator('#editorForm')).toBeVisible();
  await page.waitForTimeout(300);

  // 启动 mock
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(800);

  const r1 = await hitMock(19504, '/e2e');
  const r2 = await hitMock(19504, '/e2e');
  const b1 = JSON.parse(r1.body);
  const b2 = JSON.parse(r2.body);
  expect(b1.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(b2.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(b1.id).not.toBe(b2.id);
});
