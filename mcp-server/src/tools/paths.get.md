# paths.get

Returns resolved installation paths for the current Clawdevbox installation.

## Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| workspace_id | string | no | Workspace ID override (uses caller context if omitted) |

## Examples

Get all resolved paths:
```json
{ "tool": "paths.get", "args": {} }
```

## Response

Returns a JSON object with:
- `global_dir` — Global Clawdevbox directory (e.g., `~/.clawdevbox`)
- `project_dir` — Current project's `.clawdevbox` directory
- `workspaces_root` — Directory containing all workspace folders
- `vaults` — Array of vault entries (ordered leaf→root) with:
  - `id` — Vault identifier
  - `path` — Filesystem path
  - `kind` — "personal" or "team"
  - `remote` — Git remote URL or null
  - `title` — Optional display name

## Notes

- Use this tool to discover vault locations before reading/writing skills, agents, or memory.
- The vault chain determines skill/recipe resolution order.
