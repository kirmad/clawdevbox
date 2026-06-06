// Drive the Main Agent via Playwright's REAL keyboard (xterm.js → WS → pty)
// — the same path a human user takes. Watch state in API + DOM.
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:5201/', { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');

try { await page.click('text=Terminals', { timeout: 5000 }); } catch {}
await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(800);

// Click on Main Agent tab.
await page.click('text=Main Agent');
await page.waitForTimeout(800);

// Focus the xterm host.
const host = await page.$('.xterm-host');
if (!host) throw new Error('xterm-host not found');
await host.click();
await page.waitForTimeout(400);

// Snapshot DOM state for BEFORE.
async function snap(label) {
  const apiItems = await page.evaluate(async () => {
    const r = await fetch('/api/sessions?status=active');
    return (await r.json()).items;
  });
  const main = apiItems.find((x) => x.instance_id === 'main');
  const dom = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.tab-row'))
      .find((r) => (r.textContent ?? '').includes('Main Agent'));
    const icon = row?.querySelector('.row-1 i');
    return { iconClass: icon?.className, iconTitle: icon?.getAttribute('title') };
  });
  console.log(`${label}: api.state=${main?.state} icon=${dom.iconClass} title=${dom.iconTitle}`);
}

await snap('BEFORE');

// Type into the live terminal — uses xterm.js's keyboard handling.
await page.keyboard.type('reply with: pong', { delay: 25 });
await page.waitForTimeout(400);
await page.keyboard.press('Enter');
console.log('Pressed Enter');

const t0 = Date.now();
for (const target of [1, 2, 3, 5, 8, 12, 18, 25, 35, 50, 70]) {
  const wait = t0 + target * 1000 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  await snap(`T+${target}s`);
}

// Final screenshot
await page.screenshot({ path: process.argv[2] ?? './main-agent-state.png', fullPage: false });
await browser.close();
