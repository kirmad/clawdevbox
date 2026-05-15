# Bidirectional Plugin Sync between clawdevbox and Agent CLIs

**Status:** Draft (design)
**Date:** 2026-05-15
**Scope:** Two-way plugin sync between clawdevbox and the configured agent CLI (Claude Code, GitHub Copilot CLI, Microsoft Agency). Direction A: plugins installed via clawdevbox are auto-installed in the client CLI (via the client's own `plugin install` command). Direction B: plugins already installed in the client CLI that carry a `clawdevbox.*` extension block are auto-registered in clawdevbox's workspace. Plus an interactive init step that surfaces client-installed plugins with expandable component listings.

## 1. Problem

A user with both clawdevbox and Claude (or Copilot, or Agency) installed runs through three friction points:

1. **`clawdevbox plugin install x` does not make `x`'s skills/agents/commands/MCP visible to the CLI.** The plugin lands at `<globalDir>/plugins/x/` and clawdevbox registers its capabilities — but `claude` (or `copilot`/`agency`) doesn't know about it.
2. **A plugin pre-installed in the CLI carries clawdevbox extensions that go unused.** Many Microsoft `ado-private` plugins have `clawdevbox.recipes[]` / `clawdevbox.trigger_types[]` blocks that clawdevbox doesn't see because clawdevbox only scans its own `<globalDir>/plugins/`.
3. **At `clawdevbox init`, the user has no idea which already-installed plugins carry clawdevbox extensions** — there's no surfacing, no opt-in.

The result is two parallel plugin worlds that should be one cohesive system.

## 2. Goals & Non-Goals

### Goals

- Direction A — clawdevbox-side install/uninstall/marketplace-add operations sync to the configured CLI via that CLI's own `plugin` command surface.
- Direction B — client-installed plugins that carry a non-empty `clawdevbox.*` extension block are auto-registered in clawdevbox.
- Interactive `clawdevbox init` step that lists candidate client-installed plugins with expandable component details and persists the user's opt-in selection.
- Manual `clawdevbox plugin sync` subcommand that triggers both directions on demand.
- A `client_sync` config knob (`auto` / `manual` / `discover-only` / `off`) so users can disable any direction they want.
- Use each CLI's own commands (`claude plugin …`, `copilot plugin …`, `agency plugin …`) — fall back to direct config writes only when no command exists.

### Non-Goals

- **Adopting client-installed plugins WITHOUT clawdevbox extensions.** A plugin that's only skills+agents adds nothing to clawdevbox; it stays purely client-side.
- **Pull-side scope rewriting.** clawdevbox doesn't override the CLI's existing install-scope decisions (`user` / `project` / `local`). When Direction A installs into the CLI, it always targets user scope.
- **Mid-session reloads.** A plugin installed by clawdevbox during an active CLI session won't appear in that session until the user runs the CLI's own reload command (`/reload-plugins` in Claude). Sync simply makes the plugin AVAILABLE for the next CLI invocation.
- **Direct edits to client config files when a `plugin` command exists.** Claude, Copilot, and Agency all expose `plugin install` — clawdevbox uses subprocess calls, never writes `~/.claude/settings.json` directly.
- **Dependency resolution across CLI plugin systems.** clawdevbox treats each CLI's plugins as opaque; we don't try to resolve `dependencies[]` on the client side.

## 3. Provider interface additions

Two new optional methods on `AgentCliProvider`:

```ts
export interface AgentCliProvider {
  // ... existing fields ...

  /** Reconcile the configured CLI's plugin inventory with the given clawdevbox
   *  plugin/marketplace state. Idempotent. Prefers calling the CLI's own
   *  `plugin install` / `plugin marketplace add` commands; falls back to
   *  direct config writes only when the CLI has no command for that
   *  capability. */
  syncPluginInventory?(ctx: ProviderCtx, opts: SyncPluginInventoryOpts): Promise<SyncReport>;

  /** Enumerate plugins this CLI has already installed. clawdevbox loads
   *  each one and (in Direction B) registers any `clawdevbox.*` extension
   *  capabilities into the workspace. */
  discoverInstalledPlugins?(ctx: ProviderCtx): Promise<DiscoveredPlugin[]>;
}

export interface SyncPluginInventoryOpts {
  /** clawdevbox-installed plugins to make available to the CLI. */
  plugins: PluginEntry[];
  /** clawdevbox-known marketplaces to register with the CLI. */
  marketplaces: MarketplaceRecord[];
  /** Honor cfg.client_sync (in particular, treat 'discover-only' as a no-op
   *  even when this method is invoked manually). */
  dryRun?: boolean;
}

export interface SyncReport {
  marketplacesAdded:     string[];   // marketplace ids registered just now
  marketplacesPresent:   string[];   // already known to the CLI
  pluginsInstalled:      string[];   // <name>@<marketplace> ids installed just now
  pluginsPresent:        string[];   // already installed
  pluginsUninstalled:    string[];   // removed because they're no longer in clawdevbox
  failed: Array<{ kind: 'marketplace' | 'plugin'; id: string; error: string }>;
  method: 'cli-command' | 'config-write' | 'mixed';
}

export interface DiscoveredPlugin {
  name: string;
  /** Absolute path to the plugin's root dir. Has .claude-plugin/plugin.json. */
  absoluteDir: string;
  /** How this plugin landed on the CLI's filesystem. */
  source: 'cli-marketplace' | 'cli-direct' | 'cli-cache';
  /** Marketplace name when source='cli-marketplace', else null. */
  marketplaceId: string | null;
}
```

The kernel never assumes a provider implements these methods. `internal` providers (echo-stub) omit both. The agency plugin (in `C:\git\agency-provider`) implements both by delegating to the same shared helpers (§4).

## 4. Shared `cliPluginSync` / `cliPluginDiscover` helpers

Most of the work is identical across `claude`, `copilot`, and `agency`. Move it into `mcp-server/src/agent-clis/shared.ts`:

```ts
export interface PluginCliBinding {
  /** Resolved binary name or absolute path. */
  binary: string;
  /** Subcommand prefix before 'plugin' — e.g. agency uses ['copilot'] in some
   *  setups, but at the top-level today all three use [] before 'plugin'. */
  subcommandPrefix?: string[];
  /** Conventional on-disk plugin cache directory for this CLI.
   *  - claude: `~/.claude/plugins/cache`
   *  - copilot: `~/.copilot/plugins`
   *  - agency: same as copilot (wraps Copilot's plugin system)
   */
  pluginCacheDir: string;
}

export async function cliPluginSync(
  ctx: ProviderCtx,
  opts: SyncPluginInventoryOpts,
  binding: PluginCliBinding,
): Promise<SyncReport>;

export async function cliPluginDiscover(
  ctx: ProviderCtx,
  binding: PluginCliBinding,
): Promise<DiscoveredPlugin[]>;
```

### `cliPluginSync` algorithm

1. **Marketplace step.**
   - Run `<binary> plugin marketplace list` (parse text output). Build the set of marketplace ids already known.
   - For each clawdevbox-known marketplace not in that set:
     - Run `<binary> plugin marketplace add <source>` where `<source>` is the original git URL or local path.
     - On non-zero exit, capture the stderr and add to `failed[]` with `kind: 'marketplace'`. Don't abort — continue with the next marketplace.
2. **Plugin install step.**
   - Run `<binary> plugin list` (parse text output `  • <name>@<marketplace> (vX.Y.Z)`). Build the set of installed `<name>@<marketplace>` ids.
   - For each clawdevbox-installed plugin:
     - Determine the install source: `<name>@<marketplace>` (when the plugin came from a clawdevbox-known marketplace) or `owner/repo` / git URL (when installed directly).
     - If not in the installed set, run `<binary> plugin install <source>`. Capture exit + stderr.
3. **Plugin uninstall step.** (Optional based on `client_sync.bidirectional_uninstall`, default `true`)
   - For each plugin in the CLI's installed set that came from a `clawdevbox-` marketplace (identified by a marker the sync wrote at add-time) but is no longer in clawdevbox's installed set:
     - Run `<binary> plugin uninstall <name>@<marketplace>`.
   - Plugins the user installed directly via the CLI are never auto-uninstalled.
4. Return `SyncReport` with the four arrays. `method = 'cli-command'` for all three CLIs.

For plugins that have NO `<binary> plugin install` command path (none today, but forward-compat for hypothetical CLIs), the helper falls back to direct config writes and sets `method = 'config-write'`. The shared helper isn't responsible for those writes — that's the provider's job in `syncPluginInventory` after the helper returns.

### `cliPluginDiscover` algorithm

1. Run `<binary> plugin list`. Parse each line `  • <name>@<marketplace> (vX.Y.Z)` (the format used by both `copilot plugin list` and `claude plugin list`).
2. For each, locate the on-disk dir. Resolution order:
   - `<binding.pluginCacheDir>/<name>-<marketplace>/` (Claude's convention, also Copilot's as of v0.0.369).
   - `<binding.pluginCacheDir>/<name>/` (some older layouts).
   - If neither exists, skip with a one-line warn (still return what we found).
3. Return `DiscoveredPlugin[]` with `source: 'cli-marketplace'` and `marketplaceId: <marketplace>`.

Plugin list output parsing is forgiving — we extract `<name>` and `<marketplace>` via a regex that tolerates ANSI color codes (CLIs emit them) and minor format variations.

If `<binary> plugin list` exits non-zero, return `[]` and log a WARN (the CLI may be too old to support plugins, or not authenticated).

## 5. Per-provider wiring

### 5.1 `mcp-server/src/agent-clis/copilot.ts`

```ts
import { cliPluginSync, cliPluginDiscover } from './shared.ts';

const COPILOT_PLUGIN_CACHE = path.join(os.homedir(), '.copilot', 'plugins');

export const copilotProvider: AgentCliProvider = {
  // ... existing fields ...
  async syncPluginInventory(ctx, opts) {
    return cliPluginSync(ctx, opts, {
      binary: resolveBinary(),
      pluginCacheDir: COPILOT_PLUGIN_CACHE,
    });
  },
  async discoverInstalledPlugins(ctx) {
    return cliPluginDiscover(ctx, {
      binary: resolveBinary(),
      pluginCacheDir: COPILOT_PLUGIN_CACHE,
    });
  },
};
```

### 5.2 `mcp-server/src/agent-clis/claude.ts`

Same shape with `~/.claude/plugins/cache` and `claude` binary.

### 5.3 `mcp-server/src/agent-clis/echo-stub.ts`

Both methods omitted (echo-stub doesn't exec a real CLI). The kernel handles `provider.syncPluginInventory === undefined` gracefully.

### 5.4 Agency plugin (`C:\git\agency-provider\agency-provider.mjs`)

Replicates the same delegation, importing the helpers via the public clawdevbox-side path:

```js
import { cliPluginSync, cliPluginDiscover } from 'clawdevbox/agent-clis';
import os from 'node:os';
import path from 'node:path';

const AGENCY_PLUGIN_CACHE = path.join(os.homedir(), '.copilot', 'plugins');  // agency wraps copilot

const agencyProvider = {
  // ... existing fields ...
  async syncPluginInventory(ctx, opts) {
    return cliPluginSync(ctx, opts, {
      binary: resolveAgencyBinary(),
      pluginCacheDir: AGENCY_PLUGIN_CACHE,
    });
  },
  async discoverInstalledPlugins(ctx) {
    return cliPluginDiscover(ctx, {
      binary: resolveAgencyBinary(),
      pluginCacheDir: AGENCY_PLUGIN_CACHE,
    });
  },
};
export default agencyProvider;
```

The helpers are re-exported from `mcp-server/src/agent-clis/index.ts` so plugin authors get them via the existing `clawdevbox/agent-clis` import path.

## 6. Kernel lifecycle hooks

The kernel invokes the two methods on the configured agent-CLI provider (resolved via `cfg.defaultAgentCli`, fallback `'copilot'`) at the following events:

| Trigger | Methods called | Order |
|---|---|---|
| `clawdevbox start` boot (after `reloadTypeRegistries`) | `discoverInstalledPlugins` then `syncPluginInventory` | Discover first so the workspace has all client extensions BEFORE the sync makes sure the client has all clawdevbox plugins. |
| `clawdevbox plugin install <x>` succeeds | `syncPluginInventory(allPlugins)` | After the plugin row lands in `<globalDir>/plugins/`. |
| `clawdevbox plugin uninstall <x>` succeeds | `syncPluginInventory(allPlugins)` | Same. |
| `clawdevbox marketplace add <s>` succeeds | `syncPluginInventory(allPlugins)` | Marketplace metadata is in place. |
| `clawdevbox marketplace remove <s>` succeeds | `syncPluginInventory(allPlugins)` | Same. |
| `clawdevbox config set default_agent_cli <id>` | both, against the NEW provider | The old provider's state is untouched. |
| `clawdevbox plugin sync` (new manual command) | both | Ignores `cfg.client_sync` value (always runs) unless `--respect-config` flag is passed. |

Sync failures (CLI binary missing, plugin install errored) are logged at WARN level and reported in the command's output. They never abort the calling clawdevbox operation.

## 7. `clawdevbox plugin sync` subcommand

New file: `mcp-server/src/cli/plugin-sync.ts`.

```
clawdevbox plugin sync [--direction=both|push|pull] [--dry-run] [--respect-config]

  --direction=both       Default. Runs discoverInstalledPlugins + syncPluginInventory.
  --direction=push       Direction A only (clawdevbox → CLI).
  --direction=pull       Direction B only (CLI → clawdevbox).
  --dry-run              Report what would change without making changes.
  --respect-config       Honor cfg.client_sync (default for this command is to ignore it).
```

Output: human-readable summary with counts and per-plugin status. Exits 0 even on partial failure; exits 1 only if the provider lookup fails entirely.

Wired into `cli/index.ts` next to `clawdevbox plugin install/uninstall/list` (whichever sibling dispatcher exists).

## 8. Direction B import rules

When `discoverInstalledPlugins` returns plugin directories, the kernel:

1. For each path, call `loadPluginFromDir(path)` (already async).
2. Check `manifest.clawdevbox` — if undefined OR all of `recipes/tools/trigger_types/agent_clis/renderers` are empty, **skip**. clawdevbox-irrelevant plugins don't bloat the workspace.
3. Check whether this plugin's `(provider, name)` tuple appears in `cfg.client_plugins[]` (the persisted opt-in list, §9). If not, log a one-shot `INFO` (`new CLI plugin '<name>' detected; run \`clawdevbox plugin sync\` or \`clawdevbox init\` to opt in`) and **skip**.
4. Register in `ws.plugins` with id `client:${provider}:${name}`. The plugin entry's `scope` becomes `client:${provider}`.
5. Wire ONLY the `clawdevbox.*` extension capabilities into the appropriate registries (recipes/tools/trigger_types/agent_clis/renderers).
6. Skills/agents/commands/MCP from these plugins are NEVER registered in clawdevbox — the CLI already exposes them natively. The loaded manifest still carries them in memory (for the init step's expanded display), but they don't enter the workspace registries.

## 9. New config fields

In `ClawdevboxConfig` / `ResolvedConfig`:

```ts
export interface ClawdevboxClientSyncConfig {
  /** auto = both directions eager. manual = via `clawdevbox plugin sync` only.
   *  discover-only = pull side only (no writes to CLI). off = no sync. */
  mode?: 'auto' | 'manual' | 'discover-only' | 'off';
  /** When true (default), plugins removed from clawdevbox are also uninstalled
   *  from the CLI (only those that came from a clawdevbox-managed marketplace). */
  bidirectional_uninstall?: boolean;
  /** Persisted from `clawdevbox init` opt-in. Each entry is a (provider, name)
   *  tuple of a CLI-installed plugin clawdevbox should register. */
  discovered_plugins?: Array<{ provider: string; name: string }>;
}

export interface ClawdevboxConfig {
  // ... existing fields ...
  client_sync?: ClawdevboxClientSyncConfig;
}

export interface ResolvedConfig {
  // ... existing fields ...
  clientSync: {
    mode: 'auto' | 'manual' | 'discover-only' | 'off';
    bidirectionalUninstall: boolean;
    discoveredPlugins: Array<{ provider: string; name: string }>;
  };
}
```

Resolution defaults (when unset): `mode: 'auto'`, `bidirectional_uninstall: true`, `discovered_plugins: []`. Project config overrides global.

## 10. `clawdevbox init` probe step

After the existing `--plugin <source>` install loop and the workspace registry reload, BEFORE the existing agent-CLI chooser:

```
[…existing plugin install pass…]
[…existing workspace reload…]

NEW: probe each user-facing detected CLI provider for installed plugins
     with non-empty clawdevbox.* extensions; offer multi-select with
     expandable detail view; persist selections to cfg.client_sync.discovered_plugins[].

[…existing agent-CLI chooser…]
[…existing config write…]
```

### 10.1 Probe algorithm

1. Iterate `ws.agentCliProviders.values()`. Skip `internal: true` providers.
2. For each, call `await provider.detect?.(ctx)`. Skip when `available: false` (no CLI binary).
3. Call `await provider.discoverInstalledPlugins?.(ctx)`. Each returned plugin dir is passed through `loadPluginFromDir`.
4. Filter to plugins whose manifest has a non-empty `clawdevbox.*` block.
5. For each, build a `ProbedPlugin` record (§10.2) with capability counts and detail data.
6. Concurrent execution: all providers probed in parallel via `Promise.all`; per-provider failures degrade gracefully (skip that provider, continue others).

### 10.2 `ProbedPlugin` record

```ts
interface ProbedPlugin {
  pluginName: string;
  pluginDir: string;
  providerId: string;
  manifestPath: string;

  // clawdevbox-side (registered)
  clawdevbox: {
    recipes:       Array<{id: string; description?: string; file: string}>;
    tools:         Array<{id: string; runtime: string; description?: string; file: string}>;
    trigger_types: Array<{id: string; description?: string; default_cron?: string; file: string}>;
    agent_clis:    Array<{id: string; display_name: string; description?: string}>;
    renderers:     Array<{type: string; description?: string; file: string}>;
  };

  // Client-side (NOT registered by clawdevbox; shown for transparency)
  clientSide: {
    skills:     Array<{id: string; description?: string}>;
    agents:     Array<{id: string; description?: string}>;
    commands:   Array<{id: string; description?: string}>;
    mcpServers: Array<{id: string}>;
  };
}
```

Description harvesting:
- Recipes: parse `description:` from the recipe YAML/JSON top level.
- Tools: if the tool file has a JSDoc-style `/** description */` comment at top, parse it; otherwise omit.
- Triggers: read sibling `<id>.trigger.yaml`'s `description`.
- Agent CLIs: the provider module's `description` field (read by dynamic import OR by static regex scan — pragmatic: static scan to avoid running plugin code at init).
- Renderers: from the entry's optional `description` field; otherwise omit.
- Skills/agents/commands: YAML frontmatter `description`.

All harvesting is best-effort. Missing descriptions are simply omitted from the display.

### 10.3 Interactive prompt (looped per-plugin flow)

For each `ProbedPlugin`, show a `note(...)` card and a `confirm(...)`. Pseudo-flow:

```
We found 4 plugins from your installed CLIs that ship clawdevbox extensions.

Plugin 1 of 4: ado-pipeline-autodebug (claude)
┌─ Components clawdevbox will register ──────────────────────────┐
│ Recipes (2):                                                    │
│   • ado-pipeline.investigate-failure                            │
│     "Classify ADO pipeline failure and propose a fix."          │
│   • ado-pipeline.retry-flaky-stage                              │
│                                                                  │
│ Trigger types (1):                                              │
│   • ado-pipeline.build-failure-watcher  (every 5 minutes)       │
│     "Poll the ADO build for new failures."                      │
│                                                                  │
│ Components handled by Claude (not registered by clawdevbox):    │
│   • skill: check-build-status                                   │
│   • skill: analyze-build-failure                                │
│   • skill: compare-builds                                       │
│   • skill: retry-failed-stages                                  │
│   • skill: run-pipeline                                         │
│                                                                  │
│ Source: ~/.claude/plugins/cache/ado-pipeline-autodebug-ic3-…    │
└─────────────────────────────────────────────────────────────────┘
? Enable clawdevbox capabilities from this plugin? (Y/n)
```

After all plugins are reviewed, show a final summary:

```
You selected 3 of 4 client plugins to register with clawdevbox:
  • ado-pipeline-autodebug  (claude)
  • cfv                      (claude)
  • confluence               (copilot)

These selections are persisted to <config-path> and respected on every boot.
You can change them later via `clawdevbox plugin sync` or by re-running `clawdevbox init`.
? Confirm and persist? (Y/n)
```

If the user confirms, write each `(provider, name)` to `cfg.client_sync.discovered_plugins[]`.

### 10.4 Re-running init in a configured workspace

On re-run, `cfg.client_sync.discovered_plugins` is read first. For each probed plugin, the prompt is pre-checked if already in the list. Selections that were previously checked but no longer wanted can be unchecked → removed from the persisted list.

The prompt always shows the current state of CLI-installed plugins, even if some were uninstalled from the CLI since last init.

### 10.5 Implementation note

The card display uses `note(...)` (already a `@clack/prompts` primitive). The per-plugin loop uses `confirm(...)`. The final summary uses `note(...)` + `confirm(...)`. No custom widget needed.

If `cfg.client_sync.mode === 'off'`, the probe step is skipped entirely with a one-line `note(...)` ("Client plugin discovery disabled by config; skipping.").

## 11. Plugin scope hierarchy

After this change, `ws.plugins.keys()` shows:

```
clawdevbox:cfv                       ← `clawdevbox plugin install cfv@ic3-ai-plugins`
clawdevbox:icm                       ← clawdevbox-installed
client:claude:ado-pipeline-autodebug ← discovered from Claude
client:copilot:confluence            ← discovered from Copilot
client:agency:devboost               ← discovered from Agency
builtin:hello                        ← bundled in the kernel (rare)
```

`PluginEntry.scope` becomes `'project' | 'global' | 'plugin:<id>' | 'client:<provider>'` — the new scope value distinguishes client-discovered from clawdevbox-installed.

`GET /api/plugins` (when it exists) groups by scope.

## 12. Conflict resolution

If a plugin id appears in BOTH `clawdevbox:<name>` and `client:<provider>:<name>`:

- **clawdevbox-installed wins** — it's the explicit user choice. Capabilities register from there.
- Client-installed instance is recorded with `status: 'shadowed'`. Logged at INFO level. Visible in `plugin list` but doesn't contribute capabilities.

If two client-installed plugins (e.g., Claude AND Agency both register the same plugin name):

- The configured provider's discovery wins. The non-configured one is recorded as `shadowed`.

## 13. Failure modes

| Scenario | Behaviour |
|---|---|
| CLI binary not on PATH | `provider.detect()` returns `available: false`; sync/discover skipped silently. |
| `<binary> plugin list` returns non-zero (e.g., unauthenticated Copilot) | Sync returns empty `pluginsPresent`; reports failure in `SyncReport.failed[]`. Discover returns `[]`. Both log WARN. |
| `<binary> plugin install <x>` fails (plugin not in marketplace, etc.) | Captured in `SyncReport.failed[]` with the stderr. Sync continues with the next plugin. |
| Plugin found via `plugin list` but not on disk at expected path | Skipped, WARN logged. The user can re-run sync; possibly the CLI version changed paths. |
| `discoverInstalledPlugins` throws | Caught by the kernel; logged WARN; treated as `[]`. |
| `cfg.client_sync.mode === 'off'` | Both methods skipped entirely. |
| `cfg.client_sync.mode === 'discover-only'` | `syncPluginInventory` is skipped; `discoverInstalledPlugins` still runs. |
| `cfg.client_sync.mode === 'manual'` | Both skipped automatically; only `clawdevbox plugin sync` invokes them. |
| Plugin from CLI has malformed `plugin.json` | Skipped during probe; not added to `ProbedPlugin[]`; clawdevbox continues. |
| User picks a client plugin in init, then later uninstalls it from the CLI | Boot discovery returns empty for that name; the entry sits in `cfg.client_sync.discovered_plugins[]` unused. Re-running init re-prompts. No automatic cleanup. |

## 14. Testing strategy

### 14.1 Unit tests

- `cliPluginSync`:
  - All marketplaces unknown → adds each.
  - All marketplaces present → adds none, no failures.
  - Plugin install succeeds → in `pluginsInstalled[]`.
  - Plugin install fails (non-zero exit) → in `failed[]`.
  - Bidirectional uninstall on/off.
- `cliPluginDiscover`:
  - Empty output → `[]`.
  - Three plugins listed → each resolved to a dir.
  - On-disk path missing → that entry skipped with WARN.
  - ANSI color codes in output → parser ignores them.
- Provider methods delegate correctly to shared helpers (mock binary).

### 14.2 Integration tests with fake binaries

Build a fake `copilot` / `claude` binary as a Node script that:
- `plugin list` → emits a fixed plugin list to stdout.
- `plugin marketplace list` → emits a fixed marketplace list.
- `plugin install <x>` → exits 0 and records the call to a sidecar file.
- `plugin marketplace add <x>` → exits 0, records call.

Test exercises `cliPluginSync` against the fake binary, asserts the recorded calls match the expected mutation set.

### 14.3 Init probe test

Stub `@clack/prompts.confirm` to auto-accept. Plant a fake plugin under a tmp `~/.claude/plugins/cache/`. Run init programmatically. Assert `cfg.client_sync.discovered_plugins` contains the right entry.

### 14.4 End-to-end smoke

A live test that:
1. Boots clawdevbox in a tmp project.
2. Plants a plugin in `<globalDir>/plugins/cfv/` with `clawdevbox.*` extension.
3. Runs `clawdevbox plugin sync --direction=push --dry-run` against a fake `copilot` binary.
4. Asserts the planned `copilot plugin install cfv@…` call appears in dry-run output.

## 15. Phasing

1. **Provider interface + types + shared helpers.** `cliPluginSync`, `cliPluginDiscover`, types in `agent-clis/types.ts`.
2. **Built-in providers wire up.** `copilot.ts`, `claude.ts`, `echo-stub.ts` (no-op).
3. **Kernel lifecycle hooks + `clientSync` config.** New ResolvedConfig field; hooks in plugin tools, marketplace CLI, start boot.
4. **`clawdevbox plugin sync` subcommand.**
5. **`clawdevbox init` probe step.** Per-plugin confirm loop, summary, persistence into `discovered_plugins[]`.
6. **Agency plugin update** (separate repo, `C:\git\agency-provider`).
7. **Tests** — unit + fake-binary integration + init probe.
8. **Docs** — update `docs/agent-clis.md`, `docs/plugins.md`, `docs/tools/plugin.md`; new section on bidirectional sync.

## 16. Out of scope

- Bidirectional dependency resolution (clawdevbox dependency graph ↔ Claude `dependencies[]`).
- Auto-running `<binary> /reload-plugins` inside an active CLI session.
- Cross-CLI plugin promotion (a plugin installed in Claude auto-syncing to Copilot).
- Filtering by `agency.json.engines` during Direction B (we already filter at clawdevbox-install time; for Direction B the CLI already installed the plugin so engine filter is moot).
- Live UI in the SPA for the discovery list (separate `GET /api/plugins?scope=client:*` endpoint can come later).
