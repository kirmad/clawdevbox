import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const db = new Database(path.join(os.homedir(), '.clawdevbox', 'clawdevbox.db'), { readonly: true });
const instanceId = process.argv[2] ?? 'ri_mq1pqmjh_b053';
console.log(`=== agent_sessions for recipe_instance_id='${instanceId}' ===`);
const rows = db.prepare(
  `SELECT id, cli_session_id, recipe_instance_id, workspace_id, agent_cli, status,
          ended_at, status_text, derived_state, derived_state_at
   FROM agent_sessions WHERE recipe_instance_id = ?`
).all(instanceId);
console.log('row count:', rows.length);
for (const r of rows) console.log(JSON.stringify(r));

console.log(`\n=== all live (ended_at IS NULL) ===`);
const live = db.prepare(
  `SELECT id, cli_session_id, recipe_instance_id, agent_cli, derived_state, derived_state_at
   FROM agent_sessions WHERE ended_at IS NULL`
).all();
for (const r of live) console.log(JSON.stringify(r));
