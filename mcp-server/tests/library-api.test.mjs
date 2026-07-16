/**
 * library-api.test.mjs — covers the read-only Library catalog API
 * (`GET /api/library/*`) mounted by cli/start.ts via `handleLibraryApi`.
 *
 * Mirrors api-agent-clis.test.mjs: spins up a local http.Server delegating
 * to the same handler and plants on-disk fixtures (recipe template, skill +
 * supporting file, project trigger template, and a vault with memory docs)
 * so every family is exercised end-to-end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadWorkspaceFromEnv } from '../src/workspace.ts';
import { handleLibraryApi } from '../src/cli/library-api.ts';

const TOKEN = 'library-api-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const TMP_PATHS = [];

function writeFile(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function setupWorkspace() {
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-library-api-'));
  TMP_PATHS.push(tmp);
  const project = join(tmp, 'project');
  const globalDir = join(tmp, 'global');
  const vaultDir = join(tmp, 'vault-personal');
  mkdirSync(join(project, '.clawdevbox'), { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });

  // --- Recipe template (project scope) with a small dependency graph -------
  writeFile(
    join(project, '.clawdevbox', 'recipes', 'demo-flow.yaml'),
    [
      'id: demo-flow',
      'name: Demo Flow',
      'description: A demo recipe for the Library tab.',
      'steps:',
      '  - id: setup',
      '    goal: Prepare the workspace',
      '  - id: build',
      '    goal: Build the thing',
      '    depends: [setup]',
      '    ai_instructions: Run the full build.',
      '  - id: test',
      '    goal: Test the thing',
      '    depends: [build]',
      '',
    ].join('\n'),
  );

  // --- Skill (global scope) with a supporting script -----------------------
  writeFile(
    join(globalDir, 'skills', 'demo-skill', 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: A demo skill.',
      '---',
      '# Demo Skill',
      '',
      'Body of the skill.',
      '',
    ].join('\n'),
  );
  writeFile(
    join(globalDir, 'skills', 'demo-skill', 'scripts', 'helper.mjs'),
    "export function help() { return 'ok'; }\n",
  );

  // --- Project trigger template --------------------------------------------
  writeFile(
    join(project, '.clawdevbox', 'trigger-types', 'demo-watcher', 'template.yaml'),
    [
      'id: demo-watcher',
      'file: trigger.ts',
      'runtime: tsx',
      'description: A demo trigger template.',
      'default_cron: "0 * * * *"',
      'parameters:',
      '  - name: repo',
      '    type: string',
      '    required: true',
      '    description: Repo to watch',
      '',
    ].join('\n'),
  );
  writeFile(
    join(project, '.clawdevbox', 'trigger-types', 'demo-watcher', 'trigger.ts'),
    "console.log('demo trigger ran');\n",
  );

  // --- Vault with memory docs (fact + lesson + wiki) -----------------------
  writeFile(
    join(vaultDir, 'memories', 'facts', '2026-01-01-demo-fact.md'),
    [
      '---',
      'id: demo-fact',
      'title: Demo Fact Title',
      'created: 2026-01-01T00:00:00Z',
      'created_by: tester',
      'scope: personal',
      'vault_id: personal',
      'project: test',
      'type: fact',
      'tags: [alpha, beta]',
      'category: pattern',
      'citations: "src/x.ts:1"',
      'reason: "because it matters"',
      'schema: 1',
      '---',
      'The body of the demo fact.',
      '',
    ].join('\n'),
  );
  writeFile(
    join(vaultDir, 'memories', 'lessons', '2026-01-02-demo-lesson.md'),
    [
      '---',
      'id: demo-lesson',
      'title: Demo Lesson',
      'created: 2026-01-02T00:00:00Z',
      'created_by: tester',
      'scope: personal',
      'vault_id: personal',
      'project: test',
      'type: lesson',
      'tags: [gamma]',
      'context: "when doing X"',
      'schema: 1',
      '---',
      'Always do the thing.',
      '',
    ].join('\n'),
  );
  writeFile(
    join(vaultDir, 'memories', 'wiki', 'demo-page.md'),
    [
      '---',
      'id: demo-page',
      'title: Demo Wiki Page',
      'created: 2026-01-03T00:00:00Z',
      'created_by: tester',
      'scope: personal',
      'vault_id: personal',
      'project: test',
      'type: wiki',
      'tags: []',
      'schema: 1',
      '---',
      '# Heading',
      '',
      'Wiki content.',
      '',
    ].join('\n'),
  );

  // Global config wires the vault into the chain.
  writeFile(
    join(globalDir, 'config.json'),
    JSON.stringify({ version: 1, vaults: [{ id: 'personal', path: vaultDir, kind: 'personal', remote: null }] }, null, 2),
  );

  return { project, globalDir, vaultDir };
}

async function loadWs({ project, globalDir }) {
  return loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: project,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
  });
}

async function startServer(ws, expectedToken) {
  const server = createServer(async (req, res) => {
    try {
      const handled = await handleLibraryApi(req, res, ws, expectedToken);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not handled' }));
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, port };
}

async function stopServer(server) {
  await new Promise((r) => server.close(() => r()));
}

async function get(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: AUTH });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function withServer(fn) {
  const paths = setupWorkspace();
  const ws = await loadWs(paths);
  const { server, port } = await startServer(ws, TOKEN);
  try {
    await fn({ ws, port, paths });
  } finally {
    await stopServer(server);
  }
}

// ---------------------------------------------------------------------------

test('recipes: list includes the demo recipe with step count', async () => {
  await withServer(async ({ port }) => {
    const { status, body } = await get(port, '/api/library/recipes');
    assert.equal(status, 200);
    const demo = body.items.find((r) => r.id === 'demo-flow');
    assert.ok(demo, 'demo-flow recipe must be listed');
    assert.equal(demo.scope, 'project');
    assert.equal(demo.step_count, 3);
    assert.equal(demo.name, 'Demo Flow');
  });
});

test('recipes: get returns parsed steps with dependency edges', async () => {
  await withServer(async ({ port }) => {
    const { status, body } = await get(port, '/api/library/recipes/demo-flow');
    assert.equal(status, 200);
    assert.equal(body.found, true);
    assert.equal(body.steps.length, 3);
    const build = body.steps.find((s) => s.id === 'build');
    assert.deepEqual(build.depends, ['setup']);
    assert.equal(build.has_ai_instructions, true);
    assert.ok(body.source.includes('demo-flow'));
  });
});

test('recipes: get unknown id → 404', async () => {
  await withServer(async ({ port }) => {
    const { status } = await get(port, '/api/library/recipes/does-not-exist');
    assert.equal(status, 404);
  });
});

test('security: encoded path-traversal ids are rejected (recipes + skills)', async () => {
  await withServer(async ({ port }) => {
    // %2e%2e%2f… decodes to ../../… which must NOT resolve to a file
    // outside the recipe/skill roots. Invalid ids → 404.
    const trav = '%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage';
    const rec = await get(port, `/api/library/recipes/${trav}`);
    assert.equal(rec.status, 404);
    const skill = await get(port, `/api/library/skills/${trav}`);
    assert.equal(skill.status, 404);
  });
});

test('skills: list + get returns SKILL.md body and supporting files', async () => {
  await withServer(async ({ port }) => {
    const list = await get(port, '/api/library/skills');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((s) => s.id === 'demo-skill'));

    const { status, body } = await get(port, '/api/library/skills/demo-skill');
    assert.equal(status, 200);
    assert.equal(body.scope, 'global');
    assert.ok(body.body.includes('Body of the skill.'));
    const helper = body.files.find((f) => f.rel === 'scripts/helper.mjs');
    assert.ok(helper, 'supporting script must be listed');
    assert.equal(helper.is_text, true);
    assert.ok(helper.source.includes('function help'));
    // SKILL.md itself must NOT appear in the files list.
    assert.ok(!body.files.some((f) => f.name === 'SKILL.md'));
  });
});

test('trigger-templates: list + script for the project template', async () => {
  await withServer(async ({ port }) => {
    const list = await get(port, '/api/library/trigger-templates');
    assert.equal(list.status, 200);
    const demo = list.body.items.find((t) => t.id === 'demo-watcher');
    assert.ok(demo, 'demo-watcher trigger template must be listed');
    assert.equal(demo.scope, 'project');
    assert.equal(demo.runtime, 'tsx');
    assert.equal(demo.param_count, 1);

    const script = await get(port, '/api/library/trigger-templates/demo-watcher/script');
    assert.equal(script.status, 200);
    assert.equal(script.body.found, true);
    assert.ok(script.body.source.includes('demo trigger ran'));
    assert.equal(script.body.parameters.length, 1);
    assert.equal(script.body.parameters[0].name, 'repo');
  });
});

test('trigger-templates: unknown script → 404', async () => {
  await withServer(async ({ port }) => {
    const { status } = await get(port, '/api/library/trigger-templates/nope/script');
    assert.equal(status, 404);
  });
});

test('memory: list facts + get doc with citations/reason', async () => {
  await withServer(async ({ port }) => {
    const list = await get(port, '/api/library/memory?type=fact');
    assert.equal(list.status, 200);
    const fact = list.body.items.find((m) => m.title === 'Demo Fact Title');
    assert.ok(fact, 'demo fact must be listed');
    assert.equal(fact.scope, 'personal');
    assert.deepEqual(fact.tags, ['alpha', 'beta']);
    assert.equal(fact.category, 'pattern');

    const doc = await get(port, `/api/library/memory/doc?key=${encodeURIComponent(fact.key)}`);
    assert.equal(doc.status, 200);
    assert.equal(doc.body.type, 'fact');
    assert.ok(doc.body.body.includes('body of the demo fact'));
    assert.equal(doc.body.citations, 'src/x.ts:1');
    assert.equal(doc.body.reason, 'because it matters');
  });
});

test('memory: lessons carry a numeric confidence', async () => {
  await withServer(async ({ port }) => {
    const list = await get(port, '/api/library/memory?type=lesson');
    assert.equal(list.status, 200);
    const lesson = list.body.items.find((m) => m.title === 'Demo Lesson');
    assert.ok(lesson, 'demo lesson must be listed');
    assert.equal(typeof lesson.confidence, 'number');
  });
});

test('memory: wiki list + bad type → 400', async () => {
  await withServer(async ({ port }) => {
    const wiki = await get(port, '/api/library/memory?type=wiki');
    assert.equal(wiki.status, 200);
    assert.ok(wiki.body.items.some((m) => m.title === 'Demo Wiki Page'));

    const bad = await get(port, '/api/library/memory?type=bogus');
    assert.equal(bad.status, 400);
  });
});

test('memory: unknown key → 404', async () => {
  await withServer(async ({ port }) => {
    const { status } = await get(port, '/api/library/memory/doc?key=personal::fact::nope.md');
    assert.equal(status, 404);
  });
});

test('auth: 401 without bearer, 401 with wrong bearer', async () => {
  await withServer(async ({ port }) => {
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/library/recipes`);
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/api/library/recipes`, {
      headers: { authorization: 'Bearer nope' },
    });
    assert.equal(wrong.status, 401);
  });
});

test('method: POST is rejected 405', async () => {
  await withServer(async ({ port }) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/library/recipes`, { method: 'POST', headers: AUTH });
    assert.equal(r.status, 405);
  });
});

test('non-library path is not handled (returns false)', async () => {
  await withServer(async ({ port }) => {
    // The test server responds 404 "not handled" when handleLibraryApi returns false.
    const r = await fetch(`http://127.0.0.1:${port}/api/other`, { headers: AUTH });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal(body.error, 'not handled');
  });
});

test('cleanup tmp', () => {
  for (const p of TMP_PATHS) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
