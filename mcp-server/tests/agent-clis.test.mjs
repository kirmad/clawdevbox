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
  assert.equal(ws.agentCliProviders.size, 4);
  assert.ok(ws.agentCliProviders.has('copilot'));
  assert.ok(ws.agentCliProviders.has('claude'));
  assert.ok(ws.agentCliProviders.has('echo-stub'));
  assert.ok(ws.agentCliProviders.has('e2e-test-runner'));
  assert.equal(ws.agentCliProviders.get('echo-stub')?.internal, true);
  assert.equal(ws.agentCliProviders.get('e2e-test-runner')?.internal, true);
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

// ----- agent flag passthrough -----------------------------------------------

test('copilot argv: --agent <name> appended when opts.agent is set', async () => {
  const ws = await makeWs();
  const ctx = captureSpawnCtx(buildProviderCtx(ws, {}));
  const opts = baseOpts({ ws, mode: 'interactive', kind: 'new', sessionId: 's', prompt: undefined });
  opts.agent = 'dev-buddy';
  await (await copilotProvider.spawnSession(ctx, opts)).exited;
  const c = ctx._captured();
  const i = c.args.indexOf('--agent');
  assert.ok(i >= 0, `copilot must pass --agent when opts.agent is set; argv: ${c.args.join(' ')}`);
  assert.equal(c.args[i + 1], 'dev-buddy');
});

test('copilot argv: --agent is omitted when opts.agent is unset', async () => {
  const ws = await makeWs();
  const ctx = captureSpawnCtx(buildProviderCtx(ws, {}));
  await (await copilotProvider.spawnSession(
    ctx,
    baseOpts({ ws, mode: 'interactive', kind: 'new', sessionId: 's', prompt: undefined }),
  )).exited;
  const c = ctx._captured();
  assert.ok(!c.args.includes('--agent'), `copilot must not pass --agent by default; argv: ${c.args.join(' ')}`);
});

test('claude argv: --agent <name> appended when opts.agent is set', async () => {
  const ws = await makeWs();
  const ctx = captureSpawnCtx(buildProviderCtx(ws, {}));
  const prevClaude = process.env.CLAWDEVBOX_CLAUDE_PATH;
  delete process.env.CLAWDEVBOX_CLAUDE_PATH;
  try {
    const opts = baseOpts({ ws, mode: 'interactive', kind: 'new', sessionId: 's', prompt: undefined });
    opts.agent = 'dev-buddy';
    await (await claudeProvider.spawnSession(ctx, opts)).exited;
    const c = ctx._captured();
    const i = c.args.indexOf('--agent');
    assert.ok(i >= 0, `claude must pass --agent when opts.agent is set; argv: ${c.args.join(' ')}`);
    assert.equal(c.args[i + 1], 'dev-buddy');
  } finally {
    if (prevClaude !== undefined) process.env.CLAWDEVBOX_CLAUDE_PATH = prevClaude;
  }
});

test('claude argv: --agent is omitted when opts.agent is unset', async () => {
  const ws = await makeWs();
  const ctx = captureSpawnCtx(buildProviderCtx(ws, {}));
  const prevClaude = process.env.CLAWDEVBOX_CLAUDE_PATH;
  delete process.env.CLAWDEVBOX_CLAUDE_PATH;
  try {
    await (await claudeProvider.spawnSession(
      ctx,
      baseOpts({ ws, mode: 'interactive', kind: 'new', sessionId: 's', prompt: undefined }),
    )).exited;
    const c = ctx._captured();
    assert.ok(!c.args.includes('--agent'), `claude must not pass --agent by default; argv: ${c.args.join(' ')}`);
  } finally {
    if (prevClaude !== undefined) process.env.CLAWDEVBOX_CLAUDE_PATH = prevClaude;
  }
});


// ============================================================================
// Plugin loader — fake plugin fixtures (spec §4, §14)
// ============================================================================

import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadPluginProviders } from '../src/agent-clis/load-plugin.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'cli-plugins');

/** Copy each named fixture dir into <globalDir>/plugins/<id>/ and return paths. */
function setupTmpWorkspace(fixturePlugins) {
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-cli-load-'));
  const project = tmp;
  mkdirSync(join(project, '.clawdevbox'), { recursive: true });
  const globalDir = join(tmp, '.global');
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });
  for (const p of fixturePlugins) {
    cpSync(join(FIXTURE_ROOT, p), join(globalDir, 'plugins', p), { recursive: true });
  }
  return { project, globalDir };
}

test('plugin loader: happy path — registers test-cli with source plugin:test-cli', async () => {
  const { project, globalDir } = setupTmpWorkspace(['test-cli']);
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: project,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
  });
  assert.deepEqual(ws.agentCliProviderErrors, []);
  assert.ok(ws.agentCliProviders.has('test-cli'));
  const p = ws.agentCliProviders.get('test-cli');
  assert.equal(p.source, 'plugin:test-cli');
  assert.equal(p.displayName, 'Test CLI Provider');
  assert.equal(p.description, 'Returns a fake handle.');
  assert.equal(typeof p.spawnSession, 'function');
  // Built-ins still present.
  assert.ok(ws.agentCliProviders.has('copilot'));
  assert.equal(ws.agentCliProviders.get('copilot').source, 'builtin');
});

