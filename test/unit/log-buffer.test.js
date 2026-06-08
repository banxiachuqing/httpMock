import { describe, it, expect, vi } from 'vitest';
import { LogBuffer } from '../../src/log-buffer.js';

const mk = (id, ts = Date.now()) => ({ id, timestamp: ts, method: 'GET', path: '/x', port: 8080, status: 200, durationMs: 1, matched: true, endpointId: null, requestHeaders: {}, requestBodyPreview: '' });

describe('LogBuffer', () => {
  it('push + getRecent returns newest last', () => {
    const lb = new LogBuffer(5);
    lb.push(mk('a', 1));
    lb.push(mk('b', 2));
    lb.push(mk('c', 3));
    const out = lb.getRecent(10);
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('caps size and drops oldest', () => {
    const lb = new LogBuffer(3);
    for (let i = 0; i < 5; i++) lb.push(mk(String(i), i));
    const out = lb.getRecent(10);
    expect(out.map((e) => e.id)).toEqual(['2', '3', '4']);
  });

  it('honors limit on getRecent', () => {
    const lb = new LogBuffer(100);
    for (let i = 0; i < 50; i++) lb.push(mk(String(i), i));
    const out = lb.getRecent(5);
    expect(out).toHaveLength(5);
    expect(out[out.length - 1].id).toBe('49');
  });

  it('fans out to subscribers and supports unsubscribe', () => {
    const lb = new LogBuffer(10);
    const a = vi.fn();
    const b = vi.fn();
    const ua = lb.subscribe(a);
    lb.subscribe(b);
    lb.push(mk('x'));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    ua();
    lb.push(mk('y'));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('does not throw if a subscriber throws', () => {
    const lb = new LogBuffer(10);
    lb.subscribe(() => { throw new Error('subscriber boom'); });
    expect(() => lb.push(mk('x'))).not.toThrow();
  });
});
