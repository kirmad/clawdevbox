/**
 * manifest-load.test.mjs
 *
 * Tests for `src/manifest/load-plugin.ts`. Exercises both explicit paths
 * (manifest declares `skills`, `agents`, etc.) and Claude-convention
 * auto-discovery (spec §3.6), plus error / warn paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginFromDir, LoadPluginError } from '../src/manifest/load-plugin.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function mkPlugin(manifest, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdb-plg-load-'));
  if (manifest !== null) {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
      'utf8',
    );
  }
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function skillSource(name, body = 'body') {
  return `---\nname: ${name}\ndescription: a skill\n---\n${body}\n`;
}

test('loadPluginFromDir: missing manifest throws MISSING_MANIFEST', async () => {
  const dir = mkPlugin(null);
  try {
    await assert.rejects(
      () => loadPluginFromDir(dir),
      (err) => err instanceof LoadPluginError && err.code === 'MISSING_MANIFEST',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: malformed JSON throws INVALID_MANIFEST_JSON', async () => {
  const dir = mkPlugin('{ not json');
  try {
    await assert.rejects(
      () => loadPluginFromDir(dir),
      (err) => err instanceof LoadPluginError && err.code === 'INVALID_MANIFEST_JSON',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: schema-invalid manifest throws INVALID_MANIFEST_SHAPE', async () => {
  const dir = mkPlugin({ /* missing name */ version: '1.0.0' });
  try {
    await assert.rejects(
      () => loadPluginFromDir(dir),
      (err) =>
        err instanceof LoadPluginError &&
        err.code === 'INVALID_MANIFEST_SHAPE' &&
        Array.isArray(err.validationErrors) &&
        err.validationErrors.length > 0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: minimal manifest loads with empty capabilities', async () => {
  const dir = mkPlugin({ name: 'minimal', version: '0.1.0' });
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.manifest.name, 'minimal');
    assert.deepEqual(r.capabilities.skills, []);
    assert.deepEqual(r.capabilities.agents, []);
    assert.deepEqual(r.capabilities.commands, []);
    assert.deepEqual(r.capabilities.recipes, []);
    assert.deepEqual(r.capabilities.tools, []);
    assert.deepEqual(r.capabilities.triggerTypes, []);
    assert.deepEqual(r.capabilities.agentClis, []);
    assert.deepEqual(r.capabilities.mcpServers, {});
    assert.deepEqual(r.loadErrors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: auto-discovers skills/<id>/SKILL.md', async () => {
  const dir = mkPlugin(
    { name: 'auto-skills', version: '0.1.0' },
    {
      'skills/foo/SKILL.md': skillSource('foo'),
      'skills/bar/SKILL.md': skillSource('bar'),
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    const ids = r.capabilities.skills.map((s) => s.id).sort();
    assert.deepEqual(ids, ['bar', 'foo']);
    assert.equal(r.loadErrors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: skill name mismatch records LoadError and skips', async () => {
  const dir = mkPlugin(
    { name: 'skill-mismatch', version: '0.1.0' },
    {
      'skills/foo/SKILL.md': skillSource('not-foo'),
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.skills.length, 0);
    const err = r.loadErrors.find((e) => e.scope === 'skills');
    assert.ok(err, `expected a skills LoadError, got ${JSON.stringify(r.loadErrors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: explicit skills path is honored, default ignored', async () => {
  const dir = mkPlugin(
    { name: 'explicit-skills', version: '0.1.0', skills: './my-skills' },
    {
      'skills/ignored/SKILL.md': skillSource('ignored'),
      'my-skills/picked/SKILL.md': skillSource('picked'),
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    const ids = r.capabilities.skills.map((s) => s.id);
    assert.deepEqual(ids, ['picked']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: auto-discovers agents/*.agent.md and commands/*.md', async () => {
  const dir = mkPlugin(
    { name: 'auto-ac', version: '0.1.0' },
    {
      'agents/alpha.agent.md': '---\nname: alpha\n---\nbody',
      'agents/beta.agent.md': '---\nname: beta\n---\nbody',
      'commands/run.md': '---\ndescription: run\n---\nbody',
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    const agentIds = r.capabilities.agents.map((a) => a.id).sort();
    assert.deepEqual(agentIds, ['alpha', 'beta']);
    const cmdIds = r.capabilities.commands.map((c) => c.id);
    assert.deepEqual(cmdIds, ['run']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: auto-discovers .mcp.json (wrapper shape)', async () => {
  const dir = mkPlugin(
    { name: 'mcp-wrap', version: '0.1.0' },
    {
      '.mcp.json': JSON.stringify({
        mcpServers: {
          srv1: { command: 'node', args: ['srv.js'] },
        },
      }),
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.ok(r.capabilities.mcpServers.srv1);
    assert.equal(r.capabilities.mcpServers.srv1.command, 'node');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: auto-discovers .mcp.json (flat shape)', async () => {
  const dir = mkPlugin(
    { name: 'mcp-flat', version: '0.1.0' },
    {
      '.mcp.json': JSON.stringify({
        srv2: { command: 'python', args: ['-m', 'srv'] },
      }),
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.ok(r.capabilities.mcpServers.srv2);
    assert.equal(r.capabilities.mcpServers.srv2.command, 'python');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: inline mcpServers object is used directly', async () => {
  const dir = mkPlugin({
    name: 'mcp-inline',
    version: '0.1.0',
    mcpServers: { inline: { command: 'echo' } },
  });
  try {
    const r = await loadPluginFromDir(dir);
    assert.ok(r.capabilities.mcpServers.inline);
    assert.equal(r.capabilities.mcpServers.inline.command, 'echo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: clawdevbox.recipes/tools/trigger_types/agent_clis pass through', async () => {
  const dir = mkPlugin({
    name: 'cdb-ext',
    version: '0.1.0',
    clawdevbox: {
      recipes: [{ id: 'r1', file: 'recipes/r1.yaml' }],
      tools: [{ id: 'pkg.do_x', file: 'tools/do_x.ts', runtime: 'tsx' }],
      trigger_types: [
        {
          id: 'pkg.watch',
          file: 'triggers/watch.ts',
          parameters: [],
        },
      ],
      agent_clis: [{ id: 'mycli', module: 'mycli.mjs', display_name: 'My CLI' }],
    },
  });
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.recipes.length, 1);
    assert.equal(r.capabilities.recipes[0].id, 'r1');
    assert.ok(r.capabilities.recipes[0].absoluteFile.includes('recipes'));
    assert.equal(r.capabilities.tools[0].runtime, 'tsx');
    assert.equal(r.capabilities.triggerTypes[0].id, 'pkg.watch');
    assert.equal(r.capabilities.agentClis[0].id, 'mycli');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: valid agency.json is loaded', async () => {
  const dir = mkPlugin(
    { name: 'with-agency', version: '0.1.0' },
    { 'agency.json': JSON.stringify({ engines: ['claude', 'clawdevbox'], category: 'devops' }) },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.ok(r.agencyJson);
    assert.deepEqual(r.agencyJson.engines, ['claude', 'clawdevbox']);
    assert.equal(r.agencyJson.category, 'devops');
    assert.equal(r.loadErrors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: invalid agency.json is warn-only, plugin still loads', async () => {
  const dir = mkPlugin(
    { name: 'bad-agency', version: '0.1.0' },
    { 'agency.json': '{ broken json' },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.agencyJson, undefined);
    const err = r.loadErrors.find((e) => e.scope === 'agency');
    assert.ok(err, 'expected an agency LoadError');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: missing agency.json is fine', async () => {
  const dir = mkPlugin({ name: 'no-agency', version: '0.1.0' });
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.agencyJson, undefined);
    assert.equal(r.loadErrors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPluginFromDir: status passes through to capabilities', async () => {
  const dir = mkPlugin({
    name: 'with-status',
    version: '0.1.0',
    status: { testedWith: 'Claude 3.5', experimental: true, notes: 'beta' },
  });
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.status?.testedWith, 'Claude 3.5');
    assert.equal(r.capabilities.status?.experimental, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Auto-discovery for clawdevbox capabilities (spec 2026-05-15 addendum)
// ============================================================================

// ---- Recipes -------------------------------------------------------------

test('auto-discovery: recipes/ scanned when manifest omits clawdevbox.recipes', async () => {
  const dir = mkPlugin(
    { name: 'r-auto', version: '0.1.0' },
    { 'recipes/foo.yaml': 'id: foo\nname: Foo\nsteps: []\n' },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.recipes.length, 1);
    assert.equal(r.capabilities.recipes[0].id, 'foo');
    assert.ok(r.capabilities.recipes[0].file.endsWith('recipes/foo.yaml'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-discovery: recipes path-override string scans the given dir', async () => {
  const dir = mkPlugin(
    { name: 'r-path', version: '0.1.0', clawdevbox: { recipes: 'custom-recipes' } },
    {
      'custom-recipes/alpha.yaml': 'id: alpha\nsteps: []\n',
      'recipes/should-be-ignored.yaml': 'id: ignored\nsteps: []\n',
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.recipes.length, 1);
    assert.equal(r.capabilities.recipes[0].id, 'alpha');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-discovery: explicit clawdevbox.recipes entry array bypasses auto-scan', async () => {
  const dir = mkPlugin(
    {
      name: 'r-explicit',
      version: '0.1.0',
      clawdevbox: { recipes: [{ id: 'declared', file: 'somewhere/declared.yaml' }] },
    },
    {
      'recipes/auto-only.yaml': 'id: auto-only\nsteps: []\n',
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.recipes.length, 1);
    assert.equal(r.capabilities.recipes[0].id, 'declared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-discovery: files prefixed with _ are excluded from recipes', async () => {
  const dir = mkPlugin(
    { name: 'r-skip', version: '0.1.0' },
    {
      'recipes/keep.yaml': 'id: keep\nsteps: []\n',
      'recipes/_private.yaml': 'id: private\nsteps: []\n',
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.recipes.length, 1);
    assert.equal(r.capabilities.recipes[0].id, 'keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Tools ---------------------------------------------------------------

test('auto-discovery: tools/foo.ts → id <pluginName>.foo, runtime tsx', async () => {
  const dir = mkPlugin(
    { name: 'tplugin', version: '0.1.0' },
    { 'tools/foo.ts': 'export default async function () { return {}; }\n' },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.tools.length, 1);
    assert.equal(r.capabilities.tools[0].id, 'tplugin.foo');
    assert.equal(r.capabilities.tools[0].runtime, 'tsx');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-discovery: tools/_helper.ts excluded from auto-discovery', async () => {
  const dir = mkPlugin(
    { name: 'tplugin', version: '0.1.0' },
    {
      'tools/echo.ts': 'export default async function () { return {}; }\n',
      'tools/_helper.ts': 'export const X = 1;\n',
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.tools.length, 1);
    assert.equal(r.capabilities.tools[0].id, 'tplugin.echo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Trigger types -------------------------------------------------------

test('auto-discovery: trigger script with sidecar registers full PluginTriggerType', async () => {
  const dir = mkPlugin(
    { name: 'tt-auto', version: '0.1.0' },
    {
      'triggers/watch.ts': 'process.exit(0);\n',
      'triggers/watch.trigger.yaml':
        'description: watches\ndefault_cron: "*/5 * * * *"\nidentity_param: owner\nparameters:\n  - { name: owner, type: string, required: true }\n',
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.triggerTypes.length, 1);
    const t = r.capabilities.triggerTypes[0];
    assert.equal(t.id, 'tt-auto.watch');
    assert.equal(t.description, 'watches');
    assert.equal(t.default_cron, '*/5 * * * *');
    assert.equal(t.identity_param, 'owner');
    assert.equal(t.runtime, 'tsx');
    assert.equal(t.parameters?.[0]?.name, 'owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-discovery: trigger script without sidecar → LoadError, no entry registered', async () => {
  const dir = mkPlugin(
    { name: 'tt-miss', version: '0.1.0' },
    { 'triggers/orphan.ts': 'process.exit(0);\n' },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.triggerTypes.length, 0);
    const err = r.loadErrors.find(
      (e) => e.scope === 'trigger_types' && /no sidecar/.test(e.message),
    );
    assert.ok(err, 'expected a missing-sidecar LoadError');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-discovery: orphan trigger sidecar (no script) → LoadError', async () => {
  const dir = mkPlugin(
    { name: 'tt-orphan', version: '0.1.0' },
    { 'triggers/ghost.trigger.yaml': 'description: ghost\n' },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.triggerTypes.length, 0);
    const err = r.loadErrors.find(
      (e) => e.scope === 'trigger_types' && /no matching script/.test(e.message),
    );
    assert.ok(err, 'expected an orphan-sidecar LoadError');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Agent CLI providers -------------------------------------------------

test('auto-discovery: agent-clis/foo.mjs → entry { id: foo, module: agent-clis/foo.mjs }', async () => {
  const dir = mkPlugin(
    { name: 'ac-auto', version: '0.1.0' },
    {
      'agent-clis/myprov.mjs':
        'export default { id: "myprov", displayName: "MP", source: "builtin", async detect(){return{available:true};}, async spawnSession(){throw new Error("x");} };\n',
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.agentClis.length, 1);
    assert.equal(r.capabilities.agentClis[0].id, 'myprov');
    assert.ok(r.capabilities.agentClis[0].module.endsWith('agent-clis/myprov.mjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Renderers -----------------------------------------------------------

test('auto-discovery: renderers/custom-art.mjs → entry { type: "custom-art" }', async () => {
  const dir = mkPlugin(
    { name: 'rend-auto', version: '0.1.0' },
    { 'renderers/custom-art.mjs': 'export default function(){return "";}\n' },
  );
  try {
    const r = await loadPluginFromDir(dir);
    assert.equal(r.capabilities.renderers.length, 1);
    assert.equal(r.capabilities.renderers[0].type, 'custom-art');
    assert.ok(r.capabilities.renderers[0].absoluteFile.endsWith('custom-art.mjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Polymorphic shape coverage on one capability -----------------------

test('auto-discovery: tools field accepts string[] of mixed dirs and files', async () => {
  const dir = mkPlugin(
    {
      name: 'mixed',
      version: '0.1.0',
      clawdevbox: { tools: ['tools-a', 'tools-b/onefile.ts'] },
    },
    {
      'tools-a/echo.ts': 'export default async function(){return{};}\n',
      'tools-a/_hidden.ts': 'export const X = 1;\n',
      'tools-b/onefile.ts': 'export default async function(){return{};}\n',
    },
  );
  try {
    const r = await loadPluginFromDir(dir);
    const ids = r.capabilities.tools.map((t) => t.id).sort();
    assert.deepEqual(ids, ['mixed.echo', 'mixed.onefile']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Everything-auto-discovered fixture ---------------------------------

test('auto-discovery: minimal manifest + convention dirs discovers all five capabilities', async () => {
  const fixtureDir = join(HERE, 'fixtures', 'auto-discover-plugin');
  const r = await loadPluginFromDir(fixtureDir);
  assert.equal(r.loadErrors.length, 0, 'no load errors expected');
  assert.equal(r.capabilities.recipes.length, 1);
  assert.equal(r.capabilities.recipes[0].id, 'hello');

  assert.equal(r.capabilities.tools.length, 1);
  assert.equal(r.capabilities.tools[0].id, 'auto-test.echo');
  assert.equal(r.capabilities.tools[0].runtime, 'tsx');

  assert.equal(r.capabilities.triggerTypes.length, 1);
  assert.equal(r.capabilities.triggerTypes[0].id, 'auto-test.ping');

  assert.equal(r.capabilities.agentClis.length, 1);
  assert.equal(r.capabilities.agentClis[0].id, 'test-cli');

  assert.equal(r.capabilities.renderers.length, 1);
  assert.equal(r.capabilities.renderers[0].type, 'custom-thing');
});


