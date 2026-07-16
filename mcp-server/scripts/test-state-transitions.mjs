// Spawn a real Copilot session via /spawn, then observe the Terminals tab
// in Playwright over ~30s to capture state transitions (thinking → tool_use → idle).
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const URL = 'http://127.0.0.1:5201/';
const OUT_DIR = process.argv[2] ?? './state-trace';
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');
try { await page.click('text=Terminals', { timeout: 5000 }); } catch {}
await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(500);

// Spawn a fresh copilot session with a prompt that should produce
// thinking → tool_use → idle pretty quickly.
console.log('Spawning copilot via POST /spawn …');
const resp = await fetch(`${URL}spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Run this powershell: Get-ChildItem C:\\git | Select-Object -First 3 Name. Then say done.',
    provider: 'copilot',
  }),
});
const spawned = await resp.json();
console.log('Spawned:', spawned.instance_id);

const tail = spawned.instance_id.split('_').pop();
const log = [];

async function snapshot(t) {
  // Pull derived state from the API + scrape the icon's classes from DOM.
  const apiItems = await page.evaluate(async () => {
    const r = await fetch('/api/sessions?status=active');
    const j = await r.json();
    return j.items;
  });
  const api = apiItems.find((x) => x.label && x.label.includes(tail))
            ?? apiItems.find((x) => x.instance_id && x.instance_id.endsWith(tail));
  const dom = await page.evaluate((t) => {
    const rows = Array.from(document.querySelectorAll('.tab-row'));
    const row = rows.find((r) => (r.textContent ?? '').includes(t));
    if (!row) return null;
    const icon = row.querySelector('.row-1 i');
    return {
      iconClass: icon?.className ?? null,
      iconTitle: icon?.getAttribute('title') ?? null,
    };
  }, tail);
  const entry = { t, api_state: api?.state ?? '?', dom_icon: dom?.iconClass ?? '?', dom_title: dom?.iconTitle ?? '?' };
  log.push(entry);
  console.log(`T+${t}s: api=${entry.api_state}  icon=${entry.dom_icon}  title=${entry.dom_title}`);
  if ([2, 5, 10, 20, 30, 45, 60].includes(t)) {
    const tabList = await page.$('.tab-list');
    if (tabList) await tabList.screenshot({ path: join(OUT_DIR, `t${String(t).padStart(2, '0')}s.png`) });
  }
}

// Watch for ~60s. Sample every 1s for first 10s (fast transitions early),
// then every 5s.
for (let t = 0; t <= 60; t++) {
  if (t <= 10 || t % 5 === 0) await snapshot(t);
  await page.waitForTimeout(1000);
}

writeFileSync(join(OUT_DIR, 'trace.json'), JSON.stringify(log, null, 2));

// Final summary: did we see any state transitions?
const states = new Set(log.map((e) => e.api_state));
console.log(`\n--- Summary ---`);
console.log(`Distinct API states observed: ${[...states].join(', ')}`);
console.log(`Distinct DOM icons observed:  ${[...new Set(log.map((e) => e.dom_icon))].join(' | ')}`);

await browser.close();
