# Plugin Capability Auto-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Single subagent dispatch — the changes are tightly coupled (one loader, one validator).

**Goal:** Add uniform auto-discovery for the five clawdevbox-specific plugin capabilities (recipes, tools, trigger types, agent CLIs, renderers). Manifest fields become polymorphic (`string | string[] | Entry[]`). Renderers are added as a first-class extension.

**Architecture:** One generic `resolveCapability` helper in `mcp-server/src/manifest/load-plugin.ts` that handles the three-tier resolution (auto-discover from convention dir / path override / explicit list). Five thin wrappers, one per capability. Renderer-registry refactored to consume the resolved capabilities instead of scanning plugin dirs live.

**Tech Stack:** TypeScript, node:test, `js-yaml`.

**Spec:** `docs/specs/2026-05-15-plugin-capability-autodiscovery-design.md`

**Baseline:** HEAD `daa7a9b` on `main`. 351/351 tests passing. Pre-existing typecheck errors at `template-store.ts:155`, `tools/trigger.ts:658`, `tools/trigger.ts:778`.

---

## File structure

**Modified files:**
- `mcp-server/src/manifest/types.ts` — `ClawdevboxExtensions` field types become polymorphic; add `PluginRendererEntry`.
- `mcp-server/src/manifest/load-plugin.ts` — new `resolveCapability` + five wrappers; renderers added to `ResolvedCapabilities`.
- `mcp-server/src/validators.ts` — `validatePolymorphic` helper; renderer entry validator; update `validatePluginManifestJson`.
- `mcp-server/src/workspace.ts` — populate `ws.pluginRenderers` from resolved capabilities; replace per-plugin renderer scans.
- `mcp-server/src/renderer-registry.ts` — consume `ws.pluginRenderers` for resolution + listing.
- `mcp-server/tests/manifest-load.test.mjs` — new tests for each capability + polymorphic shapes.
- `mcp-server/tests/fixtures/auto-discover-plugin/` (new) — fixture for the "everything-auto-discovered" test.
- `docs/plugins.md` — add §"Auto-discovery for clawdevbox extensions" with table + examples.
- `docs/MCP-TOOLS-REFERENCE.md` — regenerate.

---

## Phase 1 — Single subagent dispatch (everything below)

### Task 1.1: Polymorphic types + renderer entry

**File:** `mcp-server/src/manifest/types.ts`

Update:

```ts
export interface PluginRendererEntry {
  type: string;
  module: string;
  description?: string;
}

export interface ClawdevboxExtensions {
  recipes?:       string | string[] | PluginProvideEntry[];
  tools?:         string | string[] | ClawdevboxToolEntry[];
  trigger_types?: string | string[] | PluginTriggerType[];
  agent_clis?:    string | string[] | PluginAgentCliEntry[];
  renderers?:     string | string[] | PluginRendererEntry[];
}
```

### Task 1.2: Validators

**File:** `mcp-server/src/validators.ts`

Add:

```ts
/**
 * Generic helper for validating a clawdevbox capability field that accepts
 * a string, string[], or array of entry objects.
 */
function validateCapabilityField<T>(
  value: unknown,
  fieldPath: string,
  entryValidator: (entry: unknown, i: number) => ValidationError[],
): ValidationError[];
```

- `string`: must match relative-path safety rules (no `..`, no absolute).
- `string[]`: each entry validated as relative path.
- `Object[]`: each entry validated via `entryValidator`.
- Anything else: `TYPE` error.

Add `validatePluginRendererEntry(entry, i)`:
- `type`: required, matches `/^[a-z0-9][a-z0-9._-]*$/i`.
- `module`: required, no `..`, no absolute path.
- `description`: optional string.

Update `validatePluginManifestJson` to use `validateCapabilityField` for each `clawdevbox.{recipes,tools,trigger_types,agent_clis,renderers}` field, delegating to the existing entry validators.

Add tests for the polymorphic field + renderer entry validator (8 cases minimum).

### Task 1.3: `resolveCapability` + five wrappers

**File:** `mcp-server/src/manifest/load-plugin.ts`

Add the generic resolver:

