# Plugin & Marketplace Schema Alignment with Claude Code

**Status:** Draft (design)
**Date:** 2026-05-15
**Scope:** Adopt Claude Code's plugin + marketplace JSON schemas as canonical for clawdevbox. Stop reading `plugin.yaml`. Auto-discover Claude conventions (`skills/<name>/SKILL.md`, `agents/<name>.agent.md`, `commands/<name>.md`, `.mcp.json`). Honor Microsoft's `agency.json`, `marketplace-config.json`, and `status` extensions found in `C:\git\ado-private`. Migrate all in-tree sample plugins, the `C:\git\clawdevbox-plugins` external samples, and the `C:\git\agency-provider` plugin.

## 1. Problem

clawdevbox's plugin format diverges from the de-facto industry standard (Claude Code's `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`). The 40+ plugins in Microsoft's `ado-private` repo already use Claude's format; clawdevbox can't load them without authors maintaining a parallel `plugin.yaml`. clawdevbox also misses Claude's auto-discovery conventions (skills as directories, agents, commands), so plugin authors can't reuse Claude-targeted plugins as-is.

Microsoft extends Claude's schema in three ways that we want to support:

1. A `.github/plugin/marketplace.json` mirror auto-generated alongside `.claude-plugin/marketplace.json`.
2. A repo-root `marketplace-config.json` with `shared` + per-engine slots (`claude`, `copilot`, …) for divergent metadata.
3. A per-plugin `agency.json` sidecar with `engines` filtering and `category` metadata. Plus a `status` field on `plugin.json` for experimental/stability hints.

## 2. Goals & Non-Goals

### Goals

- `.claude-plugin/plugin.json` is the **only** plugin manifest format clawdevbox reads. `plugin.yaml` is removed.
- Auto-discover skills/agents/commands/MCP from the Claude conventions when the manifest doesn't list explicit paths.
- clawdevbox-specific extensions (recipes, tools, trigger_types, agent_clis) live under a top-level `clawdevbox: {…}` key inside `.claude-plugin/plugin.json`. Claude Code ignores unknown keys; one manifest serves both.
- Read `.claude-plugin/marketplace.json` as the marketplace catalog. Fall back to `.github/plugin/marketplace.json` if absent.
- Honor `marketplace-config.json` at the repo root: merge `shared.*` and an optional `clawdevbox: {…}` slot.
- Honor `agency.json` per plugin: `engines` filter + `category`.
- Surface plugin.json `status` field in listings and the SPA.
- Migrate the sample plugins and the agency plugin to the new format.

### Non-Goals

- **Claude lifecycle hooks runtime.** `hooks/hooks.json` may declare `PostToolUse`, `PreToolUse`, etc. — clawdevbox loads the file but doesn't fire those events. The kernel only fires its own event topics today (`triggers`, `fires`, `recipes`, …). A future iteration may map Claude hook events to clawdevbox kernel events.
- **`userConfig` prompts at install.** Useful but punted.
- **LSP servers, themes, monitors, output styles.** Loaded into the manifest object but not surfaced as UI features.
- **Marketplace file generation.** clawdevbox is a CONSUMER. Microsoft's `sync-marketplace.py` (or any author's equivalent) remains the authority for producing the files.
- **Migration of legacy `<workspace>/.clawdevbox/plugins/`.** Already deprecated by an earlier change. The existing one-shot warning stays.
- **A `status: experimental` enforcement / blocking rule.** Surface only; the user decides whether to install.

## 3. The new plugin manifest

