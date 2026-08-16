import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

const FILE_NAME = 'data.json';
const MAX_BACKUPS = 5;

export class ConfigStore {
  constructor({ storagePath }) {
    this.storagePath = storagePath;
    this.config = null;
  }

  _file() {
    return path.join(this.storagePath, FILE_NAME);
  }

  async load() {
    const file = this._file();
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.version !== 'number') throw new Error('missing version');
      this.config = this._migrate(parsed);
      if (this.config !== parsed) await this._writeAtomic();
    } catch (e) {
      if (e.code !== 'ENOENT') {
        const backup = `${file}.broken-${Date.now()}`;
        try { await fs.rename(file, backup); } catch {}
        // Keep only the most recent MAX_BACKUPS broken files
        try {
          const dir = path.dirname(file);
          const all = fsSync.readdirSync(dir)
            .filter((f) => f.startsWith(`${FILE_NAME}.broken-`))
            .sort(); // ISO-ish ts prefix → lexicographic == chronological
          const excess = all.length - MAX_BACKUPS;
          for (let i = 0; i < excess; i++) {
            try { await fs.unlink(path.join(dir, all[i])); } catch {}
          }
        } catch {}
      }
      this.config = {
        version: 3,
        settings: { storagePath: this.storagePath, uiPort: 5050, maxBodyBytes: 4 * 1024 * 1024, theme: 'system' },
        ports: [],
        endpoints: [],
        services: [],
      };
      await this._writeAtomic();
    }
    return this.config;
  }

  async update(mutator) {
    if (!this.config) throw new Error('config not loaded');
    const next = mutator(structuredClone(this.config));
    this.config = next;
    await this._writeAtomic();
    return this.config;
  }

  async _writeAtomic() {
    const file = this._file();
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.config, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  _migrate(cfg) {
    let out = cfg;
    // v1 → v2：从端点派生 ports
    if (!Array.isArray(out.ports)) {
      const ports = [...new Set((out.endpoints || []).map((e) => e.port))]
        .sort((a, b) => a - b)
        .map((port) => ({ port, enabled: true }));
      out = { ...out, ports, version: 2 };
    }
    // v2 → v3：ports 补 type，补 services
    if (typeof out.version !== 'number' || out.version < 3) {
      out = {
        ...out,
        version: 3,
        ports: out.ports.map((p) => ({ type: 'http', ...p })),
        services: Array.isArray(out.services) ? out.services : [],
      };
    }
    return out;
  }

  checkUniqueness(endpoints, excludeId = null) {
    const seen = new Map();
    for (const e of endpoints) {
      if (e.enabled === false) continue;
      if (excludeId && e.id === excludeId) continue;
      const key = `${e.port}|${e.method}|${e.path}`;
      if (seen.has(key)) {
        throw new AppError(400, 'DUPLICATE_ENDPOINT', `duplicate ${e.method} ${e.path} on port ${e.port}`);
      }
      seen.set(key, e.id);
    }
  }

  // WS 服务唯一性：(port, path) 在 enabled 服务间唯一（spec §3）
  checkServiceUniqueness(services, excludeId = null) {
    const seen = new Map();
    for (const s of services) {
      if (s.enabled === false) continue;
      if (excludeId && s.id === excludeId) continue;
      const key = `${s.port}|${s.path}`;
      if (seen.has(key)) {
        throw new AppError(400, 'DUPLICATE_SERVICE', `duplicate service ${s.path} on port ${s.port}`);
      }
      seen.set(key, s.id);
    }
  }
}
