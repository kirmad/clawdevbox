# Trigger Kernel: Scheduler, Dispatcher, Fires DB, and HTTP-Service Bootstrap

**Status:** Draft (design)
**Date:** 2026-05-14
**Scope:** A unified async-execution kernel for clawdevbox. Adds a SQLite database, a sleep-until-next-fire scheduler, a concurrency-capped dispatcher, durable fire records with retry, lineage tracking from trigger to inbox, and MCP-side auto-bootstrap of the HTTP service.

## 1. Problem

Three structural gaps block clawdevbox from being a real automation kernel:

1. **No cron daemon.** `trigger.fire` is a metadata stub; cron-scheduled triggers never fire. `trigger.test` is currently the only path that spawns a script.
2. **No durable record of async work.** Recipe instances, inbox items, and trigger registrations live as JSON files scattered across the workspace tree. There is no fire ledger at all. A service crash mid-fire leaves no recoverable record. There is no SPA timeline of "what just happened."
3. **MCP and HTTP service are independent.** Agents who use `clawdevbox mcp` (stdio) get all the tools but no cron, no SPA, no push notifications, until the user separately runs `clawdevbox start`. There is no auto-bootstrap path.

The product positions clawdevbox as the kernel that drives async triggers, recipe spawns, and event-driven work. Until the gaps above close, none of that is real — every async path either depends on the agent CLI staying alive or on a user remembering to run `start --service`.

## 2. Goals & Non-Goals

### Goals

- Replace JSON-file storage for triggers, recipe instances, and inbox with a single SQLite database at `<globalDir>/clawdevbox.db`.
- Add a durable `fires` table that records every scheduled-or-triggered execution of a trigger, with retry and dead-letter semantics.
- Build an event-driven scheduler that sleeps until the next cron boundary or retry — no busy-wait polling.
- Build a concurrency-capped dispatcher that pulls queued fires, runs their bindings (recipe spawn or trigger script), and writes back outcomes.
- Make `trigger.fire` real — manual fires go through the same pipeline as cron.
- Make `clawdevbox mcp` auto-bootstrap the HTTP service when it isn't running.
- Track lineage end-to-end: every fire links to the trigger that scheduled it, every recipe instance links to the fire that spawned it, every inbox item links to all of the above.

### Non-Goals (deferred to a Phase 2 spec)

- **Data migration from the existing JSON files.** The new schema starts empty. Legacy files are detected and logged as warnings but ignored. Users re-register what they want.
- **Webhook source.** `POST /hooks/<trigger-id>` is not wired in this kernel. Adds a `source='webhook'` row when shipped.
- **Event-bus source.** Binding triggers to in-process `emitChange` topics is deferred. Adds a `source='event'` row when shipped.
- **Agent-session resume runtime.** The `binds_callback_to: agent_session_resume` binding is defined in the data model and validated in `template.yaml`, but the dispatcher leaves those fires `failed` with `error='agent_session_resume_not_implemented'` until the resume runtime ships (Phase 2). The DB schema is fully in place so no migration is needed when the runtime arrives.

## 3. Architectural Overview

The kernel runs entirely inside the long-running HTTP service process (`clawdevbox start`).

The product is organized around **six primitives**, each backed by its own SQLite table (§4.2):

