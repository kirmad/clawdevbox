# Plugin manifest reference

This file documents the **author-side** shape of a Clawdevbox plugin —
the `plugin.yaml` manifest and what each `provides.*` family means.
For the **operator-side** view (installing, updating, listing,
enabling), see [`docs/tools/plugin.md`](./tools/plugin.md).

A plugin is a directory containing a `plugin.yaml` manifest and the
files it points at. Plugins live under `<globalDir>/plugins/<id>/`
once installed (either as a real directory after a git clone or as a
junction to a local source folder).

## Manifest top-level fields

```yaml
id: my-plugin                  # /^[a-z][a-z0-9-]*$/
name: My plugin
version: 1.0.0                 # semver
description: One-line summary shown in plugin.list.
author: Me                     # optional
license: MIT                   # optional, SPDX id
homepage: https://example.com  # optional
```

## `provides.*` families

A plugin can declare any combination of the families below. Each
family has its own schema; entries within a family must have unique
ids. Cross-family id collisions are fine. Files referenced by any
entry must live inside the plugin directory (paths containing `..`
are rejected at load).

### `provides.recipes[]`

```yaml
provides:
  recipes:
    - id: review-pr
      file: recipes/review-pr.yaml
```

Each entry's `file` is a YAML recipe in the same shape `recipe.upsert`
accepts. See [`docs/tools/recipe.md`](./tools/recipe.md).

### `provides.skills[]`

```yaml
provides:
  skills:
    - id: dev-buddy
      file: skills/dev-buddy.md
```

Skills are markdown files with YAML frontmatter. See
[`docs/tools/skill.md`](./tools/skill.md).

### `provides.tools[]`

Hostable MCP tools — TypeScript / JavaScript files the kernel
dynamic-imports into its own process. See
[`docs/tools/plugin.md`](./tools/plugin.md) § Hostable tools.

```yaml
provides:
  tools:
    - id: my-plugin.do-thing      # namespaced: <plugin>.<verb>
      file: tools/do-thing.ts
```

### `provides.mcp_servers[]`

Heavyweight alternative to hostable tools — a separate MCP server
process declared via a Continue/Cursor-shape JSON config.

```yaml
provides:
  mcp_servers:
    - id: my-indexer
      file: mcp-servers/indexer.json
```

### `provides.trigger_types[]`

Capability declarations the agent can instantiate via
`trigger.register`. Each entry binds a callback module to a recipe (or
to the thread-resume callback type) and exposes a parameter schema.

```yaml
provides:
  trigger_types:
    - id: ado.new-pr-watcher                 # namespaced: <plugin>.<verb>
      file: triggers/new-pr-watcher.mjs
      description: Fires when a new Azure DevOps PR matches the query.
      binds_callback_to_recipe: review-pr
      default_cron: "*/5 * * * *"
      identity_param: query                  # optional; suffixes the instance id
      parameters:
        - { name: query, type: string, required: true, description: "ADO query id" }
        - { name: max_results, type: integer, required: false, default: 10 }
```

Validated by `validateTriggerTypeEntry` — id must match the namespaced
pattern `[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*`; `file` cannot contain
`..`; `binds_callback_to_recipe` and `binds_callback_to` are mutually
exclusive (the latter, when set, must equal `thread_resume`);
`default_cron` (when set) must be a well-formed 5- or 6-field cron
expression. See [`docs/tools/trigger.md`](./tools/trigger.md).

### `provides.agent_clis[]`

Register one or more agent-CLI providers. Each entry points at a JS
(or compiled-from-TS JS) module whose **default export** conforms to
`AgentCliProvider`. The module is dynamically `import()`-ed at
workspace boot.

```yaml
provides:
  agent_clis:
    - id: my-cli                       # /^[a-z0-9][a-z0-9._-]*$/i
      module: dist/my-provider.mjs     # relative to plugin root; no `..`
      display_name: "My CLI"           # optional; falls back to id
      description: "Spawns my-cli with project-specific context."
```

| Field          | Required | Notes |
|----------------|----------|-------|
| `id`           | yes      | Provider id. Matches `[a-z0-9][a-z0-9._-]*` (case-insensitive). Used as the value of `agent_cli` on `recipe.run`, `default_client` on recipes, and `default_agent_cli` in config. |
| `module`       | yes      | Path to the JS module to dynamic-import, relative to the plugin directory. Path traversal (`..` segments) is rejected. |
| `display_name` | no       | Shown in the init chooser and the SPA settings page. Falls back to `id`. |
| `description`  | no       | One-line summary shown next to the display name. |

**Built-in provider ids (`copilot`, `claude`, `echo-stub`) cannot be
shadowed.** Built-ins register before plugins; a plugin that declares
one of those ids is rejected at load and the failure is recorded in
`ws.agentCliProviderErrors` with code `BUILTIN_COLLISION`. Two
plugins that both declare the same id resolve by sorted-plugin-id —
first wins, loser recorded as `PLUGIN_COLLISION`.

The loader duck-types the module's default export against
`AgentCliProvider`: it checks for `id`, `displayName`, `description`,
and a callable `spawnSession`. See [`docs/agent-clis.md`](./agent-clis.md)
for the full interface, ProviderCtx helpers (`spawnPty`,
`writeWorkspaceFile`), the `SpawnSessionOpts` mode matrix, a complete
`.mjs` example, and the runtime resolution chain.

## `requires.*`

```yaml
requires:
  clawdevbox_version: ^1.0.0    # semver range; mismatch is a load error
  env:                          # documented requirement only — load doesn't fail
    - GITHUB_TOKEN
```

## A complete example

```yaml
id: agency-cli
name: Agency Copilot Wrapper
version: 1.0.0
description: Wraps GitHub Copilot CLI with Microsoft-internal context routing.
provides:
  agent_clis:
    - id: agency
      module: dist/agency-provider.js
      display_name: "Microsoft Agency"
      description: "Wraps Copilot with Microsoft-internal context routing."
```

Install it with a single command:

```bash
clawdevbox init --plugin git+https://github.com/microsoft/agency-cli-clawdevbox-plugin
```

…then pick "Microsoft Agency" in the agent-CLI chooser. See
[`docs/agent-clis.md`](./agent-clis.md) § Installing a plugin for the
other install paths.
