/**
 * Typed error taxonomy for the JSON API surface.
 *
 * Endpoints throw AppError with a machine-readable code; sendError is the ONE
 * place that turns any thrown value into an HTTP response. Unknown errors are
 * logged server-side and returned as an opaque 500 — internal details (stack
 * traces, Firestore paths, upstream bodies) never reach the client.
 */
import type { Response } from 'express';
import { logger } from 'firebase-functions/v2';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'HL_UPSTREAM'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  HL_UPSTREAM: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Extra JSON fields for the response body (e.g. retryAfterSeconds). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export function sendError(res: Response, err: unknown): void {
  if (res.headersSent) return; // streaming responses handle their own errors
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    return;
  }
  logger.error('Unhandled error', { err: err instanceof Error ? err.stack : String(err) });
  res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
}
