import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../../src/config-store.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir;

beforeEach(() => { dir = tempDir('mock-migrate-'); });
afterEach(() => dir.cleanup());

function writeV1() {
  const v1 = {
    version: 1,
    settings: { storagePath: dir.path, uiPort: 5050, maxBodyBytes: 4194304 },
    endpoints: [
      { id: 'a', method: 'GET', port: 9090, path: '/b', statusCode: 200, response: {}, enabled: true },
      { id: 'b', method: 'GET', port: 8080, path: '/a', statusCode: 200, response: {}, enabled: true },
      { id: 'c', method: 'POST', port: 8080, path: '/c', statusCode: 201, response: {}, enabled: true },
    ],
  };
  fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(v1));
}

describe('ConfigStore v1 → v2 迁移', () => {
  it('从端点派生去重升序的 ports，全部启用', async () => {
    writeV1();
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(2);
    expect(store.config.ports).toEqual([
      { port: 8080, enabled: true },
      { port: 9090, enabled: true },
    ]);
  });

  it('迁移结果落盘', async () => {
    writeV1();
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir.path, 'data.json'), 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.ports).toHaveLength(2);
  });

  it('已有 ports 的 v2 数据不动', async () => {
    const v2 = {
      version: 2,
      settings: { storagePath: dir.path, uiPort: 5050, maxBodyBytes: 4194304 },
      ports: [{ port: 9999, enabled: false }],
      endpoints: [],
    };
    fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(v2));
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.ports).toEqual([{ port: 9999, enabled: false }]);
  });

  it('全新存储直接是 version 2 + 空 ports', async () => {
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(2);
    expect(store.config.ports).toEqual([]);
  });
});
