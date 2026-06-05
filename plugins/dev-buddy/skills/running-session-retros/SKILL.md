---
name: running-session-retros
description: Use when analyzing recent agent sessions to find process gaps - missed skill invocations, repeated mistakes, premature completions, debugging without a plan. Use when conducting a self-improvement retrospective, asking 'what could have helped' on a session, auditing recent agent work for inefficiencies, or building drafts for human review of suggested skills/tools/memories. Keywords - retro, retrospective, self-improvement, gap analysis, missed skill, what could have helped, agent audit, process audit, post-mortem.
---

# Running Session Retros

## Overview

Take recent agent sessions (normalized via `fetching-agent-sessions`), find process gaps where an existing skill, a new skill, a memory, or a tool **would have helped**, and draft an inbox item per gap for human approval. **You never auto-commit** — every artifact rides inside an inbox item that a human approves before anything lands on disk.

**Core principle:** the output is a *draft for human review*, not an action. Be specific (cite exact turn indices), be conservative (don't propose new skills when an existing one already covers the gap), be deduplicated (use deterministic ids so re-runs don't spam).

## Required Background

You MUST understand:
- **REQUIRED BACKGROUND:** `dev-buddy/fetching-agent-sessions` — provides the normalized session shape this skill consumes.
- **REQUIRED BACKGROUND:** `superpowers/writing-skills` — for any draft that proposes a NEW skill, follow its TDD methodology in the draft text.

## When to Use

- Scheduled self-improvement retros (cron-driven, end-of-day)
- On-demand: "do a retro on this session" / "what could have helped today?"
- Pre-PR audit: "review my last N sessions before I open this PR"

**Do NOT use** to fix bugs found in retro sessions — that's a different task. The retro produces *process* recommendations, not code changes.

## The Loop

```
1. Fetch sessions          → use `fetching-agent-sessions` (window default: last 24h)
2. Skip its own sessions   → drop any session whose summary contains "session-retro"
3. Score with heuristics   → references/gap-heuristics.md (4 KISS signals)
4. Deep-dive top scored    → references/subagent-prompts.md (one sub-agent per candidate)
5. Classify the gap        → see "Gap Classification" below
6. Draft inbox item        → see "Inbox Item Schema" below (one per gap)
7. Self-critique           → re-read the draft against "Red Flags" below; fix any drift
8. Output the drafts       → return as JSON array; caller (recipe or user) decides whether to call inbox.upsert
```

**Caps (prevent inbox spam):**
- Maximum 5 drafts per run. If more gaps detected, post a single "12 gaps detected, top 5 attached" summary item.
- Skip sessions shorter than 3 turns (not enough signal).
- Skip your own sessions (summary contains "session-retro" or "retro:").

## Gap Classification & Artifact Routing

Every draft routes to a CONCRETE artifact the agent will actually consult next time. Prose recommendations don't persist — only files on disk do. Pick the classification first, then the artifact type is determined.

| Classification | Detection signal | Output artifact type | Lands at |
|---|---|---|---|
| `instruction-from-user` | User TAUGHT a procedure ("here's how to X", "let me show you", "the right way to Y is…", "next time, do Z first") | **Complete new SKILL.md body** (gerund name) | `~/.clawdevbox/skills/<name>/SKILL.md` |
| `correction-to-existing-skill` | User corrected a skill-driven task ("the X skill should also…", "update X to catch…") | **Unified diff** to that skill's SKILL.md | the existing skill path |
| `repeated-procedure` | Same N-step tool sequence observed in ≥3 sessions in the window | **Complete new SKILL.md body** extracted from observed turns | `~/.clawdevbox/skills/<name>/SKILL.md` |
| `repo-fact-from-user` | User stated a stable repo fact ("X requires header Y", "the build runs Z") | **`store_memory` JSON payload** | the memory store |
| `project-convention-from-user` | User stated a project-specific rule ("we use X for Y", "PRs must include Z") | **CLAUDE.md append block** (project scope) | `<repo>/CLAUDE.md` |
| `discipline-gap` | Agent fell into anti-pattern; existing skill would prevent it but didn't trigger | **CLAUDE.md append block** with explicit trigger conditions + historic cost | `<repo>/CLAUDE.md` (or `~/CLAUDE.md` if cross-repo) |
| `new-skill-needed` | Recurring anti-pattern with NO covering existing skill | **Complete new SKILL.md body** | `~/.clawdevbox/skills/<name>/SKILL.md` |

**Always check `skill.list` FIRST.** If an existing skill covers the gap → `discipline-gap` (CLAUDE.md append with trigger), NOT `new-skill-needed`.

## Inbox Item Schema (the exact draft shape)

```jsonc
{
  "id":          "retro-<classification>-<sessionId>-<artifact-slug>",   // DETERMINISTIC
  "title":       "<≤80 chars; names classification + artifact slug>",
  "preview":     "<≤160 chars; cites session id + the artifact target path>",
  "description": "<markdown body — see required sections below>",
  "labels":      ["session-retro", "<classification>", "<artifact-slug>"]
}
```

### `id` format (deterministic, idempotent)

```
retro-<classification>-<sessionId>-<artifact-slug>
```

