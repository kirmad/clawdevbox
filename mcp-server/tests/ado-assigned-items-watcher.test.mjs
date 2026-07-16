// Regression tests for the ado.assigned-items-watcher plugin trigger.
//
// These run the REAL shipped script (plugins/ado/triggers/assigned-items-watcher.js)
// through runTriggerScript with the same TriggerEnvelope-on-stdin contract the
// kernel uses. `az` is stubbed via the CLAWDEVBOX_AZ_BIN seam so the tests are
// deterministic and NEVER touch a real ADO org.
//
// Contract under test (see the `authoring-triggers` skill):
//   - script reads the envelope on stdin,
//   - queries ADO for assigned items,
//   - POSTs a prompt about NEW items (not in state.seen_ids) to spawn_url,
//   - writes an observation file to env.output_dir.
// The original script was authored against a nonexistent function-injection
// API (`export default async function run({params,state,dispatch,log})`), so it
// exited 0 doing nothing — no query, no dispatch, no observation file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = resolve(__dirname, '..', '..', 'plugins', 'ado', 'triggers', 'assigned-items-watcher.js');

async function startReceiver() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: parsed });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/spawn?fire_id=test-abc`,
    calls,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

// Writes a fake `az` that ignores its args and prints the JSON in AZ_FIXTURE.
// Returns a CLAWDEVBOX_AZ_BIN value using the shell-free JSON-array argv seam:
// `["<node>", "<script>"]` is invoked directly by the watcher (no cmd.exe, no
// shim re-parsing) on every platform. This mirrors how the production resolver
// runs the real MSI Azure CLI (`python.exe -IBm azure.cli …`) — a discrete
// executable + argv, never a shell string.
function makeAzStub(dir) {
  const script = join(dir, 'az-stub.mjs');
  writeFileSync(
    script,
    "import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(process.env.AZ_FIXTURE, 'utf8'));\n",
  );
  return JSON.stringify([process.execPath, script]);
}

// Like makeAzStub but captures the EXACT argv (process.argv-level, one element
// per argument) to the file named by env AZ_ARGV_OUT, then prints the JSON in
// AZ_FIXTURE. Lets a test assert that each flag value (`--project`, `--wiql`, …)
// arrives as a single, verbatim argument — i.e. that the watcher passes a
// discrete argv vector, not a shell-interpolated string. Uses the same
// shell-free JSON-array seam.
function makeAzArgvStub(dir) {
  const capture = join(dir, 'az-capture.mjs');
  writeFileSync(
    capture,
    [
      "import { writeFileSync, readFileSync } from 'node:fs';",
      'const argv = process.argv.slice(2);',
      'writeFileSync(process.env.AZ_ARGV_OUT, JSON.stringify(argv));',
      "process.stdout.write(readFileSync(process.env.AZ_FIXTURE, 'utf8'));",
      '',
    ].join('\n'),
  );
  return JSON.stringify([process.execPath, capture]);
}

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function cleanup(...dirs) {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

const baseState = {
  org: 'myorg',
  project: 'myproject',
  assigned_to: 'devuser@example.com',
};

test('manifest: trigger sidecar exposes required params (org, project, assigned_to) to the loader', async () => {
  const { loadPluginFromDir } = await import('../src/manifest/load-plugin.ts');
  const adoDir = resolve(__dirname, '..', '..', 'plugins', 'ado');
  const r = await loadPluginFromDir(adoDir);
  const tt = r.capabilities.triggerTypes.find((t) => t.id === 'ado.assigned-items-watcher');
  assert.ok(tt, 'ado.assigned-items-watcher trigger type must load');
  // The loader only accepts array-form parameters ([{name,type,required?,...}]).
  // An object-map sidecar silently drops the schema (undefined), so required
  // params are never validated at register time.
  assert.ok(Array.isArray(tt.parameters), 'parameters must be an array (loader contract)');
  const byName = Object.fromEntries(tt.parameters.map((p) => [p.name, p]));
  for (const req of ['org', 'project', 'assigned_to']) {
    assert.ok(byName[req], `parameter '${req}' must be present`);
    assert.equal(byName[req].required, true, `parameter '${req}' must be required`);
  }
});

test('watcher: newly-assigned item → POSTs prompt to spawn_url AND writes observation file', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([
    { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'Fix crash' } },
    { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'Old task' } },
  ]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_new',
        output_dir: outDir, spawn_url: recv.url,
        // #456 was seen last fire; #123 is genuinely new.
        state: { ...baseState, seen_ids: ['456'] },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    // Exactly one dispatch, for the NEW item only.
    assert.equal(recv.calls.length, 1, 'expected exactly one spawn POST');
    assert.match(recv.calls[0].body.prompt, /#123/);
    assert.doesNotMatch(recv.calls[0].body.prompt, /#456/);
    assert.equal(recv.calls[0].auth, 'Bearer test-secret');
    // Observation file persisted for the operator.
    const obsPath = join(outDir, 'observation.json');
    assert.ok(existsSync(obsPath), 'observation.json must be written to output_dir');
    const obs = JSON.parse(readFileSync(obsPath, 'utf8'));
    assert.equal(obs.total, 2);
    assert.equal(obs.new_count, 1);
    assert.deepEqual(obs.new_ids, ['123']);
    assert.equal(obs.dispatched, true);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher: no new items (all seen) → no dispatch, still writes observation file', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([
    { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'Fix crash' } },
  ]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_seen',
        output_dir: outDir, spawn_url: recv.url,
        state: { ...baseState, seen_ids: ['123'] },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 0, 'no new items → no spawn POST');
    const obsPath = join(outDir, 'observation.json');
    assert.ok(existsSync(obsPath), 'observation.json must be written even with no new items');
    const obs = JSON.parse(readFileSync(obsPath, 'utf8'));
    assert.equal(obs.total, 1);
    assert.equal(obs.new_count, 0);
    assert.equal(obs.dispatched, false);
    // Cursor contract: even when nothing is dispatched, the script must emit
    // {state:{seen_ids}} on stdout so the dispatcher persists the cursor.
    assert.ok(
      result.stdout_parsed && typeof result.stdout_parsed === 'object',
      `stdout must be a JSON object carrying state; got: ${JSON.stringify(result.stdout)}`,
    );
    assert.ok(result.stdout_parsed.state && typeof result.stdout_parsed.state === 'object',
      'stdout must carry a `state` object');
    assert.deepEqual(result.stdout_parsed.state.seen_ids, ['123'],
      'seen_ids cursor must reflect the currently-observed items');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher: empty ADO result set → no dispatch, observation reports zero', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_empty',
        output_dir: outDir, spawn_url: recv.url,
        state: { ...baseState },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 0);
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.total, 0);
    assert.equal(obs.new_count, 0);
    assert.equal(obs.dispatched, false);
    // Empty result set still emits a state cursor (an empty seen_ids array).
    assert.ok(
      result.stdout_parsed && typeof result.stdout_parsed === 'object',
      `stdout must be a JSON object carrying state; got: ${JSON.stringify(result.stdout)}`,
    );
    assert.ok(result.stdout_parsed.state && typeof result.stdout_parsed.state === 'object',
      'stdout must carry a `state` object');
    assert.deepEqual(result.stdout_parsed.state.seen_ids, [],
      'empty ADO result → seen_ids cursor must be an empty array');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher: two-tick round-trip — feeding tick-1 stdout state prevents duplicate dispatch on tick-2', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir1 = freshDir('cdb-watcher-out-');
  const outDir2 = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  // Same two items on both ticks — nothing genuinely new appears on tick 2.
  writeFileSync(fixture, JSON.stringify([
    { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'Fix crash' } },
    { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'Old task' } },
  ]));
  try {
    // ----- Tick 1: cold start, no cursor → both items are new → one dispatch.
    const tick1 = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_tick1',
        output_dir: outDir1, spawn_url: recv.url,
        state: { ...baseState },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });
    assert.equal(tick1.exit_code, 0, `tick1 stderr: ${tick1.stderr}`);
    assert.equal(recv.calls.length, 1, 'tick 1 dispatches the initial items exactly once');
    assert.ok(tick1.stdout_parsed && tick1.stdout_parsed.state,
      'tick 1 must emit a state cursor on stdout');
    const cursor = tick1.stdout_parsed.state;
    assert.deepEqual([...cursor.seen_ids].sort(), ['123', '456'],
      'tick 1 cursor must record every observed id');

    // ----- Tick 2: replay the persisted cursor (dispatcher merges stdout state
    // into trigger state) → no new items → NO dispatch.
    const tick2 = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_tick2',
        output_dir: outDir2, spawn_url: recv.url,
        state: { ...baseState, ...cursor },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });
    assert.equal(tick2.exit_code, 0, `tick2 stderr: ${tick2.stderr}`);
    assert.equal(recv.calls.length, 1, 'tick 2 must NOT re-dispatch already-seen items');
    const obs2 = JSON.parse(readFileSync(join(outDir2, 'observation.json'), 'utf8'));
    assert.equal(obs2.new_count, 0, 'tick 2 sees zero new items');
    assert.equal(obs2.dispatched, false);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir1, outDir2);
  }
});

test('watcher: worktree_path is sent to spawn as workspace_path (filesystem path), not workspace_id', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([
    { id: 789, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'New bug' } },
  ]));
  const worktree = join(workDir, 'agent-worktree');
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_ws',
        output_dir: outDir, spawn_url: recv.url,
        state: { ...baseState, worktree_path: worktree },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1, 'expected exactly one spawn POST');
    const body = recv.calls[0].body;
    // /spawn resolves a filesystem path from `workspace_path`; `workspace_id`
    // is an opaque id lookup and silently ignores a path.
    assert.equal(body.workspace_path, worktree,
      'worktree_path must be sent as workspace_path (filesystem path)');
    assert.equal(body.workspace_id, undefined,
      'worktree_path must NOT be sent as workspace_id');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher: command safety — spaced/metacharacter project + quoted WIQL reach az as exact argv, no shell injection', async () => {
  // The watcher must invoke `az` with an argument VECTOR (execFileSync/
  // spawnSync), never a shell-interpolated command string. The original
  // implementation built `"az" boards query ... --project ${project} ...`
  // and ran it through execSync, so:
  //   (a) a project name with spaces split into multiple args, and
  //   (b) shell metacharacters (& | > ") in project/extra_where let an
  //       attacker inject additional commands.
  // This test proves each flag value arrives verbatim and that NO injected
  // command runs (marker files must NOT be created).
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzArgvStub(workDir);
  const argvOut = join(workDir, 'az-argv.json');
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([])); // empty result → no dispatch needed

  // Two independent injection vectors, each attempting to create a marker
  // file via a shell command. With a proper arg vector, neither runs.
  const projMarker = join(workDir, 'PROJ_PWNED.txt');
  const whereMarker = join(workDir, 'WHERE_PWNED.txt');
  const projectName = `Big Project & echo pwned> "${projMarker}"`;      // spaces + `&` + quotes
  const extraWhere = `[System.State] = 'Active' | echo pwned> "${whereMarker}"`; // quotes + `|` + `>`

  // Reconstruct the exact WIQL the watcher builds so we can assert the
  // `--wiql` value arrives byte-for-byte (documents the query contract).
  const assignedTo = baseState.assigned_to;
  const whereClauses = [`[System.AssignedTo] = '${assignedTo}'`, extraWhere].join(' AND ');
  const expectedWiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.ChangedDate] FROM workitems WHERE ${whereClauses} ORDER BY [System.ChangedDate] DESC`;

  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_cmdsafe',
        output_dir: outDir, spawn_url: 'http://127.0.0.1:1/never', // must not be hit (empty result)
        state: { ...baseState, project: projectName, extra_where: extraWhere },
        payload: null,
      },
      timeoutMs: 60000,
      env: {
        CLAWDEVBOX_AZ_BIN: azBin,
        AZ_FIXTURE: fixture,
        AZ_ARGV_OUT: argvOut,
        CLAWDEVBOX_FIRE_SECRET: 'test-secret',
      },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);

    // No injected command executed.
    assert.ok(!existsSync(projMarker),
      'project-name metacharacters must NOT execute a shell command (marker created)');
    assert.ok(!existsSync(whereMarker),
      'extra_where metacharacters must NOT execute a shell command (marker created)');

    // az was invoked with an exact argument vector.
    assert.ok(existsSync(argvOut), 'az stub must have captured its argv');
    const argv = JSON.parse(readFileSync(argvOut, 'utf8'));

    // `boards query` subcommand arrives as two adjacent verbatim args.
    assert.equal(argv[0], 'boards', 'argv[0] must be the subcommand `boards`');
    assert.equal(argv[1], 'query', 'argv[1] must be `query`');

    const valueAfter = (flag) => {
      const i = argv.indexOf(flag);
      assert.ok(i >= 0, `flag ${flag} must be present in argv`);
      return argv[i + 1];
    };

    assert.equal(valueAfter('--wiql'), expectedWiql,
      '--wiql must arrive as one verbatim argument (quotes/pipes intact, not split)');
    assert.equal(valueAfter('--org'), `https://${baseState.org}.visualstudio.com`,
      '--org must arrive verbatim');
    assert.equal(valueAfter('--project'), projectName,
      '--project must arrive as ONE verbatim argument (spaces + metacharacters preserved)');
    assert.equal(valueAfter('-o'), 'json', '-o must arrive verbatim as json');
  } finally {
    cleanup(workDir, outDir);
  }
});

