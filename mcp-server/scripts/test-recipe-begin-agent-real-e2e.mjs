/**
 * REAL agent E2E for the recipe.begin / update_status flow.
 *
 * The whole point: ONE agent in ONE session executes a 3-step recipe
 * inline. No spawn-a-child gymnastics. No header propagation. The agent
 * calls recipe.begin to mint the run + materialize steps, then iterates
 * through each step itself using recipe.steps.update_status, with each
 * recipe_instance_id passed explicitly as an arg (returned by begin).
 *
 * Stages:
 *   1. Spawn ONE agent via /spawn with a SHORT prompt instructing the
 *      recipe.begin-iterate-update_status pattern
 *   2. Poll the agent's session for the recipe-instance it created via
 *      recipe.begin (matching by recipe_id from our test template)
 *   3. Poll the instance until it cascades to success/failure
 *   4. Verify: 3 steps all done, 3 artifacts created and attached to steps
 *   5. Open SPA, verify Recipe panel shows 3 ✓ steps and Artifacts panel
 *      shows all 3 artifacts under the SAME agent's session (no separate
 *      child session)
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SERVER = 'http://127.0.0.1:5201/';
const OUT_DIR = process.argv[2] ?? './recipe-begin-agent-e2e';
mkdirSync(OUT_DIR, { recursive: true });

const FAILURES = [];
function check(label, cond, extra) {
  if (cond) console.log('  PASS  ' + label);
  else {
    console.log('  FAIL  ' + label + (extra ? ' — ' + JSON.stringify(extra) : ''));
    FAILURES.push(label);
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// =============================================================================
// Test recipe definition — short, with 3 simple steps
// =============================================================================
const TEMPLATE_ID = 'agent-e2e-begin-test-' + Date.now().toString(36);
const SOURCE = [
  'id: ' + TEMPLATE_ID,
  'name: Agent E2E Begin Test',
  'description: 3-step recipe executed inline by the calling agent (no spawn).',
  'steps:',
  '  - id: list-files',
  '    goal: List top-level files and capture as artifact-1.',
  '  - id: write-hello',
  '    goal: Write hello.txt and capture its contents as artifact-2.',
  '    depends: [list-files]',
  '  - id: report-summary',
  '    goal: Summarize what was done as artifact-3.',
  '    depends: [write-hello]',
].join('\n');

// =============================================================================
// Agent prompt — SHORT. The agent does everything inline.
// No child spawn. No recipe.run. No header gymnastics.
// =============================================================================
const PROMPT = [
  'Execute this 3-step recipe INLINE in your current session — do NOT spawn a child.',
  '',
  '1. Call recipe.begin with this inline source (paste verbatim, including the trailing newline):',
  '',
  JSON.stringify(SOURCE),
  '',
  '   The returned recipe_instance_id is the id you pass to every step call. Remember it.',
  '',
  '2. For EACH of the 3 steps in order (list-files → write-hello → report-summary):',
  '     a. Call recipe.steps.update_status({recipe_instance_id, step_id, status: "running"}).',
  '     b. Do the work the step describes (shell/file tools).',
  '     c. Call artifact.add({workspace_id, recipe_instance_id, id, type: "markdown", title, files: {"README.md": content}}).',
  '     d. Call recipe.steps.update_status({recipe_instance_id, step_id, status: "done", attach_artifact_ids: [<artifact_id>]}).',
  '',
  '   Use these exact ids/titles:',
  '     - list-files     → artifact id "e2e-step1", title "Step 1: Files"',
  '     - write-hello    → artifact id "e2e-step2", title "Step 2: hello.txt"',
  '     - report-summary → artifact id "e2e-step3", title "Step 3: Summary"',
  '',
  '3. The instance auto-cascades to success when all 3 steps are done — no recipe.done call needed.',
  '',
  '4. Reply with exactly: DONE recipe_instance_id=<the id>',
].join('\n');

// =============================================================================
// STAGE 1 — spawn ONE agent with the short prompt
// =============================================================================
console.log('\nSTAGE 1: spawn ONE agent with recipe.begin instructions...');
const testStart = Date.now();
const spawn = await (await fetch(SERVER + 'spawn', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: PROMPT, mode: 'interactive', cli: 'copilot' }),
})).json();
console.log('  agent instance: ' + spawn.instance_id + ', session: ' + spawn.session_id);
check('spawn returned instance_id', !!spawn.instance_id);

// =============================================================================
// STAGE 2 — wait for the agent to call recipe.begin, creating an instance
//          with our 3 specific step ids. The instance's `recipe_id` for
//          inline-source recipes is `__adhoc_<instanceId>` and its `kind`
//          field reports 'adhoc' (not 'recipe'), so we identify by the
//          step_id triplet which is unique enough for this test.
// =============================================================================
console.log('\nSTAGE 2: wait for agent to call recipe.begin...');
const EXPECTED_STEP_IDS = ['list-files', 'write-hello', 'report-summary'];
let recipeInstanceId = null;
const findInstanceDeadline = Date.now() + 240_000;
while (Date.now() < findInstanceDeadline) {
  const r = await fetch(SERVER + 'api/sessions').then((r) => r.json());
  // Candidate recipe-instances are any sessions started after testStart
  // whose recipe_id looks recipe-shaped (saved recipe id OR `__adhoc_*`).
  // We exclude the spawn agent's own adhoc tracking row by instance_id.
  const candidates = (r.items ?? []).filter((s) =>
    typeof s.started_at === 'number'
    && s.started_at >= testStart - 1000
    && s.instance_id !== spawn.instance_id
    && s.instance_id !== 'main'
    && (s.kind === 'recipe' || s.kind === 'adhoc'),
  );
  for (const c of candidates) {
    try {
      const inst = await fetch(SERVER + 'api/recipe-instances/' + encodeURIComponent(c.instance_id)).then((r) => r.json());
      const stepIds = (inst.steps ?? []).map((s) => s.id).sort();
      if (stepIds.length === 3 && EXPECTED_STEP_IDS.every((sid) => stepIds.includes(sid))) {
        recipeInstanceId = c.instance_id;
        const t = Math.floor((Date.now() - testStart) / 1000);
        console.log('  T+' + t + 's: recipe.begin created ' + recipeInstanceId + ' (recipe_id=' + c.recipe_id + ', kind=' + c.kind + ')');
        break;
      }
    } catch { /* keep looking */ }
  }
  if (recipeInstanceId) break;
  await sleep(3000);
}
check('agent called recipe.begin (instance with expected steps appeared)', !!recipeInstanceId);
if (!recipeInstanceId) {
  console.error('FATAL: recipe.begin was not called within 4min.');
  await fetch(SERVER + 'api/sessions/' + encodeURIComponent(spawn.instance_id), { method: 'DELETE' });
  process.exit(1);
}

