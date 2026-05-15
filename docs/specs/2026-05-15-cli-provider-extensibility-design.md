# Agent CLI Provider Extensibility

**Status:** Draft (design)
**Date:** 2026-05-15
**Scope:** Extract every CLI-specific spawn branch (copilot, claude, echo-stub, agency) from the kernel into a plug-in-loadable `AgentCliProvider` interface. Ship copilot, claude, echo-stub as built-ins. Move agency out of the OSS tree entirely so it can be installed as a separate plugin in Microsoft-internal setups. Let `clawdevbox init` enumerate detected providers and persist the user's choice.

## 1. Problem

CLI-specific logic is hardcoded in **three places** across the kernel:

1. `mcp-server/src/recipe-runner.ts` (lines 276-303) — `if (agentCli === 'copilot') { … } else if (agentCli === 'claude') { … } else if (agentCli === 'echo-stub') { … }`. Each branch hand-codes the binary path, argv composition, MCP config layout, and Windows cmd.exe wrapping.
2. `mcp-server/src/cli/start.ts` (lines 1115-1144, the UI-driven "Resume" path) — a near-duplicate of the same chain.
3. `mcp-server/src/main-agent.ts` (lines 138-263) — hardcoded `agency.exe copilot` spawn plus `agency.toml` writer. `agency` is a Microsoft-internal wrapper that itself spawns Copilot; this binary does not exist in OSS contexts.

Plus three satellites:
- `mcp-server/src/tools/recipe.ts` line 300 — `z.enum(['copilot', 'claude', 'echo-stub'])`.
- `mcp-server/src/validators.ts` line 121 — `default_client must be 'claude' or 'copilot'`.
- `mcp-server/src/cli/init.ts` line 589 — mention of `Claude Code / agency` in init output; no chooser, no detection.

Consequences:
- Adding a new CLI means editing four files and the type union in `recipe-runner.ts`.
- Shipping to OSS forces a choice between keeping the `agency` references (confusing to non-MS users) or stripping them and breaking Microsoft-internal usage.
- The init flow can't surface what CLIs are actually installed, so users guess.

## 2. Goals & Non-Goals

### Goals

- Define a single `AgentCliProvider` interface that owns the full spawn lifecycle for one CLI.
- Ship three built-in providers in OSS: `copilot`, `claude`, `echo-stub`.
- Let plugins register additional providers via `provides.agent_clis[]` in `plugin.yaml`, loaded by the kernel via dynamic `import()` at workspace boot.
- Move `agency` out of OSS entirely; it ships as a Microsoft-side plugin that registers an `agency` provider.
- Add a chooser to `clawdevbox init` that detects available providers and persists the choice to config.
- Collapse the four CLI-specific branches into a single declarative call: `provider.spawnSession(ctx, opts)`.
- Make interactive-vs-headless and new-vs-resume **explicit fields** in the spawn opts, not implicit from "did we pass `-p`?".

### Non-Goals

- **Cross-provider resume.** A session started with copilot can't be resumed with claude. The kernel always uses the same provider that originally spawned the session (looked up via `agent_sessions.agent_cli`).
- **Provider sandboxing.** Plugin-supplied providers run code in the kernel process via dynamic `import()`. They have full Node API access. This matches the existing trust model for plugins (they already ship arbitrary scripts the kernel runs as triggers).
- **Hot reload.** Provider registry is built at workspace boot. Editing a provider module requires a service restart.
- **A `clawdevbox cli list` / `cli detect` standalone CLI.** Detection happens at init time and via SPA — no separate CLI subcommand.
- **Per-recipe provider override at trigger-time.** A trigger that binds to a recipe uses whatever provider that recipe resolves to (or the workspace default). We don't add a `provider:` field on trigger registrations.

## 3. The provider interface

A new file `mcp-server/src/agent-clis/types.ts` defines:

