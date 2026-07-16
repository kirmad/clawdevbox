/**
 * dispatcher-find-live.test.mjs
 *
 * Regression for the smart-router live-detection bug:
 *   findLiveInstanceForSession used to filter by `status='running'` in
 *   the DB, then check the in-memory pty / tmux registries only. After a
 *   clawdevbox restart (or after an idle-reaper race) the registry is
 *   empty and the DB may flip rows to 'failure' too early — so a live
 *   tmux session bound to the cli_session_id would be invisible to the
 *   router. The router would then resume via the CLI, leaving the OLD
 *   tmux session running alongside a brand new one for the same logical
 *   session.
 *
 * Fix: findLiveInstanceForSession asks tmux directly (via
 *   tmuxSessionRuntime.list) as the source of truth, ignores DB status,
 *   adopts any unregistered live tmux session it finds, and self-heals
 *   the DB row back to status='running'. This test wires up a stub
 *   runtime + registry and verifies all four behaviors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import {
  tmuxSessionRegistry,
  _resetTmuxSessionRuntimeForTests,
  _setTmuxSessionRuntimeForTests,
} from '../src/cli-sessions/tmux-session-runtime.ts';

function open() {
  const db = new BetterSqlite3(':memory:');
  // Disable FKs — this test exercises lookup logic only, doesn't need
  // recipe_instances / triggers / fires rows wired up.
  db.pragma('foreign_keys = OFF');
  runMigrations(db);
  return db;
}

function makeWs() {
  return {
    projectDir: 'C:/test',
    globalDir: 'C:/test/.cdb',
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
  };
}

function insertSession(db, opts) {
  db.prepare(
    `INSERT INTO agent_sessions (
       id, workspace_id, recipe_instance_id, cli_session_id,
       agent_cli, interactive, status, end_reason,
       started_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.workspace_id,
    opts.recipe_instance_id,
    opts.cli_session_id,
    opts.agent_cli ?? 'copilot',
    opts.interactive ? 1 : 0,
    opts.status,
    opts.end_reason ?? null,
    opts.started_at ?? Date.now(),
    opts.ended_at ?? null,
  );
}

// Tiny in-memory stub runtime that mimics CliSessionRuntime.list() so we
// can simulate "tmux says session is alive" without forking a real tmux.
function stubRuntime(liveNames) {
  return {
    spawn: async () => { throw new Error('not implemented'); },
    attach: async (shortName) => {
      if (!liveNames.has(`cdb_${shortName}`)) return null;
      const session = {
        name: `cdb_${shortName}`,
        exited: new Promise(() => { /* never resolves in tests */ }),
        send: async () => {},
        write: async () => {},
        kill: async () => {},
      };
      return session;
    },
    list: async () => [...liveNames].map((name) => ({ name, alive: true })),
  };
}

function newDispatcher(db, ws) {
  return new Dispatcher(db, ws, { maxConcurrent: 1, drainMs: 50 });
}

test('findLiveInstanceForSession: tmux says alive even though DB says failure → returns id + self-heals', async (t) => {
  _resetTmuxSessionRuntimeForTests();
  tmuxSessionRegistry.__resetForTests();

  const liveNames = new Set(['cdb_inst-live']);
  _setTmuxSessionRuntimeForTests(stubRuntime(liveNames));

  const db = open();
  t.after(() => db.close());
  ensureWorkspace(db, { id: 'ws1', path: 'C:/ws1', kind: 'auto' });

  // Insert a row marked 'failure' (the bug scenario: DB drifted but tmux
  // session is actually still alive).
  insertSession(db, {
    id: 'as1', workspace_id: 'ws1',
    recipe_instance_id: 'inst-live', cli_session_id: 'guid-X',
    interactive: true, status: 'failure', end_reason: 'crashed',
    started_at: 1000, ended_at: 2000,
  });

  const d = newDispatcher(db, makeWs());
  const found = await d.findLiveInstanceForSession('guid-X');
  assert.equal(found, 'inst-live', 'tmux is source of truth — must find the live instance even when DB says failure');

  // Self-heal: DB row should now be flipped back to 'running'.
  const repaired = db
    .prepare(`SELECT status, ended_at, end_reason FROM agent_sessions WHERE id = 'as1'`)
    .get();
  assert.equal(repaired.status, 'running', 'self-heal: status flipped back to running');
  assert.equal(repaired.ended_at, null, 'self-heal: ended_at cleared');
  assert.equal(repaired.end_reason, null, 'self-heal: end_reason cleared');

  // Adopted into in-memory registry so dispatch path can pick it up.
  assert.ok(tmuxSessionRegistry.get('inst-live'), 'live tmux session adopted into registry');
});

