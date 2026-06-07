/**
 * memory-phase4-7.test.mjs
 *
 * E2E tests for Phase 4 (voting + lesson dedup) and Phase 7
 * (update_wiki). Uses real git repos + lex-only qmd mode.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  handleAddMemory, handleAddLesson, handleAddWikiPage, handleGetMemory,
  handleVoteMemory, handleVoteLesson, handleVoteWiki,
  handleUpdateWiki,
  DEFAULT_MEMORY_CONFIG,
} from '../src/tools/memory.ts';
import { closeStore, _resetStoreCache } from '../src/tools/memory-qmd.ts';

function initVaultDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'tester@local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# vault\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  return dir;
}

function makeVaultChain() {
  const personalDir = initVaultDir('vault-p-47-');
  const teamDir     = initVaultDir('vault-t-47-');
  return {
    chain: [
      { id: 'my-notes', path: personalDir, kind: 'personal', remote: null },
      { id: 'team-eng', path: teamDir,     kind: 'team',     remote: null },
    ],
    cleanup: async () => {
      try { await closeStore(); } catch { /* ignore */ }
      _resetStoreCache();
      rmSync(personalDir, { recursive: true, force: true });
      rmSync(teamDir, { recursive: true, force: true });
    },
  };
}

function makeCtx(chain, nowIso = '2026-06-07T07:30:00Z', identityEmail = 'jane@team.com') {
  const dbDir = mkdtempSync(join(tmpdir(), 'qmd-47-'));
  return {
    chain,
    identity: { email: identityEmail, name: identityEmail, source: 'git' },
    config: {
      ...DEFAULT_MEMORY_CONFIG,
      qmd_db_path: join(dbDir, 'index.sqlite'),
      sync: { ...DEFAULT_MEMORY_CONFIG.sync, index_debounce_ms: 10 },
    },
    now: () => new Date(nowIso),
    _dbDir: dbDir,
  };
}

