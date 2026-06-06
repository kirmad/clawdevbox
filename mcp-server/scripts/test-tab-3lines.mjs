// Live E2E: spawn copilot, have it set all 3 fields via update_status,
// take a Playwright screenshot showing the 3-line tab layout, verify
// each field reaches the DOM.
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5201/';
const TASK = 'Refactor authentication module';
const SUBTASK = 'Migrating User model to TypeScript';
const STATUS = 'Updating src/models/user.ts';
const OUT_PNG = process.argv[2] ?? './tab-3lines.png';

// Spawn — ask agent to set all 3 fields then stop
console.log('Spawning copilot…');
const r = await fetch(`${URL}spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt:
      `Call the update_status MCP tool exactly ONCE with these arguments and then reply: ok.\n` +
      `  task_title: "${TASK}"\n` +
      `  subtask_title: "${SUBTASK}"\n` +
      `  status: "${STATUS}"\n` +
      `  session_id: your session id from the [clawdevbox] prefix above\n`,
    provider: 'copilot',
  }),
});
const spawned = await r.json();
console.log(`spawned: ${spawned.instance_id}, session_id: ${spawned.session_id}`);

// Wait for all 3 to land
const deadline = Date.now() + 120_000;
let landed = false;
while (Date.now() < deadline) {
  const s = await fetch(`${URL}api/sessions?status=active`).then((x) => x.json());
  const me = s.items.find((x) => x.instance_id === spawned.instance_id);
  if (me?.task_title === TASK && me?.subtask_title === SUBTASK && me?.status_text === STATUS) {
    landed = true;
    break;
  }
  if (me?.task_title || me?.subtask_title || me?.status_text) {
    console.log(`  partial: t=${JSON.stringify(me?.task_title)} st=${JSON.stringify(me?.subtask_title)} s=${JSON.stringify(me?.status_text)}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(`all 3 landed: ${landed}`);

// Open browser
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

// Verify each field appears in the rendered DOM
const dom = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.tab-row'));
  return rows.map((row) => ({
    line1: row.querySelector('.tab-task')?.textContent?.trim() ?? null,
    line2: row.querySelector('.row-subtask')?.textContent?.trim() ?? null,
    line3: row.querySelector('.row-status .muted')?.textContent?.trim() ?? null,
  }));
});

console.log('\n--- DOM tab rows (first 3): ---');
for (const r of dom.slice(0, 3)) console.log(JSON.stringify(r));

const match = dom.find((r) =>
  r.line1 === TASK &&
  r.line2 === SUBTASK &&
  (r.line3 ?? '').includes(STATUS)
);

console.log(`\n--- Result ---`);
console.log(`3-line tab visible: ${!!match}`);
console.log(`screenshot: ${OUT_PNG}`);

// Cleanup
await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, { method: 'DELETE' });

await browser.close();
process.exit(match ? 0 : 1);
