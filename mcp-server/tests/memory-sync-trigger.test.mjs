/**
 * memory-sync-trigger.test.mjs
 *
 * Deterministic harness for the memory-sync trigger SCRIPT
 * (trigger-types/memory-sync/trigger.ts). Runs the real script with a
 * crafted envelope on stdin and a throwaway local HTTP server standing in
 * for spawn_url, then asserts the output / state / spawn-request contract.
 *
 * Covers: scope -> vault list, auto_push -> prompt text, the stdout state
 * contract the dispatcher reads back (dispatcher.ts parses stdout_parsed
 * .state), the spawn POST body, the Authorization header, and the
 * blocking-error path when no callback/spawn URL is available.
 *
 * No real vault, remote, or agent is touched — spawn_url points at a
 * loopback server that just records the request.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRIGGER = join(HERE, '..', 'trigger-types', 'memory-sync', 'trigger.ts');

/** Run trigger.ts with the given envelope on stdin. Returns exit/stdout/stderr. */
function runTrigger(envelope, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', TRIGGER], {
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(envelope));
  });
}

describe('memory-sync trigger script', () => {
  let server;
  let spawnUrl;
  let lastRequest;

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        lastRequest = {
          method: req.method,
          auth: req.headers['authorization'] ?? null,
          body: body ? JSON.parse(body) : null,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, session_id: 'stub' }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    spawnUrl = `http://127.0.0.1:${port}/spawn`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });

  function envelope(state, overrides = {}) {
    return {
      trigger_id: 'memory-sync-default',
      run_id: 'run_test',
      output_dir: HERE,
      spawn_url: spawnUrl,
      fired_by: 'cron',
      state: state ?? {},
      payload: null,
      ...overrides,
    };
  }

  test('scope=all: spawns agent, prompt lists both vaults, emits state contract', async () => {
    lastRequest = undefined;
    const { code, stdout, stderr } = await runTrigger(
      envelope({ vault_scope: 'all', auto_push: true }),
    );
    assert.equal(code, 0, `expected exit 0, got ${code}; stderr=${stderr}`);

    // Dispatcher reads back stdout_parsed.state — must be valid JSON with state.
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.state, 'stdout must carry a state object');
    assert.match(parsed.state.lastFiredAt ?? '', /^\d{4}-\d{2}-\d{2}T/,
      'state.lastFiredAt should be an ISO timestamp');
    assert.ok(typeof parsed.systemMessage === 'string' && parsed.systemMessage.includes('scope=all'));

    // Spawn request captured.
    assert.ok(lastRequest, 'trigger should POST to spawn_url');
    assert.equal(lastRequest.method, 'POST');
    assert.match(lastRequest.body.prompt, /Scope: personal, team vault\(s\)/);
    assert.match(lastRequest.body.prompt, /Auto-push: yes/);
    assert.equal(lastRequest.body.context.vault_scope, 'all');
  });

  test('scope=personal: prompt lists only the personal vault', async () => {
    lastRequest = undefined;
    const { code } = await runTrigger(envelope({ vault_scope: 'personal' }));
    assert.equal(code, 0);
    assert.match(lastRequest.body.prompt, /Scope: personal vault\(s\)/);
    assert.doesNotMatch(lastRequest.body.prompt, /team vault/);
    assert.equal(lastRequest.body.context.vault_scope, 'personal');
  });

  test('scope=team: prompt lists only the team vault', async () => {
    lastRequest = undefined;
    const { code } = await runTrigger(envelope({ vault_scope: 'team' }));
    assert.equal(code, 0);
    assert.match(lastRequest.body.prompt, /Scope: team vault\(s\)/);
    assert.equal(lastRequest.body.context.vault_scope, 'team');
  });

  test('auto_push=false is reflected in the prompt', async () => {
    lastRequest = undefined;
    const { code } = await runTrigger(envelope({ vault_scope: 'all', auto_push: false }));
    assert.equal(code, 0);
    assert.match(lastRequest.body.prompt, /Auto-push: no/);
  });

  test('injects Authorization bearer when the secret env var is set', async () => {
    lastRequest = undefined;
    await runTrigger(envelope({ vault_scope: 'all' }), { CLAWDEVBOX_MCP_SECRET: 'test-secret-123' });
    assert.equal(lastRequest.auth, 'Bearer test-secret-123');
  });

  test('blocking error (exit 2) when neither callback_url nor spawn_url is set', async () => {
    const { code, stderr } = await runTrigger(
      envelope({ vault_scope: 'all' }, { spawn_url: '' }),
    );
    assert.equal(code, 2, 'missing destination URL should be a blocking error (exit 2)');
    assert.match(stderr, /missing/i);
  });
});
