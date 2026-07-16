/**
 * memory-phase8.test.mjs
 *
 * E2E tests for Phase 8 — wiki conflict auto-resolution via spawned
 * agent. Uses real bare git repos as remotes + real local clones, but
 * injects a stub spawnAgent so we don't need a live CLI subprocess.
 *
 * Tests cover:
 *   - Pre-merge tags are always created even when gated off
 *   - Halt on 'manual' mode (default)
 *   - Halt on non-wiki path
 *   - Halt on diff-line cap exceeded
 *   - Halt on conflict-frequency cap exceeded
 *   - Stub returns exit_code:0 with a merge commit → resolved + push retried
 *   - Stub returns exit_code:1 → not resolved, inbox warning emitted
 *   - Stub throws → not resolved, inbox warning emitted
 *   - End-to-end memory_sync integration: real wiki conflict, stub merges, push happens
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  handleMemorySync,
  DEFAULT_MEMORY_CONFIG,
} from '../src/tools/memory.ts';
import {
  attemptAutoResolve,
  _resetConflictHistory,
} from '../src/tools/memory-autoresolve.ts';
import { syncRepo } from '../src/tools/memory-git.ts';
import { closeStore, _resetStoreCache } from '../src/tools/memory-qmd.ts';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function tryGit(args, cwd) {
  try { return git(args, cwd); } catch { return ''; }
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
  const personalRemote = initBareRemote('vault-p8-p-bare-');
  const teamRemote     = initBareRemote('vault-p8-t-bare-');
  const personalDir    = cloneVault(personalRemote, 'vault-p8-p-clone-');
  const teamDir        = cloneVault(teamRemote,     'vault-p8-t-clone-');
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

function makeCtx(chain, overrides = {}) {
  const dbDir = mkdtempSync(join(tmpdir(), 'qmd-p8-'));
  return {
    chain,
    identity: { email: 'jane@team.com', name: 'Jane', source: 'git' },
    config: {
      ...DEFAULT_MEMORY_CONFIG,
      qmd_db_path: join(dbDir, 'index.sqlite'),
      sync: { ...DEFAULT_MEMORY_CONFIG.sync, index_debounce_ms: 10 },
      ...overrides.config,
    },
    now: () => new Date(),
    spawnAgent: overrides.spawnAgent,
    inbox: overrides.inbox,
    _dbDir: dbDir,
  };
}

function cleanupCtx(ctx) {
  if (ctx?._dbDir) {
    try { rmSync(ctx._dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Set up a vault with a wiki-page conflict pending. After this returns:
 *  - the vault is mid-rebase-conflict
 *  - returns the syncOutcome (with base_sha / our_sha / their_sha / conflict_paths)
 *  - 'memories/p/wiki/architecture/overview.md' is in conflict
 *
 * NOTE: all wiki/memory artifacts live under the top-level `memories/`
 * subdirectory in each vault (per memory-paths.ts MEMORY_ROOT_DIR).
 */
