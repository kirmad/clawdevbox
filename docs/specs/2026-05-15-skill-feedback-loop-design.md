# Skill Feedback Loop Design

**Status:** Draft  
**Date:** 2026-05-15  
**Scope:** Privacy-safe implicit feedback, aggregation, auto-correction, and auto-promotion for vault skills.

---

## 1. Problem

Skills in `.clawdevbox/skills/` and the team vault evolve slowly because there is no signal about which ones are actually useful in practice. Agents use or skip skills silently. Bad skills persist; good ones stagnate at `project` scope. There is no mechanism for agents to propose corrections without spamming the PR queue.

---

## 2. Goals & Non-Goals

### Goals

- Record implicit outcome signals locally with no user PII and no message content.
- Aggregate locally, then share only aggregate stats via a single weekly PR.
- Allow agents to queue correction patches for skills whose outputs they had to fix.
- Auto-promote high-signal skills from `project` to `global` scope via PR.
- Give vault-auditor reviewers a checklist to detect reward hacking before merge.

### Non-Goals

- No telemetry service. Everything is local JSONL and git.
- No real-time sync. Weekly batch is sufficient.
- No automated merge. vault-auditor always approves.
- No content storage. Patches in corrections are diffs only, bounded to 8 KiB.

---

## 3. Data Model

### 3.1 Local signal (`local.jsonl`)

One JSON object per line, appended by `skill.feedback.record`:

```jsonc
{
  "skill_id": "dev-buddy",
  "signal": "used",           // "used" | "skipped" | "corrected" | "error"
  "day": "2026-05-15",        // UTC date, truncated — not a full timestamp
  "session_hash": "a3f7c901", // SHA-1(hostname + pid + day)[0:8] — not user-identifying
  "correction": "--- a/...\n+++ b/...\n..."  // unified diff, only when signal=corrected
}
```

**Privacy invariants:**
- `session_hash` does not encode user identity; it changes every calendar day and every process restart.
- No message text, prompt, or output is stored.
- `local.jsonl` is gitignored and never leaves the local clone.

### 3.2 Aggregate snapshot (`agg.json`)

Produced by `skill.feedback.aggregate` from `local.jsonl`:

```jsonc
{
  "updated_at": "2026-05-15T12:00:00Z",
  "skills": [
    {
      "skill_id": "dev-buddy",
      "uses_7d": 12,
      "uses_30d": 47,
      "skips_7d": 1,
      "skips_30d": 4,
      "corrections_30d": 2,
      "errors_30d": 0,
      "score_30d": 0.87,           // (uses − skips − 2×errors) / max(total, 1), bounded [−1, 1]
      "last_correction_patch": "--- a/dev-buddy.md\n+++ b/dev-buddy.md\n..."  // optional
    }
  ]
}
```

`agg.json` **is** shared via git PR. It contains no PII, no message content. Correction patches are included only for skills with pending corrections; once a correction PR is merged, the patch field is cleared.

---

## 4. Signal Semantics

| Signal      | When to emit                                                              |
|-------------|---------------------------------------------------------------------------|
| `used`      | Agent read and applied this skill for the current task.                   |
| `skipped`   | Agent considered this skill but chose not to apply it.                    |
| `corrected` | Agent had to repair the skill's advice after applying it. Include diff.   |
| `error`     | Skill caused a tool invocation or parsing failure.                        |

Voting rules enforced during aggregation:
- One effective vote per `(skill_id, signal, session_hash, day)` — exact duplicates are dropped.
- A session can record `used` and `corrected` for the same skill (correction implies prior use).
- `error` counts double in the score formula (×2 penalty) because failures are more costly.

---

## 5. Score Formula

```
score_30d = clamp(
  (uses_30d − skips_30d − 2 × errors_30d) / max(uses_30d + skips_30d + errors_30d, 1),
  −1, 1
)
```

Range: `−1` (universally harmful) → `+1` (universally useful). Rounded to 2 decimal places.

---

## 6. Sharing via Git PR

### 6.1 What gets committed

- `.clawdevbox/feedback/agg.json` (aggregate stats, no PII)
- Optional: one `.clawdevbox/feedback/corrections/<skill_id>.patch` per pending correction

