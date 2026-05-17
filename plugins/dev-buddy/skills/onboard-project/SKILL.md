---
name: onboard-project
description: One-time first-run setup. Builds `<workspace>/.clawdevbox/memory.md` from a quick workspace scan, asks the user 3 clarifying questions, and optionally enables the heartbeat-pulse and daily-standup background recipes. Idempotent — safe to re-run; it preserves existing memory entries and only fills gaps.
---

# Onboard Project

First-run setup for dev-buddy in a workspace. Goal: a populated
`<workspace>/.clawdevbox/memory.md` and (optionally) two background
recipes scheduled.

## Inputs (ask or infer)

- `enable_heartbeat` *(default "ask")* — `"ask"` interactively, `"yes"`
  enable a 30-min heartbeat without asking, `"no"` skip.
- `enable_daily_standup` *(default "ask")* — same semantics.

## Step 1 — Scan the workspace

Read these if they exist, in this order, and extract the listed fields:

- `package.json` → project name, scripts (build/test/lint), runtime
  (`engines.node`), package manager (lockfile present?), dependencies
  that hint at the stack (react/vue/express/fastapi/etc).
- `pyproject.toml` / `requirements.txt` → python version, package
  manager (uv/poetry/pip), test framework (pytest/unittest).
- `Cargo.toml`, `go.mod`, `pom.xml`, `*.csproj` → likewise.
- `README.md` (first 100 lines) → what the project is.
- `.github/workflows/*.yml` (just the names) → CI presence.
- `git remote get-url origin` (if git is available) → repo URL.

Don't read the whole file tree. The goal is a 30-second snapshot, not
a full audit.

## Step 2 — Render `memory.md`

Check whether `<workspace>/.clawdevbox/memory.md` exists:

- **If it doesn't:** copy the template from this plugin's
  `skills/dev-buddy/MEMORY-TEMPLATE.md` and fill in everything you
  learned in Step 1. Leave headings with no content as `(empty)`
  rather than dropping them.
- **If it does:** read it. For each heading, if it's `(empty)` but
  you learned something relevant in Step 1, propose the addition to
  the user. Otherwise leave it alone.

Write the file via the regular file-write path (this is in the
workspace, not the plugin dir). Tier 1 — proceed silently.

## Step 3 — Ask the user

Ask **one consolidated question**, not three separate ones:

```
I've drafted a memory file from a scan of your workspace. A few
things I couldn't infer:
- How should I address you?
- What's your time zone?
- Anything I should remember about your communication preferences
  (terse / verbose / no emoji / code-first / etc.)?
```

Update `memory.md` with the answers under the **User** heading.

## Step 4 — Background recipes (optional)

If `enable_heartbeat` is `"ask"`:

- Tell the user what heartbeat does in one line:
  > Every 30 min, I check the inbox + pending approvals and write a
  > short summary to the inbox only if something's new. Never pushes
  > to your phone unless an urgent threshold trips.
- Ask: enable, change the cadence, or skip?
- If they say enable, call:
  ```
  trigger.register({
    type_id: 'cron',
    params: { cron: '*/30 * * * *' },
    binds_to_recipe: 'heartbeat-pulse',
    enabled: true,
  })
  ```
  Verify with `trigger.list_registered`.

If `enable_heartbeat` is `"yes"`: register without asking.
If `"no"`: skip silently.

Same flow for `enable_daily_standup` with a `0 9 * * 1-5` cron
(weekday 9 AM local — confirm time zone from `memory.md`).

## Step 4.5 — Offer identity / soul overrides (optional)

The plugin ships sensible defaults at
`<plugin>/skills/dev-buddy/IDENTITY.md` and
`<plugin>/skills/dev-buddy/SOUL.md`. The user can override per-project
by creating `<workspace>/.clawdevbox/identity.md` and
`<workspace>/.clawdevbox/soul.md`.

You don't need to create these proactively — they'll get created
automatically the first time the user asks for a durable identity or
voice change ("call me X", "stop using bullets"). But if the user
mentions any preference during onboarding ("formal tone for this
project", "no emoji in customer-facing repos", "different name here"),
seed the relevant file now:

- For identity changes: write
  `<workspace>/.clawdevbox/identity.md` with the plugin default as
  the base, then apply the user's change.
- For soul changes: same for
  `<workspace>/.clawdevbox/soul.md`.

Read the plugin defaults first via `skill.read({ id: 'dev-buddy' })`
sibling-asset paths so you start from the current content rather than
making up a structure. Preserve every section the user didn't touch.

## Step 5 — Wrap up

Report:

- **memory.md:** `created` | `updated` | `unchanged` — with the path.
- **identity.md:** `seeded with override` | `using plugin default`.
- **soul.md:** `seeded with override` | `using plugin default`.
- **Heartbeat:** `enabled @ <cron>` | `skipped`.
- **Daily standup:** `enabled @ <cron>` | `skipped`.
- One line on what's next: `Try \`/catchup\`, or just describe what
  you want to work on.`

Don't write an artifact — onboarding output belongs in chat.

## Rules

- This is a Tier-2 batch (writing `memory.md` + registering triggers).
  Step 3's ask doubles as the consent gate. Don't proceed past Step 2
  without the user's answers.
- Identity / soul seeding in Step 4.5 is Tier-1 (proceed silently) per
  `STANDING_ORDERS.md` — it's writing to the agent's own
  workspace-level config.
- Never enable triggers without confirmation when `enable_heartbeat` /
  `enable_daily_standup` is `"ask"`.
- If the user has already onboarded (memory.md exists and looks
  populated), say so and ask whether to reconfirm preferences or skip.
