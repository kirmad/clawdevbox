# Lifecycles — How MCP-managed objects flow through clawdevbox

The per-tool docs in [`docs/tools/`](./tools) describe each MCP tool family in
isolation: every parameter, every error code, every disk write. This document
is the cross-cutting view. It traces five objects — **triggers**, **recipe
instances**, **inbox items**, **artifacts**, and **CLI terminal sessions** —
from the moment they are conceived (a plugin manifest, an agent call, a button
tap) to the moment they vanish (a `delete` tool, an `rm -rf` folder, an
`EXIT_RETAIN_MS` timeout). Every state in the lifecycle is annotated with the
exact MCP tool or HTTP endpoint that drives the transition and every side
effect (file write, SSE topic, push fire, in-memory registry mutation) is
called out.

Read this when you want to answer "what happens to this thing from creation to
garbage". For the precise mechanics of any individual tool call, the per-tool
doc is still the canonical reference; this doc deliberately summarises and
points the reader at the right section.

---

## Object overview

| Object | Created by | Lives in | Mutated by | Killed by | TTL |
|---|---|---|---|---|---|
| Trigger TYPE | `plugin.install` (plugin author authors `provides.trigger_types[]` in `plugin.yaml`) | `ws.triggerTypes: Map` (in-memory, populated at workspace boot) | only `plugin.install` / `plugin.update` | `plugin.uninstall` / `plugin.disable` | as long as the plugin is installed + enabled |
| Registered trigger | `trigger.register` | `<projectDir>/.clawdevbox/triggers.json` (one row in `registered[]`) | `trigger.update_params`, `.enable`, `.disable` | `trigger.unregister` (manual). **Orphaned** — never auto-removed — on `plugin.uninstall`. | forever, unless `expires_at` is set (not enforced today — see Known gaps) |
| Recipe (YAML) | `recipe.upsert` | project/global on disk (`<projectDir>/.clawdevbox/recipes/<id>.yaml` or `<globalDir>/recipes/<id>.yaml`) or plugin-shipped read-only | `recipe.upsert` (overwrite). Plugin scope is read-only. | `recipe.delete`. Plugin recipes are removed by uninstalling the plugin. | forever |
| Recipe instance | `recipe.run` (or `POST /api/recipes/<id>/resume`) | `<workspace>/.clawdevbox/recipe-instances/<id>.json` (status row) + `.log` (terminal capture) + `.script.cjs` for echo-stub | `recipe.done` (from inside the spawn) · `recipe.kill` · pty `onExit` handler · `inst.steps[]` writes by the agent | `recipe.kill` (sets `cancelled`) or the agent calling `recipe.done` or the pty exiting | row + log are on disk forever (no GC) |
| Inbox item | `inbox.upsert` | `<globalDir>/inbox.json` (metadata) + `<globalDir>/inbox-bodies/<safe-id>.<md|txt>` (body sidecar) | `inbox.upsert`, `inbox.set_state`, `inbox.snooze`, `inbox.archive`; HTTP `POST /api/inbox/<id>/{done,archive,state,snooze}` | no terminal-state tool removes the row. `archived` and `done` are terminal but the row stays on disk forever. | forever (no GC) |
| Artifact | `artifact.add` | `<workspace>/artifacts/<id>/` — `manifest.json` plus content files | `artifact.add` (re-add merges manifest, overwrites named files) | `artifact.delete` — `rm -rf` the folder; no cascade | forever, until explicitly deleted |
| CLI terminal session | `pty.spawn(...)` inside `recipe.run` (or the resume HTTP handler) | in-memory `sessions: Map` in `pty-registry.ts`; on-disk log mirror at `<workspace>/.clawdevbox/recipe-instances/<id>.log` | pty `onData` (writes ring buffer + log) · `subscribe()` (browser viewers) · `writeToPty`/`resizePty`/`killPty` | pty `onExit`. The session is retained `EXIT_RETAIN_MS = 10_000ms` after exit for late attaches, then `sessions.delete(instanceId)`. | live: until exit. archived log: forever. |

---

## State diagrams

Each diagram below uses the same conventions:

- `[state]` — a state the object can be in.
- `--tool / event-->` — the MCP tool, HTTP endpoint, or implicit event that
  drives the transition. Side effects of that transition (file writes, SSE
  emits, push fires, registry mutations) are listed underneath.
