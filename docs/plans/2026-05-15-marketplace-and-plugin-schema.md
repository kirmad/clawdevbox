# Plugin & Marketplace Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each phase = one subagent's scope. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace clawdevbox's `plugin.yaml` with Claude Code's `.claude-plugin/plugin.json`, add marketplace consumer (`.claude-plugin/marketplace.json` + Microsoft's `marketplace-config.json` + `agency.json` extensions), migrate all sample plugins.

**Architecture:** Single canonical manifest format (Claude Code's `.claude-plugin/plugin.json`). clawdevbox-specific capabilities go under a top-level `clawdevbox: {…}` key inside that manifest. Marketplace catalog is `.claude-plugin/marketplace.json` (primary) or `.github/plugin/marketplace.json` (fallback), with `marketplace-config.json` overlay and `agency.json` per-plugin filtering.

**Tech Stack:** TypeScript, node:test, `js-yaml` (still used for recipe content), JSON.

**Spec:** `docs/specs/2026-05-15-marketplace-and-plugin-schema-design.md`

**Baseline:** HEAD `aa1d3c1` on `main`. 285/285 tests passing. Pre-existing typecheck errors at `template-store.ts:155`, `tools/trigger.ts:658`, `tools/trigger.ts:778` are NOT yours.

---

## File structure

**New files:**
- `mcp-server/src/manifest/types.ts` — `PluginManifest`, `AgencyJson`, `MarketplaceJson`, `MarketplaceConfig` types.
- `mcp-server/src/manifest/load-plugin.ts` — load + auto-discover from `.claude-plugin/plugin.json`.
- `mcp-server/src/manifest/load-marketplace.ts` — read marketplace catalog + config + per-plugin agency.json.
- `mcp-server/src/cli/marketplace.ts` — `clawdevbox marketplace {add,list,update,remove}` subcommands.
- `mcp-server/tests/manifest-load.test.mjs` — manifest + auto-discovery.
- `mcp-server/tests/marketplace-load.test.mjs` — marketplace + config + agency.json.
- `mcp-server/tests/migrated-plugins.test.mjs` — every migrated plugin loads cleanly.

**Modified files:**
- `mcp-server/src/workspace.ts` — `PluginManifest` shape, plugin loader.
- `mcp-server/src/validators.ts` — new validators.
- `mcp-server/src/tools/plugin.ts` — install/read/update use new manifest.
- `mcp-server/src/tools/skill.ts` — write `skills/<id>/SKILL.md` directory.
- `mcp-server/src/cli/plugin-sources.ts` — discovery now finds `.claude-plugin/plugin.json` AND marketplace files.
- `mcp-server/src/cli/init.ts` — `--plugin` is marketplace-aware.
- `mcp-server/src/cli/index.ts` — wire `marketplace` subcommand.
- `mcp-server/src/agent-clis/load-plugin.ts` — read `clawdevbox.agent_clis[]` (was `provides.agent_clis[]`).
- `mcp-server/src/builtin-plugins.ts` — if any built-in catalog references the old shape.
- `mcp-server/tests/fixtures/cli-plugins/*/plugin.yaml` → `.claude-plugin/plugin.json`.
- `samples/plugins/ado/plugin.yaml` → `.claude-plugin/plugin.json` (+ restructure skills if any).
- `C:\git\clawdevbox-plugins\{cfv,dgrep,icm,metrics}/plugin.yaml` → `.claude-plugin/plugin.json`.
- `C:\git\agency-provider/plugin.yaml` → `.claude-plugin/plugin.json`.
- `docs/agent-clis.md`, `docs/plugins.md`, `docs/tools/plugin.md`, `docs/MCP-TOOLS-REFERENCE.md`.

---

## Phase 1 — Types + validators

### Task 1.1: New manifest types

**Files:** `mcp-server/src/manifest/types.ts` (new)

Author the type module with `PluginManifest`, `PluginAuthor`, `PluginStatus`, `ClawdevboxExtensions`, `AgencyJson`, `MarketplaceJson`, `MarketplaceConfig`, `MarketplacePluginEntry`. Match the spec §3 and §4 exactly.

The `clawdevbox` extension subkey reuses existing types from `workspace.ts` (`PluginTriggerType`, `PluginProvideEntry`) and `agent-clis/types.ts` (`PluginAgentCliEntry`).

**Commit:** `feat(manifest): canonical plugin + marketplace types`

### Task 1.2: Validators

**Files:** `mcp-server/src/validators.ts`, `mcp-server/tests/validators.test.mjs`

Add:
- `validatePluginManifest(parsed: unknown): ValidationError[]` — replaces the existing `plugin.yaml` validator.
- `validateAgencyJson(parsed: unknown): ValidationError[]`.
- `validateMarketplaceJson(parsed: unknown): ValidationError[]`.
- `validateMarketplaceConfig(parsed: unknown): ValidationError[]`.

Reject `..` in path fields. Validate the `clawdevbox` block by delegating to existing sub-validators (`validatePluginAgentCliEntry`, `validateTriggerTypeEntry`).

Add ~12 new tests covering each validator's branches.

**Commit:** `feat(validators): plugin manifest + marketplace + agency.json`

---

## Phase 2 — Manifest loader

### Task 2.1: `manifest/load-plugin.ts`

**Files:** `mcp-server/src/manifest/load-plugin.ts` (new), `mcp-server/tests/manifest-load.test.mjs` (new)

Export:
```ts
loadPluginFromDir(pluginDir: string): Promise<{ manifest: PluginManifest; agencyJson?: AgencyJson; capabilities: ResolvedCapabilities }>
```

Where `ResolvedCapabilities` is:
```ts
interface ResolvedCapabilities {
  skills: Array<{ id: string; dir: string }>;
  agents: Array<{ id: string; file: string }>;
  commands: Array<{ id: string; file: string }>;
  mcpServers: Record<string, McpServerConfig>;     // matches Claude shape
  hooks?: object;                                   // loaded but unused
  recipes: Array<{ id: string; file: string }>;
  tools: Array<{ id: string; file: string; runtime?: string }>;
  triggerTypes: PluginTriggerType[];
  agentClis: PluginAgentCliEntry[];
  status?: PluginStatus;
}
```

Algorithm:
1. Read `<pluginDir>/.claude-plugin/plugin.json`. Throw `MISSING_MANIFEST` if absent. Parse JSON; throw `INVALID_MANIFEST_JSON` on parse error.
2. Validate via `validatePluginManifest`. Throw `INVALID_MANIFEST_SHAPE` on errors.
3. Read sibling `<pluginDir>/agency.json` if present. Validate via `validateAgencyJson` (warn-only on failure).
4. Resolve Claude paths:
   - `manifest.skills` → directory or list. If absent, auto-discover `<pluginDir>/skills/` (directories named `<id>` with a `SKILL.md` inside).
   - `manifest.agents` → file or list. If absent, auto-discover `<pluginDir>/agents/*.agent.md`.
   - `manifest.commands` → file or list. If absent, auto-discover `<pluginDir>/commands/*.md`.
   - `manifest.mcpServers` → path to JSON or inline. If absent, auto-discover `<pluginDir>/.mcp.json`. Parse the JSON; expect `{ mcpServers: {...} }` shape.
   - `manifest.hooks` → load object, don't fire events.
5. Resolve clawdevbox extensions: read `manifest.clawdevbox?.{recipes, tools, trigger_types, agent_clis}` as-is.
6. Return the bundle.

Skill validation: for each auto-discovered skill, read `SKILL.md` frontmatter (use the existing skill validator) and check `frontmatter.name === <directory-name>`. If mismatch, `SKILL_NAME_MISMATCH` is added to the capabilities' load errors (capability still ignored, plugin still loads).

Add comprehensive tests with tmp directories simulating each case: explicit paths, auto-discovery, missing manifest, malformed JSON, validation failure, name-mismatch.

**Commit:** `feat(manifest): plugin loader with Claude auto-discovery`

### Task 2.2: Wire loader into `workspace.ts`

**Files:** `mcp-server/src/workspace.ts`

Find the existing plugin discovery — likely a loop that reads `<globalDir>/plugins/<id>/plugin.yaml` for each subdirectory. Replace with calls to `loadPluginFromDir`. Drop `js-yaml` imports for plugin.yaml parsing (still needed for recipe yaml content).

Update `PluginEntry` interface to use the new `PluginManifest` shape. `PluginEntry.id` becomes `plugin.manifest.name` (rename `id` field if needed; existing code that references `entry.id` should switch to `entry.manifest.name` OR keep `id` as a synonym).

Update `reloadTypeRegistries` (and its trigger-type-walking helpers) to read from `manifest.clawdevbox.trigger_types` and `manifest.clawdevbox.agent_clis` instead of `manifest.provides.*`.

Run `npm test` after this commit. Expect failures from sample plugin tests that still use `plugin.yaml` — those are fixed in Phase 4. Mark expected failures explicitly, OR migrate the test fixtures first to avoid red builds (see Phase 4).

**Phasing tip:** Bundle Task 2.2 with Phase 4's fixture migration in one PR to avoid a red baseline mid-phase. The subagent dispatching this phase should do `git stash`/`git checkout` carefully.

**Commit:** `refactor(workspace): use Claude-format manifest loader`

### Task 2.3: Update agent-clis loader

**Files:** `mcp-server/src/agent-clis/load-plugin.ts`

Change the source of provider entries from `plugin.manifest.provides.agent_clis` to `plugin.manifest.clawdevbox?.agent_clis ?? []`. Adjust import paths.

Tests in `tests/agent-clis.test.mjs` may need fixture updates — coordinate with Phase 4.

**Commit:** `refactor(agent-clis): read providers from clawdevbox.agent_clis`

---

## Phase 3 — Skill writer + auto-discovery polish

### Task 3.1: Migrate `skill.upsert` to write directory shape

**Files:** `mcp-server/src/tools/skill.ts`

Find the `skill.upsert` handler. Currently writes `<scope>/skills/<id>.md`. Update to write `<scope>/skills/<id>/SKILL.md`. Create the directory atomically (mkdir then writeFileAtomic for SKILL.md).

If a legacy `<scope>/skills/<id>.md` exists, delete it after the new write to avoid duplicate-registration confusion. (We do NOT auto-migrate other people's plugins — only writes through this tool flip.)

Update `skill.delete` to remove the directory.

Update `skill.read` to read `SKILL.md` inside the directory.

Update skill discovery in `workspace.ts` to only register `<scope>/skills/<id>/SKILL.md`. Drop the flat-file scan.

Tests in `tests/smoke.test.mjs` and `tests/external-plugins.test.mjs` that touch skills need updating.

**Commit:** `feat(skill): write skills/<id>/SKILL.md directory shape`

### Task 3.2: Auto-discovery integration tests

**Files:** `mcp-server/tests/manifest-load.test.mjs`

Create a temp plugin directory with:
- `.claude-plugin/plugin.json` containing ONLY `{name, version}` — everything else relies on auto-discovery.
- `skills/foo/SKILL.md` with `name: foo` frontmatter.
- `agents/bar.agent.md` with `name: bar` frontmatter.
- `commands/baz.md` with frontmatter `description`.
- `.mcp.json` with one server.

Load via `loadPluginFromDir`. Assert all four capabilities materialized.

**Commit:** `test(manifest): auto-discovery picks up Claude conventions`

---

## Phase 4 — Sample plugin migrations

This phase touches 4 directories: in-repo, two external repos, and test fixtures.

### Task 4.1: Migrate in-repo `samples/plugins/ado/`

**Files:**
- Delete: `samples/plugins/ado/plugin.yaml`
- Create: `samples/plugins/ado/.claude-plugin/plugin.json`
- If skills exist at `samples/plugins/ado/skills/*.md` (flat), restructure to `samples/plugins/ado/skills/<id>/SKILL.md`.

Map the old YAML fields to the new JSON shape:
- `id: ado` → `"name": "ado"`
- `name: ...` → drop (use `description` for display name if needed)
- `version`, `description`, `author`, `license` → same
- `provides.skills: [...]` → either remove (rely on auto-discovery once skills are restructured) OR list as `"skills": "./skills"`
- `provides.recipes` → `clawdevbox.recipes`
- `provides.trigger_types` → `clawdevbox.trigger_types`
- `provides.tools` → `clawdevbox.tools`
- `provides.mcp_servers` → if present, materialize as `.mcp.json` at plugin root
- `requires.clawdevbox_version` → `requires.clawdevbox_version` (preserved)

Run `npm test` — any tests referencing the ado sample should now load.

**Commit:** `chore(samples): migrate ado plugin to .claude-plugin/plugin.json`

### Task 4.2: Migrate `mcp-server/tests/fixtures/cli-plugins/*`

**Files:**
- `tests/fixtures/cli-plugins/test-cli/plugin.yaml` → `.claude-plugin/plugin.json`
- `tests/fixtures/cli-plugins/bad-shape/plugin.yaml` → `.claude-plugin/plugin.json`
- `tests/fixtures/cli-plugins/traversal/plugin.yaml` → `.claude-plugin/plugin.json`
- `tests/fixtures/cli-plugins/conflict-copilot/plugin.yaml` → `.claude-plugin/plugin.json`
- `tests/fixtures/cli-plugins/twin-a/plugin.yaml` → `.claude-plugin/plugin.json`
- `tests/fixtures/cli-plugins/twin-b/plugin.yaml` → `.claude-plugin/plugin.json`

Each gets a single `{name, version, description, clawdevbox: { agent_clis: [{...}] } }` JSON file in `.claude-plugin/plugin.json`.

Run `npm test` — agent-clis tests should pass.

**Commit:** `test(fixtures): migrate cli-plugin fixtures to .claude-plugin/plugin.json`

### Task 4.3: Migrate `C:\git\clawdevbox-plugins\{cfv,dgrep,icm,metrics}`

**Files (per plugin):**
- Delete: `<plugin>/plugin.yaml`
- Create: `<plugin>/.claude-plugin/plugin.json`
- If skill exists at `<plugin>/skills/<id>.md` (flat), restructure to `<plugin>/skills/<id>/SKILL.md`. The frontmatter's `name:` field must match the new directory id.

For each of the 4 plugins, the migration is mechanical translation of the YAML to JSON with the clawdevbox extension block.

**This work happens in `C:\git\clawdevbox-plugins` (a separate repo from `C:\git\clawdevbox`).** Commit each plugin separately:

```bash
cd C:\git\clawdevbox-plugins
git commit -m "chore(cfv): migrate to .claude-plugin/plugin.json"
git commit -m "chore(dgrep): migrate to .claude-plugin/plugin.json"
git commit -m "chore(icm): migrate to .claude-plugin/plugin.json"
git commit -m "chore(metrics): migrate to .claude-plugin/plugin.json"
```

After the per-plugin commits, OPTIONALLY add a top-level `.claude-plugin/marketplace.json` listing all 4 plugins for future `clawdevbox marketplace add C:\git\clawdevbox-plugins` testing. This is optional — keep the commit small if marketplace.json adds friction.

### Task 4.4: Migrate `C:\git\agency-provider`

**Files:**
- Delete: `C:\git\agency-provider\plugin.yaml`
- Create: `C:\git\agency-provider\.claude-plugin\plugin.json`

The agency plugin has a single `clawdevbox.agent_clis` entry. Commit in the agency-provider repo:

```bash
cd C:\git\agency-provider
git commit -m "chore: migrate to .claude-plugin/plugin.json"
```

---

## Phase 5 — Marketplace consumer

### Task 5.1: `manifest/load-marketplace.ts`

**Files:** `mcp-server/src/manifest/load-marketplace.ts` (new), `mcp-server/tests/marketplace-load.test.mjs` (new)

Export:
```ts
loadMarketplace(root: string): Promise<{
  marketplaceId: string;
  metadata: { name: string; description?: string; version?: string; owner?: {...} };
  plugins: Array<MarketplacePluginEntry>;
  source: 'claude' | 'github-copilot' | 'single-plugin';
}>
```

Algorithm per spec §4.1:
1. If `<root>/.claude-plugin/marketplace.json` exists, parse + validate. Set `source = 'claude'`.
2. Else if `<root>/.github/plugin/marketplace.json` exists, parse + validate. Set `source = 'github-copilot'`.
3. Else if `<root>/.claude-plugin/plugin.json` exists, treat as single-plugin install. Return a 1-element plugins array. Set `source = 'single-plugin'`.
4. Else throw `NOT_A_MARKETPLACE`.

If `<root>/marketplace-config.json` exists, deep-merge `shared.*` over the marketplace.json top-level, then deep-merge `clawdevbox?` over that.

Tests with tmp dirs simulating each case.

**Commit:** `feat(marketplace): consumer for Claude + GitHub-Copilot + marketplace-config layouts`

### Task 5.2: Plugin install with `agency.json` filter

**Files:** `mcp-server/src/tools/plugin.ts`, `mcp-server/src/cli/plugin-sources.ts`

Update plugin install path to:
1. Resolve the source (git clone or local junction).
2. For each plugin in the marketplace catalog (or single-plugin), check `<plugin-root>/agency.json`. Apply the engine filter per spec §4.4.
3. Install only the engine-compatible ones.

The engine identity is `cfg.defaultAgentCli ?? 'copilot'` plus `'clawdevbox'` plus `'*'`. A plugin matches if its `engines` array contains any of those (or is missing entirely).

Add tests with tmp fixtures: plugins with `agency.json` listing various engine combinations.

**Commit:** `feat(plugin): honor agency.json engines filter on install`

### Task 5.3: Marketplace CLI subcommand

**Files:** `mcp-server/src/cli/marketplace.ts` (new), `mcp-server/src/cli/index.ts`

Implement `clawdevbox marketplace {add,list,update,remove}`:

- `add <source>` — clone git URL or junction local path into `<globalDir>/marketplaces/<id>/`. Read marketplace.json, persist metadata at `<globalDir>/marketplaces/<id>.json`. The marketplace's `name` field is the `<id>`.
- `list` — read `<globalDir>/marketplaces/*.json` and print a table.
- `update [<id>]` — `git fetch` + `git reset --hard origin/HEAD`. If `<id>` omitted, update all.
- `remove <id>` — delete the marketplace folder + metadata file. Does NOT uninstall plugins that came from it (they have their own install records).

Add to `cli/index.ts` dispatcher.

Tests in `mcp-server/tests/marketplace-load.test.mjs` — exercise add/list/remove against local fixtures.

**Commit:** `feat(cli): clawdevbox marketplace add/list/update/remove`

### Task 5.4: `init --plugin` marketplace awareness

**Files:** `mcp-server/src/cli/init.ts`, `mcp-server/src/cli/plugin-sources.ts`

In the existing `--plugin <source>` loop:
- Resolve the source (git clone or local path).
- Run `loadMarketplace(resolvedDir)`.
- If `source === 'single-plugin'`, install directly (current behavior).
- If `source ∈ {'claude', 'github-copilot'}`, show a multi-select prompt of plugin names + descriptions, install the chosen ones. Apply `agency.json` filter before prompting (only show compatible plugins).

Tests can stub the prompt as in the Phase 6 init-chooser pattern.

**Commit:** `feat(init): --plugin understands marketplace catalogs`

---

## Phase 6 — Docs

### Task 6.1: Update docs

**Files:** `docs/plugins.md`, `docs/agent-clis.md`, `docs/tools/plugin.md`, `docs/MCP-TOOLS-REFERENCE.md`

- `docs/plugins.md`: full rewrite to document `.claude-plugin/plugin.json`, the `clawdevbox` extension block, auto-discovery rules, and the migration path from old `plugin.yaml`.
- `docs/agent-clis.md`: the plugin-author section now references the JSON manifest. Update the YAML example to JSON.
- `docs/tools/plugin.md`: the `plugin.install` tool's source-resolution rules updated to mention marketplace catalogs.
- Add a new section to `docs/plugins.md` documenting Microsoft extensions (`agency.json`, `marketplace-config.json`, `status` field).
- Regenerate `docs/MCP-TOOLS-REFERENCE.md`.

**Commit:** `docs: plugin + marketplace schema alignment`

---

## Phase 7 — End-to-end verification

### Task 7.1: Migrated-plugin smoke

**Files:** `mcp-server/tests/migrated-plugins.test.mjs` (new)

Programmatic test that:
1. Clones (or junctions) each of the migrated plugins from `C:\git\clawdevbox-plugins\{cfv,dgrep,icm,metrics}` and `C:\git\agency-provider` into a tmp `<globalDir>/plugins/`.
2. Calls `loadWorkspaceFromEnv` against the tmp workspace.
3. Asserts `ws.plugins` contains all 5 entries.
4. Asserts the agency-provider plugin registered the `agency` agent-CLI provider.
5. Asserts the cfv plugin registered its skill, recipes, and tools.
6. Asserts the icm/dgrep/metrics plugins registered their trigger types.

Skip the test gracefully if `C:\git\clawdevbox-plugins` or `C:\git\agency-provider` aren't present (different machines may not have them).

**Commit:** `test(migrated): real sample plugins load via Claude manifest`

### Task 7.2: Final clean run

- `npm run typecheck` — only the 3 pre-existing errors.
- `npm run build` — clean.
- `npm test` — all green.
- `grep -rn "plugin.yaml" mcp-server/src --include="*.ts"` — empty (no remaining references in code).
- Test live with a real service start + plugin install for one of the migrated samples.

---

## Rules for executing subagents

- **NEVER use Haiku.** Opus 4.7 1M for every subagent.
- `npm test` and `npm run typecheck` after EVERY commit. Don't proceed if either regresses.
- Co-authored-by trailer on every commit: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- The clawdevbox kernel changes (Phases 1, 2, 3, 5, 6, 7) happen in `C:\git\clawdevbox`.
- Sample plugin migrations (Phase 4 Tasks 4.1, 4.2) happen in `C:\git\clawdevbox` too (in-repo samples + test fixtures).
- Phase 4 Tasks 4.3 and 4.4 happen in OTHER repos (`C:\git\clawdevbox-plugins` and `C:\git\agency-provider`). The subagent must `cd` to those paths.
- Pre-existing typecheck errors stay (`template-store.ts:155`, `tools/trigger.ts:658`, `tools/trigger.ts:778`). No new errors.

## Phasing order for subagent dispatch

1. **Phase 1** — types + validators (foundation; doesn't break tests).
2. **Phase 2 + Phase 4.2** combined — loader rewrite + fixture migration in same commit-stream (so tests stay green).
3. **Phase 3** — skill writer migration.
4. **Phase 4.1** — in-repo ado sample migration.
5. **Phase 4.3** — external clawdevbox-plugins migration (different repo).
6. **Phase 4.4** — agency-provider migration (different repo).
7. **Phase 5** — marketplace consumer + CLI + init integration.
8. **Phase 6** — docs.
9. **Phase 7** — end-to-end smoke.
