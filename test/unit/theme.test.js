import { describe, it, expect } from 'vitest';
import { resolveTheme } from '../../public/theme.js';

describe('resolveTheme', () => {
  it('system 跟随 prefersDark', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('显式 light/dark 覆盖系统偏好', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('非法值按 system 处理', () => {
    expect(resolveTheme('neon', true)).toBe('dark');
    expect(resolveTheme(undefined, false)).toBe('light');
  });
});