// ---------------------------------------------------------------------------
// Windows shell-elimination regression.
//
// The prior implementation ran a Windows Azure CLI shim as
// `cmd.exe /d /s /c az.cmd <args…>`. Node only quotes arguments that contain
// spaces/quotes, so a *space-free* metacharacter payload in a flag value —
// e.g. `--project x&echo.>marker` — is handed to cmd.exe raw. cmd.exe then
// (a) TRUNCATES the argument at `&` (az sees `--project x`) and (b) EXECUTES
// the injected `echo.>marker` command. The shell-free resolver eliminates
// cmd.exe entirely: an MSI `az.cmd` is resolved to the sibling `python.exe`
// the shim itself execs; an unsupported custom `.cmd` (no sibling python.exe)
// is REFUSED rather than shelled out. Either way no shell ever re-parses our
// argv, so the injection cannot fire.
test(
  'watcher (win32): space-free metachar project via real .cmd shim neither injects nor truncates (no cmd.exe)',
  { skip: process.platform !== 'win32' ? 'windows-only shell-injection regression' : false },
  async () => {
    const { runTriggerScript } = await import('../src/trigger-runner.ts');
    const workDir = freshDir('cdb-azcmd-');
    const outDir = freshDir('cdb-watcher-out-');
    // A REAL .cmd shim that would capture argv if executed. It deliberately has
    // NO sibling ..\python.exe, so it is an "unsupported custom .cmd" the
    // resolver must refuse (never run through cmd.exe).
    const capture = join(workDir, 'cap.mjs');
    writeFileSync(
      capture,
      [
        "import { writeFileSync } from 'node:fs';",
        'writeFileSync(process.env.AZ_ARGV_OUT, JSON.stringify(process.argv.slice(2)));',
        "process.stdout.write('[]');",
        '',
      ].join('\n'),
    );
    const azCmd = join(workDir, 'az.cmd');
    writeFileSync(azCmd, `@echo off\r\nnode "${capture}" %*\r\n`);
    const argvOut = join(workDir, 'argv.json');
    const marker = join(workDir, 'marker'); // absolute, space-free within temp
    // The vuln only reproduces with a fully space-free payload: if the temp
    // path itself contains a space, Node quotes the arg and cmd.exe cannot
    // inject. Skip in that (rare) environment rather than assert a false pass.
    if (marker.includes(' ')) return;
    const projectPayload = `x&echo.>${marker}`; // space-free `&` + `>` injection
    try {
      const result = await runTriggerScript({
        scriptPath, runtime: 'tsx',
        envelope: {
          trigger_event_name: 'TriggerFired',
          trigger_id: 'ado.assigned-items-watcher', run_id: 'run_cmdinject',
          output_dir: outDir, spawn_url: 'http://127.0.0.1:1/never',
          state: { ...baseState, project: projectPayload },
          payload: null,
        },
        timeoutMs: 60000,
        env: { CLAWDEVBOX_AZ_BIN: azCmd, AZ_ARGV_OUT: argvOut, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
      });

      // The injected shell command must NEVER run.
      assert.ok(!existsSync(marker),
        'space-free `&` payload must NOT inject a shell command (marker created ⇒ cmd.exe parsed our argv)');
      // The shim must not be executed at all — a non-MSI .cmd is refused.
      assert.ok(!existsSync(argvOut),
        'unsupported custom .cmd must NOT be executed (no truncated argv leaks to az)');
      // Fail-safe: non-zero exit + an error observation, not a silent shell-out.
      assert.notEqual(result.exit_code, 0,
        'unsupported custom .cmd must fail safely (non-zero exit)');
      const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
      assert.equal(obs.status, 'error',
        'a fail-safe refusal must be recorded as an error observation');
    } finally {
      cleanup(workDir, outDir);
    }
  },
);

// ---------------------------------------------------------------------------
// Legacy-state migration regression (production incident 2026-07).
//
// A pre-`seen_ids` registration persisted its cursor as a `seenWorkItems` MAP
// keyed by work-item id → { state, changedDate }, with NO `seen_ids` array.
// The watcher only read `state.seen_ids`, so after a byte-identical restore of
// that legacy state it saw an EMPTY previous set and treated every one of the
// 232 assigned items as "new", firing a mass triage dispatch. These tests pin
// the backward-compatible migration: legacy `seenWorkItems` keys must seed the
// previous-id set so already-known items never re-dispatch, a durable
// `seen_ids` cursor must be emitted, an explicit `seen_ids` must win over the
// legacy map, and a legacy marker that cannot be parsed must fail SAFE (baseline
// everything, dispatch nothing) rather than mass-dispatch.

// Realistic legacy map matching the production shape:
//   { "<numeric id>": { state, changedDate } }  (values are objects, not bools)
function legacyMap(ids) {
  const m = {};
  for (const id of ids) {
    m[String(id)] = { state: 'Open', changedDate: '2021-05-26T07:56:54.433Z' };
  }
  return m;
}

test('watcher (legacy migration): seenWorkItems map + no seen_ids → migrate cursor, ZERO mass dispatch', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  // Every current item is already recorded in the legacy map.
  writeFileSync(fixture, JSON.stringify([
    { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'Known A' } },
    { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'Known B' } },
  ]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_legacy_migrate',
        output_dir: outDir, spawn_url: recv.url,
        // Legacy shape: seenWorkItems map, NO seen_ids array.
        state: { ...baseState, seenWorkItems: legacyMap([123, 456]) },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    // The whole point: NO items are "new", so NOTHING is dispatched.
    assert.equal(recv.calls.length, 0, 'legacy-known items must NOT trigger a (mass) dispatch');
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.total, 2);
    assert.equal(obs.new_count, 0, 'items present in the legacy map are not new');
    assert.equal(obs.dispatched, false);
    // Migration must emit a durable seen_ids cursor for the currently-observed items.
    assert.ok(result.stdout_parsed && result.stdout_parsed.state,
      'must emit a state cursor on stdout');
    assert.deepEqual([...result.stdout_parsed.state.seen_ids].sort(), ['123', '456'],
      'migration must emit seen_ids covering the currently-observed items');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher (legacy migration): mixed legacy map + one genuinely new item → dispatch exactly once', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([
    { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'Brand new' } },
    { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'Known B' } },
  ]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_legacy_mixed',
        output_dir: outDir, spawn_url: recv.url,
        // Only #456 is in the legacy map; #123 is genuinely new.
        state: { ...baseState, seenWorkItems: legacyMap([456]) },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1, 'exactly one dispatch, for the single new item');
    assert.match(recv.calls[0].body.prompt, /#123/);
    assert.doesNotMatch(recv.calls[0].body.prompt, /#456/, 'legacy-known item must not be re-dispatched');
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.deepEqual(obs.new_ids, ['123']);
    assert.deepEqual([...result.stdout_parsed.state.seen_ids].sort(), ['123', '456']);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher (legacy migration): explicit seen_ids takes precedence over legacy seenWorkItems map', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([
    { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'A' } },
    { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'B' } },
  ]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_precedence',
        output_dir: outDir, spawn_url: recv.url,
        // seen_ids says #123 is seen; the legacy map says #456 is seen. If the
        // migrated cursor is chosen, #456 would fire; seen_ids MUST win → #456
        // is treated as seen and #123 stays seen too... to make precedence
        // unambiguous, seen_ids marks #123 seen while the map marks #456 seen.
        state: { ...baseState, seen_ids: ['123'], seenWorkItems: legacyMap([456]) },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1, 'exactly one dispatch (seen_ids precedence)');
    // seen_ids (#123 seen) wins → #456 is the only new item.
    assert.match(recv.calls[0].body.prompt, /#456/,
      'with seen_ids precedence, #456 (absent from seen_ids) is the new item');
    assert.doesNotMatch(recv.calls[0].body.prompt, /#123/,
      'seen_ids marks #123 seen; it must not be re-dispatched');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher (legacy migration): malformed seenWorkItems (not a map) → fail SAFE, no mass dispatch', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([
    { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'A' } },
    { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'B' } },
    { id: 789, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'C' } },
  ]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_malformed',
        output_dir: outDir, spawn_url: recv.url,
        // Legacy marker present but corrupt (a string, not an id→meta map).
        // The watcher must NOT fall back to an empty previous set (which would
        // mass-dispatch all 3 items); it must baseline everything as seen.
        state: { ...baseState, seenWorkItems: 'corrupt-not-a-map' },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 0,
      'a malformed legacy marker must fail SAFE (baseline), never mass-dispatch');
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.new_count, 0, 'fail-safe baselines every current item as seen');
    assert.equal(obs.dispatched, false);
    // Fail-safe still lays down a durable seen_ids baseline for the next tick.
    assert.deepEqual([...result.stdout_parsed.state.seen_ids].sort(), ['123', '456', '789']);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher (fresh registration): no seen_ids AND no legacy map → dispatch new items (baseline preserved)', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([
    { id: 555, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'Fresh' } },
  ]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_fresh',
        output_dir: outDir, spawn_url: recv.url,
        // Genuinely fresh registration — neither cursor nor legacy marker.
        state: { ...baseState },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1, 'a truly fresh registration dispatches its initial items');
    assert.match(recv.calls[0].body.prompt, /#555/);
    assert.deepEqual(result.stdout_parsed.state.seen_ids, ['555']);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher (legacy migration): two ticks — migrated cursor persists, later new item dispatches once', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir1 = freshDir('cdb-watcher-out-');
  const outDir2 = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  try {
    // ----- Tick 1: legacy state, both current items already known → migrate, no dispatch.
    writeFileSync(fixture, JSON.stringify([
      { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'Known A' } },
      { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'Known B' } },
    ]));
    const tick1 = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_legacy_tick1',
        output_dir: outDir1, spawn_url: recv.url,
        state: { ...baseState, seenWorkItems: legacyMap([123, 456]) },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });
    assert.equal(tick1.exit_code, 0, `tick1 stderr: ${tick1.stderr}`);
    assert.equal(recv.calls.length, 0, 'tick 1 migrates silently — no dispatch');
    const cursor = tick1.stdout_parsed.state;

    // ----- Tick 2: replay the migrated cursor; a NEW item #789 appears.
    writeFileSync(fixture, JSON.stringify([
      { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'Known A' } },
      { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'Known B' } },
      { id: 789, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'Newly assigned' } },
    ]));
    const tick2 = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_legacy_tick2',
        output_dir: outDir2, spawn_url: recv.url,
        // Dispatcher shallow-merges tick-1 stdout state back onto trigger state.
        state: { ...baseState, seenWorkItems: legacyMap([123, 456]), ...cursor },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });
    assert.equal(tick2.exit_code, 0, `tick2 stderr: ${tick2.stderr}`);
    assert.equal(recv.calls.length, 1, 'tick 2 dispatches only the genuinely new item once');
    assert.match(recv.calls[0].body.prompt, /#789/);
    assert.doesNotMatch(recv.calls[0].body.prompt, /#123/);
    assert.doesNotMatch(recv.calls[0].body.prompt, /#456/);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir1, outDir2);
  }
});

