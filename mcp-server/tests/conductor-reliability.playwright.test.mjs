// conductor-reliability.playwright.test.mjs
//
// E2E tests against the REAL clawdevbox at http://127.0.0.1:5201 with the
// REAL `copilot.exe` binary. Validates three SessionConductor fixes:
//
//   1. Bug A — slash-commands like `/help` must NOT be wrapped with the
//      [SYSTEM: ###CDB_DONE_...] marker (corrupts copilot's command parser).
//   2. Bug B — when a dispatch is aborted via Ctrl+C, the conductor should
//      detect copilot's "ctrl+c again to exit" hint and NOT false-positive
//      on the redrawn prompt glyph.
//   3. Bug C — sequential dispatches against the SAME copilot pty must all
//      submit successfully (regression for the `\x15` clear-input fix in
//      copilot.writePrompt).
//
// Run with:
//   cd C:\git\clawdevbox\mcp-server
//   npx playwright test tests/conductor-reliability.playwright.test.mjs --reporter=list

import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

const BASE = process.env.CLAWDEVBOX_URL ?? 'http://127.0.0.1:5201';
const TOKEN = process.env.CLAWDEVBOX_TOKEN ?? '';
const PROVIDER = process.env.CLAWDEVBOX_PROVIDER ?? 'copilot';
const PROJECT_DIR = process.env.CLAWDEVBOX_PROJECT_DIR ?? 'C:\\git\\clawdevbox\\mcp-server';

const baseAuth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function fetchJson(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...baseAuth, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json ?? text, raw: text };
}

async function postJson(path, body, extraHeaders = {}) {
  return fetchJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body ?? {}),
  });
}

async function recordActiveRun(targetInstanceId) {
  const body = {
    fire_id: `fire_cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    secret: 'sec_cr_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x'),
    workspace_path: PROJECT_DIR,
    provider_id: PROVIDER,
  };
  if (targetInstanceId) body.dispatch_target_instance_id = targetInstanceId;
  const rec = await postJson('/api/test/record-active-run', body);
  if (rec.status !== 200) throw new Error(`record-active-run failed: ${rec.raw}`);
  return { fireId: rec.body.fire_id, secret: rec.body.secret };
}

async function spawnFreshCopilot(seedPrompt) {
  const { fireId, secret } = await recordActiveRun(null);
  const spawnRes = await postJson(`/spawn?fire_id=${fireId}`, {
    prompt: seedPrompt,
  });
  if (spawnRes.status !== 200) throw new Error(`/spawn failed: ${spawnRes.raw}`);
  return {
    fireId,
    secret,
    instanceId: spawnRes.body.instance_id,
  };
}

async function waitForState(instanceId, predicate, maxSec = 90) {
  for (let i = 0; i < maxSec * 2; i++) {
    const list = await fetchJson('/api/sessions?status=active&limit=50');
    const row = list.body?.items?.find((it) => it.instance_id === instanceId);
    if (row && predicate(row)) return row;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForState: predicate never satisfied for ${instanceId}`);
}

async function waitForIdle(instanceId, maxSec = 120) {
  return waitForState(instanceId, (r) => r.live && r.state === 'idle', maxSec);
}

async function readScrollback(instanceId, durationMs = 2000) {
  // Connect to the pty WebSocket, accumulate the snapshot + any data
  // events for `durationMs`, then close. Returns the concatenated string.
  return new Promise((resolve, reject) => {
    const wsUrl = BASE.replace(/^http/, 'ws') + `/terminal/${instanceId}/ws`;
    const ws = new WebSocket(wsUrl);
    let buf = '';
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(buf); }, durationMs);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'snapshot' && typeof msg.content === 'string') buf += msg.content;
        else if (msg.type === 'data' && typeof msg.chunk === 'string') buf += msg.chunk;
      } catch { /* ignore */ }
    });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function waitForSubstring(instanceId, substr, maxSec = 90) {
  let last = '';
  for (let i = 0; i < maxSec; i += 2) {
    try {
      const snap = await readScrollback(instanceId, 1500);
      last = snap;
      if (snap.includes(substr)) return snap;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForSubstring: "${substr}" not found. tail=${last.slice(-1500)}`);
}

async function cleanupSession(instanceId) {
  try {
    const { fireId, secret } = await recordActiveRun(instanceId);
    await postJson(`/dispatch?fire_id=${fireId}`, { prompt: '/exit' }).catch(() => {});
  } catch { /* ignore */ }
}

test.beforeAll(async () => {
  const r = await fetch(`${BASE}/healthz`);
  if (!r.ok) throw new Error(`clawdevbox not reachable at ${BASE}`);
});

// ---------------------------------------------------------------------------
// Bug C — multi-dispatch sequence on the SAME copilot pty
// ---------------------------------------------------------------------------
test('bug C: 3 sequential dispatches on same copilot pty all get responses', async () => {
  test.setTimeout(600_000);

  const seedCanary = 'CR_SEED_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const { instanceId } = await spawnFreshCopilot(`Reply with only: ${seedCanary}`);
  console.log(`spawned instance=${instanceId}`);

  try {
    await waitForState(instanceId, (r) => r.live && (r.state === 'idle' || r.state === 'busy'), 120);
    await waitForSubstring(instanceId, seedCanary, 120);
    console.log(`seed canary ${seedCanary} arrived`);
    await waitForIdle(instanceId, 60);

    const canaries = [];
    for (let i = 1; i <= 3; i++) {
      const canary = `CR_DISP${i}_` + Math.random().toString(36).slice(2, 8).toUpperCase();
      canaries.push(canary);
      const { fireId, secret } = await recordActiveRun(instanceId);
      const res = await postJson(`/dispatch?fire_id=${fireId}`, {
        prompt: `Reply with only: ${canary}`,
      });
      expect(res.status, `dispatch ${i} response: ${res.raw}`).toBe(200);
      console.log(`dispatch #${i} accepted; waiting for canary ${canary}...`);
      await waitForSubstring(instanceId, canary, 90);
      console.log(`✅ canary ${canary} arrived`);
      await waitForIdle(instanceId, 60);
    }

    // Final assertion: all canaries present in scrollback
    const finalSnap = await readScrollback(instanceId, 2000);
    for (const c of canaries) {
      expect(finalSnap, `final snapshot missing canary ${c}`).toContain(c);
    }
  } finally {
    await cleanupSession(instanceId);
  }
});