// =============================================================================
// STAGE 3 — wait for instance to terminal (auto-cascade or explicit fail)
// =============================================================================
console.log('\nSTAGE 3: wait for instance to terminal state...');
const completeDeadline = Date.now() + 600_000;
let finalInst = null;
let lastLog = 0;
while (Date.now() < completeDeadline) {
  const inst = await fetch(SERVER + 'api/recipe-instances/' + encodeURIComponent(recipeInstanceId)).then((r) => r.json());
  if (Date.now() - lastLog > 15_000) {
    const stepStr = (inst.steps ?? []).map((s) => s.id + '=' + s.status).join(', ');
    console.log('  [' + new Date().toISOString().slice(11, 19) + '] inst=' + inst.status + '  steps=[' + stepStr + ']');
    lastLog = Date.now();
  }
  if (inst.status === 'success' || inst.status === 'failure' || inst.status === 'cancelled') {
    finalInst = inst;
    break;
  }
  await sleep(3000);
}
check('instance reached terminal state within 10min', !!finalInst);
if (!finalInst) {
  console.error('FATAL: instance never finished.');
  await fetch(SERVER + 'api/sessions/' + encodeURIComponent(spawn.instance_id), { method: 'DELETE' });
  process.exit(1);
}
check('instance cascaded to success', finalInst.status === 'success', { status: finalInst.status });
const stepStatuses = Object.fromEntries((finalInst.steps ?? []).map((s) => [s.id, s.status]));
console.log('  final step statuses: ' + JSON.stringify(stepStatuses));
check('step "list-files" done', stepStatuses['list-files'] === 'done');
check('step "write-hello" done', stepStatuses['write-hello'] === 'done');
check('step "report-summary" done', stepStatuses['report-summary'] === 'done');

