# Bidirectional Plugin Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. One subagent per phase.

**Goal:** Wire bidirectional plugin sync between clawdevbox and the configured CLI (Claude, Copilot, Agency). Direction A pushes clawdevbox-installed plugins to the CLI via `<binary> plugin install`. Direction B pulls client-installed plugins carrying `clawdevbox.*` extensions into the clawdevbox registry. Plus an interactive `clawdevbox init` step that surfaces client-installed plugins with expandable details and persists user opt-in.

**Architecture:** Shared `cliPluginSync` / `cliPluginDiscover` helpers in `agent-clis/shared.ts` that all three CLI providers reuse. Two new optional methods on `AgentCliProvider`. New `client_sync` config field. New `clawdevbox plugin sync` subcommand. Init flow gains a probe step.

**Tech Stack:** TypeScript, node:test, `@clack/prompts`, `child_process.spawn`.

**Spec:** `docs/specs/2026-05-15-plugin-bidirectional-sync-design.md`

**Baseline:** HEAD `207e962` on `main`. 377/377 tests passing. Pre-existing typecheck errors at `template-store.ts:155`, `tools/trigger.ts:658`, `tools/trigger.ts:778`.

---

## File structure

**Modified files:**
- `mcp-server/src/agent-clis/types.ts` — new types (`SyncPluginInventoryOpts`, `SyncReport`, `DiscoveredPlugin`, `PluginCliBinding`).
- `mcp-server/src/agent-clis/shared.ts` — `cliPluginSync` + `cliPluginDiscover` helpers.
- `mcp-server/src/agent-clis/copilot.ts` — implement `syncPluginInventory` + `discoverInstalledPlugins`.
- `mcp-server/src/agent-clis/claude.ts` — same.
- `mcp-server/src/agent-clis/index.ts` — re-export the shared helpers.
- `mcp-server/src/config.ts` — `client_sync` field on `ClawdevboxConfig`; `clientSync` on `ResolvedConfig`.
- `mcp-server/src/tools/plugin.ts` — call `syncPluginInventory` after install/uninstall.
- `mcp-server/src/cli/marketplace.ts` — call `syncPluginInventory` after add/remove.
- `mcp-server/src/cli/start.ts` — boot-time sync wiring.
- `mcp-server/src/workspace.ts` — Direction B import: pull client plugins into `ws.plugins` with `scope: 'client:<provider>'`.
- `mcp-server/src/cli/init.ts` — probe step + interactive flow.
- `mcp-server/src/cli/index.ts` — `plugin sync` subcommand dispatch.

**New files:**
- `mcp-server/src/cli/plugin-sync.ts` — `clawdevbox plugin sync` subcommand.
- `mcp-server/src/cli/probe-client-plugins.ts` — helper for the init probe step.
- `mcp-server/tests/cli-plugin-sync.test.mjs` — unit tests for helpers.
- `mcp-server/tests/init-client-probe.test.mjs` — init probe tests.
- `mcp-server/tests/fixtures/fake-cli/fake-claude.cjs` — fake CLI for integration tests.
- `mcp-server/tests/fixtures/fake-cli/fake-copilot.cjs` — fake CLI for integration tests.

**External:**
- `C:\git\agency-provider\agency-provider.mjs` — add `syncPluginInventory` + `discoverInstalledPlugins`.

---

## Phase 1 — Types + shared helpers

### Task 1.1: Types

**File:** `mcp-server/src/agent-clis/types.ts`

Add to the existing types module:

```ts
export interface PluginCliBinding {
  binary: string;
  subcommandPrefix?: string[];
  pluginCacheDir: string;
}

export interface SyncPluginInventoryOpts {
  plugins: PluginEntry[];                  // from workspace
  marketplaces: MarketplaceRecord[];       // from cli/marketplace.ts
  dryRun?: boolean;
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
  absoluteDir: string;
  source: 'cli-marketplace' | 'cli-direct' | 'cli-cache';
  marketplaceId: string | null;
}
```

Extend `AgentCliProvider` interface with the two new optional methods (`syncPluginInventory`, `discoverInstalledPlugins`) using the types above.

**Commit:** `feat(agent-clis): bidirectional-sync types (sync/discover/PluginCliBinding)`

