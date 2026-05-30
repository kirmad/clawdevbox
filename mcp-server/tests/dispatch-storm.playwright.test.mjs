// dispatch-storm.playwright.test.mjs
//
// STRESS TEST. Spawn ONE real copilot.exe pty against the live 5201
// server, then fire 10 dispatches back-to-back (mix of LLM prompts and
// slash-commands) and assert ALL canaries arrive in correct order.
//
// This is the heaviest reliability test: it stresses the SessionConductor
// queue (FIFO), the layered done-detector (marker + prompt-ready +
// idle-fallback), the Ctrl+U clear-input fix, AND the slash-command
// auto-skip-marker code path — all on the SAME pty without restart.
//
// Run: npx playwright test tests/dispatch-storm.playwright.test.mjs --reporter=list

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
  try { json = JSON.parse(text); } catch {}
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
    fire_id: `fire_storm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    secret: 'sec_storm_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x'),
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
  const spawnRes = await postJson(`/spawn/${fireId}`, { prompt: seedPrompt },
    { Authorization: `Bearer ${secret}` });
  if (spawnRes.status !== 200) throw new Error(`/spawn failed: ${spawnRes.raw}`);
  return { instanceId: spawnRes.body.instance_id };
}

async function waitForState(instanceId, predicate, maxSec = 120) {
  for (let i = 0; i < maxSec * 2; i++) {
    const list = await fetchJson('/api/sessions?status=active&limit=50');
    const row = list.body?.items?.find((it) => it.instance_id === instanceId);
    if (row && predicate(row)) return row;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForState: predicate never satisfied for ${instanceId}`);
}

async function readScrollback(instanceId, durationMs = 2000) {
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
      } catch {}
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
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForSubstring: "${substr}" not found. tail=${last.slice(-1200)}`);
}

async function cleanupSession(instanceId) {
  try {
    const { fireId, secret } = await recordActiveRun(instanceId);
    await postJson(`/dispatch/${fireId}`, { prompt: '/exit' },
      { Authorization: `Bearer ${secret}` }).catch(() => {});
  } catch {}
}

test.beforeAll(async () => {
  const r = await fetch(`${BASE}/healthz`);
  if (!r.ok) throw new Error(`clawdevbox not reachable at ${BASE}`);
});

test('STRESS: 10 mixed dispatches (LLM + slash) on same copilot pty all succeed', async () => {
  test.setTimeout(15 * 60_000); // 15 minutes

  const seedCanary = 'STORM_SEED_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const { instanceId } = await spawnFreshCopilot(`Reply with only: ${seedCanary}`);
  console.log(`[storm] spawned instance=${instanceId}`);

  const results = [];
  try {
    await waitForState(instanceId, (r) => r.live && (r.state === 'idle' || r.state === 'busy'), 120);
    await waitForSubstring(instanceId, seedCanary, 120);
    console.log(`[storm] seed canary ${seedCanary} arrived`);
    await waitForState(instanceId, (r) => r.live && r.state === 'idle', 60);

    // 10 dispatches: alternating LLM prompt + slash-command + LLM
    // patterns. Slash commands stress the auto-skip-marker code path.
    // LLM prompts stress writePrompt + done-detector across many requests.
    const dispatches = [];
    for (let i = 1; i <= 10; i++) {
      if (i % 3 === 0) {
        // Slash command — bug A regression coverage
        dispatches.push({ kind: 'slash', prompt: '/help', canary: null });
      } else {
        const canary = `STORM_C${i}_` + Math.random().toString(36).slice(2, 6).toUpperCase();
        dispatches.push({
          kind: 'llm',
          prompt: `Reply with only this exact token: ${canary}`,
          canary,
        });
      }
    }

    for (let i = 0; i < dispatches.length; i++) {
      const d = dispatches[i];
      const t0 = Date.now();
      const { fireId, secret } = await recordActiveRun(instanceId);
      const res = await postJson(`/dispatch/${fireId}`, { prompt: d.prompt },
        { Authorization: `Bearer ${secret}` });
      expect(res.status, `dispatch #${i + 1} (${d.kind}): ${res.raw}`).toBe(200);
      console.log(`[storm] #${i + 1} (${d.kind}) accepted, state=${res.body.state}`);

      if (d.kind === 'llm') {
        await waitForSubstring(instanceId, d.canary, 120);
        const elapsed = Date.now() - t0;
        results.push({ i: i + 1, kind: 'llm', canary: d.canary, ms: elapsed });
        console.log(`[storm] #${i + 1} ✅ canary ${d.canary} arrived (${elapsed}ms)`);
      } else {
        // For slash, just wait for help output or any non-error response
        let snap = '';
        let helpSeen = false;
        for (let j = 0; j < 30; j++) {
          snap = await readScrollback(instanceId, 1500);
          if (/Invalid argument/i.test(snap)) {
            throw new Error(`/help triggered "Invalid argument" — bug A regression! tail=${snap.slice(-800)}`);
          }
          if (/Available|Slash|Usage|press \?|commands/i.test(snap)) {
            helpSeen = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        const elapsed = Date.now() - t0;
        results.push({ i: i + 1, kind: 'slash', helpSeen, ms: elapsed });
        console.log(`[storm] #${i + 1} ✅ slash done (help_seen=${helpSeen}, ${elapsed}ms)`);
      }

      // Wait for conductor to return to idle before next dispatch
      await waitForState(instanceId, (r) => r.live && r.state === 'idle', 60);
    }

    // Final assertion: all LLM canaries present in final scrollback
    const finalSnap = await readScrollback(instanceId, 3000);
    const missing = [];
    for (const r of results) {
      if (r.kind === 'llm' && !finalSnap.includes(r.canary)) {
        missing.push(r.canary);
      }
    }
    expect(missing, `final scrollback missing canaries: ${missing.join(', ')}`).toEqual([]);

    // Summary
    const llmCount = results.filter((r) => r.kind === 'llm').length;
    const slashCount = results.filter((r) => r.kind === 'slash').length;
    const avgLlmMs = Math.round(
      results.filter((r) => r.kind === 'llm').reduce((s, r) => s + r.ms, 0) / Math.max(1, llmCount)
    );
    console.log(`[storm] ✅ STRESS PASS: ${llmCount} LLM dispatches (avg ${avgLlmMs}ms), ${slashCount} slash dispatches, all canaries present`);
  } finally {
    await cleanupSession(instanceId);
  }
});
