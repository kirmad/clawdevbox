# @conductor/mcp-ado — LEGACY (reference only)

> **Superseded by hostable tools (spec §10.3).** The ADO plugin's primary tool surface now lives at `../tools/*.ts` — single-file scripts hosted in-process by the Conductor MCP server. This separate-process MCP server is kept as a reference implementation for plugin authors who need the heavyweight pattern: long-running indexers, stateful daemons, or foreign-language binaries that don't fit a single-file `ToolContext`-shaped function.
>
> See `../README.md` for the hostable-tools approach and `../tools/get_pr.ts` for an example of the equivalent code in single-file form.

MCP server that exposes Azure DevOps tools (`ado.*`) to Conductor recipes and any other MCP-aware agent host (Continue, Cursor, Claude Desktop, Claude Code).

This is the legacy server stub. It still works, but the plugin's `plugin.yaml` no longer declares `provides.mcp_servers[]` referencing it — `provides.tools[]` references the hostable equivalents under `../tools/` instead.

---

## Install

```bash
# From npm (production install, once published)
npm i -g @conductor/mcp-ado

# Local-dev (this sample) — no install needed: the plugin's mcp/ado.json runs
# `npx -y tsx ../../../mcp-server/src/index.ts` directly.
```

---

## Configure (Continue / Cursor / Conductor)

```jsonc
{
  "mcpServers": {
    "ado": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@conductor/mcp-ado"],
      "env": {
        "ADO_ORG":          "${env:ADO_ORG}",
        "ADO_PROJECT":      "${env:ADO_PROJECT}",
        "ADO_BEARER_TOKEN": "${env:ADO_BEARER_TOKEN}",
        "ADO_PAT":          "${env:ADO_PAT}"
      }
    }
  }
}
```

For the local-dev wiring used by the sample plugin, see `../mcp/ado.json` — same shape, different `command`/`args`.

---

## Env vars

| Var                 | Required | Notes                                                                                                                |
|---------------------|----------|----------------------------------------------------------------------------------------------------------------------|
| `ADO_ORG`           | per-call | Default ADO org. May be overridden in each tool call. May be a composite `"<org>/<urlencoded project>"`.            |
| `ADO_PROJECT`       | no       | Default ADO project. May be overridden per-call.                                                                     |
| `ADO_BEARER_TOKEN`  | one of   | AAD access token. Preferred. `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` mints one.|
| `ADO_PAT`           | one of   | Personal access token (basic auth). Legacy fallback when AAD isn't available.                                        |

At least one of `ADO_BEARER_TOKEN` or `ADO_PAT` must be set. Missing-auth errors surface at the **first tool call**, not at server start — recipes that load but never touch ADO won't fail.

---

## Tools

All tools live under the `ado.` namespace. Argument names are snake_case (mirroring the recipe samples).

### `ado.get_pr`

PR metadata.

**Input**
```jsonc
{
  "org": "string?",        // default ADO_ORG
  "project": "string?",    // default ADO_PROJECT
  "repo": "string",        // required (repo slug)
  "pr_id": 12345           // required
}
```

**Output (structuredContent)**
```jsonc
{
  "pullRequest": {
    "pullRequestId": 12345,
    "title": "...", "description": "...", "status": "active",
    "sourceRefName": "refs/heads/feat/x", "targetRefName": "refs/heads/main",
    "creationDate": "...", "closedDate": null,
    "isDraft": false, "mergeStatus": "succeeded",
    "createdBy": { "displayName": "...", "uniqueName": "...", "id": "..." },
    "repository": { "id": "...", "name": "...", "project": { "id": "...", "name": "..." } },
    "url": "https://..."
  }
}
```

### `ado.list_pr_comments`

User-authored comments (skips ADO `system` comment type). Sorted ascending by id.

**Input**
```jsonc
{ "org": "?", "project": "?", "repo": "string", "pr_id": 12345, "since_id": 0 }
```
`since_id` is optional — pass the last seen id to get only newer comments.

**Output**
```jsonc
{
  "comments": [
    { "id": 11, "threadId": 7, "content": "...", "commentType": "text",
      "author": { "displayName": "...", "uniqueName": "..." },
      "publishedDate": "...", "lastUpdatedDate": "..." }
  ],
  "count": 1
}
```

### `ado.comment_pr`

Post a comment. New top-level thread by default, or reply on an existing thread.

**Input**
```jsonc
{
  "org": "?", "project": "?", "repo": "string", "pr_id": 12345,
  "content": "Looks good — could you also add a test for the empty-list case?",
  "in_reply_to_thread_id": 7 // optional
}
```

**Output**
```jsonc
{ "commentId": 42, "threadId": 7 }
```

### `ado.list_iterations`

PR iterations (push snapshots), oldest → newest.

**Input**
```jsonc
{ "org": "?", "project": "?", "repo": "string", "pr_id": 12345 }
```

**Output**
```jsonc
{
  "iterations": [
    { "id": 1, "createdDate": "...", "description": null,
      "sourceRefCommit": "abc...", "targetRefCommit": "def...",
      "push": { "pushId": 99, "date": "..." } }
  ],
  "count": 1
}
```

### `ado.get_pr_status`

Derived status + vote roll-up.

**Input**
```jsonc
{ "org": "?", "project": "?", "repo": "string", "pr_id": 12345 }
```

**Output**
```jsonc
{
  "status": "active",
  "mergeStatus": "succeeded",
  "votes": [
    { "reviewerId": "...", "displayName": "...", "vote": 10,
      "voteLabel": "approved", "isRequired": true }
  ]
}
```

Vote labels: `approved` (10), `approved-with-suggestions` (5), `no-vote` (0), `waiting-for-author` (-5), `rejected` (-10), `unknown` (anything else).

---

## Manual test

Pipe a JSON-RPC `initialize` + `tools/list` request to the server's stdin and read the response from stdout. Anything on stderr is human-readable log noise (the `[mcp-ado] ready` banner, error stack traces).

```bash
# From this directory:
npm install
npx tsc --noEmit

# tools/list (no auth needed — just shape inspection):
( cat <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-test","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
EOF
sleep 0.5 ) | npx tsx src/index.ts
```

Tested manually against real ADO PR `o365exchange/SubstrateSearch#5180686` with `ADO_BEARER_TOKEN` minted via `az account get-access-token`. See the test driver output in the slice notes for the recorded round-trip.

---

## Errors

All tool errors return `{ isError: true, content: [{ type: 'text', text: '...' }] }` rather than throwing. The agent can read the message and decide whether to retry, ask the user, or abort.

- `AdoConfigError` (missing org / repo / auth / content) → `<tool>: config error — <msg>`
- `AdoHttpError` (non-2xx from ADO) → `<tool>: ADO HTTP <status> on <url>\n<body>`

The server itself never crashes on a tool error — only on protocol-level failures (which exit non-zero so the MCP host can restart it).
