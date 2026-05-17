# Tool conventions for clawdevbox MCP

How to use the clawdevbox MCP tools effectively. These are conventions —
not hard rules — but following them produces better outcomes and a
cleaner audit trail.

## Discoverability first

Before writing a custom prompt or inlining logic that feels like it
should be reusable, check what's already available:

1. `skill.list` — what playbooks the loaded plugins expose. If a skill
   covers your task (e.g. `icm-investigate` for incident forensics,
   `cfv` for call analysis), load it and follow it rather than
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
- **Don't double-write.** If an artifact already captures the work,
  the inbox item should reference the artifact's `view_url`, not
  duplicate its body.

## Artifacts

Artifacts are HTML/markdown/structured-data documents the user can view
in the Artifacts tab. Use them whenever:
- The output is something the user will want to revisit.
- The output is structured (a report, a walkthrough, a diff).
- The output is longer than ~30 lines of useful prose.

### Adding an artifact

```
artifact.add({
  id: 'icm-12345',           // /^[a-z0-9][a-z0-9._-]*$/
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
