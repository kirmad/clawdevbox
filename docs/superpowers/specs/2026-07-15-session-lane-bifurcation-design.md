# Design — Session-lane bifurcation + agent/model selection (execution phase 2)

**Date:** 2026-07-15
**Status:** Approved (brainstorm) — pending spec review
**Builds on:** `2026-07-14-recipe-step-validation-and-isolated-execution-design.md` (§5.7 fresh-session execution, §5.8 parallel fan-out/join — both deferred/unimplemented) and `2026-07-14-multiple-validation-gates-per-step-design.md` (validation gates, shipped).

---

## 1. Problem

Two capabilities are declared in the schema but **not wired to runtime**, and one is missing entirely:

1. **`execution: { mode: 'inline' | 'fresh-session', isolation?, model? }`** is validated, materialized into `recipe_steps.execution_json`, and read back — but **no runtime consumer acts on it**. Every step runs inline on the single session that called `recipe.instance.begin` and self-drives the whole DAG. The 2026-07-14 spec §5.7 designed the "do role" fresh session but only the "verify role" (validation) was implemented.
2. **`verifier_model`** exists on every gate and is normalized into `validation_json`, but `spawnVerifier` calls `runRecipe` **without** passing it, so it is silently ignored.
3. There is **no way to bifurcate a recipe across parallel interactive sessions and rejoin** — the phase-2 fan-out/join deferred in 2026-07-14 §5.8.

The motivating workflow (implement-work-item): *design* + *implementation* run on the initial console; *comment analysis* and *NPE deployment* run on their own independent consoles in parallel; then *final closing + memory* resumes the **initial** console. And the author wants to pick the **agent/model** for both step-execution sessions and validation gates.

## 2. Goals

- **Named session lanes** — a step declares which session ("lane") it runs on. Steps in the same lane share one console (sequential within the lane); different lanes run in parallel on separate consoles.
- **Resume the initial session** — a later step on the `main` lane resumes the *original* console (not a fresh one), enabling the "bifurcate then rejoin for closing/memory" pattern.
- **Server-driven (declarative)** — a new lane-dispatch worker (mirroring the validation worker) spawns/wakes lane sessions from step declarations; no new orchestration burden on the agent.
- **Agent/model selection, symmetric** — per-step `execution.{provider,agent,model}` for the lane's session and per-gate `verifier_{provider,agent,model}` for the verifier. `verifier_model` finally honored.
- **Backward compatible** — every existing recipe (no `execution.session`) behaves exactly as today: one `main` lane on the initial session.

## 3. Non-goals

- Nested/hierarchical lanes; dynamic lane creation beyond what steps declare.
- Switching a live lane session's model mid-run (a lane is one CLI process).
- Per-file / per-todo automatic decomposition of a single step into N units (that remains the deferred `fresh-parallel`, out of scope).
- Cross-lane file-conflict resolution beyond what the shared workspace + `depends` ordering already provide.

## 4. Core model

**A lane is a persistent session identity within one recipe instance.** Each step maps to exactly one lane:

- `execution.session: <name>` → the named lane `<name>`.
- else `execution.mode: 'fresh-session'` (no session name) → an implicit per-step lane `__step:<step_id>` (realizes 2026-07-14 §5.7: an isolated, bias-free single-step session).
- else (absent / `mode: 'inline'` / `session: main`) → the `main` lane.

The `main` lane **is** the initial `/spawn` session that called `recipe.instance.begin`. Non-`main` lanes get their own spawned **interactive** console (same workspace, so all lanes see the same files/artifacts). A lane's session is spawned lazily on first need and reused for every subsequent step in that lane.

Each session **self-drives only its own lane's ready steps** — identical to today's single-session self-drive, but scoped to a lane. Cross-lane coordination is the worker's job.

## 5. Author-facing schema

```yaml
steps:
  - id: implement
    execution: { session: main }                 # default; may be omitted entirely
  - id: npe-deploy
    depends: [implement]
    execution: { session: deploy, provider: copilot, agent: dev-buddy:dev-buddy, model: claude-opus-4.8 }
  - id: comment-analysis
    depends: [implement]
    execution: { session: reviews, model: gpt-5.6-sol }
  - id: finalize
    depends: [implement, npe-deploy, comment-analysis]
    execution: { session: main }                 # resumes the ORIGINAL console
    validation:
      - name: memory-check
        mode: judge
        verifier_provider: copilot
        verifier_agent: dev-buddy:dev-buddy
        verifier_model: claude-opus-4.8
```

