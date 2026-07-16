# Session MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 MCP tools (`session.send`, `session.read`, `session.kill`, `session.list`) that let agents spawn / dispatch-to / read / enumerate / kill / resume sub-agent CLI sessions, by wrapping existing HTTP `/spawn` `/dispatch` `/api/sessions` paths via a shared helper module.

**Architecture:** Extract the bodies of the 4 HTTP handlers into a new `session-helpers.ts` module; both `cron-api.ts` HTTP routes and the new `tools/session.ts` MCP tools call the same helpers (single source of truth, no protocol drift). Add a `readScrollback` helper to `pty-registry.ts` that returns code-unit-offset cursors. The smart routing of `session.send` adds a `resume` branch: when an alias resolves to an archived `agent_sessions` row whose provider supports resume, run `runRecipe({resumeOf: cli_session_id})` then FIFO-dispatch the prompt. Per-canonical-GUID async mutex prevents concurrent same-alias spawns from creating duplicates.

**Tech Stack:** TypeScript, Zod schemas, `node:test` runner, better-sqlite3, node-pty, tmux (psmux on Windows), MCP SDK.

---

## File Structure

```
NEW       mcp-server/src/async-mutex.ts              — minimal keyed async mutex (no deps)
NEW       mcp-server/src/session-helpers.ts          — shared spawn/dispatch/list/kill/read helpers
NEW       mcp-server/src/tools/session.ts            — registerSessionEntries (4 defineTool calls)
MODIFIED  mcp-server/src/pty-registry.ts             — + readScrollback + totalCodeUnits counter
MODIFIED  mcp-server/src/cli/cron-api.ts             — 4 handlers delegate to session-helpers
MODIFIED  mcp-server/src/server.ts                   — call registerSessionEntries in registerAllBuiltinEntries
NEW       mcp-server/tests/async-mutex.test.mjs      — mutex unit tests
NEW       mcp-server/tests/pty-registry-scrollback.test.mjs — readScrollback unit tests
NEW       mcp-server/tests/tools-session.test.mjs    — 19 test cases for the new MCP tools
```

Tasks are ordered bottom-up: foundation utilities (mutex, scrollback) → shared helper module → MCP tool registrations → cron-api refactor → end-to-end tests. Each task is independently committable.

---

## Task 1: Keyed async mutex utility

**Files:**
- Create: `mcp-server/src/async-mutex.ts`
- Create: `mcp-server/tests/async-mutex.test.mjs`

**Rationale:** `session.send` needs to serialize the `findLiveInstanceForSession → spawn/resume/dispatch` block per canonical session GUID so concurrent same-alias calls don't both observe "no live instance" and both spawn. Tiny in-process keyed mutex, no external deps.

- [ ] **Step 1: Write the failing test**

Create `mcp-server/tests/async-mutex.test.mjs`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { withKeyedLock, _internalQueueSize } from '../src/async-mutex.ts';

test('async-mutex: serializes same-key concurrent calls', async () => {
  const order = [];
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push(withKeyedLock('K1', async () => {
      order.push(`enter-${i}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`exit-${i}`);
      return i;
    }));
  }
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  for (let i = 0; i < 5; i++) {
    assert.equal(order[2 * i], `enter-${i}`);
    assert.equal(order[2 * i + 1], `exit-${i}`);
  }
});

test('async-mutex: different keys run concurrently', async () => {
  let aRunning = false;
  let bRunning = false;
  let overlap = false;
  await Promise.all([
    withKeyedLock('A', async () => {
      aRunning = true;
      await new Promise((r) => setTimeout(r, 30));
      if (bRunning) overlap = true;
      aRunning = false;
    }),
    withKeyedLock('B', async () => {
      bRunning = true;
      await new Promise((r) => setTimeout(r, 30));
      if (aRunning) overlap = true;
      bRunning = false;
    }),
  ]);
  assert.equal(overlap, true);
});

test('async-mutex: releases lock when fn throws', async () => {
  await assert.rejects(
    withKeyedLock('K2', async () => { throw new Error('boom'); }),
    /boom/,
  );
  const result = await withKeyedLock('K2', async () => 'ok');
  assert.equal(result, 'ok');
});

test('async-mutex: prunes empty queues', async () => {
  await withKeyedLock('PRUNE_KEY', async () => 'a');
  await withKeyedLock('PRUNE_KEY', async () => 'b');
  assert.equal(_internalQueueSize('PRUNE_KEY'), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-server && npx tsx --test tests/async-mutex.test.mjs`
Expected: FAIL with module-not-found for `../src/async-mutex.ts`.

- [ ] **Step 3: Write the implementation**

Create `mcp-server/src/async-mutex.ts`:
```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-server && npx tsx --test tests/async-mutex.test.mjs`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd C:/git/clawdevbox
git add mcp-server/src/async-mutex.ts mcp-server/tests/async-mutex.test.mjs
git commit -m "feat(util): keyed async mutex for session.send serialization

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: pty-registry `readScrollback` + monotonic counter

**Files:**
- Modify: `mcp-server/src/pty-registry.ts`
- Create: `mcp-server/tests/pty-registry-scrollback.test.mjs`

**Rationale:** `session.read` needs incremental reads against legacy IPty sessions. Add monotonic `totalCodeUnits` + `headCodeUnits` counters to each `PtySession` (updated on every `appendToBuffer`), a `spawnTs` for cursor-invalidation on respawn, and an exported `readScrollback(instanceId, {since})` helper.

- [ ] **Step 1: Write the failing test**

Create `mcp-server/tests/pty-registry-scrollback.test.mjs`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  registerPty,
  readScrollback,
  killPty,
  _resetForTests,
} from '../src/pty-registry.ts';

function makeFakeIPty() {
  const ee = new EventEmitter();
  return {
    pid: 12345, cols: 80, rows: 24, process: 'fake',
    onData: (cb) => { ee.on('data', cb); return { dispose: () => ee.off('data', cb) }; },
    onExit: (cb) => { ee.on('exit', cb); return { dispose: () => ee.off('exit', cb) }; },
    write: () => {}, resize: () => {}, kill: () => { ee.emit('exit', { exitCode: 0 }); },
    clear: () => {}, pause: () => {}, resume: () => {},
    _emit: (chunk) => ee.emit('data', chunk),
    _emitExit: (code) => ee.emit('exit', { exitCode: code }),
  };
}

test('readScrollback: returns full buffer + monotonic offset', () => {
  _resetForTests();
  const ipty = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty });
  ipty._emit('hello');
  ipty._emit(' world');
  const r = readScrollback('i1', { since: 0 });
  assert.equal(r.content, 'hello world');
  assert.equal(r.totalOffset, 11);
  assert.equal(r.headOffset, 0);
  assert.equal(r.exited, false);
});

test('readScrollback: incremental read with cursor', () => {
  _resetForTests();
  const ipty = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty });
  ipty._emit('AAA');
  const r1 = readScrollback('i1', { since: 0 });
  assert.equal(r1.totalOffset, 3);
  ipty._emit('BBB');
  const r2 = readScrollback('i1', { since: r1.totalOffset });
  assert.equal(r2.content, 'BBB');
  assert.equal(r2.totalOffset, 6);
});

test('readScrollback: since below head_offset reports head advance', () => {
  _resetForTests();
  const ipty = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty });
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 5; i++) ipty._emit(chunk);
  const r = readScrollback('i1', { since: 0 });
  assert.ok(r.headOffset > 0, `expected headOffset > 0, got ${r.headOffset}`);
  assert.equal(r.totalOffset, 5 * 64 * 1024);
  assert.equal(r.content.length, r.totalOffset - r.headOffset);
});

test('readScrollback: spawnTs differs after kill + re-register', async () => {
  _resetForTests();
  const ipty1 = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty: ipty1 });
  const meta1 = readScrollback('i1', { since: 0 });
  ipty1._emitExit(0);
  // Wait for EXIT_RETAIN_MS to elapse so the registry GCs the session.
  // Use the test hatch reset to skip the wait.
  _resetForTests();
  await new Promise((r) => setTimeout(r, 5));
  const ipty2 = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty: ipty2 });
  const meta2 = readScrollback('i1', { since: 0 });
  assert.notEqual(meta2.spawnTs, meta1.spawnTs);
});

test('readScrollback: returns null for unknown instance', () => {
  _resetForTests();
  assert.equal(readScrollback('nope', { since: 0 }), null);
});

test('readScrollback: reports exited + exitCode', () => {
  _resetForTests();
  const ipty = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty });
  ipty._emit('done');
  ipty._emitExit(42);
  const r = readScrollback('i1', { since: 0 });
  assert.equal(r.exited, true);
  assert.equal(r.exitCode, 42);
  assert.equal(r.content, 'done');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-server && npx tsx --test tests/pty-registry-scrollback.test.mjs`
Expected: FAIL — `readScrollback` and `_resetForTests` not exported.

- [ ] **Step 3: Add new fields to `PtySession` interface**

In `mcp-server/src/pty-registry.ts`, locate the `PtySession` interface (currently lines 117-132). Replace it with:

```typescript
interface PtySession {
  instanceId: string;
  workspaceId: string;
  ipty: IPty;
  cols: number;
  rows: number;
  buffer: string[];
  bufferBytes: number;
  subscribers: Set<PtySubscriber>;
  exited: boolean;
  exitCode: number | null;
  meta: PtySessionMeta;
  conductor: SessionConductor | null;
  initialPromptGateActive: boolean;
  pendingResize: { cols: number; rows: number } | null;
  /**
   * Monotonic total UTF-16 code units appended to this session's output
   * stream (NOT the current buffer length — counts content already dropped
   * from the ring). Cursor offset basis for readScrollback.
   */
  totalCodeUnits: number;
  /**
   * Code-unit offset of the FIRST character currently in the ring.
   * Advances when appendToBuffer drops head entries past BUFFER_LIMIT_BYTES.
   */
  headCodeUnits: number;
  /** Epoch ms at register time. Encoded into cursor so respawn invalidates. */
  spawnTs: number;
}
```

- [ ] **Step 4: Initialize new fields in `registerPty`**

In `registerPty()`, the `session` object literal initializer (currently around lines 177-192). Add the three new fields:

```typescript
    pendingResize: null,
    totalCodeUnits: 0,
    headCodeUnits: 0,
    spawnTs: Date.now(),
