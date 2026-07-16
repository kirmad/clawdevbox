// real-copilot-smoke.mjs — spawn a REAL interactive copilot.exe via the
// /spawn endpoint, drive it via /dispatch, validate the output appears
// in the live SPA's xterm. NOT the e2e-test-runner stub — the actual
// GitHub Copilot CLI binary on PATH.

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.CLAWDEVBOX_URL ?? 'http://127.0.0.1:5201';
const SHOT_DIR = resolve(process.cwd(), 'verify-screenshots');
mkdirSync(SHOT_DIR, { recursive: true });
const projectDir = process.env.CLAWDEVBOX_PROJECT_DIR ?? 'C:\\git\\clawdevbox\\mcp-server';
const PROVIDER = process.env.CLAWDEVBOX_PROVIDER ?? 'copilot';

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
  const file = resolve(SHOT_DIR, `copilot-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const size = existsSync(file) ? statSync(file).size : 0;
  console.log(`📸 ${name}: ${file} (${size} bytes)`);
  return file;
}

async function readXtermScreen(page) {
  return page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows');
    return rows ? rows.textContent : '';
  });
}

async function main() {
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(`server not healthy at ${BASE}: ${health.status}`);
  console.log(`✅ live server up at ${BASE}, provider=${PROVIDER}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.warn('[pageerror]', err.message));

  let spawnInstanceId = null;
  let dispatchFireId = null;
  let dispatchSecret = null;

  try {
    // ---- 1. Open SPA + Terminals tab
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('tab', { name: /Terminals/i }).click();
    await page.waitForTimeout(800);
    await shoot(page, '01-initial');
    console.log('✅ Terminals tab open');

    // ---- 2. Spawn real copilot.exe via /spawn
    const rec1 = await postJson('/api/test/record-active-run', {
      fire_id: `fire_copilot_${Date.now().toString(36)}`,
      secret: 'sec_cp_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x'),
      workspace_path: projectDir,
      provider_id: PROVIDER,
    });
    if (rec1.status !== 200) throw new Error(`record-active-run failed: ${rec1.status} ${rec1.raw}`);
    const { fire_id: spawnFireId, secret: spawnSecret } = rec1.body;

    const canary = 'COPILOT_HELLO_' + Math.random().toString(36).slice(2, 8).toUpperCase();
    console.log(`📤 POST /spawn with provider=${PROVIDER}, canary=${canary}`);
    const spawnRes = await postJson(`/spawn/${spawnFireId}`, {
      prompt: `Reply with only: ${canary}`,
    }, { Authorization: `Bearer ${spawnSecret}` });
    if (spawnRes.status !== 200) throw new Error(`/spawn failed: ${spawnRes.status} ${spawnRes.raw}`);
    spawnInstanceId = spawnRes.body.instance_id;
    console.log(`✅ /spawn returned instance_id=${spawnInstanceId}`);

    // ---- 3. Wait for the new tab + click it
    const shortId = spawnInstanceId.slice(-8);
    const tabLabel = `Spawn ${shortId}`;
    const tabLocator = page.getByText(tabLabel, { exact: true });
    await tabLocator.waitFor({ state: 'visible', timeout: 30_000 });
    await tabLocator.click();
    console.log(`✅ UI shows + selected tab "${tabLabel}"`);
    await page.waitForTimeout(1500);
    await shoot(page, '02-spawned');

    // ---- 4. Wait for conductor idle (real copilot cold start)
    console.log(`⏳ waiting for conductor idle (real copilot needs ~20-30s cold start)...`);
    let ready = false;
    let lastState = null;
    for (let i = 0; i < 240; i++) { // 120s max
      const list = await fetchJson('/api/sessions?status=active&limit=50');
      const row = list.body?.items?.find((it) => it.instance_id === spawnInstanceId);
      lastState = row;
      if (row && row.live && (row.state === 'idle' || row.state === 'busy')) { ready = true; break; }
      if (!row || !row.live) {
        console.warn(`  pty exited (live=${row?.live}, state=${row?.state})`);
        break;
      }
      if (i % 10 === 0) console.log(`  [${i*500}ms] state=${row?.state ?? '?'}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) {
      const screen = await readXtermScreen(page);
      console.error('xterm tail (last 2000):', screen.slice(-2000));
      throw new Error(`copilot pty never reached idle. last row: ${JSON.stringify(lastState)}`);
    }
    console.log(`✅ conductor reached non-starting state — copilot REPL ready`);

    // ---- 5. Wait for initial seed prompt's canary to appear in xterm
    let foundInitial = false;
    for (let i = 0; i < 60; i++) {
      const screen = await readXtermScreen(page);
      if (screen && screen.includes(canary)) { foundInitial = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (foundInitial) {
      console.log(`✅ initial canary "${canary}" appeared — proves seed prompt reached the LLM`);
    } else {
      console.warn(`⚠️  initial canary "${canary}" NOT found in xterm (LLM may have refused). Continuing.`);
    }
    await shoot(page, '03-initial-canary');

    // ---- 6. Dispatch a follow-up prompt via HTTP
    const rec2 = await postJson('/api/test/record-active-run', {
      fire_id: `fire_dispatch_${Date.now().toString(36)}`,
      secret: 'sec_disp_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x'),
      workspace_path: projectDir,
      provider_id: PROVIDER,
      dispatch_target_instance_id: spawnInstanceId,
    });
    dispatchFireId = rec2.body.fire_id;
    dispatchSecret = rec2.body.secret;

    const canary2 = 'COPILOT_DISPATCH_' + Math.random().toString(36).slice(2, 8).toUpperCase();
    console.log(`📤 POST /dispatch with canary=${canary2}`);
    const dispRes = await postJson(`/dispatch/${dispatchFireId}`, {
      prompt: `Reply with only: ${canary2}`,
    }, { Authorization: `Bearer ${dispatchSecret}` });
    if (dispRes.status !== 200) throw new Error(`/dispatch failed: ${dispRes.status} ${dispRes.raw}`);
    console.log(`✅ /dispatch accepted — conductor state=${dispRes.body.state}`);

    // ---- 7. Wait for dispatch canary in xterm
    let foundDispatch = false;
    for (let i = 0; i < 60; i++) {
      const screen = await readXtermScreen(page);
      if (screen && screen.includes(canary2)) { foundDispatch = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await shoot(page, '04-dispatched');

    if (!foundDispatch) {
      const screen = await readXtermScreen(page);
      console.error('xterm tail (last 2000):', screen.slice(-2000));
      throw new Error(`dispatch canary "${canary2}" never appeared in xterm`);
    }
    console.log(`✅ dispatch canary "${canary2}" arrived in xterm — full chain validated`);

    // ---- 8. Clean exit
    await postJson(`/dispatch/${dispatchFireId}`, { prompt: '/exit' },
      { Authorization: `Bearer ${dispatchSecret}` }).catch(() => {});
    await page.waitForTimeout(2000);
    await shoot(page, '05-exited');

    console.log('\n🎉 REAL COPILOT END-TO-END PASSED');
    process.exit(0);
  } catch (err) {
    console.error('❌ FAIL:', err.message);
    try { await shoot(page, '99-failure'); } catch {}
    if (dispatchFireId && dispatchSecret) {
      await postJson(`/dispatch/${dispatchFireId}`, { prompt: '/exit' },
        { Authorization: `Bearer ${dispatchSecret}` }).catch(() => {});
    }
    process.exit(1);
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
