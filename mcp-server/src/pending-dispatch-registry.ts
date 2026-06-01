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

// Active head per instance. Queued (waiting) entries live only in chained .then()
// closures — they become the head when the prior entry's promise resolves.
const registry = new Map<string, Entry>();

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

  const prior = registry.get(instanceId);
  if (!prior) {
    // No active dispatch — install immediately.
    registry.set(instanceId, entry);
  } else {
    // Queue: become head only after prior resolves.
    prior.promise.then(() => {
      registry.set(instanceId, entry);
    });
  }

  // When this resolves, clear if still the head.
  promise.then(() => {
    const cur = registry.get(instanceId);
    if (cur && cur.dispatchId === dispatchId) registry.delete(instanceId);
  });

  return { dispatchId, promise };
}

export function getPending(instanceId: string): Entry | null {
  return registry.get(instanceId) ?? null;
}

export function hasPending(instanceId: string): boolean {
  return registry.has(instanceId);
}

export function resolvePending(
  instanceId: string,
  dispatchId: string,
  payload: DispatchPayload,
): void {
  const e = registry.get(instanceId);
  if (!e || e.dispatchId !== dispatchId) return;
  e.resolve({ status: 'ok', ...payload });
}

export function resolvePendingTimeout(instanceId: string): void {
  const e = registry.get(instanceId);
  if (!e) return;
  e.resolve({
    status: 'timeout',
    needs_user_input: false,
    task_complete: false,
    doneAt: Date.now(),
  });
}

/** TEST-ONLY hatch: clear the registry. */
export function _resetForTests(): void {
  registry.clear();
}
