# Clawdevbox Repo as a Built-in Marketplace

**Status:** Draft (design)
**Date:** 2026-05-15
**Scope:** Make the clawdevbox repo itself a Claude-Code-style plugin marketplace. Move built-in plugins out of `samples/plugins/` into a top-level `plugins/` directory. Ship three built-in plugins (`clawdevbox-mcp`, `dev-buddy`, `ado`). Replace the bespoke `BUILTIN_PLUGINS` array + `installBuiltinPlugin` machinery with the standard marketplace install path. Extract the hardcoded `dev-buddy` skill out of `main-agent.ts` into a real plugin. Auto-install `clawdevbox-mcp` at `clawdevbox init` so the configured CLI sees clawdevbox's MCP server through its own plugin pipeline.

## 1. Problem

clawdevbox today maintains TWO parallel plugin mechanisms:

1. **Built-in plugins** — a hardcoded `BUILTIN_PLUGINS: BuiltinPluginDef[]` array in `mcp-server/src/builtin-plugins.ts`, served via a special-purpose `installBuiltinPlugin()` that copies from `samples/plugins/<id>/` into `<globalDir>/plugins/<id>/`. `clawdevbox init` calls this directly. One entry exists today: `ado`.

2. **Third-party plugins** — installed via `clawdevbox plugin install` or via the marketplace consumer added in the previous work. Lives at `<globalDir>/plugins/<id>/` (same destination as built-ins).

The shapes are identical at the destination but the install paths are different code, with different validators, different UI surfaces, and (today) a different source-file layout (built-in plugins must live under `samples/plugins/`).

Two additional pain points:

- The `dev-buddy` skill is hardcoded as a string literal in `main-agent.ts` (`DEV_BUDDY_SKILL_BODY`, ~70 lines) and seeded onto disk by `seedDevBuddySkill()` at workspace boot. It's a built-in capability but lives outside the plugin system.
- `clawdevbox` exposes an MCP server, but the configured CLI doesn't see it unless clawdevbox SPAWNS that CLI (the existing `writeMcpJson` in `agent-clis/shared.ts` writes a workspace `.mcp.json` only at spawn time). Standalone `claude`/`copilot`/`agency` sessions don't have clawdevbox tools.

## 2. Goals & Non-Goals

### Goals

- The clawdevbox repo has a `.claude-plugin/marketplace.json` at the root. clawdevbox itself is a Claude-Code-style marketplace named `clawdevbox`.
- Built-in plugins live at top-level `plugins/<id>/` — out of `samples/`.
- Three built-in plugins ship in v1: `clawdevbox-mcp`, `dev-buddy`, `ado`.
- A new `clawdevbox` extension key on each marketplace entry declares `install_tier: 'required' | 'recommended' | 'optional'`.
- `clawdevbox init` auto-installs `required` plugins silently and shows a multi-select for `recommended` + `optional` (recommended pre-checked).
- After init, the bidirectional sync forwards every installed plugin to the configured CLI's own `plugin install` command — so the CLI's standalone sessions see `clawdevbox-mcp`, `dev-buddy`'s skill, etc.
- The hardcoded `dev-buddy` seed in `main-agent.ts` is removed. `dev-buddy` becomes a real plugin.
- The bespoke `BUILTIN_PLUGINS` + `installBuiltinPlugin` machinery is removed. One install path for everything.
- The published npm package ships `dist/marketplace/` so the built-in marketplace is available without needing the source repo.

### Non-Goals

- Migrating built-in renderers (`markdown.mjs`, `pr-review.mjs`, `walkthrough.mjs`) into a plugin. They stay kernel-shipped. Future cleanup.
- An HTTP variant of `clawdevbox-mcp` (`clawdevbox-mcp-http`). Stdio-only for v1. Users running clawdevbox as a long-lived service can configure the HTTP MCP entry manually.
- Migrating `samples/recipes/` (`simple-prompt.yaml`) or `samples/triggers/` into plugins. They're test fixtures and demo material, not user-facing plugins. They stay at `samples/`.
- A `--no-builtin` flag's interaction with re-running init in a configured workspace. v1 behavior: `--no-builtin` always skips step 5 (built-in install) entirely; previously-installed built-ins stay; nothing is uninstalled.

