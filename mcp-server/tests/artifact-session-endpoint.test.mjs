/**
 * artifact-session-endpoint.test.mjs — unit tests for GET /artifact/<id>/session.
 *
 * Exercises the real handleHttpRequest dispatcher via the in-process
 * startTerminalServer() handle on an ephemeral port. Mirrors the harness
 * from json-doc-store-api.test.mjs but adds the DB open/close lifecycle
 * because /session reads agent_sessions when looking for a live instance.
 *
 * Tests cover the four documented branches:
 *   1. Non-existent artifact → 404.
 *   2. Artifact present but no recipe_instance_id → { session_id: null,
 *      workspace_id, live_instance_id: null }.
 *   3. recipe_instance_id resolves to a session_id via the recipe-instance
 *      JSON (project workspace) → session_id populated, live_instance_id
 *      null (no live agent in this test harness).
 *   4. Matching agent_sessions row whose recipe_instance_id is live in the
 *      pty-registry → live_instance_id populated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTerminalServer } from '../src/terminal-server.ts';
import { openDatabase, closeDatabase, getDatabase } from '../src/db/index.ts';

let baseUrl;
let serverHandle;
let projectDir;
let globalDir;
let tmpRoot;
let prevProjectDir;
let prevGlobalDir;

test.before(async () => {
  prevProjectDir = process.env.CLAWDEVBOX_PROJECT_DIR;
  prevGlobalDir = process.env.CLAWDEVBOX_GLOBAL_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), 'cdb-art-sess-'));
  projectDir = join(tmpRoot, 'project');
  globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(join(projectDir, '.clawdevbox'), { recursive: true });
  mkdirSync(join(projectDir, '.clawdevbox', 'recipe-instances'), { recursive: true });
  process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
  process.env.CLAWDEVBOX_GLOBAL_DIR = globalDir;

  // Open the DB so getDatabase() works inside serveArtifactSession. The
  // schema includes agent_sessions, which test 4 inserts into.
  openDatabase(globalDir);

  serverHandle = await startTerminalServer({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${serverHandle.port()}`;
});

test.after(async () => {
  await serverHandle?.close();
  try { closeDatabase(); } catch { /* ignore */ }
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevProjectDir === undefined) {
    delete process.env.CLAWDEVBOX_PROJECT_DIR;
  } else {
    process.env.CLAWDEVBOX_PROJECT_DIR = prevProjectDir;
  }
  if (prevGlobalDir === undefined) {
    delete process.env.CLAWDEVBOX_GLOBAL_DIR;
  } else {
    process.env.CLAWDEVBOX_GLOBAL_DIR = prevGlobalDir;
  }
});

function seedArtifact(id, manifestExtra = {}) {
  const dir = join(projectDir, 'artifacts', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    id,
    type: 'markdown',
    title: 'Test',
    workspace_id: 'project',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...manifestExtra,
  }, null, 2));
  writeFileSync(join(dir, 'content.md'), '# hello\n');
}

function seedRecipeInstance(instanceId, sessionId) {
  const path = join(projectDir, '.clawdevbox', 'recipe-instances', `${instanceId}.json`);
  writeFileSync(path, JSON.stringify({
    id: instanceId,
    workspace_path: projectDir,
    agent_cli: 'copilot',
    session_id: sessionId,
    recipe_id: 'test-recipe',
    status: 'success',
    started_at: Date.now(),
    steps: [],
  }, null, 2));
}

// ----------------------------------------------------------------------------
// Test 1: non-existent artifact → 404
// ----------------------------------------------------------------------------
test('GET /artifact/<unknown-id>/session returns 404', async () => {
  const r = await fetch(`${baseUrl}/artifact/nope-does-not-exist/session`);
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.error, 'ARTIFACT_NOT_FOUND');
});

// ----------------------------------------------------------------------------
// Test 2: artifact without recipe_instance_id → session_id null
// ----------------------------------------------------------------------------
test('artifact without recipe_instance_id returns null session_id', async () => {
  const artId = 'art-no-recipe-' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId);  // no recipe_instance_id in manifest

  const r = await fetch(`${baseUrl}/artifact/${artId}/session`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.session_id, null);
  assert.equal(body.workspace_id, 'project');
  assert.equal(body.live_instance_id, null);
});

