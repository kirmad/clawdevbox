# ClawDevbox

**Agents for developers** — a toolkit for running AI coding agents (GitHub Copilot CLI, Claude Code, Cursor) headlessly inside hidden pseudo-terminals, with browser-based viewers for both live terminals and rendered artifacts (markdown design docs, PR reviews, code walkthroughs).

> ⚠️ Pre-release. The reference implementation is here as a working sample. APIs and on-disk formats are not stable yet.

## What it gives you

- **Hidden agent runs.** Spawn `agency copilot`, `claude`, or any TTY-driven CLI inside a `node-pty` (ConPTY on Windows) — no console window flashes. Each run gets an isolated workspace under `~/.clawdevbox/workspaces/<id>/`.
- **Live browser viewer for any running agent.** An HTTP/WebSocket server attached to the MCP layer exposes `view_url`s. Open in any browser, see the live xterm, type input, kill the session.
- **Renderable artifacts.** Agents call `artifact.add(id, type, ...)` to publish a folder of files (design docs, PR reviews, walkthroughs). The viewer dynamic-imports a `.mjs` renderer matched on `type`. Three built-in renderers ship: `markdown`, `pr-review`, `walkthrough`. Renderers are extensible by plugins or by the agent itself (workspace → plugin → built-in resolution chain).
- **MCP-first surface.** Recipes (YAML task templates), skills (prompt snippets), triggers (cron / webhook-fired scripts), plugins, workspaces, inbox / threads / approvals — every verb is an MCP tool, so the same surface works from a side-terminal CLI, an external agent, or the eventual desktop app.

## Repository layout

```
clawdevbox/
├── docs/
│   └── design.md         The simplified architecture spec.
├── mcp-server/           Reference MCP server (Node + node-pty + ws).
│                         Built-in renderers, recipe / skill / trigger /
│                         artifact / renderer / workspace / inbox tools,
│                         terminal + artifact HTTP viewer, Playwright
│                         verification scripts.
├── sdk/                  TypeScript SDK skeleton.
└── samples/
    ├── triggers/         Trigger script samples (TS + Python),
    │                     mock-conductor test driver.
    ├── recipes/          Recipe YAML samples (simple-prompt).
    └── plugins/          Plugin samples (ADO trigger types + hostable
                          tools + skills + recipes).
```

## Quick start

```bash
git clone https://github.com/<your-org>/clawdevbox
cd clawdevbox/mcp-server
npm install
npx playwright install chromium
```

### Install and run

`clawdevbox init` is the single setup command. It asks for an **install scope**:

- **Global (recommended)** — writes account-wide config to
  `<globalDir>/config.json` (defaults to `~/.clawdevbox/config.json`).
  Plugins also live globally under `<globalDir>/plugins/`. One install per
  user; every project sees the same MCP server, tunnel, and plugin set.
- **Project-specific** — legacy per-project config under
  `<projectDir>/.clawdevbox/config.json`. Useful when you want a separate
  port / token / tunnel per project.

```bash
clawdevbox init                          # interactive
clawdevbox init --scope global --plugin git+https://example.com/some-plugin.git
```

After `init`, three ways to run the MCP server:

```bash
# Stdio MCP — wired up by your agent (Claude Code, agency copilot, ...).
clawdevbox mcp

# HTTP MCP foreground — runs until you Ctrl+C.
clawdevbox start

# HTTP MCP background — detaches, registers OS auto-start at login.
clawdevbox start --service        # install + start now (idempotent)
clawdevbox status                 # is it running? auto-start installed?
clawdevbox stop                   # halt; auto-start remains registered
clawdevbox uninstall-service      # stop + remove auto-start
```

The service uses Windows Task Scheduler (`schtasks`), macOS LaunchAgents
(`launchctl`), or Linux systemd-user (`systemctl --user`) for "always
running across reboots" semantics. PID + port are recorded in
`<globalDir>/service.json` so `stop` always finds the running instance.

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
| **Recipe** | `.clawdevbox/recipes/<id>.yaml` | Author-time. Templates a multi-step agent run. |
| **Recipe instance** | `<workspace>/.clawdevbox/recipe-instances/<id>.json` | Per `recipe.run`. Tracks status / result / pid / log path. |
| **Skill** | `.clawdevbox/skills/<id>.md` | Author-time. Prompt snippet the agent can include. |
| **Trigger** | `.clawdevbox/triggers.json` + `.clawdevbox/triggers/<id>.ts\|py\|sh` | Cron / webhook / manual. POSTs to a callback URL when something fires. |
| **Workspace** | `<workspaces_root>/<id>/` | Per recipe run or long-lived. Holds `.clawdevbox/` state + `artifacts/`. |
| **Artifact** | `<workspace>/artifacts/<id>/` | Folder with `manifest.json` + content files. Renderer dispatch on `manifest.type`. |
| **Plugin** | `<global_dir>/plugins/<id>/` (real dir for git/built-in, junction for local-folder installs) + sibling `<id>.install.json` | Shared across all projects on the account. Ships recipes, skills, triggers, hostable tools, renderers. |
| **PTY session** | In-memory registry (terminal-server.ts) | Per `recipe.run`. Browser viewers subscribe over WebSocket. |

## Internal codename

This codebase uses **`conductor`** as the internal namespace — env vars (`CLAWDEVBOX_*`), on-disk paths (`.clawdevbox/`), npm package names (`clawdevbox`). The branding is **ClawDevbox**; the engine that runs underneath is the **Conductor MCP server**. Don't refactor the internals — the name is load-bearing and stable across the spec and the samples.

## Design spec

See [`docs/design.md`](docs/design.md) for the full architecture spec (~1900 lines). Section index:

- §3 — Glossary (Plugin, Recipe, Trigger type vs. registered trigger, Skill, Scope, Hostable tool).
- §6.1 — MCP tool catalog (55+ tools).
- §7 — Recipes.
- §8 — Triggers (Type vs. Registered, parameter schema, cron lifecycle).
- §10 — Plugins (manifest, discovery, scope/shadowing, hostable tools, git-based install).

## License

MIT. See [LICENSE](LICENSE).
