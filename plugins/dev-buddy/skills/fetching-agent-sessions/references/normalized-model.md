# Normalized Session Model

The single source of truth for the JSON shape every provider returns.

## Top-level object

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Provider-unique session id. Use the raw id from the source store verbatim. |
| `provider` | enum string | yes | One of: `copilot-cli`, `claude-code`, `agency-cli`. No other values allowed. |
| `cwd` | string \| null | yes | Working directory at session start. `null` only if the source truly has no cwd field. |
| `started_at` | ISO-8601 string | yes | UTC, millisecond precision, trailing `Z`. Example: `"2026-05-30T14:00:00.000Z"`. |
| `ended_at` | ISO-8601 string \| null | yes | Timestamp of last event/turn. `null` only for sessions that haven't ended (rare). |
| `summary` | string \| null | yes | Short topic summary if the source provides one; `null` otherwise. |
| `turns` | array of Turn | yes | Chronological log of session events (see below). |
| `files_touched` | array of FileTouched | yes | Files written to during the session. Empty array if none. |

**No other top-level fields are allowed.** If a provider has additional data, it stays in the source store; callers re-fetch via the provider's Deep-fetch step.

## Turn object

| Field | Type | Required | Description |
|---|---|---|---|
| `index` | int | yes | 0-based monotonically increasing within the session. |
| `role` | enum string | yes | One of: `user`, `assistant`, `tool`. |
| `text` | string | yes | Human-readable content. For `role:"tool"`, a one-line description like `"view README.md"`. Empty string `""` is allowed; `null` is not. |
| `tool_name` | string \| null | yes | Populated when `role == "tool"`; `null` for user/assistant turns. |
| `tool_success` | bool \| null | yes | Populated when `role == "tool"` and success status is known; `null` otherwise. |
| `ts` | ISO-8601 string | yes | UTC millisecond timestamp of this turn. |

**Tool calls = one `role:"tool"` turn per call.** Do not split into separate "tool_use" and "tool_result" entries. Do not nest tool data under a `tool` sub-object — fields are flat.

## FileTouched object

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | File path as recorded by the source (project-relative or absolute, whatever the source provides). |
| `op` | enum string | yes | One of: `edit`, `create`, `read`. |

**No `count`, `first_seen_at`, `tool`, or other extras.** A file edited 5 times → one entry with `op: "edit"`. If the same file was both read AND edited, emit two entries (one per op).

## Enums (closed sets)

- `provider`: `copilot-cli` | `claude-code` | `agency-cli`
- `role`: `user` | `assistant` | `tool`
- `op`: `edit` | `create` | `read`

If a provider has an operation that doesn't fit (e.g., `delete`, `move`), omit the entry from `files_touched` for v1 and document the gap. Do NOT extend the enum without a coordinated spec change.

## Null vs missing

Every documented field is **required in output**, even when null. An output that omits `summary` (because it was null) is non-conformant. Write `"summary": null` explicitly.

## Canonical example

See the SKILL.md "Canonical Example" section. That object is the full shape.

## Versioning

This is v1 of the model. Breaking changes require:
1. Bumping all provider adapters in lock-step.
2. Updating fixtures and ASSERTIONS.md.
3. Re-running the GREEN test for both this skill and any downstream skill (e.g., `running-session-retros`).
