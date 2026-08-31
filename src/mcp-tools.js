// MCP 工具集：与 REST 路由 1:1 映射（纯映射不做业务校验，唯一事实来源是 REST——
// 参数校验/唯一性/引擎同步都由 REST 侧负责，MCP 层只做透传与结果整形）。
// call(method, path, body?) 由 mcp-server.js 注入（fetch 封装）：成功返回 REST JSON，
// 失败抛 ToolError（payload 为 REST 错误信封 {error, code}）。
import { ToolNotFoundError } from './mcp-stdio.js';

/** REST 4xx/5xx 失败的载体：callTool 捕获后转为 isError:true 的 result */
export class ToolError extends Error {
  constructor(payload) {
    super(typeof payload?.error === 'string' ? payload.error : 'tool call failed');
    this.payload = payload;
  }
}

const CALL_TIMEOUT_MS = 30000;

/**
 * fetch 封装（stdio 轻代理与 HTTP 端点共用）：成功返回 REST JSON；
 * 连接失败/4xx/5xx 抛 ToolError（payload 为 REST 错误信封）
 */
export function createRestCall(baseUrl) {
  return async function call(method, url, body) {
    let res;
    try {
      res = await fetch(baseUrl + url, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ToolError({
        error: `mock server 不可达（${baseUrl}）：${err?.cause?.code || err?.message || err}`,
        code: 'SERVER_UNREACHABLE',
      });
    }
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 500), code: 'BAD_RESPONSE' }; }
    }
    if (!res.ok) throw new ToolError(json ?? { error: `HTTP ${res.status}`, code: 'HTTP_ERROR' });
    return json;
  };
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const PORT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 65535,
  description: '端口号（1-65535）',
};

const PATH_SCHEMA = {
  type: 'string',
  pattern: '^/',
  description: '以 / 开头；不得包含 ? 或 #；支持通配段 *（单段）与 **（跨段），通配符必须独占一段',
};

// 只拷贝白名单字段（剔除未定义项，避免把 undefined 序列化成脏 JSON）
function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/**
 * @param {{call: (method: string, path: string, body?: unknown) => Promise<unknown>}} deps
 */