1. **Workspace** — a directory + identity that owns artifacts, recipe instances, and trigger registrations. Sub-recipes inherit their parent's workspace, allowing shared design docs and other knowledge to flow between steps.
2. **Trigger** — a long-lived watcher that fires on a schedule, on event, or on manual invocation. Triggers can be top-level (they spawn a recipe) or step-scoped (a recipe step declares a trigger that listens during the step's lifetime).
3. **Recipe** (instance) — a sequence of steps the agent works through, optionally spawning sub-agent sessions, waiting for user approval, or producing artifacts. The SPA renders the stepper so the user always knows where the work stands.
4. **Agent Session** — a single agent-CLI process (Copilot, Claude, …). Sessions are bound to a recipe instance and usually a specific step. The user can open a session interactively at any time; otherwise it runs autonomously. Resume-of-a-prior-session is a first-class field.
5. **Artifact** — a folder of files plus metadata, rendered in the SPA via a typed renderer (PR comments, PR walkthrough, design doc, …). Files stay on disk; the DB holds metadata only.
6. **Inbox Item** — the agent's primary channel for notifying the user. Tied optionally to a recipe instance, step, agent session, trigger, or fire — clicking any inbox item reconstructs the full causal chain.

Four cooperating components implement the kernel itself:

1. **Database layer (`mcp-server/src/db/`)** — single SQLite file at `<globalDir>/clawdevbox.db` opened in WAL mode via `better-sqlite3`. Versioned migrations apply on every service boot. The database is the source of truth for triggers, fires, recipe instances, and inbox metadata.

2. **Scheduler (`mcp-server/src/scheduler.ts`)** — event-driven, sleep-until-next-fire. One `setTimeout` at any time. On wake: enqueues cron-due fires, promotes retrying fires whose `next_retry_at` has passed, pokes the dispatcher, computes the next wake. Listens on the event bus for `triggers` and `fires` changes and reschedules. Includes a 60-second safety-net interval that calls `reschedule()` unconditionally.

3. **Dispatcher (`mcp-server/src/dispatcher.ts`)** — concurrency-capped (default 4 in-flight) worker. Not polling: invoked by the scheduler on wake and by itself on every fire completion. Atomically claims the oldest queued fire, runs the binding (recipe spawn or trigger script), writes back outcome, applies retry-with-backoff or dead-letter on failure.

4. **Bootstrap & singleton enforcement** — the HTTP port binding is the lease. A second `clawdevbox start` invocation sees `EADDRINUSE`, probes `GET /api/cron/status` to confirm it's our service, and exits cleanly. `clawdevbox mcp` (stdio) auto-spawns the HTTP service via `spawnDetached` if `<globalDir>/service.json` is absent or stale.

## 4. Data Model

### 4.1 Storage location

- **DB**: single SQLite file at `<globalDir>/clawdevbox.db` (WAL mode).
- **User-authored content stays on disk** — recipe YAML/JSON, trigger template manifests, trigger scripts, inbox bodies, artifact files. The DB holds metadata and pointers only.
- **Fire output blobs** (stdout, stderr, captured callbacks) live at `<workspace>/.clawdevbox/fires/<fire_id>/attempt-<N>/` and are referenced from `fires.output_dir`.
- **Ad-hoc recipe snapshots** (`recipe.run({source: ...})`) write the inline YAML/JSON to `<workspace>/.clawdevbox/recipe-snapshots/<recipe_instance_id>.<ext>`. The DB stores the path in `recipe_instances.recipe_snapshot_path`.
- **Artifact folders** live at `<workspace>/.clawdevbox/artifacts/<artifact_id>/`. The DB stores the path in `artifacts.dir_path`.

### 4.2 Schema v1

The schema implements the six primitives plus the fires ledger and an append-only step-event log. SQLite permits forward references in `REFERENCES`; the listed order below is for readability, not creation order.

```sql
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Primitive 1: Workspaces
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT,
  parent_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_workspaces_parent ON workspaces(parent_workspace_id);

-- Primitive 2: Triggers
CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  params_json TEXT NOT NULL,
  cron_mode TEXT NOT NULL CHECK(cron_mode IN ('inherit','override','disabled')),
  cron_expression TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  recipe_instance_id TEXT REFERENCES recipe_instances(id) ON DELETE SET NULL,
  recipe_step_id TEXT REFERENCES recipe_steps(id) ON DELETE SET NULL,
  binds_callback_to TEXT,                              -- 'agent_session_resume' | NULL
  binds_callback_to_recipe TEXT,                       -- recipe id | NULL
  auto_declared INTEGER NOT NULL DEFAULT 0,            -- 1 = registered automatically when a step entered 'running'
  auto_registered_by_step_id TEXT REFERENCES recipe_steps(id) ON DELETE CASCADE,
  expires_at INTEGER,
  once INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  backoff_ms_json TEXT NOT NULL DEFAULT '[30000,120000,600000]',
  registered_at INTEGER NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  last_run_at INTEGER,
  last_run_status TEXT,
  last_run_error TEXT
);
CREATE INDEX idx_triggers_active ON triggers(enabled, workspace_id) WHERE enabled=1;
CREATE INDEX idx_triggers_recipe ON triggers(recipe_instance_id);
CREATE INDEX idx_triggers_step   ON triggers(recipe_step_id);

-- Primitive 3a: Recipe instances
CREATE TABLE recipe_instances (
  id TEXT PRIMARY KEY,
  recipe_id TEXT,                                       -- NULL for ad-hoc (snapshot only)
  recipe_snapshot_path TEXT,                            -- path on disk; never NULL for ad-hoc
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL,
  parent_recipe_instance_id TEXT REFERENCES recipe_instances(id) ON DELETE SET NULL,
  prompt TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','success','failure','cancelled')),
  completed_at INTEGER,
  result TEXT,
  message TEXT,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  fire_id TEXT REFERENCES fires(fire_id) ON DELETE SET NULL
);
CREATE INDEX idx_recipe_instances_ws      ON recipe_instances(workspace_id, started_at DESC);
CREATE INDEX idx_recipe_instances_trigger ON recipe_instances(trigger_id);
CREATE INDEX idx_recipe_instances_fire    ON recipe_instances(fire_id);

-- Primitive 3b: Recipe steps (materialized from the recipe's steps[])
CREATE TABLE recipe_steps (
  id TEXT PRIMARY KEY,                                  -- 'rs_<base36>' (DB key; FK target from sessions/triggers/artifacts/inbox/events)
  recipe_instance_id TEXT NOT NULL REFERENCES recipe_instances(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,                          -- declaration order in the recipe
  step_id TEXT NOT NULL,                                -- step id from the recipe (string; legacy integer ids coerced)
  name TEXT,                                            -- display name (falls back to step_id)
  goal TEXT NOT NULL,                                   -- prose for the agent (recipe.step.goal)
  depends_json TEXT NOT NULL DEFAULT '[]',              -- string[] of dependent step_ids
  params_schema_json TEXT NOT NULL DEFAULT '[]',        -- declared step-local parameter schema
  triggers_decl_json TEXT NOT NULL DEFAULT '[]',        -- declared triggers (auto-registered on step entry)
  artifacts_decl_json TEXT NOT NULL DEFAULT '[]',       -- declared artifacts (UI hint)
  status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed','awaiting_user','skipped')),
  message TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER,
  completed_at INTEGER,
  awaiting_user_message TEXT,
  result TEXT,
  error TEXT,
  UNIQUE(recipe_instance_id, step_id)
);
CREATE INDEX idx_steps_instance ON recipe_steps(recipe_instance_id, step_index);
CREATE INDEX idx_steps_status   ON recipe_steps(status);

-- Primitive 4: Agent sessions
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,                                  -- 'as_<base36>'
  cli_session_id TEXT,                                  -- preserved across resumes (the agent CLI's own session id)
  recipe_instance_id TEXT REFERENCES recipe_instances(id) ON DELETE CASCADE,
  recipe_step_id TEXT REFERENCES recipe_steps(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_cli TEXT NOT NULL,                              -- 'copilot' | 'claude' | …
  pid INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','success','failure','cancelled','suspended')),
  result TEXT,
  error TEXT,
  resume_of_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  interactive INTEGER NOT NULL DEFAULT 0                -- 1 = user opened in interactive mode
);
CREATE INDEX idx_sessions_instance ON agent_sessions(recipe_instance_id, started_at DESC);
CREATE INDEX idx_sessions_step     ON agent_sessions(recipe_step_id);
CREATE INDEX idx_sessions_resume   ON agent_sessions(resume_of_agent_session_id);
CREATE INDEX idx_sessions_active   ON agent_sessions(status) WHERE status IN ('running','suspended');

-- Primitive 5: Artifacts (metadata; files live at dir_path)
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,                                  -- 'art_<base36>'
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipe_instance_id TEXT REFERENCES recipe_instances(id) ON DELETE CASCADE,
  recipe_step_id TEXT REFERENCES recipe_steps(id) ON DELETE SET NULL,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  artifact_decl_id TEXT,                                -- the id from the step's artifacts_decl (when matched)
  type TEXT NOT NULL,                                   -- renderer key (pr-review | pr-walkthrough | design-doc | …)
  title TEXT,
  dir_path TEXT NOT NULL,                               -- absolute filesystem path to the artifact folder
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_ws       ON artifacts(workspace_id, created_at DESC);
CREATE INDEX idx_artifacts_instance ON artifacts(recipe_instance_id);
CREATE INDEX idx_artifacts_step     ON artifacts(recipe_step_id);
CREATE INDEX idx_artifacts_session  ON artifacts(agent_session_id);

-- Primitive 6: Inbox items
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  preview TEXT,
  body_path TEXT,
  attachments_json TEXT,
  labels_json TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'unread',
  snoozed_until INTEGER,
  recipe_instance_id TEXT REFERENCES recipe_instances(id) ON DELETE SET NULL,
  recipe_step_id TEXT REFERENCES recipe_steps(id) ON DELETE SET NULL,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  fire_id TEXT REFERENCES fires(fire_id) ON DELETE SET NULL,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_inbox_status ON inbox_items(status, created_at DESC);
CREATE INDEX idx_inbox_step   ON inbox_items(recipe_step_id);

-- Fires ledger
CREATE TABLE fires (
  fire_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK(source IN ('cron','manual','webhook','event')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','success','failed','retrying','dead','skipped')),
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  next_retry_at INTEGER,
  exit_code INTEGER,
  duration_ms INTEGER,
  output_dir TEXT,
  error TEXT,
  recipe_instance_id TEXT REFERENCES recipe_instances(id) ON DELETE SET NULL,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  payload_json TEXT
);
CREATE INDEX idx_fires_queue   ON fires(status, scheduled_at);
CREATE INDEX idx_fires_retry   ON fires(status, next_retry_at) WHERE status='retrying';
CREATE INDEX idx_fires_recent  ON fires(workspace_id, scheduled_at DESC);
CREATE INDEX idx_fires_trigger ON fires(trigger_id, status);

-- Step events (append-only activity log for the SPA stepper UI)
CREATE TABLE step_events (
  id TEXT PRIMARY KEY,                                  -- 'ev_<base36>'
  recipe_step_id TEXT NOT NULL REFERENCES recipe_steps(id) ON DELETE CASCADE,
  recipe_instance_id TEXT NOT NULL REFERENCES recipe_instances(id) ON DELETE CASCADE,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                                   -- 'status_changed' | 'message' | 'state_patched' | 'artifact_attached' | 'inbox_attached' | 'trigger_registered' | 'trigger_unregistered' | 'trigger_registration_failed' | 'user_input_requested' | 'user_input_received' | 'meta_patched' | 'step_added' | 'step_removed'
  message TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_step_events_step     ON step_events(recipe_step_id, created_at DESC);
CREATE INDEX idx_step_events_instance ON step_events(recipe_instance_id, created_at DESC);
```

### 4.3 Canonical step schema

The same `Step` shape is used by:
- recipe YAML/JSON files on disk (`<recipes>/<recipe-id>.{yaml|yml|json}`),
- the `recipe.upsert` MCP tool's `source` payload,
- the `recipe.update_steps` MCP tool's `add` and `update_meta` arrays.

Single source of truth — agent-authored steps look identical regardless of where they originate.

```ts
type Step = {
  id: string;                       // kebab-case; legacy integer ids coerced at load time
  name?: string;                    // display name for UI; falls back to id
  goal: string;                     // prose for the agent (required, non-empty)
  depends?: string[];               // ids of steps this depends on

  params?: Array<{                  // step-local parameter schema
    name: string;
    type: 'string'|'integer'|'number'|'boolean'|'array'|'object';
    required?: boolean;
    default?: unknown;
    description?: string;
  }>;

  triggers?: Array<{                // triggers auto-registered when step enters 'running'
    type: string;                   // trigger TYPE id (e.g. 'ado.comment-watcher')
    params?: Record<string, unknown>;
    cron?: string | null | false;
    binds_callback_to?: 'agent_session_resume';
    binds_callback_to_recipe?: string;
    once?: boolean;
    expires_at?: number;
    max_attempts?: number;
    backoff_ms?: number[];
  }>;

  artifacts?: Array<{               // declared artifacts (UI hint; not enforced)
    id: string;                     // matched against artifact_decl_id on attachment
    type: string;                   // renderer key
    title?: string;
  }>;
};
```

**Materialization.** When a `recipe_instances` row is created, every entry of `steps[]` is INSERTed into `recipe_steps` with `status='pending'`. The serialized step fields populate the dedicated columns (`name`, `goal`, `depends_json`, `params_schema_json`, `triggers_decl_json`, `artifacts_decl_json`). The step's recipe-defined `id` is stored in `step_id`; the `id` PK is generated as `rs_<base36>`.

**Backward compatibility.** The existing sample recipes use integer step ids (`id: 1`, `depends: [1, 2]`). At validator time, the coercion rule is:
- `step.id: <number>` → `step_id: String(number)` (only `Number.isInteger` allowed).
- `step.depends: [<int>, …]` → `[String(int), …]`.
- Missing `name` / `triggers` / `params` / `artifacts` → defaults (null / empty arrays).

The validator (`validateRecipeParsed` in `validators.ts`) is updated to accept either form. No on-disk migration is required.

**Declared triggers — server semantics.** When a step transitions to `status='running'` via `recipe.steps.update_status`, the server reads `triggers_decl_json` and registers each entry into the `triggers` table with:
- `workspace_id` = the instance's workspace,
- `recipe_instance_id` = the current instance,
- `recipe_step_id` = this step's `id`,
- `auto_declared = 1`,
- `auto_registered_by_step_id` = this step's `id`,
- all other fields from the declaration.

The registered trigger ids are appended to the step's `state_json.declared_trigger_ids`. When the step transitions to a terminal status (`done`, `failed`, `skipped`), the server runs `UPDATE triggers SET enabled=0 WHERE auto_registered_by_step_id = ?`. The recipe-instance terminal cascade also disables any auto-declared triggers that escaped step-level cleanup.

**Declared artifacts — server semantics.** Declared artifacts are UI hints. The SPA can render placeholder cards for the step's planned outputs. When the agent later attaches a real artifact via `update_status({attach_artifact_ids: [...]})`, the server matches by the artifact's optional `artifact_decl_id`; otherwise it attaches as ad-hoc.

### 4.4 Recipe file formats

Recipes are accepted in either YAML (`.yaml` / `.yml`) or JSON (`.json`). The validator parses both into the same canonical `Step` shape (§4.3) before checking. Inline `source` payloads (`recipe.run({source: '...'})`, `recipe.upsert({source: '...'})`) are sniffed by leading non-whitespace character: `{` or `[` → JSON.parse, anything else → js-yaml load.

The `recipe.upsert` tool gains an optional `format: 'yaml' | 'json'` argument that controls the saved file extension (default `yaml` for human-authoring continuity, §10.6).

Guidance: YAML is recommended for human-authored recipes (multi-line `goal:` prose reads better). JSON is recommended for agent-generated recipes (less ambiguous, matches the MCP tool payloads exactly).

### 4.5 Legacy-file handling

On every boot, the migration runner checks for these legacy files:
- `<projectDir>/.clawdevbox/triggers.json`
- `<workspacesRoot>/*/.clawdevbox/triggers.json`
- `<workspace>/.clawdevbox/recipe-instances/*.json`
- `<globalDir>/inbox.json`

For each one found, emit one structured warning at INFO level: `legacy file detected at <path> — ignored; re-register if needed`. Files are not read, not deleted, not moved. They are inert.

### 4.6 Cron mode encoding

Cron has three states per registration: inherit (use the TYPE's `default_cron`), override (use a specific expression), or disabled (manual/webhook only). The schema uses two columns rather than sentinel values:

| `cron_mode` | `cron_expression` | Meaning |
|---|---|---|
| `inherit` | NULL | Use the TYPE's `default_cron`. If the TYPE has none, the trigger never fires on a schedule. |
| `override` | `'<expr>'` | Use this expression. |
| `disabled` | NULL | Cron disabled. Trigger can still fire via `trigger.fire` (manual) or, when shipped, webhook/event sources. |

The MCP tools `trigger.register` / `trigger.update_params` translate the existing `cron: string | null | false` argument into these two columns. The on-the-wire schema does not change.

### 4.7 Lineage chain

Every artifact downstream of a trigger fire carries its causal lineage:

```
triggers.id ──► fires.trigger_id ──► fires.recipe_instance_id ──► recipe_instances.id
                       │                                                  │
                       ▼                                                  ▼
                fires.agent_session_id ◄── agent_sessions.recipe_instance_id
                                                       │
                                                       ▼
                                              recipe_steps.recipe_instance_id ──► recipe_steps.id
                                                                                       │
                       ┌──────────────────────────────────────────────────────────────┘
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
  artifacts.    inbox_items.       step_events.
  recipe_step_id recipe_step_id    recipe_step_id
  recipe_instance_id recipe_instance_id recipe_instance_id
  agent_session_id   agent_session_id   agent_session_id
                     trigger_id
                     fire_id
```

A single SQL JOIN reconstructs the full causal trace for any artifact, inbox item, or step event.

## 5. Scheduler

### 5.1 Responsibilities

- Compute the next moment any trigger will fire or any retrying fire will resume.
- Sleep until that moment via `setTimeout`.
- On wake: enqueue all due cron fires and all due retry promotions, then poke the dispatcher.
- Respond to trigger CRUD events from the bus (`'triggers'`, `'fires'`) by rescheduling.
- Run a 60-second safety-net interval that calls `reschedule()` unconditionally to defend against clock drift and missed events.

### 5.2 Public interface

```ts
export class Scheduler {
  constructor(db: Database, dispatcher: Dispatcher, ws: Workspace);
  start(): void;
  stop(): void;
  reschedule(): void;
  status(): { next_wake_at: number | null; last_wake_at: number | null; total_wakes: number };
}
```

### 5.3 `reschedule()`

1. Clear the existing `setTimeout` if any.
2. Find the earliest moment among:
   - `nextRunAfter(effectiveCron, now)` for every enabled trigger with a resolved cron expression.
   - `MIN(next_retry_at)` across `fires WHERE status='retrying'`.
3. If non-null, set a `setTimeout(onWake, earliest - now)` (lower-bounded to 0).
4. Record the new `nextWakeAt` and `last_reschedule_at` in `kv`.

### 5.4 `onWake()`

1. For every enabled trigger, compute `nextRunAfter(effectiveCron, now - 1s)`. If the result is `≤ now + 50ms`, INSERT a `fires` row with `status='queued'`, `source='cron'`, `scheduled_at=now`. Run all inserts in one transaction. The 1-second lookback absorbs OS/setTimeout jitter (≤1s); any boundary older than that is silently skipped — this is the skip-missed semantic.
2. For every `fires WHERE status='retrying' AND next_retry_at <= now`, UPDATE to `status='queued'`.
3. Call `dispatcher.pickUp()`.
4. Call `reschedule()`.

### 5.5 Skip-missed semantics

When the service was down across cron boundaries, the scheduler does NOT replay missed fires. The `nextRunAfter(cron, now - 1s)` window above only catches boundaries within the last second. Any cron boundary that elapsed while the service was down is silently skipped — the next fire is computed from the current moment forward. This matches standard cron behaviour.

### 5.6 Event-bus integration

Listens for two topics:

- `'triggers'` — fired whenever the `triggers` table changes (any register/update/delete/enable/disable). Triggers a `reschedule()`.
- `'fires'` — fired whenever the `fires` table changes. Triggers a `reschedule()` (a new retrying fire may have the soonest deadline).

### 5.7 Safety net

A 60-second `setInterval` that calls `reschedule()` unconditionally. Defends against:
- Wall-clock jumps (NTP sync, daylight saving).
- Missed event-bus notifications (defensive — the bus is in-process so this should not happen, but the cost of one extra reschedule per minute is negligible).
- Any bug where in-memory state and DB state diverge.

## 6. Dispatcher

### 6.1 Responsibilities

- Pull `queued` fires from the database in FIFO order by `scheduled_at`.
- Cap parallelism at `maxConcurrent` (default 4).
- Per-trigger overlap-skip: if a fire's trigger already has another fire `running`, mark this fire `skipped` and continue.
- Resolve the trigger TYPE and run the binding:
  - **Recipe binding** (`binds_callback_to_recipe`): call `runRecipe()` (extracted from `tools/recipe.ts`) directly. The spawned recipe instance gets `trigger_id` and `fire_id` set on its row.
  - **Script binding** (no callback binding): call `runTriggerScript()` from `trigger-runner.ts`. Capture Mode A + Mode B callbacks.
  - **Agent-session-resume binding**: return `failed` with `error='agent_session_resume_not_implemented'`. (Phase 2.)
- Persist the outcome: success, failed-with-retry, or dead.
- On every completion, call `pickUp()` again to fill the freed slot.

### 6.2 Public interface

```ts
export class Dispatcher {
  constructor(db: Database, ws: Workspace, opts?: { maxConcurrent?: number });
  start(): void;
  stop(): Promise<void>;
  pickUp(): void;
  status(): { in_flight: number; max_concurrent: number; queued_count: number; retrying_count: number; dead_count: number };
}
```

### 6.3 Atomic claim with overlap-skip

```sql
BEGIN IMMEDIATE;
SELECT * FROM fires WHERE status='queued' ORDER BY scheduled_at LIMIT 1;
-- If the row's trigger_id has another fire WHERE status='running':
UPDATE fires SET status='skipped', finished_at=?, error='overlap_skip' WHERE fire_id=? AND status='queued';
-- Else:
UPDATE fires SET status='running', started_at=? WHERE fire_id=? AND status='queued';
COMMIT;
```

The single-writer-WAL guarantees of better-sqlite3 make this race-free. If the claim returns `skipped`, the dispatcher recurses to try the next queued row.

### 6.4 Per-attempt output blobs

Each attempt of a fire writes its outputs to a dedicated directory:

```
<workspace>/.clawdevbox/fires/<fire_id>/
   attempt-1/
      stdout.txt
      stderr.txt
      callbacks.json
   attempt-2/
      stdout.txt
      stderr.txt
      callbacks.json
```

The `fires.output_dir` column stores the parent path (`.../fires/<fire_id>/`). The API endpoint that returns fire detail picks the latest attempt by default, with a `?attempt=N` filter for prior attempts.

### 6.5 Retry policy

On a fire's failure (non-zero exit, timeout, or exception thrown by the binding):

```
backoffs = JSON.parse(triggers.backoff_ms_json) || [30000, 120000, 600000]

if (fire.attempt < fire.max_attempts) {
  next_retry_at = now + backoffs[fire.attempt - 1] ?? backoffs[backoffs.length - 1]
  UPDATE fires SET status='retrying', attempt=attempt+1, next_retry_at=?, error=?, output_dir=? WHERE fire_id=?
  scheduler.reschedule()
} else {
  UPDATE fires SET status='dead', finished_at=?, error=?, output_dir=? WHERE fire_id=?
  // Dead-letter to inbox
  inbox.add({
    title: `Trigger fire failed permanently: ${trigger.id}`,
    preview: error.slice(0, 200),
    body: full_error,
    source: 'trigger-dead',
    workspace_id, trigger_id, fire_id,
  })
  UPDATE triggers SET last_run_at=?, last_run_status='error', last_run_error=? WHERE id=?
}
```

Per-trigger overrides: `max_attempts` and `backoff_ms_json` are columns on the `triggers` table, exposed via optional fields on `trigger.register` and `trigger.update_params`.

### 6.6 `once: true` semantics

When a `once=1` trigger's fire succeeds:

```
UPDATE triggers SET enabled=0 WHERE id=?
emitChange('triggers')   -- triggers a reschedule
```

The registration row stays on disk so the agent can see the history; `enabled=0` removes it from the scheduler's consideration. Agent can re-enable explicitly if desired.

### 6.7 Graceful shutdown

`dispatcher.stop()` returns a Promise that:
1. Stops accepting new `pickUp()` calls (sets an internal `stopped=true` flag).
2. Waits up to 15 seconds for in-flight fires to finish naturally.
3. For any fire still in-flight at the deadline, UPDATE `status='failed'`, `error='service_shutdown'`. The retry loop picks it up on next boot.

## 7. Bindings

The dispatcher resolves a fire's binding from the trigger's TYPE manifest. Three binding modes are recognized:

### 7.1 Recipe binding

```yaml
binds_callback_to_recipe: pr-review
```

The dispatcher calls `runRecipe()` (the extracted core of `recipe.run`) with:
- `recipeId`: from `binds_callback_to_recipe`
- `prompt`: synthesized from the trigger (see §7.4)
- `params`: `{ ...trigger.params, ...fire.payload, _trigger_state: trigger.state }`
- `triggerId`: the fire's trigger_id
- `fireId`: the fire's fire_id
- `workspaceId`: defaults to the workspace where the trigger was registered

The returned `RecipeInstance` is saved with `trigger_id` and `fire_id` set so the lineage chain is complete.

### 7.2 Script binding (no `binds_callback_to_recipe`, no `binds_callback_to`)

The dispatcher calls `runTriggerScript()` from `trigger-runner.ts` with the trigger's script path, runtime, and a synthesized envelope:

```ts
{
  trigger_event_name: 'TriggerFired',
  trigger_id: fire.trigger_id,
  run_id: fire.fire_id,
  callback_url: `http://127.0.0.1:${cfg.http.port}/callback/${fire.fire_id}`,
  state: trigger.state,
  payload: fire.payload,
}
```

A `/callback/<fire_id>` HTTP route on the existing HTTP server captures Mode B POSTs. Each accepts `Authorization: Bearer <per-fire-secret>` (injected as `CLAWDEVBOX_MCP_SECRET` env into the script). Captured bodies are appended to `attempt-N/callbacks.json`. After exit, Mode A is parsed from stdout's `callback.body` field and prepended.

If the script's `stdout_parsed.state` is an object, it is persisted back to `triggers.state_json` on success. This is how a trigger's state evolves across runs.

### 7.3 Agent-session-resume binding (Phase 2)

For Phase 1: returns `failed` with `error='agent_session_resume_not_implemented'`. The fire dead-letters after `max_attempts` and shows up in inbox.

The data model is fully in place. The trigger's `binds_callback_to = 'agent_session_resume'` field, together with `recipe_instance_id` + `recipe_step_id`, is enough to resolve which prior `agent_sessions` row to resume from. When the Phase 2 runtime ships, the dispatcher will:

1. Look up the latest `agent_sessions` row WHERE `recipe_step_id` = trigger.recipe_step_id AND `status ∈ {'suspended','success','failure'}` (typically the suspended one set when the step entered `awaiting_user`).
2. Spawn a new agent CLI process with `--resume <cli_session_id>`, `interactive=0`.
3. INSERT a new `agent_sessions` row with `resume_of_agent_session_id` set to the prior row's id and the same `cli_session_id`.
4. Inject ambient env: `CLAWDEVBOX_AGENT_SESSION_ID`, `CLAWDEVBOX_RECIPE_INSTANCE_ID`, `CLAWDEVBOX_RECIPE_STEP_ID`, `CLAWDEVBOX_WORKSPACE_ID`.
5. Pipe the fire's payload as the agent's first user message (e.g. "Build failed on PR 1234 — react.").

### 7.4 Prompt synthesis for recipe binding

The recipe needs a `prompt` arg. The dispatcher synthesizes one:

```
"Triggered by ${trigger.id} at ${new Date(fire.scheduled_at).toISOString()}.
Payload: ${JSON.stringify(fire.payload)}"
```

A future enhancement could let the trigger TYPE declare a `prompt_template` field for full control.

## 8. MCP Bootstrap

### 8.1 `cli/mcp.ts` changes

Before `server.connect(transport)`, run `ensureHttpServiceRunning(cfg)`:

```ts
async function ensureHttpServiceRunning(cfg: ResolvedConfig): Promise<BootstrapResult> {
  const state = readServiceState(cfg.globalDir);
  if (state && isProcessAlive(state.pid)) {
    const probe = await probeHealth({ host: cfg.http.host, port: state.port, timeoutMs: 1500 });
    if (probe.ok) return { running: true, pid: state.pid, port: state.port, started: false };
  }
  if (state) clearServiceState(cfg.globalDir);

  logger.info({ globalDir: cfg.globalDir }, 'http service not running — bootstrapping');
  const childArgs = ['start', '--service-runner', ...forwardedFlags(cfg)];
  const { pid, logPath } = spawnDetached(execPath, childArgs, { logDir: cfg.globalDir });
  writeServiceState(cfg.globalDir, { pid, port: cfg.http.port, started_at: Date.now(), version, exec_path: execPath, exec_args: childArgs });

  const probe = await probeHealth({ host: cfg.http.host, port: cfg.http.port, timeoutMs: 10_000 });
  if (probe.ok) return { running: true, pid, port: cfg.http.port, started: true };
  return { running: false, reason: probe.reason, logPath };
}
```

The MCP stdio session never fails because bootstrap failed. The agent gets every tool. A WARN log surfaces the failure with a log-file path.

### 8.2 `cli/start.ts` changes

Wrap `httpServer.listen()` in `listenOrConfirmExisting`:

```ts
async function listenOrConfirmExisting(server, host, port, token): Promise<'listening' | 'already-running' | 'conflict'> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    return 'listening';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    const probe = await fetch(`http://${host}:${port}/api/cron/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    if (probe?.ok) return 'already-running';
    return 'conflict';
  }
}
```

- `already-running`: log + exit 0.
- `conflict`: log + exit 1.

### 8.3 Boot order in `runStart`

```
1. resolveConfig + loadWorkspace
2. listenOrConfirmExisting  → exit if already running
3. openDatabase(globalDir)  → run migrations, log legacy-file warnings
4. buildMcpServer, mount /mcp + /healthz + /api/* + /callback/*
5. dispatcher = new Dispatcher(db, ws);  dispatcher.start()
6. scheduler  = new Scheduler(db, dispatcher, ws);  scheduler.start()
7. on SIGTERM / process exit: scheduler.stop(); await dispatcher.stop(); httpServer.close()
```

## 9. API Surface

All new endpoints require `Authorization: Bearer <token>`.

### 9.1 `GET /api/cron/status`

```json
{
  "service": { "pid": 12345, "port": 5201, "started_at": 1715534812000, "version": "0.1.0" },
  "scheduler": { "next_wake_at": 1715534820000, "last_wake_at": 1715534760000, "total_wakes": 17 },
  "dispatcher": { "in_flight": 0, "max_concurrent": 4, "queued_count": 0, "retrying_count": 0, "dead_count": 0 },
  "db": { "path": "C:/Users/.../clawdevbox.db", "schema_version": 1 }
}
```

Used by the second-instance start probe, MCP bootstrap, and the SPA introspection panel.

### 9.2 `GET /api/fires`

Query parameters:
- `status` (csv): `queued,running,success,failed,retrying,dead,skipped`
- `workspace_id` (string)
- `trigger_id` (string)
- `limit` (int, default 50, max 500)
- `before` (int, ms): only return fires with `scheduled_at < before` (pagination)

Returns:

```json
{
  "fires": [
    {
      "fire_id": "fire_abc",
      "workspace_id": "project",
      "trigger_id": "ado.new-pr-watcher#auth-svc",
      "source": "cron",
      "status": "success",
      "attempt": 1,
      "scheduled_at": 1715534760000,
      "started_at": 1715534760100,
      "finished_at": 1715534762000,
      "duration_ms": 1900,
      "recipe_instance_id": "ri_def"
    }
  ],
  "count": 1,
  "next_offset": null
}
```

### 9.3 `GET /api/fires/:fire_id?attempt=N`

```json
{
  "fire": { /* fires row */ },
  "stdout": "...",
  "stderr": "...",
  "callbacks": [
    { "mode": "B", "path": "/callback/fire_abc", "method": "POST", "body": {...}, "received_at": 1715534761500 }
  ],
  "attempts_available": [1, 2]
}
```

`attempt` defaults to the latest. Outputs >1 MB are truncated with a `"truncated": true` flag. Full content is available on the filesystem at `output_dir/attempt-N/`.

### 9.4 `POST /api/fires/:fire_id/retry`

Manual retry of a `failed`, `dead`, or `skipped` fire. Resets to `status='queued'`, `attempt=1`. Pokes the scheduler. Returns:

```json
{ "fire_id": "fire_abc", "status": "queued" }
```

### 9.5 `POST /api/cron/diagnose`

Dev/debug endpoint. Forces `scheduler.reschedule()` and returns the new status. Helpful when iterating on cron expressions.

### 9.6 `/callback/<fire_id>` (internal)

Routes Mode B POSTs from running trigger scripts into the dispatcher's per-fire capture buffer. Auth: `Authorization: Bearer <per-fire-secret>` (set by the dispatcher via the script's `CLAWDEVBOX_MCP_SECRET` env). Each fire gets a fresh secret.

### 9.7 SSE topic

`emitChange('fires')` whenever the `fires` table changes status. The SPA subscribes to the existing `/api/events` SSE stream which already supports topic dispatch.

## 10. MCP Tool Surface Changes

### 10.1 `trigger.fire` (real implementation)

Currently a stub that returns a queued `run_id` without doing anything. New behaviour:

```
INSERT INTO fires (fire_id, workspace_id, trigger_id, source, status, scheduled_at, payload_json, max_attempts)
VALUES (?, ?, ?, 'manual', 'queued', ?, ?, ?)
```

Returns:
```json
{ "fire_id": "fire_abc", "trigger_id": "ado.new-pr-watcher#auth-svc", "status": "queued" }
```

The fire goes through the same dispatch path as a cron fire. Same retry policy. Same lineage.

### 10.2 `trigger.register` / `trigger.update_params`

Two new optional fields:
- `max_attempts`: integer ≥ 1 (default 3).
- `backoff_ms`: array of integers in milliseconds (default `[30000, 120000, 600000]`).

These persist to the `triggers.max_attempts` and `triggers.backoff_ms_json` columns. They are honored by the dispatcher on retry decisions.

### 10.3 `recipe.run` (extracted core)

The handler logic moves to a new `mcp-server/src/recipe-runner.ts` module exposing `runRecipe(opts, ctx): Promise<RecipeInstance>`. The MCP tool becomes a thin wrapper. The dispatcher calls `runRecipe()` directly for recipe-binding fires.

This also lets `runRecipe()` accept `triggerId`, `fireId`, and `parentRecipeInstanceId` as first-class lineage fields, which previously the tool didn't support.

`runRecipe()` is responsible for the **ambient env injection** for every spawned agent process:

| Env var | Value |
|---|---|
| `CLAWDEVBOX_WORKSPACE_ID` | the recipe instance's `workspace_id` |
| `CLAWDEVBOX_RECIPE_INSTANCE_ID` | the new instance's `id` |
| `CLAWDEVBOX_AGENT_SESSION_ID` | the new `agent_sessions` row's `id` |
| `CLAWDEVBOX_RECIPE_STEP_ID` | the current `recipe_steps` row id when scoped (sub-agent for one step), unset when the whole instance is spawned at once |

These let the agent call `recipe.update_steps` / `recipe.steps.update_status` / `inbox.add` without juggling ids — every parameter that defaults to "ambient" reads from these env vars.

### 10.4 `recipe.update_steps`

Adds, removes, or patches step metadata (the recipe-authoring schema fields). Distinct from §10.5 which patches runtime state.

```ts
recipe.update_steps({
  recipe_instance_id?: string,        // defaults to ambient $CLAWDEVBOX_RECIPE_INSTANCE_ID
  add?: Step[];                       // new steps — full §4.3 Step shape
  remove?: string[];                  // step ids; only valid while their status ∈ {pending, skipped}
  update_meta?: Array<Partial<Step> & { id: string }>;   // patch metadata; partial Step (id required)
});
```

**Server semantics.**
- `add`: INSERT new rows in `recipe_steps`. Server validates the §4.3 shape and rejects unresolved `depends`. Returns the inserted DB ids. Emits one `step_events` row per added step (`type='step_added'`).
- `remove`: DELETE rows. Server rejects deletion if `status ∉ {pending, skipped}`. Also rejects if any non-removed step's `depends` would become unresolved. Cascade-deletes auto-declared triggers via the FK. Emits `type='step_removed'` events.
- `update_meta`: UPDATE specified fields. Allowed on any status. If `triggers` is patched on a running step, server diffs old vs new declarations:
  - Removed entries → `UPDATE triggers SET enabled=0` for matching auto-declared rows.
  - Added entries → register them immediately (the step is `running`); for non-running steps, queue for entry-time registration.
  - Emits `type='meta_patched'` event.
- All changes emit `'recipes'` SSE topic. All changes are wrapped in a single transaction per call.

**Errors.** `INVALID_STEP_SCHEMA`, `INVALID_DEPENDENCY`, `STEP_NOT_FOUND`, `CANNOT_REMOVE_RUNNING_STEP`, `CIRCULAR_DEPENDENCY`, `RECIPE_INSTANCE_NOT_FOUND`.

### 10.5 `recipe.steps.update_status`

Patches the runtime state of a single step. Does NOT modify the step's recipe-authoring fields (use `recipe.update_steps.update_meta` for those).

```ts
recipe.steps.update_status({
  recipe_instance_id?: string,        // defaults to ambient $CLAWDEVBOX_RECIPE_INSTANCE_ID
  step_id: string,                    // required
  status?: 'running'|'done'|'failed'|'skipped'|'awaiting_user',
  message?: string,                   // short progress message for UI
  state?: Record<string, unknown>,    // shallow-merged into state_json
  state_replace?: Record<string, unknown>,   // replaces state_json wholesale (mutually exclusive with state)
  result?: string,                    // terminal-only, on done|failed
  error?: string,                     // terminal-only, on failed
  attach_artifact_ids?: string[],     // link existing artifacts to this step
  attach_inbox_item_ids?: string[],   // link existing inbox items to this step
  request_user_input?: {              // shortcut: sets status='awaiting_user' AND creates an inbox item
    message: string,
    options?: string[],
    inbox_item?: { title?: string; labels?: string[] },
  },
});
```

**Server semantics.**
- **Monotonic status.** Server rejects backward transitions with `INVALID_STEP_TRANSITION`. Allowed transitions:
  - `pending → running | skipped`
  - `running → awaiting_user | done | failed | skipped`
  - `awaiting_user → running | done | failed | skipped`
  - `{done, failed, skipped} → (terminal)` — no further transitions
- **Entry hook on `running`.** When transitioning to `running` (from `pending` or `awaiting_user`):
  1. Sets `started_at = now` if not already set.
  2. Reads `triggers_decl_json`; INSERTs auto-declared rows into `triggers` with `recipe_step_id` set. Each registration emits a `type='trigger_registered'` event; failures emit `type='trigger_registration_failed'` (the step still enters `running`).
  3. Emits `type='status_changed'` event.
- **Exit hook on terminal.** When transitioning to `done` / `failed` / `skipped`:
  1. Sets `completed_at = now`.
  2. `UPDATE triggers SET enabled=0 WHERE auto_registered_by_step_id = ?`. Each disable emits `type='trigger_unregistered'`.
  3. If all sibling steps are terminal, the recipe-instance terminal cascade marks the parent `recipe_instances` row terminal too (status = worst-of: `failure` if any failed, else `success`).
  4. Emits `type='status_changed'` event.
- **`request_user_input` shortcut.** Atomic with the status update:
  - `status = 'awaiting_user'`, `awaiting_user_message = message`,
  - INSERT one `inbox_items` row with `recipe_step_id`, `recipe_instance_id`, `agent_session_id` set,
  - emit `type='user_input_requested'` event.
- **Attachments.** `attach_artifact_ids` updates each artifact's `recipe_step_id` and `agent_session_id`. `attach_inbox_item_ids` updates each item's `recipe_step_id` and `agent_session_id`. Each attachment emits an event (`artifact_attached` or `inbox_attached`).
- **Resume (Phase 2).** When the user replies on the inbox item, the server transitions the step back to `running` and resumes the prior agent session via the `agent_session_resume` binding (§7.3).

**Errors.** `STEP_NOT_FOUND`, `INVALID_STEP_TRANSITION`, `ARTIFACT_NOT_FOUND`, `INBOX_ITEM_NOT_FOUND`, `RECIPE_INSTANCE_NOT_FOUND`, `MUTUALLY_EXCLUSIVE_STATE_FIELDS`.

### 10.6 `recipe.upsert` format argument

`recipe.upsert` gains an optional `format: 'yaml' | 'json'` argument (default `yaml`). Controls the saved file extension. The validator accepts either format on input (§4.4). If the recipe file already exists in one format and the call specifies the other, the old file is removed in the same transaction as the new one is written (no duplicate-id collisions).

## 11. Adapter Layer for Existing Stores

The existing modules (`triggers-store.ts`, `recipe-instances-store.ts`, `inbox-persistence.ts`) keep their exported function signatures but their bodies are rewritten to use the DB. This minimizes churn across the rest of the codebase. Call sites in `tools/*.ts`, `cli/start.ts`, etc. do not change.

Specifically:
- `readTriggersFile(path)` → `selectAllTriggersForWorkspace(workspaceId)`. The `path` argument is mapped to a workspace_id via a small `path → workspace_id` resolver.
- `writeTriggersFile(path, file)` → DELETE+INSERT or upsert by id within a transaction.
- `readRecipeInstance(workspacePath, id)` → `SELECT * FROM recipe_instances WHERE id=?`. Result is enriched with `steps` from `recipe_steps`.
- `writeRecipeInstance(workspacePath, instance)` → upsert. If `instance.steps` is set, replace `recipe_steps` rows for this instance in the same transaction, preserving runtime state where step ids match (`status`, `message`, `state_json`, `started_at`, `completed_at`, `result`, `error`).
- `loadInboxFromDisk(globalDir)` → `SELECT * FROM inbox_items ORDER BY created_at DESC`.
- `saveInboxToDisk(globalDir, items)` → transactional upsert; current code does full rewrites which we can preserve as `DELETE all + INSERT each` in one transaction.

**New stores (no legacy adapter — fresh code):**
- `mcp-server/src/db/recipe-steps-store.ts`: materialize step rows from a recipe; transition status with monotonic-rule enforcement; bridge to declared triggers / artifacts; append `step_events`.
- `mcp-server/src/db/agent-sessions-store.ts`: open/close session rows; thread them onto recipe steps; expose `findResumeTarget(stepId)` for Phase 2.
- `mcp-server/src/db/artifacts-store.ts`: register artifact metadata; attach to steps/sessions; resolve by `artifact_decl_id`.
- `mcp-server/src/db/step-events-store.ts`: append-only log; query by step or instance for the SPA stepper.

The `emitChange('triggers' | 'recipes' | 'inbox' | 'fires')` calls remain at their existing sites. Two new SSE topics are added: `'sessions'` (when `agent_sessions` changes) and `'artifacts'` (when `artifacts` changes).

## 12. Configuration

Two new config keys (with env-var equivalents) in `config.ts`:

- `cron.maxConcurrent` / `CLAWDEVBOX_CRON_MAX_CONCURRENT` (integer, default 4)
- `cron.dispatcherDrainMs` / `CLAWDEVBOX_CRON_DRAIN_MS` (integer, default 15000)

The DB path is fixed at `<globalDir>/clawdevbox.db`; not configurable in v1.

## 13. Failure Modes & Recovery

| Scenario | Behaviour |
|---|---|
| Service crashes mid-fire | On next boot, the fire row is left in `status='running'` with `started_at` set. The scheduler's safety-net poll detects rows older than 1 hour and resets them to `failed` with `error='service_crash_recovery'`. Retry policy kicks in. |
| Database corruption | `better-sqlite3` reports the error at open; service exits 2 with a structured error. User can delete the DB to start clean (legacy-file warnings re-appear). A `clawdevbox db repair` CLI subcommand is out of scope here. |
| HTTP service stops unexpectedly | MCP bootstrap detects this on next stdio session and respawns. Lost work: any `running` fire is recovered as above on next boot. |
| Two services attempting to start | Second binding fails with EADDRINUSE → probe `/api/cron/status` → confirm clawdevbox → exit 0. No file-lease, no race window. |
| Clock jump forward | Safety-net interval calls `reschedule()` every 60 s; the next wake corrects. May cause a single extra fire if a boundary was crossed in the jump. |
| Clock jump backward | `nextRunAfter` returns a future timestamp; no extra fires. |
| Trigger script never exits | Script binding has a per-script timeout (default 30s, overridable). Dispatcher kills the process and treats as failure → retry. |
| Recipe spawn fails (e.g., agent CLI not installed) | `runRecipe()` throws; dispatcher records `error='recipe_spawn_failed: <message>'` and applies retry policy. |
| Step transition violates monotonic order | `recipe.steps.update_status` returns `INVALID_STEP_TRANSITION`. State unchanged. No partial writes. |
| Declared trigger registration fails on step entry | Step still enters `running`. Each failed registration is logged in `state_json.trigger_registration_errors` and emits a `step_events` row of type `trigger_registration_failed`. The agent can retry via `recipe.update_steps.update_meta`. |
| Agent process crashes mid-step | `agent_sessions.status` left as `running`; safety-net poll resets to `failure` after 1 hour. The step's `status` is not auto-changed — the agent's last `update_status` wins, and the SPA renders a "session unexpectedly ended" warning on the step card. |
| Declared trigger references unknown TYPE | Registration fails fast; emits `trigger_registration_failed`. Other declared triggers for the step still register. |
| Recipe instance has a circular step `depends` graph | Validator rejects at `recipe.run`/`recipe.upsert` time with `CIRCULAR_DEPENDENCY`. Never reaches DB. |

## 14. Testing Strategy

### 14.1 Unit tests

- DB migration runner: idempotent on re-run, applies new migrations in order.
- Scheduler `reschedule()`: empty DB, one trigger, multiple triggers, retrying fire with sooner deadline.
- Scheduler `onWake()`: cron-due enqueue, retry promotion, no-op when nothing due.
- Dispatcher `claimNext()`: queue empty, single queued, overlap-skip, race between two pickups.
- Dispatcher retry: success path, failure-with-retry path, dead path.
- Adapter layer: each rewritten function preserves its prior behaviour (run the existing tests, expect green).
- Step schema validator: accepts integer ids (coerced), string ids; rejects unresolved depends, duplicate ids, circular deps.
- `recipe.update_steps`: add path; remove path (rejected on running step); update_meta with trigger diff; circular-dep guard.
- `recipe.steps.update_status`: monotonic transition (forward allowed, backward rejected); entry hook registers declared triggers; exit hook disables them; `request_user_input` creates inbox item atomically.
- Step events: every status change appends an event; every trigger register/unregister appends an event.

### 14.2 Integration tests

- Boot service → register cron trigger with 1-second cron → wait 3 seconds → assert 2-3 success fires.
- Boot service → `trigger.fire` manually → assert fire row, dispatch, success.
- Failing script → assert retry-with-backoff → dead-letter inbox item appears.
- Service shutdown mid-fire → restart → assert recovery path resets status.
- Two `clawdevbox start` invocations in sequence → second exits cleanly.
- `clawdevbox mcp` with no service running → asserts auto-spawn → asserts `/healthz` becomes responsive.
- Recipe instance with declared step-level triggers → step enters `running` → auto-declared triggers appear in `triggers` table → step transitions to `done` → those triggers are disabled.
- `recipe.steps.update_status({request_user_input})` → inbox item appears with SSE notification → reply transitions step back to `running`.
- Recipe step coercion: load a legacy sample recipe with integer step ids → materialized rows have string `step_id` and matching `depends_json`.

### 14.3 End-to-end live verification

- `trigger.register` with `binds_callback_to_recipe: simple-prompt` → wait for next cron boundary → assert a `recipe_instances` row appears with `trigger_id` + `fire_id` set → assert the agent CLI process started.
- Manual `trigger.fire` → SPA Fires timeline shows it in real time via SSE.

## 15. Phasing (informs the plan, not the design)

The spec describes the full v1 kernel. The implementation plan will phase it:

1. **DB foundation**: add `better-sqlite3`, the `db/` module, schema v1 (all 9 tables: workspaces, triggers, recipe_instances, recipe_steps, agent_sessions, artifacts, inbox_items, fires, step_events + schema_version + kv), migration runner, integration into service boot.
2. **Step schema validator updates**: integer→string id coercion, accept new optional `Step` fields (name, params, triggers, artifacts), JSON parser fallback for recipes.
3. **Adapter layer**: rewrite `triggers-store`, `recipe-instances-store`, `inbox-persistence` to use the DB. Add new stores: `recipe-steps-store`, `agent-sessions-store`, `artifacts-store`, `step-events-store`. Re-run all existing tests, expect green.
4. **Scheduler**: ship with empty dispatcher (logs but doesn't actually run fires). Tests against synthetic trigger rows.
5. **Dispatcher**: implement recipe and script bindings. Per-attempt output dirs. Retry. Dead-letter to inbox. SSE.
6. **MCP tool changes**: real `trigger.fire`, `runRecipe()` extraction with ambient-env injection, `max_attempts`/`backoff_ms` on register/update, new `recipe.update_steps` and `recipe.steps.update_status` tools, `recipe.upsert` format arg.
7. **API endpoints**: `/api/cron/status`, `/api/fires*`, `/callback/<fire_id>`, `/api/cron/diagnose`, plus read-only `/api/sessions*`, `/api/artifacts*`, `/api/steps/:id/events`.
8. **MCP bootstrap**: `ensureHttpServiceRunning` in `cli/mcp.ts`, `listenOrConfirmExisting` in `cli/start.ts`.
9. **SPA**: Fires timeline + recipe stepper view (with declared-trigger and declared-artifact rendering) + agent-session detail + artifact gallery; all SSE-wired.
10. **Docs**: `docs/tools/cron.md`, `docs/tools/recipe-steps.md`, updates to `docs/tools/trigger.md`, `docs/tools/recipe.md`, `docs/MCP-TOOLS-REFERENCE.md`.

## 16. Out of Scope / Future Work

- Webhook source: `POST /hooks/<trigger-id>` → INSERT fire with `source='webhook'`. Trivial once the kernel exists.
- Event-bus source: a `binds_event: 'inbox.added' | ...` field on the TYPE manifest. The dispatcher subscribes; bus events enqueue fires.
- Agent-session-resume runtime: requires designing and building the resume runtime — spawning `--resume <cli_session_id>` with first-message-injection.
- `clawdevbox db repair` / `clawdevbox db vacuum` subcommands.
- Cross-project fan-out: a trigger in project A that fires into project B's workspace. Currently each workspace is isolated.
- Distributed clawdevbox: multiple machines sharing one DB over a network. The current design assumes single-host.
