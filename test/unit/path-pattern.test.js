import { describe, it, expect } from 'vitest';
import {
  isPattern, splitPath, validatePattern,
  compilePattern, compareSpecificity, matchSegments,
} from '../../src/path-pattern.js';

const compiled = (path) => compilePattern({ path });
const match = (pattern, path) => matchSegments(compiled(pattern), splitPath(path));

describe('isPattern', () => {
  it('含 * 即视为 pattern，字面 path 不是', () => {
    expect(isPattern('/a/*')).toBe(true);
    expect(isPattern('/a/**')).toBe(true);
    expect(isPattern('/a/b')).toBe(false);
  });
});

describe('splitPath — 拆段丢弃空段（/a/ 与 /a 等价）', () => {
  it('尾斜杠、连续斜杠、根路径', () => {
    expect(splitPath('/a/')).toEqual(['a']);
    expect(splitPath('/a')).toEqual(['a']);
    expect(splitPath('/a//b')).toEqual(['a', 'b']);
    expect(splitPath('/')).toEqual([]);
  });
});

describe('validatePattern — * 与 ** 必须独占一段', () => {
  it('合法 pattern 返回 null', () => {
    expect(validatePattern('/a/*')).toBeNull();
    expect(validatePattern('/a/**/b/**')).toBeNull();
    expect(validatePattern('/a/b')).toBeNull();
  });
  it('段内部分通配返回原因（大声失败，不做隐式语义）', () => {
    expect(validatePattern('/api/fo*/cmd')).toContain('独占一段');
    expect(validatePattern('/api/*x/cmd')).toContain('独占一段');
    expect(validatePattern('/api/***/cmd')).toContain('独占一段');
  });
});

describe('matchSegments — * 单段', () => {
  it('匹配单段并捕获', () => {
    expect(match('/api/*/cmd', '/api/v1/cmd')).toEqual(['v1']);
  });
  it('不匹配零段、不跨段', () => {
    expect(match('/api/*/cmd', '/api/cmd')).toBeNull();
    expect(match('/api/*/cmd', '/api/v1/v2/cmd')).toBeNull();
  });
  it('字面段必须相等', () => {
    expect(match('/api/*/cmd', '/other/v1/cmd')).toBeNull();
    expect(match('/api/*/cmd', '/api/v1/other')).toBeNull();
  });
  it('尾斜杠等价：/a/* 匹配 /a/b/', () => {
    expect(match('/a/*', '/a/b/')).toEqual(['b']);
  });
});

describe('matchSegments — ** 跨段', () => {
  it('零段命中（捕获空串）', () => {
    expect(match('/api/**', '/api')).toEqual(['']);
  });
  it('多段命中并用 / 拼回', () => {
    expect(match('/api/**', '/api/v1/deep/x')).toEqual(['v1/deep/x']);
  });
  it('** 在中间：非贪婪取第一个可行解', () => {
    expect(match('/a/**/b', '/a/x/y/b')).toEqual(['x/y']);
  });
  it('多通配段按从左到右顺序收集捕获值', () => {
    expect(match('/a/*/b/**', '/a/x/b/y/z')).toEqual(['x', 'y/z']);
  });
});

describe('compareSpecificity — 字面(2) > *(1) > **(0)，逐段从左到右', () => {
  const cmp = (a, b) => compareSpecificity(compiled(a), compiled(b));

  it('首段字面胜 *', () => {
    expect(cmp('/a/*/c', '/*/b/c')).toBeLessThan(0);
  });
  it('* 胜 **', () => {
    expect(cmp('/a/*/*', '/a/**')).toBeLessThan(0);
  });
  it('逐段类型全同 → 段数多者胜', () => {
    expect(cmp('/a/**/b', '/a/**')).toBeLessThan(0);
  });
  it('综合排序：/users/* 胜 /users/** 胜 /**', () => {
    const sorted = ['/**', '/users/**', '/users/*'].map(compiled).sort(compareSpecificity);
    expect(sorted.map((p) => p.endpoint.path)).toEqual(['/users/*', '/users/**', '/**']);
  });
  it('完全平手 → 稳定排序保持配置顺序', () => {
    const list = ['/a/*', '/b/*'].map(compiled);
    list.sort(compareSpecificity);
    expect(list.map((p) => p.endpoint.path)).toEqual(['/a/*', '/b/*']);
  });
});
