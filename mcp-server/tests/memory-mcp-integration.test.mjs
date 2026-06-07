/**
 * memory-mcp-integration.test.mjs
 *
 * Integration test: registers memory tools via registerMemoryEntries
 * and invokes them through the global registry (the same path MCP
 * uses when run_tool is called). Verifies Zod validation, ctx
 * building (config + identity + vault chain), and response shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerMemoryEntries } from '../src/tools/memory.ts';
import { clearRegistry, getRegistry } from '../src/tools/registry.ts';
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

/**
 * Build a workspace stub that mirrors what registerMemoryEntries needs:
 *   - globalDir: where to find memory-config.json + global config.json
 *   - projectDir: where to find project-level .clawdevbox/config.json
 *
 * We write a real clawdevbox config.json (under globalDir) with the
 * vault chain so loadVaultChainSafe() picks it up through resolveConfig.
 */
function makeStubWorkspace(personalDir, teamDir) {
  const globalDir = mkdtempSync(join(tmpdir(), 'globalDir-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'projectDir-'));
  const workspacesRoot = mkdtempSync(join(tmpdir(), 'workspaces-'));

  const cfg = {
    version: 1,
    workspaces_root: workspacesRoot,
    vaults: [
      { id: 'my-notes', path: personalDir, kind: 'personal', remote: null },
      { id: 'team-eng', path: teamDir,     kind: 'team',     remote: null },
    ],
  };
  // Global config — read by resolveConfig({ globalDir }).
  writeFileSync(join(globalDir, 'config.json'), JSON.stringify(cfg));

  // memory-config.json with lex mode + short index debounce for tests
  const dbDir = mkdtempSync(join(tmpdir(), 'qmd-int-'));
  writeFileSync(join(globalDir, 'memory-config.json'), JSON.stringify({
    qmd_db_path: join(dbDir, 'index.sqlite'),
    qmd_search_mode: 'lex',
    sync: { index_debounce_ms: 10, push_debounce_ms: 100, pull_interval_ms: 100000 },
  }));

  return {
    ws: {
      globalDir,
      projectDir,
    },
    cleanup: async () => {
      try { await closeStore(); } catch { /* ignore */ }
      _resetStoreCache();
      for (const d of [globalDir, projectDir, workspacesRoot, dbDir]) {
        rmSync(d, { recursive: true, force: true });
      }
    },
  };
}

function getTool(name) {
  const t = getRegistry().get(name);
  assert.ok(t, `tool ${name} not registered`);
  return t;
}

/**
 * Invoke a registered tool the way MCP does:
 *   1. Validate args through the tool's Zod schema.
 *   2. Call the handler with parsed args.
 *   3. Assert the response is MCP-shaped: { content: [...], structuredContent: ... }
 */
async function invokeTool(name, args) {
  const t = getTool(name);
  const parsed = t.parameters.parse(args);
  const response = await t.handler(parsed, {});
  assert.ok(Array.isArray(response.content), `${name} response.content must be array`);
  assert.ok(response.content[0].type === 'text', `${name} content[0].type must be 'text'`);
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}

// ---------------------------------------------------------------------------

test('full MCP integration: register, init, add×4, search, get, status', async (t) => {
  const personalDir = initVaultDir('vault-p-int-');
  const teamDir     = initVaultDir('vault-t-int-');
  const { ws, cleanup } = makeStubWorkspace(personalDir, teamDir);

  try {
    clearRegistry();
    registerMemoryEntries(ws);

    // All 13+ tools should be registered (14 with memory_sync)
    const expected = [
      'add_memory', 'add_lesson', 'add_session_summary', 'add_wiki_page',
      'get_memory', 'memory_status', 'memory_init', 'search_memory', 'get_wiki_index',
      'vote_memory', 'vote_lesson', 'vote_wiki', 'update_wiki', 'memory_sync',
    ];
    for (const name of expected) {
      assert.ok(getRegistry().has(name), `${name} should be registered`);
    }

    // memory_init
    const initResult = await invokeTool('memory_init', {});
    assert.equal(initResult.vaults.length, 2);
    assert.equal(initResult.qmd_status.collections, 2);

    // memory_status reports both vaults
    const status = await invokeTool('memory_status', {});
    assert.equal(status.config.vaults.length, 2);
    assert.equal(status.config.qmd_search_mode, 'lex');

    // add_memory (team)
    const mem = await invokeTool('add_memory', {
      content: 'JWT exp claim must be validated before iat to prevent future-iat token bypass',
      scope: 'team',
      project: 'clawdevbox',
      citations: 'src/auth/jwt.ts:42',
      reason: 'We hit this in prod twice; future auth work needs this rule.',
      concepts: ['auth', 'jwt', 'security'],
    });
    assert.equal(mem.action, 'created');
    assert.equal(mem.vault_id, 'team-eng');

    // add_lesson (personal)
    const lesson = await invokeTool('add_lesson', {
      content: 'Sidecar event logs work better than mutable in-frontmatter counters for concurrent edits',
      scope: 'personal',
      project: 'clawdevbox',
      confidence: 0.8,
      context: 'Learned while designing memory subsystem',
    });
    assert.equal(lesson.vault_id, 'my-notes');

    // add_session_summary
    const session = await invokeTool('add_session_summary', {
      title: 'Memory tools MVP build',
      narrative: 'Implemented Phases 0-3 end-to-end. All 72 unit tests green.',
      scope: 'team',
      project: 'clawdevbox',
      decisions: ['lex-only default', 'sidecar event logs'],
      files: ['mcp-server/src/tools/memory.ts'],
      concepts: ['memory-tools', 'qmd'],
    });
    assert.match(session.slug, /memory-tools-mvp-build/);

    // add_wiki_page
    const wiki = await invokeTool('add_wiki_page', {
      path: 'architecture/overview',
      content: '# Architecture overview\n\nMCP tools live in `memory.ts`. See [[architecture/data-flow]].\n',
      scope: 'team',
      project: 'clawdevbox',
      keywords: ['architecture'],
    });
    assert.equal(wiki.action, 'created');

    // get_memory round-trip
    const fetched = await invokeTool('get_memory', {
      path: `clawdevbox/memories/${mem.slug}`,
      scope: 'team',
    });
    assert.equal(fetched.type, 'memory');
    assert.equal(fetched.frontmatter.scope, 'team');

    // search_memory — need to flush reindex since debounce is async
    const { flushReindex, getStore } = await import('../src/tools/memory-qmd.ts');
    const { loadMemoryConfig } = await import('../src/tools/memory-config.ts');
    const memCfg = loadMemoryConfig(join(ws.globalDir, 'memory-config.json'));
    const store = await getStore(memCfg);
    await flushReindex(store, memCfg);

    const results = await invokeTool('search_memory', { query: 'jwt' });
    assert.ok(results.results.length >= 1, `expected at least one jwt hit, got ${results.total}`);
    const top = results.results[0];
    assert.equal(top.type, 'memory');
    assert.equal(top.scope, 'team');

    // get_wiki_index — should see the overview page
    const idx = await invokeTool('get_wiki_index', {
      scope: 'team',
      project: 'clawdevbox',
      depth: 3,
      include: { links: true },
    });
    assert.equal(idx.total_pages, 1);
    // overview.md is nested under architecture/ folder
    const folder = idx.tree.find((n) => n.type === 'folder' && n.path === 'architecture/');
    assert.ok(folder, `expected architecture/ folder, got tree: ${JSON.stringify(idx.tree)}`);
    const page = folder.children.find((n) => n.type === 'page');
    assert.ok(page, 'expected an overview page inside architecture/');
    assert.ok(page.links_out?.includes('architecture/data-flow'),
      `expected links_out to include "architecture/data-flow", got ${JSON.stringify(page.links_out)}`);
  } finally {
    await cleanup();
    rmSync(personalDir, { recursive: true, force: true });
    rmSync(teamDir, { recursive: true, force: true });
  }
});

test('Zod validation rejects malformed args via the registered tool', async () => {
  const personalDir = initVaultDir('vault-p-zod-');
  const teamDir     = initVaultDir('vault-t-zod-');
  const { ws, cleanup } = makeStubWorkspace(personalDir, teamDir);
  try {
    clearRegistry();
    registerMemoryEntries(ws);

    const addMem = getTool('add_memory');
    assert.throws(
      () => addMem.parameters.parse({
        // missing required `content`
        scope: 'team', project: 'p', citations: 'a', reason: 'b b',
      }),
      /content/i,
    );
    assert.throws(
      () => addMem.parameters.parse({
        content: 'x', scope: 'invalid', project: 'p', citations: 'a', reason: 'b',
      }),
      /invalid|enum/i,
    );
  } finally {
    await cleanup();
    rmSync(personalDir, { recursive: true, force: true });
    rmSync(teamDir, { recursive: true, force: true });
  }
});
