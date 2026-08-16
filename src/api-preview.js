// 三个预览 / 生成器 API 路由
import { AppError } from './errors.js';
import { GENERATORS, runGenerator, CATEGORIES, LOCALES } from './generators/index.js';
import { resolve } from './expression-resolver.js';

/**
 * @param {import('express').Express} app
 */
export function registerPreviewRoutes(app) {
  app.get('/api/generators', (_req, res) => {
    const categories = CATEGORIES.map((cat) => ({
      id: cat.id,
      label: cat.label,
      generators: cat.generatorIds.map((gid) => {
        const def = GENERATORS[gid];
        let sample = null;
        try { sample = runGenerator(gid, {}); } catch { /* keep null */ }
        return {
          id: gid,
          label: def.label,
          outputType: def.outputType,
          args: def.args,
          sample,
        };
      }),
    }));
    res.json({ locale: 'zh_CN', locales: LOCALES, categories });
  });

  app.post('/api/generators/sample', (req, res, next) => {
    try {
      const { id, args = {} } = req.body || {};
      if (typeof id !== 'string' || !GENERATORS[id]) {
        throw new AppError(400, 'UNKNOWN_GENERATOR', `未知生成器：${id}`);
      }
      let sample;
      try {
        sample = runGenerator(id, args);
      } catch (genErr) {
        // runGenerator 抛的 Error → 包成 400 AppError
        throw new AppError(400, 'BAD_ARGS', genErr.message);
      }
      res.json({ ok: true, sample });
    } catch (e) { next(e); }
  });

  app.post('/api/preview', (req, res, next) => {
    try {
      const { text, format } = req.body || {};
      if (typeof text !== 'string') {
        throw new AppError(400, 'INVALID_TEXT', 'text must be a string');
      }
      // WS XML 预览：不做 JSON.parse，直接混合模式替换（spec §5）
      if (format === 'text') {
        const exprCount = countExpressions(text);
        const { value, errors } = resolve(text);
        return res.json({
          ok: true,
          resolved: typeof value === 'string' ? value : String(value),
          exprCount,
          errors: serializeErrors(errors),
        });
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        return res.json({
          ok: false,
          stage: 'json-parse',
          error: parseErr.message,
          lastResolved: null,
        });
      }
      const exprCount = countExpressions(text);
      const { value, errors } = resolve(parsed);
      res.json({ ok: true, resolved: value, exprCount, errors: serializeErrors(errors) });
    } catch (e) { next(e); }
  });
}

const EXPR_RE = /\{\{\$[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*(?::[^}]*)?\}\}/g;

function countExpressions(text) {
  return (text.match(EXPR_RE) || []).length;
}

// ResolverError → plain object（ok=true 时不走错误中间件，需手动序列化）
function serializeErrors(errors) {
  return errors.map((e) => ({
    message: e.message,
    code: e.code,
    ...(e.generatorId !== undefined ? { generatorId: e.generatorId } : {}),
    ...(e.from !== undefined ? { from: e.from } : {}),
    ...(e.to !== undefined ? { to: e.to } : {}),
  }));
}
