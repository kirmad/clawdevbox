/**
 * Schema migrations for the clawdevbox kernel DB.
 *
 * Each migration has a monotonically increasing `version` and an `up` that
 * mutates the DB. The runner (`./index.ts`) applies any migration whose
 * `version > MAX(schema_version.version)`, each inside its own transaction.
 *
 * SQLite permits forward references in FOREIGN KEY clauses, so table creation
 * order follows spec §4.2 for readability rather than dependency order.
 */

import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  up: (db: Database) => void;
}

const V1_SCHEMA = `
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT,
  parent_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_workspaces_parent ON workspaces(parent_workspace_id);

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
  binds_callback_to TEXT,
  binds_callback_to_recipe TEXT,
  auto_declared INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE recipe_instances (
  id TEXT PRIMARY KEY,
  recipe_id TEXT,
  recipe_snapshot_path TEXT,
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

CREATE TABLE recipe_steps (
  id TEXT PRIMARY KEY,
  recipe_instance_id TEXT NOT NULL REFERENCES recipe_instances(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  name TEXT,
  goal TEXT NOT NULL,
  depends_json TEXT NOT NULL DEFAULT '[]',
  params_schema_json TEXT NOT NULL DEFAULT '[]',
  triggers_decl_json TEXT NOT NULL DEFAULT '[]',
  artifacts_decl_json TEXT NOT NULL DEFAULT '[]',
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

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  cli_session_id TEXT,
  recipe_instance_id TEXT REFERENCES recipe_instances(id) ON DELETE CASCADE,
  recipe_step_id TEXT REFERENCES recipe_steps(id) ON DELETE SET NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_cli TEXT NOT NULL,
  pid INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','success','failure','cancelled','suspended')),
  result TEXT,
  error TEXT,
  resume_of_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  interactive INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_instance ON agent_sessions(recipe_instance_id, started_at DESC);
CREATE INDEX idx_sessions_step     ON agent_sessions(recipe_step_id);
CREATE INDEX idx_sessions_resume   ON agent_sessions(resume_of_agent_session_id);
CREATE INDEX idx_sessions_active   ON agent_sessions(status) WHERE status IN ('running','suspended');

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipe_instance_id TEXT REFERENCES recipe_instances(id) ON DELETE CASCADE,
  recipe_step_id TEXT REFERENCES recipe_steps(id) ON DELETE SET NULL,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  artifact_decl_id TEXT,
  type TEXT NOT NULL,
  title TEXT,
  dir_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_ws       ON artifacts(workspace_id, created_at DESC);
CREATE INDEX idx_artifacts_instance ON artifacts(recipe_instance_id);
CREATE INDEX idx_artifacts_step     ON artifacts(recipe_step_id);
CREATE INDEX idx_artifacts_session  ON artifacts(agent_session_id);

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

CREATE TABLE step_events (
  id TEXT PRIMARY KEY,
  recipe_step_id TEXT NOT NULL REFERENCES recipe_steps(id) ON DELETE CASCADE,
  recipe_instance_id TEXT NOT NULL REFERENCES recipe_instances(id) ON DELETE CASCADE,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  message TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_step_events_step     ON step_events(recipe_step_id, created_at DESC);
CREATE INDEX idx_step_events_instance ON step_events(recipe_instance_id, created_at DESC);
`;

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
  {
    version: 3,
    up: (db) => {
      // PR #terminals-panel: track which spawn resumed an archived session
      // so the UI can render "Resumed as <new-id>" badges on the original row.
      // Spec: docs/superpowers/specs/2026-05-30-terminals-panel-design.md
      db.exec(`
        ALTER TABLE agent_sessions ADD COLUMN resumed_into_instance_id TEXT;
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      // Trigger API smart routing: lets callers use friendly session aliases
      // (e.g. "my-feature", "pr-review-4547615") instead of having to mint
      // and remember UUIDs. The alias maps to a stable GUID that's used as
      // the underlying cli_session_id (which copilot --session-id requires
      // to be a UUID).
      db.exec(`
        CREATE TABLE session_aliases (
          alias TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_session_aliases_session ON session_aliases(session_id);
      `);
    },
  },
  {
    version: 5,
    up: (db) => {
      // Tmux-migration: agents now report status via the update_status MCP
      // tool instead of sentinel markers in stdout. These columns persist
      // the latest report so the UI can render status badges + "needs you"
      // banners without re-querying the agent.
      db.exec(`
        ALTER TABLE agent_sessions ADD COLUMN status_text TEXT;
        ALTER TABLE agent_sessions ADD COLUMN needs_user_input INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE agent_sessions ADD COLUMN last_status_at INTEGER;
      `);
    },
  },
  {
    version: 6,
    up: (db) => {
      // Inbox-DB-first: previously inbox.json on disk was the source of truth
      // and inbox_items was a partial mirror that lost `kind`, `state`,
      // `description_format`, `description_size`. Now the DB is authoritative
      // and the JSON file is a legacy mirror only. Add the missing columns +
      // a `raw_json` blob for forward-compatibility (any new InboxItem field
      // survives without a schema migration).
      db.exec(`
        ALTER TABLE inbox_items ADD COLUMN kind TEXT;
        ALTER TABLE inbox_items ADD COLUMN state TEXT;
        ALTER TABLE inbox_items ADD COLUMN description_format TEXT;
        ALTER TABLE inbox_items ADD COLUMN description_size INTEGER;
        ALTER TABLE inbox_items ADD COLUMN raw_json TEXT;
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      // Daemon supervisor — desired-state "always running" supervision for
      // long-lived scripts (e.g. the Teams trouter listener).
      //
      // Two tables: `daemons` is the desired-state spec; `daemon_runs` is
      // the audit log of every spawn attempt. Partial unique index on
      // daemon_runs(daemon_id) WHERE status IN ('starting','running')
      // enforces at-most-one-live-run-per-daemon at the DB level — the
      // supervisor races claim a starting row inside a transaction, and
      // the loser observes a UNIQUE-constraint failure and backs off.
      //
      // `generation` on the daemon row + on each run guards against the
      // "stale exit handler restarts after disable" race: when the user
      // disables or reconfigures, the daemon's generation bumps, and any
      // in-flight runner's exit handler skips restart if its generation
      // no longer matches.
      db.exec(`
        CREATE TABLE daemons (
          id                  TEXT PRIMARY KEY,
          name                TEXT NOT NULL,
          workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          kind                TEXT NOT NULL CHECK(kind IN ('script')),
          runtime             TEXT NOT NULL CHECK(runtime IN ('node','tsx','python','bash','pwsh','direct')),
          command_json        TEXT NOT NULL,
          cwd                 TEXT,
          env_json            TEXT NOT NULL DEFAULT '{}',
          enabled             INTEGER NOT NULL DEFAULT 1,
          generation          INTEGER NOT NULL DEFAULT 1,
          restart_policy_json TEXT NOT NULL DEFAULT '{}',
          backoff_ms          INTEGER NOT NULL DEFAULT 0,
          restart_count       INTEGER NOT NULL DEFAULT 0,
          last_exit_at        INTEGER,
          last_error          TEXT,
          next_restart_at     INTEGER,
          stable_since        INTEGER,
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL
        );
        CREATE INDEX idx_daemons_enabled ON daemons(enabled, next_restart_at) WHERE enabled=1;
        CREATE INDEX idx_daemons_workspace ON daemons(workspace_id);

        CREATE TABLE daemon_runs (
          id           TEXT PRIMARY KEY,
          daemon_id    TEXT NOT NULL REFERENCES daemons(id) ON DELETE CASCADE,
          generation   INTEGER NOT NULL,
          status       TEXT NOT NULL CHECK(status IN ('starting','running','exited','failed','stopped')),
          pid          INTEGER,
          started_at   INTEGER NOT NULL,
          exited_at    INTEGER,
          exit_code    INTEGER,
          signal       TEXT,
          error        TEXT,
          log_path     TEXT
        );
        CREATE INDEX idx_daemon_runs_daemon ON daemon_runs(daemon_id, started_at DESC);
        CREATE INDEX idx_daemon_runs_status ON daemon_runs(status);
        CREATE UNIQUE INDEX idx_daemon_runs_live ON daemon_runs(daemon_id)
          WHERE status IN ('starting','running');
      `);
    },
  },
  {
    version: 8,
    up: (db) => {
      // Events-driven status indicators. The events.jsonl watcher
      // (copilot-events.ts) writes the agent's derived live state here.
      // Kept separate from status_text (which is agent-supplied free text
      // via the update_status MCP tool) so the two channels don't fight.
      //
      // Values: 'idle' | 'thinking' | 'tool_use' | 'waiting' | 'error'.
      // NULL means the watcher has not yet observed any classifiable event
      // (e.g. session just spawned, events.jsonl not yet flushed).
      db.exec(`
        ALTER TABLE agent_sessions ADD COLUMN derived_state TEXT;
        ALTER TABLE agent_sessions ADD COLUMN derived_state_at INTEGER;
      `);
    },
  },
  {
    version: 9,
    up: (db) => {
      // Audit how a session ended. NULL while running. Filled in by
      // closeSession() callers and the idle-reaper.
      // Values: 'user_killed' | 'agent_exited' | 'idle_reaped' | 'shutdown' | NULL.
      db.exec(`
        ALTER TABLE agent_sessions ADD COLUMN end_reason TEXT;
      `);
    },
  },
  {
    version: 10,
    up: (db) => {
      // Split agent-self-reported tab text into three fields. status_text
      // (added in v5) becomes the "status" line; the new columns hold the
      // sticky goal (task_title) and the current sub-goal (subtask_title).
      // UI renders them as three lines with different font weights so the
      // user can at a glance see WHAT the terminal is doing.
      //
      // All three are nullable. The MCP tool's update semantics:
      //   - undefined  → leave column unchanged (sticky)
      //   - ""         → CLEAR (e.g. when subtask finishes)
      //   - non-empty  → SET
      db.exec(`
        ALTER TABLE agent_sessions ADD COLUMN task_title TEXT;
        ALTER TABLE agent_sessions ADD COLUMN subtask_title TEXT;
      `);
    },
  },
  {
    version: 11,
    up: (db) => {
      // Human-readable labels for recipe instances and registered
      // triggers, so the SPA's master-detail rails don't have to fall
      // back to opaque ids like `__adhoc_ri_mq8kwr2q_0331` or
      // `local.oneoff.tpl_xxx#hash`. For recipes, this is the `name`
      // field already required by the recipe YAML schema. For
      // triggers, this is a new optional `name` arg on
      // `trigger.instance.register` (the recipe-author / daemon can
      // pass whatever short label is meaningful — e.g. "Teams chat
      // listener" or "Hourly QoE sanity-check").
      //
      // Both columns are nullable; readers fall back to id when null.
      db.exec(`
        ALTER TABLE recipe_instances ADD COLUMN recipe_name TEXT;
        ALTER TABLE triggers ADD COLUMN name TEXT;
      `);
    },
  },
  {
    version: 12,
    up: (db) => {
      // Durable artifact outbox — messages a viewer sends from an artifact
      // (PR-walkthrough Q&A questions, inline review comments) are queued
      // here BEFORE they reach the agent, then delivered asynchronously by
      // `artifact-outbox-worker.ts`. This decouples the browser POST (which
      // must return instantly so the UI never blocks) from the slow, failure-
      // prone dispatch (which may need to WAKE a closed session: resume/spawn,
      // then wait for the agent to be idle before injecting the prompt).
      //
      // Robustness the queue buys us:
      //   - The POST returns 202 immediately — the user is never blocked on a
      //     10-20s dispatch or a session cold-start.
      //   - If the terminal/session is closed, the worker resumes/spawns it
      //     and delivers the message when it's ready — no message lost.
      //   - Transient failures retry with exponential backoff up to
      //     `max_attempts`; a server crash mid-send is recovered on the next
      //     boot (stuck 'sending' rows are reset to 'pending').
      //
      // status:  pending → sending → sent | failed
      // next_attempt_at is epoch-ms; the worker only claims pending rows whose
      // next_attempt_at <= now, so backoff is just a future timestamp.
      db.exec(`
        CREATE TABLE artifact_outbox (
          id              TEXT PRIMARY KEY,
          artifact_id     TEXT NOT NULL,
          session_id      TEXT,
          workspace_id    TEXT,
          workspace_path  TEXT,
          kind            TEXT NOT NULL DEFAULT 'ask',
          prompt          TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','sending','sent','failed')),
          attempts        INTEGER NOT NULL DEFAULT 0,
          max_attempts    INTEGER NOT NULL DEFAULT 10,
          last_error      TEXT,
          delivered_instance_id TEXT,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          sent_at         INTEGER
        );
        CREATE INDEX idx_artifact_outbox_claim
          ON artifact_outbox(status, next_attempt_at, created_at)
          WHERE status IN ('pending','sending');
        CREATE INDEX idx_artifact_outbox_artifact
          ON artifact_outbox(artifact_id, created_at);
      `);
    },
  },
  {
    version: 13,
    up: (db) => {
      // Recipe step `required` flag: a step declared `required: true` in the
      // recipe YAML cannot be transitioned into `skipped`. Enforced at
      // runtime in recipe-steps-store.transitionStatus (throws
      // StepRequiredError → tool surfaces code STEP_REQUIRED). Non-required
      // steps (the default, 0) keep the existing skippable behavior.
      db.exec(`
        ALTER TABLE recipe_steps ADD COLUMN required INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 14,
    up: (db) => {
      // Validation gate + isolated execution (spec 2026-07-14). Opt-in per step:
      // a `validation` block routes completion through a `validating` state whose
      // ONLY path to `done` is the server worker-loop applying a verifier verdict.
      // `execution` selects fresh-session vs inline run. All nullable / defaulted,
      // so steps that opt into nothing behave exactly as before.
      db.exec(`
        ALTER TABLE recipe_steps ADD COLUMN validation_json TEXT;
        ALTER TABLE recipe_steps ADD COLUMN execution_json TEXT;
        ALTER TABLE recipe_steps ADD COLUMN verifier_session_id TEXT;
        ALTER TABLE recipe_steps ADD COLUMN verdict_json TEXT;
        ALTER TABLE recipe_steps ADD COLUMN rework_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recipe_steps ADD COLUMN validation_attempt INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 15,
    up: (db) => {
      // Allow the new 'validating' status in the recipe_steps CHECK constraint.
      // The status list is baked into the v1 CREATE TABLE and SQLite cannot
      // ALTER a CHECK. A full table rebuild is unsafe here: migrations run
      // inside a transaction with foreign_keys=ON (see db/index.ts), so we can
      // neither disable FKs nor DROP the FK-referenced recipe_steps table
      // without cascade-deleting child rows. Instead, surgically patch the
      // stored DDL via writable_schema. REPLACE preserves the columns v14
      // appended to the DDL, and is a no-op if already applied (idempotent).
      db.unsafeMode(true);
      try {
        db.pragma('writable_schema = ON');
        db.prepare(
          `UPDATE sqlite_master SET sql = REPLACE(sql, ?, ?)
             WHERE type = 'table' AND name = 'recipe_steps'`,
        ).run(
          "status IN ('pending','running','done'",
          "status IN ('pending','running','validating','done'",
        );
        db.pragma('writable_schema = RESET');
        // Fail loud if the DDL patch did not apply (e.g. schema-text drift):
        // a silent no-op would leave `validating` rejected by the CHECK and
        // break the gate at runtime. This must never pass silently.
        const row = db
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recipe_steps'`)
          .get() as { sql?: string } | undefined;
        if (!row || typeof row.sql !== 'string' || !row.sql.includes("'validating'")) {
          throw new Error(
            "migration v15: failed to add 'validating' to recipe_steps.status CHECK — " +
              "DDL text did not match the expected pattern. Aborting to avoid a silent no-op.",
          );
        }
      } finally {
        db.unsafeMode(false);
      }
    },
  },
  {
    version: 16,
    up: (db) => {
      // Additive nullable column — no CHECK/table rebuild needed (unlike v15).
      // Holds the validation worker's per-attempt, per-gate runtime state for
      // multi-gate steps: { attempt, gates: { <name>: { verifier_session_id,
      // started_at } } }. Steps with 0 or 1 gate never populate it.
      db.exec(`ALTER TABLE recipe_steps ADD COLUMN validation_runs_json TEXT;`);
    },
  },
  {
    version: 17,
    up: (db) => {
      // Session lanes: N interactive sessions per recipe instance (design
      // 2026-07-15). Maps (instance, lane) -> the live cli_session_id driving it.
      db.exec(`
        CREATE TABLE recipe_lane_sessions (
          recipe_instance_id TEXT NOT NULL REFERENCES recipe_instances(id) ON DELETE CASCADE,
          lane               TEXT NOT NULL,
          cli_session_id     TEXT,
          status             TEXT NOT NULL DEFAULT 'live',
          spawned_at         INTEGER NOT NULL,
          PRIMARY KEY (recipe_instance_id, lane)
        );
        CREATE INDEX idx_lane_sessions_cli ON recipe_lane_sessions(cli_session_id);
      `);
    },
  },
];
