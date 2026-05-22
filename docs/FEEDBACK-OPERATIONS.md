# Feedback Operations Runbook

**Audience:** vault-auditor and any team member reviewing a feedback-related PR.

---

## PR types and what to check

### `feedback-batch` PR (weekly stats)

Branch pattern: `feedback/YYYY-Www`  
Contains: `.clawdevbox/feedback/agg.json` update only.

#### Checklist

- [ ] **No PII.** `agg.json` must not contain email addresses, usernames, hostnames, or message text. Only `skill_id`, counters, and `score_30d`.
- [ ] **Schema valid.** Every entry has `skill_id` (string), `uses_30d` (integer ≥ 0), `skips_30d` (integer ≥ 0), `score_30d` (float −1 to 1).
- [ ] **No sudden spike (reward hacking check).** For each skill, compare this week's `score_30d` against last merged week's value. If `Δscore > 0.30` **and** `uses_30d < 5`, add label `needs-human-review` and ping the team before merging.
- [ ] **Correction patches absent.** Stats PRs must not include `.patch` files — those travel on their own `skill-correction/*` PRs.
- [ ] **`local.jsonl` absent.** If any `local.jsonl` appears in the diff, close the PR and ask the contributor to fix their `.gitignore`.

If all checks pass: **approve and merge**.

---

### `skill-correction` PR

Branch pattern: `skill-correction/<skill_id>/<date>`  
Contains: one modified `SKILL.md` in project or global skills.

#### Checklist

- [ ] **Diff is structural, not adversarial.** Read the changed lines. Instructions should clarify, not redirect the agent to call arbitrary tools or exfiltrate data.
- [ ] **Frontmatter `id` and `name` unchanged.** A correction must not rename or re-id a skill.
- [ ] **Patch applied cleanly.** PR CI should show green. If it doesn't apply, close and ask for a rebase.
- [ ] **Aggregate signal supports the correction.** PR body should include `corrections_30d` count. If `corrections_30d < 2`, the single-correction signal may be noise — comment and request confirmation.
- [ ] **`score_30d` direction.** Corrected skills typically have a lower score. If `score_30d > 0.90` and there are corrections, something is inconsistent — investigate before merging.

If all checks pass: **approve and merge**.

---

### `skill-promotion` PR

Branch pattern: `skill-promotion/<skill_id>`  
Contains: skill file moved from `project/skills/<id>/` to `global/skills/<id>/`.

#### Checklist

- [ ] **Threshold met.** PR body must show `score_30d > 0.75` and `uses_30d >= 10`. Reject if either condition is missing from the body (the recipe is supposed to include this).
- [ ] **Skill body review.** Read the full skill markdown. It is becoming globally available — content should be appropriate for all team members.
- [ ] **No project-specific secrets.** Skill body must not reference project-specific endpoints, internal hostnames, or credentials.
- [ ] **Conflicts.** No `global/skills/<id>/` directory already exists with conflicting content.

If all checks pass: **approve and merge**.

---

### `skill-demotion` PR

Branch pattern: `skill-demotion/<skill_id>`  
Contains: skill file moved from `global/skills/<id>/` back to `project/skills/<id>/`.

#### Checklist

- [ ] **Score has declined.** PR body must show `score_30d < 0.30` sustained over 14+ days.
- [ ] **Skill body is unchanged** (this is purely a scope move, not a content edit).

If all checks pass: **approve and merge**.

---

## Anomaly detection script

Run this locally to flag suspicious batches before reviewing a `feedback-batch` PR:

```sh
# Compare current agg.json with the last merged week's agg.json
git fetch origin main
git show origin/main:.clawdevbox/feedback/agg.json > agg_prev.json 2>/dev/null || echo '{"skills":[]}' > agg_prev.json

node - <<'EOF'
const prev = JSON.parse(require('fs').readFileSync('agg_prev.json','utf8'));
const curr = JSON.parse(require('fs').readFileSync('.clawdevbox/feedback/agg.json','utf8'));
const prevMap = Object.fromEntries((prev.skills||[]).map(s=>[s.skill_id, s]));
for (const s of (curr.skills||[])) {
  const p = prevMap[s.skill_id];
  const prevScore = p ? p.score_30d : 0;
  const delta = s.score_30d - prevScore;
  if (delta > 0.30 && s.uses_30d < 5)
    console.log(`SUSPICIOUS: ${s.skill_id}  Δscore=${delta.toFixed(2)}  uses_30d=${s.uses_30d}`);
}
console.log('Anomaly scan complete.');
EOF

rm -f agg_prev.json
```

Any `SUSPICIOUS:` lines should be investigated before merging. Ask the contributor to explain the spike or wait for the next weekly batch to confirm the trend.

---

## Escalation

If you see:
- Correction patches that inject tool calls or remote requests into a skill body
- Score spikes > 0.50 in a single week with < 3 sessions
- `local.jsonl` included in any PR diff

→ Close the PR, add label `security-review`, and ping `@vault-auditor` for a synchronous review.
