// Live end-to-end smoke for claude + copilot main-agent spawn.
// Spawns the agent, waits 5s, verifies it's still alive, then exits without
// explicit pty cleanup (process exit reaps any orphan ptys). Pre-v0.1.3
// claude exited within ~10s with "Invalid session ID. Must be a valid UUID."
// and copilot exited within ~11s with "Invalid literal value" on type.
//
// Requires real `claude` / `copilot` binaries on PATH. Gate per-provider so
// each can be run independently (or together).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadWorkspaceFromEnv } from '../src/workspace.ts';
import { resolveConfig } from '../src/config.ts';
import { startMainAgent, getMainAgentStatus } from '../src/main-agent.ts';

async function runOneProvider(providerId) {
  const tmp = mkdtempSync(join(tmpdir(), `cdb-e2e-${providerId}-`));
  mkdirSync(join(tmp, '.clawdevbox'), { recursive: true });
  const globalDir = join(tmp, '.global');
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: tmp,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
  });
  const cfg = resolveConfig({ projectDir: tmp, globalDir });
  const cfgPinned = { ...cfg, defaultAgentCli: providerId };

  const status = await startMainAgent({
    workspace: ws,
    cfg: cfgPinned,
    host: '127.0.0.1',
    port: 5201,
  });
  assert.equal(status.agent_cli, providerId, `agent_cli must equal ${providerId}`);

  // Wait 5s. The pre-v0.1.3 bugs surfaced as exit code 1 within ~11s.
  await new Promise(r => setTimeout(r, 5000));

  const after = getMainAgentStatus();
  assert.equal(after.running, true,
    `${providerId} main-agent should still be running 5s after spawn; got ${JSON.stringify(after)}`);

  // Verify .mcp.json was written with the corrected shape (type=http).
  const mcpPath = join(tmp, '.mcp.json');
  assert.ok(existsSync(mcpPath), '.mcp.json should be written to workspace path');
  const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
  assert.equal(parsed.mcpServers.clawdevbox.type, 'http',
    'type must be http (not streamable-http)');
  assert.match(parsed.mcpServers.clawdevbox.url, /^http:\/\/127\.0\.0\.1:5201\/mcp$/);

  return { tmp, status: after };
}

const CLAUDE = process.env.CLAWDEVBOX_E2E_CLAUDE === '1';
const COPILOT = process.env.CLAWDEVBOX_E2E_COPILOT === '1';

if (CLAUDE) {
  test('main-agent boots claude with valid UUID + type=http mcp config', { timeout: 30000 }, async () => {
    await runOneProvider('claude');
  });
}

if (COPILOT) {
  test('main-agent boots copilot with valid UUID + type=http mcp config', { timeout: 30000 }, async () => {
    await runOneProvider('copilot');
  });
}

if (!CLAUDE && !COPILOT) {
  test('main-agent E2E skipped (set CLAWDEVBOX_E2E_CLAUDE=1 and/or CLAWDEVBOX_E2E_COPILOT=1 to enable)', () => {
    // doc-only test entry
  });
}