```

- [ ] **Step 5: Update `appendToBuffer` to maintain offsets**

Replace `appendToBuffer` (currently lines 141-148):

```typescript
function appendToBuffer(s: PtySession, chunk: string): void {
  s.buffer.push(chunk);
  s.bufferBytes += chunk.length;
  s.totalCodeUnits += chunk.length;
  while (s.bufferBytes > BUFFER_LIMIT_BYTES && s.buffer.length > 1) {
    const head = s.buffer.shift();
    if (head !== undefined) {
      s.bufferBytes -= head.length;
      s.headCodeUnits += head.length;
    }
  }
}
```

- [ ] **Step 6: Add the `readScrollback` exported helper**

Append to `mcp-server/src/pty-registry.ts` (after the existing `listSessions` export):

```typescript
export interface ReadScrollbackOpts {
  since: number;
}

export interface ReadScrollbackResult {
  /** Content from Math.max(since, headCodeUnits) to totalCodeUnits. */
  content: string;
  /** Total code units written so far. New cursor offset. */
  totalOffset: number;
  /** First code unit still in the ring. */
  headOffset: number;
  /** Session spawn timestamp — encode into cursor so respawn invalidates. */
  spawnTs: number;
  exited: boolean;
  exitCode?: number;
}

/**
 * Return scrollback slice from `Math.max(since, headOffset)` to current
 * total. Returns null when the session isn't in the registry. Caller
 * compares `since` with `headOffset` to compute truncated_before.
 */
export function readScrollback(
  instanceId: string,
  opts: ReadScrollbackOpts,
): ReadScrollbackResult | null {
  const s = sessions.get(instanceId);
  if (!s) return null;
  const since = Math.max(opts.since, s.headCodeUnits);
  const full = s.buffer.join('');
  const startInFull = since - s.headCodeUnits;
  const content = startInFull >= full.length ? '' : full.slice(startInFull);
  return {
    content,
    totalOffset: s.totalCodeUnits,
    headOffset: s.headCodeUnits,
    spawnTs: s.spawnTs,
    exited: s.exited,
    exitCode: s.exitCode ?? undefined,
  };
}

/** Test hatch — wipes the live registry. Production callers should not use. */
export function _resetForTests(): void {
  sessions.clear();
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd mcp-server && npx tsx --test tests/pty-registry-scrollback.test.mjs`
Expected: 6 tests pass.

- [ ] **Step 8: Sanity-check existing pty-registry callers still pass**

Run: `cd mcp-server && npx tsx --test tests/main-agent-spawn.test.mjs tests/recipe-runner-interactive.test.mjs`
Expected: all pass — new fields are purely additive.

- [ ] **Step 9: Commit**

```bash
git add mcp-server/src/pty-registry.ts mcp-server/tests/pty-registry-scrollback.test.mjs
git commit -m "feat(pty-registry): readScrollback + monotonic code-unit cursors

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: `session-helpers.ts` — extracted shared helpers

**Files:**
- Create: `mcp-server/src/session-helpers.ts`

**Rationale:** Extract the bodies of `/spawn`, `/dispatch`, `/api/sessions` GET, and `/api/sessions/:id` DELETE from `cron-api.ts` into reusable helpers. Both HTTP routes (Task 5) and MCP tools (Task 4) call them. Add the resume + foreign-tmux branches that don't exist in the current HTTP handlers.

This task ONLY creates the helpers — Task 5 refactors `cron-api.ts` to use them. Both must be in place before tests can verify behavior parity, so we ship them together via the test in Task 6.

- [ ] **Step 1: Create the helpers module skeleton + types**

Create `mcp-server/src/session-helpers.ts`:
```typescript
/**
 * session-helpers.ts
 *
 * Single source of truth for spawn/dispatch/list/kill/read of sessions.
 * Used by both `cron-api.ts` HTTP routes and `tools/session.ts` MCP tools
 * so the two protocols can't drift.
 *
 * Helper responsibilities:
 *   spawnDispatchOrResume — smart router. Live? dispatch. Archived+resumable?
 *     resume. Else spawn. Foreign tmux? FOREIGN_NOT_WRITABLE.
 *   dispatchOnly          — pure dispatch to an existing instance_id.
 *   listSessions          — enumerate all live + archived (+ foreign tmux).
 *   killSession           — tries pty, tmux-registry, foreign tmux in order.
 *   readScrollback        — backend-aware: pty (cursor) or tmux (snapshot).
 *
 * All helpers take a `SessionHelperCtx` (db + dispatcher + ws + cfg).
 */

import type { Database } from 'better-sqlite3';
import type { Dispatcher } from './dispatcher.ts';
import type { Workspace } from './workspace.ts';
import type { ResolvedConfig } from './config.ts';
import { withKeyedLock } from './async-mutex.ts';
import { logger } from './logger.ts';

export interface SessionHelperCtx {
  db: Database;
  dispatcher: Dispatcher;
  ws: Workspace;
  cfg: ResolvedConfig;
}

export type SendMode = 'spawn' | 'dispatch' | 'resume';

export interface SendArgs {
  prompt: string;
  session_id?: string | null;
  provider?: string | null;
  agent?: string | null;
  model?: string | null;
  workspace_id?: string | null;
  workspace_path?: string | null;
  /** Caller's project dir (from X-Clawdevbox-Project-Dir or env). Fallback for workspace_path. */
  default_workspace_path?: string | null;
  /** Optional fire_id for trigger-context spawns (preserves HTTP /spawn?fire_id behavior). */
  fire_id?: string | null;
}

export type SendResult =
  | { ok: true; mode: SendMode; instance_id: string; session_id: string;
      session_alias?: string | null; state?: 'dispatched'; resumed_from?: string }
  | { ok: false; code: SendErrorCode; message: string; details?: Record<string, unknown> };

export type SendErrorCode =
  | 'PROVIDER_REQUIRED'
  | 'WORKSPACE_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'RESUME_FAILED'
  | 'FOREIGN_NOT_WRITABLE'
  | 'NOT_FOUND_FIRE';

// implementations follow in Step 2…
```

- [ ] **Step 2: Implement `spawnDispatchOrResume`**

Append to `mcp-server/src/session-helpers.ts`:
```typescript
/**
 * Smart routing for session.send + HTTP /spawn. Resolves session_id alias
 * to a canonical GUID, checks live state, then routes to:
 *   - dispatch  (live pty exists for this GUID)
 *   - resume    (archived agent_sessions row + provider.supportsResume)
 *   - spawn     (fresh session)
 *
 * Per-GUID async mutex ensures concurrent same-alias calls serialize.
 */
export async function spawnDispatchOrResume(
  ctx: SessionHelperCtx,
  args: SendArgs,
): Promise<SendResult> {
  const { resolveSessionId } = await import('./db/session-aliases-store.ts');
  const { guid: sessionGuid, alias: sessionAlias } = resolveSessionId(ctx.db, args.session_id);

  return withKeyedLock(`session.send:${sessionGuid}`, async () => {
    // 1. LIVE? → dispatch
    const liveInstance = await ctx.dispatcher.findLiveInstanceForSession(sessionGuid);
    if (liveInstance) {
      const dr = await ctx.dispatcher.dispatchToInstance(liveInstance, args.prompt);
      if (dr.status !== 'target_unavailable') {
        return {
          ok: true, mode: 'dispatch',
          instance_id: liveInstance,
          session_id: sessionGuid,
          session_alias: sessionAlias,
          state: 'dispatched',
        };
      }
      // target_unavailable → fall through to spawn/resume (pty died between
      // findLive and dispatch).
    }

    // 2. FOREIGN TMUX? → reject writes
    // If the caller passed an instance-id-like string that matches a live
    // tmux session not in our registry, refuse to send to avoid clobbering
    // a user's shell.
    if (args.session_id) {
      const { tmuxSessionRegistry, tmuxSessionRuntime } =
        await import('./cli-sessions/tmux-session-runtime.ts');
      try {
        const live = await tmuxSessionRuntime().list();
        const asInstance = args.session_id.startsWith('cdb_')
          ? args.session_id.slice(4)
          : args.session_id;
        const isForeign = live.some((s) =>
          (s.name === args.session_id || s.name === `cdb_${args.session_id}`)
          && !tmuxSessionRegistry.get(asInstance)
        );
        if (isForeign) {
          return {
            ok: false,
            code: 'FOREIGN_NOT_WRITABLE',
            message: `session_id '${args.session_id}' is a foreign tmux session — writes are not allowed for safety. Use session.read to observe it.`,
          };
        }
      } catch { /* tmux not available — fall through, spawn will surface real error */ }
    }

    // 3. ARCHIVED + RESUMABLE? → resume
    const resumeRow = lookupResumableArchivedRow(ctx, sessionGuid);
    if (resumeRow) {
      const provider = ctx.ws.agentCliProviders.get(resumeRow.agent_cli);
      if (provider?.supportsResume) {
        try {
          const result = await runResume(ctx, resumeRow, args.prompt, sessionGuid);
          return {
            ok: true, mode: 'resume',
            instance_id: result.newInstanceId,
            session_id: sessionGuid,
            session_alias: sessionAlias,
            resumed_from: resumeRow.recipe_instance_id ?? resumeRow.id,
          };
        } catch (err) {
          return {
            ok: false,
            code: 'RESUME_FAILED',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
      // provider can't resume — fall through to fresh spawn with same GUID.
    }

    // 4. SPAWN
    const provider = args.provider ?? ctx.cfg.defaultAgentCli ?? null;
    if (!provider) {
      return {
        ok: false,
        code: 'PROVIDER_REQUIRED',
        message: 'No `provider` given and `cfg.defaultAgentCli` is not configured.',
      };
    }

    const workspacePath = args.workspace_path
      ?? args.default_workspace_path
      ?? null;

    const result = await ctx.dispatcher.spawnFromCallback(
      args.fire_id ?? null,
      args.prompt,
      {
        agent: args.agent ?? undefined,
        model: args.model ?? undefined,
        workspaceId: args.workspace_id ?? undefined,
        workspacePath: workspacePath ?? undefined,
        provider,
        sessionId: sessionGuid,
      },
    );
    if (result.status === 'not_found_fire') {
      return { ok: false, code: 'NOT_FOUND_FIRE', message: 'fire not found or not in flight',
               details: { fire_id: args.fire_id } };
    }
    if (result.status === 'spawn_failed') {
      return { ok: false, code: 'SPAWN_FAILED', message: result.message };
    }
    return {
      ok: true, mode: 'spawn',
      instance_id: result.instanceId,
      session_id: result.sessionId,
      session_alias: sessionAlias,
    };
  });
}

interface ArchivedResumeRow {
  id: string;
  recipe_instance_id: string | null;
  cli_session_id: string;
  workspace_id: string;
  agent_cli: string;
}

function lookupResumableArchivedRow(
  ctx: SessionHelperCtx,
  sessionGuid: string,
): ArchivedResumeRow | null {
  // The agent_sessions table keys live sessions by cli_session_id (the
  // canonical session GUID). When the pty exits, the row stays. Pick the
  // most-recently-started terminal row with this cli_session_id.
  const row = ctx.db.prepare(
    `SELECT id, recipe_instance_id, cli_session_id, workspace_id, agent_cli
     FROM agent_sessions
     WHERE cli_session_id = ?
       AND cli_session_id IS NOT NULL
       AND status != 'running'
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(sessionGuid) as ArchivedResumeRow | undefined;
  return row ?? null;
}

