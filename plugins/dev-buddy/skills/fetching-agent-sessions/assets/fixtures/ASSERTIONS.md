# TDD Assertions for `fetching-agent-sessions`

A correct normalization of either raw fixture (copilot or claude) MUST produce a JSON object meeting all these assertions:

## Required top-level fields (all 8)
- `id` — string, non-empty, matches the source session id (e.g. `"sess-001-copilot"` or `"sess-001-claude"`)
- `provider` — string in `{"copilot-cli","claude-code","agency-cli"}` matching the source
- `cwd` — string `"C:\\git\\example-app"` (escaped backslashes preserved)
- `started_at` — string ISO-8601 `"2026-05-30T14:00:00.000Z"`
- `ended_at` — string ISO-8601 `"2026-05-30T14:05:00.000Z"` (last turn time)
- `summary` — string `"Add status badge to README"` (copilot only; claude has no summary field → null is acceptable for claude)
- `turns` — array of 4 turn objects
- `files_touched` — array containing `{"path":"README.md","op":"edit"}`

## Required per-turn fields
Each turn object MUST have: `index` (0-based int), `role` (one of `user|assistant|tool`), `text` (string), `tool_name` (string|null), `tool_success` (bool|null), `ts` (ISO string).

## Required turn ordering (copilot)
1. `index=0 role=user text="Add a status badge to the README" ts=14:00:00`
2. `index=1 role=tool tool_name=view tool_success=true ts=14:00:30`
3. `index=2 role=tool tool_name=edit tool_success=true ts=14:02:00`
4. `index=3 role=assistant text="Added status badge to README.md" ts=14:05:00`

## Required turn ordering (claude)
Same role/tool sequence as copilot. tool_success may be `true` (inferred from tool_result.is_error=false) or `null` (acceptable if adapter doesn't merge tool_result into tool turn).

## Fail conditions (these mean the test is RED)
- Output is not valid JSON
- Missing any top-level field
- `turns` array length != 4
- `turns[1].tool_name` or `turns[2].tool_name` missing or wrong
- `files_touched` empty or missing the README.md entry
- Different shapes between the two providers (must normalize to same schema)