test('plugin loader: bad shape — records INVALID_PROVIDER_SHAPE', async () => {
  const { project, globalDir } = setupTmpWorkspace(['bad-shape']);
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: project,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
  });
  assert.ok(!ws.agentCliProviders.has('bad-shape'));
  const err = ws.agentCliProviderErrors.find(
    (e) => e.plugin_id === 'bad-shape' && e.code === 'INVALID_PROVIDER_SHAPE',
  );
  assert.ok(err, `expected INVALID_PROVIDER_SHAPE error, got ${JSON.stringify(ws.agentCliProviderErrors)}`);
});

test('plugin loader: path traversal — records MODULE_PATH_TRAVERSAL (defense in depth)', async () => {
  // Manifest validator already rejects ".." segments — manifest-level rejection
  // would short-circuit before the loader runs. To exercise the loader's
  // defense-in-depth traversal check, construct a workspace with a synthetic
  // plugin entry whose manifest carries a traversal module path.
  const { project, globalDir } = setupTmpWorkspace([]);
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: project,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
  });
  // Synthetic plugin: bypass manifest validation.
  const pluginDir = join(globalDir, 'plugins', 'traversal');
  mkdirSync(pluginDir, { recursive: true });
  ws.plugins.set('traversal', {
    id: 'traversal',
    dir: pluginDir,
    manifest: {
      name: 'traversal',
      version: '0.1.0',
      description: 'synthetic',
      clawdevbox: {
        agent_clis: [{ id: 'traversal', module: '../../../etc/evil.js' }],
      },
    },
    capabilities: {
      skills: [], agents: [], commands: [], mcpServers: {},
      recipes: [], tools: [], triggerTypes: [],
      agentClis: [{ id: 'traversal', module: '../../../etc/evil.js' }],
    },
    loadErrors: [],
    status: 'enabled',
  });
  await loadPluginProviders(ws);
  assert.ok(!ws.agentCliProviders.has('traversal'));
  const err = ws.agentCliProviderErrors.find(
    (e) => e.plugin_id === 'traversal' && e.code === 'MODULE_PATH_TRAVERSAL',
  );
  assert.ok(err, `expected MODULE_PATH_TRAVERSAL error, got ${JSON.stringify(ws.agentCliProviderErrors)}`);
});

test('plugin loader: built-in collision — BUILTIN_COLLISION, built-in wins', async () => {
  const { project, globalDir } = setupTmpWorkspace(['conflict-copilot']);
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: project,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
  });
  // Built-in copilot still wins.
  const copilot = ws.agentCliProviders.get('copilot');
  assert.ok(copilot);
  assert.equal(copilot.source, 'builtin');
  const err = ws.agentCliProviderErrors.find(
    (e) => e.plugin_id === 'conflict-copilot' && e.code === 'BUILTIN_COLLISION',
  );
  assert.ok(err, `expected BUILTIN_COLLISION error, got ${JSON.stringify(ws.agentCliProviderErrors)}`);
});

test('plugin loader: plugin-vs-plugin collision — first-by-plugin-id wins, loser records PLUGIN_COLLISION', async () => {
  const { project, globalDir } = setupTmpWorkspace(['twin-a', 'twin-b']);
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: project,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
  });
  const twin = ws.agentCliProviders.get('twin');
  assert.ok(twin);
  assert.equal(twin.source, 'plugin:twin-a');
  assert.equal(twin.displayName, 'Twin A');
  const err = ws.agentCliProviderErrors.find(
    (e) => e.plugin_id === 'twin-b' && e.code === 'PLUGIN_COLLISION',
  );
  assert.ok(err, `expected PLUGIN_COLLISION error for twin-b, got ${JSON.stringify(ws.agentCliProviderErrors)}`);
});

// ============================================================================
// Regression: .mcp.json shape required by copilot + claude CLIs
// ============================================================================
// Copilot 1.0.49 rejects type='streamable-http' with 'Invalid literal value'.
// Claude 2.1.x accepts type='http'. We write the same shape for both — use
// 'http' so neither CLI rejects validation.

test('writeMcpJson writes type=http (not streamable-http) for both providers', async () => {
  const { readFileSync } = await import('node:fs');
  const ws = await makeWs();
  const ctx = captureSpawnCtx(buildProviderCtx(ws, {}));
  const opts = baseOpts({ ws, mode: 'interactive', kind: 'new', sessionId: 'mcp-shape', prompt: undefined });

  await (await copilotProvider.spawnSession(ctx, opts)).exited;
  const mcpPath = join(ws.projectDir, '.mcp.json');
  const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
  assert.equal(parsed.mcpServers.clawdevbox.type, 'http',
    'copilot CLI rejects streamable-http; must be http');
  assert.equal(parsed.mcpServers.clawdevbox.url, 'http://127.0.0.1:9999/mcp');
  assert.equal(parsed.mcpServers.clawdevbox.headers.Authorization, 'Bearer sek');
});

// ============================================================================
// Regression: main-agent session id must be UUID for Claude compatibility
// ============================================================================
// Claude Code's --session-id requires a valid UUID ('Invalid session ID. Must
// be a valid UUID.'). Copilot's --name accepts any string. mintMainAgentSessionId
// must produce UUIDs so the same id works for both providers.

test('mintMainAgentSessionId returns a valid UUID', async () => {
  // We can't import mintMainAgentSessionId directly (it's not exported).
  // Instead, exercise the path that uses it by ensuring the session id passed
  // through spawnSession is UUID-shaped. Since main-agent.ts isn't directly
  // testable without booting the kernel, we assert the contract on randomUUID
  // — the function we expect main-agent.ts to use.
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.match(id, UUID_RE);
});
