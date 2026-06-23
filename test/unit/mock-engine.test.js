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

describe('mock-engine with dynamic response', () => {
  it('resolves {{$uuid}} at serve time and returns different values per request', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'dyn-uuid', port: 18101, method: 'GET', path: '/uuid',
        statusCode: 200, response: { id: '{{$uuid}}' }, enabled: true },
    ]);
    const r1 = await get(18101, '/uuid');
    const r2 = await get(18101, '/uuid');
    const b1 = JSON.parse(r1.body);
    const b2 = JSON.parse(r2.body);
    expect(b1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b2.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b1.id).not.toBe(b2.id);
  });

  it('preserves type for pure number expression (no quotes around int)', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'dyn-int', port: 18102, method: 'GET', path: '/n',
        statusCode: 200, response: { age: '{{$int:42:42}}' }, enabled: true },
    ]);
    const r = await get(18102, '/n');
    expect(r.body).toBe('{"age":42}');
    expect(JSON.parse(r.body).age).toBe(42);
  });

  it('soft-fail: bad generator in pure expression → null at serve time', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'dyn-bad', port: 18103, method: 'GET', path: '/bad',
        statusCode: 200, response: { x: '{{$int:notanumber:10}}' }, enabled: true },
    ]);
    const r = await get(18103, '/bad');
    expect(r.body).toBe('{"x":null}');
  });

  it('soft-fail: bad generator in mixed expression → keeps original string', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'dyn-mixed-bad', port: 18104, method: 'GET', path: '/mb',
        statusCode: 200, response: { x: 'pre-{{$nonexistent}}' }, enabled: true },
    ]);
    const r = await get(18104, '/mb');
    expect(r.body).toBe('{"x":"pre-{{$nonexistent}}"}');
  });

  it('mixed expression stringifies resolved values', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'dyn-mixed', port: 18105, method: 'GET', path: '/m',
        statusCode: 200, response: { x: 'id-{{$int:7:7}}' }, enabled: true },
    ]);
    const r = await get(18105, '/m');
    expect(r.body).toBe('{"x":"id-7"}');
  });
});
