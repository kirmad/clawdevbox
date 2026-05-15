import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceFromEnv } from '../src/workspace.ts';
import { buildProviderCtx } from '../src/agent-clis/shared.ts';
import { copilotProvider } from '../src/agent-clis/copilot.ts';
import { claudeProvider } from '../src/agent-clis/claude.ts';
import { echoStubProvider } from '../src/agent-clis/echo-stub.ts';

test('workspace registers built-in agent-CLI providers on load', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-cli-skel-'));
  mkdirSync(join(tmp, '.clawdevbox'), { recursive: true });
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: tmp,
    CLAWDEVBOX_GLOBAL_DIR: join(tmp, '.global'),
  });
  assert.ok(ws.agentCliProviders instanceof Map);
  assert.equal(ws.agentCliProviders.size, 3);
  assert.ok(ws.agentCliProviders.has('copilot'));
  assert.ok(ws.agentCliProviders.has('claude'));
  assert.ok(ws.agentCliProviders.has('echo-stub'));
  assert.equal(ws.agentCliProviders.get('echo-stub')?.internal, true);
  assert.deepEqual(ws.agentCliProviderErrors, []);
});

// ============================================================================
// Provider argv-shape tests
// ============================================================================

async function makeWs() {
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-cli-argv-'));
  mkdirSync(join(tmp, '.clawdevbox'), { recursive: true });
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: tmp,
    CLAWDEVBOX_GLOBAL_DIR: join(tmp, '.global'),
  });
  return ws;
}

function captureSpawnCtx(realCtx) {
  let captured;
  return {
    ...realCtx,
    spawnPty(file, args, opts) {
      captured = { file, args, opts };
      return {
        pid: 12345,
        onExit(cb) { setImmediate(() => cb({ exitCode: 0, signal: 0 })); },
        onData() {}, write() {}, kill() {}, resize() {},
      };
    },
    _captured() { return captured; },
  };
}

function baseOpts({ ws, mode, kind, sessionId, prompt }) {
  return {
    mode,
    init: { kind, session_id: sessionId },
    role: 'recipe-instance',
    prompt,
    workspaceInfo: { id: 'wsX', path: ws.projectDir },
    ambientEnv: { FOO: 'bar' },
    mcp: { url: 'http://127.0.0.1:9999/mcp', secret: 'sek' },
  };
}

const MATRIX = [
  { mode: 'interactive', kind: 'new',    sessionId: 'sess-new-i',  prompt: undefined },
  { mode: 'interactive', kind: 'resume', sessionId: 'sess-res-i',  prompt: undefined },
  { mode: 'headless',    kind: 'new',    sessionId: 'sess-new-h',  prompt: 'hello world' },
  { mode: 'headless',    kind: 'resume', sessionId: 'sess-res-h',  prompt: 'resume me' },
];

// ----- copilot --------------------------------------------------------------

for (const row of MATRIX) {
  test(`copilot argv: ${row.mode} × ${row.kind}`, async () => {
    const ws = await makeWs();
    const ctx = captureSpawnCtx(buildProviderCtx(ws, {}));
    const handle = await copilotProvider.spawnSession(ctx, baseOpts({ ws, ...row }));
    await handle.exited;
    const c = ctx._captured();
    assert.ok(c, 'spawnPty should have been called');

    const expectedBin = process.env.CLAWDEVBOX_COPILOT_PATH
      ?? (process.platform === 'win32' ? 'copilot.exe' : 'copilot');
    assert.equal(c.file, expectedBin);

    const sessionFlag = row.kind === 'new'
      ? `--name=${row.sessionId}`
      : `--resume=${row.sessionId}`;
    assert.ok(c.args.includes(sessionFlag), `args missing ${sessionFlag}: ${c.args.join(' ')}`);

    const mcpIdx = c.args.indexOf('--additional-mcp-config');
    assert.ok(mcpIdx >= 0, 'should include --additional-mcp-config');
    const mcpVal = c.args[mcpIdx + 1];
    assert.ok(mcpVal && mcpVal.startsWith('@'), `expected @<path>, got ${mcpVal}`);
    assert.ok(mcpVal.endsWith('.mcp.json'), `expected .mcp.json path, got ${mcpVal}`);

    if (row.mode === 'headless') {
      assert.ok(c.args.includes('--allow-all-tools'), 'headless missing --allow-all-tools');
      const pIdx = c.args.indexOf('-p');
      assert.ok(pIdx >= 0, 'headless missing -p');
      assert.equal(c.args[pIdx + 1], row.prompt);
    } else {
      assert.ok(!c.args.includes('-p'), 'interactive must not include -p');
      assert.ok(!c.args.includes('--allow-all-tools'), 'interactive must not include --allow-all-tools');
    }

    assert.equal(handle.sessionId, row.sessionId);
    assert.equal(handle.pid, 12345);
  });
}

