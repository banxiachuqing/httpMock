import { test, expect } from '@playwright/test';
import { bootServer } from './helpers.js';

let server;

test.beforeAll(async () => { server = await bootServer(); });
test.afterAll(async () => { if (server) await server.cleanup(); });

test('新建 TCP 抓包端口：弹窗选型 + 卡片徽标与统计', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await page.click('#newPortCard');
  await expect(page.locator('#newPortModal')).toBeVisible();
  await page.check('input[name="newPortType"][value="tcp"]');
  await page.fill('#newPortNumber', '19100');
  await page.click('#newPortCreate');

  await page.waitForSelector('#portHeader:not([hidden])');
  expect(page.url()).toContain('#/port/19100');

  await page.goto(`${server.baseURL}/#/`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const card = page.locator('.port-card[data-port="19100"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.port-type-badge')).toHaveText('TCP');
  await expect(card.locator('.port-card-stats dd').first()).toHaveText('TCP 抓包');
});
