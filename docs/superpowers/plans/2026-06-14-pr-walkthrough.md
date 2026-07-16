# PR Walkthrough — Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the PR walkthrough as a first-class clawdevbox artifact type, plus the agent skill + recipe that produces one from any ADO/GitHub PR.

**Architecture:** New built-in renderer (`pr-walkthrough.mjs`) is the spike's `app.js` graduated to clawdevbox conventions. A new server endpoint persists per-step Q&A. A new agent skill (`build-pr-walkthrough`) is the authoritative guide for how an agent builds the `walkthrough.json` narrative (verdict, confidence, attention plan, FAQ, disqualifiers, steps). A new recipe (`pr-walkthrough`) is the dispatchable entry point.

**Tech Stack:** TypeScript (server), vanilla ES modules (renderer, no build step), mermaid 11.4.0, highlight.js 11.10.0, Playwright (e2e), node:test (unit), DOMPurify (XSS hardening). Reuses `_comment-overlay.mjs` and `json-doc-store.ts` shipped earlier.

**Spike reference:** `spikes/pr-walkthrough/` contains a fully working prototype with the real PR 1426766 (UIO Backfill). The renderer logic, CSS, and narrative shape are all proven there. This plan adapts that prototype to production conventions.

---

## File structure

### NEW files

| Path | Purpose |
|---|---|
| `mcp-server/src/renderers/pr-walkthrough.mjs` | The renderer. ~1500 LOC, vanilla ES module. Adapted from `spikes/pr-walkthrough/app.js`. |
| `mcp-server/src/renderers/_pr-walkthrough-styles.mjs` | CSS as a tagged-template string. Underscore-prefixed so registry skips it. |
| `mcp-server/src/qa-store.ts` | Per-artifact Q&A persistence: write+poll for `artifact/<id>/qa/step-<N>.json`. |
| `plugins/ado/skills/build-pr-walkthrough/SKILL.md` | The agent's instructions: how to cluster files into narrative steps, how to compute confidence, how to author disqualifiers + FAQ. |
| `plugins/ado/recipes/pr-walkthrough.yaml` | The recipe: orchestrates the agent through PR fetch → walkthrough authoring → artifact.add. |
| `docs/superpowers/specs/2026-06-14-pr-walkthrough-design.md` | Canonical design doc — data shape, renderer contract, Q&A protocol. |
| `mcp-server/tests/pr-walkthrough-renderer.test.mjs` | Renderer unit tests (jsdom): verdict / confidence / attention / FAQ / disqualifiers render. |
| `mcp-server/tests/pr-walkthrough-e2e.playwright.test.mjs` | E2E: overview → step mode → collapsible rail → diff render → Q&A round-trip. |
| `mcp-server/tests/qa-store.test.mjs` | Q&A store unit tests. |

### MODIFY

| Path | Change |
|---|---|
| `mcp-server/src/terminal-server.ts` | Add `GET/POST /artifact/<id>/qa/step-<N>.json` route → delegates to `qa-store.ts`. |
| `mcp-server/src/renderer-registry.ts` | No code change — `pr-walkthrough.mjs` auto-discovered. Confirm by listing. |
| `plugins/ado/skills/summarize-pr-changes/SKILL.md` | Add note pointing `build-pr-walkthrough` consumers at this skill for the 6-bullet summary section. |
| `docs/MCP-TOOLS-REFERENCE.md` | Document the new `pr-walkthrough` artifact type + the `qa/step-<N>.json` endpoint. |

### COPY (mostly verbatim from spike)

