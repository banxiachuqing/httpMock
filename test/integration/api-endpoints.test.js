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

  it('ignores client-supplied id (server-generated UUID wins)', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/id-test', id: 'client-fixed-id' });
    expect(r.status).toBe(201);
    expect(r.body.id).not.toBe('client-fixed-id');
    expect(r.body.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('rejects invalid statusCode that would crash mock engine', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, statusCode: 'abc' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_STATUS');
  });

  it('rejects path containing ? (would be an unmatchable route)', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/search?q=1' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PATH');
  });

  it('normalizes string port to number (no split entities)', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, port: '8080', path: '/api/str-port' });
    expect(r.status).toBe(201);
    expect(r.body.port).toBe(8080);
    expect(store.config.endpoints.find((e) => e.path === '/api/str-port').port).toBe(8080);
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

describe('端口类型约束', () => {
  it('往 ws 端口建 endpoint → PORT_TYPE_MISMATCH', async () => {
    await ctx.request.post('/api/ports').send({ port: 8082, type: 'ws' });
    const r = await ctx.request.post('/api/endpoints').send({ method: 'GET', port: 8082, path: '/x', response: {} });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
  });

  it('往 http 端口（或新端口）建 endpoint 正常，补建的端口带 type:http', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ method: 'GET', port: 8088, path: '/x', response: {} });
    expect(r.status).toBe(201);
    expect(store.config.ports.find((p) => p.port === 8088)).toEqual({ port: 8088, enabled: true, type: 'http', name: 'API-1' });
  });
});

describe('PUT /api/endpoints/order', () => {
  it('reorders endpoints by given id permutation and persists', async () => {
    const a = await ctx.request.post('/api/endpoints').send(validBody);
    const b = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/y' });
    const c = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/z' });
    const ids = [c.body.id, a.body.id, b.body.id];

    const r = await ctx.request.put('/api/endpoints/order').send({ ids });
    expect(r.status).toBe(200);
    expect(r.body.map((e) => e.id)).toEqual(ids);

    const list = await ctx.request.get('/api/endpoints');
    expect(list.body.map((e) => e.id)).toEqual(ids);
  });

  it('rejects ids that are not a permutation of endpoint ids', async () => {
    const a = await ctx.request.post('/api/endpoints').send(validBody);
    await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/y' });

    // 长度不对
    let r = await ctx.request.put('/api/endpoints/order').send({ ids: [a.body.id] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_ORDER');

    // 未知 id
    r = await ctx.request.put('/api/endpoints/order').send({ ids: [a.body.id, 'nope'] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_ORDER');

    // 重复 id
    r = await ctx.request.put('/api/endpoints/order').send({ ids: [a.body.id, a.body.id] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_ORDER');

    // ids 不是数组
    r = await ctx.request.put('/api/endpoints/order').send({ ids: 'nope' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_ORDER');
  });
});

describe('POST /api/endpoints — 通配 pattern 校验（spec 2026-08-27 §2）', () => {
  it('合法通配 pattern 创建成功', async () => {
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/*/cmd' });
    expect(r.status).toBe(201);
    const r2 = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/api/**' });
    expect(r2.status).toBe(201);
  });

  it('段内部分通配 → 400 INVALID_PATH（大声失败）', async () => {
    for (const path of ['/api/fo*/cmd', '/api/*x/cmd', '/api/***']) {
      const r = await ctx.request.post('/api/endpoints').send({ ...validBody, path });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_PATH');
      expect(r.body.error).toContain('独占一段');
    }
  });

  it('唯一性按字面：/u/* 与 /u/** 可共存', async () => {
    expect((await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/u/*' })).status).toBe(201);
    expect((await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/u/**' })).status).toBe(201);
  });

  it('字面相同的 pattern 仍判重', async () => {
    await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/u/*' });
    const r = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/u/*' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_ENDPOINT');
  });

  it('PUT 更新为非法 pattern 同样拒绝', async () => {
    const created = await ctx.request.post('/api/endpoints').send({ ...validBody, path: '/put-ok' });
    const r = await ctx.request.put(`/api/endpoints/${created.body.id}`).send({ ...validBody, path: '/put/fo*' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PATH');
  });
});
