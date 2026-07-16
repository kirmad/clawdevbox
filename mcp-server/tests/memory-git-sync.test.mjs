/**
 * memory-git-sync.test.mjs
 *
 * Regression tests that drive the ACTUAL production sync primitives
 * exported from src/tools/memory-git.ts — syncRepo, getRepoState,
 * tryPush, abortRebase — across the memory-sync scenarios.
 *
 * The pre-existing tests/memory-sync-e2e.test.mjs re-implements git
 * flows with raw commands and never imports these functions, so the
 * shipped fetch/pull/push/conflict code was previously uncovered.
 *
 * All fixtures use throwaway temp repos + bare file remotes. Never
 * touches a real vault or real remote.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  syncRepo, getRepoState, tryPush, abortRebase,
} from '../src/tools/memory-git.ts';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

function configRepo(dir) {
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

let tmp;
let remotePath;
let vaultPath;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mem-git-sync-'));

  remotePath = join(tmp, 'remote.git');
  mkdirSync(remotePath);
  git(remotePath, ['init', '--bare', '--initial-branch=main']);

  vaultPath = join(tmp, 'vault');
  git(tmp, ['clone', remotePath, 'vault']);
  configRepo(vaultPath);

  writeFileSync(join(vaultPath, 'README.md'), '# Test Vault\n');
  git(vaultPath, ['add', '-A']);
  git(vaultPath, ['commit', '-m', 'initial']);
  git(vaultPath, ['push', '-u', 'origin', 'main']);
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Push a commit to the shared remote from an independent clone. */
function pushFromOtherClone(name, fileName, contents, message) {
  const other = join(tmp, name);
  git(tmp, ['clone', remotePath, name]);
  configRepo(other);
  writeFileSync(join(other, fileName), contents);
  git(other, ['add', '-A']);
  git(other, ['commit', '-m', message]);
  git(other, ['push', 'origin', 'main']);
  return other;
}

describe('getRepoState', () => {
  test('clean clone with remote: not dirty, in sync, has_remote true', () => {
    const st = getRepoState(vaultPath);
    assert.equal(st.branch, 'main');
    assert.equal(st.has_remote, true);
    assert.equal(st.dirty, false);
    assert.equal(st.ahead, 0);
    assert.equal(st.behind, 0);
  });

  test('reports dirty working tree', () => {
    writeFileSync(join(vaultPath, 'README.md'), '# changed\n');
    assert.equal(getRepoState(vaultPath).dirty, true);
  });

  test('reports ahead after a local commit', () => {
    writeFileSync(join(vaultPath, 'a.md'), 'a\n');
    git(vaultPath, ['add', '-A']);
    git(vaultPath, ['commit', '-m', 'local a']);
    const st = getRepoState(vaultPath);
    assert.equal(st.ahead, 1);
    assert.equal(st.behind, 0);
  });

  test('reports behind after remote advances', () => {
    pushFromOtherClone('other-behind', 'r.md', '# remote\n', 'remote change');
    git(vaultPath, ['fetch', '--quiet']);
    const st = getRepoState(vaultPath);
    assert.equal(st.behind, 1);
    assert.equal(st.ahead, 0);
  });

  test('no-remote repo: has_remote false', () => {
    const local = join(tmp, 'local-only');
    mkdirSync(local);
    git(local, ['init', '--initial-branch=main']);
    configRepo(local);
    writeFileSync(join(local, 'x.md'), 'x\n');
    git(local, ['add', '-A']);
    git(local, ['commit', '-m', 'init']);
    const st = getRepoState(local);
    assert.equal(st.has_remote, false);
  });
});

