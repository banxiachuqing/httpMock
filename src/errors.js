export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function toErrorResponse(err) {
  if (err instanceof AppError) {
    return { error: err.message, code: err.code };
  }
  // body-parser 等中间件抛的错误自带 .status（400 坏 JSON / 413 超限 / 415 类型）
  if (typeof err?.status === 'number' && err.status >= 400 && err.status <= 599) {
    return { error: err.message || 'bad request', code: 'BAD_REQUEST' };
  }
  return { error: err?.message || 'internal error', code: 'INTERNAL' };
}

export function statusFor(err) {
  if (err instanceof AppError) return err.status;
  if (typeof err?.status === 'number' && err.status >= 400 && err.status <= 599) return err.status;
  return 500;
}
