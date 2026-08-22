import http from 'node:http';
import crypto from 'node:crypto';
import { resolve } from './expression-resolver.js';
import {
  detectSoapVersion,
  extractAction,
  isWellFormedXml,
  extractBodyOperation,
  matchOperation,
  buildFaultXml,
} from './soap-router.js';
import { buildSkeletonWsdl, rewriteAddress } from './wsdl.js';
import { createTcpCaptureServer, createUdpCaptureSocket } from './capture.js';

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

// 日志条目 body 预览上限：防止大请求体（最多 maxBodyBytes=4MB）随日志经 SSE 无限放大内存
const MAX_LOG_PREVIEW_BYTES = 8192;

/** 日志条目统一构建：id/timestamp 一次生成，两个 handler 共用避免字段漂移 */
function buildLogEntry(extra) {
  return { id: crypto.randomUUID(), timestamp: Date.now(), ...extra };
}

function previewBody(body) {
  if (body.length <= MAX_LOG_PREVIEW_BYTES) return body;
  return `${body.slice(0, MAX_LOG_PREVIEW_BYTES)}\n…[截断 ${body.length} 字符]`;
}

/**
 * 引擎运行中：配置变更（端点/端口/服务 CRUD、改号、启停）即时同步——
 * 重建各 mock 端口，让新配置立即生效。引擎未运行（running=false）时静默跳过。
 */
export async function syncMockEngine(mockEngine, configStore) {
  if (!mockEngine?.running) return;
  await mockEngine.start(
    configStore.config.endpoints,
    configStore.config.ports,
    configStore.config.services || [],
  );
}

/**
 * Read the request body up to maxBytes. Once the cumulative size exceeds
 * maxBytes, further chunks are dropped (and `truncated` is set to true).
 * Always resolves; never rejects.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ body: string, truncated: boolean }>}
 */
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0;
    let truncated = false;
    const chunks = [];
    req.on('data', (c) => {
      const prevSize = size;
      size += c.length;
      if (size > maxBytes) {
        // Keep what we had room for; truncate this chunk at the boundary
        const allowed = maxBytes - prevSize;
        if (allowed > 0) {
          chunks.push(c.subarray(0, allowed));
        }
        truncated = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated });
    });
    req.on('error', () => resolve({ body: '', truncated: false }));
  });
}

// listen 成败 Promise 化：error/listening 一次性竞速（http/net Server 通用）
function listenOrFail(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// dgram 版本：bind + error/listening（dgram 绑定成功同样发 'listening'）
function bindOrFail(socket, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { socket.removeListener('listening', onListening); reject(err); };
    const onListening = () => { socket.removeListener('error', onError); resolve(); };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port, host);
  });
}

export class MockEngine {  /**
   * @param {object} opts
   * @param {{ push: (e: object) => void }} opts.logBuffer
   * @param {string} [opts.bindHost='127.0.0.1']
   * @param {{ config: { settings: { maxBodyBytes?: number } } }} [opts.configStore]
   */
  constructor({ logBuffer, bindHost = '127.0.0.1', configStore }) {
    this.logBuffer = logBuffer;
    this.bindHost = bindHost;
    this.configStore = configStore;
    this.servers = new Map();
    this.statuses = new Map();
    this.running = false;  // 引擎是否处于运行意图（start 置真 / stop 置假；供 API 门控即时同步）
    this._starting = null; // 串行化：进行中的 start promise
  }

  async start(endpoints, ports = null, services = []) {
    // 并发 start 串行化（快速双击、请求与 5s 轮询交错）：后者等前者结束后再执行
    if (this._starting) await this._starting.catch(() => {});
    const run = this._doStart(endpoints, ports, services);
    this._starting = run;
    try {
      return await run;
    } finally {
      if (this._starting === run) this._starting = null;
    }
  }

