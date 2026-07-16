# Agent CLI Provider Extensibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Each phase is one subagent's scope. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every CLI-specific spawn branch (copilot, claude, agency) from the kernel into a plug-in-loadable `AgentCliProvider` interface. Ship copilot + claude as built-ins (plus echo-stub marked `internal: true` for tests). Wire plugin-provided providers through the existing `clawdevbox init --plugin` flow so installing the agency plugin is a single command.

**Architecture:** A new `mcp-server/src/agent-clis/` module defines `AgentCliProvider` + a tiny `ProviderCtx` helper. Built-in providers ship as TypeScript files; plugin-provided providers come in via `provides.agent_clis[]` in `plugin.yaml` (dynamically `import()`-ed at workspace boot). The workspace exposes `ws.agentCliProviders: Map<string, AgentCliProvider>`. Existing call sites (`recipe-runner.ts`, `cli/start.ts` resume path, `main-agent.ts`) collapse to a single `provider.spawnSession(ctx, opts)` call.

**Tech Stack:** TypeScript (mcp-server), node:test, MCP SDK, `js-yaml`, `node-pty`, `@clack/prompts`.

**Spec:** `docs/specs/2026-05-15-cli-provider-extensibility-design.md`

**Tests:** `npm test` in `mcp-server/`. Build: `npm run build`. Typecheck: `npm run typecheck`. Each phase ends green.

**Baseline:** HEAD `3f6f251` on `main`. 227/227 tests passing. Pre-existing typecheck errors at `template-store.ts:155`, `tools/trigger.ts:658`, `tools/trigger.ts:778` are NOT yours to fix.

---

## File Structure

**New files:**
- `mcp-server/src/agent-clis/types.ts` — `AgentCliProvider`, `SpawnSessionOpts`, `AgentHandle`, `ProviderCtx`, `DetectResult`, `SetupOptions`, related type unions.
- `mcp-server/src/agent-clis/shared.ts` — `probeBinary()`, `writeMcpJson()`, `buildProviderCtx()` helpers.
- `mcp-server/src/agent-clis/copilot.ts` — built-in copilot provider.
- `mcp-server/src/agent-clis/claude.ts` — built-in claude provider.
- `mcp-server/src/agent-clis/echo-stub.ts` — built-in echo-stub (internal: true).
- `mcp-server/src/agent-clis/index.ts` — `BUILTIN_PROVIDERS`, `loadPluginProvider()`.
- `mcp-server/src/cli/config-set.ts` — new `clawdevbox config set` subcommand.
- `mcp-server/tests/agent-clis.test.mjs` — provider unit tests + loader tests.
- `mcp-server/tests/init-cli-chooser.test.mjs` — init chooser flow tests.
- `mcp-server/tests/api-agent-clis.test.mjs` — GET /api/agent-clis tests.
- `mcp-server/tests/fixtures/cli-plugins/test-cli/plugin.yaml` — fake plugin manifest.
- `mcp-server/tests/fixtures/cli-plugins/test-cli/test-provider.mjs` — fake provider module.
- `docs/agent-clis.md` — new reference for the provider system.

**Modified files:**
- `mcp-server/src/workspace.ts` — add `agentCliProviders`, `agentCliProviderErrors`; make `reloadTypeRegistries` async; load plugin-provided providers.
- `mcp-server/src/validators.ts` — add `validatePluginAgentCliEntry`; integrate into `validatePluginManifest`; remove the hard-coded `default_client must be 'claude' or 'copilot'` check (moved to runtime).
- `mcp-server/src/recipe-runner.ts` — drop the if/else CLI chain, route through providers.
- `mcp-server/src/cli/start.ts` — drop the resume-path if/else; mount `GET /api/agent-clis`; thread provider registry into spawn flows.
- `mcp-server/src/cli/mcp.ts` — handle the new async `loadWorkspaceFromEnv` flow.
- `mcp-server/src/main-agent.ts` — remove agency hardcoding; route through configured provider; `MainAgentOptions` gains `cfg`.
- `mcp-server/src/tools/recipe.ts` — open up `agent_cli` schema; runtime-validate against `ws.agentCliProviders`.
- `mcp-server/src/cli/init.ts` — add post-`--plugin` workspace reload + CLI chooser + `default_agent_cli` config write.
- `mcp-server/src/config.ts` — add `default_agent_cli?: string` to `ClawdevboxConfig`; add `defaultAgentCli?: string` to `ResolvedConfig`; merge in `resolveConfig()`.
- `mcp-server/src/cli/index.ts` — wire the new `config set` subcommand.
- `mcp-server/package.json` — add `tests/agent-clis.test.mjs`, `tests/init-cli-chooser.test.mjs`, `tests/api-agent-clis.test.mjs` to the `"test"` script.
- `docs/tools/recipe.md` — note `agent_cli` is open-string; document default resolution chain.
- `docs/plugins.md` — document `provides.agent_clis[]`.
- `docs/MCP-TOOLS-REFERENCE.md` — regenerate.

---

## Phase 1 — Type definitions + workspace registry skeleton

Goal: define the provider interface; carry an empty registry on the workspace; make `reloadTypeRegistries` async.

### Task 1.1: Create `agent-clis/types.ts`

**Files:**
- Create: `mcp-server/src/agent-clis/types.ts`

- [ ] **Step 1: Author the type module**

Create the file with these exports — match the spec §3 exactly:

```ts
import type { IPty } from 'node-pty';
import type { Workspace } from '../workspace.ts';
import type { ResolvedConfig } from '../config.ts';
import type { logger as Logger } from '../logger.ts';

export type SessionMode = 'interactive' | 'headless';

export type SessionInit =
  | { kind: 'new'; session_id: string }
  | { kind: 'resume'; session_id: string };

export type SessionRole = 'main-agent' | 'recipe-instance' | 'sub-agent';

export interface SpawnSessionOpts {
  mode: SessionMode;
  init: SessionInit;
  role: SessionRole;
  /** Required when mode === 'headless'. Optional in interactive mode. */
  prompt?: string;
  workspaceInfo: { id: string; path: string };
  /** Env vars the kernel wants the child process to see (ambient context). */
  ambientEnv: Record<string, string>;
  /** MCP server the child should connect back to. */
  mcp: { url: string; secret: string };
  recipeInstanceId?: string;
  agentSessionId?: string;
  triggerId?: string;
  fireId?: string;
  ptyCols?: number;
  ptyRows?: number;
}

export interface AgentHandle {
  pid: number | null;
  sessionId: string;
  pty: IPty;
  exited: Promise<{ exitCode: number; signal?: string }>;
}

export interface DetectResult {
  available: boolean;
  binary?: string;
  version?: string;
  reason?: string;
}

export interface SetupOptions {
  scope: 'project' | 'global';
}

export interface PtySpawnOpts {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  name?: string;
}

export interface ProviderCtx {
  ws: Workspace;
  cfg: ResolvedConfig;
  logger: typeof Logger;
  spawnPty(file: string, args: string[], opts: PtySpawnOpts): IPty;
  writeWorkspaceFile(relativePath: string, contents: string): void;
}

export interface AgentCliProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: 'builtin' | `plugin:${string}`;
  readonly internal?: boolean;
  detect?(ctx: ProviderCtx): Promise<DetectResult>;
  setup?(ctx: ProviderCtx, opts: SetupOptions): Promise<void>;
  spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle>;
}

/** Error captured when a plugin-provided provider fails to load. */
export interface AgentCliProviderError {
  plugin_id?: string;
  provider_id?: string;
  module?: string;
  error: string;
  code:
    | 'IMPORT_FAILED'
    | 'INVALID_PROVIDER_SHAPE'
    | 'BUILTIN_COLLISION'
    | 'PLUGIN_COLLISION'
    | 'MODULE_PATH_TRAVERSAL'
    | 'MODULE_NOT_FOUND';
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd mcp-server && npm run typecheck`
Expected: only the 3 pre-existing errors. Zero new errors mentioning `agent-clis/`.

- [ ] **Step 3: Commit**

