// Playwright visual: spawn → set title → kill → resume → screenshot showing
// NO duplicate: the resumed tab carries the title, old archived row is gone.
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5201/';
const TASK = 'Refactor visual-test ' + Math.random().toString(36).slice(2, 6);
const OUT_PNG = process.argv[2] ?? './resume-no-duplicate.png';

// Stage 1: spawn + set title + wait for idle
const r = await fetch(`${URL}spawn`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: `Call update_status(task_title="${TASK}", session_id=<yours>) and reply: ok.`,
    provider: 'copilot',
  }),
});
const spawned = await r.json();
console.log(`spawned: ${spawned.instance_id}`);

async function waitForTitle(instanceId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await fetch(`${URL}api/sessions?status=active`).then((x) => x.json());
    const me = s.items.find((x) => x.instance_id === instanceId);
    if (me?.task_title === TASK && me?.state === 'idle') return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
if (!(await waitForTitle(spawned.instance_id))) { console.log('TIMEOUT'); process.exit(1); }
console.log('planted ✓');

// Stage 2: kill
await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, { method: 'DELETE' });
await new Promise((r) => setTimeout(r, 3000));

// Stage 3: resume
const rr = await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}/resume`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
});
const resumed = await rr.json();
console.log(`resumed: ${resumed.new_instance_id}`);

await new Promise((r) => setTimeout(r, 4000));

// Stage 4: open SPA + screenshot
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');
try { await page.click('text=Terminals', { timeout: 5000 }); } catch {}
await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(800);

const tabList = await page.$('.tab-list');
if (tabList) await tabList.screenshot({ path: OUT_PNG });

// Verify: exactly ONE tab row shows the title.
const titleCount = await page.evaluate((needle) =>
  Array.from(document.querySelectorAll('.tab-task'))
    .filter((el) => (el.textContent ?? '').includes(needle))
    .length
, TASK);
console.log(`tab rows with title "${TASK}": ${titleCount}`);

// Verify: that one tab is in the ACTIVE section (not archived).
const activeHasTitle = await page.evaluate((needle) => {
  const activeHeader = document.querySelector('.active-header');
  if (!activeHeader) return false;
  // First .tab-row after the active header (until first <details>)
  let el = activeHeader.nextElementSibling;
  while (el && el.tagName !== 'DETAILS') {
    if (el.classList?.contains('tab-row')) {
      const t = el.querySelector('.tab-task')?.textContent ?? '';
      if (t.includes(needle)) return true;
    }
    el = el.nextElementSibling;
  }
  return false;
}, TASK);
console.log(`active section contains the title: ${activeHasTitle}`);

// Cleanup
await fetch(`${URL}api/sessions/${encodeURIComponent(resumed.new_instance_id)}`, { method: 'DELETE' });
await browser.close();

console.log(`screenshot: ${OUT_PNG}`);
console.log(`\n--- Verdict ---`);
const pass = titleCount === 1 && activeHasTitle;
console.log(pass ? '✅ PASS — exactly 1 tab with the title, in ACTIVE section' : '❌ FAIL');
process.exit(pass ? 0 : 1);
