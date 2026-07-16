# Session Kernel Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overlapping terminal/session/dispatch implementations with one deterministic session kernel that preserves exact prompts, prevents duplicate executions, survives restarts, drains cleanly, and has reliable Windows and Linux regression coverage.

**Architecture:** Introduce a canonical conversation/execution model, a single `SessionCoordinator`, a typed terminal backend, and a dispatch queue whose entries own their timers and lifecycle. Existing HTTP, MCP, terminal WebSocket, main-agent, and artifact-outbox surfaces become adapters over those services. Migrate incrementally behind compatibility wrappers, then remove the old registry and UI duplication after all callers use the new kernel.

**Tech Stack:** Node.js 22, TypeScript, better-sqlite3, node-pty, tmux/psmux, Vue 3, Pinia, xterm.js, Node test runner, Playwright.

---

## Baseline and constraints

- Baseline code is committed in `3d94387` and `9dc1016`.
- Preserve the existing HTTP and MCP response shapes until the compatibility-removal task.
- Windows with psmux is a first-class platform, not a best-effort compatibility target.
- Do not retry a prompt after transport acceptance unless the retry carries a durable idempotency key.
- A tmux probe failure is `unknown`, never equivalent to `dead`.
- Browser connection loss must not itself create a new agent process.
- Use test-driven development for every behavior change.
- Commit after every task. Do not combine tasks into one large commit.

## Target file structure

### New backend modules

- `mcp-server/src/session-kernel/types.ts`
  - Branded IDs, conversation/execution records, lifecycle states, probe results.
- `mcp-server/src/session-kernel/clock.ts`
  - Real and fake clocks used by queue and lifecycle tests.
- `mcp-server/src/session-kernel/dispatch-queue.ts`
  - FIFO ownership, per-dispatch timers, completion, failure, and promotion.
- `mcp-server/src/session-kernel/prompt-delivery.ts`
  - Exact prompt delivery and provider-aware commit strategy.
- `mcp-server/src/session-kernel/session-repository.ts`
  - SQLite access for canonical conversations and current executions.
- `mcp-server/src/session-kernel/terminal-backend.ts`
  - Backend interface and tri-state liveness contract.
- `mcp-server/src/session-kernel/tmux-backend.ts`
  - tmux/psmux implementation and shared asynchronous process monitor.
- `mcp-server/src/session-kernel/session-coordinator.ts`
  - Per-conversation single-flight spawn, adopt, resume, kill, resolve, and list.
- `mcp-server/src/session-kernel/session-spawner.ts`
  - Adapter from canonical conversations to `runRecipe` new/resume execution creation.
- `mcp-server/src/session-kernel/services.ts`
  - Dependency bundle injected into HTTP and MCP adapters.
- `mcp-server/src/lifecycle-controller.ts`
  - Ordered startup, readiness, reverse-order shutdown, and drain reporting.

### New frontend modules

- `mcp-server/web/src/terminal/terminal-connection-controller.ts`
  - Framework-independent WebSocket/xterm lifecycle state machine.
- `mcp-server/web/src/composables/useTerminalConnection.ts`
  - Vue adapter used by every terminal surface.

### New tests

- `mcp-server/tests/helpers/test-runtime.mjs`
- `mcp-server/tests/session-kernel/dispatch-queue.test.mjs`
- `mcp-server/tests/session-kernel/prompt-delivery.test.mjs`
- `mcp-server/tests/session-kernel/session-repository.test.mjs`
- `mcp-server/tests/session-kernel/tmux-backend.test.mjs`
- `mcp-server/tests/session-kernel/session-coordinator.test.mjs`
- `mcp-server/tests/session-kernel/lifecycle-controller.test.mjs`
- `mcp-server/tests/terminal-connection-controller.test.mjs`
- `mcp-server/tests/session-recovery.playwright.test.mjs`

---

### Task 1: Make the session regression suites deterministic

**Files:**
- Create: `mcp-server/tests/helpers/test-runtime.mjs`
- Modify: `mcp-server/tests/update-status-tool.test.mjs`
- Modify: `mcp-server/package.json`
- Modify: `mcp-server/tests/dispatcher.test.mjs`

- [ ] **Step 1: Add deterministic temporary-resource helpers**

Create `mcp-server/tests/helpers/test-runtime.mjs`:

```js
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function uniqueName(prefix) {
  return `${prefix}_${process.pid}_${randomUUID().slice(0, 8)}`;
}

export function tempRoot(prefix = 'clawdevbox-test-') {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

export async function withEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function isSettled(promise) {
  let settled = false;
  promise.finally(() => { settled = true; });
  await Promise.resolve();
  return settled;
}
```

- [ ] **Step 2: Repair the stale `update_status` tests**

Replace each obsolete context such as:

```js
{ db, instanceId: id }
```

with:

```js
{
  db,
  recipeInstanceId: id,
  cliSessionId: null,
}
```

For the DB persistence test, insert a row with both identifiers and call:

```js
await handleUpdateStatus(
  {
    db,
    recipeInstanceId: 'ri-status',
    cliSessionId: 'cli-status',
  },
  {
    status_text: 'making progress',
    needs_user_input: false,
    task_complete: false,
  },
);
```

- [ ] **Step 3: Run the repaired status tests**

Run:

```powershell
cd C:\git\clawdevbox\mcp-server
node --import tsx --test tests/update-status-tool.test.mjs
```

Expected: all tests pass with zero cancelled tests.

- [ ] **Step 4: Isolate dispatcher fixtures from process-global state**

Update `tests/dispatcher.test.mjs` so every test constructs its own temp root, database, dispatcher, and trigger IDs using `uniqueName()`. Register cleanup with `t.after()`:

```js
test('dispatcher: script binding success path writes stdout.txt + marks success', async (t) => {
  const root = tempRoot('cdb-dispatcher-');
  const db = open();
  const workspace = ensureWorkspace(db, { path: root.path });
  const triggerId = uniqueName('trigger');
  const ws = makeWs([{
    id: 'demo.mode-a',
    file: 'heartbeat-mode-a.ts',
    file_abs: join(FIXTURES, 'heartbeat-mode-a.ts'),
    runtime: 'tsx',
    source_plugin_id: 'demo',
    scope: 'plugin:demo',
  }]);
  insertTrigger(db, {
    id: triggerId,
    workspace_id: workspace.id,
    type: 'demo.mode-a',
  });
  const fireId = enqueueFireDirect(db, {
    workspace_id: workspace.id,
    trigger_id: triggerId,
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 2 });
  t.after(async () => {
    await dispatcher.stop();
    db.close();
    root.cleanup();
  });

  dispatcher.start();
  const completed = await waitFor(() => {
    const row = db.prepare(
      'SELECT status FROM fires WHERE fire_id = ?',
    ).get(fireId);
    return row?.status === 'success';
  });
  assert.equal(completed, true);
  const stdoutPath = join(
    root.path,
    '.clawdevbox',
    'fires',
    fireId,
    'attempt-1',
    'stdout.txt',
  );
  assert.equal(existsSync(stdoutPath), true);
});
```

- [ ] **Step 5: Add focused test scripts**

Add these scripts to `mcp-server/package.json`:

```json
{
  "test:sessions:unit": "node --import tsx --test --test-concurrency=1 tests/async-mutex.test.mjs tests/pending-dispatch-registry.test.mjs tests/update-status-tool.test.mjs",
  "test:sessions:integration": "node --import tsx --test --test-concurrency=1 tests/dispatcher.test.mjs tests/tools-session.test.mjs tests/api-sessions-list.test.mjs tests/api-sessions-resume.test.mjs",
  "test:sessions:tmux": "node --import tsx --test --test-concurrency=1 tests/cli-sessions/tmux-client.test.mjs tests/cli-sessions/tmux-session.test.mjs tests/cli-sessions/tmux-session-runtime.test.mjs tests/cli-sessions/tmux-session-registry.test.mjs",
  "test:sessions:e2e": "playwright test tests/terminal-viewer.playwright.test.mjs tests/terminals-panel-e2e.playwright.test.mjs tests/terminal-resize-after-panel.playwright.test.mjs tests/session-recovery.playwright.test.mjs"
}
```

- [ ] **Step 6: Verify combined isolation**

Run:

```powershell
cd C:\git\clawdevbox\mcp-server
npm run test:sessions:unit
npm run test:sessions:integration
```

Expected: both commands terminate without hanging and without the `"database connection is not open"` log.

- [ ] **Step 7: Commit**

```powershell
git add mcp-server/tests/helpers/test-runtime.mjs mcp-server/tests/update-status-tool.test.mjs mcp-server/tests/dispatcher.test.mjs mcp-server/package.json
git commit -m "test: isolate session and dispatcher regressions"
```

---

### Task 2: Add a dispatch queue that owns ordering and timers

**Files:**
- Create: `mcp-server/src/session-kernel/clock.ts`
- Create: `mcp-server/src/session-kernel/dispatch-queue.ts`
- Create: `mcp-server/tests/session-kernel/dispatch-queue.test.mjs`
- Modify: `mcp-server/src/pending-dispatch-registry.ts`

- [ ] **Step 1: Write failing queue-order and timer tests**

Create `tests/session-kernel/dispatch-queue.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DispatchQueue } from '../../src/session-kernel/dispatch-queue.ts';
import { FakeClock } from '../../src/session-kernel/clock.ts';

test('only the head dispatch receives the send turn', async () => {
  const clock = new FakeClock();
  const queue = new DispatchQueue({ clock, completionTimeoutMs: 300_000 });
  const first = queue.enqueue('ri-1', 10);
  const second = queue.enqueue('ri-1', 20);

  await first.turn;
  let secondReady = false;
  second.turn.then(() => { secondReady = true; });
  await Promise.resolve();
  assert.equal(secondReady, false);

  first.accept();
  first.complete({ task_complete: true, needs_user_input: false, doneAt: 1 });
  await second.turn;
  assert.equal(secondReady, true);
});

test('a completed dispatch timer cannot settle the next dispatch', async () => {
  const clock = new FakeClock();
  const queue = new DispatchQueue({ clock, completionTimeoutMs: 100 });
  const first = queue.enqueue('ri-1', 10);
  const second = queue.enqueue('ri-1', 20);

  await first.turn;
  first.accept();
  first.complete({ task_complete: true, needs_user_input: false, doneAt: 1 });
  clock.advanceBy(50);
  await second.turn;
  second.accept();

  let secondSettled = false;
  second.result.then(() => { secondSettled = true; });
  clock.advanceBy(50);
  await Promise.resolve();
  assert.equal(secondSettled, false);

  second.complete({ task_complete: true, needs_user_input: false, doneAt: 2 });
});

test('failure settles only the matching dispatch id', async () => {
  const clock = new FakeClock();
  const queue = new DispatchQueue({ clock, completionTimeoutMs: 100 });
  const first = queue.enqueue('ri-1', 10);
  const second = queue.enqueue('ri-1', 20);

  await first.turn;
  assert.equal(queue.fail('ri-1', second.id, 'wrong target'), false);
  assert.equal(queue.current('ri-1')?.id, first.id);
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run:

```powershell
node --import tsx --test tests/session-kernel/dispatch-queue.test.mjs
```

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Implement real and fake clocks**

Create `src/session-kernel/clock.ts`:

```ts
export interface TimerHandle {
  cancel(): void;
  unref(): void;
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const timer = globalThis.setTimeout(callback, delayMs);
    return {
      cancel: () => clearTimeout(timer),
      unref: () => timer.unref?.(),
    };
  }
}