// ----------------------------------------------------------------------------
// Test 3: recipe-instance JSON supplies the session_id
// ----------------------------------------------------------------------------
test('recipe-instance JSON supplies session_id; no live instance', async () => {
  const artId = 'art-with-recipe-' + Math.random().toString(36).slice(2, 8);
  const instanceId = 'inst_' + Math.random().toString(36).slice(2, 8);
  const sessionId = 'sess_' + Math.random().toString(36).slice(2, 8);
  seedArtifact(artId, { recipe_instance_id: instanceId });
  seedRecipeInstance(instanceId, sessionId);

  const r = await fetch(`${baseUrl}/artifact/${artId}/session`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.session_id, sessionId);
  assert.equal(body.workspace_id, 'project');
  // No agent_sessions row + no live pty → live_instance_id remains null.
  assert.equal(body.live_instance_id, null);
});

// ----------------------------------------------------------------------------
// Test 4: matching live agent_sessions row → live_instance_id populated
//
// This requires:
//   - workspaces row (foreign key target),
//   - recipe_instances row (foreign key target from agent_sessions),
//   - agent_sessions row with cli_session_id = sessionId, interactive=1,
//   - a live pty in pty-registry under that recipe_instance_id.
// ----------------------------------------------------------------------------
test('matching live agent_sessions row yields live_instance_id', async () => {
  const artId = 'art-live-' + Math.random().toString(36).slice(2, 8);
  const instanceId = 'inst_live_' + Math.random().toString(36).slice(2, 8);
  const sessionId = 'sess_live_' + Math.random().toString(36).slice(2, 8);
  const wsId = 'project';
  seedArtifact(artId, { recipe_instance_id: instanceId });
  seedRecipeInstance(instanceId, sessionId);

  const db = getDatabase();
  // Ensure 'project' workspace row exists. workspaces is FK target for
  // both recipe_instances and agent_sessions.
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, path, created_at)
     VALUES (?, ?, ?)`,
  ).run(wsId, projectDir, Date.now());
  // recipe_instances row (FK target for agent_sessions). workspace_path
  // is required (NOT NULL).
  db.prepare(
    `INSERT OR IGNORE INTO recipe_instances
       (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(instanceId, 'test-recipe', wsId, projectDir, '', '{}', Date.now(), 'success');
  // agent_sessions row that the endpoint will discover by cli_session_id.
  db.prepare(
    `INSERT INTO agent_sessions
       (id, cli_session_id, recipe_instance_id, workspace_id, agent_cli,
        started_at, status, interactive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'agentses_' + Math.random().toString(36).slice(2, 8),
    sessionId,
    instanceId,
    wsId,
    'copilot',
    Date.now(),
    'running',
    1,
  );

  // Register a synthetic live pty under that instance id so hasSession()
  // returns true. We use a minimal fake — the endpoint only calls
  // hasSession(), which only checks for presence in the sessions map.
  const { registerPty, _resetForTests } = await import('../src/pty-registry.ts');
  const fakeIpty = {
    pid: process.pid,
    cols: 80,
    rows: 24,
    process: 'fake',
    handleFlowControl: false,
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: () => {},
    resize: () => {},
    clear: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
  };
  registerPty({
    instanceId,
    workspaceId: wsId,
    ipty: /** @type {any} */ (fakeIpty),
    cols: 80,
    rows: 24,
    meta: {
      cwd: projectDir,
      commandLine: 'fake',
      agentCli: 'copilot',
      sessionId,
      recipeId: 'test-recipe',
    },
  });

  try {
    const r = await fetch(`${baseUrl}/artifact/${artId}/session`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.session_id, sessionId);
    assert.equal(body.workspace_id, wsId);
    assert.equal(body.live_instance_id, instanceId);
  } finally {
    _resetForTests();
  }
});
