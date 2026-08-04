import { startServer } from '../../server.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

export async function bootServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-e2e-'));
  const handle = await startServer({ storagePath: dir, uiPort: 0, openBrowser: false });
  return {
    handle,
    dir,
    baseURL: `http://127.0.0.1:${handle.port}`,
    cleanup: async () => {
      await handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function hitMock(port, path, opts = {}) {
  const { method = 'GET', body, headers = {} } = opts;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let respBody = '';
      res.on('data', (c) => (respBody += c));
      res.on('end', () => resolve({ status: res.statusCode, body: respBody, headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function enterPortDetail(page, baseURL, port) {
  await page.goto(`${baseURL}/#/port/${port}`, { waitUntil: 'load' });
  // goto 到仅 hash 变化的 URL 不会重新加载页面（loadAll 不重跑），
  // 导致前端状态陈旧（端点/运行状态/预览）。reload 强制全新启动，同时保留 hash。
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.waitForSelector('#portHeader:not([hidden])');
}

export async function newEndpoint(page, { method = 'GET', port, path }) {
  return await page.evaluate(async ({ method, port, path }) => {
    const r = await fetch('/api/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, port, path, response: {} }),
    });
    const ep = await r.json();
    return ep.id;
  }, { method, port, path });
}
