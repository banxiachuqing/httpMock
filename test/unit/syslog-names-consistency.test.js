// L3：服务端 src/syslog.js 与前端 public/syslog-names.js 是同一 RFC 5424 §6.2.1 表的副本；
// 任何一边改动忘了同步另一边，后端测试仍全绿但前端会显示错名或 fallback 'unparsed'。
// 这里用 dynamic import 把两份文件实际加载进来比对，保证 CI 失败（不再静默漂移）。
import { describe, it, expect } from 'vitest';

describe('syslog 名称表前后端一致性（L3）', () => {
  it('public/syslog-names.js 与 src/syslog.js 完全一致', async () => {
    const server = await import('../../src/syslog.js');
    const client = await import('../../public/syslog-names.js');
    expect(client.SYSLOG_SEVERITY_NAMES).toEqual(server.SEVERITY_NAMES);
    expect(client.SYSLOG_FACILITY_NAMES).toEqual(server.FACILITY_NAMES);
  });

  it('embed-assets/public/syslog-names.js 也保持一致', async () => {
    const server = await import('../../src/syslog.js');
    const client = await import('../../embed-assets/public/syslog-names.js');
    expect(client.SYSLOG_SEVERITY_NAMES).toEqual(server.SEVERITY_NAMES);
    expect(client.SYSLOG_FACILITY_NAMES).toEqual(server.FACILITY_NAMES);
  });
});