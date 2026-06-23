import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { AppError, toErrorResponse, statusFor } from './errors.js';
import { sseMiddleware, broadcast } from './sse.js';
import { isValidStoragePath } from './paths.js';
import { registerPreviewRoutes } from './api-preview.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function validateEndpointBody(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') throw new AppError(400, 'INVALID_BODY', 'body required');
  if (!partial || body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AppError(400, 'INVALID_PORT', 'port must be 1..65535');
    }
  }
  if (!partial || body.method !== undefined) {
    if (!METHODS.has(body.method)) {
      throw new AppError(400, 'INVALID_METHOD', `method must be one of ${[...METHODS].join(',')}`);
    }
  }
  if (!partial || body.path !== undefined) {
    if (typeof body.path !== 'string' || !body.path.startsWith('/')) {
      throw new AppError(400, 'INVALID_PATH', 'path must start with /');
    }
  }
  if (body.response !== undefined && body.response !== null) {
    try { JSON.parse(JSON.stringify(body.response)); }
    catch { throw new AppError(400, 'INVALID_JSON', 'response must be JSON-serializable'); }
  }
}

export function createApi({ configStore, logBuffer, mockEngine }) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const sse = sseMiddleware();
  if (logBuffer && typeof logBuffer.subscribe === 'function') {
    logBuffer.subscribe((entry) => broadcast(sse.clients, 'log', entry));
  }

  // Health
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // SSE
  app.get('/events', (req, res) => sse.handler(req, res));

  // Config
  app.get('/api/config', (_req, res) => res.json(configStore.config));

  app.patch('/api/config', async (req, res, next) => {
    try {
      const { settings = {} } = req.body || {};
      if (settings.storagePath !== undefined) {
        if (!isValidStoragePath(settings.storagePath)) {
          throw new AppError(400, 'INVALID_PATH', 'storagePath must be an absolute path');
        }
        const oldFile = `${configStore.storagePath}/data.json`;
        const newDir = settings.storagePath;
        await fs.mkdir(newDir, { recursive: true });
        try { await fs.copyFile(oldFile, `${newDir}/data.json`); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        try { await fs.unlink(oldFile); } catch {}
        configStore.storagePath = newDir;
      }
      await configStore.update((cfg) => {
        if (settings.uiPort !== undefined) cfg.settings.uiPort = settings.uiPort;
        if (settings.storagePath !== undefined) cfg.settings.storagePath = settings.storagePath;
        return cfg;
      });
      res.json(configStore.config);
    } catch (e) { next(e); }
  });

  // Endpoints CRUD
  app.get('/api/endpoints', (_req, res) => res.json(configStore.config.endpoints));

  app.post('/api/endpoints', async (req, res, next) => {
    try {
      validateEndpointBody(req.body);
      const id = crypto.randomUUID();
      const ep = { id, ...req.body, enabled: req.body.enabled !== false };
      const all = [...configStore.config.endpoints, ep];
      configStore.checkUniqueness(all);
      await configStore.update((cfg) => { cfg.endpoints = all; return cfg; });
      res.status(201).json(ep);
    } catch (e) { next(e); }
  });

  app.put('/api/endpoints/:id', async (req, res, next) => {
    try {
      const list = configStore.config.endpoints;
      const idx = list.findIndex((e) => e.id === req.params.id);
      if (idx < 0) throw new AppError(404, 'NOT_FOUND', 'endpoint not found');
      validateEndpointBody(req.body);
      const updated = { ...list[idx], ...req.body, id: list[idx].id };
      const all = [...list];
      all[idx] = updated;
      configStore.checkUniqueness(all, req.params.id);
      await configStore.update((cfg) => { cfg.endpoints = all; return cfg; });
      res.json(updated);
    } catch (e) { next(e); }
  });

  app.delete('/api/endpoints/:id', async (req, res, next) => {
    try {
      const list = configStore.config.endpoints;
      const next = list.filter((e) => e.id !== req.params.id);
      if (next.length === list.length) throw new AppError(404, 'NOT_FOUND', 'endpoint not found');
      await configStore.update((cfg) => { cfg.endpoints = next; return cfg; });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // Runtime
  app.post('/api/runtime/start', async (req, res, next) => {
    try {
      const result = await mockEngine.start(configStore.config.endpoints);
      res.json(result);
    } catch (e) { next(e); }
  });

  app.post('/api/runtime/stop', async (req, res, next) => {
    try {
      const ports = [...(mockEngine.servers?.keys?.() || [])];
      await mockEngine.stop();
      res.json({ stopped: ports });
    } catch (e) { next(e); }
  });

  app.get('/api/runtime/status', (_req, res) => res.json(mockEngine.getStatus()));

  // Logs
  app.get('/api/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, logBuffer.maxSize);
    res.json(logBuffer.getRecent(limit));
  });

  app.delete('/api/logs', (_req, res) => {
    logBuffer.clear();
    res.status(204).end();
  });

  // Preview & generators (dynamic response values) —挂 createApi 末尾、错误中间件之前
  registerPreviewRoutes(app);

  // Error handler (must be last in createApi so API errors are formatted)
  app.use((err, _req, res, _next) => {
    res.status(statusFor(err)).json(toErrorResponse(err));
  });

  return app;
}
