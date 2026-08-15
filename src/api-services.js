// /api/services + /api/wsdl —— WebService 一等实体（spec §5）
import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { parseWsdl } from './wsdl.js';

const MAX_NAME_LENGTH = 50;

function validateServiceName(body) {
  if (body.name === undefined) return;
  if (typeof body.name !== 'string') {
    throw new AppError(400, 'INVALID_NAME', 'name must be a string');
  }
  if (body.name.trim().length > MAX_NAME_LENGTH) {
    throw new AppError(400, 'INVALID_NAME', `name must be at most ${MAX_NAME_LENGTH} chars`);
  }
}

function validateServicePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new AppError(400, 'INVALID_PATH', 'path must start with /');
  }
  if (path.includes('?')) {
    throw new AppError(400, 'INVALID_PATH', 'path must not contain ?');
  }
}

function parsePortNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(400, 'INVALID_PORT', 'port must be 1..65535');
  }
  return port;
}

/** 响应层脱敏：wsdl 原文不随 API 返回（可能几十 KB），替换为 hasWsdl 标志 */
export function toPublicService(s) {
  const { wsdl, ...rest } = s;
  return { ...rest, hasWsdl: typeof wsdl === 'string' && wsdl.length > 0 };
}

function defaultResponseXml(name, tns) {
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Body>\n    <tns:${name}Response xmlns:tns="${tns}">\n      <!-- TODO: 响应字段 -->\n    </tns:${name}Response>\n  </soap:Body>\n</soap:Envelope>`;
}

function defaultOperation(name, soapAction, tns) {
  return {
    id: crypto.randomUUID(),
    name,
    soapAction: soapAction || null,
    responseType: 'normal',
    status: 200,
    responseXml: defaultResponseXml(name, tns),
    enabled: true,
  };
}

function findService(cfg, id) {
  const svc = (cfg.services || []).find((s) => s.id === id);
  if (!svc) throw new AppError(404, 'NOT_FOUND', 'service not found');
  return svc;
}

// WS 服务引用的端口：已是 http 型 → 冲突；不存在 → 补建 ws 端口实体
function ensureWsPortEntity(cfg, port) {
  const existing = cfg.ports.find((p) => p.port === port);
  if (existing) {
    if (existing.type !== 'ws') {
      throw new AppError(400, 'PORT_TYPE_MISMATCH', `port ${port} is an http port`);
    }
    return;
  }
  cfg.ports = [...cfg.ports, { port, enabled: true, type: 'ws' }].sort((a, b) => a.port - b.port);
}

export function registerServiceRoutes(app, { configStore }) {
  // WSDL 解析预览（不落库，导入弹窗第一步）
  app.post('/api/wsdl/parse', (req, res, next) => {
    try {
      res.json(parseWsdl(req.body?.wsdl));
    } catch (e) { next(e); }
  });

  app.post('/api/services', async (req, res, next) => {
    try {
      const body = req.body || {};
      const port = parsePortNumber(body.port);
      validateServicePath(body.path);
      validateServiceName(body);
      let wsdl = null;
      let parsed = null;
      if (body.wsdl !== undefined && body.wsdl !== null) {
        if (typeof body.wsdl !== 'string') {
          throw new AppError(400, 'INVALID_WSDL', 'wsdl must be a string');
        }
        parsed = parseWsdl(body.wsdl);
        wsdl = body.wsdl;
      }
      const name = typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : body.path.split('/').pop();
      const targetNamespace = parsed?.targetNamespace
        || (typeof body.targetNamespace === 'string' && body.targetNamespace.trim())
        || `urn:${name}`;
      const service = {
        id: crypto.randomUUID(),
        port,
        path: body.path,
        name,
        enabled: body.enabled !== false,
        targetNamespace,
        wsdl,
        operations: (parsed?.operations || []).map((o) => defaultOperation(o.name, o.soapAction, targetNamespace)),
      };
      const all = [...(configStore.config.services || []), service];
      configStore.checkServiceUniqueness(all);
      await configStore.update((cfg) => {
        cfg.services = all;
        ensureWsPortEntity(cfg, port);
        return cfg;
      });
      res.status(201).json(toPublicService(service));
    } catch (e) { next(e); }
  });

  app.put('/api/services/:id', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.port !== undefined) {
        throw new AppError(400, 'FIELD_IMMUTABLE', 'service port cannot be changed');
      }
      validateServiceName(body);
      if (body.path !== undefined) validateServicePath(body.path);
      let updated;
      await configStore.update((cfg) => {
        const list = cfg.services || [];
        const idx = list.findIndex((s) => s.id === req.params.id);
        if (idx < 0) throw new AppError(404, 'NOT_FOUND', 'service not found');
        const cur = list[idx];
        updated = { ...cur };
        if (body.name !== undefined && body.name.trim()) updated.name = body.name.trim();
        if (body.path !== undefined) updated.path = body.path;
        if (body.enabled !== undefined) updated.enabled = body.enabled !== false;
        if (body.targetNamespace !== undefined) updated.targetNamespace = String(body.targetNamespace);
        const all = [...list];
        all[idx] = updated;
        const pathChanged = body.path !== undefined && body.path !== cur.path;
        // 禁用→启用翻转同样可能与他人撞车（建服务时因禁用被跳过）；true→false 不会
        const enableFlip = body.enabled === true && cur.enabled === false;
        if (pathChanged || enableFlip) {
          // 新 key / 新启用状态：自身不可能误报（同 key 单次出现），排除自身反而漏检
          configStore.checkServiceUniqueness(all);
        }
        cfg.services = all;
        return cfg;
      });
      res.json(toPublicService(updated));
    } catch (e) { next(e); }
  });

  app.delete('/api/services/:id', async (req, res, next) => {
    try {
      const list = configStore.config.services || [];
      if (!list.some((s) => s.id === req.params.id)) {
        throw new AppError(404, 'NOT_FOUND', 'service not found');
      }
      await configStore.update((cfg) => {
        cfg.services = (cfg.services || []).filter((s) => s.id !== req.params.id);
        return cfg;
      });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // 导入/替换 WSDL：合并 operations（同名保留响应配置仅更新 soapAction；新增补默认；多余保留）
  app.post('/api/services/:id/wsdl', async (req, res, next) => {
    try {
      const { wsdl } = req.body || {};
      const parsed = parseWsdl(wsdl);
      let updated;
      await configStore.update((cfg) => {
        const svc = findService(cfg, req.params.id);
        const incoming = new Map(parsed.operations.map((p) => [p.name, p]));
        const merged = svc.operations.map((o) =>
          incoming.has(o.name)
            ? { ...o, soapAction: incoming.get(o.name).soapAction ?? o.soapAction }
            : o);
        for (const p of parsed.operations) {
          if (!merged.some((o) => o.name === p.name)) {
            merged.push(defaultOperation(p.name, p.soapAction, parsed.targetNamespace));
          }
        }
        svc.wsdl = wsdl;
        svc.targetNamespace = parsed.targetNamespace;
        svc.operations = merged;
        updated = svc;
        return cfg;
      });
      res.json(toPublicService(updated));
    } catch (e) { next(e); }
  });

  app.post('/api/services/:id/operations', async (req, res, next) => {
    try {
      const { name, soapAction } = req.body || {};
      if (typeof name !== 'string' || !name.trim()) {
        throw new AppError(400, 'INVALID_NAME', 'operation name required');
      }
      let updated;
      await configStore.update((cfg) => {
        const svc = findService(cfg, req.params.id);
        const trimmed = name.trim();
        if (svc.operations.some((o) => o.name === trimmed)) {
          throw new AppError(400, 'DUPLICATE_OPERATION', `duplicate operation ${trimmed}`);
        }
        const action = typeof soapAction === 'string' && soapAction.trim() ? soapAction.trim() : null;
        svc.operations = [...svc.operations, defaultOperation(trimmed, action, svc.targetNamespace)];
        updated = svc;
        return cfg;
      });
      res.status(201).json(toPublicService(updated));
    } catch (e) { next(e); }
  });

  app.put('/api/services/:id/operations/:opId', async (req, res, next) => {
    try {
      const body = req.body || {};
      let updated;
      await configStore.update((cfg) => {
        const svc = findService(cfg, req.params.id);
        const idx = svc.operations.findIndex((o) => o.id === req.params.opId);
        if (idx < 0) throw new AppError(404, 'NOT_FOUND', 'operation not found');
        const cur = svc.operations[idx];
        const nextOp = { ...cur };
        if (body.name !== undefined) {
          if (typeof body.name !== 'string' || !body.name.trim()) {
            throw new AppError(400, 'INVALID_NAME', 'operation name required');
          }
          const trimmed = body.name.trim();
          if (trimmed !== cur.name && svc.operations.some((o) => o.name === trimmed)) {
            throw new AppError(400, 'DUPLICATE_OPERATION', `duplicate operation ${trimmed}`);
          }
          nextOp.name = trimmed;
        }
        if (body.soapAction !== undefined) {
          nextOp.soapAction = typeof body.soapAction === 'string' && body.soapAction.trim()
            ? body.soapAction.trim()
            : null;
        }
        if (body.responseType !== undefined) {
          if (!['normal', 'fault'].includes(body.responseType)) {
            throw new AppError(400, 'INVALID_VALUE', "responseType must be 'normal' | 'fault'");
          }
          nextOp.responseType = body.responseType;
        }
        if (body.status !== undefined) {
          const st = Number(body.status);
          if (!Number.isInteger(st) || st < 100 || st > 599) {
            throw new AppError(400, 'INVALID_VALUE', 'status must be 100..599');
          }
          nextOp.status = st;
        }
        if (body.responseXml !== undefined) {
          if (typeof body.responseXml !== 'string') {
            throw new AppError(400, 'INVALID_VALUE', 'responseXml must be a string');
          }
          nextOp.responseXml = body.responseXml;
        }
        if (body.enabled !== undefined) nextOp.enabled = body.enabled !== false;
        svc.operations = [...svc.operations.slice(0, idx), nextOp, ...svc.operations.slice(idx + 1)];
        updated = svc;
        return cfg;
      });
      res.json(toPublicService(updated));
    } catch (e) { next(e); }
  });

  app.delete('/api/services/:id/operations/:opId', async (req, res, next) => {
    try {
      let updated;
      await configStore.update((cfg) => {
        const svc = findService(cfg, req.params.id);
        if (!svc.operations.some((o) => o.id === req.params.opId)) {
          throw new AppError(404, 'NOT_FOUND', 'operation not found');
        }
        svc.operations = svc.operations.filter((o) => o.id !== req.params.opId);
        updated = svc;
        return cfg;
      });
      res.json(toPublicService(updated));
    } catch (e) { next(e); }
  });
}