// demo-terminal-view.mjs — manual visual demo of the hidden-pty + terminal-viewer.
//
//   1. Starts the terminal-server on an ephemeral port.
//   2. Spawns a long-running node-pty that:
//        - emits a "tick N (ts)" line every second, AND
//        - echoes any input you send back as "echo:<input>".
//   3. Registers it under instance id "demo" so the URL is stable.
//   4. Prints the view URL and keeps running until you Ctrl-C
//      (or until you click Kill in the browser).
//
// Used for manual verification — see README / chat for instructions.

import * as pty from 'node-pty';
import { chromium } from '@playwright/test';
import { startTerminalServer } from './src/terminal-server.ts';
import { registerPty, hasSession } from './src/pty-registry.ts';

const COLS = 120;
const ROWS = 30;
const INSTANCE_ID = 'demo';

const srv = await startTerminalServer({});
const url = srv.url(INSTANCE_ID);

const stub = [
  'let n = 0;',
  'const start = Date.now();',
  'setInterval(() => {',
  '  const t = ((Date.now() - start) / 1000).toFixed(1);',
  '  process.stdout.write(`\\x1b[36mtick ${++n}\\x1b[0m at ${t}s\\r\\n`);',
  '}, 1000);',
  'process.stdin.on("data", (d) => {',
  '  const s = d.toString();',
  '  process.stdout.write(`\\x1b[33mecho:\\x1b[0m ${s.replace(/\\r/g, "")}\\r\\n`);',
  '});',
  'process.stdout.write("\\x1b[32m== conductor demo pty ==\\x1b[0m\\r\\n");',
  'process.stdout.write("type anything and hit enter to see it echoed back.\\r\\n");',
].join('');

const ipty = pty.spawn(process.execPath, ['-e', stub], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: process.cwd(),
  env: { ...process.env },
});

registerPty({
  instanceId: INSTANCE_ID,
  workspaceId: 'demo',
  cols: COLS,
  rows: ROWS,
  ipty,
});

console.log('');
console.log('================================================================');
console.log(' Conductor terminal-viewer demo');
console.log('================================================================');
console.log(` View URL:  ${url}`);
console.log('');
console.log(' Launching headed Chromium...');
console.log(' - "tick N at Ts" should print once per second');
console.log(' - type in the xterm pane to see "echo: ..." round-trip');
console.log(' - click the red "Kill" button to terminate the pty');
console.log(' - close the browser window OR Ctrl-C this shell to exit');
console.log('================================================================');
console.log('');

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 600 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });

// If the user closes the Chromium window, treat that as a quit signal so
// the shell doesn't dangle waiting for Ctrl-C.
browser.on('disconnected', () => {
  console.log('browser window closed.');
  shutdown();
});

// Keep alive until pty exits or user Ctrl-Cs.
ipty.onExit(({ exitCode }) => {
  console.log(`pty exited (code=${exitCode}). shutting down terminal server...`);
  srv.close().finally(() => process.exit(0));
});

function shutdown() {
  console.log('\nshutting down...');
  try { ipty.kill(); } catch { /* ignore */ }
  srv.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Tiny status heartbeat so you can confirm in this shell that the pty is alive.
setInterval(() => {
  if (!hasSession(INSTANCE_ID)) {
    console.log('pty session unregistered.');
    shutdown();
  }
}, 5000).unref();
