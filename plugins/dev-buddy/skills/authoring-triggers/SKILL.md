---
name: authoring-triggers
description: Use when writing or editing a clawdevbox trigger TYPE or an inline trigger script — before calling trigger.template.create, trigger.template.update, trigger.instance.register with a `script`, or trigger.test with an inline `script`. Read this first whenever the trigger never fires, state never advances, auth 401s, spawn/dispatch does nothing, or the script exits 0 but did nothing useful.
---

# Authoring triggers

A clawdevbox trigger is a small script the kernel spawns on every fire (manual,
cron, or webhook). The kernel hands it **one JSON envelope on stdin + one env
var**, captures its stdout/stderr, and persists whatever files it writes under
`output_dir`. Get the envelope contract wrong and the script exits 0 while doing
nothing — the #1 failure mode. This skill is the authoritative contract.

> **REQUIRED for**: `trigger.template.create`, `trigger.template.update`,
> `trigger.instance.register` (with `script`/`script_file`), and `trigger.test`
> (with inline `script`). Those tool descriptions point here on purpose.

## When to use
- Writing a new trigger TYPE (`trigger.template.create`) or editing one
  (`trigger.template.update`).
- Registering a one-off inline `script` / `script_file`
  (`trigger.instance.register`) — same envelope contract as a TYPE.
- Debugging: events never fire, `state` never advances, `401` on
  dispatch/spawn, or "exit 0 but nothing happened".

**Not for**: registering/running an EXISTING TYPE, scheduling cron, firing,
enable/disable → use **`using-triggers`**. General tool usage → **`using-clawdevbox`**.

## The envelope contract (this is the whole skill)

The script reads **one JSON object on stdin** (`TriggerEnvelope`) and uses the
`CLAWDEVBOX_FIRE_SECRET` env var for auth. Source of truth:
`docs/tools/trigger.md` §"Trigger envelope contract";
`mcp-server/src/trigger-runner.ts`.

```ts
interface TriggerEnvelope {
  trigger_event_name: 'TriggerFired';
  trigger_id: string;
  run_id: string;
  output_dir: string;          // write observation files HERE (persisted for you)
  dispatch_url?: string;       // POST {prompt} → live subscriber pty. FEATURE-DETECT: absent when no live pty
  spawn_url: string;           // POST {prompt, agent?, workspace_id?} → fresh agent. Always present ('' under trigger.test)
  state: Record<string, unknown>; // last persisted state; {} on first run
  payload: unknown;            // firer-supplied (trigger.fire arg / webhook body)
}
```

Read it with the Node async-iterator idiom (scripts run under `tsx`/`node`; the
web `Response`/`Bun.stdin` shapes do NOT work):

```ts
async function readStdin(): Promise<string> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
const env = JSON.parse(await readStdin());
```

> **⚠️ Scripts run as ES modules (`.mjs`) — even for `runtime: "node"`.** The
> runner copies your source to a `.mjs` temp file, so `require()` throws
> `ReferenceError: require is not defined in ES module scope`. Use `import`
> statements (and top-level `await` is available). *(Verified 2026-07-12 via
> `trigger.test`: a `require('node:fs')` script exited 1; switching to
> `import { writeFileSync } from 'node:fs'` exited 0.)*

### The three actions (pick one per fire)
1. **Observe** — write a file under `env.output_dir`. Most common; the kernel
   persists it to `<ws>/.clawdevbox/fires/<fire_id>/attempt-N/`.
   ```ts
   writeFileSync(join(env.output_dir, 'observation.json'), JSON.stringify({ observed_at: Date.now(), payload: env.payload }));
   ```
