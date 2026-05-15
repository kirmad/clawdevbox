# Plugin manifest reference

This file documents the **author-side** shape of a clawdevbox plugin —
the `.claude-plugin/plugin.json` manifest, what each field does, the
auto-discovery rules clawdevbox inherits from Claude Code, and the
Microsoft-extension sidecars (`agency.json`, `marketplace-config.json`,
`status`) that the kernel honors when present. For the **operator-side**
view (installing, updating, listing, enabling), see
[`docs/tools/plugin.md`](./tools/plugin.md). For the marketplace consumer
contract (catalogs, `clawdevbox marketplace add`), see
[§ Marketplace catalogs](#marketplace-catalogs) below.

## Overview

clawdevbox plugins use Claude Code's plugin manifest format verbatim:
`<plugin>/.claude-plugin/plugin.json`. A single manifest serves both
runtimes — Claude reads its own keys (`skills`, `agents`, `commands`,
`mcpServers`, `hooks`, …) and ignores everything else; clawdevbox reads
the same Claude keys plus a clawdevbox-specific extension under the
top-level `clawdevbox` key. Plugin authors target both runtimes with one
file.

```
<plugin>/
├── .claude-plugin/
│   └── plugin.json          ← canonical manifest (JSON, not YAML)
├── agency.json              ← optional Microsoft sidecar (engines + category)
├── skills/                  ← auto-discovered if not listed
│   └── <id>/SKILL.md        ← Claude skill directory layout
├── agents/<id>.agent.md     ← auto-discovered if not listed
├── commands/<id>.md         ← auto-discovered if not listed
├── .mcp.json                ← auto-discovered if not listed
├── hooks/hooks.json         ← loaded, not fired (see Non-goals)
├── recipes/                 ← clawdevbox-only (listed under clawdevbox.recipes)
├── tools/                   ← clawdevbox-only (listed under clawdevbox.tools)
└── triggers/                ← clawdevbox-only (listed under clawdevbox.trigger_types)
```

There is **no `plugin.yaml`** anywhere. The legacy YAML format was
removed in the marketplace alignment work (2026-05-15); plugins that
still carry one will fail to load with `MISSING_MANIFEST`.

## Plugin manifest

`<plugin>/.claude-plugin/plugin.json`:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "cfv",
  "version": "1.0.0",
  "description": "Fetch + analyze Teams call diagnostics.",
  "author": { "name": "Clawdevbox team", "email": "ops@example.com" },
  "homepage": "https://example.com/cfv",
  "repository": "https://github.com/example/cfv",
  "license": "MIT",
  "keywords": ["teams", "call-flow", "diagnostics"],

  "skills":     "./skills",
  "agents":     "./agents",
  "commands":   "./commands",
  "mcpServers": "./.mcp.json",
  "hooks":      "./hooks/hooks.json",

  "status": {
    "testedWith": "Teams call-flow-viewer 2024.5",
    "experimental": false,
    "notes": "Requires az login to obtain the CFV audience token."
  },

  "clawdevbox": {
    "recipes": [
      { "id": "analyze-call", "file": "recipes/analyze-call.yaml" }
    ],
    "tools": [
      { "id": "cfv.fetch_call", "file": "tools/fetch_call.ts", "runtime": "tsx" }
    ],
    "trigger_types": [
      {
        "id": "cfv.audit-watcher",
        "file": "triggers/audit.ts",
        "default_cron": "*/10 * * * *",
        "binds_callback_to_recipe": "analyze-call",
        "identity_param": "callId",
        "parameters": []
      }
    ],
    "agent_clis": []
  },

  "requires": {
    "clawdevbox_version": ">=1.0.0",
    "env": []
  }
}
```

### Top-level Claude fields

| Field          | Type                                | Notes |
|----------------|-------------------------------------|-------|
| `name`         | `string` (required, kebab-case)     | `/^[a-z][a-z0-9-]*$/`. The plugin's on-disk directory name must match. Replaces the legacy `id` field. |
| `version`      | `string`                            | Semver. Surfaced in `plugin.list`. |
| `description`  | `string`                            | One-line summary shown in listings and the marketplace SPA. |
| `author`       | `{ name, email?, url? }` or string  | Pass-through metadata. |
| `license`      | `string` (SPDX id)                  | Pass-through. |
| `keywords`     | `string[]`                          | Pass-through. |
| `homepage`     | `string`                            | Pass-through. |
| `repository`   | `string`                            | Pass-through. |
| `$schema`      | `string`                            | Optional, ignored by the loader. Use Claude's JSONSchema URL for editor IntelliSense. |

### Claude component paths

Every component field accepts either an explicit path (relative to the
plugin root, no `..`) **or is omitted** to fall back to auto-discovery.

| Field         | Explicit value                                       | Auto-discovery default          |
|---------------|------------------------------------------------------|---------------------------------|
| `skills`      | path or array of paths to skill directories          | `./skills/<id>/SKILL.md`        |
| `agents`      | path or array of paths to `*.agent.md` files / dirs  | `./agents/<id>.agent.md`        |
| `commands`    | path or array of paths to `*.md` files / dirs        | `./commands/<id>.md`            |
| `mcpServers`  | path to a JSON file OR an inline object              | `./.mcp.json`                   |
| `hooks`       | path to a JSON file OR an inline object              | `./hooks/hooks.json`            |

Auto-discovery is skipped for any field the manifest declares
explicitly. If `"skills": "./custom/path"` is set, only that path is
scanned — no fallback to `./skills/`.

### `mcpServers` (Claude-shape MCP config)

`./.mcp.json` (when auto-discovered) must match Claude Code's shape:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

clawdevbox loads each entry into `ws.plugins.get(<name>).capabilities.mcpServers`
but does **not** spawn them — Claude Code does. clawdevbox plugins that
want clawdevbox-hosted tools should use `clawdevbox.tools[]` instead
(see below).

### `hooks` (loaded, not fired)

clawdevbox loads `hooks/hooks.json` into the manifest object so a future
version can map Claude lifecycle events (`PreToolUse`, `PostToolUse`, …)
into the clawdevbox kernel event bus. **As of today, clawdevbox does
not fire those events** — only the kernel's own topics (`triggers`,
`fires`, `recipes`, `inbox`, …) drive plugins. This is an explicit
non-goal of the current iteration.

### `status` field (Microsoft extension)

```ts
status?: {
  testedWith: string;        // required when status is present
  experimental?: boolean;
  notes?: string;
};
```

Surfaced in `clawdevbox plugin list`, the marketplace SPA, and
`GET /api/plugins/marketplace`. `experimental: true` renders a warning
badge but does **not** block installation — the user decides.

### `clawdevbox` extensions

The `clawdevbox` top-level key carries every capability that isn't part
of Claude's vocabulary. Claude Code ignores unknown keys, so adding this
block doesn't break Claude-only consumers.

Every clawdevbox field is **polymorphic** — it accepts the same
`undefined | string | string[] | Entry[]` shape Claude Code uses for
`skills`/`agents`/`commands`. See **Auto-discovery for clawdevbox
extensions** below for the resolution rules.

```ts
clawdevbox?: {
  recipes?:       string | string[] | Array<{ id: string; file: string }>;
  tools?:         string | string[] | Array<{ id: string; file: string; runtime?: 'node'|'tsx'|'python'|'bash' }>;
  trigger_types?: string | string[] | PluginTriggerType[];
  agent_clis?:    string | string[] | PluginAgentCliEntry[];
  renderers?:     string | string[] | Array<{ type: string; module: string; description?: string }>;
};
```

#### `clawdevbox.recipes[]`

```json
{ "clawdevbox": { "recipes": [
  { "id": "review-pr", "file": "recipes/review-pr.yaml" }
] } }
```

Each entry's `file` is a YAML recipe in the same shape `recipe.upsert`
accepts. See [`docs/tools/recipe.md`](./tools/recipe.md).

#### `clawdevbox.tools[]`

Hostable MCP tools — TypeScript/JavaScript files the kernel
dynamic-imports into its own process at workspace boot.

```json
{ "clawdevbox": { "tools": [
  { "id": "my-plugin.do-thing", "file": "tools/do-thing.ts", "runtime": "tsx" }
] } }
```

`id` must be **namespaced** as `<plugin-name>.<verb>` (e.g.
`my-plugin.do-thing`). `runtime` defaults to `node` for `.js`/`.mjs`,
`tsx` for `.ts`. See [`docs/tools/plugin.md § Hostable tools`](./tools/plugin.md).

#### `clawdevbox.trigger_types[]`

```json
{ "clawdevbox": { "trigger_types": [
  {
    "id": "ado.new-pr-watcher",
    "file": "triggers/new-pr-watcher.mjs",
    "description": "Fires when a new ADO PR matches the query.",
    "binds_callback_to_recipe": "review-pr",
    "default_cron": "*/5 * * * *",
    "identity_param": "query",
    "parameters": [
      { "name": "query", "type": "string", "required": true, "description": "ADO query id" },
      { "name": "max_results", "type": "integer", "required": false, "default": 10 }
    ]
  }
] } }
```

Same shape as the legacy `provides.trigger_types[]`. Validated by
`validateTriggerTypeEntry`. See [`docs/tools/trigger.md`](./tools/trigger.md).

#### `clawdevbox.agent_clis[]`

Registers an agent-CLI provider. Each entry points at a JS module whose
**default export** conforms to `AgentCliProvider`.

```json
{ "clawdevbox": { "agent_clis": [
  {
    "id": "agency",
    "module": "dist/agency-provider.js",
    "display_name": "Microsoft Agency",
    "description": "Wraps Copilot with Microsoft-internal context routing."
  }
] } }
```

Built-in provider ids (`copilot`, `claude`, `echo-stub`) cannot be
shadowed. See [`docs/agent-clis.md`](./agent-clis.md) for the full
provider interface, `ProviderCtx` helpers, spawn modes, and a complete
`.mjs` example.

#### `clawdevbox.renderers[]`

Artifact renderer modules (`.mjs`) served to the terminal browser. The
`type` field matches the `artifact.type` at resolution time.

```json
{ "clawdevbox": { "renderers": [
  { "type": "pr-review", "module": "renderers/pr-review.mjs", "description": "Custom PR review card" }
] } }
```

Built-in renderer types (`markdown`, `pr-review`, `walkthrough`) cannot
be shadowed by a plugin — collisions are recorded as
`BUILTIN_COLLISION`. Cross-plugin collisions on the same `type` are
resolved deterministically (first plugin by sorted id wins; losers land
in `ws.rendererErrors` as `PLUGIN_COLLISION`).

### `requires`

```json
{ "requires": {
  "clawdevbox_version": ">=1.0.0",
  "env": ["GITHUB_TOKEN"]
} }
```

`clawdevbox_version` is a semver range; mismatch is a load error.
`env` is documentation-only — clawdevbox does **not** fail the load if a
listed env var is unset (the plugin is responsible for handling missing
inputs at runtime).

## Auto-discovery rules

When a Claude component field is omitted, clawdevbox scans the
convention-named directory at the plugin root and registers each entry
as if it had been listed explicitly.

| Convention                                  | Registered as                          | Notes |
|---------------------------------------------|----------------------------------------|-------|
| `skills/<id>/SKILL.md`                      | Skill `<id>`                           | YAML frontmatter `name` must equal `<id>`. The directory may carry supporting files (assets, child docs); they ship as part of the skill bundle. |
| `agents/<id>.agent.md`                      | Subagent `<id>`                        | YAML frontmatter declares `name`, `description`, etc. Body is the agent's system prompt. |
| `commands/<id>.md`                          | Slash-command `<id>`                   | YAML frontmatter typically carries `description` and `argument-hint`. Body is the prompt template. |
| `.mcp.json` at plugin root                  | MCP servers                            | `{ "mcpServers": { "<id>": { command, args } } }` shape. |
| `hooks/hooks.json`                          | Hook bundle (loaded, **not fired**)    | Reserved for a future iteration. |

Auto-discovery is forgiving: missing convention directories are fine.
A skill whose frontmatter `name` doesn't match its directory id is
recorded as `SKILL_NAME_MISMATCH` in the plugin's load errors and the
skill is **not** registered, but the rest of the plugin still loads.

## Auto-discovery for clawdevbox extensions

Every `clawdevbox.*` field uses the same three-tier resolution Claude
Code applies to its component-path fields:

| Manifest value | Behaviour |
|---|---|
| `undefined` (field absent) | Auto-discover from the convention directory. |
| `"some/path"` (single path) | Treat as a directory and scan it instead of the convention. |
| `["a", "b/file.ts"]` (path list) | Each entry is a path. Directory entries are scanned; file entries are registered directly. |
| `[{...}, ...]` (explicit objects) | Use the array as-is; no auto-discovery for this capability. |

Per-capability conventions:

| Capability        | Default dir   | File pattern                        | Id derivation                     | Notes |
|-------------------|---------------|-------------------------------------|-----------------------------------|-------|
| `recipes`         | `recipes/`    | `<id>.{yaml,yml,json}`              | filename stem                     | files prefixed with `_` or `.` are skipped |
| `tools`           | `tools/`      | `<id>.{ts,js,py,sh}`                | `<pluginName>.<stem>`             | runtime inferred from extension (`.ts`→`tsx`, `.js`→`node`, `.py`→`python`, `.sh`→`bash`); `_`-prefixed helpers skipped |
| `trigger_types`   | `triggers/`   | `<id>.{ts,js,py,sh}` + `<id>.trigger.yaml` sidecar | `<pluginName>.<stem>` | sidecar carries `description`, `default_cron`, `binds_callback_to_recipe`, etc.; missing sidecar → `LoadError` scope=`trigger_types`; orphan sidecar (no script) → `LoadError` |
| `agent_clis`      | `agent-clis/` | `<id>.{mjs,js}`                     | filename stem (not namespaced)    | the `.mjs` module's `default export` supplies `displayName`, `description`, etc. |
| `renderers`       | `renderers/`  | `<type>.{mjs,js}`                   | filename stem (= `artifact.type`) | built-in renderer types cannot be shadowed; cross-plugin collisions resolved by sorted plugin id |

Example trigger sidecar (`triggers/watch.trigger.yaml`):

```yaml
description: Watches a query for new pull requests.
default_cron: "*/5 * * * *"
binds_callback_to_recipe: review-pr
identity_param: query
accepts_webhook: false
parameters:
  - { name: query, type: string, required: true, description: "ADO query id" }
  - { name: max_results, type: integer, required: false, default: 10 }
