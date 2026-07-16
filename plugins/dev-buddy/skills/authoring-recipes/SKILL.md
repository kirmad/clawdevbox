---
name: authoring-recipes
description: Use when creating, editing, or fixing a clawdevbox recipe TEMPLATE (a reusable multi-step pipeline) via `recipe.template.upsert` — writing a new recipe body, adding/reordering/renaming steps, choosing kind/default_client/mcp_servers, wiring step order with depends, customizing a plugin-shipped recipe, or debugging a VALIDATION_FAILED, PLUGIN_SCOPE_READONLY, ID_MISMATCH, or UNRESOLVED_REF error.
---

# Authoring recipe templates

A **recipe template** is a reusable, multi-step pipeline an agent runs later via
`recipe.instance.begin` and drives to completion with `recipe.steps.update_status`.
You create or replace templates with the **`recipe.template.upsert`** tool.
Recipes are **prose-only** — steps are starting-point instructions the executing
agent adapts; there is no enforcing engine (`docs/tools/recipe.md`;
`plugins/ado/recipes/pr-review.yaml` header).

## When to use / not

- **Use** to write a recipe body; add/reorder/rename steps; set
  `kind`/`default_client`/`mcp_servers`; wire order with `depends`; customize a
  plugin recipe; or debug a validation error.
- **Not for running/driving** a recipe → `using-recipes`. Not for general MCP
  tool access, memory, triggers, or inbox → `using-clawdevbox`.

## Body + step shape (quick reference)

Top-level body (`validators.ts:125-193`; `docs/tools/recipe.md:102-111`):

| Field | Req | Value |
|---|---|---|
| `id` | ✅ | kebab `[a-z][a-z0-9-]*`; MUST equal the upsert `id` arg (else `ID_MISMATCH`) |
| `name` | ✅ | non-empty display name |
| `description` | ✅ | 1–3 sentence summary |
| `kind` | – | `pr_review｜workitem｜incident｜epic｜custom` — **not** `work_item` |
| `default_client` | – | provider id: `copilot｜claude` (`echo-stub` for tests); checked at run time |
| `mcp_servers` | – | array of server ids the steps call, e.g. `[clawdevbox, ado]` |
| `timeout_minutes` | – | number ≥ 0; `0` = no host-imposed timeout |
| `steps` | – | ordered array (below) |
| `agent` | – | optional persona name for single-shot recipes (e.g. dev-buddy recipes) |

Each step (`validators.ts:194-330`):

| Field | Req | Value |
|---|---|---|
| `id` | ✅ | unique; kebab string **or** integer (coerced to string); addressed by `recipe.steps.update_status` |
| `goal` | ✅ | human-readable TL;DR ≤ 200 chars — the step title in the UI |
| `ai_instructions` | – | full agent-facing prompt ≤ 16000 chars; omit for gate/informational steps |
| `depends` | – | array of step ids that must run first; each must be declared (else `UNRESOLVED_REF`) |
| `params` | – | `[{name, type, required?, default?, description?}]`; type ∈ string/integer/number/boolean/array/object |
| `artifacts` / `triggers` | – | optional declarations |

**`goal` vs `ai_instructions`:** `goal` is the terse title a human scans;
`ai_instructions` is the detailed prompt the agent executes. If `goal` exceeds
200 chars it is auto-promoted into `ai_instructions` (when unset) and a short
goal is synthesized from the first line/sentence (`validators.ts:241-256`). Don't
rely on that — split them yourself.

## Worked example

```
recipe.template.upsert({
  id: "cleanup-stale-branches",
  scope: "project",            // or "global"; plugin:<id> is read-only
  format: "yaml",              // default; "json" also supported
  source: `
id: cleanup-stale-branches
name: Prune merged remote branches
description: Delete branches already merged to main. Idempotent — safe to re-run.
kind: custom
default_client: copilot
mcp_servers: [clawdevbox]
steps:
  - id: scan
    goal: List branches merged into main
    ai_instructions: |
      Run git branch --merged main, parse the output, exclude main/master
      and release/*. Save the list for the prune step.
  - id: prune
    goal: Delete each merged branch after approval
    depends: [scan]
    ai_instructions: |
      For each branch from scan, call approval.request before deleting.
      On approval run git branch -d <b> and git push origin :<b>.
`
})
```

Adapted from the `recipe.template.upsert` tool example; it models the
`goal` + `ai_instructions` split that shipped ADO recipes omit.

## Create vs update, and scopes

- **Upsert is create-or-replace.** The same `id` + `scope` overwrites the file
  in place — there is no separate "update" call. To preserve existing steps,
  `recipe.template.get` first, edit, then upsert the full body. Switching `format`
  atomically removes the sibling-extension file (`docs/tools/recipe.md:645-648`).
- **Write scopes** (precedence project → plugin → global, `recipe.md:51-58`):

  | scope | writable | on-disk path |
  |---|---|---|
  | `project` | ✅ | `<projectDir>/.clawdevbox/recipes/<id>.yaml` |
  | `global` | ✅ | `<globalDir>/recipes/<id>.yaml` |
  | `plugin:<id>` | ❌ read-only | shipped inside the plugin |

- **Customize a plugin recipe:** `recipe.template.get({ id, scope: 'plugin:<id>' })` →
  edit → `recipe.template.upsert({ id, scope: 'project', source })`. The project
  copy shadows the plugin's on every read (`recipe.md:749-752`).

## Gotchas

- `kind: work_item` (underscore) is **rejected** — the validated enum is
  `workitem`. Shipped ADO recipes use `work_item`; don't copy that
  (`validators.ts:55`).
- Body `id` must equal the `id` arg (`ID_MISMATCH`) and be kebab-case
  (`INVALID_ID`).
- Only `id`/`name`/`description` are strictly required; a useful recipe still
  sets `kind`, `default_client`, `mcp_servers`, and `steps`.
- `depends` pointing at an undeclared step id → `UNRESOLVED_REF`. Keep step ids
  consistent (all integer or all kebab) so `depends` resolves.
- Don't dump the whole prompt into `goal` — title in `goal`, work in
  `ai_instructions`.
- List **every** MCP server the steps call in `mcp_servers` (e.g. `ado`,
  `clawdevbox`), or the spawned agent won't have them.
- Upserting a `plugin:<id>` scope → `PLUGIN_SCOPE_READONLY`; copy to `project`
  instead.

## See also

- `using-recipes` — running and driving recipe instances (`recipe.instance.begin`
  → `recipe.steps.update_status`).
- `using-clawdevbox` — the MCP tool-access protocol, scopes, memory, triggers,
  and inbox.
