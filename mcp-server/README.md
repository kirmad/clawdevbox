# clawdevbox

A toolkit for running AI coding agents headlessly. Ships the MCP server
that powers `clawdevbox` — recipes, skills, triggers, plugins, inbox,
threads, approvals, artifacts, renderers, hidden-pty agent runs, and a
browser-based terminal viewer.

## Install

```bash
npm install -g clawdevbox       # or: npm link  (from this repo, for dev)
```

## Quick start

```bash
clawdevbox init                  # interactive setup (writes .clawdevbox/config.json)
clawdevbox mcp                   # stdio MCP, for Claude Code / agency copilot
clawdevbox start                 # Streamable HTTP MCP on :5201 + terminal/artifact viewer
```

Run `clawdevbox --help` for the full flag list.

### `clawdevbox init`

Interactive (powered by `@clack/prompts`). Asks for project directory,
global directory, HTTP port; mints a 32-byte bearer token; scaffolds
`.clawdevbox/{recipes,skills,triggers,plugins,artifacts}/`; writes
`.clawdevbox/config.json`.

Re-running on an already-initialized project asks before overwriting.

### `clawdevbox mcp`

stdio MCP transport — the form Claude Code and agency copilot expect.
Wire it up like this:

```jsonc
// .mcp.json
{
  "mcpServers": {
    "clawdevbox": {
      "command": "npx",
      "args": ["-y", "clawdevbox", "mcp"],
      "env": { "CLAWDEVBOX_PROJECT_DIR": "<absolute-path-to-your-project>" }
    }
  }
}
```

(The env var is optional — `clawdevbox` falls back to `.clawdevbox/config.json`.)

### `clawdevbox start`

Streamable HTTP MCP transport, plus the existing terminal/artifact viewer,
on a single port. Default `127.0.0.1:5201`. Every `/mcp` request requires
`Authorization: Bearer <token>` — the token is whatever `init` wrote to
config (or `--token` / `CLAWDEVBOX_TOKEN`).

Routes:

| Method | Path | Purpose |
|---|---|---|
| POST/GET/DELETE | `/mcp` | Streamable HTTP MCP transport |
| GET | `/healthz` | liveness probe |
| GET | `/terminal/:instance_id` | xterm.js viewer for a recipe pty |
| WS  | `/terminal/:instance_id/ws` | bidirectional pty bridge |
| GET | `/artifact/:id` | artifact viewer |
| GET | `/artifact/:id/{manifest,files,file/:name}` | artifact API |
| GET | `/__renderer/:type.mjs` | resolved renderer module |

## What it exposes

| Family | Backing |
|---|---|
| `recipe.*` | file IO on `<project>/.clawdevbox/recipes/` |
| `skill.*` | file IO on `.clawdevbox/skills/` |
| `trigger.*` | file IO + cron registration |
| `plugin.*` | file IO + `git clone` / `git pull` |
| `workspace.*` | file IO + registry under `<global>/workspaces/` |
| `inbox.*` / `thread.*` / `approval.*` | in-memory (SQLite kernel next) |
| `artifact.*` | folder-per-id under `<workspace>/artifacts/` |
| `renderer.*` | workspace → plugin → builtin chain |

Tool descriptions cross-reference `docs/design.md` so the agent can plan
against the underlying surface.

## Scope semantics

Reads accept `scope: 'project' | 'plugin:<id>' | 'global' | 'all'` (default
`'all'`). Precedence: **project → plugin (sorted by id) → global** —
first match wins. Writes accept only `'project'` or `'global'`; plugin
scope is read-only (`PLUGIN_SCOPE_READONLY`).

## Configuration

`<project>/.clawdevbox/config.json`:

```json
{
  "version": 1,
  "project_dir": "C:/path/to/project",
  "global_dir": "C:/Users/me/.clawdevbox",
  "workspaces_root": "C:/Users/me/.clawdevbox/workspaces",
  "http": { "port": 5201, "host": "127.0.0.1", "token": "<32-byte hex>" }
}
```

Precedence: CLI flags > env vars > config file > defaults.

| Env var | Maps to |
|---|---|
| `CLAWDEVBOX_PROJECT_DIR` | `project_dir` |
| `CLAWDEVBOX_GLOBAL_DIR` | `global_dir` |
| `CLAWDEVBOX_WORKSPACES_ROOT` | `workspaces_root` |
| `CLAWDEVBOX_PORT` | `http.port` |
| `CLAWDEVBOX_HOST` | `http.host` |
| `CLAWDEVBOX_TOKEN` | `http.token` |
| `CLAWDEVBOX_LOG_LEVEL` | pino level (`trace`..`fatal`, default `info`) |

## Local development

```bash
cd mcp-server
npm install
npm link                          # global `clawdevbox` → this checkout
npm test                          # 44 tests, ~9s on Windows
npm run build                     # bundles src/cli/index.ts → dist/cli.js (esbuild)
```

Tests spawn the server through `npx tsx src/index.ts mcp`. To force the
server to spawn recipe-run agents back through `tsx src/index.ts` (instead
of `npx -y clawdevbox mcp`), set `CLAWDEVBOX_SPAWN_TSX=1`.

## What's still in-memory (next phases)

- `inbox.*` / `thread.*` / `approval.*` rows live in `Map`s. SQLite kernel
  (with FTS5) replaces this in the next phase.
- Cron daemon — `trigger.register` records the entry but no in-process
  scheduler fires it yet.
- `signal.*` pub/sub.
