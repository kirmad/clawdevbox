/**
 * builtin-marketplace.test.mjs
 *
 * Tests for `src/builtin-marketplace.ts` — the bundled-marketplace
 * registration helpers (spec §6). Covers `resolveBuiltinMarketplaceSource`
 * (finds the repo-root catalog), `ensureBuiltinMarketplaceRegistered`
 * (idempotency, junction failure is WARN-only), and a smoke load of the
 * built-in marketplace via `loadMarketplace`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureBuiltinMarketplaceRegistered,
  resolveBuiltinMarketplaceSource,
} from '../src/builtin-marketplace.ts';
import { loadMarketplace } from '../src/manifest/load-marketplace.ts';
import { validatePluginManifestJson, validateMarketplaceJson } from '../src/validators.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'cdb-bm-'));
}

function makeCfg(globalDir) {
  return {
    projectDir: globalDir,
    globalDir,
    workspacesRoot: join(globalDir, 'workspaces'),
    http: { port: 0, host: '127.0.0.1', token: null },
    tunnel: { kind: 'none', name: null, allow_anonymous: false, auto_start: false },
    notifications: { enabled: false, vapid: null },
    cron: { max_concurrent: 1, dispatcher_drain_ms: 100 },
    configPath: null,
    defaultAgentCli: null,
    clientSync: { mode: 'off', discoveredPlugins: [] },
  };
}

test('resolveBuiltinMarketplaceSource: locates the repo-root .claude-plugin/marketplace.json', () => {
  const found = resolveBuiltinMarketplaceSource();
  assert.ok(found, 'expected to resolve a source path');
  const catalog = join(found, '.claude-plugin', 'marketplace.json');
  assert.ok(existsSync(catalog), `expected catalog at ${catalog}`);
});

test('ensureBuiltinMarketplaceRegistered: writes sidecar + junction, then no-ops', () => {
  const globalDir = tmpRoot();
  try {
    const cfg = makeCfg(globalDir);
    ensureBuiltinMarketplaceRegistered(cfg);
    const sidecar = join(globalDir, 'marketplaces', 'clawdevbox.json');
    const junction = join(globalDir, 'marketplaces', 'clawdevbox');
    assert.ok(existsSync(sidecar), 'sidecar should exist after first call');
    assert.ok(existsSync(junction), 'junction should exist after first call');
    const record = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(record.id, 'clawdevbox');
    assert.equal(record.kind, 'builtin');
    assert.equal(record.ref, null);
    assert.ok(record.pluginCount >= 3, `expected pluginCount >= 3, got ${record.pluginCount}`);
    const firstAddedAt = record.addedAt;

    // Second call: idempotent — sidecar's addedAt timestamp should not change.
    ensureBuiltinMarketplaceRegistered(cfg);
    const recordAgain = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(recordAgain.addedAt, firstAddedAt, 'sidecar should not be rewritten on idempotent re-call');
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test('ensureBuiltinMarketplaceRegistered: junction failure is WARN-only (no throw)', () => {
  // Pre-create the junction PATH as a real directory so the symlink call
  // fails with EEXIST. The sidecar should still not be written.
  const globalDir = tmpRoot();
  try {
    mkdirSync(join(globalDir, 'marketplaces', 'clawdevbox'), { recursive: true });
    const cfg = makeCfg(globalDir);
    assert.doesNotThrow(() => ensureBuiltinMarketplaceRegistered(cfg));
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test('loadMarketplace(repoRoot): parses the bundled marketplace + 3 plugins with install_tier', async () => {
  const r = await loadMarketplace(repoRoot);
  assert.equal(r.marketplaceId, 'clawdevbox');
  assert.equal(r.plugins.length, 3);
  const byName = Object.fromEntries(r.plugins.map((p) => [p.name, p]));
  assert.ok(byName['clawdevbox-mcp']);
  assert.ok(byName['dev-buddy']);
  assert.ok(byName['ado']);
});

test('built-in marketplace.json passes validateMarketplaceJson', () => {
  const parsed = JSON.parse(
    readFileSync(join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8'),
  );
  const errs = validateMarketplaceJson(parsed);
  assert.deepEqual(errs, [], `expected no validation errors, got: ${JSON.stringify(errs)}`);
});

test('each built-in plugin.json passes validatePluginManifestJson', () => {
  for (const name of ['clawdevbox-mcp', 'dev-buddy', 'ado']) {
    const p = join(repoRoot, 'plugins', name, '.claude-plugin', 'plugin.json');
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    const errs = validatePluginManifestJson(parsed);
    assert.deepEqual(errs, [], `plugin '${name}' had validation errors: ${JSON.stringify(errs)}`);
  }
});

test('dev-buddy SKILL.md has correct YAML frontmatter (name: Dev Buddy)', () => {
  const text = readFileSync(
    join(repoRoot, 'plugins', 'dev-buddy', 'skills', 'dev-buddy', 'SKILL.md'),
    'utf8',
  );
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, 'expected YAML frontmatter');
  const fm = match[1];
  assert.ok(/^id:\s*dev-buddy/m.test(fm), 'frontmatter must declare id: dev-buddy');
  assert.ok(/^name:\s*Dev Buddy/m.test(fm), 'frontmatter must declare name: Dev Buddy');
  // Key prose line from the opening playbook.
  assert.ok(text.includes('When the conversation starts (or the user types `/catchup`)'));
  assert.ok(text.includes('`recipe.run({ id, prompt, params })`'));
});
