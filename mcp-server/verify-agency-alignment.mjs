// verify-agency-alignment.mjs
//
// Diagnostic driver: boots terminal-server, spawns agency copilot inside a
// hidden pty, opens headless Chromium, takes screenshots at key moments to
// verify TUI alignment.
//
// Screenshots land in ./verify-screenshots/.

import * as pty from 'node-pty';
import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startTerminalServer } from './src/terminal-server.ts';
import { registerPty } from './src/pty-registry.ts';

const COLS = 120;
const ROWS = 32;
const INSTANCE_ID = 'agency-verify';

const outDir = resolve('./verify-screenshots');
mkdirSync(outDir, { recursive: true });

const cwd = mkdtempSync(join(tmpdir(), 'clawdevbox-agency-verify-'));

const agencyBin = process.env.CLAWDEVBOX_AGENCY_PATH
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
  workspaceId: 'agency-verify',
  cols: COLS,
  rows: ROWS,
  ipty,
});

console.log(`view url: ${url}`);
console.log(`pty pid:  ${ipty.pid}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.locator('#status').waitFor({ state: 'visible' });

// Early diagnostic screenshot + buffer dump to confirm the page even loaded.
await page.waitForTimeout(3000);
await page.screenshot({ path: join(outDir, '00-early.png') });
const earlyBuf = await page.evaluate(() => {
  const t = window.__clawdevboxTerm;
  if (!t) return '<no __clawdevboxTerm>';
  const b = t.buffer.active;
  let s = '';
  for (let i = 0; i < b.length; i++) s += b.getLine(i)?.translateToString(true) + '\n';
  return s.replace(/\n+$/, '');
});
console.log('--- early xterm buffer ---');
console.log(earlyBuf);
console.log('--- end ---');

// Helper: read current xterm buffer (visible content) for text-based assertions.
async function buf() {
  return await page.evaluate(() => {
    const t = window.__clawdevboxTerm;
    if (!t) return '';
    const b = t.buffer.active;
    let s = '';
    for (let i = 0; i < b.length; i++) s += b.getLine(i)?.translateToString(true) + '\n';
    return s;
  });
}

async function shot(name) {
  const p = join(outDir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  screenshot → ${p}`);
}

async function dims() {
  return await page.evaluate(() => {
    const t = window.__clawdevboxTerm;
    return t ? { cols: t.cols, rows: t.rows } : null;
  });
}

console.log('\n[1/6] waiting for agency banner ("Describe a task" / "trusted folders")...');
await page.waitForFunction(
  () => {
    const t = window.__clawdevboxTerm;
    if (!t) return false;
    const b = t.buffer.active;
    let s = '';
    for (let i = 0; i < b.length; i++) s += b.getLine(i)?.translateToString(true) + '\n';
    return /Describe a task|Environment loaded|trusted folders/.test(s);
  },
  { timeout: 60_000 },
);
await page.waitForTimeout(2000);
console.log('  xterm initial size:', await dims());
await shot('01-initial-1280x720');

console.log('\n[2/6] dismissing folder-trust prompt with "1<Enter>"...');
await page.locator('.xterm-helper-textarea').focus();
await page.keyboard.press('1');
await page.keyboard.press('Enter');
await page.waitForTimeout(3000);
await shot('02-after-trust-confirmed');

console.log('\n[3/6] typing "/" to open command palette...');
await page.keyboard.type('/');
await page.waitForTimeout(2000);
await shot('03-after-slash');

console.log('\n[4/6] pressing Escape, sending "hi" + Enter...');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.type('hi');
await page.keyboard.press('Enter');
await page.waitForTimeout(5000);
await shot('04-after-hi');

// === RESIZE INVARIANT ===========================================
// Verify that browser viewport changes do NOT misalign the xterm.
// The pty/xterm cols/rows are locked at attach; resizing the viewport
// should just expose / hide empty space around the xterm pane, not
// reflow ANSI cursor positioning.
console.log('\n[5/6] shrinking viewport to 800x500, screenshot, checking dims...');
await page.setViewportSize({ width: 800, height: 500 });
await page.waitForTimeout(1500);
const afterShrink = await dims();
console.log('  xterm size after shrink:', afterShrink);
await shot('05-after-shrink-800x500');

console.log('\n[6/6] enlarging viewport to 1700x900, screenshot, checking dims...');
await page.setViewportSize({ width: 1700, height: 900 });
await page.waitForTimeout(1500);
const afterGrow = await dims();
console.log('  xterm size after grow:', afterGrow);
await shot('06-after-grow-1700x900');

// The locked invariant: xterm.cols/rows must NOT change across resizes.
if (afterShrink.cols !== afterGrow.cols || afterShrink.rows !== afterGrow.rows) {
  console.error(`\n❌ FAIL: xterm dims changed across resize (shrink=${JSON.stringify(afterShrink)} vs grow=${JSON.stringify(afterGrow)})`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ xterm cols/rows locked across resize (${afterGrow.cols}x${afterGrow.rows})`);
}

console.log('\ndone. shutting down.');
await browser.close();
try { ipty.kill(); } catch { /* ignore */ }
await srv.close();
process.exit(0);
