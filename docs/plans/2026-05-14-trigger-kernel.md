# Trigger Kernel Implementation Plan

> **For agentic workers:** This plan is executed via subagent-driven development. Each task is owned by one subagent (Opus 4.7 1M context). Tasks marked `- [ ]` are pending, `- [x]` are done. The main agent owns commit boundaries — every phase ends with a green test run, a build, and a `git commit`.

**Goal:** Ship the trigger kernel end-to-end so cron triggers actually fire, recipes spawn from fires, agents update step state through MCP tools, and `clawdevbox mcp` auto-bootstraps the HTTP service. All six product primitives (Workspace, Trigger, Recipe, Agent Session, Artifact, Inbox Item) are backed by SQLite at `<globalDir>/clawdevbox.db`.

**Architecture:** See `docs/specs/2026-05-14-trigger-kernel-design.md`. Single SQLite file (WAL mode) opened at HTTP-service boot; event-driven scheduler sleeps until the next fire boundary; concurrency-capped dispatcher pulls queued fires; sources stay on disk and DB holds metadata + pointers; legacy JSON files emit one INFO warning and are ignored.

**Tech stack:** TypeScript, `better-sqlite3`, node:test, MCP SDK, `js-yaml`, existing event-bus, existing trigger-runner.

**Tests:** `npm test` in `mcp-server/`. Build: `npm run build`. Typecheck: `npm run typecheck`. Each phase ends green.

**Spec:** `docs/specs/2026-05-14-trigger-kernel-design.md`

---

## File structure

**New files:**
- `mcp-server/src/db/index.ts` — open DB, run migrations, expose typed singleton.
- `mcp-server/src/db/migrations.ts` — schema v1 (9 tables + indexes).
- `mcp-server/src/db/workspaces-store.ts` — workspace CRUD + ensure-by-path resolver.
- `mcp-server/src/db/recipe-steps-store.ts` — materialize steps, monotonic transition rule, trigger-decl bridge, step_events writer.
- `mcp-server/src/db/agent-sessions-store.ts` — open/close session rows, resume_of chain, `findResumeTarget(stepId)`.
- `mcp-server/src/db/artifacts-db-store.ts` — DB-side artifacts metadata (folder files remain via existing `artifact-store.ts`).
- `mcp-server/src/db/fires-store.ts` — queue insert, atomic claim, retry promotion, attempt directories.
- `mcp-server/src/db/step-events-store.ts` — append-only log; query by step or instance.
- `mcp-server/src/db/legacy-files.ts` — boot-time scan, log INFO once per legacy file.
- `mcp-server/src/scheduler.ts` — event-driven scheduler (sleep-until-next-fire + safety-net).
- `mcp-server/src/dispatcher.ts` — concurrency-capped dispatch with retry/dead-letter.
- `mcp-server/src/recipe-runner.ts` — extracted `runRecipe()` core; ambient env injection.
- `mcp-server/tests/db-migrations.test.mjs`
- `mcp-server/tests/db-stores.test.mjs`
- `mcp-server/tests/scheduler.test.mjs`
- `mcp-server/tests/dispatcher.test.mjs`
- `mcp-server/tests/recipe-step-tools.test.mjs`
- `mcp-server/tests/cron-api.test.mjs`
- `mcp-server/tests/mcp-bootstrap.test.mjs`

**Modified files:**
- `mcp-server/package.json` — add `better-sqlite3` dependency.
- `mcp-server/src/validators.ts` — accept string OR integer step ids (coerce on success), accept new optional `Step` fields (name, params, triggers, artifacts), JSON-or-YAML source sniff.
- `mcp-server/src/triggers-store.ts` — rewrite body to use DB; preserve exported signatures.
- `mcp-server/src/recipe-instances-store.ts` — rewrite body to use DB; materialize steps; preserve signatures.
- `mcp-server/src/inbox-persistence.ts` — rewrite body to use DB for metadata; keep `inbox-bodies/` files on disk; preserve signatures.
- `mcp-server/src/tools/trigger.ts` — real `trigger.fire`; add `max_attempts`+`backoff_ms` on `register`/`update_params`.
- `mcp-server/src/tools/recipe.ts` — thin wrapper around `recipe-runner.ts`; add `recipe.update_steps`, `recipe.steps.update_status`; `recipe.upsert format` arg.
- `mcp-server/src/cli/start.ts` — `listenOrConfirmExisting`; mount `/api/cron/*`, `/api/fires/*`, `/callback/<fire_id>`; SSE `'fires'` topic; boot scheduler + dispatcher.
- `mcp-server/src/cli/mcp.ts` — `ensureHttpServiceRunning` at boot.
- `mcp-server/src/event-bus.ts` — add `'fires'`, `'sessions'`, `'artifacts'` topics.
- `docs/tools/trigger.md` — document `max_attempts`, `backoff_ms`, real `trigger.fire`.
- `docs/tools/recipe.md` — document `recipe.update_steps`, `recipe.steps.update_status`, `format` arg.
- `docs/tools/cron.md` (new) — `/api/cron/*` and `/api/fires/*` reference.
- `docs/MCP-TOOLS-REFERENCE.md` — regenerate via `python docs/scripts/compose_master_doc.py`.

