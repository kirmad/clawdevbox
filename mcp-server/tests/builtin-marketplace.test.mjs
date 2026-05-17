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

test('built-in marketplace declares the expected install_tier for each plugin', () => {
  // The init flow reads `clawdevbox.install_tier` straight off the raw
  // marketplace.json (since the resolver type drops the extension), so
  // it has to keep matching the contract: clawdevbox-mcp=required,
  // dev-buddy=recommended, ado=optional. If somebody renames or retiers
  // an entry here, the auto-install/pre-check behavior in init silently
  // shifts — this test pins the expected mapping.
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8'),
  );
  const tiers = Object.fromEntries(
    catalog.plugins.map((p) => [p.name, p.clawdevbox?.install_tier ?? null]),
  );
  assert.equal(tiers['clawdevbox-mcp'], 'required');
  assert.equal(tiers['dev-buddy'], 'recommended');
  assert.equal(tiers['ado'], 'optional');
  // Optional entries that declare required_env should still surface them
  // so init can render the "needs: …" hint.
  const ado = catalog.plugins.find((p) => p.name === 'ado');
  assert.deepEqual(ado.clawdevbox?.required_env, ['ADO_ORG', 'ADO_BEARER_TOKEN']);
});

test('dev-buddy SKILL.md has correct YAML frontmatter (name: dev-buddy)', () => {
  const text = readFileSync(
    join(repoRoot, 'plugins', 'dev-buddy', 'skills', 'dev-buddy', 'SKILL.md'),
    'utf8',
  );
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, 'expected YAML frontmatter');
  const fm = match[1];
  // Claude Code skill convention: frontmatter `name` is the canonical
  // identifier and must equal the directory name. No separate `id` field.
  assert.ok(/^name:\s*dev-buddy/m.test(fm), 'frontmatter must declare name: dev-buddy');
  // Characteristic phrases from the dev-buddy playbook. If the playbook
  // is rewritten and these phrases change, update the assertions here —
  // but the playbook MUST still cover (a) the /catchup opening flow and
  // (b) the multi-tool plan→execute→verify loop.
  assert.ok(
    /\/catchup/.test(text),
    'SKILL.md must reference the /catchup opening flow',
  );
  assert.ok(
    /Plan first|plan\s+→\s*execute|Plan\s+\(visible/i.test(text),
    'SKILL.md must describe the plan→execute discipline for substantive tasks',
  );
});

test('dev-buddy ships an agent definition', () => {
  const text = readFileSync(
    join(repoRoot, 'plugins', 'dev-buddy', 'agents', 'dev-buddy.agent.md'),
    'utf8',
  );
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, 'expected YAML frontmatter on the agent file');
  const fm = match[1];
  assert.ok(/^name:\s*dev-buddy/m.test(fm), 'agent frontmatter must declare name: dev-buddy');
  assert.ok(/^description:/m.test(fm), 'agent frontmatter must declare a description');
});

test('dev-buddy ships skills for catchup, onboard-project, run-task', () => {
  // Recipes are trigger-bound only (heartbeat-pulse, daily-standup);
  // interactive playbooks are skills. Pin the layout so a regression
  // (e.g. moving catchup back into recipes/) trips here.
  for (const skillId of ['catchup', 'onboard-project', 'run-task']) {
    const skillFile = join(
      repoRoot,
      'plugins',
      'dev-buddy',
      'skills',
      skillId,
      'SKILL.md',
    );
    const text = readFileSync(skillFile, 'utf8');
    assert.match(text, new RegExp(`^name:\\s*${skillId}`, 'm'), `${skillId} frontmatter`);
  }
});

test('dev-buddy recipes are limited to trigger-bound automation', () => {
  // If somebody adds a new recipe to dev-buddy, force a conscious
  // decision about whether it really belongs as a recipe (trigger-
  // bound) or should be a skill (interactive).
  const pluginJson = JSON.parse(
    readFileSync(
      join(repoRoot, 'plugins', 'dev-buddy', '.claude-plugin', 'plugin.json'),
      'utf8',
    ),
  );
  const recipeIds = (pluginJson.clawdevbox?.recipes ?? []).map((r) => r.id).sort();
  assert.deepEqual(recipeIds, ['daily-standup', 'heartbeat-pulse']);
});
