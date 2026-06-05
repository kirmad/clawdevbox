---
name: fetching-agent-sessions
description: Use when fetching, listing, normalizing, or auditing recent sessions from agent CLIs (Copilot CLI, Claude Code, Agency CLI). Use when another skill needs unified session data across multiple CLI clients, when reviewing what AI assistants did in a time window, or when building tools that analyze past agent activity. Keywords - session, sessions, history, transcript, audit, retro, recent activity, what did the agent do, session store, JSONL, session_store_sql.
---

# Fetching Agent Sessions

## Overview

Different agent CLIs store sessions in completely different formats. This skill lets you fetch sessions from any installed CLI and return them in ONE normalized JSON shape that downstream code can iterate over without branching on provider.

**Core principle:** every provider produces the same shape. The shape is **closed and non-negotiable**. If a field can't be sourced from a provider, set it to `null` — never invent fields, never rename fields, never add an "extras" bucket.

## When to Use

- Auditing what agents did in a time window
- Feeding downstream analyzers (gap-finding, retro, search, stats)
- Cross-client reviews (user runs both Copilot CLI and Claude Code)
- Any task where you need session content but don't care which CLI produced it

**Do NOT use** when you only need ONE provider's data — call `session_store_sql` or read JSONL files directly. The normalized layer is for cross-provider work.

## The Loop

1. **Discover** — run each provider doc's Discover step; skip absent providers.
2. **Enumerate** — per surviving provider, list session ids in the requested time window.
3. **Normalize** — per session, convert raw → normalized shape using the provider's Normalize step.
4. **Deep-fetch** (on demand) — if a downstream caller needs full bodies for a specific session, use the provider's Deep-fetch step.

## Required Reading

Before producing output you MUST read:

- **references/normalized-model.md** — the exact JSON shape (field names, types, enums). Field names are case-sensitive.
- **references/providers/README.md** — the 4-question provider contract.
- **references/providers/<provider>.md** — one file per provider. Currently shipped:
  - `copilot-cli.md` — DuckDB-backed cloud store via the `session_store_sql` MCP tool
  - `claude-code.md` — JSONL transcripts under `~/.claude/projects/`
  - `agency-cli.md` — wraps Copilot CLI; sessions appear in the Copilot store

## Canonical Example

This is the **entire shape**. Memorize it. Any deviation = wrong.

```jsonc
{
  "id": "sess-001-copilot",
  "provider": "copilot-cli",
  "cwd": "C:\\git\\example-app",
  "started_at": "2026-05-30T14:00:00.000Z",
  "ended_at":   "2026-05-30T14:05:00.000Z",
  "summary":    "Add status badge to README",
  "turns": [
    {"index":0,"role":"user",     "text":"Add a status badge to the README","tool_name":null,  "tool_success":null,"ts":"2026-05-30T14:00:00.000Z"},
    {"index":1,"role":"tool",     "text":"view README.md",                  "tool_name":"view","tool_success":true,"ts":"2026-05-30T14:00:30.000Z"},
    {"index":2,"role":"tool",     "text":"edit README.md",                  "tool_name":"edit","tool_success":true,"ts":"2026-05-30T14:02:00.000Z"},
    {"index":3,"role":"assistant","text":"Added status badge to README.md", "tool_name":null,  "tool_success":null,"ts":"2026-05-30T14:05:00.000Z"}
  ],
  "files_touched": [
    {"path":"README.md","op":"edit"}
  ]
}
```

If your output doesn't look exactly like this (modulo data values), you've drifted — re-read `references/normalized-model.md`.

## Red Flags — STOP and Re-read

You are drifting if you find yourself:

- Using `session_id` instead of `id`
- Using `source`, `agent`, or `agent_label` instead of `provider`
- Using `events`, `messages`, or `entries` instead of `turns`
- Using `kind` instead of `role`
- Using event kinds like `user_message` / `tool_invocation` instead of role values `user` / `tool`
- Nesting tool fields under a `tool` object (`tool: {name, success}`) instead of flat `tool_name` / `tool_success`
- Adding fields like `agent_label`, `repository`, `git_branch`, `model`, `usage`, `raw_meta`, `first_seen_at`
- Omitting `null` fields (every documented field is required in output, even if `null`)
- Producing different shapes for different providers

**Any one of these means: STOP. Re-read `references/normalized-model.md`. The shape is fixed.**

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "I'll add a `raw_meta` bucket so I don't lose data" | Don't. If downstream needs more, it calls Deep-fetch with `{provider, id}`. |
| "My shape is better — flat events instead of turns" | Maybe, but downstream tools depend on the contract. Propose a v2 spec change; don't ship a v1 fork. |
| "Copilot doesn't have git_branch so I'll add it as null" | If a field isn't in normalized-model.md, don't add it. The shape is closed. |
| "I'll merge user+tool_result into one event" | Don't. Each tool call is one `role:"tool"` turn. The tool_result content goes in that turn's `text`. |
| "I'll use `agent_name` from the source verbatim as provider" | Don't. `provider` is an enum: `copilot-cli` \| `claude-code` \| `agency-cli`. |
| "I'll skip the assistant message if it's empty after tool calls" | Don't. Emit every assistant text message even if short; turns are an honest log. |
| "I'll re-sort turns by timestamp" | Don't. Preserve source order; `index` is the authoritative iteration order. |

## End-to-End Test Fixtures

In `assets/fixtures/`:
- `copilot-raw.json` — input
- `claude-raw.jsonl` — input
- `session-normalized.json` — target output shape (run YOUR adapter; data values match this)
- `ASSERTIONS.md` — pass/fail criteria

A correct implementation produces output that satisfies every assertion in `ASSERTIONS.md` for both raw inputs.