```

Example minimal plugin (`{name, version}` only) that ships every
capability via convention dirs:

```
my-plugin/
├── .claude-plugin/plugin.json    ← { "name": "my-plugin", "version": "1.0.0" }
├── recipes/triage.yaml
├── tools/fetch.ts                ← becomes my-plugin.fetch (runtime tsx)
├── tools/_helpers.ts             ← skipped (underscore prefix)
├── triggers/watch.ts
├── triggers/watch.trigger.yaml
├── agent-clis/myprov.mjs
└── renderers/triage-card.mjs
```

Explicit `Entry[]` arrays continue to work for plugins that need full
control over ids, runtimes, or alternate file layouts. The four sample
plugins under `clawdevbox-plugins/` and the agency-provider plugin use
this Tier 3 form and load unchanged.

## Skill directory structure

clawdevbox writes and reads skills in Claude's directory layout:

```
skills/
└── dev-buddy/
    ├── SKILL.md              ← required, with YAML frontmatter
    ├── reference.md          ← optional supporting docs
    ├── snippets/             ← optional asset folder
    │   └── example.ts
    └── README.md             ← optional human-facing notes
```

`SKILL.md` example:

```md
---
name: dev-buddy
description: Pair-programming buddy that asks clarifying questions before suggesting code.
---

