import { test, expect } from '@playwright/test';
import net from 'node:net';
import dgram from 'node:dgram';
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

test('UDP 端口详情页为抓包视图：无接口侧栏/编辑器，日志区可见', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 19101, type: 'udp' }),
    });
  });

  await page.goto(`${server.baseURL}/#/port/19101`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#portHeader:not([hidden])');

  await expect(page.locator('#sidebarPanel')).toBeHidden();
  await expect(page.locator('#editor')).toBeHidden();
  await expect(page.locator('#logsPanel')).toBeVisible();
  await expect(page.locator('#portHeaderNumber')).toHaveText(':19101');
});

test('TCP 抓包数据出现在日志流，详情可切换 hex/文本', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 19102, type: 'tcp' }),
    });
    await fetch('/api/runtime/start', { method: 'POST' });
  });

  const s = net.connect(19102, '127.0.0.1');
  await new Promise((res) => s.once('connect', res));
  s.write('hello tcp');
  await new Promise((r) => setTimeout(r, 500)); // 等空闲聚合 flush

  await page.goto(`${server.baseURL}/#/port/19102`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const row = page.locator('.log-entry.capture', { hasText: '接收' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('TCP');
  await row.click();

  await expect(page.locator('#logDetailPayload')).toHaveText('68 65 6c 6c 6f 20 74 63 70');
  await page.click('#logDetailTextBtn');
  await expect(page.locator('#logDetailPayload')).toHaveText('hello tcp');
  await page.click('#logDetailClose');
  s.end();
});

test('UDP 抓包数据出现在日志流', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 19103, type: 'udp' }),
    });
    await fetch('/api/runtime/start', { method: 'POST' });
  });

  const client = dgram.createSocket('udp4');
  await new Promise((res, rej) => client.send('hello udp', 19103, '127.0.0.1', (e) => (e ? rej(e) : res())));
  client.close();
  await new Promise((r) => setTimeout(r, 300));

  await page.goto(`${server.baseURL}/#/port/19103`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const row = page.locator('.log-entry.capture', { hasText: '接收' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('UDP');
});