```
git add mcp-server/src/agent-clis/types.ts
git commit -m "feat(agent-clis): provider interface types

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 1.2: Workspace gains the provider registry

**Files:**
- Modify: `mcp-server/src/workspace.ts`

- [ ] **Step 1: Add fields to the `Workspace` interface**

Find the `Workspace` interface (around line 162). Add two fields after `triggerTypeErrors`:

```ts
  /** Agent-CLI provider registry. Built-ins land here first, then plugin-provided overlays. */
  agentCliProviders: Map<string, AgentCliProvider>;
  /** Provider load errors (collisions, malformed plugin modules). */
  agentCliProviderErrors: AgentCliProviderError[];
```

Add the import at the top of the file:

```ts
import type { AgentCliProvider, AgentCliProviderError } from './agent-clis/types.ts';
```

- [ ] **Step 2: Initialize the maps in `loadWorkspaceFromEnv`**

Find `loadWorkspaceFromEnv` (around line 180). In the `ws` object literal (around line 193) add:

```ts
    agentCliProviders: new Map(),
    agentCliProviderErrors: [],
```

- [ ] **Step 3: Verify typecheck**

Run: `cd mcp-server && npm run typecheck`
Expected: only the 3 pre-existing errors.

- [ ] **Step 4: Commit**

```
git add mcp-server/src/workspace.ts
git commit -m "feat(workspace): empty agent-cli provider registry on Workspace

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 1.3: Make `reloadTypeRegistries` async + propagate to callers

**Files:**
- Modify: `mcp-server/src/workspace.ts`
- Modify: `mcp-server/src/cli/start.ts`
- Modify: `mcp-server/src/cli/mcp.ts`
- Modify: any other caller of `reloadTypeRegistries` (grep first).

- [ ] **Step 1: Identify all callers**

Run: `grep -rn "reloadTypeRegistries\|reloadPluginRegistry" mcp-server/src --include='*.ts'`

Make a note of every file that calls it.

- [ ] **Step 2: Convert `reloadTypeRegistries` signature**

Find `export function reloadTypeRegistries(ws: Workspace): void` in `workspace.ts`. Change to:

```ts
export async function reloadTypeRegistries(ws: Workspace): Promise<void> {
  // ... existing body unchanged for now ...
}
```

If a deprecated `reloadPluginRegistry` alias exists, give it the same async signature so callers don't drift.

- [ ] **Step 3: Convert `loadWorkspaceFromEnv` to async**

```ts
export async function loadWorkspaceFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Workspace> {
  // ... existing body ...
  await reloadTypeRegistries(ws);
  warnIfLegacyProjectPlugins(ws);
  return ws;
}
```

- [ ] **Step 4: Update all callers to `await`**

For each caller you noted in Step 1, add `await`. The MCP entry (`cli/mcp.ts`) and the HTTP service entry (`cli/start.ts`) are both already in async functions, so this is mechanical. Plugin tools (`tools/plugin.ts`) that call `reloadTypeRegistries(ws)` synchronously must be made `await`-able — those handlers are already declared `async`.

- [ ] **Step 5: Run tests**

Run: `cd mcp-server && npm test`
Expected: 227/227 still passing. If anything broke, you missed an `await` somewhere.

- [ ] **Step 6: Commit**

```
git add -A mcp-server/src
git commit -m "refactor(workspace): make reloadTypeRegistries async; propagate await to callers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 1.4: Smoke test for the registry skeleton

**Files:**
- Create: `mcp-server/tests/agent-clis.test.mjs`
- Modify: `mcp-server/package.json` — add the new test file to `"test"`.

- [ ] **Step 1: Author the smoke test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceFromEnv } from '../src/workspace.ts';

test('workspace exposes empty agentCliProviders + agentCliProviderErrors', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-cli-skel-'));
  mkdirSync(join(tmp, '.clawdevbox'), { recursive: true });
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: tmp,
    CLAWDEVBOX_GLOBAL_DIR: join(tmp, '.global'),
  });
  assert.ok(ws.agentCliProviders instanceof Map);
  assert.equal(ws.agentCliProviders.size, 0);
  assert.deepEqual(ws.agentCliProviderErrors, []);
});
```

- [ ] **Step 2: Add to package.json test script**

Find the `"test"` script in `mcp-server/package.json`. Append `tests/agent-clis.test.mjs` to the file list.

- [ ] **Step 3: Run**

Run: `cd mcp-server && npm test`
Expected: 228/228 passing.

- [ ] **Step 4: Commit**

```
git add mcp-server/tests/agent-clis.test.mjs mcp-server/package.json
git commit -m "test(agent-clis): registry skeleton smoke test

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase 2 — Built-in providers + shared helpers

### Task 2.1: `agent-clis/shared.ts`

**Files:**
- Create: `mcp-server/src/agent-clis/shared.ts`

- [ ] **Step 1: Write the helper module**

```ts
import { spawn } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as pty from 'node-pty';
import { writeFileAtomic } from '../fs-util.ts';
import type { Workspace } from '../workspace.ts';
import type { ResolvedConfig } from '../config.ts';
import { logger } from '../logger.ts';
import type {
  AgentCliProvider,
  DetectResult,
  ProviderCtx,
  PtySpawnOpts,
} from './types.ts';

/** Spawn the binary with `args` and capture exit. Used by provider.detect(). */
export async function probeBinary(
  bin: string,
  args: string[] = ['--version'],
  timeoutMs = 5000,
): Promise<DetectResult> {
  return new Promise((resolveDetect) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, shell: false });
    } catch (err) {
      resolveDetect({ available: false, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolveDetect({ available: false, binary: bin, reason: `probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.stdout?.on('data', (b) => { stdout += b.toString('utf8'); });
    proc.stderr?.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolveDetect({ available: false, binary: bin, reason: err.message });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const version = (stdout || stderr).trim().split('\n')[0] || undefined;
        resolveDetect({ available: true, binary: bin, version });
      } else {
        resolveDetect({ available: false, binary: bin, reason: `exit ${code}: ${(stderr || stdout).trim().split('\n')[0]}` });
      }
    });
  });
}

/** Write `.mcp.json` so the spawned CLI sees the clawdevbox MCP server. */
export function writeMcpJson(
  ctx: ProviderCtx,
  wsPath: string,
  mcp: { url: string; secret: string },
): void {
  const config = {
    mcpServers: {
      clawdevbox: {
        type: 'streamable-http',
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.secret}` },
        tools: ['*'],
      },
    },
  };
  ctx.writeWorkspaceFile('.mcp.json', JSON.stringify(config, null, 2) + '\n');
}

