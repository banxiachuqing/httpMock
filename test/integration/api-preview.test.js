import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tempDir } from '../helpers/temp-dir.js';
import { ConfigStore } from '../../src/config-store.js';
import { LogBuffer } from '../../src/log-buffer.js';
import { MockEngine } from '../../src/mock-engine.js';
import { buildApp } from '../helpers/test-server.js';

let td, store, logs, engine, ctx;

beforeEach(async () => {
  td = tempDir();
  store = new ConfigStore({ storagePath: td.path });
  await store.load();
  logs = new LogBuffer(10);
  engine = new MockEngine({ logBuffer: logs, bindHost: '127.0.0.1' });
  ctx = buildApp({ storagePath: td.path, configStore: store, logBuffer: logs, mockEngine: engine });
});

afterEach(async () => {
  await engine.stop();
  td.cleanup();
});

describe('POST /api/preview', () => {
  it('returns resolved JSON with ok=true', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: '{ "id": "{{$uuid}}", "n": "{{$int:42:42}}" }' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.resolved.id).toBe('string');
    expect(res.body.resolved.n).toBe(42);
    expect(res.body.exprCount).toBe(2);
    expect(res.body.errors).toEqual([]);
  });

  it('returns ok=true with errors on unknown generator (soft fail)', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: '{ "x": "{{$nonexistent}}" }' });
    expect(res.body.ok).toBe(true);
    expect(res.body.resolved.x).toBeNull();
    expect(res.body.errors.length).toBe(1);
    expect(res.body.errors[0].code).toBe('UNKNOWN_GENERATOR');
  });

  it('returns ok=false on JSON syntax error', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: '{ broken' });
    expect(res.body.ok).toBe(false);
    expect(res.body.stage).toBe('json-parse');
    expect(res.body.error).toBeTruthy();
  });

  it('passes through plain JSON unchanged', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: '{ "a": 1, "b": [1,2,3] }' });
    expect(res.body.ok).toBe(true);
    expect(res.body.resolved).toEqual({ a: 1, b: [1, 2, 3] });
    expect(res.body.exprCount).toBe(0);
  });

  it('rejects non-string text body', async () => {
    const res = await ctx.request
      .post('/api/preview')
      .send({ text: 12345 });
    expect(res.status).toBe(400);
  });
});