The spike already validated these. The production renderer copies the logic, then:
1. Inlines the CSS into `_pr-walkthrough-styles.mjs` (vs spike's external `styles.css`)
2. Replaces `fetch('./artifact/...')` with the production `ctx.fetchFile()` / `ctx.fetchFileJson()` pattern
3. Replaces the faked Q&A `setTimeout` with real polling against `/artifact/<id>/qa/step-<N>.json`
4. Replaces the comment-send `toast()` mock with the real `/dispatch` / `/spawn` routing (already plumbed in `_comment-overlay.mjs`)

---

## Task 1: Write the design spec

**Files:**
- Create: `docs/superpowers/specs/2026-06-14-pr-walkthrough-design.md`

- [ ] **Step 1: Write the spec**

Capture the full design from the spike, suitable for review:

```markdown
# PR Walkthrough — Design Spec

## Goal

A reviewer should be able to either gain confidence to APPROVE or catch a
blocking issue within 5 minutes of opening a PR walkthrough artifact. The
walkthrough is the deliverable of an agent that has already reviewed the PR.

## Artifact shape

`<workspace>/artifacts/pr-walkthrough-<prId>/`:
- `manifest.json` — `{ id, type: 'pr-walkthrough', title, created_at, source }`
- `walkthrough.json` — see "Narrative shape" below
- `original__<safe>.txt` — pre-PR file content, one per step file
- `modified__<safe>.txt` — post-PR file content, one per step file
- `diff__<safe>.patch` — `git show -U8` (or equivalent) unified diff
- `qa/step-<N>.json` — per-step Q&A thread (server-owned, agent appends)

`<safe>` = `path.replace(/[\\/]/g, '__')`.

## Narrative shape (walkthrough.json)

```typescript
interface Walkthrough {
  pr: PrIdentity;
  verdict: { recommendation: 'APPROVE' | 'REQUEST_CHANGES';
             oneLiner: string; confidence: 'high'|'medium'|'low';
             reviewedBy: string[]; agentNotes: string[]; };
  confidence: {
    risk: Gauge; tests: Gauge; rollback: Gauge;
    publicApi: Gauge; perf: Gauge; deploy: Gauge;
  };
  tldr: string;
  whatToLookAt: Attention[];
  faq: Faq[];
  disqualifiers: Disqualifier[];
  summary: Bullet[];          // 6 bullets, see summarize-pr-changes skill
  architecture: string;       // mermaid source
  fileStats: FileStat[];      // 1 per file in PR
  steps: Step[];
}
```

(Full sub-types in spec body.)

## Renderer contract

Implements the standard renderer contract:
- `export default { type: 'pr-walkthrough', comments: false, render(root, ctx) }`
- `comments: false` because the renderer ships its own line-anchored comment
  affordance and the universal sidebar overlay would conflict.

## Q&A protocol

1. User submits question via overlay form → POST `/artifact/<id>/qa/step-<N>.json`
2. Server writes question to disk + dispatches structured prompt to the
   recipe's live agent session via `/dispatch` (live) or `/spawn` (resume).
3. Agent receives question, writes answer back via `qa-store.appendAnswer`.
4. Renderer polls `/artifact/<id>/qa/step-<N>.json` every 3s while there's a
   pending question; stops polling once answered.

## Agent's job (per `build-pr-walkthrough` skill)

Given a PR identifier, the agent:
1. Fetches PR meta + iteration + diff
2. Clusters files into 5-10 logical narrative steps
3. For each step: writes title, why-block, picks focusNewLine, optional mermaid
4. Computes the 6 confidence gauges with evidence anchors
5. Authors verdict + agentNotes
6. Authors the 5-min attention plan (priority + time-budget per step)
7. Authors disqualifiers list (concrete failure conditions + how-to-check)
8. Authors FAQ (pre-answered questions)
9. Writes the artifact via `artifact.add`
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-14-pr-walkthrough-design.md
git commit -m "spec: PR walkthrough artifact design"
```

---

## Task 2: Build the QA store + server endpoint

**Files:**
- Create: `mcp-server/src/qa-store.ts`
- Create: `mcp-server/tests/qa-store.test.mjs`
- Modify: `mcp-server/src/terminal-server.ts` (add route)

- [ ] **Step 1: Write the failing test for `qa-store.appendQuestion`**

Create `mcp-server/tests/qa-store.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendQuestion, appendAnswer, readThread } from '../src/qa-store.ts';

test('appendQuestion writes a question with id + timestamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'));
  mkdirSync(join(dir, 'qa'), { recursive: true });
  const result = await appendQuestion({
    artifactDir: dir, stepN: 1, text: 'Why three caches?',
  });
  assert.ok(result.id.startsWith('q_'));
  assert.equal(typeof result.askedAt, 'string');
  const thread = await readThread({ artifactDir: dir, stepN: 1 });
  assert.equal(thread.length, 1);
  assert.equal(thread[0].q, 'Why three caches?');
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd mcp-server; node --test tests/qa-store.test.mjs
```

Expected: FAIL (`Cannot find module ../src/qa-store.ts`)

- [ ] **Step 3: Implement `qa-store.ts`**

```typescript
// mcp-server/src/qa-store.ts
//
// Per-artifact Q&A persistence. Each step gets its own file:
//   <artifactDir>/qa/step-<N>.json
//
// File shape: [{ id, q, askedAt, a?, ts? }, ...]
// Append-only from the API side. Server writes question; agent writes answer.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicAsync } from './fs-util.js';

export interface QaEntry {
  id: string;
  q: string;
  askedAt: string;
  a?: string;
  ts?: string;
}

function threadPath(artifactDir: string, stepN: number): string {
  return join(artifactDir, 'qa', `step-${stepN}.json`);
}

function mintId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export async function readThread(args: { artifactDir: string; stepN: number }): Promise<QaEntry[]> {
  const p = threadPath(args.artifactDir, args.stepN);
  if (!existsSync(p)) return [];
  try {
    const text = await readFile(p, 'utf8');
    return JSON.parse(text);
  } catch { return []; }
}

export async function appendQuestion(args: { artifactDir: string; stepN: number; text: string }): Promise<QaEntry> {
  await mkdir(join(args.artifactDir, 'qa'), { recursive: true });
  const thread = await readThread(args);
  const entry: QaEntry = { id: mintId('q'), q: args.text, askedAt: new Date().toISOString() };
  thread.push(entry);
  await writeFileAtomicAsync(threadPath(args.artifactDir, args.stepN), JSON.stringify(thread, null, 2));
  return entry;
}

export async function appendAnswer(args: { artifactDir: string; stepN: number; questionId: string; text: string }): Promise<void> {
  const thread = await readThread(args);
  const target = thread.find(e => e.id === args.questionId);
  if (!target) throw new Error(`question ${args.questionId} not found`);
  target.a = args.text;
  target.ts = new Date().toISOString();
  await writeFileAtomicAsync(threadPath(args.artifactDir, args.stepN), JSON.stringify(thread, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
cd mcp-server; node --test tests/qa-store.test.mjs
```

Expected: PASS

- [ ] **Step 5: Add 4 more tests** — appendAnswer, readThread missing returns [], appendAnswer throws on missing question, concurrent appends keep both.

```javascript
test('appendAnswer attaches answer to existing question', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'));
  mkdirSync(join(dir, 'qa'), { recursive: true });
  const q = await appendQuestion({ artifactDir: dir, stepN: 2, text: 'why?' });
  await appendAnswer({ artifactDir: dir, stepN: 2, questionId: q.id, text: 'because' });
  const thread = await readThread({ artifactDir: dir, stepN: 2 });
  assert.equal(thread[0].a, 'because');
  assert.ok(thread[0].ts);
});

test('readThread returns [] when file does not exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'));
  const t = await readThread({ artifactDir: dir, stepN: 99 });
  assert.deepEqual(t, []);
});

test('appendAnswer throws on missing question id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'));
  mkdirSync(join(dir, 'qa'), { recursive: true });
  await appendQuestion({ artifactDir: dir, stepN: 3, text: 'q1' });
  await assert.rejects(
    appendAnswer({ artifactDir: dir, stepN: 3, questionId: 'q_nonexistent', text: 'a' }),
    /not found/,
  );
});

test('two questions on same step preserve order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'));
  mkdirSync(join(dir, 'qa'), { recursive: true });
  await appendQuestion({ artifactDir: dir, stepN: 4, text: 'q1' });
  await appendQuestion({ artifactDir: dir, stepN: 4, text: 'q2' });
  const thread = await readThread({ artifactDir: dir, stepN: 4 });
  assert.equal(thread.length, 2);
  assert.equal(thread[0].q, 'q1');
  assert.equal(thread[1].q, 'q2');
});
```

- [ ] **Step 6: Run all qa-store tests**

```powershell
cd mcp-server; node --test tests/qa-store.test.mjs
```

Expected: 5/5 PASS

- [ ] **Step 7: Add the HTTP route to `terminal-server.ts`**

Find the existing route block where `/artifact/<id>/session` is handled. Add directly after it:

```typescript
// GET  /artifact/<id>/qa/step-<N>.json     → read the thread
// POST /artifact/<id>/qa/step-<N>.json     → append a question
//   body: { text: string }
//   On POST: also dispatches a structured prompt to the artifact's session.
const qaMatch = url.pathname.match(/^\/artifact\/([^/]+)\/qa\/step-(\d+)\.json$/);
if (qaMatch) {
  const artifactId = decodeURIComponent(qaMatch[1]);
  const stepN = Number(qaMatch[2]);
  const artifact = await readArtifactManifest(ws, artifactId);
  if (!artifact) { respond(404, 'no such artifact'); return; }
  const artifactDir = artifactPath(ws, artifactId);
  if (req.method === 'GET') {
    const thread = await readThread({ artifactDir, stepN });
    respondJson(200, thread);
    return;
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    const text = (JSON.parse(body || '{}').text || '').trim();
    if (!text) { respond(400, 'text required'); return; }
    const entry = await appendQuestion({ artifactDir, stepN, text });
    // Fire-and-forget dispatch to the live session; agent's reply
    // round-trips back via appendAnswer (the agent calls back into qa-store
    // through an MCP tool — see Task 4).
    dispatchPromptToArtifactSession(ws, artifactId, buildQaPrompt({
      artifactId, stepN, questionId: entry.id, question: text,
    })).catch(err => console.warn('[qa] dispatch failed:', err.message));
    respondJson(202, entry);
    return;
  }
  respond(405, 'method not allowed');
  return;
}
```

- [ ] **Step 8: Build + restart clawdevbox + smoke-test**

```powershell
cd mcp-server; npx tsc --noEmit
# kill the running clawdevbox process, restart per stored memory pattern
# then:
curl -s -X POST http://localhost:5201/artifact/test/qa/step-1.json -d '{"text":"test"}'
```

Expected: 202 response with `{ id, q, askedAt }`.

- [ ] **Step 9: Commit**

```bash
git add mcp-server/src/qa-store.ts mcp-server/src/terminal-server.ts mcp-server/tests/qa-store.test.mjs
git commit -m "feat(pr-walkthrough): Q&A persistence + HTTP route"
```

---

## Task 3: Port the renderer styles into a JS module

**Files:**
- Create: `mcp-server/src/renderers/_pr-walkthrough-styles.mjs`

- [ ] **Step 1: Copy spike CSS into a JS module**

The spike's `spikes/pr-walkthrough/styles.css` is the source of truth. Wrap its contents in an ES-module template literal so the renderer can inject it without a separate CSS file:

```javascript
// _pr-walkthrough-styles.mjs
// Leading underscore: registry skips this file when listing renderer types.
export const PR_WALKTHROUGH_STYLES = `
/* contents of spikes/pr-walkthrough/styles.css verbatim */
`;
```

- [ ] **Step 2: Verify the file parses + exports**

```powershell
cd mcp-server; node -e "import('./src/renderers/_pr-walkthrough-styles.mjs').then(m => console.log(m.PR_WALKTHROUGH_STYLES.length, 'chars'))"
```

Expected: prints character count (≥20000).

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/renderers/_pr-walkthrough-styles.mjs
git commit -m "feat(pr-walkthrough): styles module"
```

---

## Task 4: Build the renderer

**Files:**
- Create: `mcp-server/src/renderers/pr-walkthrough.mjs`

This is the biggest task. The spike's `spikes/pr-walkthrough/app.js` is the source of truth. The production renderer differs only in:
- Uses `ctx.fetchFile()` / `ctx.fetchFileJson()` instead of `fetch('./artifact/...')`
- Imports CSS from `./_pr-walkthrough-styles.mjs`
- Q&A goes through `POST /artifact/<id>/qa/step-<N>.json` (real persistence, not setTimeout mock)
- Polls `GET /artifact/<id>/qa/step-<N>.json` while a question is pending
- All HTML markup that lived in `index.html` is now built in JS

- [ ] **Step 1: Scaffold the renderer module + smoke render**

```javascript
// mcp-server/src/renderers/pr-walkthrough.mjs
import { PR_WALKTHROUGH_STYLES } from './_pr-walkthrough-styles.mjs';
import hljs from 'https://esm.sh/highlight.js@11.10.0';
import mermaid from 'https://esm.sh/mermaid@11.4.0';

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

export default {
  type: 'pr-walkthrough',
  // The renderer ships its own line-anchored comment affordance via the
  // line gutter 💬 button; the universal sidebar overlay would conflict.
  comments: false,
  async render(root, ctx) {
    const styleEl = document.createElement('style');
    styleEl.textContent = PR_WALKTHROUGH_STYLES;
    document.head.appendChild(styleEl);

    const wt = await ctx.fetchFileJson('walkthrough.json');
    root.innerHTML = buildShellHtml(wt);
    bootApp(root, wt, ctx);
  },
};

function buildShellHtml(wt) {
  // Returns the entire static markup tree (verdict bar, dashboard,
  // overview-grid, stepmode shell, modals, toast). Copy verbatim from
  // spikes/pr-walkthrough/index.html.
  return `<header class="topbar">…</header>
  <section class="overview" id="overview">…</section>
  <section class="stepmode hidden" id="stepmode">…</section>
  <div class="toast" id="toast" hidden></div>
  …`;
}

function bootApp(root, wt, ctx) {
  // Copy the entire spike app.js body here, replacing:
  //   - fetchArtifact(name)       →  ctx.fetchFile(name)
  //   - fetchArtifactJson(name)   →  ctx.fetchFileJson(name)
  //   - the setTimeout Q&A mock   →  real fetch/poll against /artifact/<id>/qa/*
}
```

- [ ] **Step 2: Port the verdict + confidence + attention + FAQ + disqualifiers renderers**

These are pure-data rendering functions. Copy from spike `app.js`:
- `renderVerdict`, `openAgentNotes`
- `renderConfidence`
- `renderTldr`
- `renderAttention`
- `renderDisqualifiers`
- `renderFaq`
- `renderSummary`
- `renderArch`, `renderFileTree`, `fileRowHtml`

- [ ] **Step 3: Port the step mode renderers**

- `renderStepList`, `renderStepHead`
- `renderStepDiagram`
- `renderDiff`
- `parseUnifiedPatch`, `renderHunks`, `pairDelAdd`, `computeWordDiff`, `lcsDiff`, `renderRow`

- [ ] **Step 4: Replace Q&A mock with real backend**

Replace the spike's `setTimeout`-driven fake answer with real polling:

```javascript
async function submitQuestion(text) {
  const stepN = STEPS[active].n;
  const res = await fetch(
    `/artifact/${encodeURIComponent(ctx.artifactId)}/qa/step-${stepN}.json`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`qa post: ${res.status}`);
  const entry = await res.json();
  qaThreads[active - 1].push(entry);
  renderQA(); renderStepList();
  pollForAnswer(stepN, entry.id);
}

function pollForAnswer(stepN, questionId, attempts = 0) {
  if (attempts > 60) return;   // 3 minutes max
  setTimeout(async () => {
    try {
      const r = await fetch(`/artifact/${encodeURIComponent(ctx.artifactId)}/qa/step-${stepN}.json`);
      const thread = await r.json();
      const matched = thread.find(e => e.id === questionId);
      if (matched?.a) {
        // Update the local thread + re-render
        qaThreads[active - 1] = thread;
        renderQA();
        return;
      }
    } catch {}
    pollForAnswer(stepN, questionId, attempts + 1);
  }, 3000);
}
```

- [ ] **Step 5: Port the collapsible rail + nav + helpers**

- `toggleRail`, `bindRailCollapse`
- `setMode`, `setActive`, `bindNav`
- `bindArchZoom`
- `escapeHtml`, `md`, `truncate`, `mintId`, `toast`

- [ ] **Step 6: Smoke-test the renderer via demo artifact**

```powershell
# Build a tiny test artifact mirroring the spike's shape
node -e "
  // ... write a minimal walkthrough.json + 1 diff file + 1 original/modified
"
# Start clawdevbox, open http://localhost:5201/artifact/test-pr-walkthrough
```

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/renderers/pr-walkthrough.mjs
git commit -m "feat(pr-walkthrough): renderer"
```

---

## Task 5: Renderer unit tests (jsdom)

**Files:**
- Create: `mcp-server/tests/pr-walkthrough-renderer.test.mjs`

- [ ] **Step 1: Write tests covering each major section**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function loadRenderer() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { url: 'http://localhost/', pretendToBeVisual: true });
  global.window = dom.window; global.document = dom.window.document;
  global.fetch = async () => ({ ok: true, json: async () => [] });
  const mod = await import('../src/renderers/pr-walkthrough.mjs');
  return { renderer: mod.default, dom };
}