interface FakeTimer {
  at: number;
  callback: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  private current = 0;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const timer: FakeTimer = {
      at: this.current + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    return {
      cancel: () => { timer.cancelled = true; },
      unref: () => {},
    };
  }

  advanceBy(ms: number): void {
    this.current += ms;
    const due = this.timers
      .filter((timer) => !timer.cancelled && timer.at <= this.current)
      .sort((a, b) => a.at - b.at);
    for (const timer of due) {
      timer.cancelled = true;
      timer.callback();
    }
  }
}
```

- [ ] **Step 4: Implement the queue**

Create `src/session-kernel/dispatch-queue.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { RealClock, type Clock, type TimerHandle } from './clock.ts';

export interface DispatchCompletion {
  status: 'ok' | 'failed' | 'timeout';
  status_text?: string;
  needs_user_input: boolean;
  task_complete: boolean;
  doneAt: number;
  error?: string;
}

interface Entry {
  id: string;
  instanceId: string;
  promptBytes: number;
  enqueuedAt: number;
  state: 'queued' | 'sending' | 'accepted';
  turnResolve: () => void;
  resultResolve: (result: DispatchCompletion) => void;
  turn: Promise<void>;
  result: Promise<DispatchCompletion>;
  timeout: TimerHandle | null;
}

export interface DispatchTicket {
  id: string;
  turn: Promise<void>;
  result: Promise<DispatchCompletion>;
  accept(): void;
  complete(payload: Omit<DispatchCompletion, 'status'>): void;
  fail(error: string): void;
}

export class DispatchQueue {
  private readonly queues = new Map<string, Entry[]>();
  private readonly clock: Clock;
  private readonly completionTimeoutMs: number;

  constructor(opts: { clock?: Clock; completionTimeoutMs: number }) {
    this.clock = opts.clock ?? new RealClock();
    this.completionTimeoutMs = opts.completionTimeoutMs;
  }

  enqueue(instanceId: string, promptBytes: number): DispatchTicket {
    let turnResolve!: () => void;
    let resultResolve!: (result: DispatchCompletion) => void;
    const entry: Entry = {
      id: randomUUID(),
      instanceId,
      promptBytes,
      enqueuedAt: this.clock.now(),
      state: 'queued',
      turn: new Promise<void>((resolve) => { turnResolve = resolve; }),
      result: new Promise<DispatchCompletion>((resolve) => { resultResolve = resolve; }),
      turnResolve,
      resultResolve,
      timeout: null,
    };

    const queue = this.queues.get(instanceId) ?? [];
    queue.push(entry);
    this.queues.set(instanceId, queue);
    if (queue.length === 1) this.activate(entry);

    return {
      id: entry.id,
      turn: entry.turn,
      result: entry.result,
      accept: () => this.accept(instanceId, entry.id),
      complete: (payload) => this.settle(instanceId, entry.id, { status: 'ok', ...payload }),
      fail: (error) => this.settle(instanceId, entry.id, {
        status: 'failed',
        error,
        needs_user_input: false,
        task_complete: false,
        doneAt: this.clock.now(),
      }),
    };
  }

  current(instanceId: string): { id: string; state: string } | null {
    const entry = this.queues.get(instanceId)?.[0];
    return entry ? { id: entry.id, state: entry.state } : null;
  }

  fail(instanceId: string, dispatchId: string, error: string): boolean {
    return this.settle(instanceId, dispatchId, {
      status: 'failed',
      error,
      needs_user_input: false,
      task_complete: false,
      doneAt: this.clock.now(),
    });
  }

  timeout(instanceId: string, dispatchId: string): boolean {
    return this.settle(instanceId, dispatchId, {
      status: 'timeout',
      needs_user_input: false,
      task_complete: false,
      doneAt: this.clock.now(),
    });
  }

  completeActive(
    instanceId: string,
    payload: Omit<DispatchCompletion, 'status'>,
  ): boolean {
    const current = this.queues.get(instanceId)?.[0];
    return current
      ? this.settle(instanceId, current.id, { status: 'ok', ...payload })
      : false;
  }

  private activate(entry: Entry): void {
    entry.state = 'sending';
    entry.turnResolve();
  }

  private accept(instanceId: string, dispatchId: string): void {
    const current = this.queues.get(instanceId)?.[0];
    if (!current || current.id !== dispatchId || current.state !== 'sending') return;
    current.state = 'accepted';
    current.timeout = this.clock.setTimeout(() => {
      this.settle(instanceId, dispatchId, {
        status: 'timeout',
        needs_user_input: false,
        task_complete: false,
        doneAt: this.clock.now(),
      });
    }, this.completionTimeoutMs);
    current.timeout.unref();
  }

  private settle(
    instanceId: string,
    dispatchId: string,
    result: DispatchCompletion,
  ): boolean {
    const queue = this.queues.get(instanceId);
    const current = queue?.[0];
    if (!queue || !current || current.id !== dispatchId) return false;

    current.timeout?.cancel();
    queue.shift();
    current.resultResolve(result);
    if (queue.length === 0) this.queues.delete(instanceId);
    else this.activate(queue[0]!);
    return true;
  }
}
```

- [ ] **Step 5: Run the queue tests**

Run:

```powershell
node --import tsx --test tests/session-kernel/dispatch-queue.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Turn the old registry into a compatibility adapter**

Update `src/pending-dispatch-registry.ts` to instantiate one `DispatchQueue` and delegate without keeping a second map:

```ts
const dispatchQueue = new DispatchQueue({
  completionTimeoutMs: 5 * 60 * 1000,
});

export function getDispatchQueue(): DispatchQueue {
  return dispatchQueue;
}

export function resolvePendingTimeout(
  instanceId: string,
  dispatchId: string,
): boolean {
  return dispatchQueue.timeout(instanceId, dispatchId);
}
```

Update every timeout/failure caller and `tests/pending-dispatch-registry.test.mjs` to pass the matching `dispatchId`. Do not retain an instance-only settlement API.

- [ ] **Step 7: Run old and new queue tests together**

Run:

```powershell
node --import tsx --test tests/pending-dispatch-registry.test.mjs tests/session-kernel/dispatch-queue.test.mjs
```

Expected: both suites pass.

- [ ] **Step 8: Commit**

```powershell
git add mcp-server/src/session-kernel mcp-server/src/pending-dispatch-registry.ts mcp-server/tests/session-kernel/dispatch-queue.test.mjs
git commit -m "refactor: give dispatch entries explicit lifecycle ownership"
```

---

### Task 3: Make dispatcher delivery single-send and result-correct

**Files:**
- Create: `mcp-server/tests/session-kernel/dispatcher-delivery.test.mjs`
- Modify: `mcp-server/src/session-kernel/types.ts`
- Modify: `mcp-server/src/dispatcher.ts`
- Modify: `mcp-server/src/tools/update-status.ts`
- Modify: `mcp-server/src/pending-dispatch-registry.ts`

- [ ] **Step 1: Write failing production-dispatch tests**

Create `tests/session-kernel/dispatcher-delivery.test.mjs` using a real `Dispatcher` with an injected fake delivery function. Add this harness:

```js
function createDispatcherHarness({ deliverPrompt }) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const workspace = {
    projectDir: 'C:/test',
    globalDir: 'C:/test/.global',
    agentCliProviders: new Map(),
  };
  const session = {
    name: 'cdb_ri-1',
    pid: async () => 1,
    exited: new Promise(() => {}),
    sendText: async () => {},
    sendKey: async () => {},
    resize: async () => {},
    snapshot: async () => '',
    kill: async () => {},
  };
  tmuxSessionRegistry.__register('ri-1', session);
  const dispatcher = new Dispatcher(db, workspace, {
    maxConcurrent: 1,
    deliverPrompt,
    dispatchQueue: new DispatchQueue({
      clock: new FakeClock(),
      completionTimeoutMs: 300_000,
    }),
  });
  return {
    db,
    dispatcher,
    close() {
      tmuxSessionRegistry.__unregister('ri-1');
      db.close();
    },
  };
}
```

Each test calls `t.after(() => harness.close())`.

Then add:

```js
test('transport rejection returns target_unavailable', async () => {
  const harness = createDispatcherHarness({
    deliverPrompt: async () => ({ status: 'unavailable', error: 'pane gone' }),
  });
  const result = await harness.dispatcher.dispatchToInstance('ri-1', 'hello');
  assert.deepEqual(result, { status: 'target_unavailable' });
});

test('accepted delivery is sent exactly once', async () => {
  let sends = 0;
  const harness = createDispatcherHarness({
    deliverPrompt: async () => {
      sends++;
      return { status: 'accepted' };
    },
  });
  const result = await harness.dispatcher.dispatchToInstance('ri-1', 'hello');
  assert.equal(result.status, 'ok');
  assert.equal(sends, 1);
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run:

```powershell
node --import tsx --test tests/session-kernel/dispatcher-delivery.test.mjs
```

Expected: FAIL because dispatcher does not yet accept the delivery dependency and currently reports success after callback failure.

- [ ] **Step 3: Add the delivery result type**

Add to `src/session-kernel/types.ts`:

```ts
export type PromptDeliveryResult =
  | { status: 'accepted' }
  | { status: 'unavailable'; error: string }
  | { status: 'unknown'; error: string };
