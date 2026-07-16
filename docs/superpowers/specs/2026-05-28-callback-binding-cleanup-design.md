# Callback-binding cleanup + agency .mcp.json cwd fix — Design

**Date:** 2026-05-28
**Author:** session 817a3d5e (paired with devuser)
**Status:** Approved, ready for implementation plan

## Goal

Land two changes in a single PR (two commits) that together clear the way
for the upcoming **trigger → live agent** L3 wiring:

1. **F — Dead-code purge.** Remove the entire `binds_callback_to_*`
   callback-binding mechanism from kernel, DB, validators, tools, tests,
   the four `plugins/ado/triggers/*.ts` scripts, and their entries in
   `plugins/ado/.claude-plugin/plugin.json`. After this commit the
   dispatcher has exactly **one** binding mode: script binding.

2. **G — Agency `.mcp.json` cwd fix.** Stop writing `.mcp.json` and
   `agency.toml` via `ctx.writeWorkspaceFile` (which resolves against
   `ws.projectDir`) in `C:\git\agency-provider\agency-provider.mjs`. Use
   the shared `writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp)`
   helper plus a direct `fs.writeFileSync` for `agency.toml`. Fixes the
   silent MCP disconnect that surfaced as ENOENT on WI 4547615.

Both changes are independent of L3 in the sense that **nothing that
currently ships breaks**; the dispatcher's script binding (the most-used
path) is unchanged, and the agency cwd fix is a strict bug fix.

## Non-goals

- L3 callers (`recipe-runner` interactive mode, `/callback/<fire_id>`
  handler, `main-agent` migration to `SessionConductor`). Separate plan.
