# Legacy TaskDock Audit (pre-Conductor)

Date: 2026-05-08
Scope: Repo root `src/`, `src-backend/`, `src-tauri/`. Excludes `conductor/`.
Goal: Map the surface area of the legacy orchestrator (MissionControl + plugins + MCP + bridge + AI + renderer + terminals) so the simpler Conductor model can be designed against actual prior art rather than memory.

---

## 1. MissionControlService

File: `src/main/mission-control/mission-control-service.ts` (831 LOC).
Public contract: `IMissionControlService extends EventEmitter` (lines 69-139).

Owned state:
- SQLite (`tasks.db`) at `~/.taskdock/mission-control/`, accessed via `ITasksRepo`.
- Migrations runner with backfill-baseline logic (lines 193-214) for installs predating the runner.
- `Map<TaskType, TaskHandler>` registered post-construction; `Map<taskId, { kill }>` for cancellation.
- On-disk `settings.json` (concurrency cap + default agent).

Public methods grouped:
- **Lifecycle**: `init`, `startRecovery`, `dispose`.
- **Settings**: `getSettings`, `saveSettings`. **DB escape hatch**: `getDb()` for sub-routers.
- **Handler registration**: `registerHandler(type, handler)`.
- **Task CRUD**: `enqueue`, `enqueueIfNotActive` (transactional dedup by `incidentId`/`workItemId`), `updateTask`, `getTask`, `listTasks`, `cancelTask`, `retryTask`, `deleteTasks`.
- **Concurrency engine**: `tryDequeue` (FIFO, capped by `maxConcurrentSessions`), private `executeTask` with `awaiting_input` short-circuit at line 342.
- **Process lifecycle**: `registerProcess`, `getQueuePosition`.
- **Triage helpers**: `isTaskActive`, `getTaskBy{Incident,WorkItem}Id`, `get{Analyzed,Processed}{Incident,WorkItem}Ids`, `getTasksFor{Incident,WorkItem}Ids`, `snoozeTask`.
- **Analytics**: `getDashboardStats(period)`, `getTaskTimeline(taskId)`.
- **Workspace artefacts**: `listWorkspaceArtifacts`, `readWorkspaceFile` (traversal-guarded at lines 605-618), `getTaskIcmSnapshot` (PascalCase->camelCase mapping at lines 706-722).

Crash recovery (lines 724-737) is naive: if a `running` task wrote its `outputPath` it's marked `completed`, otherwise re-queued. `recoverOnStartup()` is deliberately deferred until handlers register (comment at line 184).

The dual-construction-with-singleton (`createX` + `bindXSingleton` + deprecated `getX` + `disposeX`) pattern shows up here and is replicated across **27+ services** (this audit lists most of them). The "testability canon" migration to remove this is still mid-flight.

---

## 2. Plugin system

Three files, ~1,200 LOC total:
- `plugin-loader.ts` — scans `~/.taskdock/plugins/<name>/manifest.json`, persists user config + `_enabled` to `~/.taskdock/plugin-config.json`.
- `plugin-engine.ts` — schedulers, hot-reload (`fs.watch` with 500ms per-plugin debounce, lines 312-334), hook registry (event -> [{pluginId, triggerId, workflow}]), Claude/Copilot SDK callouts on plugin's behalf.
- `plugin-script-runner.ts` — spawns `npx tsx wrapperPath ctxFile respFile` per workflow trigger (lines 94-103). Uses an `AbortController` per execution.

Contract verified (memory was correct):
- Workflows are TypeScript files. The runner generates a wrapper script in `~/.taskdock/plugins/_runtime/run-workflow.ts` that imports the workflow as an ES module (`pathToFileURL`) and provides a `ctx` global with `http`, `shell`, `ai`, `ui`, `store`.
- IPC is **stdout line prefix `__PLUGIN_MSG__:` + JSON** (line 117 of plugin-script-runner; switch cases at lines 200-227). Buffered line-aligned so partial chunks don't corrupt parsing (lines 113-116).
- For host-callbacks (AI prompts, terminal launches) the plugin uses a request/response file dance: writes `req-<id>.json`, sends `host:request` over the prefix channel, polls `res-<id>.json` (100ms x 1200 = 120s timeout, see plugin-script-runner.ts:295-317).
- Triggers come in three kinds: manual, scheduled (cron via `plugin-scheduler.ts`), and **hook** — events are matched against the in-memory `hookRegistry` and fired fire-and-forget at engine.ts:215-225.
- AI calls inside the engine itself: `callClaude` lazy-imports `@anthropic-ai/claude-agent-sdk` per call (line 368), `callCopilot` reuses a long-lived `CopilotClient` and creates+destroys a session per call (lines 380-409).

