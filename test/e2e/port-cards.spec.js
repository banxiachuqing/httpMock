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
  // 名称行是第一行（未命名 → 自动默认名 API-N）
  await expect(card.locator('.port-card-name')).toHaveText(/^API-\d+$/);
  // 接口数在「接口」行（名称行之上新增了名称，不能再用 .first() 取 dd）
  const epCount = card
    .locator('.port-card-stats > div')
    .filter({ has: page.locator('dt', { hasText: '接口' }) })
    .locator('dd');
  await expect(epCount).toHaveText('1 个');
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

test('顶栏「N 个端口已上线」按真实运行状态计数：禁用端口不计入', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    for (const port of [17701, 17702]) {
      await fetch('/api/ports', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await fetch('/api/endpoints', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port, method: 'GET', path: '/x', statusCode: 200, response: {} }),
      });
    }
    await fetch('/api/runtime/stop', { method: 'POST' });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  // 取消勾选 17702 的启用 → 点右上角启动（复刻用户操作路径）
  await page.locator('.port-card[data-port="17702"] .port-card-toggle').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.port-card[data-port="17702"]')).toHaveAttribute('data-enabled', 'false');
  await page.click('#startStopBtn');

  await expect(page.locator('#globalStatus')).toHaveAttribute('data-state', 'running');
  // 期望值取引擎权威状态（全套跑时其他测试的端口也在运行，顶栏是全局计数）：
  // 17702 已禁用不在 status 中，UI 文字必须与真实 running 数一致而非按接口列表统计
  const expected = await page.evaluate(async () => {
    const status = await (await fetch('/api/runtime/status')).json();
    return Object.values(status).filter((s) => s.state === 'running').length;
  });
  await expect(page.locator('#statusDetail')).toHaveText(`${expected} 个端口已上线`);
});

test('卡片编辑弹窗：一次改号改名，接口级联迁移', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17801, name: '原名' }),
    });
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17801, method: 'GET', path: '/api/x', statusCode: 200, response: {} }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await page.locator('.port-card[data-port="17801"] .port-card-edit').click();
  await expect(page.locator('#editPortModal')).toBeVisible();
  // 弹窗预填当前值
  await expect(page.locator('#editPortName')).toHaveValue('原名');
  await expect(page.locator('#editPortNumber')).toHaveValue('17801');

  await page.fill('#editPortName', '订单网关');
  await page.fill('#editPortNumber', '17802');
  await page.click('#editPortSave');

  // 卡片更新为新号新名，旧卡片消失
  await expect(page.locator('.port-card[data-port="17802"] .port-card-name')).toHaveText('订单网关');
  await expect(page.locator('.port-card[data-port="17801"]')).toHaveCount(0);
  // 接口级联迁移到新端口（共享服务器下只断言本端口两端）
  const eps = await page.evaluate(async () => (await fetch('/api/endpoints')).json());
  expect(eps.some((e) => e.port === 17802)).toBe(true);
  expect(eps.every((e) => e.port !== 17801)).toBe(true);
});

test('卡片编辑：名称留空则重新生成默认名', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17803, name: '旧' }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await page.locator('.port-card[data-port="17803"] .port-card-edit').click();
  await page.fill('#editPortName', '');
  await page.click('#editPortSave');

  await expect(page.locator('.port-card[data-port="17803"] .port-card-name')).toHaveText(/^API-\d+$/);
});

test('卡片删除：确认后端口与接口一并删除', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17804 }),
    });
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17804, method: 'GET', path: '/x', statusCode: 200, response: {} }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await page.locator('.port-card[data-port="17804"] .port-card-delete').click();
  // 确认弹窗提示级联删除的接口数
  await expect(page.locator('.modal-confirm-body')).toContainText('1 个接口');
  await page.click('.modal-confirm .btn-danger');

  await expect(page.locator('.port-card[data-port="17804"]')).toHaveCount(0);
  const [ports, eps] = await page.evaluate(async () => Promise.all([
    (await fetch('/api/ports')).json(),
    (await fetch('/api/endpoints')).json(),
  ]));
  expect(ports.map((p) => p.port)).not.toContain(17804);
  expect(eps.filter((e) => e.port === 17804)).toHaveLength(0);
});

test('卡片删除：取消则端口保留', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  expect((await createPort(page, 17805)).status).toBe(201);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await page.locator('.port-card[data-port="17805"] .port-card-delete').click();
  await page.click('.modal-confirm .btn-ghost');

  await expect(page.locator('.port-card[data-port="17805"]')).toHaveCount(1);
});

test('卡片显示端口自定义名称行，置于接口行之上', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17601, name: '支付网关' }),
    });
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17601, method: 'GET', path: '/pay', statusCode: 200, response: {} }),
    });
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const card = page.locator('.port-card[data-port="17601"]');
  await expect(card.locator('.port-card-name')).toHaveText('支付网关');
  // 名称行是 stats 第一行（在「接口」行之上）
  await expect(card.locator('.port-card-stats > div').first().locator('dt')).toHaveText('名称');
});

test('弹窗新建端口：填写名称则在详情页页头显示', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.click('#newPortCard');
  await page.fill('#newPortName', '会员服务');
  await page.fill('#newPortNumber', '17602');
  await page.click('#newPortCreate');
  await page.waitForSelector('#portHeader:not([hidden])');
  expect(page.url()).toContain('#/port/17602');
  await expect(page.locator('#portHeaderName')).toHaveText('会员服务');
});

test('弹窗新建端口：名称留空则自动生成默认名', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.click('#newPortCard');
  await page.fill('#newPortNumber', '17603');
  await page.click('#newPortCreate');
  await page.waitForSelector('#portHeader:not([hidden])');
  expect(page.url()).toContain('#/port/17603');
  await expect(page.locator('#portHeaderName')).toHaveText(/^API-\d+$/);
});