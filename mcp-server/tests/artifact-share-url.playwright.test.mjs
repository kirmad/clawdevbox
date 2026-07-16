/**
 * artifact-share-url.playwright.test.mjs
 *
 * End-to-end coverage for the share endpoint: boots `clawdevbox start` with
 * `share.enabled = true` and an explicit `share.port`, seeds an artifact +
 * comment via the MAIN port, then asserts that:
 *
 *   1. GET share-port `/artifact/<id>` returns the host page HTML (proves
 *      route is on the allow-list AND delegates to the real handler).
 *   2. GET share-port `/artifact/<id>/session` returns JSON (proves the
 *      session endpoint is allow-listed).
 *   3. GET share-port `/artifact/<id>/manifest` returns the seeded manifest.
 *   4. PUT a comment via the share-port `/api/store/<col>/<id>?artifact=<id>`
 *      returns 204, AND reading back via the MAIN port returns the same
 *      content (proves the two listeners share the on-disk store).
 *   5. GET share-port `/api/sessions` returns 404 NOT_AVAILABLE_ON_SHARE.
 *   6. GET share-port `/mcp` returns 404 NOT_AVAILABLE_ON_SHARE.
 *   7. DELETE share-port `/api/store/<col>/<id>` returns 404
 *      NOT_AVAILABLE_ON_SHARE even though GET/PUT work for the same path.
 *
 * The test does NOT exercise the devtunnel itself — that's covered by
 * artifact-share-tunnel.test.mjs with a mocked CLI. Here we run the share
 * server locally (`tunnel.kind = none`) so the test is hermetic.
 *
 * Uses Playwright's browser only for the host-page assertion; everything
 * else is plain fetch() against the two ports.
 */

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

// Pick ports OUTSIDE every existing playwright test's range.
//   15300-15399 vue-spa
//   15500-15599 inbox-reply / spa-routing
//   15700-15799 artifact-comments-e2e
//   15800-15899 artifact-comments-iframe
//   15900-15999 artifact-comments-send-flow / universal
//   16000-16099 terminals-panel / terminal-resize / vue-spa-screenshots
// Use 16100-16199 for the main port and 16200-16299 for the share port.
function freeMainPort() {
  return 16100 + Math.floor(Math.random() * 100);
}
function freeSharePort() {
  return 16200 + Math.floor(Math.random() * 100);
}

let serverProc;
let tmpRoot;
let projectDir;
let mainPort;
let sharePort;
let token;
let browser;
let context;

const mainUrl = () => `http://127.0.0.1:${mainPort}`;
const shareUrl = () => `http://127.0.0.1:${sharePort}`;