Cancellation: per-plugin (`runner.cancelPlugin`) and global (`runner.cancelAll`). The engine cancels running workflows before reload (lines 233 + 280).

---

## 3. MCP server / router

Files:
- `src-backend/mcp-server.ts` (329 LOC) — only **two MCP tools** are exposed: `taskdock_get_docs` (returns parameter docs) and `taskdock` (dispatches to a method-name registry).
- `src-backend/mcp-router.ts` (1,407 LOC) — the actual method registry. METHOD_NAMES at lines 129-143:

```
list_prs, get_pull_request, read_file, comment_on_pr, vote_on_pr, review_pr,
query_work_items, update_work_item,
query_incidents, get_incident, act_on_incident,
get_kql_guidelines, search_logs, await_log_results, filter_log_results,
get_settings, get_repos,
fetch_call_flow, filter_call_flow, list_cfv_log_sources, open_cfv_logs,
workspace_create, workspace_list, workspace_get, workspace_delete, workspace_update,
workspace_add_artifact, workspace_refresh_artifact, workspace_analyze,
workspace_read_file, workspace_read_artifact,
screenshot_dashboard,
mdm_list_accounts, mdm_get_dimension_values, mdm_query_metrics, mdm_query_mql, mdm_get_dashboard_metrics,
skill_list, skill_load,
```

Transport: stateless HTTP (`StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`) on the unified HTTP server at `/mcp` (lines 309-328).

Notable: the MCP layer does **bidirectional PII scrubbing** keyed by workspace id or session scope (DGrep session/log id, CFV call id, ICM incident id) — see `getWorkspaceScrubLayer`/`getSessionScrubLayer` and the `protectGuids`/`restoreGuids` dance at mcp-server.ts:101-145. Structural GUIDs (file paths, call IDs) are protected with sentinels before scrub so they stay LLM-usable; data GUIDs inside `rows` arrays get scrubbed.

The MCP tool itself just calls `router.dispatch(method, params)` which calls back into bridge `handleRpc(method, params)` in-process. So **MCP is a thin façade over WebSocket RPC** — there is no separate MCP-only logic.

---

## 4. WebSocket bridge

`src-backend/bridge.ts` is **1,984 LOC**. The actual handler logic has migrated into `src-backend/rpc-handlers/canon/<namespace>/*.ts` — bridge.ts is mostly bootstrap:
1. Service construction (lines 252-454+) — every service has the same pattern: `createX()` factory, then `bindXSingleton(instance)` so the legacy `getX()` callers see the same instance the `ctx.services.x` canon path does.
2. Event forwarding (lines 484-553) — every service emits domain events; bridge subscribes once per service and `broadcast()`s them to all WS clients.
3. WS message router (much later) — routes RPC requests through `rpcDispatch(registry, ctx, method, params)`.

Canon namespaces (30 directories under `src-backend/rpc-handlers/canon/`):
ado, ai, app, apply-changes, auth, auto-process, cache, cfv, cfv-chat, cfv-filter, chat-terminal, comment-analysis, config, console-review, dgrep, dgrep-ai, diag, fix-tracker, git, icm, incident-analysis, logger, misc, mission-control, plugin, presets, push, session, terminal, vault, walkthrough, wi, work-item, workspace, workspace-copilot, workspaces.

The total RPC surface is **hundreds of methods**. Many are pure CRUD or simple service forwards (e.g. `mission-control/list-tasks`, `apply-changes/get-state`). Only ~40 of those are surfaced as MCP methods (the METHOD_NAMES list above).

Backpressure handling (lines 286-317): `DROPPABLE_EVENTS` set + `WS_BACKPRESSURE_BYTES = 4 MB` cutoff. Terminal events use a per-client subscription map (`terminalWatchers`) so high-frequency PTY data only fans out to subscribed clients.

Which RPC handlers could plausibly become MCP tools instead: anything stateless and read-only (the CRUD list/get methods) plus the "act on" verbs. The current MCP method list already covers PRs/work-items/incidents/dgrep/cfv/workspaces; what's NOT exposed today are the orchestration verbs (`mission-control:*`, `auto-process:*`, `incident-analysis:*`, `wi:process-*`) — those still live behind WebSocket and the renderer is the only consumer.

---

## 5. AI provider integration

