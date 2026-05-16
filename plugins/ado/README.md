# Clawdevbox Plugin — Azure DevOps

Recipes, skills, triggers, and **hostable tools** for working with Azure DevOps pull requests in Clawdevbox. Reference implementation of the plugin model defined in [spec §10](../../2026-05-09-clawdevbox-simplified-design.md#10-plugins), including the hostable-tool contract from [§10.3](../../2026-05-09-clawdevbox-simplified-design.md#103-hostable-tools).

> **Tools are hostable lightweight scripts.** Each ADO operation (`ado.get_pr`, `ado.list_pr_comments`, ...) is a single TypeScript file under `tools/` that Clawdevbox's MCP server discovers, dynamic-imports at boot, and registers as an MCP tool — no separate MCP server process required. See `tools/get_pr.ts` for an example.

## What's in this plugin

```
plugin.yaml                          # manifest (spec §10.2)
README.md                            # this file
skills/
  analyze-pr-comment.md              # how to read a PR comment
  summarize-pr-changes.md            # how to summarize a PR diff
recipes/
  pr-review.yaml                     # parent recipe — full PR review flow
  respond-to-pr-comment.yaml         # sub-recipe — single-comment reply
triggers/
  ado-new-pr-watcher.ts              # cold trigger TYPE — Mode B, callback to pr-review
  ado-comment-watcher.ts             # hot trigger TYPE — Mode B, callback to thread_resume
  ado-pr-pulse-watcher.ts            # mixed-mode trigger TYPE — A+B, callback to thread_resume
tools/                               # hostable tools — spec §10.3
  _auth.ts                           # shared auth + fetch helper (not a tool)
  get_pr.ts                          # ado.get_pr
  list_pr_comments.ts                # ado.list_pr_comments
  comment_pr.ts                      # ado.comment_pr
  list_iterations.ts                 # ado.list_iterations
  get_pr_status.ts                   # ado.get_pr_status
_legacy-mcp-server/                  # reference: heavyweight separate-process MCP server
                                     # (kept as documentation; manifest no longer references it)
```

The `id` is `ado` — once installed, Clawdevbox exposes:

- `recipe.read({ id: 'pr-review' })` and `recipe.read({ id: 'respond-to-pr-comment' })`
- `skill.read({ id: 'analyze-pr-comment' })` and `skill.read({ id: 'summarize-pr-changes' })`
- Three trigger TYPES — `ado.new-pr-watcher`, `ado.comment-watcher`, `ado.pr-pulse-watcher` — visible via `trigger.list_types({ scope: 'plugin:ado' })`. None fire until an agent calls `trigger.register({ type_id, params })`.
- The five `ado.*` hostable tools registered on Clawdevbox's MCP server, ready to call from any agent client wired to Clawdevbox

All of the above resolve at `scope: 'plugin:ado'` by default.

## Hostable tool example

Each file in `tools/` exports four things — three named, one default:

```ts
// tools/get_pr.ts
import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import { adoFetch, API_VERSION, resolveScope, urlBase } from './_auth.ts';

export const id = 'ado.get_pr';
export const description = 'Get pull-request metadata for a single PR id.';
export const parameters = z.object({
  org:     z.string().optional(),
  project: z.string().optional(),
  repo:    z.string(),
  pr_id:   z.number().int().positive(),
});

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
) {
  const resolved = resolveScope(ctx, args);
  const url = `${urlBase(resolved)}/_apis/git/repositories/${args.repo}/pullRequests/${args.pr_id}?api-version=${API_VERSION}`;
  const raw = await adoFetch(ctx, url);
  return { pullRequest: raw };
}
```

`ctx` is a `ToolContext` with `env`, `workspace`, `fetch`, `logger`, `signal`. Clawdevbox catches thrown errors and surfaces them as MCP tool errors with a structured `{ code, message }`. See `_auth.ts` for the helpers shared across the five tool files.

## Why hostable, not a separate MCP server?

Compared to declaring `provides.mcp_servers[]` (which spawns a child process per server):

- **One process** instead of N — the Clawdevbox MCP server hosts every plugin's tools in-process.
- **No `npx` cold-start** per server.
- **Shared cache / fetch agent** across calls.
- **Single-file authoring** — you don't write a server harness, just a function.
- **Lower attack surface** — no extra ports, no extra subprocess management.

When the work doesn't fit a single function (long-running indexer, stateful daemon, binary in another language), declare an `mcp_servers[]` entry instead. Both can coexist on the same plugin. `_legacy-mcp-server/` keeps the previous separate-process implementation as a reference for that pattern.

## Install

Three options.

### 1. From git (the supported MVP path)

```ts
plugin.install({ from: 'git+https://github.com/clawdevbox/plugin-ado.git' })
```

Optional ref pin (recommended for production):

```ts
plugin.install({
  from: 'git+https://github.com/clawdevbox/plugin-ado.git',
  ref:  'v1.0.0',
})
```

Clawdevbox clones into `.clawdevbox/plugins/ado/`, validates the manifest,
and reloads.

### 2. As a git submodule

For workspaces that want the plugin's contents tracked in their own repo:

```bash
git submodule add https://github.com/clawdevbox/plugin-ado.git .clawdevbox/plugins/ado
```

Clawdevbox's file watcher notices the new `plugin.yaml` and loads it. No
extra command needed.

### 3. Local development path

While iterating on the plugin itself, install from an absolute local
path. Clawdevbox copies (does not symlink) the directory:

```ts
plugin.install({ from: 'C:\\src\\clawdevbox-plugin-ado' })
```

Reinstall after each iteration, or just edit the files in
`.clawdevbox/plugins/ado/` directly — the watcher reloads on save.

## Required environment

The trigger scripts and the `@clawdevbox/mcp-ado` MCP server (referenced
by `mcp/ado.json`) require:

| Env var | Purpose |
|---|---|
| `ADO_ORG` | Azure DevOps organization slug, e.g. `msasg` |
| `ADO_BEARER_TOKEN` | AAD access token (preferred). Locally: `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv`. |
| `ADO_PAT` | Personal access token (fallback for environments without AAD) |

The plugin loads even when these are unset — but any tool call that
hits ADO will fail clearly with a missing-env-var error.

## Customize

This plugin's directory is **read-only** at runtime. To change a recipe,
skill, or trigger, copy it to project scope and edit there.

### Customize a recipe

```ts
// 1. Read the plugin's version
const original = await mcp.call('recipe.read', { id: 'pr-review' });
// original.scope === 'plugin:ado'

// 2. Edit the YAML body to add an accessibility step
const updated = original.source
  .replace('# steps:\n', '# steps:\n  # NEW: accessibility check\n')
  ...

// 3. Upsert at project scope
await mcp.call('recipe.upsert', {
  id:     'pr-review',
  scope:  'project',
  source: updated,
});

// 4. Verify shadowing
const now = await mcp.call('recipe.read', { id: 'pr-review' });
// now.scope === 'project'  — plugin version is dormant
```

The plugin's `pr-review.yaml` is untouched on disk. `plugin.update({
id: 'ado' })` is safe — your project copy keeps winning.

To revert:

```ts
await mcp.call('recipe.delete', { id: 'pr-review', scope: 'project' });
// plugin version reactivates automatically
```

### Customize a skill

Same pattern with `skill.upsert` and `skill.delete`.

### Customize a trigger type or registration

Triggers split into TYPES (shipped by this plugin) and REGISTERED instances
(persisted by Clawdevbox in `.clawdevbox/triggers.json` after the agent calls
`trigger.register`):

1. **Change a registered instance's params or cron:**
   `trigger.update_params({ id: 'ado.new-pr-watcher#auth-svc', cron: '*/2 * * * *' })`.
   Or `trigger.unregister({ id })` followed by a fresh `trigger.register`.
2. **Customize the TYPE itself (script body, defaults, param schema):**
   Copy `triggers/ado-new-pr-watcher.ts` to `.clawdevbox/triggers/ado-new-pr-watcher.ts`
   in project scope and edit there. The plugin's version stays untouched.
3. **Disable a TYPE entirely:** disable the whole plugin via
   `plugin.disable({ id: 'ado' })`; the plugin's `provides.trigger_types[]`
   stop appearing in `trigger.list_types`. Re-enable to restore.

## Update

```ts
plugin.update({ id: 'ado' })
```

If installed from git, this runs `git pull` (or `git checkout <ref>`).
Clawdevbox re-validates the manifest and reloads. Project-scope
overrides survive untouched.

## Uninstall

```ts
plugin.uninstall({ id: 'ado' })
```

Removes `.clawdevbox/plugins/ado/`. Project-scope copies survive — they
just stop having the `ado` MCP server available, so any recipe that
references `mcp_servers: [ado]` fails clearly at run time.

## See also

- Spec [§10 Plugins](../../2026-05-09-clawdevbox-simplified-design.md#10-plugins) — the design contract this plugin implements.
- Spec [§7 Templates](../../2026-05-09-clawdevbox-simplified-design.md#7-templates--taskdock-style-starting-points) — the recipe (template) schema.
- Spec [§8 Triggers](../../2026-05-09-clawdevbox-simplified-design.md#8-triggers--http-webhook-handlers) — the trigger protocol the scripts implement.
- `samples/triggers/README.md` — original trigger samples; this plugin's `triggers/*.ts` are copies of those for self-containment.
