import { describe, it, expect } from 'vitest';
import { nextPortName, portNamePrefix } from '../../src/port-name.js';

describe('portNamePrefix：各端口类型的默认名前缀', () => {
  it.each([
    ['http', 'API'],
    ['ws', 'WS'],
    ['tcp', 'TCP'],
    ['udp', 'UDP'],
    ['syslog', 'SYSLOG'],
  ])('%s → %s', (type, prefix) => {
    expect(portNamePrefix(type)).toBe(prefix);
  });
});

describe('nextPortName：留空时自动生成「前缀-序号」', () => {
  it('没有任何端口时从 1 开始', () => {
    expect(nextPortName([], 'http')).toBe('API-1');
    expect(nextPortName([], 'ws')).toBe('WS-1');
    expect(nextPortName([], 'syslog')).toBe('SYSLOG-1');
  });

  it('取该前缀下最大序号 +1（而非个数 +1）', () => {
    const ports = [{ name: 'API-1' }, { name: 'API-3' }];
    expect(nextPortName(ports, 'http')).toBe('API-4');
  });

  it('序号按数值比较而非字典序（API-10 > API-2）', () => {
    const ports = [{ name: 'API-2' }, { name: 'API-10' }];
    expect(nextPortName(ports, 'http')).toBe('API-11');
  });

  it('各前缀序号相互独立（API 被占用不影响 WS 从 1 起）', () => {
    const ports = [{ name: 'API-1' }, { name: 'API-2' }];
    expect(nextPortName(ports, 'ws')).toBe('WS-1');
  });

  it('忽略不符合「前缀-数字」格式的名字与用户自定义名', () => {
    const ports = [
      { name: 'API-1' },
      { name: '支付服务' },
      { name: 'API-x' },
      { name: 'API-' },
      { name: 'API-2-备用' },
    ];
    expect(nextPortName(ports, 'http')).toBe('API-2');
  });

  it('端口缺 name 字段时不报错', () => {
    const ports = [{ port: 8080 }, { name: 'API-5' }];
    expect(nextPortName(ports, 'http')).toBe('API-6');
  });
});
