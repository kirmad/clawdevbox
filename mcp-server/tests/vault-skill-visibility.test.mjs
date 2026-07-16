import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspaceFromEnv } from '../src/workspace.ts';
import { listAllInScope } from '../src/scope.ts';
import { skillPath } from '../src/workspace.ts';

describe('vault skills visible via workspace plugin scope', () => {
  it('loads vault as plugin and surfaces its skills', async () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'ws-vault-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ws-proj-'));
    mkdirSync(join(globalDir, 'plugins'), { recursive: true });

    // Create a vault with a skill
    const vaultDir = mkdtempSync(join(tmpdir(), 'vault-sk-'));
    mkdirSync(join(vaultDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(vaultDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'team-vault',
      version: '1.0.0',
      description: 'test vault',
    }));
    mkdirSync(join(vaultDir, 'skills', 'my-skill'), { recursive: true });
    writeFileSync(join(vaultDir, 'skills', 'my-skill', 'SKILL.md'), [
      '---',
      'name: my-skill',
      'description: A test skill from the vault',
      '---',
      '# My Skill',
      'Hello from vault',
    ].join('\n'));

    // Write config with vault
    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({
      version: 1,
      vaults: [{ id: 'team-vault', path: vaultDir, kind: 'team', remote: null }],
    }));

    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });

    // Vault should be loaded as a plugin
    const plugin = ws.plugins.get('team-vault');
    assert.ok(plugin, 'vault should be loaded as a plugin');
    assert.strictEqual(plugin.status, 'enabled');
    assert.strictEqual(plugin.capabilities.skills.length, 1);
    assert.strictEqual(plugin.capabilities.skills[0].id, 'my-skill');
  });

  it('vault skills appear in listAllInScope (skill.list code path)', async () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'ws-vault-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ws-proj-'));
    mkdirSync(join(globalDir, 'plugins'), { recursive: true });

    const vaultDir = mkdtempSync(join(tmpdir(), 'vault-sk-'));
    mkdirSync(join(vaultDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(vaultDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'team-vault',
      version: '1.0.0',
      description: 'test vault',
    }));
    mkdirSync(join(vaultDir, 'skills', 'vault-helper'), { recursive: true });
    writeFileSync(join(vaultDir, 'skills', 'vault-helper', 'SKILL.md'), [
      '---',
      'name: vault-helper',
      'description: Helper from vault',
      '---',
      '# Vault Helper',
      'Does things',
    ].join('\n'));

    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({
      version: 1,
      vaults: [{ id: 'team-vault', path: vaultDir, kind: 'team', remote: null }],
    }));

    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });

    // This is exactly what skill.list calls
    const entries = listAllInScope(ws, 'all', 'skill', skillPath);
    const vaultSkill = entries.find(e => e.id === 'vault-helper');
    assert.ok(vaultSkill, 'vault skill should appear in listAllInScope');
    assert.strictEqual(vaultSkill.scope, 'plugin:team-vault');
  });

  it('does not shadow installed plugins with vault of same id', async () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'ws-vault-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ws-proj-'));

    // Create a real plugin with same id
    const pluginDir = join(globalDir, 'plugins', 'clash');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'clash',
      version: '1.0.0',
      description: 'installed plugin',
    }));

    // Create a vault with same id
    const vaultDir = mkdtempSync(join(tmpdir(), 'vault-clash-'));
    mkdirSync(join(vaultDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(vaultDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'clash',
      version: '2.0.0',
      description: 'vault version',
    }));

    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({
      version: 1,
      vaults: [{ id: 'clash', path: vaultDir, kind: 'team', remote: null }],
    }));

    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });

    // Installed plugin should win
    const plugin = ws.plugins.get('clash');
    assert.ok(plugin);
    assert.strictEqual(plugin.manifest.description, 'installed plugin');
  });

  it('skips vaults with missing path gracefully', async () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'ws-vault-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ws-proj-'));
    mkdirSync(join(globalDir, 'plugins'), { recursive: true });

    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({
      version: 1,
      vaults: [{ id: 'ghost', path: '/nonexistent/vault/xyz', kind: 'team', remote: null }],
    }));

    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });

    assert.strictEqual(ws.plugins.has('ghost'), false);
  });
});