- `(*)` — the initial state (where birth happens).
- `[X]` — a terminal state.
- A dotted arrow `····>` denotes a transition that is documented in the spec
  but not yet implemented in code (see [Known gaps](#known-gaps)).

---

### 1. Trigger

```
                        +--------------------------+
   plugin author        | (uninstalled / undefined)|
   writes plugin.yaml   +-----------+--------------+
                                    |
                                    | plugin.install
                                    | (clones into <globalDir>/plugins/<id>/)
                                    v
                        +--------------------------+
                        | TYPE on disk             |   side effect: <globalDir>/plugins/<id>/plugin.yaml
                        | (not yet loaded)         |
                        +-----------+--------------+
                                    |
                                    | workspace boot:
                                    | reloadPluginRegistry()
                                    v
                        +--------------------------+
                        | TYPE in ws.triggerTypes  |  collisions go to ws.triggerTypeErrors
                        +-----------+--------------+
                                    |
                                    | trigger.register(type_id, params)
                                    |   - validateTriggerParams
                                    |   - normalizeCron
                                    |   - mintRegisteredId
                                    |   - file write + emitChange('triggers')
                                    v
        +--------------+    trigger.disable     +--------------+
        | registered   |---------------------->| registered   |
   (*)  | enabled=true |<----------------------| enabled=false|
        +-----+--------+    trigger.enable     +--------------+
              |
              | trigger.update_params(params? cron?)
              |  - re-validates against TYPE
              |  - id NEVER re-minted
              v (same state)
              |
              | trigger.fire(payload?)
              |   - logger.info('trigger.fire queued')
              |   - mintId('run') -> run_id
              |   - NO webhook posted, NO last_run_* mutated
              | (no state change today)
              |
              | trigger.unregister
              |   - row removed from triggers.json
              |   - emitChange('triggers')
              v
        +--------------+
   [X]  |   removed    |
        +--------------+

Orphan branch:
   plugin.uninstall  -->  TYPE leaves ws.triggerTypes
                          but the registered row STAYS in triggers.json
                          with type_exists: false in the projected view.
                          Still mutable via trigger.disable, .unregister,
                          .update_params({cron}). Param updates fail with
                          TRIGGER_TYPE_NOT_FOUND because the schema is gone.
```

**Walkthrough.**

1. A plugin author declares a TYPE under `provides.trigger_types[]` in their
   `plugin.yaml`. The TYPE carries `id`, `parameters[]`, `default_cron`,
   `identity_param`, and exactly one of `binds_callback_to_recipe` (run a
   recipe when fired) or `binds_callback_to: 'thread_resume'` (wake a hot
   thread).
2. `plugin.install <source>` clones the plugin into
   `<globalDir>/plugins/<id>/`. The TYPE is now on disk but unknown to the
   running server.
3. At the next workspace boot, `reloadPluginRegistry()` in
   `mcp-server/src/workspace.ts` walks `<globalDir>/plugins/*/plugin.yaml`,
   validates each manifest, and populates `ws.triggerTypes` from every
   **enabled** plugin sorted by id. ID collisions are recorded in
   `ws.triggerTypeErrors` (first plugin wins) and surfaced through
   `trigger.list_types`'s `load_errors` array.
4. The agent calls `trigger.register({ type_id, params, ... })`. The handler
   validates params against the TYPE schema (defaults filled in, required
   params enforced), normalises `cron` via `normalizeCron`, and mints the id:
   `<type_id>#<encodeURIComponent(identity_param value)>` if the TYPE declares
   `identity_param`, otherwise `<type_id>#<sha256(sorted params)[:8]>`. The
   row is appended to `<projectDir>/.clawdevbox/triggers.json` through
   `writeFileAtomic` and `emitChange('triggers')` fires. Every connected SPA
   tab re-fetches `/api/triggers` and re-renders.
5. The row may then be `trigger.enable`d / `trigger.disable`d (pure metadata
   flips) and `trigger.update_params`-ed (`params` and/or `cron`; the id
   stays stable even when an identity param changes — by design).
6. `trigger.fire(id)` is the **manual** entry point. Today it does only this:
   `logger.info({ triggerId, runId, payload }, 'trigger.fire queued')` and
   returns `{ run_id: 'run_<rand36>', status: 'queued' }`. **No webhook is
   posted, no script is executed, no `last_run_*` field is mutated.** The
   in-process cron daemon that should call this on schedule does **not exist
   yet** — see [Known gaps](#known-gaps).
7. `trigger.unregister` removes the row and fires `emitChange('triggers')`.
   That's the only deletion path.
8. **Plugin uninstall orphans rows.** `plugin.uninstall` removes the TYPE
   from `ws.triggerTypes` but never touches `triggers.json`. The orphan row
   survives. `projectRegistered` flags it `type_exists: false`. It can still
   be `disable`d, `unregister`ed, and even
   `trigger.update_params({ cron: false })`-ed (the cron-only path skips the
   TYPE schema lookup), but any `params` update fails with
   `TRIGGER_TYPE_NOT_FOUND`.

**Cross-link.** Every TYPE carries either a `binds_callback_to_recipe: <id>`
field or `binds_callback_to: 'thread_resume'`. When the cron daemon lands, a
fire on a `binds_callback_to_recipe` trigger will be expected to spawn that
recipe per fire (via something equivalent to a server-side `recipe.run`).
Today, that bridge does not exist.

---

### 2. Recipe instance

```
       (recipe YAML on disk, written by recipe.upsert)
                          |
                          | recipe.run(id, prompt, ...)
                          |   - resolveRead(scope='all') for the recipe YAML
                          |   - resolve/create workspace
                          |   - mint instance_id  (ri_<base36>_<4hex>)
                          |   - mint session_id   (cdb_<base36>_<4hex>)
                          |   - write <workspace>/.mcp.json
                          |   - writeRecipeInstance(status='running', pid=null)
                          |       -> emitChange('recipes')
                          |   - pty.spawn(...) + registerPty(...)
                          |   - writeRecipeInstance({...current, pid})
                          v
              +-------------------------+
         (*)  |  status = 'running'     |<-----------+
              |  pid set                |            |
              +----+--+---+--------+----+            |
                   |  |   |        |                 |
   recipe.done     |  |   |        |  recipe.kill    |
   (status=...)    |  |   |        |   - killPty     |
        +----------+  |   |        |   - rewrite     |
        |             |  pty.onExit|     status='cancelled'
        |             |  (exitCode)|     - emitChange('recipes')
        |             |   |        +-----+
        v             |   |              |
+------------------+  |   v              v
| status='success' |  |  +-------------------------+
+------------------+  |  | status='cancelled'      |  [X]
| status='failure' |  |  +-------------------------+
+------------------+  |
| status='cancelled'  |  side effect of recipe.done:
|  (agent self-cancel)|  - readRecipeInstance + merge
|                  [X]|  - writeRecipeInstance({status, completed_at, result, message})
+------------------+--+  - emitChange('recipes')
                      |
                      |  pty.onExit when current.status === 'running':
                      |   - exit code 0 -> 'success' (msg: 'no recipe.done call; treating as success')
                      |   - non-zero    -> 'failure' (msg: 'agent exited with code N')
                      |   - signal !=0  -> 'failure' (msg: 'agent exited via signal N')
                      |   - emitChange('recipes')
                      |  pty.onExit when current.status !== 'running':
                      |   - skip (preserve recipe.done's authoritative status)

Pause sub-state (within 'running'):
   agent writes inst.steps[] with a step status='awaiting_user' + prompt
   -> emitChange('recipes')
   -> SPA shows a sticky banner; no MCP tool drives unpause, the agent
      itself decides when to advance the step.

Child sub-state (within 'running'):
   agent calls recipe.run again (today: without parent_recipe_instance_id —
   recipe.run does not accept that param). The child gets its own instance
   row in its own workspace. The /api/recipes endpoint walks every workspace,
   reads parent_recipe_instance_id from each row, and builds a `children`
   array per parent — so the SPA renders a tree even though recipe.run does
   not set the parent field today. [†]

Resume branch:
   POST /api/recipes/<id>/resume  (HTTP, not MCP)
     - look up source instance, read session_id + agent_cli + workspace_path
     - mint NEW instance_id, REUSE session_id
     - writeRecipeInstance(new_id, status='running', resume_of=source_id)
     - pty.spawn copilot.exe --resume=<session_id> --allow-all-tools
                  --additional-mcp-config @<.mcp.json>  (INTERACTIVE, no -p)
     - registerPty(new_instance_id, ...)
     - new pty session, same agent-CLI conversation state
```

[†] `RecipeInstance.parent_recipe_instance_id` is declared in
`recipe-instances-store.ts:83` and consumed by the HTTP `/api/recipes` handler
in `cli/start.ts:386–414`, but the `recipe.run` tool surface does **not**
accept a `parent_recipe_instance_id` argument today (only `attach_to_inbox_item_id`,
`workspace_id`, `session_id`, `resume_of`). A nested run will produce a child
row whose `parent_recipe_instance_id` is `undefined`. See
[Known gaps](#known-gaps).

**Walkthrough.**

1. **Authoring.** `recipe.upsert({ id, scope: 'project' | 'global', source })`
   validates the YAML body via `validateRecipeSource` (id syntax, required
   `name`/`description`, step graph integrity), enforces `parsed.id ===
   args.id` (`ID_MISMATCH`), and writes through `writeFileAtomic`. **No SSE
   event** fires — `recipes` is not in the change-bus topic list for
   upserts; only `RecipeInstance` writes emit `recipes`.
2. **Spawn (the long path).** `recipe.run({ id, prompt, agent_cli?,
   session_id?, resume_of?, workspace_id?, attach_to_inbox_item_id?,
   params? })`:
   - `resolveRead(ws, 'all', 'recipe', id, recipePath)` walks project →
     every enabled plugin (sorted by id) → global. First hit wins. The
     `hit.source` is held in memory — the spawned instance will store a
     verbatim YAML snapshot.
   - Workspace: explicit `workspace_id` → `getWorkspace(...)`; otherwise
     `createWorkspace({ inherit_plugins: true, callerProjectDir })` mints a
     fresh `ws_<base36>_<4hex>` workspace under
     `<workspacesRoot>/<id>/` and scaffolds `.clawdevbox/{recipes,skills,
     recipe-instances,triggers.json,workspace.json}`.
   - Ids: `instanceId = mintRecipeInstanceId() = ri_<base36>_<4hex>`.
     `sessionId = args.session_id ?? 'cdb_' + instanceId.slice(3)`. Both
     are passed explicitly to the spawned CLI so the UI can offer a
     deterministic Resume later.
   - **`.mcp.json` write.** `<workspace>/.mcp.json` lists this MCP server
     as `clawdevbox` with a per-spawn `CLAWDEVBOX_MCP_SECRET` (random
     16-byte hex), the project/workspace/instance/workspaces-root envs,
     the optional `CLAWDEVBOX_MCP_URL`, and the ADO envs if set.
     Written with `writeFileAtomic`.
   - **Instance row, pre-spawn.** `writeRecipeInstance(ws.path, {
     status: 'running', pid: null, recipe_snapshot: hit.source, prompt,
     session_id, resume_of, started_at: Date.now() })` writes
     `<workspace>/.clawdevbox/recipe-instances/<instanceId>.json` and
     fires `emitChange('recipes')`. Doing this **before** the pty spawn
     guarantees a row on disk even if `pty.spawn` throws.
   - **pty.spawn.** Branches per `agent_cli`:
     - `echo-stub` — writes a synchronous CommonJS script to
       `<id>.script.cjs` that creates a markdown artifact and rewrites the
       instance to `status: 'success'`. Spawned as `process.execPath
       <script>`.
     - `copilot` (default) — `copilot.exe --name=<sessionId>
       --allow-all-tools --additional-mcp-config @<mcpConfigPath> -p
       <prompt>` (or `--resume=<sessionId>` if `isResume`). Binary
       overridable via `CLAWDEVBOX_COPILOT_PATH`.
     - `claude` — `claude --session-id <sessionId> -p <prompt>` (or
       `--resume <sessionId>`). Routed through `cmd.exe /d /s /c claude
       ...` on Windows so `PATHEXT` resolves `claude.cmd`.
     On any throw, the instance is rewritten with `status: 'failure'`,
     `message: 'spawn failed: <error>'`, and `SPAWN_FAILED` is returned.
   - **Pty registry.** `registerPty({ instanceId, workspaceId, cols: 120,
     rows: 30, ipty })` stores the IPty in the in-memory `sessions: Map`
     under `instanceId`. The registry hooks `onData` to maintain a 256 KiB
     ring buffer and broadcast to subscribers, and hooks `onExit` to flush
     a final event and schedule `sessions.delete(instanceId)` after
     `EXIT_RETAIN_MS = 10_000` ms.
   - **Per-spawn hooks (separate from the registry hooks).** `recipe.run`
     additionally hooks `ptyProc.onData(d => logStream.write(d))` writing
     to `<workspace>/.clawdevbox/recipe-instances/<id>.log` (`flags: 'a'`)
     and `ptyProc.onExit(({ exitCode, signal }) => { ... })` which re-reads
     the instance row and rewrites status **only if** `current.status ===
     'running'` (preserving any earlier `recipe.done` or `recipe.kill`).
   - **Re-read before stamping pid.** Echo-stub can complete before
     `pty.spawn` returns to JS. The handler re-reads the row and merges
     `pid` onto whatever is there now, never clobbering a fast-completing
     `status: 'success'`.
3. **Live.** The agent CLI runs in the pty. Every chunk of stdout flows
   into:
   - the registry's ring buffer (256 KiB rolling, in memory),
   - the disk log (`flags: 'a'`, append-mode so re-attachers don't
     truncate),
   - and every current `subscribe(...)` callback (browser WS viewers,
     `recipe.view_url`).
4. **Steps.** Optional. The agent can write `inst.steps[]` rows into the
   instance JSON itself. Each `writeRecipeInstance` emits
   `emitChange('recipes')`, the SPA refreshes, and the stepper updates.
   A step with `status: 'awaiting_user'` and a `prompt` shows up as a
   sticky banner in the SPA.
5. **Child spawn.** The agent inside the pty can call `recipe.run` again
   over its `.mcp.json`-routed MCP. The child runs in its own workspace
   under its own instance id. There is no `parent_recipe_instance_id`
   tool param today — see [Known gaps](#known-gaps) — so the SPA's tree
   rendering only works if the child row is written with that field set
   by some other mechanism (e.g. a custom skill that patches its own row).
6. **Completion.** Three terminal paths:
   - The agent calls `recipe.done({ status: 'success'|'failure'|'cancelled',
     result?, message? })`. The handler reads
     `CLAWDEVBOX_RECIPE_INSTANCE_ID` + `CLAWDEVBOX_WORKSPACE_ID` from
     `process.env`, finds the row, merges `{ status, completed_at, result,
     message }`, writes via `writeFileAtomic`, and fires
     `emitChange('recipes')`. **This is the only env-gated tool in the
     family** — the spawned agent cannot mark a different instance done
     by accident.
   - The pty exits naturally. The `onExit` handler reads the row; if
     `status === 'running'` it derives the new status from `exitCode` and
     `signal`. Exit code 0 with no signal → `success` (with the
     breadcrumb message `'(no recipe.done call; treating as success)'`).
     Anything else → `failure`. **The pty `onExit` never writes
     `cancelled`** — that label is reserved for explicit cancellation.
   - `recipe.kill({ id?, signal? })` calls `killPty(id, signal)` and then
     scans every workspace for the running instance with that id,
     rewriting it `status: 'cancelled'`, `message: 'Cancelled via
     recipe.kill'`. **The only path to `cancelled` is `recipe.kill`** (or
     the agent self-cancelling via `recipe.done({ status: 'cancelled' })`).
7. **Resume.** Resume is **not** an MCP tool — it's an HTTP endpoint:
   `POST /api/recipes/<original-instance-id>/resume`
   (`cli/start.ts:898–1127`). It looks up the source instance, reads its
   `session_id`, mints a **new** `instanceId` but reuses the **same**
   `session_id`, writes a fresh `RecipeInstance` row with
   `resume_of: <source-id>`, and `pty.spawn`s the agent CLI with
   `--resume=<session_id>` (Copilot) or `--resume <session_id>` (Claude),
   **interactive** — no `-p <prompt>` is passed. The user lands in the
   running terminal via the SPA's xterm viewer and types directly. The
   new pty session is its own registry entry under the new instance id;
   the old instance is unchanged (its `status` stays as whatever it had
   finished as).
8. **Post-mortem.** Even after the pty exits and `sessions.delete(id)`
   runs, the on-disk `<workspace>/.clawdevbox/recipe-instances/<id>.log`
   persists. `terminal-server.ts:attachWebsocket` detects
   `!hasSession(id)` and serves the archived log as a one-shot snapshot
   via `readArchivedTerminalLog(instanceId)` — see [section 5](#5-cli-terminal-session).

---

### 3. Inbox item

```
                       inbox.upsert(id, kind, source, ...)
                                |
                                |  - write body sidecar (if description supplied)
                                |    via writeInboxBody(globalDir, id, body, format)
                                |  - merge patch into items map
                                |  - saveInboxToDisk(globalDir, items[])
                                |  - emitChange('inbox')
                                |  - if shouldPush: sendNotification(...)
                                v
                       +----------------+
                  (*)  |  state='new'   |
                       +-------+--------+
                               |
                               | inbox.set_state(state='open')  (typically by SPA on first view)
                               | OR  POST /api/inbox/<id>/state
                               v
                       +----------------+
              +--------|  state='open'  |--------+
              |        +-------+--------+        |
              |                |                 |
              |  inbox.snooze  |  inbox.archive  | inbox.set_state(done)
              |  (until > now) |  OR set_state   | OR POST /api/inbox/<id>/done
              v                v                 v
       +-------------+   +-------------+   +-------------+
       | 'snoozed'   |   | 'archived'  |   |   'done'    |
       | snoozed_    |   |             |   |             |
       | until set   |   |    [X]      |   |    [X]      |
       +------+------+   +-------------+   +-------------+
              |
              | inbox.set_state(state='open')  (user un-snoozes manually)
              | ····> auto-wake when now > snoozed_until: NOT IMPLEMENTED
              v
              (back to 'open')

Every transition (every state-touching tool/HTTP verb):
   - mutates items[] in InboxStore
   - saveInboxToDisk(globalDir, items[])  (atomic; writes inbox.json)
   - emitChange('inbox')  -> SSE topic 'inbox' -> SPA re-fetches /api/inbox

Body sidecar:
   inbox.upsert  description=""       -> deleteInboxBody (removes .md + .txt)
                 description=<non-empty> -> writeInboxBody (writes new + DELETES
                                            opposite-format sidecar)
                 description omitted   -> sidecar untouched
                 description_format flip without new description ->
                                          re-read in old format, write in new,
                                          delete old, update description_size

Cross-links (set at upsert, never auto-updated):
   attachments[].artifact_id       -> artifact via findArtifact
   recipe_instance.id              -> recipe instance row
   trigger_id                      -> registered trigger row
```

**Walkthrough.**

1. **Birth.** Any code that wants to surface something to the user calls
   `inbox.upsert({ id, kind, source, title?, preview?, description?,
   description_format?, attachments?, recipe_instance?, trigger_id?,
   labels?, agent_message?, agent_tone?, notify? })`. The handler runs four
   things, in order:
   - **Body sidecar first.** If `description === ''`, `deleteInboxBody`
     removes both `.md` and `.txt` siblings (idempotent). If
     `description !== ''`, `writeInboxBody(globalDir, id, body, format)`
     writes atomically to
     `<globalDir>/inbox-bodies/<safeBasename>.<md|txt>` and **also deletes
     the opposite-format sidecar** so a markdown↔text flip never leaves
     orphans. `safeBasename = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0,
     200)`. `descriptionSize = Buffer.byteLength(body, 'utf8')`.
   - **Format-only flip.** `description_format` supplied without
     `description` triggers a re-read in the old format, a write in the
     new format, deletion of the old file, and an updated `description_size`.
   - **Patch merge.** A `Record<string, unknown>` patch is built that
     contains **only** the fields the caller sent. `InboxStore.upsert(id,
     kind, source, patch)` spreads the patch over the existing row (or
     creates a fresh one with `state: 'new'`, `created_at`, `updated_at`).
     The merge formula is `{ ...existing, ...patch, kind, source,
     updated_at: now }` — note `kind` and `source` are **always**
     overwritten, even if you didn't intend to change them.
   - **Persist.** `saveInboxToDisk(globalDir, items[])` writes the entire
     items array to `<globalDir>/inbox.json` atomically (tempfile + rename).
     `emitChange('inbox')` fires.
2. **Push.** If `shouldPush` is true (default: only on creation;
   `notify: true` forces on update, `notify: false` always skips):
   - Read both `<projectDir>/.clawdevbox/config.json` and `<globalDir>/config.json`
     via `loadNotificationsConfig({ projectDir, globalDir })`. Project
     layer wins.
   - If `enabled !== true` or `vapid === null`: return `push: null,
     push_error_code: 'NOTIFICATIONS_DISABLED'`. SSE still fired earlier.
   - Else: build `{ title: item.title || `New ${kind}`, body:
     preview→agent_message→`${source} · ${id}` (clipped to PUSH_BODY_MAX
     = 120), tag: `inbox:${id}`, url: '/' }` and call `sendNotification`.
     Walks every device in `<globalDir>/push-subscriptions.json`, encrypts
     with VAPID, posts to FCM/Mozilla/APNs, prunes 404/410 endpoints. The
     `{ attempted, delivered, pruned, errors }` count is returned verbatim
     in `structuredContent.push`.
3. **SPA discovery.** The home-page tab is subscribed to SSE `inbox`.
   Re-fetches `/api/inbox` → `enrichInboxItemsForList(items, projectDir,
   workspacesRoot)` resolves every `attachments[].artifact_id` via
   `findArtifact` (which searches the project dir + every registered
   workspace), annotates each attachment with `view_url:
   /artifact/<artifact_id>` and `resolved: true/false`, and returns the
   enriched list. The SPA renders the new card at the top of the list.
4. **Body lazy-load.** When the user expands the card, the SPA calls
   `GET /api/inbox/<id>`. The handler calls `inbox.read(id)` for metadata,
   and if `description_size > 0` and `description_format` is set, calls
   `readInboxBody(globalDir, id, format)` and inlines the body in the
   response. The two-tier layout (metadata in `inbox.json`, body in
   sidecars) keeps `/api/inbox` flat even with 256-KB bodies.
5. **State transitions.** Two surfaces; either drives the same store:
   - MCP tools: `inbox.set_state({ id, state })`, `inbox.snooze({ id,
     until })`, `inbox.archive({ id })`.
   - HTTP: `POST /api/inbox/<id>/{state,snooze,archive,done}` — used by
     the SPA buttons. Same in-memory store, same SSE emit.
   There is **no transition graph** — `set_state` accepts any legal value
   for any current state, including `new` (back to inbox) or skipping
   directly from `new` to `done`. `snooze` is the only one that validates
   semantically (`until > Date.now()` else `INVALID_SNOOZE_TIME`).
6. **Update merge semantics** (the patch rules):
   | Caller wrote… | Effect |
   |---|---|
   | omitted field | unchanged |
   | `null` on nullable fields (`recipe_instance`, `trigger_id`) | set to `null` |
   | `description: ""` | sidecar deleted, `description_size: 0`, `description_format` wiped |
   | `attachments: []` | row becomes `[]` |
   | `labels: []` | row becomes `[]` |
   | anything else | replaces verbatim |
7. **Termination.** **No tool deletes an inbox row.** `archive` and `done`
   are terminal states but the rows survive on disk forever (no GC). The
   SPA's default-filter view hides them. The user can un-archive
   (`set_state` back to `open`) and the body sidecar comes back intact.
   The only way to truly remove a row is to manually delete the entry
   from `inbox.json` and the matching sidecar files on disk.

**Cross-links.** Every link is set at `inbox.upsert` time and **never auto-updated**:
- `attachments[]` → artifacts. The `enrichInboxItemsForList` helper
  resolves each `artifact_id` at read time; missing artifacts come back
  with `resolved: false, view_url: null` (a "dangling" chip).
- `recipe_instance` → a recipe instance row in some workspace. Clicking
  the chip jumps to the Recipes tab.
- `trigger_id` → a registered trigger. Clicking jumps to the Triggers tab.

---

### 4. Artifact

```
   agent / skill writes content files into
   <workspace>/artifacts/<id>/ (any tooling — Bash, edit, skill code)
                            |
                            | artifact.add({ id, type, title, workspace_id?,
                            |                recipe_instance_id?, step_id?,
                            |                meta?, files? })
                            |
                            |  - validateArtifactId
                            |  - resolveTargetWorkspace
                            |     (args.workspace_id → CLAWDEVBOX_WORKSPACE_ID env
                            |      → findWorkspaceByPath(projectDir))
                            |  - validateArtifactFilename for each inline file
                            |  - readArtifact (existing?)
                            |     - same type:    reuse created_at
                            |     - different type: ARTIFACT_TYPE_CONFLICT
                            |  - writeArtifact: mkdirSync + writeFileAtomic manifest.json
                            |                   + writeFileAtomic each inline file
                            |  - (no SSE emit; no push)
                            v
              +-----------------------------+
         (*)  |  on disk in workspace       |
              |  <workspace>/artifacts/<id>/|
              |   manifest.json             |
              |   <content files>           |
              +-----+----------+------------+
                    |          |
                    |          | artifact.add (re-add, same id)
                    |          |   - merge manifest (created_at PRESERVED)
                    |          |   - overwrite named content files
                    |          |   - manifest.json NEVER writable as a content file
                    |          v (same state, updated content)
                    |
                    |  HTTP / viewer routes (terminal-server.ts):
                    |   GET /artifact/<id>              -> HTML host page
                    |   GET /artifact/<id>/manifest     -> ArtifactManifest JSON
                    |   GET /artifact/<id>/files        -> { files[] }
                    |   GET /artifact/<id>/file/<name>  -> raw bytes (streamed)
                    |   GET /__renderer/<type>.mjs      -> resolved renderer module
                    |     (workspace .clawdevbox/renderers → plugin → builtin)
                    |
                    | artifact.delete
                    |   - findArtifact across workspace set (first-hit-wins)
                    |   - deleteArtifact: rmSync({recursive:true, force:true})
                    |   - returns { deleted: true, workspace_id }
                    v
              +-----------------------------+
         [X]  |  deleted (folder rm -rf'd)  |
              +-----------------------------+

NO cascade on delete:
   - Inbox attachments pointing at the gone id still exist on the inbox row.
   - enrichInboxItemsForList sets resolved: false, view_url: null at read time.
   - Recipe instances' result.artifact_id references stay dangling.
   - No event fired, no warning logged.
```

**Walkthrough.**

1. **Authoring content.** Heavy content (multi-MB diffs, walkthrough JSON,
   markdown bodies) is **not** typically written by `artifact.add`. The
   convention is: a skill writes the files into
   `<workspace>/artifacts/<id>/` directly (with Bash, edit, or its own
   FS code), then calls `artifact.add` to drop the manifest. The inline
   `files: { name: content }` arg on `artifact.add` is a convenience for
   tiny bundles (strings → utf-8; objects → `JSON.stringify(v, null, 2)`).
2. **`artifact.add`.** The handler:
   - `validateArtifactId(id)` rejects anything outside
     `/^[a-z0-9][a-z0-9._-]*$/i`.
   - `resolveTargetWorkspace(ws, args.workspace_id)` chooses the workspace:
     explicit `workspace_id` → `getWorkspace(root, id)` from
     `<workspacesRoot>/index.json`; else `CLAWDEVBOX_WORKSPACE_ID` env
     (set by `recipe.run`); else `findWorkspaceByPath(root,
     ws.projectDir)`. Missing → `WORKSPACE_NOT_FOUND` or
     `NO_TARGET_WORKSPACE`.
   - `validateArtifactFilename(name)` rejects empty strings, `..`, `/`,
     `\\`, and the literal `manifest.json`. The manifest is reserved for
     `writeArtifact` itself.
   - `readArtifact(workspacePath, id)` — if it exists with a different
     `type`, fail with `ARTIFACT_TYPE_CONFLICT`. Otherwise reuse the
     existing `created_at`. **Type is sticky for a given id**, by design:
     anything pointing at `/artifact/<id>` shouldn't have the renderer
     change under it.
   - `recipe_instance_id` falls back to
     `process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID` — so artifacts produced
     inside a recipe pty are auto-tagged without the agent having to
     remember.
   - `writeArtifact` does `mkdirSync({recursive:true})`,
     `writeFileAtomic` the manifest, then `writeFileAtomic` each inline
     file. **No SSE emit and no push fire** — artifacts are pulled by the
     SPA via the iframe load, not pushed.
3. **Discovery (HTTP).** `findArtifact(id)` in `terminal-server.ts`
   searches (in order):
   1. The env-set `CLAWDEVBOX_PROJECT_DIR` (treated as a pseudo-workspace
      with id `'project'`).
   2. Every workspace from `listWorkspaces(resolveWorkspacesRoot())`.
   **First match wins.** If two workspaces both contain `pr-1234-review`,
   whichever the iteration sees first is what gets served — the other is
   invisible via id-only lookups. Pass `workspace_id` to disambiguate.
4. **Viewing.** The SPA opens an iframe at `/artifact/<id>`:
   - `serveArtifactHost` calls `findArtifact(id)`, emits the dark-themed
     HTML shell with a `<script type="module">` block.
   - The browser script `fetch`es `/artifact/<id>/manifest` and `/files`,
     builds `ctx = { manifest, artifactId, listFiles, fetchFile,
     fetchFileJson }`, and `await import('/__renderer/<type>.mjs')`.
   - `resolveRendererFile(type, ws)` walks workspace
     `.clawdevbox/renderers/<type>.mjs` → plugin renderers (sorted by
     plugin id) → built-in renderers at
     `<mcp-server>/src/renderers/<type>.mjs`. **First match wins.**
   - The renderer module's `default.render(rootElement, ctx)` is called;
     any throw is caught and rendered as a red `<pre id="artifact-error">`
     block so the host page never goes blank.
   - `/artifact/<id>/file/<name>` re-validates `name` after URL decoding
     (so `%2E%2E%2Fpasswd` becomes `../passwd` and fails the `..` check)
     and streams the bytes via `createReadStream`. Multi-MB diffs don't
     eat heap.
5. **Re-add.** `artifact.add` on an existing id merges manifest fields
   (`created_at` is preserved), overwrites every inline `files[name]`,
   and leaves any content files **not** in the inline payload alone. The
   manifest is rewritten in full — so `recipe_instance_id`, `step_id`,
   `meta` are all replaced verbatim (no patch semantics). To clear them,
   pass them as `null`.
6. **Mutation by direct FS.** Skills routinely overwrite content files
   directly via Bash/edit/whatever (the `files[]` arg is just a
   convenience). There is **no** `artifact.write_file` tool. The
   `manifest.json` filename is special — the route validator rejects it
   for reads, the inline `files` validator rejects it for writes, and
   only `writeArtifact` itself authors it.
7. **Termination.** `artifact.delete({ id, workspace_id? })` finds the
   first workspace whose `artifactDir(w.path, id)` exists and runs
   `rmSync(dir, { recursive: true, force: true })`. Missing id →
   `{ deleted: false }`, **not** an error code (unlike most "not found"
   paths). **No cascade.** Inbox attachments pointing at the gone id
   stay in place but show as `resolved: false, view_url: null` after the
   next `/api/inbox` enrichment. Recipe-instance `result.artifact_id`
   references also stay dangling. No event fires; no warning is logged.

---

### 5. CLI terminal session

This is the most layered of the five — three things share one identity (the
`recipe_instance_id`): a JSON status row on disk, an IPty handle in the
pty-registry, and a WebSocket terminal that browsers attach to.

```
                    recipe.run / POST /api/recipes/<id>/resume
                                |
                                | pty.spawn(file, args, { cols:120, rows:30, cwd, env })
                                | returns IPty (ConPTY on Windows — no console window)
                                |
                                | registerPty({ instanceId, workspaceId, cols, rows, ipty })
                                |
                                | extra hooks set by the spawner:
                                |   ptyProc.onData(d => logStream.write(d))   -> .log file
                                |   ptyProc.onExit(({exit,signal}) => ...)    -> instance row
                                v
                       +----------------------+
                       | sessions.set(id, S)  |  S = { ipty, buffer:[], bufferBytes:0,
                  (*)  | exited=false         |        subscribers:Set, exited:bool,
                       +----+--+--+--+--+-----+        cols, rows }
                            |  |  |  |  |
   ptyProc.onData (registry hook) -> appendToBuffer(s, chunk)
                                    -> for sub in s.subscribers: sub({type:'data',chunk})
                            |  |  |  |  |
                            |  |  |  |  |  subscribe(id, fn):  WS browser attaches
                            |  |  |  |  |    s.subscribers.add(fn)
                            |  |  |  |  |    fn({type:'snapshot', content: s.buffer.join(''), cols, rows, exited:false})
                            |  |  |  |  |    returns { unsubscribe, sentSnapshot:true }
                            |  |  |  |  |
                            |  |  |  |  |  writeToPty(id, data) (from WS {type:'input'}):
                            |  |  |  |  |    s.exited ? noop : s.ipty.write(data)
                            |  |  |  |  |
                            |  |  |  |  |  resizePty(id, cols, rows) (from WS {type:'resize'}):
                            |  |  |  |  |    s.ipty.resize(cols,rows); s.cols/s.rows updated
                            |  |  |  |  |
                            |  |  |  |  |  killPty(id, signal?) (from WS {type:'kill'} OR recipe.kill):
                            |  |  |  |  |    s.exited ? noop : s.ipty.kill(signal)
                            |  |  |  |  |    (eventually fires the pty's own onExit)
                            v  v  v  v  v
                       +----------------------+
                       | ptyProc.onExit fires |
                       | (registry hook):     |
                       |  - s.exited = true   |
                       |  - s.exitCode set    |
                       |  - broadcast         |
                       |    {type:'exit',     |
                       |     exitCode, signal}|
                       |  - schedule          |
                       |    sessions.delete   |
                       |    after EXIT_RETAIN_|
                       |    MS = 10_000 ms    |
                       +----+-----------------+
                            |
                            | (10s grace window; late attaches still get snapshot+exit)
                            v
                       +----------------------+
                       | sessions.delete(id)  |
                       | iff s.exited &&      |  [registry-X]
                       | s.subscribers.size=0 |
                       +----------------------+
                            |
                            | The on-disk log at
                            | <workspace>/.clawdevbox/recipe-instances/<id>.log
                            | persists FOREVER (no GC).
                            v
                       +-----------------------------+
                       | attachWebsocket(ws, id):    |
                       |  hasSession(id)?  No.       |
                       |   → readArchivedTerminalLog |
                       |     (searches projectDir +  |
                       |      every workspace)       |
                       |   → ws.send({type:'snapshot',
                       |       content:<log>,        |
                       |       archived:true,        |
                       |       exited:true})         |
                       |   → ws.send({type:'exit',   |
                       |       exitCode:0})          |
                       |   → ws.close(1000,          |
                       |       'session archived')   |
                       +-----------------------------+
```

**Walkthrough.**

1. **Birth.** Always inside a `recipe.run` (or its HTTP cousin
   `/api/recipes/<id>/resume`). `pty.spawn` returns an `IPty` handle —
   ConPTY on Windows so no console window flashes. The spawner immediately
   calls `registerPty({ instanceId, workspaceId, cols: 120, rows: 30, ipty })`
   which creates a `PtySession` entry in the in-process `sessions: Map`
   keyed by `instanceId`.
2. **Stream fan-out.** The registry's own `ipty.onData(chunk)` hook does
   two things per chunk:
   - Append to a ring buffer (`buffer: string[]`, `bufferBytes` total,
     dropping from the head while `bufferBytes > BUFFER_LIMIT_BYTES =
     256 KiB`).
   - Broadcast `{ type: 'data', chunk }` to every current `subscriber` in
     `s.subscribers`.
   The recipe-run spawner additionally hooks the same `ipty.onData` to
   write to a disk log stream at
   `<workspace>/.clawdevbox/recipe-instances/<id>.log` (`flags: 'a'`,
   append-mode). The two hooks are independent: the ring buffer is
   in-memory and bounded; the disk log is unbounded.
3. **Attach (the WebSocket path).** The SPA opens an iframe at
   `/terminal/<id>` (URL from `recipe.view_url`). The host page opens a
   WebSocket to `/terminal/<id>/ws`. The server's `attachWebsocket(ws,
   id)` handler:
   - Checks `hasSession(id)`. If **no**, falls through to the archive
     branch (step 8). If yes, continues.
   - Calls `subscribe(id, fn)` where `fn` forwards every PtyServerEvent
     to the WS via `ws.send(JSON.stringify(event))`. `subscribe` adds
     `fn` to `s.subscribers` and then immediately invokes it with
     `{ type: 'snapshot', content: s.buffer.join(''), cols, rows,
     exited, exitCode? }`. Late attachers see the tail of the live
     session up to 256 KiB.
   - Hooks `ws.on('message', ...)` to route `{ type: 'input', data }` →
     `writeToPty(id, data)` (stdin to the agent CLI), `{ type: 'resize',
     cols, rows }` → `resizePty(id, cols, rows)`, and `{ type: 'kill',
     signal? }` → `killPty(id, signal)`.
   - Hooks `ws.on('close')` and `ws.on('error')` to `unsubscribe()`.
4. **Input.** User types in xterm → host page WS → `{ type: 'input',
   data }` → `writeToPty(id, data)` → `s.ipty.write(data)`. Goes directly
   to the agent CLI's stdin. If `s.exited`, the write is a no-op.
5. **Multiple viewers.** Subscribing is non-exclusive — `s.subscribers`
   is a `Set` and `subscribe` is called once per WS. Three browsers on
   three devices all watching the same recipe each get their own
   snapshot + live data, and any of them can type. Last-writer-wins for
   stdin (the pty doesn't distinguish callers).
6. **Resume.** `POST /api/recipes/<id>/resume` is not a pty-registry
   operation — it spawns a **new** pty under a **new** `instanceId` but
   reuses the **same** `session_id`. The CLI invocation is
   **interactive**: `copilot.exe --resume=<sessionId>
   --allow-all-tools --additional-mcp-config @<.mcp.json>` (no `-p` flag)
   or `claude --resume <sessionId>` (no `-p`). The user lands in the new
   xterm tab and types directly into a CLI that has the prior conversation
   loaded. The old pty session was already dead — there is no "attach to
   the original" path; resume always spawns fresh.
7. **Kill.** Two paths to terminate a live pty:
   - **WS message.** The xterm host page exposes a kill button that
     sends `{ type: 'kill', signal? }`. `attachWebsocket` calls
     `killPty(id, signal)` → `s.ipty.kill(signal)`. ConPTY ignores the
     signal name on Windows and just closes the pseudoconsole.
   - **MCP tool.** `recipe.kill({ id?, signal? })` calls `killPty` **and**
     rewrites the instance row to `status: 'cancelled'`,
     `message: 'Cancelled via recipe.kill'`, `completed_at: Date.now()`.
     This is the **only path that writes `status: 'cancelled'` to the
     instance row** — WS-driven kills run through the same pty.kill but
     leave the status decision to the pty's `onExit` handler (which writes
     `failure` for non-zero exit, never `cancelled`).
8. **Exit.** `ptyProc.onExit({ exitCode, signal })` fires. Two hooks run:
   - **Registry hook.** Sets `s.exited = true`, `s.exitCode = exitCode ??
     0`, broadcasts `{ type: 'exit', exitCode, signal }` to every
     subscriber, and `setTimeout(() => { if s.exited && s.subscribers.size
     === 0: sessions.delete(id) }, EXIT_RETAIN_MS = 10_000)`. The
     subscriber check matters: a viewer still attached at the moment the
     timer fires keeps the session alive — it's freed once the last viewer
     disconnects.
   - **Spawner hook.** `logStream.end()`. Then `readRecipeInstance(...)`;
     if `status === 'running'`, rewrite with `success`/`failure` derived
     from `exitCode` and `signal`. If already terminal (because
     `recipe.done` or `recipe.kill` got there first), skip.
9. **Post-exit archive.** Once the registry drops the session, any
   subsequent `/terminal/<id>/ws` connection takes the **archive branch**
   in `attachWebsocket`:
   - `hasSession(id)` returns false.
   - `readArchivedTerminalLog(id)` walks `CLAWDEVBOX_PROJECT_DIR` first,
     then every workspace from `listWorkspaces(resolveWorkspacesRoot())`,
     looking for `<workspace>/.clawdevbox/recipe-instances/<id>.log`.
     First found wins; missing → `null`.
   - The WS receives one `{ type: 'snapshot', content: <log>, cols: 120,
     rows: 30, exited: true, exitCode: 0, archived: true }` event,
     followed by one `{ type: 'exit', exitCode: 0 }`, then `ws.close(1000,
     'session archived')`. No input is accepted; the WS is one-shot.
   - The host page renders the snapshot as a static scrollback. The xterm
     viewer in the SPA visually flags it as "archived" via the `archived`
     flag on the snapshot.

**Cross-link.** A CLI terminal session **is** a recipe instance from the
viewpoint of identity: same id, three storage layers (the JSON row, the
in-memory `PtySession`, and the disk log). Killing the pty doesn't delete
the row; deleting the row by hand wouldn't kill the pty. The three layers
are loosely coupled, deliberately.

---

## Cross-object flow story

The canonical end-to-end scenario, walking from a plugin-declared trigger
firing all the way to a Resume from the SPA. This shows how all five objects
collaborate. For each step: **TOOL CALL** · **FILE WRITTEN** · **SSE TOPIC**
· **PUSH FIRED?** · **UI SIDE EFFECT**.

### Step 1: trigger fires

Today this is manual (`trigger.fire`); when the cron daemon lands it will
fire on schedule from a `default_cron: "*/5 * * * *"` on
`ado.new-pr-watcher`.

- **TOOL CALL.** `trigger.fire({ id: 'ado.new-pr-watcher#auth-svc' })`.
- **FILE WRITTEN.** None — `trigger.fire` is a stub that only logs.
- **SSE TOPIC.** None.
- **PUSH FIRED?** No.
- **UI SIDE EFFECT.** None directly. The agent sees `{ run_id, status:
  'queued' }` and proceeds.

The trigger handler is supposed to be the plugin's `triggers/new-pr-watcher.ts`
script, but the cron daemon that would `import()` and run it is the chunk
that doesn't exist. In practice today, the call chain is "agent or test
harness manually calls the rest of this sequence."

### Step 2: inbox item created (the trigger's effect)

The trigger handler (a hosted tool the plugin ships) detects PR 247 in
`auth-svc` and surfaces it.

- **TOOL CALL.** `inbox.upsert({ id: 'ado:pr:247', kind: 'pr_review',
  source: 'ado', title: 'Add OAuth2 to /auth', preview: 'Replaces session
  cookies with JWT...', description: '## Summary\\n...full PR body...',
  description_format: 'markdown', trigger_id: 'ado.new-pr-watcher#auth-svc',
  labels: ['auth', 'security'] })`.
- **FILE WRITTEN.**
  1. `<globalDir>/inbox-bodies/ado_pr_247.md` (atomic; body sidecar).
  2. `<globalDir>/inbox.json` (atomic; full items array re-written with
     the new row at the end).
- **SSE TOPIC.** `inbox` (every SPA tab re-fetches `/api/inbox`).
- **PUSH FIRED?** **Yes**, because `created === true` and `notify` was
  omitted. Title = `'Add OAuth2 to /auth'`, body = `'Replaces session
  cookies with JWT...'` (clipped to 120 chars), tag = `'inbox:ado:pr:247'`,
  url = `'/'`. Encrypted with VAPID, POSTed to every subscribed device.
- **UI SIDE EFFECT.** A new card appears at the top of the inbox list on
  every open SPA tab. The user's phone buzzes; tapping the notification
  opens `/` which routes to the inbox.

### Step 3: user opens the SPA + expands the card

This is pure HTTP — no MCP calls. Two GETs.

- **TOOL CALL.** None.
- **FILE WRITTEN.** None.
- **SSE TOPIC.** None.
- **PUSH FIRED?** No.
- **UI SIDE EFFECT.**
  1. SPA mounts at `/`, inbox tab is default. `GET /api/inbox` runs
     `enrichInboxItemsForList`, which for each item resolves
     `attachments[].artifact_id` via `findArtifact`. Today there are no
     attachments yet — just the body.
  2. User taps the card. `GET /api/inbox/ado:pr:247` calls `inbox.read`
     + `readInboxBody(globalDir, 'ado:pr:247', 'markdown')`. The
     `## Summary…` body renders inline in the expanded card.
  3. The first expansion **does not** auto-transition the state. State
     stays at `new`. The SPA may issue `POST /api/inbox/ado:pr:247/state
     { state: 'open' }` if its UX is "tap = mark read" — that's a design
     choice, not a hard contract.

### Step 4: user starts a review

The user taps a "Start review" button on the card, which posts to the SPA's
"run recipe" route, which in turn calls `recipe.run`. (An alternative
flow: the agent calls `recipe.run` on the user's behalf as part of
processing the inbox item.)

- **TOOL CALL.** `recipe.run({ id: 'pr-review', prompt: 'Review PR 247 in
  auth-svc, output a pr-review artifact, then attach it to inbox item
  ado:pr:247.', agent_cli: 'copilot' })`.
- **FILE WRITTEN.**
  1. Workspace mint: `<workspacesRoot>/ws_<...>/` plus its scaffold
     (`.clawdevbox/{recipes,skills,recipe-instances,triggers.json,
     workspace.json}`).
  2. `<workspacesRoot>/index.json` updated.
  3. `<workspace>/.mcp.json` with `CLAWDEVBOX_RECIPE_INSTANCE_ID`,
     `CLAWDEVBOX_WORKSPACE_ID`, `CLAWDEVBOX_SESSION_ID`, fresh
     `CLAWDEVBOX_MCP_SECRET`.
  4. `<workspace>/.clawdevbox/recipe-instances/<instanceId>.json` with
     `status: 'running'`, `pid: null`, `session_id: 'cdb_<...>'`,
     `recipe_snapshot: <verbatim YAML>`.
- **SSE TOPIC.** `recipes` (via `writeRecipeInstance`).
- **PUSH FIRED?** No.
- **UI SIDE EFFECT.** SPA's Recipes panel refreshes via the SSE. A new
  card appears for the running recipe instance.

### Step 5: CLI terminal session opens

Inside the same `recipe.run` handler, after the instance row is on disk.

- **TOOL CALL.** None new — this is internal.
- **FILE WRITTEN.**
  1. `<workspace>/.clawdevbox/recipe-instances/<instanceId>.log` opened
     in append mode.
  2. Instance row re-written with the new `pid` field.
- **SSE TOPIC.** `recipes` again (the pid update writes the row).
- **PUSH FIRED?** No.
- **UI SIDE EFFECT.** `recipe.view_url` returns
  `http://<host>:<port>/terminal/<instanceId>`. The SPA opens an iframe
  at that URL and the host page WebSocket-attaches. The xterm viewer
  appears, ring-buffer-replays the prelude (the agent CLI banner and
  prompt), and starts streaming live data.

`copilot.exe --name=<sessionId> --allow-all-tools --additional-mcp-config
@<.mcp.json> -p "Review PR 247…"` is now running in the pty. It reads
`.mcp.json`, opens an MCP child process pointing back at `npx -y clawdevbox
mcp`, and authenticates with the per-spawn `CLAWDEVBOX_MCP_SECRET`.

### Step 6: agent generates an artifact

Inside the recipe instance pty, the Copilot CLI runs a `pr-review` skill
that fetches the PR diff, writes `review.json` + `walkthrough.json` +
`diffs/*.diff` into `<workspace>/artifacts/pr-247-review/`, and then calls:

- **TOOL CALL.** `artifact.add({ id: 'pr-247-review', type: 'pr-review',
  title: 'auth-svc · PR 247 review', meta: { pr_id: 247 } })`. Note
  there's no `workspace_id` or `recipe_instance_id` — those are inferred
  from `CLAWDEVBOX_WORKSPACE_ID` and `CLAWDEVBOX_RECIPE_INSTANCE_ID` envs
  set by `recipe.run`.
- **FILE WRITTEN.**
  - `<workspace>/artifacts/pr-247-review/manifest.json` (atomic;
    `recipe_instance_id` and `step_id` are auto-populated from envs).
  - No inline content files (`files: undefined`) — the skill already
    wrote the heavy content directly.
- **SSE TOPIC.** **None** — `artifact.add` does not emit SSE. The agent
  knows about the artifact; the SPA discovers it implicitly when the
  next attached inbox / recipe row is enriched, or explicitly when the
  user clicks an attachment chip.
- **PUSH FIRED?** No.
- **UI SIDE EFFECT.** None directly.

### Step 7: agent links artifact back to the inbox item

The agent now calls `inbox.upsert` again with the same id, adding an
attachment.

- **TOOL CALL.** `inbox.upsert({ id: 'ado:pr:247', kind: 'pr_review',
  source: 'ado', attachments: [{ artifact_id: 'pr-247-review', title:
  'Review walkthrough', type: 'pr-review', workspace_id:
  '<workspaceId>' }] })`. `kind` and `source` are required and always
  overwritten — the agent passes the existing values.
- **FILE WRITTEN.** `<globalDir>/inbox.json` rewritten with the updated
  row. **No body sidecar write** (description omitted). `updated_at`
  refreshed.
- **SSE TOPIC.** `inbox`.
- **PUSH FIRED?** No (this is an update, and `notify` was not set to
  `true`).
- **UI SIDE EFFECT.** Every open SPA tab re-fetches `/api/inbox`.
  `enrichInboxItemsForList` resolves `attachments[0].artifact_id` via
  `findArtifact`, finds the bundle in the spawned workspace, sets
  `view_url: /artifact/pr-247-review`, `resolved: true`. A clickable
  chip appears on the inbox card.

### Step 8: recipe completes

The agent calls:

- **TOOL CALL.** `recipe.done({ status: 'success', result: { artifact_id:
  'pr-247-review' }, message: 'Posted review for PR 247.' })`. Reads
  `CLAWDEVBOX_RECIPE_INSTANCE_ID` + `CLAWDEVBOX_WORKSPACE_ID` from env.
- **FILE WRITTEN.** Instance row merged + atomic re-write with
  `status: 'success'`, `completed_at: Date.now()`, `result`, `message`.
- **SSE TOPIC.** `recipes`.
- **PUSH FIRED?** No.
- **UI SIDE EFFECT.** SPA Recipes panel re-renders with the green
  "success" badge. The xterm viewer keeps showing the tail until the
  CLI exits.

The agent CLI exits shortly after. The pty's `onExit` fires:
- Registry: `s.exited = true`, broadcast `{ type: 'exit', exitCode: 0 }`
  to every attached WS, schedule `sessions.delete(instanceId)` in 10 s.
- Spawner hook: `logStream.end()`. Re-read instance row → already
  `status: 'success'` from `recipe.done` → skip the rewrite.

### Step 9: user opens the artifact

- **TOOL CALL.** None — pure HTTP.
- **FILE WRITTEN.** None.
- **SSE TOPIC.** None.
- **PUSH FIRED?** No.
- **UI SIDE EFFECT.** User taps the artifact chip on the inbox card. The
  SPA opens a tab keyed `artifact:pr-247-review` rendering
  `<iframe sandbox="allow-scripts allow-same-origin ..." src="/artifact/pr-247-review">`.
  The iframe loads the dark host shell from `serveArtifactHost`. The
  embedded module fetches `/artifact/pr-247-review/manifest` + `/files`,
  then `import('/__renderer/pr-review.mjs')`. No workspace shadow, no
  plugin renderer for that type — the built-in
  `<mcp-server>/src/renderers/pr-review.mjs` is served. The renderer
  loads `review.json` + `walkthrough.json` + each diff via
  `ctx.fetchFile(...)` and paints the review summary + per-file diffs.

### Step 10: user resumes the recipe

The user wants to ask the agent a follow-up question without re-uploading
the whole context.

- **TOOL CALL.** `POST /api/recipes/<original-instance-id>/resume` with
  body `{ prompt: 'Also check the rate-limit changes in the PR' }`. (HTTP
  endpoint, not an MCP tool. The `prompt` is recorded on the new row but
  not passed to the CLI — resume is interactive.)
- **FILE WRITTEN.**
  1. New instance row at `<workspace>/.clawdevbox/recipe-instances/<newId>.json`
     with `status: 'running'`, `resume_of: <original-id>`, `session_id:
     <same as original>`, `prompt: 'Also check…'`.
  2. New log file at `<workspace>/.clawdevbox/recipe-instances/<newId>.log`.
- **SSE TOPIC.** `recipes` (from the `writeRecipeInstance` calls).
- **PUSH FIRED?** No.
- **UI SIDE EFFECT.** SPA Recipes panel re-renders, showing a new card
  linked to the original via `resume_of`. The new card auto-opens its
  terminal tab in the SPA (the standard UI behaviour for newly-spawned
  instances). `copilot.exe --resume=<sessionId> --allow-all-tools
  --additional-mcp-config @<.mcp.json>` runs **interactive** in the new
  pty. The user types directly into the xterm. Copilot has the prior
  conversation loaded (Copilot CLI persists per-`--name=<id>` session
  state to its own local store) and answers in context.

The chain has now passed through all five object types: a **trigger**
(stubbed fire) → an **inbox item** (with body sidecar + push) → a **recipe
instance** (spawn + done) → a **CLI terminal session** (live + archived
to log) → an **artifact** (rendered in the SPA) → an updated **inbox item**
(attachment added) → a second **recipe instance + CLI terminal session**
(resume sharing the session id).

---

## Failure modes

This is the catalogue of "things that go wrong" for each lifecycle, with the
exact code path that handles each one.

### Trigger failure modes

- **Plugin uninstalled but rows remain.** `plugin.uninstall` removes the
  TYPE from `ws.triggerTypes` and the on-disk `<globalDir>/plugins/<id>/`,
  but never touches `<projectDir>/.clawdevbox/triggers.json`. The
  registered rows become **orphans**: `projectRegistered` marks them
  `type_exists: false`. `trigger.list_registered` still returns them.
  Param-only updates fail with `TRIGGER_TYPE_NOT_FOUND`; cron-only
  updates, `enable`, `disable`, and `unregister` still work. Manual
  remedy: `trigger.unregister` once the agent sees `type_exists: false`.
- **`triggers.json` corruption.** `readTriggersFile` catches all parse
  errors and returns `{ registered: [] }`. A truncated file silently
  presents as an empty registry. Atomic writes via `writeFileAtomic`
  prevent this in practice; the safety net is for editor crashes and
  disk-full conditions.
- **Identity-param collision.** `trigger.register` with the same
  `identity_param` value as an existing row fails with
  `TRIGGER_ALREADY_REGISTERED`, returning the colliding id. The agent
  must `trigger.update_params` or `trigger.unregister` first.
- **Hash-id non-determinism.** TYPEs without `identity_param` mint ids
  via `sha256(JSON.stringify(sortedParams))[:8]`. Nested objects keep
  their natural key order, so two semantically-identical registrations
  with differently-ordered nested objects produce different ids. The fix
  (RFC-8785 canonical JSON) is deferred.

### Recipe-instance failure modes

- **Spawn fails (CLI not on PATH).** `pty.spawn` throws `ENOENT`. The
  handler catches it, ends the log stream, rewrites the instance row to
  `status: 'failure'`, `message: 'spawn failed: ENOENT'`, and returns
  `SPAWN_FAILED`. The row is on disk for `recipe.instance_info` to find.
- **Echo-stub finishes before `pty.spawn` returns to JS.** The echo-stub
  script writes `status: 'success'` synchronously before `pty.spawn`
  returns. If the handler blindly wrote `{ ...instance, pid }` it would
  clobber the completed status. The re-read in `recipe.ts:569–576` is
  the only thing keeping us honest. Any new code that touches the
  instance row after `registerPty` must use the same read-then-merge
  pattern.
- **`recipe.done` called twice.** The second call merges the new fields
  onto whatever the first call wrote — typically a no-op if `status` is
  the same. There's no idempotency check; the row just gets re-written.
- **Pty `onExit` after `recipe.done`.** The handler's `current.status
  === 'running'` guard preserves `recipe.done`'s authoritative status.
  No clobber.
- **`recipe.kill` after exit.** `killPty` returns `false` (the registry
  finds the session but `s.exited` is true), and the workspace scan
  finds an instance already in a terminal status — the rewrite is
  skipped.
- **MCP server restarts mid-run.** The ptys die with the server (they
  inherit its process group; we don't use `child_process.spawn({
  detached:true })`). The instance row stays at `status: 'running'`
  forever — there's no startup sweep to mark orphaned `running` rows as
  `failure`. `recipe.list_running` correctly shows nothing, but
  `/api/recipes` shows the row as still running until the user manually
  edits it.
- **`session_id` missing on resume.** `POST /api/recipes/<id>/resume`
  fails with HTTP 409 `'source instance has no session_id — cannot
  resume'`. Old instances created before the explicit-session-id era
  may hit this.

### Inbox-item failure modes

- **Push fails because `NOTIFICATIONS_DISABLED`.** `loadNotificationsConfig`
  returns `enabled: false` or no VAPID keypair. The tool **succeeds** —
  the item is created and SSE fires — but the structured response carries
  `push: null, push_error_code: 'NOTIFICATIONS_DISABLED'`. The SPA list
  updates; the phone doesn't buzz.
- **Push fails per-device.** Subscriber endpoints that return 404/410 are
  pruned from `push-subscriptions.json`. Other errors are reported in
  `push.errors[]` but `isError` stays false.
- **`description_size` lies.** `writeInboxBody` succeeds but a crash
  before `saveInboxToDisk` leaves the body on disk with no `inbox.json`
  reference. Next boot: metadata claims `description_size: 0` (or the
  previous value) while the sidecar exists. `readInboxBody` is gated by
  `description_size > 0` so the orphan stays orphaned. Re-upserting the
  same id wipes it (the cross-format cleanup deletes both `.md` and
  `.txt`).
- **Concurrent writers race.** Two processes upserting the same id at
  the same instant: each reads, applies its patch, writes. The second
  write wins; the first patch's changes are lost. `writeFileAtomic`
  guarantees no half-written files but provides no isolation. Rare in
  practice (stdio MCP and HTTP service don't typically touch the same id).
- **Pagination skips items.** `inbox.list` paginates by `updated_at`
  desc. A new item arriving while the user pages forward will appear on
  a previous page, not the current one. Acceptable for the SPA (which
  fetches `limit: 200` and re-renders); a strict-pagination consumer
  must coordinate with the eventual SQLite kernel.
- **Cascade gaps.** `inbox.archive` does **not** cancel attached
  threads. `artifact.delete` does **not** mark inbox attachments as
  resolved-false on disk — only at read time, via the enrichment helper.

### Artifact failure modes

- **`findArtifact` cross-workspace collision.** Two workspaces both
  contain `pr-247-review`. The first one iterated wins. The other is
  invisible via id-only lookups (`artifact.get`, `artifact.delete`, HTTP
  routes). Mitigation: pass `workspace_id` explicitly, or use
  workspace-scoped ids like `ws-acct123-pr-247-review`.
- **Workspace not in `index.json`.** A workspace can exist on disk but
  not be in `<workspacesRoot>/index.json` (e.g., manually-deleted index
  entry). `findArtifact` won't see it; `/artifact/<id>` returns 404.
- **Type conflict.** Re-add with a different `type` fails with
  `ARTIFACT_TYPE_CONFLICT`. Delete first.
- **Renderer missing.** `resolveRendererFile` returns null for an
  unknown type. The HTTP server responds 404 on `/__renderer/<type>.mjs`,
  and the host page's `await import(...)` throws — caught by the host's
  try/catch and rendered as a red `<pre id="artifact-error">`.
- **Renderer throws at runtime.** Same red-pre error rendering. The
  host page never goes blank.
- **Half-written multi-file bundle.** `writeArtifact` writes manifest
  first, then each file. A crash between writes leaves a manifest
  pointing at files that don't exist yet. Renderers should tolerate 404s
  from `ctx.fetchFile` rather than assuming everything in
  `ctx.listFiles()` is readable.
- **Filename traversal attack.** `/artifact/<id>/file/<name>` decodes
  once and re-validates (rejects `..`, `/`, `\\`, `manifest.json`). A
  percent-encoded traversal decodes to `../passwd`, fails the check, and
  gets a 400.

### CLI terminal-session failure modes

- **Pty session killed mid-flight.** `recipe.kill` or a WS `{type:'kill'}`
  message → `s.ipty.kill(signal)` → exit. The archived log captures
  partial output. Any attached WS receives the `exit` event and the
  recipe row is rewritten — `recipe.kill` writes `cancelled`, WS-kill
  lets `onExit`'s code-based path decide (typically `failure` because
  the exit code is non-zero after a kill signal).
- **MCP server crash mid-stream.** Ptys die with the server. The disk
  log captures everything flushed to it before the crash (no `fsync` is
  forced, but `flags: 'a'` append-mode plus `logStream.write` chunks
  generally end up on disk within a few ms). The instance row stays at
  `running` forever — there's no recovery sweep.
- **Late WS attach to a long-exited session.** `attachWebsocket` calls
  `readArchivedTerminalLog`, which iterates the project dir + every
  workspace. Found → snapshot+exit, then `ws.close(1000, 'session
  archived')`. Not found → the SPA shows the no-log fallback message
  `[clawdevbox] this session has exited and its log was not captured.`.
- **Ring buffer truncation.** Long-running sessions (e.g., a recipe that
  streams 5 MB of output) overflow the 256 KiB ring buffer. New
  subscribers only see the most-recent ~256 KiB in their snapshot. The
  disk log captures the full stream — viewers wanting the full history
  must wait for the archive branch (post-exit) or read the log file
  directly.
- **Browser refreshes during exit.** A page reload between the registry
  emitting `{type:'exit'}` and the 10 s timeout firing usually still
  hits the live `subscribe` branch (because the session is still in the
  map, just `s.exited = true`). The new viewer gets a snapshot with
  `exited: true` and the `exit` event in quick succession.

---

## Known gaps

Pieces of the design that are explicitly deferred. The on-disk shapes are
already forward-compatible; the missing pieces are the schedulers and
sweepers that would consume them.

- **No trigger cron daemon.** `trigger.fire` is the only entry point that
  even logs a fire. No in-process timer wakes on cron boundaries. No
  external scheduler subscribes to `emitChange('triggers')`. No code path
  writes back to `last_run_at` / `last_run_status` / `last_run_error`. No
  code path loads `file_abs` and executes the trigger script. `expires_at`
  TTLs are not enforced; `once: true` is not honored;
  `subscriber_thread_id` hot-trigger wake-up is not honored. `binds_callback_to_recipe`
  links nothing to anything. Everything that calls itself "trigger" today
  is the registration surface only.
- **Snoozed inbox items don't auto-unsnooze.** `snoozed_until` is a hint
  the SPA renders; nothing wakes the item when `now > snoozed_until`. The
  user must manually `inbox.set_state` back to `open`. A future cron
  daemon would scan `inbox.json` per minute and flip eligible rows.
- **No inbox GC.** `archived` and `done` are terminal labels, not
  deletions. Rows and body sidecars accumulate on disk forever. The
  schema has no `deleted_at` field; there's no API to remove a row.
- **No recipe-instance GC.** Successful, failed, and cancelled instances
  stay on disk forever. The `.log` files in particular can grow large.
  No tool deletes them.
- **No artifact GC.** Same story — no TTL, no `recipe_instance_id`-driven
  cascade. Deleting a recipe instance does not delete its artifacts; the
  artifacts outlive the runs that produced them by design.
- **`recipe.run` does not accept `parent_recipe_instance_id`.** The data
  field exists on `RecipeInstance` and the `/api/recipes` HTTP handler
  builds the tree from it, but the tool surface has no way to set it.
  Nested runs today produce orphan children (the SPA renders them as
  top-level cards). [†]
- **MCP server restart loses live state.** Pty registry is in-memory.
  Threads and pending approvals are in-memory. A restart drops every
  live session — instance rows with `status: 'running'` become permanent
  zombies because nothing sweeps them.
- **No `description: null` clear semantic.** `description: ''` deletes
  the body sidecar but `description: null` is not in the schema; the
  patch merge would store `null` as-is, and the next read would still
  see `description_size > 0` (stale) trying to load a missing sidecar.
  The cleanup path is "always send `''` to clear."
- **`inbox.set_state`'s `reason` is a no-op.** Accepted by the schema,
  ignored by the store. Will become an audit-log row when the SQLite
  kernel lands.
- **Push pruning is best-effort.** `sendNotification` prunes 404/410
  endpoints from `push-subscriptions.json` but doesn't lock the file;
  concurrent prunes can race. Rare and self-correcting.

[†] Documented in [recipe.md](./tools/recipe.md) and in this doc; not in
the `RecipeInstance` TypeScript comments.

---

## Glossary of life-stage terms

- **birth** — the operation that first creates the object on disk or in
  memory (`inbox.upsert` for new id, `artifact.add` for new id,
  `recipe.run` for instance, `pty.spawn` for terminal session).
- **mutation** — any operation that changes the object's fields without
  changing its identity (the tool name typically has `set_state`,
  `update_*`, or just reuses `upsert`/`add` with merge semantics).
- **terminal state** — a state that no mutation transitions out of in
  normal flow. Inbox `done` and `archived`, recipe `success`/`failure`/
  `cancelled`. Some are escapable via `set_state` going backwards.
- **garbage collection / GC** — automatic removal of stale rows. The
  codebase currently has none; all five lifecycles accumulate forever
  unless an explicit delete tool is called. See [Known gaps](#known-gaps).
- **TTL (time-to-live)** — the maximum age before automatic removal.
  `expires_at` exists on registered triggers but is not enforced.
- **orphan** — a row whose referenced object no longer exists. Triggers
  whose plugin was uninstalled; inbox attachments whose artifact was
  deleted; recipe instances whose pty died with the MCP server.
- **archive (verb, for ptys)** — the moment after `EXIT_RETAIN_MS` when
  the registry drops the in-memory session and only the on-disk `.log`
  remains. WS attaches after this serve the archived log instead of
  live data.
- **fan-out** — the propagation of a mutation to every observer via SSE
  (`emitChange('inbox')`, etc.). All five lifecycles use the same
  topic-only event bus.
- **patch merge** — the spread-based update semantics used by
  `inbox.upsert` and `artifact.add` re-adds. Omitted fields pass through;
  `null` on nullable fields clears; `''` / `[]` are explicit clears for
  body sidecars and arrays.
- **scope chain** — the order in which recipes, skills, and renderers
  are resolved: project → plugin (sorted by plugin id) → global, with
  first match winning. The same chain shadows: a workspace renderer for
  `markdown` hides the built-in even when no plugin renderer exists.
- **session id vs instance id** — `session_id` (`cdb_<...>`) is the
  agent-CLI's conversation handle and is **stable across resumes**.
  `instance_id` (`ri_<...>`) is one specific pty/run and is **fresh
  every spawn**. Resume preserves session_id and mints a new
  instance_id; the new row carries `resume_of: <old-instance-id>` as
  the link.
