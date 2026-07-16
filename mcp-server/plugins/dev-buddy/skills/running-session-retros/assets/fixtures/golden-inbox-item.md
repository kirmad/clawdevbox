# Golden Inbox-Item Assertions for `running-session-retros` (v2)

A correct retro draft for `session-with-gap.json` MUST satisfy ALL of the following.

## 1. Gap classification (the agent picks the right bucket)

For this fixture the correct classification is **`discipline-gap`** (the matching skill `superpowers/systematic-debugging` already exists in `skill-catalog.json` — so the artifact is a CLAUDE.md append with explicit trigger conditions, NOT a new skill).

The draft MUST NOT classify as:
- `new-skill-needed` (wrong — `systematic-debugging` already exists in the catalog)
- `correction-to-existing-skill` (wrong — no user-turn correction phrase in the fixture)
- `instruction-from-user` (wrong — no teaching phrase in the fixture)
- `tool-missing` / `memory-needed` / `project-convention-from-user`
- `skill-invocation-missed` (legacy v1 value — was deprecated when v2 unified the routing under `discipline-gap`)

## 2. Skill identification (the agent names the right skill)

The CLAUDE.md append MUST cite `superpowers/systematic-debugging` as the discipline to invoke. Acceptable to also mention `verification-before-completion`.

Unacceptable: `test-driven-development` alone, `brainstorming` alone.

## 3. Evidence (the agent cites specific turns)

The Detection evidence section MUST cite at least TWO specific turn indices from the fixture. Examples:
- "Turns 4, 6, 8, 10 — four consecutive `bash npm test` failures with no plan change between attempts"
- "Turns 3, 5, 7, 9, 11 — five edits across two files with no successful verification"
- "Turn 12 — final claim 'should be fixed' without a passing test result"

## 4. Target artifact (the heart of v2)

The draft MUST contain a `## Target artifact` section with:

| Field | Requirement |
|---|---|
| `Type:` | `claude-md-append` (for this fixture) |
| `Target path:` | An absolute path ending in `CLAUDE.md` (project-scoped to the fixture's `cwd`, i.e., `C:\\git\\example-app\\CLAUDE.md`) |
| Code block | A markdown fenced block containing a complete `## <section heading>` block with specific trigger conditions (file patterns, request shapes, signal counts) AND a "Historic cost" footnote citing session id + turn indices. |

The code block content is what gets appended to the target CLAUDE.md on approval. It MUST be self-sufficient — no references to "see above" or "the description". A future agent reading the appended block alone must understand the rule.

Pass criteria for the code block:
- Has an explicit trigger: "When the change touches… INVOKE… DO NOT…"
- Lists ≥1 concrete trigger pattern (file glob, request shape, signal threshold)
- Names the skill to invoke (`superpowers/systematic-debugging`)
- Footnote cites `sess-fixture-debug-thrash` + at least two turn indices

## 5. Inbox item structure (downstream-compatible)

| Field | Requirement |
|---|---|
| `id` | Deterministic format: `retro-discipline-gap-sess-fixture-debug-thrash-systematic-debugging`. Re-runs MUST produce the same id. |
| `title` | ≤80 chars. Mentions the classification (`discipline-gap`) AND the artifact slug (`systematic-debugging`). |
| `preview` | ≤160 chars. Cites the session id (`sess-fixture-debug-thrash`) AND the target CLAUDE.md path. |
| `description` | Markdown body with the four sections in order: Classification / Detection evidence / Target artifact / (apply hint inside Target artifact section). |
| `labels` | Array containing `"session-retro"` AND `"discipline-gap"` AND `"systematic-debugging"`. |

## 6. Non-actions (what the agent MUST NOT do)

- MUST NOT propose modifying `src/login.ts` or `src/auth.ts` (no bug-fixing).
- MUST NOT propose drafting a NEW skill (the existing `systematic-debugging` covers it; that's why this is `discipline-gap` not `new-skill-needed`).
- MUST NOT call `inbox.upsert` or write any files (the test only checks the JSON draft content).
- MUST NOT make up turn indices that don't exist in the fixture.
- MUST NOT produce a "Recommended action" prose paragraph in place of the Target artifact code block. The code block is mandatory; prose is not enough.

## Pass criteria

ALL of sections 1–6 must hold. Section 4 (the literal Target artifact code block) is the v2 acceptance gate — without it the draft is wishful-thinking and fails.

