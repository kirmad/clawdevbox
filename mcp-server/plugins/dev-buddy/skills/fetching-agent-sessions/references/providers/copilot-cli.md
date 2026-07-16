# Provider: Copilot CLI

GitHub Copilot CLI stores sessions in a DuckDB-backed cloud store accessible via the `session_store_sql` MCP tool.

## 1. Discover

The provider is present if BOTH:
- The MCP tool `session_store_sql` is exposed to the current agent (check tool list).
- A trivial probe query returns without error:
  ```sql
  SELECT 1 FROM sessions WHERE created_at > now() - INTERVAL '1 day' LIMIT 1
  ```

If either check fails, return `present=false`.

## 2. Enumerate

For window `[from, to)`:

```sql
SELECT id, cwd, summary, created_at, updated_at
FROM sessions
WHERE created_at >= TIMESTAMP '<from>'
  AND created_at <  TIMESTAMP '<to>'
ORDER BY created_at DESC
```

Use ISO timestamps cast to TIMESTAMP. Return the rows; `id` is the session id.

**Performance:** the `sessions` table is small (< 10k rows typical). No need to LIMIT.

## 3. Normalize

For each session id, run **three queries** and merge:

### Query A — session header
```sql
SELECT id, cwd, summary, created_at, updated_at
FROM sessions WHERE id = '<id>'
```

Mapping to normalized:
- `id` ← row.id
- `provider` ← `"copilot-cli"`
- `cwd` ← row.cwd (or null)
- `started_at` ← row.created_at as ISO-8601 with `Z`
- `ended_at` ← row.updated_at as ISO-8601 with `Z`
- `summary` ← row.summary (or null)

### Query B — turn-equivalents from events
```sql
SELECT timestamp, type, user_content, assistant_content,
       tool_start_name, tool_complete_success, tool_complete_result_content
FROM events
WHERE session_id = '<id>'
  AND type IN ('user.message','assistant.message','tool.execution_complete')
ORDER BY timestamp ASC
```

Mapping rules — emit one normalized turn per row:

| `events.type` | normalized `role` | `text` | `tool_name` | `tool_success` |
|---|---|---|---|---|
| `user.message` | `user` | `user_content` | null | null |
| `assistant.message` | `assistant` | `assistant_content` | null | null |
| `tool.execution_complete` | `tool` | `"<tool_start_name>"` (or first 80 chars of `tool_complete_result_content` if you want richer text) | `tool_start_name` | `tool_complete_success` |

`index` is the row's position in this ordered list (0-based). `ts` is `timestamp` as ISO-8601.

**Why events, not turns?** The `turns` table fuses user+assistant into one row and hides intervening tool calls. Events are higher-fidelity for our purposes.

### Query C — files
```sql
SELECT DISTINCT file_path, tool_name
FROM session_files WHERE session_id = '<id>'
```

Mapping:
- `path` ← file_path
- `op` ← `edit` for `tool_name IN ('edit','multiedit','str_replace')`, `create` for `tool_name = 'create'`, `read` for `tool_name IN ('view','read')`, otherwise omit the row.

Multiple rows with the same `(path, op)` collapse to one entry.

## 4. Deep-fetch

For richer per-session data (e.g., full assistant prose, tool inputs):

```sql
-- Full event bodies
SELECT timestamp, type, user_content, assistant_content,
       tool_start_name, tool_complete_call_id, tool_complete_result_content,
       usage_model, usage_input_tokens, usage_output_tokens
FROM events WHERE session_id = '<id>' ORDER BY timestamp;

-- Tool argument JSON (separate table)
SELECT tool_call_id, name, arguments_json
FROM tool_requests WHERE session_id = '<id>';
```

Return raw rows; do not normalize.

## Known limitations

- Tool **input arguments** are in `tool_requests` not `events`. The normalize step intentionally omits them (the model has no field for them). Use Deep-fetch when needed.
- The `repository` column is sometimes null even when `cwd` is a git repo — don't rely on it.
- Sessions with weird/short summaries (e.g., random REGUI-style codes) are usually automated test sessions; consider filtering by summary heuristics at the caller.
