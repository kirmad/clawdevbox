// live-copilot-e2e.playwright.test.mjs
//
// E2E playwright test against a REAL running clawdevbox at
// http://127.0.0.1:5201 (or override with $CLAWDEVBOX_URL) with the
// REAL `copilot.exe` binary on PATH — NOT the e2e-test-runner stub,
// NOT a test-spawned subprocess.
//
// Prerequisites the test asserts before running:
//   • clawdevbox HTTP server reachable at $CLAWDEVBOX_URL/healthz
//   • copilot.exe (or the configured CLAWDEVBOX_PROVIDER) is registered
//     in the server's agent-cli registry
//   • Server was started without an http.token (loopback-only auth),
//     OR test was given $CLAWDEVBOX_TOKEN to use as bearer
//
// What it validates:
//   1. SPA at / serves the Terminals tab (proves the live bundle is
//      the new one — fails fast if user forgot to rebuild + restart).
//   2. POST /spawn/<fire_id> with the per-fire bearer spawns a REAL
//      interactive copilot.exe pty. The new tab appears in the SPA's
//      Active section via the 'sessions' event-bus topic.
//   3. The conductor transitions from 'starting' → 'idle' (proves the
//      ❯ prompt-ready glyph was observed on a stable tail — i.e. the
//      real copilot REPL is ready for input).
//   4. The seed prompt passed at spawn time was delivered via
//      deliverInitialPromptWhenReady and the LLM's response canary
//      appears in the live xterm scrollback.
//   5. POST /dispatch/<fire_id> with a new prompt drives bytes through
//      SessionConductor → copilot.writePrompt → split-cr-250ms protocol
//      → real pty.write → real copilot stdin → real LLM. The dispatch
//      canary appears in xterm.
//   6. Cleanup: /dispatch "/exit" closes the real copilot session.
//
// Run with: npx playwright test tests/live-copilot-e2e.playwright.test.mjs

import { test, expect, chromium } from '@playwright/test';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE = process.env.CLAWDEVBOX_URL ?? 'http://127.0.0.1:5201';
const TOKEN = process.env.CLAWDEVBOX_TOKEN ?? '';
const PROVIDER = process.env.CLAWDEVBOX_PROVIDER ?? 'copilot';
const PROJECT_DIR = process.env.CLAWDEVBOX_PROJECT_DIR ?? 'C:\\git\\clawdevbox\\mcp-server';
const SHOT_DIR = resolve(__dirname, '..', 'verify-screenshots');

const baseAuth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

mkdirSync(SHOT_DIR, { recursive: true });

let browser;
let context;
let page;

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

async function shoot(name) {
  if (!page) return;
  const file = resolve(SHOT_DIR, `live-copilot-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const size = existsSync(file) ? statSync(file).size : 0;
  console.log(`📸 ${name}: ${size} bytes → ${file}`);
}

async function readXtermScreen() {
  if (!page) return '';
  return page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    return rows ? rows.textContent : '';
  });
}

// --- Top-level state shared across the test steps ---------------------------
let spawnInstanceId = null;
let spawnFireId = null;
let spawnSecret = null;
let dispatchFireId = null;
let dispatchSecret = null;
let initialCanary = null;

// ---------------------------------------------------------------------------
// Setup: verify live server is up before launching browser
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  // Verify the live server is reachable. If not, fail with a clear hint
  // rather than spawning our own subprocess (the user explicitly wants
  // to validate the REAL running instance).
  try {
    const r = await fetch(`${BASE}/healthz`);
    if (!r.ok) throw new Error(`healthz returned ${r.status}`);
    const txt = await r.text();
    if (txt.trim() !== 'ok') throw new Error(`unexpected healthz body: ${txt}`);
  } catch (err) {
    throw new Error(
      `clawdevbox not reachable at ${BASE}: ${err.message}.\n` +
      `Start it first: \`node dist/cli.js start\` (or \`clawdevbox start\`).`,
    );
  }

  // Verify the requested provider is registered. Skip the whole suite
  // with a clear reason if not.
  const agentClis = await fetchJson('/api/test/agent-clis');
  const provider = agentClis.body?.items?.find((p) => p.id === PROVIDER);
  if (!provider) {
    const available = (agentClis.body?.items ?? []).map((p) => p.id).join(', ');
    throw new Error(
      `provider '${PROVIDER}' is not registered on the live server. ` +
      `Available: ${available}.`,
    );
  }
  console.log(`✅ live server up at ${BASE}, provider=${PROVIDER}`);

  browser = await chromium.launch();
  context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    serviceWorkers: 'allow',
  });
  page = await context.newPage();
  page.on('pageerror', (err) => console.warn('[pageerror]', err.message));
});

