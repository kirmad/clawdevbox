# Plugin Auto-Discovery for clawdevbox Capabilities

**Status:** Draft (design addendum)
**Date:** 2026-05-15
**Spec extended:** `docs/specs/2026-05-15-marketplace-and-plugin-schema-design.md`
**Scope:** Add uniform auto-discovery + manifest override patterns for all five clawdevbox-specific capabilities (recipes, hostable tools, trigger types, agent CLI providers, artifact renderers). Make each `clawdevbox` extension field polymorphic (`string | string[] | Entry[]`), matching Claude Code's `skills` / `agents` / `commands` patterns.

## 1. Background

Today the `clawdevbox` extension block on `.claude-plugin/plugin.json` requires explicit arrays for every capability:

```json
"clawdevbox": {
  "recipes":       [{ "id": "...", "file": "..." }, ...],
  "tools":         [{ "id": "...", "file": "...", "runtime": "..." }, ...],
  "trigger_types": [{ "id": "...", "file": "...", "default_cron": "...", ... }, ...],
  "agent_clis":    [{ "id": "...", "module": "...", "display_name": "..." }, ...]
}
```

Claude Code's pattern is different: capabilities have a default convention directory (`skills/`, `agents/`, `commands/`) and the manifest field is optional. When absent, the loader scans the convention dir. When set as a string, it's a path override. When set as an array, it's an explicit list.

We adopt the same three-tier pattern for clawdevbox capabilities so:
- Minimal plugins ship with `{"name": "x"}` plus convention directories — no manifest boilerplate.
- Path overrides + explicit lists remain available for plugins that need control.

Renderers are also added as a first-class capability with the same pattern.

## 2. Manifest field polymorphism

Update `ClawdevboxExtensions` in `mcp-server/src/manifest/types.ts`:

```ts
export interface ClawdevboxExtensions {
  recipes?:       string | string[] | PluginProvideEntry[];
  tools?:         string | string[] | ClawdevboxToolEntry[];
  trigger_types?: string | string[] | PluginTriggerType[];
  agent_clis?:    string | string[] | PluginAgentCliEntry[];
  renderers?:     string | string[] | PluginRendererEntry[];   // NEW
}

export interface PluginRendererEntry {
  type: string;        // matches artifact.type, e.g. "pr-review"
  module: string;      // relative path to .mjs
  description?: string;
}
```

Resolution rules per field:

| Manifest value | Behaviour |
|---|---|
| `undefined` (field absent) | Auto-discover from the conventional directory. |
| `string` (single path) | Treat as a directory; scan it instead of the convention. |
| `string[]` (path list) | Each entry is a path. If a path is a directory, scan it; if a file, register it directly. |
| `Entry[]` (explicit objects) | Use the list as-is. No auto-discovery; the author controls every entry. |

## 3. Per-capability conventions

### 3.1 Recipes

| | |
|---|---|
| Default dir | `recipes/` |
| File pattern | `<id>.yaml`, `<id>.yml`, `<id>.json` (flat files) |
| Id derivation | filename without extension |
| Validation | `validateRecipeParsed` |
| Auto-discovery skip | files starting with `_` or `.` |

Example: `recipes/triage-incident.yaml` → registered as recipe `triage-incident`.

### 3.2 Hostable tools

| | |
|---|---|
| Default dir | `tools/` |
| File pattern | `<id>.ts`, `<id>.js`, `<id>.py`, `<id>.sh` |
| Runtime derivation | `.ts` → `tsx`, `.js` → `node`, `.py` → `python`, `.sh` → `bash` |
| Id derivation | `<plugin-name>.<filename-no-ext>` — auto-namespaced |
| Auto-discovery skip | files starting with `_` (private helpers) or `.` |

Examples in plugin `calls`:
- `tools/fetch_call.ts` → tool id `calls.fetch_call`
- `tools/_auth.ts` → private helper, ignored
- `tools/get_flow.py` → tool id `calls.get_flow`, runtime `python`

When the manifest declares `clawdevbox.tools: [{ "id": "calls.fetch_call", ... }]` explicitly, the namespacing is the author's responsibility.

### 3.3 Trigger types

Trigger types have richer metadata (`default_cron`, `binds_callback_to_recipe`, `identity_param`, parameter schema). For auto-discovery, the script lives alongside a YAML sidecar.

