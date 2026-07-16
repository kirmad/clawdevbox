// artifact-comments-universal.playwright.test.mjs
//
// Validates the universal-comments contract introduced when comment
// overlay wiring moved into the artifact host page:
//
//   1. Every renderer (HTML, markdown, plugin, workspace) automatically
//      gets the .cdb-sidebar overlay — no per-renderer import required.
//   2. Renderers can opt out by exporting `comments: false` (walkthrough,
//      pr-review).
//   3. Send routing uses GET /artifact/<id>/session as the first hop:
//      - { live_instance_id } present → POST /dispatch
//      - { session_id } only          → POST /spawn (smart-routed by
//                                       the server to dispatch/resume/spawn)
//
// Harness mirrors artifact-comments-send-flow.playwright.test.mjs:
// spawns `clawdevbox start` and drives the standalone /artifact/<id>
// page. Uses port band 15900-15999 to avoid colliding with sibling
// tests (15700 e2e, 15800 send-flow, 15500 inbox/spa, 15300 vue-spa).

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

function freePortGuess() {
  return 15900 + Math.floor(Math.random() * 100);
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

/**
 * Seed an artifact on disk. `type` switches the renderer; `files` is a
 * map of filename → string contents that will be written alongside
 * manifest.json. Manifest.meta can be extended for renderers that read
 * meta.entry (markdown/html).
 */
function seedArtifact(artId, type, files, manifestExtra = {}) {
  const artDir = join(projectDir, 'artifacts', artId);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(join(artDir, 'manifest.json'), JSON.stringify({
    id: artId,
    type,
    title: 'Universal Test ' + type,
    workspace_id: 'project',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...manifestExtra,
  }, null, 2));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(artDir, name), content);
  }
}

async function seedDraft(artId, draft) {
  const body = {
    schema_version: 1,
    artifact_id: artId,
    updated_at: new Date().toISOString(),
    drafts: [draft],
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
    throw new Error(`seedDraft PUT → ${res.status} ${await res.text().catch(() => '')}`);
  }
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-universal-'));
  projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  port = freePortGuess();
  token = 'uni-' + Math.random().toString(36).slice(2, 10);

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
// Test 1: HTML artifact auto-gets the comments sidebar
// ============================================================================
//
// The user's verbatim ask: "I created an artifact for html, comments are not
// available there. […] I want to see comments available for HTML artifacts
// too." Before this change, html.mjs called enableComments itself. Now the
// host page does it, and html.mjs no longer needs to. Either way, the
// outcome the user can see is identical: .cdb-sidebar mounts.
test('HTML artifact gets the comments sidebar automatically', async () => {
  const artId = 'art-html-' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, 'html', {
    'content.html': '<h1>Hello HTML</h1><p>This artifact should have comments.</p>',
  }, { meta: { entry: 'content.html' } });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 10_000 });
  // Renderer's own content rendered alongside the overlay.
  await expect(page.locator('.html-body h1')).toContainText('Hello HTML');
  await page.close();
});

// ============================================================================
// Test 2: Markdown still works after stripping the explicit enableComments
// ============================================================================
test('markdown artifact gets the sidebar via host page wiring', async () => {
  const artId = 'art-md-' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, 'markdown', {
    'content.md': '# Hello\n\nMarkdown test.\n',
  }, { meta: { entry: 'content.md' } });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 10_000 });
  await expect(page.locator('.markdown-body h1')).toContainText('Hello');
  await page.close();
});

