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
  return { error: err?.message || 'internal error', code: 'INTERNAL' };
}

export function statusFor(err) {
  if (err instanceof AppError) return err.status;
  return 500;
}
