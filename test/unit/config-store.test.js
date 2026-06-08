import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../../src/config-store.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir;
let store;

beforeEach(() => {
  dir = tempDir('mock-cfg-');
  store = new ConfigStore({ storagePath: dir.path });
});

afterEach(() => dir.cleanup());

describe('ConfigStore.load', () => {
  it('initializes a fresh config when file is missing', async () => {
    const cfg = await store.load();
    expect(cfg.version).toBe(1);
    expect(cfg.settings).toEqual({ storagePath: dir.path, uiPort: 5050 });
    expect(cfg.endpoints).toEqual([]);
  });

  it('loads an existing valid config', async () => {
    const data = {
      version: 1,
      settings: { storagePath: dir.path, uiPort: 5055 },
      endpoints: [
        { id: 'x', port: 8080, method: 'GET', path: '/a', statusCode: 200, response: { ok: true }, enabled: true },
      ],
    };
    fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(data));
    const cfg = await store.load();
    expect(cfg.endpoints[0].path).toBe('/a');
  });

  it('backs up corrupt file and returns fresh config', async () => {
    fs.writeFileSync(path.join(dir.path, 'data.json'), 'not json');
    const cfg = await store.load();
    expect(cfg.version).toBe(1);
    const files = fs.readdirSync(dir.path);
    expect(files.some((f) => f.startsWith('data.json.broken-'))).toBe(true);
  });
});

describe('ConfigStore.save + atomic write', () => {
  it('persists config to data.json', async () => {
    await store.load();
    await store.update((cfg) => {
      cfg.endpoints.push({ id: '1', port: 8080, method: 'GET', path: '/x', statusCode: 200, response: { a: 1 }, enabled: true });
      return cfg;
    });
    const raw = JSON.parse(fs.readFileSync(path.join(dir.path, 'data.json'), 'utf8'));
    expect(raw.endpoints).toHaveLength(1);
  });

  it('replaces via tmp + rename (no leftover tmp file)', async () => {
    await store.load();
    await store.update((cfg) => { cfg.settings.uiPort = 6060; return cfg; });
    expect(fs.existsSync(path.join(dir.path, 'data.json.tmp'))).toBe(false);
  });
});

describe('ConfigStore uniqueness', () => {
  it('treats (port, method, path) as the unique key among enabled endpoints', () => {
    expect(() =>
      store.checkUniqueness([
        { id: 'a', port: 8080, method: 'GET', path: '/x', enabled: true },
        { id: 'b', port: 8080, method: 'GET', path: '/x', enabled: true },
      ])
    ).toThrow(/duplicate/i);
  });

  it('ignores disabled endpoints for uniqueness', () => {
    expect(() =>
      store.checkUniqueness([
        { id: 'a', port: 8080, method: 'GET', path: '/x', enabled: true },
        { id: 'b', port: 8080, method: 'GET', path: '/x', enabled: false },
      ])
    ).not.toThrow();
  });

  it('ignores entries when checking a single id against the rest', () => {
    expect(() =>
      store.checkUniqueness(
        [
          { id: 'a', port: 8080, method: 'GET', path: '/x', enabled: true },
        ],
        'a',
      )
    ).not.toThrow();
  });
});
