---
name: using-clawdevbox
description: How to use the clawdevbox MCP tools effectively — memory, skills, recipes, triggers, inbox, sessions, approvals. The operational manual for any agent connected to a clawdevbox MCP server.
when_to_use: You are connected to a clawdevbox MCP server and need to look up how a specific subsystem works, how to structure a write to memory, when to author a skill vs a recipe vs a trigger, or what the recommended patterns are. Read this once at session start (or on demand for a specific subsystem) and refer back when planning multi-step work.
---

# Using Clawdevbox

Clawdevbox exposes a persistent, self-improving toolset to any MCP client. The
core idea is that you don't just answer questions — you accumulate **memory**
(durable knowledge), build **skills** (reusable workflows), wire **recipes**
(declared pipelines) and **triggers** (scheduled/event-driven entry points),
coordinate with the user via the **inbox**, and parallelize independent work
through **sessions**. This skill is the reference manual for all of that.

> **Companion to:** the server's own `SERVER_INSTRUCTIONS` (delivered on every
> MCP `initialize`) defines the *behavioural defaults* — the mandatory reflexes
> and quality bar. This skill provides the *how-to detail* and examples that
> would be too verbose for the always-on prompt.

---

## 0. Tool access protocol — the meta-tool gateway

Every "real" tool is gated behind three meta-tools so the agent only pays
schema tokens for what it actually uses:

| Meta-tool | What it does |
|---|---|
| `list_tools` | Return all tools (or filter by keyword). One-line description each. |
| `learn_tool` | Return full JSON-schema + examples for a named tool. **Batch** names in one call to save round-trips. |
| `run_tool` | Execute the named tool with arguments. Refuses to run a tool you have not learned yet in this session. |

**Pattern at session start:**

```
list_tools({"filter": "memory"})      # discover what's available
learn_tool({"tools": ["get_lessons", "search_memory", "add_memory",
                      "add_lesson", "vote_memory"]})   # batch
get_lessons({})                       # then execute
```

---

## 1. Memory subsystem — your long-term brain

### Vault chain

Each clawdevbox installation registers one or more **vaults** — git repos that
hold memory artifacts under `<vault>/memories/`. Use `paths.get` to inspect
the live chain:

```
paths.get({})
→ {
    "vaults": [
      { "id": "my-notes",  "kind": "personal", "path": ".../personal-vault", "remote": null },
      { "id": "team-eng",  "kind": "team",     "path": ".../team-vault",     "remote": "git@..." }
    ],
    ...
  }
```

- **personal** vault — your "I learned" notes; usually no remote.
- **team** vault — "we agreed" knowledge; pushes to a shared remote for collaboration.

### On-disk layout

```
<vault>/
  memories/
    <project>/
      memories/   YYYY-MM-DD-<slug>.md     ← add_memory
      lessons/    YYYY-MM-DD-<slug>.md     ← add_lesson
      sessions/   YYYY-MM-DDTHH-MM-<slug>.md  ← add_session_summary
      wiki/       <free/path>.md           ← add_wiki_page
      .events/    <stem>.jsonl             ← append-only event sidecars (votes, edits, reinforcements)
```

`<project>` is the repo/codebase slug (`clawdevbox`, `myapp`, …); use
`_general` only for genuinely cross-cutting items.

Every write is auto-committed inline by the host. Team-vault commits push only
on `memory_sync` — call it periodically.

### The five document types

| Type | When to use | Tool |
|---|---|---|
| **memory** | Atomic durable fact. Cite specifics, give a reason. | `add_memory` |
| **lesson** | Heuristic with confidence; decays over 30d unless reinforced. | `add_lesson` |
| **session** | Structured retrospective of a session/feature. | `add_session_summary` |
| **wiki** | Curated documentation page at a chosen path. | `add_wiki_page` / `update_wiki` |

### Session-start preload: `get_lessons`

This is the always-on entry point. Call once per session before answering
anything substantive:

```
get_lessons({})
→ {
    "personal": [ { "title": "...", "content": "...", "confidence": 0.82, "votes": {"up":3,"down":0}, ... }, ... ],
    "team":     [ ... ],
    "context":  { "project": "clawdevbox", "projects_searched": ["clawdevbox", "_general"], ... }
  }
```

Returns the **top 10 personal + top 10 team** lessons (defaults; override with
`limit_personal` / `limit_team` up to 50 each) ranked by:

