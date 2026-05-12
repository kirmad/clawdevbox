# Samples

Example content for ClawDevbox. The MCP server itself lives at `../mcp-server/`; what's here is intended to be consumed by it — recipes you can run, plugins you can install, triggers you can register.

## `triggers/` — Trigger script samples

How a trigger fires data back to the orchestrator. TypeScript + Python samples for an Azure DevOps PR-comment watcher. Includes a `mock-conductor.ts` test driver and `test-driver.ts` that exercises 7 scenarios (cron, external, manual, …).

```bash
cd samples/triggers
npm install
node test/capture.mjs   # full end-to-end against real ADO (needs az login)
```

## `recipes/` — Recipe YAML samples

Minimal `simple-prompt.yaml` showing the recipe shape. Used by `e2e-test.mjs` in `../mcp-server/`.

## `plugins/` — Plugin samples

`ado/` — an Azure DevOps plugin with three trigger types (cron, webhook, comment-watcher), five hostable tools, two recipes, two skills. Shows the full plugin layout (`plugin.yaml` + `recipes/` + `skills/` + `triggers/` + `tools/`).

## Common conventions

- **`@conductor/*` npm scope** — internal package names are still `@conductor/...` because the codebase uses `conductor` as its load-bearing internal name. The product brand is ClawDevbox; the engine is Conductor.
- **`.conductor/`** — every workspace has one. Holds `recipes/`, `skills/`, `plugins/`, `triggers.json`, `workspace.json`, `recipe-instances/`, optional `renderers/`.
- **`artifacts/`** — sibling of `.conductor/`, NOT inside it. Each artifact is a folder with `manifest.json` + content files.
- **Env vars** — `CONDUCTOR_PROJECT_DIR` (required), `CONDUCTOR_WORKSPACES_ROOT`, `CONDUCTOR_TERMINAL_PORT`, `CONDUCTOR_RECIPE_INSTANCE_ID`, `CONDUCTOR_WORKSPACE_ID`, `CONDUCTOR_MCP_SECRET`. The spawned agent reads its instance / workspace ids from env so it can call `recipe.done` and `recipe.instance_info` back to the parent.
