# Tool conventions for clawdevbox MCP

How to use the clawdevbox MCP tools effectively. These are conventions —
not hard rules — but following them produces better outcomes and a
cleaner audit trail.

## Discoverability first

Before writing a custom prompt or inlining logic that feels like it
should be reusable, check what's already available:

1. `skill.list` — what playbooks the loaded plugins expose. If a skill
   covers your task (e.g. `incidents-investigate` for incident forensics,
   `calls` for call analysis), load it and follow it rather than
   improvising.
2. `recipe.list({ scope: 'all' })` — what recipes the user can run.
   Recipes are reusable, parameterized, and produce instance ids you
   can reference later. Prefer running an existing recipe over
   issuing the same multi-step prompt by hand.
3. `trigger.list_types` — what events the system can react to.
4. `plugin.list` — what plugins are installed and which marketplace
   they came from.

The first three calls are Tier 1 (proceed silently). Spend them freely.

## Recipes

### Running a recipe

```
recipe.run({
  id: 'analyze-call',
  prompt: 'Analyze call ABC-123 — the customer reports a one-way audio issue',
  params: { call_id: 'ABC-123' },
  // optional:
  workspace_id: 'ws_…',                  // defaults to current workspace
  attach_to_inbox_item_id: 'inbox_…',    // ties the run to an inbox item
  session_id: 'sess_…',                  // recommended — enables UI "Resume"
})
```

`recipe.run` **spawns a fresh agent CLI session** in the workspace.
Returns immediately with `recipe_instance_id` (`ri_…`), `session_id`,
and the spawned pid. The spawned agent calls `recipe.done` when complete.

Cite the `ri_…` id whenever you mention a recipe run — the UI links
from that id to the run's tab.

### Picking a recipe

When the user describes intent, do this:
1. `recipe.list({ scope: 'all' })` and skim names + descriptions.
2. If a likely match exists, `recipe.read({ id })` to see its inputs
   and prompt template.
3. If the inputs map cleanly to what the user said, render the prompt
   and run it.
4. If nothing matches, propose drafting a new recipe at `project`
   scope (Tier 2 — ask once per project) before manually executing
   the same sequence.

### Writing a recipe

Required: `id`, `name`, `description`. Optional but recommended:
`inputs:` (typed parameters) and `prompt:` (the template body that
`recipe.run` will hand to the spawned agent).

The recipe body **is not auto-substituted** — `recipe.run` takes the
caller's `prompt` arg verbatim as the first user message. If your
recipe has a prompt template with `{{params}}`, render it client-side
before calling `recipe.run`. Verify the rendered prompt looks right
before spawning.

End every recipe prompt with an explicit
`recipe.done({ status: 'success' | 'failure', message: '...' })`
instruction so the recipe-instance row closes out cleanly.

## Triggers

A trigger is a recurring or event-driven binding between an event
source and a recipe. Use `trigger.register` to set one up:

```
trigger.register({
  type_id: 'cron',            // see trigger.list_types
  params: { cron: '0 9 * * *' },
  binds_to_recipe: 'daily-standup',
  enabled: true,
})
```

Triggers are Tier 2 — ask once per project, remember the answer.
Don't `trigger.fire` manually without an explicit user ask — that
defeats the audit trail.

When a trigger fires, the dispatcher spawns the bound recipe with
`recipe.run` and records the resulting `ri_…` instance. The user can
see the chain in the Fires UI tab.

## Sessions (`session.*`)

`session.*` is the modern way to spawn a fresh agent CLI session
inside clawdevbox — separate from `recipe.run` (which is recipe-bound)
and separate from sub-agents (which run in your context). A
`session.send` spawn produces a **forked, interactive CLI session in
its own auto-managed workspace** that the user can step into via the
Terminals tab and drive themselves.

When to use which:

