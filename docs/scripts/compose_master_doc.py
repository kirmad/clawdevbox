"""
Compose docs/tools/*.md into docs/MCP-TOOLS-REFERENCE.md.

For each source doc:
  - Strip its leading H1 (the `# <family>.* MCP tools` line) and any blank line
    immediately following it.
  - Demote every interior heading by one level (## -> ###, ### -> ####, etc.).
  - Rewrite inter-doc references like `./<other>.md` -> in-page anchor.
"""

import os
import re

SRC_DIR = r"C:\git\clawdevbox\docs\tools"
OUT_PATH = r"C:\git\clawdevbox\docs\MCP-TOOLS-REFERENCE.md"

FAMILIES = [
    ("workspace", "Workspace", 4, "Manage Clawdevbox workspaces — the registry + on-disk `.clawdevbox/` tree."),
    ("plugin",    "Plugin",    7, "Install, list, and toggle global plugins under `<globalDir>/plugins/`."),
    ("recipe",    "Recipe",   12, "CRUD for recipe YAML/JSON, plus spawning agent CLIs and mutating live step plans."),
    ("skill",     "Skill",     4, "CRUD for markdown+frontmatter skill files."),
    ("trigger",   "Trigger",   13, "Plugin-declared trigger types, agent-authored templates, registered instances, and `trigger.test`."),
    ("cron",      "Cron",       0, "HTTP control plane for the trigger kernel — scheduler, dispatcher, fire log, and the Mode-B callback receiver. (Not an MCP family — HTTP only.)"),
    ("artifact",  "Artifact",  4, "Renderable bundles produced by agents."),
    ("renderer",  "Renderer",  4, "Workspace-shadowable `.mjs` renderers for artifact `type`s."),
    ("inbox",     "Inbox",     6, "Persistent notification center the user reviews from desktop or phone."),
    ("thread",    "Thread",    6, "In-process side-terminal kernel — rows + append-only messages."),
    ("approval",  "Approval",  3, "Modal picker for agent ↔ user decisions."),
    ("notify",    "Notify",    1, "Low-level Web Push fan-out."),
    ("ui",        "UI",        1, "Plugin-facing facade combining SSE refresh + push."),
]

INTRO = """# Clawdevbox MCP Tools — Complete Reference

> **Single composed reference.** This document is a verbatim composition of every
> per-family doc under `docs/tools/`, normalized to a single heading scheme and
> stitched together with shared cross-references. The per-family docs remain the
> canonical sources; this file is regenerated from them via
> [`scripts/compose_master_doc.py`](./scripts/compose_master_doc.py).

Clawdevbox is a developer-buddy runtime that the [Model Context Protocol
(MCP)](https://modelcontextprotocol.io) exposes to coding agents through a
single Node.js server (`mcp-server/`). This document covers all **12 MCP
tool families** that ship today — 65 tools in total — plus the **Cron
HTTP control plane** that drives the trigger kernel, and the storage,
scope, and event-bus model that holds them together. The rough mental
model is:

- A **workspace** is a directory with a `.clawdevbox/` subtree. Workspaces hold
  project-scope recipes, skills, registered triggers, recipe-instances, and
  rendered artifacts.
- **Plugins** live globally under `<globalDir>/plugins/` and are visible to
  every workspace. They ship recipes, skills, hostable tools, trigger types,
  and renderers.
- **Inbox**, **threads**, and **approvals** are the agent-to-user signalling
  layer — the inbox is durable, threads/approvals are in-process today and
  durable once the SQLite kernel lands.
- An in-process **event bus** fans `change` events to every connected SPA tab
  over SSE; `ui.notify` and `notify.send` add browser **Web Push** so a closed
  laptop or sleeping phone can still buzz.

The combined reference below preserves the per-doc "Story" and "Edge cases &
gotchas" sections — those are where most of the practical wisdom lives.

A companion document, [`MCP-TOOLS-REVIEW.md`](./MCP-TOOLS-REVIEW.md), records
issues and inconsistencies uncovered while composing this reference.

## Table of contents

- [Configuration & paths](#configuration--paths)
"""


