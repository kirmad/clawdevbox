# Provider: Agency CLI

Agency CLI is a wrapper around Copilot CLI. **Sessions started under Agency are written to the same DuckDB cloud store as plain Copilot sessions.** In v1 there is no reliable signal in the store distinguishing the two — both appear with `sessions.agent_name = "Copilot CLI"`.

## 1. Discover

Present if `~/.agency/` exists AND `~/.agency/firstrun_completed` is present (indicates Agency has been initialized on this machine).

If absent, return `present=false` and skip this provider for the run.

## 2. Enumerate

**Delegate to `copilot-cli.md`.** Agency sessions are in the Copilot store.

Currently there is no way to filter Copilot-store rows down to "only Agency-launched sessions." Options:
- Return zero sessions in v1 (avoid double-counting with the Copilot provider).
- Return the same rows the Copilot provider returns, tagged as `agency-cli`.

**v1 default: return zero sessions.** Rationale: the Copilot provider already returns every session in the store. Returning the same rows again under `agency-cli` would double-count downstream analyses.

This means: in v1, Agency-launched sessions are surfaced through the Copilot provider as `provider: "copilot-cli"`. This is honest about what the store can tell us.

## 3. Normalize

Not reached in v1 (Enumerate returns zero). When a discrimination signal becomes available (see below), delegate normalization to `copilot-cli.md` but set `provider: "agency-cli"`.

## 4. Deep-fetch

Delegate to `copilot-cli.md` once a discrimination signal exists.

## Future: distinguishing Agency from Copilot

When the Agency runtime starts tagging its sessions, update Enumerate. Candidate signals (check whichever the runtime adopts):

1. **`sessions.agent_name`** value changes to `"Agency CLI"` — easiest; update Enumerate to filter on this.
2. **A custom event type** in `events.type` like `agency.session_started` — query for sessions that have this event.
3. **A path marker** in `cwd` (e.g., `cwd LIKE '%agency%'`) — fragile, avoid unless documented.
4. **A row in `sessions` with `agent_description = "Agency wrapper"`** — second-easiest; filter on that.

When any of (1)–(4) become real, update Enumerate to filter accordingly, set Normalize to set `provider: "agency-cli"`, and add a `fixture-agency-raw.json` adapter test.

## Why ship this provider at all in v1?

Two reasons:
- **Extensibility example.** Demonstrates how a new provider declares "I'm not active yet" without breaking the contract.
- **Forward-looking placeholder.** When the Agency runtime ships discrimination, the provider doc is already in place — only the Discover/Enumerate steps need to flip.
