# Conductor Trigger Test Harness

End-to-end test for the Conductor trigger mechanism (spec §8) using the
sample `ado-comment-watcher.ts` / `.py` scripts and **real Azure DevOps**.
Only the Conductor side is mocked — the trigger script makes real HTTPS
calls to `dev.azure.com` and gets real comments back.

## What this proves

That a trigger script written to the documented contract:
- Receives a JSON envelope on stdin (real-time external-fired path AND cron/poll path)
- Detects events (real ADO calls or inline payload)
- Frames each event as a prompt
- POSTs `{ prompt, context }` to the pre-bound `callback_url`
- Writes new state to stdout, exits 0 (or exit 2 on blocking error)

works end-to-end against a live ADO repository — without needing a running
Conductor sidecar, recipes, MCP, or any of the rest of the system.

## Architecture

```
                         +-------------------------------------+
                         | Real Azure DevOps (dev.azure.com)   |
                         |  - PR threads, comments, etc.       |
                         +-------------------------------------+
                                ^                       ^
                                |                       |
                                | HTTPS                 | HTTPS (PAT auth)
                                | (az cli, az login)    |
                                |                       |
   +-------------------+        |                       |
   | setup-ado.sh      |--------+ posts test comment    |
   | (one-shot fixture)|          via az devops invoke  |
   +-------------------+                                |
                                                        |
                                                        |
                       +----------------------+   spawns subprocess
                       | test-driver.ts       |---------+
                       +-----+----------+-----+         |
                             |          |               |
                             |  POST    |  GET / POST   |
                             |  /hooks/ |  /test/...    |
                             v          v               v
                       +-----------------------+  +-----------------------+
                       | mock-conductor.ts     |  | trigger script        |
                       | (in-process server,   |  | ado-comment-watcher   |
                       |  random free port)    |  |   .ts | .py           |
                       |                       |  |                       |
                       | - validates Bearer    |  | reads stdin envelope, |
                       | - spawns trigger      |  | calls real ADO,       |
                       |   subprocess on /hook |  | POSTs to callback_url |
                       | - captures all        |  +-----------+-----------+
                       |   /callback/* POSTs   |              |
                       | - assertable via      |              | POST /callback/...
                       |   /test/*             |<-------------+
                       +-----------------------+
```

Three artifacts in motion:
1. **mock-conductor** — local HTTP server that pretends to be the Conductor sidecar. Receives webhook fires, spawns the trigger script, captures whatever the script POSTs back.
2. **trigger script** — `ado-comment-watcher.ts` or `.py` from this directory. Run unmodified.
3. **test-driver** — orchestrator. Boots mock, runs scenarios, asserts on captured callbacks.

## Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| Node 20+ | mock-conductor + test-driver | https://nodejs.org |
| `tsx` | run `.ts` files directly | `npm i -g tsx` (or via `npx tsx`) |
| `python3` | Scenario D | https://python.org (or skip with `--skip-py`) |
| `az` cli | post the test comment | https://learn.microsoft.com/cli/azure/install-azure-cli |
| `azure-devops` extension | `az devops invoke` | `az extension add --name azure-devops` (auto on first run) |
| `bash` | run setup-ado.sh | Git Bash on Windows; native everywhere else. Use `setup-ado.ps1` instead if preferred. |

## One-time setup

1. **Pick a real PR you don't mind testing against.** Ideally a draft PR in a sandbox repo. The harness posts ONE comment per setup run; cleanup is manual.

2. **Generate an ADO PAT.** Go to:
   ```
   https://dev.azure.com/<your-org>/_usermenu/userTokens
   ```
   Required scope: **Code (read & write)**. The trigger script uses this PAT (basic auth) to call the ADO REST API. The setup script does NOT use it — `az login` covers that side.

3. **Set env vars:**
   ```bash
   export ADO_ORG=microsoft           # or your org
   export ADO_PROJECT=One             # or your project
   export ADO_REPO=auth-svc           # or your repo
   export ADO_PR_ID=12345             # an existing draft PR id
   export ADO_PAT='<your-token>'
   ```

4. **Make sure `az` is logged in:**
   ```bash
   az login
   ```

5. **Run setup:**
   ```bash
   cd docs/superpowers/specs/samples/triggers/test
   bash setup-ado.sh        # or:  pwsh setup-ado.ps1
   ```
   This:
   - Verifies `az` and the `azure-devops` extension
   - Verifies the PR exists
   - Posts one test comment to the PR (`"Test comment from Conductor trigger harness at <ts>"`)
   - Writes `test-config.json` next to itself

   What gets created in real ADO: **one new comment thread on the specified PR** with one comment from your `az login` user. That's it.

## Run the tests

```bash
npm run test
# or:  npx tsx test-driver.ts
```

You should see (e.g.):

```
mock-conductor on http://127.0.0.1:54321
PR=microsoft/auth-svc #12345, test_comment_id=987654

[A] Cron-fire / poll path (TS) ... PASS
[B] External webhook path (TS) ... PASS
[C] Idempotency (TS) ... PASS
[D] Cron-fire / poll path (Python) ... PASS
[E] Malformed envelope (TS) ... PASS

=== Summary ===
  [A] PASS  Cron-fire / poll path (TS)
  [B] PASS  External webhook path (TS)
  [C] PASS  Idempotency (TS)
  [D] PASS  Cron-fire / poll path (Python)
  [E] PASS  Malformed envelope (TS)

5 scenario(s); 0 failure(s)
```

