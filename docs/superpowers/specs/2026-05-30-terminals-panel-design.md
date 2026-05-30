# Terminals Panel — Design

**Date:** 2026-05-30
**Author:** session 817a3d5e (paired with kirmadi)
**Status:** Approved, ready for implementation plan

## Goal

Add a new top-level **Terminals** view to the clawdevbox SPA. It shows every spawned session — main agent, recipe instances, ad-hoc spawns — as a vertical tab list. Active (live pty) sessions are shown by default; archived (exited) sessions are accessible via a collapsible section below. Each archived session can be **resumed** with one click, spawning a fresh agent CLI with `--resume <cli_session_id>`.

This replaces today's `AgentPanel.vue`, which is hard-coded to the single main-agent terminal.

## Non-goals

- Persisted scrollback for exited sessions beyond what's already kept in the recipe-instance log file. Archived rows show metadata only when there's no live pty.
- Resume support for providers that lack `--resume` semantics (echo-stub, e2e-test-runner). UI disables the button with a tooltip.
- Searching / filtering archived sessions by free text. Pagination is by time only (last 24h by default; "Show more" advances the cursor).
- Renaming sessions / custom labels. Labels are derived from recipe id + session kind.
- Multi-select / bulk-kill operations. Single-session focus per interaction.
- DB-level garbage collection of `agent_sessions`. The UI handles growth with pagination; GC is a future concern.
- Mobile layout polish. Desktop is primary; mobile gets a graceful fallback (single terminal at a time, list collapses to a dropdown).

## Why now

After the trigger-dispatch PR, the kernel can spawn many interactive sessions (one per `/spawn/<fire_id>`, plus recipe instances, plus main). Today users can't see them — `AgentPanel.vue` only shows the main agent's terminal, and discovering other sessions requires direct URL knowledge of `/terminal/<id>`. Listing them with live status + a clean resume affordance is the natural payoff.

## Architecture — three sequential commits in one PR

| Commit | Scope |
|---|---|
| **#1 (backend)** | `GET /api/sessions` list endpoint + `POST /api/sessions/<id>/resume` + pty-registry topic emissions on the event bus + V3 migration for `agent_sessions.resumed_into_instance_id` |
| **#2 (SPA panel)** | New `TerminalsPanel.vue` with vertical tab list + xterm right-column + store integration + realtime subscription |
| **#3 (wiring)** | App.vue swap: `Agent` tab → `Terminals` tab; delete `AgentPanel.vue` (or leave a thin shim if external links to it exist) |

Each commit is independently shippable but only commit #3 makes the feature user-visible.

## Components — Commit #1 (backend)

### 1.1 `GET /api/sessions` (list endpoint)

Lives in the same routing layer as the existing `/api/sessions/<id>` (added in the trigger-dispatch PR). Signature:

```
GET /api/sessions?status=active|archived|all&since=<epoch_ms>&limit=<n>
  Auth: existing /api/* bearer
  Response 200:
  {
    items: [
      {
        instance_id: string,
        kind: 'main' | 'recipe' | 'adhoc',
        state: 'starting' | 'idle' | 'busy' | 'exited' | 'archived',
        provider_id: string,
        cli_session_id: string | null,
        recipe_id: string | null,
        label: string,
        started_at: number,
        ended_at: number | null,
        live: boolean,
        queue_depth: number,
        workspace_id: string,
      }
    ],
    next_since?: number,
  }
```

Implementation:
- Query `pty-registry.listSessions()` → enrich with conductor state (state + queue_depth from `getConductor(id)`) → set `live: true`
- Query `agent_sessions` table joined to `recipe_instances` for label resolution → set `live: false`
- Union, dedupe by `instance_id` (live wins — its state is authoritative)
- Sort: live first (by `started_at` desc), then exited (by `ended_at` desc)
- Filter: `status` parameter narrows to live / archived / all; `since` paginates archived rows (oldest accepted timestamp), `limit` caps the page size (default 50, max 200)
- `next_since` is the `started_at` of the oldest archived row in the current page minus 1ms; null when fewer than `limit` archived rows returned

