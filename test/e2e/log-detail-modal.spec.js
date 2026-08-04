import { test, expect } from '@playwright/test';
import { bootServer, hitMock, enterPortDetail } from './helpers.js';

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

async function postToMock(page, port, path, body, contentType = 'application/json') {
  return hitMock(port, path, {
    method: 'POST',
    body,
    headers: { 'content-type': contentType },
  });
}

test('click log row → dialog opens with 4 sections', async ({ page }) => {
  await createEndpointViaApi(page, {
    method: 'POST', port: 19601, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await enterPortDetail(page, server.baseURL, 19601);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await postToMock(page, 19601, '/x', '{"a":1}');
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
  await enterPortDetail(page, server.baseURL, 19602);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await postToMock(page, 19602, '/x', '{"hello":"world"}');
  await page.waitForTimeout(500);
  await page.locator('.log-entry').first().click();
  // CodeMirror 渲染
  await expect(page.locator('#logDetailBody .cm-content')).toBeVisible();
  await expect(page.locator('#logDetailBody')).toContainText('"hello"');
});

test('body is rendered as plain text when not JSON', async ({ page }) => {
  await createEndpointViaApi(page, {
    method: 'POST', port: 19603, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await enterPortDetail(page, server.baseURL, 19603);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await postToMock(page, 19603, '/x', 'just plain text', 'text/plain');
  await page.waitForTimeout(500);
  await page.locator('.log-entry').first().click();
  await expect(page.locator('#logDetailBodyPlain')).toBeVisible();
  const plainText = await page.locator('#logDetailBodyPlain').innerText();
  expect(plainText).toContain('just plain text');
});

test('GET with no body shows empty placeholder', async ({ page }) => {
  await createEndpointViaApi(page, {
    method: 'GET', port: 19604, path: '/x', statusCode: 200, response: { ok: true }, enabled: true,
  });
  await enterPortDetail(page, server.baseURL, 19604);
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
  await enterPortDetail(page, server.baseURL, 19605);
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
  await enterPortDetail(page, server.baseURL, 19606);
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
  await enterPortDetail(page, server.baseURL, 19607);
  await page.locator('#startStopBtn').click();
  await page.waitForTimeout(600);

  await postToMock(page, 19607, '/x', 'x'.repeat(50), 'text/plain');
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
