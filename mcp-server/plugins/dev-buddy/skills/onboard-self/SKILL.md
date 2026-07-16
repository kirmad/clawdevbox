---
name: onboard-self
description: Deep self-onboarding for dev-buddy. Interviews the user about identity, voice, work patterns, and the repos they live in; seeds workspace identity.md / soul.md / memory.md; surveys available skills, recipes, plugins, and triggers; then sets up the triggers the user wants and drafts new workspace-scoped skills for recurring tasks not already covered. Run once on first contact, or whenever the user wants to recalibrate. Idempotent — preserves existing answers and only fills gaps.
---

# Onboard Self

The deep, first-run calibration between dev-buddy and the user. Where
`onboard-project` is a 30-second workspace scan + 3 quick questions,
this skill is the full setup:

- **Who you are** in this workspace → `<workspace>/.clawdevbox/identity.md`
- **How you talk** in this workspace → `<workspace>/.clawdevbox/soul.md`
- **What the user needs to know about the project** → `<workspace>/.clawdevbox/memory.md`
- **What the user actually wants from you** → matched against existing
  skills + recipes; new workspace-scoped skills drafted for the gaps;
  triggers wired up for the ambient bits.

By the end, you have everything you need to handle whatever the user
asks next — without re-asking the same questions every session.

Run when:

- The user types `/onboard-self`.
- The user says "let's start fresh," "calibrate yourself," or "set
  yourself up here."
- The workspace has no `identity.md`, `soul.md`, or `memory.md` and the
  user is asking what dev-buddy can do.
- Plugin defaults are out of date relative to what the user has told you
  in chat (e.g. they renamed themselves but `identity.md` was never
  written).

This skill is **interactive**. Expect 3–5 user turns. Don't produce an
artifact at the end — onboarding output belongs in chat and on disk,
not in a viewer.

## Inputs (ask or infer)

- `depth` *(default `"full"`)* — `"full"` runs every phase; `"identity-only"`
  skips trigger setup and new-skill drafting (just identity/soul/memory);
  `"recalibrate"` keeps every existing file and only re-asks questions
  whose answers feel stale.
- `auto_proceed` *(default `false`)* — when `true`, skip the recap gate
  at the end of Phase 5 and write everything immediately. Use only when
  another setup flow already has explicit consent.

## Required reading before starting

Re-read these unless you already loaded them this turn:

- `IDENTITY.md` and `SOUL.md` (sibling assets of the `dev-buddy` skill)
  — the plugin defaults you'll diff against when seeding workspace
  overrides.
- `MEMORY-TEMPLATE.md` (sibling) — the base for `memory.md`.
- `STANDING_ORDERS.md` (sibling) — Tier 1/2/3 rules.
- `TOOLS.md` (sibling) — MCP conventions, especially `skill.upsert`,
  `recipe.upsert`, and `trigger.register`.
- The workspace overrides if any already exist:
  `<workspace>/.clawdevbox/identity.md`,
  `<workspace>/.clawdevbox/soul.md`,
  `<workspace>/.clawdevbox/memory.md`.

When `depth: "recalibrate"`, **don't overwrite** existing answers
without confirmation — read them first, surface them as the current
state during the relevant phase, and only edit what the user asks to
change.

## Phase 1 — Inventory what's available

Run these in parallel. All Tier-1 reads — proceed silently.

- `workspace.current()` — name + id of this workspace.
- `workspace.list()` — other workspaces the user already has open.
- `plugin.list()` — installed plugins (drives which domain skills /
  recipes / trigger types are loaded).
- `skill.list({ scope: 'all' })` — every skill in scope. Read names
  + descriptions; don't load bodies yet.
- `recipe.list({ scope: 'all' })` — every recipe the user could run
  or bind to a trigger.
- `trigger.list_types()` — every event source (cron, webhook,
  inbox-watch, file-watch, etc.).
- `trigger.list_registered()` — what's already wired up here.

Hold this snapshot in mind. You'll consult it in Phase 4 and again
in Phase 8.

## Phase 2 — Scan the workspace (background context)

Use the same 30-second scan as `onboard-project` Step 1 — just enough
to populate the **Project** and **Stack & conventions** sections of
`memory.md`. Don't read the whole tree; you want a snapshot, not a
full audit.