### 6.2 Branch and PR naming

- Weekly stats PR: `feedback/YYYY-Www` (e.g., `feedback/2026-W21`), label `feedback-batch`
- Correction PR: `skill-correction/<skill_id>/<YYYY-MM-DD>`, label `skill-correction`
- Promotion PR: `skill-promotion/<skill_id>`, label `skill-promotion`

Stats PRs are batched (one per week maximum). Correction and promotion PRs are individual so vault-auditor can review each skill change independently.

### 6.3 CODEOWNERS

Add to vault CODEOWNERS:
```
.clawdevbox/feedback/     @vault-auditor
```

### 6.4 gitignore

```
.clawdevbox/feedback/local.jsonl
```

`local.jsonl` must never be committed. `agg.json` and `corrections/` are committed.

---

## 7. Auto-Correction

**Trigger:** `skill.feedback.pending kind=corrections` returns entries.

**Flow:**
1. Recipe reads `agg.json`, finds skills with `last_correction_patch`.
2. Validates each patch: must parse as a unified diff, must apply cleanly to the current skill source, must not change `id` or `name` frontmatter fields.
3. Creates a branch `skill-correction/<skill_id>/<date>`, applies the patch, opens a PR.
4. PR body includes: the patch, the `corrections_30d` count, and `score_30d`.

**Safeguards:**
- Patch size capped at 8 KiB in `skill.feedback.record`.
- Only the latest correction for a skill within the aggregation window is included (earlier ones are dropped during aggregation).
- vault-auditor must approve before merge. No auto-merge.

---

## 8. Auto-Promotion

**Trigger:** `score_30d > 0.75 AND uses_30d >= 10` (configurable in `skills-promotion-policy.md`).

**Flow:**
1. Recipe opens a PR that moves the skill file from `project/skills/<id>/SKILL.md` to `global/skills/<id>/SKILL.md`.
2. PR body includes the full `agg.json` entry for the skill.
3. vault-auditor reviews and merges.

**Safeguards:**
- Threshold is deliberately high to require sustained use across many sessions.
- A skill that was demoted (score later drops below 0.3 after promotion) gets a reverse PR (`skill-demotion/<id>` label) moving it back to project scope.

---

## 9. Anti-Poisoning & Reward Hacking

| Attack                                      | Mitigation                                                                 |
|---------------------------------------------|----------------------------------------------------------------------------|
| Replay / flood `skill.feedback.record`       | Dedup by `(skill_id, signal, session_hash, day)` — flood collapses to 1 vote |
| Use a single agent session to vote many times | `session_hash` is per-process-per-day; extra calls in same session = same hash |
| Submit malicious correction patch           | Patch validated as unified diff, size-capped, frontmatter id/name protected |
| Rapid score spike to force promotion        | vault-auditor anomaly check: `score_30d` increase > 0.30 in 7d without proportional `uses` increase → PR gets `needs-human-review` label |
| Promote then corrupt skill content          | Promotion is a file-move PR reviewed by vault-auditor; skill body reviewed on the PR |
| Skew others' skills by emitting negative signals | Each contributing agent only votes on skills it itself used/skipped — design contract |

The full anomaly-check script is in `docs/FEEDBACK-OPERATIONS.md`.

---

## 10. v1 File List

**New code:**
- `mcp-server/src/tools/feedback.ts` — `skill.feedback.record`, `.aggregate`, `.pending` (~200 LOC)
- `samples/recipes/feedback-sync.yaml` — weekly aggregation recipe

**New docs (5 markdown files):**
- `docs/specs/2026-05-15-skill-feedback-loop-design.md` ← this file
- `docs/plans/2026-05-15-skill-feedback-loop.md` — implementation plan
- `docs/FEEDBACK-OPERATIONS.md` — vault-auditor runbook
- `.clawdevbox/feedback/README.md` — local directory privacy notice
- `docs/skills-promotion-policy.md` — governance thresholds

**Modified:**
- `mcp-server/src/tools/index.ts` (or equivalent) — register `registerFeedbackTools`
- `.gitignore` — add `local.jsonl`
- `CODEOWNERS` (in vault repo) — `@vault-auditor` on `.clawdevbox/feedback/`
