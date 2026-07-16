# PR Walkthrough — Design

**Status:** Spec (awaiting review)
**Date:** 2026-06-14
**Owner:** @devuser
**Plan:** `docs/superpowers/plans/2026-06-14-pr-walkthrough.md`
**Spike:** `spikes/pr-walkthrough/` (real artifact for PR `ts#1426766`, commit `8b75da85`)

---

## 1. Goal

A reviewer should be able to **either gain confidence to APPROVE or catch a
blocking issue within 5 minutes** of opening a PR walkthrough artifact.

The walkthrough is the *deliverable of an agent that has already reviewed the
PR*. It is not a tutorial, not a passive diff viewer, and not a chat surface.
It is a structured, opinionated review artefact whose job is to compress an
arbitrarily large PR (the spike was 216 files / +7903 / −982) into a single
URL where the reviewer's only remaining work is the **final-judge** decision:
**APPROVE** (trust the agent's verdict and ship) or **REQUEST_CHANGES**
(the agent missed something, here is what).

The 5-minute budget is not a soft aspiration; it is the design constraint
every section answers to. The bullets, the 6-gauge dashboard, the
attention-plan time-budgets, the disqualifier checklist, the pre-answered
FAQ — each exists because one of them, by itself, must be enough to make
the call when the reviewer is short on time. The step-by-step diff mode
exists for the reviewer who wants to drill in further, but the artifact must
be useful even if it is closed before the first step is opened.

### Why this rather than the existing surfaces

The current `pr-review.mjs` renderer shows hierarchical file tree + full-file
diff + line-anchored comments — great for "I am going to review every line"
but wrong for "give me 5 minutes to ship-or-block". The current
`walkthrough.mjs` renderer is tutorial-shaped: full files with highlighted
ranges and a floating step overlay — great for code tours, wrong for review
because there is no verdict, no rollback story, no attention budget.

The PR walkthrough collapses three previously separate surfaces — the diff
viewer, the inline review comments, and PR Q&A — into one cohesive artefact
that an agent-first workflow can drive end-to-end.

## 2. Goals & non-goals

**Goals**
1. A reviewer who skims only the overview can make a confident
   APPROVE / REQUEST_CHANGES call in ≤ 5 minutes.
2. A reviewer who drills into step mode sees the same real `git show -U8`
   diff that GitHub or ADO would show — same hunks, same line numbers, same
   word-level inline highlights.
3. The artefact is a folder on disk that the renderer fetches lazily
   (`manifest.json` + `walkthrough.json` first; per-file diffs only when a
   step is opened). The renderer is otherwise a normal built-in renderer
   discovered by the existing registry.
4. The reviewer can ask the agent a question on any step, get a real
   round-trip answer back into the same surface, without leaving the URL.
5. Inline review comments anchored to specific diff lines route through the
   same `session.send` path the universal comment overlay uses, so the agent
   can pick them up as work items in the same recipe session.
6. The agent's authoring procedure (clustering files, computing gauges,
   writing verdict / FAQ / disqualifiers) is captured in a single
   discoverable skill that any future renderer or recipe can reuse.

**Non-goals (v1)**
- A separate "build a walkthrough on demand from any commit" CLI. v1 ships
  via the `pr-walkthrough` recipe; standalone CLI usage is follow-up.
- Multi-iteration diffing. v1 always shows the latest iteration's
  cumulative diff. "Show me what changed since iteration 9" is follow-up.
- Realtime collaboration. clawdevbox is single-user-on-one-machine; two
  reviewers on the same artifact is undefined.
