# Samples

Reference implementations for ClawDevbox. Each directory is self-contained — no cross-references between samples beyond what's documented here.

## `mcp-server/` — The reference Conductor MCP server

The main sample. Node.js + TypeScript + `node-pty` + `ws`. Exposes recipes / skills / triggers / plugins / workspaces / inbox / threads / approvals / artifacts / renderers over the Model Context Protocol, plus an HTTP/WebSocket server hosting the live terminal viewer and the browser-based artifact viewer.

**Run it:**

```bash
cd samples/mcp-server
npm install
npx playwright install chromium   # for the verify-*.mjs scripts

# Demos (each opens a headed Chromium window)
npx tsx demo-terminal-view.mjs        # tick+echo pty viewer
npx tsx demo-agency-interactive.mjs   # live `agency copilot` inside hidden pty
npx tsx demo-walkthrough.mjs          # floating-overlay walkthrough renderer
npx tsx demo-pr-review.mjs            # full-file PR review with hierarchical tree

# Verification (headless)
node e2e-test.mjs                     # recipe.run → agency copilot → recipe.done round-trip
npx tsx verify-agency-alignment.mjs   # locked xterm cols/rows survive browser resize
npx tsx verify-artifacts.mjs          # all 3 built-in renderers + screenshots
```

**Layout:**

```
mcp-server/
├── src/
│   ├── index.ts                       Bootstraps MCP + terminal server.
│   ├── workspace.ts                   Workspace config loading.
│   ├── workspaces-store.ts            On-disk registry of workspaces.
│   ├── artifact-store.ts              <workspace>/artifacts/<id>/ I/O.
│   ├── pty-registry.ts                In-memory pty session map (ring buffer + subscribers).
│   ├── terminal-server.ts             HTTP + WS: /terminal/:id, /artifact/:id,
│   │                                  /__renderer/:type.mjs.
│   ├── renderer-registry.ts           workspace → plugin → builtin resolution chain.
│   ├── recipe-instances-store.ts      <workspace>/.conductor/recipe-instances/.
│   ├── triggers-store.ts              <workspace>/.conductor/triggers.json.
│   ├── tools/
│   │   ├── recipe.ts                  recipe.list/read/upsert/delete/run/done/instance_info/view_url/kill/list_running
│   │   ├── skill.ts
│   │   ├── trigger.ts                 list_types/list_registered/register/unregister/...
│   │   ├── plugin.ts
│   │   ├── workspace.ts               create/list/get/current
│   │   ├── inbox.ts, thread.ts, approval.ts   (in-memory stubs)
│   │   ├── stubs.ts                   artifact/view/search/signal (NOT_IMPLEMENTED placeholders for now)
│   │   ├── artifact.ts                add/list/get/delete
│   │   ├── renderer.ts                list/read/write/delete (workspace-level)
│   │   └── hosted.ts                  Plugin-shipped hostable tools.
│   └── renderers/
│       ├── markdown.mjs               marked + highlight.js + mermaid
│       ├── pr-review.mjs              hierarchical FileTree + full-file diff (TaskDock pattern)
│       └── walkthrough.mjs            Floating draggable/resizable overlay
├── tests/                             tsx --test
├── demo-*.mjs                         headed-Chromium manual demos
├── verify-*.mjs                       headless verification + screenshots
└── e2e-test.mjs                       end-to-end with real `agency copilot`
```

## `sdk/` — TypeScript SDK skeleton

Stub for a client SDK that wraps the MCP tool calls. Not wired into the demos yet.

## `triggers/` — Trigger script samples

How a trigger fires data back to the orchestrator. TypeScript + Python samples for an Azure DevOps PR-comment watcher. Includes a `mock-conductor.ts` test driver and `test-driver.ts` that exercises 7 scenarios (cron, external, manual, ...).

```bash
cd samples/triggers
npm install
node test/capture.mjs   # full end-to-end against real ADO (needs az login)
```

## `recipes/` — Recipe YAML samples

Minimal `simple-prompt.yaml` showing the recipe shape. Used by `e2e-test.mjs` in `mcp-server/`.

## `plugins/` — Plugin samples

`ado/` — an Azure DevOps plugin with three trigger types (cron, webhook, comment-watcher), five hostable tools, two recipes, two skills. Shows the full plugin layout (`plugin.yaml` + `recipes/` + `skills/` + `triggers/` + `tools/`).

## Common conventions

- **`@conductor/*` npm scope** — internal package names are still `@conductor/...` because the codebase uses `conductor` as its load-bearing internal name. The product brand is ClawDevbox; the engine is Conductor.
- **`.conductor/`** — every workspace has one. Holds `recipes/`, `skills/`, `plugins/`, `triggers.json`, `workspace.json`, `recipe-instances/`, optional `renderers/`.
- **`artifacts/`** — sibling of `.conductor/`, NOT inside it. Each artifact is a folder with `manifest.json` + content files.
- **Env vars** — `CONDUCTOR_PROJECT_DIR` (required), `CONDUCTOR_WORKSPACES_ROOT`, `CONDUCTOR_TERMINAL_PORT`, `CONDUCTOR_RECIPE_INSTANCE_ID`, `CONDUCTOR_WORKSPACE_ID`, `CONDUCTOR_MCP_SECRET`. The spawned agent reads its instance / workspace ids from env so it can call `recipe.done` and `recipe.instance_info` back to the parent.
