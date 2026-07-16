---
name: using-triggers
description: Use when registering, testing, firing, pausing/resuming, retuning, or removing a trigger INSTANCE at runtime — for a saved trigger TYPE, an inline script, or a script_file — including scheduling one on cron or wiring a one-off/webhook watcher. For authoring new trigger TYPES or scripts, use authoring-triggers instead.
---

# Using Triggers

## Overview

A trigger **TYPE** is a capability: a parameter schema, a default cron, and a
script — shipped by a plugin or authored by an agent. A registered **INSTANCE**
is a concrete binding `(type, params, cron, enabled)` persisted in
`.clawdevbox/triggers.json` that the in-process scheduler + dispatcher actually
fire (`mcp-server/src/tools/trigger.ts`, `triggers-store.ts`). This skill covers
**using** instances — discover, test, register, fire, and manage. Writing the
script or a reusable TYPE is the sibling skill `authoring-triggers`.

All `trigger.*` tools are gated behind the meta-tool gateway — discover with
`list_tools({filter:"trigger"})`, then `learn_tool`, then `run_tool` (see
`using-clawdevbox`).

## When to use

- Wire a plugin or agent-authored TYPE to a schedule and params.
- Dry-run a script (registered, saved, or inline) before committing to it.
- Manually fire, pause/resume, retune params/cron, or remove a registered trigger.

## When NOT to use

- Writing/debugging a trigger script or authoring a reusable TYPE → `authoring-triggers`.
- General MCP usage (memory, recipes, inbox, sessions) → `using-clawdevbox`.

## Lifecycle quick reference (discover → test → register → manage)

| Step | Tool | Notes |
|---|---|---|
| Discover TYPES | `trigger.type.list` | Full catalog: plugin **and** agent-authored. Filter `scope:"plugin:ado"` or `search:`. Each entry carries the param schema + default cron. |
| Discover templates | `trigger.template.list` | Agent-authored templates only (`project`/`global`/`vault:<id>`). |
| List instances | `trigger.instance.list` | Registered rows + cron resolution + `last_run_status`. Filter `enabled`, `type_id`, `subscriber_thread_id`. |
| Test (NON-mutating) | `trigger.test` | XOR: `id` \| `template_id` \| `script`+`runtime`. Captures stdout/stderr + observation files under `output_dir`; `timeout_ms` (default 30s, max 600000). Never writes `triggers.json`/state. |
| Register | `trigger.instance.register` | XOR source: `type_id` \| `script`+`runtime` \| `script_file`+`runtime`. Validates params against the schema, mints `<type_id>#<key>`. |
| Fire (manual) | `trigger.instance.fire` | Enqueues a run → returns `fire_id`. Works even when disabled. |
| Pause / resume | `trigger.instance.disable` / `.enable` | Row stays on disk; disabled is skipped by the cron daemon but still manually fireable. |
| Retune | `trigger.instance.update_params` | Re-validates params; **id stays stable**. |
| Remove | `trigger.instance.unregister` | Drops the row; a one-off also drops its `_oneoff/` auto-template. |

**Cron resolution** (as shown by `trigger.instance.list`): `cron: null` =
inherit the TYPE's `default_cron`; `"<expr>"` = override; `false`/`""` = disable.

## Worked example A — template-based (saved TYPE)

```
trigger.type.list({ scope: "plugin:ado" })     # find ado.new-pr-watcher + its `repo` param
trigger.test({ template_id: "ado.new-pr-watcher", params: { repo: "auth-svc" } })   # dry-run, non-mutating
trigger.instance.register({ type_id: "ado.new-pr-watcher", params: { repo: "auth-svc" } })
# → mints ado.new-pr-watcher#auth-svc (identity_param = repo), inherits default cron, enabled:true
trigger.instance.update_params({ id: "ado.new-pr-watcher#auth-svc", cron: "*/2 * * * *" })  # override cron
```

## Worked example B — script-based (inline / script_file)

```
# REQUIRED FIRST: skill.read({ id: "authoring-triggers" }) — the envelope/state/cursor/auth contract.
#   trigger.instance.register AND trigger.test ENFORCE this when `script` is inline.
trigger.test({ script: "<inline>", runtime: "tsx", params: {…}, state: {…} })   # verify BEFORE registering
trigger.instance.register({ script: "<inline>", runtime: "tsx", name: "QoE sanity-check" })
# one-off defaults → once:true, cron:false: fires only on manual/webhook, NOT on cron
trigger.instance.fire({ id: "<minted id>" })   # → fire_id

# Prefer a script_file under .clawdevbox/ for anything non-trivial, and pass an explicit cron to schedule:
trigger.instance.register({ script_file: ".clawdevbox/triggers/qoe-check.mts", runtime: "tsx", cron: "0 * * * *" })
```

## Gotchas

- **Inline script without reading `authoring-triggers` → silent no-op** (exit 0 +
  empty output looks healthy but did nothing). The tools require the skill first.
- **TYPE ≠ INSTANCE.** A TYPE never fires; nothing runs until you
  `trigger.instance.register` it.
- **`update_params` never remints the id** — even when an identity param changes.
  To change identity, `trigger.instance.unregister` + `trigger.instance.register`.
- **Always `trigger.test` first** — it's non-mutating (no `triggers.json`/state write).
- **Source XOR:** register needs exactly one of `type_id`/`script`/`script_file`;
  test exactly one of `id`/`template_id`/`script`. 0 or 2+ → `INVALID_REQUEST`.
- **`runtime` is required** with `script`/`script_file` → else `RUNTIME_REQUIRED`.
- **One-offs default to `once:true`, `cron:false`** — pass an explicit `cron` to schedule.
- **`trigger.template.list` shows agent-authored templates only** — use
  `trigger.type.list` to also see plugin-shipped TYPES.
- **Manual `fire` works even when disabled** — disabling only removes it from the cron daemon.

## Cross-references

- **REQUIRED before inline scripts or authoring a TYPE:** `authoring-triggers`
  (envelope, state, cursor, auth, spawn routing, Mode A/B callbacks).
- General MCP tool usage and the meta-tool gateway: `using-clawdevbox`.
