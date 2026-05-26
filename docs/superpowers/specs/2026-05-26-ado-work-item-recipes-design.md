# ADO Work-Item-Driven Recipes (Feature + Bug)

**Status:** design  
**Owner:** clawdevbox team  
**Date:** 2026-05-26  
**Plugin:** `plugins/ado`

## 1. Summary

Add a new ADO trigger type and a set of recipes that turn an inbound ADO work
item into an end-to-end automated implementation flow: discover the affected
repo(s) → design or analyze → plan → implement (sub-agent-driven, in
worktrees) → open PR(s) → monitor PR comments → respond / fix until merged.

The flow is deliberately gate-paced: design / analysis is reviewed by the
user, the implementation plan is reviewed by the user, the draft PR is
reviewed by the user before going live, and on the live PR each reviewer
change-request is also gated. Everything else runs unattended.

The recipes are prose-only (no engine state); they delegate to existing
superpowers skills for design (`brainstorming`), planning (`writing-plans`),
implementation orchestration (`subagent-driven-development`), worktree setup
(`using-git-worktrees`), debugging (`systematic-debugging`), test-first
discipline (`test-driven-development`), and PR-comment classification
(`analyze-pr-comment`).

## 2. Goals

- A single new ADO trigger type that fires on new (or newly-active) work
  items in a watched area.
- One thin router recipe (`triage-work-item`) plus two execution recipes
  (`implement-feature`, `fix-bug`) and one PR-monitor sub-recipe
  (`address-pr-feedback`). Together they cover feature + bug WIs end-to-end.
- Cross-repo support: a single WI may touch multiple repos / services; the
  agent discovers the set, works each in its own worktree in parallel, and
  opens one PR per repo all linked back to the WI.
- Repo discovery uses a free-form markdown memory file the agent authors
  itself and updates as it learns.
- The agent only asks the user for a repo decision when it is not
  confident, or when later discovery contradicts its initial choice.

## 3. Non-goals

- No automatic merging. PRs sit waiting for human merge after review.
- No auto-resolution of large refactors flagged by reviewers (those re-enter
  the change-request approval flow).
- No support yet for Epic-level WIs that decompose into child WIs — out of
  scope; the recipes assume a leaf WI of type User Story / Feature / Bug /
  Task.
- No first-class engine for "design + plan + execute" — recipes are prose
  the agent adapts.

## 4. Dispatch model

One trigger type bound to one router recipe. The router reads the WI type
and `recipe.run`s the appropriate execution recipe. This avoids a
proliferation of trigger types when we add more WI types later (e.g.
`Spike`, `Documentation`).

```
ado.new-work-item-watcher  ──fires──▶  triage-work-item
                                            │
                       ┌────────────────────┼────────────────────┐
                       ▼                    ▼                    ▼
              implement-feature         fix-bug         (future: spike, etc.)
                       │                    │
                       └──── opens PR ─────┘
                              registers
                              ado.comment-watcher
                              bound to
                              address-pr-feedback
```

## 5. Phase 0 — repo-set resolution

Phase 0 lives in the router recipe `triage-work-item`. The execution
recipes (`implement-feature`, `fix-bug`) receive the resolved repo set as
input and do not re-implement repo discovery.

### 5.1 Memory file

`<projectDir>/.clawdevbox/repo-registry.md` is a free-form markdown file
the agent reads at Phase 0.a and updates throughout the flow. There is no
schema; the agent decides what shape best helps it remember. A reasonable
starting shape:

```markdown
# Repo registry

## auth-svc
- Clone: https://msasg.visualstudio.com/Foo/_git/auth-svc
- Owns: token issuance, OAuth flows
- Area paths: Foo\Auth, Foo\Auth\API
- Submodules: common-protos
- Often co-changes with: auth-client, auth-docs

## auth-client
- Clone: ...
- Owns: client SDK consuming auth-svc

## Notes
- WIs tagged "identity" usually touch auth-svc + auth-client together.
- WI #13002 added a new claim → required updates in auth-svc + auth-client + auth-docs.
```

If the file is missing on first run, the agent creates it as it learns.

### 5.2 Resolution loop