`src/main/ai/` — 14 services, ~7,000 LOC.
- `ai-provider.ts` defines `IAIProvider` (lines 26-54): `reviewChunk` AsyncGenerator + `generateWalkthrough` Promise + `isAvailable()` + `configure()`.
- Two implementations: `claude-provider.ts` (361 LOC, `@anthropic-ai/claude-agent-sdk` `query()`), `copilot-provider.ts` (457 LOC, `@github/copilot-sdk` `CopilotClient`).
- **Two parallel adapter trees**: `executors/{sdk,terminal,headless}-executor.ts` (which mode runs the agent) and `providers/{claude,copilot,provider}-adapter.ts` (capability-tier adapter for orchestrator). No clear ownership boundary between them.
- Orchestrators: `ai-review-service.ts` (581), `walkthrough-service.ts` (422), `comment-analysis-service.ts` (574), `apply-changes-service.ts` (669), `review-context-service.ts` (1,044), `review-executor-service.ts` (333). Helpers: `fix-tracker-service.ts`, `preset-service.ts`, `ai-storage-service.ts`.

Session lifecycle: `startReview(...)` returns a session id, service emits `progress`/`comment`/`walkthrough`/`error`. Renderer calls `getComments()`/`getWalkthrough()` on completion. Teardown is manual: `removeSession(id)` must be called by the caller; nothing GC's stale sessions.

Reusable: the `IAIProvider` contract, the executor split, the per-session event-emitter shape, the prompt loaders that read vault templates with bundled fallbacks (ai-provider.ts:60-69).

Over-engineered: parallel `executors/` + `providers/` trees; seven event emitters across the AI service tree; the 1,044-line `review-context-service.ts` mostly orchestrates fetches and cache writes (its test file is 68 lines).

---

## 6. Renderer architecture

`src/renderer/app.ts` is a monolithic `class PRReviewApp`. Sections via `SectionSidebar`: `missionControl` (default), PR review, Work Items, ICM, CFV, DGrep, Workspaces, Terminals, About, App Logs, Settings.

Tab system: each section has its own `TabBar` + per-tab state map (`prTabStates: Map<tabId, PRTabState>`, `workItemTabCleanups`, `icmTabCleanups`). Per-tab `AbortController`s manage event-listener cleanup (app.ts:215). Tabs are hidden, not unmounted — state preserved on switch.

Mission Control surface (`src/renderer/components/mission-control/`):
- `mission-control-view.ts` — shell with mode (`incidents`/`workitems`) + view (`dashboard`/`triage`/`list`/`timeline`) + time range (`1h..7d..all`).
- Four views (`mc-{dashboard,triage,list,timeline}-view.ts`) + detail-pane (`mc-detail-tabs.ts`, `mc-copilot-panel.ts`, `mc-splitter.ts`).
- Keyboard shortcuts (mission-control-view.ts:81-92): `1`/`2`/`3`/`4` views, `M` mode, `J`/`K` nav, `A`/`C`/`S`/`D` verbs.

**No real inbox.** The closest is the Triage view — a SQL filter on `MissionControlService.listTasks()` for tasks needing human action (awaiting_input/failed/queued past SLA). The schema has no read/unread/archive/star/mute — only `snoozedUntil`.

Stack: vanilla TS, no framework, custom diff viewer (load-bearing copy-fork per PROJECT.md:25), single SPA bundle with PWA service worker.

---

## 7. Terminal subsystem (post-merge)

Memory note ("regular terminals via `terminalManager`, chat terminals via `chatTerminalService` with separate APIs") is **out of date as of the testability-canon Step 6 merge**. Current state (`src/main/terminal/`):

- `terminal-service.ts` (the unified service) — `TerminalService` with a discriminated-union `spawn(opts)` where `opts.mode: 'completion' | 'interactive'` (lines 108-118).
- `terminal-manager.ts` is now a **deprecated alias file** (~65 lines) — `export type TerminalManager = TerminalService` and `getTerminalManager() { return getTerminalServiceSingleton() }`. The old `chat-terminal-service.ts` was deleted entirely (see header comment).
- The two modes share the same `@lydell/node-pty` spawn, shell detection, exit handling, and Windows-specific kill-tree logic. They differ in what happens **after** spawn:
  - **Completion mode**: spawn a CLI, watch for a `*.done.json` completion file (300ms debounce, polling because Windows fs.watch misses creation events for non-existent files — see lines 56-61), emit `review-complete` event. Lifecycle = run-to-completion. Used by AI review executors.
  - **Interactive mode**: long-running session with a 256 KB scrollback buffer (line 50) for late-attaching renderers, 10 s grace before deletion after exit (line 53). Used by orchestrator chat panels.