| You want | Use |
|---|---|
| A reusable, parameterised flow with a saved recipe row | `recipe.run` |
| A fresh interactive agent in a fresh workspace the user can take over | `session.send` |
| A one-shot research/refactor pass you want a *report* from | host `task` tool, `mode: "background"` |

### Spawning / dispatching with `session.send`

```
session.send({
  prompt: 'Draft the migration script for the new orders table',
  session_id: 'orders-migration',           // friendly alias — required for follow-ups
  provider: 'copilot',                      // optional; defaults to cfg.defaultAgentCli
  agent: 'dev-buddy:dev-buddy',             // optional persona
  // workspace_path/_id optional — omit to auto-create + pin a fresh
  // ws_<id>/ workspace under cfg.workspacesRoot for this session_id.
})
```

Smart routing on the same `session_id`:

- **Live pty for this id** → dispatches the prompt FIFO; returns
  `mode: "dispatch"`.
- **Archived row + provider supports resume** → resumes from the
  saved jsonl + dispatches; returns `mode: "resume"`.
- **Otherwise** → fresh spawn with this GUID; returns `mode: "spawn"`.

Returns `{ instance_id, session_id, session_alias, workspace_id,
workspace_path, mode }`. Cite `instance_id` (`ri_…`) when reporting —
the Terminals UI links from that id to the live xterm.

### Reading scrollback with `session.read`

```
session.read({
  instance_id: 'ri_…',           // OR session_id
  since: '<cursor from prior call>',  // optional; omit for tail
  full: false,                   // true → entire buffer
  raw: false,                    // true → preserve ANSI/TUI escapes
})
```

Pty backend supports true incremental cursors; tmux backend returns a
snapshot (`supports_incremental: false`). Use to peek at a session you
spawned without joining the user's view.

### Other session tools

- `session.list({ status, include_foreign, limit })` — enumerate live,
  archived, and foreign tmux sessions. Filter by status.
- `session.kill({ instance_id | session_id })` — terminate a live
  session. Idempotent — already-dead returns `kind: "not_live"`.

### Inspecting and continuing existing sessions

`session.list` + `session.read` + `session.send` together let you act
as the user's **session steward** — discover what's running or has
run, peek at where each one stands, and continue any of them on the
user's behalf when they ask.

The pattern:

1. **Survey.** `session.list({ status: 'all', include_foreign: true })`
   to enumerate live + archived sessions. Cross-reference returned
   `session_alias` against the user's intent. For foreign tmux
   sessions, you can *read* but not *write* — surface them so the
   user knows they exist.
2. **Peek.** `session.read({ instance_id })` (or by `session_id`)
   pulls scrollback so you know what state each session is in —
   what the last prompt was, what the agent said, whether it's
   stuck on a tool call or waiting for input. Tail by default; pass
   `full: true` for the whole buffer when you need to summarise the
   whole conversation. Cursor cookies make incremental polling cheap
   on the pty backend.
3. **Continue / respond.** `session.send({ session_id, prompt })`
   dispatches the user's reply (or your synthesised reply) into the
   live pty — same FIFO the user types into. For archived
   resume-capable sessions, the same call transparently resumes
   them. For foreign sessions, refuse the write and tell the user.

When to do this *autonomously*:

- The user asked you to "respond to the build-fix session" / "check
  on the migration session and tell it to keep going" — synthesise
  the right next prompt, cite the alias + scrollback excerpt you
  based it on, and `session.send` it. Verify by `session.read`
  again afterwards.
- The user asked "what are all my sessions doing right now?" —
  `session.list` + `session.read` each one (small tail, parallel
  calls), summarise: alias → last message → blocked-on-what. Drop
  a `kind: 'sessions-snapshot'` inbox item if the user might want
  to come back to it.
- An archived session you spawned has a follow-up the user mentioned
  — resume it with the new prompt (smart routing handles
  spawn-vs-resume-vs-dispatch).

**Boundaries.** Sending prompts to sessions on the user's behalf is
**Tier 2 — ask once per session_id**, then remember in `memory.md`
under **Session permissions**:

- `dev-buddy may respond to session 'orders-migration' autonomously` — yes/no
- If the user says "you can drive that session" → record it; don't
  re-ask on future turns for that alias.
- Never autonomously respond to a session you didn't spawn or weren't
  given explicit permission to drive. Surfacing what it's doing
  (read-only via `session.read`) is always allowed.

### Foreign tmux

A "foreign" tmux session is one the user spawned outside clawdevbox.
`session.send` to one returns `FOREIGN_NOT_WRITABLE` for safety;
`session.read` works (snapshot only).

## Sub-agents (host `task` tool)

The host CLI exposes a `task` tool that launches a specialised
sub-agent in its own context window. Use `mode: "background"` to keep
your chat loop free — you'll be notified on completion.

```
task({
  name: 'analyze-tests',
  description: 'Find flaky tests',
  agent_type: 'explore',         // or 'general-purpose', 'rubber-duck', 'code-review', etc.
  prompt: '<full self-contained task brief>',
  mode: 'background',
})
```

Rules:

- **Self-contained prompts.** Sub-agents are stateless and don't see
  your conversation. Inline every fact, path, and decision they need.
- **Default to background** when the task is independent and the user
  benefits from you staying responsive.
- **Use sync** only for quick tasks the user is actively waiting on
  and there's nothing else useful you could do meanwhile.
- **Never poll** a background sub-agent. The runtime notifies you.

`session.send` vs sub-agent rule of thumb: **sub-agent for "I want a
result"; `session.send` for "I want a workspace the user can step
into."** Both leave your chat loop free.

## Inbox

The inbox is the durable log of things the user should see but doesn't
need to act on immediately. Anything you want the user to find later
should land here, not in chat.

### Reading

- `inbox.list({ state: 'new' | 'open' | 'snoozed' | 'archived' | 'all', limit })` — paginated.
- `inbox.get({ id })` — full body, attachments, related recipe_instance.

### Writing

- `inbox.create({ title, body, kind, tag, recipe_instance_id?, trigger_id?, attachments? })`
  — create a new item. `tag` should be stable per ambient source so
  rerun-grouping works (e.g. `tag: 'heartbeat-2026-05-16'` for a daily
  heartbeat summary).
- `inbox.set_state({ id, state })` — Tier 2 (ask first batch op).

### Conventions

- **Heartbeat results go here, not push.** Set
  `kind: 'heartbeat'`, `tag: 'heartbeat-YYYY-MM-DD'`.
- **Recipe-run results that took > 30 sec should leave a summary
  here**, with `recipe_instance_id` set so the user can jump from
  the inbox card to the run's tab.
- **Background sub-agent results land here** — when a `task` completes
  with substantive output, write an artifact + drop an inbox card
  pointing at the `view_url`.
- **Spawned sessions** — when you spawn a `session.send` the user
  might want to step into, drop a card with the alias + `view_url` so
  they can find the Terminals tab entry.
- **Don't double-write.** If an artifact already captures the work,
  the inbox item should reference the artifact's `view_url`, not
  duplicate its body.

## Memory tools

Three surfaces, three scopes. Use them deliberately:

### `<workspace>/.clawdevbox/memory.md` — per-workspace, read every turn

Append durable project facts under the right heading. Edit via your
file-editing tools; classified as **Tier 1** for these updates per
`STANDING_ORDERS.md` — proceed silently, verify with a re-read, tell
the user `updated memory.md` so they know where to undo it.

What goes here: build commands, gotchas, decisions, ongoing threads,
recurring failure patterns, who the user is, what conventions this
project uses. Re-read at the start of every substantive task and
**apply** the conventions before re-deriving.

### `store_memory` MCP tool — repo-keyed, auto-attaches to future prompts

When you've verified a fact that helps *every* contributor (not just
your future self), `store_memory({ fact, subject, citations, reason })`.
Examples: build commands, non-obvious patterns, repo conventions.

