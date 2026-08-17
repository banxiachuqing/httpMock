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

  it('禁用端口不随启动绑定', async () => {
    await ctx.request.post('/api/endpoints').send({ port: 19095, method: 'GET', path: '/a', statusCode: 200, response: { ok: 1 } });
    await ctx.request.put('/api/ports/19095').send({ enabled: false });
    const r = await ctx.request.post('/api/runtime/start');
    expect(r.body.running).toEqual([]);
    expect(r.body.failed).toEqual([]);
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

// 直连 mock 端口探测（supertest 的 request 绑定 app，不能发外部 URL）
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

describe('配置变更同步引擎（改号/停用后立即生效）', () => {
  it('改号后旧端口释放、新端口生效', async () => {
    await ctx.request.post('/api/ports').send({ port: 19101 });
    await ctx.request.post('/api/endpoints').send({ port: 19101, method: 'GET', path: '/a', statusCode: 200, response: { ok: 1 } });
    await ctx.request.post('/api/runtime/start');

    // 前置：旧端口可访问
    const before = await httpGet('http://127.0.0.1:19101/a');
    expect(before.status).toBe(200);

    const r = await ctx.request.put('/api/ports/19101').send({ port: 19102 });
    expect(r.status).toBe(200);

    // 新端口立即生效
    const afterNew = await httpGet('http://127.0.0.1:19102/a');
    expect(afterNew.status).toBe(200);
    // 旧端口已释放（连接拒绝）
    await expect(httpGet('http://127.0.0.1:19101/a')).rejects.toThrow();
    // 引擎状态同步
    const status = await ctx.request.get('/api/runtime/status');
    expect(status.body['19102']?.state).toBe('running');
    expect(status.body['19101']?.state).toBe('stopped');
  });

  it('运行时停用端口后立即释放监听', async () => {
    await ctx.request.post('/api/ports').send({ port: 19103 });
    await ctx.request.post('/api/endpoints').send({ port: 19103, method: 'GET', path: '/a', statusCode: 200, response: { ok: 1 } });
    await ctx.request.post('/api/runtime/start');

    const r = await ctx.request.put('/api/ports/19103').send({ enabled: false });
    expect(r.status).toBe(200);
    await expect(httpGet('http://127.0.0.1:19103/a')).rejects.toThrow();
    const status = await ctx.request.get('/api/runtime/status');
    expect(status.body['19103']?.state).toBe('stopped');
  });
});

describe('GET /api/runtime/status', () => {
  it('returns empty object when never started', async () => {
    const r = await ctx.request.get('/api/runtime/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });
});