def make_toc():
    lines = []
    for slug, name, count, _desc in FAMILIES:
        anchor = name.lower()
        if count == 0:
            lines.append(f"- [{name}](#{anchor}) — HTTP only")
        else:
            lines.append(f"- [{name}](#{anchor}) — `{slug}.*` ({count} tool{'s' if count != 1 else ''})")
    lines.append("- [Glossary](#glossary)")
    return "\n".join(lines)


CONFIG_SECTION = """## Configuration & paths

The whole MCP server hangs off three environment variables plus a small set of
scoping conventions every family doc below assumes. They are summarised here
once.

### `<projectDir>` — `CLAWDEVBOX_PROJECT_DIR`

Required. Identifies the directory the MCP server was booted against. The
in-process `Workspace` object loaded by `loadWorkspaceFromEnv` captures it
verbatim. It is what `recipe.upsert scope=project`, `skill.upsert
scope=project`, `renderer.write`, and the workspace-renderer chain look at.

### `<globalDir>` — `CLAWDEVBOX_GLOBAL_DIR`

Optional. Defaults to `~/.clawdevbox`. Holds account-wide state shared by every
workspace on the machine:

```
<globalDir>/
├── plugins/                     ← every plugin (real dir or junction)
│   └── <id>.install.json        ← sidecar install record per plugin
├── recipes/                     ← global-scope recipes (.yaml)
├── skills/                      ← global-scope skills (.md)
├── inbox.json                   ← inbox metadata (one file, atomic writes)
├── inbox-bodies/                ← per-item body sidecars
├── push-subscriptions.json      ← Web Push subscriptions
├── config.json                  ← `clawdevbox init` output (VAPID, notifications)
├── state.json                   ← per-plugin { enabled } flags
└── node_modules → <repo>/node_modules  ← junction for plugin tool imports
```

### `<workspacesRoot>` — `CLAWDEVBOX_WORKSPACES_ROOT`

Optional. Defaults to `<globalDir>/workspaces`. Houses the workspace registry
(`<workspacesRoot>/index.json`) plus one subdir per minted workspace
(`ws_<base36-ts>_<4hex>`). The MCP server's own `<projectDir>` is *not*
required to live under `<workspacesRoot>` — `clawdevbox mcp` can be launched
against any directory; `workspace.current` simply returns `found: false`.

### The `.clawdevbox/` subtree

Every workspace (and the project dir, if you've registered it) holds a
`.clawdevbox/` directory:

```
<workspace>/
├── .clawdevbox/
│   ├── recipes/                  ← project-scope recipes (.yaml)
│   ├── skills/                   ← project-scope skills (.md)
│   ├── renderers/                ← workspace-shadow renderers (.mjs)
│   ├── recipe-instances/         ← per-spawn JSON rows + .log + .script.cjs
│   ├── triggers.json             ← registered trigger instances
│   └── workspace.json            ← { id, name, created_at, ... }
└── artifacts/                    ← user-facing rendered bundles
    └── <artifact_id>/
        ├── manifest.json
        └── ...content files
```

`.clawdevbox/` is agent-private state; `artifacts/` is deliberately a sibling
so the user can browse / `zip` / commit it without leaking recipe internals.

### Scope chain

Several families (recipes, skills, triggers, renderers) accept a `scope`
parameter. The union is:

```
'project'        →  <projectDir>/.clawdevbox/<family>/...
'plugin:<id>'    →  <globalDir>/plugins/<id>/... (read-only)
'global'         →  <globalDir>/<family>/...
'all'            →  walk project → plugin (sorted by plugin id) → global,
                    first hit wins
```

Read tools accept all four scope values. Write tools accept only `project`
and `global` — plugin scope is read-only via MCP (`PLUGIN_SCOPE_READONLY`)
because plugins ship their definitions inside the plugin directory; the
escape hatch is to copy to `project` scope, which shadows the plugin copy.

Renderers use a slightly different chain — `workspace → plugin → builtin` —
but the same first-hit-wins rule.

### SSE topics

The in-process event bus exposes seven typed topics (`ChangeTopic` in
`event-bus.ts`): `inbox`, `recipes`, `agent`, `tunnel`, `notifications`,
`triggers`, `approvals`. Mutation tools emit a topic; SPA tabs subscribed to
`GET /api/events` re-fetch the corresponding endpoint. `ui.notify` exposes a
`custom` value that the tool rewrites to `notifications` (the typed union has
no `custom` member). `notify.send` does NOT emit anything.

### IDs

Three id patterns recur across families:

| Pattern               | Used by                                | Validator              |
|-----------------------|----------------------------------------|------------------------|
| `[a-z][a-z0-9-]*`     | recipe id, skill id, plugin id         | `validateId`           |
| `[a-z0-9][a-z0-9._-]*` | artifact id, renderer type            | `ARTIFACT_ID_RE` / `TYPE_REGEX` (case-insensitive) |
| `<prefix>_<base36...>`| workspace (`ws_`), recipe-instance (`ri_`), thread (`thr_`), approval (`apr_`), message (`msg_`), run (`run_`) | `mintId` / `mintWorkspaceId` |

`validateId` is enforced by `recipe.upsert`, `recipe.read`, `skill.upsert`,
`skill.read`. It is **not** called by `recipe.delete` or `skill.delete`; see
[`MCP-TOOLS-REVIEW.md`](./MCP-TOOLS-REVIEW.md) F-009.

---
"""


