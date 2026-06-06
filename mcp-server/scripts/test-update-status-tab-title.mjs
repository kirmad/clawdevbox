/**
 * End-to-end test for the update_status tab-title feature.
 *
 * Flow:
 *   1. /spawn a real copilot session
 *   2. Wait for it to reach idle (post-initial-prompt-reply)
 *   3. Dispatch a follow-up prompt asking the agent to call update_status
 *      with a known string AND its session_id (read from prefix)
 *   4. Verify /api/sessions returns that status_text on the matching row
 *   5. Verify the per-session .mcp.json file exists (no overwrite race)
 */
import path from 'node:path';
import { existsSync } from 'node:fs';

const URL = 'http://127.0.0.1:5201/';
const KNOWN = 'TAB_TITLE_TEST_' + Math.random().toString(36).slice(2, 8);

console.log(`Test marker: ${KNOWN}`);

const r = await fetch(`${URL}spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: `Call the update_status tool with status_text="${KNOWN}" and pass your session_id (the one in the [clawdevbox] prefix above this prompt). Then reply: done.`,
    provider: 'copilot',
  }),
});
const spawned = await r.json();
console.log(`spawned: ${spawned.instance_id}, session_id: ${spawned.session_id}`);

// Find the workspace path so we can check .clawdevbox/sessions/<sid>.mcp.json
const s0 = await fetch(`${URL}api/sessions?status=active`).then((x) => x.json());
const wsId = s0.items.find((x) => x.instance_id === spawned.instance_id)?.workspace_id;
console.log(`workspace_id: ${wsId}`);

// Poll for status_text to appear
let observed = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const s = await fetch(`${URL}api/sessions?status=active`).then((x) => x.json());
  const me = s.items.find((x) => x.instance_id === spawned.instance_id);
  if (me?.status_text === KNOWN) {
    observed = me;
    break;
  }
  if (me?.status_text) {
    console.log(`  intermediate status_text: "${me.status_text}"`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

console.log('\n--- Result ---');
if (observed) {
  console.log(`✅ tab status_text === ${JSON.stringify(observed.status_text)}`);
  console.log(`   session_id: ${observed.cli_session_id}`);
} else {
  console.log(`❌ status_text never matched`);
  const s = await fetch(`${URL}api/sessions?status=active`).then((x) => x.json());
  const me = s.items.find((x) => x.instance_id === spawned.instance_id);
  console.log(`   last seen status_text: ${JSON.stringify(me?.status_text)}`);
  console.log(`   state: ${me?.state}`);
}

// Verify the per-session .mcp.json file exists
// (workspace path: try reading via /api or the well-known root)
import os from 'node:os';
const wsRoot = path.join(os.homedir(), '.clawdevbox', 'workspaces');
import { readdirSync } from 'node:fs';
const sid = spawned.session_id;
// Search for the file under ALL workspaces (workspace_id may not be a path)
let mcpPath = null;
try {
  for (const ws of readdirSync(wsRoot)) {
    const candidate = path.join(wsRoot, ws, '.clawdevbox', 'sessions', `${sid}.mcp.json`);
    if (existsSync(candidate)) { mcpPath = candidate; break; }
  }
} catch { /* ignore */ }
console.log(`per-session .mcp.json: ${mcpPath || 'NOT FOUND'}`);

// Cleanup
await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, { method: 'DELETE' });
console.log('cleanup done');

process.exit(observed ? 0 : 1);
