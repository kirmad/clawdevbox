# Distill Session Memories — Design

**Status:** Draft · 2026-05-31
**Owner:** dev-buddy plugin
**Skill name:** `distill-session-memories`
**Skill path:** `plugins/dev-buddy/skills/distill-session-memories/SKILL.md`

## Purpose

A skill that an agent invokes to analyse a Copilot CLI session (current or
exported JSON) and durably write the learnings — bugs, conventions, gotchas,
system knowledge, user preferences — into the vault's `memory/` tree in
**Obsidian-compatible markdown**.

The agent operates like a senior engineer building institutional knowledge:
survey what's already known, decide for each finding whether to update an
existing note, extend an existing hierarchy, or create something new, and
proactively dispatch sub-agents to learn about concepts that came up in the
session but aren't fully understood yet.

## Non-goals

- Not a real-time auto-memorizer. The skill is invoked explicitly — by the
  user, a recipe, or another skill — and runs as a discrete phase.
- Not a replacement for `<workspace>/.clawdevbox/memory.md` (the dev-buddy
  per-project agent-private memory). This skill targets the **vault**
  `memory/` tree which is cross-session and Obsidian-organised.
- Not a backup tool. It distills durable knowledge; the raw session is the
  source of truth and lives elsewhere.

## Where it ships

The skill ships inside the **dev-buddy plugin**, which already owns the
memory concern (`MEMORY-TEMPLATE.md`, the `### Memorize if useful` section
of `dev-buddy/SKILL.md`).

- **File:** `plugins/dev-buddy/skills/distill-session-memories/SKILL.md`

Versioned in the clawdevbox repository alongside the other dev-buddy skills.

## Distinction from existing memory surfaces

| Surface | Scope | Format | Loaded |
|---|---|---|---|
| `<workspace>/.clawdevbox/memory.md` | Per-project, flat, agent-private | Plain markdown template | Every turn by dev-buddy |
| Vault `memory/*.md` (this skill) | Cross-session, cross-project, hierarchical | Obsidian (frontmatter + wikilinks + tags + callouts) | On demand by skill/agent |
| `store_memory` MCP tool (Copilot CLI) | Per-repo memory pinned to prompts | Short opaque facts with citations | Always in prompt |

The vault memory is the user's growing PKM. The other two are operational.

## Input modes

The skill operates on one of two normalised inputs.

### Mode A — current session

The agent uses:
- `session_store_sql` for `turns`, `events`, `tool_requests`,
  `session_files`, `session_refs`, `attachments` (DuckDB; per-session).
- `~/.copilot/session-state/<sid>/files/*` for artifacts (`plan.md`, notes,
  test outputs).
- `~/.copilot/session-state/<sid>/events.jsonl` for raw event stream when
  the DuckDB view is insufficient.

### Mode B — exported session JSON

The caller passes a file path. The skill documents the expected shape:

```jsonc
{
  "session_id": "...",
  "started_at": "ISO-8601",
  "ended_at": "ISO-8601",
  "summary": "free text",
  "turns": [
    {
      "index": 0,
      "role": "user|assistant",
      "content": "...",
      "tool_calls": [{ "name": "...", "arguments": {}, "result": "..." }]
    }
  ],
  "file_edits": [{ "path": "...", "tool": "edit|create" }],
  "refs": [{ "type": "pr|issue|commit", "value": "..." }]
}
```

The skill begins by asking the caller (or inferring from arguments) which
mode, then enumerates the data inventory before extracting.

## Workflow (7 phases)

### 1. Pre-flight

- Call `paths.get` → resolve `vaults[]` (personal + team).
- Confirm input mode (A or B) and locate the data source.
- Walk both vaults' `memory/` directories → build a working index of every
  existing note: path, title (from frontmatter), tags, top-level headings.

### 2. Inventory + proactive learning

Extract raw signals from the session:

- Verified facts (commands that succeeded, files edited and built, bugs
  reproduced).
