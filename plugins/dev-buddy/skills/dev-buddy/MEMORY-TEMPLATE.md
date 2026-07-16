# <PROJECT NAME> — dev-buddy memory

> This file is your durable, per-project memory. It lives at
> `<workspace>/.clawdevbox/memory.md` and gets re-read at the start of
> every conversation. Edit anything here, delete anything here. The
> agent will pick up changes on its next turn.
>
> The headings below are templates. Drop ones that don't apply. Add
> ones that do.

## Project

- **What it is:** <1–2 lines about the project>
- **Repo:** <git URL>
- **Working directory:** <path>
- **Primary language(s):** <list>
- **Build / test / lint commands:** `<the actual commands the user uses>`

## User

- **How to address them:** <name or handle>
- **Time zone:** <IANA tz, e.g. `America/Los_Angeles`>
- **Working hours:** <e.g. 9–17 weekdays>
- **Communication style preferences:** <e.g. terse, no emoji, code-first>

## Stack & conventions

- **Runtime versions:** <node 20, python 3.11, etc.>
- **Package manager:** <npm | pnpm | uv | poetry | …>
- **Test framework:** <jest | vitest | pytest | …>
- **Linter / formatter:** <eslint+prettier, ruff, …>
- **CI:** <where the pipeline lives>
- **Branch naming convention:** <e.g. `feat/short-desc`, `fix/short-desc`>
- **Commit style:** <conventional commits? trailers? sign-off?>

## Permissions

> Track Tier-2 answers here (per `STANDING_ORDERS.md`). When the user
> says "yes, that's fine going forward," append the rule here so you
> don't have to ask again next session.

- (empty)

### Session permissions (expires at session end)

> Tier-3 → Tier-2 promotions valid only for the current conversation.
> Clear at session end.

- (empty)

## Ongoing threads

> Active work that spans multiple sessions. Drop a 1–2 line entry per
> thread with the last known status. Delete when resolved.

- (empty)

## Architecture & gotchas

> Non-obvious things about the code that bit you (or the previous
> session) and would bite the next session too. The kind of thing you
> wish you'd known at the start.

- (empty)

## People & accounts

> Aliases, oncall rotations, team names you'll need to look up.
> Useful when filing incidents or transferring work.

- (empty)

## Tools & infra (project-specific)

> LogSearch clusters, MDM accounts, dashboards, ADO project names, etc. —
> the stuff you don't want to re-discover on every incident.

- (empty)

## Decisions log

> Architectural decisions made in conversation. Date + 1-line summary.
> When a decision gets revisited, append the new outcome rather than
> editing the old line.

- (empty)