```ts
import type { IPty } from 'node-pty';
import type { Workspace } from '../workspace.ts';
import type { ResolvedConfig } from '../config.ts';
import type { Logger } from '../logger.ts';

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
  /** Lineage IDs. */
  recipeInstanceId?: string;
  agentSessionId?: string;
  triggerId?: string;
  fireId?: string;
  /** PTY size for interactive mode. */
  ptyCols?: number;
  ptyRows?: number;
}

export interface AgentHandle {
  pid: number | null;
  /** The session id the CLI is using internally. Usually === opts.init.session_id;
   *  may differ if the provider's CLI auto-mints. The kernel writes this back
   *  to `agent_sessions.cli_session_id` so future resumes work. */
  sessionId: string;
  /** The IPty handle the kernel registers with pty-registry. */
  pty: IPty;
  /** Resolves when the underlying process exits. */
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

export interface ProviderCtx {
  ws: Workspace;
  cfg: ResolvedConfig;
  logger: Logger;
  /** Wraps node-pty.spawn so providers don't import node-pty directly. */
  spawnPty(file: string, args: string[], opts: {
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    name?: string;
  }): IPty;
  /** Atomic write into the workspace directory. Relative paths only;
   *  the kernel rejects path traversal. */
  writeWorkspaceFile(relativePath: string, contents: string): void;
}

export interface AgentCliProvider {
  readonly id: string;            // e.g. 'copilot', 'claude', 'agency'
  readonly displayName: string;
  readonly description: string;
  readonly source: 'builtin' | `plugin:${string}`;

  /** Probe whether the binary is on PATH / installed. Non-throwing.
   *  Optional — provider can be `available: true` unconditionally
   *  (e.g. echo-stub has no external dependency). */
  detect?(ctx: ProviderCtx): Promise<DetectResult>;

  /** Optional one-time setup after the user picks this provider in init.
   *  Examples: warn about missing API keys, create a default config file. */
  setup?(ctx: ProviderCtx, opts: SetupOptions): Promise<void>;

  /** Spawn one agent session. The kernel handles pty-registry registration
   *  and DB writes around this call. */
  spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle>;
}
```

### Interpretation of each `SpawnSessionOpts` field by callers

| Caller | mode | init.kind | prompt | role |
|---|---|---|---|---|
| `main-agent.ts` workspace daemon | `interactive` | `new` | absent | `main-agent` |
| `recipe-runner.ts` headless cron / trigger.fire / recipe.run | `headless` | `new` or `resume` | required | `recipe-instance` |
| `recipe-runner.ts` agent-session-resume fire (Phase 2 of trigger kernel) | `headless` | `resume` | required (payload) | `recipe-instance` |
| `cli/start.ts` UI "Resume" button on a paused step | `interactive` | `resume` | absent | `recipe-instance` |

The provider switches on `mode` and `init.kind` to compose its argv. Concrete examples in §5.

## 4. Plugin manifest extension

Extend `PluginManifest.provides` with a new optional entry:

```yaml
# plugin.yaml — agency-cli (Microsoft-internal plugin)
id: agency-cli
name: Agency Copilot Wrapper
version: 1.0.0
description: Wraps GitHub Copilot CLI with Microsoft-internal context routing.
provides:
  agent_clis:
    - id: agency                              # provider id; collision-checked
      module: scripts/agency-provider.js      # path relative to plugin root
      display_name: "Microsoft Agency"        # shown in init chooser
      description: "Agency wraps Copilot..."  # short, one line
```

Schema:

```ts
export interface PluginAgentCliEntry {
  id: string;                    // /^[a-z0-9][a-z0-9._-]*$/i
  module: string;                // relative path; resolved against plugin dir
  display_name?: string;         // falls back to id if absent
  description?: string;
}
```

Validation (`validatePluginManifest`): reject malformed ids, reject empty `module`, reject `module` paths with `..` segments.

### Module loading

At `reloadTypeRegistries(ws)` time (after plugin discovery), the kernel:

1. For each enabled plugin, iterate `manifest.provides.agent_clis ?? []`.
2. For each entry:
   - `const abs = resolve(pluginDir, entry.module)` — must stay under `pluginDir`.
   - `const mod = await import(pathToFileURL(abs).href)` — Node ESM dynamic import.
   - The module's **default export** OR named export `provider` must conform to `AgentCliProvider`. Throw a typed error otherwise (caught and logged into `ws.agentCliProviderErrors`).
   - Set `provider.source = 'plugin:<plugin_id>'`.
3. Insert into `ws.agentCliProviders: Map<string, AgentCliProvider>`.
4. Collision rules:
   - Built-in id collisions with plugin id → plugin loses, log error.
   - Plugin-to-plugin id collision → first-loaded wins (sort plugins by id for determinism), log error on the loser.

Async loading: `reloadTypeRegistries` is currently sync. Convert to async (and have callers `await` it). The `loadWorkspaceFromEnv()` boot path is async-friendly already (`runStart` is async).

Built-in providers are registered before plugins, so they can never lose to a plugin trying to shadow them.

## 5. Built-in providers

Three new files in `mcp-server/src/agent-clis/`:

### 5.1 `copilot.ts`

```ts
import { resolve, join } from 'node:path';
import { writeMcpJson } from './shared.ts';
import type { AgentCliProvider, SpawnSessionOpts, ProviderCtx, AgentHandle } from './types.ts';

export const copilotProvider: AgentCliProvider = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  description: 'The official GitHub Copilot CLI (`copilot`).',
  source: 'builtin',

  async detect(ctx) {
    const bin = resolveBinary();
    return probeBinary(bin, ['--version']);   // resolves to {available, binary, version, reason?}
  },

  async spawnSession(ctx, opts): Promise<AgentHandle> {
    const isWin = process.platform === 'win32';
    const bin = process.env.CLAWDEVBOX_COPILOT_PATH ?? (isWin ? 'copilot.exe' : 'copilot');

    // Workspace MCP config so the CLI sees the clawdevbox MCP server.
    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);
    const mcpPath = join(opts.workspaceInfo.path, '.mcp.json');

    const sessionFlag = opts.init.kind === 'new'
      ? `--name=${opts.init.session_id}`
      : `--resume=${opts.init.session_id}`;

    const argv: string[] = [sessionFlag, '--additional-mcp-config', `@${mcpPath}`];
    if (opts.mode === 'headless') {
      argv.push('--allow-all-tools', '-p', opts.prompt!);
    }
    // interactive: no -p, no --allow-all-tools (user gets prompts)

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    const pty = ctx.spawnPty(bin, argv, {
      cwd: opts.workspaceInfo.path, env,
      cols: opts.ptyCols ?? 120, rows: opts.ptyRows ?? 30,
    });

    return {
      pid: pty.pid ?? null,
      sessionId: opts.init.session_id,        // copilot honors --name / --resume verbatim
      pty,
      exited: new Promise(resolve => pty.onExit(({ exitCode, signal }) =>
        resolve({ exitCode, signal: signal != null ? String(signal) : undefined }))),
    };
  },
};
```

### 5.2 `claude.ts`

Same shape. Differences:
- Binary: `process.env.CLAWDEVBOX_CLAUDE_PATH ?? 'claude'`.
- argv: `--session-id <id>` for new, `--resume <id>` for resume. `-p <prompt>` for headless.
- Windows: spawn through `cmd.exe /d /s /c claude ...` because Claude's binary isn't a standalone `.exe`.

### 5.3 `echo-stub.ts`

Synthesizes a JS script body, writes it to `<workspace>/.clawdevbox/echo-stub/<session_id>.js`, spawns it with `process.execPath`. Used by tests. Always `available: true`.

### 5.4 `mcp-server/src/agent-clis/shared.ts`

Small helpers used by all built-ins:
- `probeBinary(bin, args)` — spawn with timeout, capture version, never throws.
- `writeMcpJson(ctx, wsPath, mcp)` — writes `.mcp.json` with the standard clawdevbox MCP server stanza (extracted from current `main-agent.ts:138-155`).

### 5.5 Registration