```
combined_score = decay_adjusted_confidence × (1 + log1p(max(0, up - down)))
```

So a lesson with confidence 0.6 and 2 upvotes (boost ≈ 2.1) ranks higher than
a lesson with confidence 0.9 and no votes (boost = 1.0). Auto-filters to the
**active project + `_general`** so you don't get cross-repo noise. Project is
auto-resolved from the `CLAWDEVBOX_PROJECT` env var, then the cwd basename.

### Task-time retrieval: `search_memory`

Query-driven hybrid search (BM25 by default, vector when configured):

```
search_memory({
  "query": "JWT validation",
  "scope": "all",                       # 'all' | 'personal' | 'team'
  "types": ["memory", "wiki"],          # omit to search all 4 types
  "project": "clawdevbox",              # optional filter
  "limit": 10
})
→ { "results": [ { "path": "...", "title": "...", "snippet": "...", "score": 0.84, ... } ], "total": 7 }
```

Use this whenever you're about to do substantive work and want to know "have
we solved this before?". For deep retrieval of one specific file, follow up
with `get_memory({"path": <path>, "scope": ...})` — returns full body +
folded event summary (votes, confidence, edit history).

### Writing — patterns

**Memory** (atomic fact with citations + reason):

```
add_memory({
  "content": "Always validate JWT exp before iat — clock skew bites otherwise",
  "scope": "team",
  "project": "clawdevbox",
  "citations": "src/auth/jwt.ts:42, RFC 7519 §4.1.6",
  "reason": "We've hit this twice in prod; future auth changes must guard exp first.",
  "category": "bug",                    # pattern|preference|architecture|bug|workflow|fact
  "concepts": ["jwt", "auth", "clock-skew"]
})
```

**Lesson** (confidence-scored heuristic; auto-reinforces on exact-content
duplicate):

```
add_lesson({
  "content": "When refactoring a hot loop, profile BEFORE optimizing — intuition is wrong 80% of the time",
  "scope": "personal",
  "project": "_general",
  "confidence": 0.7   # 0-1; default 0.5
})
```

**Wiki page** (curated documentation at a free-form path):

```
add_wiki_page({
  "path": "architecture/data-flow",     # → <project>/wiki/architecture/data-flow.md
  "content": "# Data flow\n\nThe pipeline...",
  "scope": "team",
  "project": "clawdevbox"
})
```

To edit an existing wiki page, use `update_wiki` with one of five operations:
`append`, `prepend`, `find_replace`, `replace_section`, `full_replace`. The
`find_replace` op supports an `expected_replacements` guard:

```
update_wiki({
  "path": "architecture/data-flow",
  "scope": "team",
  "project": "clawdevbox",
  "operation": "find_replace",
  "find_text": "redis cluster",
  "content": "redis sentinel",
  "expected_replacements": 1    # errors if it would change 0 or 2+ instances
})
```

### Curation — closing the loop

After any task, vote on memories you actually used:

- `vote_memory({"path": ..., "scope": ..., "direction": "up", "reason": "still accurate"})` — strengthens
- `vote_memory({..., "direction": "down", "reason": "stale, see new memory at X"})` — weakens
- Same shape for `vote_lesson` and `vote_wiki`. Per-actor latest vote wins.

For a wrong memory: vote DOWN **and** create a corrective `add_memory` in the
same turn, citing the original path in the `reason` field.

### Sync — `memory_sync`

```
memory_sync({"scope": "team"})        # 'team' | 'personal' | 'all'
→ { "outcomes": [ { "vault_id": ..., "pulled": true, "pushed": true, "conflict": false, ... } ], ... }
```

Runs fetch + pull --rebase + push for each vault that has a remote. If a wiki
conflict is detected and `auto_resolve_conflicts: "auto"` is set in
`memory-config.json`, attempts a sub-agent merge with safety gates and creates
revertible pre-merge tags. Default is `manual` — conflicts surface for human
resolution.

### Status — `memory_status`

```
memory_status({})
→ { "vaults": [...], "qmd": {...}, "git": {...}, "config": {...}, "identity": {...} }
```

One-shot health check. Run when something feels off or before a big
write/sync cycle.

---

## 2. Skills — reusable workflows you build yourself

