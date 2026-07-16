// artifact-comments-e2e.playwright.test.mjs
//
// End-to-end coverage for the artifact-commenting integration layer:
//   - text drafts seeded via /api/store/artifact-comments re-anchor on load
//     (Task 5 load-from-store + Task 6 re-anchor contract)
//   - drafts survive iframe re-mount across multiple reloads
//   - orphan flag surfaces when the stored anchor text is no longer in the DOM
//   - Send button enables and shows the correct draft count
//
// Scope note: image-anchored comments (<img>/mermaid clicks) and Alt+drag
// region screenshots are NOT covered here. They depend on html2canvas /
// canvas.toBlob behavior in headless Chromium that's unreliable enough
// to make the tests flaky. Their unit-level contract is exercised by the
// spike (spikes/artifact-comments/) and by the defensive error handling
// added to Task 7's capture paths.
//
// Mirrors the harness pattern from vue-spa.playwright.test.mjs:
//   - spawns `clawdevbox start` subprocess against a temp project
//   - launches headless Chromium
//   - drives the standalone /artifact/<id> host page (which mounts the
//     markdown renderer + comment overlay)

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

// Pick an ephemeral port outside the ranges used by sibling playwright
// tests (15300-15399 vue-spa, 15500-15599 inbox-reply/spa-routing/terminals-panel-e2e)
// so a runaway server from a previous run can't collide with us.
function freePortGuess() {
  return 15700 + Math.floor(Math.random() * 100);
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
 * Seed an on-disk artifact under <projectDir>/artifacts/<id>/. The project
 * dir is treated as workspace `project` by findArtifact() in
 * terminal-server.ts, so the artifact is discoverable without any extra
 * registration. Mirrors writeArtifact() in vue-spa-screenshots test.
 */
function seedArtifact(artId, content) {
  const artDir = join(projectDir, 'artifacts', artId);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(join(artDir, 'manifest.json'), JSON.stringify({
    id: artId,
    type: 'markdown',
    title: 'E2E Test',
    workspace_id: 'project',
    created_at: Date.now(),
    updated_at: Date.now(),
    meta: { entry: 'content.md' },
  }, null, 2));
  writeFileSync(join(artDir, 'content.md'), content);
}

/** PUT a drafts document directly to the store so we can assert
 *  re-anchor behavior on the next iframe load. */
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
  // tsx subprocess boot can stretch past Playwright's 30 s default on loaded
  // CI runners; waitForHealth alone polls 45 s. Match the pattern used by
  // sibling tests (inbox-reply, inbox-mobile-overflow, terminal-resize-after-panel).
  test.setTimeout(120_000);
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-cmt-e2e-'));
  projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  port = freePortGuess();
  token = 'cmt-' + Math.random().toString(36).slice(2, 10);

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
// Test 1: Stored text draft re-anchors on load
// ============================================================================
//
// Seeds a draft via /api/store and reloads the artifact page. The overlay's
// loadDrafts() + renderHighlights() chain should locate "30% YoY growth"
// inside the "Goals" section, wrap it in a .cdb-comment-anchor span, and
// surface a card in the sidebar.
test('stored text draft re-anchors into the artifact body', async () => {
  const artId = 'art_e2e_text_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Goals\n\nDrive 30% YoY growth in active users.\n');

  await seedDraft(artId, {
    id: 'c_test_e2e',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: {
      kind: 'text',
      section: 'Goals',
      text: '30% YoY growth',
      fingerprint: 'sha1:dummy',
      occurrence: 0,
    },
    comment: 'Needs a baseline number.',
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });

  // Sidebar appears once enableComments() finishes; the markdown renderer
  // pulls marked/hljs/mermaid from esm.sh first, so give it room.
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  // The text in the body is wrapped by re-anchor.
  await expect(page.locator('.cdb-comment-anchor')).toContainText('30% YoY growth', { timeout: 5_000 });

  // The sidebar shows 1 card.
  await expect(page.locator('.cdb-sidebar header .grow')).toContainText('Comments (1)');
  await expect(page.locator('.cdb-card')).toHaveCount(1);

  await page.close();
});

// ============================================================================
// Test 2: Drafts persist across iframe re-mount (two reloads)
// ============================================================================
test('drafts persist across iframe reload', async () => {
  const artId = 'art_e2e_persist_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Section A\n\nHello world.\n');

  await seedDraft(artId, {
    id: 'c_persist_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: 'Section A', text: 'Hello', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'note',
  });

  const page = await context.newPage();

  // First load — overlay surfaces the draft.
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });
  await expect(page.locator('.cdb-sidebar header .grow')).toContainText('Comments (1)');
  await expect(page.locator('.cdb-comment-anchor')).toContainText('Hello');

  // Second load (re-mount) — draft still there, still re-anchored.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });
  await expect(page.locator('.cdb-sidebar header .grow')).toContainText('Comments (1)');
  await expect(page.locator('.cdb-comment-anchor')).toContainText('Hello');

  await page.close();
});

// ============================================================================
// Test 3: Orphan flag when stored text no longer matches DOM
// ============================================================================
test('orphan draft surfaces when stored text is missing from DOM', async () => {
  const artId = 'art_e2e_orphan_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Section A\n\nCompletely different content.\n');

  await seedDraft(artId, {
    id: 'c_orphan_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: 'Section A', text: 'NOT IN THE DOM', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'orphan test',
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  // Card shows up flagged as orphan.
  await expect(page.locator('.cdb-sidebar header .grow')).toContainText('Comments (1)');
  await expect(page.locator('.cdb-card.cdb-orphan')).toBeVisible();
  await expect(page.locator('.cdb-card.cdb-orphan .orphan-badge')).toBeVisible();
  // No highlight is applied to the artifact body (the text isn't there).
  expect(await page.locator('.cdb-comment-anchor').count()).toBe(0);

  await page.close();
});

// ============================================================================
// Test 4: Send button enables with draft count
// ============================================================================
//
// Proves the persistence + UI contract:
//   - stored draft loads
//   - sidebar Send button transitions from disabled "Send (0)" to enabled
//     "Send (1)" once the draft is loaded
//
// The full postMessage → /dispatch hand-off is exercised by manual smoke
// (it needs a live agent session, which a headless harness can't reasonably
// provide). The integration-side contract (handleSendComments → fetchSessions
// → ack) is covered by JSDOM unit tests in tests/comment-overlay.test.mjs.
test('send button enables with the loaded draft count', async () => {
  const artId = 'art_e2e_send_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, '# Goals\n\nDrive 30% YoY growth.\n');

  await seedDraft(artId, {
    id: 'c_send_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: { kind: 'text', section: 'Goals', text: '30% YoY growth', fingerprint: 'sha1:x', occurrence: 0 },
    comment: 'review me',
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  await page.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  const sendBtn = page.locator('.cdb-sidebar header .send');
  await expect(sendBtn).toBeEnabled();
  await expect(sendBtn).toContainText('Send (1)');

  await page.close();
});
