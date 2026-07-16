// spa-routing.playwright.test.mjs
//
// Verifies the SPA tabs are routable (per request: /main-agent default,
// /inbox, /inbox/<id>, /recipes, /recipes/<id>, /triggers, /terminals).
// Asserts URL ↔ active-tab synchronisation in both directions:
//   1. Clicking a tab updates window.location.pathname.
//   2. Loading a deep-link URL activates the matching tab.
//   3. Browser back/forward navigates between tabs.

import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const cliEntry = resolve(projectRoot, 'src/index.ts');

function freePortGuess() {
  return 15500 + Math.floor(Math.random() * 100);
}

let serverProc;
let tmpRoot;
let port;
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-spa-routing-'));
  const projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  port = freePortGuess();
  const token = 'pwt-' + Math.random().toString(36).slice(2, 10);

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
  if (tmpRoot) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function newPage() {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'allow',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error('[spa-routing] pageerror:', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[spa-routing] console.error:', msg.text());
  });
  return { ctx, page };
}

async function waitForSpa(page) {
  // SPA shell is mounted once the vertical side-nav is visible.
  await page.locator('.side-nav').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(300);
}

async function expectActiveNav(page, label) {
  // `.nav-item.is-active` is the marker for the active vertical-nav row.
  // The label appears as text inside the .nav-item__label span.
  await expect(page.locator('.nav-item.is-active', { hasText: label })).toBeVisible();
}

async function clickNav(page, label) {
  await page.locator('.nav-item', { hasText: label }).first().click();
}

test('root path redirects to /main-agent', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    expect(new URL(page.url()).pathname).toBe('/main-agent');
  } finally { await ctx.close(); }
});

test('deep link /inbox activates the Inbox nav row', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/inbox`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    expect(new URL(page.url()).pathname).toBe('/inbox');
    await expectActiveNav(page, 'Inbox');
  } finally { await ctx.close(); }
});

test('deep link /recipes activates the Recipes nav row', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/recipes`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    // RecipesPanel auto-selects the first recipe on desktop, so the
    // landing URL after the redirect may include /recipes/<id>. We only
    // care that the activeTab is Recipes.
    expect(new URL(page.url()).pathname).toMatch(/^\/recipes(?:\/|$)/);
    await expectActiveNav(page, 'Recipes');
  } finally { await ctx.close(); }
});

test('deep link /triggers activates the Triggers nav row', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/triggers`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    expect(new URL(page.url()).pathname).toMatch(/^\/triggers(?:\/|$)/);
    await expectActiveNav(page, 'Triggers');
  } finally { await ctx.close(); }
});

test('deep link /terminals activates the Terminals nav row', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/terminals`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    expect(new URL(page.url()).pathname).toMatch(/^\/terminals(?:\/|$)/);
    await expectActiveNav(page, 'Terminals');
  } finally { await ctx.close(); }
});

test('deep link /library activates the Library nav row', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/library`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    expect(new URL(page.url()).pathname).toMatch(/^\/library(?:\/|$)/);
    await expectActiveNav(page, 'Library');
    // The Library sub-nav must render.
    await expect(page.locator('.lib-subnav')).toBeVisible();
  } finally { await ctx.close(); }
});

test('deep link /library/lessons activates Library + the Lessons section', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/library/lessons`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    await expectActiveNav(page, 'Library');
    await expect(page.locator('.lib-subnav__item.is-active', { hasText: 'Lessons' })).toBeVisible();
  } finally { await ctx.close(); }
});

test('clicking the Library nav row updates the URL to /library', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/main-agent`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    await clickNav(page, 'Library');
    await page.waitForFunction(
      () => /^\/library(?:\/|$)/.test(window.location.pathname),
      null,
      { timeout: 5000 },
    );
  } finally { await ctx.close(); }
});

test('unknown server path returns 404 (allow-list prevents typo masking)', async () => {
  // The server only serves the SPA shell for an explicit allow-list of
  // route prefixes (/main-agent, /inbox, /recipes, /triggers, /daemons,
  // /library, /terminals, /artifacts). A truly random path like
  // /nope/wrong is intentionally 404'd by the server so a typo'd
  // /api/foo doesn't silently get served HTML and mask the real error.
  const r = await fetch(`http://127.0.0.1:${port}/nope/wrong/path`);
  expect(r.status).toBe(404);
});

test('clicking the Inbox nav row updates the URL to /inbox', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/main-agent`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    await clickNav(page, 'Inbox');
    await page.waitForFunction(
      () => window.location.pathname === '/inbox' || /^\/inbox\//.test(window.location.pathname),
      null,
      { timeout: 5000 },
    );
  } finally { await ctx.close(); }
});

test('clicking the Recipes nav row updates the URL to /recipes(/...)', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/main-agent`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    await clickNav(page, 'Recipes');
    await page.waitForFunction(
      () => /^\/recipes(?:\/|$)/.test(window.location.pathname),
      null,
      { timeout: 5000 },
    );
  } finally { await ctx.close(); }
});

test('browser back navigates between tabs', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/main-agent`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    await clickNav(page, 'Inbox');
    await page.waitForFunction(() => /^\/inbox(?:\/|$)/.test(window.location.pathname), null, { timeout: 5000 });
    await clickNav(page, 'Recipes');
    await page.waitForFunction(() => /^\/recipes(?:\/|$)/.test(window.location.pathname), null, { timeout: 5000 });
    await page.goBack();
    await page.waitForFunction(() => /^\/inbox(?:\/|$)/.test(window.location.pathname), null, { timeout: 5000 });
    await page.goBack();
    await page.waitForFunction(() => window.location.pathname === '/main-agent', null, { timeout: 5000 });
  } finally { await ctx.close(); }
});

test('deep link /inbox/<unknown-id> falls back to /inbox after the inbox loads', async () => {
  const { ctx, page } = await newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/inbox/some-id-that-does-not-exist`, { waitUntil: 'domcontentloaded' });
    await waitForSpa(page);
    // syncFromRoute initially sets selectedInboxId='some-id-that-does-not-exist',
    // then InboxPanel's watcher detects the id isn't visible and clears it →
    // URL drops the id segment.
    await page.waitForFunction(() => window.location.pathname === '/inbox', null, { timeout: 5000 });
    await expectActiveNav(page, 'Inbox');
  } finally { await ctx.close(); }
});
