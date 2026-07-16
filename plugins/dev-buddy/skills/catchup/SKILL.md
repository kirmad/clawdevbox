---
name: catchup
description: Briefs the user on current workspace state — inbox, approvals, available recipes, scheduled triggers. Run when the conversation opens or when the user types `/catchup`. Produces a 5-10 line summary ending with one suggested next step.
---

# Catchup

When a conversation starts (or the user types `/catchup`), you are
expected to brief them on what changed while they were away. Keep it
tight — 5-10 lines total, bullets over prose, code-style formatting
for ids.

## Inputs (ask or infer)

- `brief` *(default false)* — when the user wants a faster version
  ("just the inbox"), skip the recipe + trigger inventory and only
  summarize inbox + approvals.

## Run these in parallel

All Tier-1 reads — proceed silently.

1. `workspace.current()` — confirm which project this is.
2. `inbox.list({ state: 'new', limit: 10 })` and
   `inbox.list({ state: 'open', limit: 10 })`.
3. `approval.list_pending()` — anything waiting on a human decision.
4. *(skip if `brief`)* `recipe.list({ scope: 'all' })` — recipes
   available.
5. *(skip if `brief`)* `trigger.list_registered()` — what's
   scheduled or watching.

## Format

```
**Workspace:** `<name>` (`<workspace_id>`)
**Inbox:** N new, M open
- `<id1>` <title> — `<state>`
- `<id2>` <title> — `<state>`
- `<id3>` <title> — `<state>`         (≤ 3 most-recent)
**Approvals:** K pending
- `<approval_id>` <title>             (omit the line if K == 0)
**Recipes available:** `<id1>`, `<id2>`, `<id3>`, …  (top 5 by relevance to inbox titles)
**Triggers:** N enabled, M disabled
- `<name>` — `<cron>` → `<recipe_id>`   (only the enabled ones)
**Suggested next:** <one concrete thing the user might do>
```

If nothing is pressing: `**Suggested next:** nothing pressing — what
do you want to work on?`

## Rules

- Do **not** narrate "I'll check the inbox..." — just call the tools
  and report.
- Do **not** emit a push notification from this skill. Catchup output
  goes to chat.
- Cite ids verbatim with backticks so the UI can link them.
- If `approval.list_pending` returns K > 0, surface that line first
  (above inbox). Pending approvals are the most important thing.
- If the workspace has no `memory.md` yet, append a one-liner to the
  bottom: `**Suggestion:** run \`onboard-project\` to build memory.md
  for this workspace.`
