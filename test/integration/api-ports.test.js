import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';
import http from 'node:http';

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
    expect(r.body).toEqual({ port: 8080, enabled: true, type: 'http', name: 'API-1' });
    const list = await ctx.request.get('/api/ports');
    expect(list.body).toEqual([{ port: 8080, enabled: true, type: 'http', name: 'API-1' }]);
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

describe('SSE config 广播', () => {
  // MCP/curl 等非页面来源修改配置后，页面靠 /events 的 config 事件自动刷新
  it('POST /api/ports 后向 /events 广播 config 事件', async () => {
    const server = ctx.app.listen(0);
    const port = server.address().port;
    try {
      let buf = '';
      let received = false;
      await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET' }, (res) => {
          res.setEncoding('utf8');
          res.on('data', (c) => {
            if (received) return;
            buf += c;
            const idx = buf.indexOf('event: config');
            if (idx === -1) return;
            const end = buf.indexOf('\n\n', idx);
            if (end === -1) return;
            received = true;
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => {}); // destroy 主动断开时触发，忽略
        req.end();
        setTimeout(() => {
          ctx.request.post('/api/ports').send({ port: 18080 }).then(() => {}, reject);
        }, 100);
        setTimeout(() => reject(new Error('等待 config 事件超时')), 5000);
      });
      expect(received).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('PUT /api/ports/:port', () => {
  it('切换启用状态', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const r = await ctx.request.put('/api/ports/8080').send({ enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ port: 8080, enabled: false, type: 'http', name: 'API-1' });
  });

  it('改号级联更新端点的 port 字段', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    await ctx.request.post('/api/endpoints').send({ port: 8080, method: 'GET', path: '/a', statusCode: 200, response: {} });
    const r = await ctx.request.put('/api/ports/8080').send({ port: 9090 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ port: 9090, enabled: true, type: 'http', name: 'API-1' });
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
    expect(r.body).toEqual([{ port: 7777, enabled: true, type: 'http', name: 'API-1' }]);
  });

  it('PUT /api/endpoints 改到未知端口时补建', async () => {
    await ctx.request.post('/api/ports').send({ port: 8080 });
    const created = await ctx.request.post('/api/endpoints').send({ port: 8080, method: 'GET', path: '/x', statusCode: 200, response: {} });
    await ctx.request.put(`/api/endpoints/${created.body.id}`).send({ port: 7788, method: 'GET', path: '/x', statusCode: 200, response: {} });
    const r = await ctx.request.get('/api/ports');
    expect(r.body.map((p) => p.port).sort()).toEqual([7788, 8080]);
  });
});

describe('端口类型（v3）', () => {
  it('POST 显式 type=ws', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8090, type: 'ws' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ port: 8090, enabled: true, type: 'ws', name: 'WS-1' });
  });

  it('POST 非法 type → INVALID_VALUE', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8091, type: 'grpc' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_VALUE');
  });

  it('PUT 传 type → FIELD_IMMUTABLE', async () => {
    await ctx.request.post('/api/ports').send({ port: 8092 });
    const r = await ctx.request.put('/api/ports/8092').send({ type: 'ws' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('FIELD_IMMUTABLE');
  });

  it('改号级联 services', async () => {
    await ctx.request.post('/api/ports').send({ port: 8093, type: 'ws' });
    await store.update((cfg) => {
      cfg.services = [{ id: 's1', port: 8093, path: '/ws/A', name: 'A', enabled: true, targetNamespace: 'urn:A', wsdl: null, operations: [] }];
      return cfg;
    });
    await ctx.request.put('/api/ports/8093').send({ port: 8094 });
    expect(store.config.services[0].port).toBe(8094);
  });

  it('删除端口连带删 services，不动其他端口', async () => {
    await ctx.request.post('/api/ports').send({ port: 8095, type: 'ws' });
    await store.update((cfg) => {
      cfg.services = [
        { id: 's1', port: 8095, path: '/ws/A', name: 'A', enabled: true, targetNamespace: 'urn:A', wsdl: null, operations: [] },
        { id: 's2', port: 9999, path: '/ws/B', name: 'B', enabled: true, targetNamespace: 'urn:B', wsdl: null, operations: [] },
      ];
      return cfg;
    });
    await ctx.request.delete('/api/ports/8095');
    expect(store.config.services.map((s) => s.id)).toEqual(['s2']);
  });

  it('ws 端口切换启用后 type 保留', async () => {
    await ctx.request.post('/api/ports').send({ port: 8096, type: 'ws' });
    await ctx.request.put('/api/ports/8096').send({ enabled: false });
    const r = await ctx.request.get('/api/ports');
    expect(r.body).toEqual([{ port: 8096, enabled: false, type: 'ws', name: 'WS-1' }]);
  });

  it('ws 端口改号后 type 保留', async () => {
    await ctx.request.post('/api/ports').send({ port: 8097, type: 'ws' });
    const r = await ctx.request.put('/api/ports/8097').send({ port: 8098 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ port: 8098, enabled: true, type: 'ws', name: 'WS-1' });
    const list = await ctx.request.get('/api/ports');
    expect(list.body).toEqual([{ port: 8098, enabled: true, type: 'ws', name: 'WS-1' }]);
  });
});

