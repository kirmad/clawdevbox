# Provider Contract

A **provider** is one document in this directory describing how to fetch sessions from one agent CLI. The skill reads the provider doc and follows its steps — there is no code interface.

Every provider doc MUST answer these four questions, in this order, with concrete commands an agent can execute:

## 1. Discover

How to tell whether this client is installed and has any session data on this machine.

- Output: a single boolean — present or absent.
- Side-effects: none.
- Example: "Check if `~/.claude/projects/` exists AND contains at least one subdirectory with at least one `*.jsonl` file."

If Discover returns `false`, the skill skips this provider for the run.

## 2. Enumerate

How to list session ids in a given time window `[from, to)`.

- Input: ISO-8601 `from` and `to` timestamps.
- Output: an array of session id strings sorted newest-first.
- Example: a SQL query, a glob + mtime filter, an API call.

Lightweight only — don't read full bodies here. Metadata is fine.

## 3. Normalize

How to convert one raw session into the normalized model (see `../normalized-model.md`).

- Input: a session id (or the raw payload, depending on what Enumerate returned).
- Output: a single object matching the normalized model exactly.
- Side-effects: read-only.

**Field-by-field mapping rules are required.** Don't leave any field as "figure it out" — the agent will guess and the output will drift (this was observed in the baseline RED test).

## 4. Deep-fetch

How to re-fetch full message bodies for a session id when downstream callers need more than normalization preserves.

- Input: session id.
- Output: provider-specific richer payload (no normalization required).
- Use case: a gap-analysis skill wants the full assistant prose of one suspicious session.

## Adding a new provider

1. Copy `copilot-cli.md` as a starting skeleton.
2. Answer the four questions for your client.
3. Add a fixture pair: `assets/fixtures/<provider>-raw.<ext>` + the assertion that normalizing it produces output deep-equal to `session-normalized.json` (modulo provider-specific data values).
4. Add the new enum value to `provider` in `normalized-model.md`.
5. Re-run the GREEN test for this skill plus every downstream skill that depends on the model.
6. Append a one-line entry to the "Currently shipped" list in `SKILL.md`.

## Why no code interface

The skill is invoked by an LLM agent, not a script. A markdown contract is the natural API: the agent reads it and follows it. If you find yourself wanting a TypeScript/Python interface, that's a signal you should be building an MCP tool instead — file an issue.
