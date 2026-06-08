import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { MockEngine } from '../../src/mock-engine.js';

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

function post(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let engine;
let logBuffer;
let pushedLogs = [];

beforeEach(() => {
  pushedLogs = [];
  logBuffer = { push: (e) => pushedLogs.push(e) };
});

afterEach(async () => {
  if (engine) await engine.stop();
});

describe('MockEngine', () => {
  it('starts a server per unique port and dispatches by method+path', async () => {
    engine = new MockEngine({ logBuffer });
    const { running, failed } = await engine.start([
      { id: 'a', port: 18080, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
      { id: 'b', port: 18080, method: 'POST', path: '/y', statusCode: 201, response: { ok: 2 }, enabled: true },
      { id: 'c', port: 18081, method: 'GET', path: '/z', statusCode: 200, response: { ok: 3 }, enabled: true },
    ]);
    expect(running.map((r) => r.port).sort()).toEqual([18080, 18081]);
    expect(failed).toEqual([]);

    const a = await get(18080, '/x');
    expect(a.status).toBe(200);
    expect(JSON.parse(a.body)).toEqual({ ok: 1 });
    expect(a.headers['content-type']).toMatch(/application\/json/);

    const b = await post(18080, '/y');
    expect(b.status).toBe(201);

    const c = await get(18081, '/z');
    expect(c.status).toBe(200);
  });

  it('returns 404 for unknown path on a started port', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'a', port: 18082, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    const r = await get(18082, '/unknown');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'no mock for GET /unknown' });
  });

  it('marks port as failed (EADDRINUSE) and keeps others running', async () => {
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(18083, '127.0.0.1', resolve));
    try {
      engine = new MockEngine({ logBuffer });
      const { running, failed } = await engine.start([
        { id: 'a', port: 18083, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
        { id: 'b', port: 18084, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
      ]);
      expect(failed.find((f) => f.port === 18083)).toBeTruthy();
      expect(running.find((r) => r.port === 18084)).toBeTruthy();
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('ignores disabled endpoints', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'a', port: 18085, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: false },
    ]);
    const r = await get(18085, '/x');
    expect(r.status).toBe(404);
  });

  it('stop() tears down all servers', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'a', port: 18086, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await engine.stop();
    await expect(get(18086, '/x')).rejects.toThrow();
  });

  it('logs each request through the log buffer', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'a', port: 18087, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await get(18087, '/x');
    expect(pushedLogs).toHaveLength(1);
    expect(pushedLogs[0].path).toBe('/x');
    expect(pushedLogs[0].matched).toBe(true);
  });
});
