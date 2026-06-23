import { describe, it, expect } from 'vitest';
import { resolve, parseExpression, ResolverError } from '../../src/expression-resolver.js';

describe('parseExpression', () => {
  it('parses plain id', () => {
    const p = parseExpression('{{$uuid}}');
    expect(p).toEqual({ id: 'uuid', args: {}, start: 0, end: 9 });
  });

  it('parses id with single arg', () => {
    const p = parseExpression('{{$int:1}}');
    expect(p.id).toBe('int');
    expect(p.args).toEqual({ 0: '1' });
  });

  it('parses id with multiple args', () => {
    const p = parseExpression('{{$int:1:100}}');
    expect(p.args).toEqual({ 0: '1', 1: '100' });
  });

  it('parses id with dots', () => {
    const p = parseExpression('{{$person.fullName:zh_CN}}');
    expect(p.id).toBe('person.fullName');
    expect(p.args).toEqual({ 0: 'zh_CN' });
  });

  it('returns null when no expression', () => {
    expect(parseExpression('hello world')).toBeNull();
  });

  it('returns null on unclosed expression', () => {
    expect(parseExpression('{{$uuid')).toBeNull();
  });
});

describe('resolve — scalar no expression', () => {
  it('returns string as-is', () => {
    const r = resolve('hello');
    expect(r.value).toBe('hello');
    expect(r.errors).toEqual([]);
  });

  it('returns number as-is', () => {
    expect(resolve(42).value).toBe(42);
  });

  it('returns null as-is', () => {
    expect(resolve(null).value).toBeNull();
  });

  it('returns boolean as-is', () => {
    expect(resolve(true).value).toBe(true);
  });
});

describe('resolve — pure expression type preservation', () => {
  it('int pure expression returns number (not string)', () => {
    const r = resolve('{{$int:42:42}}');
    expect(r.value).toBe(42);
    expect(typeof r.value).toBe('number');
  });

  it('uuid pure expression returns string', () => {
    const r = resolve('{{$uuid}}');
    expect(typeof r.value).toBe('string');
    expect(r.value).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('email pure expression returns string', () => {
    const r = resolve('{{$internet.email}}');
    expect(typeof r.value).toBe('string');
    expect(r.value).toContain('@');
  });
});

describe('resolve — mixed expression stringification', () => {
  it('text + expression → string concat', () => {
    const r = resolve('id-{{$int:5:5}}');
    expect(r.value).toBe('id-5');
    expect(typeof r.value).toBe('string');
  });

  it('multiple expressions → string concat', () => {
    const r = resolve('{{$uuid}}-{{$uuid}}');
    expect(typeof r.value).toBe('string');
    expect(r.value).toMatch(/^[0-9a-f-]{36}-[0-9a-f-]{36}$/);
  });

  it('multiple expressions same int → string concat', () => {
    const r = resolve('{{$int:7:7}}-{{$int:8:8}}');
    expect(r.value).toBe('7-8');
  });
});

describe('resolve — nested structures', () => {
  it('walks nested objects', () => {
    const r = resolve({ a: { b: '{{$int:3:3}}' } });
    expect(r.value).toEqual({ a: { b: 3 } });
  });

  it('walks arrays', () => {
    const r = resolve(['{{$int:1:1}}', '{{$int:2:2}}']);
    expect(r.value).toEqual([1, 2]);
  });

  it('does not resolve object keys', () => {
    const r = resolve({ '{{$int:1:1}}': 'value' });
    expect(r.value).toEqual({ '{{$int:1:1}}': 'value' });
  });

  it('handles deeply mixed', () => {
    const r = resolve({
      id: '{{$uuid}}',
      meta: { count: '{{$int:5:5}}', label: 'item-{{$uuid}}' },
      tags: ['{{$lorem.word}}', 'static'],
    });
    expect(typeof r.value.id).toBe('string');
    expect(r.value.meta.count).toBe(5);
    expect(typeof r.value.meta.label).toBe('string');
    expect(r.value.meta.label.startsWith('item-')).toBe(true);
    expect(typeof r.value.tags[0]).toBe('string');
    expect(r.value.tags[1]).toBe('static');
  });
});

describe('resolve — error handling (soft failure)', () => {
  it('unknown generator in pure expression → null + error', () => {
    const r = resolve('{{$nonexistent}}');
    expect(r.value).toBeNull();
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toBeInstanceOf(ResolverError);
    expect(r.errors[0].code).toBe('UNKNOWN_GENERATOR');
  });

  it('unknown generator in mixed expression → keeps original string + error', () => {
    const r = resolve('pre-{{$nonexistent}}');
    expect(r.value).toBe('pre-{{$nonexistent}}');
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].code).toBe('UNKNOWN_GENERATOR');
  });

  it('bad arg type in pure expression → null + error', () => {
    const r = resolve('{{$int:notanumber:10}}');
    expect(r.value).toBeNull();
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].code).toBe('BAD_ARGS');
  });

  it('bad arg type in mixed expression → keeps original string + error', () => {
    const r = resolve('pre-{{$int:notanumber:10}}');
    expect(r.value).toBe('pre-{{$int:notanumber:10}}');
    expect(r.errors.length).toBe(1);
  });

  it('accumulate multiple errors', () => {
    const r = resolve({
      a: '{{$nope1}}',
      b: '{{$nope2}}',
      c: 'static',
    });
    expect(r.errors.length).toBe(2);
    expect(r.value.a).toBeNull();
    expect(r.value.b).toBeNull();
    expect(r.value.c).toBe('static');
  });
});

describe('resolve — whitespace tolerance', () => {
  it('pure expression with surrounding whitespace is mixed', () => {
    const r = resolve(' {{$int:3:3}}');
    expect(r.value).toBe(' 3');
  });

  it('pure expression exact match preserved as type', () => {
    const r = resolve('{{$int:3:3}}');
    expect(r.value).toBe(3);
  });
});
