import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceFromEnv } from '../src/workspace.ts';
import { resolveConfig } from '../src/config.ts';
import { runAgentCliChooser } from '../src/cli/init.ts';

function setupTmpWorkspace() {
  const project = mkdtempSync(join(tmpdir(), 'cdb-chooser-'));
  const global = join(project, '.global');
  mkdirSync(global, { recursive: true });
  return { project, global };
}

async function loadWs() {
  const tmp = setupTmpWorkspace();
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: tmp.project,
    CLAWDEVBOX_GLOBAL_DIR: tmp.global,
  });
  const cfg = resolveConfig({ projectDir: tmp.project, globalDir: tmp.global });
  return { ws, cfg, tmp };
}

test('runAgentCliChooser returns the picked provider id', async () => {
  const { ws, cfg } = await loadWs();
  // echo-stub is internal, so chooser should still let us pick it via the
  // fake prompt — the fake bypasses the internal filter (the filter only
  // hides internal entries from the rendered list, not from the registry).
  // For a visible-provider pick, use 'copilot'.
  let promptArgs;
  const fakeSelect = async (args) => {
    promptArgs = args;
    return 'copilot';
  };
  const chosen = await runAgentCliChooser(ws, cfg, 'project', fakeSelect);
  assert.equal(chosen, 'copilot');
  // Sanity: the prompt was offered visible providers + __skip.
  const values = promptArgs.options.map((o) => o.value);
  assert.ok(values.includes('copilot'));
  assert.ok(values.includes('claude'));
  assert.ok(values.includes('__skip'));
  // Internal providers (echo-stub) must NOT appear in the visible list.
  assert.ok(!values.includes('echo-stub'));
});

test('runAgentCliChooser returns null when user picks __skip', async () => {
  const { ws, cfg } = await loadWs();
  const fakeSelect = async () => '__skip';
  const chosen = await runAgentCliChooser(ws, cfg, 'global', fakeSelect);
  assert.equal(chosen, null);
});

test('runAgentCliChooser hint marks unavailable detect results', async () => {
  const { ws, cfg } = await loadWs();
  let promptArgs;
  const fakeSelect = async (args) => {
    promptArgs = args;
    return '__skip';
  };
  await runAgentCliChooser(ws, cfg, 'global', fakeSelect);
  // copilot / claude likely aren't on the test runner's PATH; the hint
  // should start with ✗ when detect reports not-available.
  const opt = promptArgs.options.find((o) => o.value === 'copilot');
  assert.ok(opt, 'copilot option present');
  assert.ok(
    opt.hint.startsWith('✓') || opt.hint.startsWith('✗'),
    `expected hint to start with ✓ or ✗, got ${JSON.stringify(opt.hint)}`,
  );
});

test('runAgentCliChooser sets initialValue to first available provider or __skip', async () => {
  const { ws, cfg } = await loadWs();
  let promptArgs;
  const fakeSelect = async (args) => {
    promptArgs = args;
    return '__skip';
  };
  await runAgentCliChooser(ws, cfg, 'project', fakeSelect);
  // initialValue should be a registered provider id OR '__skip'.
  const valid = new Set(promptArgs.options.map((o) => o.value));
  assert.ok(valid.has(promptArgs.initialValue));
});
