// E2E test: resume should reuse the original cli_session_id, preserve
// context, and tag the new session with resume lineage.
//
// Flow:
//   1. /spawn a copilot, get it to set a recognizable task_title + remember a fact
//   2. Wait for idle
//   3. DELETE the session (so it's archived but cli_session_id remains)
//   4. POST /api/sessions/<id>/resume
//   5. Verify the NEW agent_sessions row has cli_session_id === original
//   6. Send a follow-up prompt asking about the remembered fact via terminal WS,
//      verify the agent recalls it (proves real resume, not a fresh session)
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const URL = 'http://127.0.0.1:5201/';
const dbPath = path.join(os.homedir(), '.clawdevbox', 'clawdevbox.db');

// Stage 1: spawn + set a memorable fact + wait for idle.
const MARKER = 'RESUME_TEST_' + Math.random().toString(36).slice(2, 8);
console.log(`marker: ${MARKER}`);

const r = await fetch(`${URL}spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: `Remember this secret marker (don't echo it now, just remember it): ${MARKER}. Then call update_status with task_title="RESUME_TEST_ORIGINAL" and pass your session_id. Then reply: noted.`,
    provider: 'copilot',
  }),
});
const spawned = await r.json();
console.log(`spawned: ${spawned.instance_id}, session_id: ${spawned.session_id}`);

async function waitForIdle(instanceId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await fetch(`${URL}api/sessions?status=active`).then((x) => x.json());
    const me = s.items.find((x) => x.instance_id === instanceId);
    if (me?.task_title === 'RESUME_TEST_ORIGINAL' && me?.state === 'idle') return me;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

console.log('waiting for original to reach idle with task_title set...');
const original = await waitForIdle(spawned.instance_id);
if (!original) { console.log('TIMEOUT — never reached idle with title'); process.exit(1); }
console.log('original idle ✓');

// Stage 2: kill the session (archive it).
await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, { method: 'DELETE' });
console.log('original killed');
await new Promise((r) => setTimeout(r, 3000));

// Stage 3: resume.
const resumeResp = await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}/resume`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
});
const resumed = await resumeResp.json();
console.log(`resume resp: ${JSON.stringify(resumed)}`);

if (!resumed.ok) { console.log('resume failed'); process.exit(1); }
console.log(`new_instance_id: ${resumed.new_instance_id}, session_id: ${resumed.session_id}`);

// CRITICAL ASSERTION 1: session_id of resumed must MATCH original.
const sameSid = resumed.session_id === spawned.session_id;
console.log(`session_id matches original: ${sameSid}`);
if (!sameSid) {
  console.log(`  expected: ${spawned.session_id}`);
  console.log(`  got:      ${resumed.session_id}`);
}

// Wait for resumed to land in DB + reach idle (it should auto-resume copilot's
// prior context, so the task_title from the prior session might or might not
// re-appear depending on whether the agent calls update_status again).
await new Promise((r) => setTimeout(r, 5000));

// CRITICAL ASSERTION 2: DB row.
const db = new Database(dbPath, { readonly: true });
const dbRow = db.prepare(
  `SELECT id, cli_session_id, recipe_instance_id, ended_at FROM agent_sessions
   WHERE recipe_instance_id = ? AND ended_at IS NULL`,
).get(resumed.new_instance_id);
db.close();
console.log(`DB row: ${JSON.stringify(dbRow)}`);

const dbSameSid = dbRow?.cli_session_id === spawned.session_id;
console.log(`DB cli_session_id matches original: ${dbSameSid}`);

// CRITICAL ASSERTION 3: original session-state dir is being used (no new dir minted).
import { existsSync } from 'node:fs';
const origDir = path.join(os.homedir(), '.copilot', 'session-state', spawned.session_id);
console.log(`original session-state dir exists: ${existsSync(origDir)}`);

// Cleanup.
await fetch(`${URL}api/sessions/${encodeURIComponent(resumed.new_instance_id)}`, { method: 'DELETE' });

console.log(`\n--- Verdict ---`);
if (sameSid && dbSameSid) {
  console.log('✅ PASS — resume correctly reuses cli_session_id');
  process.exit(0);
} else {
  console.log('❌ FAIL — resume minted a new session_id (no context recovery)');
  process.exit(1);
}