test('findLiveInstanceForSession: returns newest live instance when multiple rows share the cli_session_id', async (t) => {
  _resetTmuxSessionRuntimeForTests();
  tmuxSessionRegistry.__resetForTests();

  const liveNames = new Set(['cdb_inst-new']);
  _setTmuxSessionRuntimeForTests(stubRuntime(liveNames));

  const db = open();
  t.after(() => db.close());
  ensureWorkspace(db, { id: 'ws1', path: 'C:/ws1', kind: 'auto' });

  // OLDEST resume — DB says running (stale) but tmux is gone.
  insertSession(db, {
    id: 'as_old', workspace_id: 'ws1',
    recipe_instance_id: 'inst-old', cli_session_id: 'guid-Y',
    interactive: true, status: 'running', started_at: 1000,
  });
  // NEWEST resume — tmux alive.
  insertSession(db, {
    id: 'as_new', workspace_id: 'ws1',
    recipe_instance_id: 'inst-new', cli_session_id: 'guid-Y',
    interactive: true, status: 'running', started_at: 5000,
  });

  const d = newDispatcher(db, makeWs());
  const found = await d.findLiveInstanceForSession('guid-Y');
  assert.equal(found, 'inst-new', 'newest live wins');
});

test('findLiveInstanceForSession: returns null when tmux has no matching session — caller will resume', async (t) => {
  _resetTmuxSessionRuntimeForTests();
  tmuxSessionRegistry.__resetForTests();

  const liveNames = new Set(); // tmux empty
  _setTmuxSessionRuntimeForTests(stubRuntime(liveNames));

  const db = open();
  t.after(() => db.close());
  ensureWorkspace(db, { id: 'ws1', path: 'C:/ws1', kind: 'auto' });

  insertSession(db, {
    id: 'as1', workspace_id: 'ws1',
    recipe_instance_id: 'inst-dead', cli_session_id: 'guid-Z',
    interactive: true, status: 'running', started_at: 1000,
  });

  const d = newDispatcher(db, makeWs());
  const found = await d.findLiveInstanceForSession('guid-Z');
  assert.equal(found, null, 'tmux is source of truth — null means caller must resume');
});

test('findLiveInstanceForSession: ignores headless (interactive=0) rows', async (t) => {
  _resetTmuxSessionRuntimeForTests();
  tmuxSessionRegistry.__resetForTests();

  const liveNames = new Set(['cdb_inst-headless']);
  _setTmuxSessionRuntimeForTests(stubRuntime(liveNames));

  const db = open();
  t.after(() => db.close());
  ensureWorkspace(db, { id: 'ws1', path: 'C:/ws1', kind: 'auto' });

  insertSession(db, {
    id: 'as_h', workspace_id: 'ws1',
    recipe_instance_id: 'inst-headless', cli_session_id: 'guid-H',
    interactive: false, status: 'running', started_at: 1000,
  });

  const d = newDispatcher(db, makeWs());
  const found = await d.findLiveInstanceForSession('guid-H');
  assert.equal(found, null, 'interactive=0 rows must never be returned as live dispatch targets');
});

