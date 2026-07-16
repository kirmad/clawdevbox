/**
 * memory-get-lessons.test.mjs
 *
 * E2E tests for the get_lessons tool — the session-start preload that
 * returns the top-ranked lessons (combined_score = decay-adjusted
 * confidence × vote boost) at personal + team scopes across all vaults.
 *
 * Uses the real handler + real handleAddLesson + handleVoteLesson so
 * the ranking / scoring / dedupe-reinforce paths are exercised end-to-end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  handleGetLessons, handleAddLesson, handleVoteLesson,
  DEFAULT_MEMORY_CONFIG,
} from '../src/tools/memory.ts';
import { closeStore, _resetStoreCache } from '../src/tools/memory-qmd.ts';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function initVaultDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'tester@local'], dir);
  git(['config', 'user.name', 'Tester'], dir);
  writeFileSync(join(dir, 'README.md'), '# vault\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
  return dir;
}

function makeVaultChain() {
  const personalDir = initVaultDir('vault-gl-p-');
  const teamDir     = initVaultDir('vault-gl-t-');
  return {
    chain: [
      { id: 'my-notes', path: personalDir, kind: 'personal', remote: null },
      { id: 'team-eng', path: teamDir,     kind: 'team',     remote: null },
    ],
    cleanup: async () => {
      try { await closeStore(); } catch { /* ignore */ }
      _resetStoreCache();
      for (const d of [personalDir, teamDir]) {
        rmSync(d, { recursive: true, force: true });
      }
    },
  };
}

function makeCtx(chain, isoNow = '2026-06-08T00:00:00Z') {
  const dbDir = mkdtempSync(join(tmpdir(), 'qmd-gl-'));
  return {
    chain,
    identity: { email: 'jane@team.com', name: 'Jane', source: 'git' },
    config: {
      ...DEFAULT_MEMORY_CONFIG,
      qmd_db_path: join(dbDir, 'i.sqlite'),
      sync: { ...DEFAULT_MEMORY_CONFIG.sync, index_debounce_ms: 10 },
    },
    now: () => new Date(isoNow),
    _dbDir: dbDir,
  };
}

