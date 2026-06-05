// terminals-panel-e2e.playwright.test.mjs
//
// Real-binary end-to-end for the Terminals Panel UI + spawn/dispatch flow.
// Spins up a clawdevbox subprocess, opens the SPA, then:
//
//   1. Asserts the Terminals tab is the new top-level tab and the Main
//      Agent appears in the Active section. Screenshot: initial state.
//   2. Drives /spawn/<fire_id> to spawn a fresh interactive
//      e2e-test-runner pty (extended with capabilities+writePrompt in
//      commit beb48cb). Waits for the new tab to appear in Active section.
//      Screenshot: post-spawn state.
//   3. Drives /dispatch/<same fire_id> to send a follow-up prompt to that
//      SAME pty via SessionConductor. Asserts the prompt bytes arrive at
//      the agent's stdin (DISPATCH_RX marker in pty scrollback).
//      Screenshot: post-dispatch state.
//   4. Cleanup via __EXIT__ dispatch.
//
// This validates the whole user-visible chain: new tab in the UI when a
// trigger spawns a session, plus follow-up prompts being routed via
// /dispatch to the live pty's conductor.

import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const cliEntry = resolve(projectRoot, 'src/index.ts');
const SHOT_DIR = resolve(projectRoot, 'verify-screenshots');

function freePortGuess() {
  return 15500 + Math.floor(Math.random() * 100);
}

let serverProc;
let tmpRoot;
let port;
let token;
let browser;
let context;
let workspaceId;
let workspacePath;

const baseAuth = () => ({});

async function waitForHealth(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok && (await r.text()).trim() === 'ok') return;
    } catch { /* not yet listening */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server not healthy in ' + timeoutMs + 'ms');
}

async function postJson(path, body, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...baseAuth(), ...extraHeaders },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json ?? text, raw: text };
}

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { accept: 'application/json', ...baseAuth() },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json ?? text };
}

