/**
 * local-trigger-functional.test.mjs
 *
 * ACTUAL-FUNCTIONALITY harness for the three real local trigger scripts:
 *
 *   1. local.recipe-cron  — ~/.clawdevbox/trigger-types/local.recipe-cron/trigger.ts
 *   2. local.vault-test   — <team-vault>/trigger-types/local.vault-test/trigger.ts
 *   3. memory-sync        — mcp-server/trigger-types/memory-sync/trigger.ts (git-tracked)
 *
 * Every scenario spawns the REAL script file as a child process, feeds it a
 * real TriggerEnvelope on stdin, and — where the script POSTs — points its
 * spawn_url at a real loopback HTTP server that records each request. We then
 * assert on the captured request body, the observation files the script wrote
 * to output_dir, the stdout state contract the dispatcher reads back, and the
 * exact call counts.
 *
 * Nothing real is touched: no agent is spawned (spawn_url is loopback), no
 * vault is synced, no git command is run, and no outbound network request
 * leaves the box. The memory-sync scenarios additionally point
 * CLAWDEVBOX_GLOBAL_DIR / CLAWDEVBOX_WORKSPACES_ROOT at throwaway temp dirs so
 * even an accidental vault touch would land in a sandbox.
 *
 * RED / negative-control: the recipe-cron dry-run contract is also run against
 * the saved PRE-FIX original, captured as a stable checked-in fixture
 * (tests/fixtures/trigger-functional/local-recipe-cron.prefix.ts) and executed
 * from a temp sandbox, to prove the historical broken behavior (exit 2, no
 * observation) before the current GREEN behavior (exit 0, dry_run, observation)
 * is asserted. The fixture keeps the control RED independent of repo HEAD.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- Stable, checked-in PRE-FIX fixtures (see fixtures/trigger-functional/README).
const FIXTURES = resolve(HERE, 'fixtures', 'trigger-functional');
// --- Strict opt-in: fail (don't silently skip) when a required local source is
// missing. Coordinator wires the local-only script with this flag set; it stays
// out of generic CI.
const STRICT = process.env.CDB_REQUIRE_LOCAL_TRIGGER_SOURCES === '1';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Copy a checked-in fixture's bytes into an isolated temp sandbox that carries
 * its own package.json, then return the sandbox path. Keeps tsx happy (ESM)
 * and guarantees we never write beside a real source tree.
 */
function loadFixture(fixtureName, runName, prefix) {
  const bytes = readFileSync(join(FIXTURES, fixtureName));
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const p = join(dir, runName);
  writeFileSync(p, bytes);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  return { dir, path: p, bytes };
}

// --- Real script locations (overridable via env for other machines) ---------
const RECIPE_CRON =
  process.env.CDB_RECIPE_CRON_TRIGGER ??
  join(homedir(), '.clawdevbox', 'trigger-types', 'local.recipe-cron', 'trigger.ts');
const VAULT_TEST =
  process.env.CDB_VAULT_TEST_TRIGGER ??
  join('C:', 'git', 'team-vault', 'trigger-types', 'local.vault-test', 'trigger.ts');
const MEMORY_SYNC = resolve(HERE, '..', 'trigger-types', 'memory-sync', 'trigger.ts');

// PRE-FIX original for the recipe-cron negative control. Previously this was
// read from a volatile `.worktrees/…/trigger.original.ts` path; now it is a
// stable, checked-in fixture, sandboxed so it runs through the same harness
// and stays RED independent of repository HEAD.
const recipeCronOriginal = existsSync(join(FIXTURES, 'local-recipe-cron.prefix.ts'))
  ? loadFixture('local-recipe-cron.prefix.ts', 'trigger.ts', 'cdb-prefix-recipe-cron-')
  : null;
const RECIPE_CRON_ORIGINAL = recipeCronOriginal?.path ?? join(FIXTURES, 'local-recipe-cron.prefix.ts');

/** Skip message for a missing local source; STRICT never skips (guard test fails instead). */
const skipIfMissing = (p, label) => {
  if (existsSync(p)) return false;
  if (STRICT) return false; // strict: run + let the guard/body fail loudly
  return `real script not found${label ? ` (${label})` : ''}; set the override env or CDB_REQUIRE_LOCAL_TRIGGER_SOURCES=1: ${p}`;
};
const TODAY = new Date().toISOString().slice(0, 10);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// --- Harness -----------------------------------------------------------------

/** Spawn a real trigger .ts through node+tsx with `envelope` on stdin. */
function runScript(scriptPath, envelope, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* not JSON (blocking error path) */ }
      resolvePromise({ code, stdout, stderr, parsed });
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