// ============================================================================
// Test 3: walkthrough opts out — no sidebar mounts
// ============================================================================
//
// walkthrough.mjs has its own draggable .wt-overlay; the universal comment
// sidebar would fight for the same real-estate. With comments: false it
// must NOT auto-mount.
test('walkthrough artifact opts out of the universal comments overlay', async () => {
  const artId = 'art-wt-' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, 'walkthrough', {
    'walkthrough.json': JSON.stringify({
      title: 'Empty WT',
      steps: [],
    }),
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  // Wait for the walkthrough renderer to mount, then assert NO sidebar.
  // walkthrough.mjs always renders .wt-overlay; we use that as the "page
  // is fully rendered" signal so the assertion isn't racing the renderer.
  await page.waitForSelector('.wt-overlay', { timeout: 10_000 });
  // Give the host page's overlay-import step time to run (it would mount
  // here if comments: false weren't honored).
  await page.waitForTimeout(1_500);
  await expect(page.locator('.cdb-sidebar')).toHaveCount(0);
  await page.close();
});

// ============================================================================
// Test 4: pr-review opts out — no sidebar mounts
// ============================================================================
test('pr-review artifact opts out of the universal comments overlay', async () => {
  const artId = 'art-pr-' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, 'pr-review', {
    'review.json': JSON.stringify({
      files: [],
      comments: [],
    }),
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  // pr-review always renders some .file-tree-style structure; we just
  // wait for the page to finish booting and assert no sidebar.
  await page.waitForLoadState('networkidle', { timeout: 10_000 });
  await page.waitForTimeout(1_500);
  await expect(page.locator('.cdb-sidebar')).toHaveCount(0);
  await page.close();
});

// ============================================================================
// Test 5: Send uses /dispatch when /artifact/<id>/session reports a live instance
// ============================================================================
//
// This is the "agent is still alive" path. The server-side /session
// endpoint hands back live_instance_id, so the overlay skips its
// workspace search and goes straight to POST /dispatch with that
// instance_id. Proves the new session-memory contract for the happy
// path where the agent that produced the artifact is still running.
test('Send routes to /dispatch with live_instance_id from /session', async () => {
  const artId = 'art-send-live-' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, 'html', {
    'content.html': '<p>Live agent path.</p>',
  }, { meta: { entry: 'content.html' } });
  await seedDraft(artId, {
    id: 'c_live_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: '', text: 'Live', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'Looks great — keep it.',
  });

  const page = await context.newPage();
  const dispatchCalls = [];
  const spawnCalls = [];

  // Mock /artifact/<id>/session BEFORE the page loads so the overlay's
  // first sendAll() call hits our mock, not the real (empty) DB.
  await page.route('**/artifact/*/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      session_id: 'sess_live',
      workspace_id: 'project',
      live_instance_id: 'inst_live_xyz',
    }),
  }));
  await page.route('**/dispatch', (route) => {
    try { dispatchCalls.push(JSON.parse(route.request().postData() ?? '{}')); }
    catch { dispatchCalls.push(route.request().postData()); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/spawn', (route) => {
    try { spawnCalls.push(JSON.parse(route.request().postData() ?? '{}')); }
    catch { spawnCalls.push(route.request().postData()); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });
  await page.locator('.cdb-sidebar .send').click();

  await expect.poll(() => dispatchCalls.length, { timeout: 5_000 }).toBe(1);
  expect(spawnCalls.length).toBe(0);
  expect(dispatchCalls[0].instance_id).toBe('inst_live_xyz');
  expect(dispatchCalls[0].prompt).toContain('keep it');
  await page.close();
});

// ============================================================================
// Test 6: Send uses /spawn when /session has session_id but no live instance
// ============================================================================
//
// The "agent has exited but is resumable" path. /session returns the
// remembered session_id with live_instance_id = null. The overlay must
// fall through to POST /spawn { session_id, prompt, workspace_id } so
// the server's smart-routing can decide between dispatch/resume/spawn.
// This is the user's other explicit ask: "I should be able to send
// comments even when I use the artifact URL: [...] you may need to
// remember the session id associated with the artifact".
test('Send routes to /spawn with session_id when no live instance', async () => {
  const artId = 'art-send-spawn-' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, 'html', {
    'content.html': '<p>Resumable agent path.</p>',
  }, { meta: { entry: 'content.html' } });
  await seedDraft(artId, {
    id: 'c_spawn_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: '', text: 'Resumable', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'Please re-check this section.',
  });

  const page = await context.newPage();
  const dispatchCalls = [];
  const spawnCalls = [];

  await page.route('**/artifact/*/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      session_id: 'sess_resumable_abc',
      workspace_id: 'project',
      live_instance_id: null,
    }),
  }));
  await page.route('**/dispatch', (route) => {
    try { dispatchCalls.push(JSON.parse(route.request().postData() ?? '{}')); }
    catch { dispatchCalls.push(route.request().postData()); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/spawn', (route) => {
    try { spawnCalls.push(JSON.parse(route.request().postData() ?? '{}')); }
    catch { spawnCalls.push(route.request().postData()); }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, mode: 'spawn', instance_id: 'new_inst', session_id: 'sess_resumable_abc' }),
    });
  });

  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });
  await page.locator('.cdb-sidebar .send').click();

  await expect.poll(() => spawnCalls.length, { timeout: 5_000 }).toBe(1);
  expect(dispatchCalls.length).toBe(0);
  expect(spawnCalls[0].session_id).toBe('sess_resumable_abc');
  expect(spawnCalls[0].workspace_id).toBe('project');
  expect(spawnCalls[0].prompt).toContain('re-check this section');
  await page.close();
});