```
⓪.a  Read .clawdevbox/repo-registry.md. Reason from its prose + WI signals
     (area-path, tags, title, description, linked PRs/commits) to pick a
     candidate repo set.

⓪.b  Self-rate confidence. Confident if EITHER:
       - memory contains a clear matching entry, AND
       - WI signals all line up with that entry, AND
       - no signals contradict the choice,
     OR
       - linked PRs/commits on the WI directly name the repo(s).
     Confident → proceed silently; thread.append_message names the repos
     and the matching memory cues. No approval gate.
     Not confident → inbox card + approval with candidates, per-repo
     reasoning, and a freeform field; wait for user.

⓪.c  Ensure each chosen repo is cloned (+ submodules) under
     <workspaces_root>/<workspace-id>/repos/<repo>. Sibling worktrees off
     that clone follow the `using-git-worktrees` skill.

⓪.d  At any later phase, if discovery contradicts Phase 0 (e.g. the design
     phase finds the change actually belongs in a different service, or
     another repo also has to change), STOP and ask the user via inbox +
     approval before continuing. Update repo-registry.md with the
     correction so the next similar WI resolves correctly.

⓪.e  At recipe end, update repo-registry.md with anything learned during
     the run that wasn't already there — new aliases, new co-change
     patterns, new notes. The agent decides what's worth recording.
```

## 6. Recipes

### 6.1 `triage-work-item.yaml` (router)

```
id: triage-work-item
name: "Triage an ADO work item"
description: Read the work item, resolve which repo(s) it touches,
  ensure they're cloned, then dispatch to implement-feature or fix-bug.
default_client: copilot
mcp_servers: [ado, clawdevbox]

steps:
  1. ado.get_work_item({ id }) → extract type, area-path, tags, links.
  2. Phase 0 (§5): resolve repo set, clone if needed.
  3. Branch on System.WorkItemType:
       - Bug                       → recipe.run('fix-bug',           { wi_id, repos })
       - User Story | Feature|Task → recipe.run('implement-feature', { wi_id, repos })
       - other                     → inbox card "Unsupported type" + recipe.done(failure)
  4. recipe.done(success, "dispatched <recipe> for WI #N across <repos>")
```

### 6.2 `implement-feature.yaml`

Seven phases. Three approval gates: design, plan, pre-PR. Skill citations
are intentional; the recipe does not re-derive their content.

```
Phase 1 — Setup
  - Read WI body, acceptance criteria, attachments.
  - inbox.create({ kind:'feature', tag:'wi-<id>', title:WI.title })
  - ado.update_work_item({ state:'Active' })
  - For each repo in input.repos: consult `using-git-worktrees` skill →
    isolated worktree on a fresh branch. Let the skill name the branch
    from repo conventions.

Phase 2 — Design (GATE)
  - Consult `brainstorming` skill for design shape.
  - Produce design.md artifact: problem, approach, per-repo change shape,
    risk, test strategy.
  - approval.request with the artifact. Loop on user feedback until approved.

Phase 3 — Plan (GATE)
  - Consult `writing-plans` skill.
  - Decompose into todos in SQL, partitioned by repo; declare cross-repo
    dependencies.
  - Emit plan.md artifact mirroring the todo list.
  - approval.request → gate.

Phase 4 — Implementation
  - Consult `subagent-driven-development` skill.
  - Per repo, dispatch sub-agents per ready todo (in parallel where deps
    allow). Each sub-agent operates in that repo's worktree.
  - As todos complete, run repo-local tests (`test-driven-development`
    governs which tests).
  - Integrate. Run full test suite per repo.

Phase 5 — Pre-PR (GATE)
  - For each repo, draft PR title + description with WI back-link.
  - One approval card listing all draft PRs side-by-side; user approves
    the batch atomically.
  - On feedback, revise.

Phase 6 — Open + monitor PRs
  - For each repo: ado.create_pr(...) linked to the WI via Artifact Link.
  - ado.update_work_item({ state:'Resolved' }) with links to PRs.
  - Register one ado.comment-watcher per PR, all bound to
    `address-pr-feedback`.
  - thread.set_state('suspended').

Phase 7 — Finalize (re-entered when all PRs reach terminal state)
  - Cleanup worktrees per `using-git-worktrees` skill.
  - Update repo-registry.md (§5 ⓪.e).
  - inbox.update with final outcome.
  - recipe.done.
```

### 6.3 `fix-bug.yaml`

Same skeleton as `implement-feature` minus the explicit design phase;
**analysis is the plan** for bugs, so there's one combined GATE instead of
two.

```
Phase 1 — Setup           (same as implement-feature)
Phase 2 — Analysis (GATE)
  - Consult `systematic-debugging` skill.
  - Reproduce (where possible), bisect, identify root cause.
  - Emit analysis.md artifact: repro, root cause, blast radius, fix
    shape per repo.
  - approval.request → gate. Analysis IS the plan.

Phase 3 — Implementation
  - Consult `test-driven-development` first — write the failing test.
  - Consult `subagent-driven-development` if fix spans >1 repo or >3
    distinct touch-points; otherwise straight-line fix.
  - Verify the test goes red → green.

Phase 4 — Pre-PR (GATE)   (same as implement-feature)
Phase 5 — Open + monitor   (same as implement-feature)
Phase 6 — Finalize         (same as implement-feature)
```

