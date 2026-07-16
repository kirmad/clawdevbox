// artifact-comments-send-flow.playwright.test.mjs
//
// Coverage for the iframe-direct Send flow. The overlay no longer hands
// off to a parent SPA via postMessage — sendAll() talks to the server
// directly: GET /api/sessions?status=active → pick a live session in the
// artifact's workspace → POST /dispatch with the markdown bundle. That
// means the standalone /artifact/<id> page works exactly like the
// SPA-embedded one, which is the user's explicit requirement.
//
// Harness strategy: drive the standalone /artifact/<id> page (which
// embeds the renderer + overlay) and intercept /api/sessions + /dispatch
// via page.route() so we don't need a real agent pty running. Each test
// asserts the request body the overlay produces and how it reacts to
// success / failure responses.

import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const cliEntry = resolve(projectRoot, 'src/index.ts');

// Use a port band distinct from sibling Playwright tests so a runaway
// server from another file can't collide:
//   15300-15399 vue-spa, 15500-15599 inbox-reply/spa-routing,
//   15700-15799 artifact-comments-e2e, 15800-15899 (this file).
function freePortGuess() {
  return 15800 + Math.floor(Math.random() * 100);
}

let serverProc;
let tmpRoot;
let projectDir;
let port;
let token;
let browser;
let context;

async function waitForHealth(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok && (await r.text()).trim() === 'ok') return;
    } catch { /* not yet listening */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy within ' + timeoutMs + 'ms');
}

function seedArtifact(artId, content, workspaceId = 'project') {
  const artDir = join(projectDir, 'artifacts', artId);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(join(artDir, 'manifest.json'), JSON.stringify({
    id: artId,
    type: 'markdown',
    title: 'Send-Flow Test',
    workspace_id: workspaceId,
    created_at: Date.now(),
    updated_at: Date.now(),
    meta: { entry: 'content.md' },
  }, null, 2));
  writeFileSync(join(artDir, 'content.md'), content);
}

async function seedDraft(artId, draft) {
  return seedDrafts(artId, [draft]);
}