# Dev buddy

When the user asks for code changes, first restate the requirement in
one sentence and confirm before proceeding…
```

The flat-file form `skills/<id>.md` is **no longer recognized**. The
`skill.upsert` MCP tool writes the directory shape; any legacy flat file
at the same id is deleted on upsert to avoid duplicate registration.
See [`docs/tools/skill.md`](./tools/skill.md).

## Marketplace catalogs

A **marketplace** is a directory (git repo or local folder) that lists
multiple plugins via a `.claude-plugin/marketplace.json` catalog file.
`clawdevbox marketplace add <source>` clones / junctions the source
under `<globalDir>/marketplaces/<id>/` and parses the catalog so
`clawdevbox plugin install <name>@<marketplace-id>` can find the
constituent plugins later.

### Catalog file (`.claude-plugin/marketplace.json`)

```json
{
  "name": "acme-internal",
  "owner": { "name": "Acme Devbox Team", "email": "devbox@acme.example" },
  "description": "Acme's internal plugin collection.",
  "version": "2026.05",
  "metadata": {
    "description": "Acme's internal plugin collection.",
    "pluginRoot": "plugins"
  },
  "plugins": [
    {
      "name": "cfv",
      "source": "./plugins/cfv",
      "category": "diagnostics",
      "keywords": ["teams"]
    },
    {
      "name": "shared-skill-pack",
      "source": { "source": "github", "repo": "acme-corp/shared-skill-pack" }
    },
    {
      "name": "agency-cli",
      "source": { "source": "git", "url": "https://github.com/microsoft/agency-cli", "ref": "v1.4.0" }
    }
  ]
}
```

The `source` field for each plugin entry is one of:

| Form                                                          | Resolves to                                |
|---------------------------------------------------------------|--------------------------------------------|
| `"./relative-path"`                                           | A directory inside the marketplace itself  |
| `{ "source": "github", "repo": "owner/name", "ref"?: string }`| `git clone https://github.com/owner/name`  |
| `{ "source": "git", "url": "...", "ref"?: string }`           | Arbitrary git URL                          |
| `{ "source": "path", "path": "/abs/path" }`                   | An absolute local directory (junctioned)   |

