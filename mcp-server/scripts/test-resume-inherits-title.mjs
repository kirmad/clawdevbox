// E2E test for the resume-UX fix:
//   1. Old archived row is hidden after resume (no duplicate display)
//   2. New live row inherits task_title from the old row
//
// Stages:
//   A. Spawn copilot, set a distinctive task_title via update_status, wait for idle
//   B. Kill → assert old row is in archived list
//   C. Resume
//   D. Verify NEW live row has the inherited task_title
//   E. Verify OLD archived row is HIDDEN (not in /api/sessions listing)
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const URL = 'http://127.0.0.1:5201/';
const dbPath = path.join(os.homedir(), '.clawdevbox', 'clawdevbox.db');
const TASK = 'RESUME_INHERIT_' + Math.random().toString(36).slice(2, 8);
const SUB = 'subgoal-' + Math.random().toString(36).slice(2, 6);

console.log(`task: ${TASK}, sub: ${SUB}`);

// Stage A: spawn + set titles + wait for idle
const r = await fetch(`${URL}spawn`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt:
      `Call update_status(task_title="${TASK}", subtask_title="${SUB}", session_id=<yours>) ` +
      `and then reply: ok.`,
    provider: 'copilot',
  }),
});
const spawned = await r.json();
console.log(`spawned: ${spawned.instance_id}, sid: ${spawned.session_id}`);

async function waitForTitleAndIdle(instanceId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await fetch(`${URL}api/sessions?status=active`).then((x) => x.json());
    const me = s.items.find((x) => x.instance_id === instanceId);
    if (me?.task_title === TASK && me?.state === 'idle') return me;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}
const planted = await waitForTitleAndIdle(spawned.instance_id);
if (!planted) { console.log('TIMEOUT planting'); process.exit(1); }
console.log(`planted: task_title="${planted.task_title}", subtask_title="${planted.subtask_title}"`);

// Stage B: kill
await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, { method: 'DELETE' });
console.log('killed');
await new Promise((r) => setTimeout(r, 3000));

// Confirm it's in archived BEFORE resume
const beforeAll = await fetch(`${URL}api/sessions?status=all`).then((x) => x.json());
const beforeRows = beforeAll.items.filter((x) => x.instance_id === spawned.instance_id);
console.log(`before resume: row present = ${beforeRows.length === 1 ? 'YES (archived)' : 'NO'}`);

// Stage C: resume
const resumeResp = await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}/resume`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
});
const resumed = await resumeResp.json();
console.log(`resumed: ${resumed.new_instance_id}, sid: ${resumed.session_id}`);

// Stage D: wait for new row to appear + check inherited titles
await new Promise((r) => setTimeout(r, 3000));
const afterAll = await fetch(`${URL}api/sessions?status=all`).then((x) => x.json());
const newLive = afterAll.items.find((x) => x.instance_id === resumed.new_instance_id);
console.log(`new row task_title:    ${JSON.stringify(newLive?.task_title)}`);
console.log(`new row subtask_title: ${JSON.stringify(newLive?.subtask_title)}`);

// Stage E: verify OLD archived row is HIDDEN from listing
const oldStillShown = afterAll.items.find((x) => x.instance_id === spawned.instance_id);
console.log(`old archived row visible in /api/sessions: ${!!oldStillShown}`);

// DB-level verification
const db = new Database(dbPath, { readonly: true });
const oldRow = db.prepare(
  `SELECT recipe_instance_id, task_title, resumed_into_instance_id FROM agent_sessions WHERE recipe_instance_id = ?`,
).get(spawned.instance_id);
const newRow = db.prepare(
  `SELECT recipe_instance_id, task_title, subtask_title FROM agent_sessions WHERE recipe_instance_id = ?`,
).get(resumed.new_instance_id);
db.close();
console.log(`\nDB old: ${JSON.stringify(oldRow)}`);
console.log(`DB new: ${JSON.stringify(newRow)}`);

// Cleanup
await fetch(`${URL}api/sessions/${encodeURIComponent(resumed.new_instance_id)}`, { method: 'DELETE' });

const titleInherited = newLive?.task_title === TASK && newLive?.subtask_title === SUB;
const oldHidden = !oldStillShown;
const dbCorrect = oldRow?.resumed_into_instance_id === resumed.new_instance_id;

console.log(`\n--- Verdict ---`);
console.log(`✓ New row inherits task+subtask: ${titleInherited}`);
console.log(`✓ Old archived row hidden:      ${oldHidden}`);
console.log(`✓ DB lineage chain correct:     ${dbCorrect}`);

process.exit((titleInherited && oldHidden && dbCorrect) ? 0 : 1);
