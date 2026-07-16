# `cron.*` HTTP API + trigger kernel

The trigger kernel is the in-process subsystem that turns registered triggers
into fires, dispatches them through a concurrency-capped runner, persists
their outputs, and retries failures on an exponential backoff. It runs
**cron triggers** (`cron_expression` rows in the `triggers` table), **manual
fires** (`trigger.fire` and `POST /api/fires/:id/retry`), and **trigger
scripts** (the script runtime resolved from the trigger TYPE's manifest).

Unlike the rest of the MCP surface, the kernel control plane is **HTTP**,
not MCP. The endpoints below are mounted by `cli/start.ts` inside the same
HTTP server that hosts `/healthz`, `/api/events`, and the SPA. The
implementation lives in `mcp-server/src/cli/cron-api.ts`.

The kernel boots automatically when `clawdevbox start` runs (Phase 8). When
`clawdevbox mcp` is invoked without a running service, it auto-bootstraps
the HTTP service via `ensureHttpServiceRunning` (`cli/mcp.ts`), so agents
never have to start it explicitly.

The constituent components are:

| Component | File | Responsibility |
|---|---|---|
| **Scheduler** | `scheduler.ts` | Single `setTimeout` that wakes when the next cron tick is due, enqueues fires, and promotes retrying rows. |
| **Dispatcher** | `dispatcher.ts` | Claims queued fires (capped at `maxConcurrent`, default 4), runs them through the trigger-runner, writes outputs to disk, and routes outcomes. |
| **Fires store** | `db/fires-store.ts` | `fires` table CRUD + the atomic `claimNextFire` that enforces the §6.3 overlap-skip protocol. |
| **Trigger runner** | `trigger-runner.ts` | Spawns trigger scripts with the stdin envelope, the per-fire callback secret, and `attempt-N/stdout.txt`/`stderr.txt` redirection. |

## Fire lifecycle

```
                  ┌────────────────────┐
                  │  scheduler wake    │
                  │  or trigger.fire   │
                  └─────────┬──────────┘
                            │ insert row
                            ▼
                       ┌─────────┐
                       │ queued  │
                       └────┬────┘
                            │ dispatcher.pickUp()
                            ▼
                       ┌─────────┐
       overlap with    │ running │
       same-trigger ◀──┤         │
       running fire    └────┬────┘
            │               ├─ success ─────▶ ┌─────────┐
            ▼               │                 │ success │
       ┌─────────┐          │                 └─────────┘
       │ skipped │          │
       └─────────┘          │ failure
                            ▼
                   attempts < max?
                  ┌──── yes ────┐    ┌──── no ────┐
                  ▼             │    ▼            │
            ┌──────────┐        │ ┌──────┐        │
            │retrying  │        │ │ dead │ + dead │
            │next_retry│        │ │      │ letter │
            │   _at    │        │ └──────┘ inbox  │
            └────┬─────┘        │                 │
                 │ next wake    │                 │
                 ▼              │                 │
            ┌─────────┐         │                 │
            │ queued  │ ────────┘                 │
            └─────────┘                           │
                                                  │
        ┌────── POST /api/fires/:id/retry ─────────┤
        │  failed | dead | skipped → queued       │
        └─────────────────────────────────────────┘
```

| Status | Terminal? | Description |
|---|---|---|
| `queued` | no | Row waiting for a dispatcher pick-up. |
| `running` | no | Dispatcher has claimed it; trigger script (or recipe/resume binding) is executing. |
| `success` | yes | Binding returned cleanly. `last_run_*` audit fields are updated on the trigger. |
| `failed` | no | Last attempt failed but attempts remain. `retrying` row, `next_retry_at` set. |
| `retrying` | no | Synonym surfaced in API filters; storage-level status is `failed` with a future `next_retry_at`. |
| `dead` | yes | All `max_attempts` exhausted. A dead-letter inbox row is created. |
| `skipped` | yes | Overlap-skip: another fire for the same trigger was already running when this one was claimed. |

The retry ladder defaults to `[30000, 120000, 600000]` ms (30 s / 2 min / 10
min) and is per-trigger via `trigger.register`'s `backoff_ms` / `max_attempts`.

## Filesystem layout

Every fire produces a directory under the workspace:

```
<workspace>/.clawdevbox/fires/<fire_id>/
├── attempt-1/
│   ├── stdout.txt        ← trigger-runner stdout capture
│   ├── stderr.txt        ← trigger-runner stderr capture
│   └── ...               ← any observation files the trigger script wrote
│                            into envelope.output_dir (kernel does not read)
├── attempt-2/
│   └── ...
```

`attempts_available` in the fire-detail response enumerates the attempts on
disk. The default response shape returns the latest attempt; `?attempt=N`
picks a specific one.

## Authentication

| Surface | Auth | Source |
|---|---|---|
| `GET /healthz` | none | — |
| `GET /api/cron/*`, `GET /api/fires*`, `POST /api/cron/*`, `POST /api/fires/*/retry`, `GET /api/sessions/:id` | `Authorization: Bearer <token>` | `cfg.http.token` (the service-wide token from `config.json` or `CLAWDEVBOX_TOKEN`). |
| `POST /dispatch/:fire_id`, `POST /spawn/:fire_id` | `Authorization: Bearer <secret>` | A **per-fire** secret minted by the dispatcher when it launches a script binding. The secret is injected into the script process as `CLAWDEVBOX_FIRE_SECRET` and is only valid while the fire is in flight. |

Bearer comparisons are constant-time. Missing/wrong tokens return `401`
with `WWW-Authenticate: Bearer realm="clawdevbox"`.

---

## Endpoints

### `GET /api/cron/status`

**Auth:** Bearer required.

Returns the singleton service descriptor, the scheduler/dispatcher live
counters, and the DB metadata. Used by `clawdevbox start` to verify an
already-bound port belongs to *our* service (spec §8.5), by the MCP
bootstrap probe, and by the SPA admin pane.

**Response (200):**

```json
{
  "service": {
    "pid": 18452,
    "port": 5200,
    "started_at": 1715534812000,
    "version": "0.1.0"
  },
  "scheduler": {
    "next_wake_at": 1715534870000,
    "last_wake_at": 1715534810000,
    "total_wakes": 17
  },
  "dispatcher": {
    "in_flight": 1,
    "max_concurrent": 4,
    "queued_count": 0,
    "retrying_count": 2,
    "dead_count": 0
  },
  "db": {
    "path": "C:\\Users\\me\\.clawdevbox\\clawdevbox.db",
    "schema_version": 1
  }
}
```

`scheduler.next_wake_at` may be `null` when no triggers are armed.

**Errors:** `401` (missing/invalid bearer).

### `GET /api/fires`

**Auth:** Bearer required.

List fires across workspaces. Default `limit=50`, max `500`. Results are
ordered by `scheduled_at DESC, fire_id DESC`.

**Query parameters:**

| Name | Type | Description |
|---|---|---|
| `status` | comma-separated list | Filter by status; e.g. `status=queued,running`. |
| `workspace_id` | string | Restrict to one workspace. |
| `trigger_id` | string | Restrict to one trigger. |
| `limit` | int (1..500) | Page size. Default 50. |
| `before` | unix-ms | Pagination cursor; returns rows with `scheduled_at < before`. |

**Response (200):**

```json
{
  "fires": [
    {
      "fire_id": "fire_abc",
      "workspace_id": "ws_…",
      "trigger_id": "demo.x#alpha",
      "source": "manual",
      "status": "success",
      "attempt": 1,
      "max_attempts": 3,
      "scheduled_at": 1715534800000,
      "started_at": 1715534801000,
      "finished_at": 1715534803000,
      "next_retry_at": null,
      "error": null,
      "output_dir": "…/.clawdevbox/fires/fire_abc"
    }
  ],
  "count": 1,
  "next_offset": null
}
```

`next_offset` is the `scheduled_at` of the last row when more pages exist,
else `null`.

**Errors:** `401`.

### `GET /api/fires/:fire_id`

**Auth:** Bearer required.

Return the full fire row plus `stdout`, `stderr`, and any Mode-B
`callbacks.json` content from the requested attempt directory.

**Query parameters:**

| Name | Type | Description |
|---|---|---|
| `attempt` | int ≥ 1 | Which attempt's output to read. Defaults to the latest. |

**Response (200):**

```json
{
  "fire": { "fire_id": "fire_abc", "status": "success", "...": "..." },
  "stdout": "hello stdout",
  "stderr": "",
  "callbacks": [
    { "mode": "B", "body": { "result": "ok" }, "received_at": 1715534803000 }
  ],
  "attempts_available": [1, 2],
  "attempt": 2,
  "truncated": false
}
```

`stdout`/`stderr` are truncated at 1 MiB; the `truncated` flag flips when
either was clipped.

**Errors:** `401`; `404` (`{ error: 'fire not found', fire_id }`).

### `POST /api/fires/:fire_id/retry`

**Auth:** Bearer required.

Manual requeue of a terminal fire. Resets the row to `queued`, leaves
`attempt` untouched (the dispatcher bumps it when it picks the fire up),
and triggers a scheduler reschedule.

**Body:** none.

**Response (200):**

```json
{ "fire_id": "fire_abc", "status": "queued" }
```

**Errors:**

| Code | Trigger |
|---|---|
| `401` | Bearer missing/invalid. |
| `404` | `{ error: 'fire not found', fire_id }`. |
| `409` | `{ error: "fire status is '<s>'; only failed/dead/skipped fires can be retried", fire_id }`. Returned when the fire is currently `queued`, `running`, or already `success`. |

### `POST /api/cron/diagnose`

**Auth:** Bearer required.

Force the scheduler to recompute its next wake. Useful when a trigger has
been registered out-of-band (direct DB write) or when wall-clock skew is
suspected. Returns the post-reschedule scheduler status.

**Body:** none.

**Response (200):** same shape as `scheduler` in `/api/cron/status`.

**Errors:** `401`; `500` (`{ error: <message> }`) if the reschedule throws.

### `POST /dispatch/:fire_id`

**Auth:** `Authorization: Bearer <per-fire-secret>`. The secret is the
`CLAWDEVBOX_FIRE_SECRET` value injected into the trigger script process
by the dispatcher when it spawned this fire. It is **not** the global
`cfg.http.token`.

Routes a prompt into the `SessionConductor` attached to the trigger's
`subscriber_thread_id`. The dispatcher records the target instance id
at script-spawn time only when that pty is live in `pty-registry`; if
no live target exists, `dispatch_url` is omitted from the envelope and
calls to this endpoint return 404.

**Body:**

```json
{ "prompt": "Look at the new comment on PR 2401." }
```

`prompt` is required (non-empty string). 1 MiB max body.

**Response (200):**

```json
{ "ok": true, "queued_at": 1715534803000, "state": "running" }
```

`state` is the conductor's post-enqueue state (e.g. `'running'`,
`'awaiting_user'`).

