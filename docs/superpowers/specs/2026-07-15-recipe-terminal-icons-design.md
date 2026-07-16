# Design — Per-step & per-validation terminal icons in the recipe tab

**Date:** 2026-07-15
**Status:** Approved (brainstorm) — pending spec review
**Builds on:** `2026-07-15-session-lane-bifurcation-design.md` (lanes → per-step driving sessions) and the existing validation-gate rounds UI.

---

## 1. Problem

The recipe-instance view (recipes tab, `RecipeDetailPanel.vue`) has a single top **"Terminal (resume)"** button that only opens the recipe's main/initial session. With session lanes, a run now spans multiple consoles (one per lane) plus an independent verifier session per validation round — none of which are reachable from the UI. The user wants a **terminal icon per step** (open its driving/lane console) and **per validation round** (open that verifier's console) so they can watch any session live from the sidebar, and the top button removed.

The blocker is an ID mismatch: the terminal sidebar opens by **`recipe_instance_id`** (`ui.ts` `selectTerminal(instanceId)`), but per step/round the system stores a **`cli_session_id` GUID** (`recipe_steps.verifier_session_id`, `validation_runs_json.gates[].verifier_session_id`, `recipe_lane_sessions.cli_session_id`). The bridge already exists — `agent_sessions` maps `cli_session_id → recipe_instance_id` (the reverse lookup the code already performs) — it's just not resolved or exposed to the UI.

## 2. Goals

- A terminal icon on **each step row** → opens that step's **driving (lane) session** in the sidebar.
- A terminal icon on **each validation round** (existing rounds detail) → opens that verifier's session.
- A compact terminal icon in the **header** → the main/orchestrator session (the instance's own id).
- **Remove** the top "Terminal (resume)" button.
- Works for **live and archived** runs; no schema change.

## 3. Non-goals

- No new terminal infrastructure — reuse `ui.ts` `selectTerminal` + the Terminals panel.
- No auto-spawn/auto-resume on icon click (select-and-reveal only; the Terminals panel already offers Resume for archived sessions).
- No new DB columns / migration (resolve-at-read).
- No change to how sessions themselves are spawned.

## 4. Core model — resolve the terminal id at read-time

Add a single helper in `recipe-instances-store.ts`:
```ts
/** Resolve a stored cli_session_id GUID to the terminal recipe_instance_id
 *  the sidebar opens with. Returns null when unmapped. */
function resolveTerminal(db: Database, cliSessionId: string | null | undefined):
  { instance_id: string; cli_session_id: string } | null;
```
It runs `SELECT recipe_instance_id FROM agent_sessions WHERE cli_session_id = ? ORDER BY started_at DESC LIMIT 1` (the same reverse lookup already used in `recipe-validation-worker.ts`), returning `{ instance_id: <ri_…>, cli_session_id }` or `null`.

**Per validation round** (`ValidationRound`, `recipe-instances-store.ts:87`): each round already carries `verifier_session_id` (a cli GUID). Add:
```ts
terminal?: { instance_id: string; cli_session_id: string };
```
populated by `resolveTerminal(db, round.verifier_session_id)` in `buildStepValidation`.

**Per step** (`RecipeStep`, `recipe-instances-store.ts:52`): add
```ts
lane?: string;                                        // resolveLane(execution_json, step_id)
terminal?: { instance_id: string; cli_session_id: string };
```
The driving session is the step's lane console:
1. `lane = resolveLane(normalizeExecution(execution_json), step_id)`.
2. `cli = recipe_lane_sessions(recipe_instance_id, lane).cli_session_id` (via `getLaneSession`).
3. `terminal = resolveTerminal(db, cli)`.

For a **main-lane** step this resolves to the instance's own id (the main console); for a non-main lane, to that lane run's id; `null`/absent until the lane has a session (no icon shown yet). This is computed in `readStepsFromDb` where each step row (with `execution_json`) is already in scope.

**Header (main session):** the instance detail projection already exposes `session_id = session.cli_session_id` and the instance id; the header icon opens the instance's own `recipe_instance_id` (unchanged target from the old button, now an icon).

## 5. UI — `RecipeDetailPanel.vue` + `web/src/api.ts`

- `api.ts`: add `terminal?: { instance_id: string; cli_session_id: string }` to the step type and the `ValidationRound` type; add `lane?: string` to the step type.
- **Remove** `openTerminal()` + the top terminal button + `terminalLabel`. (Keep `reattach`/`openRecipeTerminalInline` only if still used elsewhere; otherwise remove dead code introduced solely for the button.)
- **Header icon:** a small terminal glyph button → `store.selectTerminal(recipe.id)` then reveal the terminal sidebar (the same "switch to agent/terminals view" the old flow did).
- **Step row:** when `step.terminal` is present, render a terminal icon → `store.selectTerminal(step.terminal.instance_id)` + reveal sidebar; tooltip shows the lane (e.g. "Open deploy-lane terminal").
- **Validation round:** in the existing per-round rendering, when `round.terminal` is present, render a terminal icon → `selectTerminal(round.terminal.instance_id)`; tooltip e.g. "Open verifier terminal (attempt N)".
- A tiny shared helper `openTerminalInSidebar(instanceId)` on the component wraps `selectTerminal` + the sidebar-reveal so all three call sites are identical.

**Interaction:** clicking selects the session in the Terminals sidebar. Live → live output; archived → the panel's existing Resume affordance. No spawning on click.

## 6. Backward compatibility

- Steps/rounds with no resolvable session → no `terminal` field → no icon (graceful).
- A recipe with no lanes: every step's lane is `main` → resolves to the instance's own id → the step icon and the header icon open the same (correct) console. Single-session recipes are unaffected beyond gaining icons.
- Resolve-at-read means existing/archived runs light up too, with no backfill.

## 7. Edge cases / error handling

- `resolveTerminal` returns `null` when the `agent_sessions` row is absent (session never recorded, or pruned) → the field is omitted → no icon. Never throws.
- A non-main lane whose console hasn't spawned yet → `getLaneSession` returns no `cli_session_id` → no step icon until it does.
- Multi-gate: each gate spawns its own verifier per attempt → each round entry resolves independently, so a multi-gate/reworked step naturally shows several round icons (the "multiple validations" case).
- `selectTerminal` with an instance not in the current `/api/sessions` window: the sidebar still targets it; the terminal view handles attach/resume. (No regression vs today — the old button had the same dependency.)

## 8. Testing

- **Backend unit** (`recipe-instances-store` tests): seed a recipe instance + `agent_sessions` rows (cli_session_id ↔ recipe_instance_id) + `recipe_lane_sessions` + a step with `execution.session` and a gated step with a round carrying `verifier_session_id`; assert the projected step carries `terminal.instance_id` = the lane run's id and the round carries `terminal.instance_id` = the verifier run's id; assert `null`/absent when unmapped.
- **`resolveTerminal` unit:** returns the mapped id, `null` on miss, never throws on null input.
- **Web:** `vue-tsc` + `vite` build clean with the new types; a focused check that the three icon call sites invoke `selectTerminal` with the resolved id (component-level or manual).

## 9. Out of scope (future)

- Persisting the terminal `recipe_instance_id` at write-time (only needed if `agent_sessions` rows are ever pruned before the recipe view is used).
- Inline mini-terminal previews; badges for live vs archived on the icon.