- `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` /
  `pom.xml` / `*.csproj` → language, package manager, scripts.
- `README.md` (first 100 lines) → what the project is.
- `.github/workflows/*.yml` (names only) → CI presence.
- `git remote get-url origin` (if git is available) → repo URL.

If `onboard-project` has already been run, much of this will already
be in `memory.md`. Read what's there and only fill gaps.

## Phase 3 — Interview the user

Five focused questions, **one consolidated turn** (not five separate
ones). Format the question block so the user can answer inline with
short replies — they shouldn't need to write essays.

```
I'm setting myself up for this workspace. A few things I can't infer
on my own:

1. **You.** What should I call you? (first name or handle is fine.)
   What's your time zone? Roughly what hours are you usually at the
   keyboard?

2. **Your role.** What do you do day-to-day — backend SWE, SRE, data,
   PM, security, mixed? Knowing this helps me pick the right skill
   when you describe a task.

3. **Repos you live in.** Beyond this workspace, what other repos /
   projects do you context-switch into often? Names + a 1-line
   purpose each is plenty.

4. **How I should talk to you.** Terse or verbose? Bullets or prose?
   Emoji OK? Language other than English? Anything that would make
   me actively annoying if I got it wrong?

5. **What you want from me.** Some patterns:
   - "Triage my inbox each morning."
   - "Investigate incidents on call XYZ."
   - "Watch this repo's CI and ping me on red."
   - "Review my PRs before I send them."
   - "Track these specific work items / threads across sessions."
   - "Just stay quiet until I ask."

   Pick whichever apply — or describe in your own words.
```

Wait for the user's answers. Do not proceed past Phase 3 without
them. Partial answers are fine — record what they gave and leave the
rest as `(empty)` in `memory.md`. Don't badger.

If the user already has populated `identity.md` / `soul.md` /
`memory.md` (i.e. `depth: "recalibrate"`), show them the current
values and ask which to change rather than re-asking blind.

## Phase 4 — Map expectations onto capabilities

For each work pattern the user named in Q5, find the **best existing
fit** from the Phase-1 snapshot. Don't draft anything new yet — try
to reuse what's already there.

| User said something like…                       | Likely existing fit                                                                    |
|--------------------------------------------------|-----------------------------------------------------------------------------------------|
| "Investigate incidents"                          | `incidents-*` skills/recipes if installed; `analyze-call-mcp` (calls) for Teams call forensics. |
| "Brief me each morning"                          | `daily-standup` recipe + a weekday cron trigger.                                        |
| "Keep an eye on the inbox"                       | `heartbeat-pulse` recipe + a `*/30 * * * *` cron trigger.                              |
| "Review my PRs"                                  | `analyze-pr-comment`, `summarize-pr-changes` (ado plugin) if installed.                |
| "Track work across repos"                        | `workspace.list` + repo links recorded in `memory.md`.                                 |
| "Code reviews before I push"                     | `requesting-code-review` (built-in skill).                                              |
| "Debug things systematically"                    | `systematic-debugging` (built-in skill).                                                |
| "Quiet until asked"                              | No automation. `catchup` + `run-task` on demand.                                       |

For each match, capture: `pattern` → `(skill_id | recipe_id)`, plus
a proposed trigger if the pattern is ambient (heartbeat, standup,
CI-watch, etc.).

