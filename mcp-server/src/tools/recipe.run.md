# recipe.run

Spawn a fresh agent CLI session running a recipe in a workspace.

Two ways to specify the recipe:
- **`id`** — load an already-saved recipe via the scope chain (project→plugin→global)
- **`source`** — pass the recipe YAML inline for an ad-hoc run without persisting it

Exactly one of `id` or `source` is required.

## Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | no* | Recipe id to load from the scope chain. Mutually exclusive with `source`. |
| source | string | no* | Inline recipe YAML for an ad-hoc run (not persisted). Must include valid `id`, `name`, and `description` fields. Mutually exclusive with `id`. |
| prompt | string | **yes** | The first user message handed to the spawned agent. |
| params | object | no | Parameter overrides recorded on the instance (key-value map). |
| workspace_id | string | no | Existing workspace id to run in. If omitted, a new workspace is created with `inherit_plugins: true`. |
| attach_to_inbox_item_id | string | no | Inbox item to associate the recipe instance with. |
| agent_cli | string | no | Agent-CLI provider to spawn (must be a registered provider id). Defaults to `config.default_agent_cli` or `"copilot"`. |
| agent | string | no | Agent persona name, maps to `--agent <name>`. Falls back to the recipe YAML's `agent:` field if omitted. |
| session_id | string | no | Explicit CLI session id. Recommended — lets the UI offer a "Resume" action later. Auto-minted if omitted. |
| resume_of | string | no | Recipe-instance id to resume. Spawns the CLI with `--resume` and records the new instance as a continuation. |

\* Exactly one of `id` or `source` must be provided.

## Examples

Run a saved recipe:
```json
{
  "tool": "recipe.run",
  "args": {
    "id": "deploy-staging",
    "prompt": "Deploy the current branch to staging"
  }
}
```

Run with workspace context:
```json
{
  "tool": "recipe.run",
  "args": {
    "id": "code-review",
    "prompt": "Review the latest PR changes",
    "workspace_id": "ws-abc123"
  }
}
```

Ad-hoc recipe with inline YAML:
```json
{
  "tool": "recipe.run",
  "args": {
    "source": "id: quick-fix\nname: Quick Fix\ndescription: Apply a quick fix\nsteps:\n  - run: echo done",
    "prompt": "Fix the lint errors in src/",
    "params": { "target_dir": "src/" }
  }
}
```

Resume a previous recipe instance:
```json
{
  "tool": "recipe.run",
  "args": {
    "id": "deploy-staging",
    "prompt": "Continue where we left off",
    "resume_of": "inst-previous-id",
    "session_id": "session-new-id"
  }
}
```

## Response

On success, returns a structured response with:
- `recipe_instance_id` — Unique instance identifier
- `recipe_id` — The recipe's id
- `adhoc` — Whether this was an ad-hoc (inline source) run
- `workspace_id` — Workspace the agent is running in
- `workspace_path` — Filesystem path of the workspace
- `pid` — OS process id of the spawned agent CLI
- `agent_cli` — Which CLI provider was used
- `session_id` — CLI session id (for resume)
- `resume_of` — Instance id being resumed (if applicable)
- `status` — Initial instance status
- `log_path` — Path to the agent's log file
- `view_url` — URL to view the running session (if available)

## Recipe Instance Lifecycle

1. **`recipe.run`** — creates a recipe-instance row, writes `.mcp.json` config, and spawns the agent CLI. Returns immediately.
2. The spawned agent executes the recipe steps autonomously.
3. **`recipe.done`** — called by the spawned agent to signal completion. Finalizes the instance status.

## Error Cases

| Error Code | Cause |
|-----------|-------|
| `INVALID_REQUEST` | Both `id` and `source` provided, or neither provided |
| `INVALID_ID` | The `id` failed validation |
| `NOT_FOUND` | Recipe `id` not found in any scope |
| `VALIDATION_ERROR` | Inline `source` YAML failed schema validation |
| `UNKNOWN_AGENT_CLI` | The `agent_cli` provider is not registered |
| `WORKSPACE_NOT_FOUND` | Specified `workspace_id` does not exist |
| `WORKSPACE_CREATE_FAILED` | Auto-creation of a new workspace failed |

## Notes

- The spawned agent runs in a **detached process** — `recipe.run` returns immediately without waiting for completion.
- Use `recipe.instance.status` to poll for progress after spawning.
- The `echo-stub` agent_cli is a no-op spawn for tests.
- If the recipe YAML declares a `default_client` that is not registered, the run fails with `UNKNOWN_AGENT_CLI`.
