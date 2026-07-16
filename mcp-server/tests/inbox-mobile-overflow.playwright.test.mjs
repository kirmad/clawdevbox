// inbox-mobile-overflow.playwright.test.mjs
//
// REGRESSION: at iPhone-class viewport widths (375px), the inbox list and
// detail panes must not produce horizontal page overflow even when items
// carry pathological content — long unbroken titles, long label strings,
// long preview lines, long markdown URLs in the body. Before the fix the
// PrimeVue Tag's default `white-space: nowrap`, plus `grid-template-columns:
// 1fr` (which has implicit `min-width: auto`), let any single wide chip
// blow out the whole list rail and the page width.
//
// Boots a real `clawdevbox start`, seeds two inbox items via the
// `/api/test/inbox-upsert` hook (same handler an agent CLI hits via MCP),
// then drives a 375×812 Playwright page and asserts:
//   1. `documentElement.scrollWidth <= clientWidth` (no body-level
//      horizontal scrollbar).
//   2. Each inbox card's `scrollWidth` fits within its `clientWidth`.
//   3. The detail panel (after tap-to-open) fits within the viewport.

import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const cliEntry = resolve(projectRoot, 'src/index.ts');

function freePortGuess() {
  return 15700 + Math.floor(Math.random() * 100);
}

let serverProc;
let tmpRoot;
let port;
let token;
let browser;
let context;

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok && (await r.text()).trim() === 'ok') return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy within ' + timeoutMs + 'ms');
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-inbox-mobile-'));
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

  browser = await chromium.launch();
  // iPhone 13-class viewport. CSS pixel width 390; we test the smaller
  // 375 to match iPhone SE / older iPhones, which is the tighter case.
  context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
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