const SAMPLE_WT = {
  pr: { id: 1, title: 'Test PR', sourceBranch: 'a', targetBranch: 'b',
        filesChanged: 3, additions: 10, deletions: 2, iteration: 1 },
  verdict: { recommendation: 'APPROVE', oneLiner: 'lgtm',
             confidence: 'high', reviewedBy: ['agent'], agentNotes: ['x'] },
  confidence: {
    risk: { grade: 'good', headline: 'Low', claim: 'no concerns', anchorStep: 1 },
    tests: { grade: 'good', headline: 'OK', claim: '', anchorStep: 1 },
    rollback: { grade: 'good', headline: 'Safe', claim: '', anchorStep: 1 },
    publicApi: { grade: 'good', headline: 'None', claim: '', anchorStep: 1 },
    perf: { grade: 'good', headline: 'OK', claim: '', anchorStep: 1 },
    deploy: { grade: 'good', headline: 'Safe', claim: '', anchorStep: 1 },
  },
  tldr: 'a test PR',
  whatToLookAt: [{ stepN: 1, priority: 'high', timeBudget: '30s', claim: 'look here' }],
  faq: [{ q: 'why?', a: 'because', anchorStep: 1 }],
  disqualifiers: [{ id: 'x', severity: 'block', text: 'bad', howToCheck: 'check this', agentVerified: true }],
  summary: [
    { label: 'Impact', text: 'impact text' },
    { label: 'Risk', text: 'risk text' },
    { label: 'Test coverage', text: 't' },
    { label: 'Dependency changes', text: 'd' },
    { label: 'Perf concerns', text: 'p' },
    { label: 'Safe deployment / Rollback', text: 'sd' },
  ],
  architecture: 'flowchart LR\nA --> B',
  fileStats: [{ path: 'src/a.ts', additions: 5, deletions: 1, stepIdx: 0 }],
  steps: [{ n: 1, title: 'step 1', file: 'src/a.ts', fileSafe: 'src__a.ts',
            fileLang: 'typescript', isNewFile: false, kind: 'change',
            badges: [], why: 'why text', diagram: null, timeBudget: '30s',
            focusNewLine: null, diffUrl: 'diff__src__a.ts.patch',
            originalUrl: 'original__src__a.ts.txt', modifiedUrl: 'modified__src__a.ts.txt' }],
};

