/**
 * fetch with a hard timeout and bounded retry — for OUTBOUND upstream calls.
 *
 * Without a timeout, a hung upstream pins our request (and its function slot)
 * until the platform ceiling. Retries are OPT-IN and must only be used for
 * idempotent requests; the caller decides which statuses are retryable.
 */
export interface TimeoutRetryOptions {
  timeoutMs: number;
  /** Extra attempts after the first (0 = no retry). */
  retries?: number;
  /** Response statuses that trigger a retry (e.g. [502, 503, 504]). */
  retryOnStatuses?: number[];
  /** Delay between attempts. */
  delayMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithTimeoutRetry(
  url: string | URL,
  init: RequestInit,
  opts: TimeoutRetryOptions,
): Promise<Response> {
  const { timeoutMs, retries = 0, retryOnStatuses = [], delayMs = 250 } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0 && delayMs > 0) await sleep(delayMs);
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (retryOnStatuses.includes(res.status) && attempt < retries) continue;
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) continue;
      throw err;
    }
  }
  throw lastError; // unreachable, satisfies control-flow analysis
}
