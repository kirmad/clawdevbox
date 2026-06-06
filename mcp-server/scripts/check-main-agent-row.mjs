import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.homedir(), '.clawdevbox', 'clawdevbox.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== agent_sessions rows for instance_id="main" or recipe_instance_id="main" ===');
const rows = db.prepare(
  "SELECT id, cli_session_id, recipe_instance_id, workspace_id, agent_cli, pid, status, ended_at, status_text, derived_state, derived_state_at FROM agent_sessions WHERE recipe_instance_id = 'main' OR id = 'main' OR cli_session_id = 'main' OR workspace_id = 'project' ORDER BY started_at DESC LIMIT 5"
).all();
for (const r of rows) console.log(JSON.stringify(r));

console.log('=== all live (ended_at IS NULL) rows ===');
const live = db.prepare(
  "SELECT id, cli_session_id, recipe_instance_id, workspace_id, agent_cli, status_text, derived_state FROM agent_sessions WHERE ended_at IS NULL"
).all();
for (const r of live) console.log(JSON.stringify(r));