## 3. Repo layout after this work

```
C:\git\clawdevbox\
├── .claude-plugin/
│   └── marketplace.json                ← NEW
├── plugins/                             ← NEW (top-level)
│   ├── clawdevbox-mcp/
│   │   ├── .claude-plugin/plugin.json
│   │   └── .mcp.json
│   ├── dev-buddy/
│   │   ├── .claude-plugin/plugin.json
│   │   └── skills/
│   │       └── dev-buddy/
│   │           └── SKILL.md             ← content from DEV_BUDDY_SKILL_BODY
│   └── ado/
│       ├── .claude-plugin/plugin.json
│       ├── skills/
│       ├── tools/
│       ├── recipes/
│       └── triggers/
├── samples/
│   ├── recipes/simple-prompt.yaml      ← unchanged
│   ├── triggers/...                     ← unchanged
│   └── README.md                        ← updated to point at plugins/
└── ... (mcp-server/, docs/, etc.)
```

`samples/plugins/ado/` is removed. `samples/plugins/` no longer exists.

## 4. `.claude-plugin/marketplace.json`

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-marketplace.json",
  "name": "clawdevbox",
  "description": "Built-in plugins shipped with clawdevbox.",
  "owner": { "name": "Clawdevbox team" },
  "metadata": {
    "version": "0.1.0",
    "pluginRoot": "./plugins"
  },
  "plugins": [
    {
      "name": "clawdevbox-mcp",
      "source": "clawdevbox-mcp",
      "version": "0.1.0",
      "description": "Registers the clawdevbox MCP server with the configured CLI. After install, any session that CLI spawns can call recipe.*, trigger.*, inbox.*, artifact.*, plugin.*, and the other clawdevbox tools.",
      "author": { "name": "Clawdevbox team" },
      "category": "core",
      "clawdevbox": { "install_tier": "required" }
    },
    {
      "name": "dev-buddy",
      "source": "dev-buddy",
      "version": "1.0.0",
      "description": "Workspace persona for the clawdevbox main agent. Catches users up on workspace state on /catchup, surfaces inbox items, and helps schedule or run recipes.",
      "author": { "name": "Clawdevbox team" },
      "category": "core",
      "clawdevbox": { "install_tier": "recommended" }
    },
    {
      "name": "ado",
      "source": "ado",
      "version": "1.0.0",
      "description": "Azure DevOps: PR review, comments, iterations, and cold/hot/pulse triggers.",
      "author": { "name": "Clawdevbox team" },
      "category": "azure",
      "keywords": ["azure-devops", "code-review", "ado", "pr"],
      "clawdevbox": {
        "install_tier": "optional",
        "required_env": ["ADO_ORG", "ADO_BEARER_TOKEN"]
      }
    }
  ]
}
```

The `clawdevbox` extension key carries clawdevbox-specific marketplace-entry metadata. `install_tier` drives init behavior. `required_env` is read by init to surface env-var hints in the multi-select.

## 5. The three built-in plugins

### 5.1 `clawdevbox-mcp`

**`plugins/clawdevbox-mcp/.claude-plugin/plugin.json`:**

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "clawdevbox-mcp",
  "version": "0.1.0",
  "description": "Registers the clawdevbox MCP server with the configured agent CLI.",
  "author": { "name": "Clawdevbox team" },
  "keywords": ["clawdevbox", "mcp", "core"],
  "mcpServers": "./.mcp.json"
}
```

**`plugins/clawdevbox-mcp/.mcp.json`:**

```json
{
  "mcpServers": {
    "clawdevbox": {
      "command": "npx",
      "args": ["-y", "clawdevbox", "mcp"]
    }
  }
}
```

When `<binary> plugin install clawdevbox-mcp@clawdevbox` is called (via the bidirectional sync), the CLI's plugin system registers the `clawdevbox` MCP server. Standalone sessions then spawn `npx -y clawdevbox mcp` per session.

The spawned `clawdevbox mcp` resolves its workspace via `CLAWDEVBOX_PROJECT_DIR` env if set, else falls back to `process.cwd()` (§7).

### 5.2 `dev-buddy`