// ---------------------------------------------------------------------------
// Unit coverage for the pure seen-baseline resolver (imported directly).
async function loadBaseline() {
  const mod = await import(pathToFileURL(scriptPath).href);
  assert.equal(typeof mod.deriveSeenBaseline, 'function',
    'assigned-items-watcher.js must export deriveSeenBaseline');
  return mod.deriveSeenBaseline;
}

test('deriveSeenBaseline: seen_ids present → cursor mode, ids from seen_ids', async () => {
  const deriveSeenBaseline = await loadBaseline();
  const r = deriveSeenBaseline({ seen_ids: ['1', '2'], seenWorkItems: { 9: {} } });
  assert.equal(r.mode, 'cursor');
  assert.deepEqual([...r.ids].sort(), ['1', '2']);
});

test('deriveSeenBaseline: legacy seenWorkItems map (no seen_ids) → migrate mode, ids from keys', async () => {
  const deriveSeenBaseline = await loadBaseline();
  const r = deriveSeenBaseline({ seenWorkItems: { 123: { state: 'Open' }, 456: { state: 'New' } } });
  assert.equal(r.mode, 'migrate');
  assert.deepEqual([...r.ids].sort(), ['123', '456']);
});

test('deriveSeenBaseline: malformed legacy marker (string/array/null/empty) → failsafe mode', async () => {
  const deriveSeenBaseline = await loadBaseline();
  for (const bad of ['corrupt', [1, 2, 3], null, {}, 42]) {
    const r = deriveSeenBaseline({ seenWorkItems: bad });
    assert.equal(r.mode, 'failsafe', `seenWorkItems=${JSON.stringify(bad)} must be fail-safe`);
  }
});

