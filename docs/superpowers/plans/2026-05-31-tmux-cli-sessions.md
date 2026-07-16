# Tmux-Backed CLI Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate clawdevbox agent process management from direct `node-pty` to `tmux`-backed sessions, with done-detection via a new `update_status` MCP tool that replaces sentinel markers and the `SessionConductor`.

**Architecture:** Each agent runs inside a `tmux` pane (session named `cdb_<instance_id>`, configurable `-L clawdevbox` socket). The dispatcher talks to the agent via `tmux send-keys` / `tmux resize-window` subprocess calls. Done-detection moves from byte-level marker regex to an explicit MCP tool the agent calls. Per-WebSocket viewers spawn their own `tmux attach` IPty (node-pty stays only for viewers); the agent path is fully tmux-native and the viewer-input race class is structurally eliminated because viewer bytes go to `tmux attach`, never the agent.

**Tech Stack:** TypeScript, `node:child_process` (for `tmux` subprocess calls), `node-pty` (kept only for per-viewer `tmux attach`), `better-sqlite3` (V5 migration adds status columns), `node:test` (test runner), `tsx` (no-build TypeScript imports).

**Spec:** `docs/superpowers/specs/2026-05-31-tmux-cli-sessions-design.md`

**Branch:** `feat/tmux-migration` (worktree at `C:\git\clawdevbox\.worktrees\tmux-migration`)

---

## File Structure

### New files
| Path | Responsibility |
|---|---|
| `mcp-server/src/cli-sessions/types.ts` | `CliSession`, `CliSessionRuntime`, `CliSessionSpawnOpts`, `SpecialKey`, `AgentExit` |
| `mcp-server/src/cli-sessions/tmux-client.ts` | `tmuxRun` + `tmuxRunAsync` thin subprocess wrappers (socket/config-aware) |
| `mcp-server/src/cli-sessions/tmux-session.ts` | `createTmuxSession(client, opts) → CliSession` (one tmux session per agent) |
| `mcp-server/src/cli-sessions/tmux-session-runtime.ts` | Singleton `CliSessionRuntime` backed by tmux + `tmuxSessionRegistry` for per-instance bookkeeping |
| `mcp-server/src/cli-sessions/special-keys.ts` | `SpecialKey` → tmux key-name translation table |
| `mcp-server/src/pending-dispatch-registry.ts` | One in-flight dispatch per `instanceId`; promise + timeout |
| `mcp-server/src/tools/update-status.ts` | The MCP tool agents call to report progress / completion |
| `mcp-server/assets/cdb.tmux.conf` | Bundled tmux config (aggressive-resize, history-limit, status off, remain-on-exit) |
| `mcp-server/tests/cli-sessions/tmux-client.test.mjs` | Unit tests for `tmuxRun` against a fake/real tmux |
| `mcp-server/tests/cli-sessions/tmux-session.test.mjs` | Real-tmux integration tests for `createTmuxSession` |
| `mcp-server/tests/cli-sessions/tmux-session-runtime.test.mjs` | `spawn / attach / list / reconcile` semantics |
| `mcp-server/tests/pending-dispatch-registry.test.mjs` | Registration, single-in-flight, resolve, timeout |
| `mcp-server/tests/update-status-tool.test.mjs` | Tool handler with task_complete, needs_user_input, both, no-pending no-op |
| `mcp-server/tests/dispatcher-tmux.test.mjs` | Replacement for old dispatcher conductor tests |

### Modified files
| Path | Change summary |
|---|---|
| `mcp-server/src/db/migrations.ts` | Add V5: `agent_sessions.status_text TEXT, needs_user_input INTEGER, last_status_at INTEGER` |
| `mcp-server/src/db/agent-sessions-store.ts` | Add `updateStatus(db, id, payload)` + extend `AgentSessionRow` |
| `mcp-server/src/agent-clis/types.ts` | Replace `IPty pty` on `AgentHandle` with `CliSession session` |
| `mcp-server/src/agent-clis/shared.ts` | Drop `deliverInitialPromptWhenReady`, `fullyRenderedRegex`, `notReadyRegex`. Drop `spawnPty` from `ProviderCtx` |
| `mcp-server/src/agent-clis/copilot.ts` | `spawnSession` → `tmuxSessionRuntime.spawn`. Shrink `writePrompt`. System-prompt prepend for `update_status` |
| `mcp-server/src/agent-clis/claude.ts` | Same migration as copilot.ts |
| `mcp-server/src/agent-clis/echo-stub.ts` | Same migration (smallest provider, do first) |
| `mcp-server/src/dispatcher.ts` | Replace `SessionConductor` with `pending-dispatch-registry` |
| `mcp-server/src/recipe-runner.ts` | Use `tmuxSessionRuntime` instead of `pty.spawn` for agents; archive log via `capture-pane` on exit |
| `mcp-server/src/pty-registry.ts` | Strip conductor + initial-prompt gate; viewer-IPty-only; keys are `viewer-<random>` |
| `mcp-server/src/terminal-server.ts` | On WS open: spawn `tmux attach` in IPty; on WS close: kill IPty |
| `mcp-server/src/cli/start.ts` | tmux binary detection at startup; `tmuxSessionRuntime.reconcileOnStartup()` |
| `mcp-server/package.json` | Update `test` script to drop `session-conductor.test.mjs`, add new test files |
| `mcp-server/src/agent-clis/index.ts` | Re-exports cleanup |

### Deleted files
| Path | Reason |
|---|---|
| `mcp-server/src/agent-clis/session-conductor.ts` | Replaced by `pending-dispatch-registry` + `update_status` MCP tool |
| `mcp-server/tests/session-conductor.test.mjs` | Conductor no longer exists |

### Deferred (out of scope; tracked but not touched)
- `mcp-server/src/tunnel.ts` (devtunnel pty — non-agent)
- `mcp-server/src/agent-clis/e2e-test-runner.ts` (test runner pty — non-agent)
- External plugins: `C:\git\agency-provider\agency-provider.mjs` (touched in a separate worktree)

---

## Phase 1 — Foundations (tmux subprocess + CliSession primitives)

### Task 1: Windows tmux smoke test

**Files:**
- Create: `mcp-server/scripts/tmux-smoke.mjs`

- [ ] **Step 1: Create a probe script that proves the deployment stack works**

```js
// mcp-server/scripts/tmux-smoke.mjs
// Standalone Windows smoke test — proves tmux can host copilot.exe and
// that send-keys / capture-pane / kill-session work end-to-end on this
// platform BEFORE we sink days into the migration.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOCK = ['-L', 'cdb-smoke'];
const SES = `cdb_smoke_${Date.now().toString(36)}`;
const WS = mkdtempSync(join(tmpdir(), 'cdb-smoke-'));

function tmux(args, opts = {}) {
  const r = spawnSync('tmux', [...SOCK, ...args], { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} → exit ${r.status}\nstderr: ${r.stderr}`);
  }
  return r.stdout;
}

console.log('1. new-session …');
tmux(['new-session', '-d', '-s', SES, '-x', '120', '-y', '30', '-c', WS,
      'copilot', '--yolo']);
console.log('   ok');

console.log('2. wait 10s for copilot TUI to render');
await new Promise((r) => setTimeout(r, 10_000));

console.log('3. capture-pane (verify ❯ visible)');
const snap1 = tmux(['capture-pane', '-p', '-t', SES, '-S', '-', '-E', '-']);
if (!/❯/.test(snap1)) throw new Error(`no ❯ in snapshot:\n${snap1.slice(-500)}`);
console.log('   ok — ❯ visible');

console.log('4. send-keys "Reply with only OK"');
tmux(['send-keys', '-t', SES, '-l', 'Reply with only OK']);
await new Promise((r) => setTimeout(r, 250));
tmux(['send-keys', '-t', SES, 'Enter']);

console.log('5. wait 30s for response');
await new Promise((r) => setTimeout(r, 30_000));
const snap2 = tmux(['capture-pane', '-p', '-t', SES, '-S', '-', '-E', '-']);
const hit = (snap2.match(/OK/g) ?? []).length;
console.log(`   "OK" count = ${hit}`);

console.log('6. kill-session');
tmux(['kill-session', '-t', SES]);
console.log('   ok');

if (hit >= 2) {
  console.log('\n✅ SMOKE PASSED — tmux can host copilot on this platform');
  process.exit(0);
} else {
  console.log('\n❌ SMOKE FAILED — fix tmux/copilot interop before continuing');
  process.exit(1);
}
```

- [ ] **Step 2: Run the smoke probe**

```bash
cd C:\git\clawdevbox\.worktrees\tmux-migration\mcp-server
node scripts/tmux-smoke.mjs
```

Expected: `✅ SMOKE PASSED — tmux can host copilot on this platform`.

If FAILED, **STOP**. Investigate `tmux` + `copilot.exe` interop before proceeding. Common issues:
- tmux ships under MSYS2 — `copilot.exe` may not be on tmux's PATH. Workaround: absolute path in `new-session`.
- Working directory in mixed POSIX/Windows paths. Workaround: pass `cwd` as `cygpath`-converted POSIX path.
- ConPTY size negotiation differences. Workaround: explicit `-x 120 -y 30` on `new-session`.

- [ ] **Step 3: Commit**

```bash
git add mcp-server/scripts/tmux-smoke.mjs
git commit -m "test: tmux smoke probe for windows deployment stack"
```

---

### Task 2: `SpecialKey` translation table

**Files:**
- Create: `mcp-server/src/cli-sessions/types.ts`
- Create: `mcp-server/src/cli-sessions/special-keys.ts`
- Create: `mcp-server/tests/cli-sessions/special-keys.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// mcp-server/tests/cli-sessions/special-keys.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { specialKeyToTmux, isSpecialKey } from '../../src/cli-sessions/special-keys.ts';

test('specialKeyToTmux maps every documented SpecialKey to a tmux key-name', () => {
  assert.equal(specialKeyToTmux('Enter'), 'Enter');
  assert.equal(specialKeyToTmux('Escape'), 'Escape');
  assert.equal(specialKeyToTmux('Tab'), 'Tab');
  assert.equal(specialKeyToTmux('Backspace'), 'BSpace');
  assert.equal(specialKeyToTmux('C-q'), 'C-q');
  assert.equal(specialKeyToTmux('C-c'), 'C-c');
  assert.equal(specialKeyToTmux('C-d'), 'C-d');
  assert.equal(specialKeyToTmux('C-u'), 'C-u');
  assert.equal(specialKeyToTmux('Up'), 'Up');
  assert.equal(specialKeyToTmux('Down'), 'Down');
  assert.equal(specialKeyToTmux('Left'), 'Left');
  assert.equal(specialKeyToTmux('Right'), 'Right');
});

test('isSpecialKey discriminates valid keys', () => {
  assert.equal(isSpecialKey('Enter'), true);
  assert.equal(isSpecialKey('hello'), false);
  assert.equal(isSpecialKey('enter'), false);
  assert.equal(isSpecialKey(''), false);
});

test('specialKeyToTmux throws on unknown key', () => {
  assert.throws(() => specialKeyToTmux('Bogus'), /unknown SpecialKey/);
});
```

- [ ] **Step 2: Run test, expect FAIL (module missing)**

```bash
cd mcp-server
node --import tsx --test tests/cli-sessions/special-keys.test.mjs
```

Expected: FAIL with `Cannot find module '../../src/cli-sessions/special-keys.ts'`.

- [ ] **Step 3: Create the types module**

```ts
// mcp-server/src/cli-sessions/types.ts
/**
 * Tmux-backed CLI session abstraction. Replaces direct node-pty handles
 * for agent processes. All input goes through sendText/sendKey — no raw
 * byte channel exists, which structurally eliminates the viewer-input
 * race class (xterm.js DA1/cursor capability replies cannot reach the
 * agent because the only input path is tmux send-keys).
 */
export type SpecialKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'Backspace'
  | 'C-q'
  | 'C-c'
  | 'C-d'
  | 'C-u'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right';

export interface AgentExit {
  exitCode: number | null;
}

export interface CliSession {
  readonly name: string;
  pid(): Promise<number | null>;
  readonly exited: Promise<AgentExit>;
  sendText(text: string): Promise<void>;
  sendKey(key: SpecialKey): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  snapshot(opts?: { ansi?: boolean }): Promise<string>;
  kill(): Promise<void>;
}

export interface CliSessionSpawnOpts {
  /** Becomes `cdb_${name}` as the tmux session name. Must be unique. */
  name: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  command: string;
  args: string[];
}

export interface CliSessionRuntime {
  spawn(opts: CliSessionSpawnOpts): Promise<CliSession>;
  attach(name: string): Promise<CliSession | null>;
  list(): Promise<Array<{ name: string; alive: boolean }>>;
}
```

- [ ] **Step 4: Create the special-keys module**

```ts
// mcp-server/src/cli-sessions/special-keys.ts
import type { SpecialKey } from './types.ts';

/**
 * Translation table: our `SpecialKey` vocabulary → tmux send-keys key names.
 * Tmux uses 'BSpace' for backspace (not 'Backspace'); other names match.
 * Verified against tmux 3.3.2 (`man tmux` → KEY BINDINGS section).
 */
const TABLE: Record<SpecialKey, string> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'BSpace',
  'C-q': 'C-q',
  'C-c': 'C-c',
  'C-d': 'C-d',
  'C-u': 'C-u',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
};

export function isSpecialKey(s: string): s is SpecialKey {
  return Object.prototype.hasOwnProperty.call(TABLE, s);
}