NO sha256 hashing. NO random suffixes. NO timestamps. Re-runs produce the same id → `inbox.upsert` overwrites instead of duplicating.

### `description` required sections (in this order)

````markdown
## Classification
<one of the 7 classification values>

## Detection evidence
- Turn <N>: <brief quote or summary>
- Turn <M>: <brief quote or summary>
- ... (at least TWO specific turn indices required)

## Target artifact

**Type:** `<new-skill | skill-diff | memory | claude-md-append>`
**Target path:** `<absolute path on disk>`
**Apply hint:** Ask dev-buddy: `"apply retro <id>"` — dev-buddy parses Target path + the code block below and writes/patches accordingly.

```<markdown | diff | json>
<THE LITERAL CONTENT THAT LANDS AT TARGET PATH ON APPROVAL>
```
````

The code block above is the WHOLE POINT. Without it, the draft is wishful thinking the agent will never read. The block MUST be self-sufficient — a copy-paste from inbox to disk produces the working artifact.

### Per-artifact-type templates

**Type: `claude-md-append`** — the code block is markdown to append at end of target CLAUDE.md. It MUST include:
- A `## <section heading>` with active-voice trigger conditions ("When the change touches… INVOKE/WRITE/DO…")
- An enumerated list of trigger conditions (file patterns, request shapes, etc.) — specific enough that a future agent can recognize the situation
- A "Historic cost" footnote citing the source session id + turn indices

**Type: `new-skill`** — the code block is the COMPLETE SKILL.md body, including YAML frontmatter:
```markdown
---
name: <gerund-name>
description: Use when <triggers>. <keywords>.
---

# <Title>

## Overview
...

## When to Use
...

## Steps
1. ...

## Common Mistakes
...
```

**Type: `skill-diff`** — the code block is a unified diff with full path header:
```diff
--- a/<absolute path>
+++ b/<absolute path>
@@ -L,N +L,N @@
 context
-removed
+added
```

**Type: `memory`** — the code block is a JSON object matching `store_memory` args:
```json
{
  "subject": "<1-2 words>",
  "fact": "<single sentence, ≤200 chars>",
  "citations": "<file:line refs or 'User input: \"...\"'>",
  "reason": "<2-3 sentences explaining when this matters>"
}
```

### `labels` (always include these)

- `"session-retro"` — REQUIRED; humans filter the inbox by this
- The classification value (e.g., `"discipline-gap"`)
- The artifact slug (the same one in the id)

## Red Flags — STOP and Re-draft

You are drifting if you find yourself:

- **Producing a "Recommended action" paragraph instead of a code-block artifact** — prose doesn't persist; the agent will never read it. The draft is worthless without the literal artifact.
- About to classify as `new-skill-needed` without first checking `skill.list` for an existing match (use `discipline-gap` instead)
- Citing evidence without specific turn indices ("the session had failures" — WHICH turns?)
- Producing an `id` with a hash, timestamp, or random suffix (re-runs will duplicate)
- Omitting `"session-retro"` from labels
- Including code changes for the bug shown in the session (out of scope)
- Drafting more than 5 items in a single run (cap exists for a reason)
- Producing an item for a session shorter than 3 turns (insufficient signal)
- Drafting an item for one of your OWN past retro sessions (feedback loop)
- **Producing a CLAUDE.md append that lacks specific trigger conditions** (file patterns, request shapes) — generic advice ("be more careful") is wishful thinking
- **Producing a `new-skill` artifact missing YAML frontmatter** — won't be discoverable by `skill.list`

**Any one of these means: STOP. Re-read the relevant section above.**

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "The recommended action paragraph is clear enough" | The agent will never read your inbox item. Only files on disk persist. Produce the artifact. |
| "I'll create a new skill — it's more thorough" | Check `skill.list` first. If `systematic-debugging` exists, it's a `discipline-gap` → CLAUDE.md append with trigger, not a new skill. |
| "I'll just describe the gap; turn indices are tedious" | Without indices the human can't verify. Cite at least two specific turns. |
| "I'll use a timestamp in the id so each run is unique" | Wrong. Retros are idempotent. Same session + same gap = same id. |
| "The CLAUDE.md append can just say 'invoke X next time'" | Wishful. Spell out trigger conditions specifically enough that a future agent reading CLAUDE.md will RECOGNIZE the situation: file patterns, request shapes, signal counts. |
| "I'll auto-apply the artifact since it's obviously right" | NEVER. Every artifact is a draft. Inbox approval is mandatory. dev-buddy applies on user say-so. |

## End-to-End Test Fixture

In `assets/fixtures/`:
- `session-with-gap.json` — a normalized session with classic "debugging without a plan" pattern
- `skill-catalog.json` — mock `skill.list` output (so the test is hermetic)
- `golden-inbox-item.md` — pass criteria for a correct draft

A correct implementation, given the fixture and the catalog, produces an inbox-item draft satisfying every assertion in `golden-inbox-item.md`.

## References

- `references/gap-heuristics.md` — the 4 KISS signals for scoring sessions
- `references/subagent-prompts.md` — the deep-dive prompt template for per-session analysis