**Errors:**

| Code | Trigger |
|---|---|
| `400` | `prompt` missing or not a non-empty string. |
| `401` | Bearer missing or doesn't match the per-fire secret. |
| `404` | `{ error: 'fire not found or not in flight' }`, `{ error: 'no dispatch target for this fire' }` (registration has no subscriber pty), or `{ error: 'dispatch target pty has exited' }` (subscriber was live at spawn but died since). |
| `405` | Method other than POST. |

### `POST /spawn/:fire_id`

**Auth:** `Authorization: Bearer <per-fire-secret>` — same per-fire
`CLAWDEVBOX_FIRE_SECRET` as `/dispatch`. Always available — the
dispatcher emits `spawn_url` on every envelope.

Spawns a fresh interactive agent session via the recipe runner (ad-hoc,
no recipe binding). Used when the trigger has no subscriber pty bound,
or when the script always wants a clean session.

**Body:**

```json
{
  "prompt": "Review PR 2401.",
  "agent": "dev-buddy:dev-buddy",
  "workspace_id": "ws_..."
}
```

| Field | Required | Default |
|---|---|---|
| `prompt` | yes | — |
| `agent` | no | Dispatcher's `defaultAgentCli` (e.g. `'copilot'`). |
| `workspace_id` | no | The fire's workspace. |

