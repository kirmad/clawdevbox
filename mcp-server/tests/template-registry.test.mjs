import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump as yamlDump } from 'js-yaml';

test('agent-authored project template appears in ws.triggerTypes', async () => {
  const { loadWorkspaceFromEnv } = await import('../src/workspace.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-tpl-reg-'));
  try {
    const projectDir = join(tmp, 'project');
    const localTplDir = join(projectDir, '.clawdevbox', 'trigger-types', 'local.demo');
    mkdirSync(localTplDir, { recursive: true });
    writeFileSync(join(localTplDir, 'template.yaml'), yamlDump({
      id: 'local.demo', file: 'trigger.ts', runtime: 'tsx', description: 'demo', parameters: [],
    }));
    writeFileSync(join(localTplDir, 'trigger.ts'), '// demo\n');
    mkdirSync(join(tmp, 'global'), { recursive: true });

    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: join(tmp, 'global'),
    });
    const t = ws.triggerTypes.get('local.demo');
    assert.ok(t, 'expected local.demo in registry');
    assert.equal(t.scope, 'project');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('project template shadows global with same id', async () => {
  const { loadWorkspaceFromEnv } = await import('../src/workspace.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-tpl-shadow-'));
  try {
    const projectDir = join(tmp, 'project');
    const globalDir = join(tmp, 'global');
    const projTpl = join(projectDir, '.clawdevbox', 'trigger-types', 'local.shared');
    mkdirSync(projTpl, { recursive: true });
    writeFileSync(join(projTpl, 'template.yaml'), yamlDump({ id: 'local.shared', file: 'trigger.ts', runtime: 'tsx' }));
    writeFileSync(join(projTpl, 'trigger.ts'), '// project\n');
    const globTpl = join(globalDir, 'trigger-types', 'local.shared');
    mkdirSync(globTpl, { recursive: true });
    writeFileSync(join(globTpl, 'template.yaml'), yamlDump({ id: 'local.shared', file: 'trigger.ts', runtime: 'tsx' }));
    writeFileSync(join(globTpl, 'trigger.ts'), '// global\n');

    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });
    const t = ws.triggerTypes.get('local.shared');
    assert.ok(t);
    assert.equal(t.scope, 'project');
    assert.ok(ws.triggerTypeErrors.some((e) => e.type_id === 'local.shared'));
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('_oneoff directory is excluded from project template walk', async () => {
  const { loadWorkspaceFromEnv } = await import('../src/workspace.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-tpl-oneoff-'));
  try {
    const projectDir = join(tmp, 'project');
    const oneoff = join(projectDir, '.clawdevbox', 'trigger-types', '_oneoff', 'local.oneoff.abc');
    mkdirSync(oneoff, { recursive: true });
    writeFileSync(join(oneoff, 'template.yaml'), yamlDump({ id: 'local.oneoff.abc', file: 'trigger.ts', runtime: 'tsx' }));
    writeFileSync(join(oneoff, 'trigger.ts'), '');

    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: join(tmp, 'global'),
    });
    assert.equal(ws.triggerTypes.has('local.oneoff.abc'), false);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