  async _doStart(endpoints, ports = null, services = []) {
    const byPort = new Map();
    for (const e of endpoints) {
      if (!byPort.has(e.port)) byPort.set(e.port, []);
      byPort.get(e.port).push(e);
    }

    // ports 列表模式：只绑定启用端口；空端口也绑定（404）；列表外的端点端口忽略。
    // ports 为 null 时保持旧行为（按端点分组全绑定）。
    if (Array.isArray(ports)) {
      const allowed = new Set(ports.filter((p) => p.enabled !== false).map((p) => p.port));
      for (const key of [...byPort.keys()]) {
        if (!allowed.has(key)) byPort.delete(key);
      }
      for (const p of ports) {
        if (p.enabled !== false && !byPort.has(p.port)) byPort.set(p.port, []);
      }
    }

    await this.stop();
    // statuses 重建：清除已删除/停用端口的陈旧状态，只保留本次绑定集合
    this.statuses = new Map();
    this.running = true;

    const running = [];
    const failed = [];

    for (const [port, eps] of byPort.entries()) {
      const portEntity = Array.isArray(ports) ? ports.find((p) => p.port === port) : null;
      const getMax = () => this.configStore?.config?.settings?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      const type = portEntity?.type ?? 'http';
      let record = null;
      try {
        if (type === 'tcp') {
          const { server, sockets } = createTcpCaptureServer({ port, logBuffer: this.logBuffer, getMax });
          record = { kind: 'tcp', server, sockets };
          await listenOrFail(server, port, this.bindHost);
        } else if (type === 'udp') {
          const { socket } = createUdpCaptureSocket({ port, logBuffer: this.logBuffer, getMax });
          record = { kind: 'udp', socket };
          await bindOrFail(socket, port, this.bindHost);
        } else {
          const handler = type === 'ws'
            ? createWsHandler({ port, services: services.filter((s) => s.port === port), logBuffer: this.logBuffer, getMax })
            : createHttpHandler({ port, router: buildRouter(eps), logBuffer: this.logBuffer, getMax });
          const server = http.createServer(handler);
          record = { kind: 'http', server };
          await listenOrFail(server, port, this.bindHost);
        }
        this.servers.set(port, record);
        this.statuses.set(port, { state: 'running' });
        running.push({ port });
      } catch (e) {
        this.statuses.set(port, { state: 'failed', reason: e.code || 'EADDRINUSE' });
        failed.push({ port, reason: e.code || 'EADDRINUSE' });
        try { record?.server?.close(); } catch {}
        try { record?.socket?.close(); } catch {}
      }
    }

    return { running, failed };
  }

  async stop() {
    const promises = [];
    for (const entry of this.servers.values()) {
      if (entry.kind === 'udp') {
        promises.push(new Promise((resolve) => {
          try { entry.socket.close(() => resolve()); } catch { resolve(); }
        }));
      } else if (entry.kind === 'tcp') {
        // net.Server 无 closeIdleConnections：先 close() 停止接受新连接，
        // 再 destroy 活动连接——否则 destroy→close 之间新进的连接会让 close 回调一直等（spec §4）
        promises.push(new Promise((resolve) => {
          entry.server.close(() => resolve());
          for (const s of entry.sockets) { try { s.destroy(); } catch {} }
        }));
      } else {
        promises.push(new Promise((resolve) => {
          entry.server.close(() => resolve());
          // server.close() 不关 keep-alive 空闲连接（回调不等它们）；显式关掉，
          // 否则端口被重新绑定时旧连接残留（Node 18.2+ 才有的 API，低版本跳过）
          if (typeof entry.server.closeIdleConnections === 'function') entry.server.closeIdleConnections();
        }));
      }
    }
    await Promise.all(promises);
    // 端口可能立刻被重新绑定（api.js 每次配置变更都会 stop→start 同端口）：
    // 等一轮事件循环，让同一进程内客户端 keep-alive 池收到 FIN 并移除旧连接
    // （Node ≥19 默认池化 keepAlive；旧连接残留会让池中死 socket 毒化下一次请求）
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.servers.clear();
    for (const port of this.statuses.keys()) {
      this.statuses.set(port, { state: 'stopped' });
    }
    this.running = false;
  }

  getStatus() {
    const out = {};
    for (const [port, s] of this.statuses.entries()) {
      out[port] = { ...s };
    }
    return out;
  }
}

function buildRouter(endpoints) {
  const map = new Map();
  for (const e of endpoints) {
    if (e.enabled === false) continue;
    const key = `${e.port}|${e.method}|${e.path}`;
    map.set(key, e);
  }
  return map;
}

// HTTP 端口请求处理：port|method|path 路由；resolver 失败 → warn 日志 + 原文兜底
function createHttpHandler({ port, router, logBuffer, getMax }) {
  return async (req, res) => {
    const start = Date.now();
    const url = req.url || '/';
    const [pathOnly, queryStr = ''] = url.split('?');
    const matched = router.get(`${port}|${req.method}|${pathOnly}`);

    const { body, truncated } = await readBody(req, getMax());

    if (matched) {
      // statusCode 兜底：非法值（字符串/越界）会让 res.end 抛 ERR_HTTP_INVALID_STATUS_CODE
      // 杀死整个进程（async handler 无 try/catch），这里收敛为 200
      const sc = Number(matched.statusCode);
      res.statusCode = Number.isInteger(sc) && sc >= 100 && sc <= 599 ? sc : 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      let responseBody;
      try {
        const { value } = resolve(matched.response);
        responseBody = JSON.stringify(value);
      } catch (err) {
        logBuffer?.push(buildLogEntry({
          level: 'warn',
          source: 'resolver',
          message: `resolver failed: ${err.message}`,
          endpointId: matched.id,
        }));
        responseBody = JSON.stringify(matched.response ?? null);
      }
      res.end(responseBody);
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `no mock for ${req.method} ${pathOnly}` }));
    }

    logBuffer?.push(buildLogEntry({
      method: req.method,
      path: pathOnly,
      query: queryStr,
      port,
      status: res.statusCode,
      durationMs: Date.now() - start,
      matched: !!matched,
      endpointId: matched?.id || null,
      requestHeaders: req.headers,
      requestBodyPreview: previewBody(body),
      requestBodyTruncated: truncated,
      // Prefer X-Forwarded-For if behind a proxy, else socket remote address
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress
          || '',
    }));
  };
}

