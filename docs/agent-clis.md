# Agent CLI providers

Clawdevbox spawns AI coding CLIs through a **pluggable provider** layer.
Built-ins ship in the OSS tree (`copilot`, `claude`, plus an internal
`echo-stub` used by tests); additional providers arrive as plugins that
declare `clawdevbox.agent_clis[]` in their `.claude-plugin/plugin.json`.
Every spawn —
whether it's the main-agent terminal you see in `clawdevbox start`, a
headless `recipe.run` from MCP, or a paused-step "Resume" click in the
SPA — funnels through a single `provider.spawnSession(ctx, opts)` call.
Microsoft's `agency` wrapper lives in a separate Microsoft-internal
plugin (`agency-cli`) and registers under the id `agency` once
installed.

## The `AgentCliProvider` interface

Defined in [`mcp-server/src/agent-clis/types.ts`](../mcp-server/src/agent-clis/types.ts):

```ts
export interface AgentCliProvider {
  readonly id: string;                       // e.g. 'copilot', 'claude', 'agency'
  readonly displayName: string;
  readonly description: string;
  readonly source: 'builtin' | `plugin:${string}`;
  readonly internal?: boolean;

  detect?(ctx: ProviderCtx): Promise<DetectResult>;
  setup?(ctx: ProviderCtx, opts: SetupOptions): Promise<void>;
  spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle>;
}
```

| Field         | Purpose |
|---------------|---------|
| `id`          | Provider id. Matches `[a-z0-9][a-z0-9._-]*`. Used everywhere the kernel resolves a CLI (recipes, `recipe.run`, config). Must be unique across built-ins and plugins. |
| `displayName` | Shown in the `clawdevbox init` chooser and the SPA settings page. |
| `description` | One-line summary, also shown in the chooser. |
| `source`      | `'builtin'` for shipped providers, `'plugin:<plugin_id>'` for plugin-provided ones. Set by the loader, not the plugin. |
| `internal`    | When `true`, hidden from the init chooser, the default `GET /api/agent-clis` listing, and `clawdevbox config set` autocompletion. The provider is still resolvable by id (used for the `echo-stub` test fixture). |
| `detect`      | Non-throwing probe. Resolves with `{available, binary?, version?, reason?}`. Called by the init chooser (5-second timeout per provider). Optional — a provider with no external binary can omit it. |
| `setup`       | One-time setup after the user picks the provider in init. Useful for warning about missing API keys or seeding a default config. Optional. |
| `spawnSession`| Spawn one agent session. Returns an `AgentHandle` (pid, sessionId, pty, `exited` promise). Required. |

### `SpawnSessionOpts`

| Field              | Type | Notes |
|--------------------|------|-------|
| `mode`             | `'interactive' \| 'headless'` | Interactive sessions stream a TTY to the user; headless sessions pass `-p <prompt>` and exit when done. |
| `init`             | `{kind: 'new' \| 'resume', session_id: string}` | Whether to start fresh or resume a prior session. The provider switches argv on `kind`. |
| `role`             | `'main-agent' \| 'recipe-instance' \| 'sub-agent'` | What the kernel is spawning this session for. Most providers don't branch on it — it's available for providers that need to vary behaviour. |
| `prompt`           | `string?` | Required when `mode === 'headless'`. Ignored in interactive mode. |
| `workspaceInfo`    | `{id, path}` | The cwd to spawn in, plus the workspace id (used in ambient env). |
| `ambientEnv`       | `Record<string, string>` | Env vars the kernel wants the child to see (`CLAWDEVBOX_*` IDs etc.). Merge with `process.env` before handing to `spawnPty`. |
| `mcp`              | `{url, secret}` | The clawdevbox MCP server the child should connect back to. Writes into `.mcp.json` via `writeMcpJson`. |
| `recipeInstanceId` | `string?` | Lineage. Set when `role === 'recipe-instance'`. |
| `agentSessionId`   | `string?` | Lineage. The `agent_sessions` row id. |
| `triggerId`        | `string?` | Lineage. Set when the session was spawned by a trigger fire. |
| `fireId`           | `string?` | Lineage. Set when the session was spawned by a trigger fire. |
| `ptyCols`          | `number?` | Defaults to 120. |
| `ptyRows`          | `number?` | Defaults to 30. |