### 6.4 `address-pr-feedback.yaml`

Author-side comment responder. Sibling to the existing
`respond-to-pr-comment` (which is reviewer-side). Biased toward
"you wrote this code, you can change it" — trivial nits auto-apply
without an approval.

```
Step 1 — Read the inbound comment + diff context.
Step 2 — Consult `analyze-pr-comment` skill to classify:
         question | nit | change-request | affirmation.
Step 3 — Branch:
  Question     → draft answer grounded in the diff. ado.comment_pr.
                 No code change. No approval.
  Nit          → if trivial (typo, rename, formatting): auto-apply via
                 the worktree, push, reply with commit hash. No approval.
                 Non-trivial → treat as change-request.
  Change-req   → draft plan (files, change, why). approval.request. On
                 approval: apply via the worktree, push, reply with the
                 commit hash linking back.
  Affirmation  → 2-word ack reply.
Step 4 — thread.append_message recording the action. Watcher fires
         again on the next comment.
Step 5 — recipe.done with status reflecting whether code was pushed.
```

## 7. New ADO MCP tools

Added under `plugins/ado/tools/` and exported from
`plugins/ado/.claude-plugin/plugin.json`. All follow the existing
`_auth.ts` / `adoFetch` / `resolveScope` pattern used by the current PR
tools, so auth (Bearer preferred, PAT fallback) and `org`/`project`
defaulting via env are uniform.

| Tool                            | What it does                                                                                              |
|---------------------------------|-----------------------------------------------------------------------------------------------------------|
| `ado.get_work_item`             | Get one WI by id; returns id, type, state, title, description, area-path, tags, assignedTo, links.        |
| `ado.list_work_items`           | Run a bounded WIQL query (used for manual triage; the trigger script uses raw fetch for its own polling). |
| `ado.list_work_item_comments`   | Comment thread on a WI.                                                                                   |
| `ado.add_work_item_comment`     | Post a comment.                                                                                           |
| `ado.update_work_item`          | Patch fields (state transitions, link a PR via Artifact Link, set tags).                                  |
| `ado.create_pr`                 | Open a PR; supports `work_item_refs` array so the PR auto-links to the WI(s).                             |
| `ado.get_work_item_updates`     | Revision history; used to detect reassignment / state-change mid-flight.                                  |

These mirror the agent-facing PR tools (`ado.get_pr`, `ado.comment_pr`,
etc.) so the new recipes stay declarative.

## 8. Trigger type

### 8.1 Manifest entry

Added to `plugins/ado/.claude-plugin/plugin.json` → `trigger_types[]`:

```json
{
  "id": "ado.new-work-item-watcher",
  "file": "triggers/ado-new-work-item-watcher.ts",
  "description": "Detect new ADO work items in an area; start a triage-work-item thread per WI via callback. Cold trigger -- ticks on the default cron schedule. Self-state tracks lastCheckedAt per registration.",
  "binds_callback_to_recipe": "triage-work-item",
  "default_cron": "*/5 * * * *",
  "identity_param": "area_path",
  "parameters": [
    { "name": "org",             "type": "string",  "required": true,  "description": "ADO organization slug. Defaults to env ADO_ORG if omitted." },
    { "name": "project",         "type": "string",  "required": true,  "description": "ADO project name." },
    { "name": "area_path",       "type": "string",  "required": true,  "description": "Area path prefix to watch (matched with 'Under' semantics)." },
    { "name": "assigned_to",     "type": "string",  "required": false, "description": "Filter to WIs assigned to this uniqueName. '@me' resolves to the auth identity." },
    { "name": "work_item_types", "type": "array",   "required": false, "default": ["User Story", "Feature", "Bug", "Task"], "description": "Which WI types to surface." },
    { "name": "states",          "type": "array",   "required": false, "default": ["New"], "description": "Which states to fire on." },
    { "name": "exclude_tags",    "type": "array",   "required": false, "description": "Skip WIs carrying any of these tags." }
  ]
}
```

### 8.2 Script behavior

`plugins/ado/triggers/ado-new-work-item-watcher.ts` — zero deps beyond
Node 20 `fetch`. Same shape as `ado-new-pr-watcher.ts`. Mode B (live POST
per detected WI).

