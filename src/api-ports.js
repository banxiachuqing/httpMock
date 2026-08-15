// /api/ports CRUD —— 端口一等实体
import { AppError } from './errors.js';

function parsePortNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(400, 'INVALID_PORT', 'port must be 1..65535');
  }
  return port;
}

function sorted(ports) {
  return [...ports].sort((a, b) => a.port - b.port);
}

/**
 * @param {import('express').Express} app
 * @param {{ configStore: import('./config-store.js').ConfigStore }} deps
 */
export function registerPortRoutes(app, { configStore }) {
  app.get('/api/ports', (_req, res) => res.json(configStore.config.ports));

  app.post('/api/ports', async (req, res, next) => {
    try {
      const port = parsePortNumber(req.body?.port);
      const type = req.body?.type ?? 'http';
      if (!['http', 'ws'].includes(type)) {
        throw new AppError(400, 'INVALID_VALUE', "type must be 'http' | 'ws'");
      }
      if (configStore.config.ports.some((p) => p.port === port)) {
        throw new AppError(400, 'DUPLICATE_PORT', `port ${port} already exists`);
      }
      const entity = { port, enabled: true, type };
      await configStore.update((cfg) => {
        cfg.ports = sorted([...cfg.ports, entity]);
        return cfg;
      });
      res.status(201).json(entity);
    } catch (e) { next(e); }
  });

  app.put('/api/ports/:port', async (req, res, next) => {
    try {
      const oldPort = Number(req.params.port);
      const current = configStore.config.ports.find((p) => p.port === oldPort);
      if (!current) throw new AppError(404, 'NOT_FOUND', 'port not found');

      const { port: newPortRaw, enabled, type } = req.body || {};
      if (type !== undefined) {
        throw new AppError(400, 'FIELD_IMMUTABLE', 'port type cannot be changed');
      }
      let newPort = oldPort;
      if (newPortRaw !== undefined) {
        newPort = parsePortNumber(newPortRaw);
        if (newPort !== oldPort && configStore.config.ports.some((p) => p.port === newPort)) {
          throw new AppError(400, 'DUPLICATE_PORT', `port ${newPort} already exists`);
        }
      }
      const newEnabled = enabled === undefined ? current.enabled : enabled !== false;

      let updated;
      await configStore.update((cfg) => {
        cfg.ports = sorted(cfg.ports.map((p) =>
          p.port === oldPort ? { port: newPort, enabled: newEnabled } : p));
        if (newPort !== oldPort) {
          cfg.endpoints = cfg.endpoints.map((e) =>
            e.port === oldPort ? { ...e, port: newPort } : e);
          cfg.services = (cfg.services || []).map((s) =>
            s.port === oldPort ? { ...s, port: newPort } : s);
        }
        updated = cfg.ports.find((p) => p.port === newPort);
        return cfg;
      });
      res.json(updated);
    } catch (e) { next(e); }
  });

  app.delete('/api/ports/:port', async (req, res, next) => {
    try {
      const port = Number(req.params.port);
      if (!configStore.config.ports.some((p) => p.port === port)) {
        throw new AppError(404, 'NOT_FOUND', 'port not found');
      }
      await configStore.update((cfg) => {
        cfg.ports = cfg.ports.filter((p) => p.port !== port);
        cfg.endpoints = cfg.endpoints.filter((e) => e.port !== port);
        cfg.services = (cfg.services || []).filter((s) => s.port !== port);
        return cfg;
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });
}
