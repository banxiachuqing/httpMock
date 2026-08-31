import { describe, it, expect } from 'vitest';
import { createMcpTools, ToolError } from '../../src/mcp-tools.js';
import { ToolNotFoundError } from '../../src/mcp-stdio.js';

// stub call：记录 (method, path, body)；可预置路径 → 响应；也可预置抛出的 ToolError
function stubCall({ responses = {}, throws = {} } = {}) {
  const calls = [];
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    if (throws[`${method} ${path}`]) throw throws[`${method} ${path}`];
    return responses[`${method} ${path}`] ?? { ok: true };
  };
  return { call, calls };
}

function setup(opts) {
  const stub = stubCall(opts);
  return { tools: createMcpTools({ call: stub.call }), ...stub };
}

describe('MCP 工具集', () => {
  it('工具数量与命名：17 个，name 全部唯一', () => {
    const { tools } = setup();
    const names = tools.names();
    expect(names).toHaveLength(17);
    expect(new Set(names).size).toBe(17);
  });

  it('schema 完整性：每个工具有 name/description/inputSchema；required 是 properties 子集', () => {
    const { tools } = setup();
    for (const t of tools.listTools()) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(5);
      expect(t.inputSchema.type).toBe('object');
      for (const req of t.inputSchema.required ?? []) {
        expect(t.inputSchema.properties).toHaveProperty(req);
      }
    }
  });

  it('create_port → POST /api/ports 透传 port/type（type 省略时不带键）', async () => {
    const { tools, calls } = setup();
    await tools.callTool('create_port', { port: 9001 });
    await tools.callTool('create_port', { port: 9002, type: 'ws' });
    expect(calls[0]).toEqual({ method: 'POST', path: '/api/ports', body: { port: 9001 } });
    expect(calls[1]).toEqual({ method: 'POST', path: '/api/ports', body: { port: 9002, type: 'ws' } });
  });

  it('update_port：newPort 映射为 body.port；仅启停时 body 只带 enabled', async () => {
    const { tools, calls } = setup();
    await tools.callTool('update_port', { port: 9001, newPort: 9100 });
    await tools.callTool('update_port', { port: 9001, enabled: false });
    await tools.callTool('update_port', { port: 9001, newPort: 9101, enabled: true });
    expect(calls[0].path).toBe('/api/ports/9001');
    expect(calls[0].body).toEqual({ port: 9100 });
    expect(calls[1].body).toEqual({ enabled: false });
    expect(calls[2].body).toEqual({ port: 9101, enabled: true });
  });

  it('delete_port → DELETE /api/ports/:port', async () => {
    const { tools, calls } = setup();
    await tools.callTool('delete_port', { port: 9001 });
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/api/ports/9001', body: undefined });
  });

  it('list_endpoints 支持 port 过滤（MCP 层 filter）', async () => {
    const list = [
      { id: 'a', port: 9001 },
      { id: 'b', port: 9002 },
    ];
    const { tools, calls } = setup({ responses: { 'GET /api/endpoints': list } });
    const all = await tools.callTool('list_endpoints', {});
    expect(calls[0]).toEqual({ method: 'GET', path: '/api/endpoints', body: undefined });
    expect(all.data).toEqual(list);
    const filtered = await tools.callTool('list_endpoints', { port: 9002 });
    expect(filtered.data).toEqual([{ id: 'b', port: 9002 }]);
  });

  it('create_endpoint 只透传白名单字段（剔除 undefined）', async () => {
    const { tools, calls } = setup();
    await tools.callTool('create_endpoint', {
      port: 9001, method: 'GET', path: '/hi', statusCode: 404, response: { msg: 'no' }, name: 'x', junk: 1,
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/endpoints',
      body: { port: 9001, method: 'GET', path: '/hi', statusCode: 404, response: { msg: 'no' }, name: 'x' },
    });
  });

  it('update_endpoint：id 进路径不进 body', async () => {
    const { tools, calls } = setup();
    await tools.callTool('update_endpoint', { id: 'e1', response: { ok: true }, enabled: false });
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/api/endpoints/e1',
      body: { response: { ok: true }, enabled: false },
    });
  });

  it('runtime 三件套映射 start/stop/status', async () => {
    const { tools, calls } = setup();
    await tools.callTool('runtime_start', {});
    await tools.callTool('runtime_stop', {});
    await tools.callTool('runtime_status', {});
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/runtime/start',
      'POST /api/runtime/stop',
      'GET /api/runtime/status',
    ]);
  });

  it('get_logs：limit 钳位进 query，port/protocol 在 MCP 层过滤（非 http 抓包条目 protocol 缺省按 http 归类）', async () => {
    const logs = [
      { id: '1', port: 9001, method: 'GET' },           // http（无 protocol 字段）
      { id: '2', port: 9002, protocol: 'tcp', bytes: 3 },
      { id: '3', port: 9001, protocol: 'udp', bytes: 5 },
    ];
    const { tools, calls } = setup({ responses: { 'GET /api/logs?limit=2': logs } });
    const out = await tools.callTool('get_logs', { limit: 2, port: 9001, protocol: 'http' });
    expect(calls[0].path).toBe('/api/logs?limit=2');
    expect(out.data).toEqual([{ id: '1', port: 9001, method: 'GET' }]);
  });

  it('get_logs：limit 缺省为 100，非法值回退 100，上限 500', async () => {
    const { tools, calls } = setup();
    await tools.callTool('get_logs', {});
    await tools.callTool('get_logs', { limit: 'bogus' });
    await tools.callTool('get_logs', { limit: 99999 });
    expect(calls.map((c) => c.path)).toEqual([
      '/api/logs?limit=100',
      '/api/logs?limit=100',
      '/api/logs?limit=500',
    ]);
  });

  it('clear_logs → DELETE /api/logs', async () => {
    const { tools, calls } = setup();
    await tools.callTool('clear_logs', {});
    expect(calls[0]).toEqual({ method: 'DELETE', path: '/api/logs', body: undefined });
  });

  it('create_service → POST /api/services；update_operation → PUT operations 子路径', async () => {
    const { tools, calls } = setup();
    await tools.callTool('create_service', { port: 9003, path: '/svc', name: 'N', wsdl: '<xml/>' });
    await tools.callTool('update_operation', { serviceId: 's1', operationId: 'o1', responseXml: '<r/>', status: 500 });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/services',
      body: { port: 9003, path: '/svc', name: 'N', wsdl: '<xml/>' },
    });
    expect(calls[1]).toEqual({
      method: 'PUT',
      path: '/api/services/s1/operations/o1',
      body: { responseXml: '<r/>', status: 500 },
    });
  });

  it('REST 失败（ToolError）→ callTool 返回 ok:false 且 text 为错误信封 JSON', async () => {
    const { tools } = setup({
      throws: { 'POST /api/endpoints': new ToolError({ error: 'duplicate GET /hi on port 9001', code: 'DUPLICATE_ENDPOINT' }) },
    });
    const out = await tools.callTool('create_endpoint', { port: 9001, method: 'GET', path: '/hi' });
    expect(out.ok).toBe(false);
    expect(JSON.parse(out.text)).toEqual({ error: 'duplicate GET /hi on port 9001', code: 'DUPLICATE_ENDPOINT' });
  });

  it('未知工具 → ToolNotFoundError（协议层转 -32602）', async () => {
    const { tools } = setup();
    await expect(tools.callTool('nope', {})).rejects.toBeInstanceOf(ToolNotFoundError);
  });
});
