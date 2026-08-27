import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
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

describe('MockEngine body capture and truncation', () => {
  function postWith(port, path, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  function makeConfigStore(maxBodyBytes) {
    return { config: { settings: { maxBodyBytes } } };
  }

  it('captures full body below limit and marks requestBodyTruncated=false', async () => {
    const cs = makeConfigStore(4 * 1024 * 1024);
    engine = new MockEngine({ logBuffer, configStore: cs });
    await engine.start([
      { id: 'a', port: 19001, method: 'POST', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await postWith(19001, '/x', 'hello world');
    expect(pushedLogs).toHaveLength(1);
    expect(pushedLogs[0].requestBodyPreview).toBe('hello world');
    expect(pushedLogs[0].requestBodyTruncated).toBe(false);
  });

  it('truncates body above limit and marks requestBodyTruncated=true', async () => {
    const cs = makeConfigStore(10);
    engine = new MockEngine({ logBuffer, configStore: cs });
    await engine.start([
      { id: 'a', port: 19002, method: 'POST', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    const big = 'x'.repeat(100);
    await postWith(19002, '/x', big);
    expect(pushedLogs[0].requestBodyPreview).toBe('x'.repeat(10));
    expect(pushedLogs[0].requestBodyTruncated).toBe(true);
  });

  it('GET request with no body has empty preview and truncated=false', async () => {
    const cs = makeConfigStore(100);
    engine = new MockEngine({ logBuffer, configStore: cs });
    await engine.start([
      { id: 'a', port: 19003, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await get(19003, '/x');
    expect(pushedLogs[0].requestBodyPreview).toBe('');
    expect(pushedLogs[0].requestBodyTruncated).toBe(false);
  });

  it('falls back to 4 MiB when configStore is missing or settings.maxBodyBytes undefined', async () => {
    engine = new MockEngine({ logBuffer, configStore: { config: { settings: {} } } });
    await engine.start([
      { id: 'a', port: 19004, method: 'POST', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    // 1 KB body — well under 4 MiB fallback
    await postWith(19004, '/x', 'y'.repeat(1024));
    expect(pushedLogs[0].requestBodyPreview).toHaveLength(1024);
    expect(pushedLogs[0].requestBodyTruncated).toBe(false);
  });

  it('reads fresh maxBodyBytes on each request (no caching)', async () => {
    const cs = { config: { settings: { maxBodyBytes: 5 } } };
    engine = new MockEngine({ logBuffer, configStore: cs });
    await engine.start([
      { id: 'a', port: 19005, method: 'POST', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await postWith(19005, '/x', 'aaaaaa');
    expect(pushedLogs[0].requestBodyTruncated).toBe(true);

    // User updates setting live
    cs.config.settings.maxBodyBytes = 1000;
    pushedLogs = [];
    await postWith(19005, '/x', 'bbbbbb');
    expect(pushedLogs[0].requestBodyTruncated).toBe(false);
  });
});

describe('端口感知启动（ports 列表）', () => {
  it('只绑定启用端口，禁用端口不监听', async () => {
    engine = new MockEngine({ logBuffer });
    const endpoints = [
      { id: 'a', port: 18090, method: 'GET', path: '/on', statusCode: 200, response: { ok: 1 }, enabled: true },
      { id: 'b', port: 18091, method: 'GET', path: '/off', statusCode: 200, response: { ok: 2 }, enabled: true },
    ];
    const ports = [
      { port: 18090, enabled: true },
      { port: 18091, enabled: false },
    ];
    const { running, failed } = await engine.start(endpoints, ports);
    expect(running.map((r) => r.port)).toEqual([18090]);
    expect(failed).toEqual([]);
    const res = await get(18090, '/on');
    expect(res.status).toBe(200);
    await expect(get(18091, '/off')).rejects.toThrow();
  });

  it('启用但无端点的端口照常绑定，返回 404', async () => {
    engine = new MockEngine({ logBuffer });
    const { running } = await engine.start([], [{ port: 18092, enabled: true }]);
    expect(running.map((r) => r.port)).toEqual([18092]);
    const res = await get(18092, '/anything');
    expect(res.status).toBe(404);
  });

  it('端点引用的端口不在 ports 列表时忽略', async () => {
    engine = new MockEngine({ logBuffer });
    const endpoints = [
      { id: 'a', port: 18093, method: 'GET', path: '/x', statusCode: 200, response: {}, enabled: true },
    ];
    const { running, failed } = await engine.start(endpoints, []);
    expect(running).toEqual([]);
    expect(failed).toEqual([]);
  });
});

describe('MockEngine TCP/UDP 抓包端口', () => {
  it('tcp 端口接收数据并落捕获日志', async () => {
    engine = new MockEngine({ logBuffer });
    const { running, failed } = await engine.start([], [{ port: 18920, enabled: true, type: 'tcp' }]);
    expect(running.map((r) => r.port)).toEqual([18920]);
    expect(failed).toEqual([]);
    const s = net.connect(18920, '127.0.0.1');
    await new Promise((res) => s.once('connect', res));
    s.write('ping');
    await new Promise((r) => setTimeout(r, 400)); // 等 200ms 空闲聚合 flush
    s.end();
    const msg = pushedLogs.find((e) => e.protocol === 'tcp' && !e.event);
    expect(msg.payloadText).toBe('ping');
  });

  it('udp 端口接收 datagram 并落捕获日志', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([], [{ port: 18921, enabled: true, type: 'udp' }]);
    const client = dgram.createSocket('udp4');
    await new Promise((res, rej) => client.send('ping', 18921, '127.0.0.1', (e) => (e ? rej(e) : res())));
    client.close();
    await new Promise((r) => setTimeout(r, 150));
    const msg = pushedLogs.find((e) => e.protocol === 'udp');
    expect(msg.payloadText).toBe('ping');
  });

  it('tcp 端口 EADDRINUSE 隔离：不影响其他端口', async () => {
    const blocker = net.createServer();
    await new Promise((res) => blocker.listen(18922, '127.0.0.1', res));
    try {
      engine = new MockEngine({ logBuffer });
      const { running, failed } = await engine.start(
        [{ id: 'a', port: 18923, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true }],
        [{ port: 18922, enabled: true, type: 'tcp' }, { port: 18923, enabled: true, type: 'http' }],
      );
      expect(failed.find((f) => f.port === 18922)).toBeTruthy();
      expect(running.find((r) => r.port === 18923)).toBeTruthy();
      expect(engine.getStatus()['18922'].state).toBe('failed');
      expect(engine.getStatus()['18923'].state).toBe('running');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('stop() 释放 tcp/udp 端口，可立即重绑', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([], [{ port: 18924, enabled: true, type: 'tcp' }, { port: 18925, enabled: true, type: 'udp' }]);
    await engine.stop();
    const again = await engine.start([], [{ port: 18924, enabled: true, type: 'tcp' }, { port: 18925, enabled: true, type: 'udp' }]);
    expect(again.failed).toEqual([]);
  });

  it('stop() 销毁活动 tcp 连接（客户端收到 close）', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([], [{ port: 18926, enabled: true, type: 'tcp' }]);
    const s = net.connect(18926, '127.0.0.1');
    // 服务端 destroy 时客户端可能先收到 RST → ECONNRESET error 事件；
    // 无 error 监听会变成 uncaught exception 让全量测试 exit 1（既有噪音，非本测试意图）
    s.on('error', () => {});
    await new Promise((res) => s.once('connect', res));
    const closed = new Promise((res) => s.once('close', res));
    await engine.stop();
    await closed;
  });

  it('syslog 端口收 RFC 3164 datagram → entry.protocol=syslog 且 entry.syslog 正确', async () => {
    engine = new MockEngine({ logBuffer });
    const { running } = await engine.start([], [{ port: 18927, enabled: true, type: 'syslog' }]);
    expect(running.map((r) => r.port)).toEqual([18927]);
    const client = dgram.createSocket('udp4');
    await new Promise((res, rej) =>
      client.send('<134>Aug 22 14:30:00 myhost myapp[123]: link up on eth0', 18927, '127.0.0.1', (e) => (e ? rej(e) : res()))
    );
    client.close();
    await new Promise((r) => setTimeout(r, 150));
    const msg = pushedLogs.find((e) => e.protocol === 'syslog' && e.syslog);
    expect(msg).toBeTruthy();
    expect(msg.syslog).toMatchObject({
      ok: true, format: 'rfc3164',
      facility: 16, severity: 6,
      hostname: 'myhost', appName: 'myapp', procId: '123',
      message: 'link up on eth0',
    });
  });

  it('syslog 端口收畸形 datagram → 无 syslog 字段、条目照常落', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([], [{ port: 18928, enabled: true, type: 'syslog' }]);
    const client = dgram.createSocket('udp4');
    await new Promise((res, rej) => client.send('not a syslog line', 18928, '127.0.0.1', (e) => (e ? rej(e) : res())));
    client.close();
    await new Promise((r) => setTimeout(r, 150));
    const msg = pushedLogs.find((e) => e.protocol === 'syslog' && e.payloadText === 'not a syslog line');
    expect(msg).toBeTruthy();
    expect(msg.syslog).toBeUndefined();
  });

  it('syslog 端口 stop 后可立即重绑（与 udp 端口同一 record 生命周期）', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([], [{ port: 18929, enabled: true, type: 'syslog' }]);
    await engine.stop();
    const { failed } = await engine.start([], [{ port: 18929, enabled: true, type: 'syslog' }]);
    expect(failed).toEqual([]);
  });
});

describe('MockEngine 通配符路由', () => {
  it('* 单段通配命中', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w1', port: 18201, method: 'GET', path: '/api/*/cmd', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    const r = await get(18201, '/api/v1/cmd');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: 1 });
  });

  it('* 不匹配零段与多段', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w2', port: 18202, method: 'GET', path: '/api/*/cmd', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    expect((await get(18202, '/api/cmd')).status).toBe(404);
    expect((await get(18202, '/api/v1/v2/cmd')).status).toBe(404);
  });

  it('** 跨段通配：零段与多段均命中', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w3', port: 18203, method: 'GET', path: '/api/**', statusCode: 200, response: { ok: 3 }, enabled: true },
    ]);
    expect((await get(18203, '/api')).status).toBe(200);
    expect((await get(18203, '/api/v1/deep/x')).status).toBe(200);
  });

  it('精确端点优先于通配端点', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'wild', port: 18204, method: 'GET', path: '/users/*', statusCode: 200, response: { who: 'wild' }, enabled: true },
      { id: 'exact', port: 18204, method: 'GET', path: '/users/admin', statusCode: 200, response: { who: 'exact' }, enabled: true },
    ]);
    expect(JSON.parse((await get(18204, '/users/admin')).body)).toEqual({ who: 'exact' });
    expect(JSON.parse((await get(18204, '/users/123')).body)).toEqual({ who: 'wild' });
  });

  it('具体度：静态段多者优先，与配置顺序无关', async () => {
    engine = new MockEngine({ logBuffer });
    // 先配置更泛的 /*/b/c，验证排序生效而非顺序生效
    await engine.start([
      { id: 'less', port: 18205, method: 'GET', path: '/*/b/c', statusCode: 200, response: { who: '*-b-c' }, enabled: true },
      { id: 'more', port: 18205, method: 'GET', path: '/a/*/c', statusCode: 200, response: { who: 'a-*-c' }, enabled: true },
    ]);
    expect(JSON.parse((await get(18205, '/a/b/c')).body)).toEqual({ who: 'a-*-c' });
  });

  it('通配按 method 分桶，不跨 method 命中', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w7', port: 18207, method: 'POST', path: '/api/*', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    expect((await get(18207, '/api/x')).status).toBe(404);
    expect((await post(18207, '/api/x')).status).toBe(200);
  });

  it('命中通配时日志带 pathParams 与 endpointId', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w8', port: 18208, method: 'GET', path: '/a/*/b/**', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await get(18208, '/a/x/b/y/z');
    expect(pushedLogs[0].pathParams).toEqual(['x', 'y/z']);
    expect(pushedLogs[0].endpointId).toBe('w8');
    expect(pushedLogs[0].matched).toBe(true);
  });

  it('精确命中时日志不带 pathParams', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'e9', port: 18209, method: 'GET', path: '/a/b', statusCode: 200, response: { ok: 1 }, enabled: true },
    ]);
    await get(18209, '/a/b');
    expect(pushedLogs[0].pathParams).toBeUndefined();
  });

  it('disabled 通配端点不参与匹配', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'w10', port: 18210, method: 'GET', path: '/off/*', statusCode: 200, response: { ok: 1 }, enabled: false },
    ]);
    expect((await get(18210, '/off/x')).status).toBe(404);
  });
});

describe('MockEngine 通配 + $path 回显（spec 2026-08-27 §4）', () => {
  it('{{$path:1}} 回显单段捕获值（纯表达式注入字符串）', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'p1', port: 18220, method: 'GET', path: '/users/*', statusCode: 200,
        response: { id: '{{$path:1}}' }, enabled: true },
    ]);
    const r = await get(18220, '/users/123');
    expect(r.body).toBe('{"id":"123"}');
  });

  it('{{$path:2}} 回显 ** 多段（/ 拼回）', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'p2', port: 18221, method: 'GET', path: '/a/*/b/**', statusCode: 200,
        response: { first: '{{$path:1}}', rest: '{{$path:2}}' }, enabled: true },
    ]);
    const r = await get(18221, '/a/x/b/y/z');
    expect(JSON.parse(r.body)).toEqual({ first: 'x', rest: 'y/z' });
  });

  it('混合写法拼接：/prefix/{{$path:1}}', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'p3', port: 18222, method: 'GET', path: '/t/*', statusCode: 200,
        response: { msg: 'got-{{$path:1}}' }, enabled: true },
    ]);
    const r = await get(18222, '/t/abc');
    expect(r.body).toBe('{"msg":"got-abc"}');
  });

  it('精确端点写 {{$path:1}} → null + resolver warn（行为一致的软失败）', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([
      { id: 'p4', port: 18223, method: 'GET', path: '/exact', statusCode: 200,
        response: { id: '{{$path:1}}' }, enabled: true },
    ]);
    const r = await get(18223, '/exact');
    expect(r.body).toBe('{"id":null}');
    expect(pushedLogs.some((e) => e.source === 'resolver' && e.level === 'warn')).toBe(true);
  });
});
