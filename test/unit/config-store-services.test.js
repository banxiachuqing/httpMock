import { describe, it, expect } from 'vitest';
import { ConfigStore } from '../../src/config-store.js';

const store = new ConfigStore({ storagePath: '/nonexistent' });

function svc(id, port, path, enabled = true) {
  return { id, port, path, name: id, enabled, operations: [] };
}

describe('ConfigStore.checkServiceUniqueness', () => {
  it('(port, path) 冲突抛 DUPLICATE_SERVICE', () => {
    expect(() => store.checkServiceUniqueness([svc('a', 8082, '/ws/A'), svc('b', 8082, '/ws/A')]))
      .toThrowError(/duplicate service/);
  });

  it('不同端口同 path 不冲突', () => {
    expect(() => store.checkServiceUniqueness([svc('a', 8082, '/ws/A'), svc('b', 8083, '/ws/A')]))
      .not.toThrow();
  });

  it('禁用的服务不参与查重', () => {
    expect(() => store.checkServiceUniqueness([svc('a', 8082, '/ws/A'), svc('b', 8082, '/ws/A', false)]))
      .not.toThrow();
  });

  it('excludeId 排除自身（更新场景）', () => {
    expect(() => store.checkServiceUniqueness([svc('a', 8082, '/ws/A'), svc('b', 8082, '/ws/A')], 'b'))
      .not.toThrow();
  });
});