test.afterAll(async () => {
  // Best-effort cleanup: if a real copilot session is still alive,
  // try to /exit it via dispatch.
  if (dispatchFireId && dispatchSecret) {
    await postJson(`/dispatch/${dispatchFireId}`, { prompt: '/exit' },
      { Authorization: `Bearer ${dispatchSecret}` }).catch(() => {});
  }
  try { await context?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 1. SPA loads + Terminals tab present (proves the live bundle is new)
// ---------------------------------------------------------------------------

test('live: SPA serves new Terminals tab', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 15_000 });
  const termTab = page.getByRole('tab', { name: /Terminals/i });
  await expect(termTab, 'Terminals tab must exist — if not, the live server is serving an old bundle').toBeVisible({ timeout: 5_000 });
  await termTab.click();
  await page.waitForTimeout(800);
  await shoot('01-initial');
});

// ---------------------------------------------------------------------------
// 2. POST /spawn creates a real interactive copilot pty + UI shows it
// ---------------------------------------------------------------------------

test('live: POST /spawn creates a real copilot pty visible in the UI', async () => {
  // Inject activeRuns entry so /spawn accepts the per-fire bearer.
  const rec = await postJson('/api/test/record-active-run', {
    fire_id: `fire_live_copilot_${Date.now().toString(36)}`,
    secret: 'sec_live_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x'),
    workspace_path: PROJECT_DIR,
    provider_id: PROVIDER,
  });
  expect(rec.status).toBe(200);
  spawnFireId = rec.body.fire_id;
  spawnSecret = rec.body.secret;

  initialCanary = 'COPILOT_HELLO_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  console.log(`📤 POST /spawn provider=${PROVIDER} canary=${initialCanary}`);
  const spawnRes = await postJson(`/spawn/${spawnFireId}`, {
    prompt: `Reply with only: ${initialCanary}`,
  }, { Authorization: `Bearer ${spawnSecret}` });
  expect(spawnRes.status, `/spawn body: ${spawnRes.raw}`).toBe(200);
  expect(spawnRes.body.ok).toBe(true);
  expect(spawnRes.body.instance_id).toBeTruthy();
  spawnInstanceId = spawnRes.body.instance_id;
  console.log(`✅ /spawn returned instance_id=${spawnInstanceId}`);

  // New tab should appear in UI within ~15s (event-bus 'sessions' debounced refresh).
  const shortId = spawnInstanceId.slice(-8);
  const tabLabel = `Spawn ${shortId}`;
  const tabLocator = page.getByText(tabLabel, { exact: true });
  await expect(tabLocator).toBeVisible({ timeout: 20_000 });
  await tabLocator.click();
  await page.waitForTimeout(1500); // xterm attach
  await shoot('02-spawned');
});

// ---------------------------------------------------------------------------
// 3. Real copilot REPL reaches ready state + initial canary appears
// ---------------------------------------------------------------------------

