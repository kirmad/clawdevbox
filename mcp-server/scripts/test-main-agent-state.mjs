// Drive the Main Agent via its terminal WebSocket and watch state in DOM.
import { chromium } from 'playwright';
import WebSocket from 'ws';

const URL = 'http://127.0.0.1:5201/';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');
try { await page.click('text=Terminals', { timeout: 5000 }); } catch {}
await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(500);

// Get Main Agent baseline state from API + DOM.
async function snap(label) {
  const apiItems = await page.evaluate(async () => {
    const r = await fetch('/api/sessions?status=active');
    const j = await r.json();
    return j.items;
  });
  const main = apiItems.find((x) => x.instance_id === 'main');
  const dom = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.tab-row'));
    const row = rows.find((r) => (r.textContent ?? '').includes('Main Agent'));
    const icon = row?.querySelector('.row-1 i');
    return { iconClass: icon?.className ?? null, iconTitle: icon?.getAttribute('title') ?? null };
  });
  console.log(`${label} main: api.state=${main?.state} icon=${dom.iconClass} title=${dom.iconTitle}`);
}

await snap('BEFORE');

// Send a prompt to Main Agent via its WS (same as the SPA's terminal panel does).
console.log('Connecting WS to /terminal/main/ws ...');
const ws = new WebSocket('ws://127.0.0.1:5201/terminal/main/ws');
await new Promise((resolve) => ws.on('open', resolve));
console.log('WS open');

// Send a short prompt then Enter (\r).
const prompt = 'what is 2+2? short answer please';
ws.send(JSON.stringify({ type: 'input', data: prompt }));
await new Promise((r) => setTimeout(r, 200));
ws.send(JSON.stringify({ type: 'input', data: '\r' }));
console.log('Prompt submitted');

// Now poll states for 90s
const milestones = [1, 2, 3, 5, 8, 12, 18, 25, 35, 50, 70, 90];
const t0 = Date.now();
for (const t of milestones) {
  const targetMs = t0 + t * 1000;
  const wait = targetMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  await snap(`T+${t}s`);
}

ws.close();
await browser.close();