```
on fire:
  1. Read stdin envelope → state.lastCheckedAt (0 on first run).
  2. WIQL query bounded by:
        [System.TeamProject] = @project
        AND [System.AreaPath] UNDER 'area_path'
        AND [System.WorkItemType] IN (work_item_types)
        AND [System.State] IN (states)
        AND [System.ChangedDate] > '<lastCheckedAt-as-ISO>'
     ChangedDate (not CreatedDate) so a WI moved INTO an active state
     also surfaces — matches user intent for "new to me".
  3. Batch-fetch WIs via Wiql + workitemsbatch.
  4. For each WI:
       - Skip if assigned_to mismatches.
       - Skip if any tag is in exclude_tags.
       - POST callback (Mode B) to env.callback_url:
           { prompt: <one-line summary>,
             context: { wi_id, wi_type, area_path, assigned_to, title, url } }
  5. Advance state.lastCheckedAt = max(ChangedDate over the batch, or now()).
  6. Write { state, systemMessage: "fired N callbacks" } to stdout. Exit 0.

errors:
  - ADO HTTP non-2xx → stderr + exit 2 (blocking).
  - Missing ADO_ORG or ADO_BEARER_TOKEN/ADO_PAT → exit 2 with explicit reason.

auth:
  - ADO_BEARER_TOKEN preferred (AAD), ADO_PAT fallback.
  - Mode B requires CLAWDEVBOX_MCP_SECRET for the callback Authorization header.
```

### 8.3 Re-fire avoidance

- `lastCheckedAt` per registration prevents re-firing on the same
  ChangedDate.
- The `triage-work-item` recipe transitions the WI to `Active` in setup,
  so on the default `states=["New"]` filter the WI exits the bucket on
  first dispatch.
- Inbox card uses `tag: 'wi-<id>'` so a duplicate callback (e.g. transient
  retry) collapses into the existing card rather than spawning a duplicate
  recipe instance.

## 9. Skill dependencies

Required to be installed in the user's vault chain:

| Skill                          | Used by                                            |
|--------------------------------|----------------------------------------------------|
| `brainstorming`                | `implement-feature` Phase 2                        |
| `writing-plans`                | `implement-feature` Phase 3                        |
| `subagent-driven-development`  | `implement-feature` Phase 4, `fix-bug` Phase 3     |
| `using-git-worktrees`          | Both — setup + finalize                            |
| `systematic-debugging`         | `fix-bug` Phase 2                                  |
| `test-driven-development`      | `fix-bug` Phase 3, `implement-feature` Phase 4     |
| `analyze-pr-comment`           | `address-pr-feedback`                              |

All ship in `superpowers-marketplace/superpowers/skills/`. Recipes
reference them by short name; the agent CLI's skill loader resolves via
the vault chain.

## 10. Files to create

```
plugins/ado/
  tools/
    get_work_item.ts                  ← new
    list_work_items.ts                ← new
    list_work_item_comments.ts        ← new
    add_work_item_comment.ts          ← new
    update_work_item.ts               ← new
    create_pr.ts                      ← new
    get_work_item_updates.ts          ← new
  triggers/
    ado-new-work-item-watcher.ts      ← new
  recipes/
    triage-work-item.yaml             ← new
    implement-feature.yaml            ← new
    fix-bug.yaml                      ← new
    address-pr-feedback.yaml          ← new
  .claude-plugin/
    plugin.json                       ← updated (add tools[], trigger_types[], recipes[])
```

## 11. Testing

- **New MCP tools:** unit tests under `mcp-server/tests/` mocking `fetch`
  per the `_auth.ts` conventions. Pattern after `get_pr.ts` shape.
- **Trigger script:** standalone integration test that pipes a fake
  envelope to stdin, mocks ADO endpoints, asserts the emitted stdout
  shape and stderr-on-error behavior. Mirror
  `samples/triggers/test/test-driver.ts`.
- **Recipes:** no engine to test (prose-only). The recipe shape validator
  invoked by `recipe.upsert` will reject malformed YAML on install.

## 12. Open questions (deferred)

- Should `triage-work-item` also handle Epics by decomposing them into
  per-child-WI dispatches? Out of scope here; tracked separately.
- Should `address-pr-feedback` learn over time which "nits" are truly
  trivial in this repo (from user accept/override signals)? Defer until
  we have feedback data.
- Cross-repo PR ordering: today we open all PRs in parallel. If one
  introduces a dependency the others consume, the consumer PRs will
  fail CI until the producer merges. A follow-up could surface a
  "merge order" hint in the pre-PR gate.