`mcp-server/src/agent-clis/index.ts`:

```ts
export const BUILTIN_PROVIDERS: AgentCliProvider[] = [
  copilotProvider,
  claudeProvider,
  echoStubProvider,
];
```

## 6. Provider registry on the workspace

`mcp-server/src/workspace.ts` extensions:

```ts
export interface Workspace {
  // ...existing fields...
  agentCliProviders: Map<string, AgentCliProvider>;
  agentCliProviderErrors: Array<{
    plugin_id?: string; provider_id?: string; module?: string; error: string;
  }>;
}
```

`reloadTypeRegistries(ws)` becomes async and:
1. Registers `BUILTIN_PROVIDERS` first.
2. Iterates plugins; for each `provides.agent_clis[]` entry, dynamically imports and validates.
3. Records collisions and load errors.

Callers of `reloadTypeRegistries`:
- `loadWorkspaceFromEnv(env)` — now returns `Promise<Workspace>`.
- `plugin.*` tools (install/uninstall) — await the reload.

All call sites updated to `await` the function.

## 7. Refactor of existing call sites

### 7.1 `recipe-runner.ts`

The 30-line if/else chain at lines 276-303 collapses to:

```ts
const provider = ctx.ws.agentCliProviders.get(agentCli);
if (!provider) throw new Error(`unknown agent_cli '${agentCli}'`);
const handle = await provider.spawnSession({ ws, cfg, logger, spawnPty, writeWorkspaceFile }, {
  mode: 'headless',
  init: opts.resumeOf
    ? { kind: 'resume', session_id: sessionId }
    : { kind: 'new', session_id: sessionId },
  role: 'recipe-instance',
  prompt: opts.prompt,
  workspaceInfo: opts.workspaceInfo,
  ambientEnv: { CLAWDEVBOX_RECIPE_INSTANCE_ID: ..., CLAWDEVBOX_AGENT_SESSION_ID: ..., ... },
  mcp: { url: opts.mcpUrl!, secret: opts.mcpSecret! },
  recipeInstanceId: instanceId,
  agentSessionId: sessionRow.id,
  triggerId: opts.triggerId,
  fireId: opts.fireId,
});
// kernel registers handle.pty with pty-registry, writes handle.sessionId back into DB
```

The `AgentCli` type union (`'copilot' | 'claude' | 'echo-stub'`) becomes `string` (validated at the call edge via `ws.agentCliProviders.has(id)`).

### 7.2 `cli/start.ts` UI resume path

The same chain at lines 1115-1144 deletes. Becomes:

```ts
const provider = ws.agentCliProviders.get(agentCli);
const handle = await provider.spawnSession(ctx, {
  mode: 'interactive',
  init: { kind: 'resume', session_id: sessionId },
  role: 'recipe-instance',
  // no prompt
  workspaceInfo, ambientEnv, mcp,
  recipeInstanceId: newInstanceId, agentSessionId: ...,
  ptyCols: 120, ptyRows: 30,
});
```

### 7.3 `main-agent.ts`

