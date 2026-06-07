/**
 * memory-tools-e2e.test.mjs
 *
 * End-to-end tests for the memory MCP tools (Phases 1-2).
 * Uses real git repos in tmpdir as vaults, real loadVaultChain-shaped
 * stubs, and real file I/O.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  handleAddMemory, handleAddLesson, handleAddSessionSummary,
  handleAddWikiPage, handleGetMemory, handleMemoryStatus,
  DEFAULT_MEMORY_CONFIG,
} from '../src/tools/memory.ts';

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
    cleanup: () => {
      rmSync(personalDir, { recursive: true, force: true });
      rmSync(teamDir, { recursive: true, force: true });
    },
  };
}

function makeCtx(chain, nowIso = '2026-06-07T07:30:00Z') {
  return {
    chain,
    identity: { email: 'jane@team.com', name: 'Jane', source: 'git' },
    config: { ...DEFAULT_MEMORY_CONFIG },
    now: () => new Date(nowIso),
  };
}

// ---------------------------------------------------------------------------
// add_memory
// ---------------------------------------------------------------------------

test('handleAddMemory writes file, sidecar event, and commits', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = makeCtx(chain);
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
    const filePath = join(teamRoot, 'clawdevbox', 'memories', result.slug);
    assert.ok(existsSync(filePath), `expected ${filePath} to exist`);
    const md = readFileSync(filePath, 'utf8');
    assert.match(md, /scope: team/);
    assert.match(md, /vault_id: team-eng/);
    assert.match(md, /project: clawdevbox/);
    assert.match(md, /type: memory/);
    assert.match(md, /citations:/);
    assert.match(md, /reason:/);
    assert.match(md, /Always validate JWT exp before iat/);

    const eventsFile = join(teamRoot, 'clawdevbox', 'memories', '.events',
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
  } finally { cleanup(); }
});

test('handleAddMemory rejects path traversal in project', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    await assert.rejects(
      () => handleAddMemory(makeCtx(chain), {
        content: 'x', scope: 'personal', project: '..',
        citations: 'a', reason: 'b',
      }),
      /illegal characters/i,
    );
  } finally { cleanup(); }
});

test('handleAddMemory errors when no vault matches scope', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const teamOnly = chain.filter((v) => v.kind === 'team');
    await assert.rejects(
      () => handleAddMemory(makeCtx(teamOnly), {
        content: 'x', scope: 'personal', project: 'p',
        citations: 'a', reason: 'b',
      }),
      /no vault registered with kind=personal/i,
    );
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// add_lesson
// ---------------------------------------------------------------------------

test('handleAddLesson writes to lessons/ with initial_confidence', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = makeCtx(chain, '2026-06-07T08:00:00Z');
    const result = await handleAddLesson(ctx, {
      content: 'Prefer events.jsonl over in-frontmatter mutable state',
      scope: 'personal',
      project: '_general',
      confidence: 0.7,
    });
    const filePath = join(chain[0].path, '_general', 'lessons', result.slug);
    assert.ok(existsSync(filePath));
    const md = readFileSync(filePath, 'utf8');
    assert.match(md, /type: lesson/);
    assert.match(md, /initial_confidence: 0\.7/);

    // Folded state should compute confidence from initial + delta + votes (none yet).
    const got = await handleGetMemory(ctx, {
      path: `_general/lessons/${result.slug}`,
      scope: 'personal',
    });
    assert.equal(got.events_summary.confidence_stored, 0.7);
    assert.equal(got.events_summary.reinforcement_count, 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// add_session_summary
// ---------------------------------------------------------------------------

test('handleAddSessionSummary uses minute granularity in filename', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = makeCtx(chain, '2026-06-07T09:38:15Z');
    const result = await handleAddSessionSummary(ctx, {
      title: 'Design memory tools',
      narrative: 'Picked event-sourced sidecars and the qmd SDK in-process.',
      scope: 'personal',
      project: 'clawdevbox',
      decisions: ['sidecar over frontmatter', 'qmd SDK over MCP'],
      files: ['mcp-server/src/tools/memory.ts'],
    });
    assert.match(result.slug, /^2026-06-07T09-38-design-memory-tools\.md$/);
    const md = readFileSync(join(chain[0].path, 'clawdevbox', 'sessions', result.slug), 'utf8');
    assert.match(md, /sidecar over frontmatter/);
    assert.match(md, /decisions:/);
    assert.match(md, /## Decisions/);
    assert.match(md, /mcp-server\/src\/tools\/memory\.ts/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// add_wiki_page
// ---------------------------------------------------------------------------

test('handleAddWikiPage creates nested path with wikilink-friendly body', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = makeCtx(chain);
    const result = await handleAddWikiPage(ctx, {
      path: 'architecture/data-flow',
      content: '# Data flow\n\nSee [[architecture/overview]].\n',
      scope: 'team',
      project: 'clawdevbox',
    });
    assert.equal(result.slug, 'architecture/data-flow.md');
    const filePath = join(chain[1].path, 'clawdevbox', 'wiki', 'architecture', 'data-flow.md');
    assert.ok(existsSync(filePath));
    const md = readFileSync(filePath, 'utf8');
    assert.match(md, /type: wiki/);
    assert.match(md, /\[\[architecture\/overview\]\]/);
  } finally { cleanup(); }
});

test('handleAddWikiPage rejects duplicate path', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = makeCtx(chain);
    const args = { path: 'overview', content: '# Overview\n\nHi.', scope: 'personal', project: 'p' };
    await handleAddWikiPage(ctx, args);
    await assert.rejects(() => handleAddWikiPage(ctx, args), /already exists/i);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// get_memory across vaults
// ---------------------------------------------------------------------------

test('handleGetMemory finds file in correct vault when scope=all', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = makeCtx(chain);
    const created = await handleAddMemory(ctx, {
      content: 'unique-content', scope: 'personal', project: 'p',
      citations: 'x', reason: 'because.',
    });
    // No scope filter — should still find it
    const got = await handleGetMemory(ctx, { path: `p/memories/${created.slug}` });
    assert.equal(got.vault_id, 'my-notes');
    assert.equal(got.type, 'memory');
  } finally { cleanup(); }
});

test('handleGetMemory throws when file not found', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    await assert.rejects(
      () => handleGetMemory(makeCtx(chain), { path: 'nonexistent/memories/nope.md' }),
      /not found/i,
    );
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// memory_status
// ---------------------------------------------------------------------------

test('handleMemoryStatus returns vault list + config snapshot + identity', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const status = await handleMemoryStatus(makeCtx(chain), {});
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
  } finally { cleanup(); }
});