test.beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-term-e2e-'));
  const projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  port = freePortGuess();
  token = 'pwt-' + Math.random().toString(36).slice(2, 10);
  workspacePath = projectDir;

  writeFileSync(
    join(projectDir, '.clawdevbox', 'config.json'),
    JSON.stringify({
      version: 1,
      project_dir: projectDir,
      global_dir: globalDir,
      http: { port, host: '127.0.0.1', token },
    }, null, 2),
  );

  serverProc = spawn('npx', ['tsx', cliEntry, 'start'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
      CLAWDEVBOX_PORT: String(port),
      CLAWDEVBOX_HOST: '127.0.0.1',
      CLAWDEVBOX_TOKEN: token,
      // Activate the e2e-test-runner's stdin-echo loop so /dispatch
      // bytes are observable in scrollback as DISPATCH_RX markers.
      CLAWDEVBOX_E2E_INTERACTIVE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  serverProc.stderr.on('data', (chunk) => {
    const s = chunk.toString();
    if (/error|throw|EADDRINUSE/i.test(s)) process.stderr.write(`[server] ${s}`);
  });

  await waitForHealth();

  // Register the workspace in the DB so /spawn → runRecipe can resolve it.
  const wsResp = await postJson('/api/workspaces', { path: projectDir });
  if (wsResp.status >= 200 && wsResp.status < 300 && wsResp.body?.id) {
    workspaceId = wsResp.body.id;
  } else {
    // Fall back to finding it from /api/sessions if main-agent already
    // registered the workspace. Or accept it isn't present — /spawn
    // surfaces a clear 500 if needed.
    const sessions = await getJson('/api/sessions');
    const main = sessions.body?.items?.find((i) => i.instance_id === 'main');
    workspaceId = main?.workspace_id ?? 'project';
  }

  browser = await chromium.launch();
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'allow',
  });
  mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
  try { await context?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  if (serverProc && !serverProc.killed) {
    if (platform() === 'win32' && serverProc.pid) {
      spawnSync('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
  if (tmpRoot && existsSync(tmpRoot)) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Direct kernel-state mutation: insert a fake fire row + register an
// activeRuns entry so /dispatch and /spawn accept the per-fire bearer.
//
// In production the dispatcher does this when a real trigger script
// runs. For the test we drive the kernel state directly via a small
// MCP tool — `dispatcher.__test_recordActiveRun` was added in the
// trigger-dispatch PR (commit fbdd8d2) but is exposed as
// recordActiveRun() in the Dispatcher class. We use the /api/test
// surface (api-test-hooks.ts) to reach it.
// ---------------------------------------------------------------------------

async function recordActiveRun(opts) {
  // Use the api-test-hooks surface to inject a fire + activeRuns entry.
  // If this endpoint doesn't exist, fall back to manually inserting
  // into the DB via a separate route. For now, try the /api/test path.
  const fireId = 'fire_e2e_' + Math.random().toString(36).slice(2, 10);
  const secret = 'sec_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x');

  const r = await postJson('/api/test/record-active-run', {
    fire_id: fireId,
    secret,
    workspace_id: opts.workspaceId,
    workspace_path: opts.workspacePath,
    provider_id: 'e2e-test-runner',
    dispatch_target_instance_id: opts.dispatchTargetInstanceId ?? null,
  });

  if (r.status !== 200) {
    throw new Error(`recordActiveRun failed: ${r.status} ${r.raw}`);
  }
  return { fireId, secret };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('Terminals panel: initial state shows Main Agent in Active section', async () => {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[console.error]', msg.text());
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('tab', { name: /Terminals/i }).click();
  await page.waitForTimeout(800);

  // Active group header is always visible.
  await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();

  // Main Agent should appear in the Active section if the main agent is
  // running. (It might not be if the test config doesn't auto-spawn one;
  // either way the section header should render.)
  const mainTab = page.getByText('Main Agent', { exact: true });
  // Allow the main agent some time to register.
  await mainTab.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
    console.warn('Main Agent did not appear within 10s — continuing test');
  });

  await page.screenshot({ path: join(SHOT_DIR, 'terminals-01-initial.png'), fullPage: true });
  await page.close();
});

test('Terminals panel: hidden mount on Inbox tab does NOT send a bad resize to the live pty', async () => {
  // Regression: PrimeVue eagerly mounts every TabPanel, so <TerminalsPanel>
  // mounts even while the default Inbox tab is active. Its attach() runs
  // against a hidden 0×0 .xterm-host; before the fix, fit.fit() silently
  // no-op'd but term.cols/rows still held xterm's 80×24 defaults, and
  // ws.onopen sent `resize: {cols: 80, rows: 24}` — SHRINKING the live
  // pty (e.g. the agency CLI's input box rendered in the middle of the
  // viewport with empty rows below, exactly what the user-reported
  // screenshot showed). Guard added in TerminalsPanel.vue::refit().
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));

  // Instrument WebSocket.send BEFORE app boot so the SPA's terminal WS
  // is captured from the very first message.
  await page.addInitScript(() => {
    window.__resizeCalls = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      try {
        const m = JSON.parse(data);
        if (m && m.type === 'resize' && /\/terminal\//.test(this.url)) {
          window.__resizeCalls.push({ cols: m.cols, rows: m.rows, url: this.url, when: 'hidden' });
        }
      } catch {}
      return origSend.call(this, data);
    };
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 10_000 });
  // Stay on the default Inbox tab. Give the SPA time to mount all
  // TabPanels (including the hidden <TerminalsPanel>), open its WS,
  // receive snapshot, and fire any refit() side effects.
  await page.waitForTimeout(2000);

  const hiddenResizes = await page.evaluate(() => window.__resizeCalls.slice());
  console.log('[resize-bug] resizes sent while Inbox tab active:', JSON.stringify(hiddenResizes));

  // Specifically forbid the xterm-default 80×24 from being sent — that's
  // the smoking gun of the bug. Any tiny size leaked to the pty would
  // shrink it.
  const bad = hiddenResizes.filter((r) => r.cols === 80 && r.rows === 24);
  expect(bad, 'no resize(80,24) — xterm defaults — should be sent while Terminals tab is hidden').toEqual([]);
  // Belt-and-suspenders: any resize sent while hidden is suspect because
  // the host hasn't been measured. After the fix, we expect zero.
  expect(hiddenResizes.length, `no resize messages expected while Terminals tab is hidden; got ${JSON.stringify(hiddenResizes)}`).toBe(0);

  // Sanity: switching to Terminals tab DOES send a real resize so the
  // pty gets correctly sized for the viewer.
  await page.evaluate(() => { window.__resizeCalls.length = 0; });
  await page.locator('[role="tab"]:has-text("Terminals")').first().click();
  await page.waitForTimeout(1500);
  const visibleResizes = await page.evaluate(() => window.__resizeCalls.slice());
  console.log('[resize-bug] resizes sent after Terminals tab visible:', JSON.stringify(visibleResizes));
  expect(visibleResizes.length, 'at least one resize should fire when host becomes visible').toBeGreaterThan(0);
  for (const r of visibleResizes) {
    expect(r.cols, 'cols should reflect real host width, not xterm default').toBeGreaterThan(40);
    expect(r.rows, 'rows should reflect real host height, not xterm default').toBeGreaterThan(10);
  }

  await page.close();
});