describe('TCP/UDP 端口类型（spec 2026-08-22 §3/§6）', () => {
  it('创建 tcp/udp 端口', async () => {
    const tcp = await ctx.request.post('/api/ports').send({ port: 9500, type: 'tcp' });
    expect(tcp.status).toBe(201);
    expect(tcp.body).toEqual({ port: 9500, enabled: true, type: 'tcp', name: 'TCP-1' });
    const udp = await ctx.request.post('/api/ports').send({ port: 9501, type: 'udp' });
    expect(udp.status).toBe(201);
    expect(udp.body).toEqual({ port: 9501, enabled: true, type: 'udp', name: 'UDP-1' });
  });

  it('拒绝非法 type', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 9502, type: 'sctp' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_VALUE');
  });

  it('type 创建后不可改', async () => {
    await ctx.request.post('/api/ports').send({ port: 9503, type: 'tcp' });
    const r = await ctx.request.put('/api/ports/9503').send({ type: 'http' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('FIELD_IMMUTABLE');
  });

  it('往 tcp 端口建 HTTP 端点 → PORT_TYPE_MISMATCH', async () => {
    await ctx.request.post('/api/ports').send({ port: 9504, type: 'tcp' });
    const r = await ctx.request.post('/api/endpoints').send({ port: 9504, method: 'GET', path: '/x', response: {} });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
  });

  it('往 udp 端口建 WS 服务 → PORT_TYPE_MISMATCH（ensureWsPortEntity 覆盖）', async () => {
    await ctx.request.post('/api/ports').send({ port: 9505, type: 'udp' });
    const r = await ctx.request.post('/api/services').send({ port: 9505, path: '/ws/S', name: 'S' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
  });
});

describe('Syslog 端口类型（spec 2026-08-22 §7）', () => {
  it('创建 syslog 端口', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 5514, type: 'syslog' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ port: 5514, enabled: true, type: 'syslog', name: 'SYSLOG-1' });
  });

  it('默认 type 仍为 http（不影响）', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 5515 });
    expect(r.body).toEqual({ port: 5515, enabled: true, type: 'http', name: 'API-1' });
  });

  it('PUT 传 type=syslog → FIELD_IMMUTABLE', async () => {
    await ctx.request.post('/api/ports').send({ port: 5516 });
    const r = await ctx.request.put('/api/ports/5516').send({ type: 'syslog' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('FIELD_IMMUTABLE');
  });

  it('往 syslog 端口建 HTTP 端点 → PORT_TYPE_MISMATCH', async () => {
    await ctx.request.post('/api/ports').send({ port: 5517, type: 'syslog' });
    const r = await ctx.request.post('/api/endpoints').send({ port: 5517, method: 'GET', path: '/x', response: {} });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
    expect(r.body.error).toContain('syslog');
  });

  it('往 syslog 端口建 WS 服务 → PORT_TYPE_MISMATCH', async () => {
    await ctx.request.post('/api/ports').send({ port: 5518, type: 'syslog' });
    const r = await ctx.request.post('/api/services').send({ port: 5518, path: '/ws/S', name: 'S' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
  });

  it('非法 type（与既有列表不交集）→ INVALID_VALUE', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 5519, type: 'snmp' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_VALUE');
  });
});

describe('端口名称（name）', () => {
  it('POST 未提供 name：按类型自动生成默认名（http→API-1）', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8080 });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ port: 8080, enabled: true, type: 'http', name: 'API-1' });
  });

  it('POST 各类型默认名前缀不同', async () => {
    const http = await ctx.request.post('/api/ports').send({ port: 8001 });
    const ws = await ctx.request.post('/api/ports').send({ port: 8002, type: 'ws' });
    const tcp = await ctx.request.post('/api/ports').send({ port: 8003, type: 'tcp' });
    const udp = await ctx.request.post('/api/ports').send({ port: 8004, type: 'udp' });
    const syslog = await ctx.request.post('/api/ports').send({ port: 8005, type: 'syslog' });
    expect(http.body.name).toBe('API-1');
    expect(ws.body.name).toBe('WS-1');
    expect(tcp.body.name).toBe('TCP-1');
    expect(udp.body.name).toBe('UDP-1');
    expect(syslog.body.name).toBe('SYSLOG-1');
  });

  it('POST 同类型序号递增，各前缀序号相互独立', async () => {
    await ctx.request.post('/api/ports').send({ port: 8010 }); // API-1
    await ctx.request.post('/api/ports').send({ port: 8011 }); // API-2
    const ws = await ctx.request.post('/api/ports').send({ port: 8012, type: 'ws' }); // WS-1（独立）
    const third = await ctx.request.post('/api/ports').send({ port: 8013 }); // API-3
    expect(ws.body.name).toBe('WS-1');
    expect(third.body.name).toBe('API-3');
  });

  it('POST 显式 name 被采用（去首尾空白）', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8020, name: '  订单服务  ' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('订单服务');
  });

  it('POST name 为空白时自动生成默认名', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8021, name: '   ' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('API-1');
  });

  it('POST name 非字符串 → INVALID_VALUE', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8022, name: 123 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_VALUE');
  });

  it('POST name 超过 50 字符 → INVALID_VALUE', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 8023, name: 'x'.repeat(51) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_VALUE');
  });

  it('PUT 改名：设置新名称', async () => {
    await ctx.request.post('/api/ports').send({ port: 8030 });
    const r = await ctx.request.put('/api/ports/8030').send({ name: '网关' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ port: 8030, enabled: true, type: 'http', name: '网关' });
  });

  it('PUT 改名：name 空白 → 重新生成默认名', async () => {
    await ctx.request.post('/api/ports').send({ port: 8031, name: '旧名' });
    const r = await ctx.request.put('/api/ports/8031').send({ name: '   ' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('API-1');
  });

  it('PUT 不传 name：名称保持不变', async () => {
    await ctx.request.post('/api/ports').send({ port: 8032, name: '保持' });
    const r = await ctx.request.put('/api/ports/8032').send({ enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('保持');
  });

  it('改号后名称保留', async () => {
    await ctx.request.post('/api/ports').send({ port: 8033, name: '支付' });
    const r = await ctx.request.put('/api/ports/8033').send({ port: 8034 });
    expect(r.body).toEqual({ port: 8034, enabled: true, type: 'http', name: '支付' });
  });

  it('端点自动补建端口时生成默认名', async () => {
    await ctx.request.post('/api/endpoints').send({ port: 7777, method: 'GET', path: '/x', statusCode: 200, response: {} });
    const r = await ctx.request.get('/api/ports');
    expect(r.body).toEqual([{ port: 7777, enabled: true, type: 'http', name: 'API-1' }]);
  });

  it('WS 服务补建端口时生成默认名', async () => {
    await ctx.request.post('/api/services').send({ port: 9600, path: '/ws/S', name: 'S' });
    const r = await ctx.request.get('/api/ports');
    expect(r.body).toEqual([{ port: 9600, enabled: true, type: 'ws', name: 'WS-1' }]);
  });
});
