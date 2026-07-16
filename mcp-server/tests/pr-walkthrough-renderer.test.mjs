// pr-walkthrough-renderer.test.mjs — jsdom unit tests for
// src/renderers/pr-walkthrough.mjs.
//
// The renderer does top-level `import mermaid from 'https://esm.sh/...'`
// and `import hljs from 'https://esm.sh/...'`. Node won't resolve those
// without `--experimental-network-imports` and we don't want tests to
// touch the network, so we install a module-resolution hook (inline as
// a data: URL) that short-circuits any esm.sh specifier to a tiny stub
// module exposing the surfaces the renderer touches: mermaid.initialize,
// mermaid.render, hljs.highlight.

import { register } from 'node:module';

const STUB_MOD_SRC = `
  const stub = {
    initialize: () => {},
    render: async (id, src) => ({ svg: '<svg data-stub="mermaid"></svg>' }),
    highlight: (code) => ({ value: String(code ?? '') }),
  };
  export default stub;
`;
const STUB_MOD_URL =
  'data:text/javascript;base64,' + Buffer.from(STUB_MOD_SRC).toString('base64');

const LOADER_SRC = `
  const STUB = ${JSON.stringify(STUB_MOD_URL)};
  export async function resolve(specifier, context, nextResolve) {
    if (typeof specifier === 'string' && specifier.startsWith('https://esm.sh/')) {
      return { url: STUB, shortCircuit: true, format: 'module' };
    }
    return nextResolve(specifier, context);
  }
`;
register(
  'data:text/javascript;base64,' + Buffer.from(LOADER_SRC).toString('base64'),
  import.meta.url,
);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// =============================================================================
// Sample walkthrough fixture
// =============================================================================
const SAMPLE_WT = {
  pr: {
    id: 12345,
    title: 'Test PR',
    sourceBranch: 'feat/x', targetBranch: 'main',
    filesChanged: 3, additions: 10, deletions: 2,
    iteration: 1,
  },
  verdict: {
    recommendation: 'APPROVE',
    oneLiner: 'looks good',
    confidence: 'high',
    reviewedBy: ['agent-x', 'human (author)'],
    agentNotes: ['Verified X', 'Verified Y'],
  },
  confidence: {
    risk:      { grade: 'good',    headline: 'Low',    claim: 'no concerns',     anchorStep: 1 },
    tests:     { grade: 'good',    headline: 'Strong', claim: 'all branches',    anchorStep: 1 },
    rollback:  { grade: 'good',    headline: 'Safe',   claim: 'flag-gated',      anchorStep: 1 },
    publicApi: { grade: 'good',    headline: 'None',   claim: 'internal only',   anchorStep: 1 },
    perf:      { grade: 'caution', headline: 'Medium', claim: 'one extra call',  anchorStep: 1 },
    deploy:    { grade: 'good',    headline: 'Safe',   claim: 'kill-switch',     anchorStep: 1 },
  },
  tldr: 'a test PR',
  whatToLookAt: [
    { stepN: 1, priority: 'high',   timeBudget: '90s', claim: 'critical path' },
    { stepN: 1, priority: 'low',    timeBudget: '20s', claim: 'minor cleanup' },
    { stepN: 1, priority: 'skip',   timeBudget: '0s',  claim: 'mechanical' },
  ],
  faq: [
    { q: 'why approach X?',         a: 'because Y', anchorStep: 1 },
    { q: 'what about failure Z?',   a: 'handled by W' },
  ],
  disqualifiers: [
    { id: 'd1', severity: 'block', text: 'flag defaults to true', howToCheck: 'grep',  agentVerified: true },
    { id: 'd2', severity: 'major', text: 'no telemetry',          howToCheck: 'look',  agentVerified: true },
    { id: 'd3', severity: 'minor', text: 'doc gap',               howToCheck: 'check', agentVerified: false },
  ],
  summary: [
    { label: 'Impact',                       text: 'impact text' },
    { label: 'Risk',                         text: 'risk text' },
    { label: 'Test coverage',                text: 'test text' },
    { label: 'Dependency changes',           text: 'dep text' },
    { label: 'Perf concerns',                text: 'perf text' },
    { label: 'Safe deployment / Rollback',   text: 'sd text' },
  ],
  architecture: 'flowchart LR\n  A --> B',
  fileStats: [
    { path: 'src/a.ts', additions: 5, deletions: 1, stepIdx: 0 },
    { path: 'src/b.ts', additions: 5, deletions: 1, stepIdx: 0 },
  ],
  steps: [{
    n: 1, title: 'step one',
    file: 'src/a.ts', fileSafe: 'src__a.ts', fileLang: 'typescript',
    isNewFile: false, kind: 'change',
    badges: ['logic'], why: 'why text',
    diagram: null, timeBudget: '90s',
    focusNewLine: null, relatedFiles: null,
    diffUrl: 'diff__src__a.ts.patch',
    originalUrl: 'original__src__a.ts.txt',
    modifiedUrl: 'modified__src__a.ts.txt',
  }],
};