test('deriveSeenBaseline: no seen_ids and no legacy marker → fresh mode (empty previous set)', async () => {
  const deriveSeenBaseline = await loadBaseline();
  const r = deriveSeenBaseline({ org: 'x' });
  assert.equal(r.mode, 'fresh');
  assert.deepEqual(r.ids, []);
});

// ---------------------------------------------------------------------------
// Unit coverage for the shell-free invocation resolver (imported directly).
// The script is importable without side effects (main() runs only when the
// file is executed as the entrypoint), so these assert the argv mapping for
// every branch with no subprocess.
async function loadResolver() {
  const mod = await import(pathToFileURL(scriptPath).href);
  assert.equal(typeof mod.resolveAzInvocation, 'function',
    'assigned-items-watcher.js must export resolveAzInvocation');
  return mod.resolveAzInvocation;
}

test('resolveAzInvocation: JSON-array seam → discrete executable + argv, no shell', async () => {
  const resolveAzInvocation = await loadResolver();
  const { file, args } = resolveAzInvocation(
    JSON.stringify(['/usr/bin/node', 'cap.mjs']),
    ['boards', 'query', '--project', 'p'],
  );
  assert.equal(file, '/usr/bin/node');
  assert.deepEqual(args, ['cap.mjs', 'boards', 'query', '--project', 'p']);
});

