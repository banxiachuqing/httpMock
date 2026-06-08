import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const DIR_NAME = 'MockServer';

export function defaultStoragePath() {
  const home = os.homedir();
  const documents = path.join(home, 'Documents');
  if (fs.existsSync(documents) && fs.statSync(documents).isDirectory()) {
    return path.join(documents, DIR_NAME);
  }
  return path.join(home, DIR_NAME);
}

export function isValidStoragePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  return path.isAbsolute(p);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
