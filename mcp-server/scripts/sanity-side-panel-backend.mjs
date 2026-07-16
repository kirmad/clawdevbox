// Quick server-side sanity check ONLY — confirms /api/sessions/<id>/artifacts
// returns artifacts created via direct MCP RPC. Validates the BACKEND path.
// Not the real test — use test-side-panel-real-e2e.mjs for the agent-driven one.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const URL = 'http://127.0.0.1:5201/';

// Spawn copilot — we need a real workspace + session GUID to hang artifacts off.
const spawned = await (await fetch(`${URL}spawn`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Reply: ready.',
    provider: 'copilot',
  }),
})).json();
console.log(`spawned: ${spawned.instance_id}, sid: ${spawned.session_id}, ws: ${spawned.workspace_id}`);

// Read the .mcp.json the kernel just wrote for this session
const db = new Database(path.join(os.homedir(), '.clawdevbox', 'clawdevbox.db'), { readonly: true });
// Look up workspace via agent_sessions (instance_id → workspace_id → path)
await new Promise((r) => setTimeout(r, 2000));  // give DB row time to land
const sessRow = db.prepare(
  `SELECT s.workspace_id, w.path AS workspace_path
   FROM agent_sessions s JOIN workspaces w ON w.id = s.workspace_id
   WHERE s.recipe_instance_id = ? ORDER BY s.started_at DESC LIMIT 1`,
).get(spawned.instance_id);
db.close();
if (!sessRow) { console.log('FAIL: workspace not found'); process.exit(1); }
const workspaceId = sessRow.workspace_id;
const workspacePath = sessRow.workspace_path;
console.log(`workspace: ${workspaceId} at ${workspacePath}`);
const mcpPath = path.join(workspacePath, '.clawdevbox', 'sessions', `${spawned.session_id}.mcp.json`);
let triedMs = 0;
while (triedMs < 10_000) {
  try { readFileSync(mcpPath); break; } catch { /* */ }
  await new Promise((r) => setTimeout(r, 500)); triedMs += 500;
}
const cfg = JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.clawdevbox;
console.log(`mcp url: ${cfg.url}`);

function parseSseOrJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) { try { return JSON.parse(trimmed); } catch {} }
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith('data:')) {
      const p = l.slice(5).trim();
      if (p && p !== '[DONE]') { try { return JSON.parse(p); } catch {} }
    }
  }
  return null;
}

async function rpc(sessionId, method, params, id) {
  const body = id == null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
  const hdrs = { ...(cfg.headers || {}), 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sessionId) hdrs['mcp-session-id'] = sessionId;
  const res = await fetch(cfg.url, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body: parseSseOrJson(text), raw: text };
}

// 1. initialize
const init = await rpc(null, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'backend-sanity', version: '1.0' },
}, 1);
console.log(`initialize → status=${init.status} sid=${init.sessionId}`);
if (!init.sessionId) { console.log('FAIL: no mcp-session-id'); process.exit(1); }
await rpc(init.sessionId, 'notifications/initialized', {}, null);

// 2. Call artifact.add via the `run_tool` wrapper (the production tool surface).
const callRes = await rpc(init.sessionId, 'tools/call', {
  name: 'run_tool',
  arguments: {
    tool: 'artifact.add',
    args: {
      id: 'sanity-001',
      type: 'markdown',
      title: 'Sanity Check Artifact',
      files: { 'content.md': '# hello\n\nbackend sanity check.\n' },
      recipe_instance_id: spawned.instance_id,
      workspace_id: workspaceId,
    },
  },
}, 2);
console.log('artifact.add response:');
console.log(JSON.stringify(callRes.body, null, 2).slice(0, 1500));

// 3. Verify via the new endpoint
await new Promise((r) => setTimeout(r, 500));
const list = await (await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}/artifacts`)).json();
console.log(`/api/sessions/${spawned.instance_id}/artifacts: ${list.items?.length} items`);
console.log(JSON.stringify(list, null, 2));

// Cleanup
await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, { method: 'DELETE' });

const pass = (list.items?.length ?? 0) === 1 && list.items[0].title === 'Sanity Check Artifact';
console.log(`\n${pass ? '✅ PASS' : '❌ FAIL'} — backend path works`);
process.exit(pass ? 0 : 1);
