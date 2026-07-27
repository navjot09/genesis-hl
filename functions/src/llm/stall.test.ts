import { describe, expect, it } from 'vitest';
import { nextWithStallTimeout } from './stall.js';

async function* healthy(): AsyncGenerator<string> {
  yield 'a';
  yield 'b';
}

async function* stallsAfterOne(): AsyncGenerator<string> {
  yield 'a';
  await new Promise(() => {}); // hangs forever without closing
}

describe('nextWithStallTimeout', () => {
  it('passes chunks through for a healthy stream', async () => {
    const it_ = healthy()[Symbol.asyncIterator]();
    const first = await nextWithStallTimeout(it_, 1000);
    expect(first).toEqual({ value: 'a', done: false });
    const second = await nextWithStallTimeout(it_, 1000);
    expect(second).toEqual({ value: 'b', done: false });
    const end = await nextWithStallTimeout(it_, 1000);
    expect(end).toMatchObject({ done: true });
  });

  it('detects a stream that stalls without closing', async () => {
    const it_ = stallsAfterOne()[Symbol.asyncIterator]();
    expect(await nextWithStallTimeout(it_, 1000)).toEqual({ value: 'a', done: false });
    const result = await nextWithStallTimeout(it_, 30); // stalls now
    expect(result).toBe('stalled');
  });

  it('a slow-but-alive chunk under the threshold is NOT a stall', async () => {
    async function* slow(): AsyncGenerator<string> {
      await new Promise((r) => setTimeout(r, 20));
      yield 'late';
    }
    const result = await nextWithStallTimeout(slow()[Symbol.asyncIterator](), 200);
    expect(result).toEqual({ value: 'late', done: false });
  });
});