| | |
|---|---|
| Default dir | `triggers/` |
| Script pattern | `<id>.ts`, `<id>.js`, `<id>.py`, `<id>.sh` |
| Sidecar | `<id>.trigger.yaml` (required for auto-discovery; can be omitted only if the manifest declares this trigger explicitly) |
| Id derivation | `<plugin-name>.<filename-no-ext>` — auto-namespaced |
| Auto-discovery skip | files starting with `_` or `.`; orphan sidecars (no matching script) |

Sidecar shape:
```yaml
description: One-line human description.
default_cron: "*/2 * * * *"            # optional
binds_callback_to_recipe: triage       # optional; mutually exclusive with binds_callback_to
binds_callback_to: agent_session_resume # optional
identity_param: owner                  # optional
accepts_webhook: true                  # optional
parameters:                            # optional
  - { name: owner, type: string, required: true, description: "..." }
runtime: tsx                           # optional; derived from script extension when absent
```

The sidecar fields are the same as the existing `PluginTriggerType` entries minus `id` and `file` (those are derived from the script filename).

Validation: same as today's `validateTriggerTypeEntry`, plus the script file must exist alongside the sidecar.

### 3.4 Agent CLI providers

| | |
|---|---|
| Default dir | `agent-clis/` |
| File pattern | `<id>.mjs`, `<id>.js` (ESM module) |
| Module shape | `default export` (or named `provider`) conforming to `AgentCliProvider` |
| Id derivation | `<filename-no-ext>` (NOT namespaced — provider ids are globally meaningful, e.g. `agency`, `copilot-internal`) |
| `display_name` / `description` | from the module's own fields; manifest override wins if explicit entry |
| Auto-discovery skip | files starting with `_` or `.` |

A plugin shipping only one provider (the agency-provider plugin we built earlier) can place its module at `agent-clis/agency.mjs` and omit the manifest entry entirely. The loader picks it up.

### 3.5 Renderers

| | |
|---|---|
| Default dir | `renderers/` |
| File pattern | `<type>.mjs`, `<type>.js` |
| Module | served to the browser as an ES module (loaded via `https://esm.sh` or relative imports inside the .mjs) |
| Type derivation | `<filename-no-ext>` (matches `artifact.type` field for resolution) |
| Built-in collision | renderers like `markdown`, `pr-review`, `walkthrough` cannot be shadowed by plugins (built-in wins) |
| Plugin-plugin collision | first-loaded wins (sorted by plugin name); loser recorded as `RENDERER_COLLISION` error |
| Auto-discovery skip | files starting with `_` or `.` |

Renderer discovery already partly works today (`mcp-server/src/renderer-registry.ts:65-70` scans `<plugin>/renderers/*.mjs` for resolution). This change makes it consistent: renderers also appear in the resolved `capabilities` bundle returned by `loadPluginFromDir`, so `clawdevbox plugin list` and `GET /api/plugins/<id>` can report them.

The existing precedence chain (workspace → plugin → built-in) is preserved.

## 4. Loader changes (`mcp-server/src/manifest/load-plugin.ts`)

Five new resolver helpers, all sharing a common `resolveCapability` skeleton:

```ts
async function resolveCapability<T>(opts: {
  manifestValue: string | string[] | T[] | undefined;
  pluginDir: string;
  defaultDir: string;
  scanDir(dir: string): Promise<T[]>;
  fromExplicit(entries: T[]): T[];
}): Promise<T[]>;
```

Algorithm:
1. If `manifestValue` is `undefined`: scan `<pluginDir>/<defaultDir>`.
2. If `string`: scan `<pluginDir>/<value>` as a single dir.
3. If `string[]`: iterate; for each, scan if dir, else treat as a single-file glob.
4. If `T[]`: pass through `fromExplicit`.

Each capability supplies its own `scanDir`:

- **recipes**: glob `*.{yaml,yml,json}`, filter `_*` / `.*`, build `{id, file}`.
- **tools**: glob `*.{ts,js,py,sh}`, filter `_*` / `.*`, namespace id, infer runtime.
- **trigger_types**: glob scripts, look up sidecar `<id>.trigger.yaml`, validate, build entry.
- **agent_clis**: glob `*.{mjs,js}`, treat each as if listed in `clawdevbox.agent_clis[]` (no module-content read at scan time — the loader-plugin step does dynamic import).
- **renderers**: glob `*.{mjs,js}`, build `{type, module}` entries. Module is dynamic-imported lazily by `renderer-registry.ts`.

