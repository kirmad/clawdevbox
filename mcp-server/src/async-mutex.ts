/**
 * async-mutex.ts
 *
 * Minimal in-process keyed async mutex. Used by session.send to serialize
 * the `findLiveInstanceForSession → spawn/resume/dispatch` decision per
 * canonical session GUID, so concurrent same-alias calls can't both observe
 * "no live instance" and both spawn duplicate ptys.
 *
 * No external dependency. Same-process only.
 *
 * Memory: when a key's queue empties the Map entry is deleted, so long-lived
 * processes that touch many keys don't leak.
 */

type Resolver = () => void;
const queues = new Map<string, Resolver[]>();

export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let queue = queues.get(key);
  if (queue === undefined) {
    queue = [];
    queues.set(key, queue);
  } else {
    await new Promise<void>((resolve) => queue!.push(resolve));
  }
  try {
    return await fn();
  } finally {
    const q = queues.get(key);
    if (q !== undefined && q.length > 0) {
      const next = q.shift()!;
      next();
    } else {
      queues.delete(key);
    }
  }
}

/** Test hatch: number of WAITERS currently queued for `key` (excludes the holder). */
export function _internalQueueSize(key: string): number {
  return queues.get(key)?.length ?? 0;
}