/** Build the ProviderCtx the kernel hands to a provider for one call. */
export function buildProviderCtx(ws: Workspace, cfg: ResolvedConfig): ProviderCtx {
  return {
    ws,
    cfg,
    logger,
    spawnPty(file, args, opts: PtySpawnOpts) {
      return pty.spawn(file, args, {
        name: opts.name ?? 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
      });
    },
    writeWorkspaceFile(rel, contents) {
      // Reject path traversal.
      const abs = resolve(ws.projectDir, rel);
      const rel2 = relative(ws.projectDir, abs);
      if (rel2.startsWith('..') || resolve(ws.projectDir, rel2) !== abs) {
        throw new Error(`writeWorkspaceFile: path '${rel}' escapes the workspace`);
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileAtomic(abs, contents);
    },
  };
}

/** Pretty-print an Error for use in `DetectResult.reason`. */
export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd mcp-server && npm run typecheck`
Expected: only the 3 pre-existing errors.

- [ ] **Step 3: Commit**

```
git add mcp-server/src/agent-clis/shared.ts
git commit -m "feat(agent-clis): shared helpers (probeBinary, writeMcpJson, buildProviderCtx)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2.2: `agent-clis/copilot.ts`

**Files:**
- Create: `mcp-server/src/agent-clis/copilot.ts`

- [ ] **Step 1: Write the provider**

```ts
import { join } from 'node:path';
import { writeMcpJson, probeBinary } from './shared.ts';
import type { AgentCliProvider, AgentHandle, ProviderCtx, SpawnSessionOpts } from './types.ts';

function resolveBinary(): string {
  const isWin = process.platform === 'win32';
  return process.env.CLAWDEVBOX_COPILOT_PATH ?? (isWin ? 'copilot.exe' : 'copilot');
}

export const copilotProvider: AgentCliProvider = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  description: 'The official GitHub Copilot CLI (`copilot`). Supports headless prompts and resumable sessions.',
  source: 'builtin',

  async detect(_ctx: ProviderCtx) {
    return probeBinary(resolveBinary(), ['--version']);
  },

  async spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle> {
    const bin = resolveBinary();
    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);
    const mcpPath = join(opts.workspaceInfo.path, '.mcp.json');

    const sessionFlag = opts.init.kind === 'new'
      ? `--name=${opts.init.session_id}`
      : `--resume=${opts.init.session_id}`;

    const argv: string[] = [sessionFlag, '--additional-mcp-config', `@${mcpPath}`];
    if (opts.mode === 'headless') {
      if (!opts.prompt) throw new Error('copilot: headless mode requires opts.prompt');
      argv.push('--allow-all-tools', '-p', opts.prompt);
    }

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    const pty = ctx.spawnPty(bin, argv, {
      cwd: opts.workspaceInfo.path, env,
      cols: opts.ptyCols ?? 120, rows: opts.ptyRows ?? 30,
    });

    return {
      pid: pty.pid ?? null,
      sessionId: opts.init.session_id,
      pty,
      exited: new Promise((resolveExit) => pty.onExit(({ exitCode, signal }) =>
        resolveExit({ exitCode, signal: signal != null ? String(signal) : undefined }))),
    };
  },
};
```

- [ ] **Step 2: Commit**

```
git add mcp-server/src/agent-clis/copilot.ts
git commit -m "feat(agent-clis): copilot built-in provider

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2.3: `agent-clis/claude.ts`

**Files:**
- Create: `mcp-server/src/agent-clis/claude.ts`

- [ ] **Step 1: Write the provider**

```ts
import { writeMcpJson, probeBinary } from './shared.ts';
import type { AgentCliProvider, AgentHandle, ProviderCtx, SpawnSessionOpts } from './types.ts';

function resolveBinary(): { file: string; argsPrefix: string[] } {
  const env = process.env.CLAWDEVBOX_CLAUDE_PATH;
  if (env) return { file: env, argsPrefix: [] };
  // Claude is typically a JS launcher, not a standalone .exe on Windows.
  if (process.platform === 'win32') return { file: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', 'claude'] };
  return { file: 'claude', argsPrefix: [] };
}

export const claudeProvider: AgentCliProvider = {
  id: 'claude',
  displayName: 'Anthropic Claude Code',
  description: 'The Anthropic Claude Code CLI (`claude`). Supports headless prompts and resumable sessions.',
  source: 'builtin',

  async detect(_ctx: ProviderCtx) {
    const { file, argsPrefix } = resolveBinary();
    return probeBinary(file, [...argsPrefix, '--version']);
  },

  async spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle> {
    const { file, argsPrefix } = resolveBinary();
    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);

    const sessionArgs = opts.init.kind === 'new'
      ? ['--session-id', opts.init.session_id]
      : ['--resume', opts.init.session_id];

    const argv: string[] = [...argsPrefix, ...sessionArgs];
    if (opts.mode === 'headless') {
      if (!opts.prompt) throw new Error('claude: headless mode requires opts.prompt');
      argv.push('-p', opts.prompt);
    }

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    const pty = ctx.spawnPty(file, argv, {
      cwd: opts.workspaceInfo.path, env,
      cols: opts.ptyCols ?? 120, rows: opts.ptyRows ?? 30,
    });

    return {
      pid: pty.pid ?? null,
      sessionId: opts.init.session_id,
      pty,
      exited: new Promise((resolveExit) => pty.onExit(({ exitCode, signal }) =>
        resolveExit({ exitCode, signal: signal != null ? String(signal) : undefined }))),
    };
  },
};
```

- [ ] **Step 2: Commit**

```
git add mcp-server/src/agent-clis/claude.ts
git commit -m "feat(agent-clis): claude built-in provider

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2.4: `agent-clis/echo-stub.ts`

**Files:**
- Create: `mcp-server/src/agent-clis/echo-stub.ts`

- [ ] **Step 1: Author the provider**

Extract the existing echo-stub script body from `recipe-runner.ts` (find the block around line 240-272 that synthesizes `scriptBody`) and move it here, parameterized.

```ts
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFileAtomic } from '../fs-util.ts';
import type { AgentCliProvider, AgentHandle, ProviderCtx, SpawnSessionOpts } from './types.ts';

function renderScriptBody(opts: SpawnSessionOpts): string {
  // Compose a node-runnable script that writes a tiny artifact and marks
  // the instance done. Used purely by tests; not a real agent.
  // ... see implementation in recipe-runner.ts current `scriptBody` literal ...
  return `// echo-stub generated script for session ${opts.init.session_id}
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(process.env.CLAWDEVBOX_PROJECT_DIR ?? '.', 'artifacts', 'echo-stub-' + Date.now());
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'content.md'),
  '# Echo Stub\\nsession_id=' + ${JSON.stringify(opts.init.session_id)} +
  '\\nprompt=' + ${JSON.stringify(opts.prompt ?? '')});
process.stdout.write('[echo-stub] wrote ' + dir + '\\n');
process.exit(0);
`;
}

export const echoStubProvider: AgentCliProvider = {
  id: 'echo-stub',
  displayName: 'Echo Stub (testing)',
  description: 'A no-network test fixture provider. Writes a small artifact and exits successfully.',
  source: 'builtin',
  internal: true,

  async detect(_ctx: ProviderCtx) {
    return { available: true, binary: process.execPath, version: process.version };
  },

  async spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle> {
    const dir = join(opts.workspaceInfo.path, '.clawdevbox', 'echo-stub');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, `${opts.init.session_id}.cjs`);
    writeFileAtomic(scriptPath, renderScriptBody(opts));

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    const pty = ctx.spawnPty(process.execPath, [scriptPath], {
      cwd: opts.workspaceInfo.path, env,
      cols: opts.ptyCols ?? 80, rows: opts.ptyRows ?? 24,
    });
    return {
      pid: pty.pid ?? null,
      sessionId: opts.init.session_id,
      pty,
      exited: new Promise((resolveExit) => pty.onExit(({ exitCode, signal }) =>
        resolveExit({ exitCode, signal: signal != null ? String(signal) : undefined }))),
    };
  },
};
```

Note: the spec calls for keeping all four legacy echo-stub behaviors (fresh-recipe, resume, artifact-write, instance-done). The minimal stub above writes an artifact and exits; that's enough for the kernel tests to verify the spawn path. If existing tests depended on the more elaborate `recipe-instances/<id>.json` updates inside the echo-stub script, port that logic too — search `recipe-runner.ts` for the existing scriptBody and replicate the parts the tests check.

- [ ] **Step 2: Commit**

```
git add mcp-server/src/agent-clis/echo-stub.ts
git commit -m "feat(agent-clis): echo-stub built-in provider (internal: true)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2.5: `agent-clis/index.ts` — registration

**Files:**
- Create: `mcp-server/src/agent-clis/index.ts`
- Modify: `mcp-server/src/workspace.ts` — call `registerBuiltinProviders(ws)` at the top of `reloadTypeRegistries`.

- [ ] **Step 1: Write index.ts**

```ts
import { copilotProvider } from './copilot.ts';
import { claudeProvider } from './claude.ts';
import { echoStubProvider } from './echo-stub.ts';
import type { AgentCliProvider } from './types.ts';
import type { Workspace } from '../workspace.ts';

export const BUILTIN_PROVIDERS: AgentCliProvider[] = [
  copilotProvider,
  claudeProvider,
  echoStubProvider,
];

/** Insert each built-in into the workspace's provider registry. Always runs
 *  first so plugin-provided providers can't shadow built-in ids. */
export function registerBuiltinProviders(ws: Workspace): void {
  for (const p of BUILTIN_PROVIDERS) {
    ws.agentCliProviders.set(p.id, p);
  }
}

