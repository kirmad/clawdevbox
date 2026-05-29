# Conductor — Simplified Design

**Date:** 2026-05-09
**Author:** Brainstorming session (Kiran + agent)
**Status:** Draft for review
**Supersedes:** `2026-05-01-mc-rewrite-infrastructure-design.md` (the 2,200-line event-sourced kernel spec) for the same UX contract.
**Mockup contract:** `docs/mockups/mc-rewrite/0{0..4}-*.html` — locked. This design preserves every UX element shown in the mockups.

---

## 1. Summary

Conductor is a Tauri+Node desktop app whose **only durable state is a single SQLite file** at `~/.conductor.db`. The sidecar exposes that state as an MCP server on localhost. The desktop UI is a thin viewer over the same DB. The user's actual coding agent runs as `claude` (or `copilot`) in an embedded xterm side-terminal, configured to reach Conductor's MCP — Conductor itself runs no agent loop. **Triggers are cron-scheduled TS scripts**: an in-process daemon ticks each on its schedule; the script polls whatever it needs (ADO, the inbox, anything reachable through MCP), decides whether to act, and calls MCP tools to spawn threads / wake suspended ones / append messages. **Recipes** are minimal YAML files (TaskDock-style, `name`/`description`/`steps[]`) that triggers point at when they want to invoke a scenario. The agent picks up the recipe, uses its steps as a starting point, adapts.

The design replaces the prior infrastructure spec's event-sourced kernel, projections, AutoPolicies, walkthroughs, plugin engine, ToolHost, agent runtime, and Session Manager with: **six tables (`inbox_items`, `threads`, `messages`, `triggers`, `approvals`, `artifacts`), one MCP server, three drop-folders (`recipes/`, `triggers/`, `mcp/`), a cron daemon, and an external CLI that does the actual work.**

## 2. Goals & Non-Goals

### Goals

- Deliver every UX element shown in the four mockups (PR review, work item, incident investigation, epic decomposition) without regression.
- Make adding a new capability a drop-folder operation: a new MCP server config, a new recipe YAML, a new skill markdown, a new trigger entry — never a code change to the host.
- Make the system testable in pieces. Every primitive (trigger tick, script execution, thread spawn, message append, approval round-trip, artifact write) is independently testable from a SQL fixture.
- Interop with the broader MCP ecosystem: read `.continue/mcpServers/*.json` files unchanged.
- Run autonomously while the app is open (cron daemon ticks triggers); be polite when closed (no headless service).

### Non-Goals (MVP / slice 1–15)

- Multi-user, multi-machine, or cloud sync. Local-first SQLite only.
- A built-in coding agent. Conductor is the substrate; `claude` / `copilot` is the agent.
- A plugin marketplace, registry, signing, or auto-update of recipes. Curated docs for now.
- Provider-level abstraction (LiteLLM-style). The CLI handles provider choice.
- Token accounting, rate limiting, or cost dashboards. The CLI handles it.
- A heavy compaction/memory subsystem in the host. The CLI handles it.
- **Goose-style recipes.** Goose's recipe schema (parameters, sub_recipes, retry, response, MiniJinja templating, state machines, fan_out) is rejected for MVP. We may revisit post-cutover for advanced scenarios. See §7 for the simpler recipe model.
- **State machines / checkpoint primitives in the engine.** Multi-stage flows live in the recipe's prose (steps array + agent's adaptation), not in a runtime engine. Approvals are an MCP tool the agent calls when needed.
- **Per-recipe parameter typing or binding.** Recipes are starting-point prose, not parameterized configs.
- **Per-recipe tool allowlists.** All MCP tools from configured extensions are visible; the CLI's permission prompts are the only gate.

## 3. Glossary

