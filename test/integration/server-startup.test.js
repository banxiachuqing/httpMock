import { describe, it, expect, afterEach } from 'vitest';
import { startServer } from '../../server.js';
import { tempDir } from '../helpers/temp-dir.js';
import http from 'node:http';

let handle, dir;

afterEach(async () => {
  if (handle) await handle.close();
  if (dir) dir.cleanup();
});

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startServer', () => {
  it('boots and serves /api/health', async () => {
    dir = tempDir('mock-srv-');
    handle = await startServer({ storagePath: dir.path, uiPort: 0, openBrowser: false });
    const port = handle.port;

    const health = await get(port, '/api/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).ok).toBe(true);
  });

  it('falls back to next port when desired port is occupied', async () => {
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(18100, '127.0.0.1', resolve));
    try {
      dir = tempDir('mock-srv-');
      handle = await startServer({ storagePath: dir.path, uiPort: 18100, openBrowser: false });
      expect(handle.port).toBeGreaterThan(18100);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});
