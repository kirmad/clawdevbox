import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePathsPayload } from '../src/tools/paths.ts';

describe('paths.get tool', () => {
  it('returns globalDir and projectDir', () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'paths-g-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'paths-p-'));
    // Write minimal config
    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({ version: 1 }));

    const result = resolvePathsPayload({ globalDir, projectDir });
    assert.strictEqual(result.global_dir, globalDir);
    assert.strictEqual(result.project_dir, projectDir);
    assert.ok(Array.isArray(result.vaults));
    assert.strictEqual(result.vaults.length, 0);
  });

  it('includes vault paths when configured', () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'paths-g-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'paths-p-'));
    const vaultDir = mkdtempSync(join(tmpdir(), 'paths-v-'));
    writeFileSync(join(vaultDir, 'vault.yaml'), 'id: team-a\ntitle: Team A\ntier_label: team\n');
    mkdirSync(join(vaultDir, 'skills'), { recursive: true });

    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({
      version: 1,
      vaults: [{ id: 'team-a', path: vaultDir, kind: 'team', remote: 'git@github.com:org/team-a.git' }],
    }));

    const result = resolvePathsPayload({ globalDir, projectDir });
    assert.strictEqual(result.vaults.length, 1);
    assert.strictEqual(result.vaults[0].id, 'team-a');
    assert.strictEqual(result.vaults[0].path, vaultDir);
    assert.strictEqual(result.vaults[0].kind, 'team');
  });

  it('returns workspaces_root', () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'paths-g-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'paths-p-'));
    writeFileSync(join(globalDir, 'config.json'), JSON.stringify({ version: 1 }));

    const result = resolvePathsPayload({ globalDir, projectDir });
    assert.ok(result.workspaces_root.length > 0);
  });
});
