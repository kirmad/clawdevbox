/**
 * REAL agent-driven end-to-end test for the Recipe side panel.
 *
 * Stages:
 *   STAGE 1 — Spawn copilot, prompt agent to:
 *               a) upsert a tiny test recipe (3 steps)
 *               b) call recipe.run to spawn ANOTHER session for it
 *   STAGE 2 — Poll until the recipe-instance appears in /api/sessions
 *   STAGE 3 — Open SPA, click on the recipe-bound session tab
 *   STAGE 4 — Side panel → Recipe tab → verify 3 steps visible
 *   STAGE 5 — Verify step status emojis render (PASS even if all pending)
 *   STAGE 6 — Screenshot
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'http://127.0.0.1:5201/';
const OUT_DIR = process.argv[2] ?? './recipe-panel-e2e';
mkdirSync(OUT_DIR, { recursive: true });

const FAILURES = [];
function check(label, cond) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label); FAILURES.push(label); }
}

const RECIPE_ID = 'side-panel-recipe-test';
const RECIPE_YAML = [
  'id: ' + RECIPE_ID,
  'name: "Side Panel Recipe Test"',
  'description: "Tiny 3-step recipe used by the recipe-panel E2E test."',
  'default_client: copilot',
  'steps:',
  '  - id: 1',
  '    goal: "Step One: explore the workspace and list files."',
  '  - id: 2',
  '    goal: "Step Two: write a hello.txt file in the workspace."',
  '    depends: [1]',
  '  - id: 3',
  '    goal: "Step Three: call recipe.done with status=success."',
  '    depends: [2]',
].join('\n');

// =============================================================================
// STAGE 1 — Spawn copilot with a scripted prompt.
// =============================================================================
console.log('\nSTAGE 1: spawn driver copilot to create + run a recipe...');

const prompt = [
  'You are running an automated UI test. Follow these instructions EXACTLY:',
  '',
  'STEP 1: Call the update_status tool ONCE with:',
  '          task_title="Recipe Panel E2E Driver"',
  '          session_id=<your session id from the [clawdevbox] prefix>',
  '',
  'STEP 2: Call the recipe.upsert tool (via run_tool wrapper) with these args:',
  '          tool: "recipe.upsert"',
  '          args: {',
  '            "id": "' + RECIPE_ID + '",',
  '            "scope": "project",',
  '            "source": ' + JSON.stringify(RECIPE_YAML),
  '          }',
  '',
  'STEP 3: Call the recipe.run tool (via run_tool wrapper) with these args:',
  '          tool: "recipe.run"',
  '          args: {',
  '            "id": "' + RECIPE_ID + '",',
  '            "prompt": "Just acknowledge each step but DO NOT do real work. Call recipe.done with status=success when done."',
  '          }',
  '         The response will include recipe_instance_id — note it.',
  '',
  'STEP 4: Reply with exactly:',
  '          DONE recipe_instance_id=<the id from step 3>',
  '',
  'Do NOT do anything else. Just call the tools and reply.',
].join('\n');

const spawned = await (await fetch(URL + 'spawn', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt, provider: 'copilot' }),
})).json();
console.log('  driver instance: ' + spawned.instance_id);
check('driver spawn returned instance_id', !!spawned.instance_id);

// =============================================================================
// STAGE 2 — Wait for a NEW session whose recipe_id matches our RECIPE_ID.
// =============================================================================
console.log('\nSTAGE 2: wait for agent to spawn the recipe instance...');
const t0 = Date.now();
const TIMEOUT_MS = 300_000;
let recipeInstance = null;
while (Date.now() - t0 < TIMEOUT_MS) {
  const j = await (await fetch(URL + 'api/sessions?status=active')).json();
  recipeInstance = (j.items ?? []).find((it) => it.recipe_id === RECIPE_ID);
  if (recipeInstance) {
    console.log('  T+' + Math.round((Date.now() - t0) / 1000) + 's: found recipe instance ' + recipeInstance.instance_id);
    break;
  }
  await new Promise((r) => setTimeout(r, 4000));
}
check('recipe.run produced a live session', !!recipeInstance);

if (!recipeInstance) {
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
      try { const o = JSON.parse(line); if (o.type === 'snapshot' && o.content) content += o.content; if (o.type === 'data' && o.chunk) content += o.chunk; } catch { /* */ }
    }
    console.log('\n--- driver terminal scrollback (last 4000 chars) ---');
    console.log(stripAnsi(content).slice(-4000));
    console.log('---\n');
  } catch (err) { console.log('  driver scrollback capture failed: ' + err.message); }
  // Cleanup
  await fetch(URL + 'api/sessions/' + encodeURIComponent(spawned.instance_id), { method: 'DELETE' });
  process.exit(1);
}