test('resolveAzInvocation (win32): MSI az.cmd resolves to sibling python.exe -IBm azure.cli', async () => {
  if (process.platform !== 'win32') return;
  const resolveAzInvocation = await loadResolver();
  const root = freshDir('cdb-msi-');
  try {
    const wbin = join(root, 'wbin');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(wbin, { recursive: true });
    const azCmd = join(wbin, 'az.cmd');
    const python = join(root, 'python.exe'); // MSI sibling of wbin
    writeFileSync(azCmd, '@echo off\r\n');
    writeFileSync(python, ''); // presence is what matters
    const { file, args } = resolveAzInvocation(azCmd, ['boards', 'query', '-o', 'json']);
    assert.equal(resolve(file), resolve(python),
      'az.cmd must resolve to the MSI sibling python.exe');
    assert.deepEqual(args, ['-IBm', 'azure.cli', 'boards', 'query', '-o', 'json'],
      'python must be invoked with -IBm azure.cli then the verbatim az args');
  } finally {
    cleanup(root);
  }
});

test('resolveAzInvocation (win32): unsupported custom .cmd (no sibling python.exe) throws (fail-safe)', async () => {
  if (process.platform !== 'win32') return;
  const resolveAzInvocation = await loadResolver();
  const root = freshDir('cdb-badcmd-');
  try {
    const azCmd = join(root, 'az.cmd'); // no ..\python.exe next to it
    writeFileSync(azCmd, '@echo off\r\n');
    assert.throws(() => resolveAzInvocation(azCmd, ['boards', 'query']),
      /python\.exe|shim|shell/i,
      'a .cmd without a sibling MSI python.exe must be refused, not shelled out');
  } finally {
    cleanup(root);
  }
});