**`plugins/dev-buddy/.claude-plugin/plugin.json`:**

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "dev-buddy",
  "version": "1.0.0",
  "description": "Workspace persona for the clawdevbox main agent.",
  "author": { "name": "Clawdevbox team" },
  "keywords": ["clawdevbox", "main-agent", "skill"]
}
```

`skills` field omitted → auto-discover the `skills/` directory.

**`plugins/dev-buddy/skills/dev-buddy/SKILL.md`:**

The exact content of the current `DEV_BUDDY_SKILL_BODY` string literal in `mcp-server/src/main-agent.ts:61-125`, copied verbatim. Existing frontmatter:

```yaml
---
id: dev-buddy
name: Dev Buddy
description: Persona + opening playbook for the clawdevbox main agent...
---
```

After the plugin installs to `<globalDir>/plugins/dev-buddy/skills/dev-buddy/SKILL.md`, the standard plugin loader (which already auto-discovers `skills/<id>/SKILL.md`) registers the skill in the workspace skill registry. The main agent sees it through the normal skill-lookup path. No special-case code.

### 5.3 `ado`

The content of `samples/plugins/ado/` moves to `plugins/ado/`. Everything else (skills, tools, recipes, triggers, the existing `.claude-plugin/plugin.json`) is unchanged.

The `node_modules/` and `_legacy-mcp-server/` directories at `samples/plugins/ado/` are NOT moved — they were development artifacts. `.gitignore` ensures they don't sneak back.

## 6. Bundled-marketplace auto-registration

A new helper in `mcp-server/src/builtin-marketplace.ts` (the renamed `builtin-plugins.ts`):

```ts
/**
 * Resolve the absolute path to the bundled built-in marketplace dir.
 * Returns null if the dir cannot be found in any candidate location.
 *
 * Candidates in order of preference:
 *   1. <module-dir>/../marketplace                — published-package dev (dist/marketplace)
 *   2. <module-dir>/../../marketplace             — published-package (one level deeper)
 *   3. <module-dir>/../..                          — running from source repo root
 *   4. <module-dir>/../../..                       — running from source repo (extra deep)
 *
 * The resolver checks for a `.claude-plugin/marketplace.json` at each
 * candidate before accepting it.
 */
export function resolveBuiltinMarketplaceSource(): string | null;

/**
 * Idempotently register the bundled marketplace into <globalDir>/marketplaces/.
 * If already registered (sidecar file exists), no-op.
 * Otherwise junction the source dir at <globalDir>/marketplaces/clawdevbox/
 * and write a sidecar with kind='builtin'.
 *
 * Errors are logged at WARN level and don't throw — clawdevbox can still
 * function without the built-in marketplace.
 */
export function ensureBuiltinMarketplaceRegistered(cfg: ResolvedConfig): void;
```

Called at the start of `cli/init.ts` (before the `--plugin` install pass) AND at the start of `cli/start.ts`'s boot (after DB opens). The init path runs it BEFORE the marketplace consumer reads marketplaces so the built-in catalog is available for the init multi-select.

The junction target is the source dir resolved by `resolveBuiltinMarketplaceSource()`. Junction creation uses Windows `junction` type (no admin needed) and POSIX `dir` symlink. Failure to junction (e.g. permission denied) is logged WARN and the function returns — init continues without built-ins.

The sidecar record at `<globalDir>/marketplaces/clawdevbox.json`:

```json
{
  "id": "clawdevbox",
  "kind": "builtin",
  "source": "<resolved-path>",
  "ref": null,
  "name": "clawdevbox",
  "description": "Built-in plugins shipped with clawdevbox.",
  "pluginCount": 3,
  "addedAt": 1715800000000
}
```

`kind: 'builtin'` tells `clawdevbox marketplace update` to no-op (the marketplace is a live junction; nothing to pull).

## 7. `CLAWDEVBOX_PROJECT_DIR` cwd fallback

Today `loadWorkspaceFromEnv` in `mcp-server/src/workspace.ts` requires `CLAWDEVBOX_PROJECT_DIR` to be set; it throws `WorkspaceConfigError` otherwise. After this change:

```ts
const projectDir = env.CLAWDEVBOX_PROJECT_DIR?.trim() || process.cwd();
```

When the CLI plugin's `.mcp.json` launches `npx -y clawdevbox mcp` from a project directory, `process.cwd()` is that directory — so the workspace resolves correctly without env-var ceremony.

The existing strict behavior (throw if PROJECT_DIR not set AND cwd doesn't exist) becomes: throw only when neither env var nor cwd is a real directory. This is rarely the case.

Tests that exercise `loadWorkspaceFromEnv` without setting `CLAWDEVBOX_PROJECT_DIR` need updating — they currently rely on the throw. The pragmatic fix: set `CLAWDEVBOX_PROJECT_DIR` explicitly in those tests OR rely on cwd. Either works.

## 8. Init flow rewrite

`cli/init.ts` after the change:

```
1.  Resolve scope (project/global), port, token, tunnel, notifications
    (unchanged)
