/**
 * Stall detection for async streams: a provider stream that stops producing
 * chunks WITHOUT closing would otherwise park its awaiter until the platform
 * timeout, with the user staring at a frozen generation. Racing each next()
 * against a stall timer turns silence into a normal, resumable failure.
 */
export type StallResult<T> = IteratorResult<T> | 'stalled';

export async function nextWithStallTimeout<T>(
  iterator: AsyncIterator<T>,
  stallMs: number,
): Promise<StallResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<'stalled'>((resolve) => {
    timer = setTimeout(() => resolve('stalled'), stallMs);
  });
  try {
    return await Promise.race([iterator.next(), stall]);
  } finally {
    clearTimeout(timer);
  }
}