A **skill** is a markdown file with frontmatter that another agent (or
future-you) reads to perform a recurring task. Skills are the unit of
*ability* in clawdevbox.

### When to author one (`skill.upsert`)

- You did the same multi-step thing **≥2× in one session**.
- The user said "remember how to do X" or "next time do it this way".
- A workflow is non-obvious and would take >30s to re-derive from scratch.
- A workflow has a critical "do not skip" step (TDD, lint, security check).

### Quality bar (frontmatter + body)

```markdown
---
name: my-skill-id                      # kebab-case
description: One sentence the agent will pattern-match on later when picking a skill.
when_to_use: Explicit trigger conditions — be specific ("Use when the user asks to deploy", "Before any database migration").
---

# My Skill

Numbered steps. Exact commands. Verification points after each.

1. Run X. Expect output Y. If not, abort and explain.
2. ...
```

### Discovery & reading

```
skill.list({"filter": "deploy"})       # discover by keyword
skill.read({"id": "my-skill"})         # full markdown + parsed frontmatter
skill.upsert({                          # author or update
  "scope": "project",                  # 'project' | 'global'
  "id": "my-skill",
  "content": "---\nname: ...\n---\n# ..."
})
```

Plugin-shipped skills are read-only — copy to project scope to customize.

### Feedback

`skill.feedback.record` captures privacy-safe usage signals. `skill.feedback.aggregate`
rolls them up. `skill.feedback.pending` surfaces skills the system thinks need
human attention (promotion/demotion candidates).

---

## 3. Recipes — declared multi-step pipelines

A **recipe** is a YAML file declaring a sequence of steps with a state
machine. Where a skill is documentation to follow, a recipe is *executable*.

### Lifecycle

```
recipe.list({})                                # discover
recipe.read({"id": "my-recipe"})               # see step plan
recipe.begin({"id": "my-recipe", "args": {...}})  # start IN THE CURRENT SESSION
recipe.steps.update_status({                   # advance one step
  "instance_id": <auto-injected via env>,
  "step_id": "build",
  "status": "in_progress" | "done" | "failed" | "skipped"
})
recipe.update_steps({                          # mutate the plan mid-run
  "instance_id": ...,
  "operations": [
    {"op": "add",    "step": {...}},
    {"op": "update", "step_id": "build", "patch": {...}},
    {"op": "remove", "step_id": "old"}
  ]
})
recipe.instance_info({})                       # read CLAWDEVBOX_RECIPE_INSTANCE_ID
recipe.kill({"instance_id": ...})              # terminate
recipe.view_url({"instance_id": ...})          # browser-attach to the hidden pty
recipe.list_running({})                        # live instances
```

Use a recipe when the workflow is **deterministic and repeatable** — same
inputs, same shape of output every time. For one-off multi-step work, do it
inline. For "the user keeps asking for this", elevate to a recipe.

---

## 4. Triggers — schedule-driven or event-driven entry points

A **trigger** binds a recipe (or a free-form prompt) to a cron schedule or an
event source. Use triggers for unattended recurring work: daily standup,
hourly metric pulls, on-commit lint, etc.

### TYPE vs REGISTERED instance

| Concept | What it is |
|---|---|
| **Trigger TYPE** | A *template* with default params, a script that resolves the prompt, and a manifest. Shipped by plugins or authored by agents via `trigger.create_template`. |
| **Registered instance** | A live binding: `(type_id, params, cron, enabled)`. Lives in `.clawdevbox/triggers.json`. |

### Author a TYPE (one-off or reusable)

```
trigger.create_template({
  "scope": "global",                     # or 'project'
  "id": "daily-pr-summary",
  "manifest": {
    "name": "Daily PR Summary",
    "description": "Summarize open PRs each morning",
    "params_schema": { "type": "object", "properties": { "owner": {"type": "string"} }, "required": ["owner"] }
  },
  "template": "Generate a markdown summary of {{owner}}'s open PRs and post to inbox."
})
```

### Register an instance

```
trigger.register({
  "type_id": "daily-pr-summary",
  "params": { "owner": "kirmad" },
  "cron": "0 9 * * MON-FRI",             # 9am weekdays
  "enabled": true
})
```

Other tools: `trigger.list_types`, `trigger.list_registered`,
`trigger.update_params`, `trigger.enable` / `disable`, `trigger.fire` (manual),
`trigger.test` (dry-run with synthesized envelope — NON-mutating).