- Wire-event names preserved for backwards compat: bridge.ts:507-538 routes the same singleton's events to either `terminal:*` or `chat-terminal:*` depending on `event.mode`.

The renderer still has a `TerminalsView` component but the legacy two-API split was hidden inside `terminal-manager.ts`. The frontend just sees one socket-event family per mode.

---

## 8. What's documented as painful

From `.planning/PROJECT.md` (Conductor, same repo, `feature/mission-control-redesign` branch):

> "the existing TaskDock orchestrator (MissionControlService + LoopController + AutoProcessService + assignment-watcher-as-orchestrator) is tightly coupled and non-extensible." — line 142

Specific replacements:
1. **No event store** — legacy has only the denormalised tasks table; no replay, no audit trail.
2. **No durable suspension** — `scheduledTimers: Map<string, Timeout[]>` on LoopController doesn't survive sidecar restart.
3. **No declarative routing** — `AutoProcessService` (527 LOC) is a hand-rolled poller per source type.
4. **No capability gating** — plugins have full `ctx.shell.run()` via raw `exec()` (plugin-script-runner.ts:359), no allowlist.
5. **No hierarchy** — single `~/.taskdock/` per user vs Conductor's 6-scope HierarchyResolver.
6. **Polling-only** — `AssignmentWatcherService` polls every 60s with progressive backoff (assignment-watcher-service.ts:18); no webhook, no per-source signal subtypes.
7. **Inbox missing** — Triage is a SQL filter; only `snoozedUntil` field.
8. **Parallel session models** — MC tasks have `sessionId`/`workspaceId`; AI services have their own `Map<sessionId, Session>`. No unified Sessions projection.

From feedback memory:
- `feedback_no_arbitrary_agent_cutoffs.md` — Conductor removes wallclock/token budgets; cancel-cascade is the only kill (legacy LoopController has ad-hoc per-step timeouts).
- `feedback_reuse_existing_infra.md` — explains the long PROJECT.md copy-fork list.
- D-19 added dev-mode AutoPolicies + minimal workflows for WI/incident/epic — the legacy MC had no generic workflow grammar.

---

## Synthesis

### What's worth keeping (copy-fork candidates)

Per PROJECT.md the following patterns are already on the official copy-fork list, all of which I verified are reasonably contained:
- HTTP MCP server pattern from `src-backend/mcp-server.ts` (329 lines, isolated, scrub-layer integration is the load-bearing piece).
- Unified terminal service from `src/main/terminal/terminal-service.ts` post-merge (one file, two modes via discriminated union, ~700 LOC).
- `src/main/ado-api.ts` (token cache + 429 backoff + pagination) — verified consumed by both AssignmentWatcher and AutoProcessService, well-isolated.
- `src/main/services/auth-manager.ts` — keychain-backed auth store.
- `src/renderer/components/diff-viewer.ts` — performance-tuned (see MEMORY.md "Performance (diff-viewer)" section: content-visibility on chunks, contain-intrinsic-block-size, will-change, overflow-anchor, passive scroll, rAF throttle).
- `src/main/ai/walkthrough-service.ts` JSON output schema — the prompt+schema design is reusable even if the orchestration layer isn't.
- `src/main/mission-control/assignment-watcher-service.ts` polling-cadence + dedup pattern (tiny, 359 lines, clean dedup-by-id approach).
- `src/main/plugins/plugin-loader.ts` + `plugin-scheduler.ts` — manifest scan + cron scheduler are isolated and reusable. The script-runner's stdout-prefix IPC is also reusable but Conductor will likely sandbox it more heavily.
- Migrations runner (`src/main/migrations/runner.ts`) and the `_migrations` bookkeeping table.

Worth keeping but with surgery:
- The PII scrub layer (`src/main/dgrep/scrub-layer.ts` referenced from mcp-server.ts:19) — the structural-vs-data GUID distinction is the right idea, but the per-scope cache management is fiddly.
- The keyboard-shortcut model from `mc-list-view`/`mission-control-view` (J/K nav, single-letter verbs) — the implementation is OK; what's missing is the engagement model behind it.

### What's complexity that didn't pay off