New fields (all optional, all fall back to server defaults):

- `execution.session: string` — lane name. `^[a-z][a-z0-9-]*$` or `main`. Default `main`.
- `execution.provider: string` — CLI/provider for the lane session (`copilot` | `claude` | `agency`).
- `execution.agent: string` — persona passed as `--agent`.
- `execution.model: string` — model passed as `--model` (the existing `execution.model` field, now honored).
- Gate: `verifier_provider`, `verifier_agent` (new) alongside the existing `verifier_model`.

Kept from the prior spec: `execution.mode` (`inline` | `fresh-session`) and `execution.isolation: required`. `isolation: required` refuses to run the step on a lane whose session authored the subject (enforced at lane-spawn; in practice only meaningful for the implicit `__step:` lane and for `main`).

**Lane selectors are lane-level.** A lane runs one CLI process, so `provider/agent/model` are resolved from the **first step that materializes the lane's session**. If a later step in the same lane declares a conflicting selector, `recipe.template.upsert` emits a validation **warning** and first-wins at runtime. (Validation gates are unaffected — each gate is its own spawn, so per-gate selectors are fully independent.)

## 6. Lane orchestration (new lane-dispatch worker)

A new server worker, `lane-dispatch-worker.ts`, structured like `recipe-validation-worker.ts` (single query per tick, injected deps for testability). Each tick, for every `running` recipe instance:

1. Compute **ready steps** = `status IN (pending)` AND every `depends` id is `done`. Group by resolved lane.
2. For each lane with ≥ 1 ready step:
   - **Lane has a live session** (per `recipe_lane_sessions`) → if that session is idle, `deliverToWorker`/dispatch a "you have newly-ready step(s)" nudge (resume if archived). If already busy, do nothing (it will pick the step up).
   - **Lane has no session yet**:
     - `main` → bind to the instance's initial `cli_session_id` (already recorded at `recipe.instance.begin`); dispatch/resume it.
     - other → **spawn a fresh interactive console** via `runRecipe({ spawnMode: 'interactive', agentCli/agent/model from the lane's first step, workspaceInfo = the instance's workspace, extraEnv: { CLAWDEVBOX_RECIPE_INSTANCE_ID, CLAWDEVBOX_RECIPE_LANE } })`, seeded with a **lane role prompt** (§7). Record `recipe_lane_sessions(lane → cli_session_id)`.

The worker never *does* a step; it only ensures each lane with pending work has an awake session. Steps advance via the sessions' own `recipe.steps.update_status` calls (and the validation worker for gated steps) exactly as today.

**Lane-scoped readiness.** A caller's lane is resolved authoritatively from `recipe_lane_sessions` (its `cli_session_id` → `lane`), defaulting to `main` when unmapped — so the **initial** `/spawn` session (which is not spawned with a lane env) is treated as `main` the moment `recipe.instance.begin` records its `main` row. Worker-spawned lane sessions additionally receive `CLAWDEVBOX_RECIPE_LANE` as a hint. The recipe "ready steps" surface (the next-step prompt built by the validation worker's `nextStepPrompt`, and any `recipe.instance.get`-driven selection) is filtered to the caller's lane, so a lane session only ever sees / acts on its own lane's steps.

## 7. Lane role prompt

A spawned non-`main` lane session is seeded with a deterministic preamble (mirroring the existing verifier/`[clawdevbox] Your session id is …` preambles):

> You own lane `<lane>` of recipe instance `<id>` (workspace `<path>`). Drive **only** the steps assigned to lane `<lane>`, in `depends` order, using `recipe.steps.update_status`. Steps in other lanes run on other consoles — do not touch them. When your lane has no ready step, stop; you will be resumed when one becomes ready. Your session id is `<sid>`.

## 8. Resume-the-initial-session

