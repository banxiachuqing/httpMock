import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../helpers/test-server.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir, ctx;

beforeEach(() => {
  dir = tempDir('mock-api-');
  ctx = buildApp({
    storagePath: dir.path,
    logBuffer: { push: () => {}, subscribe: () => () => {} },
    mockEngine: { start: async () => ({ running: [], failed: [] }), stop: async () => {}, getStatus: () => ({}), servers: new Map() },
  });
});

afterEach(() => dir.cleanup());

describe('API', () => {
  it('returns 404 JSON envelope for unknown routes', async () => {
    const r = await ctx.request.get('/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not found', code: 'NOT_FOUND' });
  });

  it('returns health', async () => {
    const r = await ctx.request.get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});
