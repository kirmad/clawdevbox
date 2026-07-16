# Callback-binding cleanup + agency cwd fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `binds_callback_to_*` callback-binding mechanism in its entirety (kernel, DB v2 migration, validators, tools, tests, four ado/* trigger scripts, manifest entries, docs), and fix `agency-provider.mjs` to write `.mcp.json` / `agency.toml` at `opts.workspaceInfo.path` instead of `ws.projectDir`. Spec: `docs/superpowers/specs/2026-05-28-callback-binding-cleanup-design.md`.

**Architecture:** Two logical changes shipped in one PR. **F** (commit 1) is a strictly subtractive sweep across ~12 source files + 6 tests + 1 manifest + 1 DB migration. **G** (commit 2) is a targeted bug fix in a sibling repo (`C:\git\agency-provider\`). After F, dispatcher's `runFire` collapses to a single `runScriptBinding(...)` call.

**Tech Stack:** TypeScript (mcp-server kernel), node:test, better-sqlite3 with V2 migration, plain JavaScript ESM (agency-provider plugin).

---

## File Structure

### F — files modified

| File | Responsibility | Action |
|---|---|---|
| `mcp-server/src/db/migrations.ts` | DB schema migrations | Append V2 |
| `mcp-server/tests/db-migrations.test.mjs` | NEW | Verify V2 drops columns + preserves data |
| `mcp-server/src/dispatcher.ts` | Fire dispatch | Delete `runRecipeBinding`, `RunRecipeBindingArgs`, `RunRecipeBindingResult`, `runRecipeFn`, `AGENT_SESSION_RESUME_NOT_IMPLEMENTED`, binding-resolution block, `TriggerRow` binding fields, unused imports |
| `mcp-server/src/validators.ts` | Manifest + recipe validation | Delete trigger-level `binds_callback_to*` validation + mutual-exclusion check |
| `mcp-server/src/triggers-store.ts` | DB-backed trigger registry | Delete interface fields, SQL columns from INSERT/UPDATE/SELECT |
| `mcp-server/src/db/recipe-steps-store.ts` | Recipe step rows | Delete `TriggerDecl` binding fields |
| `mcp-server/src/recipe-step-tools.ts` | `trigger.declare` plumbing | Delete from SQL bound params + zod schema |
| `mcp-server/src/tools/trigger.ts` | MCP trigger tools | Delete from `trigger.register` / `trigger.update_template` zod schemas + projections |
| `mcp-server/src/template-store.ts` | Agent-authored templates | Delete from `TemplateManifest` + `OneOffWriteOptions` |
| `mcp-server/src/manifest/load-plugin.ts` | Plugin manifest parser | Delete sidecar parsing of binding fields |
| `mcp-server/src/workspace.ts` | `PluginTriggerType` interface | Delete binding fields + JSDoc |
| `mcp-server/src/cli/start.ts` | HTTP API | Delete binding fields from `/api/triggers/types` + `/api/triggers` projections |
| `mcp-server/tests/dispatcher.test.mjs` | Dispatcher tests | Delete 2 obsolete tests, update `insertTrigger` helper |
| `mcp-server/tests/validators.test.mjs` | Validator tests | Drop binding-related assertions |
| `mcp-server/tests/trigger-templates.test.mjs` | Template tests | Delete 1 obsolete test |
| `mcp-server/tests/smoke.test.mjs` | Smoke test | Drop `binds_callback_to_recipe` assertion |
| `mcp-server/tests/recipe-real-e2e.test.mjs` | E2E test | Drop `binds_callback_to_recipe` from `trigger.create_template` call |
| `mcp-server/tests/cron-api.test.mjs` | Cron API tests | Update `insertTrigger` helper |
| `mcp-server/tests/dispatcher-fires-bus-subscription.test.mjs` | Bus tests | Update `insertTrigger` helper |
| `plugins/ado/.claude-plugin/plugin.json` | ADO plugin manifest | Remove `trigger_types[]` entries (4) |
| `plugins/ado/triggers/ado-new-pr-watcher.ts` | Trigger script | Delete file |
| `plugins/ado/triggers/ado-comment-watcher.ts` | Trigger script | Delete file |
| `plugins/ado/triggers/ado-pr-pulse-watcher.ts` | Trigger script | Delete file |
| `plugins/ado/triggers/ado-new-work-item-watcher.ts` | Trigger script | Delete file |
| `docs/MCP-TOOLS-REFERENCE.md`, `docs/tools/trigger.md`, `docs/tools/recipe.md`, `docs/plugins.md`, `docs/design.md`, `docs/LIFECYCLES.md`, `docs/agent-clis.md` | Living docs | Remove `binds_callback_to_*` mentions |

### G — files modified (separate repo)

| File | Action |
|---|---|
| `C:\git\agency-provider\agency-provider.mjs` | Use shared `writeMcpJson` for `.mcp.json`; direct `writeFileSync` for `agency.toml`; delete inline `buildMcpJson` |
| `C:\git\agency-provider\test-fixture.mjs` | Add assertion that the cwd-mismatch case writes to `opts.workspaceInfo.path` |

---

## Task 1: V2 migration + migration test

**Files:**
- Modify: `mcp-server/src/db/migrations.ts:211-218`
- Create: `mcp-server/tests/db-migrations.test.mjs`
- Modify: `mcp-server/package.json:34` (register new test file)

- [ ] **Step 1: Add migration V2 to drop the two columns**

Append a second entry to the `migrations` array at the bottom of `mcp-server/src/db/migrations.ts`:

```ts
export const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(V1_SCHEMA);
    },
  },
  {
    version: 2,
    up: (db) => {
      // F (2026-05-28): drop the binds_callback_to_* mechanism in its
      // entirety — kernel no longer has any callback-binding modes
      // beyond script binding. Spec:
      // docs/superpowers/specs/2026-05-28-callback-binding-cleanup-design.md
      db.exec(`
        ALTER TABLE triggers DROP COLUMN binds_callback_to;
        ALTER TABLE triggers DROP COLUMN binds_callback_to_recipe;
      `);
    },
  },
];
```

- [ ] **Step 2: Write the migration test**

Create `mcp-server/tests/db-migrations.test.mjs` with the full content:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { migrations } from '../src/db/migrations.ts';

function openWithV1Only() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  const v1 = migrations.find((m) => m.version === 1);
  assert.ok(v1, 'V1 migration must exist');
  db.transaction(() => {
    v1.up(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  })();
  return db;
}

function applyV2(db) {
  const v2 = migrations.find((m) => m.version === 2);
  assert.ok(v2, 'V2 migration must exist');
  db.transaction(() => {
    v2.up(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
  })();
}

test('migration V2 drops binds_callback_to and binds_callback_to_recipe columns', () => {
  const db = openWithV1Only();

  // Sanity: V1 schema has the columns.
  const v1Cols = db
    .prepare(`PRAGMA table_info(triggers)`)
    .all()
    .map((c) => c.name);
  assert.ok(v1Cols.includes('binds_callback_to'), 'V1 should have binds_callback_to');
  assert.ok(v1Cols.includes('binds_callback_to_recipe'), 'V1 should have binds_callback_to_recipe');

  // Insert a workspace + a trigger row with the soon-to-be-removed
  // columns populated, so we can prove unrelated data survives.
  db.prepare(
    `INSERT INTO workspaces (id, path, created_at) VALUES ('ws_keep', 'C:/keep', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO triggers (
       id, workspace_id, type, params_json, cron_mode,
       binds_callback_to, binds_callback_to_recipe,
       registered_at
     ) VALUES ('t_keep', 'ws_keep', 'demo.t', '{}', 'inherit',
              'agent_session_resume', 'pr-review', 99)`,
  ).run();

  applyV2(db);

  const v2Cols = db
    .prepare(`PRAGMA table_info(triggers)`)
    .all()
    .map((c) => c.name);
  assert.ok(!v2Cols.includes('binds_callback_to'), 'V2 should drop binds_callback_to');
  assert.ok(!v2Cols.includes('binds_callback_to_recipe'), 'V2 should drop binds_callback_to_recipe');

  // Other column values survive.
  const row = db.prepare(`SELECT id, workspace_id, type, registered_at FROM triggers WHERE id = ?`).get('t_keep');
  assert.equal(row.id, 't_keep');
  assert.equal(row.workspace_id, 'ws_keep');
  assert.equal(row.type, 'demo.t');
  assert.equal(row.registered_at, 99);

  db.close();
});

test('migration V2 is idempotent when applied via runMigrations', async () => {
  // Loading runMigrations after the inline test above so the import is
  // not hoisted before the V2 inline assertion runs.
  const { runMigrations } = await import('../src/db/index.ts');
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  // Running again is a no-op (runMigrations is version-gated).
  runMigrations(db);
  const max = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get();
  assert.ok(max.v >= 2, `expected schema_version >= 2, got ${max.v}`);
  const cols = db.prepare(`PRAGMA table_info(triggers)`).all().map((c) => c.name);
  assert.ok(!cols.includes('binds_callback_to'));
  assert.ok(!cols.includes('binds_callback_to_recipe'));
  db.close();
});
```

- [ ] **Step 3: Register the new test in package.json**

Open `mcp-server/package.json`. Locate the `"test"` script (currently line 34). It is a `node --import tsx --test ...` invocation listing each test file. Insert `tests/db-migrations.test.mjs` into the file list, alphabetically. For example, if the existing line is:

```
"test": "node --import tsx --test tests/agent-clis.test.mjs tests/agent-clis-capabilities.test.mjs tests/cron-api.test.mjs ..."
```

Insert `tests/db-migrations.test.mjs` immediately after `tests/cron-api.test.mjs` (keeping alpha order: ...cron-api → db-migrations → dispatcher...). Verify by inspection that the new path is present exactly once.

- [ ] **Step 4: Run the migration test**

Run from `mcp-server/`:

```powershell
node --import tsx --test tests/db-migrations.test.mjs
```

Expected: 2 tests pass.

- [ ] **Step 5: Typecheck**

Run from `mcp-server/`:

```powershell
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 6: Commit**

```powershell
cd C:\git\clawdevbox
git add mcp-server/src/db/migrations.ts mcp-server/tests/db-migrations.test.mjs mcp-server/package.json
git commit -m "feat(db): add V2 migration to drop binds_callback_to columns" -m "Drops both binds_callback_to and binds_callback_to_recipe from the triggers table as part of the dead-code purge described in docs/superpowers/specs/2026-05-28-callback-binding-cleanup-design.md. Includes tests/db-migrations.test.mjs (2 tests): one that proves the column drop + that unrelated data survives, and one that proves runMigrations is idempotent after V2." -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Atomic removal of binds_callback_to_* across kernel + tests

**Files:**
- Modify: `mcp-server/src/dispatcher.ts:11-14, 49, 64-65, 84-96, 105-107, 119, 135, 308-313, 315-341, 442-511, top of file imports`
- Modify: `mcp-server/src/validators.ts:306-315, 711-733`
- Modify: `mcp-server/src/triggers-store.ts:59-60, 81-82, 141-144, 198, 207, 221-222, 264-265`
- Modify: `mcp-server/src/db/recipe-steps-store.ts:30-40 (TriggerDecl), 132-147 (INSERT), 158-159 (run args), 416-435 (diffTriggers keyOf)`
- Modify: `mcp-server/src/recipe-step-tools.ts:136, 158-159`
- Modify: `mcp-server/src/tools/trigger.ts:155-160 (projectType), 646-647, 669-670, 749-750, 765-768, 787-788`
- Modify: `mcp-server/src/template-store.ts:45-46 (TemplateManifest), 159-181 (OneOffWriteOptions + writeOneOffTemplate)`
- Modify: `mcp-server/src/manifest/load-plugin.ts:795-800`
- Modify: `mcp-server/src/workspace.ts:80-91`
- Modify: `mcp-server/src/cli/start.ts:666-667, 700-701`
- Modify: `mcp-server/tests/dispatcher.test.mjs:43-65 (insertTrigger), 286-396 (delete 2 tests)`
- Modify: `mcp-server/tests/validators.test.mjs:196-242 (drop binding assertions from 2 tests)`
- Modify: `mcp-server/tests/trigger-templates.test.mjs:303-313 (delete 1 test)`
- Modify: `mcp-server/tests/smoke.test.mjs:631 (drop assertion)`
- Modify: `mcp-server/tests/recipe-real-e2e.test.mjs:505 (drop key from create_template args)`
- Modify: `mcp-server/tests/cron-api.test.mjs:73-91 (insertTrigger)`
- Modify: `mcp-server/tests/dispatcher-fires-bus-subscription.test.mjs:60-85 (insertTrigger)`

This task is large but each edit is mechanical surgery against a precise line range. Follow the order below — it's bottom-up (interfaces last, consumers first) so typecheck stays green between sub-steps if you choose to incrementally verify.

- [ ] **Step 1: dispatcher.ts — top-level deletions**

Open `mcp-server/src/dispatcher.ts`.

Replace the JSDoc block at lines 11-14 (the bullet list describing binding modes) so the comment reads:

```ts
 *
 * Each claimed fire is run via `runFire()`, which always dispatches to
 * the script binding. The `binds_callback_to_*` mechanism was removed
 * on 2026-05-28 (see docs/superpowers/specs/2026-05-28-callback-binding-cleanup-design.md).
```

Delete line 49 (the `AGENT_SESSION_RESUME_NOT_IMPLEMENTED` export).

Delete lines 64-65 (the `binds_callback_to` and `binds_callback_to_recipe` fields from `TriggerRow`).

Delete lines 84-96 entirely (the `RunRecipeBindingArgs` and `RunRecipeBindingResult` interfaces).

Delete the `runRecipeFn?` field from `DispatcherOptions` (line 105-106 — the `/** Test hook... */` JSDoc plus the field line).

Delete the `runRecipeFn` class field declaration (line 119).

Delete the `runRecipeFn` assignment in the constructor (line 135).

Delete the `bindsToRecipe`/`bindsTo` resolution block at lines 308-313.

Replace the runFire body's `if (bindsToRecipe) { ... } else if (...) { ... } else { ... }` chain (lines 315-341) with:

```ts
      logger.debug(
        { fire_id: fire.fire_id, trigger_id: trigger.id, attempt: fire.attempt },
        'dispatcher: running fire',
      );

      const result = await this.runScriptBinding(fire, trigger, outDir, typeManifest);
```

Note that `result` is now declared with `const`; remove the prior `let result: { ... }` declaration line (currently line 315) — it's no longer needed because the single assignment is in the const declaration above.

Delete the entire `runRecipeBinding` method (lines 442-511) and the `// ------- bindings` header comment immediately above it.

Now clean up the imports at the top of the file. After the deletions above, the following imports are no longer used by the surviving code:
- `recipePath`, `Workspace` from `./workspace.ts` — verify with grep; `Workspace` IS still used as the type of `this.ws`. `recipePath` was only used in `runRecipeBinding` — delete it from the import.
- `resolveRead` from `./scope.ts` — only used in `runRecipeBinding` — delete.
- `runRecipe` from `./recipe-runner.ts` — only used in `runRecipeBinding` — delete; if the entire `./recipe-runner.ts` import becomes empty, remove the line.
- `resolveConfig` from `./config.ts` — only used in `runRecipeBinding` — delete; remove the import line entirely.
- `resolveWorkspacesRoot` from `./workspaces-store.ts` — only used in `runRecipeBinding` — delete; remove the import line entirely.

After this step, run `npm run typecheck` from `mcp-server/`. Expected: clean exit. (TriggerRow's binding fields are now gone from dispatcher.ts; other files still have them in their own interfaces, which is fine — there are no cross-file type clashes here.)

- [ ] **Step 2: validators.ts — drop validation**

Open `mcp-server/src/validators.ts`.

Delete lines 306-315 (the `t.binds_callback_to` validation block AND the `t.binds_callback_to_recipe` validation block — 10 lines total).

Delete lines 711-734 (the entire block from the `// binds_callback_to_recipe and binds_callback_to are mutually exclusive.` comment through the closing brace of the `if (hasActionBinding && e.binds_callback_to !== 'thread_resume')` block).

After this step, typecheck.

- [ ] **Step 3: tools/trigger.ts — drop schemas + projections**

Open `mcp-server/src/tools/trigger.ts`.

In the `projectType` helper (lines 154-174), delete the `binding` variable definition (lines 155-160) and the `...binding` spread in the return object. The returned object should no longer reference `binds_callback_to*` at all.

In `trigger.create_template`'s zod schema (around line 636-648), delete the two lines:
```ts
        binds_callback_to_recipe: z.string().optional(),
        binds_callback_to: z.literal('thread_resume').optional(),
```

In the same handler, delete the two lines that copy these fields into the manifest (around line 669-670):
```ts
      if (args.binds_callback_to_recipe !== undefined) manifest.binds_callback_to_recipe = args.binds_callback_to_recipe;
      if (args.binds_callback_to !== undefined) manifest.binds_callback_to = args.binds_callback_to;
```

In `trigger.update_template`'s zod schema (around line 740-751), delete the same two lines.

In the `manifestKeys` array (around line 765-768), remove `'binds_callback_to_recipe'` and `'binds_callback_to'` from the list — the remaining keys are `'description', 'runtime', 'default_cron', 'identity_param', 'accepts_webhook', 'parameters'`.

In the merge block (around line 787-788), delete the two `if (args.binds_callback_to_recipe !== undefined) ...` and `if (args.binds_callback_to !== undefined) ...` lines.

After this step, typecheck.

- [ ] **Step 4: template-store.ts — drop interface field + writeOneOffTemplate option**

Open `mcp-server/src/template-store.ts`.

Delete lines 45-46 from `TemplateManifest`:
```ts
  binds_callback_to_recipe?: string;
  binds_callback_to?: 'thread_resume';
```

Delete the `bindsCallbackTo?: 'thread_resume';` field from `OneOffWriteOptions` (line 164).

Delete the `if (opts.bindsCallbackTo) manifest.binds_callback_to = opts.bindsCallbackTo;` line inside `writeOneOffTemplate` (line 181).

After this step, typecheck. Expected to show errors in callers (`tools/trigger.ts` after step 3 should be fine; check `tools/trigger.ts` for any remaining `bindsCallbackTo` references — there may be one calling `writeOneOffTemplate`).

If typecheck flags a `writeOneOffTemplate({ ..., bindsCallbackTo })` call in `tools/trigger.ts`, that came from the agent-authored trigger registration path. Locate the call site (likely around the `subscriber_thread_id` handling near line 470-490 in `tools/trigger.ts`) and remove `bindsCallbackTo` from the options object. The `subscriber_thread_id` itself stays — it's persisted via `state_json` per the `triggers-store.ts:117-122` round-trip. Only the manifest field goes.

- [ ] **Step 5: recipe-steps-store.ts — drop TriggerDecl fields + SQL columns**

Open `mcp-server/src/db/recipe-steps-store.ts`.

Delete lines 34-35 from `TriggerDecl`:
```ts
  binds_callback_to?: string;
  binds_callback_to_recipe?: string;
```

In the INSERT statement (around line 131-148), delete the `binds_callback_to, binds_callback_to_recipe,` column names from the column list AND the corresponding two `?` placeholders. Then delete the two `opts.decl.binds_callback_to ?? null,` and `opts.decl.binds_callback_to_recipe ?? null,` lines in the `.run(...)` args. Count the column list, placeholder count, and arg count carefully — they must match. Verify by inspection.

In the `diffTriggers` helper's `keyOf` function (lines 416-435), delete the two lines:
```ts
      binds_callback_to: t.binds_callback_to ?? null,
      binds_callback_to_recipe: t.binds_callback_to_recipe ?? null,
```

After this step, typecheck.

- [ ] **Step 6: recipe-step-tools.ts — drop from declare**

Open `mcp-server/src/recipe-step-tools.ts`.

Locate the `trigger.declare` SQL insert (around line 136). Drop the `binds_callback_to, binds_callback_to_recipe,` from the column list AND the two corresponding `?` placeholders AND the two `opts.decl.binds_callback_to ?? null,` / `opts.decl.binds_callback_to_recipe ?? null,` lines in the `.run(...)` args (lines 158-159).

Verify column/placeholder/arg counts match.

After this step, typecheck.

- [ ] **Step 7: triggers-store.ts — drop interface fields + SQL**

Open `mcp-server/src/triggers-store.ts`.

Delete lines 59-60 from `RegisteredTrigger`:
```ts
  binds_callback_to?: 'agent_session_resume';
  binds_callback_to_recipe?: string;
```

Delete lines 81-82 from `TriggerRow`:
```ts
  binds_callback_to: string | null;
  binds_callback_to_recipe: string | null;
```

Delete lines 141-144 from `rowToRegistered` (the two `if (row.binds_callback_to)` and `if (row.binds_callback_to_recipe)` blocks).

In the INSERT/UPSERT statement (lines 193-232), remove the `binds_callback_to, binds_callback_to_recipe,` column names, the two `@binds_callback_to, @binds_callback_to_recipe,` placeholders, and the two corresponding `binds_callback_to = excluded.binds_callback_to,` and `binds_callback_to_recipe = excluded.binds_callback_to_recipe,` lines from the `ON CONFLICT DO UPDATE SET` block.

Delete lines 264-265 from the `upsert.run({ ... })` call (the two `binds_callback_to: r.binds_callback_to ?? null,` / `binds_callback_to_recipe: r.binds_callback_to_recipe ?? null,` properties).

Verify column/placeholder/property counts. After this step, typecheck.

- [ ] **Step 8: workspace.ts — drop PluginTriggerType fields**

Open `mcp-server/src/workspace.ts`.

Delete lines 80-91 from `PluginTriggerType` — the JSDoc for `binds_callback_to_recipe`, the field declaration, the JSDoc for `binds_callback_to`, and that field declaration. The next surviving field is `default_cron?: string;`.

After this step, typecheck.

- [ ] **Step 9: manifest/load-plugin.ts — drop sidecar parsing**

Open `mcp-server/src/manifest/load-plugin.ts`.

Delete lines 795-800 — the `binds_callback_to_recipe:` and `binds_callback_to:` properties in the returned `PluginTriggerType` object literal.

After this step, typecheck.

- [ ] **Step 10: cli/start.ts — drop from API projections**

Open `mcp-server/src/cli/start.ts`.

In `/api/triggers/types` (around line 656-672), delete lines 666-667 (the two `binds_callback_to_recipe: t.binds_callback_to_recipe,` and `binds_callback_to: t.binds_callback_to,` properties).

In `/api/triggers` (around line 680-717), delete lines 700-701 (the two `binds_callback_to_recipe: type?.binds_callback_to_recipe ?? null,` and `binds_callback_to: type?.binds_callback_to ?? null,` properties).

After this step, typecheck.

- [ ] **Step 11: tests/dispatcher.test.mjs — update helper + delete 2 tests**

Open `mcp-server/tests/dispatcher.test.mjs`.

Update the `insertTrigger` helper (lines 41-66):
- Remove `binds_callback_to, binds_callback_to_recipe,` from the column list
- Remove the two corresponding `?` placeholders
- Remove the two `opts.binds_callback_to ?? null,` and `opts.binds_callback_to_recipe ?? null,` lines from `.run(...)`
- Verify column/placeholder/arg counts

Delete the test starting at line 286: `test('dispatcher: agent_session_resume binding throws and dead-letters', ...` through line 325 inclusive (the closing `});`).

Delete the test starting at line 329: `test('dispatcher: recipe binding via injected runRecipeFn captures triggerId+fireId', ...` through line 396 inclusive. The next surviving test is `test('dispatcher: stop() drains in-flight, ...` at line 400.

Note: after deleting the recipe-binding test, the `runRecipeFn` injection seam is no longer referenced from this test file. Task 2 step 1 already removed it from `dispatcher.ts`, so no further fix needed.

Also drop the `// ============================================================== resume binding` and `// =============================================================== recipe binding` separator comments that bracketed the deleted tests.

- [ ] **Step 12: tests/validators.test.mjs — drop binding assertions**

Open `mcp-server/tests/validators.test.mjs`.

In the `step.triggers accepts the full optional field set` test (lines 196-218), delete lines 206-207 from the trigger object:
```ts
          binds_callback_to: 'agent_session_resume',
          binds_callback_to_recipe: 'respond-to-pr-comment',
```

In the `step.triggers rejects bad binds_callback_to / max_attempts / cron` test (lines 220-242), delete line 228 (`binds_callback_to: 'bogus',`) from the trigger object, and delete line 238 from the assertions (`assert.ok(r.errors.some((e) => e.path === 'steps[0].triggers[0].binds_callback_to'));`). Rename the test to drop the `binds_callback_to` mention: `test('step.triggers rejects bad max_attempts / cron', ...`.

- [ ] **Step 13: tests/trigger-templates.test.mjs — delete 1 test**

Open `mcp-server/tests/trigger-templates.test.mjs`.

Delete the test at lines 303-313: `test('trigger.register with subscriber_thread_id sets binds_callback_to thread_resume in the auto-template', ...`.

- [ ] **Step 14: tests/smoke.test.mjs — drop assertion**

Open `mcp-server/tests/smoke.test.mjs`.

In the trigger-types listing test around lines 620-635, delete line 631:
```ts
    assert.equal(newPr.binds_callback_to_recipe, 'pr-review');
```

(Note: this test is going to start failing in a different way after Task 3 removes the `ado.new-pr-watcher` trigger type entirely. Task 3 will update this test further. For now, just remove the one assertion.)

- [ ] **Step 15: tests/recipe-real-e2e.test.mjs — drop key from create_template call**

Open `mcp-server/tests/recipe-real-e2e.test.mjs`.

In the `trigger.create_template` call around line 499-506, delete line 505:
```ts
        binds_callback_to_recipe: 'e2e-test-recipe',
```

Also update the comment at lines 496-498 to reflect that the trigger script DOES run now (no more "never invoked for recipe bindings" exception). Replace those three lines with:

```ts
      // 2. Create a trigger TYPE. After the 2026-05-28 callback-binding
      //    cleanup, every fire dispatches to the script binding — there
      //    is no longer a recipe-binding shortcut.
```

The test may need further adjustment if it depends on the recipe being invoked. Read the test body from line 499 through line 600 (or the end of the test). If the test asserts that `e2e-test-recipe` runs via dispatcher, EITHER:
- (a) update the test to invoke the recipe directly via `recipe.run` MCP tool instead of via trigger fire, OR
- (b) delete the test entirely if it has no meaningful coverage post-cleanup.

Pick the path that keeps the test meaningful with the smallest change. Document the choice inline in the commit message.

- [ ] **Step 16: tests/cron-api.test.mjs — update helper**

Open `mcp-server/tests/cron-api.test.mjs`.

Update the `insertTrigger` helper (lines 73-91): remove `binds_callback_to, binds_callback_to_recipe,` from the column list, remove the two `?` placeholders, and remove the two corresponding `.run(...)` args. Verify counts.

- [ ] **Step 17: tests/dispatcher-fires-bus-subscription.test.mjs — update helper**

Open `mcp-server/tests/dispatcher-fires-bus-subscription.test.mjs`.

Same change as Step 16, on the `insertTrigger` helper at lines 60-85.

- [ ] **Step 18: Final typecheck + targeted tests**

From `mcp-server/`:

```powershell
npm run typecheck
```

Expected: exit 0.

```powershell
node --import tsx --test tests/dispatcher.test.mjs tests/validators.test.mjs tests/trigger-templates.test.mjs tests/cron-api.test.mjs tests/dispatcher-fires-bus-subscription.test.mjs tests/db-migrations.test.mjs
```

Expected: all targeted tests pass. (The smoke and recipe-real-e2e tests are deferred to Task 3, which will update the manifest they depend on.)

- [ ] **Step 19: Commit**

```powershell
cd C:\git\clawdevbox
git add -A mcp-server/
git commit -m "refactor(kernel): remove binds_callback_to_* mechanism" -m "Spec: docs/superpowers/specs/2026-05-28-callback-binding-cleanup-design.md" -m "Removes the recipe-binding (binds_callback_to_recipe) and resume-binding (binds_callback_to: 'agent_session_resume' | 'thread_resume') mechanisms in their entirety. The dispatcher's runFire body collapses from a 3-branch conditional to a single runScriptBinding() call. Touched: dispatcher, validators, triggers-store, recipe-steps-store, recipe-step-tools, tools/trigger, template-store, manifest/load-plugin, workspace, cli/start, and matching tests. The 2 dispatcher tests that exercised the removed paths are deleted, along with 1 trigger-templates test. The recipe-real-e2e test was adjusted to no longer rely on the recipe-binding shortcut." -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Delete ado/* trigger scripts + manifest entries

**Files:**
- Delete: `plugins/ado/triggers/ado-new-pr-watcher.ts`
- Delete: `plugins/ado/triggers/ado-comment-watcher.ts`
- Delete: `plugins/ado/triggers/ado-pr-pulse-watcher.ts`
- Delete: `plugins/ado/triggers/ado-new-work-item-watcher.ts`
- Modify: `plugins/ado/.claude-plugin/plugin.json:33-91` (remove `trigger_types` entries)
- Modify: `mcp-server/tests/smoke.test.mjs:611-635` (assertion that the four trigger ids are present must go away or invert)
- Verify (do NOT delete unless orphan): `plugins/ado/recipes/pr-review.yaml`, `plugins/ado/recipes/triage-work-item.yaml`, `plugins/ado/recipes/respond-to-pr-comment.yaml`

- [ ] **Step 1: Delete the four trigger script files**

```powershell
cd C:\git\clawdevbox
Remove-Item plugins\ado\triggers\ado-new-pr-watcher.ts
Remove-Item plugins\ado\triggers\ado-comment-watcher.ts
Remove-Item plugins\ado\triggers\ado-pr-pulse-watcher.ts
Remove-Item plugins\ado\triggers\ado-new-work-item-watcher.ts
```

Verify:

```powershell
Get-ChildItem plugins\ado\triggers\
```

Expected: directory is empty (or contains only non-trigger helper files; inspect output).

- [ ] **Step 2: Remove the four trigger_types entries from plugin.json**

Open `plugins/ado/.claude-plugin/plugin.json`. Locate the `trigger_types` array (currently lines 33-91). Replace the entire array, including the comma after the preceding tool entry on line 32, with an empty array OR delete the key entirely if the structure allows.

Concretely, find the closing bracket of the `tools` array (line 32: `      { "id": "ado.get_work_item_updates", "file": "tools/get_work_item_updates.ts" }`), and look for the immediately following `,` and `"trigger_types": [ ... ]` block. Delete the comma after the `tools` array's closing `]` AND delete the entire `"trigger_types": [ ... ]` block (the key, value, and surrounding whitespace). Resulting structure should have the `tools` array as the last entry in its parent object.

Verify the JSON is still valid:

```powershell
node -e "JSON.parse(require('fs').readFileSync('plugins/ado/.claude-plugin/plugin.json', 'utf8')); console.log('valid')"
```

Expected: `valid`.

- [ ] **Step 3: Verify the ado/* recipe yamls are NOT orphans (do not delete)**

```powershell
cd C:\git\clawdevbox
grep -rn "pr-review" --include="*.{ts,mjs,yaml,json,md}" .
grep -rn "triage-work-item" --include="*.{ts,mjs,yaml,json,md}" .
grep -rn "respond-to-pr-comment" --include="*.{ts,mjs,yaml,json,md}" .
```

Inspect each list. For each recipe id, a `.yaml` is an orphan ONLY if grep surfaces nothing outside:
- the recipe yaml file itself
- the four trigger types we just removed
- sample/historical files (`samples/`, `docs/plans/`, `docs/specs/`, `docs/superpowers/specs/`)
- the renderer (`pr-review.mjs` for pr-review)

From the earlier scan, all three recipes still have references in `plugins/ado/skills/*/SKILL.md` and/or `plugins/ado/recipes/address-pr-feedback.yaml`. **Do not delete any recipe yaml in this task.**

- [ ] **Step 4: Update tests/smoke.test.mjs trigger-types assertion**

Open `mcp-server/tests/smoke.test.mjs`. Locate the trigger-types listing assertion around lines 620-634. The current assertion expects the four `ado.*` trigger type ids. Replace it with an assertion that the ADO plugin loads cleanly (no errors) and that its `trigger_types` is empty. The simplest replacement:

```ts
    const types = res.structuredContent?.trigger_types ?? [];
    const ids = types.map((t) => t.id).sort();
    // After the 2026-05-28 callback-binding cleanup, the ADO plugin no
    // longer declares any trigger types — new scripts will be written
    // against the L3 SessionConductor wiring once that lands.
    assert.deepEqual(ids, []);
```

Also delete the "Spot-check schema surfaces" block (lines 628-635 inclusive) that asserted properties of `ado.new-pr-watcher`.

If the test body has a later block that invokes `trigger.register` with one of the deleted trigger types (lines 637-...), that block must also be removed. Read lines 637 through the next `await t.test(` boundary and delete any sub-tests that depend on a removed trigger type. Document the deletions in the commit message.

- [ ] **Step 5: Run smoke + full test suite**

From `mcp-server/`:

```powershell
node --import tsx --test tests/smoke.test.mjs
```

Expected: passes (or only fails for known pre-existing flakes; compare against baseline).

```powershell
npm test
```

Expected: 495 baseline minus ~5 (deleted dispatcher/template tests) plus 2 (new migration tests) = ~492 pass, 4 pre-existing flakes, no new failures.

If new failures appear, they likely come from `recipe-real-e2e.test.mjs` (it depends on the recipe-binding path); revisit Task 2 step 15 and adjust the test further until it passes.

- [ ] **Step 6: Commit**

```powershell
cd C:\git\clawdevbox
git add -A plugins/ado mcp-server/tests/smoke.test.mjs
git commit -m "refactor(plugins/ado): delete four trigger scripts whose only purpose was binds_callback_to_*" -m "Removes plugins/ado/triggers/ado-{new-pr,comment,pr-pulse,new-work-item}-watcher.ts and the matching trigger_types entries in plugins/ado/.claude-plugin/plugin.json. The recipes (pr-review, triage-work-item, respond-to-pr-comment) are kept — they are still referenced by ADO skills and remain invocable via the recipe MCP tool. Updates smoke test to expect an empty trigger_types list for the ADO plugin." -m "New ADO trigger scripts will be authored against the L3 SessionConductor wiring once that lands." -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Doc cleanup

**Files:**
- Modify (remove `binds_callback_to_*` mentions): `docs/MCP-TOOLS-REFERENCE.md`, `docs/tools/trigger.md`, `docs/tools/recipe.md`, `docs/plugins.md`, `docs/design.md`, `docs/LIFECYCLES.md`, `docs/agent-clis.md`
- Leave alone (historical): `docs/plans/2026-05-1[45]-*.md`, `docs/specs/2026-05-1[45]-*.md`, `docs/superpowers/specs/2026-05-26-*.md`

- [ ] **Step 1: Find every doc reference**

From `C:\git\clawdevbox`:

```powershell
grep -rn "binds_callback_to" --include="*.md" docs\
```

Expected output: matches in MCP-TOOLS-REFERENCE.md, tools/trigger.md, tools/recipe.md, plugins.md, design.md, LIFECYCLES.md, agent-clis.md, plus historical files in docs/plans/ and docs/specs/.

- [ ] **Step 2: Edit each living doc file**

For each living doc file (in the list above, excluding `docs/plans/`, `docs/specs/`, `docs/superpowers/specs/`):

1. Open the file
2. Find every section that documents `binds_callback_to_recipe` or `binds_callback_to`
3. Remove the section. If the section is a bullet inside a longer list, remove the bullet. If it's a heading + paragraph, remove the heading and its content.
4. Surrounding paragraphs may need light editing for transitions; do not introduce new claims about behavior.

For doc files that describe a SCHEMA (e.g., `docs/MCP-TOOLS-REFERENCE.md` listing `trigger.create_template` parameters), also remove the two fields from the parameter table/list.

Verify:

```powershell
grep -rn "binds_callback_to" --include="*.md" docs\
```

Expected: only matches in `docs/plans/2026-05-14-*.md`, `docs/specs/2026-05-1[45]-*.md`, `docs/superpowers/specs/2026-05-26-*.md`, `docs/superpowers/specs/2026-05-28-callback-binding-cleanup-design.md` — all historical / planning docs.

- [ ] **Step 3: Commit**

```powershell
cd C:\git\clawdevbox
git add docs/
git commit -m "docs: drop binds_callback_to_* references from living docs" -m "Removes documentation of the dead callback-binding mechanism from the seven living doc files (MCP-TOOLS-REFERENCE, tools/trigger, tools/recipe, plugins, design, LIFECYCLES, agent-clis). Historical plan and spec files under docs/plans/ and docs/specs/ are kept intact as archives." -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: F verification + commit consolidation

**Files:** none modified; this task verifies and optionally squashes.

- [ ] **Step 1: Run full test suite from clean state**

From `C:\git\clawdevbox\mcp-server`:

```powershell
npm run typecheck
npm test
```

Expected:
- typecheck: exit 0
- npm test: pre-existing-flakes only (baseline 4 known failures: dispatcher script-binding, scheduler, workspace+recipe.run, smoke MCP). Pass count: ~492 (baseline 495 minus 3 deleted tests, plus 2 new migration tests = 494, give or take).

If the full suite shows NEW failures beyond the baseline 4, do not proceed. Diagnose with `npm test 2>&1 | Select-String -Pattern "^not ok " -Context 5,5` and fix in a follow-up commit before proceeding.

- [ ] **Step 2: Confirm git log shows 4 F commits**

```powershell
cd C:\git\clawdevbox
git --no-pager log --oneline -8
```

Expected to see, newest first:
1. `docs: drop binds_callback_to_* references from living docs`
2. `refactor(plugins/ado): delete four trigger scripts whose only purpose was binds_callback_to_*`
3. `refactor(kernel): remove binds_callback_to_* mechanism`
4. `feat(db): add V2 migration to drop binds_callback_to columns`

If a commit is missing or out of order, stop and investigate before proceeding.

- [ ] **Step 3: Decide squash policy**

Per the spec, the PR should land as "two commits" (F + G). The four F commits above provide better git-bisect granularity. **Default: leave the four commits as-is** — they tell a clearer story than a single squashed commit and each is independently buildable + testable. Document this choice. If the user later requests squashing before merging the PR, the operation is:

```powershell
git reset --soft HEAD~4
git commit -m "refactor: remove binds_callback_to_* mechanism + DB v2 migration"
```

Do NOT perform the squash now without explicit user confirmation.

- [ ] **Step 4: Verify no leftover references**

```powershell
grep -rn "binds_callback_to" --include="*.{ts,mjs,json,yaml}" mcp-server/ plugins/
```

Expected: zero matches outside `mcp-server/.git/` and any node_modules.

- [ ] **Step 5: Mark Task 5 done in the session todos**

No commit for this verification task.

---

## Task 6: G — Agency cwd fix + test + commit (separate repo)

**Files:**
- Modify: `C:\git\agency-provider\agency-provider.mjs:5 (import), 90-148 (delete buildMcpJson), 244, 250`
- Modify: `C:\git\agency-provider\test-fixture.mjs` (add cwd-mismatch assertion)

- [ ] **Step 1: Extend the node:fs import**

Open `C:\git\agency-provider\agency-provider.mjs`. Locate the import at line 5:

```js
import { existsSync } from 'node:fs';
```

Extend it to:

```js
import { existsSync, writeFileSync } from 'node:fs';
```

- [ ] **Step 2: Delete the local buildMcpJson helper**

Locate the `buildMcpJson(mcp)` function definition (around lines 90-148). It includes the JSDoc comment immediately preceding the `function buildMcpJson(` declaration. Delete the entire function definition AND its preceding JSDoc.

Do NOT delete `buildAgencyToml` — it's agency-specific and stays.

- [ ] **Step 3: Replace the two ctx.writeWorkspaceFile calls**

In the `spawnSession` method, locate lines 244 and 250:

```js
    ctx.writeWorkspaceFile('.mcp.json', buildMcpJson(opts.mcp));
    // ...
    ctx.writeWorkspaceFile('agency.toml', buildAgencyToml(opts.mcp));
```

Replace them with:

```js
    // Use the shared writeMcpJson helper instead of ctx.writeWorkspaceFile.
    // ctx.writeWorkspaceFile resolves against ws.projectDir, which is the
    // SERVER's project_dir — wrong for any spawn whose workspaceInfo.path
    // differs (e.g. recipes running in a workspace folder). The Copilot
    // CLI looks for .mcp.json in its cwd, which we set to
    // opts.workspaceInfo.path below. Writing to ws.projectDir leaves
    // Copilot with no MCP config and silently disconnects.
    const { writeMcpJson } = await loadSyncHelpers();
    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);

    // Same fix for agency.toml — write at the spawn cwd, not ws.projectDir.
    writeFileSync(
      join(opts.workspaceInfo.path, 'agency.toml'),
      buildAgencyToml(opts.mcp),
    );
```

(Both `join` from `node:path` and `loadSyncHelpers` are already imported/defined at the top of the file. No additional imports needed.)

- [ ] **Step 4: Verify no other callers of buildMcpJson remain**

```powershell
cd C:\git\agency-provider
grep -n "buildMcpJson" .
```

Expected: zero matches. (If any remain, fix them.)

- [ ] **Step 5: Add cwd-mismatch assertion to test-fixture.mjs**

Open `C:\git\agency-provider\test-fixture.mjs`. Read the existing test scaffolding to understand the mocking pattern (look for how `ctx.writeWorkspaceFile` is currently spied/asserted, and how `opts.workspaceInfo.path` is set in existing tests).

Add a new test case at the end of the file (or before the final `process.exit` line) that:

1. Constructs a `ctx` whose `ws.projectDir` is `'C:/server-side'` and whose `writeWorkspaceFile` is a spy that records all writes
2. Constructs `opts.workspaceInfo.path` as `'C:/spawn-cwd'` (a DIFFERENT directory)
3. Uses a tmp dir for the actual filesystem writes
4. Calls `provider.spawnSession(ctx, opts)` with `mode: 'headless'` so it short-circuits before pty.spawn
5. Asserts:
   - `ctx.writeWorkspaceFile` was NOT called for `.mcp.json` or `agency.toml`
   - The `.mcp.json` file exists at `<tmp>/C:/spawn-cwd/.mcp.json` (the spawn cwd), not at `<tmp>/C:/server-side/.mcp.json` (the ws.projectDir)
   - The `agency.toml` file exists at the same spawn-cwd path

Sample code structure (adjust to match the file's existing patterns):

```js
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ... existing tests ...

async function testCwdFix() {
  const tmp = join(tmpdir(), `agency-provider-cwd-fix-${Date.now()}`);
  const serverProjectDir = join(tmp, 'server-side');
  const spawnCwd = join(tmp, 'spawn-cwd');
  mkdirSync(serverProjectDir, { recursive: true });
  mkdirSync(spawnCwd, { recursive: true });

  const wsfWrites = [];
  const ctx = {
    ws: { projectDir: serverProjectDir, globalDir: join(tmp, 'global') },
    logger: { warn: () => {}, debug: () => {} },
    writeWorkspaceFile: (rel, content) => { wsfWrites.push({ rel, content }); },
    spawnPty: () => { throw new Error('spawnPty should not be reached in headless mode'); },
  };
  const opts = {
    mode: 'headless',
    prompt: 'echo test',
    workspaceInfo: { id: 'ws_test', path: spawnCwd },
    mcp: { url: 'http://127.0.0.1:5201/mcp', secret: '' },
    init: { kind: 'new', session_id: 'sess_test' },
    pluginDirs: [],
    ambientEnv: {},
  };

  // We can't actually spawn agency.exe here — just call up to the writes.
  // The test setup needs to either (a) stub spawnPty earlier so the
  // function returns before pty creation, or (b) call the helper logic
  // directly. Inspect the existing test-fixture patterns and follow them.
  try {
    await provider.spawnSession(ctx, opts);
  } catch (err) {
    // Headless will still try to spawn; that's ok — we only need the
    // writes to have happened first.
    if (!String(err).includes('spawnPty')) throw err;
  }

  // ASSERT: .mcp.json and agency.toml exist at spawnCwd, NOT serverProjectDir.
  if (!existsSync(join(spawnCwd, '.mcp.json'))) {
    throw new Error('FAIL: .mcp.json missing at spawnCwd');
  }
  if (!existsSync(join(spawnCwd, 'agency.toml'))) {
    throw new Error('FAIL: agency.toml missing at spawnCwd');
  }
  if (existsSync(join(serverProjectDir, '.mcp.json'))) {
    throw new Error('FAIL: .mcp.json incorrectly written to serverProjectDir');
  }
  if (existsSync(join(serverProjectDir, 'agency.toml'))) {
    throw new Error('FAIL: agency.toml incorrectly written to serverProjectDir');
  }

  // ASSERT: ctx.writeWorkspaceFile was NOT called for either file.
  const wsfMcpJson = wsfWrites.find((w) => w.rel === '.mcp.json');
  const wsfAgencyToml = wsfWrites.find((w) => w.rel === 'agency.toml');
  if (wsfMcpJson) throw new Error('FAIL: ctx.writeWorkspaceFile was called for .mcp.json');
  if (wsfAgencyToml) throw new Error('FAIL: ctx.writeWorkspaceFile was called for agency.toml');

  console.log('cwd-fix test: PASS');
  rmSync(tmp, { recursive: true, force: true });
}

await testCwdFix();
```

If `test-fixture.mjs` uses a different scaffolding pattern (e.g., a registered `t.test(...)` runner), adapt the assertions accordingly. The KEY assertion is: when `ws.projectDir !== opts.workspaceInfo.path`, the .mcp.json and agency.toml files land at `opts.workspaceInfo.path`.

- [ ] **Step 6: Run the test fixture**

```powershell
cd C:\git\agency-provider
node test-fixture.mjs
```

Expected: exit 0; new cwd-fix test prints `PASS` (or equivalent).

If the test fails because the existing fixture pattern is incompatible with the headless-mode early-exit assumption above, simplify: extract the .mcp.json/agency.toml write block from `spawnSession` into a smaller helper called from spawnSession, and test the helper directly with the cwd-mismatch scenario. This is a minimal refactor inside agency-provider.mjs and is acceptable.

- [ ] **Step 7: Commit G in agency-provider**

```powershell
cd C:\git\agency-provider
git add agency-provider.mjs test-fixture.mjs
git commit -m "fix: write .mcp.json and agency.toml at opts.workspaceInfo.path, not ws.projectDir" -m "ctx.writeWorkspaceFile resolves against ws.projectDir (the SERVER's project_dir), which is wrong for any spawn whose workspaceInfo.path differs — e.g. recipes running in a child workspace folder. Copilot CLI looks for .mcp.json in its cwd (which we set to opts.workspaceInfo.path), so writing to ws.projectDir leaves it with no MCP config and silently disconnects. Surfaced as ENOENT on WI 4547615." -m "Replaces both ctx.writeWorkspaceFile calls with: (1) the shared writeMcpJson helper from clawdevbox/agent-clis for .mcp.json, and (2) a direct writeFileSync for agency.toml. Deletes the now-unused local buildMcpJson helper. Adds a test-fixture case that asserts the cwd-mismatch scenario writes to the correct directory." -m "Spec: clawdevbox/docs/superpowers/specs/2026-05-28-callback-binding-cleanup-design.md (G section)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Verification Sequence (after all tasks)

1. `cd C:\git\clawdevbox\mcp-server && npm run typecheck` — exit 0
2. `npm test` — only pre-existing flakes fail
3. `grep -rn "binds_callback_to" --include="*.{ts,mjs,json,yaml}" mcp-server/ plugins/` — zero matches
4. `cd C:\git\agency-provider && node test-fixture.mjs` — exit 0
5. `cd C:\git\clawdevbox && git --no-pager log --oneline -5` — 4 F commits visible
6. `cd C:\git\agency-provider && git --no-pager log --oneline -3` — G commit on top
7. Manual confirmation that the design's "Out-of-scope follow-ups" list is preserved unchanged in the spec doc

## Push Policy

Do NOT push any of the new commits without explicit user confirmation. The PR currently has:

- clawdevbox: 4 unpushed commits prior to this PR (from earlier sessions: `32e82e5`, `6a25b76`, `6eb1ce6`) plus 4 new F commits = 7+ ahead of origin
- agency-provider: 2 unpushed commits prior (`8ea215d`, `5abddb9`) plus 1 new G commit = 3 ahead of origin

After all 6 tasks complete, surface the push decision to the user.