### Task 1.2: `cliPluginSync` shared helper

**File:** `mcp-server/src/agent-clis/shared.ts`

Export:

```ts
export async function cliPluginSync(
  ctx: ProviderCtx,
  opts: SyncPluginInventoryOpts,
  binding: PluginCliBinding,
): Promise<SyncReport>;
```

Implementation:
1. `await runCli(binding, ['plugin', 'marketplace', 'list'])` → parse text output; build `Set<marketplaceId>`.
2. For each `m` in `opts.marketplaces` not in the set:
   - If `opts.dryRun`, append to `marketplacesAdded` and continue.
   - Else run `<binary> plugin marketplace add <source>`. On non-zero exit, push to `failed`. Else push to `marketplacesAdded`.
3. `await runCli(binding, ['plugin', 'list'])` → parse `  • <name>@<marketplace> (vX.Y.Z)` lines; build `Set<'name@marketplace'>`.
4. For each `p` in `opts.plugins`:
   - Compute install source: prefer `<name>@<marketplaceId>` when the plugin's install record links to a clawdevbox-known marketplace; otherwise use the original git URL or `owner/repo`.
   - If already present, push to `pluginsPresent`; continue.
   - Else if `dryRun`, push to `pluginsInstalled`; continue.
   - Else run `<binary> plugin install <source>`. On non-zero exit, push to `failed`.
5. Bidirectional uninstall (default-on per `cfg.clientSync.bidirectionalUninstall`):
   - For each installed plugin in the CLI's list whose marketplace is in `clawdevbox-known marketplaces` BUT whose name is no longer in `opts.plugins`, run `<binary> plugin uninstall <name>@<marketplace>`. Track in `pluginsUninstalled` / `failed`.
6. Return `SyncReport` with `method: 'cli-command'`.

Use `child_process.spawn` with `windowsHide: true`, 30s per-command timeout.

Parse helpers — `parsePluginListOutput(stdout: string): Array<{name, marketplace, version}>`:
- Strip ANSI escape codes via `/\x1b\[[0-9;]*m/g`.
- Match lines with regex `/^\s*[•·*-]\s+([a-z0-9._-]+)@([a-z0-9._-]+)\s+\(v([^)]+)\)/i`.
- Skip lines that don't match (header/footer).

`parseMarketplaceListOutput(stdout: string): string[]` — similar parser for the marketplace list output.

Add tests in `tests/cli-plugin-sync.test.mjs` with hardcoded sample outputs from both `copilot plugin list` and `claude plugin list` (capture real outputs as fixtures).

**Commit:** `feat(agent-clis): cliPluginSync shared helper`

### Task 1.3: `cliPluginDiscover` shared helper

**File:** `mcp-server/src/agent-clis/shared.ts`

Export:

```ts
export async function cliPluginDiscover(
  ctx: ProviderCtx,
  binding: PluginCliBinding,
): Promise<DiscoveredPlugin[]>;
```

Implementation:
1. `await runCli(binding, ['plugin', 'list'])` → parse via `parsePluginListOutput`.
2. For each `{name, marketplace}`:
   - Try `<pluginCacheDir>/<name>-<marketplace>/` first.
   - Then `<pluginCacheDir>/<name>/`.
   - On match → build `DiscoveredPlugin` with `source: 'cli-marketplace'`, `marketplaceId: marketplace`.
   - On no match → log WARN, skip.
3. Return array.

If the `plugin list` call itself errors, log WARN and return `[]`.

**Commit:** `feat(agent-clis): cliPluginDiscover shared helper`

### Task 1.4: Tests with fake binaries

**Files:** `mcp-server/tests/cli-plugin-sync.test.mjs` (new), `mcp-server/tests/fixtures/fake-cli/fake-claude.cjs` (new), `mcp-server/tests/fixtures/fake-cli/fake-copilot.cjs` (new).

The fake CLI is a Node script that:
- Reads argv. If `argv[1] === 'plugin'`, dispatches on `argv[2]`:
  - `list` → prints a fixed text fixture.
  - `marketplace list` → prints a fixed list.
  - `install <source>` → records the call to a sidecar `<tmpDir>/calls.jsonl` file, exits 0.
  - `marketplace add <source>` → records the call, exits 0.
  - `uninstall <source>` → records the call, exits 0.
