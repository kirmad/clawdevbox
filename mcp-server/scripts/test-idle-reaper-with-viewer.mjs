// Two-stage negative+positive test:
//   1. With a viewer WS attached, reaper should NOT reap (even though idle+old).
//   2. After WS closes, the next tick should reap.
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const URL = 'http://127.0.0.1:5201/';
const dbPath = path.join(os.homedir(), '.clawdevbox', 'clawdevbox.db');

const resp = await fetch(`${URL}spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'reply: viewer-attached-test', provider: 'copilot' }),
});
const spawned = await resp.json();
console.log(`spawned: ${spawned.instance_id}`);

async function waitForIdle(instanceId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${URL}api/sessions?status=active`);
    const j = await r.json();
    const item = j.items.find((x) => x.instance_id === instanceId);
    if (item?.state === 'idle') return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
console.log('waiting for idle...');
if (!(await waitForIdle(spawned.instance_id))) { console.log('TIMEOUT'); process.exit(1); }
console.log('idle reached');

const wsUrl = `ws://127.0.0.1:5201/terminal/${encodeURIComponent(spawned.instance_id)}/ws`;
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
console.log('viewer WS attached');

const db = new Database(dbPath);
const ago = Date.now() - (20 * 60 * 1000);
db.prepare(`UPDATE agent_sessions SET derived_state_at = ? WHERE recipe_instance_id = ? AND ended_at IS NULL`)
  .run(ago, spawned.instance_id);
db.close();
console.log('backdated by 20min');

console.log('waiting 70s for reaper tick (WS still open) ...');
await new Promise((r) => setTimeout(r, 70_000));

const db2 = new Database(dbPath, { readonly: true });
const row = db2.prepare(`SELECT ended_at, end_reason FROM agent_sessions WHERE recipe_instance_id = ?`).get(spawned.instance_id);
db2.close();
console.log('AFTER (with viewer):', JSON.stringify(row));

ws.close();
await new Promise((r) => setTimeout(r, 1500));

const stillAlive = row.ended_at === null && row.end_reason === null;
console.log(`\n[1/2] viewer-attached test: ${stillAlive ? 'PASS - not reaped' : 'FAIL - reaped despite viewer'}`);
if (!stillAlive) process.exit(1);

console.log('\n[2/2] WS closed. Waiting another 70s - reaper should reap now ...');
await new Promise((r) => setTimeout(r, 70_000));

const db3 = new Database(dbPath, { readonly: true });
const row2 = db3.prepare(`SELECT ended_at, end_reason FROM agent_sessions WHERE recipe_instance_id = ?`).get(spawned.instance_id);
db3.close();
console.log('AFTER (post-close):', JSON.stringify(row2));

const reaped = row2.end_reason === 'idle_reaped' && row2.ended_at !== null;
console.log(`\n[2/2] post-detach reap: ${reaped ? 'PASS - reaped after viewer left' : 'FAIL - still alive after viewer left'}`);

if (!reaped) {
  await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, { method: 'DELETE' });
}
process.exit(reaped ? 0 : 1);
