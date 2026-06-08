import { describe, it, expect, vi } from 'vitest';
import { sseResponse, broadcast, sseMiddleware } from '../../src/sse.js';

function mockRes() {
  const headers = {};
  return {
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    headers,
  };
}

describe('sseResponse', () => {
  it('sets SSE headers and flushes', () => {
    const res = mockRes();
    sseResponse(res);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['connection']).toBe('keep-alive');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.flushHeaders).toHaveBeenCalledOnce();
  });
});

describe('broadcast', () => {
  it('writes event + data lines to all clients', () => {
    const res1 = mockRes();
    const res2 = mockRes();
    const clients = new Set([res1, res2]);
    broadcast(clients, 'log', { id: 'x' });
    expect(res1.write).toHaveBeenCalledWith('event: log\ndata: {"id":"x"}\n\n');
    expect(res2.write).toHaveBeenCalledWith('event: log\ndata: {"id":"x"}\n\n');
  });
});

describe('sseMiddleware', () => {
  it('tracks clients and cleans up on close', () => {
    const mw = sseMiddleware();
    const res = mockRes();
    mw.handler({}, res);
    expect(mw.clients.has(res)).toBe(true);
    // Simulate the 'close' event
    const closeHandler = res.on.mock.calls.find((c) => c[0] === 'close')?.[1];
    closeHandler();
    expect(mw.clients.has(res)).toBe(false);
  });
});
