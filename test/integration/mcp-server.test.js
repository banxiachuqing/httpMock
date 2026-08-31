import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server.js';
import { tempDir } from '../helpers/temp-dir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let handle, dir;

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  if (dir) dir.cleanup();
  dir = undefined;
});

/** 起 `node server.js mcp` 子进程，返回按 id 关联的 JSON-RPC 客户端 */
function startMcpChild(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), 'mcp'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const pending = new Map();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 1;
  const request = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP 请求超时: ${method}\nstderr: ${stderr}`));
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request, stderr: () => stderr };
}

async function hitMock(port, target) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${target}`, { signal: AbortSignal.timeout(3000) });
    return { status: res.status, body: await res.json() };
  } catch (e) {
    return { error: e?.cause?.code || e?.message };
  }
}

// 随机 mock 端口，降低与开发机已占端口的碰撞概率
const MOCK_PORT = 39100 + Math.floor(Math.random() * 500);

describe('MCP stdio 端到端（MOCK_MCP_URL 直连已运行 server）', () => {
  it('握手 → create_endpoint → runtime_start → mock 端口真实响应 → get_logs → runtime_stop', async () => {
    dir = tempDir('mock-mcp-');
    handle = await startServer({ storagePath: dir.path, uiPort: 0, openBrowser: false });
    const mcp = startMcpChild({ MOCK_MCP_URL: `http://127.0.0.1:${handle.port}` });
    try {
      // 1. initialize 握手
      const init = await mcp.request('initialize', { protocolVersion: '2025-06-18' });
      expect(init.result.serverInfo.name).toBe('mock-tools');
      expect(init.result.capabilities.tools).toBeDefined();

      // 2. tools/list：全量工具在列
      const list = await mcp.request('tools/list', {});
      const names = list.result.tools.map((t) => t.name);
      expect(names).toContain('create_endpoint');
      expect(names.length).toBe(17);

      // 3. tools/call 创建端点（MCP → REST → ConfigStore）
      const created = await mcp.request('tools/call', {
        name: 'create_endpoint',
        arguments: { port: MOCK_PORT, method: 'GET', path: '/hello', response: { msg: 'world' }, name: 'e2e' },
      });
      expect(created.result.isError).toBeUndefined();
      const ep = JSON.parse(created.result.content[0].text);
      expect(ep.id).toBeTruthy();

      // 4. REST 侧可见（同一份配置）
      const rest = await fetch(`http://127.0.0.1:${handle.port}/api/endpoints`);
      const endpoints = await rest.json();
      expect(endpoints.some((e) => e.id === ep.id && e.path === '/hello')).toBe(true);

      // 5. runtime_start → mock 引擎真实绑定并响应（MCP 写路径已触发引擎同步）
      await mcp.request('tools/call', { name: 'runtime_start', arguments: {} });
      const hit = await hitMock(MOCK_PORT, '/hello');
      expect(hit.status).toBe(200);
      expect(hit.body).toEqual({ msg: 'world' });

      // 6. get_logs 能看到刚才的请求
      const logs = await mcp.request('tools/call', {
        name: 'get_logs',
        arguments: { limit: 50, port: MOCK_PORT },
      });
      const entries = JSON.parse(logs.result.content[0].text);
      expect(entries.some((e) => e.path === '/hello' && e.matched)).toBe(true);

      // 7. runtime_stop → 端口释放（连接拒绝而非 404）
      await mcp.request('tools/call', { name: 'runtime_stop', arguments: {} });
      const afterStop = await hitMock(MOCK_PORT, '/hello');
      expect(afterStop.error).toBeTruthy();
    } finally {
      mcp.child.kill('SIGKILL');
    }
  }, 30000);

  it('REST 业务失败透传为 isError 结果（唯一性冲突）', async () => {
    dir = tempDir('mock-mcp-');
    handle = await startServer({ storagePath: dir.path, uiPort: 0, openBrowser: false });
    const mcp = startMcpChild({ MOCK_MCP_URL: `http://127.0.0.1:${handle.port}` });
    try {
      const args = { port: MOCK_PORT, method: 'GET', path: '/dup', response: null };
      await mcp.request('tools/call', { name: 'create_endpoint', arguments: args });
      const second = await mcp.request('tools/call', { name: 'create_endpoint', arguments: args });
      expect(second.result.isError).toBe(true);
      const err = JSON.parse(second.result.content[0].text);
      expect(err.code).toBe('DUPLICATE_ENDPOINT');
    } finally {
      mcp.child.kill('SIGKILL');
    }
  }, 30000);

  it('未知工具回 JSON-RPC -32602', async () => {
    dir = tempDir('mock-mcp-');
    handle = await startServer({ storagePath: dir.path, uiPort: 0, openBrowser: false });
    const mcp = startMcpChild({ MOCK_MCP_URL: `http://127.0.0.1:${handle.port}` });
    try {
      const res = await mcp.request('tools/call', { name: 'nope', arguments: {} });
      expect(res.error?.code).toBe(-32602);
    } finally {
      mcp.child.kill('SIGKILL');
    }
  }, 30000);

  it('MOCK_MCP_URL 不可达时快速失败退出（不静默改道拉起）', async () => {
    dir = tempDir('mock-mcp-');
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), 'mcp'], {
      cwd: ROOT,
      env: { ...process.env, MOCK_MCP_URL: 'http://127.0.0.1:59999' },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('MOCK_MCP_URL');
  }, 15000);
});
