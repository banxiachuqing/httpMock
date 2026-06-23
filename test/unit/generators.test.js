import { describe, it, expect } from 'vitest';
import {
  GENERATORS, CATEGORIES, LOCALES,
  runGenerator, listGenerators, getSample,
} from '../../src/generators/index.js';

describe('GENERATORS registry', () => {
  it('contains entries for all 9 categories from spec §4', () => {
    const cats = new Set(Object.values(GENERATORS).map((g) => g.category));
    expect(cats).toEqual(new Set(['string', 'lorem', 'number', 'date', 'person', 'phone', 'internet', 'image', 'location']));
  });

  it('every generator declares outputType', () => {
    for (const [id, g] of Object.entries(GENERATORS)) {
      expect(['string', 'number', 'boolean', 'date'], `generator ${id}`).toContain(g.outputType);
    }
  });

  it('every generator has label, args, run', () => {
    for (const [id, g] of Object.entries(GENERATORS)) {
      expect(typeof g.label, `label ${id}`).toBe('string');
      expect(Array.isArray(g.args), `args ${id}`).toBe(true);
      expect(typeof g.run, `run ${id}`).toBe('function');
    }
  });

  it('CATEGORIES lists each category once with generatorIds', () => {
    expect(CATEGORIES.length).toBe(9);
    for (const c of CATEGORIES) {
      expect(c.id).toBeTruthy();
      expect(c.label).toBeTruthy();
      expect(c.generatorIds.length).toBeGreaterThan(0);
      for (const gid of c.generatorIds) {
        expect(GENERATORS[gid], `missing generator ${gid}`).toBeDefined();
        expect(GENERATORS[gid].category).toBe(c.id);
      }
    }
  });

  it('LOCALES contains zh_CN and en', () => {
    expect(LOCALES).toEqual(['zh_CN', 'en']);
  });
});

describe('runGenerator', () => {
  it('uuid returns a UUID v4 string', () => {
    const v = runGenerator('uuid', {});
    expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('int respects min/max', () => {
    for (let i = 0; i < 50; i++) {
      const v = runGenerator('int', { min: 5, max: 7 });
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('int uses defaults when args omitted', () => {
    const v = runGenerator('int', {});
    expect(Number.isInteger(v)).toBe(true);
  });

  it('float returns a number', () => {
    const v = runGenerator('float', {});
    expect(typeof v).toBe('number');
  });

  it('internet.email matches email regex', () => {
    const v = runGenerator('internet.email', {});
    expect(v).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  it('internet.ip matches IPv4', () => {
    const v = runGenerator('internet.ip', {});
    expect(v).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  it('internet.url matches http(s)://', () => {
    const v = runGenerator('internet.url', {});
    expect(v).toMatch(/^https?:\/\//);
  });

  it('phone.number returns a non-empty string', () => {
    const v = runGenerator('phone.number', {});
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('person.fullName with locale=zh_CN returns a string', () => {
    const v = runGenerator('person.fullName', { locale: 'zh_CN' });
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('person.fullName with locale=en returns a string', () => {
    const v = runGenerator('person.fullName', { locale: 'en' });
    expect(typeof v).toBe('string');
  });

  it('date.recent with days=7 returns a Date or ISO string', () => {
    const v = runGenerator('date.recent', { days: 7 });
    expect(typeof v === 'string' || v instanceof Date).toBe(true);
  });

  it('image.url returns a URL-like string', () => {
    const v = runGenerator('image.url', {});
    expect(v).toMatch(/^https?:\/\//);
  });

  it('location.city returns a string', () => {
    const v = runGenerator('location.city', { locale: 'zh_CN' });
    expect(typeof v).toBe('string');
  });

  it('throws for unknown id', () => {
    expect(() => runGenerator('does.not.exist', {})).toThrow(/未知生成器/);
  });

  it('throws when required arg missing', () => {
    expect(() => runGenerator('int', { min: 'not a number' })).toThrow();
  });
});

describe('listGenerators', () => {
  it('returns one entry per generator with computed sample', () => {
    const list = listGenerators();
    expect(list.length).toBe(Object.keys(GENERATORS).length);
    for (const entry of list) {
      expect(entry.category).toBeTruthy();
      expect(entry.generator.id).toBeTruthy();
      expect('sample' in entry).toBe(true);
    }
  });
});

describe('getSample', () => {
  it('returns a sample for known id', () => {
    const s = getSample('uuid');
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });

  it('merges partialArgs with defaults', () => {
    const s = getSample('int', { min: 100, max: 100 });
    expect(s).toBe(100);
  });

  it('returns null for unknown id (does not throw)', () => {
    const s = getSample('nope');
    expect(s).toBeNull();
  });
});