---

## Phase 1 — DB Foundation

### Task 1.1: Add `better-sqlite3` dependency

**Files:** `mcp-server/package.json`

- [ ] Run `npm install --save better-sqlite3@^11.0.0` in `mcp-server/`.
- [ ] Run `npm install --save-dev @types/better-sqlite3` in `mcp-server/`.
- [ ] Verify `mcp-server/node_modules/better-sqlite3/build/Release/better_sqlite3.node` exists (prebuilt binary). On Windows, this is precompiled for Node 20.
- [ ] Run `npm run typecheck` and `npm run build` to confirm the dep loads.

**Commit:** `feat(db): add better-sqlite3 dependency`

### Task 1.2: Create `db/index.ts` (open + migrate)

**Files:** `mcp-server/src/db/index.ts`, `mcp-server/src/db/migrations.ts`

- [ ] `db/migrations.ts` exports `migrations: Array<{ version: number; up: (db: Database) => void }>` with `version: 1` applying the full schema v1 from spec §4.2 (all 9 tables + indexes). Use `db.exec()` with a single multi-statement SQL string.
- [ ] `db/index.ts` exports:
  - `openDatabase(globalDir: string): Database` — opens `<globalDir>/clawdevbox.db`, enables `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, `PRAGMA synchronous=NORMAL`, runs migrations idempotently.
  - `getDatabase(): Database` — module-scope singleton getter; throws if not yet opened.
  - `closeDatabase(): void` — for test teardown.
  - `setDatabaseForTesting(db: Database): void` — inject an `:memory:` DB in tests.
- [ ] Migration runner: SELECT `MAX(version)` from `schema_version`; iterate migrations with version > current; wrap each migration in `db.transaction(() => { migration.up(db); db.prepare('INSERT INTO schema_version VALUES (?)').run(version) })()`.
- [ ] Foreign-key forward-references: SQLite permits them. The schema includes circular FKs (triggers→recipe_instances, recipe_instances→fires, fires→recipe_instances). Validated at row-insert time only.
- [ ] Export `Database` type alias from `better-sqlite3` so callers don't have to import twice.

**Commit:** `feat(db): schema v1 + migration runner`

### Task 1.3: Wire DB into service boot

**Files:** `mcp-server/src/cli/start.ts`

- [ ] In `runStart()`, after `loadWorkspace()` returns and before HTTP `listen()`, call `openDatabase(cfg.globalDir)`.
- [ ] On graceful shutdown (`SIGTERM`/`SIGINT`/process exit), call `closeDatabase()` before `httpServer.close()`.
- [ ] Add a startup log: `db opened — path=<path> schema_version=<v>`.

**Commit:** `feat(db): open DB at service boot`

### Task 1.4: Tests for migrations

**Files:** `mcp-server/tests/db-migrations.test.mjs`

- [ ] Open an `:memory:` DB → run migrations → assert all 9 tables exist via `sqlite_master`.
- [ ] Open same DB twice → assert idempotent (no error, no duplicate `schema_version` rows).
- [ ] Insert a row with an FK violation → assert it fails (PRAGMA foreign_keys is on).
- [ ] Insert a row with `status` outside the CHECK constraint → assert it fails.
- [ ] Update `package.json` `"test"` script to include `tests/db-migrations.test.mjs`.

**Commit:** `test(db): migration runner + schema constraints`

---

## Phase 2 — Step schema validator updates

### Task 2.1: Coerce integer step ids; accept new fields

**Files:** `mcp-server/src/validators.ts`, `mcp-server/tests/validators.test.mjs`

- [ ] In `validateRecipeParsed()`, update step validation to:
  - Accept `step.id` as either string (kebab-case `/^[a-z0-9][a-z0-9._-]*$/i`) or integer; coerce integer → string at validation time (mutate the parsed object so downstream code sees strings).
  - Coerce `step.depends` integers → strings the same way.
  - Accept optional `step.name: string` (≤200 chars).
  - Accept optional `step.params: Array<ParamSpec>` where each entry has `name: string` (`/^[a-z][a-z0-9_]*$/i`), `type: 'string'|'integer'|'number'|'boolean'|'array'|'object'`, optional `required: boolean`, `default: unknown`, `description: string`.
  - Accept optional `step.triggers: Array<TriggerDecl>` where each entry has `type: string` (trigger TYPE id), optional `params: Record<string,unknown>`, optional `cron: string|null|false`, optional `binds_callback_to: 'agent_session_resume'`, optional `binds_callback_to_recipe: string`, optional `once`, `expires_at`, `max_attempts`, `backoff_ms`.
  - Accept optional `step.artifacts: Array<ArtifactDecl>` where each entry has `id: string`, `type: string`, optional `title: string`.
- [ ] Add unit tests covering each new field: valid + invalid examples.
- [ ] Add a backward-compat test: load `samples/plugins/ado/recipes/pr-review.yaml` → assert ids become strings, depends become strings, recipe is valid.
- [ ] Update existing recipe-schema tests if they break.

**Commit:** `feat(validators): rich step schema (coerce int ids, name/params/triggers/artifacts)`

### Task 2.2: JSON source sniff for recipes

**Files:** `mcp-server/src/validators.ts`, `mcp-server/src/tools/recipe.ts`, `mcp-server/tests/validators.test.mjs`

- [ ] Add `parseRecipeSource(source: string): unknown` to `validators.ts` that:
  - Strips leading whitespace.
  - If first non-whitespace char is `{` or `[`: `JSON.parse(source)`.
  - Else: `yaml.load(source)`.
- [ ] Update `validateRecipeSource` (or its callers in `tools/recipe.ts`) to use this helper.
- [ ] Add tests covering valid YAML, valid JSON, malformed both, mixed-leading-whitespace.

**Commit:** `feat(validators): JSON-or-YAML source sniff`

---

## Phase 3 — Core DB stores

### Task 3.1: `db/workspaces-store.ts`

**Files:** `mcp-server/src/db/workspaces-store.ts`, `mcp-server/tests/db-stores.test.mjs`

- [ ] Export functions:
  - `ensureWorkspace(db, opts: { id?: string; path: string; name?: string; parent_workspace_id?: string }): WorkspaceRow` — upsert by path; mint id `ws_<base36>` if not provided.
  - `getWorkspaceByPath(db, path): WorkspaceRow | null`
  - `getWorkspaceById(db, id): WorkspaceRow | null`
  - `listWorkspaces(db): WorkspaceRow[]`
- [ ] `WorkspaceRow` type matches the table columns.
- [ ] Unit tests in `db-stores.test.mjs`.

**Commit:** `feat(db): workspaces store`

### Task 3.2: `db/fires-store.ts`

**Files:** `mcp-server/src/db/fires-store.ts`, `mcp-server/tests/db-stores.test.mjs`

- [ ] Export functions:
  - `enqueueFire(db, opts: { workspace_id, trigger_id?, source: 'cron'|'manual'|'webhook'|'event', scheduled_at?: number, max_attempts?: number, payload?: unknown }): FireRow` — INSERT with `status='queued'`, mints `fire_<base36>`.
  - `claimNextFire(db): FireRow | null` — atomic claim in IMMEDIATE transaction: SELECT oldest queued, check trigger-overlap (any other fire with same trigger_id in `running`), mark either `skipped` or `running`. Returns the claimed row or null.
  - `markFireSuccess(db, fire_id, opts: { duration_ms, exit_code? }): void`
  - `markFireFailedWithRetry(db, fire_id, opts: { error: string, backoff_ms_json: string }): void`
  - `markFireDead(db, fire_id, opts: { error: string }): void`
  - `markFireFailedShutdown(db, fire_id): void`
  - `markFireForRetry(db, fire_id): void` — manual retry; reset to queued attempt=1.
  - `listFires(db, opts: { status?, workspace_id?, trigger_id?, limit?, before? }): FireRow[]`
  - `getFire(db, fire_id): FireRow | null`
  - `attemptDir(workspacePath, fire_id, attempt): string` — helper for output dirs.
- [ ] `emitChange('fires')` on every state-changing function.
- [ ] Unit tests including overlap-skip and atomic-claim race.

**Commit:** `feat(db): fires store with atomic claim + retry`

### Task 3.3: `db/recipe-steps-store.ts` + `step-events-store.ts`

**Files:** `mcp-server/src/db/recipe-steps-store.ts`, `mcp-server/src/db/step-events-store.ts`, `mcp-server/tests/db-stores.test.mjs`

- [ ] `recipe-steps-store.ts` exports:
  - `materializeSteps(db, recipe_instance_id, steps: Step[]): RecipeStepRow[]` — INSERTs one row per `steps[]` entry with `status='pending'`. Generates `rs_<base36>` ids. Validates uniqueness of `step_id` within the instance.
  - `listSteps(db, recipe_instance_id): RecipeStepRow[]`
  - `getStep(db, recipe_instance_id, step_id): RecipeStepRow | null`
  - `getStepById(db, rs_id): RecipeStepRow | null`
  - `transitionStatus(db, rs_id, opts: { status, message?, state?, state_replace?, result?, error?, awaiting_user_message? }): void` — applies the monotonic rule (rejects backward transitions with thrown `StepTransitionError`). Auto-sets `started_at`/`completed_at`. Emits `step_events` row.
  - `addSteps(db, recipe_instance_id, newSteps: Step[]): RecipeStepRow[]` — INSERTs and validates depends resolution.
  - `removeSteps(db, recipe_instance_id, step_ids: string[]): void` — rejects if any non-removed step depends on a removed one; rejects if any removed step is `running` or `awaiting_user`.
  - `updateMeta(db, recipe_instance_id, step_id, patch: Partial<Step>): RecipeStepRow` — patches metadata columns; if `triggers_decl_json` is patched on a running step, returns the diff so the caller can register/unregister.
  - `MONOTONIC_TRANSITIONS` constant — the allowed-transition map per spec §10.5.
  - `StepTransitionError` exception class with `code='INVALID_STEP_TRANSITION'`.
- [ ] `step-events-store.ts` exports:
  - `appendEvent(db, opts: { recipe_step_id, recipe_instance_id, agent_session_id?, type, message?, payload? }): void`
  - `listEvents(db, opts: { recipe_step_id?, recipe_instance_id?, limit?, before? }): StepEventRow[]`
  - Type literals: `'status_changed' | 'message' | 'state_patched' | 'artifact_attached' | 'inbox_attached' | 'trigger_registered' | 'trigger_unregistered' | 'trigger_registration_failed' | 'user_input_requested' | 'user_input_received' | 'meta_patched' | 'step_added' | 'step_removed'`.
- [ ] Every `recipe-steps-store` mutation emits exactly one `step_events` row (`appendEvent` is the single writer). Mutations also `emitChange('recipes')`.
- [ ] Unit tests: materialize → status round-trip; monotonic violation rejected; add/remove guards; meta patch.

**Commit:** `feat(db): recipe-steps + step-events stores`

### Task 3.4: `db/agent-sessions-store.ts`

**Files:** `mcp-server/src/db/agent-sessions-store.ts`, `mcp-server/tests/db-stores.test.mjs`

- [ ] Export functions:
  - `openSession(db, opts: { workspace_id, recipe_instance_id?, recipe_step_id?, agent_cli, pid?, cli_session_id?, interactive?, resume_of_agent_session_id? }): AgentSessionRow` — INSERTs with `status='running'`, mints `as_<base36>`.
  - `closeSession(db, id, opts: { status: 'success'|'failure'|'cancelled'|'suspended', result?, error? }): void`
  - `getSession(db, id): AgentSessionRow | null`
  - `listSessionsForStep(db, recipe_step_id): AgentSessionRow[]`
  - `findResumeTarget(db, recipe_step_id): AgentSessionRow | null` — returns the latest session for that step with `status ∈ {suspended, success, failure}`.
  - `markSessionSuspended(db, id, opts: { awaiting_user_message? }): void`
- [ ] `emitChange('sessions')` on every state change.
- [ ] Unit tests for the resume-chain.

**Commit:** `feat(db): agent-sessions store with resume chain`

### Task 3.5: `db/artifacts-db-store.ts`

**Files:** `mcp-server/src/db/artifacts-db-store.ts`, `mcp-server/tests/db-stores.test.mjs`

- [ ] Export functions:
  - `registerArtifact(db, opts: { workspace_id, recipe_instance_id?, recipe_step_id?, agent_session_id?, artifact_decl_id?, type, title?, dir_path, metadata? }): ArtifactRow` — INSERT, mints `art_<base36>`.
  - `attachArtifactToStep(db, art_id, recipe_step_id, agent_session_id?): void`
  - `listArtifactsForWorkspace(db, workspace_id, opts?: { limit?, before? }): ArtifactRow[]`
  - `listArtifactsForStep(db, recipe_step_id): ArtifactRow[]`
  - `getArtifact(db, art_id): ArtifactRow | null`
- [ ] `emitChange('artifacts')` on every state change.
- [ ] Bridge note: existing `artifact-store.ts` (filesystem layer) stays; new `artifacts-db-store.ts` is the metadata index. Each `artifact.add` tool call writes BOTH the on-disk manifest AND the DB row (Task 7.x will wire this up).

**Commit:** `feat(db): artifacts metadata store`

### Task 3.6: `db/legacy-files.ts`

**Files:** `mcp-server/src/db/legacy-files.ts`, `mcp-server/src/cli/start.ts`

- [ ] Export `scanLegacyFiles(cfg: ResolvedConfig): void` that checks for and INFO-logs (one log per file):
  - `<projectDir>/.clawdevbox/triggers.json`
  - `<workspacesRoot>/*/.clawdevbox/triggers.json`
  - `<workspace>/.clawdevbox/recipe-instances/*.json`
  - `<globalDir>/inbox.json`
- [ ] No reads, deletes, or moves. Use `kv` table to record we've logged each file's existence so we only log once per process lifetime. Key: `legacy_file_seen:<path>`.
- [ ] Call `scanLegacyFiles(cfg)` from `runStart()` right after `openDatabase()`.

**Commit:** `feat(db): legacy-file warning scan`

---

## Phase 4 — Adapter rewrites

### Task 4.1: Rewrite `triggers-store.ts` to use DB

**Files:** `mcp-server/src/triggers-store.ts`, `mcp-server/tests/db-stores.test.mjs`

- [ ] Keep exported function signatures (`readTriggersFile`, `writeTriggersFile`, etc.) so callers don't change.
- [ ] Internally, read/write via `db/index.ts`. Map `path` arg → `workspace_id` via `ensureWorkspace(db, { path })`.
- [ ] Add NEW columns from schema v1: `recipe_instance_id`, `recipe_step_id`, `binds_callback_to`, `binds_callback_to_recipe`, `auto_declared`, `auto_registered_by_step_id`, `max_attempts`, `backoff_ms_json`.
- [ ] Drop legacy `subscriber_thread_id` column (not in schema).
- [ ] Confirm all existing trigger tests still pass.
- [ ] Update `RegisteredTrigger` interface in `workspace.ts` if needed to mirror new columns.

**Commit:** `refactor(triggers): use DB instead of triggers.json`

### Task 4.2: Rewrite `recipe-instances-store.ts` to use DB

**Files:** `mcp-server/src/recipe-instances-store.ts`, `mcp-server/tests/db-stores.test.mjs`

- [ ] Preserve `mintRecipeInstanceId`, `readRecipeInstance`, `writeRecipeInstance`, `listRecipeInstances` signatures.
- [ ] Move agent-process fields (`pid`, `agent_cli`, `session_id`, `resume_of`) into the new `agent_sessions` table. `readRecipeInstance` now returns a `RecipeInstance` enriched with the latest session for compat (preserve `pid`, `agent_cli`, `session_id`, `resume_of` on the return value by joining on `agent_sessions`).
- [ ] On `writeRecipeInstance({steps: [...]})`, materialize/replace `recipe_steps` rows in the same transaction. PRESERVE runtime state (`status`, `message`, `started_at`, `completed_at`, `result`, `error`, `state_json`) for steps whose `step_id` matches an existing row.
- [ ] `recipe.run` (in `tools/recipe.ts`) currently writes `agent_cli`/`pid`/`session_id` directly to the instance file — those calls need to migrate to also creating an `agent_sessions` row. Do this in Phase 7 — for now, accept both code paths (write to DB and to nothing else; the joined-read pattern recovers them).
- [ ] Confirm all existing recipe tests still pass.

**Commit:** `refactor(recipe-instances): use DB; split agent-session fields`

### Task 4.3: Rewrite `inbox-persistence.ts` to use DB

**Files:** `mcp-server/src/inbox-persistence.ts`, `mcp-server/tests/db-stores.test.mjs`

- [ ] Preserve `loadInboxFromDisk`/`saveInboxToDisk` signatures.
- [ ] Migrate metadata to the `inbox_items` DB table. KEEP the `<globalDir>/inbox-bodies/` filesystem layout for body content — DB stores `body_path` only.
- [ ] Add columns: `recipe_step_id`, `agent_session_id`.
- [ ] Confirm all existing inbox tests still pass.

**Commit:** `refactor(inbox): use DB for metadata; keep bodies on disk`

---

## Phase 5 — Scheduler

### Task 5.1: Implement scheduler

**Files:** `mcp-server/src/scheduler.ts`, `mcp-server/src/event-bus.ts`, `mcp-server/tests/scheduler.test.mjs`

- [ ] Add `'fires'`, `'sessions'`, `'artifacts'` to `event-bus.ts` `ChangeTopic` union.
- [ ] `scheduler.ts` exports a `Scheduler` class with API per spec §5.2.
- [ ] `reschedule()` per spec §5.3.
- [ ] `onWake()` per spec §5.4 (1-second jitter window; older missed boundaries skipped).
- [ ] Listen on event-bus for `'triggers'` and `'fires'`; call `reschedule()`.
- [ ] 60-second safety-net `setInterval` calling `reschedule()` unconditionally.
- [ ] Use `cron-parser` (already in deps) for next-fire computation. Helper `effectiveCron(trigger)` resolves inherit→type-default vs override.
- [ ] Unit tests: empty DB, one trigger, multiple triggers, retrying fire with sooner deadline, no-op when nothing due. Use Sinon-free fake timers via `node:test` mocking primitives where needed (or wrap `setTimeout` in an injectable clock for tests).

**Commit:** `feat(scheduler): event-driven sleep-until-next-fire`

---

## Phase 6 — Dispatcher

### Task 6.1: Implement dispatcher core

**Files:** `mcp-server/src/dispatcher.ts`, `mcp-server/tests/dispatcher.test.mjs`

- [ ] Class `Dispatcher` per spec §6.2.
- [ ] `pickUp()` loop: while `in_flight < maxConcurrent`, call `claimNextFire(db)` (atomic). If returns a fire, kick off binding async; on completion, write outcome and call `pickUp()` again.
- [ ] Concurrency tracking via in-process `Set<fire_id>`.
- [ ] Recipe binding (Task 6.2 below) and script binding (Task 6.3 below) plug in here.
- [ ] Retry policy per spec §6.5. Backoff array from `triggers.backoff_ms_json`.
- [ ] Dead-letter → INSERT `inbox_items` row with `source='trigger-dead'`.
- [ ] `once: true` semantics: on success, `UPDATE triggers SET enabled=0`.
- [ ] Graceful shutdown: 15-second drain, then mark `failed/service_shutdown`.
- [ ] Unit tests: success path, failure-with-retry, dead-letter, overlap-skip via the store's atomic claim, drain shutdown.

**Commit:** `feat(dispatcher): concurrency-capped queue with retry + dead-letter`

### Task 6.2: Recipe binding

**Files:** `mcp-server/src/dispatcher.ts`, `mcp-server/src/recipe-runner.ts`, `mcp-server/tests/dispatcher.test.mjs`

- [ ] Extract `runRecipe(opts, ctx)` core from `tools/recipe.ts` to `recipe-runner.ts`. Tool becomes thin wrapper. Recipe-runner accepts new options: `triggerId`, `fireId`, `parentRecipeInstanceId`.
- [ ] In recipe-runner, before spawning the agent process, INSERT an `agent_sessions` row and set ambient env on the child:
  - `CLAWDEVBOX_WORKSPACE_ID`
  - `CLAWDEVBOX_RECIPE_INSTANCE_ID`
  - `CLAWDEVBOX_AGENT_SESSION_ID`
  - `CLAWDEVBOX_RECIPE_STEP_ID` (only when scoped to one step)
- [ ] Dispatcher's recipe binding: call `runRecipe()` with `triggerId`, `fireId` set. Updates `fires.recipe_instance_id` + `fires.agent_session_id` on success.
- [ ] Synthesize prompt per spec §7.4.
- [ ] Integration test: register cron trigger with `binds_callback_to_recipe: 'simple-prompt'` (using sample recipe) → wait → assert recipe_instance row + agent_session row appear with lineage.

**Commit:** `feat(dispatcher): recipe binding with ambient env`

### Task 6.3: Script binding + agent-session-resume stub

**Files:** `mcp-server/src/dispatcher.ts`, `mcp-server/tests/dispatcher.test.mjs`

- [ ] Script binding (no `binds_callback_to_recipe`, no `binds_callback_to`): call `runTriggerScript()` (from existing `trigger-runner.ts`). Write per-attempt blobs to `<workspace>/.clawdevbox/fires/<fire_id>/attempt-<N>/{stdout.txt,stderr.txt,callbacks.json}`. Update `triggers.state_json` from `stdout_parsed.state` on success.
- [ ] Agent-session-resume binding (`binds_callback_to: 'agent_session_resume'`): immediately `fail` with `error='agent_session_resume_not_implemented'`. Goes through retry/dead-letter like any failure.
- [ ] Tests covering each path with fixture scripts (reuse trigger-runner fixtures).

**Commit:** `feat(dispatcher): script binding + agent-session-resume stub`

### Task 6.4: Wire scheduler + dispatcher into service boot

**Files:** `mcp-server/src/cli/start.ts`

- [ ] In `runStart()`, after DB opens and HTTP server listens:
  ```ts
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: cfg.cron.maxConcurrent });
  dispatcher.start();
  const scheduler = new Scheduler(db, dispatcher, ws);
  scheduler.start();
  ```
- [ ] On shutdown: `scheduler.stop(); await dispatcher.stop()`.
- [ ] Add `cfg.cron` config keys (`maxConcurrent` default 4, `dispatcherDrainMs` default 15000) to `config.ts`.

**Commit:** `feat(kernel): boot scheduler + dispatcher at service startup`

---

## Phase 7 — MCP tool changes

### Task 7.1: Real `trigger.fire`

**Files:** `mcp-server/src/tools/trigger.ts`, `mcp-server/tests/...`

- [ ] Replace the metadata stub with a DB-backed `enqueueFire()` call. `source='manual'`. Returns `{ fire_id, trigger_id, status: 'queued' }`.
- [ ] Honor optional `payload` parameter — stored as `payload_json`.
- [ ] Confirm the new behavior via an integration test: register a trigger with a recipe binding → `trigger.fire` → wait for recipe_instances row.

**Commit:** `feat(trigger): real trigger.fire backed by DB queue`

### Task 7.2: `max_attempts` + `backoff_ms` on register/update_params

**Files:** `mcp-server/src/tools/trigger.ts`, `mcp-server/src/validators.ts`

- [ ] Extend `trigger.register` schema: optional `max_attempts: integer >= 1` (default 3), optional `backoff_ms: integer[]` (default `[30000, 120000, 600000]`).
- [ ] Same for `trigger.update_params`.
- [ ] Persist to DB columns. Honored by dispatcher's retry policy.
- [ ] Validator rejects empty arrays, negative numbers, non-integers.
- [ ] Tests.

**Commit:** `feat(trigger): max_attempts + backoff_ms per-trigger overrides`

### Task 7.3: Extract `runRecipe()` to `recipe-runner.ts`

**Files:** `mcp-server/src/recipe-runner.ts`, `mcp-server/src/tools/recipe.ts`

- [ ] Move the body of `recipe.run` (in `tools/recipe.ts`) to `runRecipe(opts, ctx): Promise<RecipeInstance>` in `recipe-runner.ts`.
- [ ] Tool becomes a thin wrapper.
- [ ] Add ambient-env injection on agent spawn (as in Task 6.2).
- [ ] Wire new `agent_sessions` row creation.
- [ ] Materialize `recipe_steps` from the recipe's `steps[]` at run-time (preserving any prior step state in `recipe_steps` if `resume_of` is set).
- [ ] Existing recipe.run tests pass without changes.

**Commit:** `refactor(recipe): extract runRecipe() core; ambient env; materialize steps`

### Task 7.4: `recipe.update_steps` tool

**Files:** `mcp-server/src/tools/recipe.ts`, `mcp-server/tests/recipe-step-tools.test.mjs`

- [ ] Tool schema: `{ recipe_instance_id?: string, add?: Step[], remove?: string[], update_meta?: Array<Partial<Step> & {id:string}> }`. Defaults `recipe_instance_id` from env `CLAWDEVBOX_RECIPE_INSTANCE_ID`.
- [ ] Implementation: open a DB transaction, call store helpers for add/remove/update_meta, emit `step_events` rows, emit `'recipes'` SSE topic.
- [ ] Error mapping per spec §10.4.
- [ ] Comprehensive tests: add path, remove path with running-step guard, update_meta with trigger diff, circular-dep guard, ambient-env fallback, missing-instance.

**Commit:** `feat(recipe): recipe.update_steps tool`

### Task 7.5: `recipe.steps.update_status` tool

**Files:** `mcp-server/src/tools/recipe.ts`, `mcp-server/tests/recipe-step-tools.test.mjs`

- [ ] Tool schema per spec §10.5.
- [ ] Entry hook on `running`: registers declared triggers with `recipe_step_id` set.
- [ ] Exit hook on terminal: disables auto-declared triggers.
- [ ] `request_user_input` shortcut: atomic status update + inbox INSERT.
- [ ] Monotonic transition enforcement (return `INVALID_STEP_TRANSITION` error).
- [ ] Recipe-instance terminal cascade: if all steps terminal, mark instance terminal too.
- [ ] Comprehensive tests covering all transitions, hooks, attachments, request_user_input flow.

**Commit:** `feat(recipe): recipe.steps.update_status with hooks + monotonic guard`

### Task 7.6: `recipe.upsert` format arg

**Files:** `mcp-server/src/tools/recipe.ts`, `mcp-server/src/validators.ts`

- [ ] Add `format: 'yaml' | 'json'` optional arg to `recipe.upsert` (default `'yaml'`).
- [ ] On save, write to `<recipes-dir>/<id>.<ext>` and remove any duplicate-id file in the other format atomically.
- [ ] Tests.

**Commit:** `feat(recipe): recipe.upsert format arg (yaml or json)`

---

## Phase 8 — API + bootstrap

### Task 8.1: `/api/cron/*` and `/api/fires/*` endpoints

**Files:** `mcp-server/src/cli/start.ts`, `mcp-server/tests/cron-api.test.mjs`

- [ ] `GET /api/cron/status` per spec §9.1.
- [ ] `GET /api/fires` with filters per spec §9.2.
- [ ] `GET /api/fires/:fire_id?attempt=N` per spec §9.3 (read stdout/stderr/callbacks from disk; truncate >1MB).
- [ ] `POST /api/fires/:fire_id/retry` per spec §9.4.
- [ ] `POST /api/cron/diagnose` per spec §9.5.
- [ ] All require bearer auth (existing pattern).
- [ ] Mount inside the existing HTTP server. SSE topic `'fires'` already wired via event-bus.
- [ ] Tests for each endpoint.

**Commit:** `feat(api): cron + fires endpoints`

### Task 8.2: `/callback/<fire_id>` route

**Files:** `mcp-server/src/cli/start.ts`, `mcp-server/src/dispatcher.ts`

- [ ] HTTP POST handler at `/callback/:fire_id`.
- [ ] Auth: `Authorization: Bearer <per-fire-secret>` (dispatcher injects via `CLAWDEVBOX_MCP_SECRET` env).
- [ ] Body appended to the fire's `attempt-<N>/callbacks.json`.
- [ ] 401 on bad secret; 404 on unknown fire.
- [ ] Tests.

**Commit:** `feat(api): /callback/<fire_id> for Mode-B trigger callbacks`

### Task 8.3: Bootstrap — `listenOrConfirmExisting`

**Files:** `mcp-server/src/cli/start.ts`, `mcp-server/tests/mcp-bootstrap.test.mjs`

- [ ] Implement per spec §8.2.
- [ ] On `EADDRINUSE`: probe `/api/cron/status` with the bearer token. If 200 with our signature, log + exit 0 ("already-running"). Otherwise log + exit 1 ("conflict").
- [ ] Test: two sequential `clawdevbox start` invocations; second exits cleanly.

**Commit:** `feat(start): listen-or-confirm-existing singleton`

### Task 8.4: Bootstrap — `ensureHttpServiceRunning` in MCP

**Files:** `mcp-server/src/cli/mcp.ts`, `mcp-server/tests/mcp-bootstrap.test.mjs`

- [ ] Implement per spec §8.1.
- [ ] On entry to `runMcp()` before `server.connect()`: check `service.json` + probe `/healthz`. If absent/stale, `spawnDetached` `clawdevbox start --service-runner` and probe for up to 10s.
- [ ] MCP session never fails on bootstrap failure — warn + continue.
- [ ] Test: stop any running service; `clawdevbox mcp` (stdio) → asserts auto-spawn → `/healthz` becomes responsive within 10s.

**Commit:** `feat(mcp): auto-bootstrap HTTP service on MCP startup`

---

## Phase 9 — Docs

### Task 9.1: `docs/tools/cron.md` (new)

- [ ] Document `/api/cron/status`, `/api/fires`, `/api/fires/:id`, `/api/fires/:id/retry`, `/api/cron/diagnose`, `/callback/:fire_id`.
- [ ] Include curl examples and example JSON responses.

### Task 9.2: Update `docs/tools/trigger.md`

- [ ] Document `max_attempts` + `backoff_ms` on `register`/`update_params`.
- [ ] Document real `trigger.fire` (no longer a stub).
- [ ] Document the new lineage columns visible via `trigger.list`.

### Task 9.3: Update `docs/tools/recipe.md`

- [ ] Document `recipe.update_steps`, `recipe.steps.update_status`, and `recipe.upsert format`.
- [ ] Document the canonical `Step` schema with examples.
- [ ] Document the ambient env vars agents can rely on.

### Task 9.4: Regenerate `docs/MCP-TOOLS-REFERENCE.md`

- [ ] Run `python docs/scripts/compose_master_doc.py`.
- [ ] Update tool counts in `docs/scripts/compose_master_doc.py` if needed.
- [ ] Verify the regenerated reference looks right.

**Commit:** `docs: cron + recipe-steps + trigger updates; regen master ref`

---

## Phase 10 — Live verification

### Task 10.1: End-to-end cron fire smoke

- [ ] `clawdevbox start &` in a tmp project.
- [ ] Register a cron trigger with `cron: '*/2 * * * * *'` and `binds_callback_to_recipe: 'simple-prompt'`.
- [ ] Wait 5 seconds.
- [ ] Assert via API: at least one `recipe_instances` row exists with `trigger_id` + `fire_id` set, plus an `agent_sessions` row linked to it.

### Task 10.2: `trigger.fire` manual smoke

- [ ] `trigger.fire` against a manual trigger with a script binding.
- [ ] Assert fire transitions queued → running → success within a few seconds.
- [ ] Assert `attempt-1/stdout.txt` exists on disk.

### Task 10.3: Step API smoke

- [ ] Start a recipe instance with declared step-level triggers in the YAML.
- [ ] As the agent: call `recipe.steps.update_status({step_id, status: 'running'})`.
- [ ] Assert declared triggers register in DB.
- [ ] Call `update_status({step_id, status: 'done'})`.
- [ ] Assert declared triggers disabled.

### Task 10.4: Bootstrap smoke

- [ ] Stop any running service.
- [ ] `clawdevbox mcp` (with stdio kept open by a smoke test harness).
- [ ] Assert `service.json` appears.
- [ ] Assert `GET /healthz` returns 200.

### Task 10.5: Final test suite + build

- [ ] `npm run typecheck` clean.
- [ ] `npm run build` clean.
- [ ] `npm test` clean (all suites pass).
- [ ] Commit final state.

**Commit:** `test: end-to-end kernel smoke (cron + manual + step API + bootstrap)`

---

## Out of scope (this plan)

These are listed in the spec §16 and are explicitly deferred:

- SPA UI work (Fires timeline, stepper view, agent-session detail, artifact gallery) — kernel works headlessly first.
- Agent-session-resume runtime — binding stubs with `failed/error='agent_session_resume_not_implemented'`.
- Webhook source (`/hooks/<trigger-id>`).
- Event-bus source (binding triggers to `emitChange` topics).
- Read-only API endpoints for sessions/artifacts/steps/events.
- 1-hour safety-net poll for hung agent sessions.
- Cross-project fan-out.
- `clawdevbox db repair` / `db vacuum` subcommands.

These can be implemented incrementally on top of the kernel without breaking changes.

---

## Execution notes for subagents

- **Model:** All subagents use Opus 4.7 1M (`claude-opus-4.7-1m-internal`). Never use Haiku.
- **Branch:** Work on `main`. Commit per phase per the labels above.
- **Tests:** Run `npm test` and `npm run typecheck` at every phase boundary. Do NOT proceed if tests fail.
- **Sources on disk:** Recipe YAML/JSON, trigger scripts, inbox bodies, artifact folders, fire output blobs — these never move to DB. DB stores pointers + metadata only.
- **No data migration:** Legacy JSON files are logged + ignored. The DB starts fresh on every install.
- **Foreign keys ON:** `PRAGMA foreign_keys=ON` is set in `openDatabase()`. All FK-dependent INSERTs must respect parent rows.
- **Better-sqlite3 is synchronous:** No `await` on DB calls. Wrap multi-statement work in `db.transaction(() => ...)()` for atomicity.
- **Atomic claim races:** The dispatcher's `claimNextFire` is the only operation that needs `BEGIN IMMEDIATE`. The atomicity comes from the single-writer-WAL model.
- **Backward compat:** Existing sample recipes (`samples/plugins/*/recipes/*.yaml`) MUST still validate and run. Integer step ids are coerced to strings at validator time.
- **Don't break existing tests:** All 90 tests must remain green throughout. Add new tests; don't delete existing ones unless they test now-removed behaviour.
