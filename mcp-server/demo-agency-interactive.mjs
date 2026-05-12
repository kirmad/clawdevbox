// demo-agency-interactive.mjs
//
// Spawns a real interactive `agency copilot` session inside a hidden
// node-pty (no Windows console window), registers it in the PtyRegistry,
// and opens a headed Chromium pointed at the terminal-viewer page.
//
// You type into the xterm pane in the browser — agency receives the
// keystrokes through the WS bridge → PtyRegistry.write → IPty.write.
// Output streams back the same way.
//
// Click the red "Kill" button (or close the browser) to terminate.

import * as pty from 'node-pty';
import { chromium } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTerminalServer } from './src/terminal-server.ts';
import { registerPty } from './src/pty-registry.ts';

const COLS = 160;
const ROWS = 40;
const INSTANCE_ID = 'agency-interactive';

// Use a fresh tmp dir as cwd so we don't pollute anything.
const cwd = mkdtempSync(join(tmpdir(), 'conductor-agency-demo-'));

// Spawn agency interactively. No `-p` → full TUI session.
const agencyBin = process.env.CONDUCTOR_AGENCY_PATH
  ?? (process.platform === 'win32' ? 'agency.exe' : 'agency');

const srv = await startTerminalServer({});
const url = srv.url(INSTANCE_ID);

const ipty = pty.spawn(agencyBin, ['copilot'], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd,
  env: { ...process.env },
});

registerPty({
  instanceId: INSTANCE_ID,
  workspaceId: 'agency-demo',
  cols: COLS,
  rows: ROWS,
  ipty,
});

console.log('');
console.log('================================================================');
console.log(' Conductor — interactive agency copilot in hidden pty');
console.log('================================================================');
console.log(` View URL:  ${url}`);
console.log(` cwd:       ${cwd}`);
console.log(` pty pid:   ${ipty.pid}`);
console.log('');
console.log(' Launching headed Chromium...');
console.log(' - Type into the xterm pane. Agency receives it via the WS bridge.');
console.log(' - "Kill" button or closing the browser ends the session.');
console.log('================================================================');
console.log('');

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });

function shutdown() {
  try { ipty.kill(); } catch { /* already gone */ }
  srv.close().finally(() => process.exit(0));
}

browser.on('disconnected', () => {
  console.log('browser window closed.');
  shutdown();
});

ipty.onExit(({ exitCode }) => {
  console.log(`agency pty exited (code=${exitCode}). shutting down...`);
  srv.close().finally(() => process.exit(0));
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
