import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../../src/config-store.js';
import { tempDir } from '../helpers/temp-dir.js';

let dir, store;

beforeEach(() => {
  dir = tempDir('mock-cfg-bk-');
  store = new ConfigStore({ storagePath: dir.path });
});

afterEach(() => dir.cleanup());

describe('ConfigStore corrupt-file backup rotation', () => {
  it('keeps at most 5 broken backups and removes the oldest', async () => {
    const dataFile = path.join(dir.path, 'data.json');
    // Pre-create 6 backup files with lexicographically increasing timestamps
    for (let i = 0; i < 6; i++) {
      const name = `data.json.broken-${String(1700000000000 + i * 1000).padStart(13, '0')}`;
      fs.writeFileSync(path.join(dir.path, name), `corrupt ${i}`);
    }
    // Add a current corrupt data.json
    fs.writeFileSync(dataFile, 'definitely not json {{{');

    // Loading triggers a 7th backup and should clean up to MAX_BACKUPS=5
    await store.load();

    const remaining = fs.readdirSync(dir.path)
      .filter((f) => f.startsWith('data.json.broken-'))
      .sort();
    expect(remaining.length).toBe(5);
    // The oldest 2 pre-existing backups should be gone; the 4 newest preserved
    expect(remaining[0]).toMatch(/broken-1700000002000/);
    expect(remaining[3]).toMatch(/broken-1700000005000/);
    // The 5th is the one we just created from the current corrupt data.json
    expect(remaining[4]).toMatch(/broken-/);
  });

  it('does nothing when fewer backups exist than the cap', async () => {
    const dataFile = path.join(dir.path, 'data.json');
    fs.writeFileSync(dataFile, 'garbage');
    for (let i = 0; i < 3; i++) {
      const name = `data.json.broken-${String(1700000000000 + i * 1000).padStart(13, '0')}`;
      fs.writeFileSync(path.join(dir.path, name), `corrupt ${i}`);
    }
    await store.load();
    const remaining = fs.readdirSync(dir.path)
      .filter((f) => f.startsWith('data.json.broken-'));
    expect(remaining.length).toBe(4); // 3 pre-existing + 1 new
  });
});