test('renderer renders verdict bar with APPROVE', async () => {
  const { renderer } = await loadRenderer();
  const root = document.createElement('div');
  const ctx = { artifactId: 'test', manifest: {},
    fetchFile: async () => '', fetchFileJson: async () => SAMPLE_WT };
  await renderer.render(root, ctx);
  assert.match(root.querySelector('#verdict-rec').textContent, /APPROVE/);
});

test('renderer renders 6 confidence gauges', async () => { … });
test('renderer renders attention list with priority badges', async () => { … });
test('renderer renders disqualifiers with verified marks', async () => { … });
test('renderer renders FAQ details', async () => { … });
test('renderer renders the 6-bullet summary', async () => { … });
test('renderer renders file tree', async () => { … });
test('clicking confidence gauge switches to step mode', async () => { … });
test('rail collapse hides .right, shows strip', async () => { … });
```

- [ ] **Step 2: Run tests**

```powershell
cd mcp-server; node --test tests/pr-walkthrough-renderer.test.mjs
```

Expected: 9/9 PASS

- [ ] **Step 3: Commit**

```bash
git add mcp-server/tests/pr-walkthrough-renderer.test.mjs
git commit -m "test(pr-walkthrough): renderer unit tests"
```

---

## Task 6: Playwright e2e

**Files:**
- Create: `mcp-server/tests/pr-walkthrough-e2e.playwright.test.mjs`

- [ ] **Step 1: Write the e2e test**

The test should:
1. Spin up clawdevbox in a tmp workspace
2. Write a real PR walkthrough artifact (use the spike's extract output as seed data — copy `spikes/pr-walkthrough/artifact/` into the workspace)
3. Open the artifact URL in Playwright
4. Assert each surface renders (verdict, dashboard, attention, FAQ, disqualifiers, summary, arch, files)
5. Click a confidence gauge → assert step mode opens
6. Submit a Q&A question → poll → assert it lands as a pending bubble
7. Collapse the rail → assert it collapses
8. Click a 💬 line gutter button → assert composer opens

```javascript
import { test, expect } from '@playwright/test';
import { startTerminalServer } from '../src/terminal-server.ts';
// ... (workspace + artifact-copy setup pattern from existing e2e tests)

