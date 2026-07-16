# Skill Feedback Loop — Implementation Plan

> **For agentic workers:** Use `claude-opus-4.7-1m-internal`. One subagent per phase.

**Goal:** Wire the skill feedback loop described in `docs/specs/2026-05-15-skill-feedback-loop-design.md`. Three MCP tools (`skill.feedback.record`, `.aggregate`, `.pending`), one recipe, and documentation. No telemetry. No auto-merge.

**Spec:** `docs/specs/2026-05-15-skill-feedback-loop-design.md`

**Baseline:** Current HEAD on `main`. All tests passing.

---

## File structure

**New files:**
- `mcp-server/src/tools/feedback.ts` — three MCP tools (~200 LOC)
- `samples/recipes/feedback-sync.yaml` — weekly aggregation recipe
- `.clawdevbox/feedback/README.md` — local privacy notice (already in place)
- `docs/FEEDBACK-OPERATIONS.md` — vault-auditor runbook
- `docs/skills-promotion-policy.md` — governance thresholds
- `mcp-server/tests/feedback.test.mjs` — unit tests

**Modified files:**
- `mcp-server/src/server.ts` (or tool registration entry point) — call `registerFeedbackTools`
- `.gitignore` — add `.clawdevbox/feedback/local.jsonl`

---

## Phase 1 — Core tools

### Task 1.1: `feedback.ts`

**File:** `mcp-server/src/tools/feedback.ts`

Implement `registerFeedbackTools(server, ws)` exporting three tools:

**`skill.feedback.record`**
- Inputs: `skill_id: string`, `signal: enum(used|skipped|corrected|error)`, `correction?: string`
- Validates correction is a unified diff starting with `---` or `diff ` and ≤ 8 KiB.
- Computes `session_hash = SHA-1(hostname + process.pid + UTC-date)[0:8]`.
- Appends one JSONL line to `<projectDir>/.clawdevbox/feedback/local.jsonl`.
- Creates the directory if missing.

**`skill.feedback.aggregate`**
- No inputs.
- Reads `local.jsonl`, deduplicates by `(skill_id, signal, session_hash, day)`.
- Computes per-skill rolling window counts (7d, 30d) and `score_30d`.
- Writes `agg.json` atomically.

**`skill.feedback.pending`**
- Input: `kind: enum(corrections|promotions|all)`, default `all`.
- Reads `agg.json`. Returns correction candidates (`last_correction_patch` present) and promotion candidates (`score_30d > 0.75 && uses_30d >= 10`).
- Thresholds are constants at the top of the file, not hardcoded in the condition, so the policy doc and the code stay in sync.

**Commit:** `feat(tools): skill.feedback.record/aggregate/pending`

### Task 1.2: Wire registration

Find the file that calls `registerSkillTools(server, ws)` and add `registerFeedbackTools(server, ws)` in the same block.

**Commit:** `feat(server): register skill feedback tools`

### Task 1.3: `.gitignore`

Add `.clawdevbox/feedback/local.jsonl` to the root `.gitignore`.

**Commit:** `chore: gitignore feedback local.jsonl`

---

## Phase 2 — Recipe

### Task 2.1: `feedback-sync.yaml`

**File:** `samples/recipes/feedback-sync.yaml`

Single-step recipe:
1. Call `skill.feedback.aggregate`.
2. Call `skill.feedback.pending kind=all`.
3. Report counts (signal count, skills summarised, pending corrections, promotion candidates).
4. If any corrections or promotions pending, suggest the vault-auditor open the corresponding PRs per `docs/FEEDBACK-OPERATIONS.md`.
5. `recipe.done status=success`.

**Commit:** `feat(recipes): feedback-sync weekly recipe`

---

## Phase 3 — Tests

### Task 3.1: Unit tests

**File:** `mcp-server/tests/feedback.test.mjs`

Cover:
- `record` writes a valid JSONL line.
- `record` rejects an oversized correction.
- `record` rejects a non-diff correction.
- `aggregate` deduplicates same `(skill_id, signal, session_hash, day)`.
- `aggregate` computes correct `score_30d` for a known input set.
- `aggregate` respects 7d / 30d windows correctly (signals older than 30d excluded).
- `pending` returns correction candidates only when `last_correction_patch` present.
- `pending` returns promotion candidates only when `score_30d > 0.75 && uses_30d >= 10`.
- `pending` kind filter works.

Use `node:test` and `node:assert`, matching existing test style in `mcp-server/tests/`.

Run: `npm test` — all must pass.

**Commit:** `test(feedback): unit tests for record/aggregate/pending`

---

## Phase 4 — Final verify

- `npm run typecheck` — pre-existing errors only.
- `npm run build` — clean.
- `npm test` — all passing.

---

## Rules for executing subagents

- `npm test` and `npm run typecheck` after EVERY commit.
- Co-authored-by trailer on every commit.
- Stay on `main`.
- Do NOT implement auto-merge. PRs are always human-reviewed.
- Do NOT store message content, prompts, or user identity in any file.