function setupWikiConflict(vaultPath, remotePath, ourContent, theirContent) {
  const wikiSubdir = join(vaultPath, 'memories', 'p', 'wiki', 'architecture');
  // First create the file on remote so both sides start from a common base
  const seedDir = mkdtempSync(join(tmpdir(), 'seed-conflict-'));
  try {
    git(['clone', '-q', remotePath, seedDir], '.');
    git(['config', 'user.email', 'seed@team.com'], seedDir);
    git(['config', 'user.name', 'Seed'], seedDir);
    const seedSubdir = join(seedDir, 'memories', 'p', 'wiki', 'architecture');
    require_mkdir(seedSubdir);
    writeFileSync(join(seedSubdir, 'overview.md'), '# base\n\nshared starting content\n');
    git(['add', '.'], seedDir);
    git(['commit', '-q', '-m', 'seed wiki page'], seedDir);
    git(['push', '-q', 'origin', 'main'], seedDir);
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
  }

  // Pull the seed into our local clone
  git(['pull', '-q', '--rebase', 'origin', 'main'], vaultPath);

  // Now make a divergent local edit
  require_mkdir(wikiSubdir);
  writeFileSync(join(wikiSubdir, 'overview.md'), ourContent);
  git(['add', '.'], vaultPath);
  git(['commit', '-q', '-m', 'local: edit wiki overview'], vaultPath);

  // And a divergent remote edit via another clone
  const otherDir = mkdtempSync(join(tmpdir(), 'other-conflict-'));
  try {
    git(['clone', '-q', remotePath, otherDir], '.');
    git(['config', 'user.email', 'bob@team.com'], otherDir);
    git(['config', 'user.name', 'Bob'], otherDir);
    const otherSubdir = join(otherDir, 'memories', 'p', 'wiki', 'architecture');
    writeFileSync(join(otherSubdir, 'overview.md'), theirContent);
    git(['add', '.'], otherDir);
    git(['commit', '-q', '-m', 'bob: edit wiki overview'], otherDir);
    git(['push', '-q', 'origin', 'main'], otherDir);
  } finally {
    rmSync(otherDir, { recursive: true, force: true });
  }

  // Now syncRepo will conflict
  const outcome = syncRepo(vaultPath);
  return outcome;
}

