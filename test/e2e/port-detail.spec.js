import { test, expect } from '@playwright/test';
import { bootServer, hitMock, enterPortDetail } from './helpers.js';

let server;

test.beforeAll(async () => { server = await bootServer(); });
test.afterAll(async () => { if (server) await server.cleanup(); });

async function setup(page, port, epPath = '/api/x') {
  await page.evaluate(async ({ port, epPath }) => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port, method: 'GET', path: epPath, statusCode: 200, response: { ok: 1 } }),
    });
  }, { port, epPath });
}

test('新建接口时端口字段只读且为当前端口', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17501);
  await enterPortDetail(page, server.baseURL, 17501);

  await page.click('#newEndpointBtn');
  await expect(page.locator('#port')).toBeDisabled();
  await expect(page.locator('#port')).toHaveValue('17501');
});

test('新建接口默认响应体为统一信封（code/msg/data/success）', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17509);
  await enterPortDetail(page, server.baseURL, 17509);

  await page.click('#newEndpointBtn');
  // 默认信封是产品约定：改回 {ok:true} 等旧值时必须失败。
  // createEndpoint 是异步的（POST 完成后才渲染编辑器），用自动重试断言避免竞态
  await expect(page.locator('.cm-content')).toContainText('"code": 200');
  await expect(page.locator('.cm-content')).toContainText('"msg": "操作成功"');
  await expect(page.locator('.cm-content')).toContainText('"data": null');
  await expect(page.locator('.cm-content')).toContainText('"success": true');
});

test('接口名称显示在列表，留空回落 URL', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17502);
  await enterPortDetail(page, server.baseURL, 17502);

  await page.locator('.endpoint-item').first().dispatchEvent('click');
  // 未填名称 → 名称行显示 METHOD path
  await expect(page.locator('.endpoint-item .endpoint-name').first()).toHaveText('GET /api/x');

  await page.fill('#endpointName', '查询接口');
  await page.click('#saveBtn');
  await expect(page.locator('.endpoint-item .endpoint-name').first()).toHaveText('查询接口');

  // 清空名称 → 回落
  await page.fill('#endpointName', '');
  await page.click('#saveBtn');
  await expect(page.locator('.endpoint-item .endpoint-name').first()).toHaveText('GET /api/x');
});

test('详情页日志只显示本端口', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17503, '/a');
  await setup(page, 17504, '/b');
  await page.evaluate(async () => {
    await fetch('/api/runtime/start', { method: 'POST' });
  });
  await hitMock(17503, '/a');
  await hitMock(17504, '/b');

  await enterPortDetail(page, server.baseURL, 17503);
  const rows = page.locator('#logsBody .log-entry');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.log-port')).toHaveText('17503');
  await expect(page.locator('#logsCount')).toContainText('1 条 / 共 2 条');
});

test('改端口号级联更新接口并更新 hash', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17505);
  await enterPortDetail(page, server.baseURL, 17505);

  await page.fill('#portNumberInput', '17506');
  await page.click('#portRenameBtn');

  // 改号是异步的；header 本来就可见，等 URL 变化而不是 header
  await page.waitForURL(/#\/port\/17506/, { timeout: 5000 });
  expect(page.url()).toContain('#/port/17506');
  const ports = await page.evaluate(async () => (await fetch('/api/ports')).json());
  expect(ports.map((p) => p.port)).toContain(17506);
  const eps = await page.evaluate(async () => (await fetch('/api/endpoints')).json());
  // 共享服务器下其它测试的端点仍在；只断言改号端口的级联结果
  expect(eps.some((e) => e.port === 17506)).toBe(true);
  expect(eps.every((e) => e.port !== 17505)).toBe(true);
});

test('删除端口连带删除接口并回到首页', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17507);
  await enterPortDetail(page, server.baseURL, 17507);

  page.once('dialog', (d) => {
    expect(d.message()).toContain('1 个接口');
    d.accept();
  });
  await page.click('#deletePortBtn');

  await page.waitForSelector('#viewHome:not([hidden])');
  const ports = await page.evaluate(async () => (await fetch('/api/ports')).json());
  expect(ports.map((p) => p.port)).not.toContain(17507);
  const eps = await page.evaluate(async () => (await fetch('/api/endpoints')).json());
  expect(eps.filter((e) => e.port === 17507)).toHaveLength(0);
});