Note any pattern with **no** match — those are candidates for Phase 8
(new workspace-scoped skill drafting). Don't promise to fix
everything; some user asks are out of scope (e.g. "write my code for
me" is not a skill-shaped task).

## Phase 5 — Recap & confirm

Before writing anything to disk, surface the plan to the user as a
single block. This is the consent gate for the Tier-2 batch (triggers
+ new skills + recipe upserts). The Tier-1 file writes (identity /
soul / memory) are folded into the same recap so the user can see
everything you're about to do.

```
Here's what I'll do — say `yes`, `edit`, or which parts to skip:

**Write `<workspace>/.clawdevbox/identity.md`**
- call you `<name>`
- avatar: `<emoji or none>`
- <any other identity changes from Phase 3>

**Write `<workspace>/.clawdevbox/soul.md`**
- voice: <terse|verbose|formal|casual>
- emoji: <on|off|sparingly>
- language: <if non-English>
- <any other style changes>

**Write `<workspace>/.clawdevbox/memory.md`**
- project: `<inferred name>` — `<repo url>`
- user: `<name>`, tz `<tz>`, hours `<window>`, role `<role>`
- other repos you live in: <list>
- work patterns I'll handle: <list with matched skill/recipe ids>

**Triggers to register** (Tier 2 — asking once):
- `<cron>` → `<recipe_id>` — <one-line purpose>
- …

**New workspace-scoped skills to draft** (Tier 2 — asking once):
- `<id>` — <one-line purpose, for the pattern from Q5 with no
  existing fit>
- …

Look right?  (yes / edit X / skip triggers / skip new skills / cancel)
```

If `auto_proceed: true`, skip this gate. Otherwise wait. Accept
partial approvals: "yes to identity and memory, skip triggers" is
valid — write only the approved items.

## Phase 6 — Seed identity.md, soul.md, memory.md

Tier-1 writes per `STANDING_ORDERS.md`. Do them in this order so each
verification is meaningful and one failure doesn't poison the next.

### 6a — identity.md

1. If `<workspace>/.clawdevbox/identity.md` exists, read it as the
   base. Otherwise read the plugin default at the sibling asset
   `IDENTITY.md` (via `skill.read({ id: 'dev-buddy', scope: 'plugin:dev-buddy' })`
   and pull the file from the resolved plugin dir).
2. Apply only the user's stated identity changes. Preserve every
   other section verbatim.
3. Write the workspace file.
4. Verify with `view` — confirm the change is present.
5. Report: `updated <workspace>/.clawdevbox/identity.md`.

### 6b — soul.md

Same pattern with `<workspace>/.clawdevbox/soul.md` and the plugin
default at sibling asset `SOUL.md`.

### 6c — memory.md

1. If the file exists, read it. Otherwise copy `MEMORY-TEMPLATE.md`
   (sibling asset of the `dev-buddy` skill) as the base.
2. Fill in from Phase 2 + Phase 3:
   - **Project** — name, repo, working dir, primary language(s),
     build/test/lint commands.
   - **User** — name, time zone, working hours, communication
     preferences.
   - **Stack & conventions** — runtime versions, package manager,
     test framework, linter/formatter, CI.
   - **Tools & infra** — installed plugins (from Phase 1) the user
     should know they have access to.
   - Append other repos the user mentioned under a new `## Other
     repos` heading if Q3 produced anything.
3. Leave headings with no content as `(empty)` — don't drop them.
4. Write the file.
5. Verify with `view`.
6. Report: `updated <workspace>/.clawdevbox/memory.md`.

## Phase 7 — Register triggers (Tier 2 — recap approval is the gate)

For each approved trigger from Phase 5:

```
trigger.register({
  type_id: '<from trigger.list_types — typically "cron">',
  params: { cron: '<expression>' },          // or webhook/file-watch params
  binds_to_recipe: '<recipe_id>',
  enabled: true,
})
```

Verify with `trigger.list_registered()` — find the row, confirm the
`binds_to_recipe`, `params`, and `enabled` match what you sent.

Append one line per registration to `memory.md` under **Permissions**
so you don't re-ask next session:

```
- <YYYY-MM-DD>: approved `trigger.register` for `<recipe_id>` on `<cron>` via onboard-self
```

If a trigger needs a recipe that doesn't exist yet (Phase 8 drafts
it), draft the recipe first, then register the trigger.

## Phase 8 — Draft new skills / recipes for unmatched patterns

For each work pattern from Phase 4 with **no existing fit** that the
user approved in Phase 5's recap:

1. Draft a minimal skill at workspace scope using `skill.upsert`:

   ```
   skill.upsert({
     id: '<kebab-case id>',
     scope: 'project',
     source: '---\nname: <id>\ndescription: <one-line>\n---\n\n# <Title>\n\n<body>',
   })
   ```

   The body should follow the structure of the existing skills:
   - One-paragraph purpose.
   - **Inputs** section (parameters the skill takes).
   - **Phase 1 / Phase 2 / …** numbered procedure.
   - **Rules** section (Tier references, what's in/out of scope).

   Keep it short. A first-draft workspace skill is ~30–80 lines —
   the user will edit it the first time they actually use it.

2. If the pattern is event-driven (CI watch, inbox watch, daily
   summary on a different cadence than `daily-standup`), draft a
   workspace-scoped recipe via `recipe.upsert({ scope: 'project', … })`
   and then register its trigger in Phase 7.

3. Verify each creation:
   - `skill.list({ scope: 'project' })` — confirm the new id appears.
   - `recipe.list({ scope: 'project' })` — confirm the new recipe
     appears.

4. Append to `memory.md` under **Permissions**:
   ```
   - <YYYY-MM-DD>: approved workspace-scoped `<skill|recipe>` `<id>` via onboard-self
   ```

5. Report each: `created <id> @ <path>` plus a one-line example of
   how the user can invoke it.

Don't over-engineer. Don't draft a skill for something that's a
one-off task — that's `run-task` territory. Skills are for **recurring
patterns** the user explicitly named.

## Phase 9 — Wrap up

Report inline (no artifact, no inbox card):

```
**Identity:** `<name>`, avatar `<emoji or none>`     → `identity.md`
**Voice:** <one-line style summary>                  → `soul.md`
**Memory:** project + user + <N> repos + <M> permissions → `memory.md`
**Triggers enabled:** <list of "cron → recipe">, or "none"
**New workspace skills:** <list of ids>, or "none"
**New workspace recipes:** <list of ids>, or "none"

I'm calibrated. You can ask me to:
- <one-line example tied to a matched skill/recipe from Phase 4>
- <one-line example tied to a registered trigger from Phase 7>
- <one-line example tied to a new skill from Phase 8>
- `/catchup` — quick brief on inbox + approvals
- `/onboard-self` — re-run this calibration any time
```

Don't push, don't write an inbox card, don't write an artifact. The
output of self-onboarding is the chat recap above plus the files on
disk. Anything more is noise.

## Rules

- This is **interactive**. Never proceed past Phase 5's recap without
  the user's approval, unless `auto_proceed: true` was set by the
  caller.
- Identity / soul / memory writes are Tier-1 (workspace overrides)
  per `STANDING_ORDERS.md` — proceed silently inside Phase 6 once
  the recap is approved. Plugin defaults are read-only; never write
  to `<plugin>/skills/dev-buddy/{IDENTITY,SOUL,MEMORY-TEMPLATE}.md`.
- Trigger registration, recipe upsert, and skill upsert are Tier-2 —
  the recap approval in Phase 5 is the "ask once" gate. Record each
  approval as a dated line in `memory.md` under **Permissions** so
  the same approvals don't get re-asked next session.
- New skills and recipes drafted in Phase 8 live at **workspace
  scope** (`scope: 'project'` for both `skill.upsert` and
  `recipe.upsert`). Never write to plugin defaults from this skill.
- Idempotent: if the user re-runs `/onboard-self`, read every file
  first and propose **deltas**, not overwrites. Existing answers are
  preserved unless the user explicitly changes them.
- If at any point a tool call errors, surface the verbatim error
  before continuing. Never silently skip a phase — if Phase 7 fails
  for one trigger, finish the rest and report which one failed.
- Don't write an artifact. Onboarding output belongs in chat and on
  disk, not in the viewer.
- Don't push-notify from this skill. Even if the user asked for
  "loud" notifications elsewhere, the act of onboarding isn't itself
  urgent.

## Cross-references

- `onboard-project` — the lighter sibling. Does the workspace scan +
  3-question memory bootstrap. If the user just wants `memory.md`
  populated without the deeper identity/soul/skill-drafting work,
  point them at `onboard-project` instead.
- `dev-buddy` (this plugin's main skill) — links the
  identity/soul/memory files into the playbook and defines the
  read-on-every-turn order.
- `STANDING_ORDERS.md` — the permission tiers cited throughout this
  skill.
- `TOOLS.md` — conventions for `skill.upsert`, `recipe.upsert`,
  `trigger.register`, and verification reads.