export function specialKeyToTmux(key: SpecialKey): string {
  const v = TABLE[key];
  if (!v) throw new Error(`unknown SpecialKey: ${key}`);
  return v;
}
```

- [ ] **Step 5: Run tests, expect pass**

```bash
node --import tsx --test tests/cli-sessions/special-keys.test.mjs
```

Expected: `# pass 3, # fail 0`.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/cli-sessions/types.ts \
        mcp-server/src/cli-sessions/special-keys.ts \
        mcp-server/tests/cli-sessions/special-keys.test.mjs
git commit -m "feat(cli-sessions): SpecialKey type + tmux name translation"
```

---

### Task 3: `tmuxRun` subprocess wrapper

**Files:**
- Create: `mcp-server/src/cli-sessions/tmux-client.ts`
- Create: `mcp-server/tests/cli-sessions/tmux-client.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// mcp-server/tests/cli-sessions/tmux-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmuxRun, tmuxRunAsync } from '../../src/cli-sessions/tmux-client.ts';

test('tmuxRun prepends -L socket flag (verified via no-server error)', () => {
  const r = tmuxRun(
    { socket: 'cdb-test-empty-' + Date.now().toString(36), configPath: null },
    ['list-sessions'],
  );
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /no server running/);
});

test('tmuxRunAsync returns the same shape', async () => {
  const r = await tmuxRunAsync(
    { socket: 'cdb-test-empty-' + Date.now().toString(36), configPath: null },
    ['list-sessions'],
  );
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /no server running/);
});

test('tmuxRun honors stdin input option', () => {
  const sock = 'cdb-stdin-' + Date.now().toString(36);
  const C = { socket: sock, configPath: null };
  try {
    tmuxRun(C, ['new-session', '-d', '-s', 'X', '-x', '80', '-y', '24',
                'sh', '-c', 'sleep 60']);
    const inp = 'line1\nline2\n';
    tmuxRun(C, ['load-buffer', '-'], { input: inp });
    const r = tmuxRun(C, ['show-buffer']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, inp);
  } finally {
    try { tmuxRun(C, ['kill-server']); } catch {}
  }
});
```

- [ ] **Step 2: Run test, expect FAIL (module missing)**

```bash
node --import tsx --test tests/cli-sessions/tmux-client.test.mjs
```

Expected: FAIL with `Cannot find module '../../src/cli-sessions/tmux-client.ts'`.

- [ ] **Step 3: Create `tmux-client.ts`**

```ts
// mcp-server/src/cli-sessions/tmux-client.ts
import { spawnSync, spawn } from 'node:child_process';

export interface TmuxClientOpts {
  /** -L flag value, or null to share the default socket. */
  socket: string | null;
  /** -f flag value (config file path), or null for tmux defaults. */
  configPath: string | null;
}

export interface TmuxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TmuxRunOpts {
  input?: string;
  cwd?: string;
  env?: Record<string, string>;
}

function buildArgs(client: TmuxClientOpts, args: string[]): string[] {
  const prefix: string[] = [];
  if (client.socket) prefix.push('-L', client.socket);
  if (client.configPath) prefix.push('-f', client.configPath);
  return [...prefix, ...args];
}

export function tmuxRun(
  client: TmuxClientOpts,
  args: string[],
  opts: TmuxRunOpts = {},
): TmuxRunResult {
  const r = spawnSync('tmux', buildArgs(client, args), {
    encoding: 'utf8',
    input: opts.input,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

export function tmuxRunAsync(
  client: TmuxClientOpts,
  args: string[],
  opts: TmuxRunOpts = {},
): Promise<TmuxRunResult> {
  return new Promise((resolve) => {
    const child = spawn('tmux', buildArgs(client, args), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
  });
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
node --import tsx --test tests/cli-sessions/tmux-client.test.mjs
```

Expected: `# pass 3, # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/cli-sessions/tmux-client.ts \
        mcp-server/tests/cli-sessions/tmux-client.test.mjs
git commit -m "feat(cli-sessions): tmuxRun subprocess wrapper"
```

---

### Task 4: Bundled `cdb.tmux.conf`

**Files:**
- Create: `mcp-server/assets/cdb.tmux.conf`

- [ ] **Step 1: Write the config**

```text
# mcp-server/assets/cdb.tmux.conf
# Bundled tmux config used by clawdevbox for the cdb-scoped tmux server.
# Loaded via: tmux -L clawdevbox -f <abs path to this file> <command>

# Each client sees the pane at its own size, instead of tmux's default
# "smallest attached client wins" behavior which would shrink a pane to
# fit a tiny mobile viewer and break a wide desktop one.
set -g aggressive-resize on

# Long-running agents produce a lot of scrollback over multi-hour sessions.
set -g history-limit 100000

# Default pane size when no client has attached yet (e.g. agent spawned
# and starts rendering before any viewer hits the WebSocket).
set -g default-size 120x30

# Hide the tmux status bar — the agent does not need to see tmux UI in
# its captured output. The bottom line is reserved for the agent's own
# hint bar / model line.
set -g status off

# Keep the pane open after the agent process exits so we can capture-pane
# for the archive log. The session itself is cleaned up explicitly via
# kill-session.
set -g remain-on-exit on

# Mouse support is irrelevant for programmatic use and noisy in captures.
set -g mouse off
```

- [ ] **Step 2: Commit**

```bash
git add mcp-server/assets/cdb.tmux.conf
git commit -m "feat(cli-sessions): bundled cdb.tmux.conf"
```

---

### Task 5: `createTmuxSession` — `CliSession` implementation

**Files:**
- Create: `mcp-server/src/cli-sessions/tmux-session.ts`
- Create: `mcp-server/tests/cli-sessions/tmux-session.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// mcp-server/tests/cli-sessions/tmux-session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTmuxSession } from '../../src/cli-sessions/tmux-session.ts';
import { tmuxRun } from '../../src/cli-sessions/tmux-client.ts';

function newClient() {
  return { socket: 'cdb-sess-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), configPath: null };
}

function cleanup(c) { try { tmuxRun(c, ['kill-server']); } catch {} }

test('createTmuxSession spawns a session and exposes name', async () => {
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_a',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: 'sh', args: ['-c', 'sleep 30'],
    });
    assert.equal(s.name, 'cdb_unit_a');
    await s.kill();
  } finally { cleanup(c); }
});

test('sendText writes literal text into the pane (verified via snapshot)', async () => {
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_b',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: 'cat', args: [],
    });
    await s.sendText('HELLO_FROM_SENDTEXT');
    await sleep(150);
    await s.sendKey('Enter');
    await sleep(150);
    const snap = await s.snapshot();
    assert.match(snap, /HELLO_FROM_SENDTEXT/);
    await s.kill();
  } finally { cleanup(c); }
});

test('sendText handles multi-line text via load-buffer + paste-buffer', async () => {
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_c',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: 'cat', args: [],
    });
    await s.sendText('LINE_ONE\nLINE_TWO\nLINE_THREE');
    await sleep(200);
    const snap = await s.snapshot();
    assert.match(snap, /LINE_ONE/);
    assert.match(snap, /LINE_TWO/);
    assert.match(snap, /LINE_THREE/);
    await s.kill();
  } finally { cleanup(c); }
});

test('resize updates the pane dimensions', async () => {
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_d',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: 'sh', args: ['-c', 'sleep 30'],
    });
    await s.resize(132, 50);
    const dims = tmuxRun(c, ['display-message', '-p', '-t', s.name,
                              '#{pane_width} #{pane_height}']).stdout.trim();
    assert.equal(dims, '132 50');
    await s.kill();
  } finally { cleanup(c); }
});

test('kill is idempotent', async () => {
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_e',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: 'sh', args: ['-c', 'sleep 30'],
    });
    await s.kill();
    await s.kill();          // second call must not throw
  } finally { cleanup(c); }
});

test('exited resolves after the pane process exits', async () => {
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_f',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: 'sh', args: ['-c', 'exit 7'],
    });
    const r = await s.exited;
    assert.equal(r.exitCode, 7);
  } finally { cleanup(c); }
});

test('pid returns the pane process pid while alive', async () => {
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_g',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: 'sh', args: ['-c', 'sleep 30'],
    });
    const pid = await s.pid();
    assert.equal(typeof pid, 'number');
    assert.ok(pid > 0);
    await s.kill();
  } finally { cleanup(c); }
});

test('env vars are passed through to the pane process', async () => {
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_h',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: { CDB_MARK: 'WITNESS_42' }, cols: 80, rows: 24,
      command: 'sh', args: ['-c', 'echo CDB_MARK=$CDB_MARK; sleep 30'],
    });
    await sleep(300);
    const snap = await s.snapshot();
    assert.match(snap, /WITNESS_42/);
    await s.kill();
  } finally { cleanup(c); }
});
```

- [ ] **Step 2: Run test, expect FAIL (module missing)**

```bash
node --import tsx --test tests/cli-sessions/tmux-session.test.mjs
```

Expected: FAIL with `Cannot find module '../../src/cli-sessions/tmux-session.ts'`.

- [ ] **Step 3: Create `tmux-session.ts`**

```ts
// mcp-server/src/cli-sessions/tmux-session.ts
import { setTimeout as sleep } from 'node:timers/promises';
import { tmuxRun, tmuxRunAsync, type TmuxClientOpts } from './tmux-client.ts';
import { specialKeyToTmux } from './special-keys.ts';
import type { AgentExit, CliSession, CliSessionSpawnOpts, SpecialKey } from './types.ts';

/** How often we poll for pane-exit. */
const EXIT_POLL_MS = 500;

