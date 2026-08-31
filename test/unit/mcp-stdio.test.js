import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  createMcpServer,
  MCP_PROTOCOL_VERSION,
  ToolNotFoundError,
} from '../../src/mcp-stdio.js';

// stdin/stdout 全部换成内存流：写入 send()/sendRaw()，响应按行收进 lines[]
function setup({ onToolCall, onEnd } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = '';
  output.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  const server = createMcpServer({
    input,
    output,
    serverInfo: { name: 'mock-tools', version: '0.0.0-test' },
    listTools: () => [{ name: 't1', description: 'demo tool', inputSchema: { type: 'object' } }],
    onToolCall: onToolCall ?? (async () => ({ ok: true, data: { fine: 1 } })),
    onEnd,
  });
  return {
    server,
    lines,
    send: (obj) => input.write(JSON.stringify(obj) + '\n'),
    sendRaw: (s) => input.write(s + '\n'),
    end: () => input.end(),
  };
}

async function waitFor(lines, pred, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = lines.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('expected response not received');
}

describe('MCP stdio 协议层', () => {
  it('initialize 回协议版本 + tools 能力 + serverInfo', async () => {
    const { send, lines } = setup();
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } });
    const res = await waitFor(lines, (m) => m.id === 1);
    expect(res.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.serverInfo).toEqual({ name: 'mock-tools', version: '0.0.0-test' });
  });

  it('客户端提议旧版本时回本服务器支持的版本（协商权在服务端）', async () => {
    const { send, lines } = setup();
    send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    const res = await waitFor(lines, (m) => m.id === 2);
    expect(res.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('ping 回空 result', async () => {
    const { send, lines } = setup();
    send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    const res = await waitFor(lines, (m) => m.id === 3);
    expect(res.result).toEqual({});
  });

  it('tools/list 返回注入的工具清单', async () => {
    const { send, lines } = setup();
    send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    const res = await waitFor(lines, (m) => m.id === 4);
    expect(res.result.tools).toHaveLength(1);
    expect(res.result.tools[0].name).toBe('t1');
    expect(res.result.tools[0].inputSchema).toEqual({ type: 'object' });
  });

  it('tools/call 成功：data 序列化进 content[0].text', async () => {
    const { send, lines } = setup();
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 't1', arguments: { x: 1 } } });
    const res = await waitFor(lines, (m) => m.id === 5);
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.content[0].text)).toEqual({ fine: 1 });
  });

  it('onToolCall 返回 ok:false → isError:true + 错误文本', async () => {
    const { send, lines } = setup({
      onToolCall: async () => ({ ok: false, text: '{"error":"dup","code":"DUPLICATE_ENDPOINT"}' }),
    });
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 't1', arguments: {} } });
    const res = await waitFor(lines, (m) => m.id === 6);
    expect(res.result.isError).toBe(true);
    expect(JSON.parse(res.result.content[0].text)).toEqual({ error: 'dup', code: 'DUPLICATE_ENDPOINT' });
  });

  it('tools/call 未指定 arguments 时 handler 收到 undefined 且 data 为 null 兜底', async () => {
    const { send, lines } = setup({
      onToolCall: async (_name, args) => ({ ok: true, data: args ?? null }),
    });
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 't1' } });
    const res = await waitFor(lines, (m) => m.id === 7);
    expect(JSON.parse(res.result.content[0].text)).toBeNull();
  });

  it('未知工具抛 ToolNotFoundError → JSON-RPC -32602', async () => {
    const { send, lines } = setup({
      onToolCall: async () => { throw new ToolNotFoundError('nope'); },
    });
    send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } });
    const res = await waitFor(lines, (m) => m.id === 8);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain('nope');
  });

  it('handler 崩溃 → isError:true + TOOL_CRASH（进程不挂）', async () => {
    const { send, lines } = setup({
      onToolCall: async () => { throw new Error('boom'); },
    });
    send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 't1' } });
    const res = await waitFor(lines, (m) => m.id === 9);
    expect(res.result.isError).toBe(true);
    expect(JSON.parse(res.result.content[0].text).code).toBe('TOOL_CRASH');
  });

  it('tools/call 缺 params.name → -32602', async () => {
    const { send, lines } = setup();
    send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: {} });
    const res = await waitFor(lines, (m) => m.id === 10);
    expect(res.error.code).toBe(-32602);
  });

  it('带 id 的未知请求 → -32601', async () => {
    const { send, lines } = setup();
    send({ jsonrpc: '2.0', id: 11, method: 'resources/list' });
    const res = await waitFor(lines, (m) => m.id === 11);
    expect(res.error.code).toBe(-32601);
  });

  it('通知（无 id）静默丢弃：notifications/initialized 与未知通知都不产生响应', async () => {
    const { send, lines, end } = setup();
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', method: 'notifications/whatever' });
    end();
    await new Promise((r) => setTimeout(r, 50));
    expect(lines).toHaveLength(0);
  });

  it('畸形 JSON 行 → -32700 且 id 为 null', async () => {
    const { sendRaw, lines } = setup();
    sendRaw('{not json');
    const res = await waitFor(lines, (m) => m.error?.code === -32700);
    expect(res.id).toBeNull();
  });

  it('非对象 payload（数组/字面量）→ -32600', async () => {
    const { sendRaw, lines } = setup();
    sendRaw('[1,2,3]');
    const res = await waitFor(lines, (m) => m.error?.code === -32600);
    expect(res.id).toBeNull();
  });

  it('stdin EOF 触发 onEnd（客户端断开）', async () => {
    let ended = false;
    const s = setup({ onEnd: () => { ended = true; } });
    s.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toBe(true);
    s.server.close();
  });

  it('stdin EOF 早于在途 tools/call 完成时：响应仍送达，onEnd 推迟到调用结束', async () => {
    let ended = false;
    let resolveCall;
    const s = setup({
      onToolCall: () => new Promise((r) => { resolveCall = r; }),
      onEnd: () => { ended = true; },
    });
    s.send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 't1' } });
    s.end(); // EOF 立即到达，调用还在途
    await new Promise((r) => setTimeout(r, 30));
    expect(ended).toBe(false); // 不因 EOF 抢跑
    resolveCall({ ok: true, data: { late: true } });
    const res = await waitFor(s.lines, (m) => m.id === 20);
    expect(JSON.parse(res.result.content[0].text)).toEqual({ late: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toBe(true); // 响应送达后才结束
  });
});