"Continue back on the initial session" needs **no new mechanism** — it is the `main` lane's normal wake path. After `main` finishes its early steps (design, implementation) and no further `main` step is ready (finalize waits on `deploy`/`reviews`), the `main` session goes idle. When the branches complete and `finalize` (lane `main`) becomes ready, the lane-dispatch worker resumes the **original** `cli_session_id` and dispatches the finalize prompt — the same `deliverToWorker` / `spawnDispatchOrResume` resume the validation worker already uses.

## 9. Model/agent wiring

- **Execution:** the lane-spawn call passes `agentCli = execution.provider ?? cfg.defaultAgentCli`, `agent = execution.agent`, `model = execution.model` into the existing `runRecipe` → `provider.spawnSession({ agent, model })` path (already supported end-to-end; only the wiring from the step declaration is new).
- **Validation:** `spawnVerifier` reads the gate's `verifier_provider`/`verifier_agent`/`verifier_model` (already present on the normalized gate) and threads them into its `runRecipe` call — replacing the current hardcoded `agentCli: cfg.defaultAgentCli` with the gate's selection and adding the missing `agent`/`model`.

## 10. Data model / schema changes

- **New table `recipe_lane_sessions`** (migration vN, additive):
  `recipe_instance_id TEXT`, `lane TEXT`, `cli_session_id TEXT`, `status TEXT` (`live` | `idle` | `done`), `spawned_at INTEGER`, PRIMARY KEY `(recipe_instance_id, lane)`. Source of truth for "does this lane have a session?".
- **No new `recipe_steps` columns** — `execution.session/provider/agent` ride inside the existing nullable `execution_json`. `normalizeExecution()` (new, mirrors `normalizeValidation`) canonicalizes `execution_json` to `{ session, mode?, isolation?, provider?, agent?, model? }`.
- `recipe.instance.begin` records the initial session as `recipe_lane_sessions(main → cli_session_id)`.

## 11. Backward compatibility

- No `execution` / `execution.session` ⇒ lane `main` ⇒ the initial session ⇒ **identical to today**. All shipped recipes and the current single-session self-drive are unchanged.
- `recipe_lane_sessions` starts with just the `main` row per instance; the worker is a no-op for single-lane recipes (one lane, one session, already live).
- `verifier_model` transitions from *ignored* to *honored*; recipes that set it get the model they asked for (a latent-bug fix, not a break).

## 12. Error handling / edge cases

- **Lane session spawn fails** → log; retry on the next worker tick up to a bounded count; then mark the lane's ready steps `awaiting_user` with a "lane session could not start" message (mirrors the validation worker's `retryOrEscalate`).
- **Lane session reaped/archived while its lane still has work** → resume it (existing resume path) before dispatching.
- **Deadlock guard** — a lane whose only ready steps all `depends` on a `failed`/`awaiting_user` step in another lane simply stays idle; instance completion still cascades via `cascadeInstanceIfAllTerminal` when all steps are terminal.
- **`isolation: required`** — the worker refuses to route such a step onto a lane whose session authored the subject; falls back to the implicit `__step:` lane.
- **Conflicting lane selectors** — first-materializing step wins at runtime; `recipe.template.upsert` surfaces a warning.

## 13. Testing / acceptance

- **Unit** — lane resolution (`normalizeExecution`); lane-grouped readiness; worker routing decisions (spawn vs resume vs no-op) with injected deps; `recipe_lane_sessions` lifecycle; the model/agent wiring for both `spawnVerifier` and lane spawn (assert the args passed to a stub `runRecipe`).
- **Migration** — vN adds `recipe_lane_sessions`; existing rows unaffected.
- **Backward-compat** — a no-`execution` recipe still completes on one session (existing suites stay green).
- **Real end-to-end acceptance** — a bifurcation recipe (`main`: setup→finalize; `deploy` + `reviews` lanes in parallel) run live via `/spawn`, verifying: two extra interactive consoles spawn, branches run concurrently, `finalize` resumes the **original** session id, and a gate with `verifier_model` set spawns its verifier with that model.

## 14. Out of scope (future)

- `execution.mode: fresh-parallel` automatic per-unit decomposition (2026-07-14 §5.8).
- Live model-switch within a lane.
- UI: lane badges / per-lane console grouping in the recipe view (follow-up; the data model here is sufficient to add it later).
