# Sample Triggers — Reference Implementations

Reference triggers for the Clawdevbox design (spec §8). Demonstrates the **detect → frame as prompt → return** pattern: the script either writes a single optional `callback` object on stdout (Mode A — Clawdevbox delivers it to `env.callback_url`) or POSTs each event live to `env.callback_url` during the run (Mode B). The pre-bound URL is minted with all routing context baked into the path. The script never thinks about thread ids, parent ids, template ids, or inbox item ids.

## Two response modes (spec §8.4)

| Mode | When to use | What the script does |
|---|---|---|
| **A — stdout response** *(at most ONE delivery per run)* | One-shot detection that produces 0–1 events: a single-fire webhook, or a final/summary action emitted on exit by a longer-running script | Set a singular `callback: { body: ... }` object on the JSON response (or omit it for a no-op); write JSON on stdout; exit 0. Zero HTTP calls. Clawdevbox delivers that one entry to `env.callback_url`. |
| **B — live POSTs during the run** *(any number of events)* | Cron polls that may surface multiple events, daemon-style watchers, anything that needs to deliver more than one event per run | While the script runs, POST `{ prompt, context }` to `env.callback_url` for each event. On exit, write `{ state, systemMessage }` to stdout (no `callback` field). |

**Mode A's `callback` is singular.** If a single run needs to deliver more than one event, use Mode B for the live events. Mode A's `callback` is reserved for at most one final/summary action.

The reference comment-watchers (`ado-comment-watcher.ts/.py`) use Mode B because a single cron tick can surface multiple new comments. The `mock-clawdevbox` test harness in `test/` exercises both modes — Mode A's lone `callback` and Mode B's live POSTs both feed the same captured-callbacks list.

## Mixed Mode (A + B) — `ado-pr-pulse-watcher.ts`

A third sample, `ado-pr-pulse-watcher.ts`, demonstrates **both modes in the same script**. It's a long-running watcher that polls a PR for new comments and new iteration pushes for `state.maxRunSec` seconds.

**Why mix:**
- **Live events use Mode B.** When a new comment or iteration is detected mid-run, the script POSTs to `env.callback_url` immediately. The agent gets pinged within `pollIntervalSec` of the event — much lower latency than waiting for the script to exit.
- **The final summary uses Mode A.** When the budget is reached (or the PR closes), the script sets ONE summary `callback` on stdout and exits. Clawdevbox delivers it as the script's natural handoff — the agent reads "watch ended, here's why" and decides what to do next.

The on-receiving-end agent can't tell the difference: every callback is a `{ prompt, context }` body, regardless of which path delivered it. The two modes coexist on the same `callback_url` because Clawdevbox's callback fan-out is path-keyed, not source-keyed.

**Timeline of an 8-second pulse-watch with two new comments:**

```
t=0s   spawn pr-pulse-watcher.ts  (envelope on stdin: state.maxRunSec=8, pollIntervalSec=3)
       │
t=0s   tick #1: fetch PR status → "active"; no new comments; no new iterations.
       │
t=3s   tick #2: fetch PR status → "active"; one new comment (id=42).
       ├─[Mode B]─→ POST env.callback_url { prompt: "[live] new comment...", context: {...} }
       │
t=6s   tick #3: fetch PR status → "active"; one new comment (id=43).
       ├─[Mode B]─→ POST env.callback_url { prompt: "[live] new comment...", context: {...} }
       │
t=8s   deadline hit → exit loop.
       │
t=8s   build summary entry: "Time budget reached. Live: 2 comments, 0 iterations."
       │
t=8s   write { state, callback: <summary>, systemMessage } to stdout, exit 0.
       │
       └─[Mode A]─→ Clawdevbox reads stdout, delivers the one `callback`
                    entry to env.callback_url internally.
```

End result on the agent's resume queue: **3 messages**. Comments delivered live during the watch (Mode B); summary delivered on exit (Mode A). The mock-clawdevbox in `test/` validates both paths with Scenario F.

## Files

| File | Purpose |
|---|---|
| `ado-comment-watcher.ts` | Mode B sample. POSTs each new comment live to `env.callback_url`; stdout returns state only. Run with `tsx`. |
| `ado-comment-watcher.py` | Same logic, in Python. **Standard library only — no pip installs.** |
| `ado-pr-pulse-watcher.ts` | Mixed-mode (A + B) sample. Long-running PR pulse watcher. Run with `tsx`. |
| `triggers.json` | Example `_runtime` entries. |

**Triggers are language-agnostic.** Both files implement the exact same trigger using the same stdin/stdout/env-var/HTTP protocol. Pick whichever language fits your operational preferences. Clawdevbox doesn't care — it just spawns a subprocess and pipes JSON.

To switch from TS to Python, only one line in `triggers.json` changes:

```diff
- "command": "tsx $CLAWDEVBOX_PROJECT_DIR/.clawdevbox/triggers/_runtime/ado-comments-thr_01HX.ts"
+ "command": "python3 $CLAWDEVBOX_PROJECT_DIR/.clawdevbox/triggers/_runtime/ado-comments-thr_01HX.py"
```

