// vue-spa-screenshots.playwright.test.mjs
//
// Visual smoke for the Vue + PrimeVue SPA at desktop (1280×800) and
// mobile (390×844 — iPhone 13) viewports. Each scenario captures a
// full-page screenshot under `verify-screenshots/` so a human (or AI)
// reviewer can confirm the layout actually renders.
//
// Failure here is intentionally narrow: we check screenshot files were
// created and contain bytes. The real value is the saved PNG itself.

import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
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
  return 15400 + Math.floor(Math.random() * 100);
}

let serverProc;
let tmpRoot;
let port;
let token;
let browser;

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

test.beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-vue-shots-'));
  const projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  port = freePortGuess();
  token = 'pwt-' + Math.random().toString(36).slice(2, 10);

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

  await waitForHealth();

  browser = await chromium.launch();
  mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
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

async function shoot(viewport, name, tabClick) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    serviceWorkers: 'allow',
  });
  const page = await ctx.newPage();
  // Surface render errors so a broken screenshot is loud.
  page.on('pageerror', (err) => console.error(`[${name}] pageerror:`, err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[${name}] console.error:`, msg.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  // Wait for the Vue mount: PrimeVue Tabs node carries `.p-tabs` once mounted.
  await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 10_000 });
  // Allow PrimeVue's CSS-in-JS injection + first paint to settle.
  await page.waitForTimeout(400);
  if (tabClick) await tabClick(page);
  const out = join(SHOT_DIR, name + '.png');
  await page.screenshot({ path: out, fullPage: true });
  await ctx.close();
  expect(existsSync(out), `${out} missing`).toBe(true);
  expect(statSync(out).size, `${out} empty`).toBeGreaterThan(2_000);
  return out;
}

test('Desktop 1280×800 — Inbox', async () => {
  await shoot({ width: 1280, height: 800 }, 'desktop-inbox');
});

test('Desktop 1280×800 — Recipes', async () => {
  await shoot({ width: 1280, height: 800 }, 'desktop-recipes', async (page) => {
    await page.getByRole('tab', { name: /Recipes/i }).click();
    await page.waitForTimeout(200);
  });
});

test('Desktop 1280×800 — Terminals', async () => {
  await shoot({ width: 1280, height: 800 }, 'desktop-terminals', async (page) => {
    await page.getByRole('tab', { name: /Terminals/i }).click();
    await page.waitForTimeout(600); // xterm attach
  });
});

test('Mobile 390×844 — Inbox', async () => {
  await shoot({ width: 390, height: 844 }, 'mobile-inbox');
});

test('Mobile 390×844 — Recipes', async () => {
  await shoot({ width: 390, height: 844 }, 'mobile-recipes', async (page) => {
    await page.getByRole('tab', { name: /Recipes/i }).click();
    await page.waitForTimeout(200);
  });
});

test('Mobile 390×844 — Terminals', async () => {
  await shoot({ width: 390, height: 844 }, 'mobile-terminals', async (page) => {
    await page.getByRole('tab', { name: /Terminals/i }).click();
    await page.waitForTimeout(600);
  });
});

// ---- Rich inbox item scenarios (master-detail + fullscreen + artifact) ----

const ARTIFACT_DESIGN_DOC = `# Design Doc — auth refactor

This is a **real** artifact rendered by the built-in \`markdown\` renderer.
Clicking the attachment chip in the inbox detail pane opens this view in
a closable SPA tab via \`<iframe src="/artifact/design-doc">\`.

## Goals

- Replace the legacy session cookie auth with JWT.
- Keep the existing \`/login\` endpoint surface stable.
- Migrate without a downtime window.

## Steps

1. Introduce JWT signing keys in config.
2. Dual-write cookies during the rollout window.
3. Flip the verification path.
4. Drop legacy cookie code in the next release.

> "If it isn't tested, it's broken." — every CI run, ever.

\`\`\`ts
function sign(payload: Claims): string {
  return jwt.sign(payload, KEY, { algorithm: 'RS256', expiresIn: '8h' });
}
\`\`\`
`;

const ARTIFACT_WALKTHROUGH = `# Walkthrough — review.ts changes

Step-by-step review of the PR diff.

## Step 1 — \`src/auth.ts\`

Token validation moved from middleware into a Zod-validated guard.

## Step 2 — \`src/routes/login.ts\`

Cookie issuance gated behind \`flags.dual_write\`.
`;

const INBOX_BODY_MD = `# Body

This is a **rich** description rendered by the inbox detail pane.

- a list
- \`inline code\`
- a [link](https://example.com)

\`\`\`ts
const x: number = 42;
\`\`\`

Attach as many artifacts as you want; each becomes a clickable button
that opens a closable artifact tab.
`;

/**
 * Seed real artifacts under <projectDir>/artifacts/<id>/ so they're
 * discoverable. The project dir is treated as workspace 'project'.
 */
function writeArtifact(projectDir, id, title, content) {
  const dir = join(projectDir, 'artifacts', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id,
        type: 'markdown',
        title,
        workspace_id: 'project',
        created_at: Date.now(),
        meta: { entry: 'content.md' },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'content.md'), content);
}

async function seedRichInboxItem() {
  const projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');

  writeArtifact(projectDir, 'design-doc', 'Design Doc — auth refactor', ARTIFACT_DESIGN_DOC);
  writeArtifact(projectDir, 'walkthrough-v2', 'Walkthrough — review.ts', ARTIFACT_WALKTHROUGH);

  mkdirSync(globalDir, { recursive: true });
  mkdirSync(join(globalDir, 'inbox-bodies'), { recursive: true });
  const id = 'demo:rich:ss';
  writeFileSync(join(globalDir, 'inbox-bodies', 'demo_rich_ss.md'), INBOX_BODY_MD);
  // Also write a couple of low-content items so the list rail has
  // something else to render alongside the highlighted item.
  const otherItems = [
    {
      id: 'ado:pr:101', kind: 'pr_review', source: 'ado', state: 'open',
      title: 'PR 101: small typo fix',
      preview: 'One-line change to a comment in auth.ts.',
      labels: ['quick'],
      created_at: Date.now() - 3600_000, updated_at: Date.now() - 3600_000,
    },
    {
      id: 'icm:1234', kind: 'incident', source: 'icm', state: 'new',
      title: 'INC1234: elevated 5xx rate',
      preview: '5xx rate spiked to 1.2% on auth-svc-uswest. Auto-mitigated by retry.',
      labels: ['P1', 'auth-svc'],
      created_at: Date.now() - 600_000, updated_at: Date.now() - 600_000,
    },
  ];
  writeFileSync(
    join(globalDir, 'inbox.json'),
    JSON.stringify({
      version: 1,
      items: [
        {
          id,
          kind: 'pr_review',
          source: 'manual',
          state: 'new',
          title: 'PR 247: switch auth to JWT',
          preview: 'Big refactor — replaces session cookies with JWT. Two artifacts attached for review.',
          description_format: 'markdown',
          description_size: INBOX_BODY_MD.length,
          attachments: [
            { artifact_id: 'design-doc', type: 'markdown', title: 'Design doc' },
            { artifact_id: 'walkthrough-v2', type: 'markdown', title: 'Walkthrough' },
            { artifact_id: 'never-created', type: 'markdown', title: 'Missing artifact' },
          ],
          recipe_instance: { id: 'ri_demo_abcd' },
          trigger_id: 'ado.new-pr-watcher#auth-svc',
          labels: ['critical', 'review', 'P0'],
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        ...otherItems,
      ],
    }, null, 2),
  );
}

// --- Desktop master-detail ---

test('Desktop 1280×800 — Inbox master-detail (auto-selected first item)', async () => {
  await seedRichInboxItem();
  await shoot({ width: 1280, height: 800 }, 'desktop-inbox-master-detail', async (page) => {
    // Wait for SSE-driven refresh + body fetch to settle.
    await page.waitForTimeout(800);
  });
});

test('Desktop 1280×800 — Inbox detail in fullscreen', async () => {
  await seedRichInboxItem();
  await shoot({ width: 1280, height: 800 }, 'desktop-inbox-fullscreen', async (page) => {
    await page.waitForTimeout(800);
    // Click the maximize button in the detail header.
    await page.locator('button[title*="Fullscreen"]').first().click();
    await page.waitForTimeout(400);
  });
});

test('Desktop 1280×800 — Click attachment opens real artifact viewer', async () => {
  await seedRichInboxItem();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error('[click-artifact] pageerror:', err.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);

  // Click the "Design doc" attachment — desktop master-detail auto-
  // selects the first item which has this attachment.
  const attachmentBtn = page.locator('.attachment-btn').first();
  await expect(attachmentBtn).toBeEnabled({ timeout: 5_000 });
  await attachmentBtn.click();

  // The store adds an artifact tab and switches to it. Its body is an
  // iframe pointing at /artifact/design-doc. Wait for the renderer to
  // produce the markdown <h1>.
  const iframe = page.frameLocator('iframe[src*="/artifact/design-doc"]');
  await iframe.locator('h1', { hasText: 'auth refactor' }).waitFor({ timeout: 15_000 });

  const out = join(SHOT_DIR, 'desktop-artifact-opened.png');
  await page.screenshot({ path: out, fullPage: true });
  expect(existsSync(out), `${out} missing`).toBe(true);
  expect(statSync(out).size, `${out} empty`).toBeGreaterThan(2_000);
  await ctx.close();
});

test('Desktop 1280×800 — Artifact tab in fullscreen', async () => {
  await seedRichInboxItem();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);

  await page.locator('.attachment-btn').first().click();
  const iframe = page.frameLocator('iframe[src*="/artifact/design-doc"]');
  await iframe.locator('h1', { hasText: 'auth refactor' }).waitFor({ timeout: 15_000 });

  // Click the artifact panel's floating fullscreen button.
  await page.locator('.fs-btn').first().click();
  await page.waitForTimeout(400);

  const out = join(SHOT_DIR, 'desktop-artifact-fullscreen.png');
  await page.screenshot({ path: out, fullPage: true });
  expect(existsSync(out), `${out} missing`).toBe(true);
  expect(statSync(out).size, `${out} empty`).toBeGreaterThan(2_000);
  await ctx.close();
});

// --- Mobile navigation ---

test('Mobile 390×844 — Inbox list (no auto-select)', async () => {
  await seedRichInboxItem();
  await shoot({ width: 390, height: 844 }, 'mobile-inbox-list', async (page) => {
    await page.waitForTimeout(800);
  });
});

test('Mobile 390×844 — Tap card pushes detail view', async () => {
  await seedRichInboxItem();
  await shoot({ width: 390, height: 844 }, 'mobile-inbox-detail-pushed', async (page) => {
    await page.waitForTimeout(800);
    // Tap the first card.
    await page.locator('.card').first().click();
    await page.waitForTimeout(500);
  });
});

test('Mobile 390×844 — Click attachment opens artifact', async () => {
  await seedRichInboxItem();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.p-tabs').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800);

  await page.locator('.card').first().click();
  await page.waitForTimeout(500);

  const attachmentBtn = page.locator('.attachment-btn').first();
  await expect(attachmentBtn).toBeEnabled({ timeout: 5_000 });
  await attachmentBtn.click();

  const iframe = page.frameLocator('iframe[src*="/artifact/design-doc"]');
  await iframe.locator('h1', { hasText: 'auth refactor' }).waitFor({ timeout: 15_000 });

  const out = join(SHOT_DIR, 'mobile-artifact-opened.png');
  await page.screenshot({ path: out, fullPage: true });
  expect(existsSync(out), `${out} missing`).toBe(true);
  expect(statSync(out).size, `${out} empty`).toBeGreaterThan(2_000);
  await ctx.close();
});