## 5. Validator changes (`mcp-server/src/validators.ts`)

`validatePluginManifestJson` already accepts the existing shape. Extend each `clawdevbox.*` field to accept the polymorphic types:

```ts
function validatePolymorphic<T>(
  value: unknown,
  fieldName: string,
  entryValidator: (entry: unknown, i: number) => ValidationError[],
): ValidationError[];
```

- If `value` is a string: validate it's not `..`-prefixed.
- If array of strings: validate each.
- If array of objects: validate each via `entryValidator`.
- Else (mixed, malformed): `TYPE` error.

For `clawdevbox.renderers` (new): each entry must have `type` (kebab-case) + `module` (relative path, no `..`).

## 6. Renderer-registry integration

`mcp-server/src/renderer-registry.ts` today scans `<plugin>/renderers/*.mjs` independently. After this change, the resolved capabilities from `loadPluginFromDir` carry the renderer list. Refactor:

1. `loadPluginFromDir` returns `capabilities.renderers: Array<{ type: string; absoluteFile: string; description?: string }>`.
2. `workspace.ts` populates a `ws.pluginRenderers: Map<type, { pluginId, file }>` (first-loaded wins, collisions recorded).
3. `resolveRendererFile` walks: workspace → `ws.pluginRenderers` → built-in (instead of scanning each plugin's `renderers/` dir live).
4. `listAvailableRenderers` reads from `ws.pluginRenderers`.

This is a refactor, not a behavior change — the existing precedence is preserved. The benefit: collisions and load errors are surfaced into `ws.agentCliProviderErrors`-style array (rename to `ws.capabilityErrors`? or have separate arrays per capability — pick one and stay consistent).

For the manifest-side: a plugin can EITHER drop a `.mjs` into `renderers/` (auto-discovery) OR explicitly list it in `clawdevbox.renderers: [{type, module}]`. Path overrides via `clawdevbox.renderers: "./custom-renderers"` work the same as the other capabilities.

## 7. Failure modes

| Scenario | Behaviour |
|---|---|
| `tools/_helper.ts` ignored by auto-discovery | Intentional. Authors can explicitly list it in `clawdevbox.tools[]` if they want it exposed. |
| `triggers/x.ts` with no sidecar | Skipped during auto-discovery; emit `LoadError` scope=`trigger_types` message="missing sidecar". Manifest can declare it explicitly to avoid the error. |
| Orphan `triggers/x.trigger.yaml` (no script) | Skipped, `LoadError` scope=`trigger_types`. |
| `agent-clis/copilot.mjs` (collision with built-in) | Plugin file ignored, `LoadError` scope=`agent_clis` code=`BUILTIN_COLLISION` (same as today's manifest-driven path). |
| `renderers/markdown.mjs` (collision with built-in) | Built-in wins (it's the resolver's final step). `LoadError` scope=`renderers` code=`BUILTIN_COLLISION`. |
| `renderers/x.mjs` with malformed module | Dynamic import fails at first use (lazy). The registry caches the error and serves a 500 with the load error. |

## 8. Testing

- For each capability: unit tests covering all four manifest-value shapes (undefined / string / string[] / Entry[]).
- For tools: namespacing test (`<plugin-name>.<id>`), `_` prefix exclusion.
- For triggers: sidecar present / missing / orphan; sidecar fields round-trip.
- For renderers: built-in collision + plugin-plugin collision.
- An "everything auto-discovered" test: a plugin with `.claude-plugin/plugin.json` containing only `{name, version}` + convention dirs for all five capabilities loads cleanly.

## 9. Migration impact

The four existing sample plugins (`calls`, `logsearch`, `incidents`, `metrics`) all use explicit arrays today after the Phase 4.3 migration. They keep working unchanged because explicit arrays are the third tier of the polymorphic field. No re-migration needed.

The agency plugin (`C:\git\agency-provider`) similarly keeps its explicit `clawdevbox.agent_clis[]` entry. Optionally, the maintainer can move `agency-provider.mjs` → `agent-clis/agency.mjs` and remove the manifest entry; both paths work.

## 10. Out of scope

- Watching convention directories for hot reload — auto-discovery happens at workspace boot only.
- Sub-directory traversal for any capability beyond what Claude already supports (skills) — every clawdevbox capability is flat-scan at depth 1.
- Cross-plugin renderer composition (e.g., a renderer that extends another) — current `resolveRendererFile` is single-file; chain is precedence-only.