export type { AgentCliProvider, AgentHandle, SpawnSessionOpts, ProviderCtx, DetectResult } from './types.ts';
```

- [ ] **Step 2: Wire into `reloadTypeRegistries`**

In `workspace.ts`, find `reloadTypeRegistries`. At the start of the function body:

```ts
export async function reloadTypeRegistries(ws: Workspace): Promise<void> {
  // Clear and reseed the agent-CLI registry on every reload.
  ws.agentCliProviders = new Map();
  ws.agentCliProviderErrors = [];
  // Built-ins always go first so they win id collisions vs plugins.
  registerBuiltinProviders(ws);
  // ... existing reload body for plugins/triggerTypes (unchanged) ...
}
```

Add the import:

```ts
import { registerBuiltinProviders } from './agent-clis/index.ts';
```

- [ ] **Step 3: Update the smoke test**

The test from Task 1.4 expected `agentCliProviders.size === 0`. Update to expect 3 (copilot, claude, echo-stub):

```js
assert.equal(ws.agentCliProviders.size, 3);
assert.ok(ws.agentCliProviders.has('copilot'));
assert.ok(ws.agentCliProviders.has('claude'));
assert.ok(ws.agentCliProviders.has('echo-stub'));
assert.equal(ws.agentCliProviders.get('echo-stub')?.internal, true);
```

- [ ] **Step 4: Run tests**

Run: `cd mcp-server && npm test`
Expected: 228/228 passing.

- [ ] **Step 5: Commit**

```
git add -A mcp-server/src mcp-server/tests
git commit -m "feat(agent-clis): register built-in providers on workspace reload

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2.6: Provider unit tests

**Files:**
- Modify: `mcp-server/tests/agent-clis.test.mjs`

- [ ] **Step 1: Add per-provider argv-shape tests**

For each of copilot, claude, echo-stub, write a test that:
1. Creates a tmp workspace.
2. Builds a `ProviderCtx` via `buildProviderCtx(ws, cfg)`.
3. Calls `provider.spawnSession(ctx, opts)` with each combination of `mode`/`init`.
4. Captures the spawn via a `ctx.spawnPty` interceptor (override before calling).
5. Asserts the captured `(file, argv)`.

Helper pattern:

```js
function captureSpawnCtx(realCtx) {
  let captured;
  return {
    ...realCtx,
    spawnPty(file, args, opts) {
      captured = { file, args, opts };
      // Return a fake IPty so the function can complete.
      return {
        pid: 12345,
        onExit(cb) { setImmediate(() => cb({ exitCode: 0, signal: 0 })); },
        onData() {}, write() {}, kill() {}, resize() {},
      };
    },
    _captured() { return captured; },
  };
}
```

Test cases (per provider): `[interactive×new, interactive×resume, headless×new, headless×resume]`. For each, assert `file` and `args` contain the right flags. For headless, assert `prompt` ends up in the argv. For copilot, assert `--additional-mcp-config @<path>` appears. For claude on Windows, assert `cmd.exe /d /s /c claude` prefix.

- [ ] **Step 2: Run**

Run: `cd mcp-server && npm test`
Expected: all green; ~12 new test cases.

- [ ] **Step 3: Commit**

```
git add mcp-server/tests/agent-clis.test.mjs
git commit -m "test(agent-clis): built-in provider argv shapes

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase 3 — Plugin manifest extension + dynamic loader

### Task 3.1: Manifest schema + validator

**Files:**
- Modify: `mcp-server/src/workspace.ts` — add `PluginAgentCliEntry` to `PluginManifest.provides`.
- Modify: `mcp-server/src/validators.ts` — add `validatePluginAgentCliEntry`; integrate into `validatePluginManifest`.

- [ ] **Step 1: Extend the type**

In `workspace.ts`, find `PluginManifest.provides`. Add:

```ts
export interface PluginAgentCliEntry {
  id: string;
  module: string;
  display_name?: string;
  description?: string;
}

export interface PluginManifest {
  // ... existing fields ...
  provides?: {
    // ... existing ...
    agent_clis?: PluginAgentCliEntry[];
  };
}
```

- [ ] **Step 2: Validator**

In `validators.ts`, add the helper:

```ts
function validatePluginAgentCliEntry(entry: unknown, i: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const path = `provides.agent_clis[${i}]`;
  if (!isPlainObject(entry)) {
    errors.push({ path, code: 'TYPE', message: 'agent_clis entry must be an object.' });
    return errors;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(e.id)) {
    errors.push({ path: `${path}.id`, code: 'INVALID_VALUE',
      message: 'id is required and must match /^[a-z0-9][a-z0-9._-]*$/i' });
  }
  if (typeof e.module !== 'string' || e.module.trim() === '') {
    errors.push({ path: `${path}.module`, code: 'REQUIRED', message: 'module is required.' });
  } else if (e.module.includes('..') || e.module.startsWith('/') || /^[A-Z]:/i.test(e.module)) {
    errors.push({ path: `${path}.module`, code: 'INVALID_VALUE',
      message: 'module must be a relative path with no .. segments.' });
  }
  if (e.display_name !== undefined && typeof e.display_name !== 'string') {
    errors.push({ path: `${path}.display_name`, code: 'TYPE', message: 'display_name must be a string.' });
  }
  if (e.description !== undefined && typeof e.description !== 'string') {
    errors.push({ path: `${path}.description`, code: 'TYPE', message: 'description must be a string.' });
  }
  return errors;
}
```

Inside `validatePluginManifest`, locate where `provides.trigger_types` is validated. Add a parallel block for `provides.agent_clis`.

- [ ] **Step 3: Tests**

In an existing or new test file, add cases: valid entry, missing id, bad id, missing module, traversal (`../foo.js`), absolute path, bad display_name type. Assert the validator returns the expected errors.

- [ ] **Step 4: Run tests; commit**

Run: `npm test`. Expected: green.

```
git add -A
git commit -m "feat(plugin): provides.agent_clis manifest entry + validator

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3.2: Dynamic-import loader

**Files:**
- Create: `mcp-server/src/agent-clis/load-plugin.ts`
- Modify: `mcp-server/src/workspace.ts` — call `loadPluginProviders(ws)` from `reloadTypeRegistries`.

- [ ] **Step 1: Author the loader**

