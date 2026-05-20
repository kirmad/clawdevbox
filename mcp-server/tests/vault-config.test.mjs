import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConfig } from '../src/config.ts';

describe('config: vaults field', () => {
  it('resolves empty vaults array when not configured', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vault-cfg-'));
    const cfg = resolveConfig({ projectDir: tmp, globalDir: tmp });
    assert.deepStrictEqual(cfg.vaults, []);
  });

  it('resolves vaults from global config', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vault-cfg-'));
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      version: 1,
      vaults: [
        { id: 'personal', path: '/home/user/.clawdevbox/personal-vault', kind: 'personal', remote: null },
        { id: 'team-alpha', path: '/home/user/.clawdevbox/vaults/team-alpha', kind: 'team', remote: 'git@github.com:org/team-alpha.git' },
      ],
    }));
    const cfg = resolveConfig({ projectDir: tmp, globalDir: tmp });
    assert.strictEqual(cfg.vaults.length, 2);
    assert.strictEqual(cfg.vaults[0].id, 'personal');
    assert.strictEqual(cfg.vaults[0].kind, 'personal');
    assert.strictEqual(cfg.vaults[1].id, 'team-alpha');
    assert.strictEqual(cfg.vaults[1].remote, 'git@github.com:org/team-alpha.git');
  });

  it('rejects vault entry missing id', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vault-cfg-'));
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      version: 1,
      vaults: [{ path: '/tmp/x', kind: 'personal', remote: null }],
    }));
    assert.throws(() => resolveConfig({ projectDir: tmp, globalDir: tmp }), /id/);
  });

  it('rejects vault entry with invalid kind', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vault-cfg-'));
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      version: 1,
      vaults: [{ id: 'x', path: '/tmp/x', kind: 'invalid', remote: null }],
    }));
    assert.throws(() => resolveConfig({ projectDir: tmp, globalDir: tmp }), /kind/);
  });
});
