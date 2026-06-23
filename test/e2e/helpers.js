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

export function hitMock(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
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
