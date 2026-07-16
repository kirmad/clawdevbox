/**
 * REAL multi-step recipe E2E. The recipe-spawned child agent does REAL CLI
 * work (lists files, writes a file, reads metadata), creates an artifact
 * per step via the artifact.add MCP tool, and progresses each step from
 * pending → running → done via recipe.steps.update_status. Final step
 * calls recipe.done(status=success).
 *
 * The test verifies — end to end, against the live SPA — that:
 *
 *   1. recipe.upsert + recipe.run via the driver agent succeed
 *   2. The child agent boots (per-session MCP config wiring works)
 *   3. The child completes all 3 steps and calls recipe.done
 *   4. The recipe-instance row reaches status=success in the DB
 *   5. The DB-backed `recipe_steps` rows show status=done for all 3 steps
 *   6. The Recipe panel in the SPA renders all 3 steps with the ✓ emoji
 *      and step-success class (live, via the SSE 'recipes' topic)
 *   7. The Artifacts panel for the recipe-child session shows the 3
 *      artifacts created by the child (one per step)
 *
 * Output: stages/screenshots are written under OUT_DIR (argv[2]).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'http://127.0.0.1:5201/';
const OUT_DIR = process.argv[2] ?? './recipe-multistep-e2e';
mkdirSync(OUT_DIR, { recursive: true });

const FAILURES = [];
function check(label, cond) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label); FAILURES.push(label); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// =============================================================================
// Recipe definition — 3 steps, each doing real work + producing an artifact.
// =============================================================================
const RECIPE_ID = 'multistep-real-e2e';
const RECIPE_YAML = [
  'id: ' + RECIPE_ID,
  'name: "Multi-step Real E2E"',
  'description: "3-step recipe that actually does work, creates artifacts, and progresses step status."',
  // Force the direct copilot provider — not agency. When clawdevbox spawns
  // through agency, agency appends its own --additional-mcp-config AFTER ours
  // (with no headers), which clobbers our per-session X-Clawdevbox-* headers
  // due to copilot's last-wins precedence. The direct provider passes a
  // single --additional-mcp-config so headers survive. See
  // recipe-runner.ts:155-185 for the resolution chain.
  'default_client: copilot',
  'agent_cli: copilot',
  'steps:',
  '  - id: list-files',
  '    goal: "List the top-level files in the workspace and capture them as artifact-1."',
  '  - id: write-hello',
  '    goal: "Write hello.txt with a short greeting, then capture its contents as artifact-2."',
  '    depends: [list-files]',
  '  - id: report-summary',
  '    goal: "Summarize what was done into artifact-3, then call recipe.done."',
  '    depends: [write-hello]',
].join('\n');

// =============================================================================
// Child-agent prompt — passed via recipe.run, becomes the seed prompt for
// the spawned copilot session. This is what the CHILD reads.
//
// We give the child an explicit per-step protocol so the test is deterministic
// even though we are using a real LLM. Each step: update_status(running) →
// do real work → artifact.add → update_status(done).
// =============================================================================
const CHILD_PROMPT = [
  'You are running inside a clawdevbox recipe-spawned session. Your job is',
  'to execute a 3-step recipe FAITHFULLY using the MCP tools available.',
  '',
  'IMPORTANT — for EACH step, you MUST do these calls IN ORDER:',
  '  (a) Call recipe.steps.update_status with status="running", step_id=<id>.',
  '  (b) Do the actual work described in the step goal (use shell/file tools).',
  '  (c) Call artifact.add with the result. Save the artifact id.',
  '  (d) Call recipe.steps.update_status with status="done", step_id=<id>,',
  '      attach_artifact_ids=[<id from (c)>].',
  '',
  'When all 3 steps are done, call recipe.done with status="success".',
  '',
  '--- STEP 1: step_id="list-files" ---',
  '  Work: Use a shell tool (e.g. powershell Get-ChildItem) or a list tool',
  '        to list the top-level files in the current working directory.',
  '  Artifact: artifact.add({id:"e2e-step1-files", type:"markdown",',
  '            title:"Step 1: Workspace files", content:"# Files\\n\\n<your list>"})',
  '',
  '--- STEP 2: step_id="write-hello" ---',
  '  Work: Write a file hello.txt in the workspace containing one line:',
  '        "hello from recipe step 2"',
  '  Artifact: artifact.add({id:"e2e-step2-hello", type:"markdown",',
  '            title:"Step 2: hello.txt", content:"# hello.txt\\n\\n```\\nhello from recipe step 2\\n```"})',
  '',
  '--- STEP 3: step_id="report-summary" ---',
  '  Work: Construct a 1-paragraph summary of what was done in steps 1+2.',
  '  Artifact: artifact.add({id:"e2e-step3-summary", type:"markdown",',
  '            title:"Step 3: Run summary", content:"# Summary\\n\\n<your summary>"})',
  '  Then call recipe.done with status="success", message="all 3 steps done".',
  '',
  'Do not skip any (a)/(b)/(c)/(d) call. Do not call any other tools. Reply',
  'with exactly "DONE" when the final recipe.done call returns.',
].join('\n');

// =============================================================================
// STAGE 1 — Spawn driver copilot. It calls recipe.upsert + recipe.run.
// =============================================================================
console.log('\nSTAGE 1: spawn driver copilot to upsert + run the recipe...');
const testStart = Date.now();

const driverPrompt = [
  'You are running an automated UI test. Do EXACTLY these tool calls in order:',
  '',
  'STEP 1: Call the update_status tool with:',
  '          task_title="Multistep Recipe E2E Driver"',
  '          session_id=<your session id from the [clawdevbox] prefix>',
  '',
  'STEP 2: Call the run_tool wrapper with:',
  '          tool: "recipe.upsert"',
  '          args: {',
  '            "id": "' + RECIPE_ID + '",',
  '            "scope": "project",',
  '            "source": ' + JSON.stringify(RECIPE_YAML),
  '          }',
  '',
  'STEP 3: Call the run_tool wrapper with:',
  '          tool: "recipe.run"',
  '          args: {',
  '            "id": "' + RECIPE_ID + '",',
  '            "prompt": ' + JSON.stringify(CHILD_PROMPT),
  '          }',
  '         The response includes recipe_instance_id — note it.',
  '',
  'STEP 4: Reply with exactly:  DONE recipe_instance_id=<the id>',
  '',
  'Do NOT do anything else.',
].join('\n');

const spawned = await (await fetch(URL + 'spawn', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: driverPrompt, mode: 'interactive', cli: 'copilot' }),
})).json();
console.log('  driver instance: ' + spawned.instance_id);
check('driver spawn returned instance_id', !!spawned.instance_id);

// =============================================================================
// STAGE 2 — Wait for recipe instance to appear (driver agent ran recipe.run).
//          We track testStart BEFORE the spawn so we only match instances
//          created by THIS run; matching by recipe_id alone would happily
//          return a stale instance from a previous run and report PASS on
//          completed historical data (real bug found 2026-06-06).
// =============================================================================
console.log('\nSTAGE 2: wait for driver to spawn the recipe child...');
let recipeInstance = null;
const recipeDeadline = Date.now() + 300_000; // 5 min — driver agent takes time to boot + LLM-think + recipe.upsert + recipe.run
while (Date.now() < recipeDeadline) {
  const r = await fetch(URL + 'api/sessions').then((r) => r.json());
  recipeInstance = (r.items ?? r.sessions ?? []).find((s) =>
    s.recipe_id === RECIPE_ID
    && s.instance_id !== spawned.instance_id
    && typeof s.started_at === 'number'
    && s.started_at >= testStart - 1000,
  );
  if (recipeInstance) {
    const t = Math.floor((Date.now() - testStart) / 1000);
    console.log('  T+' + t + 's: child instance ' + recipeInstance.instance_id);
    break;
  }
  await sleep(3000);
}
check('recipe.run produced a live child session', !!recipeInstance);
if (!recipeInstance) {
  console.error('FATAL: recipe child never appeared.');
  await fetch(URL + 'api/sessions/' + encodeURIComponent(spawned.instance_id), { method: 'DELETE' });
  process.exit(1);
}

// =============================================================================
// STAGE 3 — Wait for the child to finish all 3 steps + call recipe.done.
//          We poll the API for the recipe-instance status reaching a terminal
//          value (success/failure/cancelled) — long timeout because a real
//          LLM-driven multi-step recipe takes minutes.
// =============================================================================
console.log('\nSTAGE 3: wait for child to complete all 3 steps...');
const childInstanceId = recipeInstance.instance_id;
const completeDeadline = Date.now() + 600_000; // 10 min cap
let finalInst = null;
let lastLog = 0;
while (Date.now() < completeDeadline) {
  const inst = await fetch(URL + 'api/recipe-instances/' + encodeURIComponent(childInstanceId)).then((r) => r.json());
  if (Date.now() - lastLog > 15_000) {
    const steps = (inst.steps ?? []).map((s) => s.id + '=' + s.status).join(', ');
    console.log('  [' + new Date().toISOString().slice(11, 19) + '] inst=' + inst.status + '  steps=[' + steps + ']');
    lastLog = Date.now();
  }
  if (inst.status === 'success' || inst.status === 'failure' || inst.status === 'cancelled') {
    finalInst = inst;
    break;
  }
  await sleep(3000);
}
check('child reached terminal status within 10min', !!finalInst);
if (!finalInst) {
  console.error('FATAL: child never completed. Killing driver + child.');
  await fetch(URL + 'api/sessions/' + encodeURIComponent(spawned.instance_id), { method: 'DELETE' });
  await fetch(URL + 'api/sessions/' + encodeURIComponent(childInstanceId), { method: 'DELETE' });
  process.exit(1);
}
check('recipe ended with status=success', finalInst.status === 'success');
const stepStatuses = (finalInst.steps ?? []).reduce((acc, s) => { acc[s.id] = s.status; return acc; }, {});
console.log('  final step statuses: ' + JSON.stringify(stepStatuses));
check('step "list-files" is done', stepStatuses['list-files'] === 'done');
check('step "write-hello" is done', stepStatuses['write-hello'] === 'done');
check('step "report-summary" is done', stepStatuses['report-summary'] === 'done');

// =============================================================================
// STAGE 4 — Verify the 3 artifacts exist on the child session.
// =============================================================================
console.log('\nSTAGE 4: verify 3 artifacts on the child session...');
const arts = await fetch(URL + 'api/sessions/' + encodeURIComponent(childInstanceId) + '/artifacts').then((r) => r.json());
const artList = arts.items ?? arts.artifacts ?? [];
console.log('  artifacts: ' + artList.map((a) => a.id).join(', '));
check('child registered 3 artifacts', artList.length >= 3);
check('step-1 artifact present', artList.some((a) => a.id === 'e2e-step1-files'));
check('step-2 artifact present', artList.some((a) => a.id === 'e2e-step2-hello'));
check('step-3 artifact present', artList.some((a) => a.id === 'e2e-step3-summary'));

// =============================================================================
// STAGE 5 — Open SPA + click recipe-child tab. Verify Recipe panel.
// =============================================================================
console.log('\nSTAGE 5: SPA — Recipe panel renders 3 done steps...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');
try { await page.click('text=Terminals', { timeout: 5000 }); } catch { /* already there */ }
await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(1500);

