/**
 * One-shot manual test of the clawdevbox stub.
 *
 *   - Creates a temp workspace, copies samples/plugins/ado into it
 *   - Spawns the server over stdio with CLAWDEVBOX_PROJECT_DIR pointing there
 *   - Runs 10 representative tool calls (see steps below)
 *   - Tears down the workspace
 *
 * Step 10 attempts a real ADO call against the bearer token in
 * `samples/triggers/test/test-config.json`. If the token is expired or absent,
 * step 10 surfaces the error and is reported as informational rather than
 * a hard failure (the structural assertion is "tools/list includes the
 * hostable ado.* tools" — which is independent of network reachability).
 *
 * Run from this directory:
 *   node manual-test.mjs
 *
 * Outputs raw JSON-RPC for each step so the exchange can be pasted into a
 * report.
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const entry = resolve(__dirname, 'src/index.ts');
const repoSampleAdoPlugin = resolve(__dirname, '..', 'samples', 'plugins', 'ado');

const tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-mcp-stub-'));
const clawdevboxDir = join(tmpRoot, '.clawdevbox');
const pluginDest = join(clawdevboxDir, 'plugins', 'ado');
mkdirSync(pluginDest, { recursive: true });
// Copy the ADO plugin in (minus node_modules / lockfiles to keep it fast).
cpSync(repoSampleAdoPlugin, pluginDest, {
  recursive: true,
  filter: (src) =>
    !src.includes('node_modules') &&
    !src.endsWith('package-lock.json') &&
    !src.includes('_legacy-mcp-server'),
});

const globalDir = join(tmpRoot, '.global');
mkdirSync(globalDir, { recursive: true });
const workspacesRoot = join(tmpRoot, '.workspaces');
mkdirSync(workspacesRoot, { recursive: true });
const repoSampleSimplePromptRecipe = resolve(__dirname, '..', 'samples', 'recipes', 'simple-prompt.yaml');

// Junction the Clawdevbox server's node_modules into the temp workspace root
// so the ADO plugin's hostable tools (which `import 'zod'`) resolve via Node's
// default ESM module-resolution walk-up. In a real install, plugin.install
// would `npm install` inside the plugin directory; for this manual harness
// the junction keeps things fast and deterministic.
{
  const wsNodeModules = join(tmpRoot, 'node_modules');
  if (!existsSync(wsNodeModules)) {
    const linkType = platform() === 'win32' ? 'junction' : 'dir';
    symlinkSync(resolve(__dirname, 'node_modules'), wsNodeModules, linkType);
  }
}

// Optional: load the ADO test config (bearer token + PR id) for step 10.
// If absent / unreadable, step 10 falls back to a "no real call" branch.
const testConfigPath = resolve(__dirname, '..', 'samples', 'triggers', 'test', 'test-config.json');
let adoTestConfig = null;
try {
  adoTestConfig = JSON.parse(readFileSync(testConfigPath, 'utf8'));
} catch {
  // Leave null — step 10 will report "no test config; skipping real ADO call".
}

let allPassed = true;
const assertions = [];

function recordAssertion(label, ok, detail) {
  assertions.push({ label, ok, detail });
  if (!ok) allPassed = false;
}

const env = {
  ...process.env,
  CLAWDEVBOX_PROJECT_DIR: tmpRoot,
  CLAWDEVBOX_GLOBAL_DIR: globalDir,
  CLAWDEVBOX_WORKSPACES_ROOT: workspacesRoot,
  // Hostable tools read these via ctx.env. The test-config has the
  // composite "<org>/<urlencoded project>" form for ADO_ORG.
  ...(adoTestConfig
    ? {
        ADO_ORG: adoTestConfig.trigger_ado_org ?? adoTestConfig.org ?? '',
        ADO_PROJECT: adoTestConfig.project ?? '',
        ADO_BEARER_TOKEN: adoTestConfig.ado_bearer_token ?? '',
      }
    : {}),
};

const child = spawn('npx', ['tsx', entry], {
  cwd: __dirname,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

let stdoutBuf = '';
const responses = [];
child.stdout.on('data', (d) => {
  stdoutBuf += d.toString('utf8');
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      process.stderr.write(`[non-JSON stdout] ${line}\n`);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server-stderr] ${d}`));
child.on('error', (e) => { console.error('spawn error:', e); cleanupAndExit(1); });

function cleanupAndExit(code) {
  try {
    child.kill('SIGTERM');
  } catch {}
  try {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

function waitForResponse(id, timeoutMs = 30000) {
  return new Promise((resolveP, rejectP) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const found = responses.find((r) => r.id === id);
      if (found) return resolveP(found);
      if (Date.now() > deadline) return rejectP(new Error(`timeout waiting for id=${id}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function send(obj) {
  const line = JSON.stringify(obj) + '\n';
  process.stdout.write(`>>> ${line}`);
  child.stdin.write(line);
}

function header(step, title) {
  process.stdout.write(`\n============================================================\n`);
  process.stdout.write(`STEP ${step}: ${title}\n`);
  process.stdout.write(`============================================================\n`);
}

async function call(id, name, args) {
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return waitForResponse(id);
}

async function main() {
  // Give the server a moment to come up
  await new Promise((r) => setTimeout(r, 1500));

  // Initialize
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'manual-test', version: '0' },
  }});
  const init = await waitForResponse(1);
  process.stdout.write(`<<< initialize result:\n${JSON.stringify(init, null, 2)}\n`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  // Step 1: tools/list
  header(1, 'tools/list — must register 30+ tools (built-ins + hosted plugin tools)');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listResp = await waitForResponse(2);
  const toolNames = (listResp.result?.tools ?? []).map((t) => t.name).sort();
  process.stdout.write(`<<< tool count=${toolNames.length}\n`);
  process.stdout.write(`<<< tools=${JSON.stringify(toolNames, null, 2)}\n`);
  recordAssertion(
    'step 1: tools/list returns >= 30 tools',
    toolNames.length >= 30,
    `count=${toolNames.length}`,
  );

  // Step 2: recipe.list scope=plugin:ado — expect 2 recipes
  header(2, "recipe.list scope='plugin:ado' — expect 2 recipes");
  const r2 = await call(3, 'recipe.list', { scope: 'plugin:ado' });
  process.stdout.write(`<<< recipe.list result:\n${JSON.stringify(r2.result, null, 2)}\n`);
  const recipes2 = r2.result?.structuredContent?.recipes ?? [];
  recordAssertion(
    "step 2: plugin:ado has 2 recipes",
    recipes2.length === 2 && recipes2.every((r) => r.scope === 'plugin:ado'),
    `recipes=${recipes2.map((r) => r.id).join(',')}`,
  );

  // Step 3: recipe.read pr-review — should resolve to plugin:ado
  header(3, "recipe.read pr-review — should resolve via plugin:ado");
  const r3 = await call(4, 'recipe.read', { id: 'pr-review' });
  process.stdout.write(`<<< recipe.read result:\n${JSON.stringify(r3.result, null, 2).slice(0, 1500)}...\n`);
  const scope3 = r3.result?.structuredContent?.scope;
  recordAssertion(
    "step 3: pr-review resolves to plugin:ado",
    scope3 === 'plugin:ado',
    `scope=${scope3}`,
  );

  // Step 4: recipe.upsert pr-review @ project — write a project shadow
  header(4, "recipe.upsert pr-review scope='project' — writes shadow");
  const projectShadow = [
    'id: pr-review',
    'name: "PR Review (project shadow)"',
    'description: "Project override of the plugin recipe — adds an accessibility step."',
    'kind: pr_review',
    'default_client: claude',
    'mcp_servers:',
    '  - ado',
    '  - clawdevbox',
    'timeout_minutes: 0',
    'steps:',
    '  - id: 1',
    '    goal: "Read the PR + check accessibility before classifying."',
    '  - id: 2',
    '    goal: "Classify changes and surface risks."',
    '    depends: [1]',
  ].join('\n');
  const r4 = await call(5, 'recipe.upsert', {
    id: 'pr-review',
    scope: 'project',
    source: projectShadow,
  });
  process.stdout.write(`<<< recipe.upsert result:\n${JSON.stringify(r4.result, null, 2)}\n`);
  recordAssertion(
    "step 4: upsert pr-review to project succeeds",
    r4.result && !r4.result.isError,
    `path=${r4.result?.structuredContent?.path ?? 'n/a'}`,
  );

  // Step 5: recipe.read pr-review — now project should shadow
  header(5, 'recipe.read pr-review — should now return project scope (shadowing)');
  const r5 = await call(6, 'recipe.read', { id: 'pr-review' });
  process.stdout.write(`<<< recipe.read result:\n${JSON.stringify(r5.result, null, 2).slice(0, 1500)}...\n`);
  const scope5 = r5.result?.structuredContent?.scope;
  const nameFromBody = r5.result?.structuredContent?.parsed?.name;
  recordAssertion(
    "step 5: pr-review now resolves to project (shadowing works)",
    scope5 === 'project' && nameFromBody === 'PR Review (project shadow)',
    `scope=${scope5}, name=${nameFromBody}`,
  );

  // Step 6: recipe.upsert to plugin scope — must fail with PLUGIN_SCOPE_READONLY
  header(6, "recipe.upsert foo scope='plugin:ado' — must fail PLUGIN_SCOPE_READONLY");
  const r6 = await call(7, 'recipe.upsert', {
    id: 'foo',
    scope: 'plugin:ado',
    source: 'id: foo\nname: foo\ndescription: x\n',
  });
  process.stdout.write(`<<< recipe.upsert result:\n${JSON.stringify(r6.result, null, 2)}\n`);
  const code6 = r6.result?.structuredContent?.code;
  recordAssertion(
    "step 6: plugin scope write rejected with PLUGIN_SCOPE_READONLY",
    r6.result?.isError === true && code6 === 'PLUGIN_SCOPE_READONLY',
    `isError=${r6.result?.isError}, code=${code6}`,
  );

  // Step 7: plugin.list — must include the ADO plugin
  header(7, 'plugin.list — should include the ADO plugin');
  const r7 = await call(8, 'plugin.list', {});
  process.stdout.write(`<<< plugin.list result:\n${JSON.stringify(r7.result, null, 2)}\n`);
  const plugins7 = r7.result?.structuredContent?.plugins ?? [];
  recordAssertion(
    "step 7: plugin.list shows ado plugin",
    plugins7.some((p) => p.id === 'ado' && p.status === 'enabled'),
    `plugins=${plugins7.map((p) => `${p.id}:${p.status}`).join(',')}`,
  );

  // Step 8: cleanup — delete project shadow, confirm pr-review reverts to plugin
  header(8, "recipe.delete pr-review scope='project' — revert to plugin");
  const r8 = await call(9, 'recipe.delete', { id: 'pr-review', scope: 'project' });
  process.stdout.write(`<<< recipe.delete result:\n${JSON.stringify(r8.result, null, 2)}\n`);
  const r8b = await call(10, 'recipe.read', { id: 'pr-review' });
  process.stdout.write(`<<< recipe.read after delete:\n${JSON.stringify(r8b.result, null, 2).slice(0, 800)}...\n`);
  const scope8 = r8b.result?.structuredContent?.scope;
  recordAssertion(
    "step 8: deleting project copy reverts to plugin version",
    !r8.result?.isError && scope8 === 'plugin:ado',
    `delete-isError=${r8.result?.isError}, scope-after=${scope8}`,
  );

  // Step 9: tools/list — must surface the ADO plugin's hostable tools alongside
  // the built-in clawdevbox.* surface (recipe.*, skill.*, trigger.*, etc.).
  header(9, 'tools/list — should now include the hosted ado.* tools');
  send({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} });
  const r9 = await waitForResponse(11);
  const allTools = (r9.result?.tools ?? []).map((t) => t.name).sort();
  const adoTools = allTools.filter((n) => n.startsWith('ado.'));
  process.stdout.write(`<<< total tools=${allTools.length}; ado.* tools=${JSON.stringify(adoTools)}\n`);
  const expectedAdo = [
    'ado.comment_pr',
    'ado.get_pr',
    'ado.get_pr_status',
    'ado.list_iterations',
    'ado.list_pr_comments',
  ];
  recordAssertion(
    'step 9: tools/list registers all 5 hostable ado.* tools',
    expectedAdo.every((n) => adoTools.includes(n)),
    `expected=${expectedAdo.join(',')}; got=${adoTools.join(',')}`,
  );

  // Step 10: ado.list_pr_comments against a real ADO PR (test config in
  // samples/triggers/test/test-config.json). Token may be expired — when it is,
  // we report the structured ADO_HTTP_ERROR but don't fail the suite (the
  // structural test in step 9 is the load-bearing one).
  header(10, "tools/call ado.list_pr_comments — real ADO call");
  if (!adoTestConfig) {
    process.stdout.write('<<< no test-config.json found; skipping real ADO call\n');
    recordAssertion(
      'step 10: real ADO call (skipped — no test config)',
      true,
      'no test config; skipped without failing',
    );
  } else {
    const r10 = await call(12, 'ado.list_pr_comments', {
      repo: adoTestConfig.repo,
      pr_id: adoTestConfig.pr_id,
    });
    process.stdout.write(`<<< ado.list_pr_comments result:\n${JSON.stringify(r10.result, null, 2).slice(0, 2000)}...\n`);
    if (r10.result?.isError) {
      const code = r10.result?.structuredContent?.code ?? 'UNKNOWN';
      const msg = r10.result?.structuredContent?.message ?? '';
      process.stdout.write(`<<< tool returned isError; code=${code}\n`);
      // Token expired (401) is a known acceptable outcome — refresh via
      // `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`
      // and update test-config.json. We mark the assertion as informational.
      recordAssertion(
        'step 10: real ADO call returned a structured error (informational)',
        typeof code === 'string' && code.length > 0,
        `code=${code}, msg=${msg.slice(0, 200)}`,
      );
    } else {
      const count = r10.result?.structuredContent?.count ?? 0;
      recordAssertion(
        'step 10: real ADO call succeeded',
        typeof count === 'number',
        `comments_count=${count}`,
      );
    }
  }

  // Step 11: trigger.list_types — expect 3 types from plugin:ado
  header(11, "trigger.list_types scope='plugin:ado' — expect 3 trigger types");
  const r11 = await call(13, 'trigger.list_types', { scope: 'plugin:ado' });
  process.stdout.write(`<<< trigger.list_types result:\n${JSON.stringify(r11.result, null, 2).slice(0, 2000)}...\n`);
  const types11 = r11.result?.structuredContent?.trigger_types ?? [];
  const typeIds11 = types11.map((t) => t.id).sort();
  recordAssertion(
    'step 11: plugin:ado declares the 3 expected trigger types',
    typeIds11.length === 3 &&
      typeIds11.includes('ado.new-pr-watcher') &&
      typeIds11.includes('ado.comment-watcher') &&
      typeIds11.includes('ado.pr-pulse-watcher'),
    `types=${typeIds11.join(',')}`,
  );

  // Step 12: trigger.register ado.new-pr-watcher — identity_param=repo
  header(12, "trigger.register ado.new-pr-watcher { repo: 'auth-svc' }");
  const r12 = await call(14, 'trigger.register', {
    type_id: 'ado.new-pr-watcher',
    params: { repo: 'auth-svc' },
  });
  process.stdout.write(`<<< trigger.register result:\n${JSON.stringify(r12.result, null, 2)}\n`);
  recordAssertion(
    "step 12: trigger.register mints id 'ado.new-pr-watcher#auth-svc'",
    !r12.result?.isError && r12.result?.structuredContent?.id === 'ado.new-pr-watcher#auth-svc',
    `id=${r12.result?.structuredContent?.id}`,
  );

  // Step 13: trigger.register ado.comment-watcher with cron=false (webhook-only)
  header(13, "trigger.register ado.comment-watcher with cron=false (webhook-only)");
  const r13 = await call(15, 'trigger.register', {
    type_id: 'ado.comment-watcher',
    params: { repo: 'auth-svc', pr_id: 2401 },
    subscriber_thread_id: 'thr_test',
    cron: false,
  });
  process.stdout.write(`<<< trigger.register result:\n${JSON.stringify(r13.result, null, 2)}\n`);
  const reg13 = r13.result?.structuredContent?.registered;
  recordAssertion(
    "step 13: comment-watcher registered with cron=false (webhook-only)",
    !r13.result?.isError &&
      r13.result?.structuredContent?.id === 'ado.comment-watcher#2401' &&
      reg13?.cron === false &&
      reg13?.resolved_cron === false,
    `id=${r13.result?.structuredContent?.id}, cron=${reg13?.cron}, resolved=${reg13?.resolved_cron}`,
  );

  // Step 14: trigger.list_registered — expect 2 entries
  header(14, 'trigger.list_registered — expect 2 entries');
  const r14 = await call(16, 'trigger.list_registered', {});
  process.stdout.write(`<<< trigger.list_registered result:\n${JSON.stringify(r14.result, null, 2)}\n`);
  const registered14 = r14.result?.structuredContent?.registered ?? [];
  recordAssertion(
    'step 14: list_registered returns 2 entries',
    registered14.length === 2,
    `count=${registered14.length}; ids=${registered14.map((r) => r.id).join(',')}`,
  );

  // Step 15: trigger.update_params — override cron
  header(15, "trigger.update_params ado.new-pr-watcher#auth-svc cron='* * * * *'");
  const r15 = await call(17, 'trigger.update_params', {
    id: 'ado.new-pr-watcher#auth-svc',
    cron: '* * * * *',
  });
  process.stdout.write(`<<< trigger.update_params result:\n${JSON.stringify(r15.result, null, 2)}\n`);
  recordAssertion(
    "step 15: cron updated to '* * * * *'",
    !r15.result?.isError &&
      r15.result?.structuredContent?.registered?.cron === '* * * * *' &&
      r15.result?.structuredContent?.registered?.resolved_cron === '* * * * *',
    `cron=${r15.result?.structuredContent?.registered?.cron}`,
  );

  // Step 16: trigger.register collision — fails with TRIGGER_ALREADY_REGISTERED
  header(16, "trigger.register collision — must fail TRIGGER_ALREADY_REGISTERED");
  const r16 = await call(18, 'trigger.register', {
    type_id: 'ado.new-pr-watcher',
    params: { repo: 'auth-svc' },
  });
  process.stdout.write(`<<< trigger.register result:\n${JSON.stringify(r16.result, null, 2)}\n`);
  recordAssertion(
    'step 16: collision rejected with TRIGGER_ALREADY_REGISTERED',
    r16.result?.isError === true &&
      r16.result?.structuredContent?.code === 'TRIGGER_ALREADY_REGISTERED',
    `isError=${r16.result?.isError}, code=${r16.result?.structuredContent?.code}`,
  );

  // Step 17: trigger.register missing required param — fails with PARAM_VALIDATION
  header(17, "trigger.register missing required param — must fail PARAM_VALIDATION");
  const r17 = await call(19, 'trigger.register', {
    type_id: 'ado.new-pr-watcher',
    params: {},
  });
  process.stdout.write(`<<< trigger.register result:\n${JSON.stringify(r17.result, null, 2)}\n`);
  recordAssertion(
    'step 17: missing required param rejected with PARAM_VALIDATION',
    r17.result?.isError === true &&
      r17.result?.structuredContent?.code === 'PARAM_VALIDATION' &&
      (r17.result?.structuredContent?.errors ?? []).some((e) => e.path === 'params.repo'),
    `code=${r17.result?.structuredContent?.code}`,
  );

  // Step 18: trigger.disable — enabled flips to false
  header(18, "trigger.disable ado.new-pr-watcher#auth-svc");
  const r18 = await call(20, 'trigger.disable', { id: 'ado.new-pr-watcher#auth-svc' });
  process.stdout.write(`<<< trigger.disable result:\n${JSON.stringify(r18.result, null, 2)}\n`);
  recordAssertion(
    'step 18: trigger disabled (enabled=false)',
    !r18.result?.isError && r18.result?.structuredContent?.enabled === false,
    `enabled=${r18.result?.structuredContent?.enabled}`,
  );

  // Step 19: trigger.unregister ado.new-pr-watcher#auth-svc
  header(19, "trigger.unregister ado.new-pr-watcher#auth-svc");
  const r19 = await call(21, 'trigger.unregister', { id: 'ado.new-pr-watcher#auth-svc' });
  process.stdout.write(`<<< trigger.unregister result:\n${JSON.stringify(r19.result, null, 2)}\n`);
  recordAssertion(
    'step 19: unregister succeeds',
    !r19.result?.isError && r19.result?.structuredContent?.removed === 1,
    `removed=${r19.result?.structuredContent?.removed}`,
  );

  // Step 20: trigger.unregister ado.comment-watcher#2401 (cleanup)
  header(20, "trigger.unregister ado.comment-watcher#2401 (cleanup)");
  const r20 = await call(22, 'trigger.unregister', { id: 'ado.comment-watcher#2401' });
  process.stdout.write(`<<< trigger.unregister result:\n${JSON.stringify(r20.result, null, 2)}\n`);
  recordAssertion(
    'step 20: cleanup unregister succeeds',
    !r20.result?.isError && r20.result?.structuredContent?.removed === 1,
    `removed=${r20.result?.structuredContent?.removed}`,
  );

  // Step 21: Drop simple-prompt.yaml into the test workspace's project scope
  header(21, 'install simple-prompt recipe into project scope');
  const projectRecipesDir = join(tmpRoot, '.clawdevbox', 'recipes');
  mkdirSync(projectRecipesDir, { recursive: true });
  cpSync(repoSampleSimplePromptRecipe, join(projectRecipesDir, 'simple-prompt.yaml'));
  recordAssertion(
    'step 21: simple-prompt.yaml present in project scope',
    existsSync(join(projectRecipesDir, 'simple-prompt.yaml')),
    `recipe at ${join(projectRecipesDir, 'simple-prompt.yaml')}`,
  );

  // Step 22: workspace.create — scaffold a fresh workspace
  header(22, "workspace.create { name: 'test-ws' } — verify .clawdevbox tree + registry");
  const r22 = await call(23, 'workspace.create', { name: 'test-ws', inherit_plugins: false });
  process.stdout.write(`<<< workspace.create result:\n${JSON.stringify(r22.result, null, 2)}\n`);
  const ws22 = r22.result?.structuredContent;
  const expectedSubdirs = ['recipes', 'skills', 'plugins', 'recipe-instances'];
  const allSubdirsExist =
    ws22?.path &&
    expectedSubdirs.every((s) => existsSync(join(ws22.path, '.clawdevbox', s))) &&
    existsSync(join(ws22.path, '.clawdevbox', 'triggers.json')) &&
    existsSync(join(ws22.path, '.clawdevbox', 'workspace.json'));
  const indexExists = existsSync(join(workspacesRoot, 'index.json'));
  recordAssertion(
    "step 22: workspace.create scaffolds dirs and registers in index",
    !r22.result?.isError &&
      typeof ws22?.id === 'string' &&
      ws22.id.startsWith('ws_') &&
      allSubdirsExist &&
      indexExists,
    `id=${ws22?.id}, path=${ws22?.path}, subdirs_ok=${allSubdirsExist}, index_exists=${indexExists}`,
  );

  // Step 23: workspace.list — must include the new workspace
  header(23, 'workspace.list — should include the created workspace');
  const r23 = await call(24, 'workspace.list', {});
  process.stdout.write(`<<< workspace.list result:\n${JSON.stringify(r23.result, null, 2)}\n`);
  const wsList23 = r23.result?.structuredContent?.workspaces ?? [];
  recordAssertion(
    'step 23: workspace.list includes new workspace',
    wsList23.some((w) => w.id === ws22?.id),
    `count=${wsList23.length}; ids=${wsList23.map((w) => w.id).join(',')}`,
  );

  // Step 24: workspace.current — caller dir is NOT registered → expect found:false
  header(24, 'workspace.current — caller dir is not in registry, expect found:false');
  const r24 = await call(25, 'workspace.current', {});
  process.stdout.write(`<<< workspace.current result:\n${JSON.stringify(r24.result, null, 2)}\n`);
  recordAssertion(
    'step 24: workspace.current returns found:false for unregistered caller dir',
    !r24.result?.isError && r24.result?.structuredContent?.found === false,
    `found=${r24.result?.structuredContent?.found}`,
  );

  // Step 25: recipe.run echo-stub — creates a NEW workspace + instance file
  header(25, "recipe.run { id: 'simple-prompt', agent_cli: 'echo-stub' } — fresh workspace + instance");
  const r25 = await call(26, 'recipe.run', {
    id: 'simple-prompt',
    prompt: 'Say hello',
    agent_cli: 'echo-stub',
  });
  process.stdout.write(`<<< recipe.run result:\n${JSON.stringify(r25.result, null, 2)}\n`);
  const run25 = r25.result?.structuredContent;
  const mcpJsonExists = run25?.workspace_path && existsSync(join(run25.workspace_path, '.mcp.json'));
  let mcpJsonValid = false;
  if (mcpJsonExists) {
    try {
      const cfg = JSON.parse(readFileSync(join(run25.workspace_path, '.mcp.json'), 'utf8'));
      const e = cfg.mcpServers?.clawdevbox?.env;
      mcpJsonValid =
        e?.CLAWDEVBOX_PROJECT_DIR === run25.workspace_path &&
        e?.CLAWDEVBOX_RECIPE_INSTANCE_ID === run25.recipe_instance_id &&
        e?.CLAWDEVBOX_WORKSPACE_ID === run25.workspace_id;
    } catch {
      mcpJsonValid = false;
    }
  }
  const instancePath25 =
    run25?.workspace_path &&
    join(run25.workspace_path, '.clawdevbox', 'recipe-instances', `${run25.recipe_instance_id}.json`);
  let instanceValid = false;
  if (instancePath25 && existsSync(instancePath25)) {
    try {
      const inst = JSON.parse(readFileSync(instancePath25, 'utf8'));
      instanceValid = inst.status === 'running' && inst.recipe_id === 'simple-prompt';
    } catch {
      instanceValid = false;
    }
  }
  const newWorkspace = run25?.workspace_id && run25.workspace_id !== ws22?.id;
  recordAssertion(
    'step 25: recipe.run creates new workspace + instance + .mcp.json',
    !r25.result?.isError &&
      run25?.status === 'spawned' &&
      typeof run25?.pid === 'number' &&
      run25.pid > 0 &&
      newWorkspace &&
      mcpJsonValid &&
      instanceValid,
    `instance=${run25?.recipe_instance_id}, ws=${run25?.workspace_id}, pid=${run25?.pid}, mcp_ok=${mcpJsonValid}, inst_ok=${instanceValid}`,
  );

  // Step 26: recipe.run with workspace_id — must reuse, mint new instance
  header(26, "recipe.run with workspace_id — reuse workspace, new instance");
  const r26 = await call(27, 'recipe.run', {
    id: 'simple-prompt',
    prompt: 'second call',
    workspace_id: run25?.workspace_id,
    agent_cli: 'echo-stub',
  });
  process.stdout.write(`<<< recipe.run result:\n${JSON.stringify(r26.result, null, 2)}\n`);
  const run26 = r26.result?.structuredContent;
  recordAssertion(
    'step 26: recipe.run reuses workspace, mints new instance id',
    !r26.result?.isError &&
      run26?.workspace_id === run25?.workspace_id &&
      run26?.recipe_instance_id !== run25?.recipe_instance_id,
    `ws_id=${run26?.workspace_id}, instance=${run26?.recipe_instance_id}`,
  );

  // Step 27: simulate the spawned agent calling recipe.done — separate child MCP
  header(27, 'recipe.done from a separate MCP child with instance/workspace env vars');
  const doneChild = spawn('npx', ['tsx', entry], {
    cwd: __dirname,
    env: {
      ...process.env,
      CLAWDEVBOX_PROJECT_DIR: run25?.workspace_path,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
      CLAWDEVBOX_WORKSPACES_ROOT: workspacesRoot,
      CLAWDEVBOX_RECIPE_INSTANCE_ID: run25?.recipe_instance_id,
      CLAWDEVBOX_WORKSPACE_ID: run25?.workspace_id,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  let doneBuf = '';
  const doneResponses = [];
  doneChild.stdout.on('data', (d) => {
    doneBuf += d.toString('utf8');
    let nl;
    while ((nl = doneBuf.indexOf('\n')) >= 0) {
      const line = doneBuf.slice(0, nl).trim();
      doneBuf = doneBuf.slice(nl + 1);
      if (!line) continue;
      try { doneResponses.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  doneChild.stderr.on('data', (d) => process.stderr.write(`[done-child-stderr] ${d}`));
  const waitDone = (id, timeoutMs = 15000) => new Promise((resolveP, rejectP) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const f = doneResponses.find((r) => r.id === id);
      if (f) return resolveP(f);
      if (Date.now() > deadline) return rejectP(new Error(`timeout id=${id}`));
      setTimeout(tick, 50);
    };
    tick();
  });
  let doneOk = false;
  let doneDetail = '';
  try {
    await new Promise((r) => setTimeout(r, 1500));
    doneChild.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'done', version: '0' } },
    }) + '\n');
    await waitDone(1);
    doneChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    doneChild.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'recipe.done',
        arguments: { status: 'success', message: 'manual-test done', result: { ok: true } },
      },
    }) + '\n');
    const dr = await waitDone(2);
    process.stdout.write(`<<< recipe.done result:\n${JSON.stringify(dr.result, null, 2)}\n`);
    // Verify on-disk instance file is updated.
    if (instancePath25 && existsSync(instancePath25)) {
      const inst = JSON.parse(readFileSync(instancePath25, 'utf8'));
      doneOk =
        !dr.result?.isError &&
        inst.status === 'success' &&
        typeof inst.completed_at === 'number' &&
        inst.completed_at > 0;
      doneDetail = `status=${inst.status}, completed_at=${inst.completed_at}`;
    } else {
      doneDetail = 'instance file missing';
    }
  } catch (e) {
    doneDetail = `error: ${e.message}`;
  } finally {
    try { doneChild.kill('SIGTERM'); } catch { /* ignore */ }
  }
  recordAssertion(
    'step 27: recipe.done updates instance file to status=success',
    doneOk,
    doneDetail,
  );

  // Step 28: recipe.instance_info — round-trip the completed instance
  header(28, 'recipe.instance_info — verify completed status');
  const r28 = await call(28, 'recipe.instance_info', { id: run25?.recipe_instance_id });
  process.stdout.write(`<<< recipe.instance_info result:\n${JSON.stringify(r28.result, null, 2)}\n`);
  const inst28 = r28.result?.structuredContent;
  recordAssertion(
    'step 28: recipe.instance_info returns the updated instance',
    !r28.result?.isError &&
      inst28?.recipe_instance_id === run25?.recipe_instance_id &&
      inst28?.status === 'success' &&
      inst28?.message === 'manual-test done',
    `status=${inst28?.status}, message=${inst28?.message}`,
  );

  // Summary
  process.stdout.write(`\n============================================================\n`);
  process.stdout.write(`SUMMARY (${assertions.filter((a) => a.ok).length}/${assertions.length} passed)\n`);
  process.stdout.write(`============================================================\n`);
  for (const a of assertions) {
    process.stdout.write(`  [${a.ok ? 'PASS' : 'FAIL'}] ${a.label}\n          ${a.detail}\n`);
  }

  cleanupAndExit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL:', err);
  cleanupAndExit(1);
});