def transform_family(slug: str) -> str:
    path = os.path.join(SRC_DIR, f"{slug}.md")
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()

    text = re.sub(r"\A# [^\n]*\n+", "", text, count=1)

    out_lines = []
    in_fence = False
    fence_re = re.compile(r"^(```|~~~)")
    heading_re = re.compile(r"^(#{1,5})(\s+\S.*)$")
    for line in text.splitlines():
        if fence_re.match(line):
            in_fence = not in_fence
            out_lines.append(line)
            continue
        if not in_fence:
            m = heading_re.match(line)
            if m:
                hashes = m.group(1)
                rest = m.group(2)
                line = "#" + hashes + rest
        out_lines.append(line)
    body = "\n".join(out_lines)

    def link_sub(m: re.Match) -> str:
        label = m.group(1)
        target = m.group(2).strip()
        frag = m.group(3) or ""
        anchor_name = target.lower()
        return f"[{label}](#{anchor_name}{frag})"

    body = re.sub(
        r"\[([^\]]+)\]\(\.{0,2}/?tools/?([a-z]+)\.md(#[^\)]*)?\)",
        link_sub,
        body,
    )
    body = re.sub(
        r"\[([^\]]+)\]\(\./?([a-z]+)\.md(#[^\)]*)?\)",
        link_sub,
        body,
    )

    body = re.sub(r"\.\./\.\./mcp-server/", "../mcp-server/", body)

    return body.rstrip() + "\n"


