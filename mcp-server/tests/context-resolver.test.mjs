/**
 * context-resolver.test.mjs
 *
 * Unit tests for the workspace-context resolver. Verifies all 5 resolution
 * paths (arg → header → env → cwd → error) end-to-end against an isolated
 * workspace registry on disk.
 *
 * Why this is critical:
 *   The MCP server's HTTP transport is long-lived and shared across multiple
 *   agent sessions. process.env.CLAWDEVBOX_WORKSPACE_ID inside the server
 *   reflects the SERVER's startup env, not the calling agent's. Tools that
 *   read process.env directly therefore fail in multi-agent HTTP scenarios.
 *
 *   The resolver is the migration path: tools call resolveWorkspaceContext(
 *   extra, args) which reads the per-spawn X-Clawdevbox-Workspace-Id header
 *   first (correct in HTTP mode) and falls back to env (correct in stdio mode).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveWorkspaceContext,
  resolveRecipeInstanceId,
  HEADER_WORKSPACE_ID,
  HEADER_RECIPE_INSTANCE_ID,
  HEADER_PROJECT_DIR,
} from '../src/context-resolver.ts';
import { createWorkspace } from '../src/workspaces-store.ts';

// ----------------------------------------------------------------------------
// Harness — isolated workspaces root + env reset
// ----------------------------------------------------------------------------

class Harness {
  constructor() {
    this.tmpRoot = mkdtempSync(join(tmpdir(), 'cdb-resolver-'));
    this.workspacesRoot = join(this.tmpRoot, 'workspaces');
    mkdirSync(this.workspacesRoot, { recursive: true });

    // Save + clear env vars the resolver reads
    this.savedEnv = {
      CLAWDEVBOX_WORKSPACE_ID: process.env.CLAWDEVBOX_WORKSPACE_ID,
      CLAWDEVBOX_RECIPE_INSTANCE_ID: process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID,
      CLAWDEVBOX_PROJECT_DIR: process.env.CLAWDEVBOX_PROJECT_DIR,
      CLAWDEVBOX_WORKSPACES_ROOT: process.env.CLAWDEVBOX_WORKSPACES_ROOT,
    };
    delete process.env.CLAWDEVBOX_WORKSPACE_ID;
    delete process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
    delete process.env.CLAWDEVBOX_PROJECT_DIR;
    // Point the resolver's `resolveWorkspacesRoot()` at our temp dir.
    process.env.CLAWDEVBOX_WORKSPACES_ROOT = this.workspacesRoot;
  }

  /** Create a registered workspace inside the temp root. */
  makeWorkspace(name) {
    const created = createWorkspace({
      name,
      workspacesRootOverride: this.workspacesRoot,
    });
    return created.info; // { id, path, name, created_at, parent_workspace_id }
  }

  cleanup() {
    // Restore env
    for (const k of Object.keys(this.savedEnv)) {
      const v = this.savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { rmSync(this.tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ----------------------------------------------------------------------------
// Step 1: argument override
// ----------------------------------------------------------------------------

test('arg override resolves to that workspace and reports source=arg', () => {
  const h = new Harness();
  try {
    const wsA = h.makeWorkspace('ws-A');
    const wsB = h.makeWorkspace('ws-B');

    // Even with env pointing at A and header pointing at B, arg wins.
    process.env.CLAWDEVBOX_WORKSPACE_ID = wsA.id;
    const extra = {
      requestInfo: {
        headers: { [HEADER_WORKSPACE_ID]: wsB.id },
      },
    };

    const result = resolveWorkspaceContext(extra, { argsWorkspaceId: wsA.id });
    assert.ok(result.ok);
    assert.equal(result.ctx.workspaceId, wsA.id);
    assert.equal(result.ctx.source, 'arg');
  } finally { h.cleanup(); }
});

test('arg with unknown workspace_id returns WORKSPACE_NOT_FOUND', () => {
  const h = new Harness();
  try {
    const result = resolveWorkspaceContext({}, { argsWorkspaceId: 'ws_does_not_exist' });
    assert.equal(result.ok, false);
    assert.equal(result.error.structuredContent.code, 'WORKSPACE_NOT_FOUND');
    assert.equal(result.error.structuredContent.source, 'arg');
  } finally { h.cleanup(); }
});

// ----------------------------------------------------------------------------
// Step 2: HTTP header (dominant in HTTP-MCP mode)
// ----------------------------------------------------------------------------

test('header X-Clawdevbox-Workspace-Id wins over env (HTTP mode)', () => {
  const h = new Harness();
  try {
    const wsA = h.makeWorkspace('ws-A');
    const wsB = h.makeWorkspace('ws-B');

    process.env.CLAWDEVBOX_WORKSPACE_ID = wsA.id;
    const extra = {
      requestInfo: {
        headers: { [HEADER_WORKSPACE_ID]: wsB.id },
      },
    };

    const result = resolveWorkspaceContext(extra);
    assert.ok(result.ok);
    assert.equal(result.ctx.workspaceId, wsB.id);
    assert.equal(result.ctx.source, 'header');
  } finally { h.cleanup(); }
});

test('header lookup is case-insensitive', () => {
  const h = new Harness();
  try {
    const ws = h.makeWorkspace('ws-1');
    // Mixed-case header key
    const extra = {
      requestInfo: {
        headers: { 'X-Clawdevbox-Workspace-Id': ws.id },
      },
    };

    const result = resolveWorkspaceContext(extra);
    assert.ok(result.ok);
    assert.equal(result.ctx.workspaceId, ws.id);
    assert.equal(result.ctx.source, 'header');
  } finally { h.cleanup(); }
});

test('header with array value picks first element', () => {
  const h = new Harness();
  try {
    const wsA = h.makeWorkspace('ws-A');
    const wsB = h.makeWorkspace('ws-B');
    const extra = {
      requestInfo: {
        headers: { [HEADER_WORKSPACE_ID]: [wsA.id, wsB.id] },
      },
    };

    const result = resolveWorkspaceContext(extra);
    assert.ok(result.ok);
    assert.equal(result.ctx.workspaceId, wsA.id);
  } finally { h.cleanup(); }
});

test('header with unknown workspace_id returns WORKSPACE_NOT_FOUND with source=header', () => {
  const h = new Harness();
  try {
    const extra = {
      requestInfo: {
        headers: { [HEADER_WORKSPACE_ID]: 'ws_never_existed' },
      },
    };

    const result = resolveWorkspaceContext(extra);
    assert.equal(result.ok, false);
    assert.equal(result.error.structuredContent.code, 'WORKSPACE_NOT_FOUND');
    assert.equal(result.error.structuredContent.source, 'header');
  } finally { h.cleanup(); }
});

// ----------------------------------------------------------------------------
// Step 3: env var (stdio mode)
// ----------------------------------------------------------------------------

test('env CLAWDEVBOX_WORKSPACE_ID is used when no arg or header', () => {
  const h = new Harness();
  try {
    const ws = h.makeWorkspace('ws-env');
    process.env.CLAWDEVBOX_WORKSPACE_ID = ws.id;

    const result = resolveWorkspaceContext(undefined);
    assert.ok(result.ok);
    assert.equal(result.ctx.workspaceId, ws.id);
    assert.equal(result.ctx.source, 'env');
  } finally { h.cleanup(); }
});

test('env with unknown workspace_id returns WORKSPACE_NOT_FOUND with source=env', () => {
  const h = new Harness();
  try {
    process.env.CLAWDEVBOX_WORKSPACE_ID = 'ws_phantom';

    const result = resolveWorkspaceContext({});
    assert.equal(result.ok, false);
    assert.equal(result.error.structuredContent.code, 'WORKSPACE_NOT_FOUND');
    assert.equal(result.error.structuredContent.source, 'env');
  } finally { h.cleanup(); }
});

// ----------------------------------------------------------------------------
// Step 4: project-dir match (header or env hint)
// ----------------------------------------------------------------------------

test('project-dir match resolves via header X-Clawdevbox-Project-Dir', () => {
  const h = new Harness();
  try {
    const ws = h.makeWorkspace('ws-cwd');
    const extra = {
      requestInfo: {
        headers: { [HEADER_PROJECT_DIR]: ws.path },
      },
    };

    const result = resolveWorkspaceContext(extra);
    assert.ok(result.ok);
    assert.equal(result.ctx.workspaceId, ws.id);
    assert.equal(result.ctx.source, 'cwd');
  } finally { h.cleanup(); }
});

test('project-dir match resolves via env CLAWDEVBOX_PROJECT_DIR', () => {
  const h = new Harness();
  try {
    const ws = h.makeWorkspace('ws-env-cwd');
    process.env.CLAWDEVBOX_PROJECT_DIR = ws.path;

    const result = resolveWorkspaceContext(undefined);
    assert.ok(result.ok);
    assert.equal(result.ctx.workspaceId, ws.id);
    assert.equal(result.ctx.source, 'cwd');
  } finally { h.cleanup(); }
});

test('project-dir argsProjectDir override wins over header and env', () => {
  const h = new Harness();
  try {
    const wsA = h.makeWorkspace('ws-A');
    const wsB = h.makeWorkspace('ws-B');
    const wsC = h.makeWorkspace('ws-C');

    process.env.CLAWDEVBOX_PROJECT_DIR = wsA.path;
    const extra = {
      requestInfo: {
        headers: { [HEADER_PROJECT_DIR]: wsB.path },
      },
    };

    const result = resolveWorkspaceContext(extra, { argsProjectDir: wsC.path });
    assert.ok(result.ok);
    assert.equal(result.ctx.workspaceId, wsC.id);
    assert.equal(result.ctx.source, 'cwd');
  } finally { h.cleanup(); }
});

// ----------------------------------------------------------------------------
// Step 5: no signals — structured error
// ----------------------------------------------------------------------------

test('no arg, no header, no env, no cwd-match → NO_TARGET_WORKSPACE error', () => {
  const h = new Harness();
  try {
    const result = resolveWorkspaceContext({});
    assert.equal(result.ok, false);
    assert.equal(result.error.structuredContent.code, 'NO_TARGET_WORKSPACE');
  } finally { h.cleanup(); }
});

test('cwd hint pointing at unregistered path falls through to NO_TARGET_WORKSPACE', () => {
  const h = new Harness();
  try {
    const extra = {
      requestInfo: {
        headers: { [HEADER_PROJECT_DIR]: '/nonexistent/unregistered/path' },
      },
    };

    const result = resolveWorkspaceContext(extra);
    assert.equal(result.ok, false);
    assert.equal(result.error.structuredContent.code, 'NO_TARGET_WORKSPACE');
  } finally { h.cleanup(); }
});

// ----------------------------------------------------------------------------
// Multi-agent simulation — the load-bearing real-world scenario
// ----------------------------------------------------------------------------

test('multi-agent HTTP simulation: same env, different headers → each call sees its own workspace', () => {
  const h = new Harness();
  try {
    const wsA = h.makeWorkspace('ws-A');
    const wsB = h.makeWorkspace('ws-B');

    // Server's startup env is fixed (simulating the long-lived MCP server)
    process.env.CLAWDEVBOX_WORKSPACE_ID = 'ws_SERVER_STARTUP'; // not a real ws

    // Agent A's call
    const callA = resolveWorkspaceContext({
      requestInfo: { headers: { [HEADER_WORKSPACE_ID]: wsA.id } },
    });
    assert.ok(callA.ok, 'agent A call should succeed via header');
    assert.equal(callA.ctx.workspaceId, wsA.id);

    // Agent B's call (made with the SAME server, but different per-spawn header)
    const callB = resolveWorkspaceContext({
      requestInfo: { headers: { [HEADER_WORKSPACE_ID]: wsB.id } },
    });
    assert.ok(callB.ok, 'agent B call should succeed via header');
    assert.equal(callB.ctx.workspaceId, wsB.id);

    // Crucially: server's env was never consulted because header wins.
    assert.equal(callA.ctx.source, 'header');
    assert.equal(callB.ctx.source, 'header');
  } finally { h.cleanup(); }
});

// ----------------------------------------------------------------------------
// Recipe instance id resolution
// ----------------------------------------------------------------------------

test('recipe instance id resolves from header', () => {
  const extra = {
    requestInfo: {
      headers: { [HEADER_RECIPE_INSTANCE_ID]: 'inst_abc_123' },
    },
  };
  assert.equal(resolveRecipeInstanceId(extra), 'inst_abc_123');
});

test('recipe instance id falls back to env when header missing', () => {
  const savedEnv = process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
  process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID = 'inst_from_env';
  try {
    assert.equal(resolveRecipeInstanceId({}), 'inst_from_env');
  } finally {
    if (savedEnv === undefined) delete process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
    else process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID = savedEnv;
  }
});

test('recipe instance id header wins over env', () => {
  const savedEnv = process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
  process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID = 'inst_from_env';
  try {
    const extra = {
      requestInfo: {
        headers: { [HEADER_RECIPE_INSTANCE_ID]: 'inst_from_header' },
      },
    };
    assert.equal(resolveRecipeInstanceId(extra), 'inst_from_header');
  } finally {
    if (savedEnv === undefined) delete process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
    else process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID = savedEnv;
  }
});

test('recipe instance id returns null when neither header nor env set', () => {
  const savedEnv = process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
  delete process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
  try {
    assert.equal(resolveRecipeInstanceId(undefined), null);
    assert.equal(resolveRecipeInstanceId({}), null);
    assert.equal(resolveRecipeInstanceId({ requestInfo: { headers: {} } }), null);
  } finally {
    if (savedEnv !== undefined) process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID = savedEnv;
  }
});

// ----------------------------------------------------------------------------
// Context field population
// ----------------------------------------------------------------------------

test('WorkspaceContext includes recipe instance id when header is set', () => {
  const h = new Harness();
  try {
    const ws = h.makeWorkspace('ws-recipe');
    const extra = {
      requestInfo: {
        headers: {
          [HEADER_WORKSPACE_ID]: ws.id,
          [HEADER_RECIPE_INSTANCE_ID]: 'inst_xyz',
        },
      },
    };

    const result = resolveWorkspaceContext(extra);
    assert.ok(result.ok);
    assert.equal(result.ctx.recipeInstanceId, 'inst_xyz');
  } finally { h.cleanup(); }
});

test('WorkspaceContext includes project_dir from header when set', () => {
  const h = new Harness();
  try {
    const ws = h.makeWorkspace('ws-pd');
    const projectDir = '/some/agent/project/dir';
    const extra = {
      requestInfo: {
        headers: {
          [HEADER_WORKSPACE_ID]: ws.id,
          [HEADER_PROJECT_DIR]: projectDir,
        },
      },
    };

    const result = resolveWorkspaceContext(extra);
    assert.ok(result.ok);
    assert.ok(result.ctx.projectDir);
    assert.ok(result.ctx.projectDir.endsWith(projectDir.replace(/\//g, process.platform === 'win32' ? '\\' : '/')) || result.ctx.projectDir.includes('project'));
  } finally { h.cleanup(); }
});