The hardcoded `agency.exe copilot` + `agency.toml` writer disappears entirely. Replaced with:

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
    logger.warn({ providerId }, 'main-agent: configured provider not registered — main agent disabled');
    return { instance_id: MAIN_AGENT_INSTANCE_ID, running: false, exited: false, agent_cli: providerId, view_url_path: ... };
  }

  const sessionId = mintAgentSessionCliId();
  let handle: AgentHandle;
  try {
    handle = await provider.spawnSession(buildProviderCtx(opts.workspace, opts.cfg, logger), {
      mode: 'interactive',
      init: { kind: 'new', session_id: sessionId },
      role: 'main-agent',
      workspaceInfo: { id: 'project', path: opts.workspace.projectDir },
      ambientEnv: { CLAWDEVBOX_WORKSPACE_ID: 'project', CLAWDEVBOX_PROJECT_DIR: ..., CLAWDEVBOX_GLOBAL_DIR: ... },
      mcp: { url: opts.cfg.http.baseUrl, secret: opts.cfg.http.token },
      ptyCols: 120, ptyRows: 30,
    });
  } catch (err) {
    logger.warn({ err, providerId }, 'main-agent: provider spawn failed');
    return { instance_id: MAIN_AGENT_INSTANCE_ID, running: false, exited: false, agent_cli: providerId, view_url_path: ... };
  }

  registerPty({ instanceId: MAIN_AGENT_INSTANCE_ID, workspaceId: 'project', cols: 120, rows: 30, ipty: handle.pty });
  handle.exited.then(() => emitChange('agent'));
  agentPid = handle.pid;
  emitChange('agent');
  return getMainAgentStatus();
}
```

Note that the `MainAgentStatus.agent_cli` field becomes `string` (was hardcoded `'copilot'`).

**Threading `cfg` into the existing call sites.** Today `main-agent.ts`'s `MainAgentOptions` carries only `{ workspace, host?, port? }`. To read `defaultAgentCli`, extend it to carry `cfg: ResolvedConfig`. Same for the `ProviderCtx` (already includes `cfg`). All callers in `cli/start.ts` already have `cfg` in scope.

### 7.4 `tools/recipe.ts`

```ts
// before
agent_cli: z.enum(['copilot', 'claude', 'echo-stub']).optional()
// after
agent_cli: z.string().optional()
// in handler:
const agentCli = args.agent_cli ?? ctx.cfg.defaultAgentCli ?? 'copilot';
if (!ctx.ws.agentCliProviders.has(agentCli)) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'UNKNOWN_AGENT_CLI', message: `provider '${agentCli}' is not registered (available: ${[...ctx.ws.agentCliProviders.keys()].join(', ')})` } }) }] };
}
```

### 7.5 `validators.ts`

`validateRecipeParsed` currently rejects `default_client` ∉ `{'claude', 'copilot'}`. Change to: deferred validation against the runtime provider registry. The validator no longer has access to `ws` directly; instead, the recipe-level `default_client` field is validated at recipe-run time, not parse time.

Concretely: drop the line-121 check from the static validator. Add the check inside `recipe.run` / `recipe.upsert` handlers where `ws` is in scope.

## 8. Config: `default_agent_cli`

New optional field on `ClawdevboxConfig`:

```ts
export interface ClawdevboxConfig {
  // ...existing fields...
  default_agent_cli?: string;     // provider id
}
```

Resolved value (`cfg.defaultAgentCli`) is plumbed through `ResolvedConfig`. Resolution priority for any call site:

1. Explicit `agent_cli` arg on `recipe.run` / `trigger.register` etc.
2. Recipe-level `default_client` in the recipe YAML/JSON.
3. Project config `default_agent_cli`.
4. Global config `default_agent_cli`.
5. Hardcoded fallback: `'copilot'`.

If the final resolved id isn't in `ws.agentCliProviders`, the caller returns an error / the main agent declines to start (with a logged warning).

## 9. `clawdevbox init` chooser

After the existing scope + plugin steps in `cli/init.ts`, add a new step before the final "Initialized" note.

### Detection phase

Run `provider.detect?.(ctx)` for every registered provider in parallel (5-second per-provider timeout). Collect results into a list:

```ts
type Candidate = {
  provider: AgentCliProvider;
  detect: DetectResult;                       // {available, binary?, version?, reason?}
};
```

### Prompt

Use the existing `@clack/prompts` `select` helper:

```
? Which agent CLI should this workspace use by default?
  ❯ GitHub Copilot CLI       (✓ copilot.exe 1.2.3)
    Anthropic Claude Code    (✓ claude 0.8.0)
    Microsoft Agency         (✓ agency.exe 4.5)   ← only when agency-cli plugin installed
    Echo stub (testing)      (always available)
    [skip — pick later via `clawdevbox config set`]