- User-stated preferences ("always do X", "never do Y", "call me Y").
- Architecture discoveries (how a service works, non-obvious data flow).
- Gotchas (what bit, what fixed it, why).
- Tool/API conventions (e.g., `op:'replace'` vs `'add'` for ADO patches).

**Proactive learning loop.** When a candidate references a concept the
agent isn't confident about (`GVC KPI`, `ICM relationship_type`,
`ADO WIQL date precision`), dispatch a sub-agent:
- `research` for external docs / RFCs / vendor APIs
- `general-purpose` or `explore` for codebase investigations

The sub-agent's findings become **additional candidate memories**, marked
with `confidence: researched` and citing sources.

Output of this phase: a numbered list of candidates in working memory.

### 3. Triage (senior-engineer judgement)

For each candidate decide:
- **Keep / drop?** Apply the principles in Section "Classification".
- **Vault?** Personal vs team (see routing table).
- **Target?** Update existing note · extend existing folder · new atomic
  note · new sub-folder.
- **Shape?** Atomic note vs section in a larger MOC/hub note.

### 4. Sub-agent audit (no human gate by default)

Dispatch the **rubber-duck** agent with the candidate list + chosen
classifications + relevant slices of the existing-memory index.

Ask it to critique:
- Low-signal entries
- Duplicates of existing memory
- Contradictions with existing memory
- Mis-classifications (wrong vault, wrong folder)
- Missing context (a fact without enough surrounding "why")
- Things that should be merged
- Things that should be split
- Frontmatter / link issues

Apply each finding using normal critique rules:
- Adopt findings that clearly improve durability or findability.
- Set aside findings that would over-complicate without payoff; record
  the reason inline.

Human approval is **only** invoked if the caller passes `confirm: true`
(or the user has said "ask me before saving"). Default is silent execution
after audit.

### 5. Execute writes

Apply the audited plan with file tools. Use Obsidian conventions
(Section "Obsidian schema"). Create folders on demand.

### 6. Self-verify

For each written file:
- Re-read.
- Validate frontmatter (parseable YAML, `tags` is a list, banned chars
  not in title or filename).
- Check each new `[[wikilink]]` resolves to an existing file or note it
  as an intentional forward-ref in the parent note.

### 7. Report

3–5 line summary:
- Counts: created N, updated M, dropped K.
- Paths (group by vault).
- Any sub-agents spawned, so the user can audit provenance.
- Anything dropped during audit and why.

## Obsidian schema

### Filename rules

- `kebab-case.md`, descriptive (≤ 60 chars).
- Avoid banned chars: `# | ^ : %% [[ ]]`.
- Title in frontmatter is the human surface; filename is the wikilink
  target.

### Folder hierarchy (seed taxonomy)

The skill adopts existing structure first. Create new folders only when
nothing existing fits.

- `systems/<service>/<topic>.md` — external systems (ADO, CFV, ICM, Geneva, …)
- `codebases/<repo>/<topic>.md` — repo-specific knowledge
- `conventions/<area>/<topic>.md` — coding/testing/process conventions
- `gotchas/<area>/<topic>.md` — pitfalls + fixes (also tagged `#gotcha`)
- `commands/<tool>/<topic>.md` — verified runbook commands
- `decisions/<YYYY-MM-DD>-<topic>.md` — architectural decisions log
- `people/<name-or-team>.md` — aliases, oncalls, teams
- **Personal vault only:** `preferences/<area>.md` — user preferences

Each non-empty folder gets a `_index.md` (Map of Contents) with one-line
descriptions of children.

### Frontmatter contract

Every memory note:

```yaml
---
title: "Human-readable title"
aliases:
  - "alternate handle"
tags:
  - system/ado
  - gotcha
created: 2026-05-31
updated: 2026-05-31
source-sessions:
  - e8b0565d-5c04-4c64-b9d2-61a0bd9fc452
confidence: verified   # verified | researched | hunch
related:
  - "[[systems/ado/wiql-syntax]]"
---
```

