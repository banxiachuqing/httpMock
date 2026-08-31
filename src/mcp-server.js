// MCP stdio 入口组装：发现/拉起 mock server → REST 轻代理 → stdio 协议层。
// 设计决策：MCP 进程不跑
// ConfigStore/MockEngine（双进程写同一 data.json 会互相覆盖），只经 HTTP 调用已运行 server 的
// REST API——写路径自动获得 syncMockEngine 同步；AI 客户端断开不影响已运行的 mock 服务。
// （HTTP 传输的 MCP 端点在 src/mcp-http.js，由 WebUI 设置开关控制，跑在 server 进程内。）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMcpServer, MCP_PROTOCOL_VERSION } from './mcp-stdio.js';
import { createMcpTools, createRestCall } from './mcp-tools.js';
import { getVersion } from './version.js';
import { defaultStoragePath } from './paths.js';

// 与 server.js listenWithFallback 的 +50 回退一致：5050 起步，最远落到 5100
const SCAN_PORTS = Array.from({ length: 51 }, (_, i) => 5050 + i);
const SPAWN_READY_TIMEOUT_MS = 12000;
const PROBE_TIMEOUT_MS = 800;

// 诊断只进 stderr（stdout 是 MCP 协议专用通道）
const log = (msg) => process.stderr.write(`[mock-mcp] ${msg}\n`);

/** 读 data.json 的 settings.uiPort 作为首选探测端口（自定义 uiPort 的部署不必扫全段） */
async function readConfiguredUiPort() {
  try {
    const raw = await fs.readFile(path.join(defaultStoragePath(), 'data.json'), 'utf8');
    const p = Number(JSON.parse(raw)?.settings?.uiPort);
    return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : null;
  } catch { return null; }
}

async function probeHealth(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch { return false; }
}

// dev 模式自动拉起固定用本仓库 server.js（不从 argv 推导：`node src/mcp-server.js` 直跑时
// argv[1] 是本文件，spawn 它会再次进入 MCP 而不是 server）；编译产物走 execPath 分支，用不到此路径
function resolveSelfServerPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
}

/** detached 拉起 headless server：MOCK_HEADLESS=1 不开浏览器；stdio 丢弃，生命周期独立于本进程 */
function spawnHeadlessServer(env = process.env) {
  const isCompiled = !!env.MOCK_SERVER_DIR;
  const args = isCompiled ? [] : [resolveSelfServerPath()];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...env, MOCK_HEADLESS: '1' },
  });
  child.unref();
  return child;
}

/**
 * 发现 mock server：
 * 1) MOCK_MCP_URL 显式指定（连不上直接报错——显式配置失败不该静默改道）
 * 2) 探测配置 uiPort → 5050..5100
 * 3) 全部落空 → detached 自动拉起 headless server 并轮询 ready
 * @returns {Promise<string>} baseUrl（无尾斜杠）
 */
export async function discoverServer({ env = process.env, spawnFn = spawnHeadlessServer } = {}) {
  if (env.MOCK_MCP_URL) {
    const base = env.MOCK_MCP_URL.replace(/\/+$/, '');
    if (await probeHealth(base)) return base;
    throw new Error(`MOCK_MCP_URL=${base} 不可达（GET /api/health 失败）`);
  }
  const configured = await readConfiguredUiPort();
  const candidates = [...new Set([configured, ...SCAN_PORTS].filter(Boolean))];
  for (const p of candidates) {
    const base = `http://127.0.0.1:${p}`;
    if (await probeHealth(base)) return base;
  }
  log('未发现运行中的 mock server，自动拉起 headless 实例...');
  spawnFn(env);
  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const p of candidates) {
      const base = `http://127.0.0.1:${p}`;
      if (await probeHealth(base)) return base;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('mock server 自动拉起超时；请先手动启动：pnpm start（或 node server.js）');
}

export async function startMcpCli({ env = process.env } = {}) {
  const baseUrl = await discoverServer({ env });
  log(`mock server: ${baseUrl}`);
  const tools = createMcpTools({ call: createRestCall(baseUrl) });
  createMcpServer({
    serverInfo: { name: 'mock-tools', version: await getVersion() },
    listTools: tools.listTools,
    onToolCall: (name, args) => tools.callTool(name, args),
    onEnd: () => process.exit(0), // stdin EOF = AI 客户端断开
  });
  log(`MCP stdio server 就绪（协议 ${MCP_PROTOCOL_VERSION}），${tools.names().length} 个工具`);
}

// 与 server.js 相同的 isMain 判定（pathToFileURL 处理 Windows 盘符差异）；支持 `node src/mcp-server.js` 直跑。
// 排除 MOCK_SERVER_DIR（编译产物）：bun 内联后 import.meta.url 解析为可执行文件路径，与 argv[1] 相同会
// 误判 isMain 导致 startMcpCli 双跑、双 readline 抢 stdin；产物入口固定走 server.js 的 mcp 分支。
const isMain = !process.env.MOCK_SERVER_DIR
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href;
if (isMain) {
  startMcpCli().catch((e) => {
    console.error('Failed to start MCP server:', e.message);
    process.exit(1);
  });
}
