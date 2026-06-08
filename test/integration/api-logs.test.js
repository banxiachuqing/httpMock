import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';
import { MockEngine } from '../../src/mock-engine.js';
import { LogBuffer } from '../../src/log-buffer.js';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';
import http from 'node:http';

let dir, store, engine, logBuffer, ctx;

beforeEach(async () => {
  dir = tempDir('mock-logs-');
  store = new ConfigStore({ storagePath: dir.path });
  await store.load();
  logBuffer = new LogBuffer(50);
  engine = new MockEngine({ logBuffer });
  ctx = buildApp({ storagePath: dir.path, configStore: store, logBuffer, mockEngine: engine });
});

afterEach(async () => {
  await engine.stop();
  dir.cleanup();
});

describe('GET /api/logs', () => {
  it('returns empty when no logs', async () => {
    const r = await ctx.request.get('/api/logs');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('returns buffered entries newest last', async () => {
    logBuffer.push({ id: 'a', timestamp: 1, method: 'GET', path: '/x', port: 8080, status: 200, durationMs: 1, matched: true, endpointId: null, requestHeaders: {}, requestBodyPreview: '' });
    logBuffer.push({ id: 'b', timestamp: 2, method: 'GET', path: '/y', port: 8080, status: 404, durationMs: 1, matched: false, endpointId: null, requestHeaders: {}, requestBodyPreview: '' });
    const r = await ctx.request.get('/api/logs');
    expect(r.body.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('GET /events (SSE)', () => {
  it('emits a log event when the buffer receives a new entry', async () => {
    const server = ctx.app.listen(0);
    const port = server.address().port;
    try {
      const events = [];
      let buf = '';
      let done = false;
      await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET' }, (res) => {
          res.setEncoding('utf8');
          res.on('data', (c) => {
            if (done) return;
            buf += c;
            // Look for a complete log event
            let idx;
            while ((idx = buf.indexOf('event: log')) !== -1) {
              const end = buf.indexOf('\n\n', idx);
              if (end === -1) break;
              events.push(buf.slice(idx, end + 2));
              buf = buf.slice(end + 2);
              done = true;
              req.destroy();
              resolve();
              break;
            }
          });
        });
        req.end();
        setTimeout(() => {
          logBuffer.push({ id: 'live-1', timestamp: Date.now(), method: 'GET', path: '/live', port: 8080, status: 200, durationMs: 1, matched: true, endpointId: null, requestHeaders: {}, requestBodyPreview: '' });
        }, 100);
      });
      const last = events.find((e) => e.includes('event: log')) || '';
      expect(last).toContain('live-1');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
