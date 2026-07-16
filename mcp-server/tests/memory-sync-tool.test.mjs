/**
 * memory-sync-tool.test.mjs
 *
 * Drives the real handleMemorySync (src/tools/memory.ts) — the memory_sync
 * MCP tool — to verify vault scope selection (personal / team / all) and the
 * per-vault outcome contract against the shipped code path.
 *
 * Each vault is a throwaway local-only git repo (no remote), so syncRepo
 * returns a fast "no remote" no-op and no network / real vault is touched.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { handleMemorySync } from '../src/tools/memory.ts';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function makeVault(root, name) {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 't@t.com']);
  git(dir, ['config', 'user.name', 'T']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), '# v\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

describe('handleMemorySync scope selection', () => {
  let tmp;
  let ctx;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mem-sync-tool-'));
    const personalPath = makeVault(tmp, 'personal');
    const teamPath = makeVault(tmp, 'team');
    ctx = {
      chain: [
        { id: 'personal', path: personalPath, kind: 'personal', remote: null },
        { id: 'team', path: teamPath, kind: 'team', remote: null },
      ],
      identity: { name: 'test' },
      config: { auto_resolve_conflicts: 'manual' },
      now: () => new Date(),
    };
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const ids = (res) => res.outcomes.map((o) => o.vault_id).sort();

  test('scope "all" (default) processes every vault', async () => {
    const res = await handleMemorySync(ctx, {});
    assert.deepEqual(ids(res), ['personal', 'team']);
    assert.equal(res.any_conflicts, false);
    assert.equal(res.any_errors, false);
    // No-remote vaults must not be reported as errors.
    for (const o of res.outcomes) {
      assert.equal(o.conflict, false);
      assert.match(o.message, /^no remote/);
    }
  });

  test('scope "personal" processes only the personal vault', async () => {
    const res = await handleMemorySync(ctx, { scope: 'personal' });
    assert.deepEqual(ids(res), ['personal']);
  });

  test('scope "team" processes only the team vault', async () => {
    const res = await handleMemorySync(ctx, { scope: 'team' });
    assert.deepEqual(ids(res), ['team']);
  });

  test('vault_id filter overrides scope and targets one vault', async () => {
    const res = await handleMemorySync(ctx, { vault_id: 'team' });
    assert.deepEqual(ids(res), ['team']);
  });
});
