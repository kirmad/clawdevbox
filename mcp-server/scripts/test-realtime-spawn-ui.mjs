// Validate that a /spawn POSTed from outside the SPA updates the
// Terminals tab IN PLACE (no manual reload). Captures before + after
// screenshots and counts rows.
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5201/';
const BEFORE_PNG = process.argv[2] ?? './spawn-realtime-before.png';
const AFTER_PNG = process.argv[3] ?? './spawn-realtime-after.png';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');

try {
  await page.click('text=Terminals', { timeout: 5000 });
  await page.waitForTimeout(500);
} catch { /* maybe already selected */ }

await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(800);

const beforeRows = await page.$$eval('.tab-row', (els) => els.length);
const beforeActive = await page.$$eval('.group-header.active-header ~ .tab-row', (els) => els.length);
const tabList = await page.$('.tab-list');
if (tabList) await tabList.screenshot({ path: BEFORE_PNG });
console.log(`BEFORE: total rows=${beforeRows}, active rows=${beforeActive}`);

// Spawn from OUTSIDE the SPA (curl/fetch against /spawn). The SPA didn't
// originate the call, so the only way it can learn about the new session
// is via the SSE 'sessions' topic event.
const resp = await fetch(`${URL}spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'realtime-spawn-probe', provider: 'echo-stub' }),
});
const spawned = await resp.json();
console.log(`spawned via /spawn: ${spawned.instance_id}`);

// Give the realtime channel time to deliver + the store debounce to fire.
// realtime.ts uses 80ms debounce; refreshTerminals does one fetch.
await page.waitForTimeout(1500);

const afterRows = await page.$$eval('.tab-row', (els) => els.length);
const afterActive = await page.$$eval('.group-header.active-header ~ .tab-row', (els) => els.length);
if (tabList) await tabList.screenshot({ path: AFTER_PNG });
console.log(`AFTER:  total rows=${afterRows}, active rows=${afterActive}`);

// Look for the new instance ID in the rendered DOM.
const found = await page.evaluate((id) =>
  Array.from(document.querySelectorAll('.tab-row .label'))
    .some((el) => (el.textContent ?? '').includes(id.split('_').pop()))
, spawned.instance_id);

console.log(`new instance visible in UI: ${found}`);
console.log(`delta rows: ${afterRows - beforeRows}, delta active: ${afterActive - beforeActive}`);

if (afterRows <= beforeRows) {
  console.error('FAIL: UI did not pick up the new spawn without a reload');
  process.exit(1);
}
console.log('PASS');
await browser.close();
