// End-to-end validation of the idle-reaper against the LIVE clawdevbox.
//
// 1. /spawn a real copilot session (tmux-backed)
// 2. Wait for it to enter a known state
// 3. Force its derived_state_at to ~20 minutes ago in the DB
// 4. Trigger a reaper tick (we'll patch via direct module load — see note)
// 5. Verify the tmux session was killed AND end_reason='idle_reaped'
//
// Since the reaper poll is 60s, we directly force the timestamp + wait
// a poll cycle. Faster than mocking infra.
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const URL = 'http://127.0.0.1:5201/';
const dbPath = path.join(os.homedir(), '.clawdevbox', 'clawdevbox.db');

// Spawn a fresh copilot.
const resp = await fetch(`${URL}spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: 'reply: idle-test-ack',
    provider: 'copilot',
  }),
});
const spawned = await resp.json();
console.log(`spawned: ${spawned.instance_id}`);

// Wait for it to reach 'idle' state (post-reply).
async function waitForIdle(instanceId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${URL}api/sessions?status=active`);
    const j = await r.json();
    const item = j.items.find((x) => x.instance_id === instanceId);
    if (item?.state === 'idle') return true;
    if (item?.state === 'error' || item?.state === 'exited') return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

console.log('waiting for spawn to reach idle…');
const becameIdle = await waitForIdle(spawned.instance_id);
console.log(`reached idle: ${becameIdle}`);
if (!becameIdle) { console.log('TIMEOUT'); process.exit(1); }

// Force derived_state_at back 20 minutes so the reaper considers it overdue.
const db = new Database(dbPath);
const ago = Date.now() - (20 * 60 * 1000);
const updated = db.prepare(
  `UPDATE agent_sessions
     SET derived_state_at = ?
   WHERE recipe_instance_id = ? AND ended_at IS NULL`,
).run(ago, spawned.instance_id);
console.log(`backdated derived_state_at by 20min, rows updated: ${updated.changes}`);

const before = db.prepare(
  `SELECT derived_state, derived_state_at, ended_at, end_reason
   FROM agent_sessions WHERE recipe_instance_id = ?`,
).get(spawned.instance_id);
console.log('BEFORE:', JSON.stringify(before));
db.close();

// Wait ~70 s for the reaper's 60s tick to fire.
console.log('waiting 70s for reaper tick…');
await new Promise((r) => setTimeout(r, 70_000));

// Verify.
const db2 = new Database(dbPath, { readonly: true });
const after = db2.prepare(
  `SELECT derived_state, derived_state_at, ended_at, end_reason
   FROM agent_sessions WHERE recipe_instance_id = ?`,
).get(spawned.instance_id);
console.log('AFTER:', JSON.stringify(after));
db2.close();

const reaped = after.end_reason === 'idle_reaped' && after.ended_at !== null;
console.log(`\nverdict: ${reaped ? 'PASS — reaper killed session, end_reason=idle_reaped' : 'FAIL — session not reaped'}`);
process.exit(reaped ? 0 : 1);