Subset:
```bash
npx tsx test-driver.ts --only A,C
npx tsx test-driver.ts --skip-py
npx tsx test-driver.ts --help
```

## What each scenario proves

| ID | Scenario | What it exercises | What gets created in ADO |
|----|----------|-------------------|--------------------------|
| **A** | Cron-fire / poll (TS) | Empty body POST → trigger sees `fired_by=cron` → real call to `https://dev.azure.com/<org>/.../pullRequests/<id>/threads` → finds the test comment → POSTs callback to `/callback/threads/<thr>/resume` | Nothing new (read-only ADO call) |
| **B** | External webhook (TS) | POST a synthetic ADO service-hook payload → trigger sees `fired_by=external` → uses inline payload (no ADO call) → POSTs callback | Nothing (synthetic payload, no ADO call) |
| **C** | Idempotency (TS) | Re-fire cron with `state.lastCommentId === test_comment_id` → trigger polls ADO but skips comments at or below cutoff → no duplicate callback | Nothing (read-only) |
| **D** | Cron-fire / poll (Python) | Same as A using `ado-comment-watcher.py` — proves the protocol is language-agnostic | Nothing (read-only) |
| **E** | Malformed envelope (TS) | (1) Raw text body → server returns 400 (pre-spawn JSON guard). (2) Envelope with no `state.prId/repo` → trigger writes `state.prId and state.repo must be set...` to stderr, exits 2 → server returns 5xx | Nothing |

## How to extend

### Add a new trigger script

Drop a new `.ts`/`.py`/`.sh` in the parent directory (`../`) that follows the same stdin/stdout/env-var protocol. In `test-driver.ts`, add a new `tsTrigger`/`pyTrigger`-style helper that points to it, then a new scenario function and append it to the `scenarios` array.

### Add a new scenario for an existing script

Add to the `scenarios` array in `test-driver.ts`:

```ts
{ id: 'F', name: 'Multi-comment fan-out', fn: scenarioF_multiComment }
```

Each scenario function receives the live `MockServerHandle` and the loaded `TestConfig`. Use:

- `handle.setTrigger({ id, command, state, callbackPath, ... })` to register the spawn target
- `await fireHook(handle, body)` to fire a webhook
- `await getCallbacks(handle)` / `await resetCallbacks(handle)` to assert
- Standard `node:assert/strict` (`ok`, `equal`, `deepStrictEqual`)

### Test a different callback URL shape

Change `callbackPath` on the trigger config:

```ts
handle.setTrigger({
  ...,
  callbackPath: '/callback/templates/pr-review/run',  // cold-trigger spawn
});
```

The mock-conductor's catch-all callback handler captures any `/callback/*` path, so the assertion logic just checks `cb.path` matches.

## Files

| Path | Role |
|------|------|
| `mock-conductor.ts` | The local HTTP server. Pure Node built-ins; no deps. Importable as a module or runnable as a CLI. |
| `setup-ado.sh` | Bash version of one-shot ADO fixture setup. Uses `az cli`. |
| `setup-ado.ps1` | PowerShell mirror of `setup-ado.sh`. |
| `test-driver.ts` | The actual test runner. |
| `test-config.json` | Generated by `setup-ado.sh`. Captures the real PR id + test comment id for the driver. **Not checked in.** |
| `tsconfig.json` | Type checking only (`tsx` runs files directly without compilation). |
| `package.json` | Scripts. Zero dependencies. |

## Cleanup

Each `setup-ado.sh` run posts one comment. There's no auto-cleanup — open the PR in the browser and delete or resolve the test threads when you're done:

```
https://dev.azure.com/<org>/_git/<repo>/pullrequest/<id>
```

## Troubleshooting

- **`tsx: command not found`** — install with `npm i -g tsx` or use `npx tsx`. The `test:` scripts use `npx tsx` indirectly.
- **`az: command not found`** — install Azure CLI (link in Prerequisites).
- **Scenario A/D fail with `ADO 401`** — the PAT is wrong or expired. Regenerate.
- **Scenario A/D fail with `ADO 404`** — `ADO_ORG` / `ADO_REPO` / `ADO_PR_ID` don't match a real resource. Re-check `test-config.json` against the live PR URL.
- **Scenario A/D fail with `state.lastCommentId is below test_comment_id`** — extremely unlikely; would mean someone deleted the comment between setup and test. Re-run `setup-ado.sh`.
- **Scenario C "info" message about extra callbacks** — someone posted a NEWER comment to the PR between `setup-ado.sh` and `npm run test`. Not a failure; the assertion is about not re-emitting comments at or below cutoff.

## Constraints honored

- **Real ADO.** No mock ADO. The trigger script's HTTP fetches go to `dev.azure.com`.
- **Mock only the Conductor side** — webhook receiver and callback recorder.
- **Zero external npm deps.** `node:http`, `node:child_process`, `node:crypto`, `node:fs`, etc. only.
- **Trigger scripts unmodified.** `ado-comment-watcher.ts` and `.py` are spawned as-is.