2.  ensureBuiltinMarketplaceRegistered(cfg)                                    NEW
3.  Existing --plugin <source> install pass
4.  Existing workspace reload
5.  Built-in plugin install step:                                              NEW
    a. Open marketplace at <globalDir>/marketplaces/clawdevbox/
    b. For each plugin with install_tier='required':
         installFromLocalFolder(<plugin-source-dir>)
       Log a single line: "Installed required built-ins: <name1>, <name2>"
    c. Build a multi-select with:
         - install_tier='recommended' → pre-checked
         - install_tier='optional' → unchecked
         hint string includes required_env list when present
    d. For each user-picked plugin: installFromLocalFolder(<plugin-source-dir>)
    e. Skip the entire step 5 if --no-builtin flag set
6.  Existing probe step (client-installed plugins with clawdevbox extensions)
7.  Existing agent-CLI chooser
8.  Existing config write
9.  Existing bidirectional sync — pushes ALL installed plugins (including
    the auto-installed clawdevbox-mcp) to the configured CLI via
    `<binary> plugin install <name>@clawdevbox`
```

Implementation note: step 5 should run BEFORE step 6 (probe) so that the probe step has the full clawdevbox marketplace context. Step 5 runs BEFORE step 7 (agent-CLI chooser) so the chooser can advise the user on which CLI to pick for the just-installed plugins.

### 8.1 PATH diagnostic

After step 5 installs `clawdevbox-mcp`, run a one-time check:

```ts
const onPath = await which('clawdevbox');
if (!onPath) {
  note('Warning: `clawdevbox` is not on PATH. The CLI integration installed by clawdevbox-mcp won\'t resolve until you `npm install -g clawdevbox` or set up a PATH entry pointing at the local clone.');
}
```

`which` is the existing helper (or `npx which` fallback). Diagnostic prints once and doesn't fail init.

## 9. Deletions

### 9.1 From `mcp-server/src/builtin-plugins.ts` (renamed `builtin-marketplace.ts`)

- `BUILTIN_PLUGINS` constant — DELETED.
- `BuiltinPluginDef` interface — DELETED.
- `installBuiltinPlugin` function — DELETED.
- `resolveBuiltinPluginSource` function — DELETED.

Kept and added:
- `ensureGlobalNodeModulesLink` — unchanged (used by every plugin install path).
- `resolveBuiltinMarketplaceSource` — NEW.
- `ensureBuiltinMarketplaceRegistered` — NEW.

### 9.2 From `mcp-server/src/main-agent.ts`

- `DEV_BUDDY_SKILL_ID` constant — DELETED.
- `DEV_BUDDY_SKILL_BODY` constant — DELETED (~70 lines).
- `seedDevBuddySkill` function — DELETED.
- The call site at line 174 — DELETED.

### 9.3 From `mcp-server/src/cli/init.ts`

- Lines 332-345 (the `BUILTIN_PLUGINS.map(...)` multi-select for built-in plugins) — replaced by the new tier-driven step.
- Lines 472-475 (the `installBuiltinPlugin(globalDir, id)` call) — replaced by `installFromLocalFolder(<plugin-source-dir>)`.
- Imports of `BUILTIN_PLUGINS` and `installBuiltinPlugin` — removed.

## 10. `scripts/build.mjs` changes

Today's behavior:
```
dist/cli.js
dist/plugins/                  ← copy of samples/plugins/
dist/renderers/                ← copy of mcp-server/src/renderers/
dist/web/                      ← built web app
```

New behavior:
```
dist/cli.js
dist/marketplace/
├── .claude-plugin/
│   └── marketplace.json       ← copy of <repo>/.claude-plugin/marketplace.json
└── plugins/
    ├── clawdevbox-mcp/        ← copy of <repo>/plugins/clawdevbox-mcp/
    ├── dev-buddy/             ← copy of <repo>/plugins/dev-buddy/
    └── ado/                   ← copy of <repo>/plugins/ado/