describe('syncRepo', () => {
  test('no remote configured: returns skipped no-op (not a conflict/error)', () => {
    const local = join(tmp, 'local-only2');
    mkdirSync(local);
    git(local, ['init', '--initial-branch=main']);
    configRepo(local);
    writeFileSync(join(local, 'x.md'), 'x\n');
    git(local, ['add', '-A']);
    git(local, ['commit', '-m', 'init']);

    const out = syncRepo(local);
    assert.equal(out.conflict, false);
    assert.equal(out.pushed, false);
    assert.equal(out.pulled, false);
    assert.match(out.message, /^no remote/);
  });

  test('nothing to do (in sync): fetch/pull/push no-op returns ok', () => {
    const out = syncRepo(vaultPath);
    assert.equal(out.conflict, false);
    assert.equal(out.pushed, true);
    assert.equal(out.message, 'ok');
  });

  test('local commit ahead: pushes to remote', () => {
    writeFileSync(join(vaultPath, 'pushed.md'), '# Pushed\n');
    git(vaultPath, ['add', '-A']);
    git(vaultPath, ['commit', '-m', 'memory: push me']);
    const localHead = git(vaultPath, ['rev-parse', 'HEAD']).trim();

    const out = syncRepo(vaultPath);
    assert.equal(out.pushed, true);
    assert.equal(out.conflict, false);
    assert.equal(out.message, 'ok');

    git(vaultPath, ['fetch', 'origin']);
    const remoteHead = git(vaultPath, ['rev-parse', 'origin/main']).trim();
    assert.equal(remoteHead, localHead);
  });

  test('incoming remote changes are pulled', () => {
    pushFromOtherClone('other-pull', 'team-note.md', '# Team\n', 'team: add note');

    const out = syncRepo(vaultPath);
    assert.equal(out.conflict, false);
    assert.equal(out.pulled, true);
    assert.ok(existsSync(join(vaultPath, 'team-note.md')), 'incoming file should be present after pull');
  });

  test('divergent edits to same file: reports conflict with paths + SHAs', () => {
    // remote edits README
    pushFromOtherClone('other-conflict', 'README.md', '# Modified by team\nTeam\n', 'team: edit README');
    // local also edits README
    writeFileSync(join(vaultPath, 'README.md'), '# Modified locally\nLocal\n');
    git(vaultPath, ['add', '-A']);
    git(vaultPath, ['commit', '-m', 'local: edit README']);

    const out = syncRepo(vaultPath);
    assert.equal(out.conflict, true, `expected conflict, got: ${JSON.stringify(out)}`);
    assert.equal(out.pushed, false);
    assert.ok(Array.isArray(out.conflict_paths), 'conflict_paths must be an array');
    assert.ok(out.conflict_paths.includes('README.md'),
      `conflict_paths should include README.md, got: ${JSON.stringify(out.conflict_paths)}`);
    assert.match(out.base_sha ?? '', /^[a-f0-9]{40}$/, 'base_sha should be a full SHA');
    assert.match(out.our_sha ?? '', /^[a-f0-9]{40}$/, 'our_sha should be a full SHA');
    assert.match(out.their_sha ?? '', /^[a-f0-9]{40}$/, 'their_sha should be a full SHA');

    // Cleanup: abortRebase must leave the tree free of an in-progress rebase.
    abortRebase(vaultPath);
    const status = git(vaultPath, ['status', '--porcelain=v2', '--branch']);
    assert.ok(!/rebase/i.test(git(vaultPath, ['status'])),
      `working tree should not be mid-rebase after abortRebase; status:\n${git(vaultPath, ['status'])}`);
    assert.ok(status !== undefined);
  });
});

describe('tryPush', () => {
  test('pushes a resolved local commit and reports ok', () => {
    writeFileSync(join(vaultPath, 'tp.md'), '# tp\n');
    git(vaultPath, ['add', '-A']);
    git(vaultPath, ['commit', '-m', 'memory: tryPush']);
    const r = tryPush(vaultPath);
    assert.equal(r.ok, true, `tryPush should succeed: ${r.message}`);

    git(vaultPath, ['fetch', 'origin']);
    const remoteHead = git(vaultPath, ['rev-parse', 'origin/main']).trim();
    const localHead = git(vaultPath, ['rev-parse', 'HEAD']).trim();
    assert.equal(remoteHead, localHead);
  });

  test('fails gracefully when the push is rejected (remote ahead)', () => {
    // Remote advances so a non-forced push from stale local is rejected.
    pushFromOtherClone('other-reject', 'z.md', '# z\n', 'remote advance');
    // Local makes a divergent commit WITHOUT pulling.
    writeFileSync(join(vaultPath, 'local.md'), '# local\n');
    git(vaultPath, ['add', '-A']);
    git(vaultPath, ['commit', '-m', 'local divergent']);

    const r = tryPush(vaultPath);
    assert.equal(r.ok, false, 'tryPush should fail against an advanced remote');
    assert.ok(r.message.length > 0, 'failure message should be populated');
  });
});