async function runResume(
  ctx: SessionHelperCtx,
  row: ArchivedResumeRow,
  prompt: string,
  sessionGuid: string,
): Promise<{ newInstanceId: string }> {
  const { runRecipe } = await import('./recipe-runner.ts');
  const { resolveWorkspacesRoot } = await import('./workspaces-store.ts');
  const { markResumedInto } = await import('./db/agent-sessions-store.ts');

  // Determine original recipe id (adhoc vs saved).
  let originalRecipeId: string | null = null;
  let isAdhoc = false;
  if (row.recipe_instance_id) {
    const ri = ctx.db.prepare('SELECT recipe_id FROM recipe_instances WHERE id = ?')
      .get(row.recipe_instance_id) as { recipe_id?: string } | undefined;
    originalRecipeId = ri?.recipe_id ?? null;
    isAdhoc = originalRecipeId != null && originalRecipeId.startsWith('__adhoc_');
  }

  // Look up workspace.
  const wsRow = ctx.db.prepare('SELECT id, path FROM workspaces WHERE id = ?')
    .get(row.workspace_id) as { id: string; path: string } | undefined;
  if (!wsRow) throw new Error(`workspace not found: ${row.workspace_id}`);

  const result = await runRecipe({
    recipeId: isAdhoc ? null : originalRecipeId,
    recipeSnapshot: '',
    isAdhoc,
    prompt,
    spawnMode: 'interactive',
    resumeOf: row.cli_session_id,
    workspaceInfo: { id: wsRow.id, path: wsRow.path },
    agentCli: row.agent_cli,
    workspacesRoot: resolveWorkspacesRoot(),
    ws: ctx.ws,
    cfg: ctx.cfg,
  });
  if (result.spawn_error) {
    throw new Error(`${result.spawn_error.code}: ${result.spawn_error.message}`);
  }

  // Mark the old row as resumed-into the new instance for UI display.
  if (row.recipe_instance_id) {
    try { markResumedInto(ctx.db, row.recipe_instance_id, result.recipe_instance_id); }
    catch (err) { logger.warn({ err }, 'markResumedInto failed (non-fatal)'); }
  }

  // After spawn, FIFO-dispatch the prompt so the resumed copilot picks it up.
  // runRecipe's initial-prompt delivery already handles this when prompt is
  // non-empty, so we don't need a separate dispatch step.

  return { newInstanceId: result.recipe_instance_id };
}
```

- [ ] **Step 3: Implement `dispatchOnly`, `killSession`, `listSessions`**

Append to `mcp-server/src/session-helpers.ts`:
```typescript
export interface DispatchOnlyArgs {
  instance_id?: string | null;
  session_id?: string | null;
  fire_id?: string | null;
  prompt: string;
}

export type DispatchResult =
  | { ok: true; state: string }
  | { ok: false; code: 'NOT_FOUND_FIRE' | 'NO_DISPATCH_TARGET' | 'TARGET_UNAVAILABLE' | 'NO_TARGET'; message: string };

export async function dispatchOnly(
  ctx: SessionHelperCtx,
  args: DispatchOnlyArgs,
): Promise<DispatchResult> {
  let targetInstance = args.instance_id ?? null;
  if (!targetInstance && args.session_id) {
    const { resolveSessionId } = await import('./db/session-aliases-store.ts');
    const { guid } = resolveSessionId(ctx.db, args.session_id);
    targetInstance = await ctx.dispatcher.findLiveInstanceForSession(guid);
  }
  let r;
  if (targetInstance) {
    r = await ctx.dispatcher.dispatchToInstance(targetInstance, args.prompt);
  } else if (args.fire_id) {
    r = await ctx.dispatcher.dispatchToConductor(args.fire_id, args.prompt);
  } else {
    return { ok: false, code: 'NO_TARGET', message: 'instance_id, session_id, or fire_id required' };
  }
  if (r.status === 'not_found_fire')    return { ok: false, code: 'NOT_FOUND_FIRE', message: 'fire not found or not in flight' };
  if (r.status === 'no_dispatch_target') return { ok: false, code: 'NO_DISPATCH_TARGET', message: 'no dispatch target for this fire' };
  if (r.status === 'target_unavailable') return { ok: false, code: 'TARGET_UNAVAILABLE', message: 'dispatch target pty has exited' };
  return { ok: true, state: r.state };
}

export interface KillResult {
  ok: true;
  killed: boolean;
  kind: 'pty' | 'tmux' | 'foreign-tmux' | 'not_live';
}

