// Syslog 解析器单元测试（spec 2026-08-22 §4 / §10）
// 全程不抛错（铁律）；覆盖 RFC3164 / RFC5424 / 无 PRI / 任意字节 4 类回退
import { describe, it, expect } from 'vitest';
import { parseSyslog, SEVERITY_NAMES, FACILITY_NAMES } from '../../src/syslog.js';

describe('常量导出', () => {
  it('SEVERITY_NAMES 是 RFC 5424 §6.2.1 表的标准 8 项', () => {
    expect(SEVERITY_NAMES).toEqual([
      'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
    ]);
  });

  it('FACILITY_NAMES 索引 0=kern，索引 22=local7（RFC 5424 §6.2.1 表 0..22 共 23 项命名）', () => {
    expect(FACILITY_NAMES[0]).toBe('kern');
    expect(FACILITY_NAMES[22]).toBe('local7');
    expect(FACILITY_NAMES.length).toBe(23);
  });
});

describe('parseSyslog RFC 3164', () => {
  it('完整带 PRI / 时间戳 / hostname / tag[pid]: / msg', () => {
    const r = parseSyslog(Buffer.from('<134>Aug 22 14:30:00 myhost myapp[123]: hello world'));
    expect(r).toMatchObject({
      ok: true,
      format: 'rfc3164',
      facility: 16, // 134 >> 3 = 16 → FACILITY_NAMES[16] = local1（per RFC 5424 §6.2.1）
      severity: 6,  // 134 & 7  = 6 (info)
      hostname: 'myhost',
      appName: 'myapp',
      procId: '123',
      timestamp: 'Aug 22 14:30:00',
      message: 'hello world',
    });
    expect(r.msgId).toBeNull();
    expect(r.structuredData).toBeNull();
  });

  it('无 pid 时 procId 为 null', () => {
    const r = parseSyslog(Buffer.from('<134>Aug 22 14:30:00 myhost myapp: hello'));
    expect(r.ok).toBe(true);
    expect(r.format).toBe('rfc3164');
    expect(r.appName).toBe('myapp');
    expect(r.procId).toBeNull();
    expect(r.message).toBe('hello');
  });

  it('单-digit 日允许双空格（Aug  1 形式）', () => {
    const r = parseSyslog(Buffer.from('<134>Aug  1 14:30:00 myhost myapp[123]: x'));
    expect(r.ok).toBe(true);
    expect(r.format).toBe('rfc3164');
    expect(r.timestamp).toBe('Aug  1 14:30:00');
    expect(r.message).toBe('x');
  });
});

describe('parseSyslog RFC 5424', () => {
  it('完整带 SD / APP-NAME / PROCID / MSGID / MSG', () => {
    const r = parseSyslog(Buffer.from(
      '<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog - ID47 ' +
      '[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"] ' +
      'BOMAn application event log entry...'
    ));
    expect(r.ok).toBe(true);
    expect(r.format).toBe('rfc5424');
    expect(r.facility).toBe(20); // 165 >> 3 = 20
    expect(r.severity).toBe(5);  // 165 & 7  = 5 (notice)
    expect(r.timestamp).toBe('2003-10-11T22:14:15.003Z');
    expect(r.hostname).toBe('mymachine.example.com');
    expect(r.appName).toBe('evntslog');
    expect(r.procId).toBeNull();
    expect(r.msgId).toBe('ID47');
    expect(r.structuredData).toBe('[exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"]');
    expect(r.message).toBe('BOMAn application event log entry...');
  });

  it('PROCID 为 "-" nilvalue 转 null（per spec §4 nilvalue → null）', () => {
    const r = parseSyslog(Buffer.from('<13>1 2024-01-01T00:00:00Z host app - - - hi'));
    expect(r.ok).toBe(true);
    expect(r.format).toBe('rfc5424');
    expect(r.facility).toBe(1);
    expect(r.severity).toBe(5);
    expect(r.appName).toBe('app');
    expect(r.procId).toBeNull();
    expect(r.msgId).toBeNull();
    expect(r.message).toBe('hi');
  });

  it('MSG 为空时 message 为空串', () => {
    const r = parseSyslog(Buffer.from('<13>1 2024-01-01T00:00:00Z host app - - - '));
    expect(r.ok).toBe(true);
    expect(r.format).toBe('rfc5424');
    expect(r.message).toBe('');
  });
});

describe('parseSyslog 兜底（解析失败）', () => {
  it('无 PRI 时 ok=false format=raw，message 是全文 utf8', () => {
    const r = parseSyslog(Buffer.from('hello world without pri'));
    expect(r.ok).toBe(false);
    expect(r.format).toBe('raw');
    expect(r.message).toBe('hello world without pri');
    expect(r.facility).toBeNull();
    expect(r.severity).toBeNull();
    expect(r.hostname).toBeNull();
  });

  it('PRI 后垃圾但 PRI 解析成功 → 仍保留 facility/severity，format=raw', () => {
    const r = parseSyslog(Buffer.from('<13>garbage not a syslog line'));
    expect(r.facility).toBe(1);
    expect(r.severity).toBe(5);
    expect(r.ok).toBe(false);
    expect(r.format).toBe('raw');
  });

  it('任意字节（含 null / 非 utf8）不抛错', () => {
    const buf = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x01]);
    expect(() => parseSyslog(buf)).not.toThrow();
    const r = parseSyslog(buf);
    expect(r).toHaveProperty('ok');
    expect(r).toHaveProperty('format');
    expect(r).toHaveProperty('message');
  });

  it('空 Buffer 不抛错', () => {
    const r = parseSyslog(Buffer.alloc(0));
    expect(r.ok).toBe(false);
    expect(r.format).toBe('raw');
    expect(r.message).toBe('');
  });

  it('PRI 越界（如 999999）视为 raw，facility/severity 留 null（M4 防御）', () => {
    const r = parseSyslog(Buffer.from('<999999>garbage'));
    expect(r.ok).toBe(false);
    expect(r.format).toBe('raw');
    expect(r.facility).toBeNull();
    expect(r.severity).toBeNull();
  });

  it('RFC 5424 TIMESTAMP 为 "-" → null（M2 nilvalue 覆盖全部 5 字段）', () => {
    const r = parseSyslog(Buffer.from(
      '<13>1 - host app - ID47 - hi'
    ));
    expect(r.ok).toBe(true);
    expect(r.format).toBe('rfc5424');
    expect(r.timestamp).toBeNull();
    // 其他字段仍正常 nilvalue
    expect(r.hostname).toBe('host');
    expect(r.appName).toBe('app');
    expect(r.procId).toBeNull();
    expect(r.msgId).toBe('ID47');
  });

  it('5424 SD 未闭合 + 3164 不匹配 → 走 raw，message 不残留 "1 " 前缀（L2）', () => {
    // PRI 后以 "1 " 开头触发 5424 分支；SD 故意未闭合让 5424 失败；
    // 3164 也匹配不上（无 Mmm dd 时间戳）→ 兜底 raw
    const r = parseSyslog(Buffer.from('<13>1 2024-01-01T00:00:00Z host app - ID47 [unclosed'));
    expect(r.ok).toBe(false);
    expect(r.format).toBe('raw');
    expect(r.facility).toBe(1);
    expect(r.severity).toBe(5);
    // message 应是去除 PRI 后的剩余文本，不含开头 "1 "
    expect(r.message).not.toMatch(/^1 /);
  });
});