`kind` derivation:
- `instance_id === 'main'` → `'main'`
- `recipe_id` starts with `'__adhoc_'` → `'adhoc'`
- Otherwise → `'recipe'`

`label` derivation:
- `kind === 'main'` → `'Main Agent'`
- `kind === 'recipe'` → recipe_id (e.g. `'pr-review'`)
- `kind === 'adhoc'` → `'Spawn ' + instance_id.slice(-8)`

### 1.2 `POST /api/sessions/<id>/resume`

```
POST /api/sessions/<instance_id>/resume
  Auth: existing /api/* bearer
  Body: {} (no body required)
  Response 200: { ok: true, new_instance_id, session_id }
  Response 400: { error: 'session is currently live; resume not applicable' }
  Response 404: { error: 'session not found' }
  Response 422: { error: 'provider <id> does not support --resume' }
  Response 500: { error: 'spawn failed: <reason>' }
```

Handler:
1. Look up `agent_sessions` by `instance_id`. 404 if missing.
2. If `instance_id` is currently in `pty-registry.listSessions()` and not exited → 400 (already live).
3. Look up provider via `ws.agentCliProviders.get(row.agent_cli)`. If absent or `provider.supportsResume === false` → 422.
4. Call `runRecipe({ recipeId: row.recipe_id (if not __adhoc), isAdhoc: row.recipe_id.startsWith('__adhoc_'), resumeOf: row.cli_session_id, spawnMode: 'interactive', prompt: '', /* user can provide via UI input later */, ...defaults from row })`.
5. On success: UPDATE the old `agent_sessions` row to set new column `resumed_into_instance_id = <new>` (so the UI can render "Resumed as X" badges).
6. Return `{ ok: true, new_instance_id, session_id }`.

### 1.3 Provider `supportsResume` capability

Add optional `supportsResume?: boolean` to `AgentCliProvider`. Set to `true` for `copilotProvider`, `claudeProvider`, `agencyProvider`. Set to `false` for `echoStubProvider`, `e2eTestRunnerProvider`. When absent, default-false (safe).

### 1.4 Event bus topic emission

`mcp-server/src/pty-registry.ts`:
- After every `sessions.set(...)` in `registerPty`, call `emitChange('pty-registry')`
- After every `sessions.delete(...)` (the post-exit retention timer), call `emitChange('pty-registry')`
- After `conductor.dispose()` (when conductor state moves to exited), call `emitChange('pty-registry')`

`mcp-server/src/event-bus.ts` (or wherever topics are declared):
- Add `'pty-registry'` to the allowed topic union if such a list is enforced

### 1.5 DB migration V3

`mcp-server/src/db/migrations.ts`:

```ts
{
  version: 3,
  up: (db) => {
    db.exec(`
      ALTER TABLE agent_sessions ADD COLUMN resumed_into_instance_id TEXT;
    `);
  },
},
```

The column is nullable text; existing rows get NULL. Forward-only, no backfill.

### 1.6 Tests

- `tests/api-sessions-list.test.mjs` (new) — covers `GET /api/sessions` projection + pagination + dedup
- `tests/api-sessions-resume.test.mjs` (new) — covers happy path + 400 (live) + 404 + 422 (unsupported provider) + 500 (spawn fail). Uses `e2e-test-runner` (no resume) and a mock provider (with resume) injected into the workspace registry
- Extend `tests/db-migrations.test.mjs` with a V3 assertion that the new column exists

## Components — Commit #2 (SPA panel)

### 2.1 `mcp-server/web/src/components/TerminalsPanel.vue`

Layout:

```
┌─────────────────┬────────────────────────────────────────┐
│ Active          │                                        │
│  ● Main Agent   │                                        │
│    copilot · 5m │                                        │
│ ─────────────── │                                        │
│  ● pr-review    │           xterm.js host                │
│    agency · 2m  │       (selectedInstanceId)             │
│ ─────────────── │                                        │
│ ▾ Recent (24h)  │                                        │
│  ○ triage-wi    │                                        │
│    copilot · 1h │                                        │
│  ○ Spawn 4ab2c0 │                                        │
│    agency · 3h  │                                        │
│ ───────────     │                                        │
│ ▸ Older         │                                        │
└─────────────────┴────────────────────────────────────────┘
```

