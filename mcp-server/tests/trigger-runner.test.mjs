import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function hasCmd(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Probe whether a runtime is genuinely usable, not just on PATH. On Windows,
 * `bash` may resolve to the WSL launcher (`C:\Windows\System32\bash.exe`) with
 * no distro installed; `where bash` succeeds but invoking it fails. The probe
 * runs `<cmd> <noopArg>` with a short timeout and checks the exit code.
 */
function runtimeUsable(cmd, noopArg) {
  if (!hasCmd(cmd)) return false;
  const r = spawnSync(cmd, [noopArg], { stdio: 'ignore', timeout: 3000, shell: process.platform === 'win32' });
  return r.status === 0;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, 'fixtures', 'trigger-runner');

async function startReceiver(secret) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${secret}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      calls.push({ path: req.url, method: req.method, body: parsed, received_at: Date.now() });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/spawn/test-abc`,
    calls,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

function freshOutDir() {
  return mkdtempSync(join(tmpdir(), 'cdb-trigger-runner-out-'));
}

function cleanOutDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('runner: script POSTs to spawn_url with one captured request', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('secret-mode-b');
  const outDir = freshOutDir();
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-mode-b.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_modeb',
        output_dir: outDir, spawn_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'secret-mode-b',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0, `stderr was: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
    assert.equal(recv.calls[0].body.prompt, 'mode-b heartbeat');
  } finally {
    await recv.stop();
    cleanOutDir(outDir);
  }
});

test('runner: stdout-only script — parsed stdout exposes callback object, no POST', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('secret-a');
  const outDir = freshOutDir();
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-mode-a.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_modea',
        output_dir: outDir, spawn_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'secret-a',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(recv.calls.length, 0);
    assert.ok(result.stdout_parsed && typeof result.stdout_parsed === 'object');
    assert.equal(result.stdout_parsed.callback.body.prompt, 'mode-a heartbeat');
  } finally {
    await recv.stop();
    cleanOutDir(outDir);
  }
});

test('runner: script can both POST to spawn_url AND emit stdout reply', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('secret-ab');
  const outDir = freshOutDir();
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-mode-ab.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_ab',
        output_dir: outDir, spawn_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'secret-ab',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(recv.calls.length, 1);
    assert.equal(recv.calls[0].body.prompt, 'mode-b leg');
    assert.equal(result.stdout_parsed.callback.body.prompt, 'mode-a leg');
  } finally {
    await recv.stop();
    cleanOutDir(outDir);
  }
});

test('runner: bad bearer token gets 401, captures empty', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('right-secret');
  const outDir = freshOutDir();
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-bad-auth.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_bad',
        output_dir: outDir, spawn_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'right-secret',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(recv.calls.length, 0);
    assert.match(result.stdout, /received 401/);
  } finally {
    await recv.stop();
    cleanOutDir(outDir);
  }
});

test('runner: timeout kills the process and reports timed_out', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('any');
  const outDir = freshOutDir();
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'sleep-forever.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_to',
        output_dir: outDir, spawn_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'any',
      timeoutMs: 800,
    });
    assert.equal(result.timed_out, true);
    assert.notEqual(result.exit_code, 0);
  } finally {
    await recv.stop();
    cleanOutDir(outDir);
  }
});

test('runner: node runtime', { skip: !hasCmd('node') }, async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('node-secret');
  const outDir = freshOutDir();
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat.js'),
      runtime: 'node',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_node',
        output_dir: outDir, spawn_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'node-secret', timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
  } finally { await recv.stop(); cleanOutDir(outDir); }
});

test('runner: python runtime', { skip: !hasCmd(process.platform === 'win32' ? 'python' : 'python3') }, async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('py-secret');
  const outDir = freshOutDir();
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat.py'),
      runtime: 'python',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_py',
        output_dir: outDir, spawn_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'py-secret', timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
  } finally { await recv.stop(); cleanOutDir(outDir); }
});

test('runner: bash runtime', { skip: !runtimeUsable('bash', '--version') }, async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('bash-secret');
  const outDir = freshOutDir();
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat.sh'),
      runtime: 'bash',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_bash',
        output_dir: outDir, spawn_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'bash-secret', timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
  } finally { await recv.stop(); cleanOutDir(outDir); }
});