```ts
async function resolveCapability<E>(opts: {
  manifestValue: string | string[] | E[] | undefined;
  pluginDir: string;
  defaultDir: string;
  scanDir(absoluteDir: string): Promise<E[]>;
  fileToEntry(absoluteFile: string): E | null;     // for string[]-of-files case
  normalize(entries: E[]): E[];                     // dedup, sort, etc.
}): Promise<E[]>;
```

Then five wrappers:

#### `discoverRecipes(pluginDir, manifestValue)`
- `defaultDir = 'recipes'`.
- `scanDir`: glob `*.{yaml,yml,json}`, skip `_*` and `.*`, build `{id: <basename>, file: <relativePath>}`.
- Each result validated against the recipe path regex.

#### `discoverTools(pluginDir, manifestValue, pluginName)`
- `defaultDir = 'tools'`.
- `scanDir`: glob `*.{ts,js,py,sh}`, skip `_*` and `.*`.
- Id = `<pluginName>.<basename>` (when auto-discovered or string-path resolved). When explicit entry has its own `id`, that wins.
- Runtime = derived from extension if not in the entry.

#### `discoverTriggerTypes(pluginDir, manifestValue, pluginName)`
- `defaultDir = 'triggers'`.
- `scanDir`: glob scripts `*.{ts,js,py,sh}`, skip `_*` and `.*`.
- For each script `<id>.<ext>`, look for sibling `<id>.trigger.yaml`.
- Parse the sidecar YAML; build full `PluginTriggerType` entry with `id = <pluginName>.<basename>`, `file = <relativePath>`, `description`, `default_cron`, `binds_callback_to_recipe`, `binds_callback_to`, `identity_param`, `accepts_webhook`, `parameters`, `runtime`.
- Missing sidecar → skip + log warning (return a `LoadError`).
- Orphan sidecar (no matching script) → skip + log warning.

#### `discoverAgentClis(pluginDir, manifestValue)`
- `defaultDir = 'agent-clis'`.
- `scanDir`: glob `*.{mjs,js}`, skip `_*` and `.*`.
- For each, build `{id: <basename>, module: <relativePath>}`. The actual import + shape validation happens later in `agent-clis/load-plugin.ts` (which already supports this).

#### `discoverRenderers(pluginDir, manifestValue)`
- `defaultDir = 'renderers'`.
- `scanDir`: glob `*.{mjs,js}`, skip `_*` and `.*`.
- Build `{type: <basename>, module: <relativePath>}`.

Wire all five into `loadPluginFromDir`. Extend `ResolvedCapabilities`:

```ts
interface ResolvedCapabilities {
  // ... existing ...
  renderers: Array<{ type: string; module: string; absoluteFile: string; description?: string }>;
}
```

The `loadErrors` array carries per-capability load errors as before.

### Task 1.4: Renderer-registry integration

**File:** `mcp-server/src/workspace.ts` + `mcp-server/src/renderer-registry.ts`

Add to `Workspace`:

```ts
interface Workspace {
  // ... existing ...
  pluginRenderers: Map<string, { type: string; pluginId: string; absoluteFile: string }>;
  rendererErrors: Array<{ pluginId: string; type: string; error: string; code: 'BUILTIN_COLLISION'|'PLUGIN_COLLISION'|'INVALID_TYPE' }>;
}
```

After `loadPluginFromDir` returns for each plugin, iterate `capabilities.renderers` and populate `ws.pluginRenderers`:
- If `type` is in the built-in list (`['markdown', 'pr-review', 'walkthrough', ...]`) → record `BUILTIN_COLLISION`.
- If `type` is already in `ws.pluginRenderers` from another plugin → record `PLUGIN_COLLISION`.
- Else → register `{type, pluginId, absoluteFile}`.

Refactor `renderer-registry.ts`:
- `resolveRendererFile(type, ws)`: workspace dir → `ws.pluginRenderers.get(type)` → built-in dir. (Drops the live-scan loop over `ws.plugins`.)
- `listAvailableRenderers(ws)`: workspace + iterate `ws.pluginRenderers.values()` + built-in.

### Task 1.5: Tests