2. **Dispatch** to the live subscriber agent (only if a pty is bound):
   ```ts
   if (env.dispatch_url) await fetch(env.dispatch_url, { method: 'POST',
     headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CLAWDEVBOX_FIRE_SECRET}` },
     body: JSON.stringify({ prompt: `...${env.payload.body}` }) });
   ```
3. **Spawn** a fresh agent (`spawn_url` is always present):
   ```ts
   await fetch(env.spawn_url, { method: 'POST',
     headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CLAWDEVBOX_FIRE_SECRET}` },
     body: JSON.stringify({ prompt: '...', agent: 'dev-buddy:dev-buddy', workspace_id: env.state.target_workspace_id }) });
   ```

## Authoring a TYPE — quick reference

`trigger.template.create` (live name; `docs/tools/trigger.md` calls it
`trigger.create_template`). Key params:

| Param | Notes |
|---|---|
| `id` | **Must match `/^local\.[a-z0-9-]+(\.[a-z0-9-]+)*$/`** — the `local.` prefix is mandatory. |
| `runtime` | `node` \| `tsx` \| `python` \| `bash` — picks `.js/.ts/.py/.sh` + interpreter. |
| `script` XOR `script_file` | Inline source, or a path **under `.clawdevbox/`** (outside → `SCRIPT_FILE_OUTSIDE_WORKSPACE`). Supplying both/neither → `INVALID_REQUEST`. |
| `scope` | `project` (default) or `global`. |
| `default_cron` | Inherited when a registration's `cron` is `null`. |
| `parameters` | `[{name,type,required?,default?,description?}]` — validated at register time; seeds instance `state`. |

Author-then-deploy loop:
1. `trigger.template.create({ id:"local.x", runtime:"tsx", description, script })`
2. `trigger.test({ template_id:"local.x" })` — **non-mutating**; run BEFORE
   registering. Inspect stdout/stderr + the observation files it wrote to
   `output_dir`. Under test, `dispatch_url` is omitted and `spawn_url` is `''`.
3. `trigger.instance.register({ type_id:"local.x", params:{...} })` — go live.
4. Iterate with `trigger.template.update`; existing registrations keep their ids.

## Pre-deploy checklist (run every time)
- [ ] Reads stdin via the async-iterator `readStdin()` — not `Response`/`Bun`.
- [ ] Uses `process.env.CLAWDEVBOX_FIRE_SECRET` (NOT the legacy
      `CLAWDEVBOX_MCP_SECRET`) as `Authorization: Bearer` on every
      dispatch/spawn POST.
- [ ] **Feature-detects `dispatch_url`** (absent when no live subscriber) —
      falls back to `spawn_url` or an observation file.
- [ ] Writes results to `env.output_dir` — does **NOT** emit `{state}` /
      `{callback}` / `{continue}` on stdout (the kernel no longer parses stdout;
      that's the dead legacy Mode-A/B contract).
- [ ] `id` starts with `local.`; `runtime` matches the script language.
- [ ] Ran `trigger.test` and confirmed real output (exit 0 + empty output = did
      nothing — a silent failure, not success).

## Gotchas (each is a real, documented failure mode)

| Symptom | Cause / fix |
|---|---|
| Exit 0 but nothing happened | Emitting a result on stdout instead of writing `output_dir` / POSTing dispatch/spawn. Stdout is captured to disk, never interpreted. |
| `401` on dispatch/spawn | Missing/wrong bearer. Use `CLAWDEVBOX_FIRE_SECRET`; it's only valid while the fire is in flight. |
| Dispatch silently no-ops | `dispatch_url` was `undefined` (no live subscriber pty). Must feature-detect and fall back to spawn/observe. |
| stdin parse hangs/empty | Used a web/Bun stdin shape. Use the Node async-iterator `readStdin()`. |
| State "never advances" | Scripts don't persist state via stdout anymore. State is seeded from `params` and changed via `trigger.instance.update_params`; per-fire results go to `output_dir`. |
| `VALIDATION_FAILED` on create | Bad `id` (missing `local.`), bad `runtime` enum, invalid `default_cron`, or malformed `parameters` — see `errors[]`. |
| `INVALID_REQUEST` on create | Supplied both or neither of `script`/`script_file`. |
| Legacy sample looks different | `samples/triggers/*.mjs` (e.g. `teams-listener.mjs`) use the OLD `callback_url` + `CLAWDEVBOX_MCP_SECRET` envelope. Port to `output_dir`/`dispatch_url`/`spawn_url` + `CLAWDEVBOX_FIRE_SECRET` before reusing. |
| `require is not defined` | Scripts run as `.mjs` (ESM) even under `runtime:"node"`. Use `import`, not `require`. |
| `trigger.instance.fire` "did nothing" | `fire` only ENQUEUES a run (the cron/dispatch daemon drains it — a stub in MCP-only contexts, so `last_run_at` stays null). To actually RUN and validate a script, use `trigger.test` — it's the only tool that synchronously spawns the script. |

## Naming note
The live MCP tools are `trigger.template.create/update/delete/list`,
`trigger.instance.register/unregister/enable/disable/fire/list/update_params`,
`trigger.type.list`, and `trigger.test`. `docs/tools/trigger.md` documents the
same tools under older flat names (`trigger.create_template`,
`trigger.register`, …) — the contracts are identical; trust the live schemas
(`list_tools({filter:"trigger"})` → `learn_tool`).

## Related
- **using-triggers** — register/test/fire/manage an existing TYPE or script.
- **using-clawdevbox** — the umbrella operational manual (meta-tool gateway).
