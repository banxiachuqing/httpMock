import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { AppError, toErrorResponse, statusFor } from './errors.js';
import { sseMiddleware, broadcast } from './sse.js';
import { syncMockEngine } from './mock-engine.js';
import { isValidStoragePath } from './paths.js';
import { validatePattern } from './path-pattern.js';
import { nextPortName } from './port-name.js';
import { registerPreviewRoutes } from './api-preview.js';
import { registerPortRoutes } from './api-ports.js';
import { registerServiceRoutes, toPublicService } from './api-services.js';
import { registerMcpHttpRoutes } from './mcp-http.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const MAX_NAME_LENGTH = 50;

function validateName(body) {
  if (body.name === undefined) return;
  if (typeof body.name !== 'string') {
    throw new AppError(400, 'INVALID_NAME', 'name must be a string');
  }
  if (body.name.trim().length > MAX_NAME_LENGTH) {
    throw new AppError(400, 'INVALID_NAME', `name must be at most ${MAX_NAME_LENGTH} chars`);
  }
}

function withNormalizedName(ep) {
  if (typeof ep.name === 'string') {
    const trimmed = ep.name.trim();
    if (trimmed) ep.name = trimmed;
    else delete ep.name;
  }
  return ep;
}

/** PATCH /api/config 的 settings 字段落库（迁移/普通保存共用，避免漂移） */
function applyConfigSettings(cfg, settings) {
  if (settings.uiPort !== undefined) cfg.settings.uiPort = settings.uiPort;
  if (settings.storagePath !== undefined) cfg.settings.storagePath = settings.storagePath;
  if (settings.maxBodyBytes !== undefined) cfg.settings.maxBodyBytes = settings.maxBodyBytes;
  if (settings.theme !== undefined) cfg.settings.theme = settings.theme;
  if (settings.mcpEnabled !== undefined) cfg.settings.mcpEnabled = settings.mcpEnabled === true;
  return cfg;
}

// GET/PATCH /api/config 响应层：services[].wsdl 原文不随全量配置往返（spec §5）
function publicConfig(cfg) {
  return { ...cfg, services: (cfg.services || []).map(toPublicService) };
}

// 端点引用的端口不在 ports 列表时自动补建（避免运行时静默跳过）；补建的端口按类型生成默认名
function ensurePortEntity(cfg, port) {
  if (!cfg.ports.some((p) => p.port === port)) {
    cfg.ports = [...cfg.ports, { port, enabled: true, type: 'http', name: nextPortName(cfg.ports, 'http') }].sort((a, b) => a.port - b.port);
  }
}

// 非 http 型端口拒绝挂 HTTP 端点（spec §3 端口类型约束；ws/tcp/udp 一律拒）
function assertHttpPort(cfg, port) {
  const p = cfg.ports.find((x) => x.port === port);
  if (p && p.type !== 'http') {
    throw new AppError(400, 'PORT_TYPE_MISMATCH', `port ${port} is a ${p.type} port`);
  }
}

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
    // '?' 会破坏 mock 路由的 query 拆分（pathOnly 永远匹配不到），'#' 不会到达服务端——都在入库前拒绝
    if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.includes('?') || body.path.includes('#')) {
      throw new AppError(400, 'INVALID_PATH', 'path must start with / and contain no ? or #');
    }
    // 通配 pattern：* / ** 必须独占一段（spec 2026-08-27 §2；段内部分通配不做隐式语义）
    if (body.path.includes('*')) {
      const reason = validatePattern(body.path);
      if (reason) throw new AppError(400, 'INVALID_PATH', reason);
    }
  }
  // statusCode 可选（省略默认 200）：只在显式提供时校验。
    // 非法 statusCode 会让 mock-engine 的 res.end 抛 ERR_HTTP_INVALID_STATUS_CODE 杀死进程
    if (body.statusCode !== undefined) {
      const sc = Number(body.statusCode);
      if (!Number.isInteger(sc) || sc < 100 || sc > 599) {
        throw new AppError(400, 'INVALID_STATUS', 'statusCode must be 100..599');
      }
    }
  if (body.response !== undefined && body.response !== null) {
    try { JSON.parse(JSON.stringify(body.response)); }
    catch { throw new AppError(400, 'INVALID_JSON', 'response must be JSON-serializable'); }
  }
  validateName(body);
}

