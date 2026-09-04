import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { bootServer } from './helpers.js';

let server;

test.beforeAll(async () => { server = await bootServer(); });
test.afterAll(async () => { if (server) await server.cleanup(); });

// 占用必须从独立 spawn 子进程绑定——否则强制启动的 kill 会误杀测试进程自身
function spawnBlocker(port) {
  return spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'127.0.0.1')`], { stdio: 'ignore' });
}

async function api(path, opts) {
  const r = await fetch(`${server.baseURL}${path}`, opts);
  if (r.status === 204) return null; // DELETE 等无响应体
  return r.json();
}
async function waitOccupied(port) {
  for (let i = 0; i < 50; i++) {
    const j = await api(`/api/ports/${port}/occupier`).catch(() => ({}));
    if (j.occupied) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('子进程未及时占用端口 ' + port);
}

test('启动时端口被占用：弹窗提示，强制启动 kill 占用进程后端口转 running', async ({ page }) => {
  const blocker = spawnBlocker(18010);
  try {
    await waitOccupied(18010);
    await api('/api/ports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 18010 }) });

    await page.goto(server.baseURL, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    await page.click('#startStopBtn'); // 启动 → 18010 EADDRINUSE → 弹窗

    const modal = page.locator('#portStartFailModal');
    await expect(modal).toBeVisible({ timeout: 5000 });
    const row = modal.locator('.start-fail-row[data-port="18010"]');
    await expect(row).toBeVisible();
    await expect(row.locator('.fail-reason')).toContainText('被占用');
    await expect(row.locator('.occupier-info')).toContainText('PID');
    await expect(row.locator('.force-start-btn')).toBeVisible();

    await row.locator('.force-start-btn').click();
    // 全部解决 → 弹窗关闭；端口转 running
    await expect(modal).toBeHidden({ timeout: 5000 });
    const status = await api('/api/runtime/status');
    expect(status['18010']?.state).toBe('running');
  } finally {
    blocker.kill('SIGKILL');
  }
});

test('启动时端口被占用：弹窗内改号后新端口生效', async ({ page }) => {
  const blocker = spawnBlocker(18020);
  try {
    await waitOccupied(18020);
    await api('/api/ports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 18020 }) });

    await page.goto(server.baseURL, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    await page.click('#startStopBtn');

    const modal = page.locator('#portStartFailModal');
    await expect(modal).toBeVisible({ timeout: 5000 });
    const row = modal.locator('.start-fail-row[data-port="18020"]');
    await row.locator('.rename-input').fill('18021');
    await row.locator('.rename-btn').click();
    // 改号后重试启动成功 → 弹窗关闭；新端口 running，旧端口已不存在
    await expect(modal).toBeHidden({ timeout: 5000 });
    const status = await api('/api/runtime/status');
    expect(status['18021']?.state).toBe('running');
    const ports = await api('/api/ports');
    expect(ports.some((p) => p.port === 18021)).toBe(true);
    expect(ports.some((p) => p.port === 18020)).toBe(false);
  } finally {
    blocker.kill('SIGKILL');
  }
});

// 特权端口（<1024）EACCES：无进程可 kill，只给改号、不给强制启动。需非 root 才能复现。
test('启动时特权端口（EACCES）：只给改号，不显示强制启动', async ({ page }) => {
  test.skip(process.getuid?.() === 0, '需要非 root 才能复现特权端口 EACCES');
  await api('/api/ports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 1 }) });

  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('#startStopBtn');

  const modal = page.locator('#portStartFailModal');
  await expect(modal).toBeVisible({ timeout: 5000 });
  const row = modal.locator('.start-fail-row[data-port="1"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.fail-reason')).toContainText('特权端口');
  await expect(row.locator('.force-start-btn')).toHaveCount(0); // 特权端口不可强制启动
  await expect(row.locator('.rename-input')).toBeVisible();

  // 清理：停止引擎并删除特权端口，避免影响其他用例
  await api('/api/runtime/stop', { method: 'POST' });
  await api('/api/ports/1', { method: 'DELETE' });
});