// Click the recipe-child tab (NOT the driver) by stable data-instance-id
let clickedChild = false;
const clickChildDeadline = Date.now() + 30_000;
while (Date.now() < clickChildDeadline) {
  const r = await page.evaluate((id) => {
    const row = document.querySelector(`.tab-row[data-instance-id="${id}"]`);
    if (!row) return false;
    row.click();
    return true;
  }, childInstanceId);
  if (r) { clickedChild = true; break; }
  await page.waitForTimeout(2000);
}
check('clicked recipe-child tab', clickedChild);
await page.waitForTimeout(1500);

// Open side panel + Recipe tab
const wasCollapsed = await page.$('.side-collapsed');
if (wasCollapsed) {
  await page.click('.side-collapsed .bar-btn');
  await page.waitForTimeout(500);
}
const recipeBtn = await page.$('button.tab-btn:has-text("Recipe")');
check('Recipe tab is present', !!recipeBtn);
if (recipeBtn) { await recipeBtn.click(); await page.waitForTimeout(1500); }

const stepCount = await page.$$eval('.step', (els) => els.length);
const stepData = await page.$$eval('.step', (els) => els.map((e) => ({
  title: e.querySelector('.step-title')?.textContent?.trim() ?? '',
  classes: e.className,
})));
console.log('  steps in DOM: ' + stepCount);
console.log('  step data:    ' + JSON.stringify(stepData, null, 2));
check('3 steps in DOM', stepCount === 3);
check('all 3 steps show step-success class', stepData.every((s) => s.classes.includes('step-success')));
check('step 1 title contains "List"', stepData.some((s) => /list/i.test(s.title)));
check('step 2 title contains "Write"', stepData.some((s) => /write/i.test(s.title)));
check('step 3 title contains "Summar"', stepData.some((s) => /summar/i.test(s.title)));

