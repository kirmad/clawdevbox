/**
 * marketplace-load.test.mjs
 *
 * Tests for `src/manifest/load-marketplace.ts` — the marketplace consumer
 * (spec §4). Exercises the three catalog layouts (Claude primary,
 * GitHub-Copilot fallback, single-plugin), the marketplace-config.json
 * overlay, per-plugin agency.json sidecars, and the `filterByEngines`
 * helper used at install time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMarketplace,
  filterByEngines,
  LoadMarketplaceError,
} from '../src/manifest/load-marketplace.ts';

function write(p, body) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
}

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'cdb-mp-'));
}

function claudeMarketplace(extras = {}) {
  return {
    name: 'demo-mp',
    owner: { name: 'demo team', email: 'demo@example.com' },
    description: 'demo marketplace',
    version: '1.0.0',
    plugins: [
      {
        name: 'plug-a',
        source: './plugins/plug-a',
        description: 'plugin a',
        version: '0.1.0',
      },
      {
        name: 'plug-b',
        source: './plugins/plug-b',
      },
    ],
    ...extras,
  };
}

test('loadMarketplace: claude layout (.claude-plugin/marketplace.json) → source="claude"', async () => {
  const root = tmpRoot();
  try {
    write(join(root, '.claude-plugin', 'marketplace.json'), claudeMarketplace());
    const r = await loadMarketplace(root);
    assert.equal(r.source, 'claude');
    assert.equal(r.marketplaceId, 'demo-mp');
    assert.equal(r.metadata.name, 'demo-mp');
    assert.equal(r.metadata.description, 'demo marketplace');
    assert.equal(r.plugins.length, 2);
    assert.equal(r.plugins[0].name, 'plug-a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadMarketplace: github-copilot fallback (.github/plugin/marketplace.json)', async () => {
  const root = tmpRoot();
  try {
    write(join(root, '.github', 'plugin', 'marketplace.json'), claudeMarketplace());
    const r = await loadMarketplace(root);
    assert.equal(r.source, 'github-copilot');
    assert.equal(r.plugins.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadMarketplace: single-plugin layout (.claude-plugin/plugin.json only)', async () => {
  const root = tmpRoot();
  try {
    write(join(root, '.claude-plugin', 'plugin.json'), {
      name: 'lonely-plug',
      version: '0.0.1',
      description: 'a single plugin install',
      author: { name: 'me', email: 'me@example.com' },
    });
    const r = await loadMarketplace(root);
    assert.equal(r.source, 'single-plugin');
    assert.equal(r.marketplaceId, 'lonely-plug');
    assert.equal(r.plugins.length, 1);
    assert.equal(r.plugins[0].name, 'lonely-plug');
    assert.equal(r.plugins[0].source, './');
    assert.equal(r.metadata.owner?.name, 'me');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadMarketplace: empty root → NOT_A_MARKETPLACE', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(
      () => loadMarketplace(root),
      (err) => err instanceof LoadMarketplaceError && err.code === 'NOT_A_MARKETPLACE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadMarketplace: marketplace-config.json shared slot overrides metadata', async () => {
  const root = tmpRoot();
  try {
    write(join(root, '.claude-plugin', 'marketplace.json'), claudeMarketplace());
    write(join(root, 'marketplace-config.json'), {
      shared: {
        name: 'demo-mp',
        metadata: {
          description: 'OVERRIDDEN by shared',
          version: '9.9.9',
        },
        owner: { name: 'shared owner', email: 'shared@example.com' },
      },
    });
    const r = await loadMarketplace(root);
    assert.equal(r.metadata.description, 'OVERRIDDEN by shared');
    assert.equal(r.metadata.version, '9.9.9');
    assert.equal(r.metadata.owner?.name, 'shared owner');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadMarketplace: marketplace-config.json clawdevbox slot wins over shared', async () => {
  const root = tmpRoot();
  try {
    write(join(root, '.claude-plugin', 'marketplace.json'), claudeMarketplace());
    write(join(root, 'marketplace-config.json'), {
      shared: {
        name: 'demo-mp',
        metadata: { description: 'shared desc' },
      },
      clawdevbox: {
        metadata: { description: 'CLAWDEVBOX wins' },
      },
    });
    const r = await loadMarketplace(root);
    assert.equal(r.metadata.description, 'CLAWDEVBOX wins');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadMarketplace: per-plugin agency.json attached + category fallback', async () => {
  const root = tmpRoot();
  try {
    const mp = claudeMarketplace();
    // plug-a explicitly sets category — marketplace entry wins.
    mp.plugins[0].category = 'devtools';
    write(join(root, '.claude-plugin', 'marketplace.json'), mp);
    write(join(root, 'plugins', 'plug-a', 'agency.json'), {
      engines: ['claude', 'copilot'],
      category: 'productivity',
    });
    write(join(root, 'plugins', 'plug-b', 'agency.json'), {
      engines: ['*'],
      category: 'productivity',
    });
    const r = await loadMarketplace(root);
    const a = r.plugins.find((p) => p.name === 'plug-a');
    const b = r.plugins.find((p) => p.name === 'plug-b');
    assert.ok(a?.agencyJson);
    assert.deepEqual(a.agencyJson.engines, ['claude', 'copilot']);
    assert.equal(a.category, 'devtools', 'marketplace entry category wins');
    assert.ok(b?.agencyJson);
    assert.equal(b.category, 'productivity', 'agency.json category fills in when entry omits');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadMarketplace: malformed marketplace.json → INVALID_MARKETPLACE_JSON', async () => {
  const root = tmpRoot();
  try {
    write(join(root, '.claude-plugin', 'marketplace.json'), '{ not json');
    await assert.rejects(
      () => loadMarketplace(root),
      (err) =>
        err instanceof LoadMarketplaceError && err.code === 'INVALID_MARKETPLACE_JSON',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadMarketplace: malformed marketplace-config.json → warning, falls through', async () => {
  const root = tmpRoot();
  try {
    write(join(root, '.claude-plugin', 'marketplace.json'), claudeMarketplace());
    // shared is missing → validator rejects.
    write(join(root, 'marketplace-config.json'), { not: 'a config' });
    const r = await loadMarketplace(root);
    assert.equal(r.metadata.description, 'demo marketplace', 'falls back to marketplace.json');
    assert.ok(r.warnings.some((w) => w.includes('marketplace-config.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadMarketplace: malformed agency.json → warning, treated as missing', async () => {
  const root = tmpRoot();
  try {
    write(join(root, '.claude-plugin', 'marketplace.json'), claudeMarketplace());
    write(join(root, 'plugins', 'plug-a', 'agency.json'), '{ broken');
    const r = await loadMarketplace(root);
    const a = r.plugins.find((p) => p.name === 'plug-a');
    assert.equal(a?.agencyJson, undefined);
    assert.ok(r.warnings.some((w) => w.includes('agency.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// filterByEngines matrix
// ---------------------------------------------------------------------------

test('filterByEngines: undefined agency → include', () => {
  assert.deepEqual(filterByEngines(undefined, 'copilot'), { include: true });
});

test('filterByEngines: agency without engines → include', () => {
  assert.deepEqual(filterByEngines({ category: 'x' }, 'copilot'), { include: true });
});

test('filterByEngines: empty engines [] → exclude', () => {
  const r = filterByEngines({ engines: [] }, 'copilot');
  assert.equal(r.include, false);
  assert.match(r.reason ?? '', /explicitly disabled/);
});

test('filterByEngines: "*" matches any engine', () => {
  assert.deepEqual(filterByEngines({ engines: ['*'] }, 'copilot'), { include: true });
  assert.deepEqual(filterByEngines({ engines: ['*'] }, null), { include: true });
});

test('filterByEngines: "clawdevbox" always matches', () => {
  assert.deepEqual(filterByEngines({ engines: ['clawdevbox'] }, 'copilot'), { include: true });
  assert.deepEqual(filterByEngines({ engines: ['clawdevbox'] }, 'claude'), { include: true });
});

test('filterByEngines: configured agent-cli id match', () => {
  assert.deepEqual(filterByEngines({ engines: ['copilot'] }, 'copilot'), { include: true });
  assert.deepEqual(filterByEngines({ engines: ['claude'] }, 'claude'), { include: true });
});

test('filterByEngines: mismatched engines → exclude with reason', () => {
  const r = filterByEngines({ engines: ['claude'] }, 'copilot');
  assert.equal(r.include, false);
  assert.match(r.reason ?? '', /not compatible/);
});

test('filterByEngines: configuredAgentCli=null falls back to "copilot" in reason', () => {
  const r = filterByEngines({ engines: ['claude'] }, null);
  assert.equal(r.include, false);
  assert.match(r.reason ?? '', /copilot/);
});