/** A real loopback HTTP server standing in for spawn_url. Records every hit. */
async function startLoopback() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      let json;
      try { json = body ? JSON.parse(body) : null; } catch { json = body; }
      calls.push({
        method: req.method,
        url: req.url,
        auth: req.headers['authorization'] ?? null,
        body: json,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, session_id: 'stub-loopback' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/spawn`,
    calls,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

// Every out dir is tracked so a single top-level `after` hook guarantees
// cleanup even when an assertion throws before a test's own finally runs.
const ALL_OUT_DIRS = [];
function freshOutDir() {
  const d = mkdtempSync(join(tmpdir(), 'cdb-local-trigger-out-'));
  ALL_OUT_DIRS.push(d);
  return d;
}
function cleanDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Global teardown: clean every tracked out dir + the recipe-cron fixture
// sandbox, no matter which test leaked or failed.
after(() => {
  for (const d of ALL_OUT_DIRS) cleanDir(d);
  if (recipeCronOriginal) cleanDir(recipeCronOriginal.dir);
});

// STRICT guard: with CDB_REQUIRE_LOCAL_TRIGGER_SOURCES=1, any missing required
// local source is a hard failure (not a silent skip). No-op otherwise.
test('STRICT: required local trigger sources are present (CDB_REQUIRE_LOCAL_TRIGGER_SOURCES=1)',
  { skip: STRICT ? false : 'strict local-source mode not enabled' }, () => {
    for (const [label, p] of [
      ['local.recipe-cron', RECIPE_CRON],
      ['local.vault-test', VAULT_TEST],
      ['memory-sync', MEMORY_SYNC],
      ['recipe-cron pre-fix fixture', join(FIXTURES, 'local-recipe-cron.prefix.ts')],
    ]) {
      assert.ok(existsSync(p), `required local source missing (${label}): ${p}`);
    }
  });
function readObservation(outDir) {
  const p = join(outDir, 'recipe-cron.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// =============================================================================
// 1. local.recipe-cron
// =============================================================================
describe('local.recipe-cron (real script)', () => {
  const CRON_STATE = {
    recipe_id: 'forge-bug-triage-sweep',
    recipe_inputs: { repo: 'clawdevbox', severity: 'high' },
    session_id_prefix: 'triage',
    workspace_path: 'C:/work/ws',
    provider: 'copilot',
    prompt_addendum: 'End of quarter - be thorough.',
  };

  test('production fire: exactly one spawn POST with full recipe.instance.begin prompt, inputs, session, overrides + observation will_post=true',
    { skip: skipIfMissing(RECIPE_CRON) }, async () => {
      const recv = await startLoopback();
      const outDir = freshOutDir();
      try {
        const { code, parsed, stderr } = await runScript(RECIPE_CRON, {
          trigger_event_name: 'TriggerFired',
          trigger_id: 'recipe-cron-triage',
          run_id: 'run_prod',
          output_dir: outDir,
          spawn_url: recv.url,
          fired_by: 'cron',
          state: CRON_STATE,
          payload: null,
        });

        assert.equal(code, 0, `expected exit 0; stderr=${stderr}`);

        // Exactly one POST to the loopback spawn endpoint.
        assert.equal(recv.calls.length, 1, 'should POST exactly once');
        const call = recv.calls[0];
        assert.equal(call.method, 'POST');

        // Full recipe.instance.begin prompt.
        assert.match(call.body.prompt,
          /recipe\.instance\.begin\(\{ template_id: "forge-bug-triage-sweep", inputs: <inputs below> \}\)/);
        // Inputs are embedded verbatim.
        assert.match(call.body.prompt, /"repo": "clawdevbox"/);
        assert.match(call.body.prompt, /"severity": "high"/);
        // Prompt addendum appended.
        assert.match(call.body.prompt, /End of quarter - be thorough\./);

        // Daily session id = <prefix>-<YYYY-MM-DD>.
        assert.equal(call.body.session_id, `triage-${TODAY}`);
        // provider / workspace_path overrides forwarded.
        assert.equal(call.body.provider, 'copilot');
        assert.equal(call.body.workspace_path, 'C:/work/ws');
        // context echoes source + recipe id.
        assert.equal(call.body.context.source, 'local.recipe-cron');
        assert.equal(call.body.context.recipe_id, 'forge-bug-triage-sweep');

        // stdout state contract: bootstrapped + lastFiredAt.
        assert.ok(parsed && parsed.state, 'stdout must carry a state object');
        assert.equal(parsed.state.bootstrapped, true, 'state.bootstrapped must be true after a fire');
        assert.match(parsed.state.lastFiredAt ?? '', ISO_RE, 'state.lastFiredAt must be ISO');
        assert.equal(parsed.state.lastPlannedAt, undefined, 'production fire must not set lastPlannedAt');

        // Observation file written with will_post=true.
        const obs = readObservation(outDir);
        assert.ok(obs, 'recipe-cron.json observation must be written');
        assert.equal(obs.will_post, true, 'observation.will_post must be true in production mode');
        assert.equal(obs.recipe_id, 'forge-bug-triage-sweep');
        assert.equal(obs.session_id, `triage-${TODAY}`);
      } finally {
        await recv.stop();
        cleanDir(outDir);
      }
    });

  test('test-mode (empty spawn_url): no POST, writes observation, emits dry_run + lastPlannedAt, never sets lastFiredAt [GREEN]',
    { skip: skipIfMissing(RECIPE_CRON) }, async () => {
      const recv = await startLoopback(); // present but must receive nothing
      const outDir = freshOutDir();
      try {
        const { code, parsed, stderr } = await runScript(RECIPE_CRON, {
          trigger_event_name: 'TriggerFired',
          trigger_id: 'recipe-cron-triage',
          run_id: 'run_dry',
          output_dir: outDir,
          spawn_url: '',            // <- test/dry-run mode
          fired_by: 'manual',
          state: CRON_STATE,
          payload: null,
        });

        assert.equal(code, 0, `dry-run must exit 0; stderr=${stderr}`);
        assert.equal(recv.calls.length, 0, 'dry-run must NOT POST');

        assert.ok(parsed, 'dry-run must emit JSON on stdout');
        assert.equal(parsed.dry_run, true, 'stdout must flag dry_run=true');
        assert.ok(parsed.planned, 'stdout must carry the planned observation');
        assert.match(parsed.state.lastPlannedAt ?? '', ISO_RE, 'state.lastPlannedAt must be ISO');
        assert.equal(parsed.state.lastFiredAt, undefined, 'dry-run must NOT set lastFiredAt');

        const obs = readObservation(outDir);
        assert.ok(obs, 'dry-run must still write the recipe-cron.json observation');
        assert.equal(obs.will_post, false, 'observation.will_post must be false in dry-run mode');
      } finally {
        await recv.stop();
        cleanDir(outDir);
      }
    });

  test('RED negative-control: PRE-FIX original errors (exit 2) and writes NO observation on the dry-run envelope',
    { skip: skipIfMissing(RECIPE_CRON_ORIGINAL) }, async () => {
      const recv = await startLoopback();
      const outDir = freshOutDir();
      try {
        // HEAD-independence: the committed pre-fix fixture must genuinely differ
        // from the current (fixed) live recipe-cron script — proof this is a
        // stable RED and not re-derived from a now-fixed HEAD.
        if (recipeCronOriginal && existsSync(RECIPE_CRON)) {
          assert.notEqual(sha256(recipeCronOriginal.bytes), sha256(readFileSync(RECIPE_CRON)),
            'pre-fix fixture must differ from the current recipe-cron script');
        }
        // Identical dry-run envelope as the GREEN test above.
        const { code, parsed, stderr } = await runScript(RECIPE_CRON_ORIGINAL, {
          trigger_event_name: 'TriggerFired',
          trigger_id: 'recipe-cron-triage',
          run_id: 'run_red',
          output_dir: outDir,
          spawn_url: '',
          fired_by: 'manual',
          state: CRON_STATE,
          payload: null,
        });

        // Historical broken behavior: blocking error instead of a dry-run plan.
        assert.equal(code, 2, 'pre-fix original must exit 2 (blockingError) on empty spawn_url');
        assert.match(stderr, /missing/i, 'pre-fix original errors with a "missing" message');
        assert.equal(recv.calls.length, 0, 'no POST either way');
        assert.equal(parsed, null, 'pre-fix original emits no dry_run JSON on stdout');
        assert.equal(readObservation(outDir), null,
          'pre-fix original never writes a recipe-cron.json observation');
      } finally {
        await recv.stop();
        cleanDir(outDir);
      }
    });

  test('RED negative-control: PRE-FIX original POSTs on a production fire but writes NO observation (observation feature is new)',
    { skip: skipIfMissing(RECIPE_CRON_ORIGINAL) }, async () => {
      const recv = await startLoopback();
      const outDir = freshOutDir();
      try {
        const { code } = await runScript(RECIPE_CRON_ORIGINAL, {
          trigger_event_name: 'TriggerFired',
          trigger_id: 'recipe-cron-triage',
          run_id: 'run_red2',
          output_dir: outDir,
          spawn_url: recv.url,
          fired_by: 'cron',
          state: CRON_STATE,
          payload: null,
        });
        assert.equal(code, 0, 'pre-fix original still fires in production mode');
        assert.equal(recv.calls.length, 1, 'pre-fix original does POST');
        assert.equal(readObservation(outDir), null,
          'pre-fix original writes NO observation even on a production fire');
      } finally {
        await recv.stop();
        cleanDir(outDir);
      }
    });
});

// =============================================================================
// 2. local.vault-test  (team-vault script)
// =============================================================================
describe('local.vault-test (real team-vault script)', () => {
  test('normal greeting: echoes exact state + fixed systemMessage, no callback',
    { skip: skipIfMissing(VAULT_TEST) }, async () => {
      const recv = await startLoopback();
      try {
        const { code, parsed, stderr } = await runScript(VAULT_TEST, {
          trigger_event_name: 'TriggerFired',
          trigger_id: 'vault-test-1',
          run_id: 'run_vt',
          output_dir: freshOutDir(),
          spawn_url: recv.url, // provided but the script must never POST
          fired_by: 'manual',
          state: { greeting: 'hello world' },
          payload: null,
        });
        assert.equal(code, 0, `stderr=${stderr}`);
        assert.equal(recv.calls.length, 0, 'vault-test must not POST any callback');
        assert.deepEqual(parsed, {
          state: { greeting: 'hello world' },
          systemMessage: 'vault-test fired',
        });
      } finally {
        await recv.stop();
      }
    });

  test('Unicode greeting round-trips byte-exact through stdin -> stdout',
    { skip: skipIfMissing(VAULT_TEST) }, async () => {
      const recv = await startLoopback();
      const greeting = 'こんにちは 🌍 Grüße — ¡hola!';
      try {
        const { code, parsed } = await runScript(VAULT_TEST, {
          trigger_event_name: 'TriggerFired',
          trigger_id: 'vault-test-2',
          run_id: 'run_vt_u',
          output_dir: freshOutDir(),
          spawn_url: recv.url,
          fired_by: 'manual',
          state: { greeting },
          payload: null,
        });
        assert.equal(code, 0);
        assert.equal(recv.calls.length, 0);
        assert.equal(parsed.state.greeting, greeting, 'Unicode greeting must survive intact');
        assert.equal(parsed.systemMessage, 'vault-test fired');
      } finally {
        await recv.stop();
      }
    });

  test('discovery metadata: template.yaml declares id + greeting parameter',
    { skip: skipIfMissing(VAULT_TEST) }, () => {
      const tpl = readFileSync(join(dirname(VAULT_TEST), 'template.yaml'), 'utf8');
      assert.match(tpl, /id:\s*local\.vault-test/);
      assert.match(tpl, /name:\s*greeting/);
      assert.match(tpl, /file:\s*trigger\.ts/);
    });
});

// =============================================================================
// 3. memory-sync (git-tracked script) — real spawn endpoint, synthetic vault env
// =============================================================================
describe('memory-sync (real tracked script)', () => {
  // Synthetic, throwaway vault chain/config so no real vault is ever touched.
  const VAULT_ROOT = mkdtempSync(join(tmpdir(), 'cdb-memsync-vault-'));
  const SYNTH_ENV = {
    CLAWDEVBOX_GLOBAL_DIR: join(VAULT_ROOT, 'global'),
    CLAWDEVBOX_WORKSPACES_ROOT: join(VAULT_ROOT, 'workspaces'),
  };

  function memEnvelope(state, overrides = {}) {
    return {
      trigger_event_name: 'TriggerFired',
      trigger_id: 'memory-sync-default',
      run_id: 'run_mem',
      output_dir: freshOutDir(),
      spawn_url: overrides.spawn_url,
      fired_by: 'cron',
      state,
      payload: null,
      ...overrides,
    };
  }

  test('scope=all + auto_push=false: exactly one spawn POST, prompt names both vaults + Auto-push:no, carries state',
    { skip: skipIfMissing(MEMORY_SYNC) }, async () => {
      const recv = await startLoopback();
      try {
        const { code, parsed, stderr } = await runScript(
          MEMORY_SYNC,
          memEnvelope({ vault_scope: 'all', auto_push: false }, { spawn_url: recv.url }),
          SYNTH_ENV,
        );
        assert.equal(code, 0, `stderr=${stderr}`);
        // The script's own single fetch is the ONLY outbound request — no git/network of its own.
        assert.equal(recv.calls.length, 1, 'exactly one spawn POST; no other requests');
        const call = recv.calls[0];
        assert.equal(call.method, 'POST');
        assert.match(call.body.prompt, /Scope: personal, team vault\(s\)/);
        assert.match(call.body.prompt, /Auto-push: no/); // respects auto_push=false
        assert.equal(call.body.context.vault_scope, 'all');
        assert.equal(call.body.session_id, `memory-sync-${TODAY}`);
        // state carried back on stdout.
        assert.ok(parsed && parsed.state, 'stdout must carry state');
        assert.match(parsed.state.lastFiredAt ?? '', ISO_RE);
      } finally {
        await recv.stop();
      }
    });

  test('scope=personal: prompt names ONLY the personal vault',
    { skip: skipIfMissing(MEMORY_SYNC) }, async () => {
      const recv = await startLoopback();
      try {
        const { code } = await runScript(
          MEMORY_SYNC,
          memEnvelope({ vault_scope: 'personal' }, { spawn_url: recv.url }),
          SYNTH_ENV,
        );
        assert.equal(code, 0);
        assert.equal(recv.calls.length, 1);
        assert.match(recv.calls[0].body.prompt, /Scope: personal vault\(s\)/);
        assert.doesNotMatch(recv.calls[0].body.prompt, /team vault/);
        assert.equal(recv.calls[0].body.context.vault_scope, 'personal');
      } finally {
        await recv.stop();
      }
    });

  test('scope=team: prompt names ONLY the team vault',
    { skip: skipIfMissing(MEMORY_SYNC) }, async () => {
      const recv = await startLoopback();
      try {
        const { code } = await runScript(
          MEMORY_SYNC,
          memEnvelope({ vault_scope: 'team' }, { spawn_url: recv.url }),
          SYNTH_ENV,
        );
        assert.equal(code, 0);
        assert.equal(recv.calls.length, 1);
        assert.match(recv.calls[0].body.prompt, /Scope: team vault\(s\)/);
        assert.doesNotMatch(recv.calls[0].body.prompt, /personal, team|personal vault/);
        assert.equal(recv.calls[0].body.context.vault_scope, 'team');
      } finally {
        await recv.stop();
      }
    });

  test('no destination (empty spawn_url, no callback_url): blocking error exit 2, no POST',
    { skip: skipIfMissing(MEMORY_SYNC) }, async () => {
      const recv = await startLoopback();
      try {
        const { code, stderr } = await runScript(
          MEMORY_SYNC,
          memEnvelope({ vault_scope: 'all' }, { spawn_url: '' }),
          SYNTH_ENV,
        );
        assert.equal(code, 2, 'missing destination must be a blocking error (exit 2)');
        assert.match(stderr, /missing/i);
        assert.equal(recv.calls.length, 0);
      } finally {
        await recv.stop();
      }
    });

  test('active registration FK: ensureMemorySyncInstance seeds an enabled trigger against an existing workspace (FK ON)',
    () => {
      // Point the register at the synthetic vault root before it resolves a workspace.
      process.env.CLAWDEVBOX_GLOBAL_DIR = SYNTH_ENV.CLAWDEVBOX_GLOBAL_DIR;
      process.env.CLAWDEVBOX_WORKSPACES_ROOT = SYNTH_ENV.CLAWDEVBOX_WORKSPACES_ROOT;

      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          name TEXT,
          parent_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE triggers (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          name TEXT,
          params_json TEXT NOT NULL,
          cron_mode TEXT NOT NULL CHECK(cron_mode IN ('inherit','override','disabled')),
          cron_expression TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          registered_at INTEGER NOT NULL,
          state_json TEXT NOT NULL DEFAULT '{}'
        );
      `);

      return import('../src/memory-sync-register.ts').then(({ ensureMemorySyncInstance }) => {
        assert.doesNotThrow(() => ensureMemorySyncInstance(db),
          'registration must not fail the FK with foreign_keys ON');

        const trig = db.prepare(
          `SELECT workspace_id, enabled, state_json FROM triggers WHERE type='memory-sync'`,
        ).get();
        assert.ok(trig, 'a memory-sync trigger row must be registered');
        assert.equal(trig.enabled, 1, 'registered trigger must be active/enabled');

        // FK integrity: the referenced workspace row actually exists.
        const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(trig.workspace_id);
        assert.ok(ws, 'workspace_id must reference an existing workspaces row');

        // state_json seeds the config the script actually reads.
        const state = JSON.parse(trig.state_json);
        assert.equal(state.vault_scope, 'all');
        assert.equal(state.auto_push, true);

        db.close();
      });
    });

  after(() => cleanDir(VAULT_ROOT));
});