export function createMcpTools({ call }) {
  const defs = [
    // ---- 端口（/api/ports，端口一等实体）----
    {
      name: 'list_ports',
      description: '列出全部 mock 端口（含类型 http/ws/tcp/udp/syslog 与启用状态）',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => call('GET', '/api/ports'),
    },
    {
      name: 'create_port',
      description: '创建 mock 端口（type 默认 http；创建后类型不可更改）',
      inputSchema: {
        type: 'object',
        properties: {
          port: PORT_SCHEMA,
          type: { enum: ['http', 'ws', 'tcp', 'udp', 'syslog'], description: '端口类型，默认 http' },
        },
        required: ['port'],
        additionalProperties: false,
      },
      handler: (_c, a) => call('POST', '/api/ports', pick(a, ['port', 'type'])),
    },
    {
      name: 'update_port',
      description: '更新端口：改号（级联迁移其下端点与 WS 服务）或启用/停用；type 不可改',
      inputSchema: {
        type: 'object',
        properties: {
          port: PORT_SCHEMA,
          newPort: { ...PORT_SCHEMA, description: '新端口号（改号时提供，1-65535）' },
          enabled: { type: 'boolean', description: '启用/停用该端口' },
        },
        required: ['port'],
        additionalProperties: false,
      },
      handler: (_c, a) => {
        // newPort 映射为 REST body.port（改号）；仅启停时 body 只带 enabled
        const body = a.newPort !== undefined
          ? { port: a.newPort, ...(a.enabled !== undefined ? { enabled: a.enabled } : {}) }
          : pick(a, ['enabled']);
        return call('PUT', `/api/ports/${a.port}`, body);
      },
    },
    {
      name: 'delete_port',
      description: '删除端口（其下全部端点与 WS 服务一并删除）',
      inputSchema: {
        type: 'object',
        properties: { port: PORT_SCHEMA },
        required: ['port'],
        additionalProperties: false,
      },
      handler: (_c, a) => call('DELETE', `/api/ports/${a.port}`),
    },

    // ---- 端点（/api/endpoints，HTTP mock 接口）----
    {
      name: 'list_endpoints',
      description: '列出 mock 端点（可选按端口过滤）',
      inputSchema: {
        type: 'object',
        properties: { port: PORT_SCHEMA },
        additionalProperties: false,
      },
      handler: async (_c, a) => {
        const list = await call('GET', '/api/endpoints');
        return a?.port === undefined ? list : list.filter((e) => e.port === Number(a.port));
      },
    },
    {
      name: 'create_endpoint',
      description: '创建 HTTP mock 端点：命中 method+path 时返回 response 的 JSON；（port,method,path）在启用端点间必须唯一',
      inputSchema: {
        type: 'object',
        properties: {
          port: PORT_SCHEMA,
          method: { enum: METHODS, description: 'HTTP 方法' },
          path: PATH_SCHEMA,
          statusCode: { type: 'integer', minimum: 100, maximum: 599, description: 'HTTP 状态码，默认 200' },
          response: { description: '响应体 JSON 值（对象/数组/字符串/数字均可，支持 {{faker}}、{{$uuid}} 等动态表达式）；省略则为 null' },
          name: { type: 'string', description: '端点名称（可选，≤50 字符）' },
        },
        required: ['port', 'method', 'path'],
        additionalProperties: false,
      },
      handler: (_c, a) => call('POST', '/api/endpoints', pick(a, ['port', 'method', 'path', 'statusCode', 'response', 'name'])),
    },
    {
      name: 'update_endpoint',
      description: '按 id 更新 mock 端点的字段（部分更新，只传要改的字段）',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '端点 id（list_endpoints 返回的 id）' },
          port: PORT_SCHEMA,
          method: { enum: METHODS },
          path: PATH_SCHEMA,
          statusCode: { type: 'integer', minimum: 100, maximum: 599 },
          response: { description: '响应体 JSON 值' },
          name: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: (_c, a) => call('PUT', `/api/endpoints/${a.id}`, pick(a, ['port', 'method', 'path', 'statusCode', 'response', 'name', 'enabled'])),
    },
    {
      name: 'delete_endpoint',
      description: '按 id 删除 mock 端点',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '端点 id' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: (_c, a) => call('DELETE', `/api/endpoints/${a.id}`),
    },

    // ---- 运行时（mock 引擎启停与状态）----
    {
      name: 'runtime_start',
      description: '启动 mock 引擎：绑定全部启用端口并加载端点/WS 服务',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => call('POST', '/api/runtime/start'),
    },
    {
      name: 'runtime_stop',
      description: '停止 mock 引擎（释放全部 mock 端口监听）',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => call('POST', '/api/runtime/stop'),
    },
    {
      name: 'runtime_status',
      description: '查询运行时状态：{端口号: {state, reason?}}，state 为 running/stopped/failed',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => call('GET', '/api/runtime/status'),
    },

    // ---- 日志（/api/logs，环形 500 条）----
    {
      name: 'get_logs',
      description: '查询最近的请求/抓包日志（最新在列表尾部），可选按端口或协议过滤',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500, description: '返回条数，默认 100' },
          port: PORT_SCHEMA,
          protocol: { enum: ['http', 'tcp', 'udp', 'syslog'], description: '按协议过滤' },
        },
        additionalProperties: false,
      },
      handler: async (_c, a) => {
        const limit = Math.min(Math.max(Number(a?.limit) || 100, 1), 500);
        let list = await call('GET', `/api/logs?limit=${limit}`);
        if (a?.port !== undefined) list = list.filter((e) => e.port === Number(a.port));
        if (a?.protocol !== undefined) list = list.filter((e) => (e.protocol || 'http') === a.protocol);
        return list;
      },
    },
    {
      name: 'clear_logs',
      description: '清空全部日志',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => call('DELETE', '/api/logs'),
    },

    // ---- WS 服务（/api/services，SOAP mock）----
    {
      name: 'list_services',
      description: '列出 WebService（SOAP）mock 服务及其 operations（不含 WSDL 原文，仅 hasWsdl 标志）',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => call('GET', '/api/services'),
    },
    {
      name: 'create_service',
      description: '创建 WS 服务：提供 wsdl 原文时解析生成 operations，否则建空服务（后续用 update_operation 配置响应）；自动补建 ws 型端口实体',
      inputSchema: {
        type: 'object',
        properties: {
          port: PORT_SCHEMA,
          path: { type: 'string', pattern: '^/', description: '服务路径（以 / 开头，不含 ?）；同端口启用服务间唯一' },
          name: { type: 'string', description: '服务名（可选，默认取 path 末段）' },
          wsdl: { type: 'string', description: 'WSDL XML 原文（可选）' },
        },
        required: ['port', 'path'],
        additionalProperties: false,
      },
      handler: (_c, a) => call('POST', '/api/services', pick(a, ['port', 'path', 'name', 'wsdl'])),
    },
    {
      name: 'delete_service',
      description: '按 id 删除 WS 服务',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '服务 id' } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: (_c, a) => call('DELETE', `/api/services/${a.id}`),
    },
    {
      name: 'update_operation',
      description: '更新 WS 服务的 operation：设置响应 XML（responseXml）、状态码、fault 模式、启用/停用等',
      inputSchema: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: '服务 id' },
          operationId: { type: 'string', description: 'operation id（list_services 返回）' },
          name: { type: 'string', description: 'operation 名（重命名用）' },
          soapAction: { type: ['string', 'null'], description: 'SOAPAction（null 清空）' },
          responseType: { enum: ['normal', 'fault'], description: 'normal=正常响应，fault=SOAP Fault' },
          status: { type: 'integer', minimum: 100, maximum: 599, description: 'HTTP 状态码' },
          responseXml: { type: 'string', description: 'SOAP 响应 XML 原文（支持动态表达式）' },
          enabled: { type: 'boolean' },
        },
        required: ['serviceId', 'operationId'],
        additionalProperties: false,
      },
      handler: (_c, a) => call('PUT', `/api/services/${a.serviceId}/operations/${a.operationId}`,
        pick(a, ['name', 'soapAction', 'responseType', 'status', 'responseXml', 'enabled'])),
    },
  ];

  return {
    listTools: () => defs.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    /** 工具执行入口：ToolError → isError 结果；未知工具 → ToolNotFoundError（协议层转 -32602） */
    async callTool(name, args) {
      const def = defs.find((d) => d.name === name);
      if (!def) throw new ToolNotFoundError(name);
      try {
        return { ok: true, data: await def.handler(call, args) };
      } catch (err) {
        if (err instanceof ToolError) return { ok: false, text: JSON.stringify(err.payload) };
        throw err;
      }
    },
    names: () => defs.map((d) => d.name),
  };
}