Same goes for shell, Go, Rust, anything that can read stdin, hit two HTTPS endpoints, and write stdout.

## Routing lives in the URL, not the body

When a trigger is registered, Clawdevbox mints a structured callback URL based on what the trigger should do:

| URL shape | What a POST does |
|---|---|
| `/callback/threads/<thread_id>/resume` | Append message + wake suspended CLI |
| `/callback/templates/<template_id>/run` | Spawn fresh thread with that template |
| `/callback/templates/<template_id>/run/<inbox_item_id>` | Spawn fresh thread, attach to specific inbox item |
| `/callback/templates/default-agent/run` | Spawn fresh thread with bundled empty-agent recipe |
| `/callback/threads/<parent_id>/spawn-sub/<template_id>` | Spawn a child thread (fan-out) |
| `/callback/threads/<thread_id>/close-step` | Append `step_close` + wake (for "PR merged → close monitor step") |
| `/callback/inbox/<inbox_item_id>/update` | Patch inbox columns from POST body (no agent involved) |

The trigger's registration tells Clawdevbox which URL shape to mint. The script gets it ready-to-use as `env.callback_url` and POSTs (Mode B) or returns `callback.body` (Mode A) without thinking about routing.

## What the script returns — stdout JSON

**Mode A (at most one callback per run):**

```json
{
  "state": { "lastCheckedAt": 1715284800000, "prId": 2401, "repo": "auth-svc" },
  "callback": {
    "body": {
      "prompt": "Pulse-watch on PR 2401 ended: time budget reached after 8s. Live events: 2 comments, 0 iterations.",
      "context": { "source": "ado", "kind": "pr.pulse_summary", "pr_id": 2401, "exit_reason": "time_budget_reached" }
    }
  },
  "systemMessage": "Pulse-watch done"
}
```

**Mode B (zero callbacks on stdout — events were POSTed live during the run):**

```json
{
  "state": { "lastCommentId": 99, "selfUser": "kirmadi@microsoft.com", "prId": 2401, "repo": "auth-svc" },
  "systemMessage": "Forwarded 1 comment"
}
```

`callback.body` is exactly the same shape a Mode-B script would POST to `env.callback_url`. Clawdevbox delivers Mode A's lone entry on the script's behalf.

`context` is optional and the agent can use it for structured reference. The `prompt` is the actual work instruction — natural language the agent reads.

**No-op:** `{ "state": <unchanged> }` (or `{}`) on stdout, exit 0. Zero callbacks delivered.

## How it works end-to-end (Mode B comment-watcher)

```
ADO PR comment posted
        │
        ├─── Path A (real-time):     ADO service hook POSTs to /hooks/<id>
        └─── Path B (cron, 30s):     in-process daemon self-fires /hooks/<id>
        │
        ▼
Clawdevbox sidecar /hooks/<id>:
  - validates auth, spawns: tsx ado-comment-watcher.ts
  - pipes JSON envelope to stdin (includes pre-bound callback_url)
        │
        ▼
ado-comment-watcher.ts (Mode B):
  - parses envelope
  - detects new comments (from payload, or by polling ADO)
  - for each new comment:
       1. constructs a PROMPT framing the comment as work for the agent
       2. POSTs { prompt, context } directly to env.callback_url
       (the script DOES NOT KNOW or CARE which thread; the URL handles it)
  - writes JSON to stdout: { state, systemMessage }, exits 0
        │
        ▼
Clawdevbox sidecar /callback/threads/thr_01HX/resume (per POST):
  - URL path tells the handler: append + wake on thread thr_01HX
  - inserts messages row { type: 'signal_received', payload: { prompt, context } }
  - if thread suspended → spawns `claude --resume thr_01HX`
  - returns 200
        │
        ▼
agent wakes, reads the framed prompt, drafts a reply, posts via ado.comment_pr,
exits — back to suspended.
```

## Multi-action triggers (rare)

For a trigger that needs to perform different actions in different cases (e.g., a single watcher that both wakes the parent thread AND spawns sub-recipes), the registration declares each action and the envelope contains a `callback_urls` map:

```json
{
  "callback_url": "http://.../callback/threads/thr_epic/resume",
  "callback_urls": {
    "self_resume":     "http://.../callback/threads/thr_epic/resume",
    "spawn_workitem":  "http://.../callback/threads/thr_epic/spawn-sub/implement-workitem",
    "spawn_review":    "http://.../callback/threads/thr_epic/spawn-sub/pr-review"
  }
}
```

In Mode B the script picks `env.callback_urls.spawn_workitem` for each child item and POSTs `{ prompt }`. (A future minor revision of Mode A will let the singular `callback` declare `url: 'spawn_workitem'` to pick a key.) Most triggers don't need fan-out — a single `callback_url` covers them.

## The script's real job: framing

The script doesn't push raw data at the agent. It constructs a **prompt** that frames the event as work. From `ado-comment-watcher.ts`:

