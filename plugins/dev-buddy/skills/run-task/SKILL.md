---
name: run-task
description: Wrap any substantive task in the plan → execute → verify → summarize → memorize loop. Use when the user wants a persistent record of the work (an investigation, a refactor, a multi-file change). Always produces a markdown artifact, enforces verification between steps, and writes durable learnings to memory.md.
---

# Run Task

The autonomous-execution loop for substantive work. Differs from a
plain conversational reply in that it **always** produces a markdown
artifact, **always** verifies state-mutating steps, and **writes
durable learnings to `memory.md`** at the end.

## Inputs (ask or infer)

- `task` *(required)* — free-form description of what to do.
- `auto_proceed` *(default false)* — if true, skip the "Proceed?"
  gate after the plan. Use only when the user has already confirmed
  the scope of the task.
- `artifact_id` *(optional)* — override the artifact id. Default is
  `task-<short-slug-of-task>-<YYYYMMDD>`.

## Required reading before starting

Re-read these unless you read them this turn:

- `skill.read({ id: 'dev-buddy' })` — your main playbook
- `STANDING_ORDERS.md` (sibling of dev-buddy skill) — Tier 1/2/3 rules
- `TOOLS.md` (sibling) — MCP tool conventions
- `<workspace>/.clawdevbox/memory.md` — project context

## Phase 1 — Plan (visible, terse)

Emit a numbered plan: 3–7 bullets, each one an observable outcome (not
one tool call). Cite the files / ids you expect to touch.

After the plan:

- If `auto_proceed: true` → begin executing immediately.
- Else if every step is Tier-1 → begin executing immediately.
- Else (any step is Tier-2 or Tier-3) → end the plan with **"Proceed?"**
  and wait for the user. Don't act on a Tier-2/3 step without explicit
  consent.

Example:

```
Plan:
1. Find the file that handles X
2. Confirm the failure with a test
3. Patch the function
4. Re-run the test
5. Summarize what changed

Proceed?   (Tier-2 step 3 mutates source — asking once)
```

## Phase 2 — Execute one step at a time

For each step:

1. **Execute.** Run the tool that does the thing.
2. **Verify.** Read the resulting state with a different tool.
   Confirm the change is present. Cite the verification call.
3. **Report.** One line: `step N: <verb> <id> ✓ <verified-fact>`.

If a step fails, follow `STANDING_ORDERS.md` failure handling:
- Up to 3 attempts on transient errors only (network, rate limit,
  port busy, file-system busy).
- Stop and escalate on validation, permission, or "not found" errors.
- Never silently fall back to a different approach.

Maintain a running summary in your scratchpad — what's been done,
what's outstanding, decisions made on the way. This becomes the
artifact body.

## Phase 3 — Write the summary artifact

When the plan is fully executed (or stopped by a gate / non-recoverable
failure), write a markdown artifact:

```
artifact.add({
  id: '<artifact_id or auto-derived>',
  type: 'markdown',
  title: '<one-line task title>',
  files: { 'content.md': '<markdown body, see structure below>' },
  recipe_instance_id: <CLAWDEVBOX_RECIPE_INSTANCE_ID env var if set>,
})
```

Markdown structure:

```
# <Task title>

## Outcome
<1-2 sentences. What is now true that wasn't before? Or, if the
task didn't complete: what stopped it?>

## Plan
<numbered list, copy-pasted from Phase 1>

## Execution log
- **Step N — <step goal>:** <what you did> · verified by
  `<verification tool call>` → <verification result>

## Files / ids touched
- <file:line> — <one-line description of the change>
- <recipe_id>, <artifact_id>, <inbox_id> as relevant

## Verification
<what reads were used to confirm. Re-state the evidence — don't
make the reader trust 'verified ✓' on faith.>

## Deferred / open
<anything that came up during the task but was out of scope.
Bulleted. Each item with a suggested next step.>

## Suggested next
<one concrete thing the user might do next, with the command or
tool call ready to paste.>
```

Capture the returned `view_url`.

## Phase 4 — Memorize

Append to `<workspace>/.clawdevbox/memory.md` under the appropriate
heading **only if you learned something durable** the next session
would benefit from. Examples worth recording:

- A non-obvious build / test / lint command.
- A service that's behind a flag or in a non-default region.
- A repeated failure pattern and the workaround.
- A new decision the user made in this conversation.

Skip the memorize phase if there was no durable learning. Don't pad
memory — every line should be the kind of thing the next session
would be happier knowing than not.

Append style:

- Under `## Decisions log`: `- YYYY-MM-DD: <one-line decision>`
- Under `## Architecture & gotchas`: `- <one-line gotcha>`
- Under `## Ongoing threads`: `- <thread name> — last status as of
  YYYY-MM-DD: <one line>`

## Phase 5 — Wrap up

Report inline:

- `view_url`: <the artifact URL>
- `memory.md updated:` <yes|no — and which heading if yes>
- `next:` <the one suggested next step from the artifact>

## Boundaries

- If the task is small enough to do inline in chat without a
  persistent artifact, **decline** and ask the user to just describe
  it directly. This skill is for substantive work, not trivia.
- If the task is genuinely too large for one run (more than ~15
  steps, or more than ~10 files), stop after the plan and propose
  breaking it into multiple `run-task` invocations.
- Never skip Phase 3 (the artifact) — that's the differentiator
  vs a plain chat exchange. Even on a failed task, write the artifact
  with the failure documented.
