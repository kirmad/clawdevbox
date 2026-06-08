/**
 * memory-tools-e2e.test.mjs
 *
 * End-to-end tests for the memory MCP tools (Phases 1-3).
 * Uses real git repos in tmpdir as vaults, real loadVaultChain-shaped
 * stubs, real file I/O, and real qmd SDK in lex-only mode.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  handleAddMemory, handleAddLesson, handleAddSessionSummary,
  handleAddWikiPage, handleGetMemory, handleMemoryStatus,
  handleMemoryInit, handleSearchMemory, handleGetWikiIndex,
  DEFAULT_MEMORY_CONFIG,
} from '../src/tools/memory.ts';
import { closeStore, _resetStoreCache, flushReindex, getStore } from '../src/tools/memory-qmd.ts';

function initVaultDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'tester@local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Test vault\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  return dir;
}

function makeVaultChain() {
  const personalDir = initVaultDir('vault-p-');
  const teamDir     = initVaultDir('vault-t-');
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

function makeCtx(chain, nowIso = '2026-06-07T07:30:00Z', overrides = {}) {
  const dbDir = mkdtempSync(join(tmpdir(), 'qmd-db-'));
  return {
    chain,
    identity: { email: 'jane@team.com', name: 'Jane', source: 'git' },
    config: {
      ...DEFAULT_MEMORY_CONFIG,
      qmd_db_path: join(dbDir, 'index.sqlite'),
      sync: { ...DEFAULT_MEMORY_CONFIG.sync, index_debounce_ms: 10 },
      ...overrides,
    },
    now: () => new Date(nowIso),
    _dbDir: dbDir,  // for cleanup
  };
}

function cleanupCtx(ctx) {
  if (ctx?._dbDir) {
    try { rmSync(ctx._dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// add_memory
// ---------------------------------------------------------------------------

test('handleAddMemory writes file, sidecar event, and commits', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const result = await handleAddMemory(ctx, {
      content: 'Always validate JWT exp before iat',
      scope: 'team',
      project: 'clawdevbox',
      citations: 'src/auth/jwt.ts:42',
      reason: 'We hit this in production twice; future auth work must validate exp first.',
    });
    assert.equal(result.action, 'created');
    assert.equal(result.vault_id, 'team-eng');
    assert.match(result.slug, /^2026-06-07-always-validate-jwt-exp-before-iat\.md$/);

    const teamRoot = chain[1].path;
    const filePath = join(teamRoot, 'memories', 'clawdevbox', 'memories', result.slug);
    assert.ok(existsSync(filePath), `expected ${filePath} to exist`);
    const md = readFileSync(filePath, 'utf8');
    assert.match(md, /scope: team/);
    assert.match(md, /vault_id: team-eng/);
    assert.match(md, /project: clawdevbox/);
    assert.match(md, /type: memory/);
    assert.match(md, /citations:/);
    assert.match(md, /reason:/);
    assert.match(md, /Always validate JWT exp before iat/);

    const eventsFile = join(teamRoot, 'memories', 'clawdevbox', 'memories', '.events',
      result.slug.replace(/\.md$/, '') + '.jsonl');
    assert.ok(existsSync(eventsFile), `expected ${eventsFile} to exist`);
    const ev = JSON.parse(readFileSync(eventsFile, 'utf8').trim());
    assert.equal(ev.type, 'created');
    assert.equal(ev.actor, 'jane@team.com');

    const log = execFileSync('git', ['log', '--oneline'], { cwd: teamRoot, encoding: 'utf8' });
    assert.match(log, /memory: Always validate JWT exp/);

    // Round-trip via handleGetMemory
    const got = await handleGetMemory(ctx, {
      path: `clawdevbox/memories/${result.slug}`,
      scope: 'team',
    });
    assert.equal(got.type, 'memory');
    assert.equal(got.frontmatter.scope, 'team');
    assert.equal(got.events_summary.created.by, 'jane@team.com');
    assert.equal(got.events_summary.votes.up, 0);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('handleAddMemory rejects path traversal in project', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await assert.rejects(
      () => handleAddMemory(ctx, {
        content: 'x', scope: 'personal', project: '..',
        citations: 'a', reason: 'b',
      }),
      /illegal characters/i,
    );
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('handleAddMemory errors when no vault matches scope', async () => {
  const { chain, cleanup } = makeVaultChain();
  const teamOnly = chain.filter((v) => v.kind === 'team');
  const ctx = makeCtx(teamOnly);
  try {
    await assert.rejects(
      () => handleAddMemory(ctx, {
        content: 'x', scope: 'personal', project: 'p',
        citations: 'a', reason: 'b',
      }),
      /no vault registered with kind=personal/i,
    );
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// add_lesson
// ---------------------------------------------------------------------------

test('handleAddLesson writes to lessons/ with initial_confidence', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain, '2026-06-07T08:00:00Z');
  try {
    const result = await handleAddLesson(ctx, {
      content: 'Prefer events.jsonl over in-frontmatter mutable state',
      scope: 'personal',
      project: '_general',
      confidence: 0.7,
    });
    const filePath = join(chain[0].path, 'memories', '_general', 'lessons', result.slug);
    assert.ok(existsSync(filePath));
    const md = readFileSync(filePath, 'utf8');
    assert.match(md, /type: lesson/);
    assert.match(md, /initial_confidence: 0\.7/);

    const got = await handleGetMemory(ctx, {
      path: `_general/lessons/${result.slug}`,
      scope: 'personal',
    });
    assert.equal(got.events_summary.confidence_stored, 0.7);
    assert.equal(got.events_summary.reinforcement_count, 0);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// add_session_summary
// ---------------------------------------------------------------------------

test('handleAddSessionSummary uses minute granularity in filename', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain, '2026-06-07T09:38:15Z');
  try {
    const result = await handleAddSessionSummary(ctx, {
      title: 'Design memory tools',
      narrative: 'Picked event-sourced sidecars and the qmd SDK in-process.',
      scope: 'personal',
      project: 'clawdevbox',
      decisions: ['sidecar over frontmatter', 'qmd SDK over MCP'],
      files: ['mcp-server/src/tools/memory.ts'],
    });
    assert.match(result.slug, /^2026-06-07T09-38-design-memory-tools\.md$/);
    const md = readFileSync(join(chain[0].path, 'memories', 'clawdevbox', 'sessions', result.slug), 'utf8');
    assert.match(md, /sidecar over frontmatter/);
    assert.match(md, /decisions:/);
    assert.match(md, /## Decisions/);
    assert.match(md, /mcp-server\/src\/tools\/memory\.ts/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// add_wiki_page
// ---------------------------------------------------------------------------

test('handleAddWikiPage creates nested path with wikilink-friendly body', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const result = await handleAddWikiPage(ctx, {
      path: 'architecture/data-flow',
      content: '# Data flow\n\nSee [[architecture/overview]].\n',
      scope: 'team',
      project: 'clawdevbox',
    });
    assert.equal(result.slug, 'architecture/data-flow.md');
    const filePath = join(chain[1].path, 'memories', 'clawdevbox', 'wiki', 'architecture', 'data-flow.md');
    assert.ok(existsSync(filePath));
    const md = readFileSync(filePath, 'utf8');
    assert.match(md, /type: wiki/);
    assert.match(md, /\[\[architecture\/overview\]\]/);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('handleAddWikiPage rejects duplicate path', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const args = { path: 'overview', content: '# Overview\n\nHi.', scope: 'personal', project: 'p' };
    await handleAddWikiPage(ctx, args);
    await assert.rejects(() => handleAddWikiPage(ctx, args), /already exists/i);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// get_memory across vaults
// ---------------------------------------------------------------------------

test('handleGetMemory finds file in correct vault when scope omitted', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const created = await handleAddMemory(ctx, {
      content: 'unique-content', scope: 'personal', project: 'p',
      citations: 'x', reason: 'because.',
    });
    const got = await handleGetMemory(ctx, { path: `p/memories/${created.slug}` });
    assert.equal(got.vault_id, 'my-notes');
    assert.equal(got.type, 'memory');
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('handleGetMemory throws when file not found', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await assert.rejects(
      () => handleGetMemory(ctx, { path: 'nonexistent/memories/nope.md' }),
      /not found/i,
    );
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// memory_status
// ---------------------------------------------------------------------------

test('handleMemoryStatus returns vault list + config snapshot + identity', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const status = await handleMemoryStatus(ctx, {});
    assert.equal(status.config.vaults.length, 2);
    assert.equal(status.config.vaults[0].kind, 'personal');
    assert.equal(status.config.vaults[0].id, 'my-notes');
    assert.equal(status.config.vaults[1].kind, 'team');
    assert.equal(status.config.qmd_search_mode, 'lex');
    assert.equal(status.config.decay.floor, 0.2);
    assert.equal(status.config.decay.half_life_days, 30);
    assert.equal(status.identity.email, 'jane@team.com');
    assert.equal(status.qmd.models_loaded, false);
    assert.deepEqual(status.warnings, []);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// memory_init
// ---------------------------------------------------------------------------

test('handleMemoryInit scaffolds folders and registers qmd collections idempotently', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const result1 = await handleMemoryInit(ctx, {});
    assert.equal(result1.vaults.length, 2);
    assert.equal(result1.qmd_status.collections, 2);
    assert.ok(existsSync(join(chain[0].path, 'memories', '_general', 'memories')));
    assert.ok(existsSync(join(chain[0].path, 'memories', '_general', 'lessons')));
    assert.ok(existsSync(join(chain[0].path, 'memories', '_general', 'sessions')));
    assert.ok(existsSync(join(chain[0].path, 'memories', '_general', 'wiki')));
    assert.ok(existsSync(join(chain[1].path, 'memories', '_general', 'memories')));

    // Idempotent
    const result2 = await handleMemoryInit(ctx, {});
    assert.equal(result2.qmd_status.collections, 2);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('handleMemoryInit errors when chain is empty', async () => {
  const ctx = makeCtx([]);
  try {
    await assert.rejects(() => handleMemoryInit(ctx, {}), /no vaults registered/i);
  } finally {
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// search_memory
// ---------------------------------------------------------------------------

test('handleSearchMemory finds a memory by keyword across vaults', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleMemoryInit(ctx, {});
    await handleAddMemory(ctx, {
      content: 'JWT exp must come before iat in validation order',
      scope: 'team', project: 'clawdevbox',
      citations: 'src/auth/jwt.ts:42',
      reason: 'Prevents an exploit path where iat is future.',
    });
    await handleAddMemory(ctx, {
      content: 'Always escape user input before SQL interpolation',
      scope: 'personal', project: 'clawdevbox',
      citations: 'src/db/query.ts:10',
      reason: 'SQL injection is a classic OWASP risk.',
    });

    // Force the index to pick up the new files
    const store = await getStore(ctx.config);
    await flushReindex(store, ctx.config);

    const result = await handleSearchMemory(ctx, { query: 'jwt' });
    assert.ok(result.results.length >= 1, 'expected at least one jwt hit');
    const top = result.results[0];
    assert.equal(top.type, 'memory');
    assert.equal(top.project, 'clawdevbox');
    assert.ok(top.path.includes('jwt'), `expected path to contain "jwt", got ${top.path}`);

    // Filter by scope
    const teamOnly = await handleSearchMemory(ctx, { query: 'jwt', scope: 'team' });
    assert.ok(teamOnly.results.every((r) => r.scope === 'team'));

    const personalOnly = await handleSearchMemory(ctx, { query: 'sql', scope: 'personal' });
    assert.ok(personalOnly.results.every((r) => r.scope === 'personal'));
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('handleSearchMemory filters by types and project', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleMemoryInit(ctx, {});
    await handleAddMemory(ctx, {
      content: 'foobar baz',
      scope: 'personal', project: 'projA',
      citations: 'a', reason: 'a a',
    });
    await handleAddLesson(ctx, {
      content: 'foobar lesson learned',
      scope: 'personal', project: 'projB',
      confidence: 0.5,
    });

    const store = await getStore(ctx.config);
    await flushReindex(store, ctx.config);

    const memOnly = await handleSearchMemory(ctx, { query: 'foobar', types: ['memory'] });
    assert.ok(memOnly.results.every((r) => r.type === 'memory'));

    const projB = await handleSearchMemory(ctx, { query: 'foobar', project: 'projB' });
    assert.ok(projB.results.every((r) => r.project === 'projB'));
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('handleSearchMemory returns empty when no vaults match the requested scope', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    const result = await handleSearchMemory(ctx, { query: 'anything', vault_id: 'nonexistent' });
    assert.deepEqual(result.results, []);
    assert.equal(result.total, 0);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// get_wiki_index
// ---------------------------------------------------------------------------

test('handleGetWikiIndex returns nested tree with summaries and tags', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleMemoryInit(ctx, {});

    // Build a small wiki: top-level overview + nested architecture/* pages
    await handleAddWikiPage(ctx, {
      path: 'overview', content: '# Overview\n\nTop level wiki.\n',
      scope: 'team', project: 'clawdevbox', keywords: ['intro'],
    });
    await handleAddWikiPage(ctx, {
      path: 'architecture/data-flow',
      content: '# Data flow\n\nFlows from A to B.\n\nSee [[overview]].\n',
      scope: 'team', project: 'clawdevbox',
    });
    await handleAddWikiPage(ctx, {
      path: 'architecture/components',
      content: '# Components\n\nList of components.\n',
      scope: 'team', project: 'clawdevbox',
    });

    const idx = await handleGetWikiIndex(ctx, {
      scope: 'team', project: 'clawdevbox', depth: 2,
      include: { summaries: true, tags: true, links: true, metadata: true },
    });
    assert.equal(idx.total_pages, 3);
    assert.equal(idx.tree.length, 2, 'one folder + one page at top level');

    const pages = idx.tree.filter((n) => n.type === 'page');
    const folders = idx.tree.filter((n) => n.type === 'folder');
    assert.equal(pages.length, 1);
    assert.equal(folders.length, 1);
    assert.equal(folders[0].page_count, 2);
    assert.equal(folders[0].children.length, 2);

    const overview = pages[0];
    assert.match(overview.summary ?? '', /Top level wiki/);
    assert.ok(overview.tags.includes('intro'));

    // Test the links_out extraction
    const dataFlow = folders[0].children.find((c) => c.path.endsWith('data-flow.md'));
    assert.ok(dataFlow);
    assert.ok(dataFlow.links_out?.includes('overview'),
      `expected data-flow.links_out to include "overview", got ${JSON.stringify(dataFlow.links_out)}`);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});

test('handleGetWikiIndex respects depth limit and reports truncated_at_depth', async () => {
  const { chain, cleanup } = makeVaultChain();
  const ctx = makeCtx(chain);
  try {
    await handleMemoryInit(ctx, {});
    await handleAddWikiPage(ctx, {
      path: 'a/b/c/deep',
      content: '# Deep page\n\nDeep content.\n',
      scope: 'personal', project: 'p',
    });

    const shallow = await handleGetWikiIndex(ctx, {
      scope: 'personal', project: 'p', depth: 1,
    });
    assert.equal(shallow.truncated_at_depth, true);
    assert.equal(shallow.total_pages, 1);

    const full = await handleGetWikiIndex(ctx, {
      scope: 'personal', project: 'p', depth: -1,
    });
    assert.equal(full.truncated_at_depth, false);
    assert.equal(full.total_pages, 1);
  } finally {
    await cleanup();
    cleanupCtx(ctx);
  }
});
