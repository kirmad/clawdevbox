/**
 * work-item-tools.test.mjs
 *
 * Pure-function unit tests for the 7 new ADO work-item / PR-creation
 * hostable tools added under plugins/ado/tools/:
 *   - ado.get_work_item
 *   - ado.list_work_items
 *   - ado.list_work_item_comments
 *   - ado.add_work_item_comment
 *   - ado.update_work_item
 *   - ado.create_pr
 *   - ado.get_work_item_updates
 *
 * Each tool gets: shape check, good-args parse, bad-args parse,
 * execute() against a stubbed fetch (asserting URL + headers + body),
 * and an error path where applicable.
 *
 *   node --test tests/work-item-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const adoPluginRoot = resolve(projectRoot, '..', 'plugins', 'ado');

// Mirror hosted-tools.test.mjs: junction node_modules so plugin tools
// can resolve `zod` from the server's node_modules walk-up.
{
  const adoNodeModules = join(adoPluginRoot, 'node_modules');
  if (!existsSync(adoNodeModules)) {
    const linkType = platform() === 'win32' ? 'junction' : 'dir';
    try {
      symlinkSync(resolve(projectRoot, 'node_modules'), adoNodeModules, linkType);
    } catch {
      // EPERM on Windows without dev-mode; pure-function tests below will
      // surface a clearer module-not-found message.
    }
  }
}

function loadTool(file) {
  return import(pathToFileURL(resolve(adoPluginRoot, 'tools', file)).href);
}

function makeFakeCtx(fetchImpl, env = {}) {
  return {
    env: { ADO_ORG: 'fake-org', ADO_PROJECT: 'FakeProj', ADO_BEARER_TOKEN: 'fake-token', ...env },
    workspace: {
      project_dir: '/tmp/p',
      plugin_dir: '/tmp/g/plugins/ado',
      plugin_data_dir: '/tmp/p/.clawdevbox/data/ado',
    },
    fetch: fetchImpl,
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ----------------------------------------------------------------------------
// ado.get_work_item
// ----------------------------------------------------------------------------

test('ado.get_work_item', async (t) => {
  const mod = await loadTool('get_work_item.ts');

  await t.test('exports the expected shape', () => {
    assert.equal(mod.id, 'ado.get_work_item');
    assert.equal(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.equal(typeof mod.parameters.parse, 'function');
    assert.equal(typeof mod.default, 'function');
  });

  await t.test('parameters validates good + bad args', () => {
    assert.equal(mod.parameters.parse({ id: 42 }).id, 42);
    // `fields` is the only optional flag exposed; relations are always expanded.
    assert.ok(mod.parameters.parse({ id: 42, fields: ['System.Title'] }));
    assert.throws(() => mod.parameters.parse({}), /id/i);
    assert.throws(() => mod.parameters.parse({ id: -1 }), /id|positive|too_small/i);
  });

  await t.test('execute calls the WI endpoint with bearer auth', async () => {
    let calledUrl = '';
    let calledHeaders = {};
    const fakeCtx = makeFakeCtx(async (url, init) => {
      calledUrl = String(url);
      calledHeaders = Object.fromEntries(new Headers(init?.headers ?? {}));
      return jsonResponse({
        id: 42,
        rev: 3,
        url: 'https://x',
        fields: {
          'System.Id': 42,
          'System.WorkItemType': 'Bug',
          'System.State': 'Active',
          'System.Title': 'fake bug',
          'System.AreaPath': 'P\\A',
          'System.Tags': 'red; urgent',
          'System.AssignedTo': { displayName: 'Tester', uniqueName: 't@x' },
        },
        relations: [],
      });
    });
    const out = await mod.default({ id: 42 }, fakeCtx);
    assert.equal(out.workItem.id, 42);
    assert.equal(out.workItem.title, 'fake bug');
    assert.deepEqual(out.workItem.tags, ['red', 'urgent']);
    assert.match(calledUrl, /\/_apis\/wit\/workitems\/42/i);
    assert.match(calledUrl, /api-version=7\.1/);
    assert.match(calledUrl, /\$expand=relations/i);
    assert.equal(calledHeaders.authorization ?? calledHeaders.Authorization, 'Bearer fake-token');
  });

  await t.test('throws AdoConfigError when ADO_ORG missing', async () => {
    const fakeCtx = makeFakeCtx(async () => { throw new Error('no fetch'); }, { ADO_ORG: '' });
    await assert.rejects(mod.default({ id: 1 }, fakeCtx), /ADO_ORG missing/);
  });
});

// ----------------------------------------------------------------------------
// ado.list_work_items
// ----------------------------------------------------------------------------

test('ado.list_work_items', async (t) => {
  const mod = await loadTool('list_work_items.ts');

  await t.test('exports the expected shape', () => {
    assert.equal(mod.id, 'ado.list_work_items');
    assert.equal(typeof mod.parameters.parse, 'function');
    assert.equal(typeof mod.default, 'function');
  });

  await t.test('parameters accepts either raw wiql or filter, rejects both', () => {
    assert.ok(mod.parameters.parse({ wiql: 'SELECT [System.Id] FROM WorkItems' }));
    assert.ok(mod.parameters.parse({ filter: { assigned_to: '@me' } }));
    assert.throws(() => mod.parameters.parse({}), /wiql|filter/i);
  });

  await t.test('execute composes WIQL from filter and batches results', async () => {
    let wiqlBody = null;
    let batchBody = null;
    const fakeCtx = makeFakeCtx(async (url, init) => {
      const u = String(url);
      if (u.includes('/_apis/wit/wiql')) {
        wiqlBody = JSON.parse(init.body);
        return jsonResponse({ workItems: [{ id: 1 }, { id: 2 }] });
      }
      if (u.includes('/_apis/wit/workitemsbatch')) {
        batchBody = JSON.parse(init.body);
        return jsonResponse({
          value: [
            { id: 1, fields: { 'System.Id': 1, 'System.Title': 'a', 'System.WorkItemType': 'Bug', 'System.State': 'Open' } },
            { id: 2, fields: { 'System.Id': 2, 'System.Title': 'b', 'System.WorkItemType': 'Task', 'System.State': 'New' } },
          ],
        });
      }
      throw new Error('unexpected url ' + u);
    });
    const out = await mod.default(
      { filter: { assigned_to: '@me', states: ['Open', 'New'], types: ['Bug', 'Task'] } },
      fakeCtx,
    );
    assert.equal(out.workItems.length, 2);
    assert.match(wiqlBody.query, /\[System\.AssignedTo\] = @Me/);
    assert.match(wiqlBody.query, /\[System\.State\] IN \('Open', 'New'\)/);
    assert.deepEqual(batchBody.ids, [1, 2]);
  });
});

// ----------------------------------------------------------------------------
// ado.list_work_item_comments
// ----------------------------------------------------------------------------

test('ado.list_work_item_comments', async (t) => {
  const mod = await loadTool('list_work_item_comments.ts');

  await t.test('shape + arg parse', () => {
    assert.equal(mod.id, 'ado.list_work_item_comments');
    assert.equal(mod.parameters.parse({ id: 7 }).id, 7);
    assert.throws(() => mod.parameters.parse({}), /id/i);
  });

  await t.test('execute uses the 7.1-preview.3 comments endpoint', async () => {
    let calledUrl = '';
    const fakeCtx = makeFakeCtx(async (url) => {
      calledUrl = String(url);
      return jsonResponse({
        count: 1,
        comments: [
          { id: 100, text: 'hello', createdBy: { displayName: 'X' }, createdDate: '2026-01-01' },
        ],
      });
    });
    const out = await mod.default({ id: 7 }, fakeCtx);
    assert.equal(out.count, 1);
    assert.equal(out.comments[0].id, 100);
    assert.match(calledUrl, /\/_apis\/wit\/workItems\/7\/comments/i);
    assert.match(calledUrl, /api-version=7\.1-preview\.3/);
  });
});

// ----------------------------------------------------------------------------
// ado.add_work_item_comment
// ----------------------------------------------------------------------------

test('ado.add_work_item_comment', async (t) => {
  const mod = await loadTool('add_work_item_comment.ts');

  await t.test('shape + arg parse', () => {
    assert.equal(mod.id, 'ado.add_work_item_comment');
    assert.ok(mod.parameters.parse({ id: 1, text: 'hi' }));
    assert.throws(() => mod.parameters.parse({ id: 1 }), /text/i);
    assert.throws(() => mod.parameters.parse({ text: 'hi' }), /id/i);
  });

  await t.test('execute POSTs the comment body with bearer auth', async () => {
    let calledUrl = '';
    let calledMethod = '';
    let calledBody = '';
    let calledHeaders = {};
    const fakeCtx = makeFakeCtx(async (url, init) => {
      calledUrl = String(url);
      calledMethod = (init?.method ?? 'GET').toUpperCase();
      calledBody = String(init?.body ?? '');
      calledHeaders = Object.fromEntries(new Headers(init?.headers ?? {}));
      return jsonResponse({ id: 555, text: 'hello', createdBy: { displayName: 'X' }, createdDate: 'now' });
    });
    const out = await mod.default({ id: 7, text: 'hello' }, fakeCtx);
    assert.equal(out.commentId, 555);
    assert.match(calledUrl, /\/_apis\/wit\/workItems\/7\/comments/i);
    assert.match(calledUrl, /api-version=7\.1-preview\.3/);
    assert.equal(calledMethod, 'POST');
    assert.deepEqual(JSON.parse(calledBody), { text: 'hello' });
    assert.equal(calledHeaders['content-type'], 'application/json');
    assert.equal(calledHeaders.authorization ?? calledHeaders.Authorization, 'Bearer fake-token');
  });
});

// ----------------------------------------------------------------------------
// ado.update_work_item
// ----------------------------------------------------------------------------

test('ado.update_work_item', async (t) => {
  const mod = await loadTool('update_work_item.ts');

  await t.test('shape + parse', () => {
    assert.equal(mod.id, 'ado.update_work_item');
    assert.ok(mod.parameters.parse({ id: 1, state: 'Active' }));
    assert.ok(mod.parameters.parse({ id: 1, add_tags: ['x'] }));
    assert.throws(() => mod.parameters.parse({}), /id/i);
  });

  await t.test('rejects calls with no actual update specified', async () => {
    const fakeCtx = makeFakeCtx(async () => jsonResponse({ id: 1, rev: 1, fields: {} }));
    await assert.rejects(mod.default({ id: 1 }, fakeCtx), /No update specified/);
  });

  await t.test('state uses op:replace (regression — op:add silently no-ops on ADO)', async () => {
    let patchBody = null;
    let patchHeaders = {};
    const fakeCtx = makeFakeCtx(async (url, init) => {
      patchBody = JSON.parse(init.body);
      patchHeaders = Object.fromEntries(new Headers(init?.headers ?? {}));
      return jsonResponse({ id: 1, rev: 2, fields: { 'System.State': 'Active' } });
    });
    await mod.default({ id: 1, state: 'Active' }, fakeCtx);
    assert.equal(patchBody.length, 1);
    assert.deepEqual(patchBody[0], { op: 'replace', path: '/fields/System.State', value: 'Active' });
    assert.equal(patchHeaders['content-type'], 'application/json-patch+json');
  });

  await t.test('add_tags reads current tags then PATCHes with op:replace', async () => {
    const calls = [];
    let patchBody = null;
    const fakeCtx = makeFakeCtx(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url: String(url), method });
      if (method === 'GET') {
        return jsonResponse({ id: 1, rev: 1, fields: { 'System.Tags': 'existing' } });
      }
      patchBody = JSON.parse(init.body);
      return jsonResponse({ id: 1, rev: 2, fields: { 'System.Tags': 'existing; new1; new2' } });
    });
    await mod.default({ id: 1, add_tags: ['new1', 'new2'] }, fakeCtx);
    assert.equal(calls.filter((c) => c.method === 'GET').length, 1, 'reads tags first');
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);
    assert.equal(patchBody.length, 1);
    assert.equal(patchBody[0].op, 'replace');
    assert.equal(patchBody[0].path, '/fields/System.Tags');
    assert.equal(patchBody[0].value, 'existing; new1; new2');
  });

  await t.test('remove_tags drops only the named tags and uses op:replace', async () => {
    let patchBody = null;
    const fakeCtx = makeFakeCtx(async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        return jsonResponse({ id: 1, rev: 1, fields: { 'System.Tags': 'keep; drop; keep2' } });
      }
      patchBody = JSON.parse(init.body);
      return jsonResponse({ id: 1, rev: 2, fields: { 'System.Tags': 'keep; keep2' } });
    });
    await mod.default({ id: 1, remove_tags: ['drop'] }, fakeCtx);
    assert.equal(patchBody[0].op, 'replace');
    assert.equal(patchBody[0].value, 'keep; keep2');
  });

  await t.test('link_pr appends a relations/- add op with vstfs:// URL', async () => {
    let patchBody = null;
    const fakeCtx = makeFakeCtx(async (url, init) => {
      patchBody = JSON.parse(init.body);
      return jsonResponse({ id: 1, rev: 2, fields: {} });
    });
    await mod.default(
      { id: 1, link_pr: { project_id: 'pg', repo_id: 'rg', pr_id: 999 } },
      fakeCtx,
    );
    assert.equal(patchBody.length, 1);
    assert.equal(patchBody[0].op, 'add');
    assert.equal(patchBody[0].path, '/relations/-');
    assert.equal(patchBody[0].value.rel, 'ArtifactLink');
    assert.match(patchBody[0].value.url, /^vstfs:\/\/\/Git\/PullRequestId\/pg%2Frg%2F999$/);
  });

  await t.test('clear_assigned_to emits a /fields/System.AssignedTo remove op', async () => {
    let patchBody = null;
    const fakeCtx = makeFakeCtx(async (url, init) => {
      patchBody = JSON.parse(init.body);
      return jsonResponse({ id: 1, rev: 2, fields: {} });
    });
    await mod.default({ id: 1, clear_assigned_to: true }, fakeCtx);
    assert.deepEqual(patchBody, [{ op: 'remove', path: '/fields/System.AssignedTo' }]);
  });
});

// ----------------------------------------------------------------------------
// ado.create_pr
// ----------------------------------------------------------------------------

test('ado.create_pr', async (t) => {
  const mod = await loadTool('create_pr.ts');

  await t.test('shape + parse', () => {
    assert.equal(mod.id, 'ado.create_pr');
    assert.ok(mod.parameters.parse({
      repo: 'r', source_ref: 'feature/x', target_ref: 'main', title: 't',
    }));
    assert.throws(() => mod.parameters.parse({ repo: 'r' }), /source_ref|target_ref|title/i);
  });

  await t.test('execute POSTs to /pullrequests with refs/heads and work item refs', async () => {
    let calledUrl = '';
    let calledBody = null;
    const fakeCtx = makeFakeCtx(async (url, init) => {
      calledUrl = String(url);
      calledBody = JSON.parse(init.body);
      return jsonResponse({
        pullRequestId: 12345,
        status: 'active',
        url: 'https://x',
        sourceRefName: 'refs/heads/feature/x',
        targetRefName: 'refs/heads/main',
        isDraft: true,
        repository: { id: 'rg', project: { id: 'pg' } },
      });
    });
    const out = await mod.default(
      {
        repo: 'r',
        source_ref: 'feature/x',
        target_ref: 'main',
        title: 't',
        description: 'd',
        is_draft: true,
        work_item_refs: [4495652],
      },
      fakeCtx,
    );
    assert.equal(out.pullRequest.pullRequestId, 12345);
    assert.match(calledUrl, /\/_apis\/git\/repositories\/r\/pullrequests/);
    assert.equal(calledBody.sourceRefName, 'refs/heads/feature/x');
    assert.equal(calledBody.targetRefName, 'refs/heads/main');
    assert.equal(calledBody.isDraft, true);
    assert.deepEqual(calledBody.workItemRefs, [{ id: '4495652', url: '' }]);
  });

  await t.test('normalizes refs already in refs/heads/ form', async () => {
    let calledBody = null;
    const fakeCtx = makeFakeCtx(async (url, init) => {
      calledBody = JSON.parse(init.body);
      return jsonResponse({ pullRequestId: 1, status: 'active', url: '', sourceRefName: '', targetRefName: '', isDraft: false, repository: { id: 'rg', project: { id: 'pg' } } });
    });
    await mod.default(
      { repo: 'r', source_ref: 'refs/heads/x', target_ref: 'refs/heads/main', title: 't' },
      fakeCtx,
    );
    assert.equal(calledBody.sourceRefName, 'refs/heads/x');
    assert.equal(calledBody.targetRefName, 'refs/heads/main');
  });
});

// ----------------------------------------------------------------------------
// ado.get_work_item_updates
// ----------------------------------------------------------------------------

test('ado.get_work_item_updates', async (t) => {
  const mod = await loadTool('get_work_item_updates.ts');

  await t.test('shape + parse', () => {
    assert.equal(mod.id, 'ado.get_work_item_updates');
    assert.ok(mod.parameters.parse({ id: 1 }));
    assert.ok(mod.parameters.parse({ id: 1, max: 5 }));
    assert.throws(() => mod.parameters.parse({}), /id/i);
  });

  await t.test('execute hits the /updates endpoint and summarizes field deltas', async () => {
    let calledUrl = '';
    const fakeCtx = makeFakeCtx(async (url) => {
      calledUrl = String(url);
      return jsonResponse({
        count: 2,
        value: [
          {
            id: 1001,
            rev: 1,
            revisedBy: { displayName: 'A' },
            revisedDate: '2026-01-01',
            fields: {
              'System.State': { oldValue: null, newValue: 'New' },
            },
          },
          {
            id: 1002,
            rev: 2,
            revisedBy: { displayName: 'B' },
            revisedDate: '2026-01-02',
            fields: {
              'System.State': { oldValue: 'New', newValue: 'Active' },
            },
          },
        ],
      });
    });
    const out = await mod.default({ id: 7 }, fakeCtx);
    assert.equal(out.updates.length, 2);
    assert.equal(out.updates[1].rev, 2);
    assert.match(calledUrl, /\/_apis\/wit\/workItems\/7\/updates/i);
  });
});