- Vertical tab list: fixed ~280px wide, `overflow-y: auto`
- Tab row: ~50px tall, padding 10px, three rows of content:
  - Row 1: icon (`pi-microchip` / `pi-book` / `pi-bolt`) + bold label
  - Row 2: state dot + provider id + relative time (`5m`, `2h`, `1d`)
  - Row 3 (archived only): `[Resume]` button revealed on hover
- Active session: left-border 3px solid + slightly darker bg
- State dot colors: green `idle`, blue `busy`, grey `starting`, red `exited` (archived shows hollow circle ○ instead of filled ●)
- Group headers: "Active" pinned at top (always expanded); "Recent (24h)" collapsible (default expanded); "Older" collapsible (default collapsed)
- "Show more" button at the bottom of the Older section paginates via `next_since`
- xterm host: same xterm.js setup as today's AgentPanel.vue, parametrized on `selectedInstanceId`. Tear down + re-mount on switch. WS URL is `/terminal/<selectedInstanceId>/ws`
- Empty state: "No active terminals. Spawn one via `recipe.run` or a trigger."

### 2.2 `mcp-server/web/src/stores/ui.ts`

Add to state:

```ts
terminals: {
  items: TerminalRow[];
  selectedInstanceId: string | null;
  archiveSince: number;            // floor for archived rows
  archiveExpanded: boolean;        // Older section open/closed
  loading: boolean;
}
```

Add actions:
- `refreshTerminals(opts?: { status?: 'all'|'active'|'archived', since?: number })`: GET /api/sessions; merge items
- `selectTerminal(instanceId: string)`: set selectedInstanceId
- `resumeTerminal(instanceId: string)`: POST /api/sessions/<id>/resume; optimistically insert a "starting" row + setSelected
- `loadMoreArchive()`: GET with current `next_since`; appends to items

### 2.3 `mcp-server/web/src/realtime.ts`

- Add `'pty-registry'` to the topic union type
- On `'pty-registry'` event: call `store.refreshTerminals({ status: 'active' })` (cheap — only refreshes the active partition, archive stays cached)

### 2.4 `mcp-server/web/src/api.ts`

Add `fetchSessions(opts)` and `resumeSession(id)` helpers, mirroring the existing `fetchTriggers` pattern.

### 2.5 Tests (SPA)

Minimal — the existing SPA doesn't have many component tests. Stick to what's testable:
- `composables/useFullscreen.ts` is the only composable with tests; we don't add new ones unless `TerminalsPanel.vue` introduces complex composable logic
- Manual smoke (via `npm run web:dev`): verify the panel renders, switches between sessions, shows live tabs, shows archived tabs, resume button works against a fake archive row

## Components — Commit #3 (wiring)

### 3.1 `mcp-server/web/src/App.vue`

- Locate the existing tab definition for `Agent` (loads `AgentPanel.vue`). Replace with a `Terminals` tab loading `TerminalsPanel.vue`
- Update the tab icon (e.g. `pi-microchip` → `pi-window-maximize` or similar — pick whatever PrimeIcons offers)
- Update the tab label string

### 3.2 Delete `AgentPanel.vue`

If grep confirms no other file imports it (and no external doc/test links to `/terminal/main` directly require it), delete:

```powershell
Remove-Item mcp-server/web/src/components/AgentPanel.vue
```

If something does still reference it, keep it as a thin shim that re-exports TerminalsPanel.vue.

### 3.3 Sidebar.vue — keep the agent pill

The Sidebar's "agent live status" pill stays unchanged. It reflects the main agent's running flag (from `store.agent`), independent of which terminal is selected in the new panel.

### 3.4 No changes needed to `/terminal/<id>/ws`

The existing WS endpoint serves any registered pty by instance_id. TerminalsPanel just opens a different one when the selection changes.

## Data flow