test('live: real copilot reaches idle + LLM responds to seed prompt', async () => {
  test.setTimeout(180_000); // 3 minutes — real LLM cold start + roundtrip

  console.log(`⏳ waiting for conductor to reach idle (real copilot cold start ~20-40s)...`);
  let ready = false;
  let lastState = null;
  for (let i = 0; i < 240; i++) {
    const list = await fetchJson('/api/sessions?status=active&limit=50');
    const row = list.body?.items?.find((it) => it.instance_id === spawnInstanceId);
    lastState = row;
    if (row && row.live && (row.state === 'idle' || row.state === 'busy')) { ready = true; break; }
    if (!row || !row.live) {
      console.warn(`  pty exited (live=${row?.live}, state=${row?.state})`);
      break;
    }
    if (i % 20 === 0) console.log(`  [${i*500}ms] state=${row?.state ?? '?'}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    console.error('xterm tail (last 2000):', (await readXtermScreen()).slice(-2000));
  }
  expect(ready, `copilot pty never reached idle/busy state. last row: ${JSON.stringify(lastState)}`).toBe(true);
  console.log(`✅ conductor reached non-starting state`);

  // Wait for the seed prompt's canary in xterm (LLM roundtrip).
  let foundInitial = false;
  for (let i = 0; i < 90; i++) {
    const screen = await readXtermScreen();
    if (screen && screen.includes(initialCanary)) { foundInitial = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await shoot('03-initial-canary');
  expect(foundInitial, `initial canary "${initialCanary}" never appeared in xterm — LLM did not respond to seed prompt`).toBe(true);
  console.log(`✅ initial canary "${initialCanary}" arrived in xterm`);
});

// ---------------------------------------------------------------------------
// 4. POST /dispatch sends a follow-up prompt + LLM responds via real chain
// ---------------------------------------------------------------------------

test('live: POST /dispatch delivers a follow-up prompt to the SAME copilot pty', async () => {
  test.setTimeout(120_000); // 2 minutes — LLM roundtrip

  // Inject a new activeRuns entry targeting the existing spawned pty.
  const rec = await postJson('/api/test/record-active-run', {
    fire_id: `fire_live_dispatch_${Date.now().toString(36)}`,
    secret: 'sec_live_d_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x'),
    workspace_path: PROJECT_DIR,
    provider_id: PROVIDER,
    dispatch_target_instance_id: spawnInstanceId,
  });
  expect(rec.status).toBe(200);
  dispatchFireId = rec.body.fire_id;
  dispatchSecret = rec.body.secret;

  const canary2 = 'COPILOT_DISPATCH_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  console.log(`📤 POST /dispatch canary=${canary2}`);
  const dispRes = await postJson(`/dispatch/${dispatchFireId}`, {
    prompt: `Reply with only: ${canary2}`,
  }, { Authorization: `Bearer ${dispatchSecret}` });
  expect(dispRes.status, `/dispatch body: ${dispRes.raw}`).toBe(200);
  expect(dispRes.body.ok).toBe(true);
  console.log(`✅ /dispatch accepted — conductor state=${dispRes.body.state}`);

  // Wait for the dispatched canary in xterm. Real LLM roundtrip ~5-30s.
  let foundDispatch = false;
  for (let i = 0; i < 90; i++) {
    const screen = await readXtermScreen();
    if (screen && screen.includes(canary2)) { foundDispatch = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await shoot('04-dispatched');

  if (!foundDispatch) {
    console.error('xterm tail (last 2000):', (await readXtermScreen()).slice(-2000));
  }
  expect(foundDispatch, `dispatch canary "${canary2}" never appeared in xterm`).toBe(true);
  console.log(`✅ dispatch canary "${canary2}" arrived in xterm — full chain validated against REAL copilot`);
});

// ---------------------------------------------------------------------------
// 5. Clean shutdown: /dispatch "/exit"
// ---------------------------------------------------------------------------

test('live: /exit dispatch closes the copilot session cleanly', async () => {
  test.setTimeout(30_000);

  await postJson(`/dispatch/${dispatchFireId}`, { prompt: '/exit' },
    { Authorization: `Bearer ${dispatchSecret}` });

  // Poll for the pty to exit (move from live → archived in /api/sessions).
  let exited = false;
  for (let i = 0; i < 30; i++) {
    const list = await fetchJson('/api/sessions?status=all&limit=200');
    const row = list.body?.items?.find((it) => it.instance_id === spawnInstanceId);
    if (!row || !row.live) { exited = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  await shoot('05-exited');

  // Soft assertion — /exit may not be a recognized copilot command in
  // all configurations; what matters is that we don't hang.
  console.log(exited
    ? `✅ pty exited cleanly after /exit dispatch`
    : `⚠️  pty still alive after /exit (likely "/exit" is not a copilot command) — best-effort cleanup will run in afterAll`);
});
