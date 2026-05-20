import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConfig } from '../src/config.ts';
import { loadVaultChain } from '../src/vault-chain.ts';
import { resolvePathsPayload } from '../src/tools/paths.ts';
import { scaffoldVault, deriveVaultIdFromSource } from '../src/cli/init-vault.ts';
import { buildVaultPluginDirArgs } from '../src/agent-clis/shared.ts';

describe('vault integration: full round-trip', () => {
  it('scaffold → config → chain → paths → plugin-dir', () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'vault-int-g-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'vault-int-p-'));

    // 1. Scaffold a personal vault
    const personalDir = join(globalDir, 'personal-vault');
    scaffoldVault(personalDir, { id: 'personal', title: 'My Vault', kind: 'personal' });
    assert.ok(existsSync(join(personalDir, 'vault.yaml')));
    assert.ok(existsSync(join(personalDir, '.claude-plugin', 'plugin.json')));
    assert.ok(existsSync(join(personalDir, 'skills')));

    // 2. Scaffold a team vault
    const teamDir = join(globalDir, 'vaults', 'team-alpha');
    scaffoldVault(teamDir, { id: 'team-alpha', title: 'Team Alpha', kind: 'team' });
    assert.ok(existsSync(join(teamDir, 'vault.yaml')));

    // 3. Write config referencing both vaults
    const configData = {
      version: 1,
      vaults: [
        { id: 'personal', path: personalDir, kind: 'personal', remote: null },
        { id: 'team-alpha', path: teamDir, kind: 'team', remote: 'git@github.com:org/team-alpha.git' },
      ],
    };
    writeFileSync(join(globalDir, 'config.json'), JSON.stringify(configData));

    // 4. Resolve config — vaults should be present
    const cfg = resolveConfig({ projectDir, globalDir });
    assert.strictEqual(cfg.vaults.length, 2);
    assert.strictEqual(cfg.vaults[0].id, 'personal');
    assert.strictEqual(cfg.vaults[1].id, 'team-alpha');

    // 5. Load vault chain — should order personal first
    const chain = loadVaultChain(cfg.vaults);
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].id, 'personal');
    assert.strictEqual(chain[0].kind, 'personal');
    assert.strictEqual(chain[1].id, 'team-alpha');
    assert.strictEqual(chain[1].kind, 'team');

    // 6. paths.get payload
    const paths = resolvePathsPayload({ globalDir, projectDir });
    assert.strictEqual(paths.global_dir, globalDir);
    assert.strictEqual(paths.project_dir, projectDir);
    assert.strictEqual(paths.vaults.length, 2);
    assert.strictEqual(paths.vaults[0].id, 'personal');
    assert.strictEqual(paths.vaults[1].remote, 'git@github.com:org/team-alpha.git');

    // 7. Plugin-dir args
    const pluginArgs = buildVaultPluginDirArgs(cfg.vaults.map(v => v.path));
    assert.deepStrictEqual(pluginArgs, [
      '--plugin-dir', personalDir,
      '--plugin-dir', teamDir,
    ]);
  });

  it('deriveVaultIdFromSource handles various URL formats', () => {
    assert.strictEqual(deriveVaultIdFromSource('git@github.com:org/my-vault.git'), 'my-vault');
    assert.strictEqual(deriveVaultIdFromSource('https://github.com/org/team-vault'), 'team-vault');
    assert.strictEqual(deriveVaultIdFromSource('C:\\Users\\dev\\vaults\\local-vault'), 'local-vault');
    assert.strictEqual(deriveVaultIdFromSource('/home/dev/vaults/my-team'), 'my-team');
  });

  it('skips non-existent vault paths gracefully', () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'vault-int-g-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'vault-int-p-'));
    const realDir = mkdtempSync(join(tmpdir(), 'vault-int-r-'));
    writeFileSync(join(realDir, 'vault.yaml'), 'id: real\ntier_label: team\n');

    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({
      version: 1,
      vaults: [
        { id: 'ghost', path: '/nonexistent/vault/xyz', kind: 'team', remote: null },
        { id: 'real', path: realDir, kind: 'team', remote: null },
      ],
    }));

    const cfg = resolveConfig({ projectDir, globalDir });
    const chain = loadVaultChain(cfg.vaults);
    // Chain skips non-existent
    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].id, 'real');

    // Plugin-dir also skips non-existent
    const pluginArgs = buildVaultPluginDirArgs(cfg.vaults.map(v => v.path));
    assert.deepStrictEqual(pluginArgs, ['--plugin-dir', realDir]);
  });
});
