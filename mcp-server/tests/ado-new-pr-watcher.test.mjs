// Regression tests for the ado.new-pr-watcher plugin trigger.
//
// These run the REAL shipped script (plugins/ado/triggers/new-pr-watcher.js)
// through runTriggerScript with the same TriggerEnvelope-on-stdin contract the
// kernel uses. `az` is stubbed via the CLAWDEVBOX_AZ_BIN seam so the tests are
// deterministic and NEVER touch a real ADO org or PR.
//
// Contract under test (see the `authoring-triggers` skill and the sibling
// ado.assigned-items-watcher):
//   - script reads the envelope on stdin,
//   - queries ADO for ACTIVE pull requests in the configured repo
//     (`az repos pr list --repository <repo> --status active ...`),
//   - the FIRST successful tick baselines every currently-active matching PR
//     id into state.seen_pr_ids (and sets state.initialized) but dispatches
//     NOTHING,
//   - subsequent ticks POST a read-only review prompt about each NEW PR
//     (id absent from state.seen_pr_ids) to dispatch_url (preferred) or
//     spawn_url,
//   - applies include_drafts / opened_by / assigned_to filters client-side,
//   - on a FAILED callback it exits non-zero and does NOT advance the cursor
//     past the undispatched PR,
//   - writes an observation.json to env.output_dir,
//   - emits ONE `{state}` JSON object on stdout only after a successful tick.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, delimiter, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = resolve(__dirname, '..', '..', 'plugins', 'ado', 'triggers', 'new-pr-watcher.js');