- Tests build a `PluginCliBinding` pointing at `process.execPath` + the fake script path; assert recorded calls match expectations.

Cover: marketplace add path, marketplace already-present, plugin install path, plugin already-installed, plugin install error, bidirectional uninstall, dry-run.

Add the test file to `mcp-server/package.json` `"test"` script.

**Commit:** `test(agent-clis): cliPluginSync/cliPluginDiscover with fake CLI fixtures`

---

## Phase 2 — Wire providers + config

### Task 2.1: Provider implementations

**Files:** `mcp-server/src/agent-clis/copilot.ts`, `mcp-server/src/agent-clis/claude.ts`, `mcp-server/src/agent-clis/index.ts`.

In `copilot.ts`, add both methods that delegate to `cliPluginSync` / `cliPluginDiscover` with the appropriate binding (`binary: copilotBinary()`, `pluginCacheDir: path.join(os.homedir(), '.copilot', 'plugins')`).

In `claude.ts`, same with `'~/.claude/plugins/cache'`.

In `echo-stub.ts`, omit both methods (kernel handles `undefined` gracefully).

In `index.ts`, re-export `cliPluginSync` and `cliPluginDiscover` from shared so plugin authors can import them via `clawdevbox/agent-clis`.

Add tests that mock the helpers and verify the provider calls them with the right bindings.

**Commit:** `feat(agent-clis): wire copilot+claude providers to sync/discover`

### Task 2.2: Config schema + resolver

**File:** `mcp-server/src/config.ts`

Add `ClawdevboxClientSyncConfig` type per spec §9. Add `client_sync?: ClawdevboxClientSyncConfig` to `ClawdevboxConfig`. Add `clientSync` to `ResolvedConfig` with the resolved defaults.

In `resolveConfig`, merge project > global > defaults:
- `mode`: default `'auto'`.
- `bidirectionalUninstall`: default `true`.
- `discoveredPlugins`: default `[]`.

Add a validator for `client_sync` (mode value, types).

Tests verify the defaults + project/global merge.

**Commit:** `feat(config): client_sync field with project>global merge`

### Task 2.3: Kernel lifecycle hooks

**Files:** `mcp-server/src/tools/plugin.ts`, `mcp-server/src/cli/marketplace.ts`, `mcp-server/src/cli/start.ts`, `mcp-server/src/workspace.ts`.

Add a helper `await maybeRunClientSync(ws, cfg, eventType)` that:
1. Skips if `cfg.clientSync.mode === 'off'` or `'manual'`.
2. Skips Direction A if `cfg.clientSync.mode === 'discover-only'`.
3. Looks up the configured provider in `ws.agentCliProviders`.
4. If the provider has `syncPluginInventory`, calls it; same for `discoverInstalledPlugins`.
5. Errors logged WARN; never throws.

Call this helper from:
- `tools/plugin.ts` install/uninstall handlers (after the existing operation succeeds).
- `cli/marketplace.ts` add/remove handlers (after success).
- `cli/start.ts` boot — after `reloadTypeRegistries`.

**Direction B integration** (workspace.ts):
- After kernel boot's reload, iterate `cfg.clientSync.discoveredPlugins`. For each, call the configured provider's `discoverInstalledPlugins` → match against the persisted list → load each opted-in plugin via `loadPluginFromDir` → register only `clawdevbox.*` extensions into the workspace with `scope: 'client:<provider>'`.

**Commit:** `feat(kernel): lifecycle hooks for bidirectional plugin sync`

---

## Phase 3 — `plugin sync` subcommand

### Task 3.1: Subcommand implementation

**File:** `mcp-server/src/cli/plugin-sync.ts` (new), `mcp-server/src/cli/index.ts`.

Argv parsing:
- `--direction=both|push|pull` (default `both`).
- `--dry-run`.
- `--respect-config` (default false — i.e., manual sync runs even if mode is `'off'`).

