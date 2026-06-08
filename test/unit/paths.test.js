import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { defaultStoragePath, isValidStoragePath, ensureDir } from '../../src/paths.js';

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-paths-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('defaultStoragePath', () => {
  it('uses ~/Documents/MockServer when Documents exists', () => {
    const docs = path.join(tmpRoot, 'Documents');
    fs.mkdirSync(docs);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    expect(defaultStoragePath()).toBe(path.join(docs, 'MockServer'));
  });

  it('falls back to ~/MockServer when Documents does not exist', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    expect(defaultStoragePath()).toBe(path.join(tmpRoot, 'MockServer'));
  });
});

describe('isValidStoragePath', () => {
  it('rejects relative paths', () => {
    expect(isValidStoragePath('relative/path')).toBe(false);
    expect(isValidStoragePath('./here')).toBe(false);
  });
  it('accepts absolute paths', () => {
    expect(isValidStoragePath('/abs/path')).toBe(true);
    expect(isValidStoragePath('/Users/x/Documents/MockServer')).toBe(true);
  });
  it('rejects empty and non-string', () => {
    expect(isValidStoragePath('')).toBe(false);
    expect(isValidStoragePath(null)).toBe(false);
  });
});

describe('ensureDir', () => {
  it('creates the directory if missing', () => {
    const target = path.join(tmpRoot, 'a', 'b', 'c');
    ensureDir(target);
    expect(fs.existsSync(target)).toBe(true);
  });
  it('does nothing if directory exists', () => {
    fs.mkdirSync(path.join(tmpRoot, 'x'), { recursive: true });
    expect(() => ensureDir(path.join(tmpRoot, 'x'))).not.toThrow();
  });
});