async function seedDrafts(artId, drafts) {
  const body = {
    schema_version: 1,
    artifact_id: artId,
    updated_at: new Date().toISOString(),
    drafts,
  };
  const res = await fetch(
    `http://127.0.0.1:${port}/api/store/artifact-comments/${artId}?artifact=${encodeURIComponent(artId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (res.status !== 204) {
    throw new Error(`seedDrafts PUT → ${res.status} ${await res.text().catch(() => '')}`);
  }
}

/**
 * Install request interception on the given page.
 *   - GET /artifact/<id>/session → returns `sessionResponse`. Defaults to a
 *                                  live instance match so existing tests
 *                                  exercise the /dispatch path.
 *   - GET /api/sessions(?status=active) → returns `sessions` (legacy fallback).
 *   - POST /dispatch                    → records the request body in
 *                                         `page.__dispatchCalls` and returns
 *                                         `dispatchStatus` (default 200 ok).
 *   - POST /spawn                       → records the request body in
 *                                         `page.__spawnCalls` and returns 200.
 *
 * Routes are installed BEFORE page.goto() so the overlay's very first
 * sendAll() call hits them. Uses `**` matchers so the interception doesn't
 * miss the absolute-URL form Playwright sometimes presents.
 */
async function mockServerEndpoints(page, {
  sessions = [],
  sessionResponse = { session_id: null, workspace_id: 'project', live_instance_id: 'fake_inst_1' },
  dispatchStatus = 200,
  dispatchBody = '{"ok":true}',
} = {}) {
  const dispatchCalls = [];
  const spawnCalls = [];
  page.__dispatchCalls = dispatchCalls;
  page.__spawnCalls = spawnCalls;

  await page.route('**/artifact/*/session', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sessionResponse),
    });
  });

  await page.route('**/api/sessions**', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: sessions }),
    });
  });

  await page.route('**/dispatch', (route) => {
    const req = route.request();
    let parsed = null;
    try { parsed = JSON.parse(req.postData() ?? '{}'); } catch { parsed = req.postData(); }
    dispatchCalls.push(parsed);
    return route.fulfill({
      status: dispatchStatus,
      contentType: 'application/json',
      body: dispatchBody,
    });
  });

  await page.route('**/spawn', (route) => {
    const req = route.request();
    let parsed = null;
    try { parsed = JSON.parse(req.postData() ?? '{}'); } catch { parsed = req.postData(); }
    spawnCalls.push(parsed);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true,"mode":"spawn","instance_id":"fake_inst_spawn","session_id":"sess_x"}',
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-send-flow-'));
  projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  port = freePortGuess();
  token = 'snd-' + Math.random().toString(36).slice(2, 10);

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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  serverProc.stderr.on('data', (chunk) => {
    const s = chunk.toString();
    if (/error|throw|EADDRINUSE/i.test(s)) process.stderr.write(`[server] ${s}`);
  });

  await waitForHealth(45_000);

  browser = await chromium.launch();
  context = await browser.newContext({ serviceWorkers: 'allow' });
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

// ============================================================================
// Test 1: Send fires a direct POST /dispatch with the correct payload
// ============================================================================
//
// The new contract: sendAll() calls GET /artifact/<id>/session, sees a
// live_instance_id, and POSTs to /dispatch with that instance_id.
// (The default mock returns live_instance_id='fake_inst_1', so we leave
// it default here.)
test('Send fires direct POST /dispatch with correct payload', async () => {
  const artId = 'art_snd_dispatch_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Plans\n\nShip the rocket on Tuesday.\n');
  await seedDraft(artId, {
    id: 'c_dispatch_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: 'Plans', text: 'Tuesday', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'Wednesday is better.',
  });

  const page = await context.newPage();
  await mockServerEndpoints(page);
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  const sendBtn = page.locator('.cdb-sidebar .send');
  await expect(sendBtn).toBeEnabled();
  await expect(sendBtn).toContainText('Send (1)');

  await sendBtn.click();
  // Wait for the route handler to record the dispatch call.
  await expect.poll(
    async () => page.__dispatchCalls.length,
    { timeout: 5_000 },
  ).toBe(1);

  const body = page.__dispatchCalls[0];
  expect(body.instance_id).toBe('fake_inst_1');
  expect(typeof body.prompt).toBe('string');
  expect(body.prompt).toContain('Wednesday is better.');

  await page.close();
});

// ============================================================================
// Test 2: Successful send marks the draft sent and persists across reload
// ============================================================================
test('Send marks drafts as sent and persistence survives reload', async () => {
  const artId = 'art_snd_mark_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Goals\n\nThirty percent growth.\n');
  await seedDraft(artId, {
    id: 'c_mark_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: 'Goals', text: 'Thirty', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'Audacious but reachable.',
  });

  const page = await context.newPage();
  await mockServerEndpoints(page, {
    sessionResponse: {
      session_id: null,
      workspace_id: 'project',
      live_instance_id: 'fake_inst_2',
    },
  });
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  await page.locator('.cdb-sidebar .send').click();
  await expect(page.locator('.cdb-card.cdb-sent')).toHaveCount(1, { timeout: 5_000 });
  await expect(page.locator('.cdb-card.cdb-sent .sent-meta')).toContainText('Sent');

  // Reload — sent state survives because persist() writes through /api/store.
  // Re-install the mocks for the reloaded page (page.route survives reloads,
  // but we re-install to be explicit).
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });
  await expect(page.locator('.cdb-card.cdb-sent')).toHaveCount(1);
  await expect(page.locator('.cdb-sidebar .send')).toContainText('Send (0)');

  await page.close();
});

// ============================================================================
// Test 3: No live session in workspace → alert + drafts NOT marked sent
// ============================================================================
test('no live session in workspace alerts cleanly and leaves drafts unsent', async () => {
  const artId = 'art_snd_nosess_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Risks\n\nDelivery slip possible.\n');
  await seedDraft(artId, {
    id: 'c_nosess_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: 'Risks', text: 'Delivery', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'Mitigation plan needed.',
  });

  const page = await context.newPage();
  // Capture and auto-accept the alert before clicking Send.
  const alerts = [];
  page.on('dialog', (d) => {
    alerts.push(d.message());
    return d.accept();
  });
  // /session returns no live instance and no session_id; /api/sessions
  // returns a different workspace — workspace fallback finds nothing,
  // so the overlay should alert and bail without firing dispatch/spawn.
  await mockServerEndpoints(page, {
    sessionResponse: {
      session_id: null,
      workspace_id: 'project',
      live_instance_id: null,
    },
    sessions: [{
      instance_id: 'wrong_ws_inst',
      live: true,
      workspace_id: 'some-other-workspace',
      started_at: Date.now(),
    }],
  });
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  await page.locator('.cdb-sidebar .send').click();
  // Alert should fire within a second — no 8s timeout.
  await expect.poll(() => alerts.length, { timeout: 3_000 }).toBe(1);
  expect(alerts[0]).toMatch(/No agent session for this artifact/);

  // No /dispatch or /spawn call.
  expect(page.__dispatchCalls.length).toBe(0);
  expect(page.__spawnCalls.length).toBe(0);
  // Drafts NOT marked sent.
  await expect(page.locator('.cdb-card.cdb-sent')).toHaveCount(0);
  await expect(page.locator('.cdb-sidebar .send')).toContainText('Send (1)');
  await expect(page.locator('.cdb-sidebar .send')).toBeEnabled();

  await page.close();
});

// ============================================================================
// Test 4: Second Send only ships the new unsent draft
// ============================================================================
test('second Send only includes new unsent drafts, not previously-sent ones', async () => {
  const artId = 'art_snd_partial_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Risks\n\nDelivery slip is possible.\n');
  await seedDrafts(artId, [{
    id: 'c_old_sent',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    sent: true,
    sent_at: new Date(Date.now() - 60_000).toISOString(),
    anchor: { kind: 'text', section: 'Risks', text: 'slip', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'Old feedback already shipped.',
  }, {
    id: 'c_new_unsent',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: 'Risks', text: 'Delivery', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'New feedback to ship now.',
  }]);

  const page = await context.newPage();
  await mockServerEndpoints(page, {
    sessionResponse: {
      session_id: null,
      workspace_id: 'project',
      live_instance_id: 'fake_inst_partial',
    },
  });
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  await expect(page.locator('.cdb-card')).toHaveCount(2);
  await expect(page.locator('.cdb-card.cdb-sent')).toHaveCount(1);
  await expect(page.locator('.cdb-sidebar .send')).toContainText('Send (1)');

  await page.locator('.cdb-sidebar .send').click();
  await expect.poll(() => page.__dispatchCalls.length, { timeout: 5_000 }).toBe(1);

  const body = page.__dispatchCalls[0];
  expect(body.instance_id).toBe('fake_inst_partial');
  expect(body.prompt).toContain('New feedback to ship now.');
  expect(body.prompt).not.toContain('Old feedback already shipped.');

  await page.close();
});

// ============================================================================
// Test 5: All-sent disables Send button and shows count 0
// ============================================================================
test('Send button disabled and shows count 0 when every draft is sent', async () => {
  const artId = 'art_snd_alldone_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Done\n\nAll handled already.\n');
  await seedDraft(artId, {
    id: 'c_already_sent',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    sent: true,
    sent_at: new Date(Date.now() - 60_000).toISOString(),
    anchor: { kind: 'text', section: 'Done', text: 'All', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'Closed.',
  });

  const page = await context.newPage();
  // No need to mock — Send is disabled, so the routes never get hit.
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  const sendBtn = page.locator('.cdb-sidebar .send');
  await expect(sendBtn).toContainText('Send (0)');
  await expect(sendBtn).toBeDisabled();

  await page.close();
});

// ============================================================================
// Test 6: Standalone /artifact/<id> page works without any SPA parent
// ============================================================================
//
// This is the user's explicit requirement: "we want this to work with
// standalone artifact page too". The standalone host page has NO Vue/SPA
// listener mounted — the entire Send flow lives inside the iframe. This
// test proves that loading /artifact/<id> directly and clicking Send
// produces a /dispatch call to the server, with no postMessage hop.
test('standalone /artifact/<id> page Sends directly without a SPA parent', async () => {
  const artId = 'art_snd_standalone_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Standalone\n\nNo SPA parent here.\n');
  await seedDraft(artId, {
    id: 'c_standalone_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: 'Standalone', text: 'parent', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'Proves standalone path.',
  });

  const page = await context.newPage();
  await mockServerEndpoints(page, {
    sessionResponse: {
      session_id: null,
      workspace_id: 'project',
      live_instance_id: 'fake_inst_standalone',
    },
  });
  // The standalone host page — NOT inside the SPA shell. window.parent ===
  // window at the top level, so any postMessage-based design would have
  // nowhere to route. The iframe-direct design works regardless.
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  // Sanity: no Vue app, no useArtifactCommentsHost listener anywhere.
  const hasVueApp = await page.evaluate(() =>
    Boolean(document.querySelector('#app')) || Boolean(window.__VUE__),
  );
  expect(hasVueApp).toBe(false);

  await page.locator('.cdb-sidebar .send').click();
  await expect.poll(() => page.__dispatchCalls.length, { timeout: 5_000 }).toBe(1);

  const body = page.__dispatchCalls[0];
  expect(body.instance_id).toBe('fake_inst_standalone');
  expect(body.prompt).toContain('Proves standalone path.');

  // And the mark-sent contract holds on the standalone page just as in the
  // SPA-embedded case.
  await expect(page.locator('.cdb-card.cdb-sent')).toHaveCount(1, { timeout: 5_000 });

  await page.close();
});
