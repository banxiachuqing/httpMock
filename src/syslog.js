// Syslog 解析器（spec 2026-08-22 §4）
// 纯函数；RFC 3164 / RFC 5424 自动识别；解析失败回退 raw；任意字节不抛错
//
// 铁律（spec §4）：
//   - PRI 后匹配 /^1 / 走 5424，否则 3164
//   - 3164 时间戳正则：Mmm dd hh:mm:ss（单-digit 日允许双空格）
//   - 5424 字段 `-` nilvalue → null
//   - 全程 try/catch，畸形输入兜底 raw
export const SEVERITY_NAMES = [
  'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
];

// RFC 5424 §6.2.1 facility 表
export const FACILITY_NAMES = [
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
  'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'security', 'console', 'local0',
  'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
];

function rawResult(text, facility, severity) {
  return {
    ok: false,
    format: 'raw',
    facility,
    severity,
    hostname: null,
    appName: null,
    procId: null,
    msgId: null,
    timestamp: null,
    structuredData: null,
    message: text,
  };
}

function nilOr(value) {
  return value === '-' ? null : value;
}

// RFC 5424：VERSION=1 + 6 字段 + 可选 MSG；SD 要么 `-` 要么 `[...]`（可含空格，需配对括号定位）
function parseRfc5424(afterVersion) {
  const parts = afterVersion.split(' ');
  if (parts.length < 6) return null;

  const timestamp = parts[0];
  const hostname = parts[1];
  const appName = parts[2];
  const procId = parts[3];
  const msgId = parts[4];

  let structuredData = null;
  let sdStart = 6;
  const sdHead = parts[5];
  if (sdHead === '-') {
    // nilvalue SD；合法
  } else if (sdHead && sdHead.startsWith('[')) {
    // SD 是括号块，可能跨多段空格；找配对 ']'
    let sdEnd = -1;
    for (let i = 5; i < parts.length; i++) {
      if (parts[i].endsWith(']')) { sdEnd = i; break; }
    }
    if (sdEnd < 0) return null; // 未闭合，视为 5424 解析失败
    structuredData = parts.slice(5, sdEnd + 1).join(' ');
    sdStart = sdEnd + 1;
  } else {
    return null; // SD 既不是 - 也不是 [ 开头
  }

  const message = sdStart < parts.length ? parts.slice(sdStart).join(' ') : '';

  return {
    hostname: nilOr(hostname),
    appName: nilOr(appName),
    procId: nilOr(procId),
    msgId: nilOr(msgId),
    timestamp,
    structuredData,
    message,
  };
}

// RFC 3164：Mmm dd hh:mm:ss + hostname + tag[pid]: / tag: / 裸文本
function parseRfc3164(rest) {
  const m = rest.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([\s\S]*)$/);
  if (!m) return null;
  const timestamp = m[1];
  const hostname = m[2];
  const tail = m[3];
  // tag[pid]: msg
  const tm = tail.match(/^([^:\s\[]+)(\[(\d+)\])?:\s*([\s\S]*)$/);
  let appName = null;
  let procId = null;
  let message = tail;
  if (tm) {
    appName = tm[1];
    procId = tm[3] || null;
    message = tm[4];
  }
  return {
    hostname,
    appName,
    procId,
    msgId: null,
    timestamp,
    structuredData: null,
    message,
  };
}

/**
 * @param {Buffer} buf
 * @returns {{
 *   ok: boolean,
 *   format: 'rfc5424' | 'rfc3164' | 'raw',
 *   facility: number | null,
 *   severity: number | null,
 *   hostname: string | null,
 *   appName: string | null,
 *   procId: string | null,
 *   msgId: string | null,
 *   timestamp: string | null,
 *   structuredData: string | null,
 *   message: string
 * }}
 */
export function parseSyslog(buf) {
  let text;
  try {
    text = buf.toString('utf8');
  } catch (_err) {
    return rawResult('', null, null);
  }

  try {
    let facility = null;
    let severity = null;
    let rest = text;
    const priMatch = text.match(/^<(\d+)>/);
    if (priMatch) {
      const pri = Number(priMatch[1]);
      facility = pri >> 3;
      severity = pri & 7;
      rest = text.slice(priMatch[0].length);
    }

    // 5424 判定：PRI 后匹配 /^1 / → VERSION=1 SP ...
    if (facility !== null && /^1 /.test(rest)) {
      const r5424 = parseRfc5424(rest.slice(2));
      if (r5424) {
        return { ok: true, format: 'rfc5424', facility, severity, ...r5424 };
      }
    }

    // 3164 判定
    const r3164 = parseRfc3164(rest);
    if (r3164) {
      return { ok: true, format: 'rfc3164', facility, severity, ...r3164 };
    }

    // 兜底 raw：保留 PRI（如有）的 facility/severity
    return rawResult(text, facility, severity);
  } catch (_err) {
    // 解析路径异常不抛错（spec §4 铁律）
    return rawResult(text, null, null);
  }
}