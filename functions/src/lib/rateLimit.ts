/**
 * Firestore-backed fixed-window rate limiter.
 *
 * One doc per (uid, action) under `rateLimits/`; a transaction increments the
 * counter for the current window. Serverless-safe (no in-memory state) and
 * cheap: one transactional read+write per guarded request. Fixed-window is a
 * deliberate simplicity trade-off — burst-at-boundary is acceptable for the
 * abuse cases this guards (LLM spend, outbound HL writes).
 */
import { db } from './admin.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Epoch millis when the current window resets. */
  resetAt: number;
}

export async function checkRateLimit(
  uid: string,
  action: string,
  limit: number,
  windowMs: number,
  // Injectable clock: window-rollover behavior is testable without mocking globals.
  now: () => number = Date.now,
): Promise<RateLimitResult> {
  const ref = db.collection('rateLimits').doc(`${uid}__${action}`);
  const ts = now();
  const windowStart = Math.floor(ts / windowMs) * windowMs;

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as { windowStart?: number; count?: number } | undefined;
    const count = data?.windowStart === windowStart ? (data.count ?? 0) : 0;

    if (count >= limit) {
      return { allowed: false, remaining: 0, resetAt: windowStart + windowMs };
    }
    tx.set(ref, { windowStart, count: count + 1, updatedAt: ts });
    return { allowed: true, remaining: limit - count - 1, resetAt: windowStart + windowMs };
  });
}