### `ProviderCtx`

```ts
export interface ProviderCtx {
  ws: Workspace;
  cfg: ResolvedConfig;
  logger: Logger;
  spawnPty(file: string, args: string[], opts: PtySpawnOpts): IPty;
  writeWorkspaceFile(relativePath: string, contents: string): void;
}
```

Providers use `ctx.spawnPty` instead of importing `node-pty` directly
(so the kernel can centralize PTY accounting) and `ctx.writeWorkspaceFile`
to drop config files into the workspace (atomic write, rejects paths
that escape via `..`).

## Bidirectional plugin sync

Once an agent CLI is configured (`default_agent_cli`), clawdevbox and
the configured CLI share plugin inventory in **both directions**.
Plugins you install in clawdevbox become available to the CLI; plugins
the CLI already has — when they carry a `clawdevbox.*` extension —
become available to clawdevbox (after a one-time opt-in). This keeps
the two installations in lockstep without forcing users to install
plugins twice.

### Direction A — clawdevbox → CLI

When `clawdevbox plugin install`, `clawdevbox plugin uninstall`,
`clawdevbox marketplace add`, or `clawdevbox marketplace remove`
mutates clawdevbox's plugin/marketplace state, the configured
provider's `syncPluginInventory` method is invoked. The default
implementation (shared across all built-in providers) shells out to
the CLI's own commands:

```
<binary> plugin marketplace list
<binary> plugin marketplace add <source>     # for clawdevbox marketplaces missing from the CLI
<binary> plugin list
<binary> plugin install <name>@<marketplace> # for clawdevbox plugins missing from the CLI
<binary> plugin uninstall <name>@<marketplace> # bidirectional cleanup, opt-out via config
```

A `SyncReport` is returned summarizing what was added, what was
already present, and any failures. Errors never block the originating
operation — they're logged WARN and surfaced in the report.

