import { randomUUID } from 'node:crypto';

export interface DispatchPayload {
  status_text?: string;
  needs_user_input: boolean;
  task_complete: boolean;
  doneAt: number;
}

export interface DispatchResult extends Partial<DispatchPayload> {
  status: 'ok' | 'timeout';
}

interface Entry {
  instanceId: string;
  dispatchId: string;
  prompt: string;
  startedAt: number;
  resolve: (r: DispatchResult) => void;
  promise: Promise<DispatchResult>;
}

// Per-instance FIFO queue. queue[0] is the active (head) dispatch; the rest are
// pending. Synchronous head promotion on resolve prevents microtask-window races
// where a newcomer could leapfrog a queued entry.
const queues = new Map<string, Entry[]>();

function activeHead(instanceId: string): Entry | null {
  const q = queues.get(instanceId);
  return q && q.length > 0 ? q[0] : null;
}

export function registerPending(
  instanceId: string,
  prompt: string,
): { dispatchId: string; promise: Promise<DispatchResult> } {
  const dispatchId = randomUUID();
  let resolveFn!: (r: DispatchResult) => void;
  const promise = new Promise<DispatchResult>((res) => {
    resolveFn = res;
  });
  const entry: Entry = {
    instanceId,
    dispatchId,
    prompt,
    startedAt: Date.now(),
    resolve: resolveFn,
    promise,
  };

  const q = queues.get(instanceId);
  if (!q) {
    queues.set(instanceId, [entry]);
  } else {
    q.push(entry);
  }

  return { dispatchId, promise };
}

export function getPending(instanceId: string): Entry | null {
  return activeHead(instanceId);
}

export function hasPending(instanceId: string): boolean {
  return activeHead(instanceId) !== null;
}

function settleHead(instanceId: string, result: DispatchResult): void {
  const q = queues.get(instanceId);
  if (!q || q.length === 0) return;
  const head = q.shift()!;
  if (q.length === 0) queues.delete(instanceId);
  head.resolve(result);
}

export function resolvePending(
  instanceId: string,
  dispatchId: string,
  payload: DispatchPayload,
): void {
  const head = activeHead(instanceId);
  if (!head || head.dispatchId !== dispatchId) return;
  settleHead(instanceId, { status: 'ok', ...payload });
}

export function resolvePendingTimeout(instanceId: string): void {
  if (!activeHead(instanceId)) return;
  settleHead(instanceId, {
    status: 'timeout',
    needs_user_input: false,
    task_complete: false,
    doneAt: Date.now(),
  });
}

/** TEST-ONLY hatch: clear the registry. */
export function _resetForTests(): void {
  queues.clear();
}
