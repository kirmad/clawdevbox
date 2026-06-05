/**
 * Register the teams-listener daemon directly via the DB.
 * The running clawdevbox supervisor's 30s safety tick will then spawn it.
 */
import BetterSqlite3 from 'better-sqlite3';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

import { upsertDaemon, getDaemon, listDaemons } from '../src/db/daemons-store.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';

const dbPath = join(homedir(), '.clawdevbox', 'clawdevbox.db');
const projectDir = resolve('C:/git/clawdevbox');
const scriptPath = resolve('C:/git/clawdevbox/samples/triggers/teams-listener.mjs');

const db = new BetterSqlite3(dbPath);
db.pragma('foreign_keys = ON');

// Ensure the workspace exists (DB row + on-disk scaffolding).
const ws = ensureWorkspace(db, { path: projectDir, name: 'clawdevbox-main' });
console.log('workspace:', ws.id, '->', ws.path);

// Idempotent upsert with a stable id so repeated invocations update in place.
const id = 'dmn-teams-listener';
const d = upsertDaemon(db, {
  id,
  name: 'teams-listener',
  workspace_id: ws.id,
  runtime: 'direct',
  command: [process.execPath, scriptPath],
  cwd: projectDir,
  env: {
    CLAWDEVBOX_URL: 'http://127.0.0.1:5201',
    CLAWDEVBOX_WORKSPACE_PATH: projectDir,
    CLAWDEVBOX_PROVIDER: 'copilot',
    TEAMS_AGENT_KEYWORD: '@agent,@copilot,@buddy',
    TEAMS_HISTORY_COUNT: '10',
    // Stable Trouter registrationId so the daemon survives restarts cleanly.
    TEAMS_REGISTRATION_ID: 'clawdevbox-dmn-teams-listener',
  },
  enabled: true,
  restart_policy: {
    // First retry quick (5s), then back off. Stable-after = 2 min so a
    // listener that survives the initial Trouter handshake is considered healthy.
    backoff_ms: [5_000, 15_000, 60_000, 300_000, 900_000],
    stable_after_ms: 2 * 60_000,
    max_restarts: 0,
  },
});

console.log('daemon upserted:', d.id, d.name, 'enabled=' + d.enabled);
console.log('all daemons:', listDaemons(db).map((x) => x.id));

db.close();
console.log('done — supervisor will spawn it on the next tick (≤30s).');