```ts
import { existsSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger.ts';
import type { Workspace } from '../workspace.ts';
import type { AgentCliProvider, AgentCliProviderError, PluginAgentCliEntry } from './types.ts';

const VALID_PROVIDER_KEYS = ['id', 'displayName', 'description', 'source', 'internal', 'detect', 'setup', 'spawnSession'] as const;

function shapeOk(obj: unknown): obj is AgentCliProvider {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Record<string, unknown>;
  return typeof p.id === 'string'
    && typeof p.displayName === 'string'
    && typeof p.description === 'string'
    && typeof p.spawnSession === 'function';
}

/** Walk every enabled plugin's `provides.agent_clis[]` and dynamic-import each. */
export async function loadPluginProviders(ws: Workspace): Promise<void> {
  // Sort plugins for deterministic collision precedence (first-loaded wins).
  const sorted = [...ws.plugins.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const plugin of sorted) {
    if (plugin.status !== 'enabled') continue;
    const entries = plugin.manifest.provides?.agent_clis ?? [];
    for (const entry of entries) {
      await loadOne(ws, plugin.id, plugin.dir, entry);
    }
  }
}

async function loadOne(
  ws: Workspace,
  pluginId: string,
  pluginDir: string,
  entry: PluginAgentCliEntry,
): Promise<void> {
  const record = (code: AgentCliProviderError['code'], error: string, providerId?: string): void => {
    ws.agentCliProviderErrors.push({ plugin_id: pluginId, provider_id: providerId ?? entry.id, module: entry.module, error, code });
  };

  // Built-in collision check.
  if (ws.agentCliProviders.has(entry.id)) {
    const existing = ws.agentCliProviders.get(entry.id)!;
    if (existing.source === 'builtin') {
      record('BUILTIN_COLLISION',
        `plugin '${pluginId}' tried to register built-in provider id '${entry.id}'`);
      return;
    } else {
      record('PLUGIN_COLLISION',
        `plugin '${pluginId}' tried to register provider id '${entry.id}', already provided by ${existing.source}`);
      return;
    }
  }

  // Resolve module path, reject traversal.
  const abs = resolve(pluginDir, entry.module);
  const rel = relative(pluginDir, abs);
  if (rel.startsWith('..') || resolve(pluginDir, rel) !== abs) {
    record('MODULE_PATH_TRAVERSAL', `module '${entry.module}' escapes plugin directory`);
    return;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    record('MODULE_NOT_FOUND', `module file not found at ${abs}`);
    return;
  }

  let mod: any;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (err) {
    record('IMPORT_FAILED', err instanceof Error ? err.message : String(err));
    return;
  }

  const candidate = mod?.provider ?? mod?.default ?? mod;
  if (!shapeOk(candidate)) {
    record('INVALID_PROVIDER_SHAPE',
      `module default export does not conform to AgentCliProvider (must have id, displayName, description, spawnSession)`);
    return;
  }
  if (candidate.id !== entry.id) {
    record('INVALID_PROVIDER_SHAPE',
      `module's provider.id ('${candidate.id}') does not match manifest entry.id ('${entry.id}')`);
    return;
  }

  // Stamp source AFTER validation (the module may have left source unset).
  const finalProvider: AgentCliProvider = {
    ...candidate,
    source: `plugin:${pluginId}`,
    displayName: entry.display_name ?? candidate.displayName,
    description: entry.description ?? candidate.description,
  };
  ws.agentCliProviders.set(entry.id, finalProvider);
  logger.info({ providerId: entry.id, pluginId, module: entry.module }, 'agent-cli provider loaded');
}
```

- [ ] **Step 2: Wire into reload**

In `workspace.ts`'s `reloadTypeRegistries`, after `registerBuiltinProviders(ws)` and after plugins are otherwise loaded:

```ts
import { loadPluginProviders } from './agent-clis/load-plugin.ts';
// ...
await loadPluginProviders(ws);
```

The location matters: it must come AFTER `ws.plugins` is populated by the existing plugin scan, but BEFORE callers use `ws.agentCliProviders`.

- [ ] **Step 3: Run tests**

Run: `npm test`. Expected: 228+ passing.

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "feat(agent-clis): dynamic-import loader for plugin-provided providers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3.3: Loader tests via a fake plugin fixture

**Files:**
- Create: `mcp-server/tests/fixtures/cli-plugins/test-cli/plugin.yaml`
- Create: `mcp-server/tests/fixtures/cli-plugins/test-cli/test-provider.mjs`
- Create: `mcp-server/tests/fixtures/cli-plugins/bad-shape/plugin.yaml`
- Create: `mcp-server/tests/fixtures/cli-plugins/bad-shape/bad-provider.mjs`
- Create: `mcp-server/tests/fixtures/cli-plugins/traversal/plugin.yaml`
- Modify: `mcp-server/tests/agent-clis.test.mjs`

- [ ] **Step 1: Author the fake plugins**

`fixtures/cli-plugins/test-cli/plugin.yaml`:
```yaml
id: test-cli
name: Test CLI
version: 0.1.0
description: Fixture plugin for the AgentCliProvider loader tests.
provides:
  agent_clis:
    - id: test-cli
      module: test-provider.mjs
      display_name: "Test CLI Provider"
      description: "Returns a fake handle."
```

`fixtures/cli-plugins/test-cli/test-provider.mjs`:
```js
export default {
  id: 'test-cli',
  displayName: 'Test CLI Provider',
  description: 'Returns a fake handle.',
  source: 'builtin',   // will be overwritten to 'plugin:test-cli' by the loader
  async detect() { return { available: true, binary: 'test-cli', version: '0.1.0' }; },
  async spawnSession(_ctx, _opts) {
    throw new Error('fixture provider — spawnSession not implemented');
  },
};
```

`fixtures/cli-plugins/bad-shape/plugin.yaml`:
```yaml
id: bad-shape
name: Bad Shape
version: 0.1.0
description: Fixture for INVALID_PROVIDER_SHAPE.
provides:
  agent_clis:
    - id: bad-shape
      module: bad-provider.mjs
```

`fixtures/cli-plugins/bad-shape/bad-provider.mjs`:
```js
export default { id: 'bad-shape' };  // missing displayName/description/spawnSession
```

`fixtures/cli-plugins/traversal/plugin.yaml`:
```yaml
id: traversal
name: Path Traversal
version: 0.1.0
description: Fixture for MODULE_PATH_TRAVERSAL.
provides:
  agent_clis:
    - id: traversal
      module: ../../../etc/evil.js
```

- [ ] **Step 2: Add loader tests**

In `agent-clis.test.mjs`, add tests that:

1. Copy `test-cli/` into a tmp `<globalDir>/plugins/test-cli/`, load workspace, assert `ws.agentCliProviders.has('test-cli')` is true and `source === 'plugin:test-cli'`.
2. Plant `bad-shape/` similarly, load workspace, assert `agentCliProviderErrors` has an entry with `code: 'INVALID_PROVIDER_SHAPE'`.
3. Plant `traversal/`, load workspace, assert `agentCliProviderErrors` has an entry with `code: 'MODULE_PATH_TRAVERSAL'`.
4. Plant `test-cli/` AND a competing plugin that also tries `id: 'copilot'` → assert built-in wins, error has `code: 'BUILTIN_COLLISION'`.
5. Plant two plugins both registering id `'twin'` → assert first-by-id wins; the other has `code: 'PLUGIN_COLLISION'`.

Test setup helper (since plugins need to be in `<globalDir>/plugins/<id>/`):

```js
import { cpSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupTmpWorkspace(fixturePlugins) {
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-cli-load-'));
  const project = tmp;
  const global = join(tmp, '.global');
  mkdirSync(join(global, 'plugins'), { recursive: true });
  for (const p of fixturePlugins) {
    cpSync(join('tests', 'fixtures', 'cli-plugins', p), join(global, 'plugins', p), { recursive: true });
  }
  return { project, global };
}
```

- [ ] **Step 3: Run tests; commit**

```
npm test                  # expect green
git add -A mcp-server
git commit -m "test(agent-clis): plugin loader — happy path, bad shape, traversal, collisions

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase 4 — Refactor call sites

### Task 4.1: Refactor `recipe-runner.ts`

**Files:**
- Modify: `mcp-server/src/recipe-runner.ts`

- [ ] **Step 1: Drop the if/else chain**

Find the block at lines 276-303 with `if (agentCli === 'copilot') { … } else if … else if (agentCli === 'echo-stub') { … }`. Replace with:

```ts
const provider = opts.ws.agentCliProviders.get(agentCli);
if (!provider) {
  throw new Error(`unknown agent_cli '${agentCli}' (available: ${[...opts.ws.agentCliProviders.keys()].join(', ')})`);
}
const ctxForProvider = buildProviderCtx(opts.ws, opts.cfg);
const handle = await provider.spawnSession(ctxForProvider, {
  mode: 'headless',
  init: isResume
    ? { kind: 'resume', session_id: sessionId }
    : { kind: 'new', session_id: sessionId },
  role: 'recipe-instance',
  prompt: opts.prompt,
  workspaceInfo: opts.workspaceInfo,
  ambientEnv: spawnEnv,
  mcp: { url: opts.mcpUrl ?? '', secret: opts.mcpSecret ?? '' },
  recipeInstanceId: instanceId,
  agentSessionId: sessionId,
  triggerId: opts.triggerId,
  fireId: opts.fireId,
  ptyCols: 120, ptyRows: 30,
});
const pid = handle.pid ?? undefined;
const ptyProc = handle.pty;
```

`RunRecipeOptions` needs a `ws: Workspace` and `cfg: ResolvedConfig` field if it doesn't have them — add to the interface; threading them through callers (e.g., the `recipe.run` MCP tool handler in `tools/recipe.ts`).

Remove the now-unused `AgentCli` union literal (`'copilot' | 'claude' | 'echo-stub'`) and replace with `string`.

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: existing recipe-run tests pass (they used echo-stub previously and still should). If anything fails, check the spawnEnv composition.

- [ ] **Step 3: Commit**

```
git add mcp-server/src/recipe-runner.ts mcp-server/src/tools/recipe.ts
git commit -m "refactor(recipe-runner): route through agent-CLI providers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4.2: Refactor `cli/start.ts` resume path

**Files:**
- Modify: `mcp-server/src/cli/start.ts`

- [ ] **Step 1: Delete the duplicate chain**

Find lines 1115-1144 (the recipe-resume HTTP handler if/else). Replace with:

```ts
const provider = ws.agentCliProviders.get(agentCli);
if (!provider) {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'UNKNOWN_AGENT_CLI', message: `provider '${agentCli}' is not registered` } }));
  return;
}
const ctxForProvider = buildProviderCtx(ws, cfg);
const handle = await provider.spawnSession(ctxForProvider, {
  mode: 'interactive',
  init: { kind: 'resume', session_id: sessionId },
  role: 'recipe-instance',
  workspaceInfo: { id: source.workspace_id, path: workspacePath },
  ambientEnv: spawnEnv,
  mcp: { url: `${cfg.http.host}:${cfg.http.port}/mcp`, secret: cfg.http.token ?? '' },
  recipeInstanceId: newInstanceId,
  ptyCols: 120, ptyRows: 30,
});
const pid = handle.pid;
const ptyProc = handle.pty;
```

Add import for `buildProviderCtx` at the top of the file.

- [ ] **Step 2: Run tests; commit**

```
npm test
git add mcp-server/src/cli/start.ts
git commit -m "refactor(start): resume path uses agent-CLI provider

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4.3: Refactor `main-agent.ts` — remove agency hardcoding