For one-off ad-hoc registrations, you can also pass `script` or `prompt`
inline instead of `type_id`.

---

## 5. Inbox — async communication with the user

The user doesn't watch your terminal. They read the inbox panel. Surface
anything they should know about there.

### Idempotent upsert pattern

```
inbox.upsert({
  "id": "daily-standup-2026-06-08",      # stable id → updates rather than spam
  "title": "Daily standup — 8 open PRs, 2 need review",
  "description": "Full markdown body here...",
  "severity": "info",                    # 'info' | 'warning' | 'question' | 'error'
  "links": [ {"label": "PR #42", "url": "..."} ],
  "tags": ["standup"]
})
```

### Threading

```
inbox.reply({                            # add a follow-up to the same item
  "id": "daily-standup-2026-06-08",
  "body": "Update: PR #42 was merged at 11:02am"
})
inbox.read({"id": ...})                  # fetch full body when responding
inbox.set_state({"id": ..., "state": "open" | "addressed" | "snoozed"})
inbox.snooze({"id": ..., "until_ms": 1733241600000})
inbox.archive({"id": ...})
```

### Severity guide

| Severity | When |
|---|---|
| `info` | Completion summaries, recurring digests, FYI |
| `warning` | Something the user should know but isn't blocking (drift, deprecation, soft failure) |
| `question` | Need a decision; for binary/small-set use `approval.request` instead |
| `error` | Hard failure that needs attention |

### Anti-pattern

Don't spam the inbox with progress chatter — that's what `update_status` is
for (terminal panel). Only items worth interrupting human attention.

---

## 6. Approval — blocking decisions

For binary or small-set decisions where you must wait for the user, use
`approval.request`. It's discoverable in the UI and the response is
structured.

```
approval.request({
  "title": "Destructive migration: drop users.legacy_field?",
  "description": "This column has been unused for 6 months but I want to confirm before dropping.",
  "options": [
    {"value": "yes",       "label": "Drop it"},
    {"value": "no",        "label": "Keep for now"},
    {"value": "snapshot",  "label": "Take a snapshot first, then drop"}
  ],
  "allow_freetext": false
})
```

The call suspends your turn until the user answers. Then either you resume
(if the harness supports it) or a fresh turn arrives with the answer in
context. Use `approval.list_pending` to see what's waiting; `approval.resolve`
when answering programmatically.

Prefer `approval.request` over plain-text "What should I do?" — it
guarantees structure and visibility.

---

## 7. Sessions — parallel sub-agent work

```
session.send({                           # spawn OR resume
  "prompt": "Investigate why test X is flaky in module Y",
  "workspace_path": "C:/git/myrepo",
  "session_id": null                     # null=spawn fresh; otherwise resume that session
})
→ { "ok": true, "mode": "spawn" | "resume", "instance_id": ..., "session_id": ... }

session.read({"session_id": ..., "since": <cursor>})   # incremental scrollback
session.list({})                                       # live + archived
session.kill({"session_id": ...})                      # terminate
```

`session.send` returns immediately — the spawned session runs in the
background. Poll with `session.read` (passing the `cursor` from the previous
read) for incremental output, or simply attach via the UI's terminals panel.

Use sessions for **independent** sub-tasks: investigate module A while you
work on module B; produce a long-running report while the user keeps chatting
with you. Don't use it for sequentially dependent work — just do that inline.

---

## 8. Workspace, paths, notify, ui

| Tool | Use |
|---|---|
| `workspace.create` / `list` / `get` / `current` | Manage multi-workspace setups (a workspace = a registered `.clawdevbox/` dir) |
| `paths.get` | Resolve global dir / project dir / workspaces root / vault chain |
| `notify.send` | Browser push notification to every subscribed device — high-signal only |
| `ui.notify` | Fire an SSE event for the home page to re-render — for live UI updates |
| `update_status` | Three-line status update for the terminal panel (task / subtask / status) |
| `thread.*` | Lower-level thread mgmt (spawn/append_message/read/cancel/wake) — most agents use the higher-level `session.*` tools instead |

---

## Common patterns

### Pattern A — Capture a lesson learned

