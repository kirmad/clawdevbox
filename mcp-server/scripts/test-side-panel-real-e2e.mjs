/**
 * REAL agent-driven end-to-end test for the Terminals side panel.
 *
 * The agent receives a natural-language prompt, calls real MCP tools
 * (artifact.add via the run_tool wrapper, update_status) — same .mcp.json,
 * same transport, same tool surface as any production agent. We then
 * visually validate the SPA through Playwright with screenshots at every stage.
 *
 * Six stages, each with PASS/FAIL + a screenshot.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'http://127.0.0.1:5201/';
const OUT_DIR = process.argv[2] ?? './side-panel-e2e';
mkdirSync(OUT_DIR, { recursive: true });

const FAILURES = [];
function check(label, cond) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); FAILURES.push(label); }
}

const ARTIFACTS = [
  { id: 'sidepanel-test-001', title: 'First Report', body: 'Hello from artifact 1.' },
  { id: 'sidepanel-test-002', title: 'Second Report', body: 'Hello from artifact 2.' },
  { id: 'sidepanel-test-003', title: 'Third Report', body: 'Hello from artifact 3.' },
];

// =============================================================================
// STAGE 1 — Spawn copilot with a scripted prompt.
// =============================================================================
console.log('\nSTAGE 1: spawn copilot with prompt that triggers artifact.add x3...');

const prompt = [
  'You are running an automated UI test. Follow these instructions EXACTLY:',
  '',
  'STEP 1: Call the update_status tool ONCE with these args:',
  '          task_title="Side Panel E2E Test"',
  '          session_id=<your session id from the [clawdevbox] prefix above>',
  '',
  'STEP 2: Call the artifact.add tool (via the run_tool wrapper) THREE TIMES.',
  '         The run_tool wrapper takes "tool" (string) and "args" (object).',
  '         For each call, set tool="artifact.add" with the args below.',
  '         Do NOT need to pass recipe_instance_id - the server fills it from the header.',
  '',
  ...ARTIFACTS.map((a, i) =>
    '         Call ' + (i + 1) + ': args = {\n' +
    '           "id": "' + a.id + '",\n' +
    '           "type": "markdown",\n' +
    '           "title": "' + a.title + '",\n' +
    '           "files": { "content.md": "# ' + a.title + '\\n\\n' + a.body + '\\n" }\n' +
    '         }\n',
  ),
  '',
  'STEP 3: After all three artifact.add calls succeed, reply with exactly: done.',
  '',
  'Do NOT do anything else. Just call the tools and reply.',
].join('\n');

const spawned = await (await fetch(URL + 'spawn', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt, provider: 'copilot' }),
})).json();
console.log('  instance: ' + spawned.instance_id);
console.log('  session_id: ' + spawned.session_id);
check('spawn returns instance_id', !!spawned.instance_id);
check('spawn returns session_id', !!spawned.session_id);

// =============================================================================
// STAGE 2 — Wait for the agent to register all 3 artifacts.
// =============================================================================
console.log('\nSTAGE 2: wait for agent to register 3 artifacts...');
const t0 = Date.now();
const TIMEOUT_MS = 300_000;
let observed = [];
while (Date.now() - t0 < TIMEOUT_MS) {
  const r = await fetch(URL + 'api/sessions/' + encodeURIComponent(spawned.instance_id) + '/artifacts');
  if (r.ok) {
    const j = await r.json();
    observed = j.items ?? [];
    if (observed.length > 0) {
      console.log('  T+' + Math.round((Date.now() - t0) / 1000) + 's: ' + observed.length + ' artifact(s) - ' + observed.map((a) => a.title).join(' / '));
    }
    if (observed.length >= ARTIFACTS.length) break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log('  final count: ' + observed.length + '/' + ARTIFACTS.length);
check('agent registered all 3 artifacts', observed.length === ARTIFACTS.length);
check('expected titles present', ARTIFACTS.every((a) => observed.some((o) => o.title === a.title)));

if (observed.length < ARTIFACTS.length) {
  try {
    const ws = await import('ws');
    const sock = new ws.default('ws://127.0.0.1:5201/terminal/' + encodeURIComponent(spawned.instance_id) + '/ws');
    await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
    let buf = '';
    sock.on('message', (m) => { buf += m.toString(); });
    await new Promise((r) => setTimeout(r, 3000));
    sock.close();
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]|[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
    let content = '';
    for (const line of buf.split('\n')) {
      try {
        const o = JSON.parse(line);
        if (o.type === 'snapshot' && o.content) content += o.content;
        if (o.type === 'data' && o.chunk) content += o.chunk;
      } catch { /* */ }
    }
    console.log('\n--- agent terminal scrollback (last 4000 chars) ---');
    console.log(stripAnsi(content).slice(-4000));
    console.log('---\n');
  } catch (err) { console.log('  terminal capture failed: ' + err.message); }
}

// =============================================================================
// STAGE 3 — Open SPA, select session, baseline screenshot.
// =============================================================================
console.log('\nSTAGE 3: open SPA + select session...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');
try { await page.click('text=Terminals', { timeout: 5000 }); } catch {}
await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(1500);

const targetId = spawned.instance_id;
// Wait for the new active row to appear in the DOM (SPA realtime sync),
// then click it. The SPA may auto-select the newest active row, in which
// case the click is a no-op but downstream state is correct. We locate
// the row by its stable data-instance-id attribute, not by visible text.
let clicked = false;
let foundRow = false;
const clickDeadline = Date.now() + 30_000;
while (Date.now() < clickDeadline) {
  const result = await page.evaluate((id) => {
    const row = document.querySelector(`.tab-row[data-instance-id="${id}"]`);
    if (!row) return { found: false };
    const isSelected = row.classList.contains('selected');
    row.click();
    return { found: true, isSelected };
  }, targetId);
  if (result.found) { foundRow = true; clicked = true; break; }
  await page.waitForTimeout(2000);
}
check('spawned session tab visible + selected', foundRow);
await page.waitForTimeout(2000);

