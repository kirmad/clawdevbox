// pr-walkthrough-e2e.playwright.test.mjs
//
// End-to-end coverage for the built-in `pr-walkthrough` artifact renderer
// (src/renderers/pr-walkthrough.mjs). Uses the real spike fixture at
// spikes/pr-walkthrough/artifact/ as a known-good payload and drives the
// full UI through headless Chromium.
//
// Setup mirrors terminal-viewer.playwright.test.mjs's in-process pattern:
//   1. tmp project dir with the minimal `.clawdevbox/` skeleton.
//   2. CLAWDEVBOX_PROJECT_DIR pointed at it so findArtifact() in
//      terminal-server.ts resolves /artifact/<id> to our workspace.
//   3. Copy the spike's manifest.json + walkthrough.json + diff__*.patch +
//      original__*.txt + modified__*.txt into <projectDir>/artifacts/<id>/
//      via writeArtifact() — this is a REAL artifact, not a stub.
//   4. startTerminalServer({ workspace }) in-process; Playwright targets
//      `${baseUrl}/artifact/${id}`.
//
// Surfaces under test:
//   1. Overview renders all 6 sections with the expected item counts.
//   2. Clicking a .conf-gauge jumps into step mode.
//   3. Q&A submit creates a pending bubble (poll runs; no live agent to
//      satisfy it, which is fine for this contract).
//   4. Rail collapse hides #right-rail and reveals #rail-collapsed-strip,
//      and the reverse on expand.
//   5. Hovering a diff line and clicking 💬 opens the comment composer.
//
// The unit-level contract for the renderer is exercised by
// tests/pr-walkthrough-renderer.test.mjs (jsdom). This file complements it
// with the host-page integration: HTTP artifact routes, qa endpoint,
// renderer boot, and DOM interactions.

import { test, expect, chromium } from '@playwright/test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE_ARTIFACT = join(HERE, '..', '..', 'spikes', 'pr-walkthrough', 'artifact');
const ARTIFACT_ID = 'pr-walkthrough-1426766';

let srv;
let baseUrl;
let viewUrl;
let browser;
let page;
let tmpRoot;

test.beforeAll(async () => {
  // Renderer boot pulls highlight.js + mermaid from esm.sh on first paint,
  // which can stretch past the 30s default on slow networks. Match the
  // generous budget used by sibling playwright fixtures.
  test.setTimeout(120_000);

  // -------- 1. tmp project dir + .clawdevbox skeleton ---------------------
  tmpRoot = mkdtempSync(join(tmpdir(), 'pr-walkthrough-e2e-'));
  const projectDir = join(tmpRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'plugins', 'recipe-instances', 'artifacts']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  // Minimal config.json so loadWorkspaceFromEnv doesn't trip on a missing
  // file. The terminal-server only consults workspace.plugins / renderers,
  // which are seeded by reloadTypeRegistries() — an empty config is fine.
  writeFileSync(
    join(projectDir, '.clawdevbox', 'config.json'),
    JSON.stringify({ version: 1, project_dir: projectDir }, null, 2),
  );

  process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
  process.env.CLAWDEVBOX_GLOBAL_DIR = join(tmpRoot, 'global');
  process.env.CLAWDEVBOX_WORKSPACES_ROOT = join(tmpRoot, 'workspaces');
  mkdirSync(process.env.CLAWDEVBOX_GLOBAL_DIR, { recursive: true });
  mkdirSync(process.env.CLAWDEVBOX_WORKSPACES_ROOT, { recursive: true });

  // Dynamic import AFTER env is set so any module-load-time env reads pick
  // up our temp paths.
  const { loadWorkspaceFromEnv } = await import('../src/workspace.ts');
  const { startTerminalServer } = await import('../src/terminal-server.ts');
  const { writeArtifact } = await import('../src/artifact-store.ts');

  // -------- 2. Copy spike artifact as a real artifact ---------------------
  // The spike's manifest.json is passed via the `manifest` field (writeArtifact
  // reserves the literal name "manifest.json" and rejects it from the files
  // map). All other regular files are inlined as string content.
  const spikeManifest = JSON.parse(
    readFileSync(join(SPIKE_ARTIFACT, 'manifest.json'), 'utf8'),
  );
  const files = {};
  for (const name of readdirSync(SPIKE_ARTIFACT)) {
    if (name === 'manifest.json') continue;
    const p = join(SPIKE_ARTIFACT, name);
    if (!statSync(p).isFile()) continue; // skip subdirectories (qa/, etc.)
    files[name] = readFileSync(p, 'utf8');
  }

  const projectDirArg = projectDir;
  writeArtifact({
    workspacePath: projectDirArg,
    manifest: {
      ...spikeManifest,
      id: ARTIFACT_ID,
      type: 'pr-walkthrough',
      title: spikeManifest.title ?? 'PR Walkthrough',
      workspace_id: 'project',
      created_at: spikeManifest.created_at ?? Date.now(),
    },
    files,
  });

  // -------- 3. Boot terminal-server in-process ----------------------------
  const ws = await loadWorkspaceFromEnv();
  srv = await startTerminalServer({ workspace: ws });
  baseUrl = new URL(srv.url('x')).origin;
  viewUrl = `${baseUrl}/artifact/${encodeURIComponent(ARTIFACT_ID)}`;

  // -------- 4. Launch headless Chromium and open the artifact -------------
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

  // Surface page errors so a regression in the renderer doesn't show up
  // as a mysterious selector timeout.
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('PAGE ERROR:', m.text());
  });
  page.on('pageerror', (e) => console.error('PAGE EXCEPTION:', e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) console.error('HTTP ' + r.status() + ' ' + r.url());
  });

  await page.goto(viewUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // The renderer module loads esm.sh ESM packages (mermaid, highlight.js)
  // dynamically; networkidle can be unreliable behind corporate proxies.
  // Wait on the first DOM signal the renderer emits instead.
  await page.waitForSelector('.verdict-bar', { timeout: 60_000 });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await srv?.close(); } catch { /* ignore */ }
  if (tmpRoot && existsSync(tmpRoot)) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ============================================================================