// =============================================================================
// STAGE 4 — verify 3 artifacts were attached to the recipe-instance steps.
//          The /api/sessions/<id>/artifacts endpoint takes a recipe_instance_id
//          (it resolves the workspace from the agent_sessions row bound to
//          that instance) and returns disk-scanned artifacts filtered by
//          recipe_instance_id. We pass the recipeInstanceId from Stage 2.
// =============================================================================
console.log('\nSTAGE 4: verify 3 artifacts on the recipe instance...');
const arts = await fetch(SERVER + 'api/sessions/' + encodeURIComponent(recipeInstanceId) + '/artifacts').then((r) => r.json());
const artList = arts.items ?? arts.artifacts ?? [];
console.log('  artifacts: ' + JSON.stringify(artList.map((a) => a.id)));
check('3+ artifacts on the recipe-instance', artList.length >= 3, { count: artList.length });
check('e2e-step1 artifact present', artList.some((a) => a.id === 'e2e-step1'));
check('e2e-step2 artifact present', artList.some((a) => a.id === 'e2e-step2'));
check('e2e-step3 artifact present', artList.some((a) => a.id === 'e2e-step3'));
check(
  'all 3 artifacts have step attachment (recipe_step_id set)',
  artList.filter((a) => /^e2e-step[1-3]$/.test(a.id)).every((a) => !!a.recipe_step_id),
);

// =============================================================================
// STAGE 5 — SPA reflects everything correctly
// =============================================================================
console.log('\nSTAGE 5: SPA Recipe + Artifacts panels...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(SERVER, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('load');
try { await page.click('text=Terminals', { timeout: 5000 }); } catch { /* already there */ }
await page.waitForSelector('.tab-list', { timeout: 10000 });
await page.waitForTimeout(2000);

const clicked = await page.evaluate((id) => {
  const row = document.querySelector(`.tab-row[data-instance-id="${id}"]`);
  if (!row) return false;
  row.click();
  return true;
}, recipeInstanceId);
check('clicked recipe-instance tab', clicked);
await page.waitForTimeout(1500);

const wasCollapsed = await page.$('.side-collapsed');
if (wasCollapsed) { await page.click('.side-collapsed .bar-btn'); await page.waitForTimeout(500); }
const recipeBtn = await page.$('button.tab-btn:has-text("Recipe")');
check('Recipe tab present on agent session', !!recipeBtn);
if (recipeBtn) { await recipeBtn.click(); await page.waitForTimeout(1500); }

const stepData = await page.$$eval('.step', (els) => els.map((e) => ({
  title: e.querySelector('.step-title')?.textContent?.trim() ?? '',
  classes: e.className,
})));
console.log('  steps in DOM: ' + JSON.stringify(stepData, null, 2));
check('3 steps in DOM', stepData.length === 3, { count: stepData.length });
check('all 3 steps show step-success class', stepData.every((s) => s.classes.includes('step-success')));

await page.screenshot({ path: join(OUT_DIR, 'stage5-recipe-panel.png'), fullPage: false });

const artifactsBtn = await page.$('button.tab-btn:has-text("Artifacts")');
check('Artifacts tab present', !!artifactsBtn);
if (artifactsBtn) { await artifactsBtn.click(); await page.waitForTimeout(1500); }
const artData = await page.$$eval('.art-item', (els) => els.map((e) => ({
  title: e.querySelector('.art-title')?.textContent?.trim() ?? '',
})));
console.log('  artifacts in DOM: ' + JSON.stringify(artData));
check('3+ artifact rows in DOM', artData.length >= 3);
await page.screenshot({ path: join(OUT_DIR, 'stage5-artifacts-panel.png'), fullPage: false });

await browser.close();

// =============================================================================
// CLEANUP
// =============================================================================
try {
  await fetch(SERVER + 'api/sessions/' + encodeURIComponent(spawn.instance_id), { method: 'DELETE' });
} catch { /* best effort */ }

// =============================================================================
// VERDICT
// =============================================================================
console.log('\n=== VERDICT ===');
if (FAILURES.length === 0) {
  console.log('PASS — all stages succeeded');
  process.exit(0);
} else {
  console.log('FAIL — ' + FAILURES.length + ' failure(s):');
  for (const f of FAILURES) console.log('   - ' + f);
  process.exit(1);
}
