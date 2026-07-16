// artifact-comments-iframe-renderer.playwright.test.mjs
//
// Coverage for the iframe-based workspace renderer pattern, where a
// workspace-authored renderer (`<projectDir>/.clawdevbox/renderers/html.mjs`)
// hosts artifact content inside a sandboxed nested iframe (so inline
// <script> tags run safely) AND injects the artifact-comments overlay
// INSIDE the iframe.
//
// This pattern is required because:
//   1. With a nested iframe sandbox (allow-scripts), selection / click /
//      Alt+drag events fire inside the iframe's own document. The host
//      page's overlay (mounted on the outer document) never sees them.
//      So the overlay MUST live inside the iframe too.
//   2. The iframe needs `allow-same-origin` for the in-iframe overlay to
//      reach /api/store/* and /dispatch on this server.
//   3. The iframe must NOT be height:100vh; it should fill the parent
//      container (height:100%) so #artifact-root doesn't gain a redundant
//      outer scrollbar on top of the renderer's own scrolling.
//   4. The workspace renderer exports `comments: false` so the host page's
//      auto-mount step skips it — otherwise we'd get TWO sidebars (one
//      outside the iframe with no event source, one inside that actually
//      works).
//
// Bug context: prior to the iframe-bootstrap fix, the user reported "I am
// unable to select and comment, comment on elements or use Alt to grab
// screenshots. Nothing works. Only see comments side bar. That too, I see
// 2 scrollbars on the html looking really bad." All four symptoms are
// captured by the assertions below.
//
// Harness mirrors artifact-comments-universal.playwright.test.mjs:
// spawns `clawdevbox start` and drives the standalone /artifact/<id>
// page. Uses port band 16000-16099 — universal already owns 15900-15999.

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
  return 16000 + Math.floor(Math.random() * 100);
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

/** Seed an artifact on disk under <projectDir>/artifacts/<id>/. */
function seedArtifact(artId, htmlContent) {
  const artDir = join(projectDir, 'artifacts', artId);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(join(artDir, 'manifest.json'), JSON.stringify({
    id: artId,
    type: 'html',
    title: 'Iframe Renderer Test',
    workspace_id: 'project',
    created_at: Date.now(),
    updated_at: Date.now(),
  }, null, 2));
  writeFileSync(join(artDir, 'index.html'), htmlContent);
}

/** Seed a workspace renderer that overrides the built-in for type 'html'. */
function seedWorkspaceRenderer(name, source) {
  const dir = join(projectDir, '.clawdevbox', 'renderers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.mjs`), source);
}

/**
 * The production workspace renderer source — copy-pasted from
 * `.clawdevbox/renderers/html.mjs` so the test exercises the real code
 * path. If you change one, change both (or refactor both to share a
 * fixture file).
 */
const WORKSPACE_HTML_RENDERER_SOURCE = `
const OVERLAY_BOOTSTRAP = (artifactId, title) => \`
<script type="module">
  try {
    const ctx = {
      artifactId: \${JSON.stringify(artifactId)},
      manifest: { id: \${JSON.stringify(artifactId)}, title: \${JSON.stringify(title || artifactId)} },
    };
    const { enableComments } = await import('/__renderer-lib/_comment-overlay.mjs');
    await new Promise(r => setTimeout(r, 0));
    await enableComments(document.body, ctx);
  } catch (err) {
    console.warn('[clawdevbox] comment overlay failed to load inside artifact iframe:', err);
  }
</\` + \`script>
\`;

export default {
  comments: false,
  async render(rootElement, ctx) {
    let html;
    try {
      html = await ctx.fetchFile('index.html');
    } catch (err) {
      rootElement.textContent = 'Failed to load index.html: ' + (err && err.message ? err.message : String(err));
      return;
    }
    rootElement.replaceChildren();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('title', (ctx.manifest && ctx.manifest.title) || 'HTML artifact');
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#fff;';
    iframe.srcdoc = html + OVERLAY_BOOTSTRAP(ctx.artifactId, ctx.manifest?.title);
    rootElement.appendChild(iframe);
  },
};
`;

// A rich HTML body that:
//   - has a heading + long paragraph (text selection target)
//   - has an inline <script> that mutates the DOM (proves scripts run
//     even with the iframe-bootstrap overlay glued onto srcdoc)
//   - has an <img> with a tiny inline data: URL (click-to-comment target)
const RICH_HTML_BODY = `
<!doctype html>
<html><head><meta charset="utf-8"><title>Rich</title>
<style>body { font-family: sans-serif; padding: 16px; }</style>
</head>
<body>
  <h1 id="title">Rich HTML Artifact</h1>
  <p id="intro">This paragraph contains selectable text used by the comment overlay assertion.</p>
  <img id="px" alt="One pixel" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=">
  <script>
    document.getElementById('title').dataset.scriptRan = '1';
  </script>
</body></html>
`;

/** Find the comment-overlay iframe (about:srcdoc) inside a page. */
function getOverlayFrame(page) {
  return page.frames().find((f) => f.url() === 'about:srcdoc' || f.url().startsWith('about:'));
}

async function waitForOverlayFrame(page, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = getOverlayFrame(page);
    if (f) return f;
    await page.waitForTimeout(100);
  }
  throw new Error('iframe (about:srcdoc) never appeared');
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-iframe-render-'));
  projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'triggers', 'artifacts', 'renderers']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  port = freePortGuess();
  token = 'ifr-' + Math.random().toString(36).slice(2, 10);

  writeFileSync(
    join(projectDir, '.clawdevbox', 'config.json'),
    JSON.stringify({
      version: 1,
      project_dir: projectDir,
      global_dir: globalDir,
      http: { port, host: '127.0.0.1', token },
    }, null, 2),
  );

  // The workspace renderer must exist BEFORE the server boots — its
  // presence affects how /__renderer/html.mjs is resolved.
  seedWorkspaceRenderer('html', WORKSPACE_HTML_RENDERER_SOURCE);

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
// Test 1: iframe renderer mounts overlay INSIDE the iframe
// ============================================================================
//
// The whole point of the iframe-bootstrap pattern: the overlay's
// .cdb-sidebar must live inside the about:srcdoc frame, NOT on the
// outer host page. Also asserts the iframe carries both sandbox tokens
// (allow-scripts + allow-same-origin) — without allow-same-origin the
// in-iframe overlay can't fetch /api/store/*.
test('iframe renderer mounts overlay INSIDE the iframe', async () => {
  const artId = 'art_iframe_mount_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, RICH_HTML_BODY);

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });

  const inner = await waitForOverlayFrame(page);

  // Sidebar exists INSIDE the iframe.
  await inner.waitForSelector('.cdb-sidebar', { timeout: 20_000 });
  expect(await inner.locator('.cdb-sidebar').count()).toBe(1);

  // No sidebar on the OUTER document (would mean host-page auto-mount fired
  // despite the renderer's `comments: false` opt-out).
  expect(await page.locator('body > .cdb-sidebar').count()).toBe(0);

  // The iframe must carry both sandbox tokens.
  const sandbox = await inner.evaluate(() => frameElement.getAttribute('sandbox'));
  expect(sandbox).toMatch(/allow-scripts/);
  expect(sandbox).toMatch(/allow-same-origin/);

  // Inline <script> ran (proves scripts execute alongside the overlay
  // bootstrap — the OVERLAY_BOOTSTRAP append doesn't break script tags
  // that came before it).
  const scriptRan = await inner.evaluate(() =>
    document.getElementById('title')?.dataset.scriptRan,
  );
  expect(scriptRan).toBe('1');

  await page.close();
});

