import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildVaultPluginDirArgs } from '../src/agent-clis/shared.ts';

describe('buildVaultPluginDirArgs', () => {
  it('returns empty array for undefined', () => {
    assert.deepStrictEqual(buildVaultPluginDirArgs(undefined), []);
  });

  it('returns empty array for empty array', () => {
    assert.deepStrictEqual(buildVaultPluginDirArgs([]), []);
  });

  it('returns --plugin-dir pairs for existing paths', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'vpd-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'vpd-'));
    const result = buildVaultPluginDirArgs([dir1, dir2]);
    assert.deepStrictEqual(result, ['--plugin-dir', dir1, '--plugin-dir', dir2]);
  });

  it('skips non-existent paths', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'vpd-'));
    const result = buildVaultPluginDirArgs([dir1, '/nonexistent/path/xyz']);
    assert.deepStrictEqual(result, ['--plugin-dir', dir1]);
  });
});
