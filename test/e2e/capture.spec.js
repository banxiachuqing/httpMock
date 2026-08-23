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
  await page.selectOption('#newPortType', 'tcp');
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

test('Syslog 端口：弹窗预填 514 → 切自定义端口 → dgram 发 RFC 3164 → 行/详情结构化', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  // 新建弹窗 → 选 syslog 类型：断言端口预填 514
  await page.click('#newPortCard');
  await expect(page.locator('#newPortModal')).toBeVisible();
  await page.selectOption('#newPortType', 'syslog');
  await expect(page.locator('#newPortNumber')).toHaveValue('514');
  // 切回其他类型：恢复 nextFreePort（从 8080 起算）
  await page.selectOption('#newPortType', 'http');
  await expect(page.locator('#newPortNumber')).toHaveValue('8080');
  // 再次选 syslog + 改为自定义端口 19514 再创建
  await page.selectOption('#newPortType', 'syslog');
  await expect(page.locator('#newPortNumber')).toHaveValue('514');
  await page.fill('#newPortNumber', '19514');
  await page.click('#newPortCreate');
  await expect(page.locator('#newPortModal')).toBeHidden();
  await page.waitForSelector('#portHeader:not([hidden])');
  expect(page.url()).toContain('#/port/19514');

  // 启动 runtime 并发一条 RFC 3164 datagram（facility=16 local0 / severity=6 info）
  // 启动 runtime 并发一条 RFC 3164 datagram（PRI<126> = facility 15 local0 / severity 6 info）
  await page.evaluate(async () => {
    await fetch('/api/runtime/start', { method: 'POST' });
  });
  const syslogMsg = '<126>Aug 23 14:00:00 mymachine myapp[1234]: link up on eth0';
  const client = dgram.createSocket('udp4');
  await new Promise((res, rej) =>
    client.send(syslogMsg, 19514, '127.0.0.1', (e) => (e ? rej(e) : res()))
  );
  client.close();
  await new Promise((r) => setTimeout(r, 400));

  // 刷新日志流，等实时推送（也可用 reload）
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);

  // 抓包日志行：SYSLOG chip / path = hostname · message 摘要 / 状态列 severity 徽标
  const row = page.locator('.log-entry.capture', { hasText: 'SYSLOG' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('mymachine · link up on eth0');
  await expect(row.locator('.severity-badge')).toHaveText('info');

  // 点击行打开详情弹窗，断言结构化字段表
  await row.click();
  await expect(page.locator('#log-detail')).toBeVisible();
  await expect(page.locator('#logDetailMethod')).toHaveText('SYSLOG');
  // Meta 字段表包含 facility/severity/hostname/应用/进程 ID/对端时间戳/消息
  const metaText = await page.locator('#logDetailMeta').innerText();
  expect(metaText).toContain('Facility');
  expect(metaText).toContain('16');
  expect(metaText).toContain('local0');
  expect(metaText).toContain('Severity');
  expect(metaText).toContain('6');
  expect(metaText).toContain('info');
  expect(metaText).toContain('Hostname');
  expect(metaText).toContain('mymachine');
  expect(metaText).toContain('应用');
  expect(metaText).toContain('myapp');
  expect(metaText).toContain('进程 ID');
  expect(metaText).toContain('1234');
  expect(metaText).toContain('对端时间戳');
  expect(metaText).toContain('Aug 23 14:00:00');
  expect(metaText).toContain('消息');
  expect(metaText).toContain('link up on eth0');
});