```

- Each option's hint string comes from `detect.available ? `✓ ${binary} ${version}` : detect.reason ?? 'not installed'`.
- Default selection: the first `available: true` provider in registration order (copilot wins by default).
- If the user picks `[skip]`, no field is written; the runtime fallback (`'copilot'` hardcoded) takes over.
- If the user picks an unavailable provider, surface a warning ("you can still proceed; clawdevbox will use this when the binary is installed") but accept the choice.

### Persist

Write `default_agent_cli: <id>` to the config file already being written by init (project or global, depending on `installScope`).

After selection, call `provider.setup?.(ctx, { scope: installScope })` so the provider can do its own one-time setup (warn about API keys, etc.).

### Display in summary

The "Initialized" note gains a new line:

```
Agent CLI:   GitHub Copilot CLI (copilot.exe 1.2.3)
```

## 10. The `agency-cli` Microsoft-side plugin (out of this repo)

Lives in a separate Microsoft-internal repo. Its files:

```
agency-cli/
  plugin.yaml
  scripts/
    agency-provider.js     ← compiled from agency-provider.ts
    agency-provider.ts     ← source
  README.md
```

`plugin.yaml`:

```yaml
id: agency-cli
name: Agency Copilot Wrapper
version: 1.0.0
provides:
  agent_clis:
    - id: agency
      module: scripts/agency-provider.js
      display_name: "Microsoft Agency"
      description: "Wraps Copilot with Microsoft-internal context routing."
```

`agency-provider.js` (compiled from TS) implements `AgentCliProvider`:

```ts
import type { AgentCliProvider, SpawnSessionOpts, ProviderCtx, AgentHandle } from 'clawdevbox/agent-clis';
import { join } from 'node:path';

