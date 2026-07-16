/**
 * Playwright visual proof: spawn a copilot session, have it set its tab
 * title via update_status, screenshot the Terminals tab, verify the
 * title text appears in the DOM.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5201/';
const KNOWN = 'Working on: refactor auth ' + Math.floor(Math.random() * 999);
const OUT_PNG = process.argv[2] ?? './tab-title.png';

console.log(`Test marker: ${KNOWN}`);

// Kick off the spawn first
const r = await fetch(`${URL}spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: `Call update_status with status_text="${KNOWN}" and pass your session_id (from the [clawdevbox] prefix above). Then reply: ok.`,
    provider: 'copilot',
  }),
});
const spawned = await r.json();
console.log(`spawned: ${spawned.instance_id}`);

// Wait for status_text to land before opening the browser
const deadline = Date.now() + 120_000;
let observed = false;
while (Date.now() < deadline) {
  const s = await fetch(`${URL}api/sessions?status=active`).then((x) => x.json());
  const me = s.items.find((x) => x.instance_id === spawned.instance_id);
  if (me?.status_text === KNOWN) { observed = true; break; }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!observed) { console.log('TIMEOUT'); process.exit(1); }
console.log('status_text landed');

// Open browser, capture
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');
try { await page.click('text=Terminals', { timeout: 5000 }); } catch {}
await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(800);

const tabList = await page.$('.tab-list');
if (tabList) await tabList.screenshot({ path: OUT_PNG });

// Verify the title text actually appears in the rendered DOM
const found = await page.evaluate((needle) =>
  Array.from(document.querySelectorAll('.tab-row .label'))
    .some((el) => (el.textContent ?? '').includes(needle))
, KNOWN);

console.log(`Title visible in DOM: ${found}`);
console.log(`screenshot: ${OUT_PNG}`);

await browser.close();

// Cleanup
await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, { method: 'DELETE' });

process.exit(found ? 0 : 1);
