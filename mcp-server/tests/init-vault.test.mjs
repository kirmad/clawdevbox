import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { scaffoldVault, deriveVaultIdFromSource, isGitRepo } from '../src/cli/init-vault.ts';

describe('init-vault', () => {
  describe('deriveVaultIdFromSource', () => {
    it('derives from SSH git URL', () => {
      assert.strictEqual(
        deriveVaultIdFromSource('git@github.com:org/feature-crew-vault.git'),
        'feature-crew-vault',
      );
    });
    it('derives from HTTPS URL', () => {
      assert.strictEqual(
        deriveVaultIdFromSource('https://github.com/org/my-vault'),
        'my-vault',
      );
    });
    it('derives from local folder path', () => {
      assert.strictEqual(deriveVaultIdFromSource('/home/user/vaults/team'), 'team');
    });
  });

  describe('scaffoldVault', () => {
    it('creates vault.yaml with correct fields', () => {
      const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
      scaffoldVault(dir, { id: 'test-vault', title: 'Test Vault', kind: 'personal' });
      const yamlPath = join(dir, 'vault.yaml');
      assert.ok(existsSync(yamlPath));
      const content = readFileSync(yamlPath, 'utf8');
      assert.ok(content.includes('id: test-vault'));
      assert.ok(content.includes('title: Test Vault'));
    });

    it('creates .claude-plugin/plugin.json', () => {
      const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
      scaffoldVault(dir, { id: 'pv', title: 'Personal', kind: 'personal' });
      const pluginJson = join(dir, '.claude-plugin', 'plugin.json');
      assert.ok(existsSync(pluginJson));
      const manifest = JSON.parse(readFileSync(pluginJson, 'utf8'));
      assert.strictEqual(manifest.name, 'pv');
      assert.ok(manifest.description.includes('Personal'));
    });

    it('creates subdirectories', () => {
      const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
      scaffoldVault(dir, { id: 'x', title: 'X', kind: 'team' });
      assert.ok(existsSync(join(dir, 'skills')));
      assert.ok(existsSync(join(dir, 'agents')));
      assert.ok(existsSync(join(dir, 'recipes')));
      assert.ok(existsSync(join(dir, 'triggers')));
      assert.ok(existsSync(join(dir, 'memory')));
    });

    it('creates README.md', () => {
      const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
      scaffoldVault(dir, { id: 'rv', title: 'ReadmeVault', kind: 'team' });
      assert.ok(existsSync(join(dir, 'README.md')));
    });

    it('does not overwrite existing vault.yaml', () => {
      const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
      writeFileSync(join(dir, 'vault.yaml'), 'id: existing\n');
      scaffoldVault(dir, { id: 'new', title: 'New', kind: 'team' });
      const content = readFileSync(join(dir, 'vault.yaml'), 'utf8');
      assert.ok(content.includes('id: existing'));
    });
  });

  describe('isGitRepo', () => {
    it('returns true for a git-inited directory', () => {
      const dir = mkdtempSync(join(tmpdir(), 'gitcheck-'));
      execSync('git init', { cwd: dir, stdio: 'ignore' });
      assert.strictEqual(isGitRepo(dir), true);
    });

    it('returns false for a plain directory', () => {
      const dir = mkdtempSync(join(tmpdir(), 'gitcheck-'));
      assert.strictEqual(isGitRepo(dir), false);
    });
  });
});
