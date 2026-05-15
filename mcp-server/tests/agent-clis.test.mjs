import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceFromEnv } from '../src/workspace.ts';

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