```
# After realizing in-flight that lessons should always include a code citation:
add_lesson({
  "content": "Always include a file:line citation in lesson body — anchorless lessons drift",
  "scope": "personal",
  "project": "_general",
  "confidence": 0.7
})

# Later, having done the same thing twice more:
vote_lesson({                  # reinforce (no need to re-derive; per-actor vote)
  "path": "memories/_general/lessons/2026-06-07-always-include-citation.md",
  "scope": "personal",
  "direction": "up",
  "reason": "Just hit a third drift case; pattern confirmed."
})
```

### Pattern B — Publish a wiki page that may need future edits

```
add_wiki_page({
  "path": "architecture/data-flow",
  "content": "# Data flow\n\n## Producer\n...\n\n## Consumer\n...",
  "scope": "team",
  "project": "clawdevbox"
})

# A week later, only the Producer section changed:
update_wiki({
  "path": "architecture/data-flow",
  "scope": "team",
  "project": "clawdevbox",
  "operation": "replace_section",
  "section": "## Producer",
  "content": "(new producer text)"
})
```

### Pattern C — Spawn a parallel investigation

```
session.send({
  "prompt": "Read mcp-server/src/tools/memory.ts and produce a 10-bullet summary of every exported handler. Save to memories/clawdevbox/wiki/refs/memory-handlers-cheatsheet.md.",
  "workspace_path": "C:/git/clawdevbox",
  "session_id": null
})
# returns instantly; continue with the main task
# poll session.read or just attach via the UI
```

### Pattern D — Wire a daily standup trigger

```
trigger.create_template({
  "scope": "global",
  "id": "daily-standup",
  "manifest": { "name": "Daily Standup", "description": "Workspace-wide standup at 9am" },
  "template": "Generate a 5-bullet standup for {{workspace_id}} — open PRs, recent commits, inbox items needing attention, blocked threads, suggested next focus. Upsert to inbox with id 'standup-{{date}}'."
})
trigger.register({
  "type_id": "daily-standup",
  "params": { "workspace_id": "main" },
  "cron": "0 9 * * MON-FRI",
  "enabled": true
})
trigger.test({"id": <returned-id>})       # dry-run to verify
```

### Pattern E — Handle a destructive operation

```
approval.request({
  "title": "About to git push --force to main",
  "description": "Rebase squashed 3 commits into 1. Force-push will rewrite shared history. Continue?",
  "options": [
    {"value": "yes", "label": "Force-push"},
    {"value": "no",  "label": "Cancel — leave commits stacked"}
  ]
})
# wait for user; act on result
```

---

## Anti-patterns

- **Spamming the inbox** with progress updates. Use `update_status` for the
  terminal panel; only inbox items worth interrupting attention.
- **Duplicate memories**. Always `search_memory` before `add_memory`; if a
  near-duplicate exists, vote it or reinforce a lesson, don't add a parallel.
- **Skipping `get_lessons`** at session start. The whole point of accumulated
  lessons is that future-you reads them before re-deriving.
- **Fat memories**. One fact per file. A memory titled "Things I learned about
  auth" is a wiki page, not a memory.
- **Inline reinvention of recipes**. If a recipe exists for the workflow, run
  it via `recipe.begin` — don't re-implement it as ad-hoc steps.
- **Vault-relative path confusion**. Paths returned by `add_*` and
  `search_memory` are vault-relative and start with `memories/`. The same
  paths are accepted by `get_memory` and `vote_*` either with or without that
  prefix — but be consistent within one call chain.
- **Forgetting to vote at end-of-task**. Memories you used and didn't vote on
  drift silently; memories that should have been flagged wrong stay wrong.
  Closing the curation loop is what makes the brain self-correct.

---

## Cheat sheet

```
SESSION START
  list_tools({"filter":"memory"}) → learn_tool({...batch...}) → get_lessons({})
  → skill.list({}) optional

ON USER REQUEST (substantive)
  search_memory({"query": <keywords>, "types": ["memory","wiki"]})
  → reuse if found, else proceed

DURING WORK
  update_status({"task_title":..., "subtask_title":..., "status":...})
  session.send for parallel sub-tasks

POST-TASK
  add_memory / add_lesson / add_session_summary for what you learned
  add_wiki_page or update_wiki for documentation
  skill.upsert if a workflow repeated ≥2x

END-OF-TASK
  vote_memory / vote_lesson / vote_wiki on memories you actually used
  inbox.upsert for anything user-facing
  memory_sync if team vault has a remote
```