**Files:**
- Modify: `mcp-server/src/main-agent.ts`
- Modify: callers of `startMainAgent` and `restartMainAgent` to pass `cfg`.

- [ ] **Step 1: Update `MainAgentOptions`**

```ts
import type { ResolvedConfig } from './config.ts';

interface MainAgentOptions {
  workspace: Workspace;
  cfg: ResolvedConfig;
  host?: string;
  port?: number;
}
```

- [ ] **Step 2: Replace the spawn body**

Delete the entire `writeMcpAndAgencyConfig` function. Delete the `agencyBin` resolution. Delete `agency.toml` writing. Replace the body of `startMainAgent` with the provider-routed version per spec §7.3:

```ts
export async function startMainAgent(opts: MainAgentOptions): Promise<MainAgentStatus> {
  if (hasSession(MAIN_AGENT_INSTANCE_ID)) {
    const status = getMainAgentStatus();
    if (status.running) return status;
  }

  seedDevBuddySkill(opts.workspace);

  const providerId = opts.cfg.defaultAgentCli ?? 'copilot';
  const provider = opts.workspace.agentCliProviders.get(providerId);
  if (!provider) {
    logger.warn({ providerId, available: [...opts.workspace.agentCliProviders.keys()] },
      'main-agent: configured provider is not registered — main agent disabled');
    return { instance_id: MAIN_AGENT_INSTANCE_ID, running: false, exited: false,
      agent_cli: providerId, view_url_path: `/terminal/${MAIN_AGENT_INSTANCE_ID}` };
  }

  const sessionId = mintMainAgentSessionId();
  const ctx = buildProviderCtx(opts.workspace, opts.cfg);

  let handle;
  try {
    handle = await provider.spawnSession(ctx, {
      mode: 'interactive',
      init: { kind: 'new', session_id: sessionId },
      role: 'main-agent',
      workspaceInfo: { id: 'project', path: opts.workspace.projectDir },
      ambientEnv: {
        CLAWDEVBOX_WORKSPACE_ID: 'project',
        CLAWDEVBOX_PROJECT_DIR: opts.workspace.projectDir,
        CLAWDEVBOX_GLOBAL_DIR: opts.workspace.globalDir,
      },
      mcp: {
        url: `http://${opts.host ?? '127.0.0.1'}:${opts.port ?? 5201}/mcp`,
        secret: opts.cfg.http.token ?? '',
      },
      ptyCols: 120, ptyRows: 30,
    });
  } catch (err) {
    logger.warn({ err, providerId }, 'main-agent: provider spawn failed; home page will show empty terminal');
    return { instance_id: MAIN_AGENT_INSTANCE_ID, running: false, exited: false,
      agent_cli: providerId, view_url_path: `/terminal/${MAIN_AGENT_INSTANCE_ID}` };
  }

  agentPid = handle.pid;
  registerPty({ instanceId: MAIN_AGENT_INSTANCE_ID, workspaceId: 'project', cols: 120, rows: 30, ipty: handle.pty });
  handle.exited.then(({ exitCode, signal }) => {
    logger.info({ exitCode, signal, pid: agentPid }, 'main-agent: exited');
    agentPid = null;
    emitChange('agent');
  });
  emitChange('agent');
  logger.info({ providerId, pid: agentPid, projectDir: opts.workspace.projectDir }, 'main-agent: started');

  return getMainAgentStatus(providerId);
}

function mintMainAgentSessionId(): string {
  return 'main-' + Date.now().toString(36);
}
```

Change `MainAgentStatus.agent_cli` from the literal `'copilot'` to `string`. Update `getMainAgentStatus` to accept an optional providerId arg and use that. Also `restartMainAgent` needs to mirror the new async + cfg signature.

- [ ] **Step 3: Update callers**

In `cli/start.ts`, find where `startMainAgent({ workspace, host, port })` is called and add `cfg`. The caller already has `cfg` in scope.

- [ ] **Step 4: Run tests**

```
npm test
```

Expected: green. The main-agent boot test (if any) will need updating to pass `cfg`.

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "refactor(main-agent): remove agency hardcoding; route through provider

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4.4: Verify no agency references remain in OSS

- [ ] **Step 1: Grep**

Run:
```
grep -rn "agency" mcp-server/src --include='*.ts'
```

Expected: zero matches. If any remain, hunt them down (comments, docstrings, log messages).

Acceptable: matches in tests fixtures that exercise a fake `agency` provider (none yet — would land in Phase 10).

- [ ] **Step 2: Commit if anything changed**

```
git add -A
git commit -m "chore: remove last agency reference from OSS kernel

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase 5 — Config + tools schema opening

### Task 5.1: `default_agent_cli` on config

**Files:**
- Modify: `mcp-server/src/config.ts`

- [ ] **Step 1: Add to `ClawdevboxConfig`**

```ts
export interface ClawdevboxConfig {
  // ... existing fields ...
  /** Provider id (e.g. 'copilot', 'claude', 'agency'). Falls back to 'copilot' if unset. */
  default_agent_cli?: string;
}
```

- [ ] **Step 2: Add to `ResolvedConfig`**

```ts
export interface ResolvedConfig {
  // ... existing fields ...
  defaultAgentCli: string | null;
}
```

- [ ] **Step 3: Merge in `resolveConfig`**

Find the resolver function. Add resolution: project config takes precedence over global. Default `null`. The kernel falls back to `'copilot'` at the call edge.

- [ ] **Step 4: Update `validateConfig`**

Add a type check: if `default_agent_cli` is present, it must be a non-empty string matching `/^[a-z0-9][a-z0-9._-]*$/i`.

- [ ] **Step 5: Run tests; commit**

