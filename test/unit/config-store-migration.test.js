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

describe('ConfigStore v1 → v3 迁移', () => {
  it('从端点派生 ports 并补 type/services，直达 v3', async () => {
    writeV1();
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(3);
    expect(store.config.ports).toEqual([
      { port: 8080, enabled: true, type: 'http' },
      { port: 9090, enabled: true, type: 'http' },
    ]);
    expect(store.config.services).toEqual([]);
  });

  it('迁移结果落盘', async () => {
    writeV1();
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir.path, 'data.json'), 'utf8'));
    expect(onDisk.version).toBe(3);
    expect(onDisk.ports).toHaveLength(2);
    expect(onDisk.services).toEqual([]);
  });

  it('v2 数据补 type 与 services', async () => {
    const v2 = {
      version: 2,
      settings: { storagePath: dir.path, uiPort: 5050, maxBodyBytes: 4194304 },
      ports: [{ port: 9999, enabled: false }],
      endpoints: [],
    };
    fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(v2));
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(3);
    expect(store.config.ports).toEqual([{ port: 9999, enabled: false, type: 'http' }]);
    expect(store.config.services).toEqual([]);
  });

  it('v3 数据不动', async () => {
    const v3 = {
      version: 3,
      settings: { storagePath: dir.path, uiPort: 5050, maxBodyBytes: 4194304 },
      ports: [{ port: 9999, enabled: false, type: 'ws' }],
      endpoints: [],
      services: [{ id: 's1', port: 9999, path: '/ws/A', name: 'A', enabled: true, targetNamespace: 'urn:A', wsdl: null, operations: [] }],
    };
    fs.writeFileSync(path.join(dir.path, 'data.json'), JSON.stringify(v3));
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.ports).toEqual([{ port: 9999, enabled: false, type: 'ws' }]);
    expect(store.config.services).toHaveLength(1);
  });

  it('全新存储直接是 version 3 + 空 ports/services', async () => {
    const store = new ConfigStore({ storagePath: dir.path });
    await store.load();
    expect(store.config.version).toBe(3);
    expect(store.config.ports).toEqual([]);
    expect(store.config.services).toEqual([]);
  });
});