test('操作按钮在编辑区顶部，删除在最右', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17508);
  await enterPortDetail(page, server.baseURL, 17508);
  await page.locator('.endpoint-item').first().dispatchEvent('click');

  // 意图 1+2：保存/删除落在顶部 .editor-header 区域内，且删除在保存右侧
  const headerBox = await page.locator('#editorForm .editor-header').boundingBox();
  const saveBox = await page.locator('#saveBtn').boundingBox();
  const deleteBox = await page.locator('#deleteBtn').boundingBox();
  expect(headerBox).toBeTruthy();
  expect(saveBox.y).toBeGreaterThanOrEqual(headerBox.y);
  expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
  expect(deleteBox.y).toBeGreaterThanOrEqual(headerBox.y);
  expect(deleteBox.y + deleteBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
  expect(deleteBox.x).toBeGreaterThan(saveBox.x);

  // 意图 3：HTTP 底部按钮条已移除（限定 #editorForm，WS 表单共用 .editor-form 类）
  await expect(page.locator('#editorForm > .editor-footer')).toHaveCount(0);

  // 意图 4：撤销按钮已从 HTTP 页移除（spec 2026-08-17 §5；WS 页 wsRevertBtn 不受影响）
  await expect(page.locator('#editorForm #revertBtn')).toHaveCount(0);
});

test('复制接口：-copy 避撞、插入源后方并选中、响应体同源', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async (port) => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        port, method: 'GET', path: '/api/orig', statusCode: 200,
        name: '原接口', response: { marker: 42 },
      }),
    });
  }, 17510);
  await enterPortDetail(page, server.baseURL, 17510);

  // 列表是全局混排（含其它用例的端点），按路径精确定位本用例的项
  const itemByPath = (p) =>
    page.locator('.endpoint-item').filter({ has: page.locator(`.endpoint-path:text-is("${p}")`) });

  // 第一次复制：路径 -copy 避撞，名称加 (副本)，插入源正后方并选中
  await itemByPath('/api/orig').hover();
  await itemByPath('/api/orig').locator('.endpoint-copy').click();
  await expect(itemByPath('/api/orig-copy')).toHaveCount(1);
  await expect(itemByPath('/api/orig-copy').locator('.endpoint-name')).toHaveText('原接口 (副本)');
  await expect(itemByPath('/api/orig-copy')).toHaveClass(/selected/);
  await expect(page.locator('.cm-content')).toContainText('"marker": 42');
  // 插入源正后方
  const paths = await page.locator('.endpoint-item .endpoint-path').allTextContents();
  expect(paths[paths.indexOf('/api/orig') + 1]).toBe('/api/orig-copy');

  // 第二次复制：-copy 已占用，避撞到 -copy-2
  await itemByPath('/api/orig').hover();
  await itemByPath('/api/orig').locator('.endpoint-copy').click();
  await expect(itemByPath('/api/orig-copy-2')).toHaveCount(1);
});

test('拖拽排序：换序即时生效且刷新后保持', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async (port) => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    for (const path of ['/api/a', '/api/b']) {
      await fetch('/api/endpoints', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port, method: 'GET', path, statusCode: 200, response: {} }),
      });
    }
  }, 17511);
  await enterPortDetail(page, server.baseURL, 17511);

  // 列表全局混排，按路径定位；断言 a/b 相对顺序（初始 a 在前）
  const itemByPath = (p) =>
    page.locator('.endpoint-item').filter({ has: page.locator(`.endpoint-path:text-is("${p}")`) });
  const orderFlipped = async () => {
    const paths = await page.locator('.endpoint-item .endpoint-path').allTextContents();
    return paths.indexOf('/api/b') < paths.indexOf('/api/a');
  };
  expect(await orderFlipped()).toBe(false);

  // 把 a 拖到 b 的下半区 → a 落到 b 之后
  const box = await itemByPath('/api/b').boundingBox();
  await itemByPath('/api/a').dragTo(itemByPath('/api/b'), {
    targetPosition: { x: box.width / 2, y: box.height - 5 },
  });
  await expect.poll(orderFlipped).toBe(true);

  // 刷新后顺序保持（持久化意图）
  await enterPortDetail(page, server.baseURL, 17511);
  await expect.poll(orderFlipped).toBe(true);
});