dist/renderers/                ← unchanged
dist/web/                      ← unchanged
```

`dist/plugins/` is REMOVED.

The build script reads `<repo>/.claude-plugin/marketplace.json` to find which plugins to copy (instead of a hardcoded list). It copies the marketplace.json file too. The same filter as today (skip `node_modules/`, `_legacy-*`) applies.

## 11. Sync between clawdevbox marketplace and the configured CLI

The bidirectional sync (`provider.syncPluginInventory`) added in the previous work already runs `<binary> plugin marketplace add ...` and `<binary> plugin install ...` for every clawdevbox-known marketplace and plugin. The new clawdevbox marketplace is just another entry in `<globalDir>/marketplaces/`, so the existing sync handles it without modification.

For `<binary> plugin marketplace add clawdevbox`, the `source` argument is the local junction path: `<globalDir>/marketplaces/clawdevbox`. Both Claude and Copilot's `plugin marketplace add` accept local paths.

After the sync, the configured CLI has:
- The `clawdevbox` marketplace registered.
- The `clawdevbox-mcp` plugin installed → CLI registers the clawdevbox MCP server natively → standalone sessions see clawdevbox's tools.
- Any other built-in plugins the user opted into (e.g. `dev-buddy`'s skill is now available to the configured CLI too).

This is the cohesive-system payoff from the previous work — Direction A already handles the new marketplace; we're just adding a new source to it.

## 12. Backward compatibility

- Users upgrading from a previous clawdevbox version where `samples/plugins/ado` was installed at `<globalDir>/plugins/ado/` see no change — their existing install is preserved. The new built-in marketplace registers, but the plugin install record at `<globalDir>/plugins/ado.install.json` already exists; init detects this and pre-checks the box.
- Users who relied on `seedDevBuddySkill` (file at `<projectDir>/.clawdevbox/skills/dev-buddy.md` or `<projectDir>/.clawdevbox/skills/dev-buddy/SKILL.md`) — the file stays on disk after the upgrade (we don't delete it). After the user accepts `dev-buddy` in init, the plugin-installed copy at `<globalDir>/plugins/dev-buddy/skills/dev-buddy/SKILL.md` takes precedence (per the existing skill discovery precedence: project > global > plugin). If the user wants the plugin version to win, they can manually delete the project-scope copy. Document this in the migration notes.
- `clawdevbox-mcp` auto-install is NEW; existing users who run init again get it. Users who run `clawdevbox start` without re-running init don't get the auto-install (init is the trigger). Document this — or add a `clawdevbox start` first-boot check (out of scope for v1; future polish).
- The `BUILTIN_PLUGINS`-shaped install record at `<globalDir>/plugins/<id>.install.json` had `kind: 'builtin'`. The new path uses `installFromLocalFolder` which writes `kind: 'local'`. Both shapes coexist in the wild — readers (e.g., `plugin.update`'s error message) need to accept either. Pragmatic: leave existing records alone; new installs write `kind: 'local'`.

## 13. Failure modes

| Scenario | Behaviour |
|---|---|
| `resolveBuiltinMarketplaceSource()` returns null (very rare — clawdevbox source/dist not found) | WARN logged at boot; init skips step 5 with a note ("Built-in marketplace unavailable; only --plugin selections will be installed"); user can proceed. |
| Junction creation at `<globalDir>/marketplaces/clawdevbox/` fails (permission) | WARN logged; init skips step 5. |
| `installFromLocalFolder` fails on a required built-in (`clawdevbox-mcp`) | ERROR logged; init prints a prominent warning ("Failed to install required built-in clawdevbox-mcp — the CLI won't see clawdevbox tools automatically. Run `clawdevbox plugin install clawdevbox-mcp@clawdevbox` later."); init continues. |
| `<binary> plugin install clawdevbox-mcp@clawdevbox` fails during bidirectional sync (CLI binary missing) | Existing WARN-only behavior from the sync subsystem. User can run `clawdevbox plugin sync` after installing the CLI. |
| `clawdevbox` not on PATH when `npx -y clawdevbox mcp` is invoked | The CLI session reports a connection error for the `clawdevbox` MCP server. The PATH diagnostic at init step 5 warned the user. |
| User runs `clawdevbox init --no-builtin` | Step 5 entirely skipped. No built-ins auto-installed; no multi-select; existing installs untouched. |
| User runs init twice; second run sees built-ins already installed | The pre-existing install records are detected; multi-select pre-checks them. Auto-install of required tier is idempotent (already installed → no-op). |
| `clawdevbox-mcp` plugin's `.mcp.json` references `npx` but `npx` not in PATH | Same as "clawdevbox not in PATH" — runtime error in CLI sessions, not init-blocking. |

## 14. Testing strategy

### 14.1 Unit tests

- `resolveBuiltinMarketplaceSource`: tmp dir setups simulating each candidate path; assert resolution.
- `ensureBuiltinMarketplaceRegistered`: idempotency (call twice, no error, sidecar unchanged); junction failure → WARN-only.
- Marketplace.json validates against the existing `validateMarketplaceJson` validator.

### 14.2 Integration tests

- `loadMarketplace(<repo-root>)` parses the marketplace.json + builds the expected 3-plugin entry list.
- Each built-in plugin's `plugin.json` validates against `validatePluginManifestJson`.
- `dev-buddy/skills/dev-buddy/SKILL.md` has the same content as the old `DEV_BUDDY_SKILL_BODY` constant (byte-for-byte diff).

### 14.3 Init flow tests

- Mock `@clack/prompts`. Run init programmatically.
- Assert `clawdevbox-mcp` is installed at `<globalDir>/plugins/clawdevbox-mcp/` even when the user selects nothing in the multi-select.
- Assert `dev-buddy` is pre-checked.
- Assert `ado` is unchecked.
- With `--no-builtin`: no built-ins installed; the multi-select doesn't appear.

### 14.4 End-to-end

- Run `clawdevbox init` in a tmp project against a fake `copilot` binary.
- Assert the recorded `copilot plugin marketplace add <path>` and `copilot plugin install clawdevbox-mcp@clawdevbox` calls land in the fake CLI's call log.
- Assert `<globalDir>/plugins/clawdevbox-mcp/.mcp.json` exists with the expected content.

## 15. Phases

1. **Skeleton** — `.claude-plugin/marketplace.json` + `plugins/` directory layout. Move `samples/plugins/ado` → `plugins/ado` via `git mv`.
2. **Built-in plugins** — Create `plugins/clawdevbox-mcp/` and `plugins/dev-buddy/` (with the skill content extracted from `main-agent.ts`).
3. **Marketplace registration** — `resolveBuiltinMarketplaceSource` + `ensureBuiltinMarketplaceRegistered`; renamed file `builtin-marketplace.ts`.
4. **Init rewrite** — tier-driven step, `--no-builtin` flag, drop `BUILTIN_PLUGINS` machinery, drop `seedDevBuddySkill`, add cwd fallback in `cli/mcp.ts`.
5. **Build script** — produce `dist/marketplace/`.
6. **Tests + docs** — coverage as in §14; update `samples/README.md`, `docs/plugins.md`, `docs/agent-clis.md`.

Single subagent dispatch.

## 16. Out of scope

- HTTP variant of `clawdevbox-mcp`.
- Migrating renderers to a plugin.
- Migrating samples/recipes or samples/triggers to plugins.
- A `clawdevbox start` first-boot check that auto-installs missing built-ins (init-only for v1).
- `userConfig` install-time prompts (Claude supports them but Copilot's `plugin install` doesn't — uniform behavior wins).
- Removing `samples/` entirely. `samples/recipes/simple-prompt.yaml` and `samples/triggers/*` are still useful as standalone demos.