**File:** `mcp-server/tests/manifest-load.test.mjs`

Add tests:
1. **Recipes** — `undefined` manifest + `recipes/foo.yaml` present → discovered.
2. **Recipes** — `clawdevbox.recipes: "./custom-recipes"` → scans the custom dir.
3. **Recipes** — `clawdevbox.recipes: [{id, file}]` → uses explicit list, no auto-discovery.
4. **Recipes** — `_private.yaml` excluded.
5. **Tools** — auto-discover `tools/foo.ts` → id `<pluginName>.foo`, runtime `tsx`.
6. **Tools** — `_helper.ts` excluded.
7. **Triggers** — auto-discover with sidecar present.
8. **Triggers** — script without sidecar → load error.
9. **Triggers** — sidecar without script → load error.
10. **Agent CLIs** — auto-discover from `agent-clis/foo.mjs`.
11. **Renderers** — auto-discover from `renderers/custom-art.mjs`.
12. **Renderers** — `renderers/markdown.mjs` (collides with built-in) → load error.
13. **Renderers** — two plugins both with `renderers/foo.mjs` → first-loaded wins, second is `PLUGIN_COLLISION`.
14. **Polymorphic** — for one capability, test all four shapes (undefined / string / string[] / Entry[]).
15. **Everything-auto-discovered** — fixture plugin with minimal manifest `{name, version}` plus all 5 convention dirs → every capability loads.

**Fixture:** `mcp-server/tests/fixtures/auto-discover-plugin/`
```
auto-discover-plugin/
├── .claude-plugin/plugin.json    ← {"name": "auto-test", "version": "1.0.0"}
├── recipes/hello.yaml            ← minimal valid recipe
├── tools/echo.ts                 ← minimal tool stub
├── tools/_helper.ts              ← should be skipped
├── triggers/ping.ts              ← minimal trigger script
├── triggers/ping.trigger.yaml    ← sidecar
├── agent-clis/test-cli.mjs       ← minimal provider stub (default export)
└── renderers/custom-thing.mjs    ← minimal renderer stub
```

Add the test file is already in `package.json`'s `"test"` script (it was added in Phase 2 of the prior plan).

### Task 1.6: Docs

**File:** `docs/plugins.md`

Add a new section after "Plugin manifest" titled **"Auto-discovery for clawdevbox extensions"** with:
- The uniform 3-tier resolution rule.
- A table mapping capability → default dir → file pattern → id derivation.
- The polymorphic field type signature.
- Examples for each capability.
- The trigger sidecar shape.
- Renderer registration notes (built-in collision rules).

**File:** `docs/MCP-TOOLS-REFERENCE.md`

Regenerate via `python docs/scripts/compose_master_doc.py`.

### Task 1.7: Commit cadence

One commit per logical unit:

1. `feat(manifest): polymorphic clawdevbox capability fields + renderer entry type`
2. `feat(validators): polymorphic capability + renderer entry validators`
3. `feat(manifest): generic resolveCapability + five auto-discovery wrappers`
4. `refactor(renderers): consume resolved plugin renderers from workspace`
5. `test(manifest): auto-discovery for all five capabilities`
6. `docs(plugins): auto-discovery rules + per-capability conventions`

After commit 5, run full `npm test` to confirm 351+ tests pass with the new additions (~15 new = 366+).

After commit 6, regenerate master ref and commit.

---

## Rules
- **NEVER use Haiku.**
- `npm test` and `npm run typecheck` after EVERY commit.
- Co-authored-by trailer.
- Stay on `main`.
- Pre-existing 3 typecheck errors stay. No new errors.

## Deliverables
1. Git SHAs (6-7 commits)
2. Final test count
3. Final typecheck summary
4. Output of `grep -rn "clawdevbox.recipes\|clawdevbox.tools" mcp-server/src` — should show the new polymorphic handling everywhere.
5. Confirmation that existing sample plugins (`samples/plugins/ado`, the 4 in `clawdevbox-plugins`, agency-provider) still load cleanly — run a smoke test or rely on `migrated-plugins.test.mjs`.
6. Final HEAD SHA.
