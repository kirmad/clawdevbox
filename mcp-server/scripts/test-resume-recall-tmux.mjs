// Minimal proof: resume preserves cli_session_id, copilot recognizes
// the session-state dir, agent recalls prior conversation.
//
// Stages:
//  1. spawn copilot with a marker
//  2. kill
//  3. resume
//  4. send "recall the magic word" via tmux send-keys (most reliable input path)
//  5. capture-pane after a wait, scan for the marker
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const URL = 'http://127.0.0.1:5201/';
const MARKER = 'XYZZY' + Math.random().toString(36).slice(2, 6).toUpperCase();
const TMUX = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'tmux.exe');
const CONF = 'C:\\git\\clawdevbox\\mcp-server\\assets\\cdb.tmux.conf';

function tmux(args) {
  return spawnSync(TMUX, ['-f', CONF, ...args], { encoding: 'utf8', windowsHide: true });
}

async function waitIdle(instanceId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await fetch(`${URL}api/sessions?status=active`).then((x) => x.json());
    const me = s.items.find((x) => x.instance_id === instanceId);
    if (me?.state === 'idle') return me;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

console.log(`marker: ${MARKER}`);

// Stage 1: spawn + plant
let r = await fetch(`${URL}spawn`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt:
      `Remember this magic word: ${MARKER}. Do not echo it now. ` +
      `Just call update_status(task_title="ORIGINAL", session_id=<yours>) then reply: noted.`,
    provider: 'copilot',
  }),
});
let spawned = await r.json();
console.log(`spawned: ${spawned.instance_id}, sid: ${spawned.session_id}`);
const planted = await waitIdle(spawned.instance_id);
if (!planted) { console.log('TIMEOUT planting'); process.exit(1); }
console.log('planted ✓');

// Stage 2: kill
await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, { method: 'DELETE' });
console.log('killed');
await new Promise((r) => setTimeout(r, 3000));

// Stage 3: resume
r = await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}/resume`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
});
const resumed = await r.json();
console.log(`resumed: ${resumed.new_instance_id}, sid match: ${resumed.session_id === spawned.session_id}`);

// Stage 4: wait for the resumed pty to boot + reach idle
await new Promise((r) => setTimeout(r, 35000));
await waitIdle(resumed.new_instance_id, 60_000);
console.log('resumed reached idle');

// Stage 5: send prompt via tmux send-keys (most direct path, no WS races)
const tmuxSession = `cdb_${resumed.new_instance_id}`;
tmux(['send-keys', '-t', tmuxSession, 'What was the magic word I told you to remember? Reply with just the word, nothing else.']);
await new Promise((r) => setTimeout(r, 500));
tmux(['send-keys', '-t', tmuxSession, 'Enter']);
console.log('asked agent to recall');

// Wait for response
await new Promise((r) => setTimeout(r, 45_000));

// Stage 6: capture-pane (last 200 lines) and scan
const cap = tmux(['capture-pane', '-t', tmuxSession, '-p', '-S', '-200']);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]|[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
const text = stripAnsi(cap.stdout || '');
const found = text.includes(MARKER);

console.log('\n--- capture-pane tail ---');
console.log(text.slice(-1500));
console.log(`\n--- Verdict ---`);
console.log(`marker "${MARKER}" found in resumed terminal: ${found}`);

// Cleanup
await fetch(`${URL}api/sessions/${encodeURIComponent(resumed.new_instance_id)}`, { method: 'DELETE' });

process.exit(found ? 0 : 1);
