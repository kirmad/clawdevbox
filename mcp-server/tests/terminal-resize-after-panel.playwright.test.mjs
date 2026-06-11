// terminal-resize-after-panel.playwright.test.mjs
//
// Repro for the user's report: "after the inbox question panel additions,
// the terminal UI shows garbled text". Garbled xterm output is a classic
// pty width/height mismatch — usually a refit() that fired with the wrong
// dimensions and SHRUNK the live pty.
//
// This test boots a real clawdevbox start, spawns an echo-stub session
// (long-lived, idle in /vbox-shell), navigates the SPA through:
//   Terminals → Inbox (with a seeded question item) → Terminals
// and asserts the pty never receives a resize message that DECREASES the
// cols below its starting value. Any shrink is a regression.

import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const cliEntry = resolve(projectRoot, 'src/index.ts');

function freePortGuess() { return 15700 + Math.floor(Math.random() * 100); }

let serverProc, tmpRoot, port, token, browser, context;

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok && (await r.text()).trim() === 'ok') return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server not healthy');
}

async function pollFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fn(); if (r) return r; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`pollFor(${label}) timed out`);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  tmpRoot = mkdtempSync(join(tmpdir(), 'cdb-resize-repro-'));
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
  serverProc.stderr.on('data', (chunk) => {
    const s = chunk.toString();
    if (/error|throw|EADDRINUSE/i.test(s)) process.stderr.write(`[server] ${s}`);
  });

  await waitForHealth(45_000);
  await pollFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    return r.status === 200;
  }, 30_000, '/api/sessions ready');

  browser = await chromium.launch();
  context = await browser.newContext({
    serviceWorkers: 'allow',
    viewport: { width: 1400, height: 900 }, // realistic desktop layout
  });
});

test.afterAll(async () => {
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  if (serverProc && !serverProc.killed) {
    if (platform() === 'win32' && serverProc.pid) {
      spawnSync('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { serverProc.kill('SIGTERM'); } catch {}
    }
  }
  if (tmpRoot && existsSync(tmpRoot)) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test.setTimeout(180_000);

test('switching Terminals ↔ Inbox does not shrink the pty', async () => {
  // 1. Spawn a long-lived echo-stub session — we need a pty that stays
  //    alive for the entire navigation cycle.
  const spawnRes = await fetch(`http://127.0.0.1:${port}/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'echo this',
      provider: 'echo-stub',
    }),
  });
  expect(spawnRes.status).toBe(200);

  // 2. Seed an inbox question item — the new panel UI from the inbox PR.
  await fetch(`http://127.0.0.1:${port}/api/test/inbox-upsert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'repro:q',
      kind: 'question',
      source: 'repro',
      title: 'pick',
      notify: false,
      question: {
        prompt: 'pick',
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        allow_freeform: true,
      },
    }),
  });

  // 3. Open the SPA. Intercept every WS message to the terminal endpoint
  //    so we can audit resize commands.
  const page = await context.newPage();

  await page.addInitScript(() => {
    const origWS = window.WebSocket;
    window.__termWsUrls = [];
    window.WebSocket = class extends origWS {
      constructor(url, ...rest) {
        super(url, ...rest);
        if (typeof url === 'string' && url.includes('/terminal/')) {
          window.__termWsUrls.push(url);
          const origSend = this.send.bind(this);
          this.send = (data) => {
            try {
              const parsed = JSON.parse(data);
              if (parsed && parsed.type === 'resize') {
                window.__termResizes ||= [];
                window.__termResizes.push({
                  cols: parsed.cols,
                  rows: parsed.rows,
                  url,
                  t: Date.now(),
                });
              }
            } catch { /* not json */ }
            return origSend(data);
          };
        }
      }
    };
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

  await page.getByRole('tab', { name: /Terminals/i }).click();
  await page.waitForTimeout(1500);

  // The initial WS URL must carry ?cols=&rows= so the server-side tmux-attach
  // IPty is born at the viewer's real dims (not the 120×30 default).  This
  // was the root cause of the "rendering garbled as the agent runs" report:
  // the pane started at 120 cols, then the first resize message resized
  // it to 136+ mid-render and tmux re-flowed the existing scrollback,
  // producing visibly broken output.
  const wsUrls = await page.evaluate(() => window.__termWsUrls ?? []);
  expect(wsUrls.length).toBeGreaterThan(0);
  const firstUrl = wsUrls[0];
  const parsedUrl = new URL(firstUrl);
  const initialUrlCols = Number(parsedUrl.searchParams.get('cols'));
  const initialUrlRows = Number(parsedUrl.searchParams.get('rows'));
  expect(
    initialUrlCols,
    `WS URL missing ?cols= or value too small (got "${parsedUrl.searchParams.get('cols')}") — initial IPty will be born at the 120×30 default and the first paint will garble`,
  ).toBeGreaterThanOrEqual(40);
  expect(
    initialUrlRows,
    `WS URL missing ?rows= or value too small (got "${parsedUrl.searchParams.get('rows')}")`,
  ).toBeGreaterThanOrEqual(10);
  // eslint-disable-next-line no-console
  console.log('[repro] initial WS URL dims =', initialUrlCols, 'x', initialUrlRows);

  // Under lock-after-attach there should be ZERO resize messages even
  // immediately after open — the URL ?cols=&rows= carries the dims and the
  // client never sends a follow-up resize. We assert this strictly later;
  // log here for debugging in case of regression.
  const initialResizes = await page.evaluate(() => window.__termResizes ?? []);
  // eslint-disable-next-line no-console
  console.log('[repro] initial resize msgs =', initialResizes.length, '(expected 0 under lock-after-attach)');

  // Switch to Inbox → render the InboxDetailPanel question UI.
  await page.getByRole('tab', { name: /Inbox/i }).click();
  await expect(page.getByText('pick').first()).toBeVisible({ timeout: 10_000 });
  await page.getByText('pick').first().click();
  await page.waitForTimeout(1000);

  // Switch BACK to Terminals.
  await page.getByRole('tab', { name: /Terminals/i }).click();
  await page.waitForTimeout(1500);

  // Drawer toggle stress — opening/closing the off-canvas drawer changes
  // the flex layout of .app-main, which fires ResizeObserver on the xterm
  // host. Each toggle is a candidate for a bad shrink-then-restore.
  for (let i = 0; i < 2; i++) {
    try { await page.getByLabel('Details').click({ timeout: 2000 }); }
    catch { break; /* no drawer in this layout */ }
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }

  // Viewport shrink-then-widen — the user's most common real-world trigger.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(800);

  const allResizes = await page.evaluate(() => window.__termResizes ?? []);
  // eslint-disable-next-line no-console
  console.log('[repro] all resizes:', JSON.stringify(allResizes, null, 2));

  // LOCK-AFTER-ATTACH contract: zero resize messages are sent after the
  // initial WS URL carries the fit dims. Re-flowing the pane on every
  // layout change makes tmux re-render the existing scrollback at the new
  // width, which on psmux 3.3.2 visibly garbles text (chars scattered to
  // positions computed for the old width). See refit() in TerminalsPanel
  // and the matching standalone-page comment in terminal-server.ts for
  // the rationale. Browser viewport changes are absorbed by the xterm DOM
  // being CSS-scaled inside .xterm-host.
  expect(
    allResizes.length,
    `${allResizes.length} resize message(s) leaked after the initial open — these would garble tmux scrollback. The initial URL already carries cols/rows; no follow-up resize should fire.`,
  ).toBe(0);

  await page.close();
});