export function createApi({ configStore, logBuffer, mockEngine }) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const sse = sseMiddleware();
  if (logBuffer && typeof logBuffer.subscribe === 'function') {
    logBuffer.subscribe((entry) => broadcast(sse.clients, 'log', entry));
  }
  // 配置/运行时变更广播：MCP、curl、另一标签页等非页面来源的修改也通知所有 WebUI
  // 刷新（前端监听 'config' 事件后重拉数据；payload 仅时间戳，前端全量重拉避免半同步）
  const notifyConfigChange = () => broadcast(sse.clients, 'config', { at: Date.now() });

  // Health
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // SSE
  app.get('/events', (req, res) => sse.handler(req, res));

  // Config
  app.get('/api/config', (_req, res) => res.json(publicConfig(configStore.config)));

  app.patch('/api/config', async (req, res, next) => {
    try {
      const { settings = {} } = req.body || {};
      if (settings.maxBodyBytes !== undefined) {
        if (!Number.isInteger(settings.maxBodyBytes) || settings.maxBodyBytes < 1) {
          throw new AppError(400, 'INVALID_VALUE', 'maxBodyBytes must be a positive integer');
        }
      }
      if (settings.theme !== undefined) {
        if (!['system', 'light', 'dark'].includes(settings.theme)) {
          throw new AppError(400, 'INVALID_VALUE', "theme must be one of 'system' | 'light' | 'dark'");
        }
      }
      if (settings.mcpEnabled !== undefined && typeof settings.mcpEnabled !== 'boolean') {
        throw new AppError(400, 'INVALID_VALUE', 'mcpEnabled must be a boolean');
      }
      if (settings.uiPort !== undefined) {
        const up = Number(settings.uiPort);
        if (!Number.isInteger(up) || up < 1 || up > 65535) {
          throw new AppError(400, 'INVALID_VALUE', 'uiPort must be 1..65535');
        }
        settings.uiPort = up;
      }
      // storagePath 分两种情况：未变更（前端每次保存都会带上该字段）→ 普通保存；
      // 真正迁移目录 → 校验目标无 data.json 后 拷贝→写新路径→删旧文件（失败回滚）
      const migrating = settings.storagePath !== undefined
        && settings.storagePath !== configStore.storagePath;
      if (migrating) {
        if (!isValidStoragePath(settings.storagePath)) {
          throw new AppError(400, 'INVALID_PATH', 'storagePath must be an absolute path');
        }
        const oldFile = `${configStore.storagePath}/data.json`;
        const newDir = settings.storagePath;
        const oldDir = configStore.storagePath;
        await fs.mkdir(newDir, { recursive: true });
        // 目标目录已有 data.json → 拒绝，不静默覆盖（copyFile 会无条件覆盖）
        let targetHasData = true;
        try { await fs.access(`${newDir}/data.json`); }
        catch (e) {
          if (e.code !== 'ENOENT') throw e;
          targetHasData = false;
        }
        if (targetHasData) {
          throw new AppError(409, 'DATA_EXISTS', 'target directory already has data.json');
        }
        // 顺序：先拷贝到目标 → 写新路径（失败则回滚 storagePath，旧文件仍完好）→ 最后删旧文件
        try { await fs.copyFile(oldFile, `${newDir}/data.json`); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        configStore.storagePath = newDir;
        try {
          await configStore.update((cfg) => applyConfigSettings(cfg, settings));
        } catch (e) {
          configStore.storagePath = oldDir;
          throw e;
        }
        try { await fs.unlink(oldFile); } catch {}
      } else {
        await configStore.update((cfg) => applyConfigSettings(cfg, settings));
      }
      notifyConfigChange();
      res.json(publicConfig(configStore.config));
    } catch (e) { next(e); }
  });

  // Endpoints CRUD
  app.get('/api/endpoints', (_req, res) => res.json(configStore.config.endpoints));

  app.post('/api/endpoints', async (req, res, next) => {
    try {
      validateEndpointBody(req.body);
      const id = crypto.randomUUID();
      // 剔除保留字段 + 归一化：body 里的 id 不可覆盖服务端 UUID（否则重复 id 会让更新/删除错乱）；
      // port/statusCode 按校验值 Number 落库（字符串 '8080' 与数字 8080 分裂会让端口绑定撞车）
      const { id: _clientId, enabled: _rawEnabled, ...rest } = req.body;
      const ep = withNormalizedName({
        id,
        ...rest,
        port: Number(rest.port),
        statusCode: rest.statusCode === undefined ? undefined : Number(rest.statusCode),
        enabled: req.body.enabled !== false,
      });
      const all = [...configStore.config.endpoints, ep];
      assertHttpPort(configStore.config, ep.port);
      configStore.checkUniqueness(all);
      await configStore.update((cfg) => {
        cfg.endpoints = all;
        ensurePortEntity(cfg, ep.port);
        return cfg;
      });
      await syncMockEngine(mockEngine, configStore);
      notifyConfigChange();
      res.status(201).json(ep);
    } catch (e) { next(e); }
  });

  // 列表排序：ids 必须是现有端点 id 的排列；顺序纯展示语义，不影响 mock 路由。
  // 注意：必须注册在 /api/endpoints/:id 之前，否则 "order" 被当作 :id。
  app.put('/api/endpoints/order', async (req, res, next) => {
    try {
      const { ids } = req.body || {};
      const list = configStore.config.endpoints;
      const invalid = () => new AppError(400, 'INVALID_ORDER', 'ids must be a permutation of endpoint ids');
      if (!Array.isArray(ids) || ids.length !== list.length) throw invalid();
      const byId = new Map(list.map((e) => [e.id, e]));
      const seen = new Set();
      const reordered = [];
      for (const id of ids) {
        if (seen.has(id) || !byId.has(id)) throw invalid();
        seen.add(id);
        reordered.push(byId.get(id));
      }
      await configStore.update((cfg) => {
        cfg.endpoints = reordered;
        return cfg;
      });
      notifyConfigChange();
      res.json(configStore.config.endpoints);
    } catch (e) { next(e); }
  });

  app.put('/api/endpoints/:id', async (req, res, next) => {
    try {
      const list = configStore.config.endpoints;
      const idx = list.findIndex((e) => e.id === req.params.id);
      if (idx < 0) throw new AppError(404, 'NOT_FOUND', 'endpoint not found');
      validateEndpointBody(req.body);
      // port 按校验值 Number 落库（同 POST 的归一化）；id 已显式固定为既有端点 id
      const updated = withNormalizedName({
        ...list[idx],
        ...req.body,
        id: list[idx].id,
        port: Number(req.body.port),
        statusCode: req.body.statusCode === undefined ? undefined : Number(req.body.statusCode),
      });
      const all = [...list];
      all[idx] = updated;
      assertHttpPort(configStore.config, updated.port);
      configStore.checkUniqueness(all, req.params.id);
      await configStore.update((cfg) => {
        cfg.endpoints = all;
        ensurePortEntity(cfg, updated.port);
        return cfg;
      });
      await syncMockEngine(mockEngine, configStore);
      notifyConfigChange();
      res.json(updated);
    } catch (e) { next(e); }
  });

  app.delete('/api/endpoints/:id', async (req, res, next) => {
    try {
      const list = configStore.config.endpoints;
      const next = list.filter((e) => e.id !== req.params.id);
      if (next.length === list.length) throw new AppError(404, 'NOT_FOUND', 'endpoint not found');
      await configStore.update((cfg) => { cfg.endpoints = next; return cfg; });
      await syncMockEngine(mockEngine, configStore);
      notifyConfigChange();
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // Runtime
  app.post('/api/runtime/start', async (req, res, next) => {
    try {
      const result = await mockEngine.start(configStore.config.endpoints, configStore.config.ports, configStore.config.services || []);
      notifyConfigChange();
      res.json(result);
    } catch (e) { next(e); }
  });

  app.post('/api/runtime/stop', async (req, res, next) => {
    try {
      const ports = [...(mockEngine.servers?.keys?.() || [])];
      await mockEngine.stop();
      notifyConfigChange();
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

  // Ports CRUD（端口一等实体）
  registerPortRoutes(app, { configStore, mockEngine, notifyConfigChange });

  // WebService services CRUD + WSDL 解析（spec §5）
  registerServiceRoutes(app, { configStore, mockEngine, notifyConfigChange });

  // Preview & generators (dynamic response values) —挂 createApi 末尾、错误中间件之前
  registerPreviewRoutes(app);

  // MCP over HTTP（设置页开关门控，默认关闭）——/mcp 非法方法/关闭态在此收口，避免落入下方 404/SPA fallback
  registerMcpHttpRoutes(app, { configStore });

  // Error handler (must be last in createApi so API errors are formatted)
  app.use((err, _req, res, _next) => {
    res.status(statusFor(err)).json(toErrorResponse(err));
  });

  return app;
}