- Editing the walkthrough from the renderer. The narrative is agent-owned
  and the renderer is read-only over it (Q&A and inline comments go *to*
  the agent, they don't mutate `walkthrough.json`).
- Auto-enabling the universal sidebar comment overlay (`_comment-overlay.mjs`).
  The renderer ships its own line-anchored 💬 affordance instead — see
  §5 for why.

## 3. Artifact shape

The artefact follows the standard clawdevbox layout: a single folder on
disk under the workspace, addressable by `id`, fronted by a `manifest.json`,
with all narrative + diff payload in sibling files.

```
<workspace>/.clawdevbox/artifacts/pr-walkthrough-<prId>/
├── manifest.json                      ← required, type='pr-walkthrough'
├── walkthrough.json                   ← the agent's narrative (see §4)
├── original__<safe>.txt               ← one per step file, pre-PR content
├── modified__<safe>.txt               ← one per step file, post-PR content
├── diff__<safe>.patch                 ← one per step file, `git show -U8`
└── qa/
    └── step-<N>.json                  ← per-step Q&A thread, server-owned
```

### 3.1 `manifest.json`

The standard clawdevbox manifest:

```json
{
  "id": "pr-walkthrough-1426766",
  "type": "pr-walkthrough",
  "title": "ts #1426766 — UIO Backfill: multi-user requests + region/AAD/processed-UIO caching",
  "created_at": 1781504337676,
  "source": {
    "kind": "git",
    "repo": "C:/git/ts",
    "commit": "8b75da85850e06fecad77f568698f28715974f3f"
  }
}
```

Verbatim from `spikes/pr-walkthrough/artifact/manifest.json`. The `type`
field is what binds the artifact to the new renderer; the registry already
auto-discovers renderers by `type` so no registry edit is required (the
spike confirmed this works for `pr-review.mjs` and `walkthrough.mjs`).
`source` is informational only — the renderer never re-reads the repo,
everything it shows comes from the materialised `diff__` / `original__` /
`modified__` files.

### 3.2 `walkthrough.json`

The agent-generated narrative. Full TypeScript interface in §4. Loaded
eagerly by the renderer on first open; everything visible in the overview
mode is sourced from this single file.

### 3.3 Per-file content & diff (`original__` / `modified__` / `diff__`)

For every file referenced by a step (NOT every file in the PR), the agent
writes three sibling files:

| File | Content | Source command |
|---|---|---|
| `original__<safe>.txt` | Full pre-PR file content | `git show <commit>~1:<file>` |
| `modified__<safe>.txt` | Full post-PR file content | `git show <commit>:<file>` |
| `diff__<safe>.patch` | Unified diff with 8 lines context | `git show --no-color -U8 <commit> -- <file>` |

For a `kind: 'new-file'` step, `original__<safe>.txt` is omitted (or written
empty); the renderer treats absence as "the file did not exist before".
For a `kind: 'batch'` step the same three files are written for the *primary*
file only; sibling files in the batch are listed in `relatedFiles` but not
materialised — the batch step is summarised, not diffed.

### 3.4 The `<safe>` filename convention

Repository file paths contain `/` (and on Windows artefacts may contain `\`),
neither of which are legal in a filename. The convention is:

```ts
const safe = (filePath: string): string =>
  filePath.replace(/[\\/]/g, '__');
```

So `SampleService/SampleScheduler.Common/Cache/TwoTierCache.cs` becomes
`SampleService__SampleScheduler.Common__Cache__TwoTierCache.cs`, and the three
sibling files are:

```
diff__SampleService__SampleScheduler.Common__Cache__TwoTierCache.cs.patch
original__SampleService__SampleScheduler.Common__Cache__TwoTierCache.cs.txt
modified__SampleService__SampleScheduler.Common__Cache__TwoTierCache.cs.txt
```

This is the convention `spikes/pr-walkthrough/extract-real-pr.cjs:30` uses
and the renderer must mirror it. Steps reference these files via the
`fileSafe`, `diffUrl`, `originalUrl`, `modifiedUrl` fields on the `Step`
type (see §4) — clients should treat those as opaque relative URLs and not
re-derive them from the path.

Path collisions are theoretically possible (two files differing only in
slashes) but never occur in practice because the source is a real filesystem
where the original paths were already unique.

### 3.5 `qa/step-<N>.json` — Q&A threads

One file per step. Owned by the server (`mcp-server/src/qa-store.ts`,
Task 2). The renderer reads via `GET /artifact/<id>/qa/step-<N>.json` and
appends questions via `POST` to the same URL; the agent appends answers
via the `pr-walkthrough.answer` MCP tool. Full protocol in §6.

File shape:

```ts
type QaThread = QaEntry[];
interface QaEntry {
  id: string;        // `q_<rand>` — assigned by appendQuestion
  q: string;         // the reviewer's question text
  askedAt: string;   // ISO timestamp
  a?: string;        // the agent's answer (absent until answered)
  ts?: string;       // ISO timestamp when `a` was written
}
```

The thread is append-only from the renderer's perspective — questions are
never edited or deleted in v1.

## 4. Narrative shape (`walkthrough.json`)

All TypeScript interfaces below describe the on-disk JSON shape.
The renderer must tolerate `null` / missing fields per the JSDoc.

### 4.1 Top-level `Walkthrough`

```ts
interface Walkthrough {
  /** PR identity — branches, author, iteration, totals. */
  pr: PrIdentity;

  /** The agent's APPROVE / REQUEST_CHANGES call with rationale. */
  verdict: Verdict;

  /** The 6-gauge confidence dashboard. Six named gauges, fixed names. */
  confidence: {
    risk:      Gauge;
    tests:     Gauge;
    rollback:  Gauge;
    publicApi: Gauge;
    perf:      Gauge;
    deploy:    Gauge;
  };

  /** One-sentence TL;DR. Rendered above the dashboard. */
  tldr: string;

  /** The 5-minute attention plan — ordered, prioritised, time-budgeted. */
  whatToLookAt: Attention[];

  /** Pre-answered "questions a reviewer would ask". */
  faq: Faq[];

  /** Concrete failure conditions the reviewer should grep for. */
  disqualifiers: Disqualifier[];

  /** 6-bullet PR summary from the `summarize-pr-changes` skill. */
  summary: Bullet[];

  /** System architecture, as mermaid source (rendered client-side). */
  architecture: string;

  /** All files in the PR, tagged with which step (if any) owns them. */
  fileStats: FileStat[];

  /** The narrative steps. Length 5–10 in practice. */
  steps: Step[];
}
```

### 4.2 `PrIdentity`

```ts
interface PrIdentity {
  id: number;                  // ADO PR id (or GitHub PR number)
  org: string;                 // 'myorg' (ADO org) or owner (GitHub)
  project: string;             // ADO project ('MyCollection'); empty for GitHub
  repo: string;                // 'ts' / 'octocat/Hello-World'
  title: string;
  description: string;         // first paragraph of the PR description
  author: { name: string; initials: string; };
  sourceBranch: string;        // 'user/foo/bar'
  targetBranch: string;        // typically 'master' / 'main'
  iteration: number;           // ADO iteration id; 1 for GitHub
  createdAt: string;           // ISO timestamp of PR creation
  commit: string;              // merge-or-head commit sha
  additions: number;           // sum of `+` lines across all files
  deletions: number;           // sum of `-` lines across all files
  filesChanged: number;        // count from `git diff --numstat`
}
```

### 4.3 `Verdict`

```ts
interface Verdict {
  recommendation: 'APPROVE' | 'REQUEST_CHANGES';
  /** One-sentence rationale. Renders next to the badge. */
  oneLiner: string;
  /** Agent's own confidence in its recommendation. */
  confidence: 'high' | 'medium' | 'low';
  /**
   * Who has reviewed this PR before the walkthrough was generated.
   * Convention: agent identifiers (e.g. 'copilot-pr-reviewer v3.2') plus
   * 'human (author)' if the PR author self-reviewed. Drives the
   * "reviewed by N agents" badge in the verdict bar.
   */
  reviewedBy: string[];
  /**
   * Concrete VERIFIED claims, each starting with 'Verified' or 'Confirmed'.
   * Each claim must be falsifiable — a reviewer who disagrees can spot-check
   * any single line and reject the verdict on that basis.
   * Rendered behind an "agent notes (N)" expander.
   */
  agentNotes: string[];
}
```

### 4.4 `Gauge`

```ts
interface Gauge {
  /** Colour: green / yellow / orange / red. */
  grade: 'good' | 'caution' | 'warn' | 'crit';
  /**
   * One-word verdict (e.g. 'Low', 'Strong', 'Excellent', 'None',
   * 'Net positive', 'Safe'). The dashboard renders this prominently.
   */
  headline: string;
  /** One-sentence evidence line. Cites specifics. */
  claim: string;
  /**
   * Which step proves the claim. Clicking the gauge jumps the reviewer to
   * that step. 1-indexed, matches `Step.n`.
   */
  anchorStep: number;
}
```

The six gauges (`risk`, `tests`, `rollback`, `publicApi`, `perf`, `deploy`)
are a fixed schema, not a generic key-value map — the renderer hard-codes
the labels, ordering, and icons. Adding a seventh gauge is a schema change.

### 4.5 `Attention`

```ts
interface Attention {
  /** Which step this entry refers to. 1-indexed. */
  stepN: number;
  /**
   * Reading priority. `skip` items render greyed out — the agent is
   * saying "don't spend reviewer time on this".
   */
  priority: 'high' | 'medium' | 'low' | 'skip';
  /** Human-readable budget e.g. '90s', '30s', '0s'. Free-form string. */
  timeBudget: string;
  /**
   * One-sentence guidance — "what to look at on this step and why".
   * Should read like a senior reviewer pointing at the screen.
   */
  claim: string;
}
```

The plan is ordered *by reading priority, not by step number*. Sum of
`timeBudget` ≈ 5 minutes is the design constraint per §1.

### 4.6 `Faq`

```ts
interface Faq {
  /** The question, as a reviewer would actually phrase it. */
  q: string;
  /**
   * A thorough answer. May contain backticked identifiers and reference
   * other steps inline. Rendered as collapsible markdown.
   */
  a: string;
  /**
   * Optional step anchor — if the answer is grounded in a specific step,
   * the FAQ card shows a "jump to step N" affordance.
   */
  anchorStep?: number;
}
```

### 4.7 `Disqualifier`

```ts
interface Disqualifier {
  /** Stable identifier, used for anchors and (future) suppression. */
  id: string;
  /**
   * `block` = ship-stopper if true. `major` = needs follow-up.
   * `minor` = note. Drives the icon and ordering in the checklist.
   */
  severity: 'block' | 'major' | 'minor';
  /**
   * The failure condition in one sentence. Always phrased as the BAD
   * outcome ("X defaults to true in any env"), so the verified=true case
   * reads as "the agent confirmed the bad thing is NOT happening".
   */
  text: string;
  /**
   * Exact grep / file:line / command the reviewer can run to verify the
   * agent's claim. The reviewer is the final judge — this is how they
   * audit the agent.
   */
  howToCheck: string;
  /**
   * `true` if the agent confirmed the bad condition is NOT met. `false` =
   * the agent could not verify; the reviewer MUST check before approving.
   * Drives the ✅ / ⚠️ badge in the renderer.
   */
  agentVerified: boolean;
}
```

The disqualifier list is the heart of the trust model (§8): every `block`
entry with `agentVerified: false` is a hard stop for the reviewer.

### 4.8 `Bullet`

```ts
interface Bullet {
  /**
   * Fixed enum of bullet kinds — matches the `summarize-pr-changes` skill
   * output. The renderer uses `label` to colour and icon the bullet.
   */
  label:
    | 'Impact'
    | 'Risk'
    | 'Test coverage'
    | 'Dependency changes'
    | 'Perf concerns'
    | 'Safe deployment / Rollback';
  /** Markdown body, 1–3 sentences. */
  text: string;
}
```

In practice `summary.length === 6` and the labels appear in the order above;
the renderer should render in order-of-appearance rather than sorting, so
that a skill update that adds a 7th bullet is forward-compatible.

### 4.9 `FileStat`

```ts
interface FileStat {
  /** Full repo-relative path, slash-normalised. */
  path: string;
  additions: number;
  deletions: number;
  /**
   * Zero-based index into `steps[]` of the step that "owns" this file,
   * or `null` if the file is not referenced by any step. Used by the
   * file tree in overview mode to group files under the relevant step.
   * Note this is a zero-based ARRAY INDEX, distinct from `Step.n` which
   * is 1-indexed.
   */
  stepIdx: number | null;
}
```

`fileStats.length === pr.filesChanged`. Files not owned by a step (e.g.
files in a 160-file batch step where only the primary file is listed)
get `stepIdx` set to the batch step's index via the `relatedFiles`
expansion done by the extractor — see
`spikes/pr-walkthrough/extract-real-pr.cjs:445-453`.

### 4.10 `Step`

```ts
interface Step {
  /** 1-indexed step number. Matches `anchorStep` references everywhere. */
  n: number;
  /** One-line title, conventionally "<concept> — <file basename>". */
  title: string;
  /** Repo-relative path to the primary file for this step. */
  file: string;
  /** safe(file) — see §3.4. Pre-computed so clients don't re-derive. */
  fileSafe: string;
  /** highlight.js language id (`csharp`, `typescript`, …). */
  fileLang: string;
  /** True if `original__<safe>.txt` is empty/absent. */
  isNewFile: boolean;
  /**
   * Narrative shape of the step:
   *   'new-file' — entire file is an add; renderer skips diff hunks.
   *   'change'   — normal diff against original.
   *   'batch'    — primary file diff + summary of N matching siblings.
   */
  kind: 'new-file' | 'change' | 'batch';
  /**
   * Semantic tags rendered as pill badges. Free-form but conventional
   * vocabulary: 'logic', 'test', 'config', 'flighting', 'wiring',
   * 'contract', 'foundation', 'dedup', 'core-path', 'bug-fix',
   * 'most-interesting', …. See `extract-real-pr.cjs` STEPS array for
   * the working vocabulary.
   */
  badges: string[];
  /**
   * 1–3 sentence explanation of *the purpose of the change*. NOT a code
   * summary — the reader can see the code; what they need is the why.
   * Renders italicised above the diff.
   */
  why: string;
  /** Optional per-step mermaid source. Null if no per-step diagram. */
  diagram: string | null;
  /** Human-readable budget — '30s', '90s', '2m'. Free-form. */
  timeBudget: string | null;
  /**
   * Optional line number in the modified file the renderer should scroll
   * to when the step opens. Pick the most important added line.
   */
  focusNewLine: number | null;
  /**
   * Only set when `kind === 'batch'`. List of sibling files matched by
   * the agent's batchPattern regex. The batch step displays a "N more in
   * this batch" disclosure listing these paths.
   */
  relatedFiles: string[] | null;
  /** Relative URL to the unified diff file (§3.3). */
  diffUrl: string;
  /** Relative URL to the original full-file content. */
  originalUrl: string;
  /** Relative URL to the modified full-file content. */
  modifiedUrl: string;
}
```

The renderer lazy-loads `diffUrl` the first time a step is opened, caches
it, and only fetches `originalUrl` / `modifiedUrl` when the reviewer asks
to expand collapsed context. This keeps the initial payload to
`manifest.json` + `walkthrough.json` (≈ 30 KB for the spike's 6-step PR).

## 5. Renderer contract

The renderer is a standard built-in renderer at
`mcp-server/src/renderers/pr-walkthrough.mjs`, auto-discovered by the
existing registry. It mirrors the contract used by `walkthrough.mjs` and
`pr-review.mjs`:

```ts
export default {
  type: 'pr-walkthrough',
  comments: false,
  async render(root: HTMLElement, ctx: RendererContext): Promise<void> { … },
};
```

### 5.1 `type: 'pr-walkthrough'`

Binds the renderer to artefacts whose `manifest.json` declares
`"type": "pr-walkthrough"`. The registry resolves the renderer module
purely by this field; nothing else in the registry needs to change.

### 5.2 `comments: false` — why opt out of the universal sidebar

The universal sidebar comment overlay (`_comment-overlay.mjs`, shipped by
the artifact-comments design at `docs/superpowers/specs/2026-06-13-artifact-comments-design.md`)
gives any opt-in renderer a floating selection toolbar + right-rail
sidebar for ad-hoc comments. The PR walkthrough opts out for the same
reason `walkthrough.mjs` and `pr-review.mjs` opt out today (see
`mcp-server/src/renderers/walkthrough.mjs:203-210` and
`mcp-server/src/renderers/pr-review.mjs:448`): the renderer already owns
its right rail (Q&A + Comments tabs in step mode, attention list +
disqualifiers in overview mode) and a second sidebar mounted by the
overlay would fight for the same screen real-estate.

Instead, the PR walkthrough ships its own **line-anchored 💬 affordance**
in the diff gutter: hovering a line reveals a 💬 button anchored to that
specific `(file, lineNumber)`; clicking it opens an in-rail composer
whose draft is bundled with the rest of the step's pending comments and
sent via the same `/dispatch` (live) or `/spawn` (resume) endpoints the
universal overlay uses. This is strictly *more* precise than the universal
text-selection overlay — review comments need line anchors, not arbitrary
DOM-range anchors — and it is consistent with the well-understood
GitHub / ADO inline-comment model the reviewer already knows.

### 5.3 `render(root, ctx)`

`ctx` is the standard renderer context as defined by the registry. The
fields the PR walkthrough renderer relies on are:

| Field | Type | Used for |
|---|---|---|
| `ctx.artifactId` | `string` | URL construction for `/artifact/<id>/qa/*` |
| `ctx.manifest` | `Manifest` | Title, type sanity check |
| `ctx.fetchFile(path)` | `(p) => Promise<string>` | `diff__*.patch`, `original__*.txt`, `modified__*.txt` |
| `ctx.fetchFileJson(path)` | `(p) => Promise<unknown>` | `walkthrough.json` |
| `ctx.listFiles()` | `() => Promise<string[]>` | Sanity: confirm referenced files exist before fetching |

The renderer is a pure ES module loaded into the artefact iframe; it has
no MCP client and no direct access to the workspace. All persistence
(Q&A, inline comments) routes through HTTP endpoints (§6) or the
postMessage protocol the artefact host already implements for the
universal overlay.

### 5.4 What the renderer must NOT do

- It must not write to `walkthrough.json`. The narrative is agent-owned.
- It must not call MCP tools directly. Renderers run in a sandboxed iframe
  per `_comment-overlay.mjs`'s host-message protocol; the host SPA owns
  MCP access.
- It must not embed any per-PR data at build time. The renderer module is
  identical for every PR; per-PR shape comes entirely from
  `walkthrough.json` and the sibling files.

## 6. Q&A protocol

The Q&A flow is a 4-step round-trip between renderer, server, and agent.
The contract is HTTP for the renderer⇄server hop and an MCP tool for the
agent⇄server hop, with the JSON file on disk as the source of truth both
sides converge on.

```
┌── renderer (iframe) ──┐                          ┌── recipe agent ──┐
│                       │                          │                  │
│  user submits question│                          │                  │
│  on step N            │                          │                  │
│         │             │                          │                  │
│         ▼             │  ① POST /artifact/<id>/  │                  │
│  fetch('POST', …)     │     qa/step-N.json       │                  │
│         │─────────────┼─────────────────────────▶│                  │
│         │             │                          │                  │
│         │             │  ② server appends to     │                  │
│         │             │     qa/step-N.json AND   │                  │
│         │             │     dispatches structured│                  │
│         │             │     prompt to agent      │                  │
│         │             │     session              │                  │
│         │             │                          ├─ receives prompt │
│         │             │                          │  composes answer │
│         │             │                          │                  │
│         │             │                          │ ③ calls MCP tool │
│         │             │     pr-walkthrough.answer│                  │
│         │             │◀─────────────────────────┤                  │
│         │             │     server: appendAnswer │                  │
│         │             │     to qa/step-N.json    │                  │
│         │             │                          │                  │
│  ④ poll GET …/qa/     │                          │                  │
│     step-N.json q3s   │                          │                  │
│         │─────────────┼─▶ server: read file ────▶│                  │
│         │◀────────────┼── thread w/ answer ─────┤                  │
│         │             │                          │                  │
│  render answer; stop  │                          │                  │
│  polling              │                          │                  │
└───────────────────────┘                          └──────────────────┘
```

### 6.1 Step 1 — reviewer submits

`POST /artifact/<id>/qa/step-<N>.json` with `{"text": "<question>"}`. The
server (route mounted on `mcp-server/src/terminal-server.ts` per Task 2)
validates the artifact, calls `qa-store.appendQuestion`, then *concurrently*
fires a fire-and-forget dispatch to the artefact's recipe session. The
response (202 Accepted) carries the new entry `{ id, q, askedAt }` so the
renderer immediately has a stable id to poll on.

### 6.2 Step 2 — server appends + dispatches

`qa-store.appendQuestion` writes the question to disk under
`<artifactDir>/qa/step-<N>.json` using the atomic-rename helper in
`mcp-server/src/fs-util.ts`. The dispatch is a structured prompt of the
form:

```
Question on step <N> of artifact pr-walkthrough-<prId>
File: <path>, range: L<from>-L<to>

> <user's question>
```

routed through the same `/dispatch` (live) or `/spawn` (resume) endpoints
that the universal comment overlay uses. The two endpoints diverge on what
they do when there is no active agent session: `/dispatch` errors,
`/spawn` resumes the recipe instance.

### 6.3 Step 3 — agent answers via MCP tool

When the agent has composed an answer it calls the
`pr-walkthrough.answer` MCP tool (Task 8) with
`{ artifact_id, step_n, question_id, text }`. Server-side this becomes
`appendAnswer` against the qa-store, which finds the question by id and
fills in `a` + `ts`.

### 6.4 Step 4 — renderer polls

Once the renderer has POST-ed a question it starts a 3-second poll on
`GET /artifact/<id>/qa/step-<N>.json` capped at 60 attempts (3 minutes).
On each poll it diffs the returned thread against its local copy; once the
target question id has an `a` field it re-renders the QA pane and stops
polling. If the cap is reached without an answer, the question card shows
a "no answer yet — agent may have crashed" affordance.

The renderer does *not* maintain an open WebSocket for Q&A. Polling is
intentional: it survives clawdevbox restarts, page refreshes, and laptop
sleep without re-establishing a connection. Q&A is rare enough (one or
two per artifact in typical use) that 20 polls/minute is not a load
concern.

### 6.5 Concurrency

The qa-store uses atomic-rename writes, so two near-simultaneous question
appends on different steps cannot corrupt each other. Two near-simultaneous
questions on the *same* step can race; the last writer wins on the merged
array, which means the early question may briefly disappear from the
on-disk thread before being re-merged on the next read. In practice this
is invisible — questions are user-initiated and seconds apart. We accept
the simpler implementation for v1 and document this as a known limitation;
follow-up may add proper file-level locking if usage shows races.

## 7. Agent's job (`build-pr-walkthrough` skill)

The full procedure is captured in `plugins/ado/skills/build-pr-walkthrough/SKILL.md`
(Task 7). This section is a summary of what that skill instructs, for the
benefit of readers of *this* spec who want to understand the agent side
without flipping documents.

Given a PR identifier, the agent's responsibilities are:

1. **Fetch inputs** via the ADO MCP server (`ado.get_pr`,
   `ado.get_pr_iteration`, `ado.list_pr_comments`,
   `ado.get_pr_work_items`) — or the equivalent `gh pr view` / `gh pr diff`
   for GitHub PRs.

2. **Cluster files into 5–10 narrative steps.** This is the only step that
   requires real intelligence; everything else is mechanical. Rules:
   - Group by *logical concept*, not by directory. A new caching layer
     that touches 30 files becomes "foundation → each specialised cache
     → wiring → tests", not 30 one-file steps.
   - 5 steps is under-decomposed; >10 steps blows the 5-minute budget.
   - Mark 10+ files with the same edit as `kind: 'batch'` and capture
     them via a regex `batchPattern` resolved by the extractor against
     the file list.
   - Mark new files as `kind: 'new-file'` so the renderer skips the diff
     and shows the file as a single add block.
   - Order by build dependency, then by importance: foundation first,
     specialised next, integration after, tests + config + rollout last.

3. **Author each step's narrative**: `title`, `why` (1–3 sentences,
   purpose-of-the-change not summary-of-the-code), `focusNewLine`,
   `badges`, `timeBudget`, optional per-step `diagram` (mermaid).

4. **Compute the 6 confidence gauges** per the default-grade rubric in
   the skill (risk = caution if 1–3 hot-path edits, tests = good if every
   behaviour change has a test, etc.). Each gauge gets a one-sentence
   claim citing specifics and an `anchorStep` jump target.

5. **Author the verdict** (APPROVE / REQUEST_CHANGES + one-liner +
   confidence + `reviewedBy` + 3–7 `agentNotes`, each phrased as a
   falsifiable "Verified …" or "Confirmed …" claim).

6. **Author the 5-min attention plan** — ordered list of
   `{ stepN, priority, timeBudget, claim }` with total `timeBudget`
   summing to ~5 minutes. Be honest about `skip`.

7. **Author 4–8 disqualifiers** covering at least: config defaults, gate
   conditions, contract compatibility, test-coverage gaps, telemetry,
   failure modes. Each entry phrased as the BAD outcome with
   `agentVerified: true` when the agent confirmed the bad thing is NOT
   happening.

8. **Author 3–7 FAQ entries** of the form "what would a reviewer ask"
   with thorough answers. Always include "why this approach over X?",
   "what about failure mode Y?", "how was this discovered?".

9. **Reuse `summarize-pr-changes` skill** for the 6-bullet `summary`.

10. **Materialise the artifact**: write `original__*.txt` /
    `modified__*.txt` / `diff__*.patch` for each step's primary file
    (NOT every PR file — only step files); write `manifest.json` and
    `walkthrough.json`; call `artifact.add({ type: 'pr-walkthrough',
    recipe_instance_id: <this run>, files: […] })` and surface the
    returned `view_url` as the recipe's inbox card.

11. **Subscribe to Q&A**: register a long-running listener that wakes on
    each new question (server signal), composes a thorough answer, calls
    `pr-walkthrough.answer({ artifact_id, step_n, question_id, text })`,
    re-suspends.

The skill is the *single* source of truth for these rules. This spec
declares the data shape and the contract; the skill operationalises
*how* the agent fills the shape correctly.

## 8. Diff source-of-truth

The renderer never computes a diff. It loads the verbatim text of
`diff__<safe>.patch`, which is whatever `git show --no-color -U8 <commit> -- <file>`
produced at extraction time, and parses it in the browser into structured
hunks (`@@ -from,len +from,len @@`, `+`/`-`/` ` lines, etc.). For inline
word-level highlights on paired add/delete lines, a small in-renderer
tokenizer + LCS comparison runs over the line text.

### 8.1 Why git's unified diff text, not a JS-side diff library

The spike originally tried `jsdiff` (`diff.diffLines(original, modified)`)
over the full file pair and ran into a consistent class of bugs:
`diffLines` is an LCS over *lines*, and when the file has many short
similar lines (e.g. a JSON config with one-key-per-line, or a C# property
block) it produces "matches" that are technically optimal under LCS but
have nothing to do with the author's intent. The result is hunks that
diverge from what GitHub / ADO show, and reviewers lose trust the moment
the line numbers do not match.

`git show -U8` does the *exact* diff GitHub/ADO use — same myers diff,
same hunk boundaries, same context window. By treating the patch text as
the source of truth and parsing it (rather than re-computing), the
renderer is guaranteed to render the same hunks the reviewer would see
on the PR's web UI. The cost is one extra file per step on disk, which
the lazy-load pattern (§5.3) makes a non-issue.

### 8.2 Why parse in the browser rather than ship pre-parsed JSON

Parsing the unified diff is ~200 lines of vanilla JS and the inputs are
small (the spike's largest diff is ~30 KB). Pre-parsing server-side would
add a build step to the agent's authoring pipeline for no real win — the
patch *is* the source of truth, and any divergence between a pre-parsed
JSON shape and the raw patch is a bug-magnet. Keeping the raw patch
file as the on-disk artefact also means a reviewer can `cat` it directly
to verify what the renderer is showing.

### 8.3 What the renderer does compute

- **Hunk structure** — parse `@@ -from,len +from,len @@` headers, split
  body into add / delete / context lines.
- **Paired add/delete** — adjacent `-` and `+` blocks of equal length get
  paired for word-level inline highlights via a tiny LCS-tokenizer over
  whitespace-delimited tokens.
- **Syntax colour** — highlight.js (CDN) over each line, language picked
  from `Step.fileLang`.
- **"Expand 3 lines"** affordance — when the reviewer asks to see
  collapsed context, the renderer fetches `originalUrl` / `modifiedUrl`
  and splices in the missing lines.

## 9. Trust model

The PR walkthrough is fundamentally an *agent claim* that the reviewer
either accepts or rejects. The artefact is the deliverable of one or more
agents that have already reviewed the PR; the reviewer's job is the
final-judge call, not a from-scratch re-review. The model only works if
the reviewer can audit the agent's claims cheaply.

The trust signals, in order of strength:

| Signal | What it asserts | How the reviewer audits |
|---|---|---|
| `verdict.recommendation` + `oneLiner` | "I think this PR should ship" | The whole rest of the artefact is the evidence. |
| `verdict.confidence` | "How sure am I" | If `low`, the reviewer is being told to drill in. |
| `verdict.reviewedBy` | "These agents (and possibly the author) reviewed first" | List shows in verdict bar; future iteration can link to each agent's report. |
| `verdict.agentNotes[]` | Concrete falsifiable claims | Each note is a "Verified X" the reviewer can grep for. |
| `confidence.*.claim` + `anchorStep` | Per-axis evidence | Click the gauge, land on the step that proves the claim. |
| `disqualifiers[].agentVerified` | "The bad thing didn't happen" | `howToCheck` is an exact grep/file:line; reviewer runs it in 10 seconds. |
| `whatToLookAt[]` | "Spend your time here" | Honest `skip` priorities tell the reviewer where NOT to bother. |
| `faq[]` | Pre-empted questions | Reviewer's "wait, but what about X?" already answered. |

The model is **agent-asserts, reviewer-verifies-cheaply**. Three concrete
design properties enforce this:

1. **Every agent claim has a falsifiable anchor.** No section says "trust
   me"; every confident assertion either jumps to a step (gauges, FAQ) or
   gives a one-liner the reviewer can run (`howToCheck` on disqualifiers,
   step-anchored claims on `agentNotes`).
2. **Honest negatives are first-class.** `agentVerified: false` on a
   disqualifier is not a failure mode — it is the agent telling the
   reviewer "I could not confirm this, you must". A walkthrough with
   every disqualifier verified can be ship-checked in 30 seconds; one
   with several `false` entries demands real reviewer time, and the
   artefact says so up front.
3. **The reviewer is the final judge.** The artefact does not auto-approve,
   does not push a vote to ADO, and does not modify the PR. The
   recommendation is advisory. The reviewer's `Approve` click on the PR
   UI is what ships code.

The walkthrough is allowed to be wrong; it must not be allowed to *hide*
that it is wrong. Every section of the spec is designed so that "the
agent missed something" is a 30-second discovery, not a 30-minute one.

## 10. Folder layout summary

For reviewers of this spec who want one diagram of where everything lives:

```
mcp-server/
├── src/
│   ├── renderers/
│   │   ├── pr-walkthrough.mjs              ← Task 4 — the renderer
│   │   └── _pr-walkthrough-styles.mjs      ← Task 3 — CSS as JS template
│   ├── qa-store.ts                         ← Task 2 — Q&A persistence
│   ├── terminal-server.ts                  ← Task 2 — adds GET/POST route
│   └── tools/
│       └── pr-walkthrough.ts               ← Task 8 — answer MCP tool
└── tests/
    ├── qa-store.test.mjs                   ← Task 2
    ├── pr-walkthrough-renderer.test.mjs    ← Task 5 — jsdom unit
    ├── pr-walkthrough-e2e.playwright.test.mjs ← Task 6
    └── pr-walkthrough-tool.test.mjs        ← Task 8

plugins/ado/
├── skills/
│   ├── build-pr-walkthrough/SKILL.md       ← Task 7 — agent's manual
│   └── summarize-pr-changes/SKILL.md       ← Task 10 — adds See-also link
└── recipes/
    └── pr-walkthrough.yaml                 ← Task 9 — recipe entry point

docs/superpowers/specs/
└── 2026-06-14-pr-walkthrough-design.md     ← this document

spikes/pr-walkthrough/                      ← ground truth
├── README.md
├── extract-real-pr.cjs                     ← defines the data shape
├── app.js                                  ← renderer prototype
├── styles.css                              ← renderer styles
└── artifact/                               ← real PR 1426766 baked output
```

## 11. Test plan (summary)

Full coverage lives with each task in the implementation plan; this
section sketches what each layer is responsible for so the spec reader
can sanity-check that the design is testable.

1. **`qa-store.test.mjs`** (Task 2) — node:test units over
   `appendQuestion` / `appendAnswer` / `readThread`. Covers happy path,
   missing question id, missing thread, concurrent appends preserving
   order.

2. **`pr-walkthrough-renderer.test.mjs`** (Task 5) — jsdom units. One
   test per major section (verdict bar, 6 gauges, attention list,
   disqualifier checklist, FAQ, summary, file tree, mode switch on
   gauge click, rail collapse).

3. **`pr-walkthrough-e2e.playwright.test.mjs`** (Task 6) — Playwright
   end-to-end. Spins up a real clawdevbox over a copy of
   `spikes/pr-walkthrough/artifact/`, asserts every surface renders, then
   runs the Q&A round-trip (POST question → mock agent calls
   `pr-walkthrough.answer` → assert renderer's poll surfaces it).

4. **`pr-walkthrough-tool.test.mjs`** (Task 8) — MCP tool handler unit
   tests; happy path + missing-artifact + missing-question failures.

5. **Real-PR validation** (Task 11) — manual smoke against the spike's
   extracted artefact in a temp workspace; confirms the production
   renderer renders the spike's data faithfully.

## 12. Rollout

All work is additive — new files only, with two minor edits to
`terminal-server.ts` (one route) and `tools/index.ts` (one registration).
There is no schema migration, no data backfill, and no existing artifact
type whose behaviour changes.

The PR walkthrough is opt-in by recipe choice: a user who runs the
`pr-walkthrough` recipe gets one; nothing else triggers walkthrough
creation. A user who never runs the recipe never sees the artefact type.

If a regression slips, the rollback is to remove the recipe
(`plugins/ado/recipes/pr-walkthrough.yaml`) — existing walkthrough
artefacts on disk continue to be servable by the renderer, and the
renderer can be removed in a follow-up commit without breaking any
other artefact.

## 13. Open questions (deferred to implementation)

- **Comment bundle send path** — the renderer's in-rail line-anchored
  comment composer reuses the same `/dispatch` / `/spawn` endpoints that
  `_comment-overlay.mjs` uses, but the exact assembled-markdown shape for
  PR-walkthrough comments (per-step grouping vs flat list) is a renderer
  implementation detail to settle in Task 4.
- **`source.kind: 'ado'` vs `'git'`** — the spike writes
  `source.kind: 'git'` with a local repo path. For ADO PRs fetched via
  the MCP, an `'ado'` kind with org/project/pr-id may be more useful for
  future deep-links. Decide during Task 7 (skill authoring).
- **Question dispatch when no active session** — `/dispatch` errors,
  `/spawn` resumes. The renderer needs a UX for the "agent is cold,
  resuming…" case; depend on the existing comment-overlay UX once
  Task 4 lands.

## 14. Decisions log

| # | Question | Answer |
|---|---|---|
| 1 | Diff source | Git's `git show -U8` text, parsed in browser. NOT jsdiff over file pairs (LCS misalignment). |
| 2 | Comment overlay | Opt out of universal (`comments: false`). Ship line-anchored 💬 in diff gutter instead. |
| 3 | Q&A persistence | Per-step JSON file on disk (`qa/step-<N>.json`), HTTP endpoint for read/append, MCP tool for agent answer. |
| 4 | Q&A delivery | Renderer polls 3s/cap 60. No WebSocket. |
| 5 | Walkthrough mutability | Read-only. Agent owns `walkthrough.json`; renderer never writes back. |
| 6 | Fixed gauge schema | 6 named gauges (risk/tests/rollback/publicApi/perf/deploy). Adding a 7th is a schema change. |
| 7 | Trust model | Agent-asserts + reviewer-verifies-cheaply. Every claim falsifiable, every "I'm not sure" honestly flagged. |
| 8 | Materialisation scope | Per-step files only, not per-PR-file. Batches summarise siblings via `relatedFiles`. |
| 9 | `<safe>` convention | `path.replace(/[\\/]/g, '__')`. Defined by `extract-real-pr.cjs:30`. |