1. **The dual-construction-with-singleton pattern.** Every service has `createX(deps?)` + `bindXSingleton(s)` + deprecated `getX()` + `disposeX()`. PluginLoader, PluginEngine, MissionControlService, AIReviewService, ReviewContextService, ReviewExecutorService, WalkthroughService, ApplyChangesService, FixTrackerService, CommentAnalysisService, WorkspaceService, WorkspaceShadowService, WorkspaceBuilder, CfvService, CfvChatService, CfvFilterService, DGrepService, DGrepAIService, KnowledgeRepoService, VaultService, OrchestratorLoggerImpl, UpdateService, AuthManager, DiagnosticsService, WebPushService, WorktreeService — **all** carry this triple. The "testability canon" was a multi-step migration to fix that and is still mid-flight. Conductor should pick one shape (constructor injection through a registry) and stop.
2. **Two parallel adapter trees in `src/main/ai/`.** `executors/` (sdk/terminal/headless) and `providers/` (claude-adapter/copilot-adapter/provider-adapter) — there's no clear ownership boundary between them; both contain "configure provider X for review job Y" logic.
3. **MissionControlService doing 9 unrelated things.** Task queue + concurrency engine + workspace artefact reader + ICM YAML mapper + dashboard stats aggregator + timeline event builder + crash-recovery + settings store + process-handle book — this is a god-object. The Conductor split (kernel + projections + workspace + memory) is the right corrective; the legacy file is a counter-example to follow.
4. **MCP and WebSocket exposing two views of the same registry.** Today MCP wraps about 40 of ~hundreds of RPC methods, hand-curated in METHOD_NAMES. The list is brittle: every new RPC needs a router entry to be visible to agents. Conductor's "MCP-first ToolHost" is the inversion — define tools once, route them to MCP and (optionally) the renderer.
5. **AutoProcessService.** 527 LOC of polling-with-rules-with-backoff for 4 source types, persisted to `auto-process-rules.json`. The rule schema is hand-rolled, the diff-by-id approach is per-source. AutoPolicy YAML in Conductor replaces all of it.
6. **The plugin host-request file dance.** Writing `req-<id>.json` and polling for `res-<id>.json` at 100ms intervals is fragile (and slow under load — average half-interval = 50ms latency per call). It exists only because the spawned `npx tsx` child can't easily speak the WS protocol back. A direct stdio JSON-RPC channel between host and child would be cleaner.
7. **The 1,984-line bridge.ts.** Bootstrap + service wiring + event forwarding + WS connect/disconnect + autoreview pipeline. The "canon" migration extracted RPC handlers to `rpc-handlers/canon/`, but bridge.ts kept the bootstrap monster.

### Lessons that should constrain the new design

1. **Crash-recovery is the floor, not aspirational.** Legacy recovery (mission-control-service.ts:724-737) only knows "marked completed" vs "re-queue whole task." No concept of mid-step state. Event-sourced kernel + durable suspension is the minimum viable design for any system that calls long-running CLIs.
2. **WS backpressure matters.** DROPPABLE_EVENTS + 4MB threshold (bridge.ts:286-317) exists because DGrep/AI/MC live events knock browsers over. Make per-view AbortController subscriptions first-class.
3. **`fs.watch` is unreliable on Windows for not-yet-existing files** — terminal-service.ts:60-61 polls instead. Any file-based IPC in Conductor needs to know this.
4. **Per-element listeners leak across re-renders.** MEMORY.md note about DiffViewer event delegation + `eventListenersAttached` flag echoes the renderer's `tabEventListeners: Map<string, AbortController>` pattern. Default to delegation + tracked controllers.
5. **Hot-reload-mid-run is a footgun.** Plugin engine cancels running workflows on file change (engine.ts:233+280). This is right, but it's also why Conductor's RunStarted snapshot pinning (HIER-10) matters — otherwise editing a workflow mid-run produces inconsistent steps.
6. **Process-tree kill on Windows requires `taskkill /T`.** Cancellation that only kills the parent leaves orphaned `npx tsx`/`claude.exe` children. terminal-service.ts has this — preserve it on copy-fork.
7. **`~/.taskdock/` sprawl: six stores, three formats** (`settings.json`, `plugin-config.json`, `processed-assignments.json`, `auto-process-rules.json`, `tasks.db`, workspace YAMLs). Conductor's `${workspace}/.taskdock/{kernel.db, settings.yaml, ...}` consolidation (PROJECT.md:184) is correct.
8. **`app.ts` grows without bound** — every section adds a field to `PRReviewApp`. ViewRenderer registry + per-kind itemViews manifest must ship in slice 1, not retrofit.
9. **`feedback_reuse_existing_infra.md` needs guard rails.** Copy-forking utilities is fine; copy-forking `MissionControlService` would import the god-object tech debt. The PROJECT.md "Code-fork sources" list is the right granularity — clean slices only, orchestration core stays new.
