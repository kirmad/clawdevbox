// real-server-smoke.mjs — drive a REAL Chromium against the live
// clawdevbox at http://127.0.0.1:5201. No test subprocess. The server
// must be running before this script runs (e.g. `clawdevbox start` from
// a shell or as a background service). Screenshots saved under
// `verify-screenshots/live-*.png` so the user can confirm the actual
// running instance reflects the new build.
//
// What this exercises:
//   1. Load the SPA from the live server. Screenshot the initial state
//      (`live-01-initial.png`).
//   2. Click the new "Terminals" tab. Screenshot (`live-02-terminals.png`).
//   3. POST /api/test/record-active-run to inject a fire row + dispatcher
//      activeRuns entry, then POST /spawn/<fire_id> with the per-fire
//      bearer. Wait for the new tab to appear in the UI. Screenshot
//      (`live-03-spawned.png`).
//   4. POST a SECOND record-active-run for the spawned target, then
//      POST /dispatch/<fire_id> with a canary prompt. Wait for the
//      DISPATCH_RX marker in the xterm scrollback. Screenshot
//      (`live-04-dispatched.png`).
//
// Run from C:\git\clawdevbox\mcp-server:
//   node real-server-smoke.mjs
//
// Exits 0 on success, 1 on failure. Prints a short summary.

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.CLAWDEVBOX_URL ?? 'http://127.0.0.1:5201';
const SHOT_DIR = resolve(process.cwd(), 'verify-screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

const projectDir = process.env.CLAWDEVBOX_PROJECT_DIR ?? 'C:\\git\\clawdevbox\\mcp-server';

async function fetchJson(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, init);
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

async function shoot(page, name) {
  const file = resolve(SHOT_DIR, `live-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const size = existsSync(file) ? statSync(file).size : 0;
  console.log(`📸 ${name}: ${file} (${size} bytes)`);
  return file;
}

async function main() {
  // Sanity: live server reachable.
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(`server not healthy at ${BASE}: ${health.status}`);
  console.log(`✅ live server up at ${BASE}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });

  try {
    // ---- 1. Initial load
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(600);
    await shoot(page, '01-initial');

    // ---- 2. Click Terminals tab
    const termTab = page.getByRole('tab', { name: /Terminals/i });
    if (!(await termTab.count())) {
      throw new Error('Terminals tab NOT FOUND in live SPA — server is serving an old bundle');
    }
    await termTab.click();
    await page.waitForTimeout(800);
    await shoot(page, '02-terminals');
    console.log('✅ Terminals tab present and clickable');

    // Confirm vertical tab list rendered with at least the Active group header.
    const activeHeader = page.getByText('Active', { exact: true }).first();
    await activeHeader.waitFor({ state: 'visible', timeout: 5_000 });
    console.log('✅ Active section visible');

    // ---- 3. Spawn a new terminal via /spawn
    const rec1 = await postJson('/api/test/record-active-run', {
      fire_id: `fire_live_spawn_${Date.now().toString(36)}`,
      secret: 'sec_live_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x'),
      workspace_path: projectDir,
      provider_id: 'e2e-test-runner',
    });
    if (rec1.status !== 200) throw new Error(`record-active-run failed: ${rec1.status} ${rec1.raw}`);
    const { fire_id: spawnFireId, secret: spawnSecret } = rec1.body;

    const spawnRes = await postJson(`/spawn/${spawnFireId}`, {
      prompt: 'Reply with only: LIVE_SPAWN_OK',
    }, { Authorization: `Bearer ${spawnSecret}` });
    if (spawnRes.status !== 200) throw new Error(`/spawn failed: ${spawnRes.status} ${spawnRes.raw}`);
    const spawnInstanceId = spawnRes.body.instance_id;
    console.log(`✅ POST /spawn succeeded — instance_id=${spawnInstanceId}`);

    // Wait for the new tab to appear in UI (event-bus 'sessions' topic
    // debounced refresh).
    const shortId = spawnInstanceId.slice(-8);
    const expectedLabel = `Spawn ${shortId}`;
    const tabLocator = page.getByText(expectedLabel, { exact: true });
    await tabLocator.waitFor({ state: 'visible', timeout: 20_000 });
    console.log(`✅ UI shows new tab "${expectedLabel}"`);
    await shoot(page, '03-spawned');

    // ---- 4. Dispatch a follow-up prompt to that pty
    // Wait for the new pty to reach idle (READY_FOR_DISPATCH).
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const list = await fetchJson('/api/sessions?status=all&limit=200');
      const row = list.body?.items?.find((it) => it.instance_id === spawnInstanceId);
      if (row && row.live && (row.state === 'idle' || row.state === 'busy')) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error(`pty ${spawnInstanceId} never reached idle`);
    console.log(`✅ spawned pty reached idle state`);

    const rec2 = await postJson('/api/test/record-active-run', {
      fire_id: `fire_live_dispatch_${Date.now().toString(36)}`,
      secret: 'sec_live_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x'),
      workspace_path: projectDir,
      provider_id: 'e2e-test-runner',
      dispatch_target_instance_id: spawnInstanceId,
    });
    const { fire_id: dispatchFireId, secret: dispatchSecret } = rec2.body;

    const canary = 'LIVE_DISPATCH_HELLO_' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const dispRes = await postJson(`/dispatch/${dispatchFireId}`, { prompt: canary },
      { Authorization: `Bearer ${dispatchSecret}` });
    if (dispRes.status !== 200) throw new Error(`/dispatch failed: ${dispRes.status} ${dispRes.raw}`);
    console.log(`✅ POST /dispatch succeeded — state=${dispRes.body.state}`);

    // Click the spawned tab so its xterm is visible.
    await tabLocator.click();
    await page.waitForTimeout(1500); // xterm attach + snapshot

    // Poll xterm scrollback for the canary.
    let foundMarker = false;
    for (let i = 0; i < 30; i++) {
      const screenText = await page.evaluate(() => {
        const rows = document.querySelector('.xterm-rows');
        return rows ? rows.textContent : '';
      });
      if (screenText && screenText.includes(`DISPATCH_RX: ${canary}`)) {
        foundMarker = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!foundMarker) throw new Error(`canary "${canary}" never appeared in xterm scrollback`);
    console.log(`✅ canary "${canary}" arrived at agent stdin and echoed back via DISPATCH_RX`);
    await shoot(page, '04-dispatched');

    // Cleanup: __EXIT__ the agent
    await postJson(`/dispatch/${dispatchFireId}`, { prompt: '__EXIT__' },
      { Authorization: `Bearer ${dispatchSecret}` }).catch(() => {});

    if (errors.length > 0) {
      console.warn('⚠️  console/page errors during run:');
      for (const e of errors) console.warn('  ', e);
    }

    console.log('\n🎉 ALL LIVE-CLIENT CHECKS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAIL:', err.message);
    try { await shoot(page, '99-failure'); } catch {}
    process.exit(1);
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
