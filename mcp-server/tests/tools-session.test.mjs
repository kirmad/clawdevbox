/**
 * tools-session.test.mjs — integration coverage for session.send / .read /
 * .kill / .list. Uses a fresh sqlite + dispatcher per test and stubs
 * recipe spawning for fast, deterministic helper-layer coverage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations, setDatabaseForTesting } from '../src/db/index.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { registerBuiltinProviders } from '../src/agent-clis/index.ts';
import { initTmuxSessionRuntime, tmuxSessionRegistry, tmuxSessionRuntime } from '../src/cli-sessions/tmux-session-runtime.ts';
import {
  spawnDispatchOrResume,
  readScrollbackHelper,
  killSession,
  listSessions,
} from '../src/session-helpers.ts';
import { _resetForTests as resetPtyRegistry } from '../src/pty-registry.ts';

process.env.NODE_ENV ??= 'test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_ROOT = resolve(__dirname, '.tmp', 'tools-session');

function freshDirs(name) {
  const root = join(TMP_ROOT, `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`);
  const projectDir = join(root, 'project');
  const globalDir = join(root, 'global');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  return { root, projectDir, globalDir };
}

function makeCfg(projectDir, globalDir, defaultAgentCli = 'echo-stub', workspacesRoot = null) {
  return {
    projectDir, globalDir,
    workspacesRoot: workspacesRoot ?? join(globalDir, 'workspaces'),
    defaultAgentCli,
    http: { host: '127.0.0.1', port: 0, token: null },
    tunnel: { kind: 'none', auto_start: false },
    vaults: [],
    clientSync: { mode: 'off' },
  };
}

function makeWs(projectDir, globalDir) {
  const ws = {
    projectDir, globalDir,
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
    agentCliProviders: new Map(),
  };
  registerBuiltinProviders(ws);
  return ws;
}

function makeFakeIPty({ clearOnKill = false } = {}) {
  const ee = new EventEmitter();
  let killed = false;
  const ipty = {
    pid: -1, cols: 80, rows: 24, process: 'fake',
    onData: (cb) => { ee.on('data', cb); return { dispose: () => ee.off('data', cb) }; },
    onExit: (cb) => { ee.on('exit', cb); return { dispose: () => ee.off('exit', cb) }; },
    write: () => {}, resize: () => {},
    kill: () => {
      killed = true;
      ee.emit('exit', { exitCode: 0 });
      if (clearOnKill) resetPtyRegistry();
    },
    clear: () => {}, pause: () => {}, resume: () => {},
  };
  return {
    ee,
    ipty,
    wasKilled: () => killed,
    emitData: (chunk) => ee.emit('data', chunk),
    emitExit: (exitCode = 0) => ee.emit('exit', { exitCode }),
  };
}

async function registerFakePty(instanceId, opts = {}) {
  const { registerPty } = await import('../src/pty-registry.ts');
  const fake = makeFakeIPty(opts);
  registerPty({
    instanceId,
    workspaceId: opts.workspaceId ?? 'w',
    cols: 80,
    rows: 24,
    ipty: fake.ipty,
    meta: opts.meta,
  });
  return fake;
}

function makeRunRecipeStub(db) {
  let seq = 0;
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    seq += 1;
    const now = Date.now();
    const instanceId = `inst_tools_session_${process.pid}_${now}_${seq}`;
    const recipeId = opts.recipeId ?? `__adhoc_${instanceId}`;
    const agentCli = opts.agentCli ?? 'echo-stub';
    const sessionId = opts.sessionId ?? `sess_tools_session_${seq}`;

    db.prepare(
      `INSERT INTO recipe_instances (
         id, recipe_id, recipe_snapshot_path, workspace_id, workspace_path,
         parent_recipe_instance_id, prompt, params_json, started_at, status,
         trigger_id, fire_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      instanceId,
      recipeId,
      '',
      opts.workspaceInfo.id,
      opts.workspaceInfo.path,
      opts.parentRecipeInstanceId ?? null,
      opts.prompt ?? '',
      JSON.stringify(opts.params ?? {}),
      now,
      opts.triggerId ?? null,
      opts.fireId ?? null,
    );

    db.prepare(
      `INSERT INTO agent_sessions (
         id, cli_session_id, recipe_instance_id, recipe_step_id, workspace_id,
         agent_cli, pid, started_at, status, resume_of_agent_session_id, interactive
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'running', NULL, 1)`,
    ).run(
      `as_tools_session_${process.pid}_${now}_${seq}`,
      sessionId,
      instanceId,
      opts.workspaceInfo.id,
      agentCli,
      -1,
      now,
    );

    await registerFakePty(instanceId, {
      workspaceId: opts.workspaceInfo.id,
      clearOnKill: true,
      meta: {
        cwd: opts.workspaceInfo.path,
        commandLine: 'stub',
        agentCli,
        sessionId,
        recipeId,
      },
    });

    return {
      recipe_instance_id: instanceId,
      recipe_id: recipeId,
      adhoc: true,
      workspace_id: opts.workspaceInfo.id,
      workspace_path: opts.workspaceInfo.path,
      attach_to_inbox_item_id: null,
      pid: -1,
      agent_cli: agentCli,
      session_id: sessionId,
      resume_of: opts.resumeOf ?? null,
      status: 'spawned',
      log_path: join(opts.workspaceInfo.path, '.clawdevbox', 'instances', `${instanceId}.log`),
      view_url: null,
    };
  };
  return { fn, calls };
}

async function setupHarness(options = {}) {
  const dirs = freshDirs(options.name ?? 'h');
  writeFileSync(join(dirs.projectDir, '.mcp.json'), '{}');

  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  setDatabaseForTesting(db);

  const ws = makeWs(dirs.projectDir, dirs.globalDir);
  const workspacesRoot = join(dirs.root, 'workspaces');
  // The ensureWorkspace helper in db/workspaces-store.ts mirrors to the
  // on-disk index using resolveWorkspacesRoot(), which reads the env var.
  // Point both at the same temp path so auto-managed workspaces don't leak
  // to ~/.clawdevbox/workspaces.
  const prevEnv = process.env.CLAWDEVBOX_WORKSPACES_ROOT;
  process.env.CLAWDEVBOX_WORKSPACES_ROOT = workspacesRoot;
  const cfg = makeCfg(dirs.projectDir, dirs.globalDir,
    options.defaultAgentCli ?? 'echo-stub', workspacesRoot);
  const stub = makeRunRecipeStub(db);
  const dispatcher = new Dispatcher(db, ws, {
    defaultAgentCli: options.defaultAgentCli ?? 'echo-stub',
    ...(options.useRealRunRecipe ? {} : { runRecipeFn: stub.fn }),
  });
  const dispatches = [];
  if (!options.useRealRunRecipe) {
    dispatcher.dispatchToInstance = async (instanceId, prompt) => {
      dispatches.push({ instanceId, prompt });
      return { status: 'ok', state: 'dispatched', dispatchId: `dispatch_${dispatches.length}` };
    };
  }

  initTmuxSessionRuntime({ socket: null, configPath: null });

  const ctx = { db, dispatcher, ws, cfg };
  return {
    ctx,
    workspacesRoot,
    spawnCalls: stub.calls,
    dispatches,
    cleanup() {
      for (const e of tmuxSessionRegistry.list()) {
        try { spawnSync('tmux', ['kill-session', '-t', `cdb_${e.instanceId}`], { windowsHide: true, timeout: 2000 }); } catch {}
      }
      try { tmuxSessionRegistry.__resetForTests(); } catch {}
      try { resetPtyRegistry(); } catch {}
      try { setDatabaseForTesting(null); } catch {}
      try { db.close(); } catch {}
      try { rmSync(dirs.root, { recursive: true, force: true }); } catch {}
      if (prevEnv === undefined) delete process.env.CLAWDEVBOX_WORKSPACES_ROOT;
      else process.env.CLAWDEVBOX_WORKSPACES_ROOT = prevEnv;
    },
  };
}

function hasTmux() {
  return spawnSync('tmux', ['-V'], { windowsHide: true, encoding: 'utf8' }).status === 0;
}

function spawnTmuxSession(name, code) {
  const r = spawnSync('tmux', [
    'new-session', '-d', '-s', name, '--', process.execPath, '-e', code,
  ], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, `tmux new-session failed: ${r.stderr || r.stdout}`);
}

async function waitFor(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Tests
// ============================================================================

test('1. session.send: no session_id spawns fresh', async () => {
  const h = await setupHarness();
  try {
    const r = await spawnDispatchOrResume(h.ctx, {
      prompt: 'hi',
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'spawn');
    assert.ok(r.instance_id);
    assert.ok(r.session_id);
  } finally { h.cleanup(); }
});

test('2. session.send: same alias second call dispatches', async () => {
  const h = await setupHarness();
  try {
    const r1 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'first', session_id: 'alias-X', default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r1.mode, 'spawn');
    const r2 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'second', session_id: 'alias-X', default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r2.mode, 'dispatch');
    assert.equal(r2.instance_id, r1.instance_id);
    assert.equal(r2.session_id, r1.session_id);
    assert.equal(h.dispatches.length, 1);
  } finally { h.cleanup(); }
});

test('3. session.send: 5 concurrent same-alias calls → 1 spawn + 4 dispatches', async () => {
  const h = await setupHarness();
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        spawnDispatchOrResume(h.ctx, {
          prompt: 'p', session_id: 'race-Y', default_workspace_path: h.ctx.ws.projectDir,
        })),
    );
    const spawns = results.filter((r) => r.ok && r.mode === 'spawn');
    const dispatches = results.filter((r) => r.ok && r.mode === 'dispatch');
    assert.equal(spawns.length, 1, `expected exactly 1 spawn, got ${spawns.length}`);
    assert.equal(dispatches.length, 4);
    assert.equal(h.spawnCalls.length, 1);
    assert.equal(h.dispatches.length, 4);
    const uniqueInstances = new Set(results.map((r) => r.ok && r.instance_id));
    assert.equal(uniqueInstances.size, 1);
  } finally { h.cleanup(); }
});

test('4. session.send: no provider and no default → PROVIDER_REQUIRED', async () => {  const h = await setupHarness();
  try {
    h.ctx.cfg.defaultAgentCli = undefined;
    const r = await spawnDispatchOrResume(h.ctx, { prompt: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PROVIDER_REQUIRED');
  } finally { h.cleanup(); }
});

test('4a. session.send: model/context_tier/reasoning_effort propagate to runRecipe', async () => {
  const h = await setupHarness();
  try {
    const r = await spawnDispatchOrResume(h.ctx, {
      prompt: 'x',
      session_id: 'quality-Z',
      provider: 'copilot',
      default_workspace_path: h.ctx.ws.projectDir,
      model: 'gpt-5.2',
      context_tier: 'long_context',
      reasoning_effort: 'high',
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'spawn');
    assert.equal(h.spawnCalls.length, 1);
    assert.equal(h.spawnCalls[0].model, 'gpt-5.2',
      'model must reach runRecipe via spawnFromCallback');
    assert.equal(h.spawnCalls[0].contextTier, 'long_context',
      'context_tier must reach runRecipe via spawnFromCallback');
    assert.equal(h.spawnCalls[0].reasoningEffort, 'high',
      'reasoning_effort must reach runRecipe via spawnFromCallback');
  } finally { h.cleanup(); }
});

test('5. session.send: default_workspace_path used when neither id nor path given', async () => {
  const h = await setupHarness();
  try {
    const r = await spawnDispatchOrResume(h.ctx, {
      prompt: 'x',
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'spawn');
    const row = h.ctx.db.prepare('SELECT path FROM workspaces WHERE path = ?')
      .get(h.ctx.ws.projectDir);
    assert.ok(row, 'workspace should have been created');
  } finally { h.cleanup(); }
});

test('5a. session.send: no workspace at all → auto-creates under cfg.workspacesRoot', async () => {
  const h = await setupHarness();
  try {
    const r = await spawnDispatchOrResume(h.ctx, {
      prompt: 'hi', session_id: 'auto-ws-A',
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'spawn');
    assert.ok(r.workspace_id, 'workspace_id should be returned');
    assert.ok(r.workspace_path, 'workspace_path should be returned');
    assert.ok(r.workspace_id.startsWith('ws_'), `expected ws_ prefix, got ${r.workspace_id}`);
    assert.ok(
      r.workspace_path.startsWith(h.workspacesRoot),
      `workspace_path ${r.workspace_path} should be under ${h.workspacesRoot}`,
    );
    // The DB row exists and is named after the alias.
    const row = h.ctx.db.prepare('SELECT name FROM workspaces WHERE id = ?')
      .get(r.workspace_id);
    assert.equal(row.name, 'auto-ws-A');
  } finally { h.cleanup(); }
});

test('5b. session.send: second spawn with same session_id reuses the workspace', async () => {
  const h = await setupHarness();
  try {
    const r1 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'first', session_id: 'reuse-ws-A',
    });
    assert.equal(r1.mode, 'spawn');
    assert.ok(r1.workspace_id);

    // Simulate the prior session ending: archive its agent_sessions row
    // and clear the live pty so the next send falls through to SPAWN/RESUME.
    h.ctx.db.prepare(
      `UPDATE agent_sessions SET status='success', ended_at=? WHERE cli_session_id=?`,
    ).run(Date.now(), r1.session_id);
    resetPtyRegistry();

    const r2 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'second', session_id: 'reuse-ws-A',
    });
    assert.equal(r2.ok, true);
    // echo-stub doesn't support --resume → falls through to spawn, but with
    // the SAME workspace_id pinned to this session GUID.
    assert.equal(r2.mode, 'spawn');
    assert.equal(r2.workspace_id, r1.workspace_id,
      'second spawn with same session_id must reuse the workspace');
    assert.equal(r2.workspace_path, r1.workspace_path);
  } finally { h.cleanup(); }
});

test('5c. session.send: explicit workspace_path wins over auto-create', async () => {
  const h = await setupHarness();
  try {
    const r = await spawnDispatchOrResume(h.ctx, {
      prompt: 'x', session_id: 'explicit-ws-A',
      workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'spawn');
    assert.equal(r.workspace_path, h.ctx.ws.projectDir);
    // No ws_-prefixed auto-workspace was minted for this session.
    assert.ok(!r.workspace_id.match(/^ws_[a-z0-9]+_[0-9a-f]+$/) ||
      r.workspace_path === h.ctx.ws.projectDir,
      `expected explicit workspace, got ${r.workspace_path}`);
  } finally { h.cleanup(); }
});

test('6. session.read: pty incremental cursor', async () => {
  const h = await setupHarness();
  try {
    const fake = await registerFakePty('fake-ptyA');
    fake.emitData('AAA');
    const r1 = await readScrollbackHelper(h.ctx, { instance_id: 'fake-ptyA' });
    assert.equal(r1.ok, true);
    assert.equal(r1.result.backend, 'pty');
    assert.equal(r1.result.content, 'AAA');
    fake.emitData('BBB');
    const r2 = await readScrollbackHelper(h.ctx, { instance_id: 'fake-ptyA', since: r1.result.cursor });
    assert.equal(r2.ok, true);
    assert.equal(r2.result.content, 'BBB');
  } finally { h.cleanup(); }
});

test('7. session.read: pty truncated_before when cursor offset < head', async () => {
  const h = await setupHarness();
  try {
    const fake = await registerFakePty('fake-ptyB');
    const old = await readScrollbackHelper(h.ctx, { instance_id: 'fake-ptyB' });
    assert.equal(old.ok, true);
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 5; i += 1) fake.emitData(chunk);

    const r = await readScrollbackHelper(h.ctx, {
      instance_id: 'fake-ptyB',
      since: old.result.cursor,
      full: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.backend, 'pty');
    assert.equal(r.result.truncated_before, true);
    assert.ok(r.result.content.length < 5 * 64 * 1024);
  } finally { h.cleanup(); }
});

test('8. session.read: cursor with mismatched spawnTs → truncated_before', async () => {
  const h = await setupHarness();
  try {
    await registerFakePty('fake-ptyC');
    const old = await readScrollbackHelper(h.ctx, { instance_id: 'fake-ptyC' });
    assert.equal(old.ok, true);
    const meta1 = { spawnTs: Number(old.result.cursor.split(':')[1]) };
    resetPtyRegistry();
    await waitFor(25);
    const fake2 = await registerFakePty('fake-ptyC');
    fake2.emitData('new');

    const r = await readScrollbackHelper(h.ctx, {
      instance_id: 'fake-ptyC',
      since: old.result.cursor,
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.content, 'new');
    const meta2 = { spawnTs: Number(r.result.cursor.split(':')[1]) };
    assert.notEqual(meta2.spawnTs, meta1.spawnTs, 'spawnTs must differ — bump wait if same');
    assert.equal(r.result.truncated_before, true);
  } finally { h.cleanup(); }
});

test('9. session.read: raw=false strips ANSI; raw=true preserves', async () => {
  const h = await setupHarness();
  try {
    const fake = await registerFakePty('fake-ptyD');
    fake.emitData('\x1b[31mred\x1b[0m');

    const raw = await readScrollbackHelper(h.ctx, { instance_id: 'fake-ptyD', raw: true });
    assert.equal(raw.ok, true);
    assert.equal(raw.result.content, '\x1b[31mred\x1b[0m');

    const stripped = await readScrollbackHelper(h.ctx, { instance_id: 'fake-ptyD', raw: false });
    assert.equal(stripped.ok, true);
    assert.equal(stripped.result.content, 'red');
  } finally { h.cleanup(); }
});

test('10. session.read: tmux backend returns snapshot + supports_incremental=false', async (t) => {
  if (!hasTmux()) return t.skip('tmux not installed');

  const h = await setupHarness();
  const name = `test_xyz_${process.pid}_${Date.now()}`;
  try {
    spawnTmuxSession(`cdb_${name}`, "console.log('HELLO_TMUX'); setInterval(() => {}, 10000);");
    await waitFor(300);
    const r = await readScrollbackHelper(h.ctx, { instance_id: name });
    assert.equal(r.ok, true);
    assert.equal(r.result.backend, 'tmux');
    assert.equal(r.result.supports_incremental, false);
    assert.match(r.result.content, /HELLO_TMUX/);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', `cdb_${name}`], { windowsHide: true });
    h.cleanup();
  }
});

test('11. session.kill: live pty → kind=pty; second call → kind=not_live', async () => {
  const h = await setupHarness();
  try {
    const fake = await registerFakePty('kill-test', { clearOnKill: true });
    const r1 = await killSession(h.ctx, 'kill-test');
    assert.equal(r1.kind, 'pty');
    assert.equal(r1.killed, true);
    assert.equal(fake.wasKilled(), true);
    const r2 = await killSession(h.ctx, 'kill-test');
    assert.equal(r2.kind, 'not_live');
  } finally { h.cleanup(); }
});

test('12. session.kill: live tmux → kind=tmux', async (t) => {
  if (!hasTmux()) return t.skip('tmux not installed');

  const h = await setupHarness();
  const name = `kill_tmux_${process.pid}_${Date.now()}`;
  try {
    const session = await tmuxSessionRuntime().spawn({
      name,
      cwd: h.ctx.ws.projectDir,
      env: {},
      cols: 80,
      rows: 24,
      command: process.execPath,
      args: ['-e', "console.log('KILL_TMUX'); setInterval(() => {}, 10000);"],
    });
    tmuxSessionRegistry.register(name, session);

    const r = await killSession(h.ctx, name);
    assert.equal(r.kind, 'tmux');
    assert.equal(r.killed, true);
    await waitFor(100);
    const probe = spawnSync('tmux', ['has-session', '-t', `cdb_${name}`], { windowsHide: true });
    assert.notEqual(probe.status, 0, 'tmux session should be gone after killSession');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', `cdb_${name}`], { windowsHide: true });
    h.cleanup();
  }
});

test('13. session.list: returns just-spawned sessions', async () => {
  const h = await setupHarness();
  try {
    const r1 = await spawnDispatchOrResume(h.ctx, { prompt: 'x', session_id: 'L1', default_workspace_path: h.ctx.ws.projectDir });
    const r2 = await spawnDispatchOrResume(h.ctx, { prompt: 'y', session_id: 'L2', default_workspace_path: h.ctx.ws.projectDir });
    const r = await listSessions(h.ctx, { status: 'active' });
    const ids = r.items.map((i) => i.instance_id);
    assert.ok(ids.includes(r1.instance_id), `expected ${r1.instance_id} in ${ids.join(',')}`);
    assert.ok(ids.includes(r2.instance_id), `expected ${r2.instance_id} in ${ids.join(',')}`);
  } finally { h.cleanup(); }
});

test('13a. session.send: same alias dispatches to a tmux-backed live session', async () => {
  const h = await setupHarness();
  try {
    const r1 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'first', session_id: 'tmux-live-alias', default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r1.mode, 'spawn');
    resetPtyRegistry();
    tmuxSessionRegistry.__register(r1.instance_id, {
      name: `cdb_${r1.instance_id}`,
      exited: new Promise(() => {}),
      pid: async () => -1,
      sendText: async () => {},
      sendKey: async () => {},
      resize: async () => {},
      snapshot: async () => '',
      kill: async () => {},
    });

    const r2 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'second', session_id: 'tmux-live-alias', default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r2.mode, 'dispatch');
    assert.equal(r2.instance_id, r1.instance_id);
    assert.equal(h.dispatches.length, 1);
  } finally { h.cleanup(); }
});

test('13b. session.list includes session_alias for tmux-backed sessions', async () => {
  const h = await setupHarness();
  try {
    const r1 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'first', session_id: 'listed-alias', default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r1.mode, 'spawn');
    resetPtyRegistry();
    tmuxSessionRegistry.__register(r1.instance_id, {
      name: `cdb_${r1.instance_id}`,
      exited: new Promise(() => {}),
      pid: async () => -1,
      sendText: async () => {},
      sendKey: async () => {},
      resize: async () => {},
      snapshot: async () => '',
      kill: async () => {},
    });

    const r = await listSessions(h.ctx, { status: 'active', include_foreign: false });
    const item = r.items.find((i) => i.instance_id === r1.instance_id);
    assert.ok(item, `expected ${r1.instance_id} in ${r.items.map((i) => i.instance_id).join(',')}`);
    assert.equal(item.session_alias, 'listed-alias');
  } finally { h.cleanup(); }
});

test('14. session.list: status=archived filter', async () => {
  const h = await setupHarness();
  try {
    const spawned = await spawnDispatchOrResume(h.ctx, { prompt: 'x', session_id: 'L3', default_workspace_path: h.ctx.ws.projectDir });
    await killSession(h.ctx, spawned.instance_id);
    h.ctx.db.prepare(`UPDATE agent_sessions SET status='success', ended_at=? WHERE recipe_instance_id=?`)
      .run(Date.now(), spawned.instance_id);
    const r = await listSessions(h.ctx, { status: 'archived' });
    assert.ok(r.items.some((i) => i.instance_id === spawned.instance_id));
  } finally { h.cleanup(); }
});

test('15. session.send: archived copilot session auto-resumes', async (t) => {
  if (process.env.CLAWDEVBOX_TEST_REQUIRE_COPILOT !== '1') {
    return t.skip('set CLAWDEVBOX_TEST_REQUIRE_COPILOT=1 to run copilot auto-resume integration');
  }
  const copilotBin = process.platform === 'win32' ? 'copilot.exe' : 'copilot';
  const copilotProbe = spawnSync(copilotBin, ['--version'], { windowsHide: true, encoding: 'utf8' });
  if (copilotProbe.status !== 0) return t.skip('copilot CLI not installed');
  if (!hasTmux()) return t.skip('tmux not installed');

  const h = await setupHarness({ useRealRunRecipe: true, defaultAgentCli: 'copilot', name: 'copilot' });
  let resumedInstance = null;
  try {
    const r1 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'first',
      provider: 'copilot',
      session_id: 'resume-test',
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.mode, 'spawn');

    await waitFor(500);
    await killSession(h.ctx, r1.instance_id);
    h.ctx.db.prepare(`UPDATE agent_sessions SET status='success', ended_at=? WHERE recipe_instance_id=?`)
      .run(Date.now(), r1.instance_id);

    const r2 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'second',
      provider: 'copilot',
      session_id: 'resume-test',
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.mode, 'resume');
    assert.equal(r2.resumed_from, r1.instance_id);
    resumedInstance = r2.instance_id;

    const row = h.ctx.db.prepare(
      'SELECT resumed_into_instance_id FROM agent_sessions WHERE recipe_instance_id = ?',
    ).get(r1.instance_id);
    assert.equal(row.resumed_into_instance_id, r2.instance_id);
  } finally {
    if (resumedInstance) await killSession(h.ctx, resumedInstance);
    h.cleanup();
  }
});

test('16. session.send: archived echo-stub falls through to spawn', async () => {
  const h = await setupHarness();
  try {
    const r1 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'first', session_id: 'echo-resume-test',
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r1.mode, 'spawn');
    await killSession(h.ctx, r1.instance_id);
    h.ctx.db.prepare(`UPDATE agent_sessions SET status='success', ended_at=? WHERE recipe_instance_id=?`)
      .run(Date.now(), r1.instance_id);

    const r2 = await spawnDispatchOrResume(h.ctx, {
      prompt: 'second', session_id: 'echo-resume-test',
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r2.mode, 'spawn', 'echo-stub has supportsResume=false');
    assert.notEqual(r2.instance_id, r1.instance_id);
  } finally { h.cleanup(); }
});

test('17. session.list: include_foreign default true vs false', async (t) => {
  if (!hasTmux()) return t.skip('tmux not installed');
  const name = `test_foreign_${process.pid}_${Date.now()}`;
  spawnTmuxSession(name, 'setInterval(() => {}, 10000);');
  const h = await setupHarness();
  try {
    const withForeign = await listSessions(h.ctx, {});
    assert.ok(withForeign.items.some((i) => i.instance_id === name && i.kind === 'foreign'));
    const noForeign = await listSessions(h.ctx, { include_foreign: false });
    assert.ok(!noForeign.items.some((i) => i.instance_id === name));
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { windowsHide: true });
    h.cleanup();
  }
});

test('18. session.read: foreign tmux capture-pane works', async (t) => {
  if (!hasTmux()) return t.skip('tmux not installed');
  const name = `test_read_foreign_${process.pid}_${Date.now()}`;
  spawnTmuxSession(name, "console.log('FOREIGN_HELLO'); setInterval(() => {}, 10000);");
  const h = await setupHarness();
  try {
    await waitFor(300);
    const r = await readScrollbackHelper(h.ctx, { instance_id: name });
    assert.equal(r.ok, true);
    assert.equal(r.result.backend, 'tmux');
    assert.match(r.result.content, /FOREIGN_HELLO/);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { windowsHide: true });
    h.cleanup();
  }
});

test('19. session.send: foreign tmux session_id → FOREIGN_NOT_WRITABLE', async (t) => {
  if (!hasTmux()) return t.skip('tmux not installed');
  const name = `test_write_foreign_${process.pid}_${Date.now()}`;
  spawnTmuxSession(name, 'setInterval(() => {}, 10000);');
  const h = await setupHarness();
  try {
    const r = await spawnDispatchOrResume(h.ctx, {
      prompt: 'x', session_id: name,
      default_workspace_path: h.ctx.ws.projectDir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FOREIGN_NOT_WRITABLE');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { windowsHide: true });
    h.cleanup();
  }
});