// Loopback receiver standing in for the kernel's dispatch/spawn endpoint.
// `status` lets a test force a failed callback.
async function startReceiver(status = 200) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: parsed });
      res.statusCode = status;
      res.end(JSON.stringify({ ok: status < 400 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    spawnUrl: `${base}/spawn?fire_id=test-abc`,
    dispatchUrl: `${base}/dispatch?fire_id=test-abc`,
    calls,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

// Fake `az` implemented as a NODE script rather than a shell/batch file.
//
// Why node and not az.cmd / a shell script: the shipped trigger now invokes
// `az` shell-free via execFileSync(bin, argsArray) (no shell interpolation, so
// repo/project/org values can never be re-parsed as shell tokens). A .cmd/.bat
// cannot be launched by execFileSync on Windows without `shell:true` (EFTYPE),
// which is exactly the injection vector we removed. A node script IS directly
// launchable cross-platform via [process.execPath, stubPath], so the seam
// stays shell-free on every OS.
//
// The stub records the EXACT argv it received (one JSON array, preserving
// element boundaries) to AZ_ARGV_LOG so tests can prove that each value
// arrived as a single literal argv element. If any element were re-parsed by
// a shell, the boundaries would not survive.
//
// CLAWDEVBOX_AZ_BIN is set to a JSON array `[node, stubPath]`; the trigger
// treats a JSON-array value as `[binary, ...prefixArgs]` (the existing single
// string seam still works for the real `az` binary).
function writeNodeStub(dir, name, bodyLines) {
  const p = join(dir, name);
  writeFileSync(p, [
    'import { writeFileSync, readFileSync } from "node:fs";',
    // Capture the az args exactly (argv[0]=node, argv[1]=this stub).
    'const argv = process.argv.slice(2);',
    'if (process.env.AZ_ARGV_LOG) writeFileSync(process.env.AZ_ARGV_LOG, JSON.stringify(argv));',
    ...bodyLines,
    '',
  ].join('\n'));
  return p;
}

// Fake `az` that captures argv and prints the JSON in AZ_FIXTURE.
function makeAzStub(dir) {
  const p = writeNodeStub(dir, 'az-stub.mjs', [
    'process.stdout.write(readFileSync(process.env.AZ_FIXTURE, "utf8"));',
  ]);
  return JSON.stringify([process.execPath, p]);
}

// Fake `az` that always fails (simulates auth error / not-logged-in).
function makeFailingAzStub(dir) {
  const p = writeNodeStub(dir, 'az-fail-stub.mjs', [
    'process.stderr.write("ERROR: az login required\\n");',
    'process.exit(1);',
  ]);
  return JSON.stringify([process.execPath, p]);
}

// REAL Windows MSI `az` layout — the exact shape this fix targets.
//
// The Azure CLI MSI installs `az` as `…\wbin\az.cmd`, a trivial shim that execs
// the bundled CPython:  `"%~dp0\..\python.exe" -IBm azure.cli %*`. Node's
// post-CVE child_process cannot launch a .cmd without a shell, and the previous
// fix routed through `cmd.exe /d /s /c <az.cmd> …`. That reliance on Node's
// cmd-aware quoting only defends values that contain WHITESPACE: a SPACE-FREE
// value like `repo&echo x>marker` is passed to cmd.exe UNQUOTED, so cmd splits
// on the metacharacter and runs the injected command. The shipped watcher now
// resolves az.cmd, derives the sibling `..\python.exe`, and invokes the
// interpreter DIRECTLY (spawnSync, shell:false) — every value stays one literal
// argv element regardless of content.
//
// These helpers build that real MSI layout under `root`:
//   <root>/wbin/az.cmd   — the shipped shim (execs the sibling python)
//   <root>/python.exe    — a tiny compiled stand-in that ignores the
//                          `-IBm azure.cli` prefix, captures the remaining argv
//                          (one JSON array, boundaries preserved) to
//                          AZ_ARGV_LOG, and prints AZ_FIXTURE.
// On POSIX `az` is a directly-launchable sh script (the real POSIX shape); the
// resolver runs it natively, so no python resolution is involved there.

// Compile the fake python.exe ONCE (Windows only) and reuse across tests.
let _pyStubExe = null;
function pythonStubExe() {
  if (_pyStubExe) return _pyStubExe;
  const dir = mkdtempSync(join(tmpdir(), 'cdb-pystub-'));
  const cs = join(dir, 'pystub.cs');
  writeFileSync(cs, [
    'using System;',
    'using System.IO;',
    'using System.Text;',
    'using System.Collections.Generic;',
    'class P {',
    '  static int Main(string[] args) {',
    '    var list = new List<string>(args);',
    // Strip the fixed `-IBm azure.cli` interpreter prefix the resolver prepends
    // so the captured argv matches the `az …` arguments the watcher built.
    '    if (list.Count >= 2 && list[0] == "-IBm" && list[1] == "azure.cli") list.RemoveRange(0, 2);',
    '    var log = Environment.GetEnvironmentVariable("AZ_ARGV_LOG");',
    '    if (!string.IsNullOrEmpty(log)) {',
    '      var sb = new StringBuilder("[");',
    '      for (int i=0;i<list.Count;i++){ if(i>0) sb.Append(","); sb.Append(J(list[i])); }',
    '      sb.Append("]");',
    '      File.WriteAllText(log, sb.ToString());',
    '    }',
    '    var fix = Environment.GetEnvironmentVariable("AZ_FIXTURE");',
    '    if (!string.IsNullOrEmpty(fix)) Console.Out.Write(File.ReadAllText(fix));',
    '    return 0;',
    '  }',
    '  static string J(string s){ var sb=new StringBuilder("\\""); foreach(char c in s){ switch(c){',
    '    case \'"\': sb.Append("\\\\\\""); break; case \'\\\\\': sb.Append("\\\\\\\\"); break;',
    '    case \'\\n\': sb.Append("\\\\n"); break; case \'\\r\': sb.Append("\\\\r"); break;',
    '    case \'\\t\': sb.Append("\\\\t"); break;',
    '    default: if(c<0x20) sb.Append("\\\\u"+((int)c).ToString("x4")); else sb.Append(c); break;',
    '  } } sb.Append("\\""); return sb.ToString(); }',
    '}',
    '',
  ].join('\n'));
  const exe = join(dir, 'python.exe');
  const csc = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ].find((p) => existsSync(p));
  if (!csc) throw new Error('csc.exe not found to build the fake python.exe stub');
  execFileSync(csc, ['/nologo', `/out:${exe}`, cs], { stdio: 'pipe' });
  _pyStubExe = exe;
  return exe;
}

// Build the real MSI layout (win32) or a direct sh `az` (POSIX) under `root`.
// Returns the plain-string CLAWDEVBOX_AZ_BIN value (path to wbin/az.cmd on
// Windows, path to `az` on POSIX) — the real deployment shape.
function makeAzMsi(root, { capture = false } = {}) {
  if (process.platform === 'win32') {
    mkdirSync(join(root, 'wbin'), { recursive: true });
    const azCmd = join(root, 'wbin', 'az.cmd');
    // The real shipped az.cmd shape: exec the sibling bundled python.
    writeFileSync(azCmd, [
      '@echo off',
      '@IF EXIST "%~dp0\\..\\python.exe" (',
      '  "%~dp0\\..\\python.exe" -IBm azure.cli %*',
      ') ELSE ( echo Failed to load python executable. & exit /b 1 )',
      '',
    ].join('\r\n'));
    copyFileSync(pythonStubExe(), join(root, 'python.exe'));
    return azCmd;
  }
  const az = join(root, 'az');
  if (capture) {
    const cap = join(root, 'az-real-capture.mjs');
    writeFileSync(cap, [
      'import { writeFileSync, readFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'if (process.env.AZ_ARGV_LOG) writeFileSync(process.env.AZ_ARGV_LOG, JSON.stringify(argv));',
      'process.stdout.write(readFileSync(process.env.AZ_FIXTURE, "utf8"));',
      '',
    ].join('\n'));
    writeFileSync(az, `#!/bin/sh\nexec node "${cap}" "$@"\n`);
  } else {
    writeFileSync(az, '#!/bin/sh\ncat "$AZ_FIXTURE"\n');
  }
  chmodSync(az, 0o755);
  return az;
}

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
// A guaranteed SPACE-FREE temp dir. Space-free injection payloads (the exact
// vector the cmd.exe wrapper could not defend) require a space-free marker path
// — a single space anywhere in an argv element makes Node quote it, which
// masks the vulnerability. Falls back to a space-free base off the tmp drive
// root when tmpdir() itself contains a space.
function spaceFreeDir(prefix) {
  const base = /\s/.test(tmpdir()) ? join(parsePath(tmpdir()).root, 'cdbsf') : tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}
function cleanup(...dirs) {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// Build a real-shape `az repos pr list -o json` PR object.
function pr({ id, title = 'A pull request', isDraft = false, createdBy = 'author@ms.com', reviewers = [] }) {
  return {
    pullRequestId: id,
    title,
    status: 'active',
    isDraft,
    createdBy: { uniqueName: createdBy, displayName: createdBy },
    reviewers: reviewers.map((u) => ({ uniqueName: u, displayName: u, isRequired: true })),
    repository: { name: 'myrepo' },
  };
}

const baseState = {
  org: 'myorg',
  project: 'MyProject',
  repo: 'myrepo',
};

// Convenience runner: writes the fixture and runs the trigger once.
async function runOnce({ prs, state, receiver, azBin, runId = 'run', useDispatch = false, workDir, outDir, argvLog, extraEnv }) {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const fixture = join(workDir, 'prs.json');
  writeFileSync(fixture, JSON.stringify(prs));
  const envelope = {
    trigger_event_name: 'TriggerFired',
    trigger_id: 'ado.new-pr-watcher',
    run_id: runId,
    output_dir: outDir,
    spawn_url: receiver.spawnUrl,
    state,
    payload: null,
  };
  if (useDispatch) envelope.dispatch_url = receiver.dispatchUrl;
  const env = { CLAWDEVBOX_AZ_BIN: azBin, AZ_FIXTURE: fixture, CLAWDEVBOX_FIRE_SECRET: 'test-secret' };
  // When a test wants to inspect the exact argv `az` received, point the stub
  // at a log file. Reading it back proves each value arrived as one literal
  // argv element (no shell re-parsing).
  if (argvLog) env.AZ_ARGV_LOG = argvLog;
  // Tests that resolve a bare `az` off PATH prepend the shim dir here.
  if (extraEnv) Object.assign(env, extraEnv);
  return runTriggerScript({
    scriptPath, runtime: 'tsx',
    envelope,
    timeoutMs: 60000,
    env,
  });
}

test('manifest: trigger sidecar exposes required params (org, project, repo) + identity_param repo', async () => {
  const { loadPluginFromDir } = await import('../src/manifest/load-plugin.ts');
  const adoDir = resolve(__dirname, '..', '..', 'plugins', 'ado');
  const r = await loadPluginFromDir(adoDir);
  const tt = r.capabilities.triggerTypes.find((t) => t.id === 'ado.new-pr-watcher');
  assert.ok(tt, 'ado.new-pr-watcher trigger type must load');
  assert.ok(Array.isArray(tt.parameters), 'parameters must be an array (loader contract)');
  const byName = Object.fromEntries(tt.parameters.map((p) => [p.name, p]));
  for (const req of ['org', 'project', 'repo']) {
    assert.ok(byName[req], `parameter '${req}' must be present`);
    assert.equal(byName[req].required, true, `parameter '${req}' must be required`);
  }
  assert.equal(tt.identity_param, 'repo', 'identity_param must be repo');
  assert.equal(tt.accepts_webhook, true, 'accepts_webhook must be true');
});

test('baseline: first tick records all active PR ids and dispatches NOTHING', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  try {
    const result = await runOnce({
      prs: [pr({ id: 101, title: 'First' }), pr({ id: 102, title: 'Second' })],
      state: { ...baseState }, // no `initialized`
      receiver: recv, azBin, workDir, outDir, runId: 'run_baseline',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 0, 'baseline must not dispatch anything');
    assert.ok(result.stdout_parsed && result.stdout_parsed.state, 'must emit {state} on stdout');
    assert.equal(result.stdout_parsed.state.initialized, true, 'must mark initialized');
    assert.deepEqual([...result.stdout_parsed.state.seen_pr_ids].sort(), ['101', '102']);
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.dispatched, false);
    assert.equal(obs.baseline, true);
    assert.equal(obs.total, 2);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('new PR: POSTs a read-only review prompt with real id/title/repo/org/project to spawn_url', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  try {
    const result = await runOnce({
      prs: [pr({ id: 555, title: 'Add retry logic' })],
      state: { ...baseState, initialized: true, seen_pr_ids: [] },
      receiver: recv, azBin, workDir, outDir, runId: 'run_new',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1, 'exactly one spawn POST for the new PR');
    const call = recv.calls[0];
    assert.equal(call.auth, 'Bearer test-secret');
    const prompt = call.body.prompt;
    assert.match(prompt, /555/, 'prompt carries the real PR id');
    assert.match(prompt, /Add retry logic/, 'prompt carries the real PR title');
    assert.match(prompt, /myrepo/, 'prompt carries the repo');
    assert.match(prompt, /myorg/, 'prompt carries the org');
    assert.match(prompt, /MyProject/, 'prompt carries the project');
    assert.match(prompt, /read-only/i, 'prompt must instruct a read-only review');
    assert.equal(call.body.agent, 'dev-buddy:dev-buddy', 'spawn body names the dev-buddy agent');
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.dispatched, true);
    assert.deepEqual(obs.new_ids, ['555']);
    assert.deepEqual([...result.stdout_parsed.state.seen_pr_ids].sort(), ['555']);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('include_drafts=false (default): draft PRs are neither dispatched nor recorded', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  try {
    const result = await runOnce({
      prs: [pr({ id: 1, title: 'Ready' }), pr({ id: 2, title: 'WIP', isDraft: true })],
      state: { ...baseState, initialized: true, seen_pr_ids: [] },
      receiver: recv, azBin, workDir, outDir, runId: 'run_draft',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1, 'only the non-draft PR dispatches');
    assert.match(recv.calls[0].body.prompt, /\b1\b/);
    assert.doesNotMatch(recv.calls[0].body.prompt, /WIP/);
    assert.deepEqual([...result.stdout_parsed.state.seen_pr_ids].sort(), ['1'],
      'draft must not enter the cursor when include_drafts is false');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('include_drafts=true: draft PRs are dispatched', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  try {
    const result = await runOnce({
      prs: [pr({ id: 2, title: 'WIP feature', isDraft: true })],
      state: { ...baseState, initialized: true, seen_pr_ids: [], include_drafts: true },
      receiver: recv, azBin, workDir, outDir, runId: 'run_draft_on',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1, 'draft dispatches when include_drafts is true');
    assert.match(recv.calls[0].body.prompt, /WIP feature/);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('opened_by filter: only PRs authored by the configured user dispatch', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  try {
    const result = await runOnce({
      prs: [
        pr({ id: 10, title: 'Mine', createdBy: 'me@ms.com' }),
        pr({ id: 11, title: 'Theirs', createdBy: 'other@ms.com' }),
      ],
      state: { ...baseState, initialized: true, seen_pr_ids: [], opened_by: 'me@ms.com' },
      receiver: recv, azBin, workDir, outDir, runId: 'run_openedby',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
    assert.match(recv.calls[0].body.prompt, /Mine/);
    assert.deepEqual([...result.stdout_parsed.state.seen_pr_ids].sort(), ['10']);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('assigned_to filter: only PRs with the configured reviewer dispatch', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  try {
    const result = await runOnce({
      prs: [
        pr({ id: 20, title: 'Needs me', reviewers: ['me@ms.com', 'x@ms.com'] }),
        pr({ id: 21, title: 'Not me', reviewers: ['x@ms.com'] }),
      ],
      state: { ...baseState, initialized: true, seen_pr_ids: [], assigned_to: 'me@ms.com' },
      receiver: recv, azBin, workDir, outDir, runId: 'run_assignedto',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
    assert.match(recv.calls[0].body.prompt, /Needs me/);
    assert.deepEqual([...result.stdout_parsed.state.seen_pr_ids].sort(), ['20']);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('two-tick dedup: baseline then a genuinely new PR dispatches exactly once', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir1 = freshDir('cdb-prwatch-out-');
  const outDir2 = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  try {
    // Tick 1: cold start, no `initialized` → baseline both, dispatch none.
    const tick1 = await runOnce({
      prs: [pr({ id: 301, title: 'Existing A' }), pr({ id: 302, title: 'Existing B' })],
      state: { ...baseState },
      receiver: recv, azBin, workDir, outDir: outDir1, runId: 'run_t1',
    });
    assert.equal(tick1.exit_code, 0, `tick1 stderr: ${tick1.stderr}`);
    assert.equal(recv.calls.length, 0, 'baseline dispatches nothing');
    const cursor = tick1.stdout_parsed.state;

    // Tick 2: replay cursor, a NEW PR 303 appears → dispatch only 303.
    const tick2 = await runOnce({
      prs: [
        pr({ id: 301, title: 'Existing A' }),
        pr({ id: 302, title: 'Existing B' }),
        pr({ id: 303, title: 'Brand new' }),
      ],
      state: { ...baseState, ...cursor },
      receiver: recv, azBin, workDir, outDir: outDir2, runId: 'run_t2',
    });
    assert.equal(tick2.exit_code, 0, `tick2 stderr: ${tick2.stderr}`);
    assert.equal(recv.calls.length, 1, 'only the new PR dispatches on tick 2');
    assert.match(recv.calls[0].body.prompt, /Brand new/);
    assert.deepEqual([...tick2.stdout_parsed.state.seen_pr_ids].sort(), ['301', '302', '303']);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir1, outDir2);
  }
});

test('callback failure: exits non-zero and does NOT advance the cursor past the undispatched PR', async () => {
  const recv = await startReceiver(500); // dispatch endpoint fails
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  try {
    const result = await runOnce({
      prs: [pr({ id: 900, title: 'Should not be marked seen' })],
      state: { ...baseState, initialized: true, seen_pr_ids: [] },
      receiver: recv, azBin, workDir, outDir, runId: 'run_fail',
    });
    assert.notEqual(result.exit_code, 0, 'a failed callback must exit non-zero');
    // The undispatched PR must NOT be recorded as seen — either no state is
    // emitted, or the emitted cursor still lacks 900.
    const seen = result.stdout_parsed?.state?.seen_pr_ids ?? [];
    assert.ok(!seen.map(String).includes('900'),
      'must not persist a cursor that skips the undispatched PR');
    // An error observation is still written for the operator.
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.status, 'error');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('CLI failure: az error exits non-zero, writes an error observation, dispatches nothing', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeFailingAzStub(workDir);
  try {
    const result = await runOnce({
      prs: [pr({ id: 1, title: 'unused' })], // fixture ignored; stub exits 1
      state: { ...baseState },
      receiver: recv, azBin, workDir, outDir, runId: 'run_clifail',
    });
    assert.notEqual(result.exit_code, 0, 'az failure must exit non-zero');
    assert.equal(recv.calls.length, 0, 'no dispatch on CLI failure');
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.status, 'error');
    assert.ok(obs.error, 'error observation records the failure message');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('workspace_path: worktree_path is sent to spawn as workspace_path, not workspace_id', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  const worktree = join(workDir, 'agent-worktree');
  try {
    const result = await runOnce({
      prs: [pr({ id: 42, title: 'Needs a worktree' })],
      state: { ...baseState, initialized: true, seen_pr_ids: [], worktree_path: worktree },
      receiver: recv, azBin, workDir, outDir, runId: 'run_ws',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
    assert.equal(recv.calls[0].body.workspace_path, worktree);
    assert.equal(recv.calls[0].body.workspace_id, undefined);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('dispatch_url preferred: POSTs to dispatch_url (prompt only) when present', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzStub(workDir);
  try {
    const result = await runOnce({
      prs: [pr({ id: 77, title: 'Dispatch me' })],
      state: { ...baseState, initialized: true, seen_pr_ids: [], worktree_path: join(workDir, 'wt') },
      receiver: recv, azBin, workDir, outDir, runId: 'run_dispatch', useDispatch: true,
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
    assert.match(recv.calls[0].path, /^\/dispatch/, 'must POST to dispatch_url, not spawn_url');
    // dispatch_url takes a prompt only — no workspace_path / agent routing.
    assert.equal(recv.calls[0].body.workspace_path, undefined);
    assert.match(recv.calls[0].body.prompt, /Dispatch me/);
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

// ---------------------------------------------------------------------------
// Command-injection / argv-safety regression tests.
//
// The watcher builds the `az repos pr list` invocation from operator-supplied
// org / project / repo values. These MUST be passed as discrete argv elements
// (execFileSync/spawnSync, shell:false) — never interpolated into a shell
// command string. Otherwise a project named "My Proj" breaks, and a value
// containing shell metacharacters could execute arbitrary commands on the
// host that runs the trigger.
// ---------------------------------------------------------------------------

test('argv safety: org/project/repo with spaces arrive as single literal argv elements', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const argvLog = join(workDir, 'az-argv.json');
  const azBin = makeAzStub(workDir);
  const spacedProject = 'My Cool Project';
  const spacedRepo = 'my repo';
  const spacedOrg = 'my org';
  try {
    const result = await runOnce({
      prs: [pr({ id: 1, title: 'baseline' })],
      state: { org: spacedOrg, project: spacedProject, repo: spacedRepo }, // baseline tick
      receiver: recv, azBin, workDir, outDir, argvLog, runId: 'run_spaces',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
    // The exact shape the watcher must emit, argument by argument.
    assert.deepEqual(argv, [
      'repos', 'pr', 'list',
      '--repository', spacedRepo,
      '--status', 'active',
      '--org', `https://dev.azure.com/${spacedOrg}`,
      '--project', spacedProject,
      '-o', 'json',
    ], 'each spaced value must be one literal argv element, not split on spaces');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

test('injection safety: shell metacharacters in project/repo do not execute and arrive literally', async () => {
  const recv = await startReceiver();
  const workDir = freshDir('cdb-prstub-');
  const outDir = freshDir('cdb-prwatch-out-');
  const argvLog = join(workDir, 'az-argv.json');
  const marker = join(workDir, 'PWNED.txt');
  const azBin = makeAzStub(workDir);
  // Payloads valid across POSIX sh and Windows cmd.exe. If the value were ever
  // handed to a shell, one of these separators would spawn the marker command.
  const evilProject = `MyProj & echo pwned> "${marker}" & type nul> "${marker}"`;
  const evilRepo = `repo; touch "${marker}"; $(touch "${marker}")`;
  try {
    const result = await runOnce({
      prs: [pr({ id: 1, title: 'baseline' })],
      state: { org: 'myorg', project: evilProject, repo: evilRepo }, // baseline tick
      receiver: recv, azBin, workDir, outDir, argvLog, runId: 'run_inject',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    // The tell-tale of injection: the marker command ran on the host.
    assert.equal(existsSync(marker), false,
      'metacharacters must NOT be interpreted by a shell (no marker file created)');
    const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
    const repoIdx = argv.indexOf('--repository');
    const projIdx = argv.indexOf('--project');
    assert.equal(argv[repoIdx + 1], evilRepo, 'repo must arrive as one literal, unmodified argv element');
    assert.equal(argv[projIdx + 1], evilProject, 'project must arrive as one literal, unmodified argv element');
  } finally {
    await recv.stop();
    cleanup(workDir, outDir);
  }
});

// ---------------------------------------------------------------------------
// Windows MSI shell-free launch regression tests (the reason this fix exists).
//
// Fresh real evidence: `Get-Command az` on Windows resolves
// `…\Azure\CLI2\wbin\az.cmd`, whose body is merely
// `"%~dp0\..\python.exe" -IBm azure.cli %*`. The earlier fix launched via
// `cmd.exe /d /s /c <az.cmd> …`, which re-exposed operator values to cmd's
// metacharacter parser: a SPACE-FREE `repo&echo x>marker` is NOT quoted by
// Node (no whitespace) so cmd splits it and runs the injected command. No
// quoting or ADO-name validation closes that — only removing the shell does.
//
// The watcher now resolves az.cmd, derives the sibling `..\python.exe`, and
// invokes the interpreter DIRECTLY (spawnSync, shell:false). These tests
// exercise the REAL MSI layout (POSIX: a direct sh `az`) with a PLAIN-string
// CLAWDEVBOX_AZ_BIN — the actual deployment shape — resolved by explicit path
// and bare off PATH, and prove that BOTH spaced AND space-free metacharacters
// survive as literal argv with no marker file. The space-free case FAILS under
// the old cmd.exe wrapper (marker created / argv truncated) and PASSES only
// once the shell is eliminated.
// ---------------------------------------------------------------------------

test('windows MSI (explicit az.cmd path): resolves the sibling python and runs shell-free (no ENOENT/EFTYPE)', async () => {
  const recv = await startReceiver();
  const root = freshDir('cdb-prmsi-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azBin = makeAzMsi(root); // plain path to wbin/az.cmd (win) / az (posix)
  try {
    const result = await runOnce({
      prs: [pr({ id: 4242, title: 'MSI PR' })],
      state: { ...baseState, initialized: true, seen_pr_ids: [] },
      receiver: recv, azBin, workDir: root, outDir, runId: 'run_msi_explicit',
    });
    assert.equal(result.exit_code, 0,
      `real az.cmd MSI layout must launch shell-free via the sibling python. stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr ?? '', /ENOENT|EFTYPE|EINVAL|spawnSync/i,
      'must not fail with a spawn error against the real MSI layout');
    assert.equal(recv.calls.length, 1, 'the new PR from the az output must dispatch');
    assert.match(recv.calls[0].body.prompt, /MSI PR/);
    assert.deepEqual([...result.stdout_parsed.state.seen_pr_ids].sort(), ['4242']);
  } finally {
    await recv.stop();
    cleanup(root, outDir);
  }
});

test('windows MSI (bare `az` off PATH): resolves az.cmd via where.exe → sibling python, shell-free', async () => {
  const recv = await startReceiver();
  const root = freshDir('cdb-prmsi-');
  const outDir = freshDir('cdb-prwatch-out-');
  const azCmd = makeAzMsi(root); // creates wbin/az.cmd + python.exe (win) / az (posix)
  const binDir = dirname(azCmd);
  try {
    const result = await runOnce({
      prs: [pr({ id: 808, title: 'Bare az PR' })],
      state: { ...baseState, initialized: true, seen_pr_ids: [] },
      receiver: recv,
      // Bare `az` is the production default on Windows (resolved via where.exe);
      // POSIX resolves the direct sh `az` by explicit path.
      azBin: process.platform === 'win32' ? 'az' : azCmd,
      workDir: root, outDir, runId: 'run_msi_bare',
      // Put the shim dir first on PATH so where.exe finds our az.cmd.
      extraEnv: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    });
    assert.equal(result.exit_code, 0,
      `bare \`az\` must resolve off PATH shell-free (not ENOENT). stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr ?? '', /ENOENT|EFTYPE|EINVAL|spawnSync/i,
      'bare az resolution must not fail with a spawn error');
    assert.equal(recv.calls.length, 1);
    assert.match(recv.calls[0].body.prompt, /Bare az PR/);
  } finally {
    await recv.stop();
    cleanup(root, outDir);
  }
});

test('windows MSI safety (spaced): & | > " ; $ via the default launcher stay literal argv and create no marker', async () => {
  const recv = await startReceiver();
  const root = freshDir('cdb-prmsi-');
  const outDir = freshDir('cdb-prwatch-out-');
  const argvLog = join(root, 'az-real-argv.json');
  const marker = join(root, 'SHIM_PWNED.txt');
  const azBin = makeAzMsi(root, { capture: true });
  // Every dangerous separator across cmd.exe AND POSIX sh: spaces, &, |, >,
  // double-quotes, semicolon, and $() / $VAR.
  const evilProject = `My Proj & echo pwned> "${marker}" | type nul; $(touch "${marker}") $HOME`;
  const evilRepo = `repo & echo x> "${marker}" ; touch "${marker}"`;
  try {
    const result = await runOnce({
      prs: [pr({ id: 1, title: 'baseline' })],
      state: { org: 'myorg', project: evilProject, repo: evilRepo }, // baseline tick
      receiver: recv, azBin, workDir: root, outDir, argvLog, runId: 'run_msi_inject',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(existsSync(marker), false,
      'metacharacters must NOT be interpreted by any shell (no marker file created)');
    const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
    assert.deepEqual(argv, [
      'repos', 'pr', 'list',
      '--repository', evilRepo,
      '--status', 'active',
      '--org', 'https://dev.azure.com/myorg',
      '--project', evilProject,
      '-o', 'json',
    ], 'every value must survive the shell-free launch as one literal argv element');
  } finally {
    await recv.stop();
    cleanup(root, outDir);
  }
});

test('windows MSI safety (SPACE-FREE): `&|>` via the default launcher stay literal argv and create no marker', async () => {
  const recv = await startReceiver();
  // Space-free payloads REQUIRE a space-free marker path — a single space
  // anywhere in an argv element makes Node quote the whole value, which masks
  // the vulnerability. This is the exact vector the cmd.exe wrapper cannot
  // defend: no whitespace → Node passes it unquoted → cmd splits on &|> and
  // runs the injected command (marker created, argv truncated). Only removing
  // the shell keeps every byte literal.
  const root = spaceFreeDir('cdb-sf-');
  const outDir = spaceFreeDir('cdb-sf-out-');
  const argvLog = join(root, 'az-sf-argv.json');
  const marker = join(root, 'SFMARK.txt');
  const azBin = makeAzMsi(root, { capture: true });
  const evilRepo = `repo&echo.>${marker}`;
  const evilProject = `proj|type.>${marker}&echo.>${marker}`;
  try {
    const result = await runOnce({
      prs: [pr({ id: 1, title: 'baseline' })],
      state: { org: 'myorg', project: evilProject, repo: evilRepo }, // baseline tick
      receiver: recv, azBin, workDir: root, outDir, argvLog, runId: 'run_sf_inject',
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(existsSync(marker), false,
      'space-free metacharacters must NOT be interpreted by any shell (no marker file created)');
    const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
    assert.deepEqual(argv, [
      'repos', 'pr', 'list',
      '--repository', evilRepo,
      '--status', 'active',
      '--org', 'https://dev.azure.com/myorg',
      '--project', evilProject,
      '-o', 'json',
    ], 'each space-free value must survive as one literal, unmodified argv element');
  } finally {
    await recv.stop();
    cleanup(root, outDir);
  }
});

test('windows MSI unsupported layout: az.cmd with no sibling python.exe fails safely (no cmd.exe fallback)', async () => {
  // A custom .cmd layout WITHOUT a bundled python must NOT silently fall back
  // to a shell. The watcher must exit non-zero with a clear error and dispatch
  // nothing. POSIX launches az directly (no python resolution), so this
  // Windows-only guard is skipped there.
  if (process.platform !== 'win32') return;
  const recv = await startReceiver();
  const root = freshDir('cdb-prbad-');
  const outDir = freshDir('cdb-prwatch-out-');
  // az.cmd with NO sibling python.exe.
  mkdirSync(join(root, 'wbin'), { recursive: true });
  const azCmd = join(root, 'wbin', 'az.cmd');
  writeFileSync(azCmd, '@echo off\r\necho custom shim\r\n');
  try {
    const result = await runOnce({
      prs: [pr({ id: 1, title: 'unused' })],
      state: { ...baseState },
      receiver: recv, azBin: azCmd, workDir: root, outDir, runId: 'run_bad_layout',
    });
    assert.notEqual(result.exit_code, 0, 'an unsupported az layout must fail, not fall back to a shell');
    assert.equal(recv.calls.length, 0, 'no dispatch when az cannot be launched');
    const obs = JSON.parse(readFileSync(join(outDir, 'observation.json'), 'utf8'));
    assert.equal(obs.status, 'error');
    assert.match(obs.error, /python\.exe|shell-free|unsupported/i,
      'the error must explain the missing bundled python / shell-free refusal');
  } finally {
    await recv.stop();
    cleanup(root, outDir);
  }
});