// WS 端口请求处理（spec §4）：?wsdl 分发 + SOAP POST 路由；错误不抛，全部转 Fault/404
function createWsHandler({ port, services, logBuffer, getMax }) {
  const byPath = new Map();
  for (const s of services) {
    if (s.enabled !== false) byPath.set(s.path, s);
  }

  return async (req, res) => {
    const start = Date.now();
    const url = req.url || '/';
    const qi = url.indexOf('?');
    const pathOnly = qi < 0 ? url : url.slice(0, qi);
    const queryStr = qi < 0 ? '' : url.slice(qi + 1);
    const service = byPath.get(pathOnly);

    let matched = false;
    let operationName = null;

    const sendXml = (status, xml, version) => {
      // statusCode 兜底：非法值会抛 ERR_HTTP_INVALID_STATUS_CODE 杀死进程（同 HTTP handler）
      const sc = Number(status);
      res.statusCode = Number.isInteger(sc) && sc >= 100 && sc <= 599 ? sc : 200;
      res.setHeader('Content-Type', version === '1.2'
        ? 'application/soap+xml; charset=utf-8'
        : 'text/xml; charset=utf-8');
      res.end(xml);
    };
    const send404 = (hint) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `no mock for ${req.method} ${pathOnly}`, ...(hint ? { hint } : {}) }));
    };

    const { body, truncated } = await readBody(req, getMax());

    if (service && req.method === 'GET') {
      const wantsWsdl = queryStr.toLowerCase().split('&')
        .some((p) => p === 'wsdl' || p.startsWith('wsdl='));
      if (wantsWsdl) {
        matched = true;
        operationName = '?wsdl';
        const host = String(req.headers.host || `127.0.0.1:${port}`).replace(/["'<>&\s]/g, '');
        const address = `http://${host}${service.path}`;
        const xml = service.wsdl
          ? rewriteAddress(service.wsdl, address)
          : buildSkeletonWsdl(service, address);
        sendXml(200, xml, '1.1');
      } else {
        send404('SOAP endpoint, POST requests only; append ?wsdl for WSDL');
      }
    } else if (service && req.method === 'POST') {
      const version = detectSoapVersion(req.headers['content-type']);
      if (!isWellFormedXml(body)) {
        sendXml(version === '1.2' ? 400 : 500,
          buildFaultXml(version, 'client', 'request body is not well-formed XML'), version);
      } else {
        const action = extractAction(req.headers);
        const bodyName = extractBodyOperation(body);
        operationName = bodyName || action || null;
        const op = matchOperation(service, action, bodyName);
        if (!op) {
          sendXml(500, buildFaultXml(version, 'server',
            `no mock for operation ${operationName || '(unknown)'}`), version);
        } else {
          matched = true;
          operationName = op.name;
          if (op.responseType === 'fault') {
            sendXml(500, renderXmlResponse(op.responseXml, logBuffer, op.id), version);
          } else if (!op.responseXml || !op.responseXml.trim()) {
            sendXml(500, buildFaultXml(version, 'server',
              `operation ${op.name} has no response configured`), version);
          } else {
            sendXml(op.status || 200, renderXmlResponse(op.responseXml, logBuffer, op.id), version);
          }
        }
      }
    } else {
      send404();
    }

    logBuffer?.push(buildLogEntry({
      method: req.method,
      path: pathOnly,
      query: queryStr,
      port,
      status: res.statusCode,
      durationMs: Date.now() - start,
      matched,
      serviceId: service?.id || null,
      operationName,
      requestHeaders: req.headers,
      requestBodyPreview: previewBody(body),
      requestBodyTruncated: truncated,
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress
          || '',
    }));
  };
}

// 字符串走 resolve 的混合模式替换；失败保留原文 + warn 日志（对齐 HTTP JSON 路径）
function renderXmlResponse(text, logBuffer, operationId) {
  const { value, errors } = resolve(text ?? '');
  for (const e of errors) {
    logBuffer?.push(buildLogEntry({
      level: 'warn',
      source: 'resolver',
      message: `resolver failed: ${e.message}`,
      operationId,
    }));
  }
  return typeof value === 'string' ? value : String(value);
}