Rules: `tags` is always a YAML list (Obsidian requirement). No nested
objects, no markdown in values. `confidence` lets the audit phase weight
entries.

### Body template (sections optional)

```markdown
> [!summary] One-line TL;DR.

## Context
Why this matters; what triggered the learning.

## What I learned
The durable fact. Cite paths and line numbers where applicable.

## Evidence / verification
How to reproduce; commands run; tool calls made.

## Gotchas
> [!warning] Anything that bit; how to avoid it next time.

## Related
- [[systems/ado/work-item-fields]]
- [[gotchas/ado/json-patch-add-vs-replace]]
```

### Callouts

- `[!summary]` — TL;DR
- `[!tip]` — shortcut / non-obvious trick
- `[!warning]` / `[!danger]` — gotcha
- `[!bug]` — bug pattern
- `[!example]` — verified command / code sample
- `[!question]` — unresolved; future investigation

### Wikilinks

- `[[folder/note]]` (Obsidian's relative form) preferred over markdown links.
- Headings: `[[note#Heading]]`.
- Block refs: append `^block-id` to source paragraph; link `[[note#^block-id]]`.

### Tag conventions

- Domain: `#system/ado`, `#system/cfv`, `#codebase/clawdevbox`
- Kind: `#gotcha`, `#convention`, `#command`, `#decision`, `#preference`
- Confidence: `#verified`, `#researched`, `#hunch`

### Updating existing notes (no silent rewrites)

- Append `## Update YYYY-MM-DD` at the bottom.
- Bump `updated:` in frontmatter; append the new session id to
  `source-sessions`.
- Never rewrite a prior claim — mark the old one stale with a
  `> [!warning] Superseded YYYY-MM-DD — see Update section`. Preserves
  audit trail.

## Classification rules

### Worth remembering — principles

- ✅ Will help on a future task you can't yet predict.
- ✅ Wasn't obvious from a quick read of the code/docs.
- ✅ Cost real time to discover (or recover from).
- ✅ Stable across sessions (a fact about a system, not about one PR).
- ❌ Ephemeral / task-specific ("skip lint for now", "use msg X").
- ❌ Inferable trivially from one grep.
- ❌ Already captured in the existing tree (then update, don't duplicate).
- ❌ Secrets, tokens, PII, GDPR Art. 9 categories.

### Personal vs team routing

| → personal-vault | → team-vault |
|---|---|
| User preferences (addressing, voice, no emoji) | Codebase conventions (test cmds, lint, naming) |
| Personal workflow choices | System knowledge (ADO/CFV/ICM gotchas) |
| User-specific tool setups | Architectural decisions, design rationale |
| Identity, voice, addressing | API/SDK semantics, runbook commands |
| Personal account aliases | Team aliases, oncalls, shared infra |

Tiebreaker: would a teammate joining tomorrow benefit? → team. Strictly
this user? → personal.

### Dedupe / merge heuristics (in order)

1. **Exact title match** in either vault → update existing.
2. **Same folder + semantically equivalent topic** → extend existing
   note with a new section.
3. **Same fact from a different angle** → new atomic note, link both
   directions in `## Related`.
4. **Contradiction with existing note** → append `## Update`; mark prior
   claim superseded; if it's a deliberate reversal, also write a
   `decisions/` note.

### Confidence labelling

- `verified` — directly observed this session.
- `researched` — sub-agent investigated via external sources (cite them).
- `hunch` — inferred but not verified; keep for future verification.

### Hard filters (never write)

- API keys, tokens, credentials, secrets — strip and log warning instead.
- PII beyond what's already in user's identity files.
- GDPR Art. 9 categories (health, religion, ethnicity, sexual orientation,
  political views, biometrics, union membership).
- Anything the user said "don't remember this" / "off the record".

## Open questions

None at design time. The skill is intentionally pure-markdown (no
scripts), matching the local plugin convention; if the heuristics prove
out and a hot-path emerges (e.g., dedupe scan over a large vault),
consider promoting it to a helper script or an MCP tool in a follow-up.
