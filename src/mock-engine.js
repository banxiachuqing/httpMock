import http from 'node:http';
import crypto from 'node:crypto';
import { resolve } from './expression-resolver.js';

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

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

export class MockEngine {
  /**
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
  }

  async start(endpoints) {
    const byPort = new Map();
    for (const e of endpoints) {
      if (!byPort.has(e.port)) byPort.set(e.port, []);
      byPort.get(e.port).push(e);
    }

    await this.stop();

    const running = [];
    const failed = [];

    for (const [port, eps] of byPort.entries()) {
      const router = buildRouter(eps);
      const server = http.createServer(async (req, res) => {
        const start = Date.now();
        const url = req.url || '/';
        const [pathOnly, queryStr = ''] = url.split('?');
        const matched = router.get(`${port}|${req.method}|${pathOnly}`);

        const max = this.configStore?.config?.settings?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        const { body, truncated } = await readBody(req, max);

        if (matched) {
          res.statusCode = matched.statusCode || 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          let responseBody;
          try {
            const { value } = resolve(matched.response);
            responseBody = JSON.stringify(value);
          } catch (err) {
            this.logBuffer?.push({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              level: 'warn',
              source: 'resolver',
              message: `resolver failed: ${err.message}`,
              endpointId: matched.id,
            });
            responseBody = JSON.stringify(matched.response ?? null);
          }
          res.end(responseBody);
        } else {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: `no mock for ${req.method} ${pathOnly}` }));
        }

        this.logBuffer?.push({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          method: req.method,
          path: pathOnly,
          query: queryStr,
          port,
          status: res.statusCode,
          durationMs: Date.now() - start,
          matched: !!matched,
          endpointId: matched?.id || null,
          requestHeaders: req.headers,
          requestBodyPreview: body,
          requestBodyTruncated: truncated,
          // Prefer X-Forwarded-For if behind a proxy, else socket remote address
          ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
              || req.socket.remoteAddress
              || '',
        });
      });

      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
          const onListening = () => { server.removeListener('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, this.bindHost);
        });
        this.servers.set(port, { server, router });
        this.statuses.set(port, { state: 'running' });
        running.push({ port });
      } catch (e) {
        this.statuses.set(port, { state: 'failed', reason: e.code || 'EADDRINUSE' });
        failed.push({ port, reason: e.code || 'EADDRINUSE' });
        try { server.close(); } catch {}
      }
    }

    return { running, failed };
  }

  async stop() {
    const promises = [];
    for (const { server } of this.servers.values()) {
      promises.push(new Promise((resolve) => server.close(() => resolve())));
    }
    await Promise.all(promises);
    this.servers.clear();
    for (const port of this.statuses.keys()) {
      this.statuses.set(port, { state: 'stopped' });
    }
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