test('pr-walkthrough — overview shows all 6 surfaces', async ({ page }) => {
  await page.goto(viewUrl);
  await page.waitForSelector('.verdict-bar');
  await expect(page.locator('#verdict-rec')).toContainText('APPROVE');
  await expect(page.locator('.conf-gauge')).toHaveCount(6);
  await expect(page.locator('.att-item')).toHaveCount(8);
  await expect(page.locator('.disq-item')).toHaveCount(6);
  await expect(page.locator('.faq-item')).toHaveCount(6);
  await expect(page.locator('.bullets li')).toHaveCount(6);
});

test('clicking confidence gauge jumps to step', async ({ page }) => { … });
test('Q&A submit + poll round-trip', async ({ page }) => { … });
test('rail collapse + expand', async ({ page }) => { … });
test('line gutter 💬 opens composer', async ({ page }) => { … });
```

- [ ] **Step 2: Run**

```powershell
cd mcp-server; npx playwright test tests/pr-walkthrough-e2e.playwright.test.mjs
```

Expected: 5/5 PASS

- [ ] **Step 3: Commit**

```bash
git add mcp-server/tests/pr-walkthrough-e2e.playwright.test.mjs
git commit -m "test(pr-walkthrough): e2e playwright"
```

---

## Task 7: Write the `build-pr-walkthrough` skill

**Files:**
- Create: `plugins/ado/skills/build-pr-walkthrough/SKILL.md`

- [ ] **Step 1: Write the skill**

This is the agent's instruction manual. Reuses `summarize-pr-changes` for the 6-bullet section.

```markdown
---
name: build-pr-walkthrough
description: How to assemble a PR walkthrough artifact (manifest + walkthrough.json + per-file diff/original/modified files) from any PR. The artifact powers the pr-walkthrough renderer's 5-min final-judge review experience.
triggers:
  - "pr-walkthrough recipe"
  - "build a walkthrough for PR X"
  - "user asks for an interactive PR review surface"
---

# Building a PR walkthrough artifact

The goal is an artifact a reviewer can use as the final-judge decision tool
for a PR that has already been reviewed by other agents — either gain
confidence to APPROVE or catch a blocking issue within 5 minutes.

## 1. Fetch inputs

Use the ADO MCP server:
- `ado.get_pr({ pr_id })` — meta
- `ado.get_pr_iteration({ pr_id, iteration_id: 'latest' })` — diff
- `ado.list_pr_comments({ pr_id })` — prior reviewer comments
- `ado.get_pr_work_items({ pr_id })` — linked work items

For GitHub PRs, use `gh pr view`, `gh pr diff`, `gh pr view --json files`.

## 2. Cluster files into 5-10 narrative steps

This is the only step that requires real intelligence. Rules:

- **Group by logical concept, not by directory.** New caching layer might
  touch 30 files; cluster them as: foundation (interface + base), each
  specialized cache, wiring, tests. Not as one step per file.
