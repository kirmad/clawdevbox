# Provider: Claude Code

Claude Code stores session transcripts as JSONL files under `~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl`.

## 1. Discover

Present if:
- `~/.claude/projects/` exists, AND
- At least one subdirectory contains at least one `*.jsonl` file.

If `~/.claude/projects/` exists but is empty, return `present=false` (no data to fetch).

## 2. Enumerate

The path layout is:

```
~/.claude/projects/<slug>/<session-uuid>.jsonl
~/.claude/projects/<slug>/<session-uuid>/subagents/agent-<id>.jsonl     # sub-sessions
```

The `<slug>` is the cwd path with separators replaced by `-` (e.g., `C--git-clawdevbox`).

For window `[from, to)`:

1. Glob `~/.claude/projects/**/*.jsonl` (PowerShell: `Get-ChildItem -Path "$env:USERPROFILE\.claude\projects" -Recurse -File -Include "*.jsonl"`).
2. Filter to files where `LastWriteTime` is in `[from, to)`.
3. Return objects of the form `{ id: <sessionId from first line>, path: <file path>, mtime: <last write> }`.

**Sub-sessions (sidechain agents)** are also `.jsonl` files but under `<session-uuid>/subagents/`. They have `isSidechain: true` in every line. Choose:
- Include sidechains for completeness, OR
- Skip them (sidechains are usually short specialized tasks).
- For v1, **skip sidechains** (filter by `isSidechain != true` in the first line) to keep results focused on top-level user sessions.

Session id = the `sessionId` field on the first line of the file (the file name UUID may differ from the sessionId for sidechains).

## 3. Normalize

Walk the JSONL file line-by-line. Each line is a JSON object with at least: `type` (`user`|`assistant`), `message`, `uuid`, `timestamp`, `cwd`, `sessionId`.

### Build the session header

From the first line:
- `id` ← `sessionId`
- `provider` ← `"claude-code"`
- `cwd` ← `cwd`
- `started_at` ← `timestamp`
- `summary` ← `null` (Claude does not produce server-side summaries)

From the last line:
- `ended_at` ← `timestamp`

### Build the turns array

Walk lines in order; maintain `index = 0` and a `pending_tool_uses` map keyed by tool_use id.

For each line:

**Case A — line is `type:"user"` with `message.content` as a string:**
Emit one turn: `{index, role:"user", text:<content>, tool_name:null, tool_success:null, ts:<timestamp>}`. Increment index.

**Case B — line is `type:"user"` with `message.content` as an array containing `tool_result` items:**
For each `tool_result` part, look up `tool_use_id` in `pending_tool_uses`. Replace the pending tool turn's `tool_success` with `!is_error` and append the result content to the tool turn's `text`. Do NOT emit a separate user turn for tool_result wrappers.

**Case C — line is `type:"assistant"` with `message.content` as an array:**
Walk the array. For each part:
- `{type:"text", text:...}` → emit one assistant turn: `{index, role:"assistant", text, tool_name:null, tool_success:null, ts:<timestamp>}`. Increment index.
- `{type:"tool_use", id, name, input}` → emit one tool turn: `{index, role:"tool", text:"<name> <abbreviated input>", tool_name:<name>, tool_success:null, ts:<timestamp>}`. Increment index. **Record** `pending_tool_uses[id] = <ref to this turn object>` so Case B can patch it.

**Abbreviated input** in tool turn `text`: if `input.path` or `input.file_path` exists, use `"<name> <path>"`; else use `"<name>"` alone. Keep it ≤ 80 chars.

### Build files_touched

Scan all `tool_use` parts. For each whose `name` is in:
- `{"edit","str_replace","multiedit","Edit","MultiEdit"}` → `op: "edit"`
- `{"write","create","Create","Write"}` → `op: "create"`
- `{"view","read","Read"}` → `op: "read"`
- Other → skip.

Path = `input.path` or `input.file_path`. Dedupe by `(path, op)`.

## 4. Deep-fetch

Read the entire JSONL file. Return parsed lines as an array. The caller can inspect full `message.content`, model names from `message.model`, token usage from `message.usage`, etc.

For sub-session inspection, also glob `<session-dir>/subagents/*.jsonl` and return each as a separate sub-session array.

## Known limitations

- `summary` is always null (Claude Code stores no server-side summary).
- Sub-sessions (sidechains) are skipped by default in v1 enumeration.
- Tool turn `text` uses an abbreviated input; full args available via Deep-fetch.
- Multi-part assistant messages produce multiple turns (one per part); ordering preserved.