async function waitForHealth(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok && (await r.text()).trim() === 'ok') return;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not become healthy within ${timeoutMs}ms (last err: ${lastErr})`);
}

function seedArtifact(artId, content) {
  const artDir = join(projectDir, 'artifacts', artId);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(join(artDir, 'manifest.json'), JSON.stringify({
    id: artId,
    type: 'markdown',
    title: 'Share E2E',
    workspace_id: 'project',
    created_at: Date.now(),
    updated_at: Date.now(),
    meta: { entry: 'content.md' },
  }, null, 2));
  writeFileSync(join(artDir, 'content.md'), content);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-share-e2e-'));
  projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  mainPort = freeMainPort();
  sharePort = freeSharePort();
  token = 'share-' + Math.random().toString(36).slice(2, 10);

  writeFileSync(
    join(projectDir, '.clawdevbox', 'config.json'),
    JSON.stringify({
      version: 1,
      project_dir: projectDir,
      global_dir: globalDir,
      http: { port: mainPort, host: '127.0.0.1', token },
      share: {
        enabled: true,
        port: sharePort,
        host: '127.0.0.1',
        tunnel: { kind: 'none' },
        allow_dispatch: true,
      },
    }, null, 2),
  );

  serverProc = spawn('npx', ['tsx', cliEntry, 'start'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
      CLAWDEVBOX_PORT: String(mainPort),
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

  // Wait for BOTH listeners to be up. Main goes up first; share goes up
  // ~immediately after but we poll independently to be safe.
  await waitForHealth(mainUrl(), 45_000);
  await waitForHealth(shareUrl(), 15_000);

  browser = await chromium.launch();
  context = await browser.newContext();
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

test('GET share-port /artifact/<id> returns host page HTML', async () => {
  const artId = 'art_share_html_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Hello share\n\nFirst paragraph.\n');

  const page = await context.newPage();
  const resp = await page.goto(`${shareUrl()}/artifact/${artId}`, { waitUntil: 'load' });
  expect(resp.status()).toBe(200);
  const html = await page.content();
  // Must look like the artifact host page (renderer iframe + sidebar gutter)
  // — not the share-server 404.
  expect(html).toMatch(/Share E2E/);
  expect(html).not.toMatch(/NOT_AVAILABLE_ON_SHARE/);
  await page.close();
});

test('GET share-port /artifact/<id>/session returns JSON', async () => {
  const artId = 'art_share_session_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# session test\n');
  const r = await fetch(`${shareUrl()}/artifact/${artId}/session`);
  // Either 200 with a session record OR an artifact-side 404 — but NEVER
  // the share-server 404.
  if (r.status !== 200) {
    const body = await r.json().catch(() => ({}));
    expect(body.error).not.toBe('NOT_AVAILABLE_ON_SHARE');
  } else {
    const body = await r.json();
    expect(body).toBeTruthy();
  }
});

test('GET share-port /artifact/<id>/manifest returns the seeded manifest', async () => {
  const artId = 'art_share_manifest_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# manifest test\n');
  const r = await fetch(`${shareUrl()}/artifact/${artId}/manifest`);
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.id).toBe(artId);
  expect(body.title).toBe('Share E2E');
});

test('PUT comment via share-port persists, readable from main port', async () => {
  const artId = 'art_share_put_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# put test\n');

  const put = await fetch(
    `${shareUrl()}/api/store/share-comments/comment-1?artifact=${artId}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'shared write OK' }),
    },
  );
  expect(put.status).toBe(204);

  // Read back from the MAIN port (different listener, same on-disk store).
  const getMain = await fetch(
    `${mainUrl()}/api/store/share-comments/comment-1?artifact=${artId}`,
  );
  expect(getMain.status).toBe(200);
  const body = await getMain.json();
  expect(body.comment).toBe('shared write OK');
});

test('share-port GET /api/sessions → 404 NOT_AVAILABLE_ON_SHARE', async () => {
  const r = await fetch(`${shareUrl()}/api/sessions`);
  expect(r.status).toBe(404);
  const body = await r.json();
  expect(body.error).toBe('NOT_AVAILABLE_ON_SHARE');
});

test('share-port GET /mcp → 404 NOT_AVAILABLE_ON_SHARE', async () => {
  const r = await fetch(`${shareUrl()}/mcp`);
  expect(r.status).toBe(404);
  const body = await r.json();
  expect(body.error).toBe('NOT_AVAILABLE_ON_SHARE');
});

test('share-port DELETE /api/store/... → 404 NOT_AVAILABLE_ON_SHARE (even when doc exists)', async () => {
  const artId = 'art_share_del_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# del test\n');
  // PUT first so the doc exists at the store level.
  await fetch(
    `${shareUrl()}/api/store/share-comments/to-delete?artifact=${artId}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'about to die' }),
    },
  );
  const r = await fetch(
    `${shareUrl()}/api/store/share-comments/to-delete?artifact=${artId}`,
    { method: 'DELETE' },
  );
  expect(r.status).toBe(404);
  const body = await r.json();
  expect(body.error).toBe('NOT_AVAILABLE_ON_SHARE');

  // And confirm the doc still exists when accessed via either port (the
  // DELETE was rejected before reaching the store).
  const stillThere = await fetch(
    `${mainUrl()}/api/store/share-comments/to-delete?artifact=${artId}`,
  );
  expect(stillThere.status).toBe(200);
});

test('main-port still works (no regression)', async () => {
  const r = await fetch(`${mainUrl()}/healthz`);
  expect(r.status).toBe(200);
  expect((await r.text()).trim()).toBe('ok');
});
