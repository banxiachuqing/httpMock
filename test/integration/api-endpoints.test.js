import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir, store, ctx;

beforeEach(async () => {
  dir = tempDir('mock-ep-');
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

const validBody = { port: 8080, method: 'GET', path: '/api/x', statusCode: 200, response: { ok: 1 }, enabled: true };

describe('POST /api/endpoints', () => {
  it('creates with generated id', async () => {
    const r = await ctx.request.post('/api/endpoints').send(validBody);
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('rejects invalid method', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, method: 'BREW' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_METHOD');
  });

  it('rejects port out of range', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, port: 99999 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PORT');
  });

  it('rejects path that does not start with /', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, path: 'api/x' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PATH');
  });

  it('rejects duplicate (port, method, path)', async () => {
    await ctx.request.post('/api/endpoints').send(validBody);
    const r = await ctx.request.post('/api/endpoints').send(validBody);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_ENDPOINT');
  });
});

describe('GET /api/endpoints', () => {
  it('returns the list', async () => {
    await ctx.request.post('/api/endpoints').send(validBody);
    const r = await ctx.request.get('/api/endpoints');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
  });
});

describe('PUT /api/endpoints/:id', () => {
  it('updates existing endpoint', async () => {
    const created = await ctx.request.post('/api/endpoints').send(validBody);
    const id = created.body.id;
    const r = await ctx.request.put(`/api/endpoints/${id}`).send({ ...validBody, path: '/api/y' });
    expect(r.status).toBe(200);
    expect(r.body.path).toBe('/api/y');
  });

  it('returns 404 for unknown id', async () => {
    const r = await ctx.request.put('/api/endpoints/does-not-exist').send(validBody);
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/endpoints/:id', () => {
  it('removes the endpoint', async () => {
    const created = await ctx.request.post('/api/endpoints').send(validBody);
    const r = await ctx.request.delete(`/api/endpoints/${created.body.id}`);
    expect(r.status).toBe(204);
    const list = await ctx.request.get('/api/endpoints');
    expect(list.body).toHaveLength(0);
  });
});

describe('endpoint name 字段', () => {
  it('保存 trim 后的名称', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, name: '  用户登录 ' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('用户登录');
  });

  it('超过 50 字符拒绝', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, name: 'x'.repeat(51) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_NAME');
  });

  it('非字符串拒绝', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, name: 123 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_NAME');
  });

  it('空白名称视为未填，不存储', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, name: '   ' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBeUndefined();
  });

  it('PUT 可更新名称', async () => {
    const created = await ctx.request.post('/api/endpoints').send(validBody);
    const r = await ctx.request.put(`/api/endpoints/${created.body.id}`).send({ ...validBody, name: '改名' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('改名');
  });

  it('PUT 空白名称清除已有名称', async () => {
    const created = await ctx.request.post('/api/endpoints').send({ ...validBody, name: '原名' });
    const r = await ctx.request.put(`/api/endpoints/${created.body.id}`).send({ ...validBody, name: '  ' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBeUndefined();
  });
});
