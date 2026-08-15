import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir, store, ctx;

beforeEach(async () => {
  dir = tempDir('mock-svc-');
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

const MINI_WSDL = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:tns="urn:user" targetNamespace="urn:user">
  <wsdl:portType name="P"><wsdl:operation name="getUser"/><wsdl:operation name="listUsers"/></wsdl:portType>
  <wsdl:binding name="B" type="tns:P">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <wsdl:operation name="getUser"><soap:operation soapAction="urn:getUser"/></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="UserService"><wsdl:port name="pp" binding="tns:B"><soap:address location="http://x/ws/U"/></wsdl:port></wsdl:service>
</wsdl:definitions>`;

async function createWsPort(port = 8082) {
  await ctx.request.post('/api/ports').send({ port, type: 'ws' });
}

describe('POST /api/services', () => {
  it('创建服务：自动补建 ws 端口；响应不含 wsdl 字段', async () => {
    const r = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/UserService', name: 'UserService' });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();
    expect(r.body.hasWsdl).toBe(false);
    expect(r.body.wsdl).toBeUndefined();
    expect(r.body.targetNamespace).toBe('urn:UserService');
    expect(r.body.operations).toEqual([]);
    expect(store.config.ports).toEqual([{ port: 8082, enabled: true, type: 'ws' }]);
  });

  it('往 http 端口建服务 → PORT_TYPE_MISMATCH', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const r = await ctx.request.post('/api/services').send({ port: 8080, path: '/ws/A' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
  });

  it('(port, path) 冲突 → DUPLICATE_SERVICE；禁用服务不挡', async () => {
    await createWsPort();
    await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A' });
    const dup = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A' });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('DUPLICATE_SERVICE');
  });

  it('path 含 ? → INVALID_PATH', async () => {
    const r = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A?x' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PATH');
  });

  it('带 wsdl 创建：解析出 operations + targetNamespace', async () => {
    const r = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U', wsdl: MINI_WSDL });
    expect(r.status).toBe(201);
    expect(r.body.hasWsdl).toBe(true);
    expect(r.body.targetNamespace).toBe('urn:user');
    expect(r.body.operations.map((o) => o.name)).toEqual(['getUser', 'listUsers']);
    expect(r.body.operations[0].soapAction).toBe('urn:getUser');
    expect(r.body.operations[0].responseXml).toContain('getUserResponse');
  });

  it('wsdl 畸形 → INVALID_WSDL', async () => {
    const r = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U', wsdl: '<bad' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_WSDL');
  });
});

describe('PUT /api/services/:id', () => {
  it('改 path/name/enabled/targetNamespace；传 port → FIELD_IMMUTABLE', async () => {
    await createWsPort();
    const c = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A', name: 'A' });
    const id = c.body.id;
    const r = await ctx.request.put(`/api/services/${id}`).send({ path: '/ws/B', name: 'B', enabled: false, targetNamespace: 'urn:b' });
    expect(r.status).toBe(200);
    expect(r.body.path).toBe('/ws/B');
    expect(r.body.name).toBe('B');
    expect(r.body.enabled).toBe(false);
    expect(r.body.targetNamespace).toBe('urn:b');

    const imm = await ctx.request.put(`/api/services/${id}`).send({ port: 9999 });
    expect(imm.status).toBe(400);
    expect(imm.body.code).toBe('FIELD_IMMUTABLE');
  });

  it('改 path 撞车 → DUPLICATE_SERVICE', async () => {
    await createWsPort();
    await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A' });
    const b = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/B' });
    const r = await ctx.request.put(`/api/services/${b.body.id}`).send({ path: '/ws/A' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_SERVICE');
  });

  it('禁用服务翻转启用且与他人同 (port,path) → DUPLICATE_SERVICE', async () => {
    await createWsPort();
    await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A' });
    const b = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A', enabled: false });
    const r = await ctx.request.put(`/api/services/${b.body.id}`).send({ enabled: true });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DUPLICATE_SERVICE');
  });

  it('禁用服务翻转启用且 path 唯一 → 200', async () => {
    await createWsPort();
    await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A' });
    const b = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/B', enabled: false });
    const r = await ctx.request.put(`/api/services/${b.body.id}`).send({ enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
  });

  it('enabled true→false 禁用不触发查重（服务可任意禁用）', async () => {
    await createWsPort();
    await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/A' });
    const b = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/B' });
    const r = await ctx.request.put(`/api/services/${b.body.id}`).send({ enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
  });
});

describe('POST /api/services/:id/wsdl（导入合并）', () => {
  it('同名保留响应配置、新增补默认、多余保留不删', async () => {
    await createWsPort();
    const c = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U' });
    const id = c.body.id;
    // 手工先建一个 getUser（带自定义响应）和一个 manualOp
    await ctx.request.post(`/api/services/${id}/operations`).send({ name: 'getUser' });
    await ctx.request.post(`/api/services/${id}/operations`).send({ name: 'manualOp' });
    let svc = (await ctx.request.get('/api/config')).body.services.find((s) => s.id === id);
    const getUserOp = svc.operations.find((o) => o.name === 'getUser');
    await ctx.request.put(`/api/services/${id}/operations/${getUserOp.id}`).send({ responseXml: '<custom/>', soapAction: 'urn:custom' });

    const r = await ctx.request.post(`/api/services/${id}/wsdl`).send({ wsdl: MINI_WSDL });
    expect(r.status).toBe(200);
    const ops = r.body.operations.map((o) => o.name);
    expect(ops).toContain('getUser');
    expect(ops).toContain('listUsers');   // 新增
    expect(ops).toContain('manualOp');    // 保留
    const merged = r.body.operations.find((o) => o.name === 'getUser');
    expect(merged.responseXml).toBe('<custom/>');          // 响应配置保留
    expect(merged.soapAction).toBe('urn:getUser');         // soapAction 被 WSDL 更新
    expect(r.body.targetNamespace).toBe('urn:user');
    expect(r.body.hasWsdl).toBe(true);
  });
});

describe('operations CRUD', () => {
  it('新建查重 / 更新 / 删除', async () => {
    await createWsPort();
    const c = await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U' });
    const id = c.body.id;

    const add = await ctx.request.post(`/api/services/${id}/operations`).send({ name: 'getUser', soapAction: 'urn:g' });
    expect(add.status).toBe(201);
    const op = add.body.operations.find((o) => o.name === 'getUser');
    expect(op.soapAction).toBe('urn:g');
    expect(op.responseType).toBe('normal');

    const dup = await ctx.request.post(`/api/services/${id}/operations`).send({ name: 'getUser' });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('DUPLICATE_OPERATION');

    const upd = await ctx.request.put(`/api/services/${id}/operations/${op.id}`)
      .send({ responseType: 'fault', status: 500, responseXml: '<f/>', enabled: false });
    expect(upd.status).toBe(200);
    const updOp = upd.body.operations.find((o) => o.id === op.id);
    expect(updOp.responseType).toBe('fault');
    expect(updOp.enabled).toBe(false);

    const badType = await ctx.request.put(`/api/services/${id}/operations/${op.id}`).send({ responseType: 'weird' });
    expect(badType.status).toBe(400);

    const del = await ctx.request.delete(`/api/services/${id}/operations/${op.id}`);
    expect(del.status).toBe(200);
    expect(del.body.operations).toEqual([]);
  });
});

describe('POST /api/wsdl/parse', () => {
  it('解析预览不落库', async () => {
    const r = await ctx.request.post('/api/wsdl/parse').send({ wsdl: MINI_WSDL });
    expect(r.status).toBe(200);
    expect(r.body.targetNamespace).toBe('urn:user');
    expect(r.body.operations).toHaveLength(2);
    expect(store.config.services ?? []).toEqual([]);
  });

  it('畸形 → INVALID_WSDL', async () => {
    const r = await ctx.request.post('/api/wsdl/parse').send({ wsdl: 'nope' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_WSDL');
  });
});

describe('GET /api/config strip', () => {
  it('services[].wsdl 不返回，替换为 hasWsdl', async () => {
    await ctx.request.post('/api/services').send({ port: 8082, path: '/ws/U', wsdl: MINI_WSDL });
    const cfg = (await ctx.request.get('/api/config')).body;
    const svc = cfg.services.find((s) => s.path === '/ws/U');
    expect(svc.wsdl).toBeUndefined();
    expect(svc.hasWsdl).toBe(true);
    // 存储层仍是完整 wsdl
    expect(store.config.services.find((s) => s.path === '/ws/U').wsdl).toBe(MINI_WSDL);
  });
});