export async function killSession(
  ctx: SessionHelperCtx,
  idOrAlias: string,
): Promise<KillResult> {
  // Resolve alias → live instance_id (if any). Otherwise treat idOrAlias as
  // raw instance_id / tmux session name (same precedence as DELETE /api/sessions/:id).
  let instanceId = idOrAlias;
  const { resolveSessionId } = await import('./db/session-aliases-store.ts');
  const { guid } = resolveSessionId(ctx.db, idOrAlias);
  const live = await ctx.dispatcher.findLiveInstanceForSession(guid);
  if (live) instanceId = live;

  const { hasSession, killPty } = await import('./pty-registry.ts');
  const { tmuxSessionRegistry } = await import('./cli-sessions/tmux-session-runtime.ts');

  // 1) clawdevbox-owned tmux session
  const owned = tmuxSessionRegistry.get(instanceId);
  if (owned) {
    try { await owned.kill(); } catch { /* best effort */ }
    return { ok: true, killed: true, kind: 'tmux' };
  }

  // 2) legacy IPty path
  if (hasSession(instanceId)) {
    const killedOk = killPty(instanceId);
    return { ok: true, killed: killedOk, kind: 'pty' };
  }

  // 3) foreign / leftover tmux
  const { spawnSync } = await import('node:child_process');
  const tmuxBin = process.platform === 'win32' ? 'tmux.exe' : 'tmux';
  const probe = spawnSync(tmuxBin, ['has-session', '-t', instanceId], {
    encoding: 'utf8', timeout: 1500, windowsHide: true,
  });
  if (probe.status === 0) {
    const r = spawnSync(tmuxBin, ['kill-session', '-t', instanceId], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    return { ok: true, killed: r.status === 0, kind: 'foreign-tmux' };
  }

  return { ok: true, killed: false, kind: 'not_live' };
}

export interface ListSessionsOpts {
  status?: 'all' | 'active' | 'archived';
  include_foreign?: boolean;
  since?: number;
  limit?: number;
}

export interface SessionListItem {
  instance_id: string;
  live: boolean;
  state: string;
  queue_depth: number;
  provider_id: string | null;
  recipe_id: string | null;
  cli_session_id: string | null;
  workspace_id: string;
  started_at: number;
  ended_at: number | null;
  kind: 'main' | 'recipe' | 'adhoc' | 'foreign';
  label: string;
  foreign?: true;
}

export interface ListSessionsResult {
  items: SessionListItem[];
  next_since?: number;
}

export async function listSessions(
  ctx: SessionHelperCtx,
  opts: ListSessionsOpts = {},
): Promise<ListSessionsResult> {
  const status = opts.status ?? 'all';
  const includeForeign = opts.include_foreign ?? true;
  const since = opts.since ?? 0;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const { listSessions: ptyListSessions, getSessionMeta } = await import('./pty-registry.ts');
  const { tmuxSessionRegistry, tmuxSessionRuntime } = await import('./cli-sessions/tmux-session-runtime.ts');
  const { listAllSessions } = await import('./db/agent-sessions-store.ts');
  const db = ctx.db;

  // 1. Legacy pty-registry live entries.
  const ptyLive = ptyListSessions();
  const liveIds = new Set(ptyLive.map((s) => s.instanceId));
  const live: SessionListItem[] = ptyLive.map((s) => {
    const meta = getSessionMeta(s.instanceId);
    return {
      instance_id: s.instanceId,
      live: true,
      state: s.exited ? 'exited' : 'unknown',
      queue_depth: 0,
      provider_id: meta?.agentCli ?? null,
      recipe_id: meta?.recipeId ?? null,
      cli_session_id: meta?.sessionId ?? null,
      workspace_id: s.workspaceId,
      started_at: meta?.startedAt ?? 0,
      ended_at: null,
      kind: 'recipe' as const,
      label: '',
    };
  });

  // 2. Tmux-backed entries (the dominant path).
  const tmuxEntries = tmuxSessionRegistry.list();
  if (tmuxEntries.length > 0) {
    const ids = tmuxEntries.map((e) => e.instanceId).filter((id) => !liveIds.has(id));
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT id, cli_session_id, recipe_instance_id, workspace_id, agent_cli,
                started_at, status_text, needs_user_input
         FROM agent_sessions
         WHERE recipe_instance_id IN (${placeholders})`,
      ).all(...ids) as Array<{
        id: string; cli_session_id: string | null; recipe_instance_id: string;
        workspace_id: string; agent_cli: string; started_at: number;
        status_text: string | null; needs_user_input: number;
      }>;
      const byInstance = new Map(rows.map((r) => [r.recipe_instance_id, r]));
      for (const e of tmuxEntries) {
        if (liveIds.has(e.instanceId)) continue;
        const row = byInstance.get(e.instanceId);
        live.push({
          instance_id: e.instanceId,
          live: true,
          state: row?.needs_user_input ? 'needs_user_input' : (row?.status_text || 'running'),
          queue_depth: 0,
          provider_id: row?.agent_cli ?? null,
          recipe_id: null,
          cli_session_id: row?.cli_session_id ?? null,
          workspace_id: row?.workspace_id ?? '',
          started_at: row?.started_at ?? 0,
          ended_at: null,
          kind: 'recipe' as const,
          label: '',
        });
        liveIds.add(e.instanceId);
      }
    }
  }

  // 3. Foreign tmux sessions — only if include_foreign.
  if (includeForeign) {
    try {
      const allTmux = await tmuxSessionRuntime().list();
      for (const s of allTmux) {
        const asInstance = s.name.startsWith('cdb_') ? s.name.slice(4) : s.name;
        if (liveIds.has(asInstance)) continue;
        live.push({
          instance_id: s.name,
          live: true,
          state: 'foreign',
          queue_depth: 0,
          provider_id: null,
          recipe_id: null,
          cli_session_id: null,
          workspace_id: '',
          started_at: 0,
          ended_at: null,
          kind: 'foreign' as const,
          label: '',
          foreign: true,
        });
        liveIds.add(s.name);
      }
    } catch { /* tmux unavailable */ }
  }

  // 4. Archived rows from agent_sessions.
  const archivedAll = listAllSessions(db, { since, limit });
  const archived: SessionListItem[] = archivedAll
    .filter((row) => !liveIds.has(row.recipe_instance_id ?? ''))
    .map((row) => ({
      instance_id: row.recipe_instance_id ?? row.id,
      live: false,
      state: 'archived',
      queue_depth: 0,
      provider_id: row.agent_cli,
      recipe_id: null,
      cli_session_id: row.cli_session_id,
      workspace_id: row.workspace_id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      kind: 'recipe' as const,
      label: '',
    }));

  // Enrich with recipe_id (label/kind).
  const archivedInstanceIds = archived.map((a) => a.instance_id).filter(Boolean);
  let recipeMap: Record<string, string> = {};
  if (archivedInstanceIds.length > 0) {
    const ph = archivedInstanceIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, recipe_id FROM recipe_instances WHERE id IN (${ph})`)
      .all(...archivedInstanceIds) as Array<{ id: string; recipe_id: string }>;
    recipeMap = Object.fromEntries(rows.map((r) => [r.id, r.recipe_id]));
  }

  const enrich = (item: SessionListItem) => {
    const isForeign = item.foreign === true;
    const recipeId = item.recipe_id ?? recipeMap[item.instance_id] ?? null;
    const kind: SessionListItem['kind'] =
      isForeign ? 'foreign'
        : item.instance_id === 'main' ? 'main'
        : (recipeId && recipeId.startsWith('__adhoc_')) ? 'adhoc'
        : 'recipe';
    const label =
      kind === 'foreign' ? `tmux: ${item.instance_id}`
        : kind === 'main' ? 'Main Agent'
        : kind === 'adhoc' ? `Spawn ${item.instance_id.slice(-8)}`
        : recipeId ?? item.instance_id;
    return { ...item, recipe_id: recipeId, kind, label };
  };

  const items: SessionListItem[] = [];
  if (status === 'all' || status === 'active') items.push(...live.map(enrich));
  if (status === 'all' || status === 'archived') items.push(...archived.map(enrich));

  const nextSince = archivedAll.length === limit && archivedAll.length > 0
    ? archivedAll[archivedAll.length - 1]!.started_at
    : undefined;

  return { items, ...(nextSince !== undefined ? { next_since: nextSince } : {}) };
}
```

- [ ] **Step 4: Implement `readScrollback` helper (pty + tmux backends)**

Append to `mcp-server/src/session-helpers.ts`:
```typescript
import { stripTuiNoise } from './agent-clis/shared.ts';

export interface ReadScrollbackArgs {
  instance_id?: string | null;
  session_id?: string | null;
  since?: string | null;
  full?: boolean;
  raw?: boolean;
}

export interface ReadScrollbackToolResult {
  instance_id: string;
  backend: 'pty' | 'tmux';
  supports_incremental: boolean;
  content: string;
  cursor: string;
  truncated_before: boolean;
  exited: boolean;
  exit_code?: number;
}

const DEFAULT_TAIL_CODE_UNITS = 32 * 1024;
const TMUX_CAPTURE_LINES_DEFAULT = 200;
const TMUX_CAPTURE_LINES_FULL = 10_000;

function parseCursor(cursor: string | null | undefined):
  { instanceId: string; spawnTs: number; offset: number } | null {
  if (!cursor) return null;
  const m = /^([^:]+):(\d+):(\d+)$/.exec(cursor);
  if (!m) return null;
  return { instanceId: m[1]!, spawnTs: Number(m[2]!), offset: Number(m[3]!) };
}

function encodeCursor(instanceId: string, spawnTs: number, offset: number): string {
  return `${instanceId}:${spawnTs}:${offset}`;
}

export type ReadScrollbackResult =
  | { ok: true; result: ReadScrollbackToolResult }
  | { ok: false; code: 'INSTANCE_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INVALID_CURSOR'; message: string };

export async function readScrollbackHelper(
  ctx: SessionHelperCtx,
  args: ReadScrollbackArgs,
): Promise<ReadScrollbackResult> {
  // Resolve instance_id.
  let instanceId = args.instance_id ?? null;
  if (!instanceId && args.session_id) {
    const { resolveSessionId } = await import('./db/session-aliases-store.ts');
    const { guid } = resolveSessionId(ctx.db, args.session_id);
    instanceId = await ctx.dispatcher.findLiveInstanceForSession(guid);
    if (!instanceId) {
      return { ok: false, code: 'SESSION_NOT_FOUND',
               message: `No live instance for session_id '${args.session_id}'` };
    }
  }
  if (!instanceId) {
    return { ok: false, code: 'INSTANCE_NOT_FOUND', message: 'instance_id or session_id required' };
  }

  // Validate cursor shape if provided. Empty/null cursors are fine.
  let parsedCursor = null;
  if (args.since) {
    parsedCursor = parseCursor(args.since);
    if (!parsedCursor) {
      return { ok: false, code: 'INVALID_CURSOR',
               message: `cursor '${args.since}' is malformed (expected <instance>:<spawn_ts>:<offset>)` };
    }
  }

  // Try pty backend first.
  const { readScrollback } = await import('./pty-registry.ts');
  const ptyResult = readScrollback(instanceId, {
    since: parsedCursor && parsedCursor.instanceId === instanceId
      ? parsedCursor.offset : 0,
  });
  if (ptyResult) {
    const truncatedBefore =
      (parsedCursor && parsedCursor.instanceId === instanceId
        && parsedCursor.spawnTs !== ptyResult.spawnTs)
      || (parsedCursor && parsedCursor.offset < ptyResult.headOffset)
      || false;

    let content = ptyResult.content;
    if (!args.full && content.length > DEFAULT_TAIL_CODE_UNITS) {
      content = content.slice(content.length - DEFAULT_TAIL_CODE_UNITS);
    }
    if (!args.raw) content = stripTuiNoise(content);
    return {
      ok: true,
      result: {
        instance_id: instanceId,
        backend: 'pty',
        supports_incremental: true,
        content,
        cursor: encodeCursor(instanceId, ptyResult.spawnTs, ptyResult.totalOffset),
        truncated_before: !!truncatedBefore,
        exited: ptyResult.exited,
        exit_code: ptyResult.exitCode,
      },
    };
  }

  // Tmux backend. Owned OR foreign — both go through capture-pane.
  const { spawnSync } = await import('node:child_process');
  const tmuxBin = process.platform === 'win32' ? 'tmux.exe' : 'tmux';
  // Owned sessions are stored as cdb_<instance>; foreign sessions use their
  // literal name. Try `cdb_<id>` first, then bare `<id>`.
  const candidates = [`cdb_${instanceId}`, instanceId];
  let tmuxName: string | null = null;
  for (const c of candidates) {
    const probe = spawnSync(tmuxBin, ['has-session', '-t', c], {
      encoding: 'utf8', timeout: 1500, windowsHide: true,
    });
    if (probe.status === 0) { tmuxName = c; break; }
  }
  if (!tmuxName) {
    return { ok: false, code: 'INSTANCE_NOT_FOUND',
             message: `no live pty or tmux session for instance_id '${instanceId}'` };
  }

  const lines = args.full ? TMUX_CAPTURE_LINES_FULL : TMUX_CAPTURE_LINES_DEFAULT;
  const cap = spawnSync(tmuxBin, [
    'capture-pane', '-p', '-t', tmuxName, '-S', `-${lines}`,
    ...(args.raw ? ['-e'] : []),
  ], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  let content = cap.stdout ?? '';
  if (!args.raw) content = stripTuiNoise(content);
  // Tmux snapshot cursor is always "fresh start" — offset 0 with current ts.
  return {
    ok: true,
    result: {
      instance_id: instanceId,
      backend: 'tmux',
      supports_incremental: false,
      content,
      cursor: encodeCursor(instanceId, Date.now(), 0),
      truncated_before: false,
      exited: false,
    },
  };
}
```

- [ ] **Step 5: Type-check the new module**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: no errors. (No tests yet — those land with the MCP tools in Task 4.)

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/session-helpers.ts
git commit -m "feat(session): extract shared spawn/dispatch/list/kill/read helpers

Single source of truth for both HTTP routes (Task 5) and MCP tools
(Task 4). Adds resume + foreign-tmux branches that the existing HTTP
handlers don't have.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: `tools/session.ts` — register the 4 MCP tools

**Files:**
- Create: `mcp-server/src/tools/session.ts`
- Modify: `mcp-server/src/server.ts`

**Rationale:** Wire the 4 helpers from Task 3 into `defineTool` calls with proper Zod schemas and descriptions. The MCP tool layer is intentionally a thin shell over the helpers.

- [ ] **Step 1: Create `tools/session.ts` skeleton**

Create `mcp-server/src/tools/session.ts`:
```typescript
/**
 * tools/session.ts
 *
 * MCP tool surface for the `session.*` namespace:
 *   - session.send: smart spawn-or-dispatch-or-resume
 *   - session.read: cursor-based scrollback (pty + tmux backends)
 *   - session.kill: terminate a live session
 *   - session.list: enumerate live + archived + foreign sessions
 *
 * Thin wrappers over `session-helpers.ts`. The helpers are shared with the
 * HTTP routes in `cron-api.ts` so the two protocols can't drift.
 */

import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { structuredError } from '../scope.ts';
import type { Workspace } from '../workspace.ts';
import { HEADER_PROJECT_DIR } from '../context-resolver.ts';
import {
  spawnDispatchOrResume,
  readScrollbackHelper,
  killSession,
  listSessions,
  type SessionHelperCtx,
} from '../session-helpers.ts';

function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower) {
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
    }
  }
  return null;
}

