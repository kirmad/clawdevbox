// Deterministic regression test for vault-scoped trigger TYPE discovery.
//
// Guards the "restart/discovery assumption" behind vault-stored trigger
// templates such as `local.vault-test` (team-vault): the loader must
// re-discover the type from disk on every load, surface it EXACTLY ONCE
// with scope `vault:<id>`, preserve its metadata verbatim, and stay robust
// against malformed / partial entries. `listVaultTemplates` is pure disk
// I/O, so it is the deterministic stand-in for a server restart.
//
// Mirrors the on-disk shape of the real fixture at
//   <team-vault>/trigger-types/local.vault-test/{template.yaml,trigger.ts}
// without touching the real vault.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listVaultTemplates, loadVaultTemplate } from '../src/template-store.ts';

/** Build a minimal VaultInfo pointing at a scratch dir. */
function makeVault(id = 'team-vault') {
  const path = mkdtempSync(join(tmpdir(), `vault-trig-${id}-`));
  return {
    vault: { id, path, kind: 'team', remote: null, readonly: false, memory: true },
    cleanup: () => { try { rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/** Write a trigger-type dir <vault>/trigger-types/<id>/ with a manifest + script. */
function writeType(vault, id, { yaml, script = "process.stdout.write('ok');\n", file = 'trigger.ts' }) {
  const dir = join(vault.path, 'trigger-types', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'template.yaml'), yaml);
  if (file) writeFileSync(join(dir, file), script);
  return dir;
}

// The exact manifest shipped by the real team-vault fixture.
const VAULT_TEST_YAML = [
  'id: local.vault-test',
  'file: trigger.ts',
  'runtime: tsx',
  'description: Trivial vault-stored trigger template — should appear in the TYPE catalog after restart.',
  "default_cron: '*/10 * * * *'",
  'parameters:',
  '  - name: greeting',
  '    type: string',
  '    required: false',
  '',
].join('\n');

describe('vault trigger TYPE discovery (restart/discovery assumption)', () => {
  it('discovers local.vault-test exactly once with verbatim metadata + vault scope', () => {
    const { vault, cleanup } = makeVault('team-vault');
    try {
      writeType(vault, 'local.vault-test', { yaml: VAULT_TEST_YAML });

      const loaded = listVaultTemplates(vault);
      const hits = loaded.filter((t) => t.manifest.id === 'local.vault-test');

      assert.equal(hits.length, 1, 'local.vault-test must appear exactly once');
      const [t] = hits;
      assert.equal(t.scope, 'vault:team-vault');
      assert.equal(t.manifest.id, 'local.vault-test');
      assert.equal(t.manifest.runtime, 'tsx');
      assert.equal(t.manifest.file, 'trigger.ts');
      assert.equal(t.manifest.default_cron, '*/10 * * * *');
      assert.match(t.manifest.description, /appear in the TYPE catalog after restart/);
      assert.deepEqual(t.manifest.parameters, [
        { name: 'greeting', type: 'string', required: false },
      ]);
      assert.ok(t.scriptAbs.endsWith('trigger.ts'));
    } finally {
      cleanup();
    }
  });

  it('re-discovery is idempotent across reloads (simulated restart)', () => {
    const { vault, cleanup } = makeVault('team-vault');
    try {
      writeType(vault, 'local.vault-test', { yaml: VAULT_TEST_YAML });
      const first = listVaultTemplates(vault).map((t) => ({ id: t.manifest.id, scope: t.scope }));
      const second = listVaultTemplates(vault).map((t) => ({ id: t.manifest.id, scope: t.scope }));
      assert.deepEqual(second, first, 'reload must yield identical catalog');
      assert.equal(first.length, 1);
    } finally {
      cleanup();
    }
  });

  it('skips dotfiles, _oneoff, and non-directory entries — no phantom types', () => {
    const { vault, cleanup } = makeVault('team-vault');
    try {
      writeType(vault, 'local.vault-test', { yaml: VAULT_TEST_YAML });
      // Noise that must NOT be discovered as a type.
      writeType(vault, '.hidden', { yaml: VAULT_TEST_YAML });
      writeType(vault, '_oneoff', { yaml: VAULT_TEST_YAML });
      writeFileSync(join(vault.path, 'trigger-types', 'README.md'), '# not a type\n');

      const ids = listVaultTemplates(vault).map((t) => t.manifest.id);
      assert.deepEqual(ids, ['local.vault-test']);
    } finally {
      cleanup();
    }
  });

  it('drops a malformed-YAML sibling without aborting discovery of healthy types', () => {
    const { vault, cleanup } = makeVault('team-vault');
    try {
      writeType(vault, 'local.vault-test', { yaml: VAULT_TEST_YAML });
      // Malformed manifest — yamlLoad throws, must be dropped (not fatal).
      writeType(vault, 'local.broken-yaml', { yaml: ':\n  - [unbalanced\n' });

      const ids = listVaultTemplates(vault).map((t) => t.manifest.id).sort();
      assert.deepEqual(ids, ['local.vault-test'], 'broken-yaml type is skipped, healthy type survives');
      // Direct loader call on the broken entry returns null (no throw).
      assert.equal(loadVaultTemplate(vault, 'local.broken-yaml'), null);
    } finally {
      cleanup();
    }
  });

  it('CONTRACT: script existence is NOT checked at discovery (validated at fire-time)', () => {
    // Characterizes the actual loader contract shared by project/global/vault
    // scopes: resolveScriptAbs() only resolves + sandbox-checks the path, it
    // does not stat() the script. A manifest whose `file:` points at a missing
    // script is therefore still surfaced in the TYPE catalog; the missing-file
    // failure surfaces when the trigger fires, not when it is discovered.
    const { vault, cleanup } = makeVault('team-vault');
    try {
      writeType(vault, 'local.no-script', {
        yaml: 'id: local.no-script\nfile: missing.ts\nruntime: tsx\n',
        file: null, // no script written to disk
      });
      const loaded = loadVaultTemplate(vault, 'local.no-script');
      assert.ok(loaded, 'type is discovered even though its script is absent');
      assert.ok(loaded.scriptAbs.endsWith('missing.ts'));
    } finally {
      cleanup();
    }
  });

  it('returns [] when the vault has no trigger-types dir at all', () => {
    const { vault, cleanup } = makeVault('empty-vault');
    try {
      assert.deepEqual(listVaultTemplates(vault), []);
    } finally {
      cleanup();
    }
  });
});
