# Non-Interactive Launcher Flags - Design

**Date:** 2026-07-12
**Status:** Approved, ready for implementation plan

## Goal

Ensure every clawdevbox-managed Copilot or Agency launch passes
`--no-ask-user` immediately before `--yolo`.

## Scope

Two launcher implementations are affected:

- `mcp-server/src/agent-clis/copilot.ts` in clawdevbox.
- `agency-provider.mjs` in `C:\git\agency-provider`.

No other CLI providers or manually maintained smoke scripts are part of this
change.

## Design

### Copilot provider

Keep the existing argument construction and insert `--no-ask-user` directly
before the existing `--yolo`. The pair remains enabled for interactive,
interactive-with-seed, headless, new, and resumed sessions.

The existing provider argument matrix test will assert:

- `--no-ask-user` is present exactly once.
- `--yolo` is present exactly once.
- `--no-ask-user` immediately precedes `--yolo`.

### Agency provider

The provider currently appends `--yolo` twice. Remove both existing pushes and
append one final permission pair:

```text
--no-ask-user --yolo
```

Keeping the pair at the end preserves the provider's existing intent that its
full-permission flags override any earlier permission-narrowing arguments.
The fixture will capture the spawned argv and assert uniqueness and adjacency.

The README spawn example will be updated to document the new pair.

## Error Handling

No new runtime branches or fallbacks are needed. Argument construction remains
deterministic, and launcher failures continue to surface through the existing
PTY/session error paths.

## Validation

- Run the targeted clawdevbox agent-CLI provider test.
- Run the agency-provider fixture through its package test command.
- Inspect the final diffs in both repositories to confirm no unrelated dirty
  files were modified.

## Non-goals

- Sharing argument-building code across repositories.
- Changing trust-workspace behavior.
- Changing MCP, model, agent, prompt, resume, or plugin arguments.
- Updating historical plans or smoke scripts that are not used by the active
  launch providers.