Implementation:
1. `await loadWorkspaceFromEnv()`.
2. `cfg = resolveConfig()`.
3. If `--respect-config` and mode is `off`, print message + exit 0.
4. Look up provider via `cfg.defaultAgentCli`.
5. If direction includes `pull`: call `provider.discoverInstalledPlugins(ctx)`. Print count + the filtered (against `cfg.clientSync.discoveredPlugins`) subset to be registered.
6. If direction includes `push`: read clawdevbox's marketplaces + plugins → call `provider.syncPluginInventory(ctx, {plugins, marketplaces, dryRun})` → print the `SyncReport`.
7. Exit 0 on success, even with `failed[]` entries. Exit 1 only if the provider lookup fails.

Wire into `cli/index.ts` dispatcher under `plugin sync`.

Tests in `tests/cli-plugin-sync.test.mjs` invoking `runPluginSync` programmatically.

**Commit:** `feat(cli): clawdevbox plugin sync subcommand`

---

## Phase 4 — Init probe step

### Task 4.1: Probe helper

**File:** `mcp-server/src/cli/probe-client-plugins.ts` (new).

Export:

```ts
export interface ProbedPlugin {
  pluginName: string;
  pluginDir: string;
  providerId: string;
  manifestPath: string;
  clawdevbox: {
    recipes: Array<{id: string; description?: string; file: string}>;
    tools: Array<{id: string; runtime: string; description?: string; file: string}>;
    trigger_types: Array<{id: string; description?: string; default_cron?: string; file: string}>;
    agent_clis: Array<{id: string; display_name: string; description?: string}>;
    renderers: Array<{type: string; description?: string; file: string}>;
  };
  clientSide: {
    skills: Array<{id: string; description?: string}>;
    agents: Array<{id: string; description?: string}>;
    commands: Array<{id: string; description?: string}>;
    mcpServers: Array<{id: string}>;
  };
}

export async function probeClientPlugins(ws: Workspace, cfg: ResolvedConfig): Promise<ProbedPlugin[]>;
```

Implementation:
1. For each user-facing provider in `ws.agentCliProviders.values()`:
   - Skip if `internal: true`.
   - `await provider.detect?.(ctx)`. Skip if `!available`.
   - `await provider.discoverInstalledPlugins?.(ctx)`. Skip if undefined.
2. For each returned plugin dir, `await loadPluginFromDir(dir)`. Check `manifest.clawdevbox`. Skip if undefined/empty.
3. For each surviving candidate, harvest descriptions from disk (read recipe YAMLs, sidecars, etc.) per spec §10.2.
4. Run all providers in parallel via `Promise.all`. Per-provider failures degrade gracefully (skip).

Tests with a tmp fixture directory containing a fake-Claude-installed plugin tree.

**Commit:** `feat(init): probe client-installed plugins for clawdevbox extensions`

### Task 4.2: Init prompt integration

**File:** `mcp-server/src/cli/init.ts`.

After the existing `--plugin` install pass + workspace reload, BEFORE the agent-CLI chooser:

```ts
import { probeClientPlugins } from './probe-client-plugins.ts';
import { note, confirm } from '@clack/prompts';

if (cfg.clientSync.mode !== 'off') {
  const probed = await probeClientPlugins(ws, cfg);
  if (probed.length > 0) {
    note(`We found ${probed.length} plugins from your installed CLIs that ship clawdevbox extensions.`);
    
    const selectedNames = new Set<string>();
    const preselected = new Set(cfg.clientSync.discoveredPlugins.map(d => `${d.provider}:${d.name}`));
    
    for (const [i, p] of probed.entries()) {
      const isPreselected = preselected.has(`${p.providerId}:${p.pluginName}`);
      note(renderPluginCard(p, i + 1, probed.length));
      const include = await confirm({
        message: `Enable clawdevbox capabilities from '${p.pluginName}'?`,
        initialValue: isPreselected,
      });
      if (include === true) selectedNames.add(`${p.providerId}:${p.pluginName}`);
    }
    
    // Final summary
    const selectedList = probed.filter(p => selectedNames.has(`${p.providerId}:${p.pluginName}`));
    if (selectedList.length > 0) {
      note(renderFinalSummary(selectedList));
      const confirmed = await confirm({ message: 'Confirm and persist?', initialValue: true });
      if (confirmed === true) {
        cfg.clientSync.discoveredPlugins = selectedList.map(p => ({
          provider: p.providerId,
          name: p.pluginName,
        }));
      }
    }
  }
}
```