// ---------------------------------------------------------------------------
// Bug A — slash-command dispatch must not be wrapped with [SYSTEM:] marker
// ---------------------------------------------------------------------------
test('bug A: /help slash command does not show "Invalid argument"', async () => {
  test.setTimeout(300_000);

  const seedCanary = 'CR_HELP_SEED_' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const { instanceId } = await spawnFreshCopilot(`Reply with only: ${seedCanary}`);
  console.log(`spawned instance=${instanceId}`);

  try {
    await waitForState(instanceId, (r) => r.live && (r.state === 'idle' || r.state === 'busy'), 120);
    await waitForSubstring(instanceId, seedCanary, 120);
    await waitForIdle(instanceId, 60);

    // Dispatch /help and assert copilot's help text appears WITHOUT the
    // "Invalid argument" error that would result from the [SYSTEM:...]
    // marker being appended.
    const { fireId, secret } = await recordActiveRun(instanceId);
    const res = await postJson(`/dispatch?fire_id=${fireId}`, { prompt: '/help' });
    expect(res.status, `/dispatch /help: ${res.raw}`).toBe(200);

    // Wait for either help text or invalid-argument error to appear.
    let snap = '';
    for (let i = 0; i < 30; i++) {
      snap = await readScrollback(instanceId, 1500);
      if (/Invalid argument/i.test(snap)) break;
      if (/Available commands|Slash commands|Usage:|usage:|press \?/i.test(snap)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(snap, `snapshot should NOT contain "Invalid argument" (would indicate /help was wrapped with marker). tail=${snap.slice(-1500)}`)
      .not.toMatch(/Invalid argument/i);
  } finally {
    await cleanupSession(instanceId);
  }
});

// ---------------------------------------------------------------------------
// Bug B — abort detection: after Ctrl+C the conductor must transition back
// to idle and the next dispatch must succeed. We verify externally by:
//   1. sending a long-running prompt
//   2. sending Ctrl+C via WS terminal input
//   3. asserting a subsequent dispatch completes correctly (proves the
//      conductor did NOT get stuck or false-positive on the abort redraw)
// ---------------------------------------------------------------------------
test('bug B: ctrl+c during dispatch leaves conductor usable for next dispatch', async () => {
  test.setTimeout(300_000);

  const seedCanary = 'CR_ABORT_SEED_' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const { instanceId } = await spawnFreshCopilot(`Reply with only: ${seedCanary}`);
  console.log(`spawned instance=${instanceId}`);

  try {
    await waitForState(instanceId, (r) => r.live && (r.state === 'idle' || r.state === 'busy'), 120);
    await waitForSubstring(instanceId, seedCanary, 120);
    await waitForIdle(instanceId, 60);

    // Send a long-running prompt, then 3s later send Ctrl+C via WS.
    const { fireId: longFireId, secret: longSecret } = await recordActiveRun(instanceId);
    await postJson(`/dispatch?fire_id=${longFireId}`, {
      prompt: 'Count slowly from 1 to 50, one number per line, with a sentence describing each.',
    });

    // Open WS, wait, send Ctrl+C
    await new Promise((r) => setTimeout(r, 3000));
    const wsUrl = BASE.replace(/^http/, 'ws') + `/terminal/${instanceId}/ws`;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(() => reject(new Error('ws open timeout')), 10_000);
    });
    ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
    await new Promise((r) => setTimeout(r, 500));
    ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
    await new Promise((r) => setTimeout(r, 500));
    ws.close();

    // Wait for conductor to settle back to idle.
    await waitForState(instanceId, (r) => r.live && r.state === 'idle', 60);
    console.log(`conductor returned to idle after Ctrl+C`);

    // Now a fresh dispatch must work.
    const followCanary = 'CR_AFTER_ABORT_' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const { fireId, secret } = await recordActiveRun(instanceId);
    const res = await postJson(`/dispatch?fire_id=${fireId}`, {
      prompt: `Reply with only: ${followCanary}`,
    });
    expect(res.status).toBe(200);
    await waitForSubstring(instanceId, followCanary, 90);
    console.log(`✅ post-abort dispatch succeeded`);
  } finally {
    await cleanupSession(instanceId);
  }
});
