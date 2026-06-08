import { describe, it, expect } from 'vitest';
import { AppError, toErrorResponse, statusFor } from '../../src/errors.js';

describe('AppError', () => {
  it('carries status, code, and message', () => {
    const e = new AppError(400, 'INVALID_JSON', 'parse failed at line 3');
    expect(e.status).toBe(400);
    expect(e.code).toBe('INVALID_JSON');
    expect(e.message).toBe('parse failed at line 3');
    expect(e instanceof Error).toBe(true);
  });
});

describe('toErrorResponse', () => {
  it('serializes AppError as JSON envelope', () => {
    const e = new AppError(409, 'DUPLICATE_ENDPOINT', 'port+method+path exists');
    expect(toErrorResponse(e)).toEqual({
      error: 'port+method+path exists',
      code: 'DUPLICATE_ENDPOINT',
    });
  });
  it('wraps unknown errors as 500 INTERNAL', () => {
    const e = new Error('boom');
    expect(toErrorResponse(e)).toEqual({ error: 'boom', code: 'INTERNAL' });
  });
  it('preserves status for AppError', () => {
    const e = new AppError(503, 'EADDRINUSE', 'port 8080 in use');
    expect(toErrorResponse(e)).toEqual({ error: 'port 8080 in use', code: 'EADDRINUSE' });
  });
});

describe('statusFor', () => {
  it('returns status for AppError, 500 for others', () => {
    expect(statusFor(new AppError(404, 'NOT_FOUND', 'x'))).toBe(404);
    expect(statusFor(new Error('x'))).toBe(500);
  });
});