// ----- claude ---------------------------------------------------------------

for (const row of MATRIX) {
  test(`claude argv: ${row.mode} × ${row.kind}`, async () => {
    const ws = await makeWs();
    const ctx = captureSpawnCtx(buildProviderCtx(ws, {}));
    // Force default resolution by clearing override.
    const prevClaude = process.env.CLAWDEVBOX_CLAUDE_PATH;
    delete process.env.CLAWDEVBOX_CLAUDE_PATH;
    try {
      const handle = await claudeProvider.spawnSession(ctx, baseOpts({ ws, ...row }));
      await handle.exited;
      const c = ctx._captured();
      assert.ok(c, 'spawnPty should have been called');

      if (process.platform === 'win32') {
        assert.equal(c.file, 'cmd.exe');
        assert.equal(c.args[0], '/d');
        assert.equal(c.args[1], '/s');
        assert.equal(c.args[2], '/c');
        assert.equal(c.args[3], 'claude');
      } else {
        assert.equal(c.file, 'claude');
      }

      if (row.kind === 'new') {
        const i = c.args.indexOf('--session-id');
        assert.ok(i >= 0, 'missing --session-id');
        assert.equal(c.args[i + 1], row.sessionId);
        assert.ok(!c.args.includes('--resume'));
      } else {
        const i = c.args.indexOf('--resume');
        assert.ok(i >= 0, 'missing --resume');
        assert.equal(c.args[i + 1], row.sessionId);
        assert.ok(!c.args.includes('--session-id'));
      }

      if (row.mode === 'headless') {
        const pIdx = c.args.indexOf('-p');
        assert.ok(pIdx >= 0, 'headless missing -p');
        assert.equal(c.args[pIdx + 1], row.prompt);
      } else {
        assert.ok(!c.args.includes('-p'), 'interactive must not include -p');
      }
    } finally {
      if (prevClaude !== undefined) process.env.CLAWDEVBOX_CLAUDE_PATH = prevClaude;
    }
  });
}

// ----- echo-stub ------------------------------------------------------------

for (const row of MATRIX) {
  test(`echo-stub argv: ${row.mode} × ${row.kind}`, async () => {
    const ws = await makeWs();
    const ctx = captureSpawnCtx(buildProviderCtx(ws, {}));
    const handle = await echoStubProvider.spawnSession(ctx, baseOpts({ ws, ...row }));
    await handle.exited;
    const c = ctx._captured();
    assert.ok(c, 'spawnPty should have been called');

    assert.equal(c.file, process.execPath, 'echo-stub must spawn current node');
    assert.equal(c.args.length, 1, 'echo-stub args should be just the script path');
    assert.ok(c.args[0].endsWith(`${row.sessionId}.cjs`),
      `expected script ending with ${row.sessionId}.cjs, got ${c.args[0]}`);
    // echo-stub never takes -p / --allow-all-tools / --resume / --session-id
    assert.ok(!c.args.includes('-p'));
    assert.equal(handle.sessionId, row.sessionId);
    assert.equal(handle.pid, 12345);
  });
}