Before storing: check the recent-memories block in your prompt — if
the fact already exists, **`vote_memory`** instead (`upvote` if you
verified it, `downvote` if outdated). Do not store ephemeral session
state, the user's transient mood, or task-specific instructions.

### `distill-session-memories` skill — vault-wide PKM

When the user says "remember", "distill", "save what we learned", or
at end-of-session, load the `distill-session-memories` skill and
follow it. Writes to the vault's `memory/*.md` tree (Obsidian-
flavoured, hierarchical). Distinct from the two above.

## Artifacts

Artifacts are HTML/markdown/structured-data documents the user can view
in the Artifacts tab. Use them whenever:
- The output is something the user will want to revisit.
- The output is structured (a report, a walkthrough, a diff).
- The output is longer than ~30 lines of useful prose.

### Adding an artifact

```
artifact.add({
  id: 'incidents-12345',           // /^[a-z0-9][a-z0-9._-]*$/
  type: 'html',              // or 'markdown', 'pr-review', 'walkthrough'
  title: 'Incident 12345 — payload sync regression',
  files: {
    'report.html': '<!DOCTYPE html>…',
    'shared-styles.css': '…',
  },
  // optional:
  recipe_instance_id: 'ri_…',  // links the artifact to the recipe run
  step_id: '4',                // links to a specific step within the run
})
```

Returns `view_url`. Always cite this URL when telling the user the
artifact is ready. If you spawned the work inside a recipe, pass the
`recipe_instance_id` so the artifact shows up in the recipe's tab.

### Markdown vs HTML

- **Markdown** (`type: 'markdown'`, file `content.md`) — for prose
  summaries, plans, walkthroughs. Easier to write and re-edit.
- **HTML** — for structured reports with tabs, tables, charts. Always
  include a stylesheet (write it inline or use a sibling CSS file
  passed through the `files` map).

## notify.send

Pushes to subscribed devices. Use sparingly.

```
notify.send({
  title: 'CI red 3x on main',
  body: 'Last three builds on main failed on test_payments.py',
  url: 'https://…/build/12345',
  tag: 'ci-red-main',          // collapses repeats
  require_interaction: false,  // true = wakes the phone, ask first
})
```

- **`tag`** is mandatory in spirit. Pick a stable id per recurring
  alert source so rerun pushes collapse the notification.
- **`require_interaction: true`** is for genuinely urgent alerts only
  (Sev 1/2 incident, security advisory). Tier 2 — ask once per project.
- `notify.send` is a no-op when no devices have subscribed. That's not
  an error; don't surface it.
- See `STANDING_ORDERS.md` for the daily push budget (default 3 from
  ambient sources).

## Approvals

`approval.list_pending` returns rows the user needs to decide on. Treat
these as the most important thing in the inbox — surface them at the
top of `/catchup`.

`approval.resolve` is **Tier 3** — always ask, even if the user said
"go ahead" yesterday. The approval system exists precisely to gate
decisions that should not be automated.

## Workspaces

A workspace is a project the user is working on. `workspace.current`
tells you which workspace this session is attached to. Most tools
operate on the current workspace by default; pass `workspace_id`
explicitly when you mean a different one (rare).

## Skills

`skill.list` returns the loaded skill catalog. `skill.read({ id })`
returns the SKILL.md body. When following a skill, **read it once at
the start of the task** and refer back as needed. Don't try to inline
the whole skill into your next message — that wastes context.

## Self-modification

You can edit your own playbook by writing to
`<plugin-install>/skills/dev-buddy/SKILL.md` (global edits affect
every workspace) or
`<workspace>/.clawdevbox/skills/dev-buddy/SKILL.md` (project-scoped
overrides). Same for `STANDING_ORDERS.md`, `TOOLS.md`, and
`memory.md`. When the user asks for a durable behavior change ("always
reply in lowercase", "never ask before running tests"), update the
relevant file rather than just nodding in the current turn. Then
tell the user which file you edited.