// =============================================================================
// Shared test setup — wire up JSDOM, stub fetch, dynamic-import the renderer
// =============================================================================
async function loadRenderer({ wt = SAMPLE_WT, files = {} } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
    { url: 'http://localhost/', pretendToBeVisual: true },
  );

  // Wire up jsdom globals so the renderer can use document.*, etc.
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.requestAnimationFrame =
    dom.window.requestAnimationFrame?.bind(dom.window) ?? ((cb) => setTimeout(cb, 0));
  // Node 22 exposes a read-only `navigator` global, so we must use
  // defineProperty (with configurable: true) to override it.
  Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });

  // Stub fetch: the renderer hits /artifact/<id>/qa/step-*.json on submit,
  // /artifact/<id>/session for dispatch, /dispatch and /spawn for the
  // actual agent prompt. Test bodies only render, so we return safe defaults.
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/qa/step-')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  // Dynamic-import the renderer. The loader hook registered at the top of
  // this file swaps any https://esm.sh/* specifier with a stub module, so
  // this works offline.
  const mod = await import('../src/renderers/pr-walkthrough.mjs');

  const root = document.createElement('div');
  document.body.appendChild(root);
  const ctx = {
    artifactId: 'test-art',
    manifest: { id: 'test-art', type: 'pr-walkthrough', title: 'Test' },
    fetchFile: async (name) => files[name] ?? '',
    fetchFileJson: async (name) =>
      name === 'walkthrough.json' ? wt : (files[name] ?? {}),
    listFiles: async () => Object.keys(files),
  };
  await mod.default.render(root, ctx);
  // Mermaid render is async — wait a tick for the inner promise to flush.
  await new Promise((r) => setTimeout(r, 50));
  return { root, ctx, dom };
}

// =============================================================================
// The 9 tests
// =============================================================================
test('renderer renders verdict bar with APPROVE recommendation', async () => {
  const { root } = await loadRenderer();
  assert.match(root.querySelector('#verdict-rec').textContent, /APPROVE/);
  assert.equal(root.querySelector('#verdict-icon').textContent, '✅');
  assert.match(root.querySelector('#verdict-conf').textContent, /high/);
});

test('renderer renders 6 confidence gauges with correct grades', async () => {
  const { root } = await loadRenderer();
  const gauges = root.querySelectorAll('.conf-gauge');
  assert.equal(gauges.length, 6);
  const cautionCount = root.querySelectorAll('.conf-gauge.grade-caution').length;
  const goodCount = root.querySelectorAll('.conf-gauge.grade-good').length;
  assert.equal(cautionCount, 1);
  assert.equal(goodCount, 5);
});

test('renderer renders attention list with priority + time budgets', async () => {
  const { root } = await loadRenderer();
  const items = root.querySelectorAll('.att-item');
  assert.equal(items.length, 3);
  assert.ok(root.querySelector('.att-item.priority-high'));
  assert.ok(root.querySelector('.att-item.priority-low'));
  assert.ok(root.querySelector('.att-item.priority-skip'));
});

test('renderer renders disqualifiers with verified marks', async () => {
  const { root } = await loadRenderer();
  const items = root.querySelectorAll('.disq-item');
  assert.equal(items.length, 3);
  const verified = root.querySelectorAll('.verified').length;
  const unverified = root.querySelectorAll('.unverified').length;
  assert.equal(verified, 2);
  assert.equal(unverified, 1);
});

test('renderer renders FAQ as collapsible details elements', async () => {
  const { root } = await loadRenderer();
  const items = root.querySelectorAll('.faq-item');
  assert.equal(items.length, 2);
  // Only the first FAQ entry has an anchorStep, so we expect exactly one
  // anchor button to be rendered.
  const anchored = root.querySelectorAll('.faq-anchor');
  assert.equal(anchored.length, 1);
});

test('renderer renders 6-bullet summary with proper section labels', async () => {
  const { root } = await loadRenderer();
  const bullets = root.querySelectorAll('#bullets li');
  assert.equal(bullets.length, 6);
  assert.ok(root.querySelector('#bullets li.sdp'));
  assert.ok(root.querySelector('#bullets li.risk'));
});

test('renderer renders file tree with step-chip', async () => {
  const { root } = await loadRenderer();
  // 2 files, both assigned to step 0 → 1 step-chip + 1 file row visible
  // (the second file folds into the group because of the seenStep guard).
  assert.ok(root.querySelector('.file-tree'));
  assert.ok(root.querySelector('.step-chip'));
});

test('renderer renders step list with time-budgets', async () => {
  const { root } = await loadRenderer();
  // Step list lives inside #stepmode which is rendered up-front. Steps are
  // populated when setMode('step') runs — which we trigger by clicking the
  // overview's "Start step-by-step walkthrough" button.
  root.querySelector('#enter-stepmode').click();
  await new Promise((r) => setTimeout(r, 50));
  const stepEntries = root.querySelectorAll('.steps li');
  assert.equal(stepEntries.length, 1);
  assert.match(stepEntries[0].textContent, /90s/);
});

test('renderer Q&A form is present and wired', async () => {
  const { root } = await loadRenderer();
  // Click "Start step-by-step walkthrough" to enter step mode where the
  // Q&A form is the active rail tab.
  root.querySelector('#enter-stepmode').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(root.querySelector('#qa-form'));
  assert.ok(root.querySelector('#qa-input'));
  assert.ok(root.querySelector('.qa-thread'));
});