- **Aim for 5-10 steps.** Fewer than 5 = under-decomposed; more than 10 =
  reviewer can't budget time per step.
- **Mark batch steps** for any 10+ files getting the same edit (e.g. a flag
  rolled out across regions). Use `kind: 'batch'` + `batchPattern` regex.
- **Mark new files** with `kind: 'new-file'` so the renderer shows a NEW FILE
  badge and renders the entire file as one big add block.
- **Order by build dependency, then by importance.** Foundation first,
  specialized next, integration after, then tests + config + rollout last.

## 3. For each step, author:

- `title` — one line, includes file name
- `why` — 1-3 sentence explanation of the change's purpose (NOT a code summary)
- `focusNewLine` — pick the most important line for the renderer to scroll to
- `badges` — semantic tags (`logic`, `test`, `config`, `flighting`, `wiring`, `new-file`, …)
- `timeBudget` — your honest estimate ("30s", "60s", "90s")
- `diagram` (optional) — mermaid for steps where the conceptual delta is non-obvious from code alone (control-flow forks, before/after, multi-component touchpoints)

## 4. Compute the 6 confidence gauges

For each of `risk`, `tests`, `rollback`, `publicApi`, `perf`, `deploy`:
- `grade`: `good` | `caution` | `warn` | `crit`
- `headline`: one-word verdict (`Low`, `Medium`, `Strong`, `None`, `Excellent`)
- `claim`: one sentence of evidence (cite specifics)
- `anchorStep`: which step proves the claim — reviewer clicks to jump

Default grades:
- `risk`: `good` if no hot-path edits, `caution` if 1-3, `warn` if 4+, `crit` if any auth/persistence/public-API
- `tests`: `good` if every behavior change has a test, `caution` if some, `warn` if any major branch untested
- `rollback`: `good` if flag-gated OR code-only-revert-safe, `caution` if data-migration, `warn` if irreversible
- `publicApi`: `good` if internal only, `caution` if new field, `warn` if signature change, `crit` if removed/renamed
- `perf`: `good` if net-positive or no-op, `caution` if added ms, `warn` if added seconds, `crit` if added s on request path
- `deploy`: `good` if flag-gated, `caution` if direct deploy, `warn` if multi-step coordinated rollout, `crit` if requires migration script

## 5. Author the verdict

- `recommendation`: `APPROVE` or `REQUEST_CHANGES`
- `oneLiner`: one sentence saying why
- `confidence`: `high` | `medium` | `low` — how sure are you?
- `reviewedBy`: array of agent identifiers + 'human (author)' if author has self-reviewed
- `agentNotes`: 3-7 concrete VERIFIED claims (each starting with "Verified" or "Confirmed"). Each claim should be falsifiable — a reviewer could spot-check any one and reject your verdict if wrong.

## 6. Author the 5-min attention plan (`whatToLookAt`)

Ordered by reading priority, NOT step number. For each:
- `stepN`: which step
- `priority`: `high` | `medium` | `low` | `skip`
- `timeBudget`: how long the reviewer should spend ("90s")
- `claim`: one sentence telling the reviewer what to look at + why

Aim for total `timeBudget` ≈ 5 minutes. Be honest about `skip` — if a step
is mechanical and well-tested, say so.

## 7. Author disqualifiers (`disqualifiers`)

"What would change the reviewer's mind from APPROVE to REQUEST_CHANGES?"
Each:
- `id`: stable identifier
- `severity`: `block` | `major` | `minor`
- `text`: the failure condition in one sentence ("X defaults to true in any env")
- `howToCheck`: exact grep/command/file:line the reviewer should look at
- `agentVerified`: `true` if you confirmed the condition is NOT met. Be honest — `false` means the reviewer must verify.

Include 4-8 disqualifiers covering: config defaults, gate conditions, contract
compatibility, test coverage gaps, telemetry, failure modes.

## 8. Author FAQ (`faq`)

3-7 pre-answered questions a reviewer would ask the author. Each:
- `q`: the question
- `a`: a thorough answer with citations to the diff
- `anchorStep` (optional): if the answer is grounded in a specific step

Cover at minimum:
- "Why this approach over X?"
- "What about failure mode Y?"
- "How was this discovered / what triggered the change?"

## 9. Reuse the `summarize-pr-changes` skill for `summary`

The 6-bullet summary uses the same shape that skill specifies. Quote
backticks for identifiers. Keep each bullet to 1-3 sentences.

## 10. Materialize the artifact

For each file referenced by a step (NOT every PR file):
- Write `original__<safe>.txt` = `git show <commit>~1:<file>` (or ADO equivalent)
- Write `modified__<safe>.txt` = `git show <commit>:<file>`
- Write `diff__<safe>.patch` = `git show --no-color -U8 <commit> -- <file>`

`<safe>` = file path with `/` and `\` replaced by `__`.

Call `artifact.add` with:
```json
{
  "type": "pr-walkthrough",
  "title": "<repo> #<prId> — <prTitle>",
  "files": [
    "manifest.json", "walkthrough.json",
    "original__*.txt", "modified__*.txt", "diff__*.patch"
  ]
}
```

The returned `view_url` is what you give the user. If a recipe instance is
live, also link it via `recipe_instance_id` so the renderer's Q&A round-trip
finds the session.

## 11. Handing off to Q&A

When a reviewer asks a question via the renderer's Q&A form, the server
dispatches a structured prompt to your recipe's session:

> Question on step <N> of artifact pr-walkthrough-<prId>
> File: <path>, range: L<from>-L<to>
>
> > <user's question>

Reply by calling:
- `pr-walkthrough.answer({ artifact_id, step_n, question_id, text })`
  (MCP tool — see Task 8)

Be thorough; include code refs. The reviewer is reading your answer to
decide whether to approve. Don't gloss.
```