```
1. User clicks "Terminals" tab in App.vue
2. TerminalsPanel.vue mounts → store.refreshTerminals() → GET /api/sessions?status=all&limit=50
3. Backend unions pty-registry + agent_sessions; returns enriched list
4. Panel renders left column (Active group + Recent group + Older collapsed)
5. Panel picks selectedInstanceId = first active (or 'main' if it exists, else first archived if no active)
6. Panel opens WS to /terminal/<selectedInstanceId>/ws (existing endpoint)
7. pty-registry change emits 'pty-registry' on event bus → realtime SSE → store.refreshTerminals({status:'active'})
8. User clicks an active tab → tear down current WS, set selectedInstanceId, open new WS
9. User clicks an archived tab → tear down WS, show metadata-only view (no scrollback unless the pty is still in 10s retention)
10. User clicks [Resume] → POST /api/sessions/<id>/resume → backend spawns new pty → 200 with new instance_id
11. Optimistic UI: new "starting" row inserted in Active group, selectedInstanceId = new
12. pty-registry topic fires → real list refresh confirms the row + state transition
13. Backend marks old archive row resumed_into_instance_id; UI shows "↳ Resumed as <new-id>" badge on that row
```

## Cross-cutting concerns

### Error handling

| Scenario | Behavior |
|---|---|
| GET /api/sessions returns 5xx | Toast "Could not load sessions"; retry button in empty state |
| /terminal/<id>/ws fails to open | Show "Terminal unavailable — pty may have exited" in xterm area; retry button |
| Resume against echo-stub / e2e-test-runner | UI disables the button with tooltip "Provider does not support resume"; backend also returns 422 as a safety net |
| Resume succeeds but the spawned pty exits immediately | New row appears with `exited` state; selected; xterm shows the death banner |
| User selects an archived row from before clawdevbox restart (pty-registry has nothing, the recipe-instance log file may exist) | xterm shows "Historical session — open the log file at `<path>` for full transcript" with a link |
| `recipe.done` workspace-header bug from the trigger-dispatch PR | Out of scope for this PR; pre-existing |

### Security

- All routes use the existing /api/* bearer model. No new attack surface.
- `POST /api/sessions/<id>/resume` triggers a spawn — same auth/permission model as `recipe.run` MCP tool today.
- No PII / secrets in the list projection (`label` is recipe id or short hash, not user content).

### Performance

- `agent_sessions` queries use the existing `idx_sessions_instance` index. For pagination, add an `idx_sessions_archive` index `(status, started_at DESC)` if not already present (verify; the V1 schema has `idx_sessions_active` which filters on status — likely fine for the union query, but archive sort needs the descending index).
- `pty-registry.listSessions()` is in-memory; cheap.
- Event bus emits on every session register/exit — already throttled by the existing SSE infrastructure. No additional throttling needed at this scale (<100 sessions).

### Concurrency

- `selectedInstanceId` changes tear down the WS before opening a new one. Race: rapid clicks. Acceptable — the WS handshake is fast (<50ms loopback), and any race resolves cleanly because both WSs are independent.
- Resume + concurrent live emission of the same instance_id: backend's 400 ("already live") prevents the worst case. UI may briefly show stale data; next event-bus tick corrects.

## Testing strategy

| Phase | Command | Pass criteria |
|---|---|---|
| Per-file dev | `npm run typecheck` | clean |
| Backend unit | `node --import tsx --test tests/api-sessions-list.test.mjs tests/api-sessions-resume.test.mjs tests/db-migrations.test.mjs` | all pass |
| Backend regression | `npm test` | no new failures vs current baseline (510/3 flakes per the prior PR's verification) |
| SPA build | `npm --prefix web run build` | exit 0 |
| Manual smoke | `npm run web:dev`, click Terminals tab, switch between live + archived rows, click Resume on an archived row | renders correctly; resume spawns a new entry |

## Out-of-scope follow-ups

- Scrollback persistence for exited sessions (would need a per-session log file copy or DB BLOB)
- Free-text search of archived sessions
- Bulk operations (kill multiple, resume multiple)
- Customizable labels / pinning beyond main agent
- Mobile-first layout
- Session sharing (copy-link to a specific terminal view)
- DB GC of `agent_sessions` (deferred until growth becomes a real problem)
