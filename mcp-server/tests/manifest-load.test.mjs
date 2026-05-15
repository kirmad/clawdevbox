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
import { join } from 'node:path';
import { loadPluginFromDir, LoadPluginError } from '../src/manifest/load-plugin.ts';

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