- [ ] **Step 2: Commit**

```bash
git add plugins/ado/skills/build-pr-walkthrough/SKILL.md
git commit -m "feat(pr-walkthrough): build-pr-walkthrough skill"
```

---

## Task 8: Add the `pr-walkthrough.answer` MCP tool

**Files:**
- Create: `mcp-server/src/tools/pr-walkthrough.ts`
- Modify: `mcp-server/src/tools/index.ts` (register the new tool)

- [ ] **Step 1: Write the tool**

```typescript
// mcp-server/src/tools/pr-walkthrough.ts
//
// MCP tool: pr-walkthrough.answer
// Used by agents to reply to a reviewer Q&A question. Server-side this
// becomes an appendAnswer call against qa-store.
import { z } from 'zod';
import { appendAnswer } from '../qa-store.js';
import { resolveArtifactDir } from '../artifact-store.js';
import type { Workspace } from '../workspace.js';

export const answerSchema = z.object({
  artifact_id: z.string(),
  step_n: z.number().int().positive(),
  question_id: z.string(),
  text: z.string().min(1),
});

export async function handleAnswer(ws: Workspace, args: z.infer<typeof answerSchema>) {
  const dir = resolveArtifactDir(ws, args.artifact_id);
  if (!dir) throw new Error(`no such artifact: ${args.artifact_id}`);
  await appendAnswer({
    artifactDir: dir,
    stepN: args.step_n,
    questionId: args.question_id,
    text: args.text,
  });
  return { ok: true };
}
```

- [ ] **Step 2: Register the tool**

Add to `mcp-server/src/tools/index.ts` (find the existing tool registrations and add):

```typescript
import { answerSchema, handleAnswer } from './pr-walkthrough.js';

// in registerTools():
server.tool('pr-walkthrough.answer',
  'Reply to a reviewer Q&A question on a PR walkthrough artifact.',
  answerSchema.shape,
  async (args) => {
    const result = await handleAnswer(ws, args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);
```

- [ ] **Step 3: Write tool tests**

```javascript
// mcp-server/tests/pr-walkthrough-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
// ... arrange: temp workspace + artifact dir + question + invoke handleAnswer
test('handleAnswer attaches answer to question', async () => { … });
test('handleAnswer throws on missing artifact', async () => { … });
test('handleAnswer throws on missing question', async () => { … });
```

- [ ] **Step 4: Run + restart clawdevbox**

```powershell
cd mcp-server; node --test tests/pr-walkthrough-tool.test.mjs; npx tsc --noEmit
# restart clawdevbox
```

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/pr-walkthrough.ts mcp-server/src/tools/index.ts mcp-server/tests/pr-walkthrough-tool.test.mjs
git commit -m "feat(pr-walkthrough): pr-walkthrough.answer MCP tool"
```

---

## Task 9: Write the `pr-walkthrough` recipe

**Files:**
- Create: `plugins/ado/recipes/pr-walkthrough.yaml`

- [ ] **Step 1: Write the recipe**

```yaml
# plugins/ado/recipes/pr-walkthrough.yaml
id: pr-walkthrough
name: "PR Walkthrough (ADO)"
description: >
  Produce an interactive PR walkthrough artifact — a 5-minute final-judge
  review surface backed by the agent's verdict, confidence dashboard,
  attention plan, disqualifiers, and pre-answered FAQ.
kind: pr_review
default_client: claude
mcp_servers:
  - ado
  - clawdevbox
timeout_minutes: 0

steps:
  - id: 1
    goal: >
      Fetch the PR via `ado.get_pr` + `ado.get_pr_iteration({iteration_id: 'latest'})`.
      Consult the `build-pr-walkthrough` skill for the full procedure. Begin
      authoring `walkthrough.json` in memory: PR identity + 5-bullet summary
      (via `summarize-pr-changes` skill).

  - id: 2
    goal: >
      Cluster the changed files into 5-10 narrative steps per `build-pr-walkthrough`
      §2. For each step author: title, why, focusNewLine, badges, timeBudget,
      optional mermaid diagram. Identify any batch steps (10+ files with the
      same edit) and any new-file steps.
    depends: [1]

  - id: 3
    goal: >
      Materialize per-step files: `original__<safe>.txt`, `modified__<safe>.txt`,
      `diff__<safe>.patch` for each step's file. Use `git show` (or ADO blob
      API) — see `build-pr-walkthrough` §10.
    depends: [2]

  - id: 4
    goal: >
      Author the verdict (recommendation + oneLiner + confidence + agentNotes),
      the 6-gauge confidence dashboard, the 5-min attention plan
      (`whatToLookAt`), the disqualifier checklist, and the pre-answered FAQ.
      Refer to `build-pr-walkthrough` §4-§8.
    depends: [3]

  - id: 5
    goal: >
      Write the artifact via `artifact.add({type: 'pr-walkthrough', ...,
      recipe_instance_id: <this run>, files: [manifest.json, walkthrough.json,
      original__*, modified__*, diff__*]})`. Take the returned `view_url`
      and `share_url` and post them as the inbox card's `agent_message`.
    depends: [4]

  - id: 6
    goal: >
      Register a long-running listener for Q&A questions on this artifact.
      Suspend the recipe; on each new question (signal from server), wake,
      compose a thorough answer per `build-pr-walkthrough` §11, call
      `pr-walkthrough.answer({artifact_id, step_n, question_id, text})`,
      re-suspend.
    depends: [5]
```

- [ ] **Step 2: Commit**

```bash
git add plugins/ado/recipes/pr-walkthrough.yaml
git commit -m "feat(pr-walkthrough): pr-walkthrough recipe"
```

---

## Task 10: Documentation + glue

**Files:**
- Modify: `docs/MCP-TOOLS-REFERENCE.md`
- Modify: `plugins/ado/skills/summarize-pr-changes/SKILL.md`

- [ ] **Step 1: Document the new artifact + tool**

Add a section to `docs/MCP-TOOLS-REFERENCE.md`:

```markdown
### `pr-walkthrough` artifact type