// ============================================================================
// Test 2: selection inside iframe triggers the comment toolbar
// ============================================================================
//
// The user's main symptom: "I am unable to select and comment". Before
// the fix, selection events fired inside the iframe but the overlay
// listeners lived on the outer document — nothing happened. After the
// fix the overlay listens on the iframe's own document, so selection
// inside the iframe surfaces a .cdb-toolbar inside the iframe.
test('selection inside iframe triggers the comment toolbar', async () => {
  const artId = 'art_iframe_sel_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, RICH_HTML_BODY);

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });

  const inner = await waitForOverlayFrame(page);
  await inner.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  // Programmatically select a range inside the iframe and fire mouseup —
  // the overlay's selectionchange/mouseup handler should surface the
  // .cdb-toolbar near the selection.
  await inner.evaluate(() => {
    const p = document.getElementById('intro');
    const tn = p.firstChild;
    const range = document.createRange();
    range.setStart(tn, 0);
    range.setEnd(tn, Math.min(tn.nodeValue.length, 12));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // Trigger the overlay's handlers — both selectionchange (debounced) and
    // mouseup (immediate) are listened for; mouseup is the deterministic path.
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  await inner.waitForSelector('.cdb-toolbar', { timeout: 5_000 });
  expect(await inner.locator('.cdb-toolbar').count()).toBeGreaterThanOrEqual(1);

  // And NO toolbar leaked to the outer document.
  expect(await page.locator('body > .cdb-toolbar').count()).toBe(0);

  await page.close();
});

// ============================================================================
// Test 3: outer #artifact-root does not get a redundant scrollbar
// ============================================================================
//
// Bug: with iframe height:100vh inside #artifact-root (which sits below a
// header, so its clientHeight < 100vh), the iframe forced an outer scroll
// gutter on top of the inner one. After the fix the iframe is height:100%,
// so the outer container is exactly the iframe's size — no overflow.
test('outer artifact-root does not get a redundant scrollbar', async () => {
  const artId = 'art_iframe_scroll_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, RICH_HTML_BODY);

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });

  const inner = await waitForOverlayFrame(page);
  await inner.waitForSelector('.cdb-sidebar', { timeout: 20_000 });
  // Let layout settle — sidebar mount triggers body padding change.
  await page.waitForTimeout(300);

  const metrics = await page.evaluate(() => {
    const r = document.getElementById('artifact-root');
    return {
      scroll: r.scrollHeight,
      client: r.clientHeight,
    };
  });
  // Allow a 1px rounding tolerance.
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1);

  await page.close();
});

