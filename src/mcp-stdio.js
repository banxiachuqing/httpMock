// MCP 协议核心（JSON-RPC 2.0，协议版本 2025-06-18）——传输无关。
// createMcpCore：纯消息处理（消息 → 响应 | null），stdio 与 HTTP 两种传输共用；
// createMcpServer：stdio 传输壳（readline 逐行读 stdin + 在途请求生命周期）。
// 只支持最小面：initialize / ping / tools/list / tools/call；其余带 id 回 -32601，通知静默。
import readline from 'node:readline';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const JSONRPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

// tools/call 引用不存在的工具时按 MCP 规范回 -32602（区别于业务失败的 isError 结果）
export class ToolNotFoundError extends Error {
  constructor(name) {
    super(`Unknown tool: ${name}`);
    this.name = 'ToolNotFoundError';
  }
}

/**
 * 传输无关的协议核心。
 * @param {object} opts
 * @param {{name: string, version: string}} opts.serverInfo
 * @param {() => Array<{name: string, description: string, inputSchema: object}>} opts.listTools
 * @param {(name: string, args: object|undefined) => Promise<{ok: true, data?: unknown} |
 *   {ok: false, text?: string, message?: string}>} opts.onToolCall
 *   ok:false → 工具级失败（isError:true 的 result）；throw → 协议兜底（TOOL_CRASH）
 * @returns {(msg: object) => Promise<object|null>} handleMessage：返回应发给客户端的响应对象；
 *          返回 null 表示无需响应（通知）
 */
export function createMcpCore({ serverInfo, listTools, onToolCall }) {
  return async function handleMessage(msg) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      return { jsonrpc: '2.0', id: null, error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request' } };
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method !== 'string') {
      return hasId
        ? { jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request: missing method' } }
        : null; // 无 method 无 id 的畸形包静默丢弃
    }
    switch (msg.method) {
      case 'initialize': {
        // 版本协商：客户端请求的版本受支持则原样回，否则回本服务器唯一支持版本（由客户端决定是否继续）
        const version = msg.params?.protocolVersion === MCP_PROTOCOL_VERSION
          ? msg.params.protocolVersion
          : MCP_PROTOCOL_VERSION;
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id: msg.id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id: msg.id, result: { tools: listTools() } };
      case 'tools/call': {
        const name = msg.params?.name;
        if (typeof name !== 'string') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: JSONRPC_ERRORS.INVALID_PARAMS, message: 'Invalid params: tools/call requires params.name' },
          };
        }
        try {
          const out = await onToolCall(name, msg.params?.arguments);
          if (out.ok) {
            return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out.data ?? null) }] } };
          }
          const text = out.text ?? JSON.stringify({ error: out.message || 'tool failed', code: 'TOOL_ERROR' });
          return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: true } };
        } catch (err) {
          if (err instanceof ToolNotFoundError) {
            return { jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC_ERRORS.INVALID_PARAMS, message: err.message } };
          }
          const text = JSON.stringify({ error: err?.message || 'tool crashed', code: 'TOOL_CRASH' });
          return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: true } };
        }
      }
      default:
        // 通知（无 id，如 notifications/initialized）静默丢弃；带 id 的未知请求回 -32601
        return hasId
          ? { jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC_ERRORS.METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` } }
          : null;
    }
  };
}

/**
 * stdio 传输壳。
 * @param {object} opts
 * @param {import('node:stream').Readable} [opts.input] 默认 process.stdin
 * @param {import('node:stream').Writable} [opts.output] 默认 process.stdout
 * @param {() => void} [opts.onEnd] stdin EOF 且在途请求全部完成后触发（客户端断开）
 */
export function createMcpServer({
  input = process.stdin,
  output = process.stdout,
  serverInfo,
  listTools,
  onToolCall,
  onEnd,
}) {
  const handleMessage = createMcpCore({ serverInfo, listTools, onToolCall });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const send = (msg) => output.write(JSON.stringify(msg) + '\n');

  // stdin EOF 不能立即结束：在途 tools/call 的响应必须送达（否则客户端断连时最后一个调用被截断）
  let inflight = 0;
  let inputEnded = false;
  const maybeFinish = () => {
    if (inputEnded && inflight === 0) onEnd?.();
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // 解析失败时 id 无法确定，按规范回 id:null
      send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_ERRORS.PARSE, message: 'Parse error' } });
      return;
    }
    inflight += 1;
    handleMessage(msg)
      .then((response) => { if (response) send(response); })
      .catch(() => {
        // handleMessage 自身不应抛错；兜底协议级内部错误
        if (msg && msg.id !== undefined && msg.id !== null) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC_ERRORS.INTERNAL, message: 'Internal error' } });
        }
      })
      .finally(() => {
        inflight -= 1;
        maybeFinish();
      });
  });
  rl.on('close', () => { inputEnded = true; maybeFinish(); });

  return { close: () => rl.close() };
}