A 5-minute final-judge PR review surface. Built by the `pr-walkthrough`
recipe via the `build-pr-walkthrough` skill. Manifest:

`{ "type": "pr-walkthrough", "title": "...", "id": "pr-walkthrough-<prId>" }`

Folder shape: `walkthrough.json` (agent narrative) + `original__*` /
`modified__*` / `diff__*` per file + `qa/step-<N>.json` (Q&A threads).

### `pr-walkthrough.answer` MCP tool

Used by agents to reply to a reviewer Q&A question. Args:
`{ artifact_id, step_n, question_id, text }`. Server appends the answer to
`<artifactDir>/qa/step-<N>.json`; the renderer's poll picks it up within 3s.
```

- [ ] **Step 2: Cross-link from `summarize-pr-changes`**

Add to the bottom of `plugins/ado/skills/summarize-pr-changes/SKILL.md`:

```markdown
## See also

- `build-pr-walkthrough` — for the full interactive review artifact;
  consumes this skill for the 6-bullet `summary` section.
```

- [ ] **Step 3: Commit**

```bash
git add docs/ plugins/ado/skills/summarize-pr-changes/
git commit -m "docs(pr-walkthrough): reference + cross-link"
```

---

## Task 11: End-to-end real-PR validation

**Files:**
- No new files; uses existing test infrastructure

- [ ] **Step 1: Use the spike's extracted artifact as a real-PR fixture**

The spike at `spikes/pr-walkthrough/artifact/` contains a real PR (1426766)
extracted from `C:/git/ts`. Copy it into a temp workspace and serve via
the production renderer:

```powershell
# Manual smoke test in PowerShell:
$ws = "$env:TEMP\pr-walkthrough-validation"
New-Item -ItemType Directory -Force $ws | Out-Null
Copy-Item -Recurse spikes/pr-walkthrough/artifact "$ws/artifacts/pr-walkthrough-1426766"
# start clawdevbox pointed at $ws
# open http://localhost:5201/artifact/pr-walkthrough-1426766
```

Manually verify:
- Verdict bar shows APPROVE / high confidence
- All 6 confidence gauges render
- Attention list shows 8 items prioritized HIGH/MEDIUM/LOW/SKIP
- Disqualifiers show 6 items with verified marks
- FAQ shows 6 items, click-to-expand
- 6-bullet summary present
- Architecture mermaid renders
- File tree shows 5 unique step-files + collapsed "159 more" batch
- Click confidence gauge → jumps to step
- Step mode shows time-budget, why-block, mini-diagram, real git diff
- Rail collapse + expand work
- Submit a Q&A → bubble shows + poll begins

- [ ] **Step 2: Document any production-vs-spike deltas**

If any visual divergence between the spike and the production renderer, add
a release note to the spec doc. The two should be pixel-identical.

- [ ] **Step 3: Commit any tweaks discovered during validation**

```bash
git commit -am "fix(pr-walkthrough): validation tweaks"
```

---

## Task 12: Spike cleanup

**Files:**
- Modify: `spikes/pr-walkthrough/README.md`

- [ ] **Step 1: Mark the spike superseded**

Add a banner to `spikes/pr-walkthrough/README.md`:

```markdown
> **Note:** This spike has been graduated to the production renderer at
> `mcp-server/src/renderers/pr-walkthrough.mjs`. Use the production
> artifact + the `pr-walkthrough` recipe (ADO plugin) for any new work.
> Kept here as a reference for the design rationale.
```

- [ ] **Step 2: Commit**

```bash
git add spikes/pr-walkthrough/README.md
git commit -m "docs(spike): mark pr-walkthrough spike superseded"
```

---

## Verification checklist (run after all tasks)

- [ ] `cd mcp-server; npx tsc --noEmit` — 0 errors
- [ ] `cd mcp-server; node --test tests/qa-store.test.mjs tests/pr-walkthrough-renderer.test.mjs tests/pr-walkthrough-tool.test.mjs` — all pass
- [ ] `cd mcp-server; npx playwright test tests/pr-walkthrough-e2e.playwright.test.mjs` — 5/5 pass
- [ ] `cd mcp-server; npx playwright test tests/*-comments*.playwright.test.mjs` — no regressions in earlier artifact-comments work
- [ ] Manual: spike artifact rendered via production renderer at `http://localhost:5201/artifact/pr-walkthrough-1426766` matches the spike screenshot pixel-for-pixel
- [ ] Renderer registry lists `pr-walkthrough` as a builtin type
- [ ] `plugin.list_skills ado` includes `build-pr-walkthrough`
- [ ] `recipe.template.list` includes `pr-walkthrough` (ADO scope)

---

## Notes for the executor

- **Spike is the source of truth.** Don't redesign — copy the spike's
  app.js + styles.css + index.html structure into the production renderer
  and adjust only the data-source plumbing (fetch vs ctx.fetchFile, real
  Q&A backend vs mock).
- **Q&A backend uses the existing `_comment-overlay.mjs` send-to-agent
  pattern** for routing (`/dispatch` for live, `/spawn` for resume). The
  pr-walkthrough renderer's Q&A code is just a thinner version since we
  don't need DOM element capture.
- **Keep `comments: false` on the renderer** — the line-anchored 💬 inside
  the diff is our own implementation, not the universal sidebar overlay.
- **DOMPurify is needed** if we ever inject user-authored HTML — currently
  we don't (mermaid is sandboxed, agent notes are passed through `md()`
  which escapes first). Don't add it unless needed.
- **Use Opus for all subagents per user preference.**
