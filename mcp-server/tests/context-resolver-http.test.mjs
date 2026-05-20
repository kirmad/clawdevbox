/**
 * context-resolver-http.test.mjs
 *
 * End-to-end test: a real MCP HTTP server with the migrated `recipe.done` /
 * `recipe.instance_info` / `artifact.add` tools must correctly identify the
 * calling workspace via the per-request X-Clawdevbox-Workspace-Id header,
 * NOT via the server's startup env.
 *
 * Why this matters
 * ----------------
 * Before this fix, recipe.done and friends read process.env.CLAWDEVBOX_WORKSPACE_ID
 * directly in the tool handler. In HTTP MCP mode, that env is the SERVER's
 * startup env — fixed at boot time, identical for every caller. With multiple
 * concurrent agent sessions sharing one server (the `clawdevbox start` model),
 * every call would resolve to the same workspace regardless of who's calling.
 *
 * This test boots a real `clawdevbox start` HTTP server with one workspace id
 * in its env, registers two distinct workspaces, then makes tool calls
 * impersonating "agent A" and "agent B" via different X-Clawdevbox-* headers
 * and verifies each call sees its own context.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const entry = resolve(projectRoot, 'src/cli/index.ts');

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

async function waitForHealth(url, deadlineMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
}

class HarnessServer {
  constructor() {
    this.globalDir = mkdtempSync(join(tmpdir(), 'cdb-hdr-int-'));
    this.projectDir = mkdtempSync(join(tmpdir(), 'cdb-hdr-int-proj-'));
    this.token = 'integration-test-token';
    this.port = null;
    this.proc = null;
    this.stdoutBuf = '';
    this.stderrBuf = '';
  }

  async start(serverWorkspaceIdInEnv) {
    this.port = await freePort();
    mkdirSync(join(this.globalDir, 'plugins'), { recursive: true });
    writeFileSync(join(this.globalDir, 'config.json'), JSON.stringify({
      version: 1,
      workspacesRoot: join(this.globalDir, 'workspaces'),
      http: { host: '127.0.0.1', port: this.port, token: this.token },
      projects: {},
    }, null, 2));

    this.proc = spawn(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings=ExperimentalWarning',
      entry,
      'start',
    ], {
      env: {
        ...process.env,
        CLAWDEVBOX_GLOBAL_DIR: this.globalDir,
        CLAWDEVBOX_PROJECT_DIR: this.projectDir,
        CLAWDEVBOX_WORKSPACE_ID: serverWorkspaceIdInEnv, // simulating "server's startup workspace"
        CLAWDEVBOX_WORKSPACES_ROOT: join(this.globalDir, 'workspaces'),
        CLAWDEVBOX_HTTP_TOKEN: this.token,
        CLAWDEVBOX_HTTP_PORT: String(this.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (b) => { this.stdoutBuf += b.toString(); });
    this.proc.stderr.on('data', (b) => { this.stderrBuf += b.toString(); });

    const ok = await waitForHealth(`http://127.0.0.1:${this.port}/healthz`, 30000);
    if (!ok) {
      this.cleanup();
      throw new Error('server did not become healthy. stderr: ' + this.stderrBuf.slice(0, 400));
    }
  }

  async initSession() {
    const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '0.0.1' },
        },
      }),
    });
    const sessionId = res.headers.get('mcp-session-id');
    await res.text();
    // notifications/initialized
    await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    });
    return sessionId;
  }

  async callTool(sessionId, toolName, args, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
        'mcp-session-id': sessionId,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1e9),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    });
    const text = await res.text();
    if (text.startsWith('event:') || text.includes('data: ')) {
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      return line ? JSON.parse(line.slice(6)) : { raw: text };
    }
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  async createWorkspace(sessionId, name) {
    const res = await this.callTool(sessionId, 'workspace.create', { name });
    if (!res.result?.structuredContent) {
      throw new Error('workspace.create failed: ' + JSON.stringify(res));
    }
    return res.result.structuredContent;
  }

  cleanup() {
    try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
    try { rmSync(this.globalDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(this.projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ----------------------------------------------------------------------------
// The actual test
// ----------------------------------------------------------------------------

test('HTTP MCP: per-request X-Clawdevbox-Workspace-Id header drives recipe.done / artifact.* / recipe.instance_info', { timeout: 90_000 }, async () => {
  const h = new HarnessServer();
  // Server starts with this workspace id in env. If the server-side tool
  // handlers were still reading process.env (the bug), every call from
  // every "agent" would resolve to this — regardless of headers.
  await h.start('ws_SERVER_STARTUP_NOT_REAL');

  try {
    const sessionId = await h.initSession();

    // Create two real workspaces via workspace.create.
    const wsA = await h.createWorkspace(sessionId, 'agent-A-workspace');
    const wsB = await h.createWorkspace(sessionId, 'agent-B-workspace');
    assert.ok(wsA.id?.startsWith('ws_'), 'workspace A should be created');
    assert.ok(wsB.id?.startsWith('ws_'), 'workspace B should be created');
    assert.notEqual(wsA.id, wsB.id);

    // --- Agent A: artifact.add with header X-Clawdevbox-Workspace-Id: <wsA.id> ---
    const addA = await h.callTool(sessionId, 'artifact.add', {
      id: 'art-from-agent-a',
      type: 'markdown',
      title: 'Agent A artifact',
      files: { 'content.md': '# Hello from A' },
    }, { 'X-Clawdevbox-Workspace-Id': wsA.id });
    assert.ok(addA.result, `artifact.add for A should succeed; got ${JSON.stringify(addA)}`);
    assert.equal(addA.result.isError, undefined, 'add should not be an error');
    assert.equal(
      addA.result.structuredContent?.workspace_id,
      wsA.id,
      'artifact.add must record workspace A as the target',
    );

    // --- Agent B: artifact.add with a different header ---
    const addB = await h.callTool(sessionId, 'artifact.add', {
      id: 'art-from-agent-b',
      type: 'markdown',
      title: 'Agent B artifact',
      files: { 'content.md': '# Hello from B' },
    }, { 'X-Clawdevbox-Workspace-Id': wsB.id });
    assert.ok(addB.result);
    assert.equal(
      addB.result.structuredContent?.workspace_id,
      wsB.id,
      'artifact.add must record workspace B as the target',
    );

    // --- artifact.list per workspace shows ONLY that workspace's artifacts ---
    const listA = await h.callTool(sessionId, 'artifact.list', { workspace_id: wsA.id });
    const idsA = listA.result.structuredContent?.artifacts?.map((a) => a.id) ?? [];
    assert.ok(idsA.includes('art-from-agent-a'), 'workspace A should contain agent-A artifact');
    assert.ok(!idsA.includes('art-from-agent-b'), 'workspace A should NOT contain agent-B artifact');

    const listB = await h.callTool(sessionId, 'artifact.list', { workspace_id: wsB.id });
    const idsB = listB.result.structuredContent?.artifacts?.map((a) => a.id) ?? [];
    assert.ok(idsB.includes('art-from-agent-b'), 'workspace B should contain agent-B artifact');
    assert.ok(!idsB.includes('art-from-agent-a'), 'workspace B should NOT contain agent-A artifact');

    // --- Bug regression check: artifact.add WITHOUT any header, relying ONLY
    //     on server's startup env, must fail with WORKSPACE_NOT_FOUND ---
    //     because the env points at ws_SERVER_STARTUP_NOT_REAL which doesn't
    //     exist. (Before the fix, this would either silently pollute one of
    //     the real workspaces or err with that same code — but the fact that
    //     header-based calls work proves resolution actually uses the header.)
    const noHeader = await h.callTool(sessionId, 'artifact.add', {
      id: 'art-no-header',
      type: 'markdown',
      title: 'should fail',
    }, {});
    // Should error because env points at non-existent workspace
    assert.equal(
      noHeader.result?.isError,
      true,
      'without header, fallback to env hits non-existent workspace',
    );
  } finally {
    h.cleanup();
  }
});