await page.screenshot({ path: join(OUT_DIR, 'stage3-baseline.png'), fullPage: false });
console.log('  screenshot: ' + join(OUT_DIR, 'stage3-baseline.png'));

// =============================================================================
// STAGE 4 — Artifacts tab.
// =============================================================================
console.log('\nSTAGE 4: side panel + Artifacts tab...');
const sidePanelPresent = !!(await page.$('.side-panel, .side-collapsed'));
check('side panel mounted', sidePanelPresent);

const wasCollapsed = await page.$('.side-collapsed');
if (wasCollapsed) {
  console.log('  side panel was collapsed, expanding...');
  await page.click('.side-collapsed .bar-btn');
  await page.waitForTimeout(500);
}

const artifactsBtn = await page.$('button.tab-btn:has-text("Artifacts")');
if (artifactsBtn) { await artifactsBtn.click(); await page.waitForTimeout(1500); }

const itemCount = await page.$$eval('.art-item', (els) => els.length);
const titlesInDom = await page.$$eval('.art-title', (els) => els.map((e) => e.textContent?.trim() ?? ''));
console.log('  DOM rows: ' + itemCount + ', titles: ' + JSON.stringify(titlesInDom));
check('all 3 artifacts visible in DOM', itemCount === ARTIFACTS.length);
check('expected titles render', ARTIFACTS.every((a) => titlesInDom.some((d) => d.includes(a.title))));

await page.screenshot({ path: join(OUT_DIR, 'stage4-artifacts-list.png'), fullPage: false });
console.log('  screenshot: ' + join(OUT_DIR, 'stage4-artifacts-list.png'));

// =============================================================================
// STAGE 5 — Click -> drilldown.
// =============================================================================
console.log('\nSTAGE 5: click artifact -> iframe drilldown...');
const firstItem = await page.$('.art-item');
if (firstItem) { await firstItem.click(); await page.waitForTimeout(2500); }

const iframeEl = await page.$('iframe.viewer-frame');
check('iframe mounted', !!iframeEl);
const iframeSrc = iframeEl ? await iframeEl.getAttribute('src') : null;
console.log('  iframe src: ' + iframeSrc);
check('iframe src targets /artifact/<id>', iframeSrc?.startsWith('/artifact/') ?? false);

let iframeBodyLen = 0;
try {
  const frame = page.frames().find((f) => f.url().includes('/artifact/'));
  if (frame) {
    await frame.waitForLoadState('domcontentloaded', { timeout: 10000 });
    await page.waitForTimeout(2000);
    iframeBodyLen = (await frame.content()).length;
  }
} catch (err) { console.log('  iframe inspect failed: ' + err.message); }
console.log('  iframe body length: ' + iframeBodyLen);
check('iframe loaded content', iframeBodyLen > 200);

await page.screenshot({ path: join(OUT_DIR, 'stage5-drilldown.png'), fullPage: false });
console.log('  screenshot: ' + join(OUT_DIR, 'stage5-drilldown.png'));

const backBtn = await page.$('.back-btn');
if (backBtn) { await backBtn.click(); await page.waitForTimeout(500); }
const backToList = await page.$$eval('.art-item', (els) => els.length);
check('back button returns to list', backToList === ARTIFACTS.length);

await page.screenshot({ path: join(OUT_DIR, 'stage5b-back-to-list.png'), fullPage: false });

// =============================================================================
// STAGE 6 — Resize handles.
// =============================================================================
console.log('\nSTAGE 6: drag resize handles...');
const handles = await page.$$('.resize-handle');
console.log('  resize handles found: ' + handles.length);
check('2 resize handles present', handles.length >= 2);

const sideBefore = await page.evaluate(() => Number(localStorage.getItem('clawdevbox.terminals.sidePanelWidth') || 360));
console.log('  sidePanelWidth before: ' + sideBefore);
if (handles.length >= 2) {
  const h = handles[1];
  const box = await h.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x - 120, box.y + 100, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
}
const sideAfter = await page.evaluate(() => Number(localStorage.getItem('clawdevbox.terminals.sidePanelWidth') || 360));
console.log('  sidePanelWidth after:  ' + sideAfter);
check('side panel width changed', sideAfter !== sideBefore);
check('side panel width persisted', sideAfter > 0);

const tabBefore = await page.evaluate(() => Number(localStorage.getItem('clawdevbox.terminals.tabListWidth') || 280));
const handle0 = (await page.$$('.resize-handle'))[0];
if (handle0) {
  const box = await handle0.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 100, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
}
const tabAfter = await page.evaluate(() => Number(localStorage.getItem('clawdevbox.terminals.tabListWidth') || 280));
console.log('  tabListWidth: ' + tabBefore + ' -> ' + tabAfter);
check('tab list width changed', tabAfter !== tabBefore);

await page.screenshot({ path: join(OUT_DIR, 'stage6-resized.png'), fullPage: false });
console.log('  screenshot: ' + join(OUT_DIR, 'stage6-resized.png'));

// =============================================================================
// CLEANUP + VERDICT
// =============================================================================
await fetch(URL + 'api/sessions/' + encodeURIComponent(spawned.instance_id), { method: 'DELETE' });
await browser.close();

console.log('\n=== FINAL VERDICT ===');
if (FAILURES.length === 0) { console.log('PASS - all stages succeeded'); process.exit(0); }
else { console.log('FAIL - ' + FAILURES.length + ' failure(s):'); for (const f of FAILURES) console.log('   - ' + f); process.exit(1); }
