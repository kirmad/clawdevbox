# ClawDevbox

**Agents for developers** — a toolkit for running AI coding agents (GitHub Copilot CLI, Claude Code, Cursor) headlessly inside hidden pseudo-terminals, with browser-based viewers for both live terminals and rendered artifacts (markdown design docs, PR reviews, code walkthroughs).

> ⚠️ Pre-release. The reference implementation is here as a working sample. APIs and on-disk formats are not stable yet.

## What it gives you

- **Hidden agent runs.** Spawn `agency copilot`, `claude`, or any TTY-driven CLI inside a `node-pty` (ConPTY on Windows) — no console window flashes. Each run gets an isolated workspace under `~/.conductor/workspaces/<id>/`.
- **Live browser viewer for any running agent.** An HTTP/WebSocket server attached to the MCP layer exposes `view_url`s. Open in any browser, see the live xterm, type input, kill the session.
- **Renderable artifacts.** Agents call `artifact.add(id, type, ...)` to publish a folder of files (design docs, PR reviews, walkthroughs). The viewer dynamic-imports a `.mjs` renderer matched on `type`. Three built-in renderers ship: `markdown`, `pr-review`, `walkthrough`. Renderers are extensible by plugins or by the agent itself (workspace → plugin → built-in resolution chain).
- **MCP-first surface.** Recipes (YAML task templates), skills (prompt snippets), triggers (cron / webhook-fired scripts), plugins, workspaces, inbox / threads / approvals — every verb is an MCP tool, so the same surface works from a side-terminal CLI, an external agent, or the eventual desktop app.

## Repository layout

```
clawdevbox/
├── docs/
│   ├── design.md         The simplified architecture spec.
│   └── research/         Background — agent-CLI patterns,
│                         Goose deep-dive, legacy audit.
└── samples/
    ├── mcp-server/       Reference MCP server (Node + node-pty + ws).
    │                     Built-in renderers, recipe / skill / trigger /
    │                     artifact / renderer / workspace / inbox tools,
    │                     terminal + artifact HTTP viewer, Playwright
    │                     verification scripts.
    ├── sdk/              TypeScript SDK skeleton.
    ├── triggers/         Trigger script samples (TS + Python),
    │                     mock-conductor test driver.
    ├── recipes/          Recipe YAML samples (simple-prompt).
    └── plugins/          Plugin samples (ADO trigger types + hostable
                          tools + skills + recipes).
```

## Quick start

```bash
git clone https://github.com/<your-org>/clawdevbox
cd clawdevbox/samples/mcp-server
npm install
npx playwright install chromium
```

Three demos you can run immediately (each opens a headed Chromium):

```bash
# Live terminal viewer over a hidden node-pty
npx tsx demo-terminal-view.mjs

# Interactive `agency copilot` inside the hidden pty, viewed in browser
npx tsx demo-agency-interactive.mjs

# Code walkthrough overlay (floating panel on top of the diff)
npx tsx demo-walkthrough.mjs

# Full PR review viewer with hierarchical file tree + full-file diff
npx tsx demo-pr-review.mjs
```

End-to-end verification scripts:

```bash
# Agency copilot ↔ MCP round-trip via recipe.run
node e2e-test.mjs

# Locked-size xterm survives browser resize without misalignment
npx tsx verify-agency-alignment.mjs

# All three built-in renderers tested in headless Chromium with screenshots
npx tsx verify-artifacts.mjs
```

## Concepts

| Concept | Backing store | Lifecycle |
|---|---|---|
| **Recipe** | `.conductor/recipes/<id>.yaml` | Author-time. Templates a multi-step agent run. |
| **Recipe instance** | `<workspace>/.conductor/recipe-instances/<id>.json` | Per `recipe.run`. Tracks status / result / pid / log path. |
| **Skill** | `.conductor/skills/<id>.md` | Author-time. Prompt snippet the agent can include. |
| **Trigger** | `.conductor/triggers.json` + `.conductor/triggers/<id>.ts\|py\|sh` | Cron / webhook / manual. POSTs to a callback URL when something fires. |
| **Workspace** | `<workspaces_root>/<id>/` | Per recipe run or long-lived. Holds `.conductor/` state + `artifacts/`. |
| **Artifact** | `<workspace>/artifacts/<id>/` | Folder with `manifest.json` + content files. Renderer dispatch on `manifest.type`. |
| **Plugin** | `<plugin_dir>/plugin.yaml` + provides tree | Ships recipes, skills, triggers, hostable tools, renderers. |
| **PTY session** | In-memory registry (terminal-server.ts) | Per `recipe.run`. Browser viewers subscribe over WebSocket. |

## Internal codename

This codebase uses **`conductor`** as the internal namespace — env vars (`CONDUCTOR_*`), on-disk paths (`.conductor/`), npm package names (`@conductor/mcp-server`). The branding is **ClawDevbox**; the engine that runs underneath is the **Conductor MCP server**. Don't refactor the internals — the name is load-bearing and stable across the spec and the samples.

## Design spec

See [`docs/design.md`](docs/design.md) for the full architecture spec (~1900 lines). Section index:

- §3 — Glossary (Plugin, Recipe, Trigger type vs. registered trigger, Skill, Scope, Hostable tool).
- §6.1 — MCP tool catalog (55+ tools).
- §7 — Recipes.
- §8 — Triggers (Type vs. Registered, parameter schema, cron lifecycle).
- §10 — Plugins (manifest, discovery, scope/shadowing, hostable tools, git-based install).

## Research

- [`docs/research/agent-cli-architectures.md`](docs/research/agent-cli-architectures.md) — How GitHub Copilot CLI, Claude Code, Cursor agents, Aider, and others structure themselves.
- [`docs/research/goose-deep-dive.md`](docs/research/goose-deep-dive.md) — Block's Goose: recipe model, executor architecture, lessons.
- [`docs/research/goose-vs-clawdevbox-arch.md`](docs/research/goose-vs-clawdevbox-arch.md) — Side-by-side comparison of choices.
- [`docs/research/legacy-taskdock-audit.md`](docs/research/legacy-taskdock-audit.md) — What worked in the predecessor and what we kept.

## License

MIT. See [LICENSE](LICENSE).