```
npm test
git add mcp-server/src/config.ts
git commit -m "feat(config): default_agent_cli field

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5.2: `tools/recipe.ts` open-up

**Files:**
- Modify: `mcp-server/src/tools/recipe.ts`

- [ ] **Step 1: Replace zod enum with string + runtime validation**

Find `.enum(['copilot', 'claude', 'echo-stub'])` (line ~300). Replace with `.string()`.

Inside the handler (line ~381 area), before passing `agentCli` downstream, validate:

```ts
const agentCli = (args.agent_cli ?? ctx.cfg.defaultAgentCli ?? 'copilot') as string;
if (!ctx.ws.agentCliProviders.has(agentCli)) {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: {
        code: 'UNKNOWN_AGENT_CLI',
        message: `provider '${agentCli}' is not registered (available: ${[...ctx.ws.agentCliProviders.keys()].filter(id => !ctx.ws.agentCliProviders.get(id)?.internal).join(', ')})`,
      },
    }) }],
  };
}
```

(`internal` providers like echo-stub are STILL valid targets — the user can explicitly opt in — but the error message lists only user-facing ones to avoid confusing OSS users.)

Test fix: any existing test that mocks `agent_cli` with a literal works unchanged.

- [ ] **Step 2: Run tests; commit**

```
npm test
git add mcp-server/src/tools/recipe.ts
git commit -m "feat(recipe): agent_cli accepts any registered provider id

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5.3: `validators.ts` recipe default_client

**Files:**
- Modify: `mcp-server/src/validators.ts`

- [ ] **Step 1: Soften the `default_client` check**

Find the line: `if (r.default_client !== undefined && r.default_client !== 'claude' && r.default_client !== 'copilot') { … }`. Replace with a kind/string check only:

```ts
if (r.default_client !== undefined) {
  if (typeof r.default_client !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(r.default_client)) {
    errors.push({ path: 'default_client', code: 'INVALID_VALUE',
      message: `default_client must be a non-empty provider id (e.g. 'copilot', 'claude', 'agency').` });
  }
}
```

The actual "is this id registered" check moves to `recipe.run`/`recipe.upsert` handlers where `ws` is in scope.

- [ ] **Step 2: Inside `recipe.run` and `recipe.upsert` handlers**

After parsing the recipe, before spawning: if `recipe.default_client && !ws.agentCliProviders.has(recipe.default_client)`, return `UNKNOWN_AGENT_CLI`.

- [ ] **Step 3: Update tests**

Any test that asserted "default_client must be 'claude' or 'copilot'" needs softening. Replace with the new shape.

- [ ] **Step 4: Run tests; commit**

```
npm test
git add -A
git commit -m "feat(validators): default_client accepts any provider id; runtime-checked

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase 6 — Init chooser

### Task 6.1: Workspace reload after `--plugin` install

**Files:**
- Modify: `mcp-server/src/cli/init.ts`

- [ ] **Step 1: Find the post-install spot**

Find the loop that installs each pick from `externalPicks` / `selectedPluginIds` (likely around line 440-500). After that loop completes:

```ts
// Plugins were just dropped on disk; reload the workspace registry so the
// CLI chooser below sees their provides.agent_clis[].
await reloadTypeRegistries(ws);   // ws must be in scope; if it isn't, load it here
```

If `ws` isn't yet constructed at this point in init, call `loadWorkspaceFromEnv` here. Look at the existing flow — `ws` may not exist yet. The simplest pattern: build a minimal Workspace from the env at this stage, run `reloadTypeRegistries`, then pass the populated `ws` into the chooser.

- [ ] **Step 2: Run tests; commit**

```
npm test
git add mcp-server/src/cli/init.ts
git commit -m "feat(init): reload provider registry after plugin install

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 6.2: CLI chooser prompt

**Files:**
- Modify: `mcp-server/src/cli/init.ts`

- [ ] **Step 1: Add the chooser block**

After the workspace reload from Task 6.1, before the config-file write:

```ts
import { select } from '@clack/prompts';   // already imported elsewhere in init.ts

const visibleProviders = [...ws.agentCliProviders.values()].filter(p => !p.internal);

// Run detect() in parallel with a 5s per-provider timeout.
const detectResults = await Promise.all(visibleProviders.map(async (p) => {
  if (!p.detect) return { provider: p, detect: { available: true } as DetectResult };
  const ctx = buildProviderCtx(ws, /* partial cfg ok for detect */ {} as any);
  try {
    const result = await Promise.race([
      p.detect(ctx),
      new Promise<DetectResult>((resolveTimeout) =>
        setTimeout(() => resolveTimeout({ available: false, reason: 'detect timed out' }), 5000)),
    ]);
    return { provider: p, detect: result };
  } catch (err) {
    return { provider: p, detect: { available: false, reason: err instanceof Error ? err.message : String(err) } };
  }
}));

const defaultProvider = detectResults.find(r => r.detect.available)?.provider.id;

const cliPick = abortIfCancel(await select<
  Array<{ value: string; label: string; hint?: string }>,
  string
>({
  message: 'Which agent CLI should this workspace use by default?',
  options: [
    ...detectResults.map(({ provider, detect }) => ({
      value: provider.id,
      label: provider.displayName,
      hint: detect.available
        ? `✓ ${detect.binary ?? provider.id}${detect.version ? ` ${detect.version}` : ''}`
        : `✗ ${detect.reason ?? 'not installed'}`,
    })),
    { value: '__skip', label: '[skip — pick later via `clawdevbox config set`]' },
  ],
  initialValue: defaultProvider ?? '__skip',
}));

let chosenProviderId: string | null = null;
if (cliPick !== '__skip') {
  chosenProviderId = cliPick;
  const provider = ws.agentCliProviders.get(chosenProviderId)!;
  if (provider.setup) {
    try {
      await provider.setup(buildProviderCtx(ws, {} as any), { scope: installScope });
    } catch (err) {
      logger.warn?.({ err, providerId: chosenProviderId }, 'provider.setup() failed; continuing init');
    }
  }
}
```

- [ ] **Step 2: Plumb `chosenProviderId` into the config write**

Find the config-write block (around line 500). Inject `default_agent_cli: chosenProviderId ?? undefined` into the object before `writeFileSync`.

- [ ] **Step 3: Update the Initialized summary**

In the `note(...)` block (around line 575), add a line:

```ts
chosenProviderId
  ? `Agent CLI:   ${ws.agentCliProviders.get(chosenProviderId)!.displayName}`
  : `Agent CLI:   not selected (fallback: copilot)`,
```

- [ ] **Step 4: Tests**

Create `mcp-server/tests/init-cli-chooser.test.mjs` and add to package.json. The test stubs `@clack/prompts`'s `select` to auto-pick a value; runs init programmatically against a tmp dir; asserts the resulting config file has `default_agent_cli` set.

- [ ] **Step 5: Run tests; commit**

```
npm test
git add -A
git commit -m "feat(init): agent-CLI chooser with parallel detect

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase 7 — API endpoint + config-set subcommand

### Task 7.1: `GET /api/agent-clis`

**Files:**
- Modify: `mcp-server/src/cli/start.ts`
- Create: `mcp-server/tests/api-agent-clis.test.mjs`

- [ ] **Step 1: Mount the route**

In `runStart`'s HTTP route registration, add a handler:

```ts
} else if (req.method === 'GET' && url.pathname === '/api/agent-clis') {
  if (!checkBearer(req, res, cfg.http.token)) return;
  const includeInternal = url.searchParams.get('include_internal') === 'true';
  const providers = [...ws.agentCliProviders.values()].filter(p => includeInternal || !p.internal);
  const ctx = buildProviderCtx(ws, cfg);
  const detectResults = await Promise.all(providers.map(async (p) => ({
    id: p.id,
    display_name: p.displayName,
    description: p.description,
    source: p.source,
    internal: !!p.internal,
    detect: p.detect ? await Promise.race([
      p.detect(ctx),
      new Promise<DetectResult>((r) => setTimeout(() => r({ available: false, reason: 'timed out' }), 5000)),
    ]).catch((err) => ({ available: false, reason: err instanceof Error ? err.message : String(err) })) : { available: true },
  })));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    configured: cfg.defaultAgentCli,
    providers: detectResults,
    errors: ws.agentCliProviderErrors,
  }));
  return;
}
```

- [ ] **Step 2: Tests**

In `api-agent-clis.test.mjs`:

1. Boot service. Hit `/api/agent-clis` with bearer → expect copilot + claude (echo-stub hidden by default).
2. Hit with `?include_internal=true` → echo-stub present.
3. Hit without bearer → 401.
4. After installing a fake plugin via filesystem manipulation + reload → fake provider appears.

- [ ] **Step 3: Run tests; commit**

```
npm test
git add -A
git commit -m "feat(api): GET /api/agent-clis with include_internal flag

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 7.2: `clawdevbox config set` subcommand

