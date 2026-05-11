# Goose vs. Legacy TaskDock vs. Proposed Conductor — Side-by-Side Architecture Comparison

**Date:** 2026-05-08 (clone snapshot pulled 2026-05-09)
**Author:** Research agent (Conductor planning)
**Goose source:** `aaif-goose/goose` `main`, cloned to `.planning/research/goose-clone/`
**TaskDock source:** repo root `src/`, `src-backend/`, `src-tauri/`
**Conductor source:** `conductor/` subtree (Phase 0 scaffold; design surfaced in `docs/superpowers/specs/2026-05-01-mc-rewrite-infrastructure-design.md` + the brainstorming-derived simpler shape captured below)

> Scope: structural comparison across the eleven architecture layers from §2 of the brief. Builds on the prior Goose recipe deep-dive (`goose-deep-dive-2026-05-08.md`) and the legacy-TaskDock audit (`legacy-taskdock-audit-2026-05-08.md`); does not re-derive content already covered there — those files are referenced inline.

---

## 1. Two-paragraph orientation

**Goose** is a Rust-first agent framework with an Electron+React desktop wrapper. The desktop spawns a `goosed` HTTP+SSE Axum server as a sidecar, talks to it over a runtime-chosen localhost port with a per-process secret in the `Authorization` header, and consumes a strongly-typed TS client codegen'd from `utoipa`-derived OpenAPI. All durable state lives in one SQLite at `Paths::data_dir()/sessions.db` (sessions, messages, threads — schema v12) plus loose JSON for scheduled jobs. The agent is one big stateful object (`crates/goose/src/agents/agent.rs`, 2,562 LOC) holding the conversation, MCP extension manager, permission router, and provider trait. Recipes are YAML drop-folder bundles that configure one agent session — they cover the prompt, parameters, extension set, and a structured-output JSON schema, but not multi-stage orchestration. Cron is the only first-class trigger.

**Legacy TaskDock** is a Tauri+vanilla-TS desktop with a Node.js sidecar over WebSocket on port 5200, a hand-typed RPC contract spread across `src-backend/rpc-handlers/canon/<namespace>/*.ts`, and twenty-seven services using the same triple-construction pattern. SQLite holds tasks; per-source polling (`AssignmentWatcherService`), an in-process queue (`MissionControlService`), an unrelated `AutoProcessService`, and a child-process plugin runner orbit it. Mission Control today is "tasks list + triage filter," not a real inbox. **Proposed Conductor** (the simpler shape that emerged in brainstorming) collapses this to: one SQLite at `~/.conductor.db` with `inbox_items / threads / messages / signals / approvals / artifacts`; Conductor exposes itself as an MCP server that any external CLI (Claude Code, Cursor, Continue) can drive; a tiny scheduler watches `signals` and matches `triggers:` on Goose-style YAML scenarios in `.conductor/scenarios/*.yaml`; Tauri UI is a thin viewer that embeds `claude --resume <thread-id>` in a side terminal. The orchestrator's role shrinks to "match signals to scenarios, append messages, and let the external agent do the work."

---

## 2. Layer-by-layer comparison

### A. Process topology

**Goose.**
- One Electron main process spawns `goosed` (a Rust binary) as a child sidecar at app boot. Electron picks a free port (`ui/desktop/src/goosed.ts:25 findAvailablePort()`, lines 25-36), passes it as a CLI arg, generates a 32-byte hex `GOOSE_SERVER__SECRET_KEY`, and waits for `/status` to come up (30s, 100ms intervals: `goosed.ts:94-96`). The renderer never spawns its own children — every tool subprocess runs under the sidecar.
- The sidecar serves Axum on a localhost-only `Settings::socket_addr()` (`crates/goose-server/src/commands/agent.rs:74`). TLS optional (line 86); in dev, plain HTTP. Graceful shutdown on SIGINT/SIGTERM (lines 16-31).
- MCP extensions are spawned **as separate child processes** by the sidecar's `ExtensionManager` (`crates/goose/src/agents/extension_manager.rs`). Each `stdio` extension is a `tokio::process::Command` with stdin/stdout for JSON-RPC.
- CLI mode (`goose run`, `goose session`) imports the same `goose` crate in-process — no sidecar (`crates/goose-cli/src/main.rs`, ~20 LOC, defers to `goose_cli::cli::cli()`).
- A second mode: `goose-cli` can also act as an **ACP server** over stdio (`Acp` subcommand, `cli.rs:762-774`) or **HTTP+WebSocket** (`Serve` subcommand, lines 776-794, default port 3284) — i.e., other agents can use Goose itself as a backend.

**Legacy TaskDock.**
- Tauri shell (Rust) spawns a Node.js sidecar (`src-backend/bridge.ts`, 1,984 LOC) over WebSocket port 5200. Single sidecar, in-process service registry, all tools (terminals, MCP, AI sessions) run inside the sidecar.
- Renderer is a Vite-built SPA loaded by Tauri WebView; communicates only with the sidecar over WS (no direct Tauri-Rust → renderer IPC for app logic).
- Plugins spawn `npx tsx` child processes via `plugin-script-runner.ts`; each child writes `__PLUGIN_MSG__:`-prefixed JSON to stdout for IPC.

**Proposed Conductor.**
- Same Tauri+Node sidecar shape (no need to switch — see §6.3 of the recipe deep-dive). One SQLite db, one Express/HTTP MCP endpoint, one WS port for the renderer's typed RPC.
- The sidecar additionally **exposes itself as an MCP server** so external CLIs (`claude --resume <thread-id> --mcp http://localhost:5201/mcp`) can call `inbox.list`, `thread.append_message`, `signal.emit`, `approval.request`. This is Goose's `mcp_app_proxy` idea but inverted — Goose exposes its session to *its own* desktop; Conductor exposes its inbox to *any* MCP-capable CLI.
- The renderer side terminal embeds a real `claude --resume <thread-id>` (or Copilot equivalent) — it's the same external CLI, run inside an xterm.js, configured with Conductor's MCP endpoint. **No bespoke "agent loop" inside Conductor.** The agent loop lives in Claude Code; Conductor is the substrate.

| Concern | Goose | Legacy TaskDock | Proposed Conductor |
|---|---|---|---|
| Sidecar lang | Rust (`goosed`) | Node.js (`bridge.ts`) | Node.js (sidecar pattern preserved) |
| Sidecar transport | HTTP + SSE | WebSocket | WebSocket (renderer) + HTTP (MCP) |
| Port discovery | `findAvailablePort()` per launch | Fixed `5200` | Fixed `5201` (`CONDUCTOR_SIDECAR_PORT`, `package.json:13`) |
| Auth on sidecar | 32-byte hex secret in header (`agent.rs:49-50`) | None (localhost only) | TBD; localhost-only is the floor |
| MCP child-procs | Yes, sidecar-managed | Yes, plugin-runner manages | Yes, but on top of `claude/cursor/continue` MCP config files |
| Where the agent loop lives | Sidecar (`agent.rs:1049 reply()`) | Sidecar (Claude/Copilot SDK calls inside services) | **External CLI** — Conductor is *not* the loop |
| Run-headless mode | `goose run --recipe` (no sidecar, in-process) | None | `claude --resume <thread-id>` from any terminal |

### B. IPC contract

**Goose.** Three orthogonal contracts:

1. **HTTP REST** — every non-streaming RPC is plain JSON over Axum routes. The full route inventory (counted across `crates/goose-server/src/routes/*.rs`):

| Domain | Routes | Source |
|---|---|---|
| Status / diag | `/status`, `/system_info`, `/diagnostics` | `status.rs` |
| Config | `/config/{validate,upsert,remove,read,read_all}`, `/config/extensions`, `/config/permissions`, `/config/providers`, `/config/providers/{models,custom,catalog,catalog/template,oauth,check}`, `/config/slash_commands` | `config_management.rs` (889 LOC) |
| Agent | `/agent/{start,resume,restart,stop,update_working_dir,update_provider,update_session,update_from_session,tools,call_tool,read_resource,list_apps,export_app/{name},import_app,add_extension,remove_extension,set_container}` | `agent.rs:1322` |
| Recipe | `/recipes/{create,encode,decode,scan,list,delete,schedule,slash-command,save,parse,to-yaml}` | `recipe.rs:572` |
| Schedule | `/schedule/{create,list,delete/{id},{id},{id}/{run_now,pause,unpause,kill,inspect,sessions}}` | `schedule.rs:545` |
| Session | `/sessions`, `/sessions/{search,insights,{id},{id}/{export,name,user_recipe_values,fork,extensions}}` | `session.rs:501` |
| Reply (streaming) | `POST /reply` SSE, `POST /confirm` for tool gate | `reply.rs`, `action_required.rs` |
| Session-events | `/session_events/{events,reply,cancel}` | `session_events.rs` |
| MCP proxies | `/mcp/app/*`, `/mcp/ui/*` | `mcp_app_proxy.rs:284`, `mcp_ui_proxy.rs:53` |
| Tunnel / gateway | `/tunnel/{start,stop,status}`, `/gateway/*` | `tunnel.rs`, `gateway.rs` |
| Setup wizards | `/setup/{openrouter,tetrate,nanogpt}` | `setup.rs` |
| Telemetry / dictation / features | `/telemetry/event`, `/dictation/{transcribe,config,list_models,download/...}`, `/features` | `telemetry.rs`, `dictation.rs`, `features.rs` |

   — wired in `routes/mod.rs:31-57` (`configure(state, secret)`).

2. **SSE** — `POST /reply` returns `text/event-stream`. Events are `MessageEvent` enum variants serialised as JSON. The exhaustive event list is in `reply.rs` and OpenAPI §`MessageEvent`: `Message`, `Error`, `Finish`, `Notification`, `UpdateConversation`, `ActiveRequests`, `Ping` (heartbeat). Pings keep proxies/load-balancers from killing the connection.