```

- [ ] **Step 4: Inject queue and delivery dependencies into `Dispatcher`**

Extend `DispatcherOptions`:

```ts
dispatchQueue?: DispatchQueue;
deliverPrompt?: (
  instanceId: string,
  prompt: string,
) => Promise<PromptDeliveryResult>;
```

Store:

```ts
private readonly dispatchQueue: DispatchQueue;
private readonly deliverPromptFn: (
  instanceId: string,
  prompt: string,
) => Promise<PromptDeliveryResult>;
```

Initialize with production defaults in the constructor.

- [ ] **Step 5: Add a single-attempt production delivery function**

Add this method to `Dispatcher` as the temporary production implementation. Task 4 replaces its byte encoding with `deliverPromptExact`.

```ts
private async deliverPromptOnce(
  instanceId: string,
  prompt: string,
): Promise<PromptDeliveryResult> {
  const tmuxSession = tmuxSessionRegistry.get(instanceId);
  if (tmuxSession) {
    try {
      await tmuxSession.sendKey('Escape');
      await sleepP(200);
      await tmuxSession.sendText(prompt);
      await sleepP(250);
      await tmuxSession.sendKey('Enter');
      return { status: 'accepted' };
    } catch (error) {
      return {
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const { isSessionLive, writeToPty } = await import('./pty-registry.ts');
  if (!isSessionLive(instanceId)) {
    return { status: 'unavailable', error: 'session is not live' };
  }
  const accepted =
    writeToPty(instanceId, '\x1b') &&
    writeToPty(instanceId, prompt) &&
    writeToPty(instanceId, '\r');
  return accepted
    ? { status: 'accepted' }
    : { status: 'unavailable', error: 'pty rejected input' };
}
```

Set `deliverPromptFn` to the injected function or `this.deliverPromptOnce.bind(this)`.

- [ ] **Step 6: Replace `dispatchToInstance` with head-owned delivery**

Use this control flow:

```ts
const ticket = this.dispatchQueue.enqueue(
  instanceId,
  Buffer.byteLength(prompt, 'utf8'),
);
await ticket.turn;

const delivery = await this.deliverPromptFn(instanceId, prompt);
if (delivery.status !== 'accepted') {
  ticket.fail(delivery.error);
  return { status: 'target_unavailable' };
}

ticket.accept();
this.markInstanceWorking(instanceId);
return {
  status: 'ok',
  state: 'dispatched',
  dispatchId: ticket.id,
};
```

Delete the three-attempt blind resend loop and the independent five-minute `Promise.race`.

- [ ] **Step 7: Complete only the active accepted dispatch from `update_status`**

Replace `getPending()` plus `resolvePending()` in `tools/update-status.ts` with:

```ts
getDispatchQueue().completeActive(ctx.recipeInstanceId, {
  status_text: summary,
  needs_user_input,
  task_complete,
  doneAt: now,
});
```

Export `getDispatchQueue()` from the compatibility adapter in `pending-dispatch-registry.ts`. It must return the one process-wide queue created in Task 2.

- [ ] **Step 8: Run dispatcher and status tests**

Run:

```powershell
node --import tsx --test tests/session-kernel/dispatcher-delivery.test.mjs tests/update-status-tool.test.mjs tests/dispatcher-tmux.test.mjs
```

Expected: all tests pass and Node exits immediately instead of waiting five minutes for referenced timers.

- [ ] **Step 9: Commit**

```powershell
git add mcp-server/src/dispatcher.ts mcp-server/src/tools/update-status.ts mcp-server/src/pending-dispatch-registry.ts mcp-server/src/session-kernel mcp-server/tests/session-kernel/dispatcher-delivery.test.mjs
git commit -m "fix: make dispatch delivery ordered and result-correct"
```

---

### Task 4: Preserve exact prompts on tmux and psmux

**Files:**
- Create: `mcp-server/src/session-kernel/prompt-delivery.ts`
- Create: `mcp-server/tests/session-kernel/prompt-delivery.test.mjs`
- Modify: `mcp-server/src/cli-sessions/tmux-session.ts`
- Modify: `mcp-server/src/dispatcher.ts`
- Modify: `mcp-server/src/agent-clis/types.ts`

- [ ] **Step 1: Add failing exact-content tests**

Create `tests/session-kernel/prompt-delivery.test.mjs`:

```js
test('multiline prompt is preserved byte-for-byte', async () => {
  const session = fakeSession();
  const text = 'line one\n```json\n{"value": 1}\n```\nline five';
  await deliverPromptExact(session, text, 'Enter');
  assert.equal(session.insertedText, text);
  assert.deepEqual(session.keys, ['Enter']);
});

test('native Ctrl+Q is used only for short single-line prompts', async () => {
  assert.equal(selectCommitStrategy({
    queueMode: 'ctrl-q',
    prompt: 'short prompt',
  }), 'C-q');
  assert.equal(selectCommitStrategy({
    queueMode: 'ctrl-q',
    prompt: 'line one\nline two',
  }), 'Enter');
  assert.equal(selectCommitStrategy({
    queueMode: 'ctrl-q',
    prompt: 'x'.repeat(4097),
  }), 'Enter');
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run:

```powershell
node --import tsx --test tests/session-kernel/prompt-delivery.test.mjs tests/cli-sessions/tmux-session.test.mjs
```

Expected: the new suite fails to import and the existing multiline psmux test still fails.

- [ ] **Step 3: Replace `paste-buffer` with literal bracketed paste**

In `cli-sessions/tmux-session.ts`, add:

```ts
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const SEND_LITERAL_CHUNK = 2048;

async function sendBracketedPaste(
  sendLiteral: (text: string) => Promise<void>,
  text: string,
): Promise<void> {
  await sendLiteral(BRACKETED_PASTE_START);
  for (let offset = 0; offset < text.length; offset += SEND_LITERAL_CHUNK) {
    await sendLiteral(text.slice(offset, offset + SEND_LITERAL_CHUNK));
  }
  await sendLiteral(BRACKETED_PASTE_END);
}
```

Change `sendText`:

```ts
async sendText(text: string): Promise<void> {
  if (text.length === 0) return;
  if (text.includes('\n') || text.length > 4096) {
    await sendBracketedPaste(sendLiteral, text);
    return;
  }
  await sendLiteral(text);
}
```

Remove the tmux buffer creation/deletion path.

- [ ] **Step 4: Add provider-aware strategy selection**

Create `session-kernel/prompt-delivery.ts`:

```ts
import type { CliSession, SpecialKey } from '../cli-sessions/types.ts';
import type { PromptQueueMode } from '../agent-clis/types.ts';

export function selectCommitStrategy(args: {
  queueMode: PromptQueueMode;
  prompt: string;
}): Extract<SpecialKey, 'Enter' | 'C-q'> {
  const nativeQueueSafe =
    args.queueMode === 'ctrl-q' &&
    !args.prompt.includes('\n') &&
    args.prompt.length <= 4096;
  return nativeQueueSafe ? 'C-q' : 'Enter';
}

export async function deliverPromptExact(
  session: CliSession,
  prompt: string,
  commitKey: Extract<SpecialKey, 'Enter' | 'C-q'>,
): Promise<void> {
  await session.sendKey('Escape');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await session.sendText(prompt);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await session.sendKey(commitKey);
}
```

- [ ] **Step 5: Route dispatcher through the exact delivery helper**

For multiline/long prompts, wait for provider idle and commit with `Enter`. For short single-line Copilot prompts, commit with `C-q`. Delete newline flattening.

- [ ] **Step 6: Run Windows tmux contract tests**

Run:

```powershell
node --import tsx --test --test-concurrency=1 tests/session-kernel/prompt-delivery.test.mjs tests/cli-sessions/tmux-session.test.mjs
```

Expected: multiline content is visible in the pane on psmux and all tests pass.

- [ ] **Step 7: Run provider tests**

Run:

```powershell
node --import tsx --test tests/agent-clis.test.mjs tests/agent-clis-capabilities.test.mjs tests/session-kernel/dispatcher-delivery.test.mjs
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```powershell
git add mcp-server/src/session-kernel/prompt-delivery.ts mcp-server/src/cli-sessions/tmux-session.ts mcp-server/src/dispatcher.ts mcp-server/src/agent-clis/types.ts mcp-server/tests/session-kernel/prompt-delivery.test.mjs
git commit -m "fix: preserve exact prompts across tmux and psmux"
```

---

### Task 5: Add canonical conversations to the database

**Files:**
- Modify: `mcp-server/src/db/migrations.ts`
- Create: `mcp-server/src/session-kernel/types.ts`
- Create: `mcp-server/src/session-kernel/session-repository.ts`
- Create: `mcp-server/tests/session-kernel/session-repository.test.mjs`
- Modify: `mcp-server/tests/db-migrations.test.mjs`

- [ ] **Step 1: Write failing migration and repository tests**

Add:

```js
function createRepository() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  db.prepare(
    'INSERT INTO workspaces (id, path, created_at) VALUES (?, ?, ?)',
  ).run('ws-1', 'C:/ws-1', Date.now());
  db.prepare(
    'INSERT INTO workspaces (id, path, created_at) VALUES (?, ?, ?)',
  ).run('project', 'C:/project', Date.now());
  return createSessionRepository(db);
}
```

Test these invariants:

```js
test('one conversation has at most one current execution', () => {
  const repo = createRepository();
  repo.upsertConversation({
    sessionId: 'cli-1',
    kind: 'adhoc',
    workspaceId: 'ws-1',
    providerId: 'copilot',
  });
  repo.bindCurrentExecution('cli-1', 'ri-1');
  repo.bindCurrentExecution('cli-1', 'ri-2');
  assert.equal(repo.getConversation('cli-1').currentInstanceId, 'ri-2');
});

test('main agent is represented as a normal conversation', () => {
  const repo = createRepository();
  const row = repo.upsertConversation({
    sessionId: 'main-cli-id',
    kind: 'main',
    workspaceId: 'project',
    providerId: 'copilot',
  });
  assert.equal(row.kind, 'main');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
node --import tsx --test tests/session-kernel/session-repository.test.mjs tests/db-migrations.test.mjs
```

Expected: FAIL because migration 13 and repository do not exist.

- [ ] **Step 3: Add migration 13**

Append:

```ts
{
  version: 13,
  up: (db) => {
    db.exec(`
      ALTER TABLE agent_sessions ADD COLUMN instance_id TEXT;
      UPDATE agent_sessions
         SET instance_id = CASE
           WHEN interactive = 1 AND recipe_instance_id IS NOT NULL
             THEN recipe_instance_id
           ELSE id
         END;
      CREATE INDEX idx_agent_sessions_instance_id
        ON agent_sessions(instance_id, started_at DESC);

      CREATE TABLE session_conversations (
        session_id          TEXT PRIMARY KEY,
        kind                TEXT NOT NULL
                              CHECK(kind IN ('main','recipe','adhoc')),
        workspace_id        TEXT NOT NULL
                              REFERENCES workspaces(id) ON DELETE CASCADE,
        provider_id         TEXT NOT NULL,
        current_instance_id TEXT,
        state               TEXT NOT NULL DEFAULT 'inactive'
                              CHECK(state IN (
                                'inactive','starting','live','stopping',
                                'exited','recovering','unknown'
                              )),
        version             INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_session_conversations_current_instance
        ON session_conversations(current_instance_id)
        WHERE current_instance_id IS NOT NULL;
      CREATE INDEX idx_session_conversations_workspace
        ON session_conversations(workspace_id, updated_at DESC);

      WITH ranked AS (
        SELECT
          s.cli_session_id AS session_id,
          CASE
            WHEN ri.recipe_id LIKE '__adhoc_%' THEN 'adhoc'
            ELSE 'recipe'
          END AS kind,
          s.workspace_id,
          s.agent_cli AS provider_id,
          s.instance_id,
          s.status,
          s.started_at,
          COALESCE(s.ended_at, s.started_at) AS updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY s.cli_session_id
            ORDER BY s.started_at DESC
          ) AS row_number,
          MIN(s.started_at) OVER (
            PARTITION BY s.cli_session_id
          ) AS created_at
        FROM agent_sessions s
        LEFT JOIN recipe_instances ri ON ri.id = s.recipe_instance_id
        WHERE s.cli_session_id IS NOT NULL
      )
      INSERT OR IGNORE INTO session_conversations (
        session_id, kind, workspace_id, provider_id, current_instance_id,
        state, created_at, updated_at
      )
      SELECT
        session_id,
        kind,
        workspace_id,
        provider_id,
        instance_id,
        CASE WHEN status = 'running' THEN 'live' ELSE 'inactive' END,
        created_at,
        updated_at
      FROM ranked
      WHERE row_number = 1;
    `);
  },
},
```

- [ ] **Step 4: Define branded IDs and records**

In `session-kernel/types.ts`:

```ts
export type ConversationId = string & { readonly __brand: 'ConversationId' };
export type ExecutionId = string & { readonly __brand: 'ExecutionId' };

export type ConversationKind = 'main' | 'recipe' | 'adhoc';
export type ConversationState =
  | 'inactive'
  | 'starting'
  | 'live'
  | 'stopping'
  | 'exited'
  | 'recovering'
  | 'unknown';

export interface ConversationRecord {
  sessionId: ConversationId;
  kind: ConversationKind;
  workspaceId: string;
  providerId: string;
  currentInstanceId: ExecutionId | null;
  state: ConversationState;
  version: number;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 5: Implement repository methods**

`session-repository.ts` must expose:

```ts
export interface SessionRepository {
  getConversation(sessionId: string): ConversationRecord | null;
  findConversationByInstance(instanceId: string): ConversationRecord | null;
  upsertConversation(input: {
    sessionId: string;
    kind: ConversationKind;
    workspaceId: string;
    providerId: string;
  }): ConversationRecord;
  bindCurrentExecution(sessionId: string, instanceId: string): ConversationRecord;
  setState(sessionId: string, state: ConversationState): ConversationRecord;
  listByWorkspace(workspaceId: string): ConversationRecord[];
}
```

Use SQLite transactions and increment `version` on every state-changing update. `setState` preserves `current_instance_id`; that column records the latest embodiment even after it exits, which gives `ensureLive` a deterministic resume target.

Update `openSession` in `db/agent-sessions-store.ts` to require or mint an `instance_id`, persist it, and return it in `AgentSessionRow`.

- [ ] **Step 6: Run repository and migration tests**

Run:

```powershell
node --import tsx --test tests/session-kernel/session-repository.test.mjs tests/db-migrations.test.mjs tests/db-migrations-v5.test.mjs
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```powershell
git add mcp-server/src/db/migrations.ts mcp-server/src/session-kernel/types.ts mcp-server/src/session-kernel/session-repository.ts mcp-server/tests/session-kernel/session-repository.test.mjs mcp-server/tests/db-migrations.test.mjs
git commit -m "feat: add canonical session conversation records"
```

---

### Task 6: Introduce a tri-state terminal backend

**Files:**
- Create: `mcp-server/src/session-kernel/terminal-backend.ts`
- Create: `mcp-server/src/session-kernel/tmux-backend.ts`
- Create: `mcp-server/tests/session-kernel/tmux-backend.test.mjs`
- Modify: `mcp-server/src/cli-sessions/tmux-session-runtime.ts`
- Modify: `mcp-server/src/live-instance-resolver.ts`

- [ ] **Step 1: Write failing tri-state tests**

```js
test('nonzero tmux exit is unavailable, not an empty live set', async () => {
  const backend = createTmuxBackend({
    run: async () => ({ exitCode: 1, stdout: '', stderr: 'server unavailable' }),
  });
  assert.deepEqual(await backend.probeAll(), {
    status: 'unavailable',
    error: 'server unavailable',
  });
});

test('an empty successful list is authoritative absence', async () => {
  const backend = createTmuxBackend({
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  assert.deepEqual(await backend.probeAll(), {
    status: 'available',
    sessions: [],
  });
});
```

- [ ] **Step 2: Add the backend contract**

Create `terminal-backend.ts`:

```ts
import type { CliSession, CliSessionSpawnOpts } from '../cli-sessions/types.ts';

export type RuntimeProbe =
  | { status: 'live'; sessionName: string }
  | { status: 'absent' }
  | { status: 'unavailable'; error: string };

export type RuntimeListProbe =
  | { status: 'available'; sessions: string[] }
  | { status: 'unavailable'; error: string };

export interface TerminalBackend {
  spawn(opts: CliSessionSpawnOpts): Promise<CliSession>;
  attach(instanceId: string): Promise<CliSession | null>;
  probe(instanceId: string): Promise<RuntimeProbe>;
  probeAll(): Promise<RuntimeListProbe>;
  kill(instanceId: string): Promise<boolean>;
}
```

- [ ] **Step 3: Implement `TmuxBackend`**

Use `tmuxRunAsync`. Return `unavailable` for non-zero `list-sessions` except the known no-server messages:

```ts
const noServer = /no server running|no sessions|failed to connect/i;
if (result.exitCode !== 0 && noServer.test(result.stderr)) {
  return { status: 'available', sessions: [] };
}
if (result.exitCode !== 0) {
  return {
    status: 'unavailable',
    error: result.stderr.trim() || `tmux exited ${result.exitCode}`,
  };
}
```

- [ ] **Step 4: Stop `CliSessionRuntime.list()` from hiding failures**

Change the method to throw on unexpected non-zero exits. Existing compatibility callers may catch and degrade, but reconciliation must not receive a false empty list.

- [ ] **Step 5: Update live-instance resolution**

Change `resolveLiveInstanceForSession` to return:

```ts
export type LiveResolution =
  | { status: 'live'; instanceId: string }
  | { status: 'absent' }
  | { status: 'unknown'; error: string };
```

Do not update DB state when status is `unknown`.

- [ ] **Step 6: Run backend tests**

Run:

```powershell
node --import tsx --test tests/session-kernel/tmux-backend.test.mjs tests/cli-sessions/tmux-session-runtime.test.mjs
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```powershell
git add mcp-server/src/session-kernel/terminal-backend.ts mcp-server/src/session-kernel/tmux-backend.ts mcp-server/src/cli-sessions/tmux-session-runtime.ts mcp-server/src/live-instance-resolver.ts mcp-server/tests/session-kernel/tmux-backend.test.mjs
git commit -m "refactor: distinguish dead sessions from unavailable tmux"
```

---

### Task 7: Replace per-session synchronous exit polling with one monitor

**Files:**
- Modify: `mcp-server/src/session-kernel/tmux-backend.ts`
- Modify: `mcp-server/src/cli-sessions/tmux-session.ts`
- Create: `mcp-server/tests/session-kernel/tmux-monitor.test.mjs`

- [ ] **Step 1: Write monitor tests with a fake clock**

At the top of the test file, add:

```js
function createMonitorHarness(initialLive) {
  let live = [...initialLive];
  const backend = {
    probeAll: async () => ({ status: 'available', sessions: [...live] }),
  };
  const monitor = new TmuxMonitor(backend, 1000);
  monitor.setLive = (next) => { live = [...next]; };
  return monitor;
}

function createUnavailableMonitorHarness() {
  return new TmuxMonitor({
    probeAll: async () => ({
      status: 'unavailable',
      error: 'tmux unavailable',
    }),
  }, 1000);
}
```

Then add:

```js
test('one probe resolves exits for multiple watched sessions', async () => {
  const monitor = createMonitorHarness(['cdb-a', 'cdb-b']);
  const a = monitor.watch('cdb-a');
  const b = monitor.watch('cdb-b');

  monitor.setLive(['cdb-b']);
  await monitor.tick();

  assert.deepEqual(await a, { exitCode: null });
  assert.equal(monitor.isWatching('cdb-b'), true);
  void b;
});

test('probe unavailable does not resolve any exit', async () => {
  const monitor = createUnavailableMonitorHarness();
  const exit = monitor.watch('cdb-a');
  await monitor.tick();
  assert.equal(await isSettled(exit), false);
});
```

- [ ] **Step 2: Implement one asynchronous monitor**

Inside `tmux-backend.ts`, add `TmuxMonitor` with:

```ts
interface WatchedSession {
  resolve: (exit: { exitCode: number | null }) => void;
}

export class TmuxMonitor {
  private readonly watched = new Map<string, WatchedSession>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly backend: TerminalBackend,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isWatching(sessionName: string): boolean {
    return this.watched.has(sessionName);
  }

  watch(sessionName: string): Promise<{ exitCode: number | null }> {
    return new Promise((resolve) => {
      this.watched.set(sessionName, { resolve });
    });
  }

  async tick(): Promise<void> {
    if (this.running || this.watched.size === 0) return;
    this.running = true;
    try {
      const probe = await this.backend.probeAll();
      if (probe.status === 'unavailable') return;
      const live = new Set(probe.sessions);
      for (const [name, watcher] of this.watched) {
        if (live.has(name)) continue;
        this.watched.delete(name);
        watcher.resolve({ exitCode: null });
      }
    } finally {
      this.running = false;
    }
  }
}
```

Start one unreferenced timer for the monitor, not one process per session.

- [ ] **Step 3: Remove the `spawnSync` 500 ms loop**

In `tmux-session.ts`, construct `exited` from `TmuxMonitor.watch(sessionName)`. Keep explicit `kill()` resolution idempotent.

- [ ] **Step 4: Run monitor and tmux tests**

Run:

```powershell
node --import tsx --test --test-concurrency=1 tests/session-kernel/tmux-monitor.test.mjs tests/cli-sessions/tmux-session.test.mjs tests/cli-sessions/tmux-session-runtime.test.mjs
```

Expected: all pass; no test leaves recurring child-process polling behind.

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/src/session-kernel/tmux-backend.ts mcp-server/src/cli-sessions/tmux-session.ts mcp-server/tests/session-kernel/tmux-monitor.test.mjs
git commit -m "perf: monitor tmux sessions with one async probe loop"
```

---

### Task 8: Add `SessionCoordinator` and make resume single-flight

**Files:**
- Create: `mcp-server/src/session-kernel/session-coordinator.ts`
- Create: `mcp-server/src/session-kernel/session-spawner.ts`
- Create: `mcp-server/src/session-kernel/services.ts`
- Create: `mcp-server/tests/session-kernel/session-coordinator.test.mjs`
- Modify: `mcp-server/src/async-mutex.ts`

- [ ] **Step 1: Write concurrent ensure-live tests**

Add this harness in the test file:

```js
function createCoordinatorHarness(overrides = {}) {
  const conversation = {
    sessionId: 'cli-1',
    kind: 'adhoc',
    workspaceId: 'ws-1',
    providerId: 'copilot',
    currentInstanceId: null,
    state: 'inactive',
    version: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const repository = {
    getConversation: () => ({ ...conversation }),
    setState: (_id, state) => {
      conversation.state = state;
      return { ...conversation };
    },
    bindCurrentExecution: (_id, instanceId) => {
      conversation.currentInstanceId = instanceId;
      conversation.state = 'live';
      return { ...conversation };
    },
  };
  const backend = {
    probe: overrides.probe ?? (async () => (
      conversation.state === 'live' && conversation.currentInstanceId
        ? { status: 'live', sessionName: `cdb_${conversation.currentInstanceId}` }
        : { status: 'absent' }
    )),
  };
  const spawner = {
    spawnNew: overrides.spawn ?? (async () => ({ instanceId: 'ri-new' })),
    resume: overrides.spawn ?? (async () => ({ instanceId: 'ri-new' })),
  };
  return createSessionCoordinator({ repository, backend, spawner });
}
```

```js
test('two concurrent ensureLive calls spawn exactly once', async () => {
  let spawns = 0;
  const coordinator = createCoordinatorHarness({
    spawn: async () => {
      spawns++;
      await Promise.resolve();
      return { instanceId: 'ri-new' };
    },
  });

  const [a, b] = await Promise.all([
    coordinator.ensureLive('cli-1'),
    coordinator.ensureLive('cli-1'),
  ]);

  assert.equal(spawns, 1);
  assert.equal(a.instanceId, 'ri-new');
  assert.equal(b.instanceId, 'ri-new');
});

test('unknown runtime state never spawns', async () => {
  const coordinator = createCoordinatorHarness({
    probe: async () => ({ status: 'unavailable', error: 'psmux busy' }),
  });
  const result = await coordinator.ensureLive('cli-1');
  assert.deepEqual(result, {
    status: 'unknown',
    error: 'psmux busy',
  });
});
```

- [ ] **Step 2: Define coordinator dependencies**

```ts
export interface SessionSpawner {
  spawnNew(conversation: ConversationRecord): Promise<{ instanceId: string }>;
  resume(conversation: ConversationRecord): Promise<{ instanceId: string }>;
}

export type EnsureLiveResult =
  | { status: 'live'; instanceId: string; reused: boolean }
  | { status: 'not_found' }
  | { status: 'unknown'; error: string };

export interface SessionCoordinator {
  ensureLive(sessionId: string): Promise<EnsureLiveResult>;
  resolveLive(sessionId: string): Promise<EnsureLiveResult>;
  kill(sessionId: string): Promise<boolean>;
}
```

Implement `session-spawner.ts` as the only module that calls `runRecipe` for session recovery:

```ts
export function createRecipeSessionSpawner(args: {
  db: Database;
  workspace: Workspace;
  config: ResolvedConfig;
}): SessionSpawner {
  const execute = async (
    conversation: ConversationRecord,
    resume: boolean,
  ): Promise<{ instanceId: string }> => {
    const workspaceRow = args.db.prepare(
      'SELECT id, path FROM workspaces WHERE id = ?',
    ).get(conversation.workspaceId) as { id: string; path: string } | undefined;
    if (!workspaceRow) {
      throw new Error(`workspace not found: ${conversation.workspaceId}`);
    }
    const result = await runRecipe({
      recipeId: null,
      recipeSnapshot: '',
      isAdhoc: conversation.kind === 'adhoc',
      prompt: '',
      spawnMode: 'interactive',
      sessionId: conversation.sessionId,
      resumeOf: resume ? conversation.sessionId : undefined,
      workspaceInfo: workspaceRow,
      agentCli: conversation.providerId,
      workspacesRoot: resolveWorkspacesRoot(),
      ws: args.workspace,
      cfg: args.config,
    });
    if (result.spawn_error) {
      throw new Error(`${result.spawn_error.code}: ${result.spawn_error.message}`);
    }
    return { instanceId: result.recipe_instance_id };
  };

  return {
    spawnNew: (conversation) => execute(conversation, false),
    resume: (conversation) => execute(conversation, true),
  };
}
```

- [ ] **Step 3: Implement the lock around the full decision**

Add this private resolver:

```ts
private async resolveCurrentExecution(
  conversation: ConversationRecord,
): Promise<
  | { status: 'live'; instanceId: string; reused: true }
  | { status: 'absent' }
  | { status: 'unknown'; error: string }
> {
  if (!conversation.currentInstanceId) return { status: 'absent' };
  const probe = await this.backend.probe(conversation.currentInstanceId);
  if (probe.status === 'live') {
    return {
      status: 'live',
      instanceId: conversation.currentInstanceId,
      reused: true,
    };
  }
  if (probe.status === 'unavailable') {
    return { status: 'unknown', error: probe.error };
  }
  return { status: 'absent' };
}
```

```ts
async ensureLive(sessionId: string): Promise<EnsureLiveResult> {
  return withKeyedLock(`session.ensure:${sessionId}`, async () => {
    const conversation = this.repository.getConversation(sessionId);
    if (!conversation) return { status: 'not_found' };

    const resolution = await this.resolveCurrentExecution(conversation);
    if (resolution.status === 'live') return resolution;
    if (resolution.status === 'unknown') return resolution;

    this.repository.setState(sessionId, 'starting');
    try {
      const spawned = conversation.currentInstanceId
        ? await this.spawner.resume(conversation)
        : await this.spawner.spawnNew(conversation);
      this.repository.bindCurrentExecution(sessionId, spawned.instanceId);
      return { status: 'live', instanceId: spawned.instanceId, reused: false };
    } catch (error) {
      this.repository.setState(sessionId, 'inactive');
      throw error;
    }
  });
}
```

- [ ] **Step 4: Add a `SessionServices` composition type**

```ts
export interface SessionServices {
  repository: SessionRepository;
  backend: TerminalBackend;
  coordinator: SessionCoordinator;
  dispatchQueue: DispatchQueue;
}
```

Export a concrete factory:

```ts
export function createSessionServices(args: {
  db: Database;
  workspace: Workspace;
  config: ResolvedConfig;
  backend: TerminalBackend;
  spawner: SessionSpawner;
}): SessionServices {
  const repository = createSessionRepository(args.db);
  const dispatchQueue = new DispatchQueue({
    completionTimeoutMs: 5 * 60 * 1000,
  });
  const coordinator = createSessionCoordinator({
    repository,
    backend: args.backend,
    spawner: args.spawner,
  });
  return {
    repository,
    backend: args.backend,
    coordinator,
    dispatchQueue,
  };
}
```

- [ ] **Step 5: Run coordinator tests**

Run:

```powershell
node --import tsx --test tests/session-kernel/session-coordinator.test.mjs
```

Expected: all pass, including five concurrent callers producing one spawn.

- [ ] **Step 6: Commit**

```powershell
git add mcp-server/src/session-kernel/session-coordinator.ts mcp-server/src/session-kernel/session-spawner.ts mcp-server/src/session-kernel/services.ts mcp-server/src/async-mutex.ts mcp-server/tests/session-kernel/session-coordinator.test.mjs
git commit -m "feat: serialize session recovery through one coordinator"
```

---

### Task 9: Route HTTP, MCP, terminal attachment, and outbox through the coordinator

**Files:**
- Modify: `mcp-server/src/session-helpers.ts`
- Modify: `mcp-server/src/cli/cron-api.ts`
- Modify: `mcp-server/src/terminal-server.ts`
- Modify: `mcp-server/src/tools/session.ts`
- Modify: `mcp-server/src/server.ts`
- Modify: `mcp-server/src/artifact-outbox-worker.ts`
- Modify: `mcp-server/src/cli/start.ts`
- Modify: `mcp-server/tests/api-sessions-resume.test.mjs`
- Create: `mcp-server/tests/session-kernel/session-adapters.test.mjs`

- [ ] **Step 1: Add an HTTP concurrency regression**

Add to `api-sessions-resume.test.mjs`:

```js
function makeDelayedStubRunRecipe() {
  const calls = [];
  return {
    calls,
    async fn(opts) {
      calls.push(opts);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        recipe_instance_id: 'ri-resumed-once',
        session_id: opts.resumeOf,
        workspace_id: opts.workspaceInfo.id,
        workspace_path: opts.workspaceInfo.path,
        status: 'spawned',
        spawn_error: null,
      };
    },
  };
}

test('two concurrent resume requests reuse one spawned instance', async () => {
  const stub = makeDelayedStubRunRecipe();
  const [a, b] = await Promise.all([
    fetch(`${base}/api/sessions/ri_old/resume`, { method: 'POST' }).then((r) => r.json()),
    fetch(`${base}/api/sessions/ri_old/resume`, { method: 'POST' }).then((r) => r.json()),
  ]);
  assert.equal(stub.calls.length, 1);
  assert.equal(a.new_instance_id, b.new_instance_id);
});
```

- [ ] **Step 2: Reorder startup so services exist before server registration**

In `cli/start.ts`:

```ts
const sessionServices = createSessionServices({
  db: opened.db,
  workspace: ws,
  config: cfg,
  backend: createTmuxBackend(tmuxClient),
  spawner: createRecipeSessionSpawner({
    db: opened.db,
    workspace: ws,
    config: cfg,
  }),
});

const { hostedErrors } = await buildServer(ws, sessionServices);
```

Remove `globalThis.__clawdevboxSessionHelperCtx`.

- [ ] **Step 3: Inject services into MCP registration**

Change:

```ts
registerSessionEntries(ws)
```

to:

```ts
registerSessionEntries(ws, services)
```

Handlers call `services.coordinator`, repository, and queue directly.

- [ ] **Step 4: Replace the resume route body**

The HTTP route becomes:

```ts
const conversation =
  ctx.sessionServices.repository.findConversationByInstance(instanceId);
if (!conversation) {
  sendJson(res, 404, { error: 'session not found' });
  return true;
}
const result =
  await ctx.sessionServices.coordinator.ensureLive(conversation.sessionId);
if (result.status === 'unknown') {
  sendJson(res, 503, { error: result.error, code: 'RUNTIME_UNAVAILABLE' });
  return true;
}
if (result.status !== 'live') {
  sendJson(res, 422, { error: result.status });
  return true;
}
sendJson(res, 200, {
  ok: true,
  new_instance_id: result.instanceId,
  session_id: conversation.sessionId,
  reused: result.reused,
});
```

Delete the duplicated provider fallback and direct `runRecipe` block from this route; the spawner dependency owns it.

- [ ] **Step 5: Route terminal attachment through coordinator resolution**

Before archived fallback, call `coordinator.resolveLive(sessionId)`. Send an initial protocol message:

```ts
ws.send(JSON.stringify({
  type: 'hello',
  requestedInstanceId: instanceId,
  resolvedInstanceId,
  sessionId,
  state: 'live',
}));
```

- [ ] **Step 6: Route outbox delivery through coordinator plus dispatcher**

The worker must:

```ts
const live = await ctx.coordinator.ensureLive(row.session_id);
if (live.status === 'unknown') {
  return { ok: false, message: `RUNTIME_UNAVAILABLE: ${live.error}` };
}
if (live.status !== 'live') {
  return { ok: false, message: 'SESSION_NOT_FOUND' };
}
const dispatch = await ctx.dispatcher.dispatchToInstance(live.instanceId, row.prompt);
```

Do not call `spawnDispatchOrResume`.

- [ ] **Step 7: Run adapter tests**

Run:

```powershell
node --import tsx --test tests/session-kernel/session-adapters.test.mjs tests/api-sessions-resume.test.mjs tests/tools-session.test.mjs tests/artifact-outbox.test.mjs
```

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add mcp-server/src/session-helpers.ts mcp-server/src/cli/cron-api.ts mcp-server/src/terminal-server.ts mcp-server/src/tools/session.ts mcp-server/src/server.ts mcp-server/src/artifact-outbox-worker.ts mcp-server/src/cli/start.ts mcp-server/tests
git commit -m "refactor: route session surfaces through the coordinator"
```

---

### Task 10: Make the main agent a first-class conversation

**Files:**
- Modify: `mcp-server/src/main-agent.ts`
- Modify: `mcp-server/src/tools/update-status.ts`
- Modify: `mcp-server/src/session-helpers.ts`
- Create: `mcp-server/tests/main-agent-session-kernel.test.mjs`

- [ ] **Step 1: Write main-agent idempotency tests**

Add:

```js
function createMainAgentHarness() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  db.prepare(
    'INSERT INTO workspaces (id, path, created_at) VALUES (?, ?, ?)',
  ).run('project', 'C:/project', Date.now());

  const workspace = {
    projectDir: 'C:/project',
    globalDir: 'C:/global',
    agentCliProviders: new Map(),
  };
  const config = {
    projectDir: 'C:/project',
    globalDir: 'C:/global',
    workspacesRoot: 'C:/workspaces',
    defaultAgentCli: 'copilot',
    http: { host: '127.0.0.1', port: 5201, token: null },
    tmux: { socket: null },
    vaults: [],
  };
  const liveInstances = new Set();
  const backend = {
    async probe(instanceId) {
      return liveInstances.has(instanceId)
        ? { status: 'live', sessionName: `cdb_${instanceId}` }
        : { status: 'absent' };
    },
  };

  let spawnCalls = 0;
  const spawn = async (conversation) => {
    spawnCalls++;
    const instanceId = `main-exec-${spawnCalls}`;
    openSession(db, {
      instance_id: instanceId,
      workspace_id: conversation.workspaceId,
      agent_cli: conversation.providerId,
      cli_session_id: conversation.sessionId,
      interactive: true,
    });
    liveInstances.add(instanceId);
    return { instanceId };
  };
  const services = createSessionServices({
    db,
    workspace,
    config,
    backend,
    spawner: {
      spawnNew: spawn,
      resume: spawn,
    },
  });

  return {
    db,
    get spawnCalls() { return spawnCalls; },
    start: () => startMainAgent({
      workspace,
      cfg: config,
      services,
    }),
    updateStatus: (sessionId, status) => handleUpdateStatus({
      db,
      recipeInstanceId: services.repository
        .getConversation(sessionId)?.currentInstanceId ?? null,
      cliSessionId: sessionId,
    }, {
      status,
      task_complete: false,
      needs_user_input: false,
    }),
  };
}
```

```js
test('startMainAgent called twice uses one execution', async () => {
  const harness = createMainAgentHarness();
  await harness.start();
  await harness.start();
  assert.equal(harness.spawnCalls, 1);
});

test('main update_status persists through the normal repository', async () => {
  const harness = createMainAgentHarness();
  const status = await harness.start();
  await harness.updateStatus(status.sessionId, 'working');
  assert.equal(
    harness.db.prepare(
      'SELECT status_text FROM agent_sessions WHERE cli_session_id = ? AND ended_at IS NULL',
    ).get(status.sessionId).status_text,
    'working',
  );
});
```

- [ ] **Step 2: Register the main conversation before spawning**

```ts
const conversation = services.repository.upsertConversation({
  sessionId,
  kind: 'main',
  workspaceId: 'project',
  providerId,
});
const live = await services.coordinator.ensureLive(conversation.sessionId);
```

- [ ] **Step 3: Remove pty-only idempotence**

Delete the initial `hasSession('main')` decision and use coordinator state. Keep `/terminal/main` as a compatibility alias that resolves to the main conversation's current execution.

- [ ] **Step 4: Use the normal DB status path**

Remove the main-agent-only `setPtyStatusFields` requirement for tmux-backed main sessions. Every main execution gets an `agent_sessions` row.

- [ ] **Step 5: Run main-agent tests**

Run:

```powershell
node --import tsx --test tests/main-agent-session-id.test.mjs tests/main-agent-session-kernel.test.mjs tests/api-sessions-list.test.mjs tests/update-status-tool.test.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add mcp-server/src/main-agent.ts mcp-server/src/tools/update-status.ts mcp-server/src/session-helpers.ts mcp-server/tests/main-agent-session-kernel.test.mjs
git commit -m "refactor: manage the main agent as a normal session"
```

---

### Task 11: Make artifact delivery idempotent and crash-explicit

**Files:**
- Modify: `mcp-server/src/db/migrations.ts`
- Modify: `mcp-server/src/db/artifact-outbox-store.ts`
- Create: `mcp-server/src/db/artifact-feedback-store.ts`
- Modify: `mcp-server/src/artifact-outbox-worker.ts`
- Modify: `mcp-server/src/cli/cron-api.ts`
- Modify: `mcp-server/src/qa-store.ts`
- Modify: `mcp-server/web/src/api.ts`
- Modify: `mcp-server/src/renderers/_comment-overlay.mjs`
- Modify: `mcp-server/src/renderers/pr-walkthrough.mjs`
- Modify: `mcp-server/tests/artifact-outbox.test.mjs`

- [ ] **Step 1: Add failing ambiguous-delivery and drain tests**

Add this test helper:

```js
function enqueueAndAccept(db) {
  const row = enqueueOutbox(db, {
    artifact_id: 'artifact-1',
    session_id: 'session-1',
    prompt: 'question',
  });
  claimNextOutbox(db);
  markAccepted(db, row.id, 'dispatch-1', 'instance-1');
  return row;
}
```

```js
test('recovery marks an accepted-but-unconfirmed row unknown, not pending', () => {
  const row = enqueueAndAccept(db);
  resetStuckSending(db, 0);
  assert.equal(getOutbox(db, row.id).status, 'unknown');
  assert.equal(claimNextOutbox(db), null);
});

test('stopAndDrain waits for the active delivery', async () => {
  const gate = deferred();
  const worker = startArtifactOutboxWorker(ctx, {
    deliver: async () => {
      await gate.promise;
      return { ok: true, instance_id: 'ri-1', dispatch_id: 'd-1' };
    },
  });
  const running = worker.runOnce();
  const stopping = worker.stopAndDrain();
  assert.equal(await isSettled(stopping), false);
  gate.resolve();
  await running;
  await stopping;
});
```

- [ ] **Step 2: Add migration 14 by rebuilding the CHECK constraint**

Create `artifact_outbox_v14` with statuses:

```sql
'pending','sending','accepted','sent','unknown','failed'
```

Add:

```sql
dispatch_id TEXT,
idempotency_key TEXT NOT NULL,
accepted_at INTEGER,
completed_at INTEGER
```

Copy rows, using `id` as `idempotency_key`, drop the old table, rename the new table, and recreate indexes.

In the same migration, create:

```sql
CREATE TABLE artifact_feedback (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('question','comment')),
  anchor_json TEXT,
  prompt      TEXT NOT NULL,
  outbox_id   TEXT NOT NULL UNIQUE
                REFERENCES artifact_outbox(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_artifact_feedback_artifact
  ON artifact_feedback(artifact_id, created_at);
```

- [ ] **Step 3: Record acceptance before waiting for completion**

Add:

```ts
export function markAccepted(
  db: Database,
  id: string,
  dispatchId: string,
  instanceId: string,
): void
```

The worker calls it immediately after dispatcher returns `status: 'ok'`.

Add:

```ts
export function markUnknown(
  db: Database,
  id: string,
  error: string,
): void {
  db.prepare(`
    UPDATE artifact_outbox
       SET status = 'unknown',
           last_error = ?,
           updated_at = ?
     WHERE id = ? AND status IN ('sending','accepted')
  `).run(error.slice(0, 500), Date.now(), id);
}
```

- [ ] **Step 4: Expose an internal dispatch receipt**

Add:

```ts
export interface DispatchReceipt {
  dispatchId: string;
  completion: Promise<DispatchCompletion>;
}

async dispatchWithReceipt(
  instanceId: string,
  prompt: string,
): Promise<
  | { status: 'target_unavailable' }
  | { status: 'ok'; receipt: DispatchReceipt }
>
```

`dispatchToInstance` remains the immediate compatibility wrapper. The outbox worker uses `dispatchWithReceipt`, calls `markAccepted`, awaits `receipt.completion`, and then:

```ts
if (completion.status === 'ok') markSent(db, row.id, instanceId);
else if (completion.status === 'timeout') markUnknown(db, row.id, 'completion timeout');
else markFailed(db, row.id, completion.error ?? 'dispatch failed');
```

- [ ] **Step 5: Recover ambiguous accepted or sending rows as `unknown`**

Never automatically retry a row that may already have reached the agent. Retry only failures returned before transport acceptance.

- [ ] **Step 6: Persist feedback and outbox rows atomically**

Implement `enqueueArtifactFeedback`:

```ts
export function enqueueArtifactFeedback(
  db: Database,
  input: {
    artifactId: string;
    sessionId: string;
    workspaceId: string | null;
    workspacePath: string | null;
    kind: 'question' | 'comment';
    anchor: unknown;
    prompt: string;
  },
): { feedbackId: string; outboxId: string } {
  return db.transaction(() => {
    const outbox = enqueueOutbox(db, {
      artifact_id: input.artifactId,
      session_id: input.sessionId,
      workspace_id: input.workspaceId,
      workspace_path: input.workspacePath,
      kind: input.kind,
      prompt: input.prompt,
    });
    const feedbackId = `fb_${randomUUID()}`;
    db.prepare(`
      INSERT INTO artifact_feedback (
        id, artifact_id, kind, anchor_json, prompt, outbox_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      feedbackId,
      input.artifactId,
      input.kind,
      input.anchor == null ? null : JSON.stringify(input.anchor),
      input.prompt,
      outbox.id,
      Date.now(),
    );
    return { feedbackId, outboxId: outbox.id };
  })();
}
```

Change `POST /artifact/<id>/ask` to call this function once. Update `qa-store.ts` reads to include DB-backed feedback while retaining legacy file entries for existing artifacts.

- [ ] **Step 7: Add awaitable worker shutdown**

Expose:

```ts
stopAndDrain(): Promise<void>;
```

Track the kick timer and active tick promise. Clear the kick timer during stop and await the active tick.

- [ ] **Step 8: Return and retain delivery receipts in the UI**

The POST response already includes `message_id`. Keep it in local UI state and poll/SSE until:

```ts
type DeliveryStatus = 'pending' | 'sending' | 'accepted' | 'sent' | 'unknown' | 'failed';
```

Do not mark a draft sent on HTTP 202 alone.

- [ ] **Step 9: Run outbox tests**

Run:

```powershell
node --import tsx --test tests/artifact-outbox.test.mjs tests/share-server.test.mjs tests/qa-store.test.mjs
```

Expected: all pass.

- [ ] **Step 10: Commit**

```powershell
git add mcp-server/src/db/migrations.ts mcp-server/src/db/artifact-outbox-store.ts mcp-server/src/db/artifact-feedback-store.ts mcp-server/src/artifact-outbox-worker.ts mcp-server/src/cli/cron-api.ts mcp-server/src/qa-store.ts mcp-server/web/src/api.ts mcp-server/src/renderers mcp-server/tests/artifact-outbox.test.mjs
git commit -m "fix: make artifact delivery crash-explicit and drainable"
```

---

### Task 12: Add ordered application lifecycle and real readiness

**Files:**
- Create: `mcp-server/src/lifecycle-controller.ts`
- Create: `mcp-server/tests/session-kernel/lifecycle-controller.test.mjs`
- Modify: `mcp-server/src/cli/start.ts`
- Modify: `mcp-server/src/service.ts`
- Modify: `mcp-server/src/daemon-supervisor.ts`
- Modify: `mcp-server/src/artifact-outbox-worker.ts`

- [ ] **Step 1: Write order and timeout tests**

Add:

```js
function component(name, events) {
  return {
    name,
    requiredForReadiness: true,
    async start() { events.push(`start:${name}`); },
    async stop() { events.push(`stop:${name}`); },
  };
}
```

```js
test('components stop in reverse start order', async () => {
  const events = [];
  const controller = new LifecycleController();
  controller.add(component('database', events));
  controller.add(component('sessions', events));
  controller.add(component('http', events));
  await controller.start();
  await controller.stop();
  assert.deepEqual(events, [
    'start:database',
    'start:sessions',
    'start:http',
    'stop:http',
    'stop:sessions',
    'stop:database',
  ]);
});

test('readiness is false until every required component starts', async () => {
  const controller = new LifecycleController();
  const gate = deferred();
  controller.add({
    name: 'sessions',
    requiredForReadiness: true,
    start: () => gate.promise,
    stop: async () => {},
  });
  const starting = controller.start();
  assert.equal(controller.isReady(), false);
  gate.resolve();
  await starting;
  assert.equal(controller.isReady(), true);
});
```

- [ ] **Step 2: Implement `LifecycleController`**

```ts
export interface LifecycleComponent {
  name: string;
  requiredForReadiness?: boolean;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export class LifecycleController {
  private components: LifecycleComponent[] = [];
  private started: LifecycleComponent[] = [];
  private ready = false;

  add(component: LifecycleComponent): void {
    this.components.push(component);
  }

  async start(): Promise<void> {
    for (const component of this.components) {
      await component.start();
      this.started.push(component);
    }
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    for (const component of [...this.started].reverse()) {
      await component.stop();
    }
    this.started = [];
  }

  isReady(): boolean {
    return this.ready;
  }
}
```

- [ ] **Step 3: Register startup components in explicit order**

Order:

1. database and migrations
2. tmux backend and authoritative reconciliation
3. session services
4. HTTP/MCP server
5. dispatcher and scheduler
6. daemon supervisor
7. artifact outbox
8. idle reaper
9. main agent
10. tunnels

- [ ] **Step 4: Add `/livez` and `/readyz`**

`/livez` returns 200 once the Node process can answer HTTP. `/readyz` returns:

```json
{
  "ready": true,
  "components": {
    "database": "ready",
    "tmux": "ready",
    "sessions": "ready",
    "dispatcher": "ready"
  }
}
```

Return 503 while any required component is not ready.

- [ ] **Step 5: Change service health probing to `/readyz`**

Do not report service installation success before reconciliation and session services are ready.

- [ ] **Step 6: Replace broad exception survival**

Log `uncaughtException`/`unhandledRejection`, set the process unhealthy, await bounded lifecycle stop, and exit non-zero so the OS supervisor restarts the process.

- [ ] **Step 7: Run lifecycle and service tests**

Run:

```powershell
node --import tsx --test tests/session-kernel/lifecycle-controller.test.mjs tests/service.test.mjs tests/mcp-bootstrap.test.mjs tests/daemon-supervisor.test.mjs
```

Expected: all pass and no shutdown test writes to a closed DB.

- [ ] **Step 8: Commit**

```powershell
git add mcp-server/src/lifecycle-controller.ts mcp-server/src/cli/start.ts mcp-server/src/service.ts mcp-server/src/daemon-supervisor.ts mcp-server/src/artifact-outbox-worker.ts mcp-server/tests/session-kernel/lifecycle-controller.test.mjs
git commit -m "refactor: make kernel startup and shutdown ordered"
```

---

### Task 13: Unify terminal WebSocket and xterm lifecycle in the SPA

**Files:**
- Create: `mcp-server/web/src/terminal/terminal-connection-controller.ts`
- Create: `mcp-server/web/src/composables/useTerminalConnection.ts`
- Create: `mcp-server/tests/terminal-connection-controller.test.mjs`
- Modify: `mcp-server/web/src/components/TerminalTile.vue`
- Modify: `mcp-server/web/src/components/TerminalsPanel.vue`
- Modify: `mcp-server/web/src/components/InboxTerminalPanel.vue`
- Modify: `mcp-server/web/src/components/MainAgentPanel.vue`

- [ ] **Step 1: Write framework-independent controller tests**

Add a fake socket and harness:

```js
class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.listeners = new Map();
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  close() {
    this.readyState = 3;
  }
  send() {}
  emitMessage(message) {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }
}

function createControllerHarness() {
  const sockets = [];
  const output = [];
  const controller = new TerminalConnectionController({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    writeOutput: (chunk) => output.push(chunk),
  });
  return { controller, sockets, output };
}
```

```js
test('a superseded attach cannot publish events', async () => {
  const { controller, sockets, output } = createControllerHarness();
  const first = controller.connect('ri-1');
  const second = controller.connect('ri-2');
  sockets[0].emitMessage({ type: 'data', chunk: 'old' });
  sockets[1].emitMessage({ type: 'data', chunk: 'new' });
  await Promise.all([first, second]);
  assert.deepEqual(output, ['new']);
});

test('socket exit changes state but never resumes a session', async () => {
  const { controller, sockets } = createControllerHarness();
  await controller.connect('ri-1');
  sockets[0].emitMessage({ type: 'exit', exitCode: 0 });
  assert.equal(controller.state, 'exited');
});
```

- [ ] **Step 2: Implement the controller state machine**

States:

```ts
export type TerminalConnectionState =
  | 'idle'
  | 'measuring'
  | 'connecting'
  | 'live'
  | 'archived'
  | 'exited'
  | 'error'
  | 'disposed';
```

The controller owns attach generation, WebSocket handlers, resize dedupe, terminal disposal, and the server `hello` message.

Implement the core as:

```ts
interface SocketLike {
  readonly readyState: number;
  addEventListener(name: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface TerminalConnectionControllerOptions {
  createSocket(url: string): SocketLike;
  writeOutput(chunk: string): void;
}

export class TerminalConnectionController {
  state: TerminalConnectionState = 'idle';
  resolvedInstanceId: string | null = null;
  error: string | null = null;
  private generation = 0;
  private socket: SocketLike | null = null;

  constructor(private readonly opts: TerminalConnectionControllerOptions) {}

  async connect(instanceId: string): Promise<void> {
    const generation = ++this.generation;
    this.disconnectSocket();
    this.state = 'connecting';
    const socket = this.opts.createSocket(
      `/terminal/${encodeURIComponent(instanceId)}/ws`,
    );
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      if (this.generation !== generation || typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as {
        type: string;
        chunk?: string;
        content?: string;
        resolvedInstanceId?: string;
        error?: string;
      };
      if (message.type === 'hello') {
        this.resolvedInstanceId = message.resolvedInstanceId ?? instanceId;
        this.state = 'live';
      } else if (message.type === 'snapshot') {
        this.opts.writeOutput(message.content ?? '');
      } else if (message.type === 'data') {
        this.opts.writeOutput(message.chunk ?? '');
      } else if (message.type === 'exit') {
        this.state = 'exited';
      } else if (message.type === 'error') {
        this.error = message.error ?? 'terminal connection failed';
        this.state = 'error';
      }
    });
  }

  sendInput(data: string): void {
    if (this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify({ type: 'input', data }));
  }

  resize(cols: number, rows: number): void {
    if (this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  disconnect(): void {
    this.generation++;
    this.disconnectSocket();
    this.state = 'idle';
  }

  dispose(): void {
    this.disconnect();
    this.state = 'disposed';
  }

  private disconnectSocket(): void {
    this.socket?.close();
    this.socket = null;
  }
}
```

- [ ] **Step 3: Implement the Vue composable**

Expose:

```ts
const {
  host,
  state,
  error,
  resolvedInstanceId,
  connect,
  disconnect,
  focus,
} = useTerminalConnection({
  requestedInstanceId: computed(() => props.sessionId),
  interactive: true,
  renderer: 'canvas',
});
```

- [ ] **Step 4: Replace component-local connection implementations**

Delete duplicated `attachGen`, WebSocket, `ResizeObserver`, and teardown code from all four terminal components.

- [ ] **Step 5: Remove auto-resume from WebSocket exit**

An exited terminal shows a Resume button. Clicking Resume calls the idempotent backend coordinator. Merely receiving `exit` or `close` never spawns.

- [ ] **Step 6: Run controller and type tests**

Run:

```powershell
cd C:\git\clawdevbox\mcp-server
node --import tsx --test tests/terminal-connection-controller.test.mjs
cd web
npx vue-tsc --noEmit
```

Expected: all pass.

- [ ] **Step 7: Run terminal Playwright tests**

Run:

```powershell
cd C:\git\clawdevbox\mcp-server
npx playwright test tests/terminal-viewer.playwright.test.mjs tests/terminals-panel-e2e.playwright.test.mjs tests/terminal-resize-after-panel.playwright.test.mjs
```

Expected: all pass without fixed `waitForTimeout` assertions.

- [ ] **Step 8: Commit**

```powershell
git add mcp-server/web/src/terminal mcp-server/web/src/composables/useTerminalConnection.ts mcp-server/web/src/components mcp-server/tests/terminal-connection-controller.test.mjs
git commit -m "refactor: share one terminal connection controller"
```

---

### Task 14: Add restart/recovery E2E coverage

**Files:**
- Create: `mcp-server/tests/session-recovery.playwright.test.mjs`
- Modify: `mcp-server/src/agent-clis/e2e-test-runner.ts`
- Modify: `mcp-server/tests/terminals-panel-e2e.playwright.test.mjs`
- Modify: `mcp-server/tests/dispatch-bytes-e2e.test.mjs`
- Modify: `mcp-server/tests/dispatch-endpoint.test.mjs`

- [ ] **Step 1: Make the existing E2E provider resumable and tmux-backed**

Set:

```ts
supportsResume: true,
```

For interactive mode, spawn with `ctx.spawnTmuxSession`:

```ts
const instanceKey = opts.recipeInstanceId ?? opts.init.session_id;
const session = await ctx.spawnTmuxSession!({
  name: instanceKey,
  cwd: opts.workspaceInfo.path,
  env,
  cols: opts.ptyCols ?? 80,
  rows: opts.ptyRows ?? 24,
  command: process.execPath,
  args: [scriptPath],
});
return {
  pid: await session.pid(),
  sessionId: opts.init.session_id,
  session,
  exited: session.exited.then(({ exitCode }) => ({
    exitCode: exitCode ?? 0,
  })),
};
```

In the generated interactive script, retain the MCP session until process exit and persist received prompts under:

```js
const statePath = path.join(
  process.env.CLAWDEVBOX_PROJECT_DIR || process.cwd(),
  '.clawdevbox',
  'e2e-test-runner',
  ${JSON.stringify(opts.init.session_id)} + '.state.json',
);
let state = { sequence: 0, prompts: [] };
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
```

For each line:

```js
rl.on('line', async (line) => {
  const prompt = line.replace(/\r$/, '');
  if (!prompt.trim()) return;
  state.sequence += 1;
  state.prompts.push(prompt);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write(
    '[e2e-test-runner] DISPATCH_RX #' + state.sequence + ': ' +
    Buffer.from(prompt, 'utf8').toString('base64') + '\n',
  );
  await rpc(cfg.url, cfg.headers, mcpSessionId, 'tools/call', {
    name: 'update_status',
    arguments: {
      status: 'processed dispatch #' + state.sequence,
      task_complete: true,
      session_id: ${JSON.stringify(opts.init.session_id)},
    },
  }, 1000 + state.sequence);
});
```

This fixture now provides deterministic persistence, exact-content assertions, completion signaling, and restart adoption without requiring a real Copilot installation.

- [ ] **Step 2: Add restart adoption E2E**

Add this harness to the Playwright test:

```js
async function startKernel({ globalDir, projectDir, port }) {
  const child = spawn(process.execPath, [
    '--import', 'tsx',
    'src/cli/index.ts',
    'start',
    '--global', globalDir,
    '--project', projectDir,
    '--port', String(port),
    '--token', '',
  ], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      CLAWDEVBOX_DEFAULT_AGENT_CLI: 'e2e-test-runner',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  await pollUntil(async () => (await fetch(`${base}/readyz`)).ok, 30_000);

  return {
    async spawn(body) {
      const response = await fetch(`${base}/spawn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body,
          provider: 'e2e-test-runner',
          workspace_path: projectDir,
        }),
      });
      return response.json();
    },
    async sessions() {
      return fetch(`${base}/api/sessions`).then((response) => response.json());
    },
    async tmuxPid(instanceId) {
      const result = spawnSync('tmux', [
        'display-message', '-p', '-t', `cdb_${instanceId}`, '#{pane_pid}',
      ], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return Number(result.stdout.trim());
    },
    async stopWithoutKillingTmux() {
      child.kill('SIGKILL');
      await once(child, 'exit');
    },
    async stop() {
      child.kill('SIGTERM');
      await once(child, 'exit');
    },
  };
}
```

Test flow:

```js
test('kernel restart adopts the existing tmux execution', async () => {
  const root = tempRoot('cdb-recovery-');
  const port = await freePort();
  const kernel = await startKernel({
    globalDir: join(root.path, 'global'),
    projectDir: join(root.path, 'project'),
    port,
  });
  const spawned = await kernel.spawn({ session_id: 'recovery', prompt: 'FIRST' });
  const originalTmuxPid = await kernel.tmuxPid(spawned.instance_id);

  await kernel.stopWithoutKillingTmux();
  const restarted = await startKernel({
    globalDir: join(root.path, 'global'),
    projectDir: join(root.path, 'project'),
    port,
  });
  const sessions = await restarted.sessions();

  assert.equal(
    sessions.items.find((item) => item.cli_session_id === spawned.session_id).instance_id,
    spawned.instance_id,
  );
  assert.equal(await restarted.tmuxPid(spawned.instance_id), originalTmuxPid);
  await restarted.stop();
  root.cleanup();
});
```

- [ ] **Step 3: Add concurrent resume E2E**

Open two browser pages on the same archived session and click Resume simultaneously. Assert one live execution and one tmux PID.

- [ ] **Step 4: Add exact multiline dispatch E2E**

Send a multiline JSON/code prompt through `/dispatch`. Assert the fake CLI receives byte-for-byte content once.

- [ ] **Step 5: Unskip direct dispatch tests**

Replace removed conductor assumptions with the fake CLI and coordinator. Remove `test.skip` from the three `/dispatch` happy paths.

- [ ] **Step 6: Run E2E**

Run:

```powershell
npx playwright test tests/session-recovery.playwright.test.mjs
node --import tsx --test tests/dispatch-bytes-e2e.test.mjs tests/dispatch-endpoint.test.mjs
```

Expected: all pass on Windows.

- [ ] **Step 7: Commit**

```powershell
git add mcp-server/src/agent-clis/e2e-test-runner.ts mcp-server/tests/session-recovery.playwright.test.mjs mcp-server/tests/terminals-panel-e2e.playwright.test.mjs mcp-server/tests/dispatch-bytes-e2e.test.mjs mcp-server/tests/dispatch-endpoint.test.mjs
git commit -m "test: cover session recovery and exact dispatch end to end"
```

---

### Task 15: Remove compatibility paths and split oversized modules

**Files:**
- Delete: `mcp-server/src/pending-dispatch-registry.ts`
- Delete: `mcp-server/src/cli-sessions/wait-for-ready.ts`
- Modify: `mcp-server/src/pty-registry.ts`
- Modify: `mcp-server/src/agent-clis/shared.ts`
- Modify: `mcp-server/src/agent-clis/types.ts`
- Split: `mcp-server/src/terminal-server.ts`
- Split: `mcp-server/src/cli/start.ts`
- Modify: `mcp-server/src/session-helpers.ts`

- [ ] **Step 1: Prove compatibility exports have no callers**

Run:

```powershell
rg "getConductor|initialPromptDelivery|deliverInitialPromptWhenReady|pending-dispatch-registry|__clawdevboxSessionHelperCtx" mcp-server/src mcp-server/tests
```

Expected: only compatibility definitions remain.

- [ ] **Step 2: Remove conductor-era state from `pty-registry`**

Delete:

- null-only `conductor`
- `initialPromptGateActive`
- `pendingResize`
- `INITIAL_PROMPT_VIEWER_GATE_GRACE_MS`
- silent-success input dropping

Raw PTY input either succeeds or returns `false`.

- [ ] **Step 3: Remove deprecated prompt helpers and types**

Delete `deliverInitialPromptWhenReady`, `PromptStrategy`, and unused provider `writePrompt` variants after `prompt-delivery.ts` owns the behavior.

- [ ] **Step 4: Split terminal server by responsibility**

Create:

- `src/http/artifact-routes.ts`
- `src/http/store-routes.ts`
- `src/http/terminal-routes.ts`
- `src/terminal/terminal-websocket.ts`

`terminal-server.ts` becomes composition only:

```ts
export async function startTerminalServer(opts: TerminalServerOptions) {
  const router = createHttpRouter([
    artifactRoutes(opts),
    storeRoutes(opts),
    terminalRoutes(opts),
  ]);
  return createTerminalHttpServer(router, opts);
}
```

- [ ] **Step 5: Split startup by phase**

Create:

- `src/bootstrap/preflight.ts`
- `src/bootstrap/create-session-services.ts`
- `src/bootstrap/create-http-server.ts`
- `src/bootstrap/create-background-workers.ts`

`cli/start.ts` parses flags, builds the lifecycle controller, and renders the startup banner.

- [ ] **Step 6: Run dead-code and build checks**

Run:

```powershell
cd C:\git\clawdevbox\mcp-server
npm run typecheck
npm run build
rg "getConductor|initialPromptDelivery|deliverInitialPromptWhenReady|__clawdevboxSessionHelperCtx" src
```

Expected: typecheck/build pass and ripgrep returns no matches.

- [ ] **Step 7: Commit**

```powershell
git add -A
git commit -m "refactor: remove legacy terminal and session paths"
```

---

### Task 16: Final cross-platform verification and documentation

**Files:**
- Modify: `mcp-server/package.json`
- Modify: `docs/tmux-cli-sessions.md`
- Modify: `mcp-server/README.md`
- Create: `docs/session-kernel.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Document the final invariants**

`docs/session-kernel.md` must state:

1. one canonical conversation ID
2. at most one current execution per conversation
3. one dispatch head writes at a time
4. transport acceptance is not task completion
5. runtime liveness is live/absent/unavailable
6. UI disconnect never spawns
7. outbox retries only before transport acceptance
8. shutdown drains workers before DB close

- [ ] **Step 2: Update tmux documentation**

Remove the false psmux paste-buffer fallback description. Document the tested bracketed-paste path and exact commands used by the Windows contract suite.

- [ ] **Step 3: Run all focused suites**

Run:

```powershell
cd C:\git\clawdevbox\mcp-server
npm run typecheck
npm run web:build
npm run test:sessions:unit
npm run test:sessions:integration
npm run test:sessions:tmux
npm run test:sessions:e2e
```

Expected: every command exits 0.

- [ ] **Step 4: Run the complete backend suite**

Run:

```powershell
npm test
```

Expected: command completes without hanging, with zero failed and zero cancelled tests. Environment-dependent live CLI tests may be explicitly skipped.

- [ ] **Step 5: Run the full Playwright suite**

Run:

```powershell
npm run test:e2e
```

Expected: all configured browsers pass.

- [ ] **Step 6: Verify on Windows and Ubuntu**

Run the unit, integration, tmux, build, and Playwright suites in the existing CI workflow on:

```yaml
strategy:
  matrix:
    os: [windows-latest, ubuntu-latest]
```

- [ ] **Step 7: Commit**

```powershell
git add docs mcp-server/README.md mcp-server/package.json .github/workflows
git commit -m "docs: document and verify the session kernel"
```

---

## Final acceptance criteria

- Two concurrent resume requests create one execution and return the same ID.
- A failed tmux probe never marks sessions dead or starts replacements.
- Multiline and 4097+ character prompts arrive byte-for-byte on Windows psmux.
- A completed dispatch timer cannot affect a later dispatch.
- Transport rejection returns `target_unavailable`, never success.
- The main agent has a canonical conversation and normal DB-backed status.
- Kernel restart adopts existing tmux processes without changing their PID.
- Artifact outbox never automatically retries an ambiguously accepted message.
- Outbox and daemon shutdown complete before the database closes.
- All terminal Vue components use one connection controller.
- WebSocket exit or browser disconnect never auto-spawns an agent.
- Full backend and Playwright suites terminate reliably on Windows and Ubuntu.

## Implementation sequence

Tasks 1-4 are the immediate correctness gate and should land first. Tasks 5-10 introduce the session kernel while preserving external contracts. Tasks 11-14 harden durable delivery, lifecycle, UI, and restart behavior. Tasks 15-16 remove compatibility code and establish the final release gate.