test('resolveAzInvocation: a concrete executable path is invoked directly (no shell)', async () => {
  const resolveAzInvocation = await loadResolver();
  const direct = process.platform === 'win32' ? 'C:\\py\\python.exe' : 'az';
  const { file, args } = resolveAzInvocation(direct, ['boards', 'query']);
  assert.equal(file, direct);
  assert.deepEqual(args, ['boards', 'query']);
});

// ---------------------------------------------------------------------------
// Malformed-KEY regression (spec review 2026-07).
//
// deriveSeenBaseline originally accepted ANY non-empty plain object as a valid
// legacy map and migrated from its keys. But ADO ids are canonical positive
// integer strings; a legacy map whose keys are non-numeric (or a mix of numeric
// and non-numeric) can NEVER intersect the numeric current ids, so every item
// looks "new" — the very mass-dispatch bug the migration exists to prevent.
// A legacy map is only trustworthy when EVERY key is a canonical ADO id; any
// invalid key makes the WHOLE map fail-safe (no partial migration, no
// dispatching uncertain items).

test('deriveSeenBaseline: all-nonnumeric legacy keys → failsafe (never migrate)', async () => {
  const deriveSeenBaseline = await loadBaseline();
  const r = deriveSeenBaseline({ seenWorkItems: { foo: { state: 'Open' }, bar: { state: 'New' } } });
  assert.equal(r.mode, 'failsafe',
    'a legacy map with no canonical ADO ids cannot seed a numeric baseline — must fail safe');
  assert.deepEqual(r.ids, []);
});