`renderPluginCard(p, idx, total)` is a helper that builds the box-drawn card per spec §10.3. It uses `┌─ ... ─┐` / `│` / `└─...─┘` characters. Width clamped to 80 chars; long lines truncated with ellipsis.

`renderFinalSummary(selectedList)` is a helper that prints the bullet list and the "persisted to <path>" note.

The probe step is skipped (with a one-line `note(...)`) if `cfg.clientSync.mode === 'off'`.

`probedPlugins` selections are persisted to the config file written by the existing config-write step (no separate write).

Tests stub the `@clack/prompts.confirm` calls.

**Commit:** `feat(init): probe + opt-in step for client-installed plugins`

---

## Phase 5 — Agency plugin update

### Task 5.1: Update `C:\git\agency-provider`

**File:** `C:\git\agency-provider\agency-provider.mjs`.

Add the same `syncPluginInventory` + `discoverInstalledPlugins` methods that delegate to the shared helpers from `clawdevbox/agent-clis`. The plugin already imports from this path (existing `provider` shape lookup).

Use the same `~/.copilot/plugins` cache dir as the copilot provider (Agency wraps Copilot).

Update `README.md` with a section on bidirectional sync.

Run `node test-fixture.mjs` to confirm the provider still loads cleanly.

Commit in `C:\git\agency-provider`:
```
chore: bidirectional plugin sync (sync + discover methods)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Phase 6 — Docs

### Task 6.1: Update docs

**Files:**
- `docs/agent-clis.md` — new "Bidirectional plugin sync" section after the provider interface section. Cover the two methods, the shared helpers, lifecycle hooks.
- `docs/plugins.md` — note that clawdevbox-installed plugins also become available in the configured CLI (Direction A) and vice versa (Direction B).
- `docs/tools/plugin.md` — document `clawdevbox plugin sync` subcommand.
- `docs/MCP-TOOLS-REFERENCE.md` — regenerate.

**Commit:** `docs: bidirectional plugin sync`

---

## Phase 7 — End-to-end smoke

### Task 7.1: E2E smoke

**File:** `mcp-server/tests/plugin-sync-e2e.test.mjs` (new).

Plant a fake Claude binary at a tmp path, point the resolved `claude` binary at it via env override. Plant 2 fake "installed" plugins under tmp `~/.claude/plugins/cache/`. Run:

1. `clawdevbox plugin sync --direction=pull --dry-run` → asserts both fake plugins appear in the report.
2. `clawdevbox plugin sync --direction=push --dry-run` → asserts the expected `claude plugin install …` calls would be made.

### Task 7.2: Final clean run

- `npm run typecheck` — only the 3 pre-existing errors.
- `npm run build` — clean.
- `npm test` — all passing.
- Final HEAD reported.

---

## Rules for executing subagents

- **NEVER use Haiku.** Opus 4.7 1M.
- `npm test` and `npm run typecheck` after EVERY commit.
- Co-authored-by trailer on every commit.
- Stay on `main` in `C:\git\clawdevbox`. Stay on `main` in `C:\git\agency-provider`.
- Pre-existing 3 typecheck errors stay. No new errors.
- Don't break the 377-test baseline.

## Phasing for dispatch

1. **Phase 1** (Tasks 1.1-1.4) — types + shared helpers + tests. Foundation; doesn't touch consumers.
2. **Phase 2** (Tasks 2.1-2.3) — provider implementations + config + lifecycle hooks.
3. **Phase 3** (Task 3.1) — `plugin sync` subcommand.
4. **Phase 4** (Tasks 4.1-4.2) — init probe step.
5. **Phase 5** (Task 5.1) — agency plugin update in separate repo.
6. **Phase 6** (Task 6.1) — docs.
7. **Phase 7** (Tasks 7.1-7.2) — end-to-end smoke + final verify.

A single subagent can carry Phases 1-2-3 in one dispatch. Phase 4 separately (init touches a sensitive file). Phase 5 separately (different repo). Phase 6+7 together.