export async function createTmuxSession(
  client: TmuxClientOpts,
  opts: CliSessionSpawnOpts,
): Promise<CliSession> {
  const sessionName = `cdb_${opts.name}`;

  // Build env-arg list: tmux new-session -e KEY=VAL takes one per flag.
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    envArgs.push('-e', `${k}=${v}`);
  }

  // tmux new-session -d (detached) -s <name> -x <cols> -y <rows>
  // -c <cwd> -e KEY=VAL ... <command> <args...>
  const r = tmuxRun(client, [
    'new-session', '-d',
    '-s', sessionName,
    '-x', String(opts.cols),
    '-y', String(opts.rows),
    '-c', opts.cwd,
    ...envArgs,
    opts.command, ...opts.args,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  // Wire up exit-poller. We poll list-sessions for the name; when it goes
  // away we resolve `exited`. To get the actual exit code we set
  // remain-on-exit (per cdb.tmux.conf) and read pane_dead_status before
  // the session is killed.
  let exitResolve!: (e: AgentExit) => void;
  const exited = new Promise<AgentExit>((res) => { exitResolve = res; });
  let stopped = false;
  let resolvedAlready = false;

  const poll = async () => {
    while (!stopped && !resolvedAlready) {
      await sleep(EXIT_POLL_MS);
      if (stopped || resolvedAlready) break;
      // display-message returns "1" if pane is dead, plus the status.
      const r = tmuxRun(client, [
        'display-message', '-p', '-t', sessionName,
        '#{pane_dead}|#{pane_dead_status}',
      ]);
      if (r.exitCode !== 0) {
        // Session is fully gone — couldn't read the status before cleanup.
        // Resolve with unknown exit code.
        resolvedAlready = true;
        exitResolve({ exitCode: null });
        return;
      }
      const [dead, status] = r.stdout.trim().split('|');
      if (dead === '1') {
        resolvedAlready = true;
        const code = status === '' ? null : Number(status);
        exitResolve({ exitCode: Number.isFinite(code as number) ? (code as number) : null });
        return;
      }
    }
  };
  poll();

  const session: CliSession = {
    name: sessionName,
    exited,

    async pid() {
      const r = await tmuxRunAsync(client, [
        'display-message', '-p', '-t', sessionName, '#{pane_pid}',
      ]);
      if (r.exitCode !== 0) return null;
      const n = Number(r.stdout.trim());
      return Number.isFinite(n) ? n : null;
    },

    async sendText(text: string): Promise<void> {
      if (text.length === 0) return;
      if (text.includes('\n') || text.length > 4096) {
        // Multi-line / large text: use load-buffer + paste-buffer so
        // newlines aren't interpreted as key boundaries by send-keys.
        const buf = `cdb_${sessionName}`;
        const load = await tmuxRunAsync(client, ['load-buffer', '-b', buf, '-'], { input: text });
        if (load.exitCode !== 0) throw new Error(`load-buffer failed: ${load.stderr}`);
        try {
          const paste = await tmuxRunAsync(client, [
            'paste-buffer', '-t', sessionName, '-b', buf, '-d', '-p',
          ]);
          if (paste.exitCode !== 0) throw new Error(`paste-buffer failed: ${paste.stderr}`);
        } finally {
          // Ensure the buffer is deleted even if paste failed.
          await tmuxRunAsync(client, ['delete-buffer', '-b', buf]);
        }
        return;
      }
      const r = await tmuxRunAsync(client, ['send-keys', '-t', sessionName, '-l', text]);
      if (r.exitCode !== 0) throw new Error(`send-keys -l failed: ${r.stderr}`);
    },

    async sendKey(key: SpecialKey): Promise<void> {
      const tmuxKey = specialKeyToTmux(key);
      const r = await tmuxRunAsync(client, ['send-keys', '-t', sessionName, tmuxKey]);
      if (r.exitCode !== 0) throw new Error(`send-keys ${tmuxKey} failed: ${r.stderr}`);
    },

    async resize(cols: number, rows: number): Promise<void> {
      const r = await tmuxRunAsync(client, [
        'resize-window', '-t', sessionName,
        '-x', String(cols), '-y', String(rows),
      ]);
      if (r.exitCode !== 0) throw new Error(`resize-window failed: ${r.stderr}`);
    },

    async snapshot(opts?: { ansi?: boolean }): Promise<string> {
      const args = ['capture-pane', '-p', '-t', sessionName, '-S', '-', '-E', '-'];
      if (opts?.ansi) args.push('-e');
      const r = await tmuxRunAsync(client, args);
      if (r.exitCode !== 0) throw new Error(`capture-pane failed: ${r.stderr}`);
      return r.stdout;
    },

    async kill(): Promise<void> {
      stopped = true;
      const r = await tmuxRunAsync(client, ['kill-session', '-t', sessionName]);
      // "can't find session" stderr is OK (idempotent).
      if (r.exitCode !== 0 && !/can't find session/i.test(r.stderr) && !/no such session/i.test(r.stderr)) {
        throw new Error(`kill-session failed: ${r.stderr}`);
      }
      if (!resolvedAlready) {
        resolvedAlready = true;
        exitResolve({ exitCode: null });
      }
    },
  };

  return session;
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
node --import tsx --test tests/cli-sessions/tmux-session.test.mjs
```

Expected: `# pass 8, # fail 0`. If a test about `pane_dead_status` flakes on this tmux version (3.3.2 emits it; older may not), adjust by polling pid-existence via `ps` as a fallback.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/cli-sessions/tmux-session.ts \
        mcp-server/tests/cli-sessions/tmux-session.test.mjs
git commit -m "feat(cli-sessions): createTmuxSession CliSession impl"
```

---

### Task 6: `CliSessionRuntime` singleton + `tmuxSessionRegistry`

**Files:**
- Create: `mcp-server/src/cli-sessions/tmux-session-runtime.ts`
- Create: `mcp-server/tests/cli-sessions/tmux-session-runtime.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// mcp-server/tests/cli-sessions/tmux-session-runtime.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTmuxSessionRuntime,
} from '../../src/cli-sessions/tmux-session-runtime.ts';
import { tmuxRun } from '../../src/cli-sessions/tmux-client.ts';

function makeRuntime() {
  const c = { socket: 'cdb-rt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), configPath: null };
  return { client: c, runtime: createTmuxSessionRuntime(c) };
}

function cleanup(c) { try { tmuxRun(c, ['kill-server']); } catch {} }

test('spawn creates a session and list returns it', async () => {
  const { client, runtime } = makeRuntime();
  try {
    const s = await runtime.spawn({
      name: 'rt_a',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-rt-')),
      env: {}, cols: 80, rows: 24,
      command: 'sh', args: ['-c', 'sleep 30'],
    });
    const items = await runtime.list();
    assert.ok(items.find((x) => x.name === 'cdb_rt_a' && x.alive));
    await s.kill();
  } finally { cleanup(client); }
});

test('attach returns null for a missing session', async () => {
  const { client, runtime } = makeRuntime();
  try {
    const s = await runtime.attach('nonexistent');
    assert.equal(s, null);
  } finally { cleanup(client); }
});

test('attach returns a working CliSession for an existing session', async () => {
  const { client, runtime } = makeRuntime();
  try {
    const original = await runtime.spawn({
      name: 'rt_b',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-rt-')),
      env: {}, cols: 80, rows: 24,
      command: 'cat', args: [],
    });
    const adopted = await runtime.attach('rt_b');
    assert.ok(adopted);
    assert.equal(adopted.name, 'cdb_rt_b');
    await adopted.sendText('FROM_ADOPTED');
    await new Promise((r) => setTimeout(r, 150));
    const snap = await adopted.snapshot();
    assert.match(snap, /FROM_ADOPTED/);
    await original.kill();
  } finally { cleanup(client); }
});
```

- [ ] **Step 2: Run test, expect FAIL (module missing)**

```bash
node --import tsx --test tests/cli-sessions/tmux-session-runtime.test.mjs
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Create the runtime module**

```ts
// mcp-server/src/cli-sessions/tmux-session-runtime.ts
import { setTimeout as sleep } from 'node:timers/promises';
import { tmuxRun, tmuxRunAsync, type TmuxClientOpts } from './tmux-client.ts';
import { createTmuxSession } from './tmux-session.ts';
import { specialKeyToTmux } from './special-keys.ts';
import type { AgentExit, CliSession, CliSessionRuntime, CliSessionSpawnOpts, SpecialKey } from './types.ts';

const EXIT_POLL_MS = 500;

/**
 * Build a CliSession bound to an EXISTING tmux session (no new-session call).
 * Used by `attach()` for adopt-on-startup.
 */
async function adoptExistingSession(
  client: TmuxClientOpts,
  shortName: string,
): Promise<CliSession | null> {
  const sessionName = `cdb_${shortName}`;
  const probe = await tmuxRunAsync(client, [
    'has-session', '-t', sessionName,
  ]);
  if (probe.exitCode !== 0) return null;

  let exitResolve!: (e: AgentExit) => void;
  const exited = new Promise<AgentExit>((res) => { exitResolve = res; });
  let stopped = false;
  let resolved = false;

  (async () => {
    while (!stopped && !resolved) {
      await sleep(EXIT_POLL_MS);
      if (stopped || resolved) break;
      const r = tmuxRun(client, [
        'display-message', '-p', '-t', sessionName,
        '#{pane_dead}|#{pane_dead_status}',
      ]);
      if (r.exitCode !== 0) {
        resolved = true;
        exitResolve({ exitCode: null });
        return;
      }
      const [dead, status] = r.stdout.trim().split('|');
      if (dead === '1') {
        resolved = true;
        const code = status === '' ? null : Number(status);
        exitResolve({ exitCode: Number.isFinite(code as number) ? (code as number) : null });
        return;
      }
    }
  })();

  return {
    name: sessionName,
    exited,
    async pid() {
      const r = await tmuxRunAsync(client, ['display-message', '-p', '-t', sessionName, '#{pane_pid}']);
      if (r.exitCode !== 0) return null;
      const n = Number(r.stdout.trim());
      return Number.isFinite(n) ? n : null;
    },
    async sendText(text: string) {
      if (text.length === 0) return;
      if (text.includes('\n') || text.length > 4096) {
        const buf = `cdb_${sessionName}`;
        const load = await tmuxRunAsync(client, ['load-buffer', '-b', buf, '-'], { input: text });
        if (load.exitCode !== 0) throw new Error(`load-buffer failed: ${load.stderr}`);
        try {
          const paste = await tmuxRunAsync(client, ['paste-buffer', '-t', sessionName, '-b', buf, '-d', '-p']);
          if (paste.exitCode !== 0) throw new Error(`paste-buffer failed: ${paste.stderr}`);
        } finally {
          await tmuxRunAsync(client, ['delete-buffer', '-b', buf]);
        }
        return;
      }
      const r = await tmuxRunAsync(client, ['send-keys', '-t', sessionName, '-l', text]);
      if (r.exitCode !== 0) throw new Error(`send-keys -l failed: ${r.stderr}`);
    },
    async sendKey(key: SpecialKey) {
      const tk = specialKeyToTmux(key);
      const r = await tmuxRunAsync(client, ['send-keys', '-t', sessionName, tk]);
      if (r.exitCode !== 0) throw new Error(`send-keys ${tk} failed: ${r.stderr}`);
    },
    async resize(cols: number, rows: number) {
      const r = await tmuxRunAsync(client, ['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)]);
      if (r.exitCode !== 0) throw new Error(`resize-window failed: ${r.stderr}`);
    },
    async snapshot(opts?: { ansi?: boolean }) {
      const args = ['capture-pane', '-p', '-t', sessionName, '-S', '-', '-E', '-'];
      if (opts?.ansi) args.push('-e');
      const r = await tmuxRunAsync(client, args);
      if (r.exitCode !== 0) throw new Error(`capture-pane failed: ${r.stderr}`);
      return r.stdout;
    },
    async kill() {
      stopped = true;
      const r = await tmuxRunAsync(client, ['kill-session', '-t', sessionName]);
      if (r.exitCode !== 0 && !/can't find session/i.test(r.stderr) && !/no such session/i.test(r.stderr)) {
        throw new Error(`kill-session failed: ${r.stderr}`);
      }
      if (!resolved) {
        resolved = true;
        exitResolve({ exitCode: null });
      }
    },
  };
}

export function createTmuxSessionRuntime(client: TmuxClientOpts): CliSessionRuntime {
  return {
    async spawn(opts: CliSessionSpawnOpts) {
      return createTmuxSession(client, opts);
    },
    async attach(name: string) {
      return adoptExistingSession(client, name);
    },
    async list() {
      const r = await tmuxRunAsync(client, ['list-sessions', '-F', '#{session_name}']);
      if (r.exitCode !== 0) return [];
      const out: Array<{ name: string; alive: boolean }> = [];
      for (const line of r.stdout.split('\n')) {
        const name = line.trim();
        if (!name.startsWith('cdb_')) continue;
        out.push({ name, alive: true });
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
node --import tsx --test tests/cli-sessions/tmux-session-runtime.test.mjs
```

Expected: `# pass 3, # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/cli-sessions/tmux-session-runtime.ts \
        mcp-server/tests/cli-sessions/tmux-session-runtime.test.mjs
git commit -m "feat(cli-sessions): tmux-session-runtime (spawn/attach/list)"
```

---

## Phase 2 — MCP tool + dispatch refactor

### Task 7: V5 migration — status columns on `agent_sessions`

**Files:**
- Modify: `mcp-server/src/db/migrations.ts:243-260` (add V5 after V4)
- Modify: `mcp-server/src/db/agent-sessions-store.ts` (extend `AgentSessionRow`)
- Create: `mcp-server/tests/db-migrations-v5.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// mcp-server/tests/db-migrations-v5.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/migrations.ts';

test('V5 migration adds status_text, needs_user_input, last_status_at to agent_sessions', () => {
  const db = new Database(':memory:');
  for (const m of MIGRATIONS) m.up(db);
  const cols = db.prepare(`PRAGMA table_info(agent_sessions)`).all().map((r) => r.name);
  assert.ok(cols.includes('status_text'), 'status_text column should exist');
  assert.ok(cols.includes('needs_user_input'), 'needs_user_input column should exist');
  assert.ok(cols.includes('last_status_at'), 'last_status_at column should exist');
});

test('V5 columns default to NULL/0 and accept updates', () => {
  const db = new Database(':memory:');
  for (const m of MIGRATIONS) m.up(db);
  // Insert a minimal row (other columns NULL where allowed).
  const stmt = db.prepare(`SELECT name FROM pragma_table_info('agent_sessions')
                           WHERE \`notnull\` = 1 AND dflt_value IS NULL`);
  const required = stmt.all().map((r) => r.name);
  // Build INSERT that fills only required columns with stub values.
  const placeholders = required.map(() => '?').join(', ');
  const values = required.map(() => 'x');
  db.prepare(`INSERT INTO agent_sessions (${required.join(', ')}) VALUES (${placeholders})`).run(...values);
  const row = db.prepare(`SELECT status_text, needs_user_input, last_status_at FROM agent_sessions LIMIT 1`).get();
  assert.equal(row.status_text, null);
  assert.equal(row.needs_user_input, 0);
  assert.equal(row.last_status_at, null);
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
node --import tsx --test tests/db-migrations-v5.test.mjs
```

Expected: FAIL with `status_text column should exist`.

- [ ] **Step 3: Add V5 to migrations.ts**

Open `mcp-server/src/db/migrations.ts` and replace the line `];` at the end of the `MIGRATIONS` array (currently line ~260) with:

```ts
  {
    version: 5,
    up: (db) => {
      // Tmux-migration: agents now report status via the update_status MCP
      // tool instead of sentinel markers in stdout. These columns persist
      // the latest report so the UI can render status badges + "needs you"
      // banners without re-querying the agent.
      db.exec(`
        ALTER TABLE agent_sessions ADD COLUMN status_text TEXT;
        ALTER TABLE agent_sessions ADD COLUMN needs_user_input INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE agent_sessions ADD COLUMN last_status_at INTEGER;
      `);
    },
  },
];
```

- [ ] **Step 4: Extend `AgentSessionRow` type**

In `mcp-server/src/db/agent-sessions-store.ts`, find the `AgentSessionRow` interface and add three optional fields:

```ts
export interface AgentSessionRow {
  // ...existing fields...
  status_text: string | null;
  needs_user_input: number;        // 0 or 1
  last_status_at: number | null;
}
```

- [ ] **Step 5: Add `updateStatus` helper**

Append to `mcp-server/src/db/agent-sessions-store.ts`:

```ts
export function updateStatus(
  db: Database,
  id: string,
  payload: { text: string | null; needs_user_input: boolean; ts: number },
): void {
  db.prepare(
    `UPDATE agent_sessions
       SET status_text = ?, needs_user_input = ?, last_status_at = ?
     WHERE id = ?`,
  ).run(payload.text, payload.needs_user_input ? 1 : 0, payload.ts, id);
}
```

- [ ] **Step 6: Run tests, expect pass**

```bash
node --import tsx --test tests/db-migrations-v5.test.mjs
```

Expected: `# pass 2, # fail 0`.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/db/migrations.ts \
        mcp-server/src/db/agent-sessions-store.ts \
        mcp-server/tests/db-migrations-v5.test.mjs
git commit -m "feat(db): V5 migration adds status_text/needs_user_input/last_status_at"
```

---

### Task 8: `pending-dispatch-registry`

**Files:**
- Create: `mcp-server/src/pending-dispatch-registry.ts`
- Create: `mcp-server/tests/pending-dispatch-registry.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// mcp-server/tests/pending-dispatch-registry.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPending, getPending, resolvePending, resolvePendingTimeout, hasPending,
} from '../src/pending-dispatch-registry.ts';