function require_mkdir(p) {
  try { execFileSync('cmd', ['/c', 'mkdir', p.replace(/\//g, '\\')], { windowsHide: true }); }
  catch { /* exists */ }
}

// ---------------------------------------------------------------------------
// attemptAutoResolve direct tests (don't need full sync flow)
// ---------------------------------------------------------------------------

test('attemptAutoResolve: gated off in manual mode, but still tags pre-merge state', async () => {
  _resetConflictHistory();
  const { chain, cleanup } = makeVaultChainWithRemotes();
  try {
    const vault = chain[1];
    const outcome = setupWikiConflict(vault.path, vault.remote, '# ours\n\nmy edit\n', '# theirs\n\nbob edit\n');
    assert.equal(outcome.conflict, true, 'precondition: setup creates a conflict');

    let spawnCalled = false;
    const config = { ...DEFAULT_MEMORY_CONFIG, auto_resolve_conflicts: 'manual' };
    const result = await attemptAutoResolve(
      {
        vault,
        conflictPath: outcome.conflict_paths[0],
        base_sha: outcome.base_sha,
        our_sha: outcome.our_sha,
        their_sha: outcome.their_sha,
      },
      {
        config,
        spawnAgent: async () => { spawnCalled = true; return { exit_code: 0 }; },
        now: () => new Date(),
      },
    );

    assert.equal(spawnCalled, false, 'spawnAgent must NOT be called in manual mode');
    assert.equal(result.attempted, false);
    assert.equal(result.resolved, false);
    assert.match(result.reason, /manual/);
    assert.ok(result.preMergeTag, 'pre-merge tag should always be set');
    assert.ok(result.preMergeTagTheirs, 'pre-merge theirs tag should always be set');

    // Verify tags actually exist in the repo
    const tags = git(['tag'], vault.path);
    assert.match(tags, /memory-pre-merge\/.+-ours/);
    assert.match(tags, /memory-pre-merge\/.+-theirs/);
  } finally {
    await cleanup();
  }
});

test('attemptAutoResolve: gated off for non-wiki paths', async () => {
  _resetConflictHistory();
  const { chain, cleanup } = makeVaultChainWithRemotes();
  try {
    const vault = chain[1];

    let spawnCalled = false;
    const config = { ...DEFAULT_MEMORY_CONFIG, auto_resolve_conflicts: 'auto' };
    const result = await attemptAutoResolve(
      {
        vault,
        conflictPath: 'p/memories/foo.md', // memories, not wiki
        base_sha: 'deadbeef',
        our_sha: 'deadbeef',
        their_sha: 'deadbeef',
      },
      {
        config,
        spawnAgent: async () => { spawnCalled = true; return { exit_code: 0 }; },
        now: () => new Date(),
      },
    );

    assert.equal(spawnCalled, false);
    assert.equal(result.attempted, false);
    assert.match(result.reason, /non-wiki/);
  } finally {
    await cleanup();
  }
});

test('attemptAutoResolve: gated off when diff exceeds max_diff_lines cap', async () => {
  _resetConflictHistory();
  const { chain, cleanup } = makeVaultChainWithRemotes();
  try {
    const vault = chain[1];
    // Make 200-line divergent edits → exceeds default cap of 100
    const big = (sigil) => '# wiki\n\n' + Array.from({ length: 200 }, (_, i) => `line ${i} ${sigil}`).join('\n') + '\n';
    const outcome = setupWikiConflict(vault.path, vault.remote, big('OURS'), big('THEIRS'));

    let spawnCalled = false;
    const config = { ...DEFAULT_MEMORY_CONFIG, auto_resolve_conflicts: 'auto' };
    const result = await attemptAutoResolve(
      {
        vault,
        conflictPath: outcome.conflict_paths[0],
        base_sha: outcome.base_sha,
        our_sha: outcome.our_sha,
        their_sha: outcome.their_sha,
      },
      {
        config,
        spawnAgent: async () => { spawnCalled = true; return { exit_code: 0 }; },
        now: () => new Date(),
      },
    );

    assert.equal(spawnCalled, false);
    assert.equal(result.attempted, false);
    assert.match(result.reason, /diff size/);
  } finally {
    await cleanup();
  }
});

test('attemptAutoResolve: gated off when conflict frequency exceeds cap', async () => {
  _resetConflictHistory();
  const { chain, cleanup } = makeVaultChainWithRemotes();
  try {
    const vault = chain[1];
    const outcome = setupWikiConflict(vault.path, vault.remote, '# ours\n', '# theirs\n');
    const baseArgs = {
      vault,
      conflictPath: outcome.conflict_paths[0],
      base_sha: outcome.base_sha,
      our_sha: outcome.our_sha,
      their_sha: outcome.their_sha,
    };
    const config = {
      ...DEFAULT_MEMORY_CONFIG,
      auto_resolve_conflicts: 'auto',
      auto_resolve: { ...DEFAULT_MEMORY_CONFIG.auto_resolve, max_conflicts_per_file_per_hour: 1 },
    };

    let spawnCount = 0;
    const spawn = async () => { spawnCount++; return { exit_code: 1, reason: 'declined' }; };

    // First conflict: counts as 1 (==cap), spawn is called
    const r1 = await attemptAutoResolve(baseArgs, { config, spawnAgent: spawn, now: () => new Date() });
    assert.equal(r1.attempted, true, 'first attempt within cap should fire');
    assert.equal(spawnCount, 1);

    // Second conflict: count becomes 2, >cap, gated off
    const r2 = await attemptAutoResolve(baseArgs, { config, spawnAgent: spawn, now: () => new Date() });
    assert.equal(r2.attempted, false);
    assert.match(r2.reason, /conflicts in last hour/);
    assert.equal(spawnCount, 1, 'second attempt should NOT fire spawn');
  } finally {
    await cleanup();
  }
});

test('attemptAutoResolve: spawn succeeds + creates a merge commit → resolved + inbox info', async () => {
  _resetConflictHistory();
  const { chain, cleanup } = makeVaultChainWithRemotes();
  try {
    const vault = chain[1];
    const outcome = setupWikiConflict(vault.path, vault.remote, '# ours\nmy edit\n', '# theirs\nbob edit\n');
    const conflictPath = outcome.conflict_paths[0];

    const inboxEntries = [];
    const config = { ...DEFAULT_MEMORY_CONFIG, auto_resolve_conflicts: 'auto' };

    const spawn = async ({ cwd, prompt }) => {
      // Simulate what a real merging agent would do:
      // 1. Write a merged body
      // 2. git add + commit (which finishes the rebase)
      assert.match(prompt, /3-way merge conflict/);
      writeFileSync(join(cwd, conflictPath), '# merged\n\nboth edits captured\n\n> [!note] Auto-merged\n');
      git(['add', conflictPath], cwd);
      // For an in-progress rebase, `git rebase --continue` is what finishes
      git(['-c', 'core.editor=true', 'rebase', '--continue'], cwd);
      return { exit_code: 0, reason: 'merged' };
    };

    const result = await attemptAutoResolve(
      {
        vault,
        conflictPath,
        base_sha: outcome.base_sha,
        our_sha: outcome.our_sha,
        their_sha: outcome.their_sha,
      },
      {
        config,
        spawnAgent: spawn,
        now: () => new Date(),
        inbox: (e) => { inboxEntries.push(e); },
      },
    );

    assert.equal(result.attempted, true);
    assert.equal(result.resolved, true, `expected resolved; reason=${result.reason}`);
    assert.equal(inboxEntries.length, 1);
    assert.equal(inboxEntries[0].severity, 'info');
    assert.match(inboxEntries[0].title, /Auto-merged/);

    // Verify the file actually contains the merged content
    const merged = readFileSync(join(vault.path, conflictPath), 'utf8');
    assert.match(merged, /merged/);
  } finally {
    await cleanup();
  }
});

test('attemptAutoResolve: spawn returns exit_code 1 → not resolved + inbox warning', async () => {
  _resetConflictHistory();
  const { chain, cleanup } = makeVaultChainWithRemotes();
  try {
    const vault = chain[1];
    const outcome = setupWikiConflict(vault.path, vault.remote, '# ours\n', '# theirs\n');

    const inboxEntries = [];
    const config = { ...DEFAULT_MEMORY_CONFIG, auto_resolve_conflicts: 'auto' };
    const result = await attemptAutoResolve(
      {
        vault,
        conflictPath: outcome.conflict_paths[0],
        base_sha: outcome.base_sha,
        our_sha: outcome.our_sha,
        their_sha: outcome.their_sha,
      },
      {
        config,
        spawnAgent: async () => ({ exit_code: 1, reason: 'gave up' }),
        now: () => new Date(),
        inbox: (e) => { inboxEntries.push(e); },
      },
    );

    assert.equal(result.attempted, true);
    assert.equal(result.resolved, false);
    assert.match(result.reason, /gave up/);
    assert.equal(inboxEntries.length, 1);
    assert.equal(inboxEntries[0].severity, 'warning');
    assert.match(inboxEntries[0].title, /Auto-merge declined/);
  } finally {
    await cleanup();
  }
});

test('attemptAutoResolve: spawn throws → not resolved + inbox warning', async () => {
  _resetConflictHistory();
  const { chain, cleanup } = makeVaultChainWithRemotes();
  try {
    const vault = chain[1];
    const outcome = setupWikiConflict(vault.path, vault.remote, '# ours\n', '# theirs\n');

    const inboxEntries = [];
    const config = { ...DEFAULT_MEMORY_CONFIG, auto_resolve_conflicts: 'auto' };
    const result = await attemptAutoResolve(
      {
        vault,
        conflictPath: outcome.conflict_paths[0],
        base_sha: outcome.base_sha,
        our_sha: outcome.our_sha,
        their_sha: outcome.their_sha,
      },
      {
        config,
        spawnAgent: async () => { throw new Error('connection lost'); },
        now: () => new Date(),
        inbox: (e) => { inboxEntries.push(e); },
      },
    );

    assert.equal(result.attempted, true);
    assert.equal(result.resolved, false);
    assert.match(result.reason, /connection lost/);
    assert.equal(inboxEntries.length, 1);
    assert.equal(inboxEntries[0].severity, 'warning');
    assert.match(inboxEntries[0].title, /spawn errored/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Full memory_sync integration test
// ---------------------------------------------------------------------------

test('memory_sync: auto-resolve wiki conflict end-to-end, push retried', async () => {
  _resetConflictHistory();
  const { chain, cleanup } = makeVaultChainWithRemotes();

  const inboxEntries = [];
  let spawnCalls = 0;
  const ctx = makeCtx(chain, {
    config: { auto_resolve_conflicts: 'auto' },
    inbox: (e) => { inboxEntries.push(e); },
    spawnAgent: async ({ cwd, prompt }) => {
      spawnCalls++;
      // Pull the conflicting path out of the prompt
      const m = prompt.match(/^File: (.+)$/m);
      assert.ok(m, `prompt should embed the conflict path: ${prompt}`);
      const conflictPath = m[1];
      writeFileSync(join(cwd, conflictPath), '# merged-by-agent\n\nboth edits captured\n');
      git(['add', conflictPath], cwd);
      git(['-c', 'core.editor=true', 'rebase', '--continue'], cwd);
      return { exit_code: 0, reason: 'merged' };
    },
  });

  try {
    const vault = chain[1];
    setupWikiConflict(vault.path, vault.remote, '# ours\nmy edit\n', '# theirs\nbob edit\n');

    // memory_sync sees the conflict, invokes attemptAutoResolve, the
    // stub merges + commits, and the push retry pushes the merge upstream.
    const result = await handleMemorySync(ctx, { scope: 'team' });

    assert.equal(spawnCalls, 1, 'spawnAgent should be called exactly once');
    assert.equal(result.outcomes.length, 1);
    const out = result.outcomes[0];
    assert.equal(out.vault_id, 'team-eng');
    assert.equal(out.conflict, false, 'conflict should now be cleared after auto-resolve');
    assert.equal(out.pushed, true, 'push retry should succeed');
    assert.ok(out.auto_resolve, 'outcome should include auto_resolve metadata');
    assert.equal(out.auto_resolve.attempted, true);
    assert.equal(out.auto_resolve.resolved, true);
    assert.ok(out.auto_resolve.preMergeTag, 'pre-merge tag should be recorded');

    // Verify the merge actually landed on the remote
    const remoteLog = execFileSync('git', ['--git-dir', vault.remote, 'log', '--oneline'],
      { encoding: 'utf8', windowsHide: true });
    assert.match(remoteLog, /local: edit wiki overview/);

    // Inbox should have an info-level "Auto-merged" entry
    const info = inboxEntries.find((e) => e.severity === 'info');
    assert.ok(info, `expected an info-level inbox entry; got: ${JSON.stringify(inboxEntries)}`);
    assert.match(info.title, /Auto-merged/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('memory_sync: auto-resolve declined → conflict surfaced, rebase aborted, inbox warning', async () => {
  _resetConflictHistory();
  const { chain, cleanup } = makeVaultChainWithRemotes();

  const inboxEntries = [];
  const ctx = makeCtx(chain, {
    config: { auto_resolve_conflicts: 'auto' },
    inbox: (e) => { inboxEntries.push(e); },
    spawnAgent: async () => ({ exit_code: 1, reason: 'too risky' }),
  });

  try {
    const vault = chain[1];
    setupWikiConflict(vault.path, vault.remote, '# ours\n', '# theirs\n');

    const result = await handleMemorySync(ctx, { scope: 'team' });

    assert.equal(result.outcomes.length, 1);
    const out = result.outcomes[0];
    assert.equal(out.vault_id, 'team-eng');
    // Conflict stays surfaced because spawn declined.
    assert.equal(out.conflict, true);
    assert.ok(out.auto_resolve);
    assert.equal(out.auto_resolve.attempted, true);
    assert.equal(out.auto_resolve.resolved, false);
    assert.match(out.message, /auto-resolve declined/);

    // Rebase should have been aborted — repo is back to a clean state
    const status = tryGit(['status', '--porcelain'], vault.path);
    // If rebase was aborted properly, no unmerged paths remain
    assert.doesNotMatch(status, /^UU /m, 'rebase should have been aborted (no UU paths)');

    const warning = inboxEntries.find((e) => e.severity === 'warning');
    assert.ok(warning, 'expected a warning-level inbox entry');
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});
