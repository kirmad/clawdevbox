import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    url: `http://127.0.0.1:${port}/callback/test/abc`,
    calls,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

test('runner: Mode B-only script captures one POSTed callback', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('secret-mode-b');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-mode-b.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_modeb',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'secret-mode-b',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0, `stderr was: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
    assert.equal(recv.calls[0].body.prompt, 'mode-b heartbeat');
  } finally {
    await recv.stop();
  }
});

test('runner: Mode A-only script — stdout has callback object, no Mode B captures', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('secret-a');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-mode-a.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_modea',
        callback_url: recv.url, state: {}, payload: null,
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
  }
});

test('runner: Mode A+B — stdout has Mode A, receiver has Mode B', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('secret-ab');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-mode-ab.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_ab',
        callback_url: recv.url, state: {}, payload: null,
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
  }
});

test('runner: bad bearer token gets 401, captures empty', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('right-secret');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-bad-auth.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_bad',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'right-secret',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(recv.calls.length, 0);
    assert.match(result.stdout, /received 401/);
  } finally {
    await recv.stop();
  }
});

test('runner: timeout kills the process and reports timed_out', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('any');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'sleep-forever.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_to',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'any',
      timeoutMs: 800,
    });
    assert.equal(result.timed_out, true);
    assert.notEqual(result.exit_code, 0);
  } finally {
    await recv.stop();
  }
});
