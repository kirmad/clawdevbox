// Reproduce the "killing a terminal crashes the server" scenario, then
// verify the server SURVIVED.
//
// Sequence:
//   1. Spawn a fresh copilot session via /spawn
//   2. Open + close the Terminals tab's viewer WS multiple times rapidly
//      (each close on Windows used to invoke node-pty's buggy
//      conpty_console_list_agent fork that crashed with AttachConsole failed)
//   3. Kill the session via DELETE /api/sessions
//   4. Verify /healthz still returns 200 and /api/sessions still responds
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5201/';

// Spawn a real copilot session that we can hammer with viewer attaches.
const spawnResp = await fetch(`${URL}spawn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: 'wait 5 seconds then say done',
    provider: 'copilot',
  }),
});
const spawned = await spawnResp.json();
console.log(`spawned: ${spawned.instance_id}`);

// Wait briefly for the tmux session to be alive.
await new Promise((r) => setTimeout(r, 4000));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

// Open + close viewer 8 times rapidly (mimics the recent Playwright runs).
console.log('Opening + closing terminal viewer 8 times rapidly...');
for (let i = 0; i < 8; i++) {
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  try { await page.click('text=Terminals', { timeout: 3000 }); } catch {}
  // Click on the spawned session to make it the active terminal.
  const tail = spawned.instance_id.split('_').pop();
  try {
    await page.click(`text=${tail}`, { timeout: 3000 });
  } catch {}
  await page.waitForTimeout(600);   // give WS time to attach
  await page.close();               // close → WS close → viewer-ipty cleanup
  console.log(`  iteration ${i + 1} closed`);
}

// Now kill the agent session via the API.
console.log('Killing session via DELETE /api/sessions...');
const killResp = await fetch(`${URL}api/sessions/${encodeURIComponent(spawned.instance_id)}`, {
  method: 'DELETE',
});
console.log(`kill resp: ${killResp.status}`);

await new Promise((r) => setTimeout(r, 2000));

// CRITICAL: did the server survive?
let healthOK = false;
let listOK = false;
try {
  const h = await fetch(`${URL}healthz`, { signal: AbortSignal.timeout(5000) });
  healthOK = h.ok;
  console.log(`/healthz: ${h.status} ${await h.text()}`);
} catch (err) {
  console.log(`/healthz FAILED: ${err.message}`);
}
try {
  const s = await fetch(`${URL}api/sessions?status=active`, { signal: AbortSignal.timeout(5000) });
  listOK = s.ok;
  const j = await s.json();
  console.log(`/api/sessions: ${s.status}, count=${j.items?.length}`);
} catch (err) {
  console.log(`/api/sessions FAILED: ${err.message}`);
}

await browser.close();

console.log(`\n--- Verdict ---`);
console.log(`server survived: ${healthOK && listOK}`);
process.exit(healthOK && listOK ? 0 : 1);
