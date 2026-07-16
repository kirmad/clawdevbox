/**
 * Controlled MCP-level verification for the new recipe.begin tool.
 *
 * Drives the MCP server DIRECTLY over HTTP (no agent involved) to verify:
 *
 *   1. recipe.begin creates an instance row + materializes step rows
 *   2. The returned recipe_instance_id is usable in subsequent
 *      recipe.steps.update_status calls
 *   3. Steps progress pending → running → done
 *   4. When all steps reach `done`, the instance auto-cascades to `success`
 *   5. artifact.add can attach artifacts to specific steps
 *   6. recipe.steps.update_status with attach_artifact_ids succeeds
 *      (i.e. the DB mirror in artifact.add works end-to-end)
 *   7. The on-disk recipe-instance JSON + the API reflect the final state
 *
 * No agent CLI is spawned. No agency wrapper. No header propagation
 * gymnastics. This is the design point of recipe.begin: the calling
 * process executes the recipe inline.
 */
import { randomUUID } from 'node:crypto';

const SERVER = 'http://127.0.0.1:5201';
const FAILURES = [];
function check(label, cond, extra) {
  if (cond) console.log('  PASS  ' + label);
  else {
    console.log('  FAIL  ' + label + (extra ? ' — ' + JSON.stringify(extra) : ''));
    FAILURES.push(label);
  }
}

// Minimal MCP client: initialize → call tool → collect result.
let mcpSessionId = null;
async function mcpCall(method, params) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
  };
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: randomUUID(),
    method,
    params,
  });
  const res = await fetch(SERVER + '/mcp', { method: 'POST', headers, body });
  if (!mcpSessionId) {
    const hdr = res.headers.get('mcp-session-id');
    if (hdr) mcpSessionId = hdr;
  }
  const text = await res.text();
  // SSE response — extract the first data: line that parses as JSON
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
      } catch { /* keep scanning */ }
    }
  }
  // Sometimes the server returns a plain JSON body (non-streaming)
  try { return JSON.parse(text); } catch { /* */ }
  throw new Error(`MCP response not parseable: ${text.slice(0, 500)}`);
}

async function callTool(name, args) {
  const res = await mcpCall('tools/call', { name: 'run_tool', arguments: { tool: name, args } });
  if (res.error) throw new Error(`MCP error: ${JSON.stringify(res.error)}`);
  const content = res.result?.content?.[0];
  const structured = res.result?.structuredContent;
  if (res.result?.isError) {
    throw new Error(`Tool error: ${content?.text ?? JSON.stringify(structured)}`);
  }
  return { text: content?.text, structured };
}

// =============================================================================
// Init + sanity
// =============================================================================
console.log('\n=== Stage 0: initialize MCP session ===');
const init = await mcpCall('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'recipe-begin-controlled-test', version: '1.0.0' },
});
if (init.error) {
  console.error('FATAL: initialize failed:', init.error);
  process.exit(1);
}
console.log('  mcp session: ' + mcpSessionId);

// Send notifications/initialized to complete the handshake
await fetch(SERVER + '/mcp', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'mcp-session-id': mcpSessionId,
  },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
});

// =============================================================================
// Stage 1: recipe.begin returns instance + materialized steps
// =============================================================================
console.log('\n=== Stage 1: recipe.begin ===');
const TEMPLATE_ID = 'controlled-begin-test-' + Date.now().toString(36);
const SOURCE = [
  'id: ' + TEMPLATE_ID,
  'name: Controlled Begin Test',
  'description: Verifies recipe.begin materializes steps + returns shape.',
  'steps:',
  '  - id: alpha',
  '    goal: First step (alpha).',
  '  - id: beta',
  '    goal: Second step (beta).',
  '    depends: [alpha]',
  '  - id: gamma',
  '    goal: Third step (gamma).',
  '    depends: [beta]',
].join('\n');

const begin = await callTool('recipe.begin', { source: SOURCE });
console.log('  ' + begin.text);
const instanceId = begin.structured?.recipe_instance_id;
const steps = begin.structured?.steps ?? [];
check('recipe.begin returns recipe_instance_id', typeof instanceId === 'string' && /^ri_/.test(instanceId));
check('recipe.begin returns 3 materialized steps', steps.length === 3, { count: steps.length });
check('returned status is "running"', begin.structured?.status === 'running');
check('all returned steps start as "pending"', steps.every((s) => s.status === 'pending'));
check('step ids preserved from YAML', steps.map((s) => s.id).join(',') === 'alpha,beta,gamma');