Per-plugin entry fields (`version`, `description`, `author`,
`keywords`, `category`, `strict`, `tags`, …) act as **overrides** for
the resolved plugin's manifest values when the install record is
written. Marketplace metadata thus wins over plugin metadata where
they conflict.

### Fallback: `.github/plugin/marketplace.json`

clawdevbox reads `.claude-plugin/marketplace.json` first and falls back
to `.github/plugin/marketplace.json` if absent. This second location is
populated by Microsoft's `sync-marketplace.py` for repos that need a
GitHub-Copilot-friendly mirror; clawdevbox treats them as equivalent.

### Single-plugin sources

If neither catalog file exists but `.claude-plugin/plugin.json` does,
`clawdevbox marketplace add` rejects the source as
`NOT_A_MARKETPLACE` — but `clawdevbox init --plugin <source>` happily
treats it as a one-shot single-plugin install. The
[`plugin.install`](./tools/plugin.md#plugininstall) MCP tool is the
runtime equivalent for an already-running workspace.

### `clawdevbox marketplace` CLI

```
clawdevbox marketplace add <git-url-or-folder>     # add a marketplace
clawdevbox marketplace list                        # print installed marketplaces
clawdevbox marketplace update [<id>]               # git fetch + reset --hard
clawdevbox marketplace remove <id>                 # forget the marketplace
```

Marketplaces live under `<globalDir>/marketplaces/<id>/`; metadata
sidecars are at `<globalDir>/marketplaces/<id>.json`. Installed plugins
that came from a marketplace have their own install records under
`<globalDir>/plugins/<id>.install.json` and are **not** removed by
`marketplace remove`.

## Microsoft extensions

clawdevbox honors three Microsoft-introduced extensions to the Claude
schema that ship with the `ado-private` plugin collection.

### `marketplace-config.json` (catalog metadata overlay)

A repo-root file that overlays metadata onto the marketplace catalog
without modifying it directly. Shape:

```json
{
  "shared": {
    "name": "acme-shared",
    "metadata": { "description": "Shared metadata", "version": "2026.05" },
    "owner": { "name": "Acme team" }
  },
  "claude":     { "metadata": { "description": "Claude-flavored copy" } },
  "copilot":    { "metadata": { "description": "Copilot-flavored copy" } },
  "clawdevbox": { "metadata": { "description": "clawdevbox-flavored copy" } }
}
```

Merge order applied by `loadMarketplace`:

1. Start with `marketplace.json`'s top-level (`name`, `owner`, `metadata`).
2. Deep-merge `shared.{name, metadata, owner}` on top.
3. Deep-merge the `clawdevbox` slot on top of (2).

Per-plugin entries (`plugins[]`) are **not** overridden — they come
from the catalog file. The overlay affects only the catalog's
top-level metadata.

### `agency.json` (per-plugin engines filter)

A sidecar at `<plugin>/agency.json`:

```json
{
  "engines": ["clawdevbox", "copilot"],
  "category": "diagnostics"
}
```

- **`engines`** filters which engines see the plugin. Missing file
  means "all engines". A plugin is included if `engines` contains `"*"`,
  the current CLI identity (e.g. `"copilot"`), or the literal
  `"clawdevbox"`. Empty `engines: []` skips the plugin everywhere.
- **`category`** is copied to the plugin entry's `category` field when
  the marketplace catalog doesn't already set one.

The filter applies at install time: bulk installs (from a marketplace)
silently skip non-matching plugins; explicit `plugin.install` of an
excluded plugin returns `ENGINE_MISMATCH`.

### `status` (per-plugin stability marker)

See [§ `status` field](#status-field-microsoft-extension) above.

## Installing plugins

### Bidirectional sync with agent CLIs

When clawdevbox is configured with an agent CLI (Copilot, Claude, or
Agency), plugin installs flow in **both directions**:

- clawdevbox-installed plugins are automatically installed in the
  configured CLI via its own `<binary> plugin install` command. The
  CLI's chat surface sees the same skills/agents/commands/MCP servers
  the plugin ships.
- Client-installed plugins that carry a `clawdevbox.*` extension block
  are auto-registered in clawdevbox (after user opt-in via
  `clawdevbox init` or `clawdevbox plugin sync`). Only the
  `clawdevbox.*` capabilities are registered; skills, sub-agents,
  slash-commands, and MCP entries stay client-side where they
  already live.

The behavior is configurable via the `client_sync` block (modes:
`auto` / `discover-only` / `manual` / `off`). See
[`docs/agent-clis.md`](./agent-clis.md#bidirectional-plugin-sync) for
the full design and
[`docs/tools/plugin.md`](./tools/plugin.md#clawdevbox-plugin-sync) for
the `clawdevbox plugin sync` subcommand.

Three end-to-end paths, in roughly the order Microsoft-side users
encounter them:

### 1. One-liner during init

```bash
clawdevbox init --plugin git+https://github.com/example/cfv-plugin
clawdevbox init --plugin C:\src\my-plugin
clawdevbox init --plugin git+https://github.com/example/clawdevbox-plugins   # a marketplace
```

`init` resolves the source. If it's a single plugin (root
`.claude-plugin/plugin.json`), the plugin is installed directly. If
it's a marketplace catalog, init prompts for a multi-select of plugins
to install (filtered through `agency.json` first). Either way the
plugin lands under `<globalDir>/plugins/<name>/` and the registry
reload makes its capabilities visible immediately.

### 2. Marketplace, then per-plugin install

```bash
clawdevbox marketplace add git+https://github.com/example/clawdevbox-plugins
clawdevbox plugin install cfv@clawdevbox-plugins
```

The first command persists the catalog under `<globalDir>/marketplaces/`.
The second resolves the source for `cfv` from the catalog and installs
it like any other plugin.

### 3. From inside the agent

The [`plugin.install`](./tools/plugin.md#plugininstall) MCP tool
accepts either a single-plugin source or a marketplace source:

```json
{ "from": "git+https://github.com/example/cfv-plugin" }
```

A marketplace source installs every catalog plugin (filtered through
`agency.json`); a single-plugin source installs the one plugin
directly.

## Engine identity

When evaluating the `agency.json` `engines` filter, clawdevbox
identifies itself as a set of strings:

1. The id of the configured agent-CLI provider — typically `copilot`,
   `claude`, or (with the agency plugin installed) `agency`.
2. The literal `clawdevbox`.
3. The literal `*` (universal match).

A plugin with `engines: ["copilot"]` ships to a clawdevbox install
configured with the Copilot provider. A plugin with
`engines: ["clawdevbox"]` ships to every clawdevbox install regardless
of provider. A plugin with `engines: ["claude"]` only on a clawdevbox
install configured to use the Claude provider — but the same plugin
files load fine in Claude Code itself, which is the point.

## Authoring a clawdevbox-only plugin

A plugin can declare **only** clawdevbox capabilities (no skills, no
agents, no commands). Claude Code will silently ignore it; clawdevbox
will load it normally.

```json
{
  "name": "tiny",
  "version": "0.1.0",
  "description": "A clawdevbox-only trigger type.",
  "clawdevbox": {
    "trigger_types": [
      {
        "id": "tiny.cron-pulse",
        "file": "triggers/pulse.mjs",
        "default_cron": "* * * * *",
        "binds_callback_to_recipe": "log-tick",
        "parameters": []
      }
    ],
    "recipes": [{ "id": "log-tick", "file": "recipes/log-tick.yaml" }]
  }
}
```

## Authoring a Claude-only plugin that also works in clawdevbox

The `clawdevbox` key is **optional**. A plugin with only Claude
capabilities (skills/agents/commands/MCP servers) loads in clawdevbox
without any clawdevbox-specific authoring:

```json
{
  "name": "dev-buddy",
  "version": "1.0.0",
  "description": "A pair-programming buddy.",
  "license": "MIT"
}
```

With this manifest in place plus `skills/dev-buddy/SKILL.md` on disk,
both Claude Code and clawdevbox register the `dev-buddy` skill. No
clawdevbox-specific fields needed.

## A complete example

```json
{
  "name": "agency-cli",
  "version": "1.0.0",
  "description": "Wraps GitHub Copilot CLI with Microsoft-internal context routing.",
  "author": { "name": "Microsoft IDX Team" },
  "license": "MIT",

  "clawdevbox": {
    "agent_clis": [
      {
        "id": "agency",
        "module": "dist/agency-provider.js",
        "display_name": "Microsoft Agency",
        "description": "Wraps Copilot with Microsoft-internal context routing."
      }
    ]
  }
}
```

Plus a sibling `agency.json`:

```json
{
  "engines": ["*"],
  "category": "agent-cli"
}
```

Install with a single command:

```bash
clawdevbox init --plugin git+https://github.com/microsoft/agency-cli-clawdevbox-plugin
```

…then pick "Microsoft Agency" in the agent-CLI chooser. See
[`docs/agent-clis.md`](./agent-clis.md) § Installing a plugin for the
other install paths.