GLOSSARY = """## Glossary

| Term | Definition |
|---|---|
| **Workspace** | A directory with a `.clawdevbox/` subtree, registered in `<workspacesRoot>/index.json`. The unit a recipe runs in. See [Workspace](#workspace). |
| **`<projectDir>`** | The `CLAWDEVBOX_PROJECT_DIR` the MCP server was booted with. Read-only context loaded by `loadWorkspaceFromEnv`. Distinct from a registered workspace — it may or may not be one. |
| **`<globalDir>`** | The account-wide config root (`CLAWDEVBOX_GLOBAL_DIR`, default `~/.clawdevbox`). Holds the plugin store, global recipes/skills, inbox, push subscriptions, VAPID keys, and the per-plugin enabled flag. |
| **`<workspacesRoot>`** | Parent dir for minted workspaces; defaults to `<globalDir>/workspaces`. The registry `index.json` lives here. |
| **Plugin** | A directory under `<globalDir>/plugins/<id>/` with a `plugin.yaml` manifest declaring `provides.{recipes,skills,trigger_types,tools,mcp_servers}`. Global to the account. |
| **Plugin install record** | A sidecar `<globalDir>/plugins/<id>.install.json` written next to (not inside) the plugin dir. Records `kind` (`git` / `local` / `builtin` / `manual`), source spec, optional `ref`, and `installed_at`. |
| **Scope** | One of `'project'`, `'plugin:<id>'`, `'global'`, `'all'`. Resolution order on `'all'`: project → plugin (sorted by id) → global. Writes accept only `project` and `global`. |
| **Scope chain** | The walk used by `resolveRead` and `listAllInScope` to look up a recipe/skill/trigger across scopes, taking the first hit. |
| **Renderer chain** | The same idea for `.mjs` renderer modules, but `workspace → plugin → builtin` instead. |
| **Recipe** | A YAML file at `<scope>/.clawdevbox/recipes/<id>.yaml` (or a plugin-shipped equivalent) declaring `id`, `name`, `description`, optional `steps[]`, etc. |
| **Recipe instance** | A row at `<workspace>/.clawdevbox/recipe-instances/<id>.json` recording one spawn of a recipe — id, workspace, prompt, agent CLI, pid, status, snapshot of the recipe YAML, etc. |
| **Session id** | The agent CLI's own session id. Recipe runs always pass an explicit id (`cdb_<base36>`) so resume is deterministic. |
| **Skill** | A markdown file with YAML frontmatter at `<scope>/.clawdevbox/skills/<id>.md` (or plugin-shipped). The body is the agent-readable prose; frontmatter holds `name` + `description` + arbitrary extra keys. |
| **Trigger type** | A plugin-declared capability (`provides.trigger_types[]`): id, parameter schema, default cron, callback binding. Read-only via MCP. |
| **Registered trigger** | A concrete `<type>#<key>` instance written to `<projectDir>/.clawdevbox/triggers.json`. Has bound params, cron override, enabled flag, and `last_run_*` audit fields. |
| **Identity param** | A parameter named in the trigger TYPE's manifest whose value becomes the suffix of the registered instance id (`<type>#<value>`). Falls back to an 8-hex hash of the params object. |
| **Artifact** | A folder `<workspace>/artifacts/<id>/` containing `manifest.json` plus free-form content files. Rendered by an `.mjs` module resolved through the renderer chain. |
| **Manifest** | `<workspace>/artifacts/<id>/manifest.json` — `{ id, type, title, workspace_id, recipe_instance_id?, step_id?, created_at, meta? }`. |
| **Inbox item** | A row in `<globalDir>/inbox.json` with kind/source/state plus optional body sidecar at `<globalDir>/inbox-bodies/<safe-id>.<md\\|txt>`. |
| **Body sidecar** | The per-item markdown/text file holding an inbox item's full description. Read lazily; the list endpoint never opens it. |
| **Thread** | An in-process conversation row (`thr_<rand>`) tied to an inbox item, with an append-only message list (`Message[]`). Today: in-memory only. Future: SQLite kernel. |
| **Approval** | An in-process row (`apr_<rand>`) representing a question + options + answer, owned by a thread. The thread sits in `awaiting_user` while the approval is pending. |
| **SSE topic** | One of the seven `ChangeTopic` enum values fired by `emitChange` and consumed by `/api/events` subscribers. Topics carry no payload — the SPA always re-reads the source endpoint. |
| **Hostable tool** | A `.ts`/`.js`/`.mjs` file under a plugin's `tools/` dir, declared in `provides.tools[]`. Loaded by `hosted.ts` at workspace boot, given access to the MCP server. |
| **VAPID** | Voluntary Application Server Identification — the P-256 keypair + `subject` Web Push services demand. Lives in `config.json`. Minted by `clawdevbox init`. |
| **`writeFileAtomic`** | Helper in `fs-util.ts`: write to a sibling tempfile, then `renameSync` into place. Used by every config write. POSIX-atomic, best-effort on Windows. |
| **`structuredError`** | The standard MCP error shape produced by `scope.ts`: `{ isError: true, structuredContent: { code, message, ...extra } }`. |
| **`emitChange(topic)`** | One-line pub/sub call into `event-bus.ts`. No payload — SPA re-reads the source endpoint for that topic. |
"""


def main():
    out = [INTRO, make_toc(), "\n"]
    out.append(CONFIG_SECTION)
    for slug, name, count, desc in FAMILIES:
        out.append(f"## {name}\n\n")
        if count == 0:
            out.append(f"_{desc}_\n\n")
        else:
            out.append(f"_{count} tool{'s' if count != 1 else ''} — {desc}_\n\n")
        out.append(transform_family(slug))
        out.append("\n---\n\n")
    out.append(GLOSSARY)
    out.append("\n")

    text = "".join(out)
    text = re.sub(r"\n{4,}", "\n\n\n", text)

    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)

    lines = text.count("\n")
    print(f"Wrote {OUT_PATH} ({lines} lines, {len(text):,} bytes)")


if __name__ == "__main__":
    main()