// =============================================================================
// STAGE 3 — Open SPA + click the recipe-bound tab.
// =============================================================================
console.log('\nSTAGE 3: open SPA + select recipe-bound session...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');
try { await page.click('text=Terminals', { timeout: 5000 }); } catch {}
await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(1500);

const targetId = recipeInstance.instance_id;
let foundRow = false;
const clickDeadline = Date.now() + 30_000;
while (Date.now() < clickDeadline) {
  const result = await page.evaluate((id) => {
    const row = document.querySelector(`.tab-row[data-instance-id="${id}"]`);
    if (!row) return { found: false };
    const wasSelected = row.classList.contains('selected');
    row.click();
    return { found: true, wasSelected };
  }, targetId);
  if (result.found) { foundRow = true; break; }
  await page.waitForTimeout(2000);
}
check('recipe-bound tab visible + clicked', foundRow);
await page.waitForTimeout(2000);

await page.screenshot({ path: join(OUT_DIR, 'stage3-selected.png'), fullPage: false });
console.log('  screenshot: ' + join(OUT_DIR, 'stage3-selected.png'));

// =============================================================================
// STAGE 4 — Side panel + Recipe tab.
// =============================================================================
console.log('\nSTAGE 4: side panel + Recipe tab...');
const sidePanelPresent = !!(await page.$('.side-panel, .side-collapsed'));
check('side panel mounted', sidePanelPresent);

const wasCollapsed = await page.$('.side-collapsed');
if (wasCollapsed) {
  await page.click('.side-collapsed .bar-btn');
  await page.waitForTimeout(500);
}

// Click Recipe tab
const recipeBtn = await page.$('button.tab-btn:has-text("Recipe")');
check('Recipe tab is present', !!recipeBtn);
if (recipeBtn) { await recipeBtn.click(); await page.waitForTimeout(1500); }

const stepCount = await page.$$eval('.step', (els) => els.length);
const stepTitles = await page.$$eval('.step-title', (els) => els.map((e) => e.textContent?.trim() ?? ''));
console.log('  steps in DOM: ' + stepCount);
console.log('  step titles: ' + JSON.stringify(stepTitles));
check('3 steps visible in DOM', stepCount === 3);
check('step 1 title visible', stepTitles.some((t) => t.includes('Step One')));
check('step 2 title visible', stepTitles.some((t) => t.includes('Step Two')));
check('step 3 title visible', stepTitles.some((t) => t.includes('Step Three')));

await page.screenshot({ path: join(OUT_DIR, 'stage4-recipe-steps.png'), fullPage: false });
console.log('  screenshot: ' + join(OUT_DIR, 'stage4-recipe-steps.png'));

// =============================================================================
// STAGE 5 — Recipe header (id + status) visible
// =============================================================================
console.log('\nSTAGE 5: recipe header...');
const recipeIdText = await page.$eval('.recipe-id', (el) => el.textContent?.trim() ?? '').catch(() => '');
const recipeStatusText = await page.$eval('.recipe-status', (el) => el.textContent?.trim() ?? '').catch(() => '');
console.log('  recipe id:     ' + recipeIdText);
console.log('  recipe status: ' + recipeStatusText);
check('recipe id rendered', recipeIdText === RECIPE_ID);
check('recipe status rendered', !!recipeStatusText);

// =============================================================================
// CLEANUP + VERDICT
// =============================================================================
// Kill both sessions
await fetch(URL + 'api/sessions/' + encodeURIComponent(spawned.instance_id), { method: 'DELETE' });
await fetch(URL + 'api/sessions/' + encodeURIComponent(recipeInstance.instance_id), { method: 'DELETE' });
await browser.close();

console.log('\n=== FINAL VERDICT ===');
if (FAILURES.length === 0) { console.log('PASS - all stages succeeded'); process.exit(0); }
else { console.log('FAIL - ' + FAILURES.length + ' failure(s):'); for (const f of FAILURES) console.log('   - ' + f); process.exit(1); }