3. **OpenAPI codegen** — `crates/goose-server/src/openapi.rs` declares `ApiDoc` with 100+ paths and 100+ schemas (lines 383-661). `just generate-openapi` runs `cargo run --bin generate_schema` to emit `ui/desktop/openapi.json`; the desktop's `pnpm run generate-api` runs `@hey-api/openapi-ts` (`ui/desktop/openapi-ts.config.ts`) to produce `ui/desktop/src/api/types.gen.ts`. **The desktop never hand-writes RPC types** — the `pnpm test-e2e` and `lint:check` scripts both run `generate-api` first (`ui/desktop/package.json:23-30`).

**Legacy TaskDock.** Single contract: WebSocket on port 5200 with hand-rolled JSON-RPC envelopes. RPC handlers live under `src-backend/rpc-handlers/canon/<namespace>/` (30 namespaces — `legacy-taskdock-audit-2026-05-08.md` §4). Shared types are hand-typed in `src/shared/*-types.ts` and drift between renderer and backend (audit §4 + §"Synthesis"). Backpressure handling exists (`bridge.ts:286-317`, `DROPPABLE_EVENTS` set + 4 MB cutoff) — better than Goose's untyped SSE there.

**Proposed Conductor.** Two contracts:

1. **WebSocket RPC** for the renderer (preserves the legacy TaskDock pattern; backpressure code is copy-fork-safe).
2. **HTTP MCP** at `/mcp` for external CLIs and any other MCP client. This is the inversion — instead of legacy TaskDock's "MCP wraps ~40 of the WS methods" (`mcp-router.ts`, 1,407 LOC, a hand-curated `METHOD_NAMES` list at lines 129-143), Conductor defines tools **once** in the MCP server and lets the renderer use either MCP or a thin WS facade. Drop-folder MCP config under `.conductor/mcp/*.json` (Continue/Cursor compatible, see `agent-cli-architectures-2026-05-08.md` Continue.dev entry).

| Concern | Goose (HTTP+SSE+OpenAPI) | Legacy TaskDock (WS+hand-typed) | Proposed Conductor |
|---|---|---|---|
| Stream protocol | SSE over `POST /reply` | WS event names (`event:` field) | WS for renderer; MCP `notifications/*` for external |
| RPC type source | `utoipa` derives → `openapi.json` → `types.gen.ts` | `src/shared/*-types.ts` (hand) | TBD (zod schemas → JSON Schema → both renderer + MCP tool I/O) |
| Auth | per-process secret in `Authorization` header | none (localhost-bound) | localhost-only (and per-source-id session id for MCP, mirroring the §7.5 pattern) |
| Backpressure | none documented | `DROPPABLE_EVENTS` + 4 MB threshold (`bridge.ts:286`) | preserve TaskDock's pattern |
| Heartbeat | `Ping` SSE every 500 ms | none | adopt Goose's `Ping` for MCP `notifications/keepalive` |
| Self-registers as MCP | only `mcp_app_proxy`/`ui_proxy` for *its own UI* | only ~40 of hundreds of methods | **Yes — first-class.** Inbox/threads/signals/approvals all exposed as MCP tools |

### C. Data persistence

**Goose.** A single SQLite via `sqlx` at `Paths::data_dir()/sessions.db`. Schema is v12 (`crates/goose/src/session/session_manager.rs:22 CURRENT_SCHEMA_VERSION`). Tables (lines 633-714):

| Table | Columns (key ones) | Notes |
|---|---|---|
| `schema_version` | `version`, `applied_at` | one row per applied migration |
| `sessions` | `id` PK, `name`, `description`, `working_dir`, `session_type`, `extension_data` (JSON), 6 token counters, `schedule_id`, `recipe_json`, `user_recipe_values_json`, `provider_name`, `model_config_json`, `goose_mode`, `archived_at`, `project_id` | denormalised; `extension_data` is opaque JSON blob |
| `messages` | `id` AUTOINC, `message_id`, `session_id` FK, `role`, `content_json`, `created_timestamp`, `tokens`, `metadata_json` | append-only conversation log |
| `threads` | (added at v9 migration, lines 1026-1031) | thread = grouping of sessions |
| `thread_messages` | (lines 1040-...) | per-thread overlay |
| `idx_messages_{session,timestamp,message_id}`, `idx_sessions_{updated,type}` | | basic perf indices |

`SessionType` enum (`session_manager.rs:41-50`): `User`, `Scheduled`, `SubAgent`, `Hidden`, `Terminal`, `Gateway`, `Acp` — much richer than TaskDock's lone `task` notion. Migrations are `ALTER TABLE` adds plus one rare `DROP COLUMN` (line 1099) — additive-only is the policy.

Loose JSON files for non-row data: `~/.config/goose/config.yaml` (provider keys, user prefs), `Paths::data_dir()/schedule.json` (cron jobs — `scheduler.rs:32-36`), `Paths::data_dir()/scheduled_recipes/*.yaml` (per-job recipe snapshots, `scheduler.rs:38-43`).