**Response (200):**

```json
{ "ok": true, "instance_id": "ri_...", "session_id": "cdb_..." }
```

**Errors:**

| Code | Trigger |
|---|---|
| `400` | `prompt` missing or not a non-empty string. |
| `401` | Bearer missing or doesn't match the per-fire secret. |
| `404` | `{ error: 'fire not found or not in flight' }`. |
| `405` | Method other than POST. |
| `500` | `{ error: 'spawn failed: <message>' }` (recipe-runner failure). |

### `GET /api/sessions/:instance_id`

**Auth:** Bearer required (service token, same as `/api/cron/*`).

Introspect the live `SessionConductor` for a recipe instance / spawned
agent — useful for the SPA, debugging, and any caller that wants to
poll for a session's state without subscribing to SSE.

**Response (200):**

```json
{
  "instance_id": "ri_...",
  "state": "running",
  "queue_depth": 0,
  "provider_id": "copilot",
  "agent_session_id": "cdb_..."
}
```

| Field | Description |
|---|---|
| `state` | Conductor state (`'running'`, `'awaiting_user'`, `'idle'`, or `'unknown'` if no conductor is bound). |
| `queue_depth` | Pending prompts queued for delivery to the agent. |
| `provider_id` | Agent CLI identifier (e.g. `'copilot'`, `'claude'`, `'dev-buddy:dev-buddy'`). |
| `agent_session_id` | The CLI's own session id (the `cdb_*` value passed via `--name` / `--session-id`). |

**Errors:**

| Code | Trigger |
|---|---|
| `401` | Bearer missing/invalid. |
| `404` | `{ error: 'session not found' }` — no live conductor for that instance. |

---

## See also

- [`trigger.*`](./trigger.md) — MCP tools that register/fire triggers.
- [`recipe.*`](./recipe.md) — recipe instances spawn through the same kernel pipeline.
- Spec §5, §6, §8, §9 in `docs/specs/2026-05-14-trigger-kernel-design.md`.
