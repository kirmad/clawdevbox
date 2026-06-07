/**
 * memory-phase6.test.mjs
 *
 * E2E tests for Phase 6 (manual sync + populated memory_status.git).
 * Uses real bare git repos as remotes + real local clones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  handleAddMemory, handleMemorySync, handleMemoryStatus,
  DEFAULT_MEMORY_CONFIG,
} from '../src/tools/memory.ts';
import { closeStore, _resetStoreCache } from '../src/tools/memory-qmd.ts';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function initBareRemote(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(['init', '-q', '--bare', '-b', 'main'], dir);
  return dir;
}

function cloneVault(remotePath, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(['clone', '-q', remotePath, dir], '.');
  git(['config', 'user.email', 'tester@local'], dir);
  git(['config', 'user.name', 'Tester'], dir);
  writeFileSync(join(dir, 'README.md'), '# vault\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
  git(['push', '-q', 'origin', 'main'], dir);
  return dir;
}

function makeVaultChainWithRemotes() {
  const personalRemote = initBareRemote('vault-p-bare-');
  const teamRemote     = initBareRemote('vault-t-bare-');
  const personalDir    = cloneVault(personalRemote, 'vault-p-clone-');
  const teamDir        = cloneVault(teamRemote, 'vault-t-clone-');
  return {
    chain: [
      { id: 'my-notes', path: personalDir, kind: 'personal', remote: personalRemote },
      { id: 'team-eng', path: teamDir,     kind: 'team',     remote: teamRemote },
    ],
    cleanup: async () => {
      try { await closeStore(); } catch { /* ignore */ }
      _resetStoreCache();
      for (const d of [personalDir, teamDir, personalRemote, teamRemote]) {
        rmSync(d, { recursive: true, force: true });
      }
    },
  };
}

function makeCtx(chain) {
  const dbDir = mkdtempSync(join(tmpdir(), 'qmd-p6-'));
  return {
    chain,
    identity: { email: 'jane@team.com', name: 'Jane', source: 'git' },
    config: {
      ...DEFAULT_MEMORY_CONFIG,
      qmd_db_path: join(dbDir, 'index.sqlite'),
      sync: { ...DEFAULT_MEMORY_CONFIG.sync, index_debounce_ms: 10 },
    },
    now: () => new Date(),
    _dbDir: dbDir,
  };
}

