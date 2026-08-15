import { test, expect } from '@playwright/test';
import { bootServer, enterPortDetail } from './helpers.js';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

async function setTheme(page, value) {
  await page.click('#settingsBtn');
  await page.selectOption('#settingsTheme', value);
  await page.click('#settingsSave');
  await page.waitForSelector('#settingsModal', { state: 'hidden' });
}

async function setupPortWithEndpoint(page, port) {
  await page.evaluate(async (p) => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: p }),
    });
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: p, method: 'GET', path: '/api/theme', statusCode: 200, response: { ok: 1 } }),
    });
  }, port);
}

test('设置面板切换亮色/暗色并写入缓存，编辑器实时联动', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await setTheme(page, 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('mockserver.theme'))).toBe('light');

  // CodeMirror 只在详情页挂载：进入端口详情，断言亮色下 gutter 边框为亮色值
  await setupPortWithEndpoint(page, 17601);
  await enterPortDetail(page, server.baseURL, 17601);
  await page.locator('.endpoint-item').first().dispatchEvent('click');
  await expect(page.locator('.cm-gutters')).toHaveCount(1);

  const gutterBorder = await page.evaluate(() => {
    const g = document.querySelector('.cm-gutters');
    return g ? getComputedStyle(g).borderRightColor : null;
  });
  expect(gutterBorder).toBe('rgba(15, 23, 42, 0.1)'); // 亮色值，证明编辑器联动真实生效

  // 热切换到暗色：已挂载的编辑器应立即变暗（Compartment 热切换）
  await setTheme(page, 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('mockserver.theme'))).toBe('dark');
  const gutterBorderDark = await page.evaluate(() => {
    const g = document.querySelector('.cm-gutters');
    return g ? getComputedStyle(g).borderRightColor : null;
  });
  expect(gutterBorderDark).toBe('rgba(255, 255, 255, 0.08)');
});

test('跟随系统：emulateMedia 切换系统外观时界面跟随', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await setTheme(page, 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('刷新后主题保持（服务端持久化 + 缓存引导）', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await setTheme(page, 'dark');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // 还原为 system，避免影响同文件其他用例与本地状态
  await setTheme(page, 'system');
});