// Helper: a single unbroken 80-char string is wider than 375px at any sane
// font-size, so it's a reliable overflow trigger.
const LONG_UNBROKEN =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('Inbox list does not overflow viewport at 375px with long titles/labels', async () => {
  // Seed pathological items:
  //  - Two with long unbroken title / preview / label to test width-overflow.
  //  - Plus 14 more so the list TOTAL height exceeds the rail's viewport,
  //    forcing the column-flex container into the "shrink children to fit"
  //    failure mode (regression for the cards-collapse-to-22px bug).
  const idA = 'q:overflow-long-title-' + Math.random().toString(36).slice(2, 7);
  const idB = 'note:overflow-long-body-' + Math.random().toString(36).slice(2, 7);
  const payloads = [
    {
      id: idA,
      kind: 'note',
      source: 'e2e-test',
      title: `LongTitle${LONG_UNBROKEN}EndOfTitle`,
      preview: `LongPreviewLine${LONG_UNBROKEN}EndOfPreview`,
      labels: [`label-${LONG_UNBROKEN}-end`, 'short-label'],
      notify: false,
    },
    {
      id: idB,
      kind: 'note',
      source: 'e2e-test',
      title: 'Normal title, but body has a wide URL',
      preview: 'Tap to see body with long unbroken URL',
      description: `Some text then https://example.com/${LONG_UNBROKEN}/path/${LONG_UNBROKEN} and more.`,
      description_format: 'markdown',
      notify: false,
    },
  ];
  for (let i = 0; i < 35; i++) {
    payloads.push({
      id: `note:filler-${i}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'note',
      source: 'e2e-test',
      title: `Filler item ${i} — normal title`,
      preview: 'Two-line preview text that fills out the card height so the rail overflows the mobile viewport, exercising the column-flex squish-children failure mode.',
      labels: ['filler', `n-${i}`],
      notify: false,
    });
  }

  for (const payload of payloads) {
    const r = await fetch(`http://127.0.0.1:${port}/api/test/inbox-upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(r.status).toBe(200);
  }

  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  // On mobile the sidebar collapses to icons-only; the Inbox nav button
  // uses title="Inbox" with no visible label. Click by title.
  await page.locator('button.nav-item[title="Inbox"]').click();

  // Wait for at least one card to render.
  await expect(page.locator('.list-rail .card').first()).toBeVisible({ timeout: 10_000 });

  // ──────── ASSERTION 1: <html> width matches viewport (no horizontal scroll). ─
  const docOverflow = await page.evaluate(() => {
    const html = document.documentElement;
    return {
      scrollWidth: html.scrollWidth,
      clientWidth: html.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
    };
  });
  expect(
    docOverflow.scrollWidth,
    `<html> scrollWidth=${docOverflow.scrollWidth} exceeds clientWidth=${docOverflow.clientWidth} — page is wider than viewport`,
  ).toBeLessThanOrEqual(docOverflow.clientWidth);
  expect(
    docOverflow.bodyScrollWidth,
    `<body> scrollWidth=${docOverflow.bodyScrollWidth} exceeds clientWidth=${docOverflow.bodyClientWidth}`,
  ).toBeLessThanOrEqual(docOverflow.bodyClientWidth);

  // ──────── ASSERTION 2: the rail and every card fit within the viewport. ───
  // The .panel has `overflow: hidden`, so document-level scrollWidth can
  // never report overflow — content gets clipped silently. The real bug
  // surface is that .card / .list-rail expand past the viewport width
  // (visible content lost on the right edge). Check painted widths
  // directly against the viewport.
  const layout = await page.evaluate(() => {
    const rail = document.querySelector('.list-rail');
    const cards = Array.from(document.querySelectorAll('.list-rail .card'));
    return {
      viewportWidth: window.innerWidth,
      rail: rail ? { clientWidth: rail.clientWidth, scrollWidth: rail.scrollWidth } : null,
      cards: cards.map((c, i) => {
        const r = c.getBoundingClientRect();
        const widest = Array.from(c.querySelectorAll('*')).reduce(
          (acc, el) => (el.scrollWidth > acc.w
            ? { w: el.scrollWidth, tag: el.tagName + '.' + (el.className || '') }
            : acc),
          { w: 0, tag: '<none>' },
        );
        return {
          idx: i,
          clientWidth: c.clientWidth,
          scrollWidth: c.scrollWidth,
          right: Math.round(r.right),
          widestChild: widest,
        };
      }),
    };
  });
  expect(layout.rail, 'list-rail must be in the DOM').not.toBeNull();
  expect(
    layout.rail.clientWidth,
    `.list-rail clientWidth=${layout.rail.clientWidth} exceeds viewport=${layout.viewportWidth}`,
  ).toBeLessThanOrEqual(layout.viewportWidth);
  expect(
    layout.rail.scrollWidth - layout.rail.clientWidth,
    `.list-rail scroll=${layout.rail.scrollWidth} client=${layout.rail.clientWidth} (content overflows rail by ${layout.rail.scrollWidth - layout.rail.clientWidth}px)`,
  ).toBeLessThanOrEqual(1);

  expect(layout.cards.length, 'at least one inbox card must render').toBeGreaterThan(0);
  for (const c of layout.cards) {
    expect(
      c.right,
      `Card #${c.idx}: rightEdge=${c.right} exceeds viewport=${layout.viewportWidth} ` +
      `(clientWidth=${c.clientWidth}, widest descendant ${c.widestChild.tag}@${c.widestChild.w}px)`,
    ).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(
      c.scrollWidth - c.clientWidth,
      `Card #${c.idx}: scrollWidth=${c.scrollWidth} > clientWidth=${c.clientWidth} ` +
      `(overflow ${c.scrollWidth - c.clientWidth}px; widest descendant ${c.widestChild.tag}@${c.widestChild.w}px)`,
    ).toBeLessThanOrEqual(1);
  }

  // ──────── ASSERTION 3: cards must not be vertically squished. ──────────────
  // Repro for the column-flex squishing bug: when a card has `overflow:
  // hidden` (which forces `min-height: auto` → 0 per Flexbox spec) AND
  // sits in .list-rail (column flex with overflow-y: auto), the rail
  // squishes every card to a ~20px sliver instead of scrolling. The fix
  // is `flex-shrink: 0` on .card.
  //
  // To make this test deterministic without depending on whether
  // `overflow: hidden` is present in the current CSS, we INJECT it here
  // and then assert cards still render at >= 40px. If flex-shrink: 0 is
  // missing, this fails immediately; with it, cards keep their natural
  // height.
  await page.addStyleTag({
    content: `.list-rail .card { overflow: hidden !important; }`,
  });
  await page.waitForTimeout(50); // let layout settle
  const renderedHeights = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.list-rail .card'));
    return cards.map((c, i) => ({
      idx: i,
      renderedHeight: Math.round(c.getBoundingClientRect().height),
      childTotalHeight: Math.round(
        Array.from(c.children).reduce(
          (h, ch) => h + ch.getBoundingClientRect().height, 0,
        ),
      ),
    }));
  });
  for (const h of renderedHeights) {
    expect(
      h.renderedHeight,
      `Card #${h.idx} rendered at ${h.renderedHeight}px (children need ~${h.childTotalHeight}px) — ` +
      `cards collapsed by column-flex parent. Likely cause: .card missing flex-shrink: 0 inside .list-rail.`,
    ).toBeGreaterThanOrEqual(40);
  }

  // ──────── ASSERTION 4: tap a card → detail pane also fits the viewport. ──────
  await page.locator('.list-rail .card').first().tap();
  await expect(page.locator('.detail-only .detail-panel')).toBeVisible({ timeout: 5_000 });

  const detailOverflow = await page.evaluate(() => {
    const html = document.documentElement;
    return { scrollWidth: html.scrollWidth, clientWidth: html.clientWidth };
  });
  expect(
    detailOverflow.scrollWidth,
    `Detail view: <html> scrollWidth=${detailOverflow.scrollWidth} > clientWidth=${detailOverflow.clientWidth}`,
  ).toBeLessThanOrEqual(detailOverflow.clientWidth);

  await page.close();
});