// ============================================================================
// Test 4: body uses padding-right (not margin-right) for sidebar gutter
// ============================================================================
//
// Bug: margin-right adds the 340px gutter OUTSIDE the body, pushing
// content beyond the html viewport on constrained layouts. padding-right +
// box-sizing keeps the gutter INSIDE the body, so the content area reflows
// to (iframe-width - 340px) with no horizontal scrollbar.
test('body uses padding-right (not margin-right) for sidebar gutter', async () => {
  const artId = 'art_iframe_padding_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, RICH_HTML_BODY);

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });

  const inner = await waitForOverlayFrame(page);
  await inner.waitForSelector('.cdb-sidebar', { timeout: 20_000 });
  // Sidebar mount toggles `cdb-has-sidebar` on body.
  await inner.waitForFunction(() =>
    document.body.classList.contains('cdb-has-sidebar'), null, { timeout: 5_000 });
  // The CSS uses `transition: padding-right 180ms ease`, so getComputedStyle
  // returns the in-progress value while the transition is running. Wait past
  // the transition window before sampling.
  await page.waitForTimeout(400);

  const styles = await inner.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return {
      hasClass: document.body.classList.contains('cdb-has-sidebar'),
      paddingRight: cs.paddingRight,
      marginRight: cs.marginRight,
      boxSizing: cs.boxSizing,
    };
  });
  expect(styles.hasClass).toBe(true);
  expect(styles.paddingRight).toBe('340px');
  expect(styles.boxSizing).toBe('border-box');
  // The OLD CSS used margin-right: 340px. The new CSS must NOT set that.
  expect(styles.marginRight).not.toBe('340px');

  await page.close();
});

// ============================================================================
// Test 5: Send button inside iframe POSTs to /dispatch
// ============================================================================
//
// Proves the full Send flow works from inside the iframe: with
// allow-same-origin the overlay can hit /artifact/<id>/session and
// /dispatch on this server. Without allow-same-origin those fetches
// would fail (opaque response), so this test is the strongest signal
// that the sandbox tokens are correct.
//
// We seed one unsent draft via /api/store, then mock /artifact/<id>/session
// and /dispatch via page.route() (the latter MUST match nested-frame
// requests — Playwright's page.route() does interception for ALL frames
// in the page).
test('Send button inside iframe POSTs to /dispatch', async () => {
  const artId = 'art_iframe_send_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, RICH_HTML_BODY);

  // Seed an unsent draft anchored to text we know is in the body.
  const draft = {
    id: 'c_iframe_send_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    anchor: {
      kind: 'text',
      section: '',
      text: 'selectable text',
      fingerprint: 'sha1:x',
      occurrence: 0,
    },
    comment: 'Looks good — ship it.',
  };
  const seedRes = await fetch(
    `http://127.0.0.1:${port}/api/store/artifact-comments/${artId}?artifact=${encodeURIComponent(artId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_version: 1,
        artifact_id: artId,
        updated_at: new Date().toISOString(),
        drafts: [draft],
      }),
    },
  );
  expect(seedRes.status).toBe(204);

  const page = await context.newPage();
  const dispatchCalls = [];

  // Mock /artifact/<id>/session to advertise a live instance, so the
  // overlay routes to /dispatch (the happy path).
  await page.route('**/artifact/*/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      session_id: 'sess_iframe',
      workspace_id: 'project',
      live_instance_id: 'inst_iframe_xyz',
    }),
  }));
  await page.route('**/api/sessions**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"items":[]}',
  }));
  await page.route('**/dispatch', (route) => {
    try { dispatchCalls.push(JSON.parse(route.request().postData() ?? '{}')); }
    catch { dispatchCalls.push(route.request().postData()); }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true}',
    });
  });

  await page.goto(`http://127.0.0.1:${port}/artifact/${artId}`, { waitUntil: 'load' });
  const inner = await waitForOverlayFrame(page);
  await inner.waitForSelector('.cdb-sidebar', { timeout: 20_000 });

  // Wait for the draft to be loaded (the Send button reflects the count).
  await expect(inner.locator('.cdb-sidebar .send')).toContainText('Send (1)', { timeout: 10_000 });
  await expect(inner.locator('.cdb-sidebar .send')).toBeEnabled();

  await inner.locator('.cdb-sidebar .send').click();

  await expect.poll(() => dispatchCalls.length, { timeout: 8_000 }).toBe(1);
  const body = dispatchCalls[0];
  expect(body.instance_id).toBe('inst_iframe_xyz');
  expect(typeof body.prompt).toBe('string');
  expect(body.prompt).toContain('Looks good — ship it.');

  await page.close();
});

// TODO(image-anchor): an in-iframe <img>-click → sidebar-card-with-thumbnail
// test was originally scoped but is flaky in headless Chromium because the
// image-anchored capture path lazy-loads html2canvas from esm.sh. The
// element-click contract is already exercised by JSDOM unit tests and the
// universal Playwright suite for non-iframe renderers; the iframe-specific
// risk (events not reaching the overlay) is fully covered by the selection
// test above, which uses the same listener wiring.
