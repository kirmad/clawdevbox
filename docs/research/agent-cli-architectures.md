# Agent CLI Architectures — Reference Research (2026-05-08)

Research scan to inform a Conductor simplification: flip the model so external CLI agents drive the work, MCP is the spine of extensibility, and the Tauri UI is a thin viewer (inbox + Claude-Code-like side terminal).

Each entry: architecture in one paragraph, MCP role, inbox/queue surface, extensibility model, UI/CLI separation, persistence, what to borrow, what to avoid.

---

## OpenClaw

A communication-channel-driven agent harness whose central trick is that *any* MCP-capable client (Claude Code, Cursor, Codex, etc.) can drive an OpenClaw runtime by speaking to its stdio MCP bridge. The CLI ships three surfaces: `openclaw` (interactive), `openclaw-cli` (lets other agents talk in over terminal/MCP), and `openclaw mcp serve` which connects to the OpenClaw Gateway over WebSocket and exposes routed channel conversations to MCP clients. There is also `acpx`, a headless ACP (Agent Client Protocol) client that replaces PTY-scraping with a structured protocol across Pi, OpenClaw, Codex, and Claude.
- **MCP role:** Both. Server (`openclaw mcp serve` exposes ~10 tools — list conversations, read messages, send replies, handle approvals) and client (registry of outbound MCP servers managed via `mcp list/show/set/unset`).
- **Inbox / queue:** "Live event queue" — messages, approval requests, and Claude-specific notifications are queued in memory while the bridge is connected; older history fetched separately via `messages_read`. **No durable backlog replay** — queue starts fresh per bridge connection.
- **Extensibility:** Adding capability = registering an MCP server. Channel adapters (Slack, Telegram, etc.) feed the gateway; outbound MCP servers feed the runtime.
- **UI/CLI:** Thin. The "UI" is whatever client connects (Claude Code's TUI, a chat channel). OpenClaw orchestrates and exposes; it doesn't own a heavy UI.
- **Persistence:** Gateway-side WebSocket + in-memory live queue. Older messages persisted server-side, fetched on demand.
- **Borrow:** The "expose Conductor's inbox over MCP so any agent can drive it" pattern is *exactly* what the user is asking for. Also: `acpx` confirms there is a real industry move from PTY scraping to structured agent protocols — relevant for the side-terminal redesign.
- **Avoid:** In-memory-only queue (loses state on bridge disconnect); no message edit/react tools yet. Push channel is Claude-specific — don't hardcode an adapter.
- Sources: [openclaw-cli](https://github.com/TimoBechtel/openclaw-cli), [docs.openclaw.ai/cli/mcp](https://docs.openclaw.ai/cli/mcp), [acpx](https://github.com/openclaw/acpx), [Pi: The Minimal Agent](https://lucumr.pocoo.org/2026/1/31/pi/)

## Hermes Agent (Nous Research)

Self-improving agent that lives across CLI, Telegram, Discord, Slack, and 15+ platforms from one gateway. Single agent core, many adapters. The CLI is a full TUI with multiline editing, slash autocomplete, streaming tool output, and an explicit message queue (`/queue` command, `display.busy_input_mode = "queue"`).
- **MCP role:** Both. Connects out to MCP servers for tools; runs as an MCP server so other clients (Claude Code, Cursor) can call Hermes's messaging tools — list conversations, read history, send messages across all connected platforms.
- **Inbox / queue:** First-class. `/queue` lets users line up follow-ups without interrupting in-flight work; base adapter queues into `_pending_messages` while a session is active. Multi-Agent Kanban added in v0.13.
- **Extensibility:** MCP servers + pluggable providers + platform adapters. The "platform adapter" abstraction is the trick that lets Slack/Discord/Telegram all behave like the same inbox.
- **UI/CLI:** No heavy GUI — chat platforms *are* the UI. The TUI is a power-user surface; everything else is bring-your-own-channel.
- **Persistence:** SQLite + JSON. The MCP server reads conversation data directly from `~/.hermes/sessions/sessions.json` plus a SQLite db. This is the cleanest reference implementation we found of "MCP server is a thin reader on top of a session store."
- **Borrow:** (1) MCP-server-as-inbox-reader on top of SQLite is a near-perfect template for Conductor. (2) The platform-adapter pattern — one core, N channels, each channel feeding the same queue. (3) `/queue` UX for "agent is busy, stack work for it."
- **Avoid:** Don't conflate the chat-platform adapters with core agent logic — Hermes keeps them at the edges, and we should too.
- Sources: [hermes-agent](https://github.com/NousResearch/hermes-agent), [MCP docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), [v0.13 reference](https://blakecrosley.com/guides/hermes)

## OpenCode (sst/opencode)

Client-server architecture: an `opencode serve` backend (Hono-based HTTP/SSE) handles AI interactions; multiple clients (TUI, desktop, web) connect to it. A `SessionPrompt` orchestrates the agent loop, calling `Provider.getModel()` and `Tool.define()`. Two built-in agents: `build` (full access) and `plan` (read-only).
- **MCP role:** Client only. Tools register automatically alongside built-in tools. Supports stdio + remote (HTTP, OAuth). No documented server-mode where other agents drive OpenCode.
- **Inbox / queue:** None as a first-class surface. Sessions are the unit; multiple sessions can run.
- **Extensibility:** MCP servers + agent definitions in config (`build`, `plan`, custom). Tools enable/disable globally or per-agent via glob.
- **UI/CLI:** Strong CLI/TUI; desktop and web are alternate clients on the same server. **This separation — backend service + thin clients — is the model TaskDock already half-has** (sidecar + Tauri).
- **Persistence:** Session-based, server-managed.
- **Borrow:** Backend-as-service with multiple thin clients. Per-agent tool allowlists via glob (cleaner than per-tool flags).
- **Avoid:** No queue/inbox abstraction — would have to be added.
- Sources: [opencode.ai/docs](https://opencode.ai/docs/), [MCP servers](https://opencode.ai/docs/mcp-servers/), [DeepWiki](https://deepwiki.com/sst/opencode)

## Aider

Terminal-only pair-programmer. Coder system coordinates LLM ↔ filesystem ↔ git, with variant Coders (EditBlock, WholeFile, UnifiedDiff, Architect) for different edit formats. LiteLLM routing to 100+ providers. Repo map uses a graph-rank algorithm to fit the most relevant code into the token budget.
- **MCP role:** None natively (as of public docs). Tools are built-in coders, not MCP-driven.
- **Inbox / queue:** None. Aider is single-session, single-prompt.
- **Extensibility:** Conventions files (`CONVENTIONS.md`-style), edit format choice, model choice. Limited compared to MCP-first peers.
- **UI/CLI:** CLI-only. No GUI.
- **Persistence:** Git is the persistence layer. Atomic commits per change. Conventions files = persistent project memory.
- **Borrow:** **Repo map ranking** — graph-rank to fit a budget is a reusable idea for any agent that needs codebase context. **Atomic commit per agent step** as a durability/undo strategy.
- **Avoid:** Single-session, no MCP. Not a structural model for our redesign.
- Sources: [Aider repo map](https://aider.chat/docs/repomap.html), [Better Stack guide](https://betterstack.com/community/guides/ai/aider-ai-pair-programming/)

## Cline (and Roo Code fork)

VS Code extension acting as autonomous coder with human-in-the-loop approval. Plan/Act pipeline — every tool call is approved, governed, logged. Roo Code forks Cline and adds a multi-mode system (Code/Architect/Ask/Debug).
- **MCP role:** Client + factory. Cline can both *use* and *create* MCP servers — "ask Cline to add a tool" and it scaffolds, installs, and registers a new MCP server. No tool cap (vs. Cursor's 40).
- **Inbox / queue:** None. Task-at-a-time.
- **Extensibility:** Custom MCP servers (built by Cline itself), Plan/Act gating, Rules files. Roo adds modes.
- **UI/CLI:** GUI inside VS Code. Heavy UI — explicit approval per step, diff view per edit.
- **Persistence:** Workspace files + VS Code state.
- **Borrow:** The "agent generates and installs its own MCP server" loop is a great extensibility story — Conductor could let an agent ship a new capability without code changes to the host.
- **Avoid:** Approval-per-tool-call is heavy and ergonomic-dragging when scaled to autonomous work. The Plan/Act dichotomy is more rigid than needed for our case.
- Sources: [cline/cline](https://github.com/cline/cline), [Cline docs](https://docs.cline.bot/home), [Cline MCP setup](https://www.agensi.io/learn/cline-mcp-setup-guide)

## Continue.dev

VS Code/JetBrains extension organized around a `config.yaml` of models, rules, and tools (MCP servers). Three modes: Chat (no tools), Plan (read-only), Agent (all tools). MCP only available in Agent mode.
- **MCP role:** Client. Transports: stdio, SSE, streamable-HTTP, WebSocket via `@modelcontextprotocol/sdk`. **Drops Claude-Desktop / Cursor / Cline `mcp.json` files into `.continue/mcpServers/` — auto-discovered.**
- **Inbox / queue:** None.
- **Extensibility:** Config-driven (YAML). Custom slash commands, prompt templates, rules. Context Providers for sources.
- **UI/CLI:** IDE extension. Tool-call permission modes: Ask First (default) vs Automatic.
- **Persistence:** Config files + IDE state.
- **Borrow:** **Drop-folder MCP server config** (`.continue/mcpServers/*.json`) — interoperates with Cursor/Cline/Claude Desktop configs. Conductor should read the same format so users don't reconfigure their MCP fleet. Per-tool permission mode (Ask First vs Automatic) is the right granularity.
- **Avoid:** Mode-locked tool access (MCP only in Agent mode) is a footgun; tools either exist or they don't.
- Sources: [Continue MCP docs](https://docs.continue.dev/customize/deep-dives/mcp), [config.yaml reference](https://docs.continue.dev/reference), [DeepWiki MCP integration](https://deepwiki.com/continuedev/continue/3.5-mcp-integration)

## Claude Code

Core is a simple while-loop: call model → run tools → repeat. Surrounding systems: 7-mode permission system, 5-layer compaction pipeline, **four extensibility mechanisms** (MCP, plugins, skills, hooks), and subagent delegation.
- **MCP role:** Client (host). Consumes MCP servers; not documented as running its own server-mode for other agents to call. (OpenClaw and Hermes fill this gap by exposing themselves *to* Claude Code.)
- **Inbox / queue:** None native. Sessions/threads are local.
- **Extensibility — four-tier model with explicit cost trade-offs:**
  | Mechanism | Context cost | Deploy complexity | When to use |
  |---|---|---|---|
  | **Skills** (`.claude/skills/SKILL.md`) | Lowest — only frontmatter in prompt | Low (filesystem) | Domain knowledge / workflows |
  | **Hooks** (settings.json) | Minimal — event-driven | Low (JSON) | Enforce standards, side-effects |
  | **MCP servers** | Higher — tool schemas in context (improving with deferred loading 2026) | Moderate (server setup) | External tools/data |
  | **Plugins** | Cumulative (bundle of above) | Low (distributable) | Team sharing |
- **Subagents:** Isolated context windows, separate system prompts, restricted tool sets, per-agent model choice (Haiku/Sonnet/Opus), optional worktree isolation. Built-ins: Explore, Plan, General-purpose. Prevents "context poisoning."
- **UI/CLI:** TUI; relies on terminal. Hooks make it scriptable.
- **Persistence:** Local files; settings.json; markdown skills.
- **Borrow:** **The four-tier extensibility model** is the cleanest taxonomy in the field. Conductor should map to it explicitly: MCP for external integrations, Skills (markdown) for domain workflows, Hooks for enforcement, Plugins for distribution. **Subagents with worktree isolation** map directly to Conductor scenarios (PR review, incident, work item, epic) — each is a subagent class.
- **Avoid:** Claude Code does not expose itself over MCP for other agents to drive. Conductor *should* — that's the inversion the user wants.
- Sources: [Understanding Claude Code's full stack](https://alexop.dev/posts/understanding-claude-code-full-stack/), [Claude Code docs](https://code.claude.com/docs/en/how-claude-code-works), [Penligent inside-Claude-Code](https://www.penligent.ai/hackinglabs/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/)

## Goose (now Agentic AI Foundation, formerly Block)

Rust-based agent with modular architecture: core agent loop, provider abstraction, MCP-based extension system. Ships as **CLI + Electron desktop both connecting to the same agent core**. 70+ documented MCP extensions, 3000+ via the wider MCP ecosystem. Apache 2.0.
- **MCP role:** Client. One of the earliest and deepest MCP integrations. Extensions = MCP servers.
- **Inbox / queue:** Sessions; recipes (reusable workflow definitions) are the closest thing to a queue abstraction.
- **Extensibility:** MCP extensions + recipes (reusable parameterized workflows).
- **UI/CLI:** Both — Electron desktop + `goose session` CLI on the same backend. Direct precedent for what TaskDock already does.
- **Persistence:** Session-based; details not in primary docs.
- **Borrow:** **CLI + GUI on the same backend** is exactly TaskDock's split. **Recipes** as parameterized, reusable workflows are a lightweight alternative to TaskDock's heavy plugin/AutoPolicy system — a recipe is just a markdown/YAML file with prompts + tool list.
- **Avoid:** No noted inbox abstraction.
- Sources: [block/goose](https://github.com/block/goose), [goose docs](https://block-goose.mintlify.app/), [Block intro](https://block.xyz/inside/block-open-source-introduces-codename-goose)

## Smithery / mcp.so / PulseMCP / Glama

The MCP registry layer. Three flavors:
- **Smithery** — registry + CLI for installing/managing/developing MCP servers, can run servers in their own infra. ~7000 servers. The "Docker Hub of MCP."
- **mcp.so** — community-curated educational/discovery layer. ~19,700 servers, broader but less curated.
- **PulseMCP** — hand-reviewed directory.
- **modelcontextprotocol/servers** — official reference registry.
- **Borrow:** Conductor doesn't need its own registry, but **should treat Smithery/mcp.so as the discovery surface** — "Add a capability" UI = "browse Smithery" or "paste an MCP URL." Don't build a TaskDock-only plugin marketplace.
- **Avoid:** Don't fork the directory game. Conductor's value is the inbox + workflows, not the registry.
- Sources: [Smithery CLI](https://github.com/smithery-ai/cli), [TrueFoundry registries comparison](https://www.truefoundry.com/blog/best-mcp-registries), [WorkOS Smithery](https://workos.com/blog/smithery-ai)

## Sourcegraph Amp

CLI-only (VS Code extension killed March 2026) coding agent built on top of Sourcegraph code search. **Threads are the central abstraction**, stored server-side at `ampcode.com/threads`. Multiple threads run simultaneously; threads are **permanent team assets** (vs. Cursor's ephemeral chats). Subagents (Oracle for codebase analysis, Librarian for external libraries) handle specialized work in isolated context windows. Handoff threads replace lossy compaction.
- **MCP role:** Client.
- **Inbox / queue:** **Yes — server-side persistent threads with multi-thread parallelism.** This is the closest existing analog to what the user wants Conductor's inbox to feel like.
- **Extensibility:** AGENT.md per project (rules/constraints), subagents (Oracle, Librarian) as specialized roles, MCP for tools.
- **UI/CLI:** CLI + web at ampcode.com/threads (the inbox surface). Web is a thin viewer of server-stored threads.
- **Persistence:** Server-side. All threads durable; team-shareable.
- **Borrow:** **Threads-as-team-assets** with a thin web viewer is a near-perfect mental model for Conductor. **Subagents-as-roles** (Oracle = code search; Librarian = external lookup) maps to Conductor's scenarios. **Handoff threads** instead of compaction is a cleaner UX for long-running work.
- **Avoid:** Server-side-only (no local-first option) won't fly for an enterprise desktop tool. Threads must be local-first SQLite with optional sync.
- Sources: [Amp by Sourcegraph](https://ampcode.com/), [Amp examples & guides](https://github.com/sourcegraph/amp-examples-and-guides), [Amp Code review](https://www.secondtalent.com/resources/amp-ai-review/)

## Sourcegraph Cody (legacy, pre-Amp)

VS Code/JetBrains/NeoVim extension. The `@sourcegraph/cody-agent` package implements a **JSON-RPC server over stdin/stdout** so non-ECMAScript clients (JetBrains, NeoVim) can drive Cody. Custom Commands stored in `~/.vscode/cody.json` (user) or `.vscode/cody.json` (workspace).
- **Borrow:** **JSON-RPC-over-stdio as the agent driver protocol** — a clean alternative to PTY scraping, predates ACP. Custom commands as workspace-scoped JSON files.
- Sources: [cody-agent npm](https://www.npmjs.com/package/@sourcegraph/cody-agent), [Cody custom commands](https://docs.sourcegraph.com/cody/custom-commands)

## Devin (Cognition)

Autonomous SWE agent. **Slack/Linear/Jira/web app are the inbox** — natural-language ticket → Devin instance. Engineers run multiple Devins in parallel, each with its own cloud IDE; engineer's role becomes PR review and high-level direction.
- **Inbox / queue:** External SaaS (Linear, Jira, Slack) *is* the queue. Devin doesn't reinvent it; it subscribes.
- **Borrow:** **"Don't build an inbox — subscribe to the user's existing one"** is a powerful design choice. ADO work items, GitHub issues, Slack threads can all feed Conductor's queue rather than asking the user to maintain a separate one.
- **Avoid:** Cloud-only, opaque internals; not directly applicable to a desktop app.
- Sources: [Cognition Devin 2.0](https://cognition.ai/blog/devin-2), [Devin technical deep-dive](https://medium.com/@takafumi.endo/agent-native-development-a-deep-dive-into-devin-2-0s-technical-design-3451587d23c0)

## Factory AI (Droids)

Coordinator agent decomposes work and dispatches to **role-specialized droids** (Code, Review, Docs, Test, Knowledge, Incident). Multi-model routing — Claude for planning, DeepSeek for high-volume codegen, smaller models for routine tests. Each droid has a **persistent computer that never resets** — Monday's work picks up Tuesday with full context. HyperCode (graph + latent) for codebase context; ByteRank for retrieval; DroidShield for static-analysis gating.
- **Inbox / queue:** Coordinator-managed task queue. "Missions" run multi-day.
- **Extensibility:** Droid roles are first-class units; adding a droid = adding a specialized agent class with its own prompt + tool allowlist.
- **Borrow:** (1) **Role-specialized agents (droids)** map directly to Conductor's scenarios — PR Reviewer, Incident Responder, Implementer, Decomposer = four "droids." (2) **Persistent per-droid working state** (a worktree + thread that survives across days) is the durability model. (3) **Multi-model routing** — pick model per subtask, not per session.
- **Avoid:** Custom retrieval (HyperCode/ByteRank) is bespoke and over-engineered for our scale; lean on Sourcegraph or codebase MCP servers instead.
- Sources: [Factory.ai](https://factory.ai/), [Factory GA announcement](https://factory.ai/news/factory-is-ga), [Factory multi-agent review](https://www.digitalapplied.com/blog/factory-ai-multi-agent-coding-platform-review)

---

# Three architectural patterns we should consider stealing

## 1. "Conductor IS an MCP server" — invert the host relationship (OpenClaw + Hermes)

Both OpenClaw and Hermes work because they expose their *inbox and channels* as MCP tools that any external agent can call. Claude Code becomes the driver; OpenClaw/Hermes become a queryable substrate.

For Conductor:
- Ship `conductor mcp serve` (stdio + HTTP) exposing tools: `inbox.list`, `inbox.read`, `inbox.append`, `inbox.claim`, `thread.write`, `thread.complete`, `approval.request`, `approval.resolve`.
- Hermes's pattern: the MCP server is a **thin reader** over a SQLite session store at `~/.conductor/db.sqlite`. Conductor desktop reads the same SQLite. No separate event-sourced kernel needed — SQLite *is* the kernel.
- An external Claude Code session in the side terminal can call these tools to write into the inbox; the Tauri UI re-renders by tailing the same DB. This is the "inbox surfaces what other CLI agents wrote to it via MCP" requirement, distilled.
- Avoid OpenClaw's in-memory-only queue mistake: persist everything, treat the live event feed as a tail of durable rows.

## 2. Four-tier extensibility taxonomy (Claude Code) + drop-folder MCP config (Continue)

Match Claude Code's explicit extensibility taxonomy with cost trade-offs the user can reason about:

| Tier | Conductor analog | Cost | When |
|---|---|---|---|
| **Skills** (markdown) | `.conductor/skills/*.md` — domain workflows like "PR-review-policy" | Frontmatter only in context | Per-scenario knowledge |
| **Hooks** (JSON) | `.conductor/settings.json` — on-inbox-item, on-thread-complete | Minimal | Enforce, notify, automate |
| **MCP servers** | Anything external (ADO, ICM, DGrep, GitHub, …) | Tool schemas in context | Integrations |
| **Recipes** (Goose-style YAML) | `.conductor/recipes/*.yml` — parameterized scenarios (replaces AutoPolicies + workflows) | Pulled in per invocation | Reusable parameterized flows |

Plus Continue's drop-folder trick: read `.conductor/mcp/*.json` in the same format as Claude Desktop / Cursor / Cline. Users bring an existing MCP fleet for free.

This entirely replaces today's: event-sourced kernel, plugins, AutoPolicies, walkthroughs, projections, session manager. Skills + recipes + MCP servers + hooks cover all four canonical scenarios with a fraction of the moving parts.

## 3. Persistent threads + role-specialized subagents on local-first SQLite (Amp + Factory + Claude Code subagents)

Combine three ideas:
- **Amp's persistent threads** — every inbox item opens a thread that lives forever in SQLite. Multiple threads run in parallel; the desktop UI is a tail/list view.
- **Factory's role-specialized droids** — PR Reviewer, Incident Responder, Implementer, Decomposer are not plugins; they're *subagent roles* with system prompt + tool allowlist + model choice. New scenario = new role file.
- **Claude Code subagents with worktree isolation** — each thread runs in its own git worktree, isolated context window, separate model choice. No context poisoning between concurrent investigations.

Concretely for Conductor:
- The Tauri UI is *only*: (a) inbox list backed by `inbox` table, (b) thread viewer backed by `thread_events` table, (c) embedded terminal (Claude-Code-like) that runs the actual agent in the worktree.
- Adding a scenario = dropping a role markdown file + a recipe YAML + (optionally) an MCP server. No code changes to the host.
- Devin's lesson: don't build a parallel inbox — let ADO/GitHub/ICM webhooks (via MCP servers) push items into the same `inbox` table. The "inbox" is one SQLite table; everything else is a view over it.

This is the simplest architecture that satisfies all four user requirements (agent-driven, MCP-first, thin viewer, dead-simple extensibility) and discards the kernel/projection/walkthrough/policy machinery.