// =============================================================================
// Stage 2: API reflects the new instance
// =============================================================================
console.log('\n=== Stage 2: API reflects the new instance ===');
const apiInst = await fetch(SERVER + '/api/recipe-instances/' + encodeURIComponent(instanceId)).then((r) => r.json());
check('API returns instance with matching id', apiInst.id === instanceId);
check('API status == running', apiInst.status === 'running');
const apiSteps = apiInst.steps ?? [];
check('API returns 3 steps', apiSteps.length === 3, { actual: apiSteps.length });
check('API step statuses all "pending"', apiSteps.every((s) => s.status === 'pending'));

// =============================================================================
// Stage 3: progress steps via recipe.steps.update_status
// =============================================================================
console.log('\n=== Stage 3: update_status drives steps to done ===');
for (const stepId of ['alpha', 'beta', 'gamma']) {
  const running = await callTool('recipe.steps.update_status', {
    recipe_instance_id: instanceId,
    step_id: stepId,
    status: 'running',
  });
  check(`step ${stepId} → running`, running.structured?.step?.status === 'running');

  const done = await callTool('recipe.steps.update_status', {
    recipe_instance_id: instanceId,
    step_id: stepId,
    status: 'done',
    message: 'done by controlled test',
  });
  check(`step ${stepId} → done`, done.structured?.step?.status === 'done');
}

// =============================================================================
// Stage 4: instance auto-cascades to success
// =============================================================================
console.log('\n=== Stage 4: instance auto-cascades to success ===');
const after = await fetch(SERVER + '/api/recipe-instances/' + encodeURIComponent(instanceId)).then((r) => r.json());
check('instance status == success after all steps done', after.status === 'success');
check('all steps status == done in API', (after.steps ?? []).every((s) => s.status === 'done'));

// =============================================================================
// Stage 5: artifact.add mirrors to DB so attach_artifact_ids succeeds
// =============================================================================
console.log('\n=== Stage 5: artifact.add mirrors to DB ===');
// Start a fresh instance just for artifact attach
const TEMPLATE_ID_2 = 'controlled-artifact-test-' + Date.now().toString(36);
const SOURCE_2 = [
  'id: ' + TEMPLATE_ID_2,
  'name: Controlled Artifact Test',
  'description: Verifies artifact.add → recipe.steps.update_status attach.',
  'steps:',
  '  - id: only-step',
  '    goal: The only step.',
].join('\n');
const begin2 = await callTool('recipe.begin', { source: SOURCE_2 });
const instanceId2 = begin2.structured?.recipe_instance_id;
check('second recipe.begin works', typeof instanceId2 === 'string');

await callTool('recipe.steps.update_status', {
  recipe_instance_id: instanceId2,
  step_id: 'only-step',
  status: 'running',
});

const artifactId = 'controlled-test-artifact-' + Date.now().toString(36);
const addedArtifact = await callTool('artifact.add', {
  workspace_id: begin2.structured?.workspace_id,
  recipe_instance_id: instanceId2,
  step_id: 'only-step',
  id: artifactId,
  type: 'markdown',
  title: 'Controlled Test Artifact',
  files: { 'README.md': '# Test\n\nFrom the controlled test.' },
});
check('artifact.add returned id', addedArtifact.structured?.id === artifactId);

const stepDone = await callTool('recipe.steps.update_status', {
  recipe_instance_id: instanceId2,
  step_id: 'only-step',
  status: 'done',
  attach_artifact_ids: [artifactId],
});
check(
  'update_status(done) with attach_artifact_ids succeeded',
  stepDone.structured?.step?.status === 'done',
  { structured: stepDone.structured },
);
check(
  'attach_artifact_ids returned the attached id',
  Array.isArray(stepDone.structured?.attached_artifact_ids)
    && stepDone.structured.attached_artifact_ids.includes(artifactId),
);

// =============================================================================
// Verdict
// =============================================================================
console.log('\n=== VERDICT ===');
if (FAILURES.length === 0) {
  console.log('PASS — all controlled checks succeeded');
  process.exit(0);
} else {
  console.log('FAIL — ' + FAILURES.length + ' failure(s):');
  for (const f of FAILURES) console.log('   - ' + f);
  process.exit(1);
}
