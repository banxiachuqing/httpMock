import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';
import { MockEngine } from '../../src/mock-engine.js';
import { LogBuffer } from '../../src/log-buffer.js';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';
import http from 'node:http';

let dir, store, engine, logBuffer, ctx;

beforeEach(async () => {
  dir = tempDir('mock-rt-');
  store = new ConfigStore({ storagePath: dir.path });
  await store.load();
  logBuffer = new LogBuffer(50);
  engine = new MockEngine({ logBuffer });
  ctx = buildApp({ storagePath: dir.path, configStore: store, logBuffer, mockEngine: engine });
});

afterEach(async () => {
  await engine.stop();
  dir.cleanup();
});

describe('POST /api/runtime/start', () => {
  it('starts engines for all unique ports and returns running/failed', async () => {
    await ctx.request.post('/api/endpoints').send({ port: 19090, method: 'GET', path: '/a', statusCode: 200, response: { ok: 1 } });
    await ctx.request.post('/api/endpoints').send({ port: 19091, method: 'GET', path: '/b', statusCode: 200, response: { ok: 1 } });
    const r = await ctx.request.post('/api/runtime/start');
    expect(r.status).toBe(200);
    expect(r.body.running.map((x) => x.port).sort()).toEqual([19090, 19091]);
    expect(r.body.failed).toEqual([]);
  });

  it('marks EADDRINUSE ports as failed', async () => {
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(19092, '127.0.0.1', resolve));
    try {
      await ctx.request.post('/api/endpoints').send({ port: 19092, method: 'GET', path: '/a', statusCode: 200, response: { ok: 1 } });
      await ctx.request.post('/api/endpoints').send({ port: 19093, method: 'GET', path: '/a', statusCode: 200, response: { ok: 1 } });
      const r = await ctx.request.post('/api/runtime/start');
      expect(r.body.failed.find((f) => f.port === 19092)).toBeTruthy();
      expect(r.body.running.find((x) => x.port === 19093)).toBeTruthy();
    } finally {
      await new Promise((res) => blocker.close(res));
    }
  });
});

describe('POST /api/runtime/stop', () => {
  it('stops running engines', async () => {
    await ctx.request.post('/api/endpoints').send({ port: 19094, method: 'GET', path: '/a', statusCode: 200, response: { ok: 1 } });
    await ctx.request.post('/api/runtime/start');
    const r = await ctx.request.post('/api/runtime/stop');
    expect(r.status).toBe(200);
    expect(r.body.stopped).toContain(19094);
  });
});

describe('GET /api/runtime/status', () => {
  it('returns empty object when never started', async () => {
    const r = await ctx.request.get('/api/runtime/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });
});
