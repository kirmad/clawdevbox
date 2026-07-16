# Terminals Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a new top-level **Terminals** view in the clawdevbox SPA — vertical tab list (active sessions on top, archived below in a collapsible time-paginated section), xterm.js host on the right, one-click resume from archived sessions. Replaces the single-purpose `AgentPanel.vue`.

Spec: `docs/superpowers/specs/2026-05-30-terminals-panel-design.md`.

**Architecture:** Single PR, three sequential commits. Commit #1 adds the backend `GET /api/sessions` list + `POST /api/sessions/<id>/resume` + V3 migration + pty-registry event-bus emissions. Commit #2 adds the SPA `TerminalsPanel.vue` + store hooks + realtime topic handler. Commit #3 wires it into `App.vue` and deletes `AgentPanel.vue`.

**Tech Stack:** TypeScript (mcp-server kernel + Vue 3 SPA), node:test, better-sqlite3 (V3 migration), xterm.js (existing in the SPA), Pinia store, PrimeVue components.

**Pre-existing affordances we reuse:**
- `event-bus.ts` already declares `'sessions'` topic (line 26) — just wire pty-registry to emit it
- `pty-registry.listSessions()` + `getConductor()` + `getSessionMeta()` already exist
- `agent_sessions` table schema is fine; only one new nullable column added
- `GET /api/sessions/<id>` (singular) added in the trigger-dispatch PR — extend with the list endpoint at the same handler
- xterm.js setup pattern: copy verbatim from `AgentPanel.vue`

---

## File Structure

### Commit #1 (backend)

| File | Action |
|---|---|
| `mcp-server/src/db/migrations.ts` | Add V3 migration: `ALTER TABLE agent_sessions ADD COLUMN resumed_into_instance_id TEXT` |
| `mcp-server/src/agent-clis/types.ts` | Add optional `supportsResume?: boolean` to `AgentCliProvider` |
| `mcp-server/src/agent-clis/copilot.ts` | Set `supportsResume: true` |
| `mcp-server/src/agent-clis/claude.ts` | Set `supportsResume: true` |
| `mcp-server/src/agent-clis/e2e-test-runner.ts` | Set `supportsResume: false` |
| `mcp-server/src/agent-clis/echo-stub.ts` | Set `supportsResume: false` |
| `C:\git\agency-provider\agency-provider.mjs` | Set `supportsResume: true` (sibling repo) |
| `mcp-server/src/pty-registry.ts` | Emit `'sessions'` on register / exit / conductor dispose |
| `mcp-server/src/cli/cron-api.ts` (or wherever /api/sessions/<id> lives) | Add `GET /api/sessions` list + `POST /api/sessions/<id>/resume` |
| `mcp-server/src/db/agent-sessions-store.ts` | Add `listAllSessions(db, opts)` helper + `markResumedInto(db, oldId, newId)` helper |
| `mcp-server/tests/api-sessions-list.test.mjs` | NEW — list endpoint coverage |
| `mcp-server/tests/api-sessions-resume.test.mjs` | NEW — resume endpoint coverage |
| `mcp-server/tests/db-migrations.test.mjs` | Extend with V3 assertion |
| `mcp-server/package.json:34` | Register 2 new test files |

### Commit #2 (SPA panel)

| File | Action |
|---|---|
| `mcp-server/web/src/api.ts` | Add `fetchSessions(opts)`, `resumeSession(id)`, `Session` types |
| `mcp-server/web/src/stores/ui.ts` | Add `terminals` state slice + `refreshTerminals` / `selectTerminal` / `resumeTerminal` / `loadMoreArchive` actions |
| `mcp-server/web/src/realtime.ts` | Add `'sessions'` topic handler |
| `mcp-server/web/src/components/TerminalsPanel.vue` | NEW — vertical tab list + xterm host |

### Commit #3 (wiring)

| File | Action |
|---|---|
| `mcp-server/web/src/App.vue` | Replace Agent tab with Terminals tab; import TerminalsPanel; drop AgentPanel import |
| `mcp-server/web/src/components/AgentPanel.vue` | DELETE (after confirming no other importer) |

---

## Commit #1 (backend) — 14 tasks

### Task 1.1: V3 migration + supportsResume capability + provider declarations