- Re-writing the four ado/* trigger scripts against the new L3 model
  (user explicitly opted to delete them and start fresh later).
- Updating `subscriber_thread_id` template defaults in
  `template-store.ts` — only what's coupled to `binds_callback_to`
  goes; the broader template surface is L3's problem.
- Touching `samples/triggers/*` or `plugins/ado/skills/*` even though
  they mention the removed trigger ids — they're not loaded at runtime,
  not part of the kernel surface, and not blocking L3.

## Why a clean slate (and not a partial removal)

The current state has THREE "callback binding" values:

| Value | Status | What dispatcher does |
|---|---|---|
| `binds_callback_to_recipe: <id>` | Implemented | runs recipe (Path A) |
| `binds_callback_to: 'agent_session_resume'` | Stub | throws and dead-letters |
| `binds_callback_to: 'thread_resume'` | Declared in manifest, **never matched in dispatcher** | falls through to script binding silently |

`thread_resume` is the worst of the three: manifests declare it,
validators accept it, runtime ignores it. Keeping any partial version of
this mechanism would force every L3 PR to keep pretending the dead
fields matter. Per user decision (this session), all three go.

## Architecture

Single PR. Two commits, in this order:

1. **Commit 1 (F):** dead-code purge across kernel, DB, manifest, tests
2. **Commit 2 (G):** agency-provider cwd fix (lives in a separate repo;
   committed there as a third commit but bundled in the same PR
   conceptually — see "Cross-repo coordination" below)

After F, the dispatcher's `runFire` body collapses from a 3-branch
conditional to a single `runScriptBinding(...)` call. The trigger TYPE
manifest's role narrows: trigger types still declare scripts and
parameters; they no longer declare what runs when the script signals an
event. That coupling moves to L3.

## Components

### F.1 — Dispatcher simplification

**File:** `mcp-server/src/dispatcher.ts`

- Delete the `bindsToRecipe` / `bindsTo` resolution block (current lines
  308–313)
- Delete the `runRecipeBinding` private method and its call site
- Delete the `agent_session_resume` branch and the exported
  `AGENT_SESSION_RESUME_NOT_IMPLEMENTED` constant (line 49)
- Drop `binds_callback_to` / `binds_callback_to_recipe` from the local
  `TriggerRow` interface (lines 64–65)
- `runFire`'s body becomes "always `runScriptBinding`"
- Drop the JSDoc bullets at lines 12–13 that describe the removed
  binding modes

### F.2 — DB migration V2

**File:** `mcp-server/src/db/migrations.ts`

Append a new entry to the `migrations` array:

```ts
{
  version: 2,
  up: (db) => {
    db.exec(`
      ALTER TABLE triggers DROP COLUMN binds_callback_to;
      ALTER TABLE triggers DROP COLUMN binds_callback_to_recipe;
    `);
  },
}
```

SQLite 3.35+ supports `DROP COLUMN`. better-sqlite3 bundles 3.40+. The
existing migration runner (`./index.ts`) wraps each migration in a
transaction, so on failure V1 remains intact and the server refuses to
start with a clear error.

No data backfill needed. Pre-existing rows silently lose those fields on
upgrade.

### F.3 — Storage + tools surgical removals

Each file gets the same shape of edit: drop the two field names from
SQL projections, interface declarations, zod schemas, parameter lists,
and any conditional emit/merge logic. Specific anchors:

| File | Lines to touch |
|---|---|
| `mcp-server/src/triggers-store.ts` | 59–60 (interface), 81–82, 141–144, 198, 207, 221–222, 264–265 |
| `mcp-server/src/db/recipe-steps-store.ts` | 34–35 (interface), 425–426 (insert args) |
| `mcp-server/src/recipe-step-tools.ts` | 136, 158–159 |
| `mcp-server/src/tools/trigger.ts` | 156–159 (auto-template emit), 646–647, 669–670 (register schema), 749–750, 767, 787–788 (update schema) |
| `mcp-server/src/template-store.ts` | 45–46 (interface), 181 (manifest emit) |
| `mcp-server/src/manifest/load-plugin.ts` | 795–800 (sidecar parse) |
| `mcp-server/src/validators.ts` | 306–315 (trigger-level), 711–733 (step.triggers mutual exclusion) |
| `mcp-server/src/workspace.ts` | 81–91 (RegisteredTriggerType fields + JSDoc) |
| `mcp-server/src/cli/start.ts` | 666–667, 700–701 (triggers projection) |

### F.4 — Test cleanup

Delete entirely:

- `dispatcher.test.mjs` lines 286–325 (`agent_session_resume binding
  throws and dead-letters`)
- `dispatcher.test.mjs` lines 329 onward (`recipe binding via injected
  runRecipeFn captures triggerId+fireId`) — and the `runRecipeFn`
  injection seam in the `Dispatcher` constructor if it's no longer used
  elsewhere (verify by grep)
- `trigger-templates.test.mjs` line 303 (`trigger.register with
  subscriber_thread_id sets binds_callback_to thread_resume`)
- `validators.test.mjs` cases at lines 206–238 that exercise the removed
  validator branches

Edit in place:

- `cron-api.test.mjs` line 78, 86 — drop columns from the
  `insertTrigger` helper's SQL + bound params
- `dispatcher-fires-bus-subscription.test.mjs` lines 65, 77–78 — same
- `dispatcher.test.mjs` lines 46, 58–59 — same (in the surviving
  `insertTrigger` helper)
- `smoke.test.mjs` line 631 — replace the
  `binds_callback_to_recipe === 'pr-review'` assertion with one that
  verifies the trigger type was loaded at all (since we're deleting the
  trigger type itself in F.5, this assertion may simply go away)
- `recipe-real-e2e.test.mjs` line 505 — drop the field from the test's
  trigger declaration

Add new test:

- `tests/db-migrations.test.mjs` (new) — creates an in-memory DB,
  applies V1 only, INSERTs a row with the old columns populated, runs
  V2, asserts the columns are gone and other column values survived

### F.5 — Plugin manifest + trigger script deletion

Delete:

- `plugins/ado/triggers/ado-new-pr-watcher.ts`
- `plugins/ado/triggers/ado-comment-watcher.ts`
- `plugins/ado/triggers/ado-pr-pulse-watcher.ts`
- `plugins/ado/triggers/ado-new-work-item-watcher.ts`

Edit `plugins/ado/.claude-plugin/plugin.json`:

- Remove all four `trigger_types[]` entries (current lines 33–91)
- If the `trigger_types` key now has an empty array, remove the key
  entirely (cleaner than `"trigger_types": []`)

For the ado recipes that those trigger types referenced
(`pr-review.yaml`, `triage-work-item.yaml`,
`respond-to-pr-comment.yaml`), grep the repo for non-trigger references
to each recipe id. Delete a recipe yaml ONLY if no surviving code path
references it. Leave the recipe alone otherwise — it might be invoked
manually or by an agent skill.

Verification command (run BEFORE deleting each recipe):

```powershell
# Replace <recipe-id> with one of pr-review|triage-work-item|respond-to-pr-comment
# A clean delete is safe ONLY if the only matches are:
#  - the recipe yaml itself
#  - the trigger types being removed in F.5
#  - sample/sample-test files (samples/triggers/*)
#  - historical specs/plans
grep -r "<recipe-id>" C:\git\clawdevbox --include="*.{ts,mjs,yaml,json,md}"
```

If grep surfaces a `plugins/*/skills/*` or another `plugins/*/recipes/*`
reference, keep the yaml.

### F.6 — Doc cleanup

Edit (remove `binds_callback_to_*` mentions):

- `docs/MCP-TOOLS-REFERENCE.md`
- `docs/tools/trigger.md`
- `docs/tools/recipe.md` (if it cross-references the binding mechanism)
- `docs/plugins.md`
- `docs/design.md`
- `docs/LIFECYCLES.md`
- `docs/agent-clis.md`

Leave alone (historical, not living docs):

- `docs/plans/2026-05-14-*.md`
- `docs/specs/2026-05-1[45]-*.md`
- `docs/superpowers/specs/2026-05-26-ado-work-item-recipes-design.md`

### G — Agency provider .mcp.json cwd fix

**File:** `C:\git\agency-provider\agency-provider.mjs`

Current bug (lines 244, 250 + 327):

```js
ctx.writeWorkspaceFile('.mcp.json', buildMcpJson(opts.mcp));  // <- ws.projectDir
ctx.writeWorkspaceFile('agency.toml', buildAgencyToml(opts.mcp));
// ...
const pty = ctx.spawnPty(bin, argv, {
  cwd: opts.workspaceInfo.path,  // <- DIFFERENT path
  ...
});
```

When `opts.workspaceInfo.path !== ws.projectDir` (any recipe whose
workspace differs from the server's project_dir), Copilot CLI looks for
`.mcp.json` in the cwd it was spawned with and finds nothing. Result:
silent MCP disconnect; ENOENT downstream.

Fix:

```js
// Top of file — extend the helpers import
async function loadSyncHelpers() {
  return import('clawdevbox/agent-clis');
}

// In spawnSession:
const { writeMcpJson } = await loadSyncHelpers();
writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);
writeFileSync(
  join(opts.workspaceInfo.path, 'agency.toml'),
  buildAgencyToml(opts.mcp),
);
```

Also:

- Delete the local `buildMcpJson` helper (lines roughly 90–148) — fully
  superseded by the shared `writeMcpJson`
- Keep `buildAgencyToml` — agency-specific TOML emission
- `writeFileSync` is from `node:fs` (already imported as `existsSync` —
  extend the import to `{ existsSync, writeFileSync }`)

**Test:** extend `test-fixture.mjs` with a case that spies on the
function passed to `writeMcpJson` (or asserts via a tmp dir) that the
`.mcp.json` file is written at `opts.workspaceInfo.path` when that path
differs from `ws.projectDir`.

## Cross-repo coordination

F lives in `C:\git\clawdevbox\` (one commit). G lives in
`C:\git\agency-provider\` (one commit). The two repos are git
submodule-free but the agency-provider is junctioned into
`~/.clawdevbox/plugins/agency-cli/` so the running kernel picks it up.

Sequence:

1. Land F first (kernel-only). Agency-provider still has the old `.mcp.json` bug
   but nothing in F changes the agency contract.
2. Land G. Verify against a real spawn whose `workspaceInfo.path !==
   ws.projectDir`.

Both commits are author-attributable to this session; both get the
`Co-authored-by: Copilot` trailer.

## Data flow (post-F)

**Before:**

```
trigger fires → dispatcher.runFire()
  ├─ if trigger.binds_callback_to_recipe → runRecipeBinding()
  ├─ elif binds_callback_to === 'agent_session_resume' → throw
  └─ else → runScriptBinding()
```

**After:**

```
trigger fires → dispatcher.runFire() → runScriptBinding()
```

Trigger scripts continue to receive their existing `runOnce({...})`
contract. What changes is that no trigger script can rely on the
dispatcher to "automatically start a recipe" — that coupling moves to
L3, where the trigger script (or any future caller) explicitly invokes
a kernel call that dispatches into a SessionConductor.

## Testing strategy

| Phase | Command | Pass criteria |
|---|---|---|
| Per-file dev loop | `npm run typecheck` | clean |
| Per-file dev loop | `node --import tsx --test tests/<file>.test.mjs` | targeted passes |
| Before commit F | `node --import tsx --test tests/dispatcher.test.mjs tests/validators.test.mjs tests/trigger-templates.test.mjs tests/smoke.test.mjs tests/cron-api.test.mjs tests/dispatcher-fires-bus-subscription.test.mjs tests/db-migrations.test.mjs` | all touched tests pass |
| Before commit F | `npm test` | ≥ baseline-pre-existing-flakes; the 2 deleted dispatcher tests + 1 deleted trigger-templates test reduce the total by 3 |
| Before commit G | `cd C:\git\agency-provider; node test-fixture.mjs` | exits 0, new cwd assertion passes |
| Final | `npm test` in clawdevbox; `node test-fixture.mjs` in agency-provider | both clean |

Baseline: full suite was 495 pass / 4 fail (pre-existing flakes) at the
end of the previous session. Expect F to land at ~492 pass / 4 fail
(same flake set, three fewer total because of deleted tests + one new
migration test).

## Error handling / migration safety

- V2 migration runs inside a transaction. On failure the DB stays at V1
  and the server fails to start with a clear error. Standard
  `./migrations` contract.
- No data backfill — pre-existing rows lose two fields silently. Per
  user, acceptable for a pre-1.0 tool.
- DB rows in `triggers` table whose `type` referenced the deleted ado/*
  trigger types will fail at next dispatch with the existing "trigger
  type not registered" error path. No new error handling needed; the
  user can delete those rows via the /triggers UI.
- The agency provider fix is a strict bug fix; no migration concerns.

## Out-of-scope follow-ups (track separately)

- L3 wiring: `/callback/<fire_id>` → `SessionConductor.dispatch`
- `recipe-runner` `spawnMode: 'interactive'` plumbing
- `main-agent.ts` migration to SessionConductor
- New trigger scripts for ado/* (post-L3, with the new model in hand)
- Updates to `subscriber_thread_id` template defaults once L3 picks a
  replacement mechanism
- Push the 4 unpushed commits from prior sessions (clawdevbox `32e82e5`
  + `6a25b76`, agency-provider `8ea215d` + `5abddb9`) along with the
  two new commits from this PR