**Files:**
- Create: `mcp-server/src/cli/config-set.ts`
- Modify: `mcp-server/src/cli/index.ts`

- [ ] **Step 1: Author the subcommand**

```ts
// config-set.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveConfig, configPath, globalConfigPath } from '../config.ts';
import { loadWorkspaceFromEnv } from '../workspace.ts';

export async function runConfigSet(flags: { _: string[]; [k: string]: any }): Promise<number> {
  const args = flags._;
  if (args.length < 2 || args[0] !== 'set') {
    console.error('usage: clawdevbox config set <key> <value>');
    return 2;
  }
  const [, key, value] = args;
  const scope: 'project' | 'global' = flags.global ? 'global' : 'project';

  const SUPPORTED_KEYS = new Set(['default_agent_cli']);
  if (!SUPPORTED_KEYS.has(key)) {
    console.error(`unsupported key '${key}'. Supported: ${[...SUPPORTED_KEYS].join(', ')}`);
    return 2;
  }

  const ws = await loadWorkspaceFromEnv();

  if (key === 'default_agent_cli') {
    if (!ws.agentCliProviders.has(value)) {
      console.error(`provider '${value}' is not registered. Available: ${[...ws.agentCliProviders.keys()].join(', ')}`);
      return 2;
    }
  }

  const cfg = resolveConfig();
  const p = scope === 'global' ? globalConfigPath(cfg.globalDir) : configPath(cfg.projectDir);
  const obj: any = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { version: 1 };
  obj[key] = value;
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  console.log(`set ${key}=${value} in ${p}`);
  return 0;
}
```

- [ ] **Step 2: Wire into CLI dispatcher**

In `cli/index.ts`, find the subcommand router. Add `case 'config': return runConfigSet(parsedFlags);`.

- [ ] **Step 3: Tests**

Add to `init-cli-chooser.test.mjs` (or new file): invoke `runConfigSet` programmatically with a tmp config dir. Assert file contents.

- [ ] **Step 4: Run tests; commit**

```
npm test
git add -A
git commit -m "feat(cli): clawdevbox config set subcommand

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase 8 — Docs

### Task 8.1: `docs/agent-clis.md` (new)

**Files:**
- Create: `docs/agent-clis.md`

- [ ] **Step 1: Author the reference**

Cover:
- What the provider system is, why it exists (high-level: pluggable CLIs).
- The `AgentCliProvider` interface (signature + each field's purpose).
- `SpawnSessionOpts` modes table.
- How to author a plugin (manifest entry + module export pattern + best practices).
- How to install a plugin (the `init --plugin` one-liner; `plugin install` alternative).
- How to switch the default (init chooser; `config set`).
- API: `GET /api/agent-clis`.
- Failure modes table (mirrored from spec §14).
- Built-in providers: copilot, claude, echo-stub. Env var overrides.

~250-400 lines is the right length.

- [ ] **Step 2: Commit**

```
git add docs/agent-clis.md
git commit -m "docs: agent-clis reference

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 8.2: Update tools/recipe.md and plugins.md

**Files:**
- Modify: `docs/tools/recipe.md`
- Modify: `docs/plugins.md`

- [ ] **Step 1: Update `docs/tools/recipe.md`**

Add a section under `recipe.run`:

> ## `agent_cli` argument
>
> Specifies which agent CLI provider runs the recipe. Accepts any registered provider id (built-ins: `copilot`, `claude`; plugins may add more — see `GET /api/agent-clis`).
>
> Resolution order if omitted: explicit recipe `default_client` → project config `default_agent_cli` → global config `default_agent_cli` → `'copilot'`.

Also under the recipe-file schema, document the same for `default_client`.

- [ ] **Step 2: Update `docs/plugins.md`**

Add a section for `provides.agent_clis[]`:

> ### `provides.agent_clis`
>
> Register one or more agent-CLI providers. Each entry points at a JS/TS module (relative to the plugin root) whose default export conforms to `AgentCliProvider` (see `docs/agent-clis.md`).
>
> ```yaml
> provides:
>   agent_clis:
>     - id: my-cli
>       module: dist/my-provider.js
>       display_name: "My Custom CLI"
>       description: "Spawns my-custom-cli with project-specific env."
> ```
>
> The module is dynamically `import()`-ed at workspace boot. Built-in provider ids (`copilot`, `claude`, `echo-stub`) cannot be shadowed.

- [ ] **Step 3: Regenerate master ref**

```
cd C:\git\clawdevbox
python docs/scripts/compose_master_doc.py
```

If the script has hardcoded section counts, update them.

- [ ] **Step 4: Commit**

```
git add docs/tools/recipe.md docs/plugins.md docs/MCP-TOOLS-REFERENCE.md docs/scripts/compose_master_doc.py
git commit -m "docs: agent-cli providers — recipe + plugins + regen master ref

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase 9 — End-to-end smoke

### Task 9.1: Fake-plugin + init smoke

**Files:**
- Modify: `mcp-server/tests/init-cli-chooser.test.mjs` (or new `tests/cli-provider-e2e.test.mjs`)

- [ ] **Step 1: Author the E2E test**

The test:
1. Creates a tmp dir.
2. Writes a fake plugin at `<tmp>/test-cli-plugin/plugin.yaml` + `test-provider.mjs` that exports a valid provider with `id: 'fake-provider'`.
3. Runs `runInit({ plugin: [tmpPluginPath], ... })` programmatically (you may need to expose a testing entry in `cli/init.ts`).
4. Asserts:
   - The plugin landed at `<globalDir>/plugins/test-cli-plugin/` (junction or copy depending on local-vs-git source).
   - After reload, `ws.agentCliProviders.has('fake-provider')` is true.
   - The chooser surfaced the provider (mock the prompt to auto-pick it).
   - The written config file has `default_agent_cli: fake-provider`.

- [ ] **Step 2: Service-spawn smoke**

If practical, also boot the actual service with the same workspace and hit `GET /api/agent-clis`. Assert the fake provider appears in the response.

- [ ] **Step 3: Run; commit**

```
npm test
git add -A
git commit -m "test(agent-clis): end-to-end smoke — init --plugin → registry → chooser → API

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 9.2: Final clean run

- [ ] **Step 1: Verify**

```
cd mcp-server
npm run typecheck     # only the 3 pre-existing errors
npm run build         # clean
npm test              # all green
```

- [ ] **Step 2: Grep for stale agency references one final time**

```
grep -rn "agency" mcp-server/src --include='*.ts'
grep -rn "CLAWDEVBOX_AGENCY_PATH" mcp-server/src
```

Both should return nothing (or only matches in test fixtures that explicitly stand up a fake `agency` provider).

- [ ] **Step 3: Final commit if anything stuck**

```
git add -A
git commit -m "chore: final sweep — confirm no agency references in OSS kernel

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" || true
```

---

## Out of scope (per spec §17)

- Separate `clawdevbox-sdk` npm package.
- Per-recipe trigger-time provider override.
- Hot reload without restart.
- Standalone `clawdevbox cli detect` subcommand.
- Sandboxed plugin execution.

These can be added incrementally without breaking changes.

---

## Notes for subagents executing this plan

- **Model:** Opus 4.7 1M context (`claude-opus-4.7-1m-internal`) only. Never Haiku.
- **Branch:** Stay on `main`. Commit per task labels.
- **Tests:** `npm test` and `npm run typecheck` after every commit. Don't proceed if they regress.
- **Pre-existing typecheck errors** stay (3 in `template-store.ts`, `tools/trigger.ts`). New errors are yours.
- **Trust model:** plugin-provided providers run in-process. Same as existing trigger scripts conceptually (existing plugins already ship arbitrary JS that the kernel executes).
- **Workspace reloads** must `await` because `reloadTypeRegistries` is now async.
- **`buildProviderCtx`** is the single source of truth for `ProviderCtx` construction; callers should not hand-roll.
- **Don't break the 227 baseline tests.** They use `agent_cli: 'echo-stub'`, which is still registered (just marked `internal`).