The built-in `clawdevbox-mcp` plugin (auto-installed at init, see
[`docs/plugins.md` → Built-in marketplace](./plugins.md#built-in-marketplace))
piggybacks on this same mechanism: once `clawdevbox init` installs it,
Direction A propagates it to the configured CLI's plugin store. Any
standalone CLI session the user then spawns sees a `.mcp.json` that
points at the running clawdevbox HTTP server, so `recipe.*`,
`workspace.*`, and the rest of the clawdevbox tools are visible there
too — without a second install step.

### Direction B — CLI → clawdevbox

At workspace boot **and on demand** (`clawdevbox plugin sync`,
`clawdevbox init`), the provider's `discoverInstalledPlugins` method
returns the list of plugins already installed in the CLI's local
plugin cache. clawdevbox loads each one via `loadPluginFromDir` and
registers **only the `clawdevbox.*` extension capabilities** (recipes,
tools, trigger_types, agent_clis, renderers). Skills, sub-agents,
slash-commands, and MCP-server entries stay client-side — they
already live in the CLI's runtime and clawdevbox does not duplicate
them.

Registered client-side plugins are tagged with `scope:
'client:<provider_id>'` so the workspace can tell them apart from
locally-installed plugins, and the user has to opt in once per plugin
(via the `clawdevbox init` probe step or `clawdevbox plugin sync`).
The opt-in is persisted in `cfg.client_sync.discovered_plugins`.

### The two new provider methods

Both methods are **optional**. Providers that don't implement them are
skipped silently. Add them to `AgentCliProvider`:

```ts
export interface AgentCliProvider {
  // …existing fields…
  syncPluginInventory?(
    ctx: ProviderCtx,
    opts: SyncPluginInventoryOpts,
  ): Promise<SyncReport>;
  discoverInstalledPlugins?(
    ctx: ProviderCtx,
  ): Promise<DiscoveredPlugin[]>;
}
```

#### Supporting types

```ts
export interface SyncPluginInventoryOpts {
  /** clawdevbox-installed plugins to make available to the CLI. */
  plugins: PluginEntry[];
  /** clawdevbox-known marketplaces to register with the CLI. */
  marketplaces: MarketplaceRecord[];
  /** When true, report what would change without making any changes. */
  dryRun?: boolean;
  /** When true (default), uninstall plugins removed from clawdevbox. */
  bidirectionalUninstall?: boolean;
}

export interface SyncReport {
  marketplacesAdded: string[];
  marketplacesPresent: string[];
  pluginsInstalled: string[];
  pluginsPresent: string[];
  pluginsUninstalled: string[];
  failed: Array<{ kind: 'marketplace' | 'plugin'; id: string; error: string }>;
  method: 'cli-command' | 'config-write' | 'mixed';
}

export interface DiscoveredPlugin {
  name: string;
  /** Absolute path to the plugin's root dir (contains .claude-plugin/plugin.json). */
  absoluteDir: string;
  source: 'cli-marketplace' | 'cli-direct' | 'cli-cache';
  marketplaceId: string | null;
}

export interface PluginCliBinding {
  /** Resolved binary name or absolute path. */
  binary: string;
  /** Optional argv prefix injected before the args (e.g. Windows shell wrapper). */
  argsPrefix?: string[];
  /** Reserved for CLIs that nest `plugin` under a sub-command. */
  subcommandPrefix?: string[];
  /** Conventional on-disk plugin cache directory for this CLI. */
  pluginCacheDir: string;
}
```

### Shared helpers

clawdevbox ships two helpers in
[`mcp-server/src/agent-clis/shared.ts`](../mcp-server/src/agent-clis/shared.ts)
that all three built-in providers (copilot, claude, agency) reuse
verbatim — and that third-party provider plugins should use too:

```ts
import { cliPluginSync, cliPluginDiscover } from 'clawdevbox/agent-clis';

export const myProvider: AgentCliProvider = {
  // …
  async syncPluginInventory(ctx, opts) {
    return cliPluginSync(ctx, opts, {
      binary: resolveMyBinary(),
      pluginCacheDir: path.join(os.homedir(), '.my-cli', 'plugins'),
    });
  },
  async discoverInstalledPlugins(ctx) {
    return cliPluginDiscover(ctx, {
      binary: resolveMyBinary(),
      pluginCacheDir: path.join(os.homedir(), '.my-cli', 'plugins'),
    });
  },
};
```

The helpers:

- Spawn the CLI with `windowsHide: true`, `shell: false`, and a 30s
  per-command timeout.
- Parse `plugin list` / `marketplace list` output with ANSI-tolerant
  regexes (`parsePluginListOutput`, `parseMarketplaceListOutput`).
- Try multiple disk layouts for the plugin cache (`<name>-<mp>/`,
  `<name>/`, `<mp>/<name>/`) so the same code works for Copilot's
  flat layout and Claude's marketplace-nested layout.
- Capture per-plugin failures into `SyncReport.failed[]` instead of
  throwing, so a single bad install doesn't abort the whole sync.

Any future provider that ships a `<binary> plugin install` /
`<binary> plugin list` surface can use these helpers directly. CLIs
with non-standard surfaces can implement `syncPluginInventory` /
`discoverInstalledPlugins` from scratch — the kernel only cares about
the return shape.

### Lifecycle hooks

| Event | Direction A (push) | Direction B (pull) |
|---|---|---|
| Workspace boot (`clawdevbox start`) | ✓ after kernel reload | ✓ after kernel reload |
| `clawdevbox plugin install <src>` | ✓ after success | — |
| `clawdevbox plugin uninstall <id>` | ✓ after success | — |
| `clawdevbox marketplace add <src>` | ✓ after success | — |
| `clawdevbox marketplace remove <id>` | ✓ after success | — |
| Config change (`default_agent_cli` flip) | ✓ on next reload | ✓ on next reload |
| `clawdevbox plugin sync` (manual) | ✓ unless `--direction=pull` | ✓ unless `--direction=push` |
| `plugin.install` / `plugin.uninstall` MCP tools | ✓ after success | — |

All hooks route through `maybeRunClientSync(ws, cfg, eventType)` in
[`mcp-server/src/agent-clis/lifecycle.ts`](../mcp-server/src/agent-clis/lifecycle.ts).
The helper is a no-op when `cfg.client_sync.mode === 'off'` or
`'manual'`; it skips Direction A when the mode is `'discover-only'`.
Errors are logged WARN and swallowed — sync **never blocks** the
originating operation.

### Config knob: `client_sync`

```toml
# clawdevbox.toml (project or global scope)
[client_sync]
mode = "auto"                  # 'auto' | 'discover-only' | 'manual' | 'off'
bidirectional_uninstall = true # when true, removing a plugin in clawdevbox uninstalls it in the CLI too

[[client_sync.discovered_plugins]]
provider = "copilot"
name = "superpowers"
```

| Value | Meaning |
|---|---|
| `mode = 'auto'` | Default. Both directions run automatically on every lifecycle event. |
| `mode = 'discover-only'` | Direction B runs automatically; Direction A is skipped (use `clawdevbox plugin sync --direction=push` to opt in manually). |
| `mode = 'manual'` | No automatic sync. `clawdevbox plugin sync` still runs both directions on demand. |
| `mode = 'off'` | All sync disabled (including `clawdevbox plugin sync` when `--respect-config` is set). |
| `bidirectional_uninstall = true` | Default. When clawdevbox uninstalls a plugin that came from a clawdevbox-known marketplace, the CLI also uninstalls it. Plugins from marketplaces clawdevbox doesn't know about are never touched. |
| `discovered_plugins[]` | Persisted opt-in list for Direction B. Each entry binds a provider id to a client-installed plugin name; without an entry, the plugin is shown in init but **not registered**. |

The merge is project-over-global-over-defaults, same as every other
clawdevbox config field. See
[`mcp-server/src/config.ts`](../mcp-server/src/config.ts) for the
resolver.

### Init probe step

When `clawdevbox init` runs, after the `--plugin` install pass and
before the agent-CLI chooser, an additional **probe step** kicks in
(only when `cfg.client_sync.mode !== 'off'`). It calls
`discoverInstalledPlugins` on every non-internal provider that reports
`available: true`, then filters to plugins that ship a non-empty
`clawdevbox.*` extension block. For each survivor it prints a
box-drawn card listing:

- The clawdevbox capabilities the plugin would register (recipes,
  tools, trigger_types, agent_clis, renderers — with descriptions
  harvested from disk).
- The client-side capabilities (skills/agents/commands/mcp-servers)
  that would **stay** in the CLI, for transparency.

The user gets a per-plugin `Enable clawdevbox capabilities from
'<name>'?` confirm prompt, and a final summary asks for one
confirmation before persisting the selection to
`cfg.client_sync.discovered_plugins`. See
[`mcp-server/src/cli/probe-client-plugins.ts`](../mcp-server/src/cli/probe-client-plugins.ts)
and
[`mcp-server/src/cli/init-probe-prompt.ts`](../mcp-server/src/cli/init-probe-prompt.ts)
for the implementation.

### `clawdevbox plugin sync` subcommand

```
clawdevbox plugin sync [--direction=both|push|pull] [--dry-run] [--respect-config]
```

Manually trigger bidirectional sync at any time. Defaults to running
both directions and ignoring `cfg.client_sync.mode` so the command
always does something (pass `--respect-config` to honor the configured
mode). `--dry-run` prints the planned changes without making them. See
[`docs/tools/plugin.md`](./tools/plugin.md#clawdevbox-plugin-sync) for
the full flag reference and exit semantics.

## `SpawnSessionOpts` modes

| mode          | init.kind | typical caller                                                |
|---------------|-----------|---------------------------------------------------------------|
| `interactive` | `new`     | `main-agent.ts` on `clawdevbox start` (workspace daemon)      |
| `headless`    | `new`     | `recipe.run` from MCP or a `trigger.fire`                     |
| `headless`    | `resume`  | `agent_session_resume` trigger fires (Phase 2 trigger kernel) |
| `interactive` | `resume`  | SPA "Resume" button on a paused step                          |

The provider switches argv on these two fields. Concrete arg recipes
are in [§ Built-in providers](#built-in-providers).

## Built-in providers

OSS ships three built-in providers, registered in
[`mcp-server/src/agent-clis/index.ts`](../mcp-server/src/agent-clis/index.ts):

```ts
export const BUILTIN_PROVIDERS: AgentCliProvider[] = [
  copilotProvider,
  claudeProvider,
  echoStubProvider,
];
```

Built-ins are registered **before** plugins, so plugin authors can
never shadow a built-in id.

### `copilot`

- **Display name:** GitHub Copilot CLI
- **Binary lookup:** `process.env.CLAWDEVBOX_COPILOT_PATH ?? (process.platform === 'win32' ? 'copilot.exe' : 'copilot')`.
- **MCP config:** Writes `<workspace>/.mcp.json` via `writeMcpJson`.
- **argv conventions:**
  - `init.kind === 'new'`: `--name=<session_id>`
  - `init.kind === 'resume'`: `--resume=<session_id>`
  - Always: `--additional-mcp-config @<workspace>/.mcp.json`
  - Headless adds: `--allow-all-tools -p <prompt>`
  - Interactive: no `-p`, no `--allow-all-tools` (user gets approval prompts).

The CLI honours `--name` / `--resume` verbatim, so `handle.sessionId`
equals `opts.init.session_id` every time.

### `claude`

- **Display name:** Anthropic Claude Code
- **Binary lookup:** `process.env.CLAWDEVBOX_CLAUDE_PATH ?? 'claude'`.
- **Windows wrap:** Claude Code is not a standalone `.exe` on Windows
  — the provider spawns through `cmd.exe /d /s /c claude …` instead.
- **MCP config:** Same `.mcp.json` write as copilot.
- **argv conventions:**
  - `init.kind === 'new'`: `--session-id <session_id>`
  - `init.kind === 'resume'`: `--resume <session_id>`
  - Headless adds: `-p <prompt>`

### `echo-stub`

- **`internal: true`** — hidden from the init chooser and the default
  `GET /api/agent-clis` listing. Surfaces only with `?include_internal=true`.
- No external dependency. `detect` always returns `{ available: true }`.
- Synthesizes a JS script at
  `<workspace>/.clawdevbox/echo-stub/<session_id>.js`, spawns it with
  `process.execPath`, and exits after writing a small artifact. Used by
  tests; recipes can still request it explicitly via
  `recipe.run({agent_cli: 'echo-stub'})`.

## Authoring a plugin

A provider plugin is an ordinary clawdevbox plugin (see
[`docs/plugins.md`](./plugins.md)) with a `clawdevbox.agent_clis[]`
entry in its `.claude-plugin/plugin.json` manifest. Steps:

### 1. Plugin manifest

```json
{
  "name": "my-cli",
  "version": "1.0.0",
  "description": "Registers the my-cli agent provider.",
  "clawdevbox": {
    "agent_clis": [
      {
        "id": "my-cli",
        "module": "dist/my-provider.mjs",
        "display_name": "My CLI",
        "description": "Spawns my-cli with project-specific context."
      }
    ]
  }
}
```

The provider entry's `id` must match `/^[a-z0-9][a-z0-9._-]*$/i`. The
`module` path is relative to the plugin root and rejects `..`
traversal. `display_name` falls back to `id` when omitted.

### 2. Provider module

The module's **default export** (or a named `provider` export) must
conform to `AgentCliProvider`. The loader duck-types — it checks for
`id`, `displayName`, `description`, and a callable `spawnSession`.
A minimal `.mjs` example:

```js
// dist/my-provider.mjs
const provider = {
  id: 'my-cli',
  displayName: 'My CLI',
  description: 'Spawns my-cli with project-specific context.',
  // `source` is overwritten by the loader to `plugin:<plugin_id>`.
  source: 'builtin',

  async detect(ctx) {
    const bin = process.env.MY_CLI_PATH ?? 'my-cli';
    try {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 4000 });
      if (r.status === 0) return { available: true, binary: bin, version: r.stdout.trim() };
      return { available: false, reason: r.stderr || `exit ${r.status}` };
    } catch (err) {
      return { available: false, reason: String(err?.message ?? err) };
    }
  },

  async spawnSession(ctx, opts) {
    const bin = process.env.MY_CLI_PATH ?? 'my-cli';
    const sessionFlag = opts.init.kind === 'new'
      ? `--name=${opts.init.session_id}`
      : `--resume=${opts.init.session_id}`;
    const argv = [sessionFlag];
    if (opts.mode === 'headless') argv.push('-p', opts.prompt);

    // Optionally drop a workspace-scoped config file:
    ctx.writeWorkspaceFile('.my-cli.json', JSON.stringify({ mcp: opts.mcp }, null, 2));

    const pty = ctx.spawnPty(bin, argv, {
      cwd: opts.workspaceInfo.path,
      env: { ...process.env, ...opts.ambientEnv },
      cols: opts.ptyCols ?? 120,
      rows: opts.ptyRows ?? 30,
    });

    return {
      pid: pty.pid ?? null,
      sessionId: opts.init.session_id,
      pty,
      exited: new Promise(resolve =>
        pty.onExit(({ exitCode, signal }) =>
          resolve({ exitCode, signal: signal != null ? String(signal) : undefined }))),
    };
  },
};

export default provider;
```

### Best practices

- **Use `ctx.spawnPty`**, not `node-pty` directly. The kernel registers
  the returned `IPty` with `pty-registry` so the SPA terminal can attach.
- **Use `ctx.writeWorkspaceFile`** for any config files the CLI needs.
  It writes atomically and rejects path traversal.
- **Never throw from `detect`.** Catch and return
  `{available: false, reason: '…'}`. The init chooser treats throws and
  timeouts as `available: false`.
- **Honor `opts.init.session_id`.** Set it as the underlying CLI's
  session id so resume works deterministically. If the CLI auto-mints
  ids, write the assigned id back into `handle.sessionId` and the
  kernel will persist it to `agent_sessions.cli_session_id`.
- **Honor `opts.mode`.** Headless callers must reach exit on their own
  (no interactive prompts); interactive callers expect a stayed-open
  pty. Don't pass `-p` when `mode === 'interactive'`.

## Installing a plugin

Three ways to install a provider plugin, in order of how Microsoft-side
users typically encounter them:

### One-liner during init

```bash
clawdevbox init --plugin git+https://github.com/microsoft/agency-cli-clawdevbox-plugin
```

`clawdevbox init` resolves the plugin source, installs it under
`<globalDir>/plugins/<id>/`, reloads the workspace registry, and then
the agent-CLI chooser surfaces the newly-registered provider alongside
the OSS built-ins.

### `plugin.install` MCP tool

From inside the agent:

```json
{ "from": "git+https://github.com/microsoft/agency-cli-clawdevbox-plugin" }
```

Installs the plugin without re-running init. The provider becomes
resolvable on the next workspace registry reload (which `plugin.install`
triggers automatically). The user still has to flip
`default_agent_cli` themselves — see [§ Switching the default](#switching-the-default).

### Local development

```bash
clawdevbox plugin install C:\src\my-plugin
```

Equivalent: `clawdevbox init --plugin C:\src\my-plugin` (init re-runs
fine on an already-configured workspace and is non-destructive). Local
sources are **junctioned**, not copied — edits to your `dist/` output
land in the plugin tree as soon as you save, and a service restart
picks them up.

## Switching the default

The provider used when a recipe doesn't pin one explicitly comes from
`default_agent_cli` in the config file (project- or global-scope).

### Init chooser

`clawdevbox init` runs the chooser after the `--plugin` install pass:

```
? Which agent CLI should this workspace use by default?
  ❯ GitHub Copilot CLI       (✓ copilot.exe 1.2.3)
    Anthropic Claude Code    (✓ claude 0.8.0)
    Agency         (✓ agency.exe 4.5)
    [skip — pick later via `clawdevbox config set`]
```

The selection is written to `default_agent_cli` in the same config
file init is already producing (project or global, matching the
init scope). The chosen provider's `setup` hook (if defined) runs
immediately after — usually a warning about missing API keys.

### One-shot

```bash
clawdevbox config set default_agent_cli claude        # project scope
clawdevbox config set default_agent_cli claude --global   # global scope
```

Validates the id against the runtime provider registry (refuses unknown
ids) and writes just that one field — no other init prompts re-run.

## Resolution chain at runtime

When the kernel needs a provider id for a spawn, it walks this chain
and stops at the first hit:

1. Explicit `agent_cli` argument on the `recipe.run` call.
2. Recipe-level `default_client` field in the recipe YAML.
3. Project config `default_agent_cli`.
4. Global config `default_agent_cli`.
5. Hardcoded fallback: `'copilot'`.

If the resolved id isn't in `ws.agentCliProviders`, `recipe.run`
returns `UNKNOWN_AGENT_CLI` and the main-agent declines to spawn (with
a logged warning; the workspace continues to serve HTTP).

## HTTP API: `GET /api/agent-clis`

Bearer-auth required. Returns the registered providers plus their
detect results, and anything in `ws.agentCliProviderErrors`.

```bash
curl -H "Authorization: Bearer $CLAWDEVBOX_TOKEN" \
  http://localhost:7077/api/agent-clis
```

```json
{
  "configured": "copilot",
  "providers": [
    {
      "id": "copilot",
      "display_name": "GitHub Copilot CLI",
      "description": "The official GitHub Copilot CLI (`copilot`).",
      "source": "builtin",
      "internal": false,
      "detect": { "available": true, "binary": "copilot.exe", "version": "1.2.3" }
    },
    {
      "id": "claude",
      "display_name": "Anthropic Claude Code",
      "description": "Anthropic's Claude Code CLI.",
      "source": "builtin",
      "internal": false,
      "detect": { "available": true, "binary": "claude", "version": "0.8.0" }
    }
  ],
  "errors": []
}
```

### Query params

| Param              | Default | Effect                                                                |
|--------------------|---------|-----------------------------------------------------------------------|
| `include_internal` | `false` | When `true`, internal providers (e.g. `echo-stub`) appear in the list. |

The SPA always uses the default (internal hidden). Tests opt in.

## Failure modes

Mirrored from the design spec, §14:

| Scenario | Behaviour |
|---|---|
| Plugin's `module` path resolves outside the plugin directory | Rejected at load; recorded in `agentCliProviderErrors` with code `MODULE_PATH_TRAVERSAL`. Other capabilities the plugin declares still load. |
| Plugin's `module` throws on dynamic `import()` | Recorded as `IMPORT_FAILED { plugin_id, module, error }`. Provider not registered. |
| Module's default export doesn't match `AgentCliProvider` shape | Recorded as `INVALID_PROVIDER_SHAPE`. Provider not registered. |
| Plugin tries to register a built-in id (`copilot`, `claude`, `echo-stub`) | Recorded as `BUILTIN_COLLISION`. Plugin loses; built-in keeps the slot. |
| Two plugins both register the same id `foo` | First plugin (sorted by plugin id) wins; loser recorded as `PLUGIN_COLLISION`. |
| `default_agent_cli` references a provider not in the registry | `recipe.run` returns `UNKNOWN_AGENT_CLI`; main-agent logs a warning and refuses to spawn. The workspace continues to serve HTTP. |
| `provider.detect()` throws or hangs past the 5-second timeout | Treated as `{available: false, reason: '<error>'}`. The chooser still shows the option, marked unavailable. |
| `provider.spawnSession()` throws | Caller catches, marks the recipe-instance / fire as failed with the error message. No pty registered. |
| Spawned pty exits before the kernel registers it (extremely fast crash) | The provider's `handle.exited` promise resolves; the kernel reports a spawn failure. |

## Migration from agency-hardcoded clawdevbox

Older Microsoft-internal builds spawned `agency.exe copilot` directly
from `main-agent.ts` and wrote an `agency.toml` to the workspace.
Those hardcodes are gone — `agency` is now a plugin. To migrate:

```bash
clawdevbox init --plugin git+https://github.com/microsoft/agency-cli-clawdevbox-plugin
```

Re-running init on an already-configured workspace is non-destructive:
existing plugin picks aren't dropped. The new step installs the agency
plugin, the chooser surfaces "Agency" alongside the OSS
built-ins, you pick it, and `default_agent_cli: agency` lands in the
existing config file. Restart the service and the main-agent now
spawns through the agency provider.