test('deriveSeenBaseline: mixed numeric + nonnumeric legacy keys → failsafe (no partial migration)', async () => {
  const deriveSeenBaseline = await loadBaseline();
  const r = deriveSeenBaseline({ seenWorkItems: { 123: { state: 'Open' }, bogus: { state: 'New' }, 456: {} } });
  assert.equal(r.mode, 'failsafe',
    'one invalid key must fail-safe the ENTIRE map — never partially migrate and dispatch uncertain items');
  assert.deepEqual(r.ids, []);
});

test('deriveSeenBaseline: non-canonical integer-ish keys → failsafe', async () => {
  const deriveSeenBaseline = await loadBaseline();
  // Each of these single-bad-key maps must fail-safe: empty, whitespace,
  // negative, decimal, leading-zero, hex/prefix junk, plus sign, exponent.
  const badKeys = ['', ' ', '  ', '-5', '3.5', '0', '01', '007', ' 5', '5 ', '5abc', '0x10', '+5', '1e3', '1_000'];
  for (const bad of badKeys) {
    const r = deriveSeenBaseline({ seenWorkItems: { [bad]: { state: 'Open' } } });
    assert.equal(r.mode, 'failsafe', `seenWorkItems key ${JSON.stringify(bad)} must be fail-safe`);
    assert.deepEqual(r.ids, []);
  }
});