function projectDirFromExtra(extra: any): string | null {
  const fromHeader = readHeader(extra?.requestInfo?.headers, HEADER_PROJECT_DIR);
  return fromHeader ?? process.env.CLAWDEVBOX_PROJECT_DIR ?? null;
}

export function registerSessionEntries(ws: Workspace): void {
  // Build ctx lazily — the dispatcher and cfg are owned by start.ts.
  // We can't access them from this module at register time, so we look them
  // up via globals/late-bound getters provided by start.ts (see Step 4
  // below for how this is wired).
  const buildCtx = (): SessionHelperCtx => {
    const ctx = (globalThis as any).__clawdevboxSessionHelperCtx as SessionHelperCtx | undefined;
    if (!ctx) {
      throw new Error('session-helper context not initialized (only available inside `clawdevbox start`)');
    }
    return ctx;
  };

  // --- session.send ---------------------------------------------------------
  defineTool({
    name: 'session.send',
    description:
      'Spawn a new agent CLI session OR send a follow-up prompt to an existing one. Smart-routed via `session_id`: live → dispatch (queued FIFO); archived + provider supports resume → resume from saved jsonl + dispatch; otherwise → fresh spawn. Returns immediately; the prompt may not have been typed yet — poll `session.read`. WARNING: this can spawn unbounded sub-agents (each ~50-200 MB). Foreign tmux sessions (not spawned by clawdevbox) are read-only via this tool.',
    parameters: z.object({
      prompt: z.string().min(1).describe('The user-style message handed to the spawned/dispatched agent.'),
      session_id: z.string().min(1).optional().describe(
        "Alias or canonical GUID. If a live pty exists for this id, the prompt is dispatched to it (mode='dispatch'). If an archived agent_sessions row exists and the provider supports --resume, the session is resumed (mode='resume'). Otherwise a fresh session is spawned with this GUID (mode='spawn'). Omit to always spawn fresh with a generated GUID.",
      ),
      provider: z.string().min(1).optional().describe(
        "Agent CLI provider id (copilot, claude, agency, echo-stub). Defaults to cfg.defaultAgentCli.",
      ),
      agent: z.string().min(1).optional().describe(
        "Persona name passed as --agent to the CLI (e.g. 'dev-buddy:dev-buddy').",
      ),
      model: z.string().min(1).optional().describe('LLM model override passed as --model.'),
      workspace_id: z.string().min(1).optional().describe('Existing workspace id to run in.'),
      workspace_path: z.string().min(1).optional().describe(
        "Absolute path. If the workspace doesn't exist yet, it's created. Defaults to the calling agent's project dir (X-Clawdevbox-Project-Dir header).",
      ),
    }),
    handler: async (args, extra) => {
      const ctx = buildCtx();
      const result = await spawnDispatchOrResume(ctx, {
        prompt: args.prompt,
        session_id: args.session_id ?? null,
        provider: args.provider ?? null,
        agent: args.agent ?? null,
        model: args.model ?? null,
        workspace_id: args.workspace_id ?? null,
        workspace_path: args.workspace_path ?? null,
        default_workspace_path: projectDirFromExtra(extra),
      });
      if (!result.ok) return structuredError(result.code, result.message, result.details ?? {});
      return {
        content: [{
          type: 'text',
          text: `${result.mode === 'spawn' ? 'Spawned' : result.mode === 'resume' ? 'Resumed' : 'Dispatched to'} ${result.instance_id} (session ${result.session_id}${result.session_alias ? `, alias ${result.session_alias}` : ''})`,
        }],
        structuredContent: result,
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- session.read ---------------------------------------------------------
  defineTool({
    name: 'session.read',
    description:
      "Read terminal scrollback for a session. Pass a `cursor` from a prior call as `since` to get only new content (backend='pty' supports true incremental reads; backend='tmux' returns a snapshot each call — supports_incremental=false). ANSI/TUI escape sequences are stripped by default; pass `raw: true` to preserve them. Default returns the last ~32 KB; pass `full: true` for the whole buffer.",
    parameters: z.object({
      instance_id: z.string().min(1).optional().describe(
        "Pty/tmux instance id. EITHER this OR session_id is required.",
      ),
      session_id: z.string().min(1).optional().describe(
        "Alias/GUID resolved to the current live instance.",
      ),
      since: z.string().min(1).optional().describe(
        "Opaque cursor from a prior call. Use to get only new content. Default: read from current position.",
      ),
      full: z.boolean().optional().describe(
        "When true, return the entire buffer (capped by backend). Default: last ~32 KB tail.",
      ),
      raw: z.boolean().optional().describe(
        "When true, preserve raw ANSI/TUI escape sequences. Default: strip via stripTuiNoise.",
      ),
    }),
    handler: async (args) => {
      const ctx = buildCtx();
      const r = await readScrollbackHelper(ctx, {
        instance_id: args.instance_id ?? null,
        session_id: args.session_id ?? null,
        since: args.since ?? null,
        full: !!args.full,
        raw: !!args.raw,
      });
      if (!r.ok) return structuredError(r.code, r.message);
      return {
        content: [{ type: 'text', text: r.result.content || '(empty)' }],
        structuredContent: r.result,
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- session.kill ---------------------------------------------------------
  defineTool({
    name: 'session.kill',
    description:
      'Terminate a live session. Tries (in order): legacy pty, clawdevbox-owned tmux, foreign tmux. Returns `{ kind, killed }`. Idempotent: a session that was already dead returns `kind: "not_live"`.',
    parameters: z.object({
      instance_id: z.string().min(1).optional(),
      session_id: z.string().min(1).optional(),
    }).refine(
      (v) => !!(v.instance_id || v.session_id),
      { message: 'one of instance_id or session_id is required' },
    ),
    handler: async (args) => {
      const ctx = buildCtx();
      const key = args.instance_id ?? args.session_id!;
      const r = await killSession(ctx, key);
      return {
        content: [{
          type: 'text',
          text: r.kind === 'not_live'
            ? `Session ${key} was not live.`
            : `Killed ${key} (${r.kind}).`,
        }],
        structuredContent: r,
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- session.list ---------------------------------------------------------
  defineTool({
    name: 'session.list',
    description:
      'Enumerate sessions: live (clawdevbox-owned), archived (from agent_sessions), and foreign tmux (set include_foreign=false to exclude). Returns the same shape as GET /api/sessions.',
    parameters: z.object({
      status: z.enum(['all', 'active', 'archived']).optional().describe("Default: 'active'."),
      include_foreign: z.boolean().optional().describe(
        "Include foreign tmux sessions (user-spawned, not by clawdevbox). Default: true.",
      ),
      since: z.number().int().nonnegative().optional().describe('Epoch ms for archived pagination.'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50, max 200.'),
    }),
    handler: async (args) => {
      const ctx = buildCtx();
      const r = await listSessions(ctx, {
        status: args.status ?? 'active',
        include_foreign: args.include_foreign ?? true,
        since: args.since,
        limit: args.limit,
      });
      return {
        content: [{ type: 'text', text: `Found ${r.items.length} session(s).` }],
        structuredContent: r,
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
```

- [ ] **Step 2: Wire `registerSessionEntries` into `server.ts`**

Open `mcp-server/src/server.ts`. Find the `registerAllBuiltinEntries(ws)` function (around line 55). Add:

```typescript
import { registerSessionEntries } from './tools/session.ts';
```

…to the imports near the top, and inside `registerAllBuiltinEntries`, before the last entry registration, add:

```typescript
  registerSessionEntries(ws);
```

- [ ] **Step 3: Late-bind the helper context in `start.ts`**

`tools/session.ts` reads `globalThis.__clawdevboxSessionHelperCtx` at tool-call time because the helpers need `db + dispatcher + ws + cfg` — values that don't exist when `buildServer()` runs (those are owned by `runStart`).

Open `mcp-server/src/cli/start.ts`. Find where `dispatcher` is constructed (search for `new Dispatcher(`). Immediately AFTER the dispatcher is constructed AND `cfg` is in scope (also `opened.db` and `ws`), add:

```typescript
  // Late-bind the session-helper context so MCP tools in tools/session.ts
  // can access dispatcher + db + cfg + ws at call time (they're registered
  // during buildServer(), before these values exist).
  (globalThis as Record<string, unknown>).__clawdevboxSessionHelperCtx = {
    db: opened.db,
    dispatcher,
    ws,
    cfg,
  };
```

(If the variable names differ in start.ts — verify by reading `mcp-server/src/cli/start.ts` around the dispatcher construction site. Match what's actually in scope.)

- [ ] **Step 4: Type-check**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Smoke test — tool appears in `list_tools`**

Run: `cd mcp-server && npm run build`
Then start clawdevbox in a fresh temp workspace (use the helper from Task 6's setup) and probe `/mcp`:
```bash
curl -s -X POST http://127.0.0.1:5201/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```
Then `tools/call` for `list_tools` filtered by `session`:
```bash
# (after initialize; reuse the session-id from response headers)
curl -s -X POST http://127.0.0.1:5201/mcp \
  -H 'content-type: application/json' -H 'mcp-session-id: <id>' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tools","arguments":{"filter":"session"}}}'
```
Expected: response includes `session.send`, `session.read`, `session.kill`, `session.list`.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/tools/session.ts mcp-server/src/server.ts mcp-server/src/cli/start.ts
git commit -m "feat(tools): register session.* MCP tools (send/read/kill/list)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Refactor `cron-api.ts` to call shared helpers

**Files:**
- Modify: `mcp-server/src/cli/cron-api.ts`

**Rationale:** Delete the inline bodies of `POST /spawn`, `POST /dispatch`, `GET /api/sessions`, and `DELETE /api/sessions/:id` and delegate to the new helpers. This removes ~300 lines of duplication and guarantees the HTTP path and MCP path stay in sync.

- [ ] **Step 1: Replace `POST /dispatch` body**

In `mcp-server/src/cli/cron-api.ts`, locate the `/dispatch` handler (currently lines ~186-213). Replace the body inside the `if (path === '/dispatch')` block (after the prompt validation) with:

```typescript
    const { dispatchOnly } = await import('../session-helpers.ts');
    const helperCtx = {
      db: ctx.db,
      dispatcher: ctx.dispatcher,
      ws: ctx.ws!,
      cfg: (ctx as any).cfg ?? null as any,  // cfg may not be in CronApiContext; see Step 4
    };
    const result = await dispatchOnly(helperCtx, {
      prompt: body.prompt,
      instance_id: typeof body.instance_id === 'string' ? body.instance_id : null,
      session_id: null,
      fire_id: fireId,
    });
    if (!result.ok) {
      const httpStatus =
        result.code === 'NOT_FOUND_FIRE' ? 404 :
        result.code === 'NO_DISPATCH_TARGET' ? 404 :
        result.code === 'TARGET_UNAVAILABLE' ? 404 :
        400;
      sendJson(res, httpStatus, { error: result.message, code: result.code, fire_id: fireId });
      return true;
    }
    sendJson(res, 200, { ok: true, queued_at: Date.now(), state: result.state });
    return true;
```

- [ ] **Step 2: Replace `POST /spawn` body**

Replace the body inside `if (path === '/spawn')` (currently lines ~234-305) after the prompt validation with:

```typescript
    const { spawnDispatchOrResume } = await import('../session-helpers.ts');
    const helperCtx = {
      db: ctx.db,
      dispatcher: ctx.dispatcher,
      ws: ctx.ws!,
      cfg: (ctx as any).cfg ?? null as any,
    };
    const result = await spawnDispatchOrResume(helperCtx, {
      prompt: body.prompt,
      session_id: typeof body.session_id === 'string' ? body.session_id : null,
      provider: typeof body.provider === 'string' ? body.provider : null,
      agent: typeof body.agent === 'string' ? body.agent : null,
      model: typeof body.model === 'string' ? body.model : null,
      workspace_id: typeof body.workspace_id === 'string' ? body.workspace_id : null,
      workspace_path: typeof body.workspace_path === 'string' ? body.workspace_path : null,
      default_workspace_path: null,  // HTTP callers must pass workspace_path explicitly
      fire_id: fireId,
    });
    if (!result.ok) {
      const httpStatus =
        result.code === 'NOT_FOUND_FIRE' ? 404 :
        result.code === 'SPAWN_FAILED' ? 500 :
        result.code === 'RESUME_FAILED' ? 500 :
        result.code === 'PROVIDER_REQUIRED' ? 400 :
        result.code === 'FOREIGN_NOT_WRITABLE' ? 403 :
        500;
      sendJson(res, httpStatus, { error: result.message, code: result.code });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      mode: result.mode,
      instance_id: result.instance_id,
      session_id: result.session_id,
      session_alias: result.session_alias ?? null,
      ...(result.state ? { state: result.state } : {}),
      ...(result.resumed_from ? { resumed_from: result.resumed_from } : {}),
    });
    return true;
```

- [ ] **Step 3: Replace `GET /api/sessions` body**

Replace the body of `if (path === '/api/sessions' && method === 'GET')` (currently lines ~315-494) with:

```typescript
    const { listSessions } = await import('../session-helpers.ts');
    const helperCtx = {
      db: ctx.db,
      dispatcher: ctx.dispatcher,
      ws: ctx.ws!,
      cfg: (ctx as any).cfg ?? null as any,
    };
    const result = await listSessions(helperCtx, {
      status: (url.searchParams.get('status') as 'all'|'active'|'archived') ?? 'all',
      include_foreign: url.searchParams.get('include_foreign') !== 'false',
      since: Number(url.searchParams.get('since') ?? 0) || 0,
      limit: Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200),
    });
    sendJson(res, 200, result);
    return true;
```

- [ ] **Step 4: Replace `DELETE /api/sessions/:id` body**

Find the block `if (m && method === 'DELETE')` (currently lines ~608-650). Replace the body with:

```typescript
      const { killSession } = await import('../session-helpers.ts');
      const helperCtx = {
        db: ctx.db,
        dispatcher: ctx.dispatcher,
        ws: ctx.ws!,
        cfg: (ctx as any).cfg ?? null as any,
      };
      const instanceId = decodeURIComponent(m[1]!);
      const result = await killSession(helperCtx, instanceId);
      // Preserve legacy response shape: include `reason: 'not_live'` for the
      // not-live case to maintain backward compat.
      if (result.kind === 'not_live') {
        sendJson(res, 200, { ok: true, killed: false, reason: 'not_live' });
      } else {
        sendJson(res, 200, { ok: true, killed: result.killed, kind: result.kind });
      }
      return true;
```

- [ ] **Step 5: Add `cfg` to `CronApiContext` if missing**

The helpers need `cfg` (a `ResolvedConfig`). Check `mcp-server/src/cli/cron-api.ts` `CronApiContext` interface (lines ~48-76). If `cfg?: ResolvedConfig` is not present, add it:

```typescript
import type { ResolvedConfig } from '../config.ts';

export interface CronApiContext {
  db: Database;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  dbPath: string;
  schemaVersion: number;
  service: { pid: number; port: number; started_at: number; version: string };
  expectedToken: string | null;
  ws?: Workspace;
  cfg?: ResolvedConfig;     // ← add this
  runRecipeFn?: typeof RunRecipeFn;
}
```

Then in `mcp-server/src/cli/start.ts`, find where `cronApiCtx` is constructed (search for `cronApiCtx = {`). Add `cfg,` to the object literal.

- [ ] **Step 6: Type-check**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run existing HTTP-route tests to confirm no regression**

Run: `cd mcp-server && npx tsx --test tests/spawn-endpoint.test.mjs tests/api-sessions.test.mjs tests/api-sessions-list.test.mjs tests/dispatch-endpoint.test.mjs tests/dispatch-spawn-e2e.test.mjs`
Expected: all pass. (Existing tests cover spawn, dispatch, list, kill via HTTP — they're the protection against refactor regressions.)

- [ ] **Step 8: Commit**

```bash
git add mcp-server/src/cli/cron-api.ts mcp-server/src/cli/start.ts
git commit -m "refactor(cron-api): delegate spawn/dispatch/list/kill to session-helpers

Removes ~250 lines of duplication; both HTTP routes and session.* MCP
tools now go through one implementation.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Integration tests for `tools/session.ts`

**Files:**
- Create: `mcp-server/tests/tools-session.test.mjs`

**Rationale:** End-to-end tests that call the MCP tool handlers directly (no HTTP layer), against a real DB + dispatcher + echo-stub provider. Covers the 19 cases in the spec.

- [ ] **Step 1: Write the test scaffolding**

Create `mcp-server/tests/tools-session.test.mjs`:
```javascript
/**
 * tools-session.test.mjs — integration coverage for session.send / .read /
 * .kill / .list. Uses the echo-stub provider (no real LLM, instant turns)
 * and a fresh sqlite + dispatcher per test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { spawnSync } from 'node:child_process';

import { runMigrations } from '../src/db/index.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { registerBuiltinProviders } from '../src/agent-clis/index.ts';
import { initTmuxSessionRuntime, tmuxSessionRegistry } from '../src/cli-sessions/tmux-session-runtime.ts';
import {
  spawnDispatchOrResume,
  readScrollbackHelper,
  killSession,
  listSessions,
} from '../src/session-helpers.ts';
import { clearRegistry } from '../src/tools/registry.ts';
import { registerSessionEntries } from '../src/tools/session.ts';
import { getRegistry } from '../src/tools/registry.ts';
import { _resetForTests as resetPtyRegistry } from '../src/pty-registry.ts';

function makeCfg(projectDir, globalDir) {
  return {
    projectDir, globalDir,
    defaultAgentCli: 'echo-stub',
    http: { host: '127.0.0.1', port: 0, token: null },
    tunnel: { kind: 'none', auto_start: false },
    vaults: [],
    clientSync: { mode: 'off' },
  };
}

function makeWs(projectDir, globalDir) {
  const ws = {
    projectDir, globalDir,
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
    agentCliProviders: new Map(),
  };
  registerBuiltinProviders(ws);
  return ws;
}

async function setupHarness() {
  const root = mkdtempSync(join(tmpdir(), 'cdb-tools-session-'));
  const projectDir = join(root, 'project');
  const globalDir = join(root, 'global');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(projectDir, '.mcp.json'), '{}');

  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const ws = makeWs(projectDir, globalDir);
  const cfg = makeCfg(projectDir, globalDir);
  const dispatcher = new Dispatcher(db, ws, { defaultAgentCli: 'echo-stub' });

  initTmuxSessionRuntime({ socket: null, configPath: null });

  const ctx = { db, dispatcher, ws, cfg };
  return {
    ctx,
    cleanup() {
      try { db.close(); } catch {}
      try { rmSync(root, { recursive: true, force: true }); } catch {}
      resetPtyRegistry();
      // Kill any tmux sessions we left behind.
      for (const e of tmuxSessionRegistry.list()) {
        try { spawnSync('tmux', ['kill-session', '-t', `cdb_${e.instanceId}`], { windowsHide: true, timeout: 2000 }); } catch {}
      }
    },
  };
}

// ============================================================================
// Tests
// ============================================================================
```

- [ ] **Step 2: Add the 19 test cases**

Append the test bodies. (Listed compactly here — engineer implements each as a `test('...', async () => { ... })` block following the scaffolding above.)

Test 1 — `session.send fresh spawn`:
```javascript
test('1. session.send: no session_id spawns fresh', async () => {
  const h = await setupHarness();
  try {
    const r = await spawnDispatchOrResume(h.ctx, { prompt: 'hi' });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'spawn');
    assert.ok(r.instance_id);
    assert.ok(r.session_id);
  } finally { h.cleanup(); }
});
```

Test 2 — `session.send same alias dispatches`:
```javascript
test('2. session.send: same alias second call dispatches', async () => {
  const h = await setupHarness();
  try {
    const r1 = await spawnDispatchOrResume(h.ctx, { prompt: 'first', session_id: 'alias-X' });
    assert.equal(r1.mode, 'spawn');
    const r2 = await spawnDispatchOrResume(h.ctx, { prompt: 'second', session_id: 'alias-X' });
    assert.equal(r2.mode, 'dispatch');
    assert.equal(r2.instance_id, r1.instance_id);
    assert.equal(r2.session_id, r1.session_id);
  } finally { h.cleanup(); }
});
```

Test 3 — concurrent same-alias mutex:
```javascript
test('3. session.send: 5 concurrent same-alias calls → 1 spawn + 4 dispatches', async () => {
  const h = await setupHarness();
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        spawnDispatchOrResume(h.ctx, { prompt: 'p', session_id: 'race-Y' })),
    );
    const spawns = results.filter((r) => r.ok && r.mode === 'spawn');
    const dispatches = results.filter((r) => r.ok && r.mode === 'dispatch');
    assert.equal(spawns.length, 1, `expected exactly 1 spawn, got ${spawns.length}`);
    assert.equal(dispatches.length, 4);
    // All share the same instance_id.
    const uniqueInstances = new Set(results.map((r) => r.ok && r.instance_id));
    assert.equal(uniqueInstances.size, 1);
  } finally { h.cleanup(); }
});
```

Test 4 — PROVIDER_REQUIRED:
```javascript
test('4. session.send: no provider and no default → PROVIDER_REQUIRED', async () => {
  const h = await setupHarness();
  try {
    h.ctx.cfg.defaultAgentCli = undefined;
    const r = await spawnDispatchOrResume(h.ctx, { prompt: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PROVIDER_REQUIRED');
  } finally { h.cleanup(); }
});
```

Test 5 — workspace defaulting:
```javascript
test('5. session.send: default_workspace_path used when neither id nor path given', async () => {
  const h = await setupHarness();
  try {
    const r = await spawnDispatchOrResume(h.ctx, {
      prompt: 'x',
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'spawn');
    // Verify workspace was registered for the project dir.
    const row = h.ctx.db.prepare('SELECT path FROM workspaces WHERE path = ?')
      .get(h.ctx.ws.projectDir);
    assert.ok(row, 'workspace should have been created');
  } finally { h.cleanup(); }
});
```

Tests 6-9 — readScrollback against legacy IPty:
```javascript
test('6. session.read: pty incremental cursor', async () => {
  const h = await setupHarness();
  try {
    // Use a fake pty registration so we don't need a real provider.
    const { registerPty } = await import('../src/pty-registry.ts');
    const { EventEmitter } = await import('node:events');
    const ee = new EventEmitter();
    const fakeIpty = {
      pid: 1, cols: 80, rows: 24, process: 'fake',
      onData: (cb) => { ee.on('data', cb); return { dispose: () => ee.off('data', cb) }; },
      onExit: (cb) => { ee.on('exit', cb); return { dispose: () => ee.off('exit', cb) }; },
      write: () => {}, resize: () => {}, kill: () => {},
      clear: () => {}, pause: () => {}, resume: () => {},
    };
    registerPty({ instanceId: 'fake-ptyA', workspaceId: 'w', cols: 80, rows: 24, ipty: fakeIpty });
    ee.emit('data', 'AAA');
    const r1 = await readScrollbackHelper(h.ctx, { instance_id: 'fake-ptyA' });
    assert.equal(r1.ok, true);
    assert.equal(r1.result.backend, 'pty');
    assert.equal(r1.result.content, 'AAA');
    ee.emit('data', 'BBB');
    const r2 = await readScrollbackHelper(h.ctx, { instance_id: 'fake-ptyA', since: r1.result.cursor });
    assert.equal(r2.result.content, 'BBB');
  } finally { h.cleanup(); }
});

test('7. session.read: pty truncated_before when cursor offset < head', async () => {
  // Push enough data to evict ring head, then read with old cursor.
  // Implementation parallels test 6 — see pty-registry-scrollback.test.mjs
  // for the ring-eviction pattern (5 × 64 KB chunks).
});

test('8. session.read: cursor with mismatched spawnTs → truncated_before', async () => {
  // Register, read, kill, re-register same id (different spawnTs), pass old
  // cursor — assert truncated_before true.
});

test('9. session.read: raw=false strips ANSI; raw=true preserves', async () => {
  // Emit '\x1b[31mred\x1b[0m', read with raw=false → 'red';
  // read with raw=true → original.
});
```

Test 10 — tmux backend:
```javascript
test('10. session.read: tmux backend returns snapshot + supports_incremental=false', async (t) => {
  // Skip if tmux not on PATH.
  const probe = spawnSync('tmux', ['-V'], { windowsHide: true, encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('tmux not installed');

  const h = await setupHarness();
  try {
    // Create a real tmux session named cdb_test_xyz, register in tmuxSessionRegistry.
    const name = `test_xyz_${Date.now()}`;
    spawnSync('tmux', ['new-session', '-d', '-s', `cdb_${name}`, 'sh', '-c', 'echo HELLO_TMUX && sleep 60'], { windowsHide: true });
    try {
      // Wait for content to appear.
      await new Promise((r) => setTimeout(r, 200));
      const r = await readScrollbackHelper(h.ctx, { instance_id: name });
      assert.equal(r.ok, true);
      assert.equal(r.result.backend, 'tmux');
      assert.equal(r.result.supports_incremental, false);
      assert.match(r.result.content, /HELLO_TMUX/);
    } finally {
      spawnSync('tmux', ['kill-session', '-t', `cdb_${name}`], { windowsHide: true });
    }
  } finally { h.cleanup(); }
});
```

Test 11-12 — kill paths:
```javascript
test('11. session.kill: live pty → kind=pty; second call → kind=not_live', async () => {
  const h = await setupHarness();
  try {
    const { registerPty, killPty: _kp } = await import('../src/pty-registry.ts');
    const { EventEmitter } = await import('node:events');
    const ee = new EventEmitter();
    let killed = false;
    const fakeIpty = {
      pid: 1, cols: 80, rows: 24, process: 'fake',
      onData: (cb) => { ee.on('data', cb); return { dispose: () => ee.off('data', cb) }; },
      onExit: (cb) => { ee.on('exit', cb); return { dispose: () => ee.off('exit', cb) }; },
      write: () => {}, resize: () => {},
      kill: () => { killed = true; ee.emit('exit', { exitCode: 0 }); },
      clear: () => {}, pause: () => {}, resume: () => {},
    };
    registerPty({ instanceId: 'kill-test', workspaceId: 'w', cols: 80, rows: 24, ipty: fakeIpty });
    const r1 = await killSession(h.ctx, 'kill-test');
    assert.equal(r1.kind, 'pty');
    assert.equal(r1.killed, true);
    const r2 = await killSession(h.ctx, 'kill-test');
    assert.equal(r2.kind, 'not_live');
  } finally { h.cleanup(); }
});

test('12. session.kill: live tmux → kind=tmux', async (t) => {
  // Requires tmux; skip if absent. Spawn a real session via tmuxSessionRuntime,
  // then kill via killSession, then list-sessions to confirm gone.
});
```

Test 13-14 — list filters:
```javascript
test('13. session.list: returns just-spawned sessions', async () => {
  const h = await setupHarness();
  try {
    await spawnDispatchOrResume(h.ctx, { prompt: 'x', session_id: 'L1', default_workspace_path: h.ctx.ws.projectDir });
    await spawnDispatchOrResume(h.ctx, { prompt: 'y', session_id: 'L2', default_workspace_path: h.ctx.ws.projectDir });
    const r = await listSessions(h.ctx, { status: 'active' });
    const aliases = r.items.map((i) => i.cli_session_id).filter(Boolean);
    assert.ok(aliases.length >= 2, `expected ≥2 sessions, got ${aliases.length}`);
  } finally { h.cleanup(); }
});

test('14. session.list: status=archived filter', async () => {
  const h = await setupHarness();
  try {
    const spawned = await spawnDispatchOrResume(h.ctx, { prompt: 'x', session_id: 'L3', default_workspace_path: h.ctx.ws.projectDir });
    await killSession(h.ctx, spawned.instance_id);
    // Mark the row archived (this happens naturally when the pty exits).
    // For the test we may need to force the agent_sessions row to ended_at != null.
    h.ctx.db.prepare(`UPDATE agent_sessions SET status='success', ended_at=? WHERE recipe_instance_id=?`)
      .run(Date.now(), spawned.instance_id);
    const r = await listSessions(h.ctx, { status: 'archived' });
    assert.ok(r.items.some((i) => i.instance_id === spawned.instance_id));
  } finally { h.cleanup(); }
});
```

Test 15-16 — auto-resume:
```javascript
test('15. session.send: archived copilot session auto-resumes', async (t) => {
  // Copilot binary required. Skip if absent.
  const probe = spawnSync(process.platform === 'win32' ? 'copilot.exe' : 'copilot', ['--version'], { windowsHide: true });
  if (probe.status !== 0) return t.skip('copilot CLI not installed');

  // 1. Spawn with provider='copilot', alias='resume-test'.
  // 2. Wait briefly for session to register.
  // 3. Kill the session.
  // 4. Mark row terminal in DB.
  // 5. Send again with same alias.
  // 6. Assert mode === 'resume' and resumed_from === first instance_id.
  // 7. Assert markResumedInto wrote into the old row.
});

test('16. session.send: archived echo-stub falls through to spawn', async () => {
  const h = await setupHarness();
  try {
    const r1 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'first', session_id: 'echo-resume-test',
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r1.mode, 'spawn');
    await killSession(h.ctx, r1.instance_id);
    // Force-archive
    h.ctx.db.prepare(`UPDATE agent_sessions SET status='success', ended_at=? WHERE recipe_instance_id=?`)
      .run(Date.now(), r1.instance_id);

    const r2 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'second', session_id: 'echo-resume-test',
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r2.mode, 'spawn', 'echo-stub has supportsResume=false');
    assert.notEqual(r2.instance_id, r1.instance_id);
  } finally { h.cleanup(); }
});
```

Test 17-19 — foreign tmux:
```javascript
test('17. session.list: include_foreign default true vs false', async (t) => {
  const probe = spawnSync('tmux', ['-V'], { windowsHide: true });
  if (probe.status !== 0) return t.skip('tmux not installed');
  const name = `test_foreign_${Date.now()}`;
  spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep', '120'], { windowsHide: true });
  const h = await setupHarness();
  try {
    const withForeign = await listSessions(h.ctx, { include_foreign: true });
    assert.ok(withForeign.items.some((i) => i.instance_id === name && i.kind === 'foreign'));
    const noForeign = await listSessions(h.ctx, { include_foreign: false });
    assert.ok(!noForeign.items.some((i) => i.instance_id === name));
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { windowsHide: true });
    h.cleanup();
  }
});

test('18. session.read: foreign tmux capture-pane works', async (t) => {
  const probe = spawnSync('tmux', ['-V'], { windowsHide: true });
  if (probe.status !== 0) return t.skip('tmux not installed');
  const name = `test_read_foreign_${Date.now()}`;
  spawnSync('tmux', ['new-session', '-d', '-s', name, 'sh', '-c', 'echo FOREIGN_HELLO; sleep 60'], { windowsHide: true });
  const h = await setupHarness();
  try {
    await new Promise((r) => setTimeout(r, 200));
    const r = await readScrollbackHelper(h.ctx, { instance_id: name });
    assert.equal(r.ok, true);
    assert.equal(r.result.backend, 'tmux');
    assert.match(r.result.content, /FOREIGN_HELLO/);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { windowsHide: true });
    h.cleanup();
  }
});

test('19. session.send: foreign tmux session_id → FOREIGN_NOT_WRITABLE', async (t) => {
  const probe = spawnSync('tmux', ['-V'], { windowsHide: true });
  if (probe.status !== 0) return t.skip('tmux not installed');
  const name = `test_write_foreign_${Date.now()}`;
  spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep', '60'], { windowsHide: true });
  const h = await setupHarness();
  try {
    const r = await spawnDispatchOrResume(h.ctx, {
      prompt: 'x', session_id: name,
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FOREIGN_NOT_WRITABLE');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { windowsHide: true });
    h.cleanup();
  }
});
```

- [ ] **Step 3: Implement test 7, 8, 9, 12, 15 stubs**

Tests 7, 8, 9, 12, 15 are sketched above. Flesh them out following the patterns from tests 6, 11, 10. For test 15 specifically, only run when `process.env.CLAWDEVBOX_TEST_REQUIRE_COPILOT=1` to keep CI green when copilot CLI isn't present.

- [ ] **Step 4: Run the test suite**

Run: `cd mcp-server && npx tsx --test tests/tools-session.test.mjs`
Expected: 14+ tests pass; tmux-dependent tests (10, 12, 17, 18, 19) skip if tmux not on PATH; test 15 skips if copilot not on PATH. ZERO failures.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/tests/tools-session.test.mjs
git commit -m "test(session): 19 integration tests for session.* MCP tools

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: Live end-to-end smoke + acceptance criteria

**Files:**
- No new files; this is the end-to-end acceptance pass against a live clawdevbox.

**Rationale:** The acceptance criterion in the spec is that an agent in the Terminals tab can do the full spawn → read → dispatch → kill → resume cycle. This task verifies that.

- [ ] **Step 1: Build and start clawdevbox in a fresh workspace**

```bash
cd C:/git/clawdevbox/mcp-server && npm run build
$env:NODE_OPTIONS = "--max-old-space-size=8192 --heapsnapshot-near-heap-limit=2"
npx clawdevbox start
# Wait for: "Press Ctrl+C to stop."
```

- [ ] **Step 2: Confirm tools are visible in MCP**

Open the Terminals tab in the browser, click the Main Agent. From the main agent prompt:
```
/run_tool list_tools {"filter":"session"}
```
Expected: returns 4 entries — `session.send`, `session.read`, `session.kill`, `session.list`.

- [ ] **Step 3: Full lifecycle**

In the main agent terminal, drive each tool in sequence:
```
/run_tool session.send {"prompt":"reply with only: HELLO_E2E","session_id":"e2e-test","provider":"copilot"}
```
Expected: response has `mode: 'spawn'`, an `instance_id`, `session_id: '...'`, `session_alias: 'e2e-test'`. The new session appears in the Terminals tab.

Poll:
```
/run_tool session.read {"session_id":"e2e-test"}
```
Repeat ~5× until `content` contains `HELLO_E2E`.

Dispatch a follow-up:
```
/run_tool session.send {"prompt":"reply with only: BYE_E2E","session_id":"e2e-test"}
```
Expected: `mode: 'dispatch'`. Poll `session.read` again; eventually see `BYE_E2E`.

Kill:
```
/run_tool session.kill {"session_id":"e2e-test"}
```
Expected: `killed: true`, `kind: 'tmux'`. Session disappears from Terminals (or moves to Recent).

Resume:
```
/run_tool session.send {"prompt":"reply with only: WELCOME_BACK","session_id":"e2e-test"}
```
Expected: `mode: 'resume'`, `resumed_from` matches the previous instance_id, new instance_id is different. Poll `session.read` until `WELCOME_BACK` appears.

- [ ] **Step 4: Verify no regressions in existing flows**

In the Terminals tab:
- Confirm the SPA list still loads `/api/sessions`.
- Click a recipe session's "Kill" button — confirm DELETE `/api/sessions/:id` still works.
- Click "Resume" on an archived row — confirm `/api/sessions/:id/resume` still works.

- [ ] **Step 5: Run the full test suite one more time**

```bash
cd C:/git/clawdevbox/mcp-server
npm test 2>&1 | Select-String -Pattern "^# (tests|pass|fail)" | Select-Object -First 5
```
Expected: pass count > pre-PR baseline (tools-session + async-mutex + pty-registry-scrollback add coverage); no NEW failures vs the pre-PR baseline (pre-existing flakes are OK).

- [ ] **Step 6: Final commit + tag**

```bash
git add -A
git status
# Verify nothing unexpected
git commit --allow-empty -m "feat(session): session.* MCP tools — e2e verified

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Acceptance criteria checklist

Mirrors spec §"Acceptance criteria". All must be checked:

- [ ] All 19 tests in `tools-session.test.mjs` pass (or skip on missing dependency).
- [ ] All 4 mutex tests + 6 readScrollback tests pass.
- [ ] `npm run build` succeeds, `npx tsc --noEmit` is clean.
- [ ] `list_tools filter=session` returns exactly 4 entries.
- [ ] Live e2e cycle (spawn → read → dispatch → read → kill → resume → read) succeeds in a real Copilot-CLI session.
- [ ] HTTP regression: `tests/spawn-endpoint.test.mjs`, `tests/api-sessions*.test.mjs`, `tests/dispatch-*.test.mjs` all pass after the cron-api refactor.
- [ ] No new `npm test` failures relative to baseline (`485 pass / 20 fail` on main before this PR).


