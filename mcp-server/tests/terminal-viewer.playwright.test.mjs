// terminal-viewer.playwright.test.mjs
//
// End-to-end test for the hidden-pty + xterm.js terminal-viewer pipeline.
//
//   1. Boot the in-process terminal-server (HTTP + WS).
//   2. Spawn a small interactive node-pty that emits "tick" every 200ms and
//      echoes any input back as "got:<input>".
//   3. Register the pty in the PtyRegistry under a known instance id.
//   4. Open the view URL in Playwright Chromium (headless).
//   5. Assert xterm renders the initial "tick" output.
//   6. Type into xterm; verify "got:..." echo appears (input round-trip).
//   7. Click the Kill button; verify status flips to "exited" via the
//      WebSocket exit event.
//
// This validates: PtyRegistry snapshot + subscribe, terminal-server HTTP page,
// WS protocol both directions, xterm DOM rendering, and recipe.kill semantics.
// Mirrors the chat-terminal:watch/write/kill flow used in taskdock.

import { test, expect, chromium } from '@playwright/test';
import * as pty from 'node-pty';
import { startTerminalServer } from '../src/terminal-server.ts';
import { registerPty } from '../src/pty-registry.ts';

const INSTANCE_ID = 'pwt_terminal_view';
const COLS = 100;
const ROWS = 24;

// --- shared fixture state ---------------------------------------------------
let terminalServer;
let ptyProc;
let browser;

test.beforeAll(async () => {
  // 1) Terminal server on an ephemeral port (host 127.0.0.1).
  terminalServer = await startTerminalServer({});

  // 2) Long-lived interactive stub: emits ticks + echoes stdin.
  //    Inline -e so we don't ship a separate test fixture file.
  const stubScript = [
    'let n=0;',
    'setInterval(()=>{process.stdout.write(`tick ${++n}\\r\\n`)},200);',
    'process.stdin.on("data",d=>process.stdout.write(`got:${d.toString().replace(/\\r/g,"")}\\r\\n`));',
  ].join('');
  ptyProc = pty.spawn(process.execPath, ['-e', stubScript], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: process.cwd(),
    env: { ...process.env },
  });

  // 3) Hand it to the registry under a stable id.
  registerPty({
    instanceId: INSTANCE_ID,
    workspaceId: 'pwt_workspace',
    cols: COLS,
    rows: ROWS,
    ipty: ptyProc,
  });

  // 4) Launch headless Chromium.
  browser = await chromium.launch();
});

test.afterAll(async () => {
  try { ptyProc?.kill(); } catch { /* may already be dead */ }
  try { await browser?.close(); } catch { /* ignore */ }
  try { await terminalServer?.close(); } catch { /* ignore */ }
});

test('xterm renders pty output, sends input, kill closes session', async () => {
  const page = await browser.newPage();
  const url = terminalServer.url(INSTANCE_ID);

  // Capture console errors for easier diagnosis on failure.
  page.on('pageerror', (err) => console.error('[page]', err));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[console]', msg.text());
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // --- 1. Wait for ws attach + initial snapshot/data --------------------
  await expect(page.locator('#status')).toHaveText('attached', { timeout: 5000 });

  // --- 2. Wait for "tick" to render in xterm ---------------------------
  // The xterm DOM uses .xterm-rows > div per row. We poll the
  // accessible buffer via term.buffer.active.getLine, which is the most
  // robust way to read on-screen content regardless of styling spans.
  const readBuffer = async () =>
    page.evaluate(() => {
      const t = window.__conductorTerm;
      if (!t) return '';
      const buf = t.buffer.active;
      let out = '';
      for (let i = 0; i < buf.length; i++) {
        out += buf.getLine(i)?.translateToString(true) + '\n';
      }
      return out;
    });

  await expect.poll(readBuffer, { timeout: 5000 }).toMatch(/tick \d+/);

  // --- 3. Send input, assert echo round-trip ---------------------------
  // Focus the xterm helper textarea, type, then wait for "got:hello".
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('hello\r');

  await expect.poll(readBuffer, { timeout: 5000 }).toMatch(/got:hello/);

  // --- 4. Kill session, assert exit event reflects in status -----------
  await page.locator('#killBtn').click();
  await expect(page.locator('#status')).toContainText(/exited/, { timeout: 5000 });

  await page.close();
});