function cleanupCtx(ctx) {
  if (ctx?._dbDir) {
    try { rmSync(ctx._dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------

test('memory_sync pushes commits to remote', async () => {
  const { chain, cleanup } = makeVaultChainWithRemotes();
  const ctx = makeCtx(chain);
  try {
    // Write a memory locally (commits inline, no push yet).
    await handleAddMemory(ctx, {
      content: 'Test memory for sync',
      scope: 'team', project: 'p',
      citations: 'x', reason: 'y y',
    });

    // Verify remote does NOT yet have it
    const beforeRemote = execFileSync('git', ['--git-dir', chain[1].remote, 'log', '--oneline'],
      { encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(beforeRemote, /Test memory for sync/);

    // Sync
    const result = await handleMemorySync(ctx, { scope: 'team' });
    assert.equal(result.outcomes.length, 1);
    const teamOutcome = result.outcomes[0];
    assert.equal(teamOutcome.vault_id, 'team-eng');
    assert.equal(teamOutcome.pushed, true);
    assert.equal(teamOutcome.conflict, false);
    assert.equal(result.any_conflicts, false);

    // Verify remote now has the commit
    const afterRemote = execFileSync('git', ['--git-dir', chain[1].remote, 'log', '--oneline'],
      { encoding: 'utf8', windowsHide: true });
    assert.match(afterRemote, /Test memory for sync/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('memory_sync pulls remote commits made elsewhere', async () => {
  const { chain, cleanup } = makeVaultChainWithRemotes();
  const ctx = makeCtx(chain);
  try {
    const teamRemote = chain[1].remote;
    const teamLocal = chain[1].path;

    // Simulate a teammate pushing from a different clone.
    const otherDir = mkdtempSync(join(tmpdir(), 'other-clone-'));
    try {
      git(['clone', '-q', teamRemote, otherDir], '.');
      git(['config', 'user.email', 'bob@team.com'], otherDir);
      git(['config', 'user.name', 'Bob'], otherDir);
      writeFileSync(join(otherDir, 'teammate-note.md'), '# teammate wrote this\n');
      git(['add', '.'], otherDir);
      git(['commit', '-q', '-m', 'teammate: added note'], otherDir);
      git(['push', '-q', 'origin', 'main'], otherDir);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }

    // Local does NOT yet have it.
    assert.equal(existsSync(join(teamLocal, 'teammate-note.md')), false);

    // Sync — should pull (no local changes to push).
    const result = await handleMemorySync(ctx, { scope: 'team' });
    const out = result.outcomes[0];
    assert.equal(out.conflict, false);
    assert.equal(out.pulled, true);
    // Push happens unconditionally; with nothing local it just succeeds.
    assert.equal(out.pushed, true);

    // Local should now have it.
    assert.ok(existsSync(join(teamLocal, 'teammate-note.md')),
      `teammate-note.md should have been pulled`);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('memory_sync detects pull conflict when local + remote both edited same file', async () => {
  const { chain, cleanup } = makeVaultChainWithRemotes();
  const ctx = makeCtx(chain);
  try {
    const teamRemote = chain[1].remote;
    const teamLocal = chain[1].path;

    // Local edit (committed but not pushed)
    writeFileSync(join(teamLocal, 'shared.md'), '# local version\n');
    git(['add', '.'], teamLocal);
    git(['commit', '-q', '-m', 'local edit'], teamLocal);

    // Teammate edit pushed remotely (touches the SAME file with different content)
    const otherDir = mkdtempSync(join(tmpdir(), 'other-conflict-'));
    try {
      git(['clone', '-q', teamRemote, otherDir], '.');
      git(['config', 'user.email', 'bob@team.com'], otherDir);
      git(['config', 'user.name', 'Bob'], otherDir);
      writeFileSync(join(otherDir, 'shared.md'), '# remote version\n');
      git(['add', '.'], otherDir);
      git(['commit', '-q', '-m', 'remote edit'], otherDir);
      git(['push', '-q', 'origin', 'main'], otherDir);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }

    // Sync should detect conflict during pull --rebase
    const result = await handleMemorySync(ctx, { scope: 'team' });
    const out = result.outcomes[0];
    assert.equal(out.conflict, true);
    assert.equal(out.pushed, false);
    assert.equal(result.any_conflicts, true);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('memory_sync skips vaults without remote', async () => {
  // Use a chain where the vaults have remote=null
  const { chain: chainWithRemotes, cleanup } = makeVaultChainWithRemotes();
  // Override remote=null
  const chain = chainWithRemotes.map((v) => ({ ...v, remote: null }));
  // But the underlying repos DO have remotes set up — clear them via git config
  for (const v of chain) {
    try { git(['remote', 'remove', 'origin'], v.path); } catch { /* may not exist */ }
  }
  const ctx = makeCtx(chain);
  try {
    const result = await handleMemorySync(ctx, {});
    for (const out of result.outcomes) {
      assert.equal(out.pulled, false);
      assert.equal(out.pushed, false);
      assert.match(out.message, /no remote configured/i);
    }
    assert.equal(result.any_conflicts, false);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// memory_status.git population
// ---------------------------------------------------------------------------

test('memory_status.git reports branch + ahead + behind + dirty per vault', async () => {
  const { chain, cleanup } = makeVaultChainWithRemotes();
  const ctx = makeCtx(chain);
  try {
    // Write a memory but don't push yet — should bump 'ahead' by 1.
    await handleAddMemory(ctx, {
      content: 'mem', scope: 'team', project: 'p',
      citations: 'a', reason: 'b b',
    });

    // Make a dirty change to README.
    writeFileSync(join(chain[1].path, 'README.md'), '# vault DIRTY\n');

    const status = await handleMemoryStatus(ctx, {});
    const teamGit = status.git['team-eng'];
    assert.ok(teamGit, 'expected team-eng git state');
    assert.equal(teamGit.branch, 'main');
    assert.ok(teamGit.ahead >= 1, `expected ahead>=1, got ${teamGit.ahead}`);
    assert.equal(teamGit.behind, 0);
    assert.equal(teamGit.dirty, true);
    assert.equal(teamGit.has_remote, true);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});
