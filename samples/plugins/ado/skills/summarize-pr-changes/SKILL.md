---
name: summarize-pr-changes
description: How to read an ADO PR's diff and produce a 5-bullet summary keyed on impact, risk, test coverage, dependency changes, and perf concerns. Used by the pr-review recipe before drafting inline comments.
triggers:
  - "pr-review recipe step 1"
  - "the user asks 'what's in this PR'"
  - "summarizing an iteration push for the inbox card"
---

# Summarizing a PR's changes

The goal is a 5-bullet summary the user can read in under 20 seconds and
understand: *what changed, what's risky, what's tested, what dependencies
moved, what to watch in production*.

This is the first surface for every PR review and the snippet the
inbox card displays under `agent_message`. Keep it tight.

## 1. Gather inputs

Use the ADO MCP server (see `mcp/ado.json` in this plugin) to fetch:

- `ado.get_pr({ pr_id })` — title, description, source/target branches,
  status, author.
- `ado.get_pr_iteration({ pr_id, iteration_id })` — the diff for the
  iteration you're reviewing. (Pass `latest` for the current one.)
- `ado.list_pr_comments({ pr_id })` — prior reviewer comments; useful to
  see what's already been raised.
- `ado.get_pr_work_items({ pr_id })` — linked work items (for context on
  *why* this PR exists).

(These tool names are illustrative of the ADO MCP server's surface; the
exact names live in `mcp/ado.json` and the server's manifest.)

## 2. The five bullets

Always produce exactly five bullets, in this order:

1. **Impact.** One sentence: what does this PR *do*? Not how — what user-
   visible or system-level behavior changes.
2. **Risk.** What could break? Look for: error-handling deletions,
   widened type signatures, removed validation, concurrent-access
   patterns, public-API changes.
3. **Test coverage.** Are there new tests? Do they cover the new branches?
   Are existing tests modified? Flag anything where a behavior change
   ships without a corresponding test.
4. **Dependency changes.** Any `package.json`, `package-lock.json`,
   `pom.xml`, `Cargo.toml`, `requirements.txt`, etc. diffs. Note the
   version delta and whether the bump is patch / minor / major.
5. **Perf concerns.** Any new loops, network calls in hot paths,
   synchronous I/O on request paths, or unbounded allocations. Default
   to "none observed" if the diff is mechanical.

If a bullet has nothing to report, write "none" — don't omit the bullet.
The fixed five-bullet shape is what makes this scannable.

## 3. Style

- One sentence per bullet, max two. The user is skimming.
- Cite the file and (when useful) line number: ``Impact: switches
  `src/auth/login.ts:42` from `Bearer` to `OAuth2` token validation.``
- No "this PR" preamble — every bullet is implicitly about this PR.
- No emoji, no bold inside bullets. The bullet header is bold; the body
  is plain text.

## 4. Worked example

```
**Impact.** Replaces in-process LRU cache with shared Redis cache for session lookup; cuts cold-start latency on multi-instance deploys.
**Risk.** Removes the in-memory fallback path entirely; if Redis is unreachable, login fails closed (no graceful degradation). `src/auth/session.ts:88`.
**Test coverage.** New `RedisSessionStore` unit tests added. No integration test covering the Redis-unreachable path. Flag.
**Dependency changes.** Adds `ioredis@5.3.2` (minor bump from project's existing `4.x` dev usage).
**Perf concerns.** Adds one Redis GET per login. Should be sub-ms; existing in-process cache was 10us. Acceptable for the resilience win.
```

## 5. Handing off to the next step

Once the summary is drafted, the `pr-review` recipe expects you to:

1. Update the inbox card's `agent_message` to the first bullet ("Impact:
   ...") truncated to 80 chars.
2. Append a `view_emitted` message with the full five-bullet summary
   (kind: `pr_summary`, payload: `{ bullets: string[] }`) so the
   renderer can show it inline.
3. Continue to step 2 of `pr-review` (classification).