function cleanupCtx(ctx) {
  if (ctx?._dbDir) {
    try { rmSync(ctx._dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Voting
// ---------------------------------------------------------------------------

test('vote_memory appends event, commits, returns vote tally', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const mem = await handleAddMemory(ctx, {
      content: 'Memory content', scope: 'team', project: 'p',
      citations: 'a', reason: 'b b',
    });
    const voted = await handleVoteMemory(ctx, {
      path: mem.path, scope: 'team', direction: 'up', reason: 'looks legit',
    });
    assert.equal(voted.action, 'voted');
    assert.equal(voted.votes.up, 1);
    assert.equal(voted.votes.down, 0);

    // Sidecar should now have created + voted events.
    const got = await handleGetMemory(ctx, { path: mem.path, scope: 'team' });
    assert.equal(got.events_summary.votes.up, 1);
    assert.equal(got.events_summary.voters['jane@team.com'], 'up');

    // Commit should be visible in git log.
    const log = execFileSync('git', ['log', '--oneline'], { cwd: chain[1].path, encoding: 'utf8' });
    assert.match(log, /vote: up p\/memories/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('vote_memory rejects when target is a different type', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const lesson = await handleAddLesson(ctx, {
      content: 'lesson content', scope: 'personal', project: 'p', confidence: 0.5,
    });
    await assert.rejects(
      () => handleVoteMemory(ctx, { path: lesson.path, scope: 'personal', direction: 'up' }),
      /vote_memory called on a lesson document/i,
    );
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('vote_lesson returns decay-adjusted confidence', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const lesson = await handleAddLesson(ctx, {
      content: 'L1 content unique', scope: 'personal', project: 'p', confidence: 0.6,
    });
    const voted = await handleVoteLesson(ctx, {
      path: lesson.path, scope: 'personal', direction: 'up',
    });
    assert.equal(voted.votes.up, 1);
    assert.ok(typeof voted.confidence === 'number');
    // confidence = 0.6 + 0.05 (vote uplift) = 0.65, no decay since just reinforced
    assert.ok(Math.abs(voted.confidence - 0.65) < 1e-9, `expected ~0.65, got ${voted.confidence}`);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('vote_lesson per-actor latest-wins (flip up→down)', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const lesson = await handleAddLesson(ctx, {
      content: 'unique lesson', scope: 'personal', project: 'p',
    });
    await handleVoteLesson(ctx, { path: lesson.path, scope: 'personal', direction: 'up' });
    const flipped = await handleVoteLesson(ctx, {
      path: lesson.path, scope: 'personal', direction: 'down',
    });
    assert.equal(flipped.votes.up, 0);
    assert.equal(flipped.votes.down, 1);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('vote_wiki appends edit-history-independent vote events', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const wiki = await handleAddWikiPage(ctx, {
      path: 'guide', content: '# Guide\n\nContent.\n',
      scope: 'team', project: 'p',
    });
    const voted = await handleVoteWiki(ctx, {
      path: wiki.path, scope: 'team', direction: 'up',
    });
    assert.equal(voted.votes.up, 1);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// Phase 4: Lesson dedup (lex mode — exact normalized-content match)
// ---------------------------------------------------------------------------

test('add_lesson with exact-duplicate content appends reinforced event', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const first = await handleAddLesson(ctx, {
      content: 'Prefer events.jsonl over mutable frontmatter for vote counts',
      scope: 'personal', project: 'p', confidence: 0.5,
    });
    assert.equal(first.action, 'created');

    // Same content (whitespace differences should still match due to normalization)
    const second = await handleAddLesson(ctx, {
      content: '  prefer events.jsonl   over\nmutable frontmatter for vote counts  ',
      scope: 'personal', project: 'p',
    });
    assert.equal(second.action, 'reinforced');
    assert.equal(second.target, first.path);
    assert.equal(second.similarity, 1.0);

    // Verify confidence increased due to reinforcement.
    const got = await handleGetMemory(ctx, { path: first.path, scope: 'personal' });
    assert.equal(got.events_summary.reinforcement_count, 1);
    assert.ok(got.events_summary.confidence_stored > 0.5);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('add_lesson with different content creates new lesson', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const first = await handleAddLesson(ctx, {
      content: 'Always validate exp before iat',
      scope: 'personal', project: 'p',
    });
    const second = await handleAddLesson(ctx, {
      content: 'Use Redis for hot keys',
      scope: 'personal', project: 'p',
    });
    assert.equal(second.action, 'created');
    assert.notEqual(second.path, first.path);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// Phase 7: update_wiki
// ---------------------------------------------------------------------------

test('update_wiki append adds content to end of body', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleAddWikiPage(ctx, {
      path: 'guide', content: '# Guide\n\nOriginal.\n', scope: 'team', project: 'p',
    });
    const result = await handleUpdateWiki(ctx, {
      path: 'p/wiki/guide.md', scope: 'team', project: 'p',
      operation: 'append', content: '\n## New section\n\nAppended.\n',
    });
    assert.equal(result.action, 'updated');
    assert.equal(result.operation, 'append');

    const got = await handleGetMemory(ctx, { path: 'p/wiki/guide.md', scope: 'team' });
    assert.match(got.body, /Original/);
    assert.match(got.body, /New section/);
    assert.match(got.body, /Appended/);
    assert.equal(got.events_summary.edit_count, 1);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('update_wiki prepend adds content to start of body', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleAddWikiPage(ctx, {
      path: 'g', content: '# G\n\nBody.\n', scope: 'team', project: 'p',
    });
    await handleUpdateWiki(ctx, {
      path: 'p/wiki/g.md', scope: 'team', project: 'p',
      operation: 'prepend', content: '> [!note] Prepended\n',
    });
    const got = await handleGetMemory(ctx, { path: 'p/wiki/g.md', scope: 'team' });
    assert.ok(got.body.startsWith('> [!note] Prepended'), `body should start with prepend, got: ${got.body.slice(0, 100)}`);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('update_wiki find_replace with expected_replacements guard', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleAddWikiPage(ctx, {
      path: 'g', content: '# G\n\nfoo bar foo\n', scope: 'team', project: 'p',
    });
    await handleUpdateWiki(ctx, {
      path: 'p/wiki/g.md', scope: 'team', project: 'p',
      operation: 'find_replace', find_text: 'foo', content: 'baz',
      expected_replacements: 2,
    });
    const got = await handleGetMemory(ctx, { path: 'p/wiki/g.md', scope: 'team' });
    assert.match(got.body, /baz bar baz/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('update_wiki find_replace fails when expected_replacements mismatch', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleAddWikiPage(ctx, {
      path: 'g', content: '# G\n\nonly once\n', scope: 'team', project: 'p',
    });
    await assert.rejects(
      () => handleUpdateWiki(ctx, {
        path: 'p/wiki/g.md', scope: 'team', project: 'p',
        operation: 'find_replace', find_text: 'only', content: 'no',
        expected_replacements: 5,
      }),
      /expected 5 replacement/i,
    );
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('update_wiki replace_section swaps content under a markdown header', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleAddWikiPage(ctx, {
      path: 'g',
      content: '# G\n\nIntro paragraph.\n\n## Examples\n\nold example\n\n## Other\n\nkeep me\n',
      scope: 'team', project: 'p',
    });
    await handleUpdateWiki(ctx, {
      path: 'p/wiki/g.md', scope: 'team', project: 'p',
      operation: 'replace_section', section: '## Examples',
      content: 'NEW example body',
    });
    const got = await handleGetMemory(ctx, { path: 'p/wiki/g.md', scope: 'team' });
    assert.match(got.body, /NEW example body/);
    assert.doesNotMatch(got.body, /old example/);
    assert.match(got.body, /## Other/);  // sibling section preserved
    assert.match(got.body, /keep me/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('update_wiki full_replace rewrites body entirely', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleAddWikiPage(ctx, {
      path: 'g', content: '# G\n\nold body\n', scope: 'team', project: 'p',
    });
    await handleUpdateWiki(ctx, {
      path: 'p/wiki/g.md', scope: 'team', project: 'p',
      operation: 'full_replace', content: '# G\n\nbrand-new body\n',
    });
    const got = await handleGetMemory(ctx, { path: 'p/wiki/g.md', scope: 'team' });
    assert.match(got.body, /brand-new body/);
    assert.doesNotMatch(got.body, /old body/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('update_wiki errors when file does not exist', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await assert.rejects(
      () => handleUpdateWiki(ctx, {
        path: 'doesnotexist', scope: 'team', project: 'p',
        operation: 'append', content: 'x',
      }),
      /wiki page not found/i,
    );
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});
