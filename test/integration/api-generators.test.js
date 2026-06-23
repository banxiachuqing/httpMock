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

describe('GET /api/generators', () => {
  it('returns categories with generators and samples', async () => {
    const res = await ctx.request.get('/api/generators');
    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('zh_CN');
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories.length).toBe(9);
    const stringCat = res.body.categories.find((c) => c.id === 'string');
    expect(stringCat).toBeTruthy();
    const uuidGen = stringCat.generators.find((g) => g.id === 'uuid');
    expect(uuidGen).toBeTruthy();
    expect(uuidGen.args).toEqual([]);
    expect(typeof uuidGen.sample).toBe('string');
  });

  it('int generator sample is a number', async () => {
    const res = await ctx.request.get('/api/generators');
    const numberCat = res.body.categories.find((c) => c.id === 'number');
    const intGen = numberCat.generators.find((g) => g.id === 'int');
    expect(typeof intGen.sample).toBe('number');
  });
});

describe('POST /api/generators/sample', () => {
  it('returns sample for known id', async () => {
    const res = await ctx.request
      .post('/api/generators/sample')
      .send({ id: 'int', args: { min: 10, max: 10 } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sample).toBe(10);
  });

  it('returns 400 for unknown id', async () => {
    const res = await ctx.request
      .post('/api/generators/sample')
      .send({ id: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 for bad args', async () => {
    const res = await ctx.request
      .post('/api/generators/sample')
      .send({ id: 'int', args: { min: 'bad' } });
    expect(res.status).toBe(400);
  });
});
