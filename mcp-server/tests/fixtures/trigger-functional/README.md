# trigger-functional pre-fix fixtures

This file is a **stable, checked-in capture of the historical PRE-FIX source**
for the local recipe-cron trigger script. It exists so the functional
negative control in

- `mcp-server/tests/local-trigger-functional.test.mjs`

stays **RED independent of the repository HEAD**. Previously the control read a
`.worktrees/...` path (recipe-cron) to obtain the "old" behavior. Once the
production fix is committed, `HEAD` becomes the *fixed* source and the control
silently turns GREEN — no longer proving anything. Committing the exact pre-fix
bytes here removes that dependency: the control reproduces the old failure
forever.

The fixture contains exactly the historical script bytes and is executed
through the **same** `runTriggerScript` / spawn harness as the current script,
from an isolated temp sandbox (with its own `package.json`) so no `package.json`
is ever written beside a real source tree.

| Fixture | Captured from (pre-fix) | Reproduces (RED) |
|---|---|---|
| `local-recipe-cron.prefix.ts` | `~/.clawdevbox/trigger-types/local.recipe-cron/trigger.ts` original (saved `trigger.original.ts`) | empty `spawn_url` → blockingError exit 2, no observation |

The test asserts the fixture still **differs** from the current (fixed)
production script (sha256 inequality), which is what proves the control is not
accidentally re-derived from a now-fixed HEAD.