```ts
function commentToPrompt(prId: number, comment: AdoComment): string {
  return [
    `New comment on PR ${prId} from ${comment.author.displayName}:`,
    ``,
    `> ${comment.content.split('\n').join('\n> ')}`,
    ``,
    `Look at this comment in the context of your current review.`,
    `If it's a question, draft a clear answer grounded in the diff.`,
    `If it's a change request, draft a plan and ask the user via approval.request before applying.`,
    `If it's affirming, acknowledge briefly and continue.`,
    `Consult the respond-to-pr-comment template for tone and structure.`,
  ].join('\n');
}
```

That's the script's most valuable code. The HTTP plumbing is generic; the prompt translation is what makes this trigger useful.

## Setup

1. Drop the file in: `<workspace>/.clawdevbox/triggers/_runtime/ado-comments-<thread_id>.ts`
2. The agent (or you) calls `trigger.upsert(...)` to register the entry. Clawdevbox mints the right callback URL based on what the trigger declares it does (here: `subscriber_thread_id` set → resume URL).
3. Set ADO credentials in Clawdevbox's keychain.
4. (Optional) Configure an ADO service hook to POST comment events to `/hooks/<id>` for sub-second response.

## Testing without the daemon

Because `ado-comment-watcher.ts` uses Mode B, it needs a callback endpoint to POST to during the run. The `test/capture.mjs` helper spins up a local `mock-clawdevbox` first, then pipes a synthetic envelope through the script, then prints the resulting timeline:

```bash
cd test && node capture.mjs
# → STDIN envelope, STDOUT response, exit code, AND the live Mode B POSTs
#   captured by mock-clawdevbox at /test/received-callbacks
```

For an end-to-end test that runs all six scenarios, see `test/test-driver.ts`.

## Other prompt patterns

The same one-URL pattern applies elsewhere — only the registration shape (which URL Clawdevbox mints) varies:

| Trigger detects | Registration mints URL | Constructed prompt |
|---|---|---|
| New PR (cold trigger) | `/callback/templates/pr-review/run` | "Review PR 2401 in auth-svc: Fix auth..." |
| PR merged | `/callback/threads/<id>/close-step` | "PR 2401 was merged. Close the monitor step and move to post-merge cleanup." |
| Stale PR (7d idle) | `/callback/threads/<id>/resume` | "PR 2401 has been quiet for 7 days. Bump the author/reviewers; if already nudged, escalate." |
| Epic decomposed → 5 items | `callback_urls.spawn_workitem` (per item) | "Implement WI-9001: <title>." |
| Incident fired | `/callback/templates/incident-investigate/run` | "Incident INC-9082 (P0, auth-svc) fired at 03:14. Investigate." |
| Walkthrough comment | `/callback/threads/<id>/resume` | "User commented at line 42: 'why this approach?' — answer in your reply." |

The script body is generic; only `commentToPrompt`-style functions change per trigger kind.

## State vs. trigger_data_dir

The envelope gives the script two persistence channels:

| Channel | What it's for | How it works |
|---|---|---|
| `state` (in stdin envelope, returned via stdout) | Small structured data — counters, ids, timestamps, settings. The example here uses it for `lastCommentId`, `selfUser`, etc. | Clawdevbox reads the previous value from `triggers.state_json` and gives it to the script; the script returns the new value via stdout JSON; Clawdevbox persists. |
| `trigger_data_dir` | Files, caches, large blobs, anything you'd `fs.writeFile`. Path is `<project_dir>/.clawdevbox/triggers/<trigger_id>/data/`. | The script writes/reads with normal `fs` calls. Clawdevbox creates the directory on first run and (for hot triggers) deletes it when the trigger goes away. Per-trigger — no collisions with other triggers. |

A richer trigger that downloads files (e.g., a release-notes generator that fetches PR diffs) would use `trigger_data_dir` to cache them between runs. The comment-watcher here doesn't need it, but the path is always available.

## Idempotency & error handling

- `state.lastCommentId` advances monotonically. A comment delivered both via webhook AND on next cron poll is skipped on the second pass.
- One bad ADO call only blocks the poll path; transient errors retry from the same state on the next tick.
- In Mode A, callback delivery happens *after* the script exits — Clawdevbox handles delivery failures and retries; the script doesn't need to.
- In Mode B, a failed POST means the script exits non-zero; Clawdevbox logs `last_run_error` and does NOT update state — next tick retries.

## Why this design

The earlier drafts of this script:
1. Made 3-5 MCP calls per comment to look up threads, append messages, wake CLIs.
2. Hardcoded routing fields (`thread_id`, `recipe`, `parent_thread_id`) into the POST body, forcing the script to know Clawdevbox's data model.

Now:
1. Routing is in the URL (minted by Clawdevbox at registration time, not script-time).
2. Callback body has only `{ prompt, context }` — no internal-state knowledge required.
3. Mode A scripts make ZERO HTTP calls — they just write JSON on stdout — but they're capped at one delivery per run.
4. Mode B scripts POST live for any number of events; their stdout is state-only.

The script becomes a generic adapter: external events → human-framed prompts. The agent does the actual work of responding.