// Test 1: All 6 overview surfaces render with the expected item counts.
// ============================================================================
//
// Drives off the spike's walkthrough.json:
//   - verdict.recommendation = "APPROVE"
//   - confidence has 6 sub-keys → 6 .conf-gauge buttons
//   - whatToLookAt has 8 entries → 8 .att-item rows
//   - disqualifiers has 6 entries → 6 .disq-item rows
//   - faq has 6 entries          → 6 .faq-item rows
//   - summary.bullets has 6      → 6 #bullets > li rows
test('overview renders all 6 surfaces (verdict, dashboard, attention, disqualifiers, FAQ, summary)', async () => {
  await expect(page.locator('#verdict-rec')).toContainText('APPROVE');
  await expect(page.locator('.conf-gauge')).toHaveCount(6);
  await expect(page.locator('.att-item')).toHaveCount(8);
  await expect(page.locator('.disq-item')).toHaveCount(6);
  await expect(page.locator('.faq-item')).toHaveCount(6);
  await expect(page.locator('#bullets > li')).toHaveCount(6);
});

// ============================================================================
// Test 2: Clicking a confidence gauge jumps to its anchor step.
// ============================================================================
test('clicking a confidence gauge jumps to its anchor step', async () => {
  // The previous test left us in overview. If a later run interleaves, the
  // back-overview button restores it.
  if (await page.locator('#stepmode:not(.hidden)').count() > 0) {
    await page.locator('#back-overview').click();
    await page.waitForSelector('#stepmode.hidden', { timeout: 5_000 });
  }
  await page.locator('.conf-gauge').first().click();
  await expect(page.locator('#stepmode')).toBeVisible();
  await page.waitForSelector('.diff-line', { timeout: 10_000 });
});

// ============================================================================
// Test 3: Q&A submit creates a pending bubble and starts polling.
// ============================================================================
//
// We assert the *pending bubble* contract only. The full round-trip needs a
// live agent to satisfy the poll — out of scope here; covered manually and
// by the dispatch-bytes / spawn-endpoint suites.
test('Q&A submit creates a pending bubble and polls', async () => {
  if (await page.locator('#stepmode.hidden').count() > 0) {
    await page.locator('#enter-stepmode').click();
    await expect(page.locator('#stepmode')).toBeVisible();
  }
  await page.locator('.rail-tabs .tab[data-tab="qa"]').click();
  await page.fill('#qa-input', 'why does this work?');
  await page.locator('#qa-form button[type="submit"]').click();
  await expect(page.locator('.qa-bubble.pending')).toBeVisible({ timeout: 10_000 });
});

// ============================================================================
// Test 4: Rail collapse hides .right and shows .rail-collapsed-strip.
// ============================================================================
test('rail collapse hides .right and shows .rail-collapsed-strip', async () => {
  if (await page.locator('#stepmode.hidden').count() > 0) {
    await page.locator('#enter-stepmode').click();
    await expect(page.locator('#stepmode')).toBeVisible();
  }
  await expect(page.locator('#right-rail')).toBeVisible();
  await page.locator('#rail-collapse').click();
  await expect(page.locator('#right-rail')).toBeHidden();
  await expect(page.locator('#rail-collapsed-strip')).toBeVisible();
  await page.locator('#rail-collapsed-strip').click();
  await expect(page.locator('#right-rail')).toBeVisible();
});

// ============================================================================
// Test 5: Hovering a diff line and clicking 💬 opens the comment composer.
// ============================================================================
test('line gutter 💬 opens the comment composer', async () => {
  if (await page.locator('#stepmode.hidden').count() > 0) {
    await page.locator('#enter-stepmode').click();
    await expect(page.locator('#stepmode')).toBeVisible();
  }
  await page.waitForSelector('.diff-line', { timeout: 10_000 });
  const line = page.locator('.diff-line.add').first();
  await line.hover();
  // force: true — the gutter button only opacity-fades to 1 on hover and
  // playwright's actionability check can flake on CI even after hover.
  await line.locator('.line-comment-btn').click({ force: true });
  await expect(page.locator('.composer textarea')).toBeVisible();
});