const recipeStatusText = await page.$eval('.recipe-status', (el) => el.textContent?.trim() ?? '').catch(() => '');
console.log('  recipe status in DOM: ' + recipeStatusText);
check('Recipe status shows "success"', /success/i.test(recipeStatusText));

await page.screenshot({ path: join(OUT_DIR, 'stage5-recipe-panel.png'), fullPage: false });
console.log('  screenshot: ' + join(OUT_DIR, 'stage5-recipe-panel.png'));

// =============================================================================
// STAGE 6 — SPA — Artifacts panel for the child shows 3 artifacts.
// =============================================================================
console.log('\nSTAGE 6: SPA — Artifacts panel renders 3 artifacts...');
const artifactsBtn = await page.$('button.tab-btn:has-text("Artifacts")');
check('Artifacts tab is present', !!artifactsBtn);
if (artifactsBtn) { await artifactsBtn.click(); await page.waitForTimeout(1500); }

const artRows = await page.$$eval('.art-item', (els) => els.map((e) => ({
  title: e.querySelector('.art-title')?.textContent?.trim()
    ?? e.textContent?.trim()
    ?? '',
})));
console.log('  artifact rows in DOM: ' + artRows.length);
console.log('  titles: ' + JSON.stringify(artRows.map((r) => r.title)));
check('3+ artifact rows in DOM', artRows.length >= 3);
check('Step 1 artifact title visible', artRows.some((r) => /workspace files/i.test(r.title)));
check('Step 2 artifact title visible', artRows.some((r) => /hello/i.test(r.title)));
check('Step 3 artifact title visible', artRows.some((r) => /run summary/i.test(r.title)));

await page.screenshot({ path: join(OUT_DIR, 'stage6-artifacts.png'), fullPage: false });
console.log('  screenshot: ' + join(OUT_DIR, 'stage6-artifacts.png'));

// =============================================================================
// CLEANUP
// =============================================================================
await page.screenshot({ path: join(OUT_DIR, 'final-full.png'), fullPage: true });
await browser.close();
try {
  await fetch(URL + 'api/sessions/' + encodeURIComponent(spawned.instance_id), { method: 'DELETE' });
} catch { /* best effort */ }
// Leave the child session alive so the user can inspect it afterwards.

// =============================================================================
// VERDICT
// =============================================================================
console.log('\n=== FINAL VERDICT ===');
if (FAILURES.length === 0) {
  console.log('PASS - all stages succeeded');
  process.exit(0);
} else {
  console.log('FAIL - ' + FAILURES.length + ' failure(s):');
  for (const f of FAILURES) console.log('   - ' + f);
  process.exit(1);
}
