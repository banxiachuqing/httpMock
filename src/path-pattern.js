// HTTP 端点 path 段级通配（spec 2026-08-27 §2/§3）：
//   *  独占一段 → 匹配任意单个非空段
//   ** 独占一段 → 匹配零个或多个段（跨段）
// 纯函数无状态；mock-engine 每端口 buildRouter 时编译+排序，请求时只做匹配。

/** path 是否含通配符（含 * 即视为 pattern；字面 path 走精确 Map） */
export function isPattern(path) {
  return path.includes('*');
}

/** 拆段：split('/') 后丢弃空段 —— /a/ 与 /a 在通配匹配中等价（spec §2） */
export function splitPath(path) {
  return path.split('/').filter((s) => s !== '');
}

/**
 * 校验 pattern：* / ** 必须独占一段（两侧是 / 或字符串边界）。
 * @returns {string | null} 合法返回 null，非法返回中文原因（供 api.js 抛 INVALID_PATH）
 */
export function validatePattern(path) {
  for (const seg of splitPath(path)) {
    if (!seg.includes('*')) continue;
    if (seg !== '*' && seg !== '**') {
      return `通配符 * / ** 必须独占一段（非法段："${seg}"）`;
    }
  }
  return null;
}

/**
 * 编译 pattern 为段数组结构。
 * @param {object} endpoint 端点实体（含 path）
 * @returns {{ segments: string[], endpoint: object }}
 */
export function compilePattern(endpoint) {
  return { segments: splitPath(endpoint.path), endpoint };
}

// 段类型打分：字面 2 > * 1 > ** 0（spec §3.4）
function segScore(seg) {
  if (seg === '**') return 0;
  if (seg === '*') return 1;
  return 2;
}

/**
 * 具体度比较器（Array.sort 用，更具体者排前）：
 * 逐段从左到右比类型分，第一处分出胜负即定；全同 → 段数多者胜；
 * 再平 → 返回 0，依赖 JS 稳定排序保持配置顺序。
 */
export function compareSpecificity(a, b) {
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const d = segScore(b.segments[i]) - segScore(a.segments[i]);
    if (d !== 0) return d;
  }
  return b.segments.length - a.segments.length;
}

/**
 * 匹配：pattern 段数组 vs 请求段数组（回溯，** 非贪婪尝试消费 0..n 段）。
 * @returns {string[] | null} 命中返回捕获值数组（按通配段从左到右顺序；
 *   ** 多段用 '/' 拼回、零段为 ''），未命中返回 null
 */
export function matchSegments(compiled, pathSegs) {
  const pat = compiled.segments;
  function walk(pi, si, captures) {
    if (pi === pat.length) return si === pathSegs.length ? captures : null;
    const seg = pat[pi];
    if (seg === '**') {
      for (let take = 0; si + take <= pathSegs.length; take++) {
        const r = walk(pi + 1, si + take, [...captures, pathSegs.slice(si, si + take).join('/')]);
        if (r) return r;
      }
      return null;
    }
    if (si >= pathSegs.length) return null;
    if (seg === '*') return walk(pi + 1, si + 1, [...captures, pathSegs[si]]);
    if (seg === pathSegs[si]) return walk(pi + 1, si + 1, captures);
    return null;
  }
  return walk(0, 0, []);
}
