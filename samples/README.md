# Samples

Example content for ClawDevbox. The MCP server itself lives at `../mcp-server/`; what's here is intended to be consumed by it — recipes you can run, plugins you can install, triggers you can register.

## `triggers/` — Trigger script samples

How a trigger fires data back to the orchestrator. TypeScript + Python samples for an Azure DevOps PR-comment watcher. Includes a `mock-clawdevbox.ts` test driver and `test-driver.ts` that exercises 7 scenarios (cron, external, manual, …).

```bash
cd samples/triggers
npm install
node test/capture.mjs   # full end-to-end against real ADO (needs az login)
```

## `recipes/` — Recipe YAML samples

Minimal `simple-prompt.yaml` showing the recipe shape. Used by `e2e-test.mjs` in `../mcp-server/`.

## Note: built-in plugins moved

Built-in plugins (`ado`, `dev-buddy`, `clawdevbox-mcp`) now live at the
repo-root `plugins/` directory and ship as a marketplace catalog via
`.claude-plugin/marketplace.json`. This `samples/` directory keeps only
sample recipes and trigger fixtures used by tests.

## Common conventions

- **`@clawdevbox/*` npm scope** — internal package names are still `@clawdevbox/...` because the codebase uses `clawdevbox` as its load-bearing internal name. The product brand is ClawDevbox; the engine is Clawdevbox.
- **`.clawdevbox/`** — every workspace has one. Holds `recipes/`, `skills/`, `plugins/`, `triggers.json`, `workspace.json`, `recipe-instances/`, optional `renderers/`.
- **`artifacts/`** — sibling of `.clawdevbox/`, NOT inside it. Each artifact is a folder with `manifest.json` + content files.
- **Env vars** — `CLAWDEVBOX_PROJECT_DIR` (optional; defaults to cwd), `CLAWDEVBOX_WORKSPACES_ROOT`, `CLAWDEVBOX_TERMINAL_PORT`, `CLAWDEVBOX_RECIPE_INSTANCE_ID`, `CLAWDEVBOX_WORKSPACE_ID`, `CLAWDEVBOX_MCP_SECRET`. The spawned agent reads its instance / workspace ids from env so it can call `recipe.done` and `recipe.instance_info` back to the parent.
