import { test, expect } from '@playwright/test';
import { bootServer } from './helpers.js';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('设置面板勾选 MCP Server 后展示具体接入参数（地址 = 当前访问 host）并可保存', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  // 打开设置：未勾选时示例区隐藏
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal:not([hidden])');
  await expect(page.locator('#settingsMcpExample')).toBeHidden();

  // 勾选 → 示例区出现，地址 = 当前浏览器访问的 host（uiPort: 0 → 随机端口）。
  // 注意：.toggle 的 checkbox 是视觉隐藏样式（pointer-events: none），点击走 label 转发
  await page.click('label[for="settingsMcp"]');
  await expect(page.locator('#settingsMcp')).toBeChecked();
  await expect(page.locator('#settingsMcpExample')).toBeVisible();
  const expectedUrl = `http://${new URL(server.baseURL).host}/mcp`;
  await expect(page.locator('#settingsMcpUrl')).toHaveText(expectedUrl);
  await expect(page.locator('#settingsMcpSnippet')).toContainText(expectedUrl);
  await expect(page.locator('#settingsMcpSnippet')).toContainText('"mock-tools"');

  // 取消勾选 → 示例区再次隐藏
  await page.click('label[for="settingsMcp"]');
  await expect(page.locator('#settingsMcp')).not.toBeChecked();
  await expect(page.locator('#settingsMcpExample')).toBeHidden();

  // 勾选并保存 → 状态落库（重开设置面板仍勾选且示例地址正确）
  await page.click('label[for="settingsMcp"]');
  await page.click('#settingsSave');
  await page.waitForSelector('#settingsModal', { state: 'hidden' });
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal:not([hidden])');
  await expect(page.locator('#settingsMcp')).toBeChecked();
  await expect(page.locator('#settingsMcpExample')).toBeVisible();
  await expect(page.locator('#settingsMcpUrl')).toHaveText(expectedUrl);

  // 服务端真实生效：/mcp 端点已可用
  const res = await page.evaluate(async () => {
    const r = await fetch('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    });
    return r.status;
  });
  expect(res).toBe(200);
});
