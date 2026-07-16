/**
 * memory-qmd.test.mjs
 *
 * Real-world tests for the qmd wrapper using a temp dbPath + temp
 * vault directory. Stays in lex mode (BM25 only) so no GGUF models
 * are loaded — works on machines without a GPU.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getStore, closeStore, registerVaultCollections, registerProjectContexts,
  searchAcrossCollections, scheduleReindex, flushReindex, decomposeDisplayPath,
  _resetStoreCache,
} from '../src/tools/memory-qmd.ts';
import { DEFAULT_MEMORY_CONFIG } from '../src/tools/memory-config.ts';

function writeMd(path, body) {
  mkdirSync(join(path, '..').replace(/[^/\\]+$/, '') || '.', { recursive: true });
  mkdirSync(path.substring(0, path.lastIndexOf(require('node:path').sep)), { recursive: true });
  writeFileSync(path, body);
}

test('decomposeDisplayPath splits type/rest (flat layout)', () => {
  assert.deepEqual(
    decomposeDisplayPath('facts/2026-06-07-x.md'),
    { type: 'fact', rest: '2026-06-07-x.md' },
  );
  assert.deepEqual(
    decomposeDisplayPath('wiki/architecture/data-flow.md'),
    { type: 'wiki', rest: 'architecture/data-flow.md' },
  );
  assert.equal(decomposeDisplayPath('bare.md'), null);
  assert.equal(decomposeDisplayPath('unknown-folder/file.md'), null);
});

test('getStore returns cached singleton; force=true rebuilds', async () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'qmd-cache-'));
  try {
    _resetStoreCache();
    const cfg = { ...DEFAULT_MEMORY_CONFIG, qmd_db_path: join(dbDir, 'a.sqlite') };
    const s1 = await getStore(cfg);
    const s2 = await getStore(cfg);
    assert.equal(s1, s2, 'same dbPath returns same instance');
    const s3 = await getStore(cfg, { force: true });
    assert.notEqual(s3, s1, 'force=true rebuilds the instance');
    await closeStore();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('registerVaultCollections + searchAcrossCollections finds a memory by keyword', async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'qmd-vault-'));
  const dbDir   = mkdtempSync(join(tmpdir(), 'qmd-db-'));
  try {
    mkdirSync(join(vaultDir, 'memories', 'clawdevbox', 'facts'), { recursive: true });
    writeFileSync(
      join(vaultDir, 'memories', 'clawdevbox', 'facts', '2026-06-07-jwt.md'),
      '---\ntitle: JWT validation\nproject: clawdevbox\ntype: fact\n---\n\n# JWT validation\n\nAlways check the exp claim before iat.\n',
    );
    mkdirSync(join(vaultDir, 'memories', 'clawdevbox', 'wiki'), { recursive: true });
    writeFileSync(
      join(vaultDir, 'memories', 'clawdevbox', 'wiki', 'overview.md'),
      '---\ntitle: Overview\nproject: clawdevbox\ntype: wiki\n---\n\n# Overview\n\nCaching strategy uses redis.\n',
    );

    _resetStoreCache();
    const cfg = { ...DEFAULT_MEMORY_CONFIG, qmd_db_path: join(dbDir, 'index.sqlite') };
    const store = await getStore(cfg, { force: true });
    const chain = [{ id: 'my-notes', path: vaultDir, kind: 'personal', remote: null }];
    await registerVaultCollections(store, chain);
    await store.update();

    const jwtHits = await searchAcrossCollections(store, {
      collections: ['my-notes'], query: 'jwt', mode: 'lex',
    });
    assert.ok(jwtHits.length >= 1, 'expected at least one hit for "jwt"');
    assert.ok(jwtHits[0].displayPath.includes('jwt'), `expected path to contain "jwt", got ${jwtHits[0].displayPath}`);

    const redisHits = await searchAcrossCollections(store, {
      collections: ['my-notes'], query: 'redis', mode: 'lex',
    });
    assert.ok(redisHits.length >= 1, 'expected at least one hit for "redis"');
    assert.ok(redisHits[0].displayPath.includes('overview'),
      `expected redis hit in overview, got ${redisHits[0].displayPath}`);

    await closeStore();
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('registerVaultCollections is idempotent', async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'qmd-vault-'));
  const dbDir   = mkdtempSync(join(tmpdir(), 'qmd-db-'));
  try {
    _resetStoreCache();
    const cfg = { ...DEFAULT_MEMORY_CONFIG, qmd_db_path: join(dbDir, 'index.sqlite') };
    const store = await getStore(cfg, { force: true });
    const chain = [{ id: 'v1', path: vaultDir, kind: 'personal', remote: null }];
    await registerVaultCollections(store, chain);
    await registerVaultCollections(store, chain); // no error
    const cols = await store.listCollections();
    assert.equal(cols.filter((c) => c.name === 'v1').length, 1);
    await closeStore();
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('registerProjectContexts adds contexts for existing project/type subtrees', async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'qmd-ctx-'));
  const dbDir   = mkdtempSync(join(tmpdir(), 'qmd-db-'));
  try {
    mkdirSync(join(vaultDir, 'memories', 'clawdevbox', 'facts'), { recursive: true });
    mkdirSync(join(vaultDir, 'memories', 'clawdevbox', 'wiki'), { recursive: true });
    // No lessons / sessions folders — they should be skipped.

    _resetStoreCache();
    const cfg = { ...DEFAULT_MEMORY_CONFIG, qmd_db_path: join(dbDir, 'i.sqlite') };
    const store = await getStore(cfg, { force: true });
    const chain = [{ id: 'v1', path: vaultDir, kind: 'team', remote: null }];
    await registerVaultCollections(store, chain);
    await registerProjectContexts(store, chain);

    const contexts = await store.listContexts();
    const v1 = contexts.filter((c) => c.collection === 'v1');
    assert.ok(v1.some((c) => c.path === '/clawdevbox/facts'),
      'expected context for /clawdevbox/facts');
    assert.ok(v1.some((c) => c.path === '/clawdevbox/wiki'),
      'expected context for /clawdevbox/wiki');
    assert.ok(!v1.some((c) => c.path === '/clawdevbox/lessons'),
      'no context for missing folder');

    await closeStore();
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('scheduleReindex + flushReindex picks up newly written files', async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'qmd-reindex-'));
  const dbDir   = mkdtempSync(join(tmpdir(), 'qmd-db-'));
  try {
    mkdirSync(join(vaultDir, 'memories', 'p', 'facts'), { recursive: true });
    writeFileSync(join(vaultDir, 'memories', 'p', 'facts', 'a.md'), '# alpha\n\nbeta.\n');

    _resetStoreCache();
    const cfg = { ...DEFAULT_MEMORY_CONFIG, qmd_db_path: join(dbDir, 'i.sqlite') };
    const store = await getStore(cfg, { force: true });
    await registerVaultCollections(store, [{ id: 'v', path: vaultDir, kind: 'personal', remote: null }]);
    await store.update();

    // Write a new file, schedule reindex, then flush to pick it up.
    writeFileSync(join(vaultDir, 'memories', 'p', 'facts', 'b.md'), '# gamma\n\ndelta.\n');
    scheduleReindex(store, 'v', cfg);
    await flushReindex(store, cfg);

    const hits = await searchAcrossCollections(store, {
      collections: ['v'], query: 'gamma', mode: 'lex',
    });
    assert.ok(hits.length >= 1, 'expected gamma to be indexed after reindex');

    await closeStore();
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});
