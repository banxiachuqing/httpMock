// 表达式解析器 —— 单一来源，被 mock-engine 和 /api/preview 共用
// 类型规则见 specs/2026-06-23-dynamic-response-generator-design.md §3
import { runGenerator, GENERATORS } from './generators/index.js';

export class ResolverError extends Error {
  /**
   * @param {string} message
   * @param {'UNKNOWN_GENERATOR'|'BAD_ARGS'|'BAD_EXPRESSION'} code
   * @param {{ generatorId?: string, from?: number, to?: number }} meta
   */
  constructor(message, code, meta = {}) {
    super(message);
    this.code = code;
    if (meta.generatorId !== undefined) this.generatorId = meta.generatorId;
    if (meta.from !== undefined) this.from = meta.from;
    if (meta.to !== undefined) this.to = meta.to;
  }
}

const ID_RE = '[a-zA-Z_][a-zA-Z0-9_]*(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)*';

/**
 * 解析首个 {{...}} 表达式（用于 Editor / 模态框预填）。
 * @param {string} text
 * @returns {{ id: string, args: Record<string, string>, start: number, end: number } | null}
 */
export function parseExpression(text) {
  const re = new RegExp(`\\{\\{\\$(${ID_RE})(?::([^}]*))?\\}\\}`);
  const m = re.exec(text);
  if (!m) return null;
  const id = m[1];
  const argStr = m[2] || '';
  const args = {};
  if (argStr) {
    argStr.split(':').forEach((p, i) => { args[i] = p; });
  }
  return { id, args, start: m.index, end: m.index + m[0].length };
}

/**
 * 判断字符串是否为「纯表达式」：整个字符串就是一个 {{...}}，无前后空白也无其他字符。
 * （按 spec §3 「不允许任何其他字符、包括空格」—— 边界空白让表达式变成「混合」）
 * @param {string} text
 */
function isPureExpression(text) {
  if (typeof text !== 'string') return false;
  const re = new RegExp(`^\\{\\{\\$(${ID_RE})(?::([^}]*))?\\}\\}$`);
  return re.test(text);
}

/**
 * 把按位置排列的 args 对象转成按生成器定义的名字命名。
 * @param {Record<string, string>} positional
 * @param {Array<{ name: string }>} argSpecs
 */
function bindArgs(positional, argSpecs) {
  const out = {};
  for (let i = 0; i < argSpecs.length; i++) {
    out[argSpecs[i].name] = positional[i];
  }
  return out;
}

/**
 * 递归解析 value 中的 {{...}} 表达式。
 * 纯表达式按 outputType 原类型注入；混合 → String() 拼接；失败时纯 → null / 混合 → 原字符串。
 * @param {unknown} value
 * @returns {{ value: unknown, errors: ResolverError[] }}
 */
export function resolve(value) {
  const errors = [];
  const out = walk(value, errors);
  return { value: out, errors };
}

function walk(value, errors) {
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, errors));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // key 不解析（语义：字段名不应动态）
      out[k] = walk(v, errors);
    }
    return out;
  }
  if (typeof value !== 'string') {
    return value;
  }
  if (!value.includes('{{')) {
    return value;
  }

  const pure = isPureExpression(value);
  const re = new RegExp(`\\{\\{\\$(${ID_RE})(?::([^}]*))?\\}\\}(?::([^}]*))?`, 'g');
  // 上面正则多带一个 :[^}]* 是占位 — 实际上需要不带 (避免错配)；用更简单的：
  const findRe = new RegExp(`\\{\\{\\$(${ID_RE})(?::([^}]*))?\\}\\}`, 'g');
  const replacements = [];
  let m;
  while ((m = findRe.exec(value)) !== null) {
    replacements.push({
      match: m[0], id: m[1], argsStr: m[2] || '',
      from: m.index, to: m.index + m[0].length,
    });
  }
  // 抑制 lint: re 仅用于展示解析器意图
  void re;

  // 纯表达式：单条，尝试按 outputType 原类型注入
  if (pure && replacements.length === 1) {
    return resolvePure(replacements[0], errors);
  }

  // 混合：替换所有 {{...}}，失败保留原 match 字符串
  let result = '';
  let cursor = 0;
  for (const r of replacements) {
    result += value.slice(cursor, r.from);
    const sub = resolvePure(r, errors, /* mixedMode */ true);
    result += sub === null ? r.match : String(sub);
    cursor = r.to;
  }
  result += value.slice(cursor);
  return result;
}

function resolvePure(r, errors, mixedMode = false) {
  const def = GENERATORS[r.id];
  if (!def) {
    errors.push(new ResolverError(`未知生成器：${r.id}`, 'UNKNOWN_GENERATOR', {
      generatorId: r.id, from: r.from, to: r.to,
    }));
    return null;
  }
  const positional = {};
  if (r.argsStr) {
    r.argsStr.split(':').forEach((p, i) => { positional[i] = p; });
  }
  const named = bindArgs(positional, def.args);
  try {
    const out = runGenerator(r.id, named);
    return out;
  } catch (err) {
    const code = err.message.startsWith('未知生成器') ? 'UNKNOWN_GENERATOR' : 'BAD_ARGS';
    errors.push(new ResolverError(err.message, code, {
      generatorId: r.id, from: r.from, to: r.to,
    }));
    return null;
  }
  // mixedMode 仅用于语义标注；逻辑同上（成功 → 转换，失败 → null → 上层决定用原 match）
  void mixedMode;
}