| Term | Meaning |
|---|---|
| **Inbox item** | A row representing one actionable thing (a PR, a work item, an incident, an epic, a manual ask). The user's primary view. |
| **Thread** | A row representing one ongoing run for an inbox item. Recursive via `parent_thread_id`. |
| **Message** | An append-only log entry on a thread (agent text, tool call, tool result, signal received, walkthrough comment, view emission, user message). |
| **Approval** | A row representing a pending user decision the agent surfaced. The agent's interrupt. |
| **Artifact** | A file the agent wrote, registered via `artifact.write` (review markdown, postmortem, aggregate). |
| **Recipe** | A simple YAML file (`name`, `description`, `mcp_servers?`, `steps?: [{id, goal, depends?}]`) that the agent uses as a starting point. TaskDock-shape. The agent picks one matching the goal, reads it, adapts the steps as needed. |
| **Trigger type** | A *capability* shipped by a plugin (or defined in project scope). Declares a script file, a parameter schema, a default cron, and (optionally) an identity param + webhook opt-out. Itself doesn't fire — it must be **registered** with concrete param values to become active. See §8.2. |
| **Registered trigger** | A concrete *instance* of a trigger type, bound to specific param values, an optional cron override (string=override, null=inherit, false=disable cron), and (for hot triggers) a `subscriber_thread_id`. Lives in `.conductor/triggers.json` `registered[]`. See §8.3. |
| **Skill** | A markdown file with frontmatter that the side-terminal CLI auto-loads as procedural knowledge (Claude Code skills semantics). Living at `.conductor/skills/<id>.md` or in a plugin's `skills/` directory. |
| **Plugin** | A self-contained directory of recipes, skills, triggers, hostable tools, and MCP server configs that ships as a unit. Lives at `<workspace>/.conductor/plugins/<id>/`. Read-only at runtime — customizations go in `project` scope. |
| **Hostable tool** | A small TypeScript file inside a plugin's `tools/` directory that Conductor's MCP server discovers and exposes as an MCP tool. Lightweight alternative to declaring an external MCP server: single-file, single-function, hosted in the Conductor process. The tool exports an `id`, `description`, a `parameters` zod schema, and a default `execute(args, ctx)` function. See §10.3. |
| **Scope** | Where a recipe/skill/trigger comes from: `project` (workspace), `plugin:<id>` (a plugin's bundle), or `global` (user home). Project shadows plugin shadows global on id collision. |

## 4. Architecture

```
                   ┌────────────────────────────────────────────────────┐
                   │                   Tauri shell (Rust)               │
                   └────────────────────┬───────────────────────────────┘
                                        │
                              ┌─────────┴──────────┐
                              │   Renderer (TS)    │     ┌──────────────────┐
                              │   inbox · thread · │     │ Side terminal    │
                              │   side-terminal    │◀───▶│ xterm hosting    │
                              │   (thin viewer)    │     │ `claude --resume`│
                              └─────────┬──────────┘     └────┬─────────────┘
                                        │ WS RPC               │ stdin/stdout
                                        ▼                      │
                   ┌────────────────────────────────────────────┐
                   │           Conductor sidecar (Node)         │
                   │   ┌──────────────┐    ┌──────────────────┐ │
                   │   │ WS facade    │    │ HTTP MCP server  │ │
                   │   │ (renderer)   │    │ (any MCP client) │◀┼── side terminal CLI
                   │   └──────┬───────┘    └────────┬─────────┘ │   talks here
                   │          │                     │           │
                   │   ┌──────┴─────────────────────┴────────┐  │
                   │   │   Cron daemon                       │  │
                   │   │   - ticks each trigger on schedule  │  │
                   │   │   - spawns `tsx` worker per tick    │  │
                   │   │   - script calls MCP tools          │  │
                   │   └──────┬──────────────────────────────┘  │
                   │          │                                 │
                   │   ┌──────┴─────────────────────────────┐   │
                   │   │  Trigger scripts (in-process       │   │
                   │   │  workers; one per tick)            │   │
                   │   │  Each calls `conductor.recipe.     │   │
                   │   │  run`, `thread.append_message`,    │   │
                   │   │  `thread.wake`, etc. as needed.    │   │
                   │   └────────────────────────────────────┘   │
                   └─────────────────────┬──────────────────────┘
                                         │
                                         ▼
                   ┌────────────────────────────────────────────┐
                   │              ~/.conductor.db               │
                   │  inbox_items · threads · messages          │
                   │  triggers · approvals · artifacts          │
                   │  + schema_version, settings_kv             │
                   └────────────────────────────────────────────┘

  Drop-folders (per-workspace, not in the DB):
   .conductor/recipes/*.yaml      minimal TaskDock-style recipe YAML
   .conductor/triggers/*.yaml     cron-scheduled TS scripts (one per file)
   .conductor/mcp/*.json          Continue/Cursor-compatible MCP server configs
   .conductor/skills/*.md         markdown skills the CLI auto-loads
   .conductor/hooks.json          on-event side effects (notify, run script)
```

**The key inversion:** the sidecar does NOT run an agent loop. The side-terminal CLI does. Conductor's job is to keep the SQLite tables consistent, expose them via MCP, and wake CLIs up when trigger scripts demand it.

### 4.1 Install modes

The sidecar can be installed two ways via `clawdevbox init`:

- **Global (recommended)** — `<globalDir>/config.json` holds account-wide
  settings (HTTP port, bearer token, tunnel, notifications, plugin set).
  Plugins live under `<globalDir>/plugins/` and are shared across every
  project on the account. The MCP server can be launched from any
  directory and treats the current working directory as `project_dir`.
- **Project-specific** — legacy path. Writes
  `<projectDir>/.clawdevbox/config.json`. Only takes effect when the
  server is launched against that project. Useful when a particular repo
  needs a different port / token / tunnel.

`resolveConfig` merges both layers when both are present (project >
global > defaults). Env vars and CLI flags override anything on disk.

### 4.2 Background service

`clawdevbox start --service` spawns the HTTP MCP server as a detached
background process and registers an OS-level auto-start entry so the
server relaunches at every login:

- Windows: registry Run key (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`)
- macOS: LaunchAgent plist at `~/Library/LaunchAgents/com.clawdevbox.server.plist`
- Linux: systemd-user unit at `~/.config/systemd/user/clawdevbox.service` (plus `loginctl enable-linger` for logout survival)

`<globalDir>/service.json` records PID + port + version of the running
instance. `clawdevbox stop` reads that file and sends `taskkill` /
`SIGTERM` to the recorded PID. `clawdevbox status` reports running
state + auto-start registration. `clawdevbox uninstall-service` stops the
instance and removes the OS auto-start entry.

Only one global instance is supported per user account; the service is
bound to the global config. Per-project installs do not use the service
mode.

## 5. The Kernel — `~/.conductor.db`

Six logical tables plus a `schema_version` and a `settings_kv`. All access through `better-sqlite3` (TaskDock pattern, copy-fork). All schema changes additive only (Goose's policy, copy-fork).

### 5.1 `inbox_items`

```sql
CREATE TABLE inbox_items (
  id              TEXT PRIMARY KEY,            -- e.g. "ado:pr:2401" — natural+stable
  kind            TEXT NOT NULL,               -- pr | workitem | incident | epic | manual
  source          TEXT NOT NULL,               -- ado | github | icm | manual
  external_id     TEXT,                        -- "PR-2401", "INC-9082" — for de-dup
  title           TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'new', -- new | triaged | in_progress | awaiting_input | blocked | done | dismissed
  priority        TEXT,                        -- p0 | p1 | p2 | normal | low
  agent_message   TEXT,                        -- the prose card body the mockups show
  agent_tone      TEXT,                        -- neutral | warn | err | ok
  meta            TEXT NOT NULL DEFAULT '{}',  -- JSON; kind-specific (PR url, incident severity, …)
  snoozed_until   INTEGER,                     -- unix ms
  starred         INTEGER NOT NULL DEFAULT 0,
  muted           INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER,
  last_event_id   TEXT,                        -- monotonic; for "what changed since you last looked"
  last_viewed_at  INTEGER,                     -- per the engagement projection in mockup 04
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_inbox_state ON inbox_items(state) WHERE archived_at IS NULL;
CREATE INDEX idx_inbox_kind  ON inbox_items(kind, state);
```

The mockup's left-rail list, kind chip, agent-prose card body, awaiting-input state, snooze/star/mute, and "what changed since you last looked" all come from this table. State transitions are validated in TS (no DB triggers — keep SQLite generic).

### 5.2 `threads`

```sql
CREATE TABLE threads (
  id                 TEXT PRIMARY KEY,         -- e.g. "thr_01HX..."
  inbox_item_id      TEXT NOT NULL REFERENCES inbox_items(id),
  parent_thread_id   TEXT REFERENCES threads(id),
  recipe_id          TEXT,                     -- nullable — direct manual runs may have no recipe
  recipe_snapshot    TEXT,                     -- frozen YAML at spawn time, for stable replay; nullable when no recipe
  trigger_id         TEXT,                     -- which trigger spawned this; nullable for manual runs
  prompt             TEXT NOT NULL,            -- the rendered prompt the CLI received as first user message
  state              TEXT NOT NULL DEFAULT 'pending',
                                               -- pending | running | suspended | completed | failed | cancelled
  pause_reason       TEXT,                     -- waiting-signal | waiting-approval | waiting-user | manual
  cli_session_id     TEXT,                     -- the claude/copilot session id when active; null when idle
  cli_provider       TEXT,                     -- claude | copilot
  cli_model          TEXT,
  started_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  cancelled_reason   TEXT
);
CREATE INDEX idx_threads_item        ON threads(inbox_item_id, state);
CREATE INDEX idx_threads_state       ON threads(state) WHERE state IN ('running','suspended');
CREATE INDEX idx_threads_parent      ON threads(parent_thread_id) WHERE parent_thread_id IS NOT NULL;
```

The recursive epic tree (mockup 04) is `WITH RECURSIVE descendants(...) AS (SELECT * FROM threads WHERE id = ? UNION ALL SELECT t.* FROM threads t JOIN descendants d ON t.parent_thread_id = d.id)`. `recipe_snapshot` pins the recipe YAML at spawn so a hot-reloaded recipe doesn't break a long-running thread.

### 5.3 `messages`

```sql
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,                -- ULID/event id; monotonic per thread
  thread_id   TEXT NOT NULL REFERENCES threads(id),
  type        TEXT NOT NULL,
                                               -- agent_text | tool_call | tool_result
                                               -- step_start | step_end | stage_transition
                                               -- signal_received | user_message
                                               -- walkthrough_comment | view_emitted
                                               -- approval_request | approval_resolved
                                               -- artifact_written
  payload     TEXT NOT NULL,                   -- JSON; type-discriminated shape
  ts          INTEGER NOT NULL,
  attribution TEXT                             -- e.g. "user:slack:@kirmadi", "agent:claude", "policy:stuck-pr"
);
CREATE INDEX idx_messages_thread_ts ON messages(thread_id, ts);
CREATE INDEX idx_messages_type      ON messages(type, ts);
```

The mockup-02 timeline is a `SELECT * FROM messages WHERE thread_id = ? ORDER BY ts`. The walkthrough comments (mockup 02) are `type='walkthrough_comment'` rows. The askUser block (mockup 03/04) is `type='approval_request'` + a row in `approvals`. The diff-viewer comments are `type='view_emitted'` rows whose payload references a view id.

**Append-only.** No updates, no deletes. Retention/pruning is a separate sweep that lives in `messages_archive` if we ever need it (out of scope for slice 1).

### 5.4 `triggers`

```sql
CREATE TABLE triggers (
  id                    TEXT PRIMARY KEY,
  state_json            TEXT NOT NULL DEFAULT '{}',
  subscriber_thread_id  TEXT REFERENCES threads(id),  -- NULL = global; set = scoped to a thread
  enabled               INTEGER NOT NULL DEFAULT 1,
  last_run_at           INTEGER,
  last_run_status       TEXT,                     -- 'ok' | 'error'
  last_run_error        TEXT,
  last_run_duration_ms  INTEGER,
  created_at            INTEGER NOT NULL,
  removed_at            INTEGER
);
CREATE INDEX idx_triggers_enabled ON triggers(enabled, removed_at) WHERE enabled = 1 AND removed_at IS NULL;
CREATE INDEX idx_triggers_thread  ON triggers(subscriber_thread_id) WHERE subscriber_thread_id IS NOT NULL AND removed_at IS NULL;
```

The `triggers` table holds **only registered-instance runtime state** — `state_json` (per-trigger persistence across runs), `last_run_*` audit fields, and the `subscriber_thread_id` linkage for hot triggers. **The registered-instance configuration (id, type, params, cron, enabled) lives on disk in `.conductor/triggers.json` `registered[]`** (Claude-Code-hooks-style — see §8). The DB does not duplicate it. The trigger **types** (capabilities) live in plugin manifests (`provides.trigger_types[]`, §10.2) and are loaded into an in-memory registry at sidecar boot — not in SQLite.

When a registered trigger fires:
- The daemon reads its config from `triggers.json` `registered[]` (in memory cache) and resolves the bound type from the workspace's `triggerTypes` registry
- Loads `state_json` from this row
- Spawns the type's script file as a subprocess with the envelope on stdin
- On exit: parses stdout JSON → updates `state_json`; updates `last_run_*` fields

`subscriber_thread_id` set means the registered trigger is hot (agent-registered, scoped to a thread); when the thread reaches terminal state, both this row and the corresponding entry in `triggers.json` `registered[]` are removed by the same scheduler tick (via `trigger.unregister`).

There is **no `signals` table** in MVP. Scripts call MCP tools directly to upsert inbox items, append messages, spawn threads, etc. If we later need a global event audit log, it gets added without schema impact.

### 5.5 `approvals`

```sql
CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  question      TEXT NOT NULL,                 -- agent's prose
  options       TEXT NOT NULL DEFAULT '[]',    -- JSON array of { id, label, description?, recommended?, confidence? }
  allow_freetext INTEGER NOT NULL DEFAULT 0,
  default_view  TEXT,                          -- which view to surface in the renderer
  state         TEXT NOT NULL DEFAULT 'pending', -- pending | resolved | cancelled
  answer        TEXT,                          -- JSON: { option_id?, freetext?, attribution }
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);
CREATE INDEX idx_approvals_pending ON approvals(thread_id, state) WHERE state = 'pending';
```

The askUser modals in mockups 03/04 are an `approvals` row + a `messages` row of type `approval_request`. The CLI calls `approval.request(...)` via MCP, which inserts both rows; the renderer shows the modal; the user's answer writes back through `approval.resolve(...)`, which updates the row, appends a `messages` row of type `approval_resolved`, and emits a notification the suspended CLI is awaiting.

### 5.6 `artifacts`

```sql
CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES threads(id),
  kind         TEXT NOT NULL,                  -- review-md | postmortem-md | aggregate-json | diff-html | custom
  path         TEXT NOT NULL,                  -- absolute path on disk
  size_bytes   INTEGER,
  meta         TEXT NOT NULL DEFAULT '{}',     -- JSON
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_thread ON artifacts(thread_id, kind);
```

Artifacts live on disk under `<workspace>/.conductor/runs/<thread_id>/artifacts/<name>` (Goose's missing convention, retrofitted). The DB row is a pointer + metadata.

### 5.7 `schema_version` + `settings_kv`

Standard. Version-tracked migrations runner copy-forked from legacy TaskDock (`migrations/runner.ts`). Settings is `(key TEXT PRIMARY KEY, value TEXT)`.

## 6. The MCP Surface

The sidecar runs an HTTP MCP server (Streamable HTTP) on a localhost port (default `5201`, env `CONDUCTOR_MCP_PORT`). It is **the** primary surface — the renderer's WS facade is a convenience layer over the same handlers, not a parallel API.

Auth: per-launch 32-byte hex secret (Goose copy-fork) in the `Authorization: Bearer <secret>` header. The Tauri shell mints it at boot, sets `CONDUCTOR_MCP_SECRET` for the sidecar, and writes it to `.conductor/mcp.json` so spawned `claude` CLIs pick it up via `--mcp-config`.

### 6.1 Tools (the verb surface)

| Tool | Inputs (zod) | Side effect |
|---|---|---|
| `inbox.list` | `{ kind?, state?, limit?, cursor? }` | Read |
| `inbox.read` | `{ id }` | Read (item + recent messages) |
| `inbox.upsert` | `{ id, kind, source, ..., agent_message? }` | Create or update an item; idempotent on `id` |
| `inbox.set_state` | `{ id, state, reason? }` | State transition w/ validation |
| `inbox.snooze` | `{ id, until }` | |
| `inbox.archive` | `{ id }` | |
| `thread.spawn` | `{ inbox_item_id, prompt, recipe_id?, parent_thread_id? }` | Insert thread row, snapshot recipe if id given; does NOT spawn the CLI process — the scheduler does |
| `thread.append_message` | `{ thread_id, type, payload, attribution? }` | Append a message; the side-terminal CLI calls this on every step |
| `thread.read` | `{ thread_id, since_message_id?, limit? }` | Read |
| `thread.set_state` | `{ thread_id, state, reason? }` | |
| `thread.cancel` | `{ thread_id, recursive?, reason? }` | Cancel + cascade |
| `approval.request` | `{ thread_id, question, options, allow_freetext?, default_view? }` | Insert approval row + message row; suspends caller |
| `approval.resolve` | `{ approval_id, answer }` | Update row; emit notification |
| `approval.list_pending` | `{ thread_id? }` | |
| `artifact.write` | `{ thread_id, kind, path, meta? }` | Register a path the agent just wrote |
| `view.emit` | `{ thread_id, view_id, type, payload }` | Append a `view_emitted` message; the renderer subscribes to these |
| `search.memory` | `{ query, kind?, limit? }` | Lexical FTS5 over `messages`; opt-in semantic later |
| `recipe.list` | `{ scope?, search? }` | Read; merges project + plugins + global (project shadows plugin shadows global); returns `{ id, name, description, kind?, mcp_servers?, step_count, scope }[]`. `scope` accepts `'project' \| 'plugin:<id>' \| 'global' \| 'all'` (default `'all'`) |
| `recipe.read` | `{ id, scope? }` | Read; returns full parsed structure + raw YAML source + the scope it resolved from |
| `recipe.upsert` | `{ id, scope, source }` | Create or replace recipe file; runs shape validator first; writes atomically; idempotent. **Rejects `scope='plugin:*'`** (plugin scope is read-only) |
| `recipe.delete` | `{ id, scope }` | Remove recipe file; refuses if any active thread holds it. **Rejects `scope='plugin:*'`** |
| `recipe.run` | `{ id, prompt, params?, workspace_id?, attach_to_inbox_item_id?, agent_cli? }` | Resolve recipe → reuse `workspace_id` or `workspace.create({ inherit_plugins: true })` → write `<workspace>/.mcp.json` (Conductor MCP wired with `CONDUCTOR_PROJECT_DIR` / `_RECIPE_INSTANCE_ID` / `_WORKSPACE_ID` / `_MCP_SECRET`) → write `<workspace>/.conductor/recipe-instances/<id>.json` (status=`running`) → spawn the agent CLI detached (`copilot --allow-all-tools` / `claude -p` / `echo-stub` for tests) and `child.unref()` → returns `{ recipe_instance_id, workspace_id, workspace_path, pid, agent_cli, status: 'spawned' }` immediately. Fire-and-forget; the spawned agent calls `recipe.done` to signal completion |
| `recipe.done` | `{ status?, result?, message? }` | Called by the agent inside a spawned recipe-run session. Reads `CONDUCTOR_RECIPE_INSTANCE_ID` + `CONDUCTOR_WORKSPACE_ID` env vars; updates the instance file with `status` (`success`/`failure`/`cancelled`, default `success`), `completed_at`, `result`, `message`. Errors `NOT_IN_RECIPE_INSTANCE` if env vars are missing |
| `recipe.instance_info` | `{ id? }` | Read a recipe-run instance row. With `id`, scans the workspace registry to find it; without `id`, reads from `CONDUCTOR_RECIPE_INSTANCE_ID` + `CONDUCTOR_WORKSPACE_ID` env vars (inside a spawned session). Returns the full instance: recipe id, prompt, params, agent_cli, pid, started/completed timestamps, status, result, message |
| `skill.list` | `{ scope?, search? }` | List skills across scopes; merges project + plugins + global with project shadows plugin shadows global; returns `{ id, name, description, scope }[]` |
| `skill.read` | `{ id, scope? }` | Returns markdown body + parsed frontmatter + resolved scope |
| `skill.upsert` | `{ id, scope: 'project' \| 'global', source }` | Create or update a skill file. **Rejects `scope='plugin:*'`** (plugin scope is read-only) |
| `skill.delete` | `{ id, scope: 'project' \| 'global' }` | Remove a skill file. **Rejects `scope='plugin:*'`** |
| `plugin.list` | `{}` | List installed plugins with manifest summary + load status (`loaded`/`disabled`/`error`) |
| `plugin.read` | `{ id }` | Returns the full manifest, the `provides` listing, install origin, and status |
| `plugin.install` | `{ from, ref? }` | `from` accepts `git+https://…`, `git+ssh://…`, or an absolute local path; clones/copies into `.conductor/plugins/<manifest.id>/`; validates manifest; reloads. `ref` is an optional branch/tag/sha (git-only) |
| `plugin.update` | `{ id }` | For git-installed plugins, runs `git pull`; re-validates manifest; reloads. Errors clearly if the plugin wasn't installed from a git source |
| `plugin.uninstall` | `{ id }` | Removes `.conductor/plugins/<id>/`; reloads. Project-scope overrides survive |
| `plugin.enable` / `plugin.disable` | `{ id }` | Flag toggle without removing the plugin directory |
| `trigger.list_types` | `{ scope?, search? }` | List available trigger TYPES (capabilities) discovered from enabled plugins. Returns `{ id, source_plugin_id, scope, description, parameters, default_cron, accepts_webhook, identity_param }[]`. `scope` filters to `'plugin:<id>'`; omit for all. **`trigger.list_types` + `trigger.list_registered` together replace the prior generic `trigger.list`** — listing capabilities is distinct from listing active instances |
| `trigger.list_registered` | `{ enabled?, type_id?, subscriber_thread_id? }` | List REGISTERED instances from `.conductor/triggers.json` `registered[]`. Each row carries `params`, `cron` (raw), `resolved_cron` (after inheritance), `enabled`, `subscriber_thread_id`, `state`, `last_run_*` |
| `trigger.register` | `{ type_id, params, cron?, subscriber_thread_id?, expires_at?, once? }` | Validate `params` against the type's `parameters[]` schema; normalize `cron` (string=override, null=inherit, false/""=disable); mint id (using `identity_param` if declared, else hash of params); append to `registered[]`. Errors: `TRIGGER_TYPE_NOT_FOUND`, `PARAM_VALIDATION`, `TRIGGER_ALREADY_REGISTERED` |
| `trigger.unregister` | `{ id }` | Remove the registered instance from `registered[]`. The underlying TYPE stays available — re-register to recreate |
| `trigger.update_params` | `{ id, params?, cron? }` | Replace `params` and/or `cron` on an existing registration. Re-validates against the type schema. Does NOT remint the id (use unregister + register for that) |
| `trigger.enable` / `trigger.disable` | `{ id }` | Flag toggle. Disabled rows are skipped by the cron daemon; `trigger.fire` still works |
| `trigger.fire` | `{ id, payload? }` | Manual fire of a registered instance — POST to its `/hooks/<id>` webhook. Always works regardless of `cron` state |
| `workspace.create` | `{ name?, parent_workspace_id?, base_path?, inherit_plugins?, copy_from? }` | Mint a new workspace id (`ws_<base36-ts>_<4hex>`), scaffold `<workspaces_root>/<id>/.conductor/{recipes,skills,plugins,triggers.json,workspace.json,recipe-instances}/`, and register in `<workspaces_root>/index.json` (atomic write). `inherit_plugins: true` copies the calling workspace's plugins/ tree (minus `node_modules` and `_legacy-mcp-server`). `copy_from: <ws_id>` clones an existing workspace's `.conductor/` tree (except `recipe-instances/` and `workspace.json`). Mutually exclusive. `<workspaces_root>` defaults to `$CONDUCTOR_WORKSPACES_ROOT` or `~/.conductor/workspaces`. Returns `{ id, path, name, created_at, parent_workspace_id }` |
| `workspace.list` | `{}` | Read `<workspaces_root>/index.json`. Returns `{ workspaces: WorkspaceInfo[], count, workspaces_root }` |
| `workspace.get` | `{ id }` | Full registry entry plus on-disk counts (`plugins`, `recipes`, `skills`, `registered_triggers`) under the workspace's `.conductor/` tree. Errors `WORKSPACE_NOT_FOUND` if the id is absent |
| `workspace.current` | `{}` | Match `CONDUCTOR_PROJECT_DIR` against the registry; returns `{ found: true, ...WorkspaceInfo }` or `{ found: false, project_dir, workspaces_root }` |

`scope` is `'project'` (`<workspace>/.conductor/recipes/`, `<workspace>/.conductor/skills/`, etc.), `'plugin:<id>'` (a plugin's bundle at `<workspace>/.conductor/plugins/<id>/`), or `'global'` (`~/.conductor/`). When unspecified on read paths, all scopes are searched and project shadows plugin shadows global on id collision. On write paths, scope is required and **must be one of `'project'` or `'global'`** — `scope='plugin:*'` is rejected with a structured error (`{ code: 'plugin_scope_read_only', message: '…' }`) since plugins are read-only at runtime. To customize a plugin-shipped recipe/skill/trigger, the agent copies it into project scope and edits there (see §10.7). See §10 for the full plugin model.

**Validation is shape-only.** Recipes validate against a small JSON Schema: `name` (string, required), `description` (string, required), `mcp_servers` (string[]?), `default_client` (`'claude' | 'copilot'`?), `steps` (array?, each `{ id: number, goal: string, depends?: number[], ... }`). Step ids must be unique within a recipe; every `depends[]` reference must resolve to an existing step id. **No state-machine graph check, no MiniJinja, no tool-reference check, no parameter-binding rules.** Trigger TYPES validate against the plugin-manifest schema in §10.8 (id pattern, `default_cron` well-formed, `parameters[].type` enum, `default` matches declared type, `identity_param` resolves). Registered triggers validate `params` against the bound type's `parameters[]` schema at `trigger.register` / `trigger.update_params` time, and the `cron` field against the three-state contract (string | null | false).

**Authoring discipline.** Every write tool runs the shape validator server-side and rejects with a structured error array (`{ path, code, message }`) before touching disk. The agent self-corrects field-by-field.

**Concurrency.** Files are write-locked per file (advisory `fs.flock` on POSIX; rename-into-place on Windows). The sidecar serialises writes through a per-file queue.

**Workspace + recipe-instance lifecycle.** A workspace is a directory with a `.conductor/` tree; the canonical registry lives at `<workspaces_root>/index.json` (default `~/.conductor/workspaces/`, override via `CONDUCTOR_WORKSPACES_ROOT`). A recipe-instance is one agent run started from a recipe; the row lives at `<workspace>/.conductor/recipe-instances/<ri_…>.json` and is the durable record of what's running. `recipe.run` mints the row (status=`running`), writes `<workspace>/.mcp.json` with the env vars the spawned CLI needs (`CONDUCTOR_PROJECT_DIR`, `CONDUCTOR_RECIPE_INSTANCE_ID`, `CONDUCTOR_WORKSPACE_ID`, `CONDUCTOR_MCP_SECRET`), then detach-spawns the agent CLI and returns immediately. The spawned agent's MCP client reads those env vars; when finished it calls `recipe.done`, which patches the row to `success`/`failure`/`cancelled` with `completed_at`, `result`, `message`. A crashed sidecar can recover by re-scanning `recipe-instances/` — the file IS the state.

### 6.2 Resources (the noun surface)

MCP `resources/list` exposes `conductor://inbox/<id>`, `conductor://thread/<id>`, `conductor://artifact/<id>`, `conductor://recipe/<id>`. `resources/read` returns a JSON document. This lets MCP clients reference a recipe, thread, or artifact by URI without round-tripping through tools.

### 6.3 Notifications (the stream surface)

The sidecar emits MCP `notifications/resources/updated` whenever an inbox item, thread, or approval state changes. The renderer also subscribes via WS for the same events (one source of truth, two transports). External CLIs polling at 100 ms intervals are fine; subscribed clients are preferred.

## 7. Recipes — TaskDock-Style Starting Points

Recipes are simple YAML files that act as **starting points** for the agent, not strict configs. They mirror TaskDock's `orchestrator_templates/` pattern (`src/main/mission-control/template-discovery.ts`, `mission-control-types.ts:251`). The agent reads the matching recipe, uses its steps as a base, and adapts as the work demands.

### 7.1 Disk layout and discovery

Recipes live in (search order):

1. `<workspace>/.conductor/recipes/` — project-local
2. `~/.conductor/recipes/` — global library
3. Bundled defaults shipped inside the sidecar binary (read-only fallback)

Project-local shadows global on id collision. File extension is `.yaml` or `.yml`. The sidecar watches the project-local directory with a 500 ms debounce and re-emits `notifications/resources/updated` for `conductor://recipe/<id>` so the renderer's "available recipes" list is always live.

### 7.2 Schema

```yaml
# Required
id: pr-iteration-review
name: "PR Iteration Review"
description: "Reviews a PR after each iteration: classify changes, post structured comments, monitor for next push."

# Optional
kind: pr_review                          # pr_review | workitem | incident | epic | custom
default_client: claude                   # claude | copilot — which CLI the scheduler spawns
mcp_servers:                             # which extensions to enable (must exist in .conductor/mcp/)
  - ado
  - conductor
timeout_minutes: 0                       # 0 = no timeout; otherwise scheduler kills the CLI after N

# Optional starting-point steps (the agent ADAPTS these — not enforced)
steps:
  - id: 1
    goal: "Read the PR + prior iteration comments via ado.get_pr_iteration"
  - id: 2
    goal: "Classify changes (mechanical / logic / test) and surface risks"
    depends: [1]
  - id: 3
    goal: "Draft inline review comments; ask user via approval.request before posting"
    depends: [2]
  - id: 4
    goal: "Post comments via ado.comment_pr; mark thread done unless next iteration is expected"
    depends: [3]
```

That's the entire schema. No state machines, no parameter binding, no sub-recipes, no MiniJinja, no `response.json_schema`, no `retry`, no `fan_out`. Steps are **prose hints** the agent can follow, skip, reorder, or expand. The `depends[]` is for human readability of the steps list — it does not gate execution.

### 7.3 How the agent uses a recipe

When the scheduler spawns a CLI session for a thread with `recipe_id` set:

1. The renderer (or scheduler) writes a one-shot bootstrap prompt to the CLI: *"You are picking up a `<recipe.kind>` thread. The starting-point recipe is `<recipe.id>` — `<recipe.description>`. Its suggested steps are: [...]. Use these as a base and adapt. Call MCP tools to read the inbox item, append messages, request approvals, and write artifacts. Use `thread.append_message` after every meaningful step so the user can see your progress."*
2. The agent reads the actual recipe via MCP `recipe.read({ id })` if it wants the full body.
3. It runs its loop, calling whatever MCP tools it needs.
4. Multi-stage flows (PR review classify → review → post → monitor) live in the recipe's prose + the agent's adaptation. Approvals happen when the agent calls `approval.request`. Fan-out happens when the agent calls `thread.spawn(parent_thread_id=...)` itself for each child it wants to spin up.

**No engine state machine.** The agent's reasoning IS the state machine. The recipe is just well-curated prose to bootstrap that reasoning.

### 7.4 Validation (shape only)

```ts
type Recipe = {
  id: string;                    // required, unique, lowercase + hyphens (loader-enforced)
  name: string;                  // required, non-empty
  description: string;           // required, non-empty
  kind?: string;                 // optional; if present, must match enum or be 'custom'
  default_client?: 'claude' | 'copilot';
  mcp_servers?: string[];        // optional; each must reference an entry in .conductor/mcp/ (warn-only — missing servers cause runtime failure, not load failure)
  timeout_minutes?: number;      // optional; >= 0
  steps?: Array<{
    id: number;                  // required, unique within steps[]
    goal: string;                // required, non-empty
    depends?: number[];          // optional; each must reference another step id
  }>;
};
```

Validator checks: required fields present, types match, step ids unique, `depends[]` resolves, `kind` enum (if present), `id` matches `[a-z][a-z0-9-]*`. Errors return as `{ path, code, message }[]`.

**No deeper checks.** No tool-reference validation, no signal-kind validation, no graph validation, no parameter rules. Goose's 5-stage validator is overkill for the MVP. Recipes are starting-point prose; the worst-case failure of a malformed-but-shape-valid recipe is "the agent improvises and the user sees that on the thread timeline" — survivable.

The same validator function powers: drop-folder loader, `recipe.upsert`, `recipe.run` pre-spawn re-check. One function, one path.

### 7.6 Sample recipes (and how sub-recipes work)

Recipes are pure prose-with-frontmatter. There is **no first-class `sub_recipes:` field** (Goose-style). A "sub-recipe" is just another recipe that a parent recipe's prose tells the agent to consult — or that the parent agent invokes via `recipe.run({ id: '...' })` for a child thread. Two patterns appear:

- **Inline sub-recipe (same session, same thread).** The parent recipe's `steps` mention "use the `respond-to-pr-comment` recipe's prose to draft your reply." The agent calls `recipe.read({ id: 'respond-to-pr-comment' })` and follows the body, all within the parent thread's CLI session. No new thread, no new agent.
- **Spawned sub-recipe (child thread, fresh session).** The parent agent calls `thread.spawn({ recipe_id: 'implement-workitem', parent_thread_id: '<self>', prompt: '...' })`. A child thread runs the sub-recipe in its own CLI session; aggregated output flows back to the parent as a message.

Both patterns work off the same flat recipe files. Below: parents and sub-recipes for the four mockup scenarios.

#### 7.6.1 `pr-review` (parent — mockup 01)

```yaml
# .conductor/recipes/pr-review.yaml
id: pr-review
name: "PR Review"
description: "Review a PR iteration: classify, comment, monitor next push."
kind: pr_review
default_client: claude
mcp_servers: [ado, conductor]
timeout_minutes: 0
steps:
  - id: 1
    goal: "Read the PR + prior iteration comments via ado.get_pr and ado.list_pr_comments. Update the inbox card's agent_message to a one-sentence status (e.g., 'Reviewing iteration 3 of 12 files.')."
  - id: 2
    goal: "Classify changes (mechanical / logic / test / config). Surface risks. If risks are high, request user input via approval.request before proceeding."
    depends: [1]
  - id: 3
    goal: "Draft inline review comments. Consult recipe 'respond-to-pr-comment' as a style guide for tone and structure. Show the user the drafted comments via view.emit and request approval before posting."
    depends: [2]
  - id: 4
    goal: "On approval, post comments via ado.comment_pr. On rejection, revise and re-request."
    depends: [3]
  - id: 5
    goal: "Register a hot trigger that watches PR comments while this thread is alive (see §8 sample 8.7.2). Then exit; thread enters 'suspended' state waiting for the next iteration or comment."
    depends: [4]
```

#### 7.6.2 `respond-to-pr-comment` (sub-recipe — invoked inline by `pr-review` and by the comment-watcher hot trigger)

```yaml
# .conductor/recipes/respond-to-pr-comment.yaml
id: respond-to-pr-comment
name: "Respond to a PR comment"
description: "Author an agent reply to a single inbound PR comment, weighing tone and intent. Used both as a style guide for initial review and as a runtime sub-recipe when a reviewer comments."
kind: pr_review
mcp_servers: [ado, conductor]
steps:
  - id: 1
    goal: "Read the comment, the surrounding diff, and any prior agent replies in this thread. Identify whether the reviewer is asking a question, requesting a change, or affirming."
  - id: 2
    goal: "If a question: draft a clear answer grounded in the diff. If a change request: draft an action plan AND ask the user via approval.request whether to apply, defer, or push back. If affirming: thumbs-up acknowledgement, no further action."
    depends: [1]
  - id: 3
    goal: "Post the reply via ado.comment_pr. If a code change was approved, also produce the change in a follow-up step (the parent recipe handles that)."
    depends: [2]
```

#### 7.6.3 `incident-investigate` (parent — mockup 03)

```yaml
# .conductor/recipes/incident-investigate.yaml
id: incident-investigate
name: "Incident Investigation"
description: "Multi-source correlation for an active P0/P1 incident. Hypothesize, gather evidence, propose mitigation."
kind: incident
default_client: claude
mcp_servers: [icm, mdm, dgrep, conductor]
timeout_minutes: 0
steps:
  - id: 1
    goal: "Read the incident details (icm.get_incident). Update the inbox card with severity + service. Set agent_tone='err'."
  - id: 2
    goal: "Form 2-4 hypotheses ranked by likelihood (recent deploys, ongoing dependencies, similar past incidents from memory)."
    depends: [1]
  - id: 3
    goal: "For each hypothesis, gather evidence in parallel: query MDM for relevant metrics, DGrep for error-log signals, and ICM for related incidents. Use thread.spawn(parent_thread_id=<self>, recipe_id='gather-evidence-for-hypothesis', prompt=...) for each, run them concurrently."
    depends: [2]
  - id: 4
    goal: "Read the children's aggregated summaries (they appear as messages on this thread). Pick the highest-confidence hypothesis."
    depends: [3]
  - id: 5
    goal: "Render a correlation banner via view.emit({ payload: { confidence: <0..1> } }). Surface 3 mitigation options via approval.request with options[] (each with description, recommended?, confidence?). Free-text reply allowed."
    depends: [4]
  - id: 6
    goal: "On user choice: invoke recipe 'apply-mitigation' inline (read it, follow its steps in this same session)."
    depends: [5]
  - id: 7
    goal: "Write a markdown postmortem to <thread_id>/artifacts/postmortem.md, register via artifact.write."
    depends: [6]
```

#### 7.6.4 `gather-evidence-for-hypothesis` (sub-recipe — spawned as a child thread, fan-out from incident-investigate)

```yaml
# .conductor/recipes/gather-evidence-for-hypothesis.yaml
id: gather-evidence-for-hypothesis
name: "Evidence Gatherer"
description: "Investigate one hypothesis for an incident: query metrics, logs, related incidents. Return a 200-token summary to the parent thread."
mcp_servers: [icm, mdm, dgrep, conductor]
steps:
  - id: 1
    goal: "Identify the queries needed for this hypothesis (which MDM metric, which DGrep filter, which time window)."
  - id: 2
    goal: "Run the queries. Capture top findings."
    depends: [1]
  - id: 3
    goal: "Write a 200-token summary appraising whether the evidence supports or refutes the hypothesis. Append to the parent thread via thread.append_message({ thread_id: <parent_thread_id>, type: 'view_emitted', payload: { renderer: 'evidence-card-v1', hypothesis, summary, confidence, supporting_links } })."
    depends: [2]
```

The parent agent gets only this 200-token summary — not the full transcript of each child's investigation — so its context window stays clean while N children fan out.

#### 7.6.5 `apply-mitigation` (sub-recipe — invoked inline by `incident-investigate` step 6)

```yaml
# .conductor/recipes/apply-mitigation.yaml
id: apply-mitigation
name: "Apply Mitigation Runbook"
description: "Walk a known runbook step-by-step against an active incident; capture pre/post metrics; decide outcome (mitigated, no-effect, escalation-needed)."
mcp_servers: [icm, mdm, terminal, conductor]
steps:
  - id: 1
    goal: "Search memory for runbooks matching the incident's category. Pick the one with the strongest match. If none: emit overallOutcome='escalation-needed' and exit."
  - id: 2
    goal: "Capture 'before' metric snapshots (mdm.query for each success indicator)."
    depends: [1]
  - id: 3
    goal: "For each runbook step in order: read description, ask user via approval.request if step.destructive=true, execute, evaluate successPredicate, append to runbook log via artifact.write."
    depends: [2]
  - id: 4
    goal: "Wait 60s. Capture 'after' metrics. Compare before vs after. Decide overallOutcome."
    depends: [3]
  - id: 5
    goal: "Emit the structured MitigationResult via view.emit so the parent recipe's step 7 (postmortem) can read it."
    depends: [4]
```

#### 7.6.6 `epic-decompose` (parent — mockup 04)

```yaml
# .conductor/recipes/epic-decompose.yaml
id: epic-decompose
name: "Epic Decomposition"
description: "Decompose a high-level epic into child work items, plan a DAG, fan out implementation in waves with concurrency cap."
kind: epic
default_client: claude
mcp_servers: [ado, conductor]
steps:
  - id: 1
    goal: "Read the epic via ado.get_workitem. Read linked child work items via ado.list_children."
  - id: 2
    goal: "Propose a decomposition: ordered list of children with dependencies. Render via view.emit({ payload: { renderer: 'children-table-v1', children } }). Request approval; allow user to edit the breakdown via the renderer's editable table."
    depends: [1]
  - id: 3
    goal: "Plan execution order (DAG topo). Group into waves (set of children with no inter-wave deps). Render the DAG via view.emit({ payload: { renderer: 'dag-graph-v1' } })."
    depends: [2]
  - id: 4
    goal: "For each wave: spawn up to MAX_LIVE_SESSIONS child threads via thread.spawn(parent_thread_id=<self>, recipe_id='implement-workitem', prompt=`Implement WI-${id}: ${title}`). Self-pace: do NOT spawn more than the cap allows. Wait for the wave to complete (poll thread.read or use a hot trigger)."
    depends: [3]
  - id: 5
    goal: "On wave completion: aggregate children's outcomes (each child appended a final summary via view_emitted). If any child failed: surface to user via approval.request with options to retry, skip, or escalate. Move to next wave on success."
    depends: [4]
  - id: 6
    goal: "Write the rollup artifact (children.json) when all waves complete."
    depends: [5]
```

#### 7.6.7 `implement-workitem` (sub-recipe — spawned as child threads, fan-out from `epic-decompose`)

```yaml
# .conductor/recipes/implement-workitem.yaml
id: implement-workitem
name: "Implement Work Item"
description: "End-to-end implementation of a single ADO work item: read spec, write code in a worktree, open PR, monitor."
kind: workitem
default_client: claude
mcp_servers: [ado, conductor]
timeout_minutes: 0
steps:
  - id: 1
    goal: "Read the work item via ado.get_workitem. Update the inbox card with title + status."
  - id: 2
    goal: "Branch off main in a fresh worktree. Implement the requested change. Run tests."
    depends: [1]
  - id: 3
    goal: "Open a PR via ado.create_pr. Append the PR URL to the parent thread (via thread.append_message)."
    depends: [2]
  - id: 4
    goal: "Register a hot trigger that watches this PR for comments; when comments arrive, consult 'respond-to-pr-comment'. Then exit (thread suspended)."
    depends: [3]
  - id: 5
    goal: "On PR merge (separate trigger fires), call view.emit on the parent thread with a final 'merged' summary. thread.set_state('completed')."
    depends: [4]
```

#### 7.6.8 The naming convention

There is no formal "sub" prefix. By convention:

- **Top-level recipes** are named for the inbox-item kind (`pr-review`, `incident-investigate`, `epic-decompose`, `implement-workitem`).
- **Sub-recipes** are named for the bounded operation (`respond-to-pr-comment`, `gather-evidence-for-hypothesis`, `apply-mitigation`).
- **Runtime recipes** authored by the agent for a specific thread are prefixed `_runtime/` (cleaned up when the thread terminates).

Any recipe can be used as a sub-recipe just by being referenced from another recipe's prose or invoked via `thread.spawn` / `recipe.run` / `recipe.read`. There is no schema-level distinction.

## 8. Triggers — HTTP Webhook Handlers

Triggers are **HTTP webhooks**. Conductor exposes `POST /hooks/<id>` for each registered trigger; whoever wants to fire it sends a POST. **Conductor stops being a scheduler** — that's a solved problem (OS cron, systemd, GitHub Actions, ADO service hooks, ICM webhooks). The user picks how to fire each trigger; Conductor just receives, runs the registered command, and returns 200.

Optional ergonomic shortcut: a registration can declare a `cron` field. An in-process daemon then self-fires the webhook on that schedule — useful for "I just want every 5 minutes without setting up OS cron." The cron daemon is NOT load-bearing; if it didn't exist, users would simply put `curl ...` in their crontab.

Like Claude Code hooks, the framework owns one thing — the webhook rule + the stdin/stdout/env-var protocol. The user owns the command. The command can be any executable: a TS file with `tsx`, a shell script, a Python script. **Runnable in isolation** — set env vars and run it directly, or `curl` the webhook from anywhere.

### 8.1 Trigger types vs registered triggers

Triggers split cleanly into two concepts:

- A **trigger type** is a *capability* — a script file plus a parameter schema and a default cron. It's declared by a plugin under `provides.trigger_types[]` (§10.2). A type itself doesn't fire; it's a contract.
- A **registered trigger** is a *concrete instance* — a binding of a type to specific param values, persisted in `.conductor/triggers.json` `registered[]`. The cron daemon ticks registered rows; the webhook server mounts `/hooks/<id>` for each one.

A single trigger type (e.g. `ado.new-pr-watcher`) can be registered many times with different params (one per repo). Each registration gets its own webhook path, its own cron timer (if any), and its own persisted `state`.

The agent activates a capability by calling **`trigger.register({ type_id, params, cron? })`** — the only verb that creates a webhook-mounted, daemon-ticked instance. Listing capabilities is `trigger.list_types`; listing active instances is `trigger.list_registered`. The two are deliberately separate tools (§6.1).

### 8.2 Trigger type declaration

A plugin (or project) declares a trigger type with:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Globally unique. Plugin manifests require namespaced ids matching `[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*` (e.g. `ado.new-pr-watcher`) |
| `file` | yes | Relative path to the trigger script, under the plugin or project directory |
| `description` | recommended | One-line prose, shown in `trigger.list_types` |
| `default_cron` | no | 5- or 6-field cron expression. Registrations with `cron=null/absent` inherit this; registrations with `cron=<string>` override; registrations with `cron=false` disable cron entirely |
| `accepts_webhook` | no | Default `true`. When `false`, the type opts out of inbound `/hooks/<id>` mounting (cron-only or manual-only) |
| `identity_param` | no | Name of the param that uniquely identifies a registered instance. When set, registered-trigger id is `<type_id>#<param[identity_param]>` (URL-encoded). When absent, ids are minted from a SHA-256 hash of the params |
| `parameters` | no | Array of `{ name, type, required?, description?, default? }`. `type` ∈ `string \| integer \| number \| boolean \| array \| object`. At register-time these are validated against the agent's `params`; defaults are applied; the resolved params become the instance's initial `state` (§8.5) |

### 8.3 Registration lifecycle

```
trigger.list_types       — what capabilities can I bind?
trigger.register         — bind one with concrete params + (optional) cron override
trigger.list_registered  — what's currently active?
trigger.update_params    — modify params and/or cron without unregister
trigger.enable / disable — toggle without removing the row
trigger.unregister       — remove the row; type stays available
```

**Param validation.** `register` and `update_params` validate `params` against the type's `parameters[]` schema. Errors surface as a structured `PARAM_VALIDATION` result with `{ errors: [{ path, code, message }] }`. Required params missing → `path=params.<name>, code=REQUIRED`. Type mismatch → `path=params.<name>, code=TYPE`. Defaults from the type schema are applied to absent optional params; extra params (not on the schema) pass through as-is — types are forward-compatible.

**Cron resolution (three states).** A registration's `cron` field is one of:

| `cron` on registration | Effect |
|---|---|
| `"<expression>"` | Override the type's `default_cron` for this instance |
| `null` / absent | **Inherit** — the type's `default_cron` is used (and may be null itself, in which case no cron fires) |
| `false` / `""` | **Disable** cron — webhook-only / manual-only. Useful for hot triggers wired to a real-time service hook |

Other firing modes (webhook `POST /hooks/<registered-id>`, `trigger.fire` MCP) **always work** regardless of cron state.

**Id minting.**

- `identity_param` set on the type: `<type_id>#<encodeURIComponent(param[identity_param])>` — stable, human-readable, e.g. `ado.new-pr-watcher#auth-svc`.
- `identity_param` absent: `<type_id>#<sha256(sorted-params).slice(0,8)>` — deterministic, opaque.

Collisions (same id minted twice — same type + same identity-param value) reject with structured `TRIGGER_ALREADY_REGISTERED`. The agent's recovery path is `trigger.update_params` or `trigger.unregister` followed by a fresh `register`.

### 8.4 Firing modes — pick whatever fits

Once registered, a row can be fired five ways:

| Mechanism | When | How |
|---|---|---|
| **External webhook** (real-time) | ADO PR pushed, ICM incident fired, GitHub Action completes, Slack receives a message | The external system is configured to POST to `http://localhost:5201/hooks/<id>` (typically via a tunnel or service-hook config). Sub-second latency. |
| **Internal cron** (ergonomic poll) | "Every 5 minutes, fire this" without setting up OS cron | The registration's resolved cron is set. In-process daemon self-fires the webhook. |
| **External cron** (no Conductor cron at all) | Same use case as above, but the user prefers OS cron / systemd / Task Scheduler | Add to crontab: `*/5 * * * * curl -X POST http://localhost:5201/hooks/<id> -H "Authorization: Bearer $TOK"`. Register with `cron: false`. |
| **Manual** (testing or one-off) | "Run this now" from the UI or terminal | Click "Run Now" in UI, or `curl -X POST ...` from any shell |
| **Agent-driven** (programmatic) | Agent decides to fire a registered trigger | Calls `trigger.fire({ id, payload })` MCP tool |

**The same script handles all five.** Inside, it can branch on `fired_by` and on whether the POST body is empty (see envelope §8.5).

**Skip-on-overlap.** When the cron daemon's tick fires for a row whose previous run is still in flight, the new tick is skipped (logged, `last_run_skipped_count` incremented). Long polls don't pile up.

### 8.5 Stdin envelope at fire time

> **Implementation note (2026-05-29).** The §8.5–§8.10 sections below describe
> the **original conceptual design** — a single `callback_url` per registered
> trigger with the routing baked into the path, Mode-A vs Mode-B response
> protocols, and a Claude-Code-style stdout JSON envelope (`callback`,
> `continue`, `decision`, etc.). The shipped implementation has since
> diverged. The current envelope contract — `output_dir` + `dispatch_url?` +
> `spawn_url`, per-fire `CLAWDEVBOX_FIRE_SECRET`, and the
> `POST /dispatch/<fire_id>` + `POST /spawn/<fire_id>` + `GET /api/sessions/<id>`
> endpoints — is the source of truth for trigger authors. See
> [`docs/tools/trigger.md`](./tools/trigger.md#trigger-envelope-contract) and
> [`docs/tools/cron.md`](./tools/cron.md#endpoints). The original prose below
> is retained as a historical design record; do not rely on the URL shapes,
> response fields, or env-var names in §§8.5–8.10 for new work.

The stdin envelope (full shape in §8.6 below) merges the registration's `state` with everything the script needs to act. The type's `parameters[]` defines the **initial state shape** — at `trigger.register` time, the resolved params (with defaults applied) seed `state` so the first fire reads them under their declared names. Subsequent fires update `state` via the script's stdout, so additional fields accumulate (e.g., `lastCheckedAt` cursors). The script reads `env.state.<param-name>` directly — no separate `params` envelope field is necessary.

### 8.6 Configuration: `.conductor/triggers.json`

The on-disk shape is a single array of registered instances:

```json
{
  "registered": [
    {
      "id": "ado.new-pr-watcher#auth-svc",
      "type": "ado.new-pr-watcher",
      "params": { "repo": "auth-svc" },
      "cron": null,
      "enabled": true,
      "subscriber_thread_id": null,
      "expires_at": null,
      "once": false,
      "registered_at": 1715380000000,
      "state": { "repo": "auth-svc", "lastCheckedAt": 0 },
      "last_run_at": null,
      "last_run_status": null,
      "last_run_error": null
    },
    {
      "id": "ado.comment-watcher#2401",
      "type": "ado.comment-watcher",
      "params": { "repo": "auth-svc", "pr_id": 2401 },
      "cron": false,
      "enabled": true,
      "subscriber_thread_id": "thr_01HX...",
      "expires_at": 1716998400000,
      "once": false,
      "registered_at": 1715380000123,
      "state": { "repo": "auth-svc", "pr_id": 2401, "lastCommentId": 0 },
      "last_run_at": null,
      "last_run_status": null,
      "last_run_error": null
    }
  ]
}
```

`cron` is one of: a cron string (override), `null` (inherit the type's `default_cron`), or `false` (cron disabled — webhook/manual-only). The sidecar reads this file at boot, mounts the **inbound webhook** (`/hooks/<id>`) and a **callback URL** per registered trigger, optionally registers an in-process cron timer (when resolved cron is non-null and non-false), and watches the file for changes (500 ms debounce).

**Two URLs per registered trigger:**
- **Webhook URL** (inbound): `http://localhost:5201/hooks/<registered-id>` — what fires the script. ADO service hooks POST here; the cron daemon self-fires here; the user `curl`s here.
- **Callback URL** (outbound): a **pre-bound URL** Conductor mints at registration time. The URL itself encodes the routing — which thread to resume, which recipe to spawn, which parent to fan out under, which inbox item to attach to. The script doesn't construct it or pass routing fields; it just POSTs `{ prompt, context }`.

Both authenticated with `Authorization: Bearer $CONDUCTOR_MCP_SECRET`.

#### The callback URL — routing baked into the path

Conductor mints a structured URL per registered trigger at registration time. The URL has all the routing context — thread ids, recipe ids, parent ids, inbox item ids — embedded as path components. The script gets this URL ready-to-use in its stdin envelope as `callback_url`:

| URL shape | What a POST does |
|---|---|
| `/callback/threads/<thread_id>/resume` | Append message to thread; wake suspended CLI |
| `/callback/recipes/<recipe_id>/run` | Spawn fresh thread with that recipe; prompt = first user message |
| `/callback/recipes/<recipe_id>/run/<inbox_item_id>` | Spawn fresh thread, attach to specific inbox item |
| `/callback/recipes/default-agent/run` | Spawn fresh thread with the bundled empty-agent recipe; agent extends from prompt |
| `/callback/threads/<parent_thread_id>/spawn-sub/<recipe_id>` | Spawn a child thread with that recipe + `parent_thread_id` set |
| `/callback/threads/<thread_id>/close-step` | Append a `step_close` message + wake; agent reads prompt to know how to advance |
| `/callback/inbox/<inbox_item_id>/update` | Patch inbox item columns from POST body |

The script's POST body is uniform regardless of URL:

```json
{
  "prompt": "New comment on PR 2401 from alice@example.com:\n\n> Why are you changing this?\n\nLook at the comment in context of your current review.",
  "context": { "pr_id": 2401, "comment_id": 99 }
}
```

#### The script never has to think about routing

The script just reads `env.callback_url` and POSTs to it.

For a trigger that needs to perform **multiple action kinds** (rare — typically a fan-out case), the type declares each one and the envelope contains a `callback_urls` map:

```json
{
  ...
  "callback_url": "http://.../callback/threads/thr_epic/resume",
  "callback_urls": {
    "self_resume": "http://.../callback/threads/thr_epic/resume",
    "spawn_workitem": "http://.../callback/threads/thr_epic/spawn-sub/implement-workitem",
    "spawn_review": "http://.../callback/threads/thr_epic/spawn-sub/pr-review"
  }
}
```

The script picks `env.callback_urls.spawn_workitem` for each child item, POSTs prompt + context, and Conductor spawns the right sub-recipe.


#### What the script DOES have to do

Two things, both meaningful:

1. **Detect the event.** Poll the external system, dedupe against `state`, find what's new. (Or use the `payload` from a real-time webhook fire.)
2. **Frame each event as a prompt.** Translate raw structured data into a human-readable instruction the agent can act on. This is the actual intelligence of the trigger.

That's it. No routing, no thread lookup, no message-type selection, no MCP calls. The URL handles routing; the prompt does the work.

A script that DOES need to read internal state (e.g., "list all live PRs to decide who to nudge") still has MCP available via `CONDUCTOR_MCP_URL`. But the **detect-frame-POST loop is the 90% case**.

The actual scripts live wherever the user wants. Convention:
- `<plugin>/triggers/<type-name>.ts` for plugin-shipped types
- `.conductor/triggers/<type-name>.ts` for project-scope types
- Hot-trigger scripts that the agent generates at runtime live where the agent puts them; the type declaration just points `file` at that location

### 8.7 Webhook protocol (caller → Conductor)

| Aspect | Spec |
|---|---|
| Method + path | `POST /hooks/<registered-id>` |
| Auth | `Authorization: Bearer <CONDUCTOR_MCP_SECRET>` (header). For dev, `CONDUCTOR_AUTH_DEV_OPEN=1` skips. |
| Request body | Optional JSON. Whatever the caller wants to pass to the script. ADO service hooks send PR payloads; ICM sends incident payloads; cron self-fires send `{}`. |
| Response | `200 { run_id, duration_ms, exit_code, stdout? }` on success, `4xx` on auth/validation, `5xx` on script error |

### 8.8 Script protocol (Conductor → script subprocess)

The protocol mirrors **Claude Code's hook script protocol** verbatim where it makes sense — typed JSON envelope on stdin, JSON output with `decision`/`reason`/`systemMessage` semantics, exit-code conventions including the special `2` for blocking error. If you've written a Claude Code hook, you've written a Conductor trigger.

#### Stdin: typed JSON envelope

When the webhook fires, Conductor spawns the command as a subprocess with a **single JSON object on stdin** containing everything the script needs:

```json
{
  "trigger_event_name": "TriggerFired",
  "trigger_id": "ado-comment-watcher",
  "run_id": "run_01HX...",
  "fired_by": "external",
  "fired_at": 1715284800000,
  "cwd": "/path/to/workspace",
  "project_dir": "/path/to/workspace",
  "trigger_data_dir": "/path/to/workspace/.conductor/triggers/ado-comment-watcher/data",
  "subscriber_thread_id": "thr_01HX...",
  "callback_url": "http://localhost:5201/callback/threads/thr_01HX/resume",
  "state": { "lastCommentId": 1234, "selfUser": "kirmadi@microsoft.com" },
  "payload": {
    "resource": { "pullRequest": { "pullRequestId": 2401 }, "comment": { "id": 1235, "content": "..." } }
  }
}
```

| Field | Always present | Description |
|---|---|---|
| `trigger_event_name` | yes | Constant `"TriggerFired"` (room to add more event types later, mirroring Claude Code's `hook_event_name`) |
| `trigger_id` | yes | The id from `triggers.json` |
| `run_id` | yes | Unique per invocation; same id as in DB row |
| `fired_by` | yes | `"external"` (HTTP POST), `"cron"` (in-process daemon), `"manual"` (UI/CLI), `"agent"` (`trigger.fire` MCP tool) |
| `fired_at` | yes | Unix-ms timestamp |
| `cwd`, `project_dir` | yes | Workspace root — the user's project directory (mirrors Claude Code's `CLAUDE_PROJECT_DIR`). The script can read project files (recipes, configs, source) from here. |
| `trigger_data_dir` | yes | **Per-trigger scratch directory.** `<project_dir>/.conductor/triggers/<trigger_id>/data/`. Conductor creates it on first run and guarantees it's not shared with other triggers. The script can write any files it needs to maintain across runs (caches, downloaded artifacts, partial state too large for `state_json`, etc.) without collision. For hot triggers, this directory is deleted along with the trigger when the subscriber thread terminates. |
| `callback_url` | yes | **Pre-bound HTTP endpoint encoding routing in its path.** Script just POSTs `{ prompt, context? }`; Conductor parses the URL path to know which thread to resume, which recipe to spawn, which parent to fan out under, etc. (§8.1) |
| `callback_urls` | when trigger has multiple actions | Optional map keyed by named action (e.g., `spawn_workitem`, `self_resume`). Used by fan-out triggers; for single-action triggers, just `callback_url`. |
| `state` | yes | Last persisted state object (`{}` on first run). Best for small, structured data. For larger data (downloaded files, caches), use `trigger_data_dir`. |
| `payload` | yes if external | The POST body parsed as JSON. `null` for cron/manual fires unless caller provided a body. |
| `subscriber_thread_id` | hot only | Set when the trigger is context-bound to a thread; mirrors Claude Code's optional `agent_id` |

**State vs. `trigger_data_dir`:** small structured data (counters, ids, timestamps, settings) → `state` (auto-persisted to DB by Conductor as `state_json`). Files, caches, large blobs, anything you'd `fs.writeFile` → `trigger_data_dir` (managed by the script directly with `fs` calls).

**The callback URL is the killer simplification.** Most trigger scripts shouldn't have to call MCP at all — they just translate external event format → Conductor event format → POST. Conductor's callback handler does all the SQLite writes, thread-wake, recipe-spawn, etc. The script becomes pure I/O glue.

A TS hook reads it in one line:

```ts
const input = JSON.parse(await readStdin());
const { state, payload, subscriber_thread_id, fired_by } = input;
```

A shell hook reads it via `jq`:

```bash
INPUT=$(cat)
LAST=$(echo "$INPUT" | jq -r '.state.lastCheckedAt // 0')
PR_ID=$(echo "$INPUT" | jq -r '.payload.resource.pullRequestId // empty')
```

#### Env vars (minimal, just bootstrap context)

We deliberately keep env vars minimal — everything trigger-specific is in the stdin envelope. This matches Claude Code's pattern (only `CLAUDE_PROJECT_DIR` + a couple of bootstrap vars).

| Env var | Meaning |
|---|---|
| `CONDUCTOR_PROJECT_DIR` | Workspace root (mirrors Claude Code's `CLAUDE_PROJECT_DIR`) |
| `CONDUCTOR_MCP_URL` | `http://localhost:5201/mcp` |
| `CONDUCTOR_MCP_SECRET` | Per-launch auth bearer token |

The script doesn't need anything else — `state`, `payload`, `trigger_id`, `subscriber_thread_id`, `fired_by` all live in the stdin JSON.

#### Stdout: JSON response with semantics

Mirrors Claude Code's hook output. On exit 0, stdout is parsed as JSON; recognized fields:

```json
{
  "state": { "lastCheckedAt": 1715284800000 },
  "callback": { "body": { "prompt": "Review PR 2401: Fix auth", "context": { "pr_id": 2401 } } },
  "continue": true,
  "stopReason": null,
  "suppressOutput": false,
  "systemMessage": "Started review for 1 new PR",
  "decision": "ok",
  "reason": null
}
```

| Field | Type | Default | Effect |
|---|---|---|---|
| `state` | object | unchanged | Persisted as new `state_json` for this trigger |
| `callback` | object | omitted | **Mode-A callback.** Optional, **at most one**. The `body` field is the same shape the script would have POSTed to `env.callback_url`. Conductor delivers it to that URL internally. (See *Two response modes* below.) If a single run needs to deliver more than one event, use Mode B (live POSTs during the run) for the additional events; Mode A's `callback` is for at most one final/summary action. |
| `continue` | boolean | `true` | If `false`, **disable** the trigger (set `enabled=0`); the user re-enables manually. Useful for "this trigger has hit a permanent error condition." |
| `stopReason` | string | none | Logged to `last_run_error` when `continue=false` |
| `suppressOutput` | boolean | `false` | Omit stdout/stderr from run logs (still updates state) |
| `systemMessage` | string | none | One-line summary surfaced in the UI's trigger list (e.g., "Picked up 3 PRs") |
| `decision` | string | `"ok"` | `"ok"` (default) or `"block"` (this run is treated as a soft error — state NOT persisted, last_run_status='error', but trigger stays enabled). Mirrors Claude Code's PostToolUse `decision: "block"`. |
| `reason` | string | none | Logged to `last_run_error` when `decision='block'` |

**Plain-text stdout is also valid.** If the stdout isn't valid JSON, Conductor treats it as a log line — state unchanged, run logged ok. This matches Claude Code's "plain text fallback" behavior.

#### Two response modes

Triggers can deliver callbacks two ways. Pick whichever fits — they interoperate cleanly.

**Mode A — Respond via stdout (default, simple).** The script reads stdin, optionally sets a single `callback` object on its JSON response, writes that JSON on stdout, and exits. Conductor delivers `callback.body` to the trigger's pre-bound `env.callback_url`. **The script makes zero HTTP calls.** Most one-shot triggers (cron polls that surface a single event, single-fire webhooks, on-exit summaries from longer-running scripts) want this mode.

`callback` is **singular and optional**: at most one delivery per run. **If a single run needs to deliver more than one event, use Mode B for the additional events** (POST each one live to `env.callback_url` during the run); Mode A's `callback` is reserved for at most one final/summary action delivered when the script exits.

```ts
// Mode A: build at most one callback, write, exit.
let callback: { body: { prompt: string; context?: object } } | undefined;
if (newComment) {
  callback = { body: { prompt: framePrompt(newComment), context: { comment_id: newComment.id } } };
  state.lastCommentId = newComment.id;
}
process.stdout.write(JSON.stringify({ state, ...(callback ? { callback } : {}) }));
```

**Mode B — Long-running script POSTs directly.** The script keeps running, makes HTTP calls to `env.callback_url` itself as events arrive, and exits with `{ state }` on stdout when its internal loop is done. Used for daemon-style watchers and any script that needs to deliver more than one event per run — e.g., a watcher that polls a PR and POSTs each new comment immediately as it lands. Requires `CONDUCTOR_MCP_SECRET` for the Authorization header.

```ts
// Mode B: stream events out, exit when done.
for await (const evt of streamSubscription()) {
  await fetch(env.callback_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ prompt: framePrompt(evt), context: { ... } }),
  });
}
process.stdout.write(JSON.stringify({ state }));
```

**Multi-URL triggers (rare).** When a trigger declares multiple actions (§8.1), the envelope ships `callback_urls: { spawn_workitem: '...', self_resume: '...' }`. In Mode B, the script picks the right URL per event. In Mode A, future revisions of this protocol will let `callback` declare `url: 'spawn_workitem'` to pick a key — for the common single-action case, just set `body` and Conductor delivers to `callback_url`.

**No-op.** Just `{ "state": <unchanged> }` (or `{}`) on stdout. No callback delivered. The default outcome of "I polled and there was nothing new."

**Mixing.** A script may use both modes in the same run: POST live events via Mode B during execution, AND set one final `callback` on stdout for a summary/closing action (delivered after exit). Conductor feeds both into the same callback fan-out; the agent on the other end can't tell which path delivered each one.

#### Exit codes (Claude-Code-style)

| Exit code | Behavior |
|---|---|
| **0** | Success; parse stdout. Returns 200 to webhook caller. |
| **2** | **Blocking error** — stderr is captured to `last_run_error`. Returns 500 to webhook caller. State NOT updated. (Same semantics as Claude Code's exit 2 — "I have a real reason to fail this run.") |
| Other non-zero | Non-blocking error — first line of stderr to `last_run_error`. Returns 500. State NOT updated. |
| Process exceeds `timeout_seconds` | SIGKILL; returns 504. |

If a script repeatedly fails, the user disables it from the UI. Conductor never auto-disables (unless the script itself returns `continue: false`). Script bugs shouldn't silently kill triggers.

### 8.9 Running a script in isolation

Two ways to test without going through the deployed daemon:

```bash
# Way 1: hit the live webhook with curl
curl -X POST http://localhost:5201/hooks/new-pr-watcher \
  -H "Authorization: Bearer $(cat .conductor/.secret)" \
  -H "Content-Type: application/json" \
  -d '{}'

# Way 2: run the script directly with a synthetic stdin envelope (no daemon at all)
export CONDUCTOR_PROJECT_DIR="$(pwd)"
export CONDUCTOR_MCP_URL="http://localhost:5201/mcp"
export CONDUCTOR_MCP_SECRET="$(cat .conductor/.secret)"

# Stdin is a single JSON envelope (same shape Conductor passes in production)
cat <<EOF | tsx .conductor/triggers/new-pr-watcher.ts
{
  "trigger_event_name": "TriggerFired",
  "trigger_id": "new-pr-watcher",
  "run_id": "manual-test-$(date +%s)",
  "fired_by": "manual",
  "fired_at": $(date +%s%3N),
  "cwd": "$(pwd)",
  "project_dir": "$(pwd)",
  "subscriber_thread_id": null,
  "state": {"lastCheckedAt": 0},
  "payload": null
}
EOF

# stdout: '{"state": {"lastCheckedAt": 1715284800000}, "systemMessage": "Picked up 3 PRs"}'
```

A `conductor trigger run <id>` CLI subcommand wraps both:

```bash
conductor trigger run new-pr-watcher                  # POST to webhook, current state
conductor trigger run new-pr-watcher --payload-file=p.json --dry   # don't persist state
conductor trigger logs new-pr-watcher --tail          # stream stderr from recent runs
```

### 8.10 End-to-end execution timeline (PR review with comment-watcher)

A worked example showing every component in motion. PR 2401 is pushed to ADO; ADO has a service hook configured to POST to `http://<dev-machine>:5201/hooks/ado-new-pr-watcher`.

```
T=0         ADO finishes pushing PR 2401. Within ~1s, ADO's service-hook engine
            fires:
              POST http://localhost:5201/hooks/ado-new-pr-watcher
                Authorization: Bearer <SECRET>
                Content-Type: application/json
                Body:  { resource: { pullRequestId: 2401, title: "Fix auth",
                                     createdBy: { uniqueName: "alice" }, ... } }

T=0+50ms    Conductor sidecar's HTTP handler:
              - Validates auth header                                 (200ms total)
              - Reads `triggers.json` entry for `ado-new-pr-watcher`
              - Loads state_json from DB row (e.g. {"lastCheckedAt": ...})
              - Spawns: `tsx .conductor/triggers/ado-new-pr-watcher.ts`
                  ├─ stdin:   <ADO payload bytes>
                  ├─ env:     CONDUCTOR_TRIGGER_STATE='{...}', CONDUCTOR_MCP_*,
                  │           CONDUCTOR_WEBHOOK_FIRED_BY='external', ...
                  └─ stdout/stderr piped to parent

T=0+200ms   Script reads stdin, parses payload. Sees `payload.resource.pullRequestId`
            → real-time path. Calls (via @conductor/sdk → MCP tool):
              conductor.recipe.run({
                id: 'pr-review',
                prompt: 'Review PR 2401 in auth-svc: Fix auth',
                attach_to_inbox_item_id: 'ado:pr:2401',
              })
            Sidecar: upserts inbox_item, inserts thread T1, snapshots recipe.
            Scheduler component: spawns `claude --resume T1 --mcp-config ...`.
            Script writes stdout: '{"lastCheckedAt": ...}', exits 0.
            Sidecar persists state_json, returns 200 to ADO.
            (ADO's service-hook engine sees 200, marks delivery successful.)

T=0+1s      The `claude` CLI is alive on thread T1. Agent reads its bootstrap prompt
            (recipe name, system prompt) and the user message ('Review PR 2401...').

T=0+30s     Agent has read the diff, classified changes, drafted review comments
            (via ado.* MCP tools). Writes them via thread.append_message and
            view.emit. Inbox card now shows agent_message and the review walkthrough.

T=0+45s    Before posting, agent registers an instance of the
            `ado.comment-watcher` trigger type to watch this PR's comments
            while T1 is alive. Calls (via MCP):
              trigger.register({
                type_id: 'ado.comment-watcher',
                params: { repo: 'auth-svc', pr_id: 2401, self_user: '<me>' },
                subscriber_thread_id: 'T1',
                expires_at: <now> + 30d,
                cron: null,    // inherit the type's default_cron ("*/30 * * * * *")
              })
            Sidecar: validates params against the type schema, mints
            id `ado.comment-watcher#2401` (identity_param=pr_id), appends a
            row to `.conductor/triggers.json` `registered[]`, mounts the
            webhook at `/hooks/ado.comment-watcher#2401`, and registers the
            inherited cron timer. (Optionally, agent also configures ADO
            to POST comments directly to the same webhook URL.)

T=0+60s    Agent posts initial review via ado.comment_pr, calls thread.set_state(T1, 'suspended'),
           exits cleanly. CLI subprocess exits, scheduler updates thread.
           Registered trigger `ado.comment-watcher#2401` is now armed; T1 is suspended.

T=2h       Reviewer Bob comments on PR 2401. Two paths can fire:

           Path A (real-time, if ADO is configured to post comments):
             ADO POSTs the comment payload to /hooks/ado.comment-watcher#2401 at T=2h+1s.
             Sidecar spawns the script. Script sees comment in stdin → POSTs
             to env.callback_url (the resume URL minted at registration time).

           Path B (cron backup, if ADO isn't configured for comments):
             Within 30s, in-process cron self-fires the webhook with empty body.
             Script sees empty stdin → polls ado.list_pr_comments → finds Bob's
             comment → same outcome.

T=2h+(1-30)s
           Inside the script:
             - POST env.callback_url with { prompt, context } — the URL
               itself encodes the thread resume; Conductor appends a
               signal_received message and wakes T1.
           Conductor sees T1 is 'suspended' → spawns `claude --resume T1`.

T=2h+(2-31)s
           Same agent session resumes. Sees the new signal_received message.
           Drafts a reply (consulting the 'respond-to-pr-comment' sub-recipe).
           Posts via ado.comment_pr. Goes back to suspended.

T=24h      Bob approves the PR; ADO merges it. ADO posts pr.merged event to a
           different webhook (registered from a `pr-merged-cleanup` type).
           That trigger's script:
             - calls thread.set_state(T1, 'completed') via MCP
             - calls trigger.unregister({ id: 'ado.comment-watcher#2401' })

T=24h+1tick
           Cron daemon's housekeeping pass sees subscriber_thread_id 'T1'
           is in a terminal state; calls trigger.unregister to drop the
           `ado.comment-watcher#2401` row from triggers.json.
```

**What ran where:**

| Component | Did |
|---|---|
| ADO service hook | Fired the webhook with PR + comment data |
| Conductor sidecar HTTP server | Authed, read config, spawned script subprocess, persisted state, returned 200 |
| Trigger script (tsx subprocess) | Read stdin, called MCP tools, wrote new state to stdout, exited |
| Conductor MCP server | Inserted/updated DB rows; spawned the agent CLI process |
| `claude` CLI subprocess | Read recipe + prompt, called MCP tools, posted comments, exited |
| Cron daemon | Backup poll if ADO comments aren't webhooked; housekeeping cleanup |

**Conductor itself never reasoned.** Webhooks fired; scripts called MCP tools; the agent did the work. Every step is independently inspectable: the webhook hit shows in HTTP logs, the script run shows in `triggers.last_run_*` columns, the agent run shows in `messages` rows, the artifacts are on disk under `<workspace>/.conductor/runs/T1/`.

### 8.11 Hot triggers — context-bound to a thread

A trigger registered with a `subscriber_thread_id` is a **hot trigger** — meaningful only in the context of a live thread. The agent activates it by calling `trigger.register(...)` with `subscriber_thread_id` set:

```
trigger.register({
  type_id: 'ado.comment-watcher',
  params: { repo: 'auth-svc', pr_id: 2401 },
  subscriber_thread_id: '<this-thread-id>',
  cron: null,    // inherit the type's default_cron, OR pass false to disable cron
  expires_at: <now> + 30d,
})
```

Conductor:
1. Validates `params` against the type's `parameters[]` schema.
2. Mints the registered id (e.g. `ado.comment-watcher#2401` if `identity_param=pr_id`).
3. Appends to `.conductor/triggers.json` `registered[]` with the bound thread.
4. Mounts `/hooks/<registered-id>` and registers the resolved cron timer (if any).

When the subscriber thread reaches `completed` / `failed` / `cancelled`, Conductor calls `trigger.unregister` for every row carrying that `subscriber_thread_id` — the type itself stays available and can be re-registered against a future thread.

### 8.12 Hot-trigger context: same-thread injection

Most hot triggers exist to wake their owning thread when external context changes. Inside the script:

```ts
import { conductor } from '@conductor/sdk';

const state = JSON.parse(process.env.CONDUCTOR_TRIGGER_STATE!);
const threadId = process.env.CONDUCTOR_THREAD_ID!;

// (Poll something, find new external state...)

if (newComment) {
  await conductor.thread.append_message({
    thread_id: threadId,
    type: 'signal_received',
    payload: { source: 'ado', kind: 'pr.commented', body: newComment, sub_template: 'respond-to-pr-comment' },
  });
  await conductor.thread.wake(threadId);
}

process.stdout.write(JSON.stringify({ ...state, lastSeen: newComment.id }));
```

`thread.wake` is no-op if the thread is `running` (live CLI sees the new message on next turn). If `suspended`, the scheduler spawns `claude --resume <thread_id>` so the same agent session picks up the new context.

### 8.13 Sample triggers

Each sample is two parts: the entry in `triggers.json` (declares the webhook + handler binding) and the executable script file (runs whenever the webhook fires). Scripts handle both **cron-fired** (empty stdin, poll for state) and **externally-fired** (stdin has payload from ADO/ICM/whatever) cases — the dual-fire pattern.

#### 8.8.1 Dual-fire (TS) — Watch new ADO PRs (mockup 01)

ADO posts directly to our webhook on PR-create events; cron polls every 5 minutes as a backup.

`triggers.json` entry:
```json
{
  "id": "ado-new-pr-watcher",
  "description": "Fire on ADO PR-created service hook, OR poll every 5m as backup.",
  "command": "tsx $CONDUCTOR_PROJECT_DIR/.conductor/triggers/ado-new-pr-watcher.ts",
  "cron": "*/5 * * * *",
  "timeout_seconds": 60
}
```

ADO admin pastes this into "Service hook subscriptions → New pull request → POST to URL":
```
URL:    http://<dev-machine>:5201/hooks/ado-new-pr-watcher
Header: Authorization: Bearer <CONDUCTOR_MCP_SECRET>
```

`.conductor/triggers/ado-new-pr-watcher.ts`:
```ts
#!/usr/bin/env tsx
import { conductor, ado } from '@conductor/sdk';
import { readStdin } from '@conductor/sdk/util';

// One JSON envelope on stdin contains everything we need (Claude-Code-hook-style)
const input = JSON.parse(await readStdin());
const state = { lastCheckedAt: 0, selfUser: 'kirmadi@microsoft.com', ...input.state };
const fired = input.fired_by;     // 'external' | 'cron' | 'manual' | 'agent'
const payload = input.payload;    // ADO service hook body, or null for cron-fire

let picked = 0;

if (payload?.resource?.pullRequestId) {
  // Real-time path — ADO told us about exactly this PR
  const pr = payload.resource;
  if (pr.createdBy.uniqueName !== state.selfUser) {
    await conductor.recipe.run({
      id: 'pr-review',
      prompt: `Review PR ${pr.pullRequestId} in ${pr.repository.name}: ${pr.title}`,
      attach_to_inbox_item_id: `ado:pr:${pr.pullRequestId}`,
    });
    picked++;
  }
} else {
  // Cron-fire backup path — scan everything since last check
  const repos = (await conductor.settings.get('watched_repos')) ?? ['auth-svc'];
  for (const repo of repos) {
    const prs = await ado.list_prs({ repo, created_after: state.lastCheckedAt });
    for (const pr of prs) {
      if (pr.author === state.selfUser) continue;
      await conductor.recipe.run({
        id: 'pr-review',
        prompt: `Review PR ${pr.id} in ${repo}: ${pr.title}`,
        attach_to_inbox_item_id: `ado:pr:${pr.id}`,
      });
      picked++;
    }
  }
  state.lastCheckedAt = Date.now();
}

// Stdout: structured response (Claude-hook-style)
process.stdout.write(JSON.stringify({
  state,
  systemMessage: picked > 0 ? `Picked up ${picked} PR(s) (fired_by=${fired})` : `No new PRs (fired_by=${fired})`,
}));
```

Three ways to test it:
```bash
# 1. Hit the webhook directly (simulates an ADO service hook)
curl -X POST http://localhost:5201/hooks/ado-new-pr-watcher \
  -H "Authorization: Bearer $(cat .conductor/.secret)" \
  -d '{"resource":{"pullRequestId":2401,"title":"Fix auth","createdBy":{"uniqueName":"alice"},"repository":{"name":"auth-svc"}}}'

# 2. Pipe a synthetic stdin envelope (cron-fire simulation, no daemon needed)
echo '{"trigger_event_name":"TriggerFired","trigger_id":"ado-new-pr-watcher","run_id":"t1","fired_by":"cron","fired_at":0,"project_dir":"'"$(pwd)"'","state":{"lastCheckedAt":0},"payload":null}' \
  | CONDUCTOR_MCP_URL=http://localhost:5201/mcp CONDUCTOR_MCP_SECRET=$(cat .conductor/.secret) \
    tsx .conductor/triggers/ado-new-pr-watcher.ts

# 3. Use the helper CLI
conductor trigger run ado-new-pr-watcher --payload '{"resource":{"pullRequestId":2401,...}}'
```

#### 8.8.2 Hot (TS) — Watch comments on a specific PR (mockup 01/02)

Registered by the PR-review agent during its first run via `trigger.register` against the `ado.comment-watcher` TYPE (declared by the ADO plugin). The plugin ships the script; the agent only supplies params + subscriber_thread_id.

The registered row added to triggers.json `registered[]`:
```json
{
  "id": "ado.comment-watcher#2401",
  "type": "ado.comment-watcher",
  "params": { "repo": "auth-svc", "pr_id": 2401, "self_user": "kirmadi@microsoft.com" },
  "cron": null,
  "enabled": true,
  "subscriber_thread_id": "thr_01HX...T1",
  "expires_at": 1716998400000,
  "once": false,
  "registered_at": 1715380000000,
  "state": { "repo": "auth-svc", "pr_id": 2401, "self_user": "kirmadi@microsoft.com", "lastCommentId": 0 }
}
```

The script lives at `.conductor/plugins/ado/triggers/ado-comment-watcher.ts` (read-only, plugin-shipped). It reads PR id + repo from `state` (seeded from `params` at registration):
```ts
#!/usr/bin/env tsx
// Mode B — POST each new comment live; exit with state-only stdout.
// (Multiple events per run requires Mode B; Mode A's `callback` is singular.)
import { ado } from '@conductor/sdk';

const input = JSON.parse(await readStdin());
const state = { lastCommentId: 0, ...input.state };
const secret = process.env.CONDUCTOR_MCP_SECRET!;

const newComments = await ado.list_pr_comments({
  pr_id: state.pr_id,
  repo: state.repo,
  since_id: state.lastCommentId,
});

let posted = 0;
for (const c of newComments) {
  if (c.author === state.self_user) continue;   // skip self
  // Mode B: POST live to env.callback_url (the resume URL minted at
  // trigger.register time, with thr_01HX...T1 baked into the path).
  await fetch(input.callback_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      prompt: framePrompt(PR_ID, c),                    // human-framed instruction
      context: { source: 'ado', kind: 'pr.commented', pr_id: PR_ID, comment_id: c.id },
    }),
  });
  state.lastCommentId = c.id;
  posted++;
}

// State-only stdout — Mode A `callback` is unused since Mode B already
// delivered the events live during the run.
process.stdout.write(JSON.stringify({
  state,
  systemMessage: posted ? `Forwarded ${posted} comment(s)` : 'No new comments',
}));
```

#### 8.8.3 Cold (shell) — Stuck-PR nudge (mockup 04)

Pure shell script using the `conductor` CLI for MCP calls. No TS, no Node, no SDK needed.

`triggers.json` entry:
```json
{
  "id": "stuck-pr-nudge",
  "description": "Bump PRs whose monitor stage has been idle > 7 days.",
  "cron": "0 9 * * 1-5",
  "command": "$CONDUCTOR_PROJECT_DIR/.conductor/triggers/stuck-pr-nudge.sh"
}
```

`.conductor/triggers/stuck-pr-nudge.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

CUTOFF=$(($(date +%s%3N) - 7 * 24 * 60 * 60 * 1000))

# `conductor mcp call` reads CONDUCTOR_MCP_URL and CONDUCTOR_MCP_SECRET from env.
STALE=$(conductor mcp call conductor.inbox.list \
  --json '{"kind":"pr","state":"in_progress","last_event_before":'"$CUTOFF"'}')

echo "$STALE" | jq -c '.[]' | while read -r item; do
  ID=$(echo "$item" | jq -r '.id')
  TITLE=$(echo "$item" | jq -r '.title')

  conductor mcp call conductor.inbox.upsert --json '{
    "id": "'"$ID"'",
    "agent_message": "This PR has been quiet for 7+ days.",
    "agent_tone": "warn"
  }'

  conductor mcp call conductor.recipe.run --json '{
    "id": "pr-nudge",
    "prompt": "Nudge stale PR '"$ID"': '"$TITLE"'.",
    "attach_to_inbox_item_id": "'"$ID"'"
  }'
done
```

#### 8.8.4 Cold (TS) — ICM incident watcher (mockup 03)

`triggers.json` entry:
```json
{
  "id": "icm-incident-watcher",
  "description": "Pick up new P0/P1 incidents from ICM.",
  "cron": "*/2 * * * *",
  "command": "tsx $CONDUCTOR_PROJECT_DIR/.conductor/triggers/icm-incident-watcher.ts"
}
```

`.conductor/triggers/icm-incident-watcher.ts`:
```ts
#!/usr/bin/env tsx
import { conductor, icm } from '@conductor/sdk';

const state = JSON.parse(process.env.CONDUCTOR_TRIGGER_STATE ?? '{"lastCheckedAt":0}');

const incidents = await icm.list_incidents({
  severity: ['P0', 'P1'],
  state: 'active',
  fired_after: state.lastCheckedAt,
});

for (const inc of incidents) {
  await conductor.recipe.run({
    id: 'incident-investigate',
    prompt: `Incident ${inc.id} (sev ${inc.severity}, service ${inc.service}). Investigate.`,
    attach_to_inbox_item_id: `icm:${inc.id}`,
  });
}

state.lastCheckedAt = Date.now();
process.stdout.write(JSON.stringify(state));
```

#### 8.8.5 Hot (TS) — Watch walkthrough comments on the current thread (mockup 02)

`.conductor/triggers/_runtime/thr-01HX-walkthrough.ts`:
```ts
#!/usr/bin/env tsx
import { conductor } from '@conductor/sdk';

const state = JSON.parse(process.env.CONDUCTOR_TRIGGER_STATE ?? '{"lastSeenId":""}');
const threadId = process.env.CONDUCTOR_THREAD_ID!;

const newMsgs = await conductor.thread.read({
  thread_id: threadId,
  since_message_id: state.lastSeenId,
  types: ['walkthrough_comment'],
});
if (newMsgs.length === 0) {
  process.stdout.write(JSON.stringify(state));
  return;
}

state.lastSeenId = newMsgs[newMsgs.length - 1].id;

await conductor.thread.append_message({
  thread_id: threadId,
  type: 'signal_received',
  payload: {
    source: 'internal',
    kind: 'walkthrough.commented',
    comment_count: newMsgs.length,
    sub_template: 'respond-to-walkthrough-comment',
  },
});
await conductor.thread.wake(threadId);

process.stdout.write(JSON.stringify(state));
```

(While the agent is `running`, the live CLI sees the new walkthrough message on next turn anyway — this hot trigger matters when the thread is `suspended`.)

#### 8.8.6 Cold (TS) — Pure scheduled work (no external system)

`triggers.json` entry:
```json
{
  "id": "morning-standup",
  "description": "Summarize yesterday's PR activity at 9am M-F.",
  "cron": "0 9 * * 1-5",
  "command": "tsx $CONDUCTOR_PROJECT_DIR/.conductor/triggers/morning-standup.ts"
}
```

`.conductor/triggers/morning-standup.ts`:
```ts
#!/usr/bin/env tsx
import { conductor } from '@conductor/sdk';

const today = new Date().toISOString().slice(0, 10);

await conductor.recipe.run({
  id: 'daily-pr-summary',
  prompt: `Summarize PR activity in the last 24h across watched repos. Post one inbox item with the rollup.`,
  attach_to_inbox_item_id: `summary:pr:${today}`,
});

// No state mutation; empty stdout = no state change
```

### 8.14 What you do NOT have to do as a script author

- **No JSONPath filters.** Plain JS conditionals.
- **No signal table.** Call MCP tools directly.
- **No dedup_key.** Track "what have I already responded to" in `state` (e.g., `lastCommentId`, `lastCheckedAt`).
- **No state-machine declarations.** Sequential JS.
- **No retry config.** If you want retry, write a try/catch loop inside the script.
- **No recipe parameter binding.** Render the prompt with template literals.

### 8.15 Cancellation, errors, lifecycle

- **Worker timeout**: 10 minutes (configurable per-trigger via `timeout_ms`). Hard kill after.
- **Errors**: stack trace logged to `last_run_error`; trigger stays enabled. Pattern: if a script is failing repeatedly, the user disables it from the UI.
- **State on error**: persisted only on successful exit. A failed run does NOT update `state_json` — next tick retries from the previous good state.
- **Hot-trigger auto-cleanup**: when the subscriber thread reaches `completed` / `failed` / `cancelled`, the cron daemon's next tick `UPDATE`s `removed_at = now` on all rows with that `subscriber_thread_id` and drops their timers.
- **Boot recovery**: at sidecar boot, all enabled rows have their timers re-created. State is preserved.

## 9. Drop-Folder Configuration

All declarative configuration lives in two well-known directories — a per-workspace `.conductor/` and a user-wide `~/.conductor/`. No database registration step, no install command for recipes/triggers/skills: drop a file, the watcher picks it up. Plugins (§10) add a third tier between the two.

```
<workspace>/
  .conductor/
    recipes/                # per-project YAML recipes (TaskDock-style)
    triggers/               # per-project cron-script TS triggers
    skills/                 # markdown skills the side-terminal CLI auto-loads
    mcp/                    # Continue/Cursor-compatible JSON MCP server configs
    plugins/                # installed plugins (one directory per plugin); read-only at runtime
      <id>/
        plugin.yaml         # manifest (see §10.2)
        skills/             # plugin-bundled skills
        recipes/            # plugin-bundled recipes
        triggers/           # plugin-bundled triggers + triggers.json
        mcp/                # plugin-bundled MCP server configs
        README.md
    hooks.json              # event → side effect (notify, log, run script)
    mcp.json                # auto-generated at boot — points the CLI at the local MCP server with the per-launch secret
    runs/<thread_id>/
      artifacts/            # files the agent wrote and registered via artifact.write
      logs/                 # CLI stdout/stderr captures
~/
  .conductor/                # global library
    recipes/
    triggers/
    skills/
    mcp/
~/.conductor.db              # the kernel
```

`.conductor/mcp/*.json` reads in the same shape as Continue's `.continue/mcpServers/*.json`. Conductor's drop-folder watcher (`fs.watch` with 500ms debounce, copy-forked TaskDock pattern) reloads recipes, triggers, skills, and plugin manifests on save; a running thread keeps its `recipe_snapshot` so changes don't poison in-flight work.

**Scope precedence at read time:** project (`<workspace>/.conductor/`) → plugins (`<workspace>/.conductor/plugins/<id>/`, scanned in plugin-id sort order) → global (`~/.conductor/`). The first match wins. **Writes** are accepted only into `project` or `global`; plugin directories are read-only (§10.5, §10.7).

## 10. Plugins

Plugins are how Conductor scales beyond what ships in the box. A plugin is a directory that bundles recipes, skills, triggers, and MCP server configs as a unit — installable from a git repo, a local path, or a future plugin registry. The MVP supports git-based installation via `plugin.install` and treats every installed plugin as a trusted, read-only bundle.

The design goal is **drop-in extension without code changes to the host**. Adding ADO support to a fresh Conductor is one MCP call:

```
plugin.install({ from: 'git+https://github.com/conductor/plugin-ado.git' })
```

…and the user's inbox now knows how to handle ADO PRs, comments, and iterations.

### 10.1 What's in a plugin

The reference implementation lives at `samples/plugins/ado/`. Disk layout:

```
<global_dir>/plugins/ado/
├── plugin.yaml                       # manifest
├── README.md                         # install + customize instructions
├── skills/
│   ├── analyze-pr-comment.md         # how to read a PR comment
│   └── summarize-pr-changes.md       # how to summarize a PR diff
├── recipes/
│   ├── pr-review.yaml                # parent recipe
│   └── respond-to-pr-comment.yaml    # sub-recipe
├── triggers/
│   ├── ado-comment-watcher.ts        # Mode B comment watcher
│   ├── ado-pr-pulse-watcher.ts       # Mixed-mode pulse watcher (sample only)
│   └── triggers.json                 # which trigger files run on which schedule
└── mcp/
    └── ado.json                      # MCP server config (Continue-shape)
```

Plugins live in the **global** plugin store (`<global_dir>/plugins/`) so the
same install is shared across every project on the user's account. Sibling
to each plugin directory is `<id>.install.json` — a sidecar install record
recording where the plugin came from and how it was installed (git clone,
local-folder junction, built-in copy, or manual). Conductor scans for
`plugin.yaml` at boot and on file-watcher events; everything else in the
directory is discovered through `provides`.

### 10.2 Manifest (`plugin.yaml`)

The manifest is the only required file at the plugin root. Full schema:

```yaml
id: ado                                          # required, unique among installed plugins, lowercase[a-z0-9-]
name: "Azure DevOps"                             # required, human-readable
version: "1.0.0"                                 # required, semver
description: "Recipes, skills, triggers, and MCP server for Azure DevOps PRs and work items."
                                                 # required
author: "Conductor team"                         # optional
license: "MIT"                                   # optional
homepage: "https://github.com/conductor/plugin-ado"   # optional

provides:
  skills:
    - { id: analyze-pr-comment,    file: skills/analyze-pr-comment.md }
    - { id: summarize-pr-changes,  file: skills/summarize-pr-changes.md }
  recipes:
    - { id: pr-review,                file: recipes/pr-review.yaml }
    - { id: respond-to-pr-comment,    file: recipes/respond-to-pr-comment.yaml }
  trigger_types:
    # Cold capability — agent activates by calling trigger.register with concrete params.
    - id: ado.new-pr-watcher
      file: triggers/ado-new-pr-watcher.ts
      description: Detect new PRs in a repo; start a pr-review for each via callback.
      default_cron: "*/5 * * * *"
      identity_param: repo
      parameters:
        - { name: repo,           type: string,  required: true }
        - { name: assigned_to,    type: string,  required: false }
        - { name: opened_by,      type: string,  required: false }
        - { name: include_drafts, type: boolean, required: false, default: false }

    # Hot capability — pr-review recipe calls trigger.register per-thread with subscriber_thread_id.
    - id: ado.comment-watcher
      file: triggers/ado-comment-watcher.ts
      description: Wake an existing thread on new PR comments.
      default_cron: "*/30 * * * * *"
      identity_param: pr_id
      parameters:
        - { name: repo,      type: string,  required: true }
        - { name: pr_id,     type: integer, required: true }
        - { name: self_user, type: string,  required: false }
  tools:
    # Hostable tools (§10.3): single-file scripts hosted in-process by the
    # Conductor MCP server. Each `id` is namespaced `<plugin>.<verb>` and
    # surfaces as an MCP tool name unchanged.
    - { id: ado.get_pr,             file: tools/get_pr.ts }
    - { id: ado.list_pr_comments,   file: tools/list_pr_comments.ts }
    - { id: ado.comment_pr,         file: tools/comment_pr.ts }
    - { id: ado.list_iterations,    file: tools/list_iterations.ts }
    - { id: ado.get_pr_status,      file: tools/get_pr_status.ts }
  mcp_servers:
    # Optional. Use only when the work doesn't fit a single-file hostable tool —
    # e.g., long-running indexer, stateful daemon, binary in another language.
    # Each entry points at a Continue/Cursor-shape JSON config.
    # - { id: ado-heavy-indexer, file: mcp/ado-heavy-indexer.json }

requires:
  conductor_version: ">=1.0.0"                   # semver range checked at load
  env: [ADO_ORG, ADO_BEARER_TOKEN]               # required env vars; missing → load with warning, runtime tools fail clearly
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `[a-z][a-z0-9-]*`; collision with another installed plugin's id is a load error |
| `name` | string | yes | Free-form human title |
| `version` | semver string | yes | Used by `plugin.update`'s downgrade detection |
| `description` | string | yes | One-paragraph summary |
| `author` | string | no | |
| `license` | SPDX id or string | no | |
| `homepage` | URL | no | |
| `provides.skills[]` | array | no | `{ id, file }`; `id` must be unique within this list |
| `provides.recipes[]` | array | no | `{ id, file }`; loaded as recipes |
| `provides.trigger_types[]` | array | no | Capability declarations (spec §8.2). Each entry: `{ id, file, description?, default_cron?, accepts_webhook?, identity_param?, parameters?: [{name, type, required?, description?, default?}] }`. The agent calls `trigger.register({ type_id, params })` to mint a concrete instance from a type. Type ids must be namespaced (`<plugin>.<verb>`) and globally unique across enabled plugins |
| `provides.tools[]` | array | no | `{ id, file }`; **hostable tools** hosted in-process by the Conductor MCP server (see §10.3). `id` must be namespaced `<plugin>.<verb>` matching `[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*`; `file` is a `.ts` file under the plugin directory exporting the standard hostable-tool shape |
| `provides.mcp_servers[]` | array | no | `{ id, file }`; **heavyweight** alternative: a separate MCP server process declared via a Continue/Cursor-shape JSON config. Use only when the work doesn't fit a hostable tool (long-running indexer, stateful daemon, foreign binary) |
| `requires.conductor_version` | semver range | no | Defaults to `*`; mismatch is a load error |
| `requires.env` | string[] | no | Documented requirement; runtime tools that need an env var fail clearly when it's missing — the load itself doesn't fail |

### 10.3 Hostable tools

A **hostable tool** is a small TypeScript file inside a plugin's `tools/` directory that Conductor's MCP server discovers, dynamic-imports, and registers as an MCP tool — no separate MCP server process required. This is the inspired-by-OpenCode pattern: one process (the Conductor MCP server) hosting N lightweight scripts instead of N separate stdio servers.

**Why hostable beats running a separate MCP server.** One process instead of N. Tools share a process / fetch agent / cache — cheaper at scale. Faster cold start — no `npx` boot per server. Plugin authors write a single file, not a whole server harness. Lower attack surface — no extra ports, no extra subprocess management.

**When to fall back to `mcp_servers[]`.** If the plugin needs heavy lifting that doesn't fit a single function — a long-running indexer, a stateful daemon, a binary in another language — declare an `mcp_servers[]` entry pointing at a real external MCP server. Both coexist on the same plugin.

| | Hostable tool | External MCP server |
|---|---|---|
| Where it lives | `<plugin>/tools/<file>.ts` | `<plugin>/mcp/<name>.json` (config) + a separately-run server |
| What runs it | Conductor's MCP server (in-process, dynamic-import) | A separate child process spawned by the calling CLI's MCP host |
| Cold start | None — already loaded at Conductor boot | Per-spawn `npx`/binary cost |
| Process count | 1 (the Conductor server) regardless of tool count | 1 per server |
| State | Per-call only (no globals are honored across calls; share via files in `plugin_data_dir`) | Stateful — server can hold connections, caches |
| Cancellation | `ctx.signal` — caller cancel propagates as `AbortSignal` | The calling MCP host kills the subprocess |
| Best for | REST wrappers, single-function ops, anything that fits one TS file | Long-running indexers, daemons, multi-language tools |

**Tool file shape.** Every file under `<plugin>/tools/` referenced by `provides.tools[]` exports four things — three named, one default:

```ts
// .conductor/plugins/ado/tools/get_pr.ts
import { z } from 'zod';
import type { ToolContext } from '@conductor/sdk';

export const id = 'ado.get_pr';
export const description = 'Get pull request metadata for a single PR id.';
export const parameters = z.object({
  org:     z.string().optional().describe('ADO org; defaults to ADO_ORG env'),
  project: z.string().optional(),
  repo:    z.string(),
  pr_id:   z.number().int().positive(),
});

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
) {
  const auth = ctx.env.ADO_BEARER_TOKEN
    ? `Bearer ${ctx.env.ADO_BEARER_TOKEN}`
    : `Basic ${Buffer.from(`:${ctx.env.ADO_PAT}`).toString('base64')}`;
  const url = `https://dev.azure.com/${args.org ?? ctx.env.ADO_ORG}/.../pullRequests/${args.pr_id}?api-version=7.1-preview.1`;
  const res = await ctx.fetch(url, {
    headers: { Authorization: auth, Accept: 'application/json' },
    signal: ctx.signal,
  });
  if (!res.ok) throw new Error(`ADO ${res.status}: ${await res.text()}`);
  return { pullRequest: await res.json() };
}
```

The four exports:

| Export | Type | Required | Notes |
|---|---|---|---|
| `id` | string (named export) | yes | The MCP tool name. Must match `[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*` (namespaced like `ado.get_pr`). |
| `description` | string (named export) | yes | One-paragraph human description. Surfaced in `tools/list`. |
| `parameters` | zod schema (named export) | yes | A `z.object({...})` (or `z.unknown()` for no args). Conductor converts to JSON Schema for `tools/list`; on each call validates the args against this. |
| `execute` | `(args, ctx) => Promise<unknown>` (default export) | yes | The handler. `args` is the parsed zod output; `ctx` is `ToolContext`. Return value becomes the MCP tool's `structuredContent`. Throw to surface a tool error. |

**The `ToolContext` interface** (from `@conductor/sdk`):

```ts
interface ToolContext {
  /** Read-only snapshot of process.env. */
  readonly env: Readonly<Record<string, string | undefined>>;

  /** Resolved paths the tool may read/write under. */
  readonly workspace: {
    project_dir:     string;   // CONDUCTOR_PROJECT_DIR
    plugin_dir:      string;   // <project_dir>/.conductor/plugins/<id>/
    plugin_data_dir: string;   // <project_dir>/.conductor/data/<id>/  (created lazily)
  };

  /** Node's global fetch, captured here for testability. */
  readonly fetch: typeof globalThis.fetch;

  /** Logger that writes to the Conductor server's stderr (never stdout). */
  readonly logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };

  /** Fires when the calling agent cancels. Pass through to fetch / spawn. */
  readonly signal: AbortSignal;
}
```

**Discovery.** At Conductor boot, for each enabled plugin, for each entry in `provides.tools`:

1. Resolve `entry.file` to an absolute path under the plugin directory (path-escape rejected).
2. Dynamic-import the module: `await import(\`file://${absPath}\`)`. In dev/sample setups, the Conductor server runs under `tsx`, so `.ts` imports resolve directly. In production, the build step compiles `tools/*.ts` to `tools/*.js` and the import resolves to the `.js`.
3. Validate the module's exported shape: `id` is a non-empty string matching the namespaced pattern; `description` is a non-empty string; `parameters` is a zod schema (has `_def`, `parse`, `safeParse`); `default` is a function. On validation failure, log to stderr and skip the tool (other tools in the same plugin still register).
4. Register an MCP tool with `name: <id>`, `description`, and `inputSchema` derived from `parameters`. At call-time, parse `args` through `parameters`, then invoke `execute(parsed, ctx)`.

**Errors.** Errors thrown from `execute` are caught by the host and surfaced as MCP tool errors:

- A thrown `Error` with a `code` property → `{ isError: true, structuredContent: { code, message: err.message } }`.
- Any other thrown value → `{ isError: true, structuredContent: { code: 'TOOL_ERROR', message: <stringified> } }`.

The Conductor server itself never crashes on a tool throw — only on protocol-level failures.

**Cancellation.** `ctx.signal` is an `AbortSignal` that fires when the calling agent cancels (spec §13). Tools doing network calls should pass it to `fetch({ signal: ctx.signal })`; tools spawning subprocesses should pass it to `spawn({ signal: ctx.signal })`. If the tool ignores it, cancellation cannot interrupt the in-flight call — the agent's overall cancel cascade still completes, but the individual tool runs to its natural end.

**Testing.** Hostable tools are pure functions, easy to unit-test:

```ts
import execute, { parameters } from '../tools/get_pr.ts';

const fakeCtx: ToolContext = {
  env: { ADO_ORG: 'test-org', ADO_BEARER_TOKEN: 'fake' },
  workspace: { project_dir: '/tmp', plugin_dir: '/tmp/plugin', plugin_data_dir: '/tmp/data' },
  fetch: async () => new Response(JSON.stringify({ pullRequestId: 42, title: 'Test' })),
  logger: { info() {}, warn() {}, error() {} },
  signal: new AbortController().signal,
};

const args = parameters.parse({ repo: 'r', pr_id: 42 });
const result = await execute(args, fakeCtx);
// assert.equal(result.pullRequest.pullRequestId, 42);
```

No process spawn, no MCP transport, no real ADO call — just function invocation against a stubbed `fetch`.

### 10.4 Discovery

At boot:

1. Scan `<global_dir>/plugins/*/plugin.yaml`. Entries are either real
   directories (built-in copies, git clones with `.git` retained) or
   junctions / symlinks pointing back at user-provided absolute folders.
   `statSync()` follows the link, so discovery walks them uniformly.
   Sibling sidecar files `<id>.install.json` are skipped; dot-prefixed
   entries (`.tmp-install-*` mid-install) are skipped.
2. For each manifest: parse (YAML), validate (§10.8), check
   `requires.conductor_version` against the running build. Reject any
   plugin whose `manifest.id` doesn't equal its directory name (a
   read-time guard against drift in junctioned local plugins).
3. Register every entry in `provides`:
   - `skills[].id` → loadable via `skill.read({ scope: 'plugin:<id>' })`
   - `recipes[].id` → loadable via `recipe.read({ scope: 'plugin:<id>' })`
   - `trigger_types[].id` → added to the global trigger-type registry, keyed by `<type_id>`. Discoverable via `trigger.list_types`; instantiated via `trigger.register`. **Type-id collisions across plugins are a load-time error** — the first plugin (sorted by plugin id) wins, subsequent collisions are recorded on the workspace's `triggerTypeErrors` and surfaced via `plugin.list` and `trigger.list_types` results
   - `tools[].id` → dynamic-imported and registered as an in-process MCP tool on the Conductor server (see §10.3 for the contract)
   - `mcp_servers[].id` → exposed to spawned CLIs via the same `--mcp-config` merge that already includes `.conductor/mcp/*.json`
4. If a plugin's manifest has any error, the plugin is marked `error` (visible via `plugin.list`); other plugins continue to load. The user sees the error in the renderer's plugin panel.

**Visibility:** all installed plugins are visible to **every** workspace on
this user account. There is no per-project opt-in — that's the whole point
of centralizing the store. The off-switch is `plugin.disable({ id })`,
which is also global.

**Live reload:** the drop-folder watcher (§9) also covers each plugin's `plugin.yaml`. On change → re-validate + re-register. The same 500ms debounce applies. Removing a `plugin.yaml` file un-registers the plugin's provides; restoring it re-registers them. Hostable tools that change source on disk are re-imported with a cache-busting URL fragment; ESM module-cache realities mean the in-process JS engine still holds the old module, but new tool calls dispatch through the freshly-imported one.

**Collision rule:** if two installed plugins both `provide` an item with the same id (e.g., both ship a `pr-review` recipe), boot does not pick a winner — both plugins load, but the colliding id resolves in plugin-id sort order. `plugin.list` surfaces a warning so the user can rename or disable one. This is intentionally not a hard error: removing or renaming a recipe in someone else's plugin is friction we don't want to force.

**Legacy project-scope plugins:** earlier versions copied plugins into
`<workspace>/.conductor/plugins/<id>/`. Those directories are silently
ignored under the new model — Conductor emits a one-line boot warning if
the legacy path is non-empty so the user can reinstall via `plugin.install`.

### 10.5 Scope and shadowing

Every recipe/skill/trigger the runtime knows about belongs to exactly one scope:

| Scope | Path | Writable? |
|---|---|---|
| `project` | `<workspace>/.conductor/{recipes,skills,triggers}/` | yes |
| `plugin:<id>` | `<global_dir>/plugins/<id>/{recipes,skills,triggers}/` (real dir OR junction to user's folder) | **no — read-only at runtime** |
| `global` | `<global_dir>/{recipes,skills,triggers}/` | yes |

**Read resolution** on `recipe.read({ id: 'pr-review' })` (and `skill.read`, `trigger.list_types` lookup, etc.):

1. Project? → return it.
2. Plugins (sorted by plugin id, first match wins)? → return it with `scope: 'plugin:<id>'`.
3. Global? → return it.
4. Otherwise → `not_found`.

Example. With the ADO plugin installed and no project overrides:

```
recipe.read({ id: 'pr-review' })
  → { id: 'pr-review', scope: 'plugin:ado', body: <...> }
```

After the user (or the agent on the user's behalf) copies it into project scope:

```
recipe.upsert({ id: 'pr-review', scope: 'project', source: <edited yaml> })
recipe.read({ id: 'pr-review' })
  → { id: 'pr-review', scope: 'project', body: <edited yaml> }     # shadowed
```

The plugin's version is still on disk, untouched — `recipe.read({ id: 'pr-review', scope: 'plugin:ado' })` returns it explicitly. Removing the project copy reverts:

```
recipe.delete({ id: 'pr-review', scope: 'project' })
recipe.read({ id: 'pr-review' })
  → { id: 'pr-review', scope: 'plugin:ado', body: <original yaml> }
```

### 10.6 Installation — git and local folders, never copied for local

`plugin.install({ from, ref? })`:

- `from` accepts:
  - `git+https://github.com/org/conductor-plugin-ado.git`
  - `git+ssh://git@github.com:org/conductor-plugin-ado.git`
  - an absolute local filesystem path (for in-development plugins —
    **junctioned, not copied**; edits in the user's folder are picked up
    live)
- `ref` is optional (branch / tag / sha); defaults to the repo's default branch
- Implementation (git):
  - `git clone <url> <tmp>` (full clone — no `--depth 1` — so `.git` history
    is intact for `plugin.update`)
  - Optional `--branch <ref>`
  - Validate `plugin.yaml` exists at the temp root; parse + validate the
    manifest
  - Atomic publish: `renameSync(<tmp>, <global_dir>/plugins/<manifest.id>/)`
  - Write sidecar `<global_dir>/plugins/<manifest.id>.install.json`
    recording `{ kind: "git", from, ref, installed_at }`
  - Reload the registry
- Implementation (local folder):
  - Validate `plugin.yaml` at the user's path
  - Create a junction (Windows) or symlink (POSIX) at
    `<global_dir>/plugins/<manifest.id>` → user's folder. **Never copy or
    mutate** the user's folder.
  - Best-effort: junction `<user_folder>/node_modules` →
    clawdevbox's `node_modules` so the plugin's hostable tools'
    `import 'zod'` resolves under Node's realpath-based walk-up.
  - Write sidecar `{ kind: "local", from, source_path, installed_at }`
- If `<manifest.id>` collides with an installed plugin, the install is
  aborted (no overwrite) and the temp dir cleaned up. The user must
  `plugin.uninstall` first.
- For `git+ssh`, the user's SSH agent must have access — Conductor inherits
  the user's git config, doesn't manage SSH keys.

`plugin.update({ id })`:

- Reads `<global_dir>/plugins/<id>.install.json` to find the origin. Errors
  clearly if the plugin was placed by hand (no sidecar) — that case is a
  manual refresh by the user.
- For `kind: "local"`: returns `LOCAL_SOURCE_NO_UPDATE` — the junction is
  already live; edits in the user's folder take effect immediately.
- For `kind: "builtin"` / `kind: "manual"`: returns `NOT_GIT_INSTALLED`
  — reinstall to refresh.
- For `kind: "git"`: runs `git fetch --prune origin` then
  `git reset --hard origin/<ref or HEAD>` inside the plugin dir. This is
  reliable across branches, tags, and SHAs because we keep full history.
- Re-validates the manifest; reloads. On validation failure, the working
  tree is left as-is and the user sees the error via `plugin.list`.

`plugin.uninstall({ id })`:

- Removes `<global_dir>/plugins/<id>/`. The uninstall path detects symlinks
  /junctions via `lstatSync` and uses `unlinkSync` to remove the link only
  — the user's local-folder source is never deleted. Real dirs are
  recursive-removed.
- Removes the sidecar `<id>.install.json`.
- Operates on the on-disk entry and sidecar even if the plugin failed to
  load (so a broken local junction can still be uninstalled).
- Any project-scope copies the user made survive — that's the point of
  project scope. `recipe.list({ scope: 'project' })` still lists them; they
  continue to work without the plugin's MCP server, which is the only thing
  the user might notice (the recipes that reference `mcp_servers: [ado]` fail
  at run-time with a clear "ado mcp server not configured" error).

`plugin.enable` / `plugin.disable`:

- Sets a flag in `<global_dir>/state.json` (`plugins.<id>.enabled`).
  Because the plugin store is global, the flag also applies globally — a
  disabled plugin is disabled for every project.
- A disabled plugin's `provides` are unregistered without removing the directory. Re-enable to restore.

### 10.7 Feedback / self-improvement loop

The agent improves a plugin recipe/skill/trigger by copying it to project scope and editing there. The plugin directory is **never** mutated at runtime — that keeps `plugin.update` clean (no merge conflicts with user edits inside the plugin) and makes "revert to the plugin's version" trivial (`*.delete({ scope: 'project' })`).

The full loop:

```
1. user: "the PR review missed checking accessibility — add that"
2. agent: recipe.read({ id: 'pr-review' })
     → returns the plugin-scope copy: { id, scope: 'plugin:ado', source }
3. agent: edits the YAML body to add an accessibility step
4. agent: recipe.upsert({ id: 'pr-review', scope: 'project', source: <new yaml> })
     → project scope now shadows plugin scope
5. next time `recipe.run({ id: 'pr-review' })` fires:
     → the agent's edited version is used; the plugin version is dormant
```

Reverting: `recipe.delete({ id: 'pr-review', scope: 'project' })` removes the project copy and the plugin version reactivates automatically on the next read.

The same pattern works for skills (`skill.upsert({ scope: 'project', … })`) and triggers (the agent copies the trigger file into `.conductor/triggers/` and registers a project-scope entry).

**Renderer surfacing.** Whenever a recipe/skill/trigger has been customized (project shadows plugin), the renderer's "available recipes" panel marks it with a small "customized" badge and exposes a "revert to plugin version" action. The diff between the plugin original and the project copy is fetchable via `recipe.read({ id, scope: 'plugin:<id>' })` and `recipe.read({ id, scope: 'project' })` — the renderer renders the unified diff inline.

### 10.8 Validation

Same shape-only pattern as recipes (§7.4) and triggers (§8). The plugin manifest validator checks:

- Required fields present (`id`, `name`, `version`, `description`)
- `id` matches `[a-z][a-z0-9-]*`
- `version` is a valid semver
- `requires.conductor_version` (if present) is a valid semver range
- Every `file` reference in `provides.*` resolves to an existing file inside the plugin directory (no `..` escapes; paths must be relative)
- Within `provides`, ids are unique across all entries of the same kind (a plugin can't ship two recipes with the same id)
- `provides.tools[].id` matches the namespaced pattern `[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*` (e.g., `ado.get_pr` — a plugin namespace followed by a dotted verb). Tool ids must be unique within the plugin.
- `provides.tools[].file` resolves to a `.ts` (or compiled `.js`) file inside the plugin directory. The runtime additionally validates the module's exported shape (`id` / `description` / `parameters` / default `execute`) at dynamic-import time — manifest validation is path-only, runtime validation is shape.
- `provides.trigger_types[].id` matches the namespaced pattern `[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*` (kebab-case both halves — e.g., `ado.new-pr-watcher`). Trigger type ids must be unique within the plugin.
- `provides.trigger_types[].file` is a relative path inside the plugin directory (no `..` escapes).
- `provides.trigger_types[].default_cron` (when set) is a well-formed 5- or 6-field cron expression.
- `provides.trigger_types[].parameters[].type` is one of `string \| integer \| number \| boolean \| array \| object`. `default` (when set) must match the declared `type`.
- `provides.trigger_types[].identity_param` (when set) references a parameter name declared in this type's `parameters[]`.
- `mcp_servers[].file` is a parseable JSON document in Continue/Cursor shape — but the *server itself* isn't started until a CLI spawn references it (lazy)

Errors return as `{ path, code, message }[]` exactly like the recipe validator. The same validator function powers: boot scan, `plugin.install` pre-move, `plugin.update` post-pull.

### 10.9 Open questions (deferred)

- **Plugin signing / authenticity.** Post-MVP. For v1, the answer is *pin a git ref or sha*. Users who care about supply-chain trust can `plugin.install({ ref: '<sha>' })` rather than tracking a moving branch.
- **Plugin discovery registry.** A "list available plugins" service (akin to npm or vsce). Post-MVP — users find plugins through READMEs, blog posts, and the Conductor docs site. The git-URL install path is enough.
- **Plugin sandbox isolation.** Today plugins are trusted: their trigger scripts run with the same privileges as the user, their MCP servers run as the user. Sandboxing (e.g., per-plugin process boundaries, capability tokens, network egress controls) is post-MVP. Users vet plugins by reading their source — a plugin is a git repo.
- **Per-plugin MCP secrets.** Plugins that need API keys today inherit user-set env vars (e.g., `ADO_BEARER_TOKEN`). A future per-plugin keychain (`plugin.set_secret({ id, key, value })`) is post-MVP.

## 11. The Renderer

Tauri shell + Vite-built vanilla TS SPA. Same as TaskDock today; copy-fork the build pipeline.

Three primary surfaces (all shown in mockups):

1. **Inbox list.** Virtualized list of `inbox_items` with kind chips, agent-message prose, awaiting-input pulse, snooze/star/mute. Mockup 00 + 01 + 02 + 03 + 04 left rail.

2. **Thread viewer.** Right pane. Renders the active inbox item's threads as a recursive tree (mockup 04), with per-stage timeline (mockup 02), inline walkthroughs with comments (mockup 02), askUser modals (mockup 03/04), and the "what changed since you last looked" panel.

3. **Side terminal.** Bottom or right (user-toggleable), running `claude --resume <thread-id>` (or `copilot`). xterm.js. Single-tab in slice 1; multi-tab post-slice-15. The CLI's stdin/stdout flow through Tauri's shell command API.

State management: a `ViewRenderer` registry keyed on inbox-item kind. The PR-review renderer knows how to show the diff-viewer comments; the incident renderer knows how to show the multi-source correlation banner; the epic renderer knows how to show the recursive tree. Each renderer is a self-contained module reading from `inbox_items` + `messages` + `approvals` via WS subscriptions.

Diff viewer is copy-forked verbatim from TaskDock with all its perf tunings preserved.

## 12. The Side Terminal — Claude Code As The Agent

This is the load-bearing inversion.

**What runs in the terminal:** the user's installed `claude` (or `copilot`) CLI. Conductor does NOT bundle it; users `npm i -g @anthropic-ai/claude-code` (or equivalent) themselves. We only require that the CLI can take `--mcp-config <path>` and `--resume <session-id>`.

**How it gets configured:** at boot, the sidecar writes `.conductor/mcp.json` containing:

```json
{
  "mcpServers": {
    "conductor": {
      "type": "streamable-http",
      "uri": "http://localhost:5201/mcp",
      "headers": {
        "Authorization": "Bearer <per-launch-secret>"
      }
    }
  }
}
```

Plus any extension entries from `.conductor/mcp/*.json` merged in. The renderer spawns the CLI as `claude --mcp-config .conductor/mcp.json --resume <thread-id>`. That's it.

**How the CLI knows what to do:** Conductor synthesizes a system prompt at spawn time describing (a) the recipe the thread is using (`name` + `description` + `steps[]`), (b) the available MCP servers and tools, and (c) the discipline of calling `thread.append_message` after every meaningful step. The trigger's `prompt` (or `recipe.run`'s `prompt`) is the first user message. Every MCP tool from every configured `mcp_servers` extension is visible — no per-recipe filtering in MVP. The CLI then runs its own loop until done.

**How Conductor sees what happens:** every meaningful CLI action is mediated by an MCP tool call. `thread.append_message` is the canonical one — the bootstrap system prompt instructs the agent to call it on each step. Tool calls Conductor cares about (`approval.request`, `artifact.write`, `view.emit`) write directly to the DB. The renderer tails `messages` for the thread and renders.

**What if the user types in the terminal directly?** The CLI's user input lane is preserved — the renderer just doesn't intercept it. Anything the user types goes through the CLI's normal user-turn path. If the user wants to inject something into a background thread, they call `thread.append_message` via the CLI just like the agent does.

## 13. Security Model

| Vector | Mitigation | Source |
|---|---|---|
| Random local process pokes the MCP server | Per-launch 32-byte hex secret in `Authorization` header, validated middleware | Goose copy-fork (`agent.rs:49-50`) |
| Malicious extension accesses unrelated env | `Envs::DISALLOWED_KEYS` blocklist (31 vars) on every spawned MCP child | Goose copy-fork (`extension.rs:71-86`) |
| Malicious extension via `cmd:` | `extension_malware_check.rs` static scan before spawn (slash-commands + obvious shell injection) | Goose copy-fork |
| PII leak to LLM | Bidirectional scrub layer: structural GUIDs vs data GUIDs; `protectGuids`/`restoreGuids` round-trip | TaskDock copy-fork (`mcp-server.ts`, `scrub-layer.ts`) |
| Recipe with secret embedded | Recipes never carry secrets. MCP server configs in `.conductor/mcp/*.json` reference env-var names (`env_keys: [...]`); sidecar resolves from OS keychain at extension spawn time | TaskDock auth-manager copy-fork |
| External CLI runs unbounded | Per-thread cancel + per-CLI permission prompts (Claude Code `Ask First`); per-recipe tool allowlist deferred post-MVP (§2 non-goals) | CLI permission prompts |
| Approval forgery | Approvals carry a renderer-minted nonce; only renderer can resolve via WS; MCP `approval.resolve` requires the nonce | New |
| Trigger script flood / runaway | Per-trigger 10 min timeout (configurable); cron daemon serializes ticks per trigger so a slow script can't pile up; failing scripts log to `last_run_error` and continue (next tick reuses last good `state`) | New |

## 14. Mockup → Primitive Mapping

Validating that the simpler model preserves the locked UX. Each row: an element from the mockups + the primitive(s) that back it.

| Mockup element | Backed by |
|---|---|
| Inbox left rail (mockup 00, all) | `inbox_items` rows; per-kind renderer for chip + prose card |
| Awaiting-input pulse (mockup 01, 03) | `inbox_items.state = 'awaiting_input'` (set when `approvals.state = 'pending'`) |
| Agent prose card body | `inbox_items.agent_message` (updated by agent via `inbox.upsert`) |
| `Open PR / Snooze 1d / Stop watching` action buttons (mockup 01) | actions live in `agent_message` JSON the agent writes; renderer maps each to an MCP call |
| 3-pane click-through diff/timeline/xterm (mockup 01) | view_emitted messages + thread messages stream + side terminal |
| Inline review comments with "resolved iter-2" (mockup 01) | `view_emitted` messages with `payload.kind='walkthrough_comment'` |
| Run timeline with per-step `+0.31s` (mockup 01, 02) | `messages` rows with `type='step_start' / 'step_end'`; render diffs |
| `142k / 200k` token gauge (mockup 01) | the CLI emits this via `thread.append_message({type:'agent_meta'})` if it tracks it; otherwise omit (we don't account ourselves) |
| Three phase cards (mockup 02) | each phase = a thread (or a section in the timeline of one thread); rendered from `messages` grouped by `step_start` / `step_end` markers the agent emits |
| Step-counter `step 4 / 7` (mockup 02 — replaces fake progress bars) | derived from the recipe's `steps[]` length and the agent's progress reported via `thread.append_message` |
| `attempt 2 / 5` (mockup 02) | inbox-item-level counter; renderer counts threads on the same inbox item with same `recipe_id`; not a runtime retry primitive |
| Walkthrough doc body with pin/thread markers (mockup 02) | `view_emitted` walkthrough view + `walkthrough_comment` messages |
| Slack reply → `injectUserTurn` flow with attribution (mockup 02) | a Slack-poll trigger script (cron) checks for replies in watched channels; on hit, calls `thread.append_message({ attribution: 'user:slack:@…' })` then `thread.wake`; the suspended CLI sees the message on next turn |
| `28d 22h remaining` countdown (mockup 02) | the suspended thread holds the timestamp it began waiting; the agent's prompt told it the timeout window; renderer computes remainder. (No engine-level `wait_for.timeout` — the agent decides when to give up and exit.) |
| P0 incident dominating + everything else dim (mockup 03) | `inbox_items.priority` sorting; renderer dim strategy |
| Correlation banner with `confidence 0.91` (mockup 03) | agent emits a `view_emitted` message with `payload.confidence` per its own logic; renderer surfaces it |
| askUser block with options + free-text (mockup 03) | `approvals` row with `options[]` and `allow_freetext=1` |
| Per-option `description` + `recommended` + `confidence` (mockup 03 — REVIEW R20 gap-filler) | extended `approvals.options[]` shape |
| Subagent A/B/C/D evidence cards (mockup 03) | the parent agent calls `thread.spawn(parent_thread_id=...)` itself for each subagent investigation; aggregated summaries appear as `view_emitted` messages on the parent |
| MDM SVG sparkline rendered by `mdm-charts/v1` (mockup 03) | `view_emitted` with `payload.renderer='mdm-charts/v1'`; renderer registry resolves |
| DGrep error-log table (mockup 03) | DGrep MCP server returns rows; agent calls `view.emit` to render |
| Investigation report markdown (mockup 03) | `artifacts` row of kind `postmortem-md` |
| Slack delivery receipt `#r_8FJK` (mockup 03) | the agent calls `thread.append_message({ type: 'delivery_receipt', payload: { receipt_id, channel } })` after Slack delivery; renderer shows it |
| Email rendering with numbered options (mockup 03) | the InboxChannel MCP renders email via `view_emitted` |
| Recursive tree Epic→Run→children (mockup 04) | `threads.parent_thread_id` recursive query |
| `concurrency cap (3 active)` queued indicator (mockup 04) | the parent agent self-paces by calling `thread.spawn` only N at a time and awaiting completion; renderer counts in-state-running children. Global `MAX_LIVE_SESSIONS` setting clamps the total |
| `wave 2 / wave 3` tags (mockup 04) | child threads tagged via `messages.attribution='dag:wave-2'` |
| Multi-segment progress bar (mockup 04) | aggregate state counts over child threads |
| `What changed since you last looked` panel (mockup 04) | `inbox_items.last_event_id` vs current max event id; pure DB query |
| `stuck-pr-nudge` auto-policy event (mockup 04) | a bundled trigger entry `{ source: cron, signal_kind: cron.tick, filter: { "$.cron_id": "every-30m" }, recipe: stuck-pr-scanner }` that runs a small recipe scanning for inbox items in `monitor` state idle > 7 days |
| Side terminal with user-takeover (mockup 03 footer) | the CLI is always live; user can take over by typing |

Every mockup element traces to the six tables + the recipe/trigger schemas. **No primitive in the prior 2,200-line spec is needed beyond what's listed here.**

## 15. Slice Plan

Slices are sequential. Each is a few sessions of agent-driven work.

| Slice | Scope | Done when |
|---|---|---|
| **S1 — Substrate** | DB migrations runner, six-table schema, `better-sqlite3` wrapper, `schema_version` & `settings_kv`, smoke tests | `npm run typecheck` + `npm test` green; CRUD on every table |
| **S2 — MCP server** | Streamable HTTP MCP at `:5201/mcp`, per-launch secret, all §6.1 tools, `notifications/resources/updated`, integration tests via `@modelcontextprotocol/sdk` client | a test agent can read inbox, append messages, request approval round-trip |
| **S3 — WS facade** | TaskDock-style WS bridge (copy-fork backpressure, types from zod), renderer can subscribe to inbox + thread updates | renderer shows live updates as MCP writes happen |
| **S4 — Recipe + trigger loader** | YAML/JSON parse, shape validator (one function), drop-folder watcher (recipes dir), single-file watcher (triggers.json), snapshot-on-spawn for recipes | recipes and triggers load, hot-reload, malformed shows clear errors via MCP write tools |
| **S5 — Scheduler** | 1Hz tick, signal matching, thread spawn, CLI exec, cancel-cascade, retry loop | a manual signal triggers a `claude` subprocess that round-trips through MCP |
| **S6 — ADO source** | service-hook receiver + watcher fallback, `pr.*` and `workitem.*` signals, dedup_key | a real ADO PR push triggers a recipe via a matching trigger entry |
| **S7 — Renderer inbox + thread viewer** | virtualized list, kind renderers (PR + WI), thread tree, timeline, awaiting-input pulse | mockup 00/01/02 visuals reproduce off real data |
| **S8 — Side terminal** | xterm.js panel, Tauri shell-command spawn of `claude --resume`, .conductor/mcp.json generation | typing in side terminal works; `claude` calls Conductor MCP |
| **S9 — Approvals UI** | askUser modal, options + freetext, default_view rendering | mockup 03 askUser flows end-to-end |
| **S10 — Walkthroughs + view renderers** | view_emitted message stream, diff-viewer copy-fork, walkthrough comments | mockup 01 + 02 walkthrough panels work |
| **S11 — Recursive thread tree (parent/child)** | `thread.spawn(parent_thread_id=...)` semantics, recursive query, `MAX_LIVE_SESSIONS` cap, recursive renderer | mockup 04 epic decomposition reproduces with the agent driving fan-out in its own loop |
| **S12 — Incident + ICM source** | ICM receiver, multi-source correlation recipe, sparkline view | mockup 03 reproduces |
| **S13 — Security pass** | Envs::DISALLOWED_KEYS, malware check, PII scrub layer wired into MCP boundary | red-team scenarios pass |
| **S14 — Hooks + skills + memory** | `.conductor/hooks.json`, skills loader, FTS5 over messages | search returns hits, hooks fire on events |
| **S15 — Cutover** | Feature parity acceptance against legacy MissionControl; flip default; prepare extraction | legacy tree archived; conductor/ ready to `git mv` |

Post-slice-15: GitHub source, multi-tab terminal, semantic search, plugin marketplace exploration.

## 16. Testing Strategy

The testability story is the main reason this design exists. Every primitive is testable from a SQL fixture without a running CLI.

| Layer | Test type | What's faked |
|---|---|---|
| Schema | Vitest + an in-memory SQLite | nothing |
| MCP tools | Vitest + the official MCP SDK test client + an in-memory SQLite | nothing |
| Scheduler | Vitest + fake clock + signal fixtures + spawn mock | the CLI subprocess (asserted on argv + env, not actually run) |
| Recipe + trigger loader/validator | Vitest with a corpus of valid and malformed YAML/JSON | nothing |
| Sources | Vitest + fixture HTTP receivers | external system |
| Renderer | Playwright (already in repo) + a seeded DB | the CLI subprocess; the WS facade is real |
| End-to-end flow | Playwright + a real `claude` invocation against the test MCP server | nothing — full real loop on a fixture recipe + trigger |

Every bug class from the prior spec's 22 root issues becomes a unit test:
- `R1` (main-agent tool catalog) → MCP-tool surface tests
- `R4` (cancellation) → `thread.cancel` + cascade tests
- `R5` (multi-event waits) → state-machine `wait_for` re-arm tests
- `R10` (dedup_by) → signal-uniqueness tests
- `R11` (stdin race) → no longer applicable (we don't drive the CLI's stdin)

## 17. Migration from Legacy TaskDock

Conductor lives at `conductor/` and never imports across the boundary (per `conductor/CLAUDE.md`). Legacy TaskDock at the repo root keeps running unchanged through slice 14. At slice 15:

1. Acceptance suite verifies feature parity for the four scenarios.
2. Default app launch flips to Conductor.
3. Legacy `MissionControlService` tree is removed.
4. `git mv conductor/ ../conductor-repo/` extracts to its own repo.

Copy-fork list (per the legacy-taskdock-audit): HTTP MCP server pattern, unified TerminalService, `ado-api.ts`, auth-manager, diff-viewer, walkthrough JSON schema, AssignmentWatcher poll/dedup, plugin-loader/scheduler primitives, migrations runner, scrub layer.

Don't bring: 27x dual-construction pattern, parallel AI adapter trees, MissionControlService god-object, MCP-curated subset of RPC, AutoProcessService, plugin file-IPC dance, 1,984-line bridge.ts.

## 18. Open Questions

These do not block writing the implementation plan but should be settled before they're load-bearing.

1. **Renderer state container.** ViewRenderer registry is the right shape, but where does subscribed state live? Per-component WS subscriptions, or a single store? Lean: per-renderer subscription, since the inbox + thread are the only two truly cross-renderer state items. Confirm in S7.
2. **MCP tool namespacing collision with extensions.** A user installs an extension whose tools are named `inbox.list`. Resolve by prefixing Conductor's own tools with `conductor.` in the published MCP catalog (`conductor.inbox.list`); the per-server tool prefix is something Claude Code already does. Decide before S2.
3. **Approval timeouts.** What happens to a `pending` approval after 14 days? Auto-cancel? Auto-default? Lean: agent-passed `timeout_ms` on `approval.request`; absence means no timeout. Decide before S9.
4. **Signal dedup window.** A signal with the same `dedup_key` arriving 5 days later — is that a duplicate or a fresh occurrence? Lean: dedup is per-thread, not global. Concretely, the scheduler dedups against `signals.dedup_key` only when `consumed_by_thread_id` is in `('running','suspended')`. Decide before S5.
5. **`view_emitted` payload schema.** Each view kind needs a typed payload. Hardcode the slice-1 set (`walkthrough_comment`, `mdm_chart`, `dgrep_table`, `email_render`) or expose a registry? Lean: registry indexed by `payload.renderer` string with version. Decide before S10.
6. **Multi-CLI session correlation.** If a user has both `claude` AND `copilot` running for the same thread, do they share `cli_session_id`? No — one provider per thread per active session, switching providers ends the prior session. Confirm before S5.
7. **Exact CLI flags.** This design assumes `claude` accepts `--mcp-config <path>` and `--resume <session-id>` (and `copilot` has equivalents). Flag names must be verified against the installed CLI versions before S5/S8. Fallback if a flag name differs: shim via env vars or a wrapper script. Decide before S8.
8. **Provider resolution.** The recipe's `default_client` (or the trigger's override) is a string the scheduler maps to a CLI binary path. If a user has `claude` and `copilot` on PATH but the recipe says `default_client: cursor`, what happens? Lean: hard fail with a clear "client not configured" error in `settings_kv`. Decide before S5.

---

## Appendix A — Why this is simpler than the prior spec

| Concept | Prior spec | This design |
|---|---|---|
| State | 8 entity types + projections + event store | 6 tables, all flat |
| Workflow | Plugin engine + ToolHost + AutoPolicies + walkthroughs + workflow runtime | Recipe YAML + triggers.json + scheduler + MCP tool calls |
| Agent loop | Session Manager + agent runtime + invokeTurn + injectUserTurn + completion markers | External CLI; Conductor doesn't run a loop |
| Cancellation | `AbortSignal` propagation through nested workflows + walkthrough lifecycle | `thread.cancel(recursive: true)` + scheduler observes |
| Hot-reload | Plugin reload + AutoPolicy reload + workflow reload + walkthrough reload | One file watcher per drop-folder; recipe snapshot pinning at thread spawn |
| Built-ins | `set_agent_message`, `set_default_view`, `ask_user`, `wait_user_approval`, `wait_walkthrough_review`, `monitor-pr`, `memory_write`, `foreach`, `dag_plan`, `parallel_runs`, `retry_loop`, `spawn_run`, `agent/multi-source-context`, `agent/correlate` | MCP tools (`thread.append_message`, `approval.request`, `view.emit`, `artifact.write`, `signal.emit`, `thread.spawn`); the agent's reasoning replaces state machines, fan-out, and retry loops |
| Subagent partition | Header-based session-id MCP filter + per-Task toolset enforcement | Child threads spawn via `thread.spawn(parent_thread_id=...)` with their own MCP config (different extensions); within a thread, all tools visible — CLI permission prompts gate (post-MVP: per-recipe allowlist) |
| Memory | Lexical FTS5 + optional embeddings + `MemoryEntry` body shape | FTS5 over `messages`; future embeddings as a separate column |
| Walkthrough lifecycle | Mint walkthroughId + stream namespace + capability grammar + range query | `view_emitted` messages + walkthrough renderer consumes them |
| Subscriptions table | Durable across restart, replay missed signals | `signals` table itself; suspended threads re-arm by re-querying |
| Lines of spec | 2,200 (with 22 root issues open) | ~600 (this doc) |

Every concept above is either subsumed or made unnecessary. The prior spec's 22 root issues either become unit tests on this design or vanish:

| Prior root issue | Status here |
|---|---|
| R1 `WorkspaceMainContext` undefined | All tools listed in §6.1; no implicit context |
| R2 Kernel built-ins undocumented | Built-ins are MCP tools; documented in §6.1 |
| R3 Task toolset partitioning | Deferred from MVP — per-child-thread MCP config gives coarse partition; CLI permission prompts gate. Per-recipe allowlist is additive and lands post-cutover (§2 non-goals) |
| R4 Cancellation | `thread.cancel(recursive)` + scheduler observation |
| R5 Multi-event waits | The agent itself blocks on subsequent signals via long-suspend on stdin or by exiting and being re-spawned by a fresh trigger match. Engine doesn't model multi-event waits — the dedup_key absorption (§7.6) gives "more events join the same thread" semantics |
| R6 Trigger schema | §7.2.1 |
| R7 Run-shared resume | CLI handles its own session resume; Conductor passes `--resume <thread-id>` |
| R8 walkthroughId lifecycle | view_emitted messages; renderer registry |
| R9 Subscriptions durability | `signals` table is the durable substrate |
| R10 dedup_by | §5.4 + §7.2.1 |
| R11 stdin race | Not applicable — we don't drive the CLI's stdin |
| R12 Memory body shape | `messages.payload` JSON |
| R13 Concurrent inbound | First matching message wins; FK constraint |
| R14 Engagement vs AutoPolicy order | AutoPolicies replaced by triggers; one match path |
| R15 State machines | §5.1 inbox state, §5.2 thread state, §5.5 approval state — explicit transitions |
| R16 perItemBudget | Out of scope; CLI handles |
| R17 Hot-reload AutoPolicies | Recipes drop-folder watcher + triggers.json single-file watcher |
| R18 SM session cap | Global `MAX_LIVE_SESSIONS` setting; agent self-paces fan-out via its own logic; renderer counts active children for the `concurrency cap (3 active)` indicator |
| R19/R20/R21/R22 Mockup + low-severity | All addressed in §14 mapping or simply not present |

---

**End of design.**

Reviewers: please flag any UX element from the mockups that isn't captured in §14, any primitive in this design that feels redundant, any open question in §18 that should be settled before slice 1 starts.
