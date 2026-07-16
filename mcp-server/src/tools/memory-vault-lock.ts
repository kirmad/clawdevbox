/**
 * tools/memory-vault-lock.ts
 *
 * Per-vault async mutex. JS is single-threaded but our git operations
 * spawn child processes; without this lock two concurrent write tools
 * could interleave `git add` / `git commit` and produce inconsistent
 * commits.
 */

const queues: Map<string, Promise<unknown>> = new Map();

export async function withVaultLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(vaultId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  // Chain `next` after `prev` so subsequent callers wait for our release.
  queues.set(vaultId, prev.then(() => next));
  try {
    await prev;
  } catch {
    // upstream error is the upstream caller's problem — we still proceed.
  }
  try {
    return await fn();
  } finally {
    release();
    // If no one queued behind us, clean up the map entry.
    if (queues.get(vaultId) === next) queues.delete(vaultId);
  }
}

/** Test helper: clear all queues. */
export function _resetVaultLocks(): void {
  queues.clear();
}
