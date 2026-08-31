import { describe, it, expect, afterEach } from 'vitest';
import { startServer } from '../../server.js';
import { tempDir } from '../helpers/temp-dir.js';

// MCP over HTTP（/mcp，Streamable HTTP 无状态模式，设置开关门控）：
// 端点跑在 server 进程内，工具经进程内自 fetch（Host 头回环）调用真实 REST。
let handle, dir;

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  if (dir) dir.cleanup();
  dir = undefined;
});

async function boot() {
  dir = tempDir('mock-mcp-http-');
  handle = await startServer({ storagePath: dir.path, uiPort: 0, openBrowser: false });
  return `http://127.0.0.1:${handle.port}`;
}

const rpc = async (base, body, method = 'POST') => {
  const res = await fetch(`${base}/mcp`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

describe('/mcp HTTP 端点（设置开关门控）', () => {
  it('默认关闭：POST /mcp → 404，不暴露能力', async () => {
    const base = await boot();
    const res = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('GET /mcp → 405（无状态模式不提供 SSE 流）', async () => {
    const base = await boot();
    await fetch(`${base}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { mcpEnabled: true } }),
    });
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(405);
  });

  it('PATCH mcpEnabled 非布尔 → 400', async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { mcpEnabled: 'yes' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_VALUE');
  });

  it('开关打开：initialize → tools/list → tools/call（自 fetch 落到真实 REST）→ 通知 202', async () => {
    const base = await boot();
    await fetch(`${base}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { mcpEnabled: true } }),
    });

    // initialize
    const init = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('mock-tools');
    expect(init.body.result.protocolVersion).toBe('2025-06-18');

    // tools/list：17 个工具
    const list = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.body.result.tools).toHaveLength(17);

    // tools/call：经 Host 回环写到真实 ConfigStore（4502 仅入库，不涉及端口绑定冲突）
    const call = await rpc(base, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'create_endpoint',
        arguments: { port: 4502, method: 'GET', path: '/via-http-mcp', response: { ok: 1 } },
      },
    });
    expect(call.status).toBe(200);
    expect(call.body.result.isError).toBeUndefined();
    const ep = JSON.parse(call.body.result.content[0].text);
    expect(ep.id).toBeTruthy();

    // REST 侧可见
    const endpoints = await (await fetch(`${base}/api/endpoints`)).json();
    expect(endpoints.some((e) => e.id === ep.id && e.path === '/via-http-mcp')).toBe(true);

    // 未知工具 → JSON-RPC -32602（HTTP 200 承载 JSON-RPC 错误）
    const unknown = await rpc(base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
    expect(unknown.status).toBe(200);
    expect(unknown.body.error.code).toBe(-32602);

    // 通知（无 id）→ 202 空体
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
  });

  it('开关持久化：重启 server 后 mcpEnabled 保持', async () => {
    const base = await boot();
    await fetch(`${base}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { mcpEnabled: true } }),
    });
    const port = handle.port;
    await handle.close();
    handle = undefined;

    // 同一 storagePath 重开（模拟重启）
    handle = await startServer({ storagePath: dir.path, uiPort: port, openBrowser: false });
    const base2 = `http://127.0.0.1:${handle.port}`;
    const res = await rpc(base2, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(200);

    // 关闭后再开 mock：端点重新伪装 404
    await fetch(`${base2}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { mcpEnabled: false } }),
    });
    const closed = await rpc(base2, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    expect(closed.status).toBe(404);
  });
});