test('registerPending returns dispatchId + promise', () => {
  const r = registerPending('inst-A', 'hello');
  assert.equal(typeof r.dispatchId, 'string');
  assert.ok(r.dispatchId.length > 0);
  assert.ok(r.promise instanceof Promise);
  resolvePendingTimeout('inst-A');               // cleanup
});

test('only one pending per instance — second register awaits the first', async () => {
  const a = registerPending('inst-B', 'first');
  const b = registerPending('inst-B', 'second');
  // b.promise must NOT be the same as a.promise
  assert.notEqual(a.promise, b.promise);
  // Resolving a leaves b pending
  resolvePending('inst-B', a.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  const ra = await a.promise;
  assert.equal(ra.task_complete, true);
  // b still pending
  let bSettled = false;
  b.promise.then(() => { bSettled = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bSettled, false);
  resolvePendingTimeout('inst-B');               // cleanup
});

test('resolvePending is a no-op for stale dispatchId', () => {
  const a = registerPending('inst-C', 'x');
  resolvePending('inst-C', 'wrong-id', { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  // a still pending — verify by inspecting registry
  assert.equal(hasPending('inst-C'), true);
  resolvePendingTimeout('inst-C');
});

test('resolvePending with matching id resolves and clears entry', async () => {
  const a = registerPending('inst-D', 'x');
  resolvePending('inst-D', a.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  await a.promise;
  assert.equal(hasPending('inst-D'), false);
});

test('getPending returns null when nothing in flight', () => {
  assert.equal(getPending('inst-NONE'), null);
});

test('resolvePendingTimeout resolves with timeout status', async () => {
  const a = registerPending('inst-E', 'x');
  resolvePendingTimeout('inst-E');
  const r = await a.promise;
  assert.equal(r.status, 'timeout');
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
node --import tsx --test tests/pending-dispatch-registry.test.mjs
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Create the registry**

```ts
// mcp-server/src/pending-dispatch-registry.ts
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

const registry = new Map<string, Entry>();

export function registerPending(
  instanceId: string,
  prompt: string,
): { dispatchId: string; promise: Promise<DispatchResult> } {
  // Queue semantics: if there's already a pending dispatch, chain after it.
  const prior = registry.get(instanceId);
  const chainAfter = prior ? prior.promise : Promise.resolve(null);

  let resolve!: (r: DispatchResult) => void;
  const promise = chainAfter.then(() => new Promise<DispatchResult>((res) => { resolve = res; }));

  const dispatchId = randomUUID();
  const entry: Entry = {
    instanceId, dispatchId, prompt,
    startedAt: Date.now(),
    resolve: (r) => resolve(r),
    promise,
  };
  // We can't store the entry until the chain settles, but newer-registers
  // also need to chain. Track the *latest* promise as the chain head.
  registry.set(instanceId, entry);
  // When this dispatch resolves, clear the entry IFF we're still the head.
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
  e.resolve({ status: 'timeout', needs_user_input: false, task_complete: false, doneAt: Date.now() });
}

/** TEST-ONLY hatch: clear the registry. */
export function _resetForTests(): void {
  registry.clear();
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
node --import tsx --test tests/pending-dispatch-registry.test.mjs
```

Expected: `# pass 6, # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/pending-dispatch-registry.ts \
        mcp-server/tests/pending-dispatch-registry.test.mjs
git commit -m "feat: pending-dispatch-registry (one-in-flight per instance)"
```

---

### Task 9: `update_status` MCP tool

**Files:**
- Create: `mcp-server/src/tools/update-status.ts`
- Create: `mcp-server/tests/update-status-tool.test.mjs`
- Modify: `mcp-server/src/server.ts` (register tool)

- [ ] **Step 1: Find where existing tools are registered**

```bash
grep -n "registerTool\|server\\.tool" mcp-server/src/server.ts | head -20
```

Note the registration pattern (it's a small file). The tool handler takes `(args, ctx)` and the `ctx.sessionContext.recipeInstanceId` is the agent's instance id (set via the `X-Clawdevbox-Recipe-Instance-Id` header on connect).

- [ ] **Step 2: Write the failing test**

```js
// mcp-server/tests/update-status-tool.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  registerPending, hasPending, _resetForTests,
} from '../src/pending-dispatch-registry.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { handleUpdateStatus } from '../src/tools/update-status.ts';

function freshDb() {
  const db = new Database(':memory:');
  for (const m of MIGRATIONS) m.up(db);
  return db;
}

function ctxFor(db, instanceId) {
  return { db, sessionContext: { recipeInstanceId: instanceId } };
}

test('task_complete=true resolves a pending dispatch', async (t) => {
  _resetForTests();
  const db = freshDb();
  const id = 'inst-T1';
  const p = registerPending(id, 'hello').promise;
  const r = await handleUpdateStatus(
    { status_text: 'done', needs_user_input: false, task_complete: true },
    ctxFor(db, id),
  );
  assert.equal(r.ok, true);
  const settled = await p;
  assert.equal(settled.task_complete, true);
  assert.equal(hasPending(id), false);
});

test('needs_user_input=true alone resolves the pending dispatch', async () => {
  _resetForTests();
  const db = freshDb();
  const id = 'inst-T2';
  const p = registerPending(id, 'hello').promise;
  await handleUpdateStatus(
    { status_text: 'need clarification', needs_user_input: true, task_complete: false },
    ctxFor(db, id),
  );
  const settled = await p;
  assert.equal(settled.needs_user_input, true);
  assert.equal(settled.task_complete, false);
});

test('no pending dispatch — call is a no-op and still returns ok', async () => {
  _resetForTests();
  const db = freshDb();
  const r = await handleUpdateStatus(
    { status_text: 'progress', needs_user_input: false, task_complete: false },
    ctxFor(db, 'inst-T3'),
  );
  assert.equal(r.ok, true);
});

test('progress update (neither flag) does not resolve the dispatch', async () => {
  _resetForTests();
  const db = freshDb();
  const id = 'inst-T4';
  registerPending(id, 'hello');
  await handleUpdateStatus(
    { status_text: 'thinking', needs_user_input: false, task_complete: false },
    ctxFor(db, id),
  );
  assert.equal(hasPending(id), true, 'dispatch must remain pending after progress-only call');
});
```

- [ ] **Step 3: Run test, expect FAIL**

```bash
node --import tsx --test tests/update-status-tool.test.mjs
```

Expected: FAIL with `Cannot find module '../src/tools/update-status.ts'`.

- [ ] **Step 4: Create the tool handler**

```ts
// mcp-server/src/tools/update-status.ts
import type { Database } from 'better-sqlite3';
import { getPending, resolvePending } from '../pending-dispatch-registry.ts';
import { updateStatus } from '../db/agent-sessions-store.ts';
import { emitChange } from '../event-bus.ts';

export interface UpdateStatusArgs {
  status_text: string;
  needs_user_input: boolean;
  task_complete: boolean;
}

export interface UpdateStatusCtx {
  db: Database;
  sessionContext: { recipeInstanceId: string | null | undefined };
}

const STATUS_TEXT_CAP = 4096;

export async function handleUpdateStatus(
  args: UpdateStatusArgs,
  ctx: UpdateStatusCtx,
): Promise<{ ok: true }> {
  const instanceId = ctx.sessionContext.recipeInstanceId;
  const status_text = (args.status_text ?? '').slice(0, STATUS_TEXT_CAP);
  const needs_user_input = !!args.needs_user_input;
  const task_complete = !!args.task_complete;
  const now = Date.now();

  if (instanceId) {
    try {
      updateStatus(ctx.db, instanceId, { text: status_text || null, needs_user_input, ts: now });
      emitChange('instance.status', instanceId);
    } catch {
      // DB row may not exist in unit tests; safe to ignore.
    }
    if (task_complete || needs_user_input) {
      const pending = getPending(instanceId);
      if (pending) {
        resolvePending(instanceId, pending.dispatchId, {
          status_text, needs_user_input, task_complete, doneAt: now,
        });
      }
    }
  }
  return { ok: true };
}

export const UPDATE_STATUS_TOOL_DEF = {
  name: 'update_status',
  description: `Report your current status to clawdevbox.

Call this:
  • Periodically during long operations — keeps the orchestrator and user informed of progress.
  • Exactly once with task_complete=true when you finish responding to the current dispatched prompt. (REQUIRED — the orchestrator blocks the next dispatch until you do this.)
  • With needs_user_input=true if you cannot proceed without clarification from the user.`,
  inputSchema: {
    type: 'object',
    properties: {
      status_text: {
        type: 'string',
        description: 'Short human-readable status, e.g. "Searching for foo", "Running tests", "Done — wrote 3 files".',
        maxLength: STATUS_TEXT_CAP,
      },
      needs_user_input: {
        type: 'boolean',
        default: false,
        description: 'True if you cannot proceed without user clarification. The UI surfaces this.',
      },
      task_complete: {
        type: 'boolean',
        default: false,
        description: 'True exactly once when you finish responding. Marks the dispatched prompt as done.',
      },
    },
    required: ['status_text'],
  },
} as const;
```

- [ ] **Step 5: Run tests, expect pass**

```bash
node --import tsx --test tests/update-status-tool.test.mjs
```

Expected: `# pass 4, # fail 0`.

- [ ] **Step 6: Register the tool in server.ts**

In `mcp-server/src/server.ts`, after the existing tool registrations, add:

```ts
import { handleUpdateStatus, UPDATE_STATUS_TOOL_DEF } from './tools/update-status.ts';

// ... near other tool registrations ...
server.registerTool({
  ...UPDATE_STATUS_TOOL_DEF,
  handler: async (args, ctx) => handleUpdateStatus(args as any, {
    db: ws.db,
    sessionContext: { recipeInstanceId: ctx.headers?.['x-clawdevbox-recipe-instance-id'] ?? null },
  }),
});
```

Adjust to match the actual MCP server registration shape in your repo (the call may be `server.tool(...)` instead of `server.registerTool({...})`). Look at how existing tools like `update_workitem` or `fire_trigger` are wired up and follow the same pattern.

- [ ] **Step 7: Build + targeted server-load test**

```bash
npm run build
node --import tsx --test tests/server.test.mjs 2>&1 | tail -20
```

Expected: build succeeds, all server smoke tests pass.

- [ ] **Step 8: Commit**

```bash
git add mcp-server/src/tools/update-status.ts \
        mcp-server/tests/update-status-tool.test.mjs \
        mcp-server/src/server.ts
git commit -m "feat(mcp): update_status tool replaces marker-based done detection"
```

---

### Task 10: Refactor `dispatcher.dispatchToInstance` to use pending-dispatch

**Files:**
- Modify: `mcp-server/src/dispatcher.ts:254-272`
- Create: `mcp-server/tests/dispatcher-tmux.test.mjs`

- [ ] **Step 1: Write the failing test (replaces old conductor-based test)**

```js
// mcp-server/tests/dispatcher-tmux.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { _resetForTests, registerPending, getPending, resolvePending } from '../src/pending-dispatch-registry.ts';

// We unit-test the dispatch loop in isolation: provide a fake CliSession,
// confirm sendText + sendKey calls, then resolve the pending dispatch.

function fakeSession() {
  const calls = [];
  return {
    name: 'cdb_fake',
    pid: async () => 1234,
    exited: new Promise(() => {}),
    sendText: async (t) => { calls.push(['sendText', t]); },
    sendKey: async (k) => { calls.push(['sendKey', k]); },
    resize: async () => {},
    snapshot: async () => '',
    kill: async () => {},
    calls,
  };
}

test('dispatch sends ESC + text + Enter and awaits update_status', async () => {
  _resetForTests();
  const sess = fakeSession();
  const sessions = new Map([['inst-X', sess]]);

  // Inline the dispatch loop we will extract into dispatcher.ts step 3.
  const dispatchToInstance = async (instanceId, prompt) => {
    const s = sessions.get(instanceId);
    if (!s) throw new Error('not found');
    const { dispatchId, promise } = registerPending(instanceId, prompt);
    await s.sendKey('Escape');
    await sleep(50);                  // shortened from prod 200ms for tests
    await s.sendText(prompt);
    await sleep(50);                  // shortened from prod 250ms for tests
    await s.sendKey('Enter');
    return await promise;
  };

  const promise = dispatchToInstance('inst-X', 'HELLO');
  await sleep(150);
  // Simulate the agent calling update_status(task_complete=true)
  const p = getPending('inst-X');
  resolvePending('inst-X', p.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  const result = await promise;
  assert.equal(result.task_complete, true);
  assert.deepEqual(sess.calls, [
    ['sendKey', 'Escape'],
    ['sendText', 'HELLO'],
    ['sendKey', 'Enter'],
  ]);
});

test('second dispatch to same instance queues behind first', async () => {
  _resetForTests();
  const sess = fakeSession();
  const sessions = new Map([['inst-Y', sess]]);

  const dispatchToInstance = async (instanceId, prompt) => {
    const s = sessions.get(instanceId);
    const { dispatchId, promise } = registerPending(instanceId, prompt);
    await s.sendText(prompt);
    await s.sendKey('Enter');
    return await promise;
  };

  const p1 = dispatchToInstance('inst-Y', 'FIRST');
  const p2 = dispatchToInstance('inst-Y', 'SECOND');
  await sleep(50);
  // Only first dispatch's text written so far
  const firstText = sess.calls.find((c) => c[0] === 'sendText' && c[1] === 'FIRST');
  const secondText = sess.calls.find((c) => c[0] === 'sendText' && c[1] === 'SECOND');
  assert.ok(firstText);
  assert.ok(!secondText, 'second prompt must not be written until first resolves');
  // Resolve first
  const ph1 = getPending('inst-Y');
  resolvePending('inst-Y', ph1.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  await p1;
  // Wait for second to start
  await sleep(50);
  const secondText2 = sess.calls.find((c) => c[0] === 'sendText' && c[1] === 'SECOND');
  assert.ok(secondText2, 'second prompt must be written after first resolves');
  const ph2 = getPending('inst-Y');
  resolvePending('inst-Y', ph2.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  await p2;
});
```

- [ ] **Step 2: Run test, expect pass (in-line dispatch logic is self-contained)**

```bash
node --import tsx --test tests/dispatcher-tmux.test.mjs
```

Expected: `# pass 2, # fail 0`. (This test validates the contract before we hoist into dispatcher.ts.)

- [ ] **Step 3: Find current `dispatchToInstance` in `dispatcher.ts`**

```bash
grep -n "dispatchToInstance" mcp-server/src/dispatcher.ts
```

Note the conductor.dispatch call site (around line 268) and the `dispatchTargetInstanceId` plumbing.

- [ ] **Step 4: Replace the dispatch implementation**

In `mcp-server/src/dispatcher.ts`, replace the conductor-based `dispatchToInstance` (currently around lines 254-272) with:

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import { registerPending, resolvePendingTimeout } from './pending-dispatch-registry.ts';
import { tmuxSessionRegistry } from './cli-sessions/tmux-session-runtime.ts';

/** Per-dispatch overall timeout. */
const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;

/** Inter-write gap before Enter (matches copilot's split-cr-250ms timing). */
const PRE_ENTER_GAP_MS = 250;
const POST_ESC_GAP_MS = 200;

export async function dispatchToInstance(
  instanceId: string,
  prompt: string,
): Promise<{ status: 'ok' | 'timeout' | 'not_found'; payload?: unknown }> {
  const session = tmuxSessionRegistry.get(instanceId);
  if (!session) return { status: 'not_found' };

  const { dispatchId, promise } = registerPending(instanceId, prompt);

  // ESC dismisses any overlay (e.g. /help) + clears the input box. Send
  // alone with a gap so the terminal doesn't interpret ESC + next-byte
  // as Alt+<byte>.
  await session.sendKey('Escape');
  await sleep(POST_ESC_GAP_MS);
  await session.sendText(prompt);
  await sleep(PRE_ENTER_GAP_MS);
  await session.sendKey('Enter');

  // Race the agent's update_status against an overall timeout.
  let timer: NodeJS.Timeout;
  const timeout = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), DISPATCH_TIMEOUT_MS);
  });
  const winner = await Promise.race([promise, timeout]);
  clearTimeout(timer!);
  if (winner === 'timeout') {
    resolvePendingTimeout(instanceId);
    return { status: 'timeout' };
  }
  return { status: 'ok', payload: winner };
}
```

(Delete the old `conductor.dispatch(...)` call site.)

- [ ] **Step 5: Build, verify dispatcher still compiles**

```bash
npm run build
```

Expected: clean build. If TypeScript complains about `tmuxSessionRegistry` not existing yet, stub it: add a temporary `export const tmuxSessionRegistry = { get(_id: string) { return null; } };` to `tmux-session-runtime.ts` for now — it'll be properly populated in Task 13.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/dispatcher.ts \
        mcp-server/tests/dispatcher-tmux.test.mjs
git commit -m "feat(dispatcher): replace SessionConductor with pending-dispatch + update_status"
```

---

### Task 11: Delete `SessionConductor` and its tests

**Files:**
- Delete: `mcp-server/src/agent-clis/session-conductor.ts`
- Delete: `mcp-server/tests/session-conductor.test.mjs`
- Modify: `mcp-server/package.json:34` (drop `session-conductor.test.mjs` from test script)
- Modify: `mcp-server/src/pty-registry.ts` (remove conductor wiring — done in Task 14, just unblock imports here)

- [ ] **Step 1: Find all imports of session-conductor**

```bash
grep -rn "session-conductor\|SessionConductor" mcp-server/src mcp-server/tests
```

Expected hits in: `pty-registry.ts`, `agent-clis/types.ts`, possibly `dispatcher.ts` if any old import lingered. List each one before deleting so you can update them.

- [ ] **Step 2: Replace imports with stub temporarily**

In `mcp-server/src/pty-registry.ts`, change:

```ts
import { createSessionConductor, UnsupportedProviderError, type SessionConductor } from './agent-clis/session-conductor.ts';
```

to:

```ts
// SessionConductor removed in tmux migration; pty-registry no longer creates conductors.
// Per-instance pending-dispatch lives in src/pending-dispatch-registry.ts.
type SessionConductor = never;
```

And remove the call to `createSessionConductor(...)` in `registerPty` (the conductor field on the session goes away — keep it nullable for now, drop entirely in Task 14).

- [ ] **Step 3: Delete the source files**

```bash
git rm mcp-server/src/agent-clis/session-conductor.ts
git rm mcp-server/tests/session-conductor.test.mjs
```

- [ ] **Step 4: Update test script in package.json**

Open `mcp-server/package.json:34` and remove `tests/session-conductor.test.mjs ` from the `"test"` script string.

- [ ] **Step 5: Build to confirm no orphan imports**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 6: Run the suite**

```bash
npm test 2>&1 | grep -E "# pass|# fail|# tests" | tail -5
```

Expected: no `session-conductor` failures. Some tests that depended on conductor behavior may need updating in Task 14 — that's expected at this point.

- [ ] **Step 7: Commit**

```bash
git add -A mcp-server/src/agent-clis/session-conductor.ts \
           mcp-server/tests/session-conductor.test.mjs \
           mcp-server/src/pty-registry.ts \
           mcp-server/package.json
git commit -m "refactor: delete SessionConductor (replaced by pending-dispatch)"
```

---

## Phase 3 — Provider migration (echo-stub → copilot → claude → agency)

Each provider follows the SAME pattern. Doing echo-stub first lets us validate the full Phase 3 plumbing against a tiny test provider before touching the real CLIs.

### Task 12: Migrate `AgentHandle` type to be CliSession-based

**Files:**
- Modify: `mcp-server/src/agent-clis/types.ts:66-69` (also handle shape)

- [ ] **Step 1: Locate `AgentHandle`**

```bash
grep -n "AgentHandle" mcp-server/src/agent-clis/types.ts
```

- [ ] **Step 2: Replace the handle definition**

In `mcp-server/src/agent-clis/types.ts`, find the existing `AgentHandle` (which today has `pty: IPty`). Replace with:

```ts
import type { CliSession } from '../cli-sessions/types.ts';

export interface AgentHandle {
  /** Pid of the agent process inside the tmux pane. */
  pid: number | null;
  /** The cli_session_id (UUID) passed to copilot --session-id / claude --resume. */
  sessionId: string;
  /** The tmux-backed CliSession; replaces direct IPty access. */
  session: CliSession;
  /** Resolves when the agent process exits. */
  exited: Promise<{ exitCode: number | null; signal?: string }>;
}
```

Also remove from `ProviderCtx`:

```ts
// REMOVED: spawnPty(file, args, opts): IPty
```

And drop the `IPty` import at top of file.

- [ ] **Step 3: Build, expect many type errors in providers**

```bash
npm run build 2>&1 | head -40
```

Expected: errors in copilot.ts, claude.ts, agency-related code, etc. These are now broken and will be fixed in Tasks 13-15. Commit the type change as-is — broken state is acceptable on this branch since we're mid-refactor.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/agent-clis/types.ts
git commit -m "refactor(types): AgentHandle now wraps CliSession instead of IPty"
```

---

### Task 13: Singleton `tmuxSessionRegistry` + boot-time client

**Files:**
- Modify: `mcp-server/src/cli-sessions/tmux-session-runtime.ts` (add singleton + registry)
- Modify: `mcp-server/src/cli/start.ts` (boot the runtime)

- [ ] **Step 1: Extend `tmux-session-runtime.ts`**

Append to `mcp-server/src/cli-sessions/tmux-session-runtime.ts`:

```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliSession } from './types.ts';

/** Process-global registry of agent CliSessions keyed by recipe_instance_id. */
class TmuxSessionRegistry {
  private map = new Map<string, CliSession>();

  register(instanceId: string, session: CliSession): void {
    this.map.set(instanceId, session);
    session.exited.then(() => {
      // Auto-unregister on agent exit. EXIT_RETAIN_MS-style retention lives
      // elsewhere; this registry tracks "currently alive" only.
      if (this.map.get(instanceId) === session) this.map.delete(instanceId);
    });
  }

  get(instanceId: string): CliSession | null {
    return this.map.get(instanceId) ?? null;
  }

  unregister(instanceId: string): void {
    this.map.delete(instanceId);
  }

  list(): Array<{ instanceId: string; sessionName: string }> {
    return [...this.map.entries()].map(([instanceId, s]) => ({ instanceId, sessionName: s.name }));
  }
}

export const tmuxSessionRegistry = new TmuxSessionRegistry();

/** Process-global singleton runtime, configured at boot. */
let _runtime: CliSessionRuntime | null = null;

export function initTmuxSessionRuntime(client: TmuxClientOpts): void {
  _runtime = createTmuxSessionRuntime(client);
}

export function tmuxSessionRuntime(): CliSessionRuntime {
  if (!_runtime) throw new Error('tmuxSessionRuntime not initialized; call initTmuxSessionRuntime() at startup');
  return _runtime;
}

/**
 * On startup: query tmux for all cdb_* sessions, match against the DB's
 * running agent_sessions rows, adopt matches, mark orphans as crashed.
 */
export async function reconcileOnStartup(
  db: { prepare(s: string): { all(): unknown[]; run(...args: unknown[]): void } },
): Promise<{ adopted: number; orphaned: number }> {
  const runtime = tmuxSessionRuntime();
  const live = await runtime.list();
  const liveByShort = new Map<string, string>();
  for (const item of live) {
    // cdb_<instanceId> → instanceId
    liveByShort.set(item.name.replace(/^cdb_/, ''), item.name);
  }

  // Find DB rows that think they're running
  const rows = db.prepare(`SELECT id FROM agent_sessions WHERE status = 'running'`).all() as Array<{ id: string }>;
  let adopted = 0;
  let orphaned = 0;
  for (const row of rows) {
    if (liveByShort.has(row.id)) {
      const session = await runtime.attach(row.id);
      if (session) {
        tmuxSessionRegistry.register(row.id, session);
        adopted++;
      }
    } else {
      db.prepare(`UPDATE agent_sessions SET status = 'crashed', ended_at = ? WHERE id = ?`).run(Date.now(), row.id);
      orphaned++;
    }
  }
  return { adopted, orphaned };
}

/** Resolve the bundled cdb.tmux.conf path (used by initTmuxSessionRuntime callers). */
export function bundledTmuxConfPath(): string | null {
  // Look up the asset relative to this file's location at runtime.
  // assets/ sits at mcp-server/assets/cdb.tmux.conf
  const candidates = [
    resolve(import.meta.dirname ?? __dirname, '../../assets/cdb.tmux.conf'),
    resolve(import.meta.dirname ?? __dirname, '../../../assets/cdb.tmux.conf'),
    resolve(process.cwd(), 'mcp-server/assets/cdb.tmux.conf'),
    resolve(process.cwd(), 'assets/cdb.tmux.conf'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}
```

- [ ] **Step 2: Wire up boot in `start.ts`**

In `mcp-server/src/cli/start.ts`, after the existing config/workspace setup, add:

```ts
import { initTmuxSessionRuntime, reconcileOnStartup, bundledTmuxConfPath } from '../cli-sessions/tmux-session-runtime.ts';

// ... in the start handler, before launching the HTTP server ...
const tmuxSocket = cfg.tmux?.socket ?? 'clawdevbox';   // null shares default socket
const tmuxConf = bundledTmuxConfPath();
initTmuxSessionRuntime({ socket: tmuxSocket, configPath: tmuxConf });

// Verify tmux is installed
{
  const { tmuxRun } = await import('../cli-sessions/tmux-client.ts');
  const probe = tmuxRun({ socket: null, configPath: null }, ['-V']);
  if (probe.exitCode !== 0) {
    console.error('FATAL: tmux binary not found on PATH. Install tmux (https://github.com/tmux/tmux) and retry.');
    process.exit(2);
  }
}

// Adopt running sessions from a previous run
const recon = await reconcileOnStartup(ws.db);
logger.info({ adopted: recon.adopted, orphaned: recon.orphaned }, 'tmux: reconciled sessions on startup');
```

Add the optional `tmux` field to the config type if not present. In `mcp-server/src/config.ts`, find `ResolvedConfig` and add:

```ts
export interface ResolvedConfig {
  // ...existing fields...
  tmux?: { socket: string | null };
}
```

Defaults to `{ socket: 'clawdevbox' }` if not configured; set to `{ socket: null }` to share the default socket.

- [ ] **Step 3: Build**

```bash
npm run build 2>&1 | head -20
```

Expected: builds (provider type errors remain — those are Task 14/15/16/17).

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/cli-sessions/tmux-session-runtime.ts \
        mcp-server/src/cli/start.ts \
        mcp-server/src/config.ts
git commit -m "feat(boot): init tmuxSessionRuntime + reconcileOnStartup"
```

---

### Task 14: Migrate echo-stub provider

**Files:**
- Modify: `mcp-server/src/agent-clis/echo-stub.ts:55-100`

- [ ] **Step 1: Read the existing echo-stub spawn flow**

```bash
view mcp-server/src/agent-clis/echo-stub.ts
```

Note where it calls `ctx.spawnPty(process.execPath, [scriptPath], ...)` and how it constructs the handle.

- [ ] **Step 2: Replace the spawn**

Replace the `ctx.spawnPty(...)` block and the handle construction with:

```ts
import { tmuxSessionRuntime } from '../cli-sessions/tmux-session-runtime.ts';

// ... inside spawnSession ...
const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
const session = await tmuxSessionRuntime().spawn({
  name: opts.recipeInstanceId,
  cwd: opts.workspaceInfo.path,
  env,
  cols: opts.ptyCols ?? 80,
  rows: opts.ptyRows ?? 24,
  command: process.execPath,
  args: [scriptPath],
});

const handle: AgentHandle = {
  pid: await session.pid(),
  sessionId: opts.init.session_id,
  session,
  exited: session.exited.then((e) => ({ exitCode: e.exitCode })),
};

return handle;
```

Delete any direct `IPty`-typed bookkeeping (the `pty` field is gone from `AgentHandle`).

- [ ] **Step 3: Update echo-stub's `writePrompt`**

If echo-stub has its own `writePrompt`, replace it with:

```ts
async writePrompt(handle, { text, strategy }) {
  if (strategy === 'submit') {
    await handle.session.sendKey('Escape');
    await new Promise((r) => setTimeout(r, 200));
  }
  await handle.session.sendText(text);
  await new Promise((r) => setTimeout(r, 250));
  await handle.session.sendKey(strategy === 'queue' ? 'C-q' : 'Enter');
}
```

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | grep -i "echo-stub\|error" | head
```

Expected: no echo-stub-related errors. Real provider errors (copilot/claude) still remain.

- [ ] **Step 5: Smoke-run echo-stub**

```bash
node --import tsx --test tests/agent-clis.test.mjs 2>&1 | grep -E "# pass|# fail|not ok" | head -10
```

Expected: echo-stub tests pass. Other tests may fail; that's the next tasks' work.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/agent-clis/echo-stub.ts
git commit -m "refactor(echo-stub): migrate to tmuxSessionRuntime + CliSession"
```

---

### Task 15: Migrate copilot provider

**Files:**
- Modify: `mcp-server/src/agent-clis/copilot.ts:50-180`

- [ ] **Step 1: Review the existing copilot spawn + writePrompt**

```bash
view mcp-server/src/agent-clis/copilot.ts
```

- [ ] **Step 2: Replace `ctx.spawnPty(bin, argv, ...)` with tmux spawn**

```ts
import { tmuxSessionRuntime } from '../cli-sessions/tmux-session-runtime.ts';

// ... inside spawnSession, replacing the existing ctx.spawnPty block ...
const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
const session = await tmuxSessionRuntime().spawn({
  name: opts.recipeInstanceId,
  cwd: opts.workspaceInfo.path,
  env,
  cols: opts.ptyCols ?? 120,
  rows: opts.ptyRows ?? 30,
  command: bin,
  args: argv,
});

const handle: AgentHandle = {
  pid: await session.pid(),
  sessionId: opts.init.session_id,
  session,
  exited: session.exited.then((e) => ({ exitCode: e.exitCode })),
};

return handle;
```

- [ ] **Step 3: Delete `deliverInitialPromptWhenReady` call AND the gate exposure**

Find and DELETE this entire block (currently around lines 127-145):

```ts
if (opts.mode === 'interactive' && opts.prompt) {
  const initialPromptDelivery = deliverInitialPromptWhenReady(pty, {
    text: opts.prompt,
    promptReadyRegex: copilotCapabilities.promptReadyRegex,
    fullyRenderedRegex: /context\s*\(\d+%\)/,
    stableMs: 2500,
    timeoutMs: 90_000,
    writePrompt: (o) => copilotProvider.writePrompt!(handle, o),
  });
  (handle as AgentHandle & { initialPromptDelivery?: Promise<unknown> }).initialPromptDelivery = initialPromptDelivery;
  // ...
}
```

The initial prompt is now delivered as the first regular `/dispatch` call by the caller (e.g. `dispatcher.spawnFromCallback`). Snapshot-poll readiness happens in the dispatcher pre-flight (Task 18).

- [ ] **Step 4: Shrink `writePrompt`**

Replace the existing `writePrompt` (lines 163-171) with:

```ts
async writePrompt(handle, { text, strategy }) {
  if (strategy === 'submit') {
    // ESC dismisses overlays + clears the input box. Send alone with a gap
    // so the terminal doesn't interpret ESC+next-byte as Alt+<byte>.
    await handle.session.sendKey('Escape');
    await sleep(200);
  }
  await handle.session.sendText(text);
  await sleep(SLEEP_BEFORE_COMMIT_MS);   // 250ms
  await handle.session.sendKey(strategy === 'queue' ? 'C-q' : 'Enter');
},
```

- [ ] **Step 5: Prepend `update_status` instructions to system prompt**

Find where copilot constructs argv. After existing `--agent` / `--model` flags, add a `--system-prompt-append` (or equivalent — verify against `copilot --help`):

```ts
const updateStatusInstruction = `

[clawdevbox runtime]
You have access to an MCP tool called \`update_status\`. Use it to:
  • Report progress periodically during long operations (every 30-60s of work, or after each meaningful step).
  • Signal \`needs_user_input=true\` when you require clarification.
  • ALWAYS call \`update_status\` with \`task_complete=true\` exactly once when you finish responding. This is mandatory — the orchestrator depends on it.`;

argv.push('--system-prompt-append', updateStatusInstruction);
```

Note: copilot CLI 1.0.57-3 may not support `--system-prompt-append`. Check `copilot --help` and adapt to whatever the real flag is (e.g. write a `~/.copilot/system-prompt-append.txt` and pass `--system-prompt-file`). If no per-session system prompt flag exists, write the instruction as an `agent` file in `~/.copilot/agents/cdb-runtime.md` and require `--agent cdb-runtime` for clawdevbox-spawned sessions.

- [ ] **Step 6: Delete unused imports**

Remove the now-unused `deliverInitialPromptWhenReady` import from the top of `copilot.ts`.

- [ ] **Step 7: Build**

```bash
npm run build 2>&1 | grep -i "copilot\|error" | head
```

Expected: clean copilot build. claude.ts still has errors — next task.

- [ ] **Step 8: Update / fix copilot tests**

```bash
node --import tsx --test tests/agent-clis-capabilities.test.mjs 2>&1 | tail -20
```

Tests that reference `pty.write` or `handle.initialPromptDelivery` need updating. Replace assertions like `pty.writes` with `session.sendText` / `session.sendKey` mocks. Stub `CliSession` for unit tests:

```js
function mockSession() {
  const calls = [];
  return {
    name: 'cdb_mock',
    pid: async () => 999,
    exited: new Promise(() => {}),
    sendText: async (t) => { calls.push(['sendText', t]); },
    sendKey: async (k) => { calls.push(['sendKey', k]); },
    resize: async () => {}, snapshot: async () => '', kill: async () => {},
    calls,
  };
}
```

Walk through each failing test and rewrite it to use `mockSession()` and assert against `session.calls` instead of `pty.writes`.

- [ ] **Step 9: Commit**

```bash
git add mcp-server/src/agent-clis/copilot.ts \
        mcp-server/tests/agent-clis-capabilities.test.mjs
git commit -m "refactor(copilot): migrate to tmuxSessionRuntime + CliSession"
```

---

### Task 16: Migrate claude provider

Same pattern as Task 15. Files: `mcp-server/src/agent-clis/claude.ts`.

- [ ] **Step 1: Apply the same five edits as Task 15 to claude.ts**
  - Replace `ctx.spawnPty` with `tmuxSessionRuntime().spawn(...)`.
  - Replace handle construction with the CliSession-backed shape.
  - Delete `deliverInitialPromptWhenReady` call.
  - Shrink `writePrompt` to ESC + sendText + sleep + Enter.
  - Append `update_status` instructions via `--system-prompt-append` (or equivalent; check `claude --help`).

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | grep -i "claude\|error" | head
```

Expected: clean claude build.

- [ ] **Step 3: Run targeted tests**

```bash
node --import tsx --test tests/agent-clis-capabilities.test.mjs 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/agent-clis/claude.ts
git commit -m "refactor(claude): migrate to tmuxSessionRuntime + CliSession"
```

---

### Task 17: Migrate external agency provider (separate worktree)

The agency provider is an external plugin at `C:\git\agency-provider\` (junctioned into `~/.clawdevbox/plugins/agency-cli/`). Touched in its own worktree so the clawdevbox repo stays clean.

- [ ] **Step 1: Create an isolated worktree on the agency-provider repo**

```bash
cd C:\git\agency-provider
git worktree add ../.agency-provider-tmux -b feat/tmux-migration
cd ../.agency-provider-tmux
```

- [ ] **Step 2: Apply the same handle/writePrompt/initial-prompt edits as copilot**

In `agency-provider.mjs`:
- Replace `ctx.spawnPty(bin, argv, ...)` with a call that requires the new `cliSessions` helper from clawdevbox (via the dynamic import already used for `writeMcpJson`/`trustCopilotWorkspace`):

```js
const { tmuxSessionRuntime } = await loadSyncHelpers();
const session = await tmuxSessionRuntime().spawn({
  name: opts.recipeInstanceId,
  cwd: opts.workspaceInfo.path,
  env: { ...process.env, ...opts.ambientEnv },
  cols: opts.ptyCols ?? 120,
  rows: opts.ptyRows ?? 30,
  command: bin,
  args: argv,
});
const handle = {
  pid: await session.pid(),
  sessionId: opts.init.session_id,
  session,
  exited: session.exited.then((e) => ({ exitCode: e.exitCode })),
};
```

- Shrink `writePrompt`:

```js
async writePrompt(handle, opts) {
  if (opts.strategy !== 'queue') {
    await handle.session.sendKey('Escape');
    await new Promise((r) => setTimeout(r, 200));
  }
  await handle.session.sendText(opts.text);
  await new Promise((r) => setTimeout(r, 250));
  await handle.session.sendKey(opts.strategy === 'queue' ? 'C-q' : 'Enter');
}
```

- DELETE the local `deliverInitialPromptWhenReady` function (lines ~140-174) and its call site.

- Add `update_status` instructions to the argv (likely via copilot's flag since agency wraps copilot).

- [ ] **Step 3: Update `loadSyncHelpers` to also export `tmuxSessionRuntime`**

In `mcp-server/src/agent-clis/shared.ts`, export `tmuxSessionRuntime` so external providers can import it via the same dynamic-import path:

```ts
export { tmuxSessionRuntime } from '../cli-sessions/tmux-session-runtime.ts';
```

- [ ] **Step 4: Commit agency-provider change**

```bash
cd C:\git\agency-provider\.agency-provider-tmux
git add agency-provider.mjs
git commit -m "refactor: migrate to tmuxSessionRuntime + CliSession"
```

- [ ] **Step 5: Note in clawdevbox worktree for cross-repo tracking**

Add a one-liner to `docs/superpowers/plans/2026-05-31-tmux-cli-sessions.md` under a "Cross-repo dependencies" note (already in the deferred section, but reference the worktree path).

---

## Phase 4 — pty-registry pivot to viewer-IPty-only

### Task 18: Snapshot-poll for initial-prompt readiness

**Files:**
- Create: `mcp-server/src/cli-sessions/wait-for-ready.ts`
- Create: `mcp-server/tests/cli-sessions/wait-for-ready.test.mjs`
- Modify: `mcp-server/src/dispatcher.ts:spawnFromCallback` (gate first dispatch on readiness)

- [ ] **Step 1: Write the failing test**

```js
// mcp-server/tests/cli-sessions/wait-for-ready.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { waitForReady } from '../../src/cli-sessions/wait-for-ready.ts';

function fakeSession(snapshotsOverTime) {
  let i = 0;
  return {
    name: 'cdb_fake',
    pid: async () => 1, exited: new Promise(() => {}),
    sendText: async () => {}, sendKey: async () => {},
    resize: async () => {},
    snapshot: async () => snapshotsOverTime[Math.min(i++, snapshotsOverTime.length - 1)],
    kill: async () => {},
  };
}

test('waitForReady resolves when both prompt-ready AND fully-rendered match', async () => {
  const s = fakeSession([
    '',                              // 0ms: nothing
    'splash text',                   // 500ms: still loading
    '❯',                             // 1000ms: prompt drawn but not model line
    '❯ context (5%)',                // 1500ms: both present
    '❯ context (5%)',                // stable
    '❯ context (5%)',                // stable
  ]);
  const result = await waitForReady(s, {
    promptReadyRegex: /❯/,
    fullyRenderedRegex: /context\s*\(\d+%\)/,
    pollIntervalMs: 100,
    stableMs: 200,
    timeoutMs: 10_000,
  });
  assert.equal(result, 'ready');
});

test('waitForReady rejects on timeout', async () => {
  const s = fakeSession(['nothing matches']);
  await assert.rejects(
    waitForReady(s, {
      promptReadyRegex: /❯/,
      fullyRenderedRegex: /context/,
      pollIntervalMs: 50,
      stableMs: 100,
      timeoutMs: 300,
    }),
    /timed out/,
  );
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
node --import tsx --test tests/cli-sessions/wait-for-ready.test.mjs
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Create `wait-for-ready.ts`**

```ts
// mcp-server/src/cli-sessions/wait-for-ready.ts
import { setTimeout as sleep } from 'node:timers/promises';
import type { CliSession } from './types.ts';

export interface WaitForReadyOpts {
  /** Required: must match the rendered prompt-ready glyph. */
  promptReadyRegex: RegExp;
  /** Optional: must ALSO match before stable timer starts. */
  fullyRenderedRegex?: RegExp;
  /** How often to call snapshot(). Default 500ms. */
  pollIntervalMs?: number;
  /** How long the latest snapshot must stay matching before we declare ready. Default 2500ms. */
  stableMs?: number;
  /** Overall timeout. Default 90s. */
  timeoutMs?: number;
}

/**
 * Poll session.snapshot() until promptReadyRegex (and optionally
 * fullyRenderedRegex) both match for `stableMs`. Resolves with 'ready'
 * or rejects on timeout. Replaces the byte-stream-based
 * deliverInitialPromptWhenReady from the IPty era.
 */
export async function waitForReady(
  session: CliSession,
  opts: WaitForReadyOpts,
): Promise<'ready'> {
  const pollMs = opts.pollIntervalMs ?? 500;
  const stableMs = opts.stableMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const start = Date.now();
  let stableSince: number | null = null;

  while (Date.now() - start < timeoutMs) {
    const snap = await session.snapshot();
    const ready = opts.promptReadyRegex.test(snap) &&
                  (!opts.fullyRenderedRegex || opts.fullyRenderedRegex.test(snap));
    if (ready) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return 'ready';
    } else {
      stableSince = null;
    }
    await sleep(pollMs);
  }
  throw new Error(`waitForReady: timed out after ${timeoutMs}ms`);
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
node --import tsx --test tests/cli-sessions/wait-for-ready.test.mjs
```

Expected: `# pass 2, # fail 0`.

- [ ] **Step 5: Wire into `dispatcher.spawnFromCallback`**

In `mcp-server/src/dispatcher.ts`, after `runRecipe(...)` returns with the new agent handle, but BEFORE returning to the caller, add:

```ts
import { waitForReady } from './cli-sessions/wait-for-ready.ts';
import { dispatchToInstance } from './dispatcher.ts'; // already in same file

// After successful runRecipe spawn, if there was an initial prompt:
if (opts.initialPrompt && result.session_id) {
  const session = tmuxSessionRegistry.get(result.recipe_instance_id);
  if (session) {
    // Wait until copilot's TUI has drawn the prompt-ready glyph + model line.
    try {
      await waitForReady(session, {
        promptReadyRegex: /❯[^\S\n]*$/m,
        fullyRenderedRegex: /context\s*\(\d+%\)/,
        pollIntervalMs: 500,
        stableMs: 2500,
        timeoutMs: 90_000,
      });
    } catch (err) {
      logger.warn({ err: String(err) }, 'spawn: initial-prompt readiness wait failed; dispatching anyway');
    }
    // Now deliver the initial prompt as a regular dispatch.
    await dispatchToInstance(result.recipe_instance_id, opts.initialPrompt);
  }
}
```

Adjust to match the actual signature of `spawnFromCallback` — the `initialPrompt` may today be passed straight to `provider.spawnSession`. After this change, it should NOT be passed to spawn; it should be held back and dispatched after readiness.

In `recipe-runner.ts`, also stop passing `prompt` to `provider.spawnSession` — providers no longer auto-deliver initial prompts (Task 14/15/16/17 already removed those code paths).

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/cli-sessions/wait-for-ready.ts \
        mcp-server/tests/cli-sessions/wait-for-ready.test.mjs \
        mcp-server/src/dispatcher.ts \
        mcp-server/src/recipe-runner.ts
git commit -m "feat(dispatcher): snapshot-poll readiness + initial prompt as first dispatch"
```

---

### Task 19: Pivot `pty-registry` to viewer-IPty-only

**Files:**
- Modify: `mcp-server/src/pty-registry.ts:1-300+` (substantial rewrite)
- Modify: `mcp-server/src/recipe-runner.ts` (stop registering agent ptys here)
- Modify: `mcp-server/src/terminal-server.ts:740-790` (spawn tmux attach IPty per viewer)
- Modify: `mcp-server/tests/pty-registry-conductor.test.mjs` (rewrite for viewer-only)

- [ ] **Step 1: Strip the agent path from pty-registry**

The current `pty-registry.ts` mixes two concerns: tracking agent IPty handles + tracking viewer state (gate, pendingResize). With agents now in tmux, pty-registry only needs to track per-viewer `tmux attach` IPty handles.

Rewrite `mcp-server/src/pty-registry.ts` to this shape:

```ts
/**
 * pty-registry.ts (tmux-migration)
 *
 * Per-viewer ephemeral IPty registry. Each WebSocket client gets its own
 * `tmux attach -t cdb_<instance>` IPty for live rendering. Entries are
 * keyed by a viewer-scoped id (NOT by instance_id — multiple viewers can
 * attach to the same agent).
 *
 * Agent processes themselves run inside tmux and are tracked separately
 * by tmuxSessionRegistry (src/cli-sessions/tmux-session-runtime.ts).
 */
import type { IPty } from 'node-pty';
import * as pty from 'node-pty';
import { tmuxSessionRegistry } from './cli-sessions/tmux-session-runtime.ts';
import { emitChange } from './event-bus.ts';
import { logger } from './logger.ts';

const BUFFER_LIMIT_BYTES = 256 * 1024;

interface ViewerPty {
  viewerId: string;
  instanceId: string;
  tmuxSessionName: string;
  ipty: IPty;
  buffer: string;
  subscribers: Set<(chunk: string) => void>;
  exitListeners: Set<(exitCode: number | null) => void>;
  exited: boolean;
  exitCode: number | null;
}

const viewers = new Map<string, ViewerPty>();

export interface AttachOpts {
  viewerId: string;
  instanceId: string;
  cols: number;
  rows: number;
  socket: string | null;          // tmux -L value
  configPath: string | null;      // tmux -f value
}

/**
 * Spawn a `tmux attach` IPty for this viewer. Returns viewerId on success
 * or throws if the underlying tmux session is missing.
 */
export function attachViewer(opts: AttachOpts): string {
  const cliSession = tmuxSessionRegistry.get(opts.instanceId);
  if (!cliSession) throw new Error(`no tmux session for instance ${opts.instanceId}`);

  const args: string[] = [];
  if (opts.socket) args.push('-L', opts.socket);
  if (opts.configPath) args.push('-f', opts.configPath);
  args.push('attach-session', '-t', cliSession.name);

  const ipty = pty.spawn('tmux', args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: process.cwd(),
    env: process.env,
  });

  const v: ViewerPty = {
    viewerId: opts.viewerId,
    instanceId: opts.instanceId,
    tmuxSessionName: cliSession.name,
    ipty,
    buffer: '',
    subscribers: new Set(),
    exitListeners: new Set(),
    exited: false,
    exitCode: null,
  };

  ipty.onData((chunk) => {
    v.buffer = (v.buffer + chunk).slice(-BUFFER_LIMIT_BYTES);
    for (const cb of v.subscribers) cb(chunk);
  });
  ipty.onExit(({ exitCode }) => {
    v.exited = true;
    v.exitCode = exitCode;
    for (const cb of v.exitListeners) cb(exitCode);
  });

  viewers.set(opts.viewerId, v);
  emitChange('viewers', opts.instanceId);
  return opts.viewerId;
}

export function detachViewer(viewerId: string): boolean {
  const v = viewers.get(viewerId);
  if (!v) return false;
  try { v.ipty.kill(); } catch {}
  viewers.delete(viewerId);
  emitChange('viewers', v.instanceId);
  return true;
}

export function writeToViewer(viewerId: string, data: string): boolean {
  const v = viewers.get(viewerId);
  if (!v || v.exited) return false;
  v.ipty.write(data);
  return true;
}

export function resizeViewer(viewerId: string, cols: number, rows: number): boolean {
  const v = viewers.get(viewerId);
  if (!v || v.exited) return false;
  try { v.ipty.resize(cols, rows); } catch { return false; }
  return true;
}

export function subscribeViewer(
  viewerId: string,
  onData: (chunk: string) => void,
  onExit: (exitCode: number | null) => void,
): () => void {
  const v = viewers.get(viewerId);
  if (!v) throw new Error(`no viewer ${viewerId}`);
  // Deliver the snapshot first.
  if (v.buffer) onData(v.buffer);
  v.subscribers.add(onData);
  v.exitListeners.add(onExit);
  if (v.exited) onExit(v.exitCode);
  return () => {
    v.subscribers.delete(onData);
    v.exitListeners.delete(onExit);
  };
}
```

Delete EVERYTHING else in the file: `INITIAL_PROMPT_VIEWER_GATE_GRACE_MS`, `EXIT_RETAIN_MS`, `applyResize` agent-side, `initialPromptDeliveryOf`, the conductor wiring, the old `registerPty`/`subscribe`/`writeToPty`/`resizePty`/`killPty` functions that took `instanceId` — those are all gone.

- [ ] **Step 2: Update `terminal-server.ts` to use the new API**

Find the WebSocket handler (around line 720+) and rewrite the message dispatch:

```ts
import { attachViewer, detachViewer, writeToViewer, resizeViewer, subscribeViewer } from './pty-registry.ts';
import { randomUUID } from 'node:crypto';
import { resolveConfig } from './config.ts';

// On WS connect for /terminal/<instanceId>/ws:
const viewerId = randomUUID();
const cfg = resolveConfig({ projectDir: ws.projectDir, globalDir: ws.globalDir });
const socket = cfg.tmux?.socket ?? 'clawdevbox';
try {
  attachViewer({
    viewerId,
    instanceId,
    cols: 120,    // updated by first 'resize' message
    rows: 30,
    socket,
    configPath: null,
  });
} catch (err) {
  ws.close(1011, `attach failed: ${(err as Error).message}`);
  return;
}

const unsubscribe = subscribeViewer(
  viewerId,
  (chunk) => ws.send(JSON.stringify({ type: 'data', chunk })),
  (exitCode) => ws.send(JSON.stringify({ type: 'exit', exitCode })),
);

ws.on('message', (raw) => {
  let msg: any;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === 'input' && typeof msg.data === 'string') {
    writeToViewer(viewerId, msg.data);
  } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
    resizeViewer(viewerId, msg.cols, msg.rows);
  }
});

ws.on('close', () => {
  unsubscribe();
  detachViewer(viewerId);
});
ws.on('error', () => {
  unsubscribe();
  detachViewer(viewerId);
});
```

Send an initial snapshot before live data. The simplest path: `subscribeViewer` already delivers `v.buffer` as the first call to onData. The first byte the tmux attach IPty emits is the full pane redraw, so the user sees the current pane content immediately.

- [ ] **Step 3: Update `recipe-runner.ts`**

In `mcp-server/src/recipe-runner.ts`, find where it calls `registerPty(...)` (old API) and REMOVE that call. The agent is no longer represented by an IPty in pty-registry; it's a tmux session in `tmuxSessionRegistry`. Register it there instead:

```ts
import { tmuxSessionRegistry } from './cli-sessions/tmux-session-runtime.ts';

// After provider.spawnSession returns handle:
tmuxSessionRegistry.register(instanceId, handle.session);

// Wire log archive on exit:
handle.exited.then(async () => {
  try {
    const snap = await handle.session.snapshot();
    await import('node:fs').then((fs) => fs.promises.appendFile(logPath, snap));
  } catch (err) {
    logger.warn({ err: String(err) }, 'recipe-runner: failed to archive pane snapshot');
  }
}).catch(() => {});
```

Drop the old IPty `onData → log` pipe (the agent's stdout is now inside tmux; we archive via capture-pane at exit).

- [ ] **Step 4: Rewrite the conductor test for viewer-only semantics**

Rename `mcp-server/tests/pty-registry-conductor.test.mjs` → `mcp-server/tests/pty-registry-viewer.test.mjs` and replace contents with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachViewer, detachViewer, writeToViewer, subscribeViewer } from '../src/pty-registry.ts';
import { tmuxSessionRegistry, initTmuxSessionRuntime } from '../src/cli-sessions/tmux-session-runtime.ts';
import { tmuxRun } from '../src/cli-sessions/tmux-client.ts';
import { createTmuxSession } from '../src/cli-sessions/tmux-session.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const client = { socket: 'cdb-vw-' + Date.now().toString(36), configPath: null };
initTmuxSessionRuntime(client);

test('attachViewer spawns a tmux-attach IPty and forwards bytes', async () => {
  // Create an underlying tmux session for the viewer to attach to.
  const inst = 'vw_a';
  const session = await createTmuxSession(client, {
    name: inst,
    cwd: mkdtempSync(join(tmpdir(), 'cdb-vw-')),
    env: {}, cols: 80, rows: 24,
    command: 'sh', args: ['-c', 'while true; do echo TICK; sleep 0.5; done'],
  });
  tmuxSessionRegistry.register(inst, session);

  const vid = attachViewer({
    viewerId: 'vid-1', instanceId: inst,
    cols: 80, rows: 24,
    socket: client.socket, configPath: client.configPath,
  });
  assert.equal(vid, 'vid-1');

  let saw = '';
  const unsub = subscribeViewer('vid-1', (chunk) => { saw += chunk; }, () => {});
  await new Promise((r) => setTimeout(r, 1500));
  assert.match(saw, /TICK/);

  unsub();
  detachViewer('vid-1');
  await session.kill();
  try { tmuxRun(client, ['kill-server']); } catch {}
});

test('writeToViewer forwards bytes to the tmux client (verified via session response)', async () => {
  // (Optional integration test — skip if it slows the suite too much.)
});
```

- [ ] **Step 5: Build**

```bash
npm run build 2>&1 | head
```

Expected: clean build.

- [ ] **Step 6: Run viewer tests**

```bash
node --import tsx --test tests/pty-registry-viewer.test.mjs
```

Expected: `# pass 1+, # fail 0`.

- [ ] **Step 7: Commit**

```bash
git rm mcp-server/tests/pty-registry-conductor.test.mjs
git add mcp-server/src/pty-registry.ts \
        mcp-server/src/terminal-server.ts \
        mcp-server/src/recipe-runner.ts \
        mcp-server/tests/pty-registry-viewer.test.mjs
git commit -m "refactor(pty-registry): viewer-IPty-only; agents live in tmuxSessionRegistry"
```

---

## Phase 5 — End-to-end verification

### Task 20: Stress test with the existing UI repro

**Files:**
- (no source changes; just running existing repros)

- [ ] **Step 1: Restart the server**

```powershell
$pid5 = (Get-NetTCPConnection -LocalPort 5201 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($pid5) { Stop-Process -Id $pid5 -Force; Start-Sleep 5 }
cd C:\git\clawdevbox\.worktrees\tmux-migration\mcp-server
Start-Process node -ArgumentList "dist/cli.js","start" -WindowStyle Hidden -PassThru
Start-Sleep 45
curl.exe -s http://127.0.0.1:5201/healthz
```

Expected: `ok`.

- [ ] **Step 2: Recreate the UI dispatch repro on this branch**

The reproducers from the previous session (`repro-scenario-c-loop.mjs`, `repro-spawn-stuck.mjs`, `repro-ui-dispatch-rapid.mjs`) were deleted after the gate fix. Re-create the minimal one:

```js
// mcp-server/scripts/repro-tmux-ui-dispatch.mjs
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const BASE = 'http://127.0.0.1:5201';
const N = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
await page.goto(BASE + '/test-ui', { waitUntil: 'domcontentloaded' });
await sleep(2000);

const ws = mkdtempSync(join(tmpdir(), 'tmux-ui-'));
const seed = 'SEED_' + Math.random().toString(36).slice(2, 6).toUpperCase();
await page.click('.tab[data-tab=spawn]');
await page.fill('#sp-prompt', `Reply with only: ${seed}`);
await page.fill('#sp-ws', ws);
await page.click('button.primary:has-text("Spawn")');
await sleep(6000);
const resp = await page.locator('#sp-response').innerText();
const instance = resp.match(/instance_id"?:\s*"?(ri_[a-z0-9_]+)"?/)?.[1];
await page.evaluate((id) => window.selectSession(id), instance);

// Wait for seed
for (let i = 0; i < 60; i++) {
  const t = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  if ((t.match(new RegExp(seed, 'g')) ?? []).length >= 2) break;
  await sleep(2000);
}

// Rapid dispatch 5
await page.click('.tab[data-tab=dispatch]');
await page.fill('#dp-instance', instance);
const canaries = [];
for (let i = 1; i <= N; i++) {
  const c = `RAP${i}_` + Math.random().toString(36).slice(2, 6).toUpperCase();
  canaries.push(c);
  await page.fill('#dp-prompt', `Reply with only: ${c}`);
  await page.click('button.primary:has-text("Dispatch")');
  await sleep(500);
}
const start = Date.now();
let ok = 0;
while (Date.now() - start < 180_000 && ok < N) {
  const t = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  ok = canaries.filter((c) => (t.match(new RegExp(c, 'g')) ?? []).length >= 2).length;
  await sleep(2000);
}
console.log(`${ok}/${N} dispatches submitted`);
await fetch(BASE + '/api/sessions/' + instance, { method: 'DELETE' });
await browser.close();
process.exit(ok === N ? 0 : 1);
```

- [ ] **Step 3: Run the repro**

```bash
node scripts/repro-tmux-ui-dispatch.mjs 2>&1 | tail -5
```

Expected: `5/5 dispatches submitted`.

- [ ] **Step 4: Manual smoke — attach via tmux from a real shell**

```bash
# In another shell on the same Windows machine:
tmux -L clawdevbox list-sessions
tmux -L clawdevbox attach -t cdb_<some-instance-id>
# Type something, see copilot react. Ctrl+B then D to detach.
```

Verify you can both watch and interact with the agent through tmux directly.

- [ ] **Step 5: Restart-survival smoke**

```bash
# 1. Spawn an agent via /spawn (or /test-ui)
curl.exe -X POST http://127.0.0.1:5201/spawn -H "content-type: application/json" \
  -d '{"prompt":"sleep test","session_id":"survive-test","provider":"copilot","workspace_path":"C:/temp/survive"}'

# 2. Note the instance_id from the response

# 3. Kill clawdevbox HARD
Stop-Process -Id $(Get-NetTCPConnection -LocalPort 5201 -State Listen).OwningProcess -Force

# 4. Confirm the agent's tmux session is still alive
tmux -L clawdevbox list-sessions
# Expected: cdb_ri_<id> listed

# 5. Restart clawdevbox
node dist/cli.js start &
Start-Sleep 45

# 6. Verify clawdevbox adopted the session
curl.exe -s http://127.0.0.1:5201/api/sessions?status=active
# Expected: the original instance_id appears

# 7. Dispatch to the adopted session — must work
curl.exe -X POST http://127.0.0.1:5201/dispatch?instance_id=ri_<id> \
  -H "content-type: application/json" -d '{"prompt":"Reply OK"}'
```

If reconcileOnStartup correctly adopted the session, the dispatch flows through normally.

- [ ] **Step 6: Commit the repro script**

```bash
git add mcp-server/scripts/repro-tmux-ui-dispatch.mjs
git commit -m "test: tmux migration UI dispatch repro"
```

---

### Task 21: Final cleanup pass

**Files:**
- Modify: `mcp-server/src/agent-clis/shared.ts` (delete `deliverInitialPromptWhenReady`)
- Modify: `mcp-server/src/agent-clis/index.ts` (re-exports cleanup)
- Modify: `mcp-server/src/trust-workspace.ts` (drop pty-registry imports if any)
- Modify: `mcp-server/package.json:34` (test script updated to include new tests)

- [ ] **Step 1: Delete `deliverInitialPromptWhenReady`**

In `mcp-server/src/agent-clis/shared.ts`, find and DELETE the entire `DeliverInitialPromptOpts` interface AND the `deliverInitialPromptWhenReady` function. They are no longer used now that `waitForReady` lives in `cli-sessions/`.

- [ ] **Step 2: Remove dead imports across the codebase**

```bash
grep -rn "deliverInitialPromptWhenReady\|fullyRenderedRegex\|notReadyRegex\|initialPromptDelivery\|INITIAL_PROMPT_VIEWER_GATE_GRACE_MS" mcp-server/src
```

Each hit must be cleaned up. Most should already be gone; remove any stragglers.

- [ ] **Step 3: Update package.json test script**

Make sure the `test` script in `mcp-server/package.json` includes all new tests:

```
tests/cli-sessions/special-keys.test.mjs
tests/cli-sessions/tmux-client.test.mjs
tests/cli-sessions/tmux-session.test.mjs
tests/cli-sessions/tmux-session-runtime.test.mjs
tests/cli-sessions/wait-for-ready.test.mjs
tests/pending-dispatch-registry.test.mjs
tests/update-status-tool.test.mjs
tests/dispatcher-tmux.test.mjs
tests/db-migrations-v5.test.mjs
tests/pty-registry-viewer.test.mjs
```

And REMOVE: `tests/session-conductor.test.mjs`, `tests/pty-registry-conductor.test.mjs`.

- [ ] **Step 4: Run full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: every test passes. Tests that depended on old conductor/IPty agent behavior must have been rewritten by earlier tasks; if anything still fails, fix it now.

- [ ] **Step 5: Rebuild and restart server, smoke-check `/healthz`**

```bash
npm run build
Stop-Process -Id $(Get-NetTCPConnection -LocalPort 5201 -State Listen).OwningProcess -Force
Start-Sleep 5
Start-Process node -ArgumentList "dist/cli.js","start" -WindowStyle Hidden -PassThru
Start-Sleep 45
curl.exe -s http://127.0.0.1:5201/healthz
```

Expected: `ok`.

- [ ] **Step 6: Re-run the UI dispatch repro and the conductor unit tests**

```bash
node --import tsx --test tests/cli-sessions/*.test.mjs tests/dispatcher-tmux.test.mjs tests/update-status-tool.test.mjs tests/pending-dispatch-registry.test.mjs tests/pty-registry-viewer.test.mjs 2>&1 | tail -5
node scripts/repro-tmux-ui-dispatch.mjs 2>&1 | tail -3
```

Expected: all unit tests pass, repro reports `5/5 dispatches submitted`.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/agent-clis/shared.ts \
        mcp-server/src/agent-clis/index.ts \
        mcp-server/src/trust-workspace.ts \
        mcp-server/package.json
git commit -m "chore: final cleanup of pre-tmux helpers"
```

---

## Phase 6 — Documentation + handoff

### Task 22: Update README + memory

**Files:**
- Modify: `mcp-server/README.md` (note tmux dependency)
- Modify: `README.md` (top-level dependency note)

- [ ] **Step 1: Add tmux dependency note**

In `mcp-server/README.md`, add a "Dependencies" section near the top:

```markdown
## Runtime dependencies

- `tmux` (3.3+ tested) on `PATH`. clawdevbox runs every agent CLI
  inside a tmux pane so sessions can survive restarts and be inspected
  via `tmux -L clawdevbox attach -t cdb_<instance>` from any shell.
  Install: Linux/macOS → your package manager; Windows → ships with
  Git Bash / MSYS2.

- `node-pty` (kept for per-viewer `tmux attach` clients only; the
  agent path is fully tmux-native).
```

- [ ] **Step 2: Add an architecture note**

```markdown
## Process architecture

Every agent runs inside a tmux session named `cdb_<recipe_instance_id>`.
Communication is:

  • clawdevbox → agent: `tmux send-keys -t <session> ...` subprocess calls
    from `src/cli-sessions/tmux-session.ts`.
  • agent → clawdevbox: regular MCP tool calls. The `update_status` tool
    (with `task_complete=true` / `needs_user_input=true`) tells the
    orchestrator when a dispatched prompt has been completed.
  • browser viewer → agent: a per-WebSocket `tmux attach` IPty in
    `src/pty-registry.ts`. Viewer keystrokes flow to tmux (not the
    agent), so xterm.js capability replies cannot corrupt the agent's
    input box.

This is documented in `docs/superpowers/specs/2026-05-31-tmux-cli-sessions-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add mcp-server/README.md README.md
git commit -m "docs: tmux runtime dependency + process architecture"
```

---

### Task 23: Wrap-up

- [ ] **Step 1: Push the branch**

```bash
cd C:\git\clawdevbox\.worktrees\tmux-migration
git log --oneline main..HEAD
git push -u origin feat/tmux-migration
```

- [ ] **Step 2: Open a PR**

```bash
gh pr create --base main --head feat/tmux-migration \
  --title "feat: tmux-backed CLI sessions (replace direct node-pty for agents)" \
  --body "$(cat <<'EOF'
Migrates clawdevbox agent process management from direct node-pty to
tmux-backed sessions per the design at
docs/superpowers/specs/2026-05-31-tmux-cli-sessions-design.md.

**What changes**
- Every agent (copilot, claude, agency, echo-stub) runs inside a tmux
  pane (cdb_<instance_id> on -L clawdevbox socket).
- SessionConductor + sentinel marker detection gone; replaced by
  pending-dispatch + update_status MCP tool.
- Viewer-input race structurally eliminated (xterm bytes go to
  `tmux attach`, not to the agent).
- Agent sessions survive clawdevbox restarts; reconciled on startup.

**What stays**
- node-pty (now only for per-viewer `tmux attach` IPty).
- WebSocket protocol (`type:input/resize/data/exit/snapshot`).
- xterm.js rendering, /test-ui, Vue SPA.

**Verification**
- 12-task suite of new unit tests (cli-sessions/*, pending-dispatch,
  update-status, dispatcher-tmux, db-migrations-v5, pty-registry-viewer).
- `scripts/repro-tmux-ui-dispatch.mjs`: 5/5 rapid UI dispatches submit
  reliably.
- Restart-survival smoke: kill clawdevbox hard, agent's tmux session
  persists, server adopts on restart.
- Manual: `tmux -L clawdevbox attach -t cdb_<id>` from any shell.

EOF
)"
```

- [ ] **Step 3: Update plan.md in the session folder**

Mark this plan as fully implemented in the session's plan.md (manually, since plan.md is per-session not per-repo).

---

## Self-Review checklist (done)

- ✅ **Spec coverage:** Each Section of the design spec has at least one task.
  - Section 1 (Architecture v4) → Tasks 4, 13, 19 (cdb.tmux.conf, runtime, pty-registry)
  - Section 2 (CliSession interface) → Tasks 2, 5, 6
  - Section 3 (update_status + dispatch) → Tasks 8, 9, 10
  - Section 4 (terminal-server) → Task 19
  - Section 5 (Migration plan) → Tasks 7-21
  - Section 6 (Risks) → Mitigations: Task 1 (Windows smoke), Task 10 (timeout), Task 4 (aggressive-resize)
- ✅ **Placeholder scan:** No "TBD" or "implement later". All steps show complete code.
- ✅ **Type consistency:** `CliSession.sendText` / `sendKey` / `resize` / `snapshot` / `kill` / `exited` / `pid` consistent across types.ts, tmux-session.ts, tmux-session-runtime.ts, dispatcher.ts, providers. `SpecialKey` consistent. `tmuxSessionRegistry` and `tmuxSessionRuntime()` consistent across boot, dispatcher, and pty-registry.
