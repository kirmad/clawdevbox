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
  /** Bytes of the prompt at registration time — kept only as a counter for
   *  diagnostics. We do NOT retain the prompt text itself because dispatched
   *  prompts can be large (multi-KB Teams-context prompts), and a backlog
   *  of pending dispatches would retain those bytes for up to the dispatcher
   *  timeout (~5 min). The dispatch consumer (`update-status`) only reads
   *  `dispatchId`. */
  promptBytes: number;
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
    promptBytes: typeof prompt === 'string' ? Buffer.byteLength(prompt, 'utf8') : 0,
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

/**
 * Diagnostics — total queued entries + total prompt bytes across all instances.
 * Used by /api/heap-status to surface backlog pressure.
 */
export function pendingDispatchStats(): {
  count: number;
  instances: number;
  totalPromptBytes: number;
  oldestAgeMs: number;
} {
  let count = 0;
  let totalPromptBytes = 0;
  let oldest = Date.now();
  for (const q of queues.values()) {
    count += q.length;
    for (const e of q) {
      totalPromptBytes += e.promptBytes;
      if (e.startedAt < oldest) oldest = e.startedAt;
    }
  }
  return {
    count,
    instances: queues.size,
    totalPromptBytes,
    oldestAgeMs: count > 0 ? Date.now() - oldest : 0,
  };
}

/** TEST-ONLY hatch: clear the registry. */
export function _resetForTests(): void {
  queues.clear();
}