**Files:**
- Modify: `mcp-server/src/db/migrations.ts:211-232`
- Modify: `mcp-server/src/agent-clis/types.ts` (find `AgentCliProvider`)
- Modify: `mcp-server/src/agent-clis/copilot.ts`, `claude.ts`, `e2e-test-runner.ts`, `echo-stub.ts`
- Modify: `C:\git\agency-provider\agency-provider.mjs`
- Modify: `mcp-server/tests/db-migrations.test.mjs` (extend, don't replace)

- [ ] **Step 1: Append V3 migration**

Open `mcp-server/src/db/migrations.ts`. Append to the `migrations` array (after the V2 entry):

```ts
  {
    version: 3,
    up: (db) => {
      // PR #terminals-panel: track which spawn resumed an archived session
      // so the UI can render "Resumed as <new-id>" badges on the original row.
      // Spec: docs/superpowers/specs/2026-05-30-terminals-panel-design.md
      db.exec(`
        ALTER TABLE agent_sessions ADD COLUMN resumed_into_instance_id TEXT;
      `);
    },
  },
```

- [ ] **Step 2: Add `supportsResume` to provider interface**

Open `mcp-server/src/agent-clis/types.ts`. Find the `AgentCliProvider` interface. Add as an optional field with JSDoc:

```ts
  /**
   * Whether this provider supports resuming a prior CLI session (typically
   * via `--resume <session_id>`). When false (or absent), the Terminals
   * Panel UI disables the [Resume] button and the /api/sessions/<id>/resume
   * endpoint returns 422.
   */
  supportsResume?: boolean;
```

- [ ] **Step 3: Set capability on each builtin provider**

Edit each provider's exported object literal:

- `mcp-server/src/agent-clis/copilot.ts` — add `supportsResume: true`
- `mcp-server/src/agent-clis/claude.ts` — add `supportsResume: true`
- `mcp-server/src/agent-clis/e2e-test-runner.ts` — add `supportsResume: false`
- `mcp-server/src/agent-clis/echo-stub.ts` — add `supportsResume: false`

- [ ] **Step 4: Set capability on agency-provider (sibling repo)**

Edit `C:\git\agency-provider\agency-provider.mjs` — add `supportsResume: true` to the exported provider object.

(Commit separately in the agency-provider repo; document the cross-repo dependency in this PR's commit message.)

- [ ] **Step 5: Extend db-migrations test**

Open `mcp-server/tests/db-migrations.test.mjs`. Add a new test:

```js
test('migration V3 adds agent_sessions.resumed_into_instance_id column', async () => {
  const { runMigrations } = await import('../src/db/index.ts');
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const cols = db.prepare(`PRAGMA table_info(agent_sessions)`).all().map((c) => c.name);
  assert.ok(cols.includes('resumed_into_instance_id'), 'V3 should add resumed_into_instance_id');
  db.close();
});
```

- [ ] **Step 6: Typecheck + targeted tests**

```powershell
cd C:\git\clawdevbox\mcp-server
npm run typecheck
node --import tsx --test tests/db-migrations.test.mjs
```

Both must pass.

- [ ] **Step 7: NO commit yet** — commit at the end of Task 1.5 alongside the rest of the backend bundle.

### Task 1.2: pty-registry emits 'sessions' topic

**File:** `mcp-server/src/pty-registry.ts:114-207` (the `registerPty` function)

- [ ] **Step 1: Import emitChange**

Top of file, add:

```ts
import { emitChange } from './event-bus.ts';
```

- [ ] **Step 2: Emit on register**

In `registerPty`, after `sessions.set(opts.instanceId, session);` (around line 166), add:

```ts
  emitChange('sessions');
```

- [ ] **Step 3: Emit on exit-handler conductor dispose**

In the `onExit` callback (around lines 175-186), AFTER `session.conductor.dispose()` and the subscriber loop, add (before the `setTimeout` that GCs the session):

```ts
    emitChange('sessions');
```

- [ ] **Step 4: Emit on final GC**

Inside the `setTimeout` callback (around lines 198-205), after `sessions.delete(opts.instanceId)`, add:

```ts
        emitChange('sessions');
```

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 6: Run existing pty-registry tests**

```powershell
node --import tsx --test tests/pty-registry-conductor.test.mjs
```

Expected: 4/4 still pass (the topic emissions are side-effects that the existing tests don't assert on).

- [ ] **Step 7: NO commit yet.**

### Task 1.3: `listAllSessions` helper + `markResumedInto`

**File:** `mcp-server/src/db/agent-sessions-store.ts`

- [ ] **Step 1: Add `listAllSessions`**

Append to `agent-sessions-store.ts`:

```ts
export interface ListAllSessionsOpts {
  /** Lower bound (inclusive) for started_at when paginating archived rows. */
  since?: number;
  /** Page size (default 50, max 200). */
  limit?: number;
}

export function listAllSessions(
  db: Database,
  opts: ListAllSessionsOpts = {},
): AgentSessionRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // started_at filter: archived rows older than the cursor are excluded.
  // Live rows (interactive=1 AND status='running') are always included
  // regardless of `since` so the Active section is never paginated out.
  const since = opts.since ?? 0;
  return db
    .prepare(
      `SELECT * FROM agent_sessions
       WHERE (status = 'running')
          OR (started_at >= ?)
       ORDER BY (status = 'running') DESC, started_at DESC
       LIMIT ?`,
    )
    .all(since, limit) as AgentSessionRow[];
}

export function markResumedInto(
  db: Database,
  oldInstanceId: string,
  newInstanceId: string,
): void {
  db.prepare(
    `UPDATE agent_sessions
       SET resumed_into_instance_id = ?
     WHERE recipe_instance_id = ?`,
  ).run(newInstanceId, oldInstanceId);
}
```

- [ ] **Step 2: Typecheck**

```powershell
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: NO commit yet.**

### Task 1.4: `GET /api/sessions` (list) + `POST /api/sessions/<id>/resume`

**File:** Locate the handler file for `/api/sessions/<id>`. Per the trigger-dispatch PR, it's in `mcp-server/src/cli/cron-api.ts` (search for `/api/sessions/` to find the exact spot).

- [ ] **Step 1: Add `GET /api/sessions` (list)**

In the cron-api router, BEFORE the existing `/api/sessions/<instance_id>` route (so the more-specific singular match wins for IDs), add:

```ts
  // ----- GET /api/sessions (list) --------------------------------------------
  {
    if (path === '/api/sessions' && method === 'GET') {
      const status = (url.searchParams.get('status') ?? 'all') as 'active' | 'archived' | 'all';
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
      const { listSessions, getConductor, getSessionMeta } = await import('../pty-registry.ts');
      const { listAllSessions } = await import('../db/agent-sessions-store.ts');
      const { getDatabase } = await import('../db/index.ts');
      const db = getDatabase();

      // Live rows from pty-registry — these win for state/queue_depth.
      const liveRaw = listSessions();
      const liveIds = new Set(liveRaw.map((s) => s.instanceId));
      const live = liveRaw.map((s) => {
        const cond = getConductor(s.instanceId);
        const meta = getSessionMeta(s.instanceId);
        return {
          instance_id: s.instanceId,
          live: true,
          state: cond?.state ?? (s.exited ? 'exited' : 'unknown'),
          queue_depth: cond?.pendingCount() ?? 0,
          provider_id: meta?.agentCli ?? null,
          recipe_id: meta?.recipeId ?? null,
          cli_session_id: meta?.sessionId ?? null,
          workspace_id: s.workspaceId,
          started_at: meta?.startedAt ?? 0,
          ended_at: null as number | null,
        };
      });

      // Archived rows from agent_sessions; filter out anything already in `live`
      // so the dedupe key (instance_id) only carries the authoritative live entry.
      const archivedAll = listAllSessions(db, { since, limit });
      const archived = archivedAll
        .filter((row) => !liveIds.has(row.recipe_instance_id ?? ''))
        .map((row) => ({
          instance_id: row.recipe_instance_id ?? row.id,
          live: false,
          state: 'archived' as const,
          queue_depth: 0,
          provider_id: row.agent_cli,
          recipe_id: null as string | null, // joined separately below
          cli_session_id: row.cli_session_id,
          workspace_id: row.workspace_id,
          started_at: row.started_at,
          ended_at: row.ended_at,
        }));

      // Join archived rows with recipe_instances to get recipe_id for labels.
      const archivedInstanceIds = archived.map((a) => a.instance_id).filter(Boolean);
      let recipeMap: Record<string, string> = {};
      if (archivedInstanceIds.length > 0) {
        const placeholders = archivedInstanceIds.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT id, recipe_id FROM recipe_instances WHERE id IN (${placeholders})`)
          .all(...archivedInstanceIds) as Array<{ id: string; recipe_id: string }>;
        recipeMap = Object.fromEntries(rows.map((r) => [r.id, r.recipe_id]));
      }

      const enrich = (item: typeof live[number] | typeof archived[number]) => {
        const recipeId = item.recipe_id ?? recipeMap[item.instance_id] ?? null;
        const kind: 'main' | 'recipe' | 'adhoc' =
          item.instance_id === 'main'
            ? 'main'
            : (recipeId && recipeId.startsWith('__adhoc_'))
              ? 'adhoc'
              : 'recipe';
        const label =
          kind === 'main' ? 'Main Agent'
            : kind === 'adhoc' ? `Spawn ${item.instance_id.slice(-8)}`
            : recipeId ?? item.instance_id;
        return { ...item, recipe_id: recipeId, kind, label };
      };

      const items: unknown[] = [];
      if (status === 'all' || status === 'active') items.push(...live.map(enrich));
      if (status === 'all' || status === 'archived') items.push(...archived.map(enrich));

      const nextSince = archived.length === limit && archived.length > 0
        ? (archived[archived.length - 1]!.started_at - 1)
        : undefined;

      sendJson(res, 200, { items, ...(nextSince !== undefined ? { next_since: nextSince } : {}) });
      return true;
    }
  }
```

This block must come BEFORE the singular `/api/sessions/<instance_id>` route in the router — otherwise the singular regex will swallow `'/api/sessions'` (matching empty instance_id).

- [ ] **Step 2: Add `POST /api/sessions/<instance_id>/resume`**

After the singular `/api/sessions/<id>` GET route, add:

```ts
  // ----- POST /api/sessions/<instance_id>/resume ----------------------------
  {
    const m = path.match(/^\/api\/sessions\/([^/]+)\/resume\/?$/);
    if (m && method === 'POST') {
      const instanceId = decodeURIComponent(m[1]!);
      const { hasSession } = await import('../pty-registry.ts');
      if (hasSession(instanceId)) {
        sendJson(res, 400, { error: 'session is currently live; resume not applicable' });
        return true;
      }
      const { getDatabase } = await import('../db/index.ts');
      const db = getDatabase();
      const row = db
        .prepare('SELECT * FROM agent_sessions WHERE recipe_instance_id = ? OR id = ?')
        .get(instanceId, instanceId) as Record<string, unknown> | undefined;
      if (!row) { sendJson(res, 404, { error: 'session not found' }); return true; }

      const provider = ctx.ws.agentCliProviders.get(String(row.agent_cli));
      if (!provider) {
        sendJson(res, 422, { error: `provider not registered: ${row.agent_cli}` });
        return true;
      }
      if (!provider.supportsResume) {
        sendJson(res, 422, { error: `provider '${row.agent_cli}' does not support --resume` });
        return true;
      }
      if (!row.cli_session_id) {
        sendJson(res, 422, { error: 'session has no cli_session_id; cannot resume' });
        return true;
      }

      // Look up the original recipe_id (if any) for ad-hoc detection.
      let originalRecipeId: string | null = null;
      if (row.recipe_instance_id) {
        const ri = db.prepare('SELECT recipe_id FROM recipe_instances WHERE id = ?').get(row.recipe_instance_id) as { recipe_id?: string } | undefined;
        originalRecipeId = ri?.recipe_id ?? null;
      }
      const isAdhoc = originalRecipeId !== null && originalRecipeId.startsWith('__adhoc_');

      const wsRow = db
        .prepare('SELECT id, path FROM workspaces WHERE id = ?')
        .get(row.workspace_id) as { id: string; path: string } | undefined;
      if (!wsRow) {
        sendJson(res, 500, { error: `workspace not found: ${row.workspace_id}` });
        return true;
      }

      try {
        const { runRecipe } = await import('../recipe-runner.ts');
        const { resolveConfig } = await import('../config.ts');
        const { resolveWorkspacesRoot } = await import('../workspaces-store.ts');
        const cfg = resolveConfig({ projectDir: ctx.ws.projectDir, globalDir: ctx.ws.globalDir });
        const result = await runRecipe({
          recipeId: isAdhoc ? null : originalRecipeId,
          recipeSnapshot: '',
          isAdhoc,
          prompt: '',
          spawnMode: 'interactive',
          resumeOf: String(row.cli_session_id),
          workspaceInfo: { id: wsRow.id, path: wsRow.path },
          agentCli: String(row.agent_cli),
          workspacesRoot: resolveWorkspacesRoot(),
          ws: ctx.ws,
          cfg,
        });
        if (result.spawn_error) {
          sendJson(res, 500, { error: `spawn failed: ${result.spawn_error.code}: ${result.spawn_error.message}` });
          return true;
        }
        const { markResumedInto } = await import('../db/agent-sessions-store.ts');
        markResumedInto(db, instanceId, result.recipe_instance_id);
        sendJson(res, 200, { ok: true, new_instance_id: result.recipe_instance_id, session_id: result.session_id });
      } catch (err) {
        sendJson(res, 500, { error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      return true;
    }
  }
```

(The `runRecipe` call uses `prompt: ''` — the resumed CLI loads the prior session's transcript from disk; no new prompt is required to wake it. If the prompt-required logic in `runRecipe` rejects empty strings, change to a single space `' '` to satisfy the check.)

- [ ] **Step 3: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 4: NO commit yet.**

### Task 1.5: New endpoint tests

**Files:**
- Create: `mcp-server/tests/api-sessions-list.test.mjs`
- Create: `mcp-server/tests/api-sessions-resume.test.mjs`
- Modify: `mcp-server/package.json:34` (register both)

- [ ] **Step 1: Write `api-sessions-list.test.mjs`**

Pattern follows `tests/api-sessions.test.mjs` (singular). Cover:
- GET /api/sessions with no sessions registered → 200 with empty items
- Register a fake live session via the pty-registry test seam → GET returns 1 item with `live: true`, `kind: 'main'` (for instance_id='main') / `kind: 'recipe'` (for an `ri_xxx` id)
- Insert an agent_sessions row directly → GET with `status=archived` returns it with `live: false, state: 'archived'`
- Register live + insert archived with same `recipe_instance_id` → GET returns only one entry (live wins)
- Pagination: insert 60 archived rows, GET with `limit=25` → 25 items + `next_since` set; subsequent GET with `since=<cursor>` returns the next page
- `kind` derivation: instance_id='main' → 'main'; recipe_id starts with '__adhoc_' → 'adhoc'; else → 'recipe'

- [ ] **Step 2: Write `api-sessions-resume.test.mjs`**

Cover:
- Happy path: register a mock provider with `supportsResume: true` in the workspace registry, insert an archived agent_sessions row with cli_session_id, POST /api/sessions/<old>/resume → 200 with `{new_instance_id, session_id}`. Assert the old row's `resumed_into_instance_id` is set.
- 400: POST against a currently-live instance → "session is currently live"
- 404: POST against unknown id → "session not found"
- 422 unsupported provider: insert a row with `agent_cli: 'echo-stub'` (or e2e-test-runner) → "provider does not support --resume"
- 422 no cli_session_id: insert a row with `cli_session_id = NULL` → "session has no cli_session_id"
- 500: stub the workspace registry to throw → "spawn failed"

Use the same `runRecipeFn` injection seam from `tests/spawn-endpoint.test.mjs` if available; otherwise stub by registering a fake provider whose `spawnSession` returns a fake handle.

- [ ] **Step 3: Register both test files in package.json**

Open `mcp-server/package.json`. Insert `tests/api-sessions-list.test.mjs` and `tests/api-sessions-resume.test.mjs` into the test script, alphabetically near `api-sessions.test.mjs`.

- [ ] **Step 4: Run all 4 sessions-related test files**

```powershell
cd C:\git\clawdevbox\mcp-server
node --import tsx --test tests/api-sessions.test.mjs tests/api-sessions-list.test.mjs tests/api-sessions-resume.test.mjs tests/db-migrations.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Full suite regression**

```powershell
npm test
```

Expected: no new failures vs the prior PR's baseline (~510/3 flakes).

- [ ] **Step 6: Commit (single commit for ALL of Commit #1's work — Tasks 1.1 through 1.5)**

```powershell
cd C:\git\clawdevbox
git add mcp-server/src/db/migrations.ts mcp-server/src/agent-clis/types.ts mcp-server/src/agent-clis/copilot.ts mcp-server/src/agent-clis/claude.ts mcp-server/src/agent-clis/e2e-test-runner.ts mcp-server/src/agent-clis/echo-stub.ts mcp-server/src/pty-registry.ts mcp-server/src/db/agent-sessions-store.ts mcp-server/src/cli/cron-api.ts mcp-server/tests/api-sessions-list.test.mjs mcp-server/tests/api-sessions-resume.test.mjs mcp-server/tests/db-migrations.test.mjs mcp-server/package.json
git commit -m "feat(api): GET /api/sessions list + POST /api/sessions/<id>/resume + V3 migration" -m "Adds the backend surface the Terminals Panel SPA will consume. GET /api/sessions returns a union of pty-registry live sessions and agent_sessions archived rows with state + queue_depth + provider_id + kind + label. POST /api/sessions/<id>/resume spawns a fresh interactive pty via runRecipe(resumeOf=cli_session_id) and marks the original row's new resumed_into_instance_id column (V3 migration). pty-registry emits 'sessions' on register/exit/conductor-dispose so the SPA stays live." -m "AgentCliProvider gains optional supportsResume — copilot/claude/agency=true, echo-stub/e2e-test-runner=false. Endpoint returns 422 for providers that don't support resume." -m "Cross-repo: agency-provider commit separately sets supportsResume: true." -m "Spec: docs/superpowers/specs/2026-05-30-terminals-panel-design.md (Commit #1)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 7: Agency-provider commit (separate repo)**

```powershell
cd C:\git\agency-provider
# Edit agency-provider.mjs to add supportsResume: true
git add agency-provider.mjs
git commit -m "feat: declare supportsResume: true for the Terminals Panel UI" -m "Lets the new /api/sessions/<id>/resume endpoint accept agency-spawned sessions for one-click resume in the Terminals Panel." -m "Spec: clawdevbox/docs/superpowers/specs/2026-05-30-terminals-panel-design.md" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Commit #2 (SPA panel) — 6 tasks

### Task 2.1: API helpers + types in `api.ts`

**File:** `mcp-server/web/src/api.ts`

- [ ] **Step 1: Add `Session` interface and helpers**

Append:

```ts
// -- Sessions / Terminals ----------------------------------------------------

export interface Session {
  instance_id: string;
  kind: 'main' | 'recipe' | 'adhoc';
  state: 'starting' | 'idle' | 'busy' | 'exited' | 'archived' | 'unknown';
  provider_id: string | null;
  cli_session_id: string | null;
  recipe_id: string | null;
  label: string;
  started_at: number;
  ended_at: number | null;
  live: boolean;
  queue_depth: number;
  workspace_id: string;
}

export interface FetchSessionsResponse {
  items: Session[];
  next_since?: number;
}

export function fetchSessions(opts: { status?: 'all'|'active'|'archived'; since?: number; limit?: number } = {}): Promise<FetchSessionsResponse> {
  const p = new URLSearchParams();
  if (opts.status) p.set('status', opts.status);
  if (opts.since !== undefined) p.set('since', String(opts.since));
  if (opts.limit !== undefined) p.set('limit', String(opts.limit));
  return fetchJson(`/api/sessions${p.toString() ? '?' + p.toString() : ''}`);
}

export interface ResumeSessionResponse {
  ok: true;
  new_instance_id: string;
  session_id: string;
}

export async function resumeSession(instanceId: string): Promise<ResumeSessionResponse> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(instanceId)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`resume failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as ResumeSessionResponse;
}
```

### Task 2.2: Store state slice + actions

**File:** `mcp-server/web/src/stores/ui.ts`

- [ ] **Step 1: Add to state**

```ts
terminals: {
  items: [] as Session[],
  selectedInstanceId: null as string | null,
  archiveSince: 0,
  archiveCursor: undefined as number | undefined,
  archiveExpanded: false,
  loading: false,
},
```

- [ ] **Step 2: Add actions**

```ts
async refreshTerminals(opts: { status?: 'all'|'active'|'archived'; since?: number } = {}): Promise<void> {
  this.terminals.loading = true;
  try {
    const status = opts.status ?? (this.terminals.archiveExpanded ? 'all' : 'all');
    const res = await fetchSessions({ status, since: opts.since, limit: 50 });
    // For an "active-only" refresh (e.g. from a 'sessions' topic event),
    // merge: replace live entries, keep archived as-is.
    if (status === 'active') {
      const archived = this.terminals.items.filter((i) => !i.live);
      this.terminals.items = [...res.items, ...archived];
    } else {
      this.terminals.items = res.items;
      this.terminals.archiveCursor = res.next_since;
    }
    if (!this.terminals.selectedInstanceId && this.terminals.items.length > 0) {
      // Prefer main, else first live, else first overall.
      const main = this.terminals.items.find((i) => i.instance_id === 'main');
      const firstLive = this.terminals.items.find((i) => i.live);
      this.terminals.selectedInstanceId = (main ?? firstLive ?? this.terminals.items[0]!).instance_id;
    }
  } finally {
    this.terminals.loading = false;
  }
},

selectTerminal(instanceId: string): void {
  this.terminals.selectedInstanceId = instanceId;
},

async resumeTerminal(instanceId: string): Promise<void> {
  const r = await resumeSession(instanceId);
  this.terminals.selectedInstanceId = r.new_instance_id;
  // Optimistic — the 'sessions' topic event will refresh authoritatively.
  await this.refreshTerminals({ status: 'all' });
},

async loadMoreArchive(): Promise<void> {
  if (!this.terminals.archiveCursor) return;
  const res = await fetchSessions({ status: 'archived', since: this.terminals.archiveCursor, limit: 50 });
  // Append (archive is sorted desc; older items go to the end).
  this.terminals.items = [...this.terminals.items, ...res.items];
  this.terminals.archiveCursor = res.next_since;
},
```

Add `import { fetchSessions, resumeSession, type Session } from '../api'` at the top.

### Task 2.3: realtime topic handler

**File:** `mcp-server/web/src/realtime.ts`

- [ ] **Step 1: Add 'sessions' to the timers + switch**

In the `timers` object initializer (line 13), add `sessions: null`.

In the topic handler switch (the if-chain around lines 40-44), add:

```ts
      if (t === 'sessions')  schedule('sessions', () => store.refreshTerminals({ status: 'active' }));
```

### Task 2.4: `TerminalsPanel.vue` component

**File:** `mcp-server/web/src/components/TerminalsPanel.vue` (new)

Create the component following the patterns in AgentPanel.vue (for xterm setup) and RecipesPanel.vue (for list + selection).

- [ ] **Step 1: Write the SFC**

```vue
<script setup lang="ts">
/**
 * TerminalsPanel — multi-session terminal view.
 *
 * Left column: vertical tab list (active sessions on top, archived
 * below in a collapsible time-paginated section).
 * Right column: xterm.js attached to the selected session's WS.
 *
 * Reuses the xterm.js setup pattern from AgentPanel.vue.
 * Subscribes to the 'sessions' topic via realtime.ts for live updates.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import type { Session } from '../api';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const store = useUiStore();
const termHost = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;

const selectedId = computed(() => store.terminals.selectedInstanceId);
const activeSessions = computed(() => store.terminals.items.filter((s) => s.live));
const recentArchived = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return store.terminals.items.filter((s) => !s.live && (s.ended_at ?? s.started_at) >= cutoff);
});
const olderArchived = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return store.terminals.items.filter((s) => !s.live && (s.ended_at ?? s.started_at) < cutoff);
});

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

function iconFor(kind: Session['kind']): string {
  if (kind === 'main') return 'pi pi-microchip';
  if (kind === 'recipe') return 'pi pi-book';
  return 'pi pi-bolt';
}

function stateClass(state: Session['state']): string {
  return `state-dot state-${state}`;
}

async function teardown(): Promise<void> {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (term) { try { term.dispose(); } catch {} term = null; }
  fit = null;
}

async function attach(): Promise<void> {
  if (!termHost.value || !selectedId.value) return;
  await teardown();
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Cascadia Code, ui-monospace, Menlo, monospace',
    fontSize: isMobile ? 12 : 13,
    scrollback: 2000,
    theme: { background: '#15171d', foreground: '#d8dee9' },
    allowProposedApi: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termHost.value);
  await nextTick();
  try { fit.fit(); } catch {}

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const id = encodeURIComponent(selectedId.value);
  ws = new WebSocket(`${proto}//${location.host}/terminal/${id}/ws`);
  ws.onmessage = (ev) => {
    let msg: { type?: string; content?: string; chunk?: string };
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot' && msg.content && term) term.write(msg.content);
    if (msg.type === 'data' && msg.chunk && term) term.write(msg.chunk);
  };
  if (term) {
    term.onData((d) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d }));
    });
  }
}

function select(s: Session): void {
  store.selectTerminal(s.instance_id);
}

async function resume(s: Session): Promise<void> {
  try {
    await store.resumeTerminal(s.instance_id);
  } catch (err) {
    console.error('resume failed:', err);
  }
}

onMounted(async () => {
  await store.refreshTerminals({ status: 'all' });
  await attach();
});

onBeforeUnmount(async () => {
  await teardown();
});

watch(selectedId, () => { attach(); });
</script>

<template>
  <div class="terminals-panel">
    <aside class="tab-list">
      <div class="group-header">Active</div>
      <div v-if="activeSessions.length === 0" class="empty">No active terminals.</div>
      <button
        v-for="s in activeSessions"
        :key="s.instance_id"
        class="tab-row"
        :class="{ selected: s.instance_id === selectedId }"
        @click="select(s)"
      >
        <div class="row-1">
          <i :class="iconFor(s.kind)" />
          <span class="label">{{ s.label }}</span>
        </div>
        <div class="row-2">
          <span :class="stateClass(s.state)" />
          <span class="muted">{{ s.provider_id ?? '—' }} · {{ relTime(s.started_at) }}</span>
        </div>
      </button>

      <details class="group" :open="store.terminals.archiveExpanded || recentArchived.length > 0">
        <summary class="group-header">Recent (24h)</summary>
        <button
          v-for="s in recentArchived"
          :key="s.instance_id"
          class="tab-row archived"
          :class="{ selected: s.instance_id === selectedId }"
          @click="select(s)"
        >
          <div class="row-1">
            <i :class="iconFor(s.kind)" />
            <span class="label">{{ s.label }}</span>
          </div>
          <div class="row-2">
            <span :class="stateClass(s.state)" />
            <span class="muted">{{ s.provider_id ?? '—' }} · {{ relTime(s.ended_at ?? s.started_at) }}</span>
          </div>
          <button class="resume-btn" @click.stop="resume(s)">Resume</button>
        </button>
      </details>

      <details class="group">
        <summary class="group-header">Older</summary>
        <button
          v-for="s in olderArchived"
          :key="s.instance_id"
          class="tab-row archived"
          :class="{ selected: s.instance_id === selectedId }"
          @click="select(s)"
        >
          <div class="row-1">
            <i :class="iconFor(s.kind)" />
            <span class="label">{{ s.label }}</span>
          </div>
          <div class="row-2">
            <span :class="stateClass(s.state)" />
            <span class="muted">{{ s.provider_id ?? '—' }} · {{ relTime(s.ended_at ?? s.started_at) }}</span>
          </div>
          <button class="resume-btn" @click.stop="resume(s)">Resume</button>
        </button>
        <button
          v-if="store.terminals.archiveCursor"
          class="load-more"
          @click="store.loadMoreArchive()"
        >Show more</button>
      </details>
    </aside>
    <main class="xterm-host" ref="termHost" />
  </div>
</template>

<style scoped>
.terminals-panel { display: flex; height: 100%; width: 100%; }
.tab-list { width: 280px; min-width: 280px; max-width: 280px; overflow-y: auto; border-right: 1px solid #23262d; padding: 8px 4px; }
.group-header { font-size: 11px; color: #7c8290; text-transform: uppercase; padding: 8px 10px 4px; cursor: pointer; }
.group { margin-top: 8px; }
.empty { font-size: 12px; color: #7c8290; padding: 8px 10px; }
.tab-row { display: block; width: 100%; text-align: left; background: transparent; border: none; padding: 10px; border-left: 3px solid transparent; cursor: pointer; color: #d8dee9; position: relative; }
.tab-row:hover { background: #1a1d24; }
.tab-row.selected { background: #1c2029; border-left-color: #4a8be8; }
.tab-row .row-1 { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.tab-row .row-2 { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 11px; }
.muted { color: #7c8290; }
.state-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.state-idle { background: #4caf50; }
.state-busy { background: #4a8be8; }
.state-starting { background: #a0a0a0; }
.state-exited { background: #d44; }
.state-archived { background: transparent; border: 1px solid #7c8290; }
.state-unknown { background: #7c8290; }
.resume-btn { position: absolute; right: 8px; top: 10px; padding: 2px 8px; font-size: 11px; background: #23262d; color: #d8dee9; border: 1px solid #3a3f4a; border-radius: 3px; cursor: pointer; display: none; }
.archived:hover .resume-btn { display: inline-block; }
.load-more { display: block; margin: 6px auto; padding: 4px 10px; font-size: 11px; background: transparent; color: #7c8290; border: 1px solid #3a3f4a; border-radius: 3px; cursor: pointer; }
.xterm-host { flex: 1; background: #15171d; min-height: 0; }
</style>
```

- [ ] **Step 2: Typecheck + SPA build**

```powershell
cd C:\git\clawdevbox\mcp-server
npm run typecheck
cd web; npm run build
```

Both must succeed.

- [ ] **Step 3: Commit Commit #2**

```powershell
cd C:\git\clawdevbox
git add mcp-server/web/src/api.ts mcp-server/web/src/stores/ui.ts mcp-server/web/src/realtime.ts mcp-server/web/src/components/TerminalsPanel.vue
git commit -m "feat(web): TerminalsPanel.vue with vertical tab list + archive resume" -m "New top-level SPA component showing all spawned sessions as a vertical tab list. Active sessions render on top with state dots (green idle / blue busy / grey starting / red exited); archived sessions appear in collapsible 'Recent (24h)' and 'Older' groups with a hover-revealed [Resume] button. Right column hosts xterm.js attached to /terminal/<selectedInstanceId>/ws. Subscribes to the 'sessions' topic via realtime.ts for live tab updates." -m "Not wired into App.vue yet — Commit #3 replaces the Agent tab." -m "Spec: docs/superpowers/specs/2026-05-30-terminals-panel-design.md (Commit #2)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Commit #3 (App.vue wiring + AgentPanel deletion)

### Task 3.1: App.vue — replace Agent tab

**File:** `mcp-server/web/src/App.vue`

- [ ] **Step 1: Swap import**

Find:
```ts
import AgentPanel from './components/AgentPanel.vue';
```
Replace with:
```ts
import TerminalsPanel from './components/TerminalsPanel.vue';
```

- [ ] **Step 2: Replace tab definition**

Locate the tab declaration for `Agent` in the template (search for `AgentPanel` or `agent` tab id). Replace `<AgentPanel />` with `<TerminalsPanel />` and update:
- Tab id from `'agent'` to `'terminals'`
- Tab label from `Agent` to `Terminals`
- Tab icon — pick `pi-window-maximize` or similar

(If the SPA persists `activeTab` to localStorage, the old `'agent'` key may need migration. Search for `localStorage.*activeTab` — if found, treat unknown `'agent'` value as `'terminals'` on read.)

- [ ] **Step 3: Build check**

```powershell
cd C:\git\clawdevbox\mcp-server\web; npm run build
```

Expected: exit 0.

### Task 3.2: Delete AgentPanel.vue

- [ ] **Step 1: Verify no other importer**

```powershell
cd C:\git\clawdevbox
grep -rn "AgentPanel" --include="*.{vue,ts}" mcp-server/web/
```

Expected: only references in the now-deleted import line and the component file itself. If anything else references it, keep AgentPanel.vue as a thin shim that re-exports TerminalsPanel.vue.

- [ ] **Step 2: Delete**

```powershell
Remove-Item mcp-server/web/src/components/AgentPanel.vue
```

- [ ] **Step 3: Build check**

```powershell
cd C:\git\clawdevbox\mcp-server\web; npm run build
```

Expected: exit 0.

### Task 3.3: Commit Commit #3

- [ ] **Step 1: Commit**

```powershell
cd C:\git\clawdevbox
git add mcp-server/web/src/App.vue
git rm mcp-server/web/src/components/AgentPanel.vue
git commit -m "feat(web): wire TerminalsPanel into App.vue; remove AgentPanel" -m "Replaces the single-purpose Agent tab (which only showed /terminal/main) with the new Terminals tab that shows all sessions. AgentPanel.vue is deleted — no other importers found." -m "Spec: docs/superpowers/specs/2026-05-30-terminals-panel-design.md (Commit #3)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Verification sequence (after all 3 commits)

1. `cd C:\git\clawdevbox\mcp-server && npm run typecheck` — exit 0
2. `npm test` — no new failures vs the prior PR's baseline
3. `cd web && npm run build` — exit 0
4. Manual smoke (via `npm run web:dev`):
   - Click Terminals tab; verify the Main Agent appears in Active (if running)
   - Spawn a recipe interactively: `recipe.run` with `spawn_mode: 'interactive'`; verify the new instance appears in Active within a few seconds (event-bus topic)
   - Kill the recipe (close its CLI); verify it moves to Recent (24h) archived section
   - Click [Resume] on the archived row; verify a new entry appears in Active and selection switches to it
   - Switch between sessions; verify the xterm host updates correctly
5. `git --no-pager log --oneline -4` — 3 PR commits + 1 spec commit visible

## Push policy

Do NOT push without explicit user confirmation.