test('deriveSeenBaseline: all-canonical positive-integer keys → migrate (ids from keys)', async () => {
  const deriveSeenBaseline = await loadBaseline();
  const r = deriveSeenBaseline({ seenWorkItems: { 1: {}, 42: {}, 999999: {} } });
  assert.equal(r.mode, 'migrate');
  assert.deepEqual([...r.ids].sort(), ['1', '42', '999999'].sort());
});

test('watcher (malformed keys): all-nonnumeric legacy map + current items → fail SAFE, no mass dispatch', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([
    { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'A' } },
    { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'B' } },
    { id: 789, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'C' } },
  ]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_nonnumeric_keys',
        output_dir: outDir, spawn_url: recv.url,
        // Legacy map is a non-empty object, but its keys are NOT ADO ids, so
        // they can never match the numeric current ids. Must fail SAFE.
        state: { ...baseState, seenWorkItems: { foo: { state: 'Open' }, bar: { state: 'New' } } },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 0,
      'nonnumeric legacy keys must fail SAFE (baseline), never mass-dispatch');
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.new_count, 0, 'fail-safe baselines every current item as seen');
    assert.equal(obs.dispatched, false);
    assert.deepEqual([...result.stdout_parsed.state.seen_ids].sort(), ['123', '456', '789']);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('watcher (malformed keys): mixed numeric+nonnumeric legacy map + current items → fail SAFE', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver();
  const workDir = freshDir('cdb-azstub-');
  const outDir = freshDir('cdb-watcher-out-');
  const azBin = makeAzStub(workDir);
  const fixture = join(workDir, 'items.json');
  writeFileSync(fixture, JSON.stringify([
    { id: 123, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.Title': 'A' } },
    { id: 456, fields: { 'System.WorkItemType': 'Task', 'System.State': 'New', 'System.Title': 'B' } },
  ]));
  try {
    const result = await runTriggerScript({
      scriptPath, runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'ado.assigned-items-watcher', run_id: 'run_mixed_keys',
        output_dir: outDir, spawn_url: recv.url,
        // One valid ADO id, one junk key. A single invalid key must fail-safe
        // the WHOLE map — never partially migrate and dispatch uncertain items.
        state: { ...baseState, seenWorkItems: { 123: { state: 'Open' }, 'not-an-id': { state: 'New' } } },
        payload: null,
      },
      timeoutMs: 60000,
      env: { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' },
    });

    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 0,
      'a mixed legacy map must fail SAFE (baseline), never partially migrate and dispatch');
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.new_count, 0, 'fail-safe baselines every current item as seen');
    assert.equal(obs.dispatched, false);
    assert.deepEqual([...result.stdout_parsed.state.seen_ids].sort(), ['123', '456']);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});
