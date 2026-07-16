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

## 0. Required `walkthrough.json` top-level schema

The renderer destructures these keys from the root of `walkthrough.json`:

```jsonc
{
  // REQUIRED — the renderer reads PR.id, PR.title, etc. for the top bar.
  // If null/missing, the renderer falls back to WT.title / manifest.title.
  "pr": {
    "id": 12345,              // PR number (int or string)
    "title": "…",            // PR title
    "sourceBranch": "feature/xyz",
    "targetBranch": "main",
    "filesChanged": 3,
    "additions": 243,
    "deletions": 0,
    "iteration": 1           // iteration/revision number (for ADO)
  },

  // REQUIRED — 6-gauge confidence dashboard.
  // Key can be "confidence" OR "gauges" (alias supported by renderer).
  "confidence": { /* see §4 below */ },

  // REQUIRED — step-by-step narrative (array)
  "steps": [ /* see §3 below */ ],

  // REQUIRED — verdict block
  "verdict": { /* see §5 below */ },

  // OPTIONAL — one-paragraph TL;DR shown below the verdict bar
  "tldr": "One paragraph summarizing the PR for a 30-second skim.",

  // OPTIONAL — ordered attention plan for the reviewer
  "whatToLookAt": [ /* see §6 below */ ],

  // OPTIONAL — pre-answered FAQ
  "faq": [ /* see §8 below */ ],

  // OPTIONAL — disqualifier checklist
  "disqualifiers": [ /* see §7 below */ ],

  // OPTIONAL — 5-6 bullet summary (array of strings)
  "summary": ["…", "…"],

  // OPTIONAL — mermaid diagram string for architecture overview
  "architecture": "graph LR\n  A --> B",

  // OPTIONAL — per-file stats for the file tree panel.
  // If missing, the renderer shows step count instead.
  "fileStats": [
    { "path": "src/Foo.cs", "additions": 53, "deletions": 0, "stepIdx": 2 }
  ]
}
```

**Pre-PR walkthroughs** (branch not yet pushed, no PR number): set `"pr": null`
and provide `"title"` and `"branch"` at the root level — the renderer reads
those as fallbacks for the top bar.

### CRITICAL: field shapes the renderer actually reads

The renderer (`.mjs`) destructures and uses these exact shapes. Getting these
wrong causes `TypeError: Cannot read properties of undefined` or renders
"UNDEFINED" text. **Do not deviate.**

| Field | Renderer reads | WRONG (will crash/show undefined) |
|-------|---------------|----------------------------------|
| `summary` | `[{ label: "Risk", text: "..." }, ...]` (array of objects) | `["string", ...]` (array of plain strings) |
| `steps[].file` | `s.file` (singular string path) | `s.files` (array) — renderer calls `.split('/')` on it |
| `steps[].diffUrl` | `s.diffUrl` (filename of `.patch` in artifact dir) | missing/omitted — causes `GET .../file/undefined 404` |
| `steps[].fileLang` | `s.fileLang` (string for syntax highlight class) | missing — renders `lang-undefined` CSS class |
| `steps[].isNewFile` | `s.isNewFile` (bool) | `s.kind === 'new-file'` alone is not enough |
| `confidence` | `{ risk: {grade,headline,claim,anchorStep}, ... }` | Named `gauges` (alias works but prefer `confidence`) |
| `architecture` | mermaid string or `null`/omit | object or array |
| `pr` | `{ id, title, sourceBranch, targetBranch, filesChanged, additions, deletions, iteration }` or `null` | top-level `prId` field (not read) |
| `tldr` | string or omit | object |
| `fileStats` | `[{ path, additions, deletions, stepIdx }]` or omit | steps-based array without `stepIdx` |

### Step shape (exhaustive)

```jsonc
{
  "n": 1,                    // REQUIRED — step number (1-indexed)
  "title": "...",            // REQUIRED — one-line title
  "file": "src/Foo.cs",     // REQUIRED — single file path (renderer calls .split('/'))
  "diffUrl": "diff__src__Foo.cs.patch",  // REQUIRED — filename of the .patch file in the artifact dir
  "fileLang": "csharp",     // REQUIRED — language for syntax highlighting ("csharp"|"typescript"|"python"|...)
  "kind": "edit",           // "edit" | "new-method" | "new-property" | "new-file" | "batch" | "test"
  "isNewFile": false,       // REQUIRED bool — renderer checks this for NEW FILE badge
  "why": "...",             // REQUIRED — 1-3 sentence purpose explanation
  "focusNewLine": 25,       // line number renderer scrolls to in the diff
  "badges": ["logic"],      // semantic tags shown as chips
  "timeBudget": "30s",      // reviewer time estimate
  "diagram": "graph...",    // mermaid string or null — step-level diagram
  "relatedFiles": []        // only for kind: "batch" — other files with same edit
}
```

**`diffUrl` construction:** Take the file path, replace `/` and `\` with `__`,
prepend `diff__`, append `.patch`. Example:
`src/auth/Login.ts` → `diff__src__auth__Login.ts.patch`

**`fileLang` values:** `csharp`, `typescript`, `javascript`, `python`, `go`,
`java`, `rust`, `yaml`, `json`, `markdown`, `shell`.

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

The 6-bullet summary MUST be an array of `{ label, text }` objects:

```jsonc
"summary": [
  { "label": "Feature", "text": "What the PR adds." },
  { "label": "Scope", "text": "What's in / out." },
  { "label": "Tests", "text": "Coverage claim." },
  { "label": "Risk", "text": "Risk assessment." },
  { "label": "Deploy", "text": "Rollout strategy." },
  { "label": "Observability", "text": "Logging/metrics." }
]
```

**NOT** `["string", "string"]` — that renders as "UNDEFINED" for every bullet.

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

## 12. Validate before delivering the URL

**MANDATORY.** After writing `walkthrough.json` and calling `artifact.add`,
run a Playwright smoke test against the rendered page. If you don't have a
test file handy, at minimum do:

```javascript
// Quick validation (run with: npx playwright test <file> --reporter=line)
const { test, expect } = require('@playwright/test');
const URL = '<artifact_view_url>';

test('no page errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  expect(errors).toEqual([]);
});

test('no UNDEFINED text', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'networkidle' });
  const body = await page.locator('body').textContent();
  expect(body.match(/\bUNDEFINED\b/gi)).toBeNull();
});

test('summary bullets have content', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'networkidle' });
  const bullets = page.locator('#bullets li');
  const count = await bullets.count();
  expect(count).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < count; i++) {
    const t = await bullets.nth(i).textContent();
    expect(t.length).toBeGreaterThan(10);
  }
});

test('steps render', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'networkidle' });
  const toggle = page.locator('#mode-toggle');
  if (await toggle.isVisible()) await toggle.click();
  const steps = page.locator('#steps li');
  await expect(steps).toHaveCount(/* expected step count */);
});
```

**Do NOT deliver the URL to the user until Playwright passes.** The most
common failures:

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| `TypeError: Cannot read properties of undefined (reading 'id')` | Missing `pr` object (or set to `null` without renderer fallback) | Ensure renderer has null guard (§0) or provide full `pr` object |
| "UNDEFINED" × 6 in summary | `summary` is `string[]` instead of `[{label,text}]` | Rewrite as array of objects |
| Steps don't render | `steps[].file` missing (used `files` array) | Use singular `file` string per step |
| Architecture blank | `architecture` is object/null instead of mermaid string | Provide valid mermaid `graph` string |
| Confidence gauges missing | Used key `gauges` without renderer alias | Use key `confidence` (canonical) |