const agencyProvider: AgentCliProvider = {
  id: 'agency',
  displayName: 'Microsoft Agency',
  description: '...',
  source: 'plugin:agency-cli',    // set by the loader

  async detect(ctx) {
    const bin = process.env.CLAWDEVBOX_AGENCY_PATH ?? (process.platform === 'win32' ? 'agency.exe' : 'agency');
    return probeBinary(bin, ['--version']);
  },

  async spawnSession(ctx, opts): Promise<AgentHandle> {
    // 1. Write the standard .mcp.json (same as copilot).
    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);

    // 2. Write agency.toml (agency's `copilot --resume` flow merges this).
    const toml = renderAgencyToml(opts.workspaceInfo.path, opts.ambientEnv);
    ctx.writeWorkspaceFile('agency.toml', toml);

    // 3. Compose argv. Agency wraps copilot, so it's `agency copilot <copilot-args>`.
    const isWin = process.platform === 'win32';
    const bin = process.env.CLAWDEVBOX_AGENCY_PATH ?? (isWin ? 'agency.exe' : 'agency');
    const sessionFlag = opts.init.kind === 'new'
      ? `--name=${opts.init.session_id}`
      : `--resume=${opts.init.session_id}`;

    const argv: string[] = ['copilot', sessionFlag];
    if (opts.mode === 'headless') {
      argv.push('--additional-mcp-config', `@${join(opts.workspaceInfo.path, '.mcp.json')}`,
                '--allow-all-tools', '-p', opts.prompt!);
    }
    // Interactive: bare `agency copilot` — what main-agent.ts does today.

    const pty = ctx.spawnPty(bin, argv, {
      cwd: opts.workspaceInfo.path,
      env: { ...process.env, ...opts.ambientEnv },
      cols: opts.ptyCols ?? 120, rows: opts.ptyRows ?? 30,
    });
    return { pid: pty.pid ?? null, sessionId: opts.init.session_id, pty,
             exited: new Promise(r => pty.onExit(({exitCode, signal}) => r({exitCode, signal: signal ? String(signal) : undefined}))) };
  },
};
export default agencyProvider;
```

For Phase 1, plugins import the provider types from the kernel's own published types path: `import type { AgentCliProvider } from 'clawdevbox/agent-clis'`. The `mcp-server/package.json` already publishes `dist/` as `files` and `clawdevbox/agent-clis` is exposed via a `"./agent-clis"` entry in `package.json.exports`. The agency plugin's `package.json` lists `clawdevbox` as a peerDependency. A separate `clawdevbox-sdk` package (future work, §17) can re-export these for ergonomics, but isn't required.

**This repo ends up with zero references to `agency`.** A grep for `agency` in `mcp-server/src/` should return nothing after the refactor.

## 11. SPA surface

Two small adjustments:

1. **Settings page** (or main-agent terminal sidebar): show the configured provider id + display name + detect status. Wire to a new `GET /api/agent-clis` endpoint that returns the registered list + their detect results.

2. **Recipe-run UI**: the `agent_cli` dropdown (if it exists) populates from `GET /api/agent-clis` instead of a hardcoded array.

These are nice-to-haves; the kernel works without them. Spec includes the API endpoint; SPA wiring is optional and tracked in the implementation plan as a stretch task.

## 12. API endpoint

`GET /api/agent-clis` — bearer auth required.

```json
{
  "configured": "copilot",
  "providers": [
    { "id": "copilot", "display_name": "GitHub Copilot CLI", "description": "...",
      "source": "builtin",
      "detect": { "available": true, "binary": "copilot.exe", "version": "1.2.3" } },
    { "id": "claude", "display_name": "Anthropic Claude Code", "description": "...",
      "source": "builtin",
      "detect": { "available": true, "binary": "claude", "version": "0.8.0" } },
    { "id": "echo-stub", "display_name": "Echo Stub (testing)", "description": "...",
      "source": "builtin",
      "detect": { "available": true } },
    { "id": "agency", "display_name": "Microsoft Agency", "description": "...",
      "source": "plugin:agency-cli",
      "detect": { "available": false, "reason": "agency.exe not found on PATH" } }
  ],
  "errors": [
    /* anything in ws.agentCliProviderErrors */
  ]
}
```

## 13. Backward compatibility

- Existing recipe files with `default_client: 'copilot'` or `'claude'` keep working — those names are exactly the built-in provider ids.
- `recipe.run({agent_cli: 'echo-stub'})` keeps working — echo-stub is a built-in.
- Existing call sites that pass `agentCli` as a literal `'copilot' | 'claude' | 'echo-stub'` continue compiling; the union widens to `string` at the boundaries that need it.
- Config without `default_agent_cli` set: the resolution chain falls to the hardcoded `'copilot'`. Existing users who haven't re-init'd see no behavior change.
- `main-agent.ts` agency hardcoding is REMOVED. Existing Microsoft installations need the `agency-cli` plugin installed and `default_agent_cli: agency` in their config. The migration step: install plugin → re-init → done. Document in the plugin's README.
- `CLAWDEVBOX_AGENCY_PATH` env var: moves to the agency plugin. The kernel stops reading it. The plugin's `agency-provider.js` reads it directly.
- `CLAWDEVBOX_COPILOT_PATH`, `CLAWDEVBOX_CLAUDE_PATH` env vars: stay; read by the built-in providers.

## 14. Failure modes

| Scenario | Behaviour |
|---|---|
| Plugin's `module` path resolves outside the plugin directory | Reject at load; log into `agentCliProviderErrors`. Plugin's other capabilities still load. |
| Plugin's `module` throws on dynamic `import()` | Record `{plugin_id, module, error}` in `agentCliProviderErrors`; do not load. |
| Plugin's module default-export doesn't match `AgentCliProvider` shape (missing `spawnSession`, etc.) | Validation rejects with `INVALID_PROVIDER_SHAPE`; recorded in errors. |
| Plugin tries to register provider id `'copilot'` | Reject — built-in collision; recorded as `BUILTIN_COLLISION`. |
| Two plugins both register id `'foo'` | First-loaded (sorted by plugin id) wins. Loser recorded as `PLUGIN_COLLISION`. |
| `default_agent_cli` references a provider not in the registry | `recipe.run` returns `UNKNOWN_AGENT_CLI`; main-agent logs warning and refuses to spawn (workspace continues to serve HTTP). |
| `provider.detect()` throws or hangs | Treated as `{ available: false, reason: '<error>' }` after the 5-second timeout. |
| `provider.spawnSession()` throws | Caller catches, marks the recipe-instance / fire as failed with the error message, no pty registered. |
| The spawned pty exits before we register it with pty-registry (extremely fast crash) | The provider's `handle.exited` promise resolves; the kernel sees `{exitCode}` and reports a spawn failure. |

## 15. Testing strategy

### 15.1 Unit tests

- Each built-in provider: spawn mode matrix (interactive×new, interactive×resume, headless×new, headless×resume). Mock binaries via fixture scripts that just `echo $0 $@` and exit. Verify argv composition. Verify `.mcp.json` written for copilot/claude.
- `probeBinary` helper: timeout, non-zero exit, success.
- `writeMcpJson` helper: atomic write, idempotent rewrite.

### 15.2 Plugin loader

- Tmp dir with a fake plugin (manifest + JS module that exports a stub provider).
- Verify dynamic import loads it, `source` is set to `plugin:<id>`, ws.agentCliProviders has it.
- Negative tests: malformed manifest, path traversal in `module`, module that throws on import, module that exports wrong shape, collision with a built-in.

### 15.3 Refactored call sites

- Re-run all existing `recipe.run` tests, parameterized over `[copilot, claude, echo-stub]` using fake binaries.
- Re-run main-agent boot tests with each built-in provider.
- Re-run the recipe-resume HTTP path test.
- Verify that `agent_cli: 'agency'` in a recipe.run fails with `UNKNOWN_AGENT_CLI` when no agency plugin is installed.

### 15.4 Init chooser

- Stub `@clack/prompts` to auto-select each option in turn.
- Verify config file has `default_agent_cli` set.
- Stub `provider.detect` to return failure for one provider; verify the prompt shows the failure reason.

### 15.5 End-to-end

- Spin up a real service with a fake plugin that registers a `test-cli` provider. Hit `GET /api/agent-clis`. Verify the response shape.
- Recipe.run via HTTP MCP with `agent_cli: 'echo-stub'` end-to-end.

## 16. Implementation phases (informs the plan, not the design)

1. **Type definitions + loader skeleton** — `agent-clis/types.ts`, `agent-clis/index.ts`, `Workspace.agentCliProviders` + `agentCliProviderErrors`, async `reloadTypeRegistries`.
2. **Built-in providers** — `copilot.ts`, `claude.ts`, `echo-stub.ts`, `shared.ts`, plus unit tests.
3. **Plugin manifest extension** — `provides.agent_clis[]`, validator, dynamic-import loader.
4. **Refactor `recipe-runner.ts`** — drop the if/else chain, route through providers, update tests.
5. **Refactor `cli/start.ts` resume path** — same.
6. **Refactor `main-agent.ts`** — remove agency.exe + agency.toml hardcoding, route through provider, update `MainAgentStatus`.
7. **Config field** — `default_agent_cli` on `ClawdevboxConfig` + `ResolvedConfig`.
8. **Init chooser** — detect + select + persist + setup hook.
9. **API endpoint** — `GET /api/agent-clis`.
10. **Tools schema updates** — `tools/recipe.ts` and `validators.ts` open-up.
11. **Docs** — `docs/agent-clis.md` (new), update `docs/tools/recipe.md` and `docs/plugins.md`, regenerate master reference.
12. **End-to-end smoke** — fake plugin loaded, full round-trip.

The plan splits these into sized tasks for subagent execution.

## 17. Out of scope (future)

- A separate `clawdevbox-sdk` npm package that re-exports the provider types for plugin authors (currently they import from the dist/ output).
- Per-recipe provider override on trigger registrations.
- Hot-reload of providers without service restart.
- A `clawdevbox cli detect` / `clawdevbox cli list` standalone subcommand.
- `provider.spawnSubAgent()` — distinct from `spawnSession({role: 'sub-agent'})` only conceptually; the same method handles both cases for now.
- Sandboxed plugin execution (workers / vm). Same trust model as today.
