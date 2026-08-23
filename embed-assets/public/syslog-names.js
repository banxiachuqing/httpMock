// 与 src/syslog.js 同步——前端需要的 syslog severity 名表（RFC 5424 §6.2.1，索引 0..7）
// 8 项；无 enum 跨语言对齐需求，保持 8 字符串 literal 即可。
export const SYSLOG_SEVERITY_NAMES = [
  'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
];

// 同源：RFC 5424 §6.2.1 facility 名称表（23 项，前端给"facility 16 (local0)"展示用）
export const SYSLOG_FACILITY_NAMES = [
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
  'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'security', 'console', 'local0',
  'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
];