Path discovery via `etcetera::choose_app_strategy(top_level_domain="Block", author="Block", app_name="goose")` (`paths.rs:20-25`) — gives `~/Library/Application Support/Block/goose/` on macOS, `~/.config/goose/` on Linux, `%APPDATA%\Block\goose\` on Windows. Comment notes "Block" is preserved for backcompat (line 17-19).

**Legacy TaskDock.** Sprawling. From the audit (§"Synthesis", item 7):
- `~/.taskdock/mission-control/tasks.db` (SQLite)
- `~/.taskdock/settings.json`
- `~/.taskdock/plugin-config.json`
- `~/.taskdock/processed-assignments.json`
- `~/.taskdock/auto-process-rules.json`
- `~/.taskdock/plugins/<name>/manifest.json`
- workspace YAMLs

Six stores, three formats. No event store. Migrations runner (`src/main/migrations/runner.ts`) handles schema bumps with backfill-baseline (audit §1).

**Proposed Conductor.** Single SQLite at `~/.conductor.db`. Tables:
- `inbox_items` — the unit of "something for the user/agent to attend to"
- `threads (parent_thread_id)` — Goose's `threads` table generalised; supports parent/child for sub-agent runs
- `messages` — append-only, mirrors Goose `messages` shape
- `signals` — replaces TaskDock's `processed-assignments.json` + `auto-process-rules.json`; events that trigger scenarios
- `approvals` — replaces ad-hoc `awaiting_input` task state in MissionControl
- `artifacts` — replaces TaskDock's workspace artefact reader; rows point at on-disk files under `<workspace>/.conductor/runs/<run_id>/`

Drop-folder configs (no DB row needed): `.conductor/scenarios/*.yaml`, `.conductor/mcp/*.json`, `.conductor/skills/*.md`, `.conductor/hooks.json`. Settings move to `~/.conductor/settings.yaml`.

| Entity | Goose | Legacy TaskDock | Proposed Conductor |
|---|---|---|---|
| Conversation log | `messages` table (append-only) | `tasks.db` denormalised columns + ad-hoc | `messages` (append-only, copy of Goose shape) |
| Session/thread | `sessions` + `threads` tables | `tasks` rows | `threads (parent_thread_id)` |
| User-actionable item | none — sessions are not "actionable" | `tasks` w/ `awaiting_input` state | **`inbox_items`** (first-class) |
| Triggering event | none (cron schedules are pre-configured, not reactive) | `processed-assignments.json` (poll + ad-hoc) | **`signals`** (rows; matched against scenario `triggers:`) |
| Approvals | `permission` per-tool (`crates/goose/src/permission/`) | `awaiting_input` task state | **`approvals`** (rows, durable across restart) |
| Artifacts | none — agent writes wherever, no convention | workspace files via `MissionControlService.readWorkspaceFile()` | **`artifacts`** rows + `<workspace>/.conductor/runs/<run_id>/` |
| Scheduled jobs | `Paths::data_dir()/schedule.json` (loose JSON) | `MissionControl` queue + `AutoProcessService` polling | **scheduler watches `signals` table** + per-source plugins emit signals |
| Settings | `~/.config/goose/config.yaml` | `~/.taskdock/settings.json` (+ 4 others) | `~/.conductor/settings.yaml` (+ scenario/mcp/skill drop folders) |
| Migrations | `schema_version` table, additive `ALTER TABLE`s in code | runner.ts + `_migrations` table | TaskDock pattern copy-fork |

### D. Agent loop

**Goose.** The loop lives in `crates/goose/src/agents/agent.rs::Agent::reply()` (line 1049). 2,562 LOC of one struct that holds:

- `AgentConfig { session_manager, permission_manager, scheduler_service, goose_mode, goose_platform, mcp_host_info, session_name_update_tx }` (lines 110-120)
- A capability stack: `ToolConfirmationRouter`, `ActionRequiredManager`, `RetryManager`, `PermissionInspector`, `RepetitionInspector`, `EgressInspector`, `AdversaryInspector`, `SecurityInspector`, `ToolInspectionManager`, `ExtensionManager`, `PromptManager`.
- A current `Conversation`, the active `SharedProvider`, the current `ContextMgmt` (compaction state).

The loop shape (verified by reading lines 1049-1245):

1. Receive `user_message` over `POST /reply`.
2. If a `/`-slash-command, dispatch to command handler; emit one `Message` and return early (lines 1090-1147). No tool calls.
3. Persist the user message with `session_manager.add_message()`.
4. Check token count vs auto-compaction threshold (`check_if_compaction_needed()`, line 1176). If over, run `compact_messages()` and yield `HistoryReplaced` event (lines 1186-1245).
5. Then enter the model→tool→result loop (continues past the snippet read), which:
   - Calls the active `Provider`'s `complete()` with the full conversation + tool catalog from `ExtensionManager.list_tools()`.
   - Streams tokens via `AgentEvent::Message` deltas.
   - When the model emits `tool_use`, dispatches through `tool_execution.rs::ToolCallContext`. Tool results stream back.
   - Loops until model emits stop, `max_turns` reached, or `cancel_token` cancelled.
- `DEFAULT_MAX_TURNS: u32 = 1000` (line 67).
- `COMPACTION_THINKING_TEXT` for the user-visible "compacting..." (line 68).
- Multi-agent: subagent loop in `subagent_handler.rs` + `subagent_execution_tool/`. A `Task` tool spawned by the parent agent runs a fresh agent with a filtered toolset; results return synchronously to parent.

Long-running tools: tool execution is `async`; the SSE stream emits intermediate `Message` events while the tool runs; the model only sees the final tool result. There is no streaming partial tool output to the model; only to the UI.

**Legacy TaskDock.** No single agent loop. Each AI service has its own:
- `ai-review-service.ts` (581 LOC) drives `IAIProvider.reviewChunk()` (an `AsyncGenerator`).
- `walkthrough-service.ts` (422 LOC) does its own session lifecycle.
- `apply-changes-service.ts` (669 LOC) yet another.
- The Claude provider lazy-imports `@anthropic-ai/claude-agent-sdk` per call (`engine.ts:368`); the Copilot provider holds a long-lived `CopilotClient` and creates+destroys a session per call (`engine.ts:380-409`).
- Cancellation: ad-hoc per service. No unified `AbortSignal` propagation.
- See `legacy-taskdock-audit-2026-05-08.md` §5.

**Proposed Conductor.** **No agent loop in Conductor.** The agent runs in an external CLI (Claude Code or Copilot via `claude --resume <thread-id>` / equivalent), which speaks MCP to Conductor. Conductor's MCP tools (`thread.append_message`, `signal.emit`, `inbox.list`, `approval.request`) are the only surface the agent sees. The CLI's own loop handles model↔tool↔model; Conductor just persists what flows through the tools.

This is the inversion that distinguishes Conductor from both Goose and legacy TaskDock: the harness shrinks dramatically because we delegate the loop to the same battle-tested CLI the user already has installed. See `agent-cli-architectures-2026-05-08.md` (OpenClaw, Hermes Agent — both treat MCP as the spine and let any client drive).

| Concern | Goose | Legacy TaskDock | Proposed Conductor |
|---|---|---|---|
| Where the loop runs | sidecar (`Agent::reply`, `agent.rs:1049`) | inside services (Claude SDK `query()` / Copilot `sendAndWait()`) | **external CLI** (Claude Code / Copilot CLI) |
| Loop LOC | 2,562 (agent.rs alone) | ~10k spread across `src/main/ai/` | ~0 (Conductor delegates) |
| Streaming | `AgentEvent::Message` deltas via SSE | `progress` / `comment` / `walkthrough` events on per-service emitters | xterm-rendered raw CLI stdout (the user sees the *real* CLI) |
| Stop conditions | `max_turns` (default 1000), model stop, cancel token | per-service ad-hoc | **none** — the CLI decides; cancel is `kill <pid>` (mirrors `feedback_no_arbitrary_agent_cutoffs`) |
| Compaction | auto-compact at threshold (`check_if_compaction_needed`, line 1176) | none | **delegated to CLI** (Claude Code already auto-compacts) |
| Subagents | `Task` tool spawns fresh agent with filtered toolset; result returns sync (`subagent_handler.rs`) | none | **threads with `parent_thread_id`** — subagent = child thread; CLI spawns it via `inbox.spawn_thread` MCP tool |
| Long tools | async; intermediate `Message` events to UI only | per-service (`session.events`) | the CLI's own tool stream surfaces in xterm; Conductor sees only `ToolCallStarted/Completed` signals |

### E. MCP integration

**Goose.** Goose is primarily an **MCP client**: every "extension" is an MCP server. `crates/goose/src/agents/extension_manager.rs` (~1,000 LOC reading the head) holds `Extension` records (struct at lines 71-117) with config + resolved-config + `McpClientBox` + cached `ServerInfo` + a `tempfile::TempDir` for per-session ephemeral state. Connection lifecycle:

- `add_extension()` — looks up `ExtensionConfig` variant (the 6-variant tagged enum from §2.2 of the recipe deep-dive), spawns the appropriate transport.
  - `stdio` — `tokio::process::Command`, `TokioChildProcess` transport.
  - `streamable_http` — `StreamableHttpClientTransport` with auth (lines 9-12, `AuthClient` import line 51).
  - `builtin` — bundled MCP server in `goose-mcp` crate (e.g. `MemoryServer`, `TutorialServer` — `crates/goose-server/src/main.rs:90-93` runs them via `serve()`).
  - `platform` — in-process, no IPC (e.g. the developer extension that does file/shell directly).
  - `inline_python` — spawns `uvx` with embedded code as a stdio MCP server.
  - `frontend` — tools the desktop client itself implements; the agent calls them via SSE round-trips.
- Connection pooling: each session has its own extensions map; client per extension per session. No shared client across sessions (sessions are isolated).
- Secrets: `Envs::DISALLOWED_KEYS` (`extension.rs:71-86`) blocks 31 dangerous env vars (PATH, LD_PRELOAD, SystemRoot, etc.) from being overridden — a real defense-in-depth layer.
- Goose **as MCP server**: `mcp_app_proxy.rs` (284 LOC) and `mcp_ui_proxy.rs` (53 LOC) are routed through the desktop's HTTP for the desktop's own MCP-UI extensions (apps, e.g. `goose_apps`). They are **not** a general "drive Goose from outside" surface. The closest is `goose-cli acp` / `goose-cli serve` (`cli.rs:762-794`) which exposes Goose as an ACP agent — but ACP is not MCP.

**Legacy TaskDock.** `src-backend/mcp-server.ts` (329 LOC) exposes exactly **two** MCP tools — `taskdock_get_docs` and `taskdock` (a method-name dispatcher). The hand-curated `METHOD_NAMES` list in `mcp-router.ts:129-143` enumerates ~40 methods. Transport: stateless `StreamableHTTPServerTransport` at `/mcp` on the unified HTTP server (audit §3, lines 309-328). PII scrub layer wraps the dispatch: `getWorkspaceScrubLayer` / `getSessionScrubLayer` + `protectGuids` / `restoreGuids` (mcp-server.ts:101-145). MCP is a thin façade over WS RPC — the same registry, two surfaces.

**Proposed Conductor.** **MCP is the spine.** Tools defined once, exposed to:
- External CLIs (`claude --mcp http://localhost:5201/mcp`).
- Other MCP clients (Continue, Cursor) via the same drop-folder config (`.conductor/mcp/*.json` written in Continue/Cursor format).
- The renderer (via the WS facade for low-latency cases, but the renderer can also call the MCP endpoint directly).

Tool surface (from the brainstorming):
- `inbox.list / get / archive / snooze`
- `thread.list / get / append_message / spawn`
- `signal.emit / list / ack`
- `approval.request / decide`
- `artifact.list / read`

For Conductor-as-MCP-client (running scenarios that need external MCP servers — GitHub, ADO, ICM): drop-folder discovery from `.conductor/mcp/*.json`, lifecycle managed via Goose-style 6-variant `ExtensionConfig` (copy-fork of `extension_manager.rs` shape, but in Node — the variants are universal).

| Concern | Goose | TaskDock | Proposed Conductor |
|---|---|---|---|
| MCP as client | Yes — extensions = MCP servers (`extension_manager.rs`) | No (single MCP server, no client) | Yes — drop-folder discovery + 6-variant config (Goose copy-fork) |
| MCP as server | Limited (`mcp_app_proxy` for own UI) | Yes (~40 methods, hand-curated) | **Primary surface** — every operation is a tool |
| Tool catalog source | per-extension `list_tools()` aggregated by `ExtensionManager` | hand-curated `METHOD_NAMES` list | tools defined alongside RPC handlers; both share schema |
| Connection lifecycle | per-session extension client; cached `ServerInfo`; tempdir per extension | one stateless transport, no per-extension state | per-session client cache (Goose pattern); per-server health watchdog |
| Secrets | `Envs::DISALLOWED_KEYS` (31-var blocklist), `env_keys` recipe pattern | per-plugin manifest config with manual-import warnings | adopt `Envs::DISALLOWED_KEYS` verbatim; secrets from OS keychain (TaskDock `auth-manager.ts` copy-fork) |
| Per-session toolset filter | `available_tools` on `ExtensionConfig` (recipe-level) + `X-TaskDock-Session-Id` header per-session in spec §7.5 (NB: brittleness called out in REVIEW-CONSOLIDATED R3) | none | **per-thread `allowed_tools`** column on `threads`; MCP server enforces; mirrors §7.5 but pinned to thread, not session header |
| Bidirectional scrub | none | `protectGuids/restoreGuids` (mcp-server.ts:101-145) | TaskDock copy-fork (already on the official copy-fork list — audit §"Synthesis") |

### F. Recipe / scenario engine

Already documented at length in `goose-deep-dive-2026-05-08.md` §1-§7. Highlights for integration points:

- Recipes are **deserialised on demand** by the runtime — `recipe.yaml` → MiniJinja render → serde_yaml → `Recipe` struct → validate → spawn agent session. No pre-compilation, no caching beyond the per-session.
- Connect to agent loop: `recipe.extensions` becomes `ExtensionManager.add_extensions()`; `recipe.settings` becomes `ModelConfig` overrides; `recipe.instructions` becomes the system message; `recipe.prompt` (if set) becomes the first user message; `recipe.sub_recipes` are synthesised as parent-toolset entries.
- Connect to scheduler: `/recipes/schedule` (`recipe.rs:580`) writes a row to `schedule.json` with `source = <recipe_path>`. Scheduler loads the recipe at run time (not at schedule time), so editing the file changes future runs.
- Connect to MCP extensions: per-recipe `available_tools` allowlist filters the tool catalog before it reaches the model.

**Proposed Conductor (renamed `scenario`).** Same shape, with the 30% extensions called out in the recipe deep-dive §7.1:
- `kind: pr_review | incident | epic | ...` (not in Goose) → routes to per-kind UI/artifact handlers.
- `state_machine:` (optional) → multi-stage workflow with explicit transitions.
- `outputs:` declarative → runtime collects artefacts into `<workspace>/.conductor/runs/<run_id>/`.
- `triggers:` (not just cron) → matches against `signals` table rows.
- `checkpoint:` activity → durable suspension with `approvals` row.
- `fan_out:` directive → spawns N child threads, parent gets aggregated summary not full transcripts.

Connection points:
- Loaded by the scheduler when a `signals` row matches a scenario's `triggers:` filter.
- Spawns a *thread* (not a session) with `parent_thread_id` set when fan-out.
- Drops a starter message into the thread; the side-terminal CLI then takes over.
- Validation: keep Goose's `validate_recipe.rs` rules verbatim, including "file params can't have defaults" and the strict-undefined Jinja policy.

### G. Scheduler

**Goose.** `crates/goose/src/scheduler.rs` (1,236 LOC). One `tokio_cron_scheduler::JobScheduler` per process; jobs in a `HashMap<String, (JobId, ScheduledJob)>`; running jobs in a `HashMap<String, CancellationToken>`. Persistence: `schedule.json` written on every mutation (`persist_jobs()`, line 120-onwards). Loaded on startup. Cron format: 5- or 6-field accepted, 5-field auto-promoted (recipe deep-dive §4.1). All HTTP routes in `schedule.rs:545-558` map 1:1 to `Scheduler` methods.

`ScheduledJob` shape (lines 104-118): `id`, `source` (recipe path), `cron`, `last_run`, `currently_running`, `paused`, `current_session_id`, `process_start_time`. **Cron-only.** No event triggers, no signal-matching.

**Legacy TaskDock.** Polls. `AssignmentWatcherService` polls every 60s with progressive backoff (audit §"Synthesis", item 3). `AutoProcessService` is 527 LOC of polling-with-rules-with-backoff for 4 source types, persisted to `auto-process-rules.json`. `MissionControlService` has a `LoopController` with `scheduledTimers: Map<string, Timeout[]>` that doesn't survive restart (audit §8 "Specific replacements", item 2). Plugin-defined cron triggers via `plugin-scheduler.ts` add a third path.

**Proposed Conductor.** Tiny tokio-style scheduler in Node — but the input isn't cron, it's `signals`. Algorithm:
1. Source plugins (PR-watcher, ADO-watcher, ICM-watcher) write rows to `signals`.
2. Scheduler tails `signals` (LISTEN/NOTIFY in Postgres terms; here, `WAL` checkpoint poll or a chokidar-on-rowid trick over the SQLite file — TBD; simplest is a 1s poll on `signals WHERE consumed_at IS NULL`).
3. For each unconsumed signal, evaluate every scenario's `triggers:` filter against the signal payload.
4. On match: spawn a thread, drop the starter message, mark signal `consumed_at = now`.
5. Cron is *one* trigger kind (`triggers: [{ type: cron, expr: "0 */6 * * *" }]`); a synthetic source plugin emits a `signal` of `kind=tick` per cron firing.