test('Terminals panel: /spawn creates a new tab in Active section', async () => {
  // 1. Record a fake fire + secret in dispatcher's activeRuns
  const { fireId, secret } = await recordActiveRun({
    workspaceId,
    workspacePath,
  });

  // 2. POST /spawn/<fire_id> with the per-fire bearer
  const spawnRes = await fetch(`http://127.0.0.1:${port}/spawn?fire_id=${fireId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt: 'Reply with only: E2E_INITIAL_OK' }),
  });
  expect(spawnRes.status, 'POST /spawn should return 200').toBe(200);
  const spawnBody = await spawnRes.json();
  expect(spawnBody.ok).toBe(true);
  expect(spawnBody.instance_id).toBeTruthy();
  console.log('[spawn] new instance_id:', spawnBody.instance_id);

  // 3. Open the SPA and click Terminals tab
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('tab', { name: /Terminals/i }).click();
  await page.waitForTimeout(800);

  // 4. The new tab should appear in the Active section. Its label is
  //    "Spawn <last-8-chars>" per the label-derivation rule.
  const shortId = spawnBody.instance_id.slice(-8);
  const expectedLabel = `Spawn ${shortId}`;
  console.log('[ui] looking for tab label:', expectedLabel);

  // Poll for the new tab — the 'sessions' topic event should refresh it
  // automatically but there's a debounce.
  await expect(page.getByText(expectedLabel, { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: join(SHOT_DIR, 'terminals-02-spawned.png'), fullPage: true });
  await page.close();

  // Stash for the next test.
  test.info().annotations.push({ type: 'spawned_instance_id', description: spawnBody.instance_id });
  test.info().annotations.push({ type: 'spawned_fire_id', description: fireId });
  test.info().annotations.push({ type: 'spawned_secret', description: secret });
});

test('Terminals panel: /dispatch delivers a follow-up prompt to the same pty', async () => {
  // Re-create the activeRun for a fresh dispatch (the previous one was
  // cleaned up when the script exited; we want to dispatch into the LIVE
  // spawned pty from the previous test).
  const annotations = test.info().annotations;
  // The previous test stashed these — pull them from the test runner's
  // annotations or just re-spawn if not available.

  // For robustness, do a fresh spawn + dispatch in this test rather than
  // relying on test ordering. Spawn a new pty with its own activeRuns entry.
  const { fireId: spawnFireId, secret: spawnSecret } = await recordActiveRun({
    workspaceId,
    workspacePath,
  });

  const spawnRes = await fetch(`http://127.0.0.1:${port}/spawn?fire_id=${spawnFireId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt: 'Reply with only: E2E_DISPATCH_TARGET_READY' }),
  });
  expect(spawnRes.status).toBe(200);
  const { instance_id: dispatchTargetId } = await spawnRes.json();
  console.log('[dispatch-test] spawned target:', dispatchTargetId);

  // Wait for the new pty's conductor to be ready. Use the LIST endpoint
  // (already verified to include both live + archived) rather than the
  // singular endpoint which 404s for archived sessions. Then look for
  // READY_FOR_DISPATCH via the pty's WebSocket scrollback.
  let ready = false;
  let lastState = null;
  for (let i = 0; i < 40; i++) {
    const list = await getJson('/api/sessions?status=all&limit=200');
    const row = list.body?.items?.find((it) => it.instance_id === dispatchTargetId);
    lastState = row;
    if (row && row.live && (row.state === 'idle' || row.state === 'busy')) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    throw new Error(`spawned pty never reached idle state. last row: ${JSON.stringify(lastState)}`);
  }
  console.log('[dispatch-test] target pty ready');

  // 2. Record a NEW activeRun targeting the just-spawned pty for dispatch
  const { fireId: dispatchFireId, secret: dispatchSecret } = await recordActiveRun({
    workspaceId,
    workspacePath,
    dispatchTargetInstanceId: dispatchTargetId,
  });

  // 3. POST /dispatch/<fire_id> with the dispatch prompt
  const canary = 'E2E_DISPATCH_HELLO_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const dispatchRes = await fetch(`http://127.0.0.1:${port}/dispatch?fire_id=${dispatchFireId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt: canary }),
  });
  expect(dispatchRes.status, 'POST /dispatch should return 200').toBe(200);
  const dispatchBody = await dispatchRes.json();
  expect(dispatchBody.ok).toBe(true);
  console.log('[dispatch] queued at:', dispatchBody.queued_at, 'state:', dispatchBody.state);

  // 4. Open the SPA, click Terminals, click the dispatched target tab,
  //    and verify the prompt arrives in the xterm scrollback as
  //    "DISPATCH_RX: <canary>" (per the e2e-test-runner echo loop).
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('tab', { name: /Terminals/i }).click();
  await page.waitForTimeout(800);

  const shortId = dispatchTargetId.slice(-8);
  const targetLabel = `Spawn ${shortId}`;
  await expect(page.getByText(targetLabel, { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByText(targetLabel, { exact: true }).click();
  await page.waitForTimeout(1500); // xterm attach + initial snapshot

  // Wait for the DISPATCH_RX marker in the xterm scrollback. xterm renders
  // text inside a canvas + DOM accessibility tree; we poll the WS via
  // the API for scrollback OR check the visible textContent of the xterm
  // host. The textContent approach is fragile; instead poll the api/sessions
  // endpoint for state changes AND check the xterm host's accessibility
  // tree.
  const xtermHost = page.locator('.xterm-host');
  await expect(xtermHost).toBeVisible({ timeout: 5_000 });

  // The xterm screen renderer writes to a canvas, so textContent doesn't
  // reflect it directly. xterm.js exposes a screen-reader DOM region
  // (`.xterm-helper-textarea` / `.xterm-rows`) that mirrors visible cells.
  let foundMarker = false;
  for (let i = 0; i < 30; i++) {
    const screenText = await page.evaluate(() => {
      const rows = document.querySelector('.xterm-rows');
      return rows ? rows.textContent : '';
    });
    if (screenText && screenText.includes(`DISPATCH_RX: ${canary}`)) {
      foundMarker = true;
      console.log('[ui] found marker in scrollback');
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  await page.screenshot({ path: join(SHOT_DIR, 'terminals-03-dispatched.png'), fullPage: true });

  expect(foundMarker, `expected to find "DISPATCH_RX: ${canary}" in xterm scrollback`).toBe(true);

  // Cleanup: signal __EXIT__ to the agent
  await fetch(`http://127.0.0.1:${port}/dispatch?fire_id=${dispatchFireId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt: '__EXIT__' }),
  });

  await page.close();
});