function cleanupCtx(ctx) {
  if (ctx?._dbDir) {
    try { rmSync(ctx._dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------

test('get_lessons returns empty when no lessons exist', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const r = await handleGetLessons(ctx, {});
    assert.equal(r.personal.length, 0);
    assert.equal(r.team.length, 0);
    assert.equal(r.context.vaults_searched.length, 2);
    assert.equal(r.context.total_candidates, 0);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('get_lessons separates personal vs team lessons by vault kind', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleAddLesson(ctx, {
      content: 'Personal preference: always use strict null checks',
      scope: 'personal', confidence: 0.7,
    });
    await handleAddLesson(ctx, {
      content: 'Team rule: TS strict mode is on; never disable',
      scope: 'team', confidence: 0.8,
    });

    const r = await handleGetLessons(ctx, {});
    assert.equal(r.personal.length, 1);
    assert.equal(r.team.length, 1);
    assert.match(r.personal[0].content, /strict null checks/);
    assert.match(r.team[0].content, /TS strict mode/);
    assert.equal(r.personal[0].scope, 'personal');
    assert.equal(r.team[0].scope, 'team');
    assert.equal(r.context.total_candidates, 2);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('get_lessons returns all lessons across vaults (no project filtering)', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    // Three distinct personal lessons — all are returned now that
    // lessons are stored flat with no per-project filtering.
    await handleAddLesson(ctx, {
      content: 'clawdevbox lesson', scope: 'personal', confidence: 0.8,
    });
    await handleAddLesson(ctx, {
      content: 'general lesson', scope: 'personal', confidence: 0.7,
    });
    await handleAddLesson(ctx, {
      content: 'unrelated repo lesson', scope: 'personal', confidence: 0.9,
    });

    const r = await handleGetLessons(ctx, {});
    assert.equal(r.personal.length, 3, `expected all 3 lessons; got: ${r.personal.map(l => l.content).join(', ')}`);
    assert.equal(r.context.total_candidates, 3);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('get_lessons ranks by combined_score = confidence × vote boost (desc)', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    // High confidence, no votes
    const a = await handleAddLesson(ctx, {
      content: 'Lesson A high conf no votes', scope: 'personal',
      confidence: 0.9,
    });
    // Lower confidence but upvoted
    const b = await handleAddLesson(ctx, {
      content: 'Lesson B low conf but upvoted', scope: 'personal',
      confidence: 0.5,
    });
    // Vote B up by two distinct actors so net = 2
    await handleVoteLesson(ctx, { path: b.path, scope: 'personal', direction: 'up' });
    const ctx2 = { ...ctx, identity: { email: 'bob@team.com', name: 'Bob', source: 'git' } };
    await handleVoteLesson(ctx2, { path: b.path, scope: 'personal', direction: 'up' });

    const r = await handleGetLessons(ctx, {});
    assert.equal(r.personal.length, 2);

    // Combined score should be strictly decreasing
    for (let i = 1; i < r.personal.length; i++) {
      assert.ok(r.personal[i - 1].combined_score >= r.personal[i].combined_score,
        `expected combined_score desc; got [${r.personal.map(l => l.combined_score.toFixed(3)).join(', ')}]`);
    }
    // B should win because it has confidence 0.5+vote_boost > 0.9
    // confidence A ~= 0.9 (no decay), boost A = 1+ln(1) = 1 → combined ~= 0.9
    // confidence B ~= 0.5 + 0.1 (vote bump from foldEvents 0.05/vote × 2 = +0.10) = 0.6
    //   then boosted: 0.6 × (1 + ln(3)) ≈ 0.6 × 2.099 ≈ 1.26
    assert.match(r.personal[0].content, /Lesson B/, 'B should rank first due to vote boost');
    assert.match(r.personal[1].content, /Lesson A/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('get_lessons respects limit_personal and limit_team caps', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    for (let i = 0; i < 5; i++) {
      // Use distinct content to avoid lesson dedup
      await handleAddLesson(ctx, {
        content: `Personal lesson number ${i} with some unique trailing text ${i}`,
        scope: 'personal', confidence: 0.5 + i * 0.05,
      });
    }
    for (let i = 0; i < 5; i++) {
      await handleAddLesson(ctx, {
        content: `Team lesson number ${i} with some unique trailing text ${i}`,
        scope: 'team', confidence: 0.5 + i * 0.05,
      });
    }

    const r = await handleGetLessons(ctx, {
      limit_personal: 2, limit_team: 3,
    });
    assert.equal(r.personal.length, 2);
    assert.equal(r.team.length, 3);
    assert.equal(r.context.total_candidates, 10);
    // Top items are highest confidence
    assert.match(r.personal[0].content, /number 4/);
    assert.match(r.personal[1].content, /number 3/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('get_lessons confidence is decay-adjusted (older lesson scores lower)', async () => {
  const { chain, cleanup } = makeVaultChain();
  // 90 days = 3× the default 30-day half-life → confidence approaches floor.
  const ctxOld = makeCtx(chain, '2026-03-10T00:00:00Z');
  try {
    // Write a lesson dated in March
    await handleAddLesson(ctxOld, {
      content: 'Old high-confidence lesson', scope: 'personal',
      confidence: 0.9,
    });

    // Query as if it's now June — 90+ days later
    const ctxNow = makeCtx(chain, '2026-06-08T00:00:00Z');
    // Reuse the chain (same on-disk vault) but new now() + db
    ctxNow.chain = chain;
    try {
      const r = await handleGetLessons(ctxNow, {});
      assert.equal(r.personal.length, 1);
      // Decay from 0.9 with floor 0.2, half-life 30d, after 90d:
      //   0.2 + (0.9 - 0.2) × 0.5^3 = 0.2 + 0.7 × 0.125 = 0.2875
      assert.ok(r.personal[0].confidence < 0.4 && r.personal[0].confidence > 0.25,
        `expected decayed confidence ~0.29; got ${r.personal[0].confidence}`);
      // combined_score = confidence × 1 (no votes) ≈ same
      assert.ok(r.personal[0].combined_score < 0.4);
    } finally {
      cleanupCtx(ctxNow);
    }
  } finally {
    await cleanup();
    cleanupCtx(ctxOld);
  }
});

test('get_lessons ignores non-lesson files in lessons/ directory', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    // Manually drop a bogus non-lesson file in the lessons/ folder
    const wrongDir = join(chain[0].path, 'memories', 'lessons');
    mkdirSync(wrongDir, { recursive: true });
    writeFileSync(join(wrongDir, 'not-a-lesson.md'),
      '---\ntype: fact\n---\n\nSome fact body.\n');
    // Also add a real lesson
    await handleAddLesson(ctx, {
      content: 'Real lesson', scope: 'personal',
      confidence: 0.7,
    });

    const r = await handleGetLessons(ctx, {});
    assert.equal(r.personal.length, 1, 'non-lesson file should be skipped');
    assert.match(r.personal[0].content, /Real lesson/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});
