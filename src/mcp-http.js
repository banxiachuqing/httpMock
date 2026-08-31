// /mcp —— Streamable HTTP 传输（无状态模式）的 MCP 端点，由设置页开关（settings.mcpEnabled）门控。
// 与 stdio 共用 createMcpCore + 17 个工具；工具经进程内自 fetch（按请求 Host 回环）调用 REST，
// 与 stdio 轻代理语义完全一致（校验/唯一性/引擎同步全走同一 REST 事实源）。
// 无状态模式：不返回 Mcp-Session-Id（每个 POST 独立 JSON-RPC，规范允许）；GET/DELETE 回 405
// （无 SSE 推送流、无 session 可删）。端点关闭时伪装成不存在（404），不暴露能力。
import { createMcpCore } from './mcp-stdio.js';
import { createMcpTools, createRestCall } from './mcp-tools.js';
import { getVersion } from './version.js';

export function registerMcpHttpRoutes(app, { configStore }) {
  const handler = async (req, res, next) => {
    try {
      if (configStore.config.settings.mcpEnabled !== true) {
        res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
        return;
      }
      if (req.method !== 'POST') {
        res.status(405).json({ error: 'method not allowed (stateless MCP: POST only)', code: 'METHOD_NOT_ALLOWED' });
        return;
      }
      const msg = req.body;
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
        res.status(400).json({ error: 'invalid JSON-RPC request', code: 'BAD_REQUEST' });
        return;
      }
      const base = `http://${req.headers.host || '127.0.0.1'}`;
      const tools = createMcpTools({ call: createRestCall(base) });
      const handleMessage = createMcpCore({
        serverInfo: { name: 'mock-tools', version: await getVersion() },
        listTools: tools.listTools,
        onToolCall: (name, args) => tools.callTool(name, args),
      });
      const response = await handleMessage(msg);
      if (!response) {
        // 通知（无 id）：按 Streamable HTTP 规范回 202 无内容
        res.status(202).end();
        return;
      }
      res.status(200).json(response);
    } catch (e) { next(e); }
  };
  app.all('/mcp', handler);
}
