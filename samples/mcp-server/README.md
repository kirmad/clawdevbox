# @conductor/mcp-server (stub)

Conductor's central MCP server. Exposes Conductor's own data primitives —
recipes, skills, triggers, plugins, inbox, threads, approvals — over an MCP
stdio transport so the side-terminal CLI (`claude --mcp-config ...`) and
external agents can call them.

This is a **stub** that ships in `docs/superpowers/specs/samples/` as a
reference implementation. The real Conductor sidecar (slice 1+) adds:

- **Streamable-HTTP transport** on `localhost:5201` with per-launch bearer auth
- **better-sqlite3** persistence for inbox / threads / messages / approvals (FTS5)
- **In-process cron daemon** that fires webhooks at `/hooks/<id>`
- **File-watcher** with 500ms debounce on `.conductor/recipes/`, `.conductor/skills/`, `.conductor/plugins/*/plugin.yaml`
- **Notifications/resources/updated** stream on every state change

This stub ships:

- **stdio transport** (same pattern as `samples/plugins/ado/mcp-server/`)
- **In-memory inbox/thread/approval** state (process-local, lost on exit)
- **Real file IO** for recipe / skill / trigger / plugin tools — they read and write the actual `.conductor/` tree
- **Plugin manifest discovery** at boot — scans `.conductor/plugins/*/plugin.yaml`
- **Real `git clone` / `git pull`** for `plugin.install` / `plugin.update`

It is faithful to spec §6.1 (the tool catalog), §7.4 (recipe validation),
§8.1 (trigger config), §10.4 (scope/shadowing), and §10.7 (plugin manifest
validation). All cross-references in tool descriptions point back at those
sections.

## What it exposes

| Family | Tools | Backing |
|---|---|---|
| `recipe.*` | `list`, `read`, `upsert`, `delete` | Real file IO |
| `skill.*` | `list`, `read`, `upsert`, `delete` | Real file IO |
| `trigger.*` | `list`, `upsert`, `delete`, `enable`, `disable`, `fire` | Real file IO (fire = stub log) |
| `plugin.*` | `list`, `read`, `install`, `update`, `uninstall`, `enable`, `disable` | Real file IO + `git` |
| `inbox.*` | `list`, `read`, `upsert`, `set_state`, `snooze`, `archive` | In-memory |
| `thread.*` | `spawn`, `append_message`, `read`, `set_state`, `cancel`, `wake` | In-memory (`wake` = stub log) |
| `approval.*` | `request`, `resolve`, `list_pending` | In-memory |
| `artifact.*`, `view.*`, `search.*`, `signal.*` | All registered as stubs | Return `NOT_IMPLEMENTED_IN_STUB` |

Total tools: 41.

## Scope semantics (spec §10.4)

Reads accept `scope: 'project' | 'plugin:<id>' | 'global' | 'all'` (default
`'all'`). On `'all'`, the precedence is **project → plugin (sorted by id) →
global** — first match wins.

Writes accept only `'project'` or `'global'`. Plugin scope returns:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "Plugin scope is read-only. Copy to 'project' scope to customize." }],
  "structuredContent": { "code": "PLUGIN_SCOPE_READONLY", "scope": "plugin:ado" }
}
```

The agent's self-improvement loop (spec §10.6) is: read the plugin recipe →
edit → `recipe.upsert({ scope: 'project' })` → it now shadows the plugin
version. Reverting is `recipe.delete({ scope: 'project' })`.

## How to run

### Manual test (end-to-end exercise)

```bash
cd samples/conductor-mcp-server
npm install
node manual-test.mjs
```

This creates a temp workspace, copies `samples/plugins/ado/` into it as a
plugin, then runs the 8 representative tool calls described in the next
section.

### Smoke tests (CI)

```bash
node --test tests/smoke.test.mjs
```

11 assertions covering `tools/list`, recipe shadowing, plugin-scope
read-only enforcement, plugin discovery, skill list, the inbox/thread/
approval in-memory round-trip, stub-tool error shape, validator failures,
and trigger upsert/list/delete.

### Typecheck

```bash
npx tsc --noEmit
```

### Wire into a Claude Code session

```jsonc
// .conductor/mcp.json — what `claude --mcp-config` reads
{
  "mcpServers": {
    "conductor": {
      "command": "npx",
      "args": ["-y", "tsx", "<absolute-path-to>/samples/conductor-mcp-server/src/index.ts"],
      "env": {
        "CONDUCTOR_PROJECT_DIR": "<absolute-path-to>/your/workspace"
      }
    }
  }
}
```

Once that's wired, every tool in the catalog above shows up as
`conductor.recipe.list`, `conductor.recipe.read`, etc. in the agent's tool
list. (MCP servers don't namespace tools themselves; clients prefix tool
names with the server name to disambiguate.)

## Manual-test recipe

The `manual-test.mjs` driver does the following in order. The output is
designed to be pasted into a phase report verbatim.

| # | Step | Verifies |
|---|---|---|
| 1 | `tools/list` | All 41 tools register |
| 2 | `recipe.list({ scope: 'plugin:ado' })` | Both plugin recipes are discovered |
| 3 | `recipe.read({ id: 'pr-review' })` | Resolves to `plugin:ado` (no project copy exists yet) |
| 4 | `recipe.upsert({ id: 'pr-review', scope: 'project', source: <edited yaml> })` | Project shadow written to disk |
| 5 | `recipe.read({ id: 'pr-review' })` | Now resolves to `scope: 'project'` (shadowing works) |
| 6 | `recipe.upsert({ id: 'foo', scope: 'plugin:ado', source: ... })` | Rejected with `PLUGIN_SCOPE_READONLY` |
| 7 | `plugin.list()` | Discovers the ADO plugin from manifest scan |
| 8 | `recipe.delete({ id: 'pr-review', scope: 'project' })` then re-read | Reverts to plugin version |

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `CONDUCTOR_PROJECT_DIR` | yes | — | Workspace root (where `.conductor/` lives) |
| `CONDUCTOR_GLOBAL_DIR` | no | `~/.conductor` | Global recipe/skill/state location (override for tests) |

The server refuses to start without `CONDUCTOR_PROJECT_DIR`.

## What this stub deliberately does **not** do

- No HTTP transport — that's the real sidecar's job (auth, port management)
- No SQLite — inbox/thread/approval rows live in `Map`s; restart loses them
- No cron daemon — `trigger.fire` logs intent but doesn't actually POST
- No `claude --resume` spawn — `thread.wake` logs intent only
- No notifications stream — clients can't subscribe to state changes
- No webhook callback URL minting — the trigger's `callback_url` envelope is sidecar-side

These are all explicitly documented in tool descriptions so the agent can
plan against the eventual surface.
