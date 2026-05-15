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
];
