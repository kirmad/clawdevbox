import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadVaultChain } from '../src/vault-chain.ts';

describe('vault-chain', () => {
  it('returns empty array for no vaults', () => {
    const chain = loadVaultChain([]);
    assert.deepStrictEqual(chain, []);
  });

  it('loads single vault with vault.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vchain-'));
    writeFileSync(join(dir, 'vault.yaml'), 'id: personal\ntitle: My Vault\ntier_label: personal\n');
    mkdirSync(join(dir, 'skills'), { recursive: true });
    mkdirSync(join(dir, 'agents'), { recursive: true });

    const chain = loadVaultChain([{ id: 'personal', path: dir, kind: 'personal', remote: null }]);
    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].id, 'personal');
    assert.strictEqual(chain[0].path, dir);
    assert.strictEqual(chain[0].kind, 'personal');
    assert.strictEqual(chain[0].tierLabel, 'personal');
  });

  it('orders multiple vaults: personal first, team second', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'vchain-'));
    writeFileSync(join(dir1, 'vault.yaml'), 'id: personal\ntier_label: personal\n');
    const dir2 = mkdtempSync(join(tmpdir(), 'vchain-'));
    writeFileSync(join(dir2, 'vault.yaml'), 'id: team-x\ntier_label: team\n');

    const chain = loadVaultChain([
      { id: 'personal', path: dir1, kind: 'personal', remote: null },
      { id: 'team-x', path: dir2, kind: 'team', remote: 'git@github.com:org/team-x.git' },
    ]);
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].id, 'personal');
    assert.strictEqual(chain[1].id, 'team-x');
  });

  it('skips vaults whose path does not exist', () => {
    const chain = loadVaultChain([
      { id: 'ghost', path: '/nonexistent/vault/path/xyz', kind: 'team', remote: null },
    ]);
    assert.deepStrictEqual(chain, []);
  });

  it('loads vault without vault.yaml (minimal info)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vchain-'));
    mkdirSync(join(dir, 'skills'), { recursive: true });

    const chain = loadVaultChain([{ id: 'bare', path: dir, kind: 'team', remote: null }]);
    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].id, 'bare');
    assert.strictEqual(chain[0].tierLabel, undefined);
  });
});
