import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir, store, ctx;

beforeEach(async () => {
  dir = tempDir('mock-ports-');
  store = new ConfigStore({ storagePath: dir.path });
  await store.load();
  ctx = buildApp({
    storagePath: dir.path,
    configStore: store,
    logBuffer: { push: () => {}, subscribe: () => () => {} },
    mockEngine: { start: async () => ({ running: [], failed: [] }), stop: async () => {}, getStatus: () => ({}), servers: new Map() },
  });
});

afterEach(() => dir.cleanup());

describe('GET /api/ports', () => {
  it('初始返回空列表', async () => {
    const r = await ctx.request.get('/api/ports');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe('POST /api/ports', () => {
  it('创建端口，默认启用', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8080 });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ port: 8080, enabled: true });
    const list = await ctx.request.get('/api/ports');
    expect(list.body).toEqual([{ port: 8080, enabled: true }]);
  });

  it('按端口号升序保存', async () => {
    await ctx.request.post('/api/ports').send({ port: 9090 });
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const list = await ctx.request.get('/api/ports');
    expect(list.body.map((p) => p.port)).toEqual([8080, 9090]);
  });

  it.each([0, 70000, 'abc'])('拒绝非法端口号 %p', async (port) => {
    const r = await ctx.request.post('/api/ports').send({ port });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PORT');
  });

  it('重复端口拒绝', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const r = await ctx.request.post('/api/ports').send({ port: 8080 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_PORT');
  });
});

describe('PUT /api/ports/:port', () => {
  it('切换启用状态', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const r = await ctx.request.put('/api/ports/8080').send({ enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ port: 8080, enabled: false });
  });

  it('改号级联更新端点的 port 字段', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    await ctx.request.post('/api/endpoints').send({ port: 8080, method: 'GET', path: '/a', statusCode: 200, response: {} });
    const r = await ctx.request.put('/api/ports/8080').send({ port: 9090 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ port: 9090, enabled: true });
    const eps = await ctx.request.get('/api/endpoints');
    expect(eps.body.map((e) => e.port)).toEqual([9090]);
    const ports = await ctx.request.get('/api/ports');
    expect(ports.body.map((p) => p.port)).toEqual([9090]);
  });

  it('改号撞已有端口拒绝', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    await ctx.request.post('/api/ports').send({ port: 9090 });
    const r = await ctx.request.put('/api/ports/8080').send({ port: 9090 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_PORT');
  });

  it('未知端口 404', async () => {
    const r = await ctx.request.put('/api/ports/1234').send({ enabled: false });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/ports/:port', () => {
  it('连带删除其下所有端点，保留其他端口', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    await ctx.request.post('/api/ports').send({ port: 9090 });
    await ctx.request.post('/api/endpoints').send({ port: 8080, method: 'GET', path: '/a', statusCode: 200, response: {} });
    await ctx.request.post('/api/endpoints').send({ port: 9090, method: 'GET', path: '/b', statusCode: 200, response: {} });
    const r = await ctx.request.delete('/api/ports/8080');
    expect(r.status).toBe(204);
    const ports = await ctx.request.get('/api/ports');
    expect(ports.body.map((p) => p.port)).toEqual([9090]);
    const eps = await ctx.request.get('/api/endpoints');
    expect(eps.body.map((e) => e.path)).toEqual(['/b']);
  });

  it('未知端口 404', async () => {
    const r = await ctx.request.delete('/api/ports/1234');
    expect(r.status).toBe(404);
  });
});

describe('端点自动补建端口实体', () => {
  it('POST /api/endpoints 为未知端口补建 port', async () => {
    await ctx.request.post('/api/endpoints').send({ port: 7777, method: 'GET', path: '/x', statusCode: 200, response: {} });
    const r = await ctx.request.get('/api/ports');
    expect(r.body).toEqual([{ port: 7777, enabled: true }]);
  });

  it('PUT /api/endpoints 改到未知端口时补建', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const created = await ctx.request.post('/api/endpoints').send({ port: 8080, method: 'GET', path: '/x', statusCode: 200, response: {} });
    await ctx.request.put(`/api/endpoints/${created.body.id}`).send({ port: 7788, method: 'GET', path: '/x', statusCode: 200, response: {} });
    const r = await ctx.request.get('/api/ports');
    expect(r.body.map((p) => p.port).sort()).toEqual([7788, 8080]);
  });
});