This means cron is collapsed into the same machinery as PR-opened, incident-filed, etc. — the Goose-style "schedule recipe" route disappears. From `feedback_no_arbitrary_agent_cutoffs`, kill-by-cancel-cascade replaces wallclock budgets.

| Concern | Goose (cron only) | TaskDock (workflows + assignment watcher) | Proposed Conductor (signals + triggers) |
|---|---|---|---|
| Trigger model | cron | per-source ad-hoc poll + per-plugin cron | unified `signals` table; cron is a synthetic signal source |
| Persistence | `schedule.json` (loose) | `auto-process-rules.json` + DB rows | `signals` table (durable, queryable) |
| Run state | `currently_running`, `current_session_id` columns | `tasks.running` flag | `threads.status` |
| Cancellation | `kill_running_job` route → `CancellationToken.cancel()` | per-service ad-hoc | thread cancel cascades to child threads (Goose `Task` shape, but durable) |
| Replay / audit | session DB has the messages but not the signal that triggered the run | `processed-assignments.json` + tasks rows | `signals.consumed_by_thread_id` foreign key gives full trace |
| HTTP surface | 11 routes (recipe deep-dive §4.1) | none external | MCP tools `signal.emit / list`; renderer admin via WS |

### H. Extension / plugin model

**Goose.** The 6-variant `ExtensionConfig` (recipe deep-dive §2.2). Lifecycle for `stdio` (the most common variant), per `extension_manager.rs`:

1. `ExtensionManager.add_extension(config, session_id)` resolves env-var substitutions (`RE_ENV_BRACES`/`RE_ENV_SIMPLE` regexes lines 57-61).
2. Creates a `tokio::process::Command` with `cmd`, `args`, scrubbed env (`Envs` filter blocks `DISALLOWED_KEYS`).
3. Wraps in `TokioChildProcess` transport, hands to `McpClient::initialize()` (with `goose` host info, lines 38-51 of file).
4. Reads `ServerInfo` for capability detection (`supports_resources`, `get_instructions` — lines 100-112).
5. Stores in `Extension` struct with a `_temp_dir` (held until extension is removed → tempdir is cleaned).
6. Tools listed via `client.list_tools()` aggregate into the agent's catalog.
7. Removal: `client.shutdown()`, drop, child process exits.

`extension_malware_check.rs` runs a static check before spawn — defense against `cmd: rm` style attacks. `subprocess.rs::configure_subprocess` sets process-group/job-object so the parent's death cascades.

**Legacy TaskDock.** Plugin manifest at `~/.taskdock/plugins/<name>/manifest.json` declares triggers (manual / scheduled / hook) and a workflow file. `plugin-script-runner.ts` spawns `npx tsx wrapper.ts ctxFile respFile`; IPC via `__PLUGIN_MSG__:`-prefixed JSON on stdout. Host callbacks via the `req-<id>.json` / `res-<id>.json` file-poll dance (audit §2). Hot reload via `fs.watch` with 500ms per-plugin debounce, cancels running workflows on change (engine.ts:233+280).

**Proposed Conductor.** Two plugin types, both copy-forking Goose's `ExtensionConfig` shape:

1. **MCP extensions** (the Goose pattern verbatim): drop a JSON in `.conductor/mcp/*.json` matching Continue/Cursor format; sidecar discovers, spawns, manages lifecycle. 6 variants supported.
2. **Source plugins** (TaskDock's plugin-loader pattern, simplified): produce `signals`. Same `npx tsx` model but with stronger sandbox (no raw `ctx.shell.run()` — capability allowlist, audit §"Synthesis" item 4).
3. **Skills** are *just markdown* in `.conductor/skills/*.md`. The CLI reads them at runtime; no compilation. (Mirrors the `goose-self-test.yaml` recipe pattern + `feedback_reuse_existing_infra` — Conductor doesn't reinvent skills.)

| Concern | Goose | TaskDock | Proposed Conductor |
|---|---|---|---|
| Extension config | 6-variant tagged enum (`ExtensionConfig`) | manifest.json (per plugin) | 6-variant copy-fork + Continue/Cursor mcp.json drop-folder |
| Lifecycle | per-session, sidecar-managed, tempdir per extension | per-plugin, runner-managed, file IPC | per-server health-checked client; per-source workflow process (TaskDock style) |
| Hot reload | not for extensions; recipes loaded per run | `fs.watch` 500ms debounce, cancels running | scenarios reload on save; running threads keep their snapshot (HIER-10 in spec §3.7) |
| Sandbox | `Envs::DISALLOWED_KEYS` (31-key blocklist) + `extension_malware_check.rs` | none real (`ctx.shell.run` is raw `exec`) | adopt Goose's blocklist + capability gating per scenario |
| IPC | JSON-RPC over MCP transports (stdio / streamable_http) | `__PLUGIN_MSG__:` stdout prefix + `req/res-<id>.json` polling | MCP for tools; signals table for source plugins |
| Process-group cleanup | `subprocess.rs::configure_subprocess` (job objects on Windows) | `taskkill /T` for cancellation (terminal-service.ts) | TaskDock copy-fork — already vetted on Windows |

### I. Frontend (Electron+React) architecture

**Goose UI** lives at `ui/desktop/src/`. Stack: Electron 41 + React 19 + react-router-dom 7 + Vite 7 + TanStack Form + Radix UI + Tailwind 4. State management is **light** — no Redux, no Zustand. Three React contexts (`ui/desktop/src/contexts/`):

- `ChatContext.tsx` — current chat (id, messages, recipe, recipe params); 60-line file (lines read).
- `FeaturesContext.tsx` — feature flags from `/features` endpoint.
- `ThemeContext.tsx` — dark/light.

Plus `ConfigContext` (`components/ConfigContext.tsx`), `ModelAndProviderContext`. Component-local `useState` covers the rest. SWR for data fetching (`package.json:96`). The codegen'd API client in `src/api/` is consumed directly by components — no Redux selectors, no service layer in the renderer.

Routing: `App.tsx:1-10` `HashRouter` (Electron-friendly). Routes: `/` (Hub), `/pair` (active session), `/sessions`, `/schedules`, `/recipes`, `/settings`, `/extensions`, `/skills`, `/apps`, `/launcher`. Each route is a top-level component.

SSE consumption: the agent stream is consumed in a hook (didn't trace exhaustively, but `BaseChat.tsx` is the entry and it consumes `MessageEvent`s through the `@aaif/goose-sdk` workspace package — a thin reader on top of the SSE endpoint). Per-message append into `chat.messages` via `setChat`.

**Legacy TaskDock.** Vanilla TS, no framework, monolithic `class PRReviewApp` (`src/renderer/app.ts`). Section-based navigation. Per-tab state maps + per-tab `AbortController`s (audit §6). Stack: vanilla TS + Fluent UI Web Components + CodeMirror + xterm.js + Mermaid.

**Proposed Conductor.** The renderer **stays vanilla TS** (preserving `feedback_reuse_existing_infra` — keep the diff-viewer, the keyboard model, the section pattern). But it shrinks dramatically because:
- The agent loop is gone — no more renderer-side AI session orchestration.
- Mission Control is replaced by `inbox` + `thread` + side terminal.
- No per-section god-component; ViewRenderer registry maps `inbox_item.kind` to a render function (REVIEW-CONSOLIDATED R1's `WorkspaceMainContext`).

| Concern | Goose (React+Electron) | TaskDock (vanilla TS+Tauri) | Proposed Conductor (vanilla TS+Tauri) |
|---|---|---|---|
| Framework | React 19 + react-router | vanilla TS, custom `class PRReviewApp` | vanilla TS, ViewRenderer registry |
| State mgmt | 3 React contexts + SWR; component `useState` | 5+ section state maps on `PRReviewApp` | per-thread state lives in DB; renderer is thin |
| API client | codegen'd via `@hey-api/openapi-ts` from `openapi.json` | hand-typed `src/shared/*-types.ts` | zod-derived JSON Schema → both renderer + MCP |
| Streaming | SSE via SDK reader | WS per-event subscriptions | WS for renderer; xterm renders the *real* CLI |
| Routing | `HashRouter` (5 top-level routes + nested) | section sidebar + `TabBar` per section | route = inbox item → thread (single primary view) |
| Heavy components | DiffViewer (none — Goose punts to xterm/markdown) | DiffViewer (load-bearing copy-fork — `MEMORY.md` perf notes) | DiffViewer copy-fork preserved |
| Build | Vite 7 + Electron Forge + electron-vite plugins | Vite 6 + Tauri | Vite 8 + Tauri 2.11 (per `conductor/package.json:43`) |

### J. Build & distribution

**Goose.** Multi-platform CI in `.github/workflows/`:
- `bundle-desktop.yml` (mac), `bundle-desktop-intel.yml`, `bundle-desktop-linux.yml`, `bundle-desktop-windows.yml` — per-OS Electron bundles.
- `build-cli.yml` — CLI binary per OS.
- `bundle-goose2.yml` — separate `goose2` bundle (an alternate UI, see `ui/text/`?).
- Just commands (`Justfile`):
  - `just release-binary` (line 24) — build + emit OpenAPI.
  - `just package-ui` (line 167) — Electron Forge package.
  - `just make-ui` / `make-ui-windows` / `make-ui-intel` — platform variants.
  - `just generate-openapi` (line 197) — regenerate `ui/desktop/openapi.json`.
  - `just run-server`, `just run-ui`, `just run-dev` — dev loops.

The desktop ships with the `goosed` binary in its resources dir (`goosed.ts:55-61`); on launch it locates the binary via `findGoosedBinaryPath()` checking `GOOSED_BINARY` env first, then packaged resources, then dev paths. Auto-update via `electron-updater` (`package.json:73`).

**Legacy TaskDock.** `package.json` at root: `npm run build:renderer` (Vite), `npm run build:sidecar` (esbuild + `pkg` to standalone .exe). Tauri builds wrap. Single Windows-first install path.

**Proposed Conductor.** Conductor is being built with extraction in mind — `conductor/package.json` is independent (`name: "conductor"`, line 2). Build:
- `npm run build:renderer` (Vite 8 — `package.json:19`).
- `npm run build` (currently just renderer, sidecar packaging TBD in slice 2).
- Tauri 2.11 wrapper (deps line 28).
- Auto-update story: open question. Goose's `electron-updater` is a plug-in; Tauri's updater is built-in but per-platform signing is a hassle.

| Concern | Goose | TaskDock | Proposed Conductor |
|---|---|---|---|
| Bundler | Electron Forge + Vite + per-OS makers | Tauri + esbuild (sidecar) + pkg | Tauri + Vite 8 + tsx watch (dev), TBD prod |
| Sidecar binary | `goosed` standalone Rust binary in resources | `pkg`-built Node .exe | similar — `pkg` or Node-SEA, TBD |
| Auto-update | `electron-updater` via GitHub Releases | Tauri updater + manual artifacts | Tauri updater (extraction-ready means no GitHub-org coupling) |
| CI | 18+ GH workflows (per-OS bundles, canary, code-review, dependabot-merge, …) | (didn't enumerate) | TBD per slice 2 |
| Versioning | `version` in `package.json` + `Cargo.toml` (one source of truth tools — `set-openapi-version`, Justfile:374) | per-package | per-package; conductor is `0.0.1` (`package.json:3`) |

### K. Testing strategy

**Goose.** Layered:
- `crates/goose/tests/` — integration tests, including ACP fixtures, MCP integration replay tests, agent.rs end-to-end, compaction, providers, repetition inspector. The `mcp_replays/` directory holds recorded transcripts for deterministic test replay (`just record-mcp-tests` at AGENTS.md:14).
- `crates/goose-server/tests/` — only `tls_test.rs` at the integration level (the routes are mostly covered through the desktop e2e or via in-process agent tests).
- `ui/desktop/tests/` and `ui/desktop/playwright.config.ts` — Playwright e2e + Vitest unit. `pnpm test-e2e:single` for targeted runs (`package.json:28`).
- `goose-self-test.yaml` at the repo root is an *executable test recipe* — `goose run --recipe goose-self-test.yaml` validates the build (AGENTS.md "Test:" line). This is a clever inversion: the agent system tests itself.
- Promptfoo / evals in `evals/open-model-gym/`.

**TaskDock.** From audit: tests scattered, `review-context-service.ts` has a 68-LOC test file for 1,044 LOC of code (audit §5). Vitest in renderer (`vitest.config.ts`).

**Proposed Conductor.** Vitest (`package.json:9-12`) + Playwright (`playwright.config.ts` exists at conductor root). `__tests__/eval` dir for promptfoo evals (`package.json:12`). Strategy not fully written but the testability-canon migration in legacy TaskDock is the relevant precedent — constructor injection through a registry, see audit §"What's complexity that didn't pay off" item 1.

---

## 3. Side-by-side comparison tables

### Table 1 — Process topology

| Concern | Goose | Legacy TaskDock | Proposed Conductor |
|---|---|---|---|
| Sidecar language | Rust (Axum) | Node.js (ws) | Node.js (ws) |
| Sidecar binary path | `~/Library/.../Block/goose/bin/goosed` | `pkg`-bundled .exe | TBD; same shape |
| How desktop spawns it | `child_process.spawn(goosedPath, ['agent'], { env: { ...secret, port } })` (`goosed.ts`) | Tauri shell command | Tauri shell command |
| Port discovery | `findAvailablePort()` then passed via env | hardcoded 5200 | hardcoded 5201 (`package.json:13`) |
| Auth on sidecar | 32-byte hex secret in `Authorization` header (`agent.rs:49-50`) | none (localhost) | localhost-only (per-thread session id for MCP scoping) |
| Where MCP child-procs live | sidecar (`ExtensionManager`) | sidecar (`mcp-router`, but limited) | sidecar (Goose pattern copy-fork) |
| Where the agent loop runs | sidecar | sidecar (per-service) | **external CLI** (Claude Code / Copilot) |
| Headless / CLI mode | `goose run --recipe` direct in-process | none | `claude --resume <thread-id>` |
| Goose-as-server-for-others | yes (`goose-cli serve --port 3284`, ACP) | only renderer can talk | yes (HTTP MCP + drop-folder config) |

### Table 2 — IPC contract

| Concern | Goose (HTTP+SSE+OpenAPI) | Legacy TaskDock (WS+hand-typed) | Proposed Conductor |
|---|---|---|---|
| Wire protocol(s) | HTTP REST + SSE (`text/event-stream`) | WebSocket only | WS (renderer) + HTTP MCP (external) |
| Schema source of truth | `utoipa::OpenApi` derive in Rust → `openapi.json` | `src/shared/*-types.ts` (hand-typed) | zod schemas in TS → JSON Schema → both surfaces |
| Client codegen | `@hey-api/openapi-ts` → `types.gen.ts` | none — hand-imported | TBD; same pattern |
| Number of routes | ~100 across 17 route modules (`routes/mod.rs:31-57`) | hundreds (~30 namespaces, see audit §4) | inbox/thread/signal/approval — ~20 tools |
| Streaming events | `MessageEvent`: `Message/Error/Finish/Notification/UpdateConversation/ActiveRequests/Ping` | per-service event names (`terminal:*`, `chat-terminal:*`, `mission-control:*`) | MCP `notifications/*` + WS for renderer |
| Heartbeat | SSE `Ping` every 500 ms (`reply.rs`) | none | adopt Goose `Ping` pattern |
| Backpressure | none documented | `DROPPABLE_EVENTS` + 4 MB cutoff (`bridge.ts:286`) | TaskDock copy-fork |
| Authn | per-process secret middleware (`auth::check_token`) | none | localhost + per-thread session id |
| TLS | optional (`Settings::tls`, rustls or native) | no | no (localhost) |
| Tunneling story | `tunnel_manager` exposes server publicly with auth (`tunnel.rs`) | none | no (out of slice 1-15 scope) |

### Table 3 — Data model

| Entity | Goose | Legacy TaskDock | Proposed Conductor |
|---|---|---|---|
| Conversation message | `messages` table; `id, message_id, session_id, role, content_json, created_timestamp, tokens, metadata_json` | embedded in `tasks` rows + ad-hoc | `messages` (Goose copy of shape) |
| Session | `sessions` table; ~22 columns incl. `extension_data`, 6 token counters, `recipe_json`, `goose_mode`, `archived_at`, `project_id` | `tasks` rows (denormalised) | `threads`; minimal columns + `parent_thread_id` |
| User-actionable item | none | `tasks WHERE awaiting_input/failed/queued past SLA` (Triage filter) | **`inbox_items`** dedicated table |
| External event | none | `processed-assignments.json` ad-hoc | **`signals`** table |
| Approval | per-tool permission rows | task `awaiting_input` state | **`approvals`** table |
| Artifact | none — files-on-disk | workspace files (`MissionControlService.readWorkspaceFile`) | **`artifacts`** rows pointing into `<ws>/.conductor/runs/<id>/` |
| Scheduled job | `schedule.json` rows (loose JSON) | rules in `auto-process-rules.json` + DB | `signals` rows of `kind=tick` |
| Project / workspace | `project_id` on session (added v11) | one workspace per task | `<workspace>/.conductor/` hierarchy |
| Threading | `threads` + `thread_messages` (added v9, lines 1026-1040) | none | first-class with parent/child |
| Session types | enum: User, Scheduled, SubAgent, Hidden, Terminal, Gateway, Acp | task type field | `kind` per inbox item; thread is mode-agnostic |

### Table 4 — Agent loop / session

| Concern | Goose | TaskDock | Proposed Conductor |
|---|---|---|---|
| Loop owner | `Agent::reply()` in sidecar (`agent.rs:1049`) | each AI service has its own | external CLI (Claude Code / Copilot) |
| Loop LOC | 2,562 (agent.rs); ~1,200 (extension_manager.rs); thousands more in supporting modules | ~10k spread | 0 (Conductor delegates) |
| Default max_turns | 1000 (`agent.rs:67`) | per-call | none — CLI decides |
| Compaction | auto at threshold; `compact_messages()` rewrites conversation; emits `HistoryReplaced` | none | delegated to CLI |
| Tool invocation | `ToolCallContext` → `ExtensionManager.dispatch()` → MCP client | per-service | CLI invokes tools via MCP to Conductor |
| Subagents | `Task` tool → fresh Agent w/ filtered toolset; result returns sync (`subagent_handler.rs`) | none | child threads (`parent_thread_id`); CLI spawns via MCP `inbox.spawn_thread` |
| Permission gates | `PermissionInspector`, `ToolConfirmationRouter`, `ActionRequiredManager` | per-service | `approvals` table; CLI's own `ask_user` plus Conductor's `approval.request` |
| Cancellation | `CancellationToken` propagated through agent + tools | ad-hoc (`AbortController` per tab/service) | thread cancel = kill external CLI process + cascade child threads |
| Streaming output | `AgentEvent` over SSE | per-service emitters | xterm renders raw CLI stdout (passive) |
| Provider abstraction | `Provider` trait (`crates/goose/src/providers/base.rs`); ~15 providers | `IAIProvider` (`src/main/ai/ai-provider.ts`); 2 providers | none in Conductor — CLI handles provider choice |
| Token accounting | per-session, per-message token counts | not tracked | not tracked — CLI handles it (cost claim narrows) |

### Table 5 — MCP integration

| Concern | Goose | TaskDock | Proposed Conductor |
|---|---|---|---|
| Goose/TaskDock as MCP client | yes — extensions are MCP servers; 6 variants | no | yes — Goose pattern copy-fork |
| Goose/TaskDock as MCP server | limited (`mcp_app_proxy.rs:284`, own UI only) | yes (~40 methods, hand-curated) | **primary** — full inbox/thread/signal/approval surface |
| Drop-folder MCP config | only `~/.config/goose/config.yaml` extensions: array | none | `.conductor/mcp/*.json` (Continue/Cursor format) |
| Per-session toolset filter | `available_tools` allowlist on `ExtensionConfig` | none | per-thread `allowed_tools` column |
| Connection lifecycle | per-session, cached `ServerInfo`, tempdir per ext | per-call (stateless) | per-server health watchdog + per-session client cache |
| Bidirectional PII scrub | none | `protectGuids/restoreGuids` | TaskDock copy-fork (already on the list) |
| Static malware scan | `extension_malware_check.rs` runs before spawn | none | adopt Goose check |
| Process isolation | `subprocess.rs` configures job objects on Win | `taskkill /T` for plugins | TaskDock copy-fork |
| OAuth on MCP | yes — `AuthClient` for Streamable HTTP | no | plan: yes (Continue's MCP servers ship with OAuth) |
| Header-based session id (§7.5) | spec'd but the `Task` parameter doesn't actually flow it | n/a | per-thread; mint child session id when spawning sub-thread |

### Table 6 — Extension / plugin model

| Concern | Goose | TaskDock | Proposed Conductor |
|---|---|---|---|
| Variants | 6 (`stdio`, `builtin`, `platform`, `streamable_http`, `frontend`, `inline_python`) | 1 (manifest + workflow file) | 6 (Goose copy-fork) + source-plugins (TaskDock simplified) |
| Hot reload | not for extensions (must restart session) | `fs.watch` 500 ms debounce, cancels running | scenarios reload on save; running threads keep snapshot |
| Sandbox | `Envs::DISALLOWED_KEYS` (31 vars) + malware check | none real | adopt both + capability allowlist per scenario |
| Manifest format | inline in recipe `extensions:` or in user config | per-plugin `manifest.json` | drop-folder JSON (Continue/Cursor-compat) + scenario inline |
| Built-in tools | `builtin/developer`, `builtin/computercontroller`, `builtin/memory`, `builtin/tutorial`, `builtin/autovisualiser` (in `crates/goose-mcp/`) | none | bundled MCP tools in sidecar (inbox/thread/signal); skill files |
| Per-extension secrets | `env_keys: [...]` recipe pattern + OS keychain | manifest config | `env_keys` pattern + TaskDock `auth-manager.ts` keychain copy-fork |
| Reload-mid-run safety | new sessions only | cancels running on file change | snapshot-pinning at thread spawn (HIER-10) |
| Per-tool permission | `PermissionLevel` enum (always/never/ask) | none granular | per-tool `Ask First / Automatic` per scenario (Continue.dev pattern) |

### Table 7 — Scheduling / triggers

| Concern | Goose (cron only) | TaskDock (workflows + assignment watcher) | Proposed Conductor (signals + triggers) |
|---|---|---|---|
| Trigger primitive | cron expression on a `ScheduledJob` | per-source poll + ad-hoc rules | `signals` row matched against scenario `triggers:` filter |
| Persistence | `schedule.json` (loose JSON) + per-job recipe snapshot | `auto-process-rules.json` + DB rows | `signals` table (durable, FK to thread) |
| Cron support | yes (5- and 6-field) | yes (per-plugin) | cron is a synthetic source (`triggers: [{ type: cron, expr }]`) |
| Event-driven triggers | no | per-source ad-hoc | yes — primary path |
| Signal dedup | n/a | `processed-assignments.json` per-id | `signals.dedup_key` unique index |
| Cancellation | `kill_running_job` route → `CancellationToken` | per-service ad-hoc | thread cancel + child-cascade (Goose `Task` shape made durable) |
| Replay / audit trail | session DB messages, but no signal trace | partial via tasks rows | `signals.consumed_by_thread_id` FK |
| HTTP / MCP surface | 11 schedule routes | none external | MCP `signal.emit/list/ack`; renderer admin via WS |
| Parallel-run cap | n/a (cron jobs run independently) | `maxConcurrentSessions` setting | per-scenario `max_parallel:` field |
| Snooze / pause | `pause_schedule` / `unpause_schedule` routes | `snoozeTask` on tasks | per-inbox-item `snoozed_until` timestamp |

### Table 8 — State management & persistence

| Concern | Goose | TaskDock | Proposed Conductor |
|---|---|---|---|
| Primary store | SQLite `sessions.db` (sqlx) | SQLite `tasks.db` (better-sqlite3) | SQLite `~/.conductor.db` (better-sqlite3) |
| Schema versioning | `schema_version` table; v12; `ALTER TABLE` adds | `_migrations` table + runner.ts | TaskDock pattern copy-fork |
| Loose JSON files | `schedule.json`, `scheduled_recipes/*.yaml`, `config.yaml` | 5+ JSON files at `~/.taskdock/` | drop-folders only (`.conductor/scenarios|mcp|skills|hooks.json`) |
| Per-project state | `sessions.project_id` (added v11) + working_dir | per-task workspace | `<workspace>/.conductor/runs/<run_id>/` artifact dir |
| Migration policy | additive `ALTER TABLE`; one rare DROP at v9->10 (line 1099) | additive only (audit §1) | additive only |
| Crash recovery | session messages persist; running jobs marked, scheduler resumes | mark `running` → `completed` if outputPath, else re-queue (`mission-control-service.ts:724-737`) | events on `signals` are durable; threads with `status='running'` get ack-or-cancel UI prompt on startup |
| State surface to UI | every column queryable through HTTP | denormalised tasks list | `inbox_items` view + `messages` paginated |
| Long-running data growth | sessions accumulate forever (no cleanup policy spec'd) | tasks accumulate | `inbox_items.archived_at`; messages prune via thread retention policy (TBD) |

### Table 9 — Frontend architecture

| Concern | Goose (React+Electron) | TaskDock (vanilla TS+Tauri) | Proposed Conductor (vanilla TS+Tauri, thin) |
|---|---|---|---|
| Stack | Electron 41 + React 19 + react-router 7 + Vite 7 + Tailwind 4 | Tauri + Vite 6 + Fluent UI Web Components + CodeMirror | Tauri 2.11 + Vite 8 (`package.json:43`) + xterm + diff-viewer copy-fork |
| State mgmt | 3 contexts (Chat/Features/Theme) + SWR + local state | section sidebar + per-tab state maps + per-tab AbortController | ViewRenderer registry + per-thread minimal state |
| API client | codegen'd `types.gen.ts` from `openapi.json` | hand-typed `src/shared/*-types.ts` | zod-derived schemas → both renderer types and MCP tool schemas |
| Routing | `HashRouter`; ~10 top-level routes | section sidebar; `TabBar` per section | inbox → thread (single primary view); side terminal as the agent surface |
| Heavy components | none of TaskDock-class — Goose punts to xterm + markdown | DiffViewer (load-bearing perf-tuned, see `MEMORY.md`) | DiffViewer copy-fork preserved |
| Streaming consumer | SDK hook on SSE | per-section WS subscriptions | xterm renders real CLI stdout; WS for inbox/thread updates |
| Per-route data loading | SWR | manual per-section | thread.messages live-stream + inbox virtual list |
| Test ergonomics | Playwright + Vitest; `pnpm test-e2e:single -g` | Vitest, sparse | Vitest + Playwright (`playwright.config.ts` exists) |
| Bundle size | very large (Electron + React 19 + Radix + Tailwind + Framer Motion) | smaller (vanilla) | smaller (vanilla; aggressively scoped) |

### Table 10 — Build & distribution

| Concern | Goose | TaskDock | Proposed Conductor |
|---|---|---|---|
| Build orchestrator | `Justfile` + `electron-forge` + `cargo` + `pnpm` | `npm run` scripts (root `package.json`) | `npm run` scripts (`conductor/package.json`) |
| Sidecar packaging | Rust release binary in resources dir | `pkg` to standalone .exe | `pkg` or Node-SEA, TBD |
| Renderer bundling | Electron Forge + Vite plugins (vite.{main,preload,renderer}.config.mts) | Vite 6 | Vite 8 |
| Multi-platform CI | 18+ GH workflows (per-OS bundles, signing, dependabot, code-review) | (didn't enumerate) | TBD per slice 2 |
| Auto-update | `electron-updater` via GitHub Releases | Tauri updater | Tauri updater (no GH-org coupling) |
| Versioning | dual `package.json` + `Cargo.toml`; `set-openapi-version` Justfile target | per-package | per-package; `0.0.1` |
| OpenAPI regen step | `just generate-openapi` (mandatory after server change) | n/a | TBD; zod → schema regen step |
| Code signing | per-OS makers in Electron Forge | Tauri config | Tauri config |
| Standalone CLI | yes — `goose` and `goosed` ship separately | no | possibly — `claude --resume <thread-id>` is *the* CLI |

---

## 4. Synthesis (Step 5)

### 4.1. Three things Goose got architecturally right that we should copy structurally

**1. OpenAPI codegen as the contract.** `crates/goose-server/src/openapi.rs` declares `ApiDoc` with 100+ paths and 100+ schemas (lines 383-661). `just generate-openapi` regenerates `ui/desktop/openapi.json`; `pnpm run generate-api` drives `@hey-api/openapi-ts` to produce `ui/desktop/src/api/types.gen.ts`. The desktop's `lint:check` and `test-e2e` scripts both run `generate-api` first (`ui/desktop/package.json:23-30`), which means **drift between server and client is a build-time error, not a runtime bug**. Legacy TaskDock's `src/shared/*-types.ts` is hand-written and drifts (audit §4 notes hundreds of methods, ~40 in MCP). Mirror in Conductor: zod schemas in TS → emit JSON Schema → consumed by both the WS facade and the MCP tool definitions, with a `prepublish` script that fails CI if regen produces a diff.

**2. The 6-variant `ExtensionConfig` tagged enum (`crates/goose/src/agents/extension.rs` + `extension_manager.rs`).** Models the entire MCP-server lifecycle space cleanly: `stdio` (most common), `builtin` (bundled), `platform` (in-process), `streamable_http` (remote MCP w/ OAuth), `frontend` (client-implemented tools), `inline_python` (uvx-spawned). `Envs::DISALLOWED_KEYS` (`extension.rs:71-86`) is a 31-variable secret-and-PATH-injection blocklist that took Goose effort to derive — copy verbatim. The `tempfile::TempDir` per extension (lines 81, 96-98) cleans up cruft when the extension is removed. Mirror in Conductor: same enum shape in TS, with the malware static check (`extension_malware_check.rs`) as a pre-spawn step.

**3. Per-process secret + middleware (`crates/goose-server/src/commands/agent.rs:49-50`, `goose_server::auth::check_token`).** Even on localhost-only, Goose mints a 32-byte hex secret per launch and rejects requests without it. Combined with the desktop spawning the binary itself and reading the secret from stdout/env, no other process on the machine can hit the sidecar — including a malicious browser tab. Legacy TaskDock has zero auth on its WS port (any process on `localhost` can connect). Mirror in Conductor: borrow the pattern even if we keep WS — generate at boot, set as env to the sidecar, pass via `Sec-WebSocket-Protocol` from renderer.

### 4.2. Three things Goose got wrong (or just generic) that we should NOT copy

**1. The 2,562-LOC `Agent` god-object (`agent.rs`).** It holds session manager, extension manager, permission router, security inspectors, retry manager, prompt manager, frontend tool channel, tool monitor, slash commands, compaction state, and the loop itself. Test surface is enormous; touching one concern requires understanding all of them. Conductor sidesteps the entire problem by **not running the agent loop** — the external CLI does. The legacy TaskDock split (one service per concern, even if the singleton triple-construction is wrong) is closer to the right factoring than Goose's monolith.

**2. Cron-only scheduling.** `crates/goose/src/scheduler.rs` (1,236 LOC) supports exactly one trigger type. Real SDLC workflows need event triggers (PR opened, incident filed, work-item assigned). Goose punts to "wire a webhook to `goose run --recipe`" externally, which means losing the durable trace. Conductor's `signals` table generalises: cron is one source, ADO-watcher is another, ICM-watcher is another — all write to the same table, and the scheduler matches signals against scenario `triggers:` filters. **One mechanism, many sources.**

**3. Free-form recipe `version` string.** `recipe.version: "1.0.0"` is documentation only — never compared, never enforced (recipe deep-dive §3.2). Combined with Goose's "schema only defined in Rust source, no published JSON Schema" footgun (recipe deep-dive §7.2 item 1), users can't tell whether their recipe matches the runtime's expectations until it crashes. Conductor should publish the JSON Schema as the source of truth, semver from day one, validate on load with a clear error.

### 4.3. Three places where TaskDock's existing architecture is BETTER than Goose's

**1. WebSocket backpressure.** `bridge.ts:286-317` defines `DROPPABLE_EVENTS` (high-frequency events that can be safely skipped under load) and `WS_BACKPRESSURE_BYTES = 4 MB` (cutoff for client buffer). Combined with `terminalWatchers` per-client subscription map for terminal events, this prevents a slow renderer from blocking the sidecar. **Goose has nothing equivalent on its SSE stream** — a stalled SSE client just buffers in the kernel until a `WriteAll` blocks. For a long-running desktop app, TaskDock's pattern is correct. Preserve it.

**2. Bidirectional PII scrub layer.** `mcp-server.ts:101-145` + `src/main/dgrep/scrub-layer.ts` distinguish *structural* GUIDs (file paths, call IDs that the LLM needs to reason about) from *data* GUIDs (incident IDs, user IDs that must not leak). `protectGuids` swaps data GUIDs for sentinels before scrub; `restoreGuids` puts them back when the LLM's response references the sentinel. **Goose has no PII scrub at all** — every tool result is shipped raw. For an enterprise SDLC tool that touches incidents, work items, and customer logs, this is non-negotiable. The audit lists this as official copy-fork; do it.

**3. Performance-tuned diff viewer with explicit memory discipline.** `MEMORY.md` documents the diff-viewer's perf wins: `content-visibility: auto` on chunks (not lines), `contain-intrinsic-block-size: auto <N>px`, `contain: layout style` (NOT `contain: content` — clips overflow), passive scroll listeners, rAF throttle for minimap, `overflow-anchor: none` to prevent fight with scroll sync, document-level mousemove/mouseup cleanup. Goose's UI doesn't have a comparable diff component (the agent emits markdown, the user clicks "Open in editor"). For a code-review-heavy tool, **TaskDock's diff viewer is a competitive advantage**. Copy-fork to Conductor verbatim.

### 4.4. Three places where the proposed simpler Conductor diverges from BOTH Goose and legacy TaskDock

**1. The agent loop is external — Conductor delegates to Claude Code / Copilot CLI.** Goose runs the loop in its own sidecar (Rust, 2,562 LOC). Legacy TaskDock runs the loop inside service classes that wrap the SDKs (~10k LOC). Conductor runs **no loop at all** — the user's already-installed `claude` or `copilot` CLI runs the loop inside an xterm.js side terminal, configured to talk to Conductor's MCP endpoint. Implications: no provider abstraction layer in Conductor, no token accounting, no compaction logic, no `max_turns` knob. The CLI handles all of it. This is the OpenClaw/Hermes/Continue pattern from `agent-cli-architectures-2026-05-08.md` taken seriously: **the harness shrinks because the CLI does the work**.

**2. Inbox/Signals/Approvals/Artifacts as first-class tables, not derived projections.** Goose's session DB has rows for sessions, messages, threads — but no concept of "user has X items to attend to," "external event Y triggered work," "approval Z is pending," "artifact W lives at this path." Legacy TaskDock fakes the inbox with a SQL filter on tasks and stuffs everything else in JSON files. Conductor commits to four separate tables because the four concepts have **different lifetimes, different access patterns, and different consumers**: `inbox_items` is the user's primary view, `signals` is the scheduler's input, `approvals` is the agent's interrupt, `artifacts` is the run's deliverable. They interact through foreign keys (signal → thread, approval → thread, artifact → thread), which gives a full audit trail.

**3. Drop-folder MCP config that interoperates with Continue/Cursor/Cline.** Goose's `~/.config/goose/config.yaml` extensions block is Goose-proprietary. Legacy TaskDock has no MCP-config UX at all. Conductor reads `.conductor/mcp/*.json` in **the same JSON shape Continue.dev uses for `.continue/mcpServers/*.json`** (see `agent-cli-architectures-2026-05-08.md` Continue.dev entry: "drops Claude-Desktop / Cursor / Cline `mcp.json` files into `.continue/mcpServers/`"). This means: a user who already configured GitHub MCP for Cursor doesn't reconfigure it for Conductor — they `cp` the JSON over. The trade-off is ceding schema control (the format is whatever the MCP-config consortium settles on), but the upgrade is one-config-many-clients, which is exactly the inversion `agent-cli-architectures-2026-05-08.md` recommended.

### 4.5. The single biggest architectural gap between Goose and what Conductor needs — and how to bridge it

**The gap: Goose models *one agent session* as the unit; Conductor needs *durable multi-actor workflows with human checkpoints*.**

Concretely, Goose's `Recipe` is a configuration bundle for one `Agent::reply()` invocation. Sub-recipes are tools the agent can call — they run isolated and return synchronously. There is no concept of "this scenario is paused waiting for user approval at step 3 of 7"; "this scenario fan-out is awaiting 5 of 8 child runs"; "this scenario was triggered by a PR-opened signal at 14:23 and ran for 6 hours then suspended on a code review comment." Goose handles *one of these things* via per-tool `permission` confirmations (`ToolConfirmationRouter` in `agent.rs`), but the abstraction is wrong level — it's a per-tool gate, not a workflow checkpoint. The recipe deep-dive §7.4 lays this out: "Goose recipes are a 70% match for Conductor scenarios — the remaining 30% (state machines, checkpoints, fan-out, cross-scenario events, durable workflow state, approval gates) are Conductor-specific."

**The bridge.** Three additive constructs on top of Goose's recipe shape:

1. **`signals` + `triggers:` (the input side).** Replace cron-only with event-driven. Concrete spec (mirror what's already in `2026-05-01-mc-rewrite-infrastructure-design.md` §2.4 + REVIEW-CONSOLIDATED R6 fix): `triggers: [{ inboxKind: workitem, state: assigned, manualOnly?: bool, filter?: <jsonpath> }]`. The scheduler watches `signals` (rows committed by source plugins) and matches; on match, spawns a thread with the signal's payload as context.

2. **`state_machine:` + `checkpoints:` + `approvals` (the durability side).** Optional section on a scenario that declares stages and explicit transitions. Each stage gets a `StepRecord` row in the DB (reusing the legacy spec's §3.7 vocabulary). A `checkpoint:` activity inside a stage suspends the run — durable across sidecar restart — and writes an `approvals` row. The thread's external CLI sees `approval.request` as a tool call; the user resolves it via the renderer; the CLI's tool result unblocks the `waitForApproval`. **This requires the kernel-side range-event-query primitive R5 calls out** (`ctx.events.queryByStream(stream, { sinceEventId, types? })`) so resumed steps can see all events accumulated since suspension.

3. **`fan_out:` + `parent_thread_id` (the parallelism side).** A scenario can declare `fan_out: { items: <jsonpath_into_signal>, scenario: <child_scenario_name>, max_parallel: 5 }`. The kernel spawns N child threads, each with `parent_thread_id` set; the parent thread sees only aggregated summaries (artifacts collected to `<run>/children/<id>/`), not full transcripts. Cancellation cascades: cancelling parent thread cancels all children with `recursive: true` (REVIEW-CONSOLIDATED R4 fix). This is Goose's `Task` made durable, and gives the spec the tree-cancel semantics walkthrough 04 already assumes.

**Net result.** A trivial scenario stays as small as a Goose recipe (no `state_machine`, no `fan_out`, no `triggers` — it's just `kind`, `instructions`, `extensions`, `parameters`). The 30% Conductor-specific affordances are opt-in fields on the same YAML. Migration of a Goose recipe is mechanical (rename fields, drop the `goose_` prefix). And — critically — **all three additions share one substrate: the `signals` / `events` / `threads` / `approvals` tables.** No bolted-on workflow engine. The kernel is small; the YAML is the surface area.

---

## 5. Sources cited

Primary Goose source files (under `.planning/research/goose-clone/`):
- `crates/goose-server/src/main.rs` (entry)
- `crates/goose-server/src/commands/agent.rs` (HTTP server bind, TLS, secret middleware)
- `crates/goose-server/src/openapi.rs` (`ApiDoc` declaration, lines 383-661)
- `crates/goose-server/src/state.rs` (`AppState` struct)
- `crates/goose-server/src/routes/mod.rs` (route assembly)
- `crates/goose-server/src/routes/{agent,recipe,schedule,session,reply,session_events,mcp_app_proxy,mcp_ui_proxy,config_management,...}.rs`
- `crates/goose/src/agents/agent.rs` (loop, `Agent::reply()` line 1049)
- `crates/goose/src/agents/extension.rs` (Envs::DISALLOWED_KEYS lines 71-86)
- `crates/goose/src/agents/extension_manager.rs` (MCP client lifecycle)
- `crates/goose/src/scheduler.rs` (lines 1-118 read; cron-only scheduler)
- `crates/goose/src/session/mod.rs` + `session_manager.rs` (schema v12 at lines 633-714)
- `crates/goose/src/config/paths.rs` (etcetera-based Block/goose path discovery)
- `crates/goose-cli/src/main.rs` + `cli.rs` (CLI entry, Subcommand enum line 736)
- `ui/desktop/src/main.ts` (Electron main process)
- `ui/desktop/src/goosed.ts` (sidecar spawn, `findAvailablePort` line 25, `findGoosedBinaryPath` line 43)
- `ui/desktop/src/App.tsx` (router, contexts)
- `ui/desktop/src/contexts/{ChatContext,FeaturesContext,ThemeContext}.tsx`
- `ui/desktop/src/api/types.gen.ts` (codegen output)
- `ui/desktop/package.json` (`generate-api`, `lint:check`, `test-e2e` script chain)
- `Justfile` (build orchestration, `generate-openapi` line 197)
- `AGENTS.md` (test/build conventions)

Legacy TaskDock files (referenced through prior audit):
- `src/main/mission-control/mission-control-service.ts` (831 LOC)
- `src-backend/bridge.ts` (1,984 LOC; `DROPPABLE_EVENTS` lines 286-317)
- `src-backend/mcp-server.ts` + `mcp-router.ts` (PII scrub lines 101-145)
- `src/main/plugins/{plugin-loader,plugin-engine,plugin-script-runner}.ts`
- `src/main/terminal/terminal-service.ts` (unified service post-merge)
- `src/main/ai/{ai-provider,claude-provider,copilot-provider,...}.ts`
- `src/renderer/app.ts` + `src/renderer/components/mission-control/`
- `src/main/dgrep/scrub-layer.ts`
- `src/renderer/components/diff-viewer.ts`

Conductor (proposed) sources:
- `conductor/CLAUDE.md` (engineering rules, copy-fork policy)
- `conductor/README.md` (extraction-ready scope)
- `conductor/package.json` (deps, port `5201`)
- `conductor/src/index.ts` (Phase 0 stub)
- `docs/superpowers/specs/2026-05-01-mc-rewrite-infrastructure-design.md` (legacy heavy spec)
- `docs/mockups/mc-rewrite/REVIEW-CONSOLIDATED.md` (22 root issues — R1, R3, R4, R5, R6 cited)
- `docs/mockups/mc-rewrite/AUDIT.md` (mockup design system)
- `.planning/research/legacy-taskdock-audit-2026-05-08.md`
- `.planning/research/goose-deep-dive-2026-05-08.md`
- `.planning/research/agent-cli-architectures-2026-05-08.md` (Continue.dev, OpenClaw, Hermes patterns)

### Items I could not authoritatively verify

- The exact Tauri 2 sidecar startup pattern Conductor will use vs. legacy TaskDock's. Conductor `package.json` has `dev:sidecar` with `tsx watch`, but the prod path is unspec'd.
- Whether Goose's `mcp_app_proxy` could be repurposed as a "drive Goose from outside" surface. The 284 LOC is shaped for the desktop's own UI extensions; would need adaptation. I noted this without claiming it.
- The performance characteristic of `signals`-table polling at 1 s intervals on SQLite. The SQLite + better-sqlite3 stack handles this fine for low-frequency signals, but I did not benchmark.
- Whether `pkg` still works on Node 22+ for the Conductor sidecar. Legacy TaskDock uses it; Node-SEA might be the modern alternative.
- The exact MCP `notifications/keepalive` semantics — the MCP spec has a `progressNotification` but I did not confirm a heartbeat shape equivalent to Goose's SSE `Ping`.
