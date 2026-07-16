/**
 * plugin-renderers.test.mjs
 *
 * Workspace-level tests for the plugin-renderer registry populated by
 * `reloadTypeRegistries`. Built-in collisions are rejected; cross-plugin
 * collisions are deterministically resolved (first plugin by sorted id
 * wins). Plugin-side renderer discovery is exercised via the manifest
 * loader and verified by `ws.pluginRenderers` + `ws.rendererErrors`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceFromEnv } from '../src/workspace.ts';

function setupGlobal() {
  const root = mkdtempSync(join(tmpdir(), 'cdb-ws-rend-'));
  const projectDir = join(root, 'project');
  const globalDir = join(root, '.global');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });
  return { root, projectDir, globalDir };
}

function writePlugin(globalDir, name, files) {
  const dir = join(globalDir, 'plugins', name);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.1.0' }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

test('workspace pluginRenderers: registers plugin renderer auto-discovered from renderers/', async () => {
  const { root, projectDir, globalDir } = setupGlobal();
  writePlugin(globalDir, 'rend-one', {
    'renderers/special-art.mjs': 'export default function(){return "";}\n',
  });
  try {
    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });
    assert.equal(ws.pluginRenderers.size, 1);
    const entry = ws.pluginRenderers.get('special-art');
    assert.ok(entry, 'special-art renderer registered');
    assert.equal(entry.pluginId, 'rend-one');
    assert.equal(ws.rendererErrors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace pluginRenderers: built-in collision is rejected (BUILTIN_COLLISION)', async () => {
  const { root, projectDir, globalDir } = setupGlobal();
  writePlugin(globalDir, 'shadow', {
    // 'markdown' is shipped as a built-in renderer (mcp-server/src/renderers/markdown.mjs).
    'renderers/markdown.mjs': 'export default function(){return "";}\n',
  });
  try {
    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });
    assert.equal(ws.pluginRenderers.has('markdown'), false);
    const err = ws.rendererErrors.find(
      (e) => e.type === 'markdown' && e.code === 'BUILTIN_COLLISION',
    );
    assert.ok(err, 'expected a BUILTIN_COLLISION error for markdown');
    assert.equal(err.plugin_id, 'shadow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace pluginRenderers: cross-plugin collision → first sorted plugin wins, second is PLUGIN_COLLISION', async () => {
  const { root, projectDir, globalDir } = setupGlobal();
  writePlugin(globalDir, 'aaa-plugin', {
    'renderers/dup.mjs': 'export default function(){return "first";}\n',
  });
  writePlugin(globalDir, 'zzz-plugin', {
    'renderers/dup.mjs': 'export default function(){return "second";}\n',
  });
  try {
    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });
    const entry = ws.pluginRenderers.get('dup');
    assert.ok(entry);
    assert.equal(entry.pluginId, 'aaa-plugin');
    const err = ws.rendererErrors.find(
      (e) => e.type === 'dup' && e.code === 'PLUGIN_COLLISION',
    );
    assert.ok(err, 'expected a PLUGIN_COLLISION error for dup');
    assert.equal(err.plugin_id, 'zzz-plugin');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
