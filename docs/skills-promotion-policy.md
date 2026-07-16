# Skills Promotion & Demotion Policy

**Owner:** vault-auditor  
**Last reviewed:** 2026-05-15

---

## Promotion: project → global scope

A skill may be proposed for promotion via a `skill-promotion/<id>` PR when **all** of the following are true:

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| `score_30d` | > 0.75 | High signal-to-noise over a 30-day window |
| `uses_30d` | ≥ 10 | Sufficient sample size; hard to game with few sessions |
| `errors_30d` | = 0 | No recent failures (errors count ×2 in the score but this is an explicit gate) |

The promotion recipe checks these thresholds against `agg.json`. The vault-auditor then reviews the skill body for global suitability (see `FEEDBACK-OPERATIONS.md`).

**Waiting period:** A skill promoted to global scope cannot be demoted for at least **14 days**, to avoid thrash from short-term signal noise.

---

## Demotion: global → project scope

A skill in global scope is a candidate for demotion when:

| Criterion | Threshold |
|-----------|-----------|
| `score_30d` | < 0.30 sustained for ≥ 14 consecutive days |
| OR `errors_30d` | ≥ 3 (hard floor — immediate demotion candidate) |

The feedback-sync recipe opens a `skill-demotion/<id>` PR automatically when either condition is met. vault-auditor reviews and merges.

---

## Correction policy

Any skill (project or global scope) may receive a correction PR when:

- `corrections_30d >= 2` — at least two distinct sessions recorded a `corrected` signal.
- The correction patch is a valid unified diff, ≤ 8 KiB, that does not change `id` or `name` frontmatter fields.

A single-session correction (`corrections_30d == 1`) is surfaced in `skill.feedback.pending` but does **not** automatically open a PR. The vault-auditor or the skill owner may open one manually after reviewing.

---

## Changing these thresholds

Update the constants in `mcp-server/src/tools/feedback.ts`:

```ts
export const PROMOTION_SCORE_THRESHOLD = 0.75;
export const PROMOTION_USES_THRESHOLD = 10;
export const DEMOTION_SCORE_THRESHOLD = 0.30;
export const DEMOTION_ERROR_HARD_FLOOR = 3;
export const CORRECTION_MIN_SESSIONS = 2;
```

Then update the table above and open a PR with the `policy-change` label. vault-auditor must approve policy changes.

---

## Scope map

```
project/skills/<id>/SKILL.md   — visible to this workspace only
global/skills/<id>/SKILL.md    — visible to all workspaces on this machine / team vault
plugin:<id>/skills/<id>/...    — read-only, owned by the plugin
```

Feedback signals are recorded regardless of scope. Promotion/demotion only applies to the `project` ↔ `global` boundary. Plugin-scoped skills are immutable via this system.
