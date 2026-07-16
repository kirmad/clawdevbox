---
name: using-recipes
description: Use when running, driving, or updating a clawdevbox recipe INSTANCE at runtime — starting a recipe (`recipe.instance.begin`), advancing its steps (`recipe.steps.update_status`), mutating a live plan (`recipe.instance.update_steps`), inspecting running instances, resuming an inherited run inside a spawned session, or debugging `INVALID_TRANSITION` / `RECIPE_INSTANCE_NOT_FOUND` / `CONFLICTING_ARGS` step errors. For writing recipe templates, use `authoring-recipes` instead.
---

# Using recipes (runtime)

A **recipe template** is a reusable YAML pipeline; a **recipe instance** is one live run of it. This skill is the deep-dive on driving *instances* — the recipe analogue of `using-clawdevbox`'s general tour. It complements, and does not repeat, the recipe section of `using-clawdevbox`; read that first for the memory/skill/recipe/trigger big picture.

**Core loop:** discover a template → `begin` an instance → for each step, mark it `running` *before* you work and terminal (`done`/`failed`/`skipped`) *after* → inspect/mutate as needed.

## When to use
- You are about to run a named workflow (`pr-review`, `implement-feature`, `daily-standup`) or an ad-hoc multi-step pipeline you want tracked in the recipe UI.
- You are inside a spawned session that inherited `CLAWDEVBOX_RECIPE_INSTANCE_ID` and must drive the run.
- A step transition was rejected and you need the state machine.

**Not for:** authoring/editing template YAML (→ `authoring-recipes`); one-off work that needs no tracking (just do it inline).

## Lifecycle quick reference

Live tool names are `recipe.template.*` (definitions) and `recipe.instance.*` / `recipe.steps.*` (runs). Learn each via `learn_tool` before first use.

| Phase | Tool | Key args |
|---|---|---|
| Discover | `recipe.template.list` | `scope?` (`project`/`plugin:<id>`/`global`/`vault:<id>`/`all`), `search?` |
| Inspect template | `recipe.template.get` | `id`, `show_ai_prompts?` (prompts omitted by default — delivered progressively as steps run) |
| Start | `recipe.instance.begin` | **`name` (REQUIRED, ≥3 chars)** + **`template_id` XOR `source`** (inline YAML), `params?`, `workspace_id?` → returns `recipe_instance_id` + step list |
| Drive | `recipe.steps.update_status` | `step_id`, `message` (both REQUIRED), `status?`, `state?`/`state_replace?`, `request_user_input?`, `recipe_instance_id?` |
| Mutate plan | `recipe.instance.update_steps` | `add?`, `remove?`, `update_meta?`, `recipe_instance_id?` |
| Inspect run | `recipe.instance.get` / `recipe.instance.list_running` | `id?` (get) |
| Terminate / view | `recipe.instance.kill` / `recipe.instance.view_url` | `id` |

**Env inheritance:** a spawned recipe session inherits `CLAWDEVBOX_RECIPE_INSTANCE_ID` and `CLAWDEVBOX_WORKSPACE_ID`; `update_status`, `update_steps`, and `instance.get` default `recipe_instance_id` from it, so you may omit the id there. In your *own* (calling) session, `begin` returns the id but sets **no** env var — you MUST pass `recipe_instance_id` explicitly to every subsequent call.

**Status state machine** (monotonic; violations → `INVALID_TRANSITION`):
```
pending       → running | skipped
running       → done | failed | skipped | awaiting_user
awaiting_user → running | done | failed | skipped
done | failed | skipped   (terminal — no further transitions)
```
Entry hook: → `running` registers the step's declared triggers. Exit hook: → terminal disables auto-declared triggers and cascades the instance to terminal once all siblings are terminal.

## Worked example (in-session, inline source)

```
begin = recipe.instance.begin({
  name: "Prune merged branches in clawdevbox",
  source: "id: cleanup\nname: Cleanup\ndescription: Prune merged branches\nsteps:\n  - id: scan\n    goal: List branches merged into main\n  - id: prune\n    goal: Delete each merged branch\n    depends: [scan]"
})
RID = begin.recipe_instance_id     # capture — no env var in your own session

recipe.steps.update_status({ recipe_instance_id: RID, step_id: "scan",  status: "running", message: "Scanning merged branches" })
# ...do the work...
recipe.steps.update_status({ recipe_instance_id: RID, step_id: "scan",  status: "done", message: "Found 3 merged branches", state: { branches: ["a","b","c"] } })

recipe.steps.update_status({ recipe_instance_id: RID, step_id: "prune", status: "running", message: "Deleting 3 branches" })
# need a human OK → atomically go awaiting_user + open an inbox item:
recipe.steps.update_status({ recipe_instance_id: RID, step_id: "prune",
  request_user_input: { message: "Delete a, b, c?", options: ["yes","no"] } })
# after approval:
recipe.steps.update_status({ recipe_instance_id: RID, step_id: "prune", status: "done", message: "Deleted 3 branches" })
```

## Gotchas

| Mistake | Reality |
|---|---|
| Omitting `name` on `begin` | It's REQUIRED (≥3 chars). *(The old "`displayName is not defined`" report did NOT reproduce — verified 2026-07-12: a real `begin` with `name` succeeded; the actual failure mode is `NO_TARGET_WORKSPACE`, below.)* |
| `begin` from a non-workspace context (e.g. an installed-plugin MCP dir) | `NO_TARGET_WORKSPACE`. `begin` needs a workspace: pass `workspace_id` explicitly (resolve one via `workspace.list`), or run where `CLAWDEVBOX_WORKSPACE_ID`/a registered project dir is set. *(Verified 2026-07-12.)* |
| Not marking a step `running` before / terminal after | Status stays stale, entry/exit hooks never fire, the instance never cascades to terminal. Update status **before starting and after finishing every step.** |
| Using `in_progress` | Not in the enum — valid statuses are `running`/`done`/`failed`/`skipped`/`awaiting_user`. |
| `pending → done`, or writing a terminal step | `INVALID_TRANSITION`. Go through `running` first. |
| Calling `begin` inside a spawned run | Mints an orphan instance. Reuse the inherited `CLAWDEVBOX_RECIPE_INSTANCE_ID`; add steps via `recipe.instance.update_steps({ add:[...] })`, then drive them. |
| `state` + `state_replace`, or `request_user_input` + `status` | `CONFLICTING_ARGS` — they're mutually exclusive. `state` merges; `state_replace` overwrites. |
| Omitting `message` on `update_status` | Required — write a specific summary, not "Done." |
| `remove`-ing a live step | `running`/`awaiting_user` steps can't be removed (`CANNOT_REMOVE_RUNNING_STEP`); only pending/terminal steps. |
| No `recipe_instance_id` outside a spawn | `RECIPE_INSTANCE_NOT_FOUND` — pass it explicitly in your own session. |

## Related
- `authoring-recipes` — write/edit the template YAML this skill runs.
- `using-clawdevbox` — the umbrella operational manual (memory, skills, triggers, inbox, sessions).