`<plugin>/.claude-plugin/plugin.json` (JSON, NOT yaml):

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "cfv",
  "version": "1.0.0",
  "description": "Fetch + analyze Teams call diagnostics.",
  "author": { "name": "Clawdevbox team", "email": "ops@example.com", "url": "..." },
  "homepage": "https://...",
  "repository": "https://...",
  "license": "MIT",
  "keywords": ["teams", "call-flow"],

  "skills": "./skills",
  "agents": "./agents",
  "commands": "./commands",
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/hooks.json",

  "status": {
    "testedWith": "Teams call-flow-viewer 2024.5",
    "experimental": false,
    "notes": "Requires az login to obtain the CFV audience token."
  },

  "clawdevbox": {
    "recipes": [{ "id": "analyze-call", "file": "recipes/analyze-call.yaml" }],
    "tools":   [{ "id": "cfv.fetch_call", "file": "tools/fetch_call.ts", "runtime": "tsx" }],
    "trigger_types": [{ "id": "cfv.audit-watcher", "file": "triggers/audit.ts",
                         "default_cron": "*/10 * * * *",
                         "binds_callback_to_recipe": "analyze-call",
                         "identity_param": "callId",
                         "parameters": [] }],
    "agent_clis": [{ "id": "agency", "module": "dist/agency.js",
                     "display_name": "Microsoft Agency",
                     "description": "..." }]
  },

  "requires": {
    "clawdevbox_version": ">=1.0.0",
    "env": []
  }
}
```

### 3.1 Required fields

- `name`: kebab-case, `/^[a-z][a-z0-9-]*$/`. Replaces the old `id` field.

### 3.2 Optional Claude fields we recognize and use

| Field | Behaviour |
|---|---|
| `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords` | Pass-through metadata. |
| `skills` | Path or array of paths. Default: auto-discover `skills/`. |
| `agents` | Path or array. Default: auto-discover `agents/`. |
| `commands` | Path or array. Default: auto-discover `commands/`. |
| `mcpServers` | Path to JSON config OR inline object. Default: auto-discover `.mcp.json`. |
| `hooks` | Path or inline. Loaded into the manifest; **not fired** by clawdevbox (Non-Goal). |
| `dependencies` | Array. Validated for shape; **resolution not implemented in v1** (Non-Goal). |

### 3.3 Optional Claude fields we recognize but don't surface

`lspServers`, `outputStyles`, `experimental.themes`, `experimental.monitors`, `userConfig`, `channels`. Loaded into the manifest object so future versions can surface them. Today: no behavior.

### 3.4 Microsoft `status` field

```ts
status?: {
  testedWith: string;        // required when status is present
  experimental?: boolean;
  notes?: string;
};
```

Surfaced in `clawdevbox plugin list`, the marketplace SPA listing, and `GET /api/plugins/marketplace`. `experimental: true` renders a warning badge but does not block installation.

### 3.5 clawdevbox-specific extensions

The `clawdevbox` top-level key carries every capability that's not in Claude's vocabulary:

```ts
clawdevbox?: {
  recipes?: Array<{ id: string; file: string }>;
  tools?:   Array<{ id: string; file: string; runtime?: 'node'|'tsx'|'python'|'bash' }>;
  trigger_types?: PluginTriggerType[];          // unchanged from current shape
  agent_clis?:    PluginAgentCliEntry[];        // unchanged
};
```

Validator (§7) checks each subkey independently. A plugin can mix Claude-only capabilities with clawdevbox extensions; `provides: agent_clis` is removed from the top level (it lives inside `clawdevbox.agent_clis`).

### 3.6 Auto-discovery rules

If a path field is absent, clawdevbox scans the convention-named directory at the plugin root and registers each entry as if listed explicitly. Specifically:

| Convention | What clawdevbox does |
|---|---|
| `skills/<id>/SKILL.md` (with YAML frontmatter `name`, `description`) | Register skill `<id>`. SKILL.md body is the skill prompt. Supporting files at `skills/<id>/*` are part of the skill bundle. |
| `agents/<id>.agent.md` (YAML frontmatter `name`, `description`, etc.) | Register subagent `<id>`. Body is the agent system prompt. |
| `commands/<id>.md` (YAML frontmatter `description`, `argument-hint`, …) | Register slash-command `<id>`. Body is the command prompt template. |
| `.mcp.json` at plugin root (`{ "mcpServers": {…} }`) | Register each entry as an MCP server. |

Auto-discovery is skipped for any field that the manifest declares explicitly. If `skills: "./custom/path"` is set, only that path is scanned (no fallback to `skills/`).

### 3.7 Skill file shape: directory, not flat file

clawdevbox today stores skills as `skills/<id>.md` (flat). Claude stores `skills/<id>/SKILL.md` (directory + supporting files). We adopt Claude's convention:

- `skill.upsert` MCP tool writes `<scope>/skills/<id>/SKILL.md`. The directory is created if needed.
- The legacy flat-file shape `skills/<id>.md` is **no longer read**. Existing sample plugins are migrated as part of this work.

The skill registry's keying remains `<id>` (the directory name). SKILL.md frontmatter must declare matching `name: <id>` — a validator enforces this.

## 4. Marketplace consumer

### 4.1 Files clawdevbox reads (in order of preference)

For a marketplace source (git URL or local directory):

1. **`<root>/.claude-plugin/marketplace.json`** — primary.
2. **`<root>/.github/plugin/marketplace.json`** — fallback if (1) is absent.
3. **`<root>/marketplace-config.json`** — meta-config that overrides metadata in (1)/(2). Always merged on top when present.
4. If neither (1) nor (2) exists but `<root>/.claude-plugin/plugin.json` does, treat the whole source as a single-plugin install (no catalog).

### 4.2 `.claude-plugin/marketplace.json` schema (standard Claude)

```ts
{
  name: string;                       // required
  owner: { name: string; email?: string };
  description?: string;
  version?: string;
  metadata?: {
    description?: string;
    version?: string;
    pluginRoot?: string;              // base dir for relative plugin source paths
  };
  plugins: Array<{
    name: string;                     // required
    source: string | {                // relative path | github source | git+url
      source: 'github' | 'git' | 'path';
      repo?: string;
      url?: string;
      path?: string;
      ref?: string;
    };
    version?: string;
    description?: string;
    author?: { name: string; email?: string };
    keywords?: string[];
    category?: string;
    strict?: boolean;
    tags?: string[];
    // Plus any plugin.json field — these become OVERRIDES for the manifest values.
  }>;
  allowCrossMarketplaceDependenciesOn?: string[];
}
```

clawdevbox preserves `category`, `strict`, `tags` (and any plugin.json field carried at the marketplace entry level) when resolving an install.

### 4.3 `marketplace-config.json` (Microsoft extension)

```ts
{
  shared: {
    name: string;
    metadata?: { description?: string; version?: string };
    owner?: { name: string; email?: string };
  };
  claude?: object;                    // engine-specific overrides
  copilot?: object;
  clawdevbox?: object;                // NEW — clawdevbox claims this slot
}
```

When clawdevbox loads a marketplace and a `marketplace-config.json` exists:
1. Start with the marketplace.json's top-level (`name`, `owner`, `metadata`).
2. Deep-merge `shared.{name, metadata, owner}` on top.
3. If `clawdevbox` slot exists, deep-merge it on top of (2).

Final values feed the catalog's top-level metadata in clawdevbox's marketplace store. Plugin entries themselves (`plugins[]`) are NOT overridden by `marketplace-config.json` — they come from the marketplace.json file.

### 4.4 `agency.json` per plugin (Microsoft extension)

`<plugin-root>/agency.json`:

```ts
{
  engines?: string[];     // ["claude", "copilot", "clawdevbox", "*"]
  category?: string;
}
```

Read when resolving a plugin install. Effects:

- **`engines` filter**: clawdevbox identifies as `"copilot"` if `cfg.defaultAgentCli` resolves to copilot, `"claude"` if claude, plus `"clawdevbox"` always. The plugin is included only if `engines` contains `"*"`, the current CLI identity, OR `"clawdevbox"`. Missing `agency.json` ⇒ no filter (all plugins ship). Empty `engines: []` ⇒ skip everywhere.
- **`category`** is copied to the resolved plugin entry's `category` field if the marketplace entry didn't already set one. Marketplace entry wins.

clawdevbox does NOT INTRODUCE a new sidecar; it consumes the established `agency.json` as-is. Authors who don't care about the agency runtime simply omit the file (or use `engines: ["*"]`).

### 4.5 Engine identity

clawdevbox's engine ids, in order of resolution priority:
1. The id of the configured agent-CLI provider (e.g. `"copilot"`, `"claude"`, `"agency"`).
2. The literal `"clawdevbox"`.
3. `"*"` (universal).

A plugin with `engines: ["copilot"]` ships to a clawdevbox install configured to use the copilot provider. A plugin with `engines: ["clawdevbox"]` ships to all clawdevbox installs regardless of provider.

### 4.6 Marketplace CLI

```
clawdevbox marketplace add <source>     # add a marketplace from git URL or local path
clawdevbox marketplace list             # list known marketplaces
clawdevbox marketplace update [<id>]    # git pull
clawdevbox marketplace remove <id>      # forget the marketplace
clawdevbox plugin install <name>@<marketplace-id>
clawdevbox plugin install <name>        # uses default marketplace if exactly one
```

The existing `clawdevbox init --plugin <source>` flow gains marketplace awareness: if `<source>` resolves to a marketplace catalog (i.e. step 4.1 finds (1) or (2)), the user is prompted to multi-select plugins to install. If `<source>` is a single plugin (step 4.1 (4)), install it directly.

Marketplace metadata is persisted at `<globalDir>/marketplaces/<id>.json` (one file per marketplace). The git clone lives at `<globalDir>/marketplaces/<id>/` next to the metadata.

## 5. clawdevbox installation flow

When a plugin is installed (from any source):

1. Resolve the manifest at `<plugin-root>/.claude-plugin/plugin.json`. If absent, error `MISSING_MANIFEST`.
2. Validate per §7.
3. Read sibling `agency.json` if present. Apply `engines` filter — if mismatch, error `ENGINE_MISMATCH` (or skip silently in marketplace bulk-install).
4. Load capabilities:
   - Claude fields (skills, agents, commands, MCP, hooks) via manifest paths OR auto-discovery (§3.6).
   - clawdevbox extensions (recipes, tools, trigger_types, agent_clis) via the `clawdevbox` key.
5. Install into `<globalDir>/plugins/<name>/` per existing rules (git clone retains `.git`; local folder gets a junction).
6. Persist an install record at `<globalDir>/plugins/<name>.install.json` (existing pattern).
7. Reload the workspace registry — providers, trigger types, skills, recipes all become visible.

## 6. Migration matrix

| Source | Files affected | Migration |
|---|---|---|
| `C:\git\clawdevbox\mcp-server\src\workspace.ts` | `PluginManifest` type | Replace with new shape (Claude + `clawdevbox` key). Drop `id`/`provides`. |
| `mcp-server/src/validators.ts` | Plugin validator | Rewrite to validate Claude-shape JSON + `clawdevbox` extension + `agency.json`. |
| `mcp-server/src/tools/plugin.ts` | `plugin.install`, `plugin.read`, etc. | Read `.claude-plugin/plugin.json`; marketplace-aware install. |
| `mcp-server/src/builtin-plugins.ts` | Built-in catalog | Update to new shape. |
| `mcp-server/src/cli/plugin-sources.ts` | Plugin source resolution | Look for `.claude-plugin/plugin.json` or marketplace files. |
| `mcp-server/src/cli/init.ts` | `--plugin` flag handling | Marketplace-aware (single vs catalog). |
| `mcp-server/src/cli/marketplace.ts` | NEW subcommand | `add`/`list`/`update`/`remove`. |
| `mcp-server/src/tools/skill.ts` | `skill.upsert` | Write `skills/<id>/SKILL.md` (directory). |
| `mcp-server/src/agent-clis/load-plugin.ts` | Provider loader | Read `clawdevbox.agent_clis[]` (currently reads `provides.agent_clis[]`). |
| `mcp-server/src/agent-clis/types.ts` | `PluginAgentCliEntry` | Move from `workspace.ts` if needed. |
| `samples/plugins/ado/plugin.yaml` | In-repo sample | Migrate to `.claude-plugin/plugin.json`. |
| `C:\git\clawdevbox-plugins\{cfv,dgrep,icm,metrics}/plugin.yaml` | External samples | Migrate to `.claude-plugin/plugin.json`. |
| `C:\git\agency-provider/plugin.yaml` | Agency plugin | Migrate to `.claude-plugin/plugin.json`. |
| `mcp-server/tests/fixtures/cli-plugins/*` | Loader test fixtures | Migrate to `.claude-plugin/plugin.json`. |
| `docs/agent-clis.md`, `docs/plugins.md` | Docs | Update to reference Claude schema + extensions. |
| `docs/MCP-TOOLS-REFERENCE.md` | Auto-gen | Regenerate. |

## 7. Validator

A single `validatePluginManifest(parsed: unknown): ValidationError[]` function checks:

- Top-level required fields (`name`).
- Optional Claude fields' types.
- `status` shape (if present): `testedWith: string` required; `experimental?: boolean`; `notes?: string`.
- `clawdevbox` block: recursively validates each sub-array.
- `clawdevbox.agent_clis[]`: same shape as today.
- Path fields are relative + no `..`.
- For auto-discovered conventions, the validator is forgiving — it doesn't fail if `skills/` is missing.

A separate `validateAgencyJson(parsed: unknown)` validates `agency.json`:
- `engines?: string[]` — each entry matches `/^[a-z][a-z0-9*-]*$/` or is `"*"`.
- `category?: string` — non-empty.

A `validateMarketplaceJson(parsed: unknown)` validates the marketplace catalog:
- `name`, `owner.name` required.
- `plugins[]` each has `name` + `source` (string or object).

A `validateMarketplaceConfig(parsed: unknown)` validates `marketplace-config.json`:
- `shared.name` required.
- `shared.owner.name` optional.
- Engine slots (`claude`, `copilot`, `clawdevbox`) optional objects.

## 8. Failure modes

| Scenario | Behaviour |
|---|---|
| Plugin missing `.claude-plugin/plugin.json` | `MISSING_MANIFEST` at install. Existing `plugin.yaml` is NOT a fallback. |
| `plugin.json` malformed JSON | `INVALID_MANIFEST_JSON` with offending line. |
| `plugin.json` validation fails | `INVALID_MANIFEST_SHAPE` with the validator's error list. |
| `agency.json` malformed | Warn but proceed; treat as if `engines: ["*"]`. |
| Marketplace `.claude-plugin/marketplace.json` malformed | `INVALID_MARKETPLACE_JSON` — `marketplace add` fails. |
| `marketplace-config.json` malformed | Warn; ignore the file; fall back to marketplace.json metadata. |
| Plugin's `agency.json` engines excludes the configured CLI | Skip silently in bulk install; explicit install returns `ENGINE_MISMATCH`. |
| Two plugins with same name installed in different marketplaces | Last-installed wins on disk; surfaced as `PLUGIN_NAME_COLLISION` in `plugin list`. |
| Skill in `skills/<id>/SKILL.md` has frontmatter `name: <other>` | `SKILL_NAME_MISMATCH` at load; skill is not registered. |

## 9. Testing strategy

### 9.1 Unit tests

- `validatePluginManifest`: each branch (missing name, bad `clawdevbox.tools` entry, bad `status`, etc.).
- `validateAgencyJson`: engines whitelist, empty array, bad type.
- `validateMarketplaceJson`: required fields, plugin entry shapes.
- `validateMarketplaceConfig`: shared + per-engine slot.
- Manifest loader: explicit paths win, auto-discovery fills gaps.
- Marketplace consumer: marketplace.json + marketplace-config.json merge; engine slot precedence; fallback order.
- `agency.json` filter: each engine configuration produces the right include/exclude set.

### 9.2 Integration tests

- Install ado-private clone (single plugin → check capabilities loaded).
- Install via `clawdevbox marketplace add <local-dir>` with the existing `tests/fixtures/cli-plugins/test-cli` fixture migrated to Claude format.
- Round-trip: create skill via `skill.upsert`, assert directory + SKILL.md created with matching frontmatter.
- Backward compat: every clawdevbox-plugins sample (cfv, dgrep, icm, metrics) installs cleanly after migration.

## 10. Phasing (informs the plan, not the design)

1. **Type definitions + validator skeleton.** New `PluginManifest`/`AgencyJson`/`MarketplaceJson`/`MarketplaceConfig` types and stub validators. Existing `plugin.yaml`-reading code still works during this phase.
2. **Manifest loader rewrite.** Read `.claude-plugin/plugin.json`. Drop `plugin.yaml` reading. Update workspace registry.
3. **Auto-discovery.** Wire up the four conventions (skills, agents, commands, MCP).
4. **Skill writer migration.** Update `skill.upsert` and friends to write the directory shape.
5. **Marketplace consumer.** Read `marketplace.json` + `marketplace-config.json` + `agency.json`. Marketplace CLI (`marketplace add/list/update/remove`).
6. **`init --plugin` marketplace awareness.** Existing single-plugin behavior stays; marketplace catalogs prompt multi-select.
7. **Sample plugin migrations.** In-repo `samples/plugins/ado/`, external `C:\git\clawdevbox-plugins\*`, `C:\git\agency-provider`, and test fixtures.
8. **Docs + master ref regen.**
9. **End-to-end smoke.** Real install of a converted sample; assert all capabilities load.

## 11. Out of scope (future iterations)

- Claude hook event runtime.
- LSP server runtime integration.
- Themes / output styles UI.
- `userConfig` install-time prompts.
- Plugin dependency resolution.
- Plugin signing / strict-mode enforcement.
- A clawdevbox-side `sync-marketplace.py` equivalent for clawdevbox-only marketplaces (consumers can copy Microsoft's script if needed).
