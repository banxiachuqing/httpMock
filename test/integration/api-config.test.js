import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir, store, ctx;

beforeEach(async () => {
  dir = tempDir('mock-cfg-api-');
  store = new ConfigStore({ storagePath: dir.path });
  await store.load();
  ctx = buildApp({
    storagePath: dir.path,
    configStore: store,
    logBuffer: { push: () => {}, subscribe: () => () => {} },
    mockEngine: { start: async () => ({ running: [], failed: [] }), stop: async () => {}, getStatus: () => ({}), servers: new Map() },
  });
});

afterEach(() => dir.cleanup());

describe('GET /api/config', () => {
  it('returns the current config', async () => {
    const r = await ctx.request.get('/api/config');
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(1);
    expect(r.body.settings.uiPort).toBe(5050);
  });
});

describe('PATCH /api/config', () => {
  it('updates uiPort in memory', async () => {
    const r = await ctx.request.patch('/api/config').send({ settings: { uiPort: 6060 } });
    expect(r.status).toBe(200);
    expect(r.body.settings.uiPort).toBe(6060);
  });

  it('rejects invalid storagePath', async () => {
    const r = await ctx.request.patch('/api/config').send({ settings: { storagePath: 'relative' } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_PATH');
  });
});
