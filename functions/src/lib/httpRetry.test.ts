import { describe, expect, it } from 'vitest';
import { fetchWithTimeoutRetry } from './httpRetry.js';

const ok = () => new Response('{}', { status: 200 });
const status = (s: number) => new Response('{}', { status: s });

describe('fetchWithTimeoutRetry', () => {
  it('passes a success straight through', async () => {
    let calls = 0;
    const res = await fetchWithTimeoutRetry('https://x', {}, {
      timeoutMs: 1000,
      fetchImpl: async () => ((calls++, ok())),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('retries once after a network error, then succeeds', async () => {
    let calls = 0;
    const res = await fetchWithTimeoutRetry('https://x', {}, {
      timeoutMs: 1000,
      retries: 1,
      delayMs: 1,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw new TypeError('fetch failed');
        return ok();
      },
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('retries on listed statuses (503 then 200)', async () => {
    let calls = 0;
    const res = await fetchWithTimeoutRetry('https://x', {}, {
      timeoutMs: 1000,
      retries: 1,
      delayMs: 1,
      retryOnStatuses: [502, 503, 504],
      fetchImpl: async () => ((calls++, calls === 1 ? status(503) : ok())),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('does NOT retry unlisted statuses', async () => {
    let calls = 0;
    const res = await fetchWithTimeoutRetry('https://x', {}, {
      timeoutMs: 1000,
      retries: 1,
      retryOnStatuses: [503],
      fetchImpl: async () => ((calls++, status(400))),
    });
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
  });

  it('with retries=0 a network error propagates immediately', async () => {
    let calls = 0;
    await expect(
      fetchWithTimeoutRetry('https://x', {}, {
        timeoutMs: 1000,
        fetchImpl: async () => {
          calls++;
          throw new TypeError('fetch failed');
        },
      }),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);
  });

  it('aborts a hung request at the timeout', async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
        );
      });
    await expect(
      fetchWithTimeoutRetry('https://x', {}, { timeoutMs: 30, fetchImpl: hang }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
