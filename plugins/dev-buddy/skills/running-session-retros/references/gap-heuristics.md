# Gap Heuristics (v2)

Seven signals operating on the **normalized session model** from `fetching-agent-sessions`. A session scores 1 point per signal that fires. Sessions scoring ≥ 1 go to deep-dive analysis.

## Signal 1 — Long session

```
len(turns) > 50
```

**Why:** very long sessions usually mean the agent got stuck or thrashed.

**Risk of false positive:** legitimate complex work is sometimes long. Combine with other signals; don't rely on this alone.

## Signal 2 — High tool failure rate

```
tool_turns = [t for t in turns if t.role == "tool"]
failure_rate = sum(1 for t in tool_turns if t.tool_success == False) / max(1, len(tool_turns))
fires when: len(tool_turns) >= 3 AND failure_rate > 0.20
```

**Why:** > 20% tool failures usually signals trial-and-error rather than informed action.

**Minimum tool count guard:** at least 3 tool turns to avoid noise from sessions with one failed tool.

## Signal 3 — File thrash

```
edit_counts = Counter(f.path for f in files_touched if f.op == "edit")
fires when: any path edited more than 3 times
```

Note: `files_touched` is deduped per `(path, op)` in v1, so this heuristic needs to look at the raw turn stream OR (better) look at the count of `role:"tool" AND tool_name in ("edit","multiedit","str_replace")` per inferred file from the turn's `text` field (which the adapters populate as `"<tool> <path>"`).

KISS implementation: count `role:"tool" AND tool_name == "edit"` turns; if > 3 fires (file-level grouping is a v2 refinement).

**Why:** repeatedly editing the same area without verification is classic thrash.

## Signal 4 — Explicit user correction

```
correction_phrases = [
  "you should have",
  "instead use",
  "i told you",
  "why didn't you",
  "that's wrong",
  "no, do",
  "stop doing"
]
fires when: any user-role turn's text (case-insensitive) contains any of the phrases above
```

**Why:** user corrections are the highest-signal indicator that the agent went down a wrong path.

**This is the highest-priority signal.** A session that fires only signal 4 should still get deep-dived.

## Signal 5 — User-initiated aborts (≥2)

```
abort_turns = [t for t in turns if t.role == "user" and t.text.startswith("[ABORT:")]
fires when: len(abort_turns) >= 2
```

**Why:** repeated user aborts mean the agent kept going down wrong paths and the user kept stopping it. Strongest signal of "should have asked first" — usually `discipline-gap` or `instruction-from-user`.

## Signal 6 — Instructional language from user (teaching moments)

```
teaching_phrases = [
  "let me show you how",
  "here's how to",
  "the right way to",
  "next time, do",
  "next time, ",
  "always ",
  "never ",
  "remember to",
  "remember that",
  "the way we do",
  "the way it works is",
  "fyi:",
  "for future reference"
]
fires when: any user-role turn matches any phrase above
```

**Why:** when the user TEACHES a procedure, that's a candidate `instruction-from-user` → new skill. Highest-leverage signal for proactive skill creation.

## Signal 7 — Skill-correction phrases (update-existing-skill candidates)

```
skill_correction_phrases = [
  "the <skill-name> skill",
  "your skill",
  "the skill missed",
  "update the skill",
  "the brainstorming step",
  "the tdd step",
  "the review step",
  "<skill-name> should also"
]
fires when: any user-role turn references an existing skill name + a corrective verb
```

Match `<skill-name>` against the `skill.list` catalog. When fired, classify as `correction-to-existing-skill` and the artifact is a diff to that skill's SKILL.md.

## Scoring

```
score = sum of fired signals (max 7)
deep_dive_threshold = 1
```

Any session with score ≥ 1 gets a deep-dive sub-agent (see `subagent-prompts.md`).

**Priority order for deep-dive when capped:** Signal 6 > 7 > 4 > 5 > 3 > 2 > 1. Teaching moments (6) and skill-corrections (7) are the highest-leverage gaps because they produce concrete new artifacts the agent will consult forever.

If too many sessions score ≥ 1, rank by score descending and take the top 10 for deep-dive (further pruning happens after classification).

## What's intentionally NOT in v2

- ML-based pattern matching (overkill; this is KISS v2)
- Cross-session correlation for `repeated-procedure` detection — see "Future" note below
- Token cost / model selection signals (deferred)
- Time-of-day / fatigue signals (deferred)

## Future: cross-session `repeated-procedure` detection

The `repeated-procedure` gap type from SKILL.md requires comparing tool sequences ACROSS multiple sessions in the window to find recurring N-step patterns. This is a v3 heuristic and currently relies on the deep-dive sub-agent recognizing patterns qualitatively. When v3 lands, add a Signal 8 here that runs sequence-mining over the normalized session set.
