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
  it('returns health', async () => {
    const r = await ctx.request.get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});
