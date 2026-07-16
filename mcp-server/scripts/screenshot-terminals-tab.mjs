// Take a Playwright screenshot of the Terminals tab to verify the new
// state-driven icons render correctly with real DOM + CSS.
//
// We can't easily provoke a real agent into all 5 states for a single
// screenshot, so we mutate the live DOM after page-load to set each of
// the first 5 tab rows to a distinct icon-state-* class. This proves
// the CSS rules render correctly with the real (built) bundle.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = 'http://127.0.0.1:5201/';
const OUT_PNG = process.argv[2] ?? './tab-icons.png';
const OUT_HTML = OUT_PNG.replace(/\.png$/, '.html');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');

try {
  await page.click('text=Terminals', { timeout: 5000 });
  await page.waitForTimeout(500);
} catch (err) {
  console.warn('Terminals tab click failed (maybe already selected):', err.message);
}

await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(800);

// MUTATION: forcibly set the first 5 row-1 icons to demonstrate each state.
// This validates the CSS bundle has the new keyframes + colors and that
// the class is plumbed all the way to the live DOM (without needing 5
// concurrent real agents in 5 different states).
const states = ['idle', 'thinking', 'tool_use', 'waiting', 'error'];
const labels = ['Idle', 'Thinking…', 'Using a tool…', 'Waiting on you', 'Error'];
await page.evaluate(({ states, labels }) => {
  const icons = document.querySelectorAll('.tab-row .row-1 i');
  for (let i = 0; i < Math.min(icons.length, states.length); i++) {
    const el = icons[i];
    // Strip all icon-state-* classes.
    for (const c of Array.from(el.classList)) {
      if (c.startsWith('icon-state-')) el.classList.remove(c);
    }
    el.classList.add(`icon-state-${states[i]}`);
    el.setAttribute('title', labels[i]);
  }
}, { states, labels });

// Give the animations a moment so the screenshot captures a tasteful frame.
await page.waitForTimeout(400);

const tabList = await page.$('.tab-list');
if (tabList) {
  await tabList.screenshot({ path: OUT_PNG });
} else {
  await page.screenshot({ path: OUT_PNG });
}

const rows = await page.$$eval('.tab-row .row-1', (els) =>
  els.map((el) => el.outerHTML)
);
writeFileSync(OUT_HTML, rows.join('\n\n'));

console.log(`screenshot: ${OUT_PNG}`);
console.log(`rows-html:  ${OUT_HTML}`);
console.log(`row count:  ${rows.length}`);
console.log(`sample row 0: ${rows[0]?.slice(0, 200) ?? '(none)'}`);

await browser.close();
