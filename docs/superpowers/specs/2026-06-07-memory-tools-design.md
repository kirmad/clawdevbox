# Memory Tools — Design

**Status:** Draft · 2026-06-07
**Owner:** clawdevbox MCP server (new `memory.ts` toolset)
**Related:** `plugins/dev-buddy/skills/distill-session-memories/SKILL.md`,
`docs/superpowers/specs/2026-05-31-distill-session-memories-design.md`

## Purpose

A first-class **knowledge subsystem** for clawdevbox that persists durable
agent/user knowledge as Obsidian-compatible markdown files in **git
repositories**, indexed for search by [qmd](https://github.com/tobi/qmd).
Two scopes (personal and team), four types (memory, lesson,
session_summary, wiki), surfaced to agents via 13 MCP tools.

Replaces ad-hoc memory in two failure modes:

1. **GitHub Copilot Memory is repo-gated.** Write attempts against
   `kirmad/clawdevbox` fail with "repository was not found... or
   repository-scoped memories may not be enabled." Reads work because the
   backend reflects pre-existing entries, but the surface is half-broken.
   We need a write path we control.
2. **`<workspace>/.clawdevbox/memory.md` is flat and per-project.** It
   can't cross-link across projects, has no decay/ranking, no search, no
   team-sharing story.

## Non-goals

- **Not a replacement for `distill-session-memories`.** That skill
  *invokes* these tools to persist its outputs. The skill stays as-is;
  this design provides the durable substrate it writes into.
- **Not a real-time auto-memorizer.** All writes are explicit tool calls
  by agents or skills.
- **Not a vector database.** qmd does that; we don't reinvent it.
- **Not a permission system.** Git repo access is the access-control
  primitive. Anyone with push rights to the team repo can write/vote.
- **Not a deletion system in v1.** Deletes are `git rm <path>` directly.
  v1.1 will add tool support with soft-delete events.

## Where it ships

| File | Purpose |
|---|---|
| `mcp-server/src/tools/memory.ts` | All 13 tools — handlers + MCP registration |
| `mcp-server/src/tools/memory-sync.ts` | Per-vault background sync daemon (commit / push / pull / index) |
| `mcp-server/src/tools/memory-events.ts` | `events.jsonl` fold + decay function + voter dedup |
| `mcp-server/src/tools/memory-config.ts` | Thin layer: `loadVaultChain()` re-export + memory-specific settings loader + identity resolution |
| `mcp-server/src/tools/memory-qmd.ts` | qmd SDK lifecycle (collections, contexts, debounced update+embed) |
| `mcp-server/package.json` | Add `@tobilu/qmd` dependency (pulls in `node-llama-cpp`) |

No new plugins, no new MCP servers — fits inside the existing
`mcp-server/src/tools/` directory alongside `inbox.ts`, `recipe.ts`,
`update-status.ts`, etc.

## Distinction from existing memory surfaces

| Surface | Scope | Format | Loaded |
|---|---|---|---|
| `<workspace>/.clawdevbox/memory.md` | Per-project, flat, agent-private | Plain markdown template | Every turn by dev-buddy |
| Vault `memory/*.md` (via `distill-session-memories`) | Cross-session, cross-project, hierarchical | Obsidian (frontmatter + wikilinks + tags) | On demand by skill |
| GitHub Copilot Memory (`store_memory` / `vote_memory`) | Per-repo or per-user, opaque | Short facts pinned to prompts | Auto-injected at session start |
| **This design** (new) | Personal + Team, project-organized, multi-type | Obsidian-compatible markdown + sidecar events log + git history | On-demand via `search_memory` / `get_*` tools |

This design *complements* the others. `distill-session-memories` can
write into this substrate. dev-buddy's per-workspace `memory.md` remains
for hot per-project agent priming.

---

# 1 — Architecture

## Code home

```
clawdevbox/mcp-server/src/tools/
  memory.ts           # 13 tools (writes, votes, reads, ops)
  memory-sync.ts      # background daemon: commit, push, pull, conflict
  memory-events.ts    # foldEvents() pure function + decay formula
  memory-config.ts    # config + identity resolution
  memory-qmd.ts       # qmd SDK lifecycle (createStore, update, embed, addContext)
```

qmd is consumed as a **library** via `@tobilu/qmd` (in-process), not as a
separate MCP server. Rationale: zero round-trip per call, no extra
daemon, unified `memory.*` tool surface for the agent, ability to
custom-rank results by folded confidence/votes before returning. See
[Implementation prerequisites](#implementation-prerequisites) for the
qmd README reading requirement.

## Per-user configuration

### Vault chain — already in clawdevbox

**Repo paths come from clawdevbox's existing vault chain.** No new repo
config needed. See `mcp-server/src/vault-chain.ts` and the `paths.get`
MCP tool: every clawdevbox install already exposes:

```typescript
interface VaultInfo {
  id: string;                              // stable user-facing id
  path: string;                            // absolute path on disk
  kind: 'personal' | 'team';
  remote: string | null;                   // git URL or null
  title?: string;                          // from vault.yaml
  tierLabel?: string;
  description?: string;
}
```

Vaults are loaded via `loadVaultChain()` returning the chain ordered
**personal first, then team**, preserving registration order within
each tier. Multiple personal AND multiple team vaults are supported.

This subsystem treats every registered vault as a memory store. The
vault's `kind` maps directly to the `scope` tool arg; the vault's `id`
is both the qmd collection name and the optional `vault_id` tool arg
used to disambiguate when multiple vaults of the same kind exist.

### Memory-specific config

`~/.clawdevbox/memory-config.json` holds only memory tunings — **never
repo paths**:

```jsonc
{
  "decay": { "floor": 0.2, "half_life_days": 30 },
  "duplicate_threshold": 0.85,

  "sync": {
    "push_debounce_ms": 30000,
    "pull_interval_ms": 300000,
    "index_debounce_ms": 5000
  },

  "auto_resolve_conflicts": "manual", // "manual" | "auto"
  "auto_resolve": {
    "max_conflicts_per_file_per_hour": 3,
    "max_diff_lines": 100,
    "pre_merge_tag_ttl_days": 30,
    "spawn_timeout_ms": 300000
  },

  "qmd_db_path": "~/.cache/qmd/clawdevbox-memory.sqlite"
}
```

All fields have sensible defaults; the entire file is optional.

- At least one vault must be registered in clawdevbox; otherwise
  memory tools refuse to write with a setup hint pointing at the
  clawdevbox vault-add documentation.
- Identity: resolved at startup as `git config user.email` →
  `git config user.name` → `os.userInfo().username` fallback. Stamped
  on every write and vote event.
- (v1.1) Per-vault overrides for these settings via a `memory:` block
  in each `vault.yaml`.

## Repository layout

Same shape for every registered vault, regardless of `kind`.
**Project-first nesting**, type as subfolder.

```
<vault.path>/
  README.md                    # auto-generated, committed; humans browsing on GitHub
  .gitignore                   # auto-generated
  .memory-meta/                # gitignored — per-clone scratch (locks, pids)
  vault.yaml                   # clawdevbox's existing vault metadata — NOT managed by us

  _general/                    # cross-project knowledge (no specific project)
    memories/
    lessons/
    sessions/
    wiki/

  clawdevbox/                  # one folder per project slug
    memories/
      .events/                 # hidden from Obsidian by default
        2026-06-07-jwt-validation-pitfall.jsonl
      2026-06-07-jwt-validation-pitfall.md
    lessons/
      .events/
        2026-06-07-prefer-events-over-mutation.jsonl
      2026-06-07-prefer-events-over-mutation.md
    sessions/
      .events/                 # sessions have no votes — folder may be empty
      2026-06-07T00-38-design-memory-tools.md
    wiki/
      .events/
        architecture/overview.jsonl
      architecture/
        overview.md
        data-flow.md
      runbooks/
        deploy.md
        rollback.md

  billing-service/             # another project — same layout
    memories/
    lessons/
    sessions/
    wiki/
```

**Slug rule:** lowercase the title, replace non-alphanumeric with `-`,
collapse runs, trim, cap at 60 chars. Date prefix is the *creation*
date — never changes. On collision: append `-2`, `-3`. Sessions use ISO
minute granularity (no `:`, Windows-safe).

Wiki paths are hand-curated by the agent (e.g.
`architecture/overview.md`); we slugify each segment but otherwise
preserve the structure provided.

## Mutable state: sidecar event logs

Bodies are **immutable after creation** for memory, lesson, and session.
All mutable state — votes, lesson confidence, wiki edit history — lives
in **append-only `.events.jsonl` sidecar files**:

- `<type>/.events/<stem>.jsonl` (hidden from Obsidian; sibling-stem to the `.md`).
- Append-only → git auto-merges line-disjoint concurrent appends without
  conflict.
- Folded into structured state on every read via a pure function (see
  [§3 — File schemas](#3--file-schemas)).
- Source of truth for: vote tallies, lesson confidence (after decay),
  wiki edit count and last-edited.

**Wiki bodies are the one mutable exception** — `update_wiki` modifies
the `.md` file. Mutable bodies need conflict handling; see
[§4 — Operations: sync](#sync-daemon) for the synchronous pull-rebase
path and [Conflict auto-resolution](#conflict-auto-resolution) for the
optional spawned-agent fallback.

## Background sync architecture

```
agent calls add_memory()
       │
       ▼
1. memory.ts writes <slug>.md + appends .events/<stem>.jsonl   ← sync
2. git add + git commit -m "memory: <title>"                   ← sync
3. return success to agent                                     ← sync (fast, ~50ms)
       │
       │ (debounced ~5s)
       ▼
4. store.update() + store.embed() — qmd reindex                ← async
       │
       │ (debounced ~30s, independent)
       ▼
5. git push                                                    ← async
       │
       │ (every 5min when idle)
       ▼
6. git fetch && git pull --rebase                              ← async
```

Two debounced timers + one periodic timer per vault, all async, all
draining independent queues. Each vault gets its own state machine and
mutex.

## Runtime picture

```
                       ┌─────────────────────────┐
                       │   Agent CLI session     │
                       └───────────┬─────────────┘
                                   │ MCP (single server)
                                   ▼
   ┌──────────────────────────────────────────────────────┐
   │  clawdevbox MCP server                               │
   │  ┌────────────────────────────────────────────────┐  │
   │  │ memory.ts (13 tools)                           │  │
   │  │   add_memory(), add_lesson(), ...              │  │
   │  │   vote_memory(), vote_lesson(), vote_wiki()    │  │
   │  │   search_memory(), get_memory(),               │  │
   │  │     get_wiki_index()                           │  │
   │  │   memory_init(), memory_status()               │  │
   │  └─────┬──────────────────┬───────────────────────┘  │
   │        │                  │                          │
   │        ▼                  ▼                          │
   │  ┌─────────────┐   ┌────────────────────────────┐    │
   │  │ memory-     │   │ @tobilu/qmd (in-process)   │    │
   │  │ events.ts   │   │   store.search()           │    │
   │  │ foldEvents()│   │   store.get()              │    │
   │  │ decay()     │   │   store.update()           │    │
   │  └─────────────┘   │   store.embed()            │    │
   │                    │   GGUF models stay loaded  │    │
   │                    └────────────────────────────┘    │
   │  ┌─────────────────────────────────────────────────┐ │
   │  │ memory-sync.ts (per-vault background daemons)   │ │
   │  │   per-vault mutex                               │ │
   │  │   debounced push (30s) + idle pull (5min)       │ │
   │  │   conflict auto-resolve (optional, spawned)     │ │
   │  └────────────────────┬────────────────────────────┘ │
   └───────────────────────┼──────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────────────────────┐
              │  loadVaultChain() — clawdevbox vaults  │
              │    <vault.path>/                       │
              │      <project>/<type>/*.md             │
              │      <project>/<type>/.events/*.jsonl  │
              └────────────────────────────────────────┘
                           ▲
                           │ indexes via qmd.addCollection(vault.id, ...)
                           │   one collection per vault in the chain
                           ▼
              ┌────────────────────────────────────┐
              │  ~/.cache/qmd/clawdevbox-memory.sqlite │
              │  ~/.cache/qmd/models/ (GGUF cache) │
              └────────────────────────────────────┘
```

---

# 2 — Tool surface

13 tools, registered in `memory.ts`, exposed via clawdevbox's existing
MCP server.

## Summary

| Tool | Purpose | Returns |
|---|---|---|
| `add_memory` | Write atomic fact to `<project>/memories/` | `{ path, slug, action: "created" }` |
| `add_lesson` | Write lesson; auto-strengthens existing duplicate via qmd vector match | `{ path, slug, action: "created" \| "reinforced", target?, similarity? }` |
| `add_session_summary` | Append structured session retrospective to `<project>/sessions/` | `{ path, slug, action: "created" }` |
| `add_wiki_page` | Create new curated wiki page (errors if `path` already exists) | `{ path, action: "created" }` |
| `update_wiki` | Edit existing wiki page body (pull-rebase first) | `{ path, action: "updated", operation }` |
| `vote_memory` | Append vote event to memory's `.events.jsonl` | `{ path, action: "voted", new_score }` |
| `vote_lesson` | Append vote event; recomputes confidence | `{ path, action: "voted", new_confidence }` |
| `vote_wiki` | Append vote event to wiki page's `.events.jsonl` | `{ path, action: "voted", new_score }` |
| `search_memory` | Hybrid search across one/more scopes/types/projects via qmd | `{ results: [{ path, type, project, score, snippet, confidence?, votes }], total }` |
| `get_memory` | Fetch a single item by path or slug, with folded events | `{ path, type, body, frontmatter, events_summary }` |
| `get_wiki_index` | Navigable tree of wiki structure (folders + pages + summaries) | `{ root, total_pages, truncated_at_depth, tree: TreeNode[] }` |
| `memory_init` | One-time setup — scaffold folders inside each vault, register qmd collections + contexts | `{ vaults: [...], qmd_status }` |
| `memory_status` | Report sync state, qmd index health, last push/pull, queue depth | `{ git, qmd, queues, config, warnings }` |

## Naming convention

Snake_case verbs (`add_memory`, `vote_lesson`), matching the user's
original spec and the existing `update_status` tool in clawdevbox. The
dotted-namespace style (`memory.add`) is reserved for tools that
genuinely sub-group within a single namespace.

## Detailed signatures — the four most nuanced tools

### `add_memory(...)`

```typescript
{
  // required
  content: string;            // 1-3 sentences — the fact itself
  scope: "personal" | "team"; // selects from vault chain by kind
  project: string;            // slug; "_general" for cross-project
  citations: string;          // "path/file.ts:42" OR 'User input: "..."'
  reason: string;             // ≥ 2 sentences — why durable, what future tasks benefit

  // optional
  vault_id?: string;          // disambiguates when multiple vaults of `scope` kind exist;
                              // defaults to first matching vault in chain registration order
  category?: "pattern" | "preference" | "architecture" | "bug" | "workflow" | "fact";
  concepts?: string[];        // free tags; normalized to frontmatter `tags`
  title?: string;             // defaults to first 60 chars of content, slugified
}
```

**Side effects**
1. Resolves `scope` + optional `vault_id` → target `VaultInfo` from the
   vault chain.
2. Writes `<vault.path>/<project>/memories/<YYYY-MM-DD>-<slug>.md` with
   frontmatter (see §3).
3. Appends `created` event to sidecar
   `<vault.path>/<project>/memories/.events/<stem>.jsonl`.
4. `git add` + `git commit -m "memory: <title>"` synchronously
   (per-vault mutex).
5. Schedules qmd `update` + `embed` (debounced 5s).
6. Schedules `git push` (debounced 30s) — only if `vault.remote` is set.

**Errors**
- No vault registered with the requested `kind` → setup hint
  ("run `paths.get` to see registered vaults; add one via clawdevbox
  vault config").
- `vault_id` doesn't match any registered vault → list valid ids.
- `project` contains path traversal (`..`, `/`) → reject.
- Git not configured (no `user.email` and no fallback username) →
  refuse with `git config --global user.email` hint.

### `add_lesson(...)`

```typescript
{
  // required
  content: string;            // subject to dedup
  scope: "personal" | "team";
  project: string;

  // optional
  vault_id?: string;
  context?: string;           // what triggered the lesson (situation)
  confidence?: number;        // 0-1; default 0.5
  tags?: string[];
  title?: string;
}
```

**Dedup flow**
1. `store.searchVector(content, { collection: <vault.id>, limit: 1 })`
   then post-filter to `<project>/lessons/`.
2. **If top hit's score ≥ `config.duplicate_threshold` (default 0.85)**:
   - Append `{ type: "reinforced", source_content: content, confidence_delta: +0.1 }`
     event to existing lesson's `.events.jsonl`.
   - Return `{ action: "reinforced", target: <existing-slug>, similarity: 0.91 }`.
   - No new file, no body churn — only one events.jsonl line.
3. **Else**: create new lesson file (same flow as `add_memory`).

### `search_memory(...)`

```typescript
{
  // required
  query: string;

  // optional filters
  scope?: "personal" | "team" | "all";        // default: "all"
  vault_id?: string;                          // narrow to a single vault by id
  types?: ("memory" | "lesson" | "session" | "wiki")[]; // default: all 4
  project?: string;                           // default: all projects
  limit?: number;                             // default: 10
  min_score?: number;                         // default: 0.3
  mode?: "hybrid" | "lex" | "vec";            // default: "hybrid" (qmd's best quality)
}
```

**Returns**
```typescript
{
  results: Array<{
    path: string;                  // vault-relative
    type: "memory" | "lesson" | "session" | "wiki";
    scope: "personal" | "team";
    vault_id: string;              // origin vault
    project: string;
    title: string;
    snippet: string;               // qmd's matched-region snippet
    score: number;                 // final blended score (0-1)
    confidence?: number;           // for lessons — decay-adjusted at read time
    votes?: { up: number; down: number };
    author?: string;
    last_modified: string;
  }>;
  total: number;
  query_expansion?: string[];      // qmd's expanded queries (when mode=hybrid)
}
```

**Internal flow**
1. Resolve `scope` + optional `vault_id` → qmd collection list. For
   example, `scope: "all"` with no `vault_id` →
   `vaultChain.map(v => v.id)`; `scope: "personal"` →
   `vaultChain.filter(v => v.kind === "personal").map(v => v.id)`.
2. Call `store.search({ query, collections, minScore: min_score, limit: limit*3 })`
   (over-fetch 3× for post-filtering).
3. Post-filter results by `types` and `project` using path-glob match.
4. For each result, load and fold its `.events.jsonl` →
   decay-adjusted confidence (lessons) and vote tallies.
5. **Confidence-weighted re-rank:**
   - For lessons: `final = qmd_score × (0.5 + 0.5 × decayed_confidence)`
   - For memory/wiki: `final = qmd_score × (1 + 0.1 × log(1 + votes_up - votes_down))`
   - For sessions: unchanged (no votes).
6. Truncate to `limit`, return.

### `update_wiki(...)`

```typescript
{
  // required
  path: string;               // "<project>/wiki/<rel>.md"
  scope: "personal" | "team";
  project: string;
  operation: "replace_section" | "append" | "prepend" | "find_replace" | "full_replace";
  content: string;

  // optional
  vault_id?: string;

  // operation-specific
  section?: string;           // for replace_section — markdown header text
  find_text?: string;         // for find_replace
  expected_replacements?: number; // for find_replace — validation guard
}
```

**Side effects (special path — body mutation)**
1. **Synchronous** `git fetch && git rebase` (only `update_wiki` does
   sync pull — wiki bodies are mutable so we must rebase to avoid
   lost-update).
2. Apply the operation to the file body.
3. Append `{ type: "edited", operation, lines_changed: N }` event to
   `.events.jsonl`.
4. `git add` + `git commit -m "wiki: <path> (<operation>)"`.
5. Schedule qmd `update` + `embed` (debounced).
6. Schedule `git push` (debounced).

**Errors**
- Pull-rebase conflict → either auto-resolve (if config opts in) or
  return `{ error: "merge_conflict", path, hint }` and leave the working
  tree in conflict state. See [Conflict auto-resolution](#conflict-auto-resolution).
- `find_replace` doesn't match `expected_replacements` → revert and
  error.

## The other 9 tools

All accept the same `vault_id?: string` optional arg as the four
detailed above. Repo paths are never passed in by the caller — they
come from the vault chain.

| Tool | Notable shape |
|---|---|
| `add_session_summary` | Required: `title`, `narrative`, `scope`, `project`. Optional: `vault_id`, `decisions[]`, `files[]`, `concepts[]`, `session_id`. Always appends, no dedup. |
| `add_wiki_page` | Required: `path` (under `<project>/wiki/`), `content`, `scope`, `project`. Optional: `vault_id`, `keywords[]`, `title`. Errors if `path` exists (use `update_wiki` instead). |
| `vote_memory` / `vote_lesson` / `vote_wiki` | Required: `path` (or `slug`), `direction: "up" \| "down"`, `scope`, `project`. Optional: `vault_id`, `reason` (short string, becomes part of event). Per-actor latest vote wins (anti-double-vote). |
| `get_memory` | Required: `path` OR `slug`. Optional: `vault_id` (needed only when `path` is ambiguous across vaults). Returns full body + frontmatter + folded events summary (votes, current confidence, last reinforced, edit count, etc.). |
| `get_wiki_index` | See [§2.x — get_wiki_index](#get_wiki_index-details). |
| `memory_init` | No args. Reads vault chain + memory-config.json, scaffolds folder skeleton inside each vault, writes README.md per vault, registers qmd collections + per-path contexts. Idempotent. |
| `memory_status` | No args. Returns sync state per vault, qmd health, queue depths, config snapshot. See [§4 — Operations](#memory_status-shape). |

### `get_wiki_index` details

```typescript
{
  // all optional — defaults give a useful overview
  scope?: "personal" | "team" | "all";   // default: "all"
  vault_id?: string;                     // narrow to a single vault by id
  project?: string;                      // default: all projects
  root?: string;                         // subpath start, e.g. "architecture/"; default: "/"
  depth?: number;                        // tree depth from root; default: 2; -1 = unlimited
  include?: {
    summaries?: boolean;                 // H1 + first paragraph per page; default: true
    tags?: boolean;                      // from frontmatter (formerly "keywords"); default: true
    metadata?: boolean;                  // author, last_modified, vote tallies; default: true
    links?: boolean;                     // outbound [[wikilinks]] + md links; default: false
  };
}
```

**Returns**

```typescript
{
  root: string;                          // e.g. "clawdevbox/wiki/"
  total_pages: number;
  truncated_at_depth: boolean;
  tree: TreeNode[];
}

type TreeNode =
  | { type: "folder"; path: string; page_count: number; children: TreeNode[]; }
  | {
      type: "page";
      path: string;
      title: string;
      summary?: string;
      tags?: string[];                   // from frontmatter
      author?: string;
      last_modified?: string;
      votes?: { up: number; down: number };
      links_out?: string[];              // resolved wiki-relative paths
    };
```

Wiki is the only type with a navigable hierarchy. For other types
("memories of clawdevbox"), use `search_memory` with empty query +
filters.

## Tools deliberately not included (v1)

- **`delete_memory` / `delete_lesson` / `delete_wiki`.** Use `git rm <path>` directly. v1.1 should add tool support with a `deleted` event so search downweights.
- **`list_memories`.** `search_memory` with empty query + filters is the same call.
- **`expand_memory` / `summarize_memory`.** Agent's job, not ours.
- **`get_wiki_backlinks(path)`.** Expensive (whole-corpus scan). v1.1.
- **Per-team variants** (`add_memory_to_team_infra`). Single tool with `vault_id` arg keeps the surface flat.

---

# 3 — File schemas

## File naming

| Type | Pattern | Example |
|---|---|---|
| memory | `<YYYY-MM-DD>-<slug>.md` | `2026-06-07-jwt-validation-pitfall.md` |
| lesson | `<YYYY-MM-DD>-<slug>.md` | `2026-06-07-prefer-events-over-mutation.md` |
| session | `<YYYY-MM-DDTHH-MM>-<slug>.md` | `2026-06-07T00-38-design-memory-tools.md` |
| wiki | user-supplied path, slugified per segment | `architecture/data-flow.md` |
| events sidecar | `<same-stem>.jsonl` inside sibling `.events/` | `architecture/.events/data-flow.jsonl` |

**Slug rule:** lowercase title → replace non-alphanumeric with `-` →
collapse runs → trim → cap at 60 chars. Date prefix is the *creation*
date; never changes. On collision (same date + slug): append `-2`, `-3`.

## Common frontmatter (all 4 types)

```yaml
---
id: 7f3a9c1e-...                  # stable UUID — survives renames; used by votes
title: "JWT validation pitfall"
created: 2026-06-07T07:30:00Z
created_by: jane@team.com
scope: team                       # personal | team — mirrors vault.kind
vault_id: engineering             # vault.id from clawdevbox's vault chain
project: clawdevbox               # slug; "_general" for cross-project
type: memory                      # memory | lesson | session | wiki
tags: [auth, jwt, security]       # unified "tags/concepts/keywords"
aliases: []                       # optional — Obsidian quick-switcher
schema: 1                         # bump on breaking format changes
---
```

**Why `tags` is unified across types:** Obsidian's `tags` field is
special. Per-type tool args can still be named `concepts:` (memory),
`keywords:` (wiki) for the agent's mental model — normalized to `tags:`
on write.

## Per-type additional frontmatter

### memory

```yaml
category: bug                     # pattern|preference|architecture|bug|workflow|fact (optional)
citations: |
  mcp-server/src/auth/jwt.ts:42
  User input: "Always validate exp before iat"
reason: |
  We hit this twice in production. Future auth-touching work should
  always validate exp first, otherwise we accept tokens whose iat is
  in the future but exp is past — a real exploit path.
```

### lesson

```yaml
context: "Encountered while debugging the 2026-06-04 outage in billing-service."
initial_confidence: 0.5           # seed; folded events tell current value
```

### session

```yaml
session_id: 61be57e3-dfb4-4124-a2cb-f4fc43289572   # link to Copilot CLI session
decisions:
  - "Sidecar events.jsonl over in-frontmatter counters"
  - "qmd SDK in-process over separate MCP server"
files:
  - "mcp-server/src/tools/memory.ts"
  - "docs/superpowers/specs/2026-06-07-memory-tools-design.md"
# Note: the agent-facing `concepts: string[]` tool arg is normalized
# into the common `tags:` field above. No separate `concepts:` field
# in frontmatter.
```

Body is human-readable narrative (markdown prose, sub-sections).
Structured arrays (`decisions`, `files`) live in frontmatter for
indexability and filtering.

### wiki

```yaml
# No additional fields beyond the common frontmatter. The
# agent-facing `keywords: string[]` tool arg is normalized into the
# common `tags:` field above.
#
# Note: edit_count and last_edited_by are NOT in frontmatter — they
# come from folded events. Otherwise concurrent edits cause
# frontmatter merge conflicts.
```

## Wiki body conventions

- Prefer `[[wikilinks]]` for cross-references — Obsidian Graph view
  works out of the box, and our `get_wiki_index({ include: { links: true } })`
  extracts both `[[...]]` and `[md link](path.md)` for the `links_out`
  field.
- H1 should match `title` in frontmatter (Obsidian reading-view
  convention).

## `events.jsonl` schema

One JSON object per line, append-only. Common envelope: `ts`, `actor`,
`type`. Per-type fields vary.

```jsonl
{"ts":"2026-06-07T07:30:00Z","actor":"jane@team.com","type":"created","initial_confidence":0.5}
{"ts":"2026-06-08T14:12:00Z","actor":"bob@team.com","type":"voted","direction":"up","reason":"confirmed in team standup"}
{"ts":"2026-06-14T09:00:00Z","actor":"jane@team.com","type":"reinforced","source_content":"Always prefer X over Y when..."}
{"ts":"2026-07-02T11:30:00Z","actor":"alice@team.com","type":"voted","direction":"down","reason":"doesn't apply to our context"}
{"ts":"2026-07-15T16:00:00Z","actor":"jane@team.com","type":"edited","operation":"replace_section","section":"## Examples","lines_changed":12}
```

**Event types:**

| Type | Applies to | Fields | Effect |
|---|---|---|---|
| `created` | all | `initial_confidence?` (lesson only) | First line of every events log |
| `voted` | memory, lesson, wiki | `direction: "up" \| "down"`, `reason?` | Counts toward score; per-actor latest wins |
| `reinforced` | lesson | `source_content`, `confidence_delta` (default +0.1) | Strengthens confidence; resets decay clock |
| `edited` | wiki | `operation`, `section?`, `lines_changed` | Tracks edit history |
| `deleted` | (v1.1) | `reason` | Soft-delete; search downweights |

## Folded state — pure function

```typescript
function foldEvents(events: Event[]): FoldedState {
  // Walk events in order.
  // Per-actor latest vote is the only one that counts.
  // Confidence = initial + Σ(reinforcement_deltas) + 0.05*(net_votes), bounded [0, 1].
  // Then apply decay = floor + (stored - floor) * 0.5^(days_since_last_reinforce / 30).
}

type FoldedState = {
  created: { at: string; by: string };
  votes: { up: number; down: number };
  voters: Record<string, "up" | "down">;       // per-actor map; double-vote protection

  // lesson-only
  confidence_stored?: number;                  // pre-decay
  confidence_now?: number;                     // decay-adjusted at fold time
  last_reinforced?: string;
  reinforcement_count?: number;

  // wiki-only
  edit_count?: number;
  last_edited?: { at: string; by: string };
};
```

**Per-actor latest vote** is the only fair rule. If `jane@team.com`
upvotes then later downvotes the same item, the folded state contains
`voters: { "jane@team.com": "down" }` — net vote is `-1`, not `0`.
Prevents both vote-stacking and accidental double-counting from
re-reading the log.

**Decay formula:**
```typescript
days = (now - last_reinforced) / 86400000;
confidence_now = floor + (confidence_stored - floor) * Math.pow(0.5, days / half_life_days);
```
With config defaults `floor=0.2`, `half_life_days=30`. If lesson has
never been `reinforced`, `last_reinforced` is the `created` timestamp.

Decay is computed at read time. Never mutated. Events log is the source
of truth.

## Auto-generated `README.md` per vault

Regenerated after each commit by the sync daemon. Pure derived data —
not edited by humans.

```markdown
# Team Memory — kirmad/team

Maintained by clawdevbox memory tools. Generated 2026-06-07T00:38:00Z.

## Projects
- [clawdevbox](./clawdevbox/) — 14 memories, 9 lessons (avg conf 0.62),
  3 wiki pages, 7 sessions
- [billing-service](./billing-service/) — 6 memories, ...
- [_general](./_general/) — 22 memories, ...

## Recent activity (last 30 events)
- 2026-06-07 07:30  jane@team   memory     clawdevbox/memories/2026-06-07-jwt-validation-pitfall.md
- 2026-06-07 07:35  bob@team    voted ↑    clawdevbox/lessons/2026-06-05-prefer-events.md
- ...

> Edit files at your own risk — the tooling auto-commits and re-indexes.
> Use `vote_memory` / `add_lesson` / etc. for changes that should affect ranking.
```

---

# 4 — Operations

## Sync daemon

One sync daemon per registered vault, started on MCP-server boot,
stopped on shutdown. Vaults with `remote: null` still get a daemon for
inline commits but skip the push/pull cycle.

### State machine (per vault)

```
      ┌─────► IDLE ◄─────┐
      │        │         │
      │      write       │
      │        ▼         │
      │   COMMITTING ────┘  (sync, in-process)
      │        │
      │        ▼
      │   (debounced 30s)
      │        │
      │        ▼
      └──── PUSHING ──────► ERROR ──► (inbox entry, retry w/ backoff)
                │                       │
                │                       ▼
            CONFLICT ◄───── push rejected (non-fast-forward)
                │                       │
                │                       ▼
                │            try pull --rebase
                │                       │
                ▼                       │
       config?         ◄────── if conflict
        ├── "manual" → HALT + inbox
        └── "auto"   → spawn agent (see below)
```

### Per-vault mutex

JS is single-threaded but git operations spawn async child processes.
Per-vault mutex serializes write-and-commit and prevents push/pull from
interleaving with each other.

```typescript
async function withVaultLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
  // chain a Promise per vaultId in a Map; new callers wait on the prior.
}
```

All git-touching operations go through this. qmd calls don't need
it — `store` is concurrency-safe per its docs.

### External writers (Obsidian, manual `git commit`)

Before every tool-driven commit: `git status --porcelain`. If unstaged
changes exist, commit them in a **separate preceding commit** with
message `memory: external edits detected`. This:
- Preserves user's changes in git history.
- Isolates them from tool commits.
- Pushes them automatically next cycle.

On every pull: append-only events + immutable bodies make races
impossible for everything except wiki updates (which use synchronous
rebase per §2).

## qmd integration lifecycle

```
clawdevbox MCP starts
   │
   ▼
1. Load vault chain + memory-config.json defaults.
2. createStore({ dbPath, config: { collections: {...} } })
      ↳ models NOT loaded yet — qmd is lazy
3. Start sync daemons per vault (don't trigger qmd yet)
4. Return; agent is ready

agent calls search_memory()
   │
   ▼
5. store.search(...) — first call triggers GGUF model download/load
      (~30-60s first time; cached in ~/.cache/qmd/models/ after that)
6. Return results

agent calls add_memory()
   │
   ▼
7. Write .md + .events/.jsonl + commit (sync, ~50ms)
8. Return success to agent
9. Background: schedule store.update + store.embed (debounced 5s)
10. Background: schedule git push (debounced 30s)
```

### qmd collection registration (via `memory_init`)

One collection per registered vault, named by `vault.id`:

```typescript
const chain = loadVaultChain();
for (const vault of chain) {
  await store.addCollection(vault.id, {
    path: vault.path,
    pattern: "**/*.md",
    ignore: [
      "**/.events/**",
      "**/.git/**",
      "README.md",
      "vault.yaml",
    ],
  });
}
```

Vault `id` becomes the qmd collection name — naturally stable, naturally
unique, naturally matches the `vault_id` arg the agent passes to tool
calls.

### qmd context registration (free search-quality boost)

Set once at `memory_init`, then again whenever a new
`<project>/<type>` subtree first gets content:

```typescript
for (const vault of chain) {
  for (const project of discoverProjectsIn(vault)) {
    await store.addContext(vault.id, `/${project}/memories`,
      `${vault.kind} memories about ${project} — high-confidence facts`);
    await store.addContext(vault.id, `/${project}/lessons`,
      `${vault.kind} lessons learned about ${project}; confidence decays over time`);
    await store.addContext(vault.id, `/${project}/wiki`,
      `${vault.kind} curated documentation for ${project}`);
    await store.addContext(vault.id, `/${project}/sessions`,
      `${vault.kind} session retrospectives from agent work on ${project}`);
  }
}
```

Per qmd docs, context strings are returned alongside results and help
the LLM make better contextual choices.

### Why qmd in-process, not as a separate MCP server

| Concern | Separate MCP server | `@tobilu/qmd` SDK (chosen) |
|---|---|---|
| Processes to manage | 2 (clawdevbox + qmd daemon) | 1 (clawdevbox) |
| Per-call latency | HTTP round-trip + JSON serialize | Direct TS function call |
| User setup | `npm install -g @tobilu/qmd` + `qmd mcp --http --daemon` lifecycle | Just `npm install @tobilu/qmd` in mcp-server deps |
| Agent's tool surface | `memory.*` AND `qmd.*` — confusing | Only `memory.*` — unified |
| Custom ranking | Hard — reranking server-side | Easy — raw scored results, fold in confidence/decay before returning |
| Reading `.events.jsonl` during search | Two-step (HTTP → disk → re-rank) | Single step in-process |

## `memory_init` flow

```typescript
memory_init() {
  // 1. Load vault chain (clawdevbox owns vault creation — we don't)
  const chain = loadVaultChain();
  if (chain.length === 0) {
    throw new Error(
      "No vaults registered. Run clawdevbox's vault setup first; " +
      "see paths.get to inspect the current chain."
    );
  }

  // 2. Load memory-specific settings (all optional with defaults)
  const cfg = readMemoryConfig();

  // 3. Per vault: ensure folder skeleton + auto-generated README.
  //    No git init, no approval flow — the vault repo already exists.
  for (const vault of chain) {
    assert(isGitRepo(vault.path), `Vault ${vault.id} at ${vault.path} is not a git repository`);
    ensureDir(`${vault.path}/_general/memories`);
    ensureDir(`${vault.path}/_general/lessons`);
    ensureDir(`${vault.path}/_general/sessions`);
    ensureDir(`${vault.path}/_general/wiki`);
    // .events/ subfolders created lazily on first write into that type
    writeReadmeIfMissingOrStale(vault);
  }

  // 4. Register qmd collections (see "qmd collection registration" above)
  // 5. Set per-path contexts (see "qmd context registration" above)

  // 6. Initial index + embed
  await store.update();
  await store.embed({ chunkStrategy: "auto" });

  // 7. Start sync daemons — one per vault. Vaults with `remote: null`
  //    still get a daemon for inline commits, but skip push/pull.
  for (const vault of chain) startSyncDaemon(vault);

  return {
    vaults: chain.map(v => ({
      id: v.id,
      kind: v.kind,
      path: v.path,
      has_remote: v.remote !== null,
      skeleton_status: "ok",
    })),
    qmd_status: {
      collections: chain.length,
      indexed_docs: await store.getStatus().then(s => s.totalDocuments),
      models_loaded: true,
    },
  };
}
```

Idempotent — re-running validates and reconciles without re-init. No
`approval.request` flow needed; vault creation is clawdevbox's concern,
not ours.

## Conflict auto-resolution

Optional, **default `manual`**. When `config.auto_resolve_conflicts ===
"auto"`, the sync daemon spawns a fresh agent CLI session via
`session.send` to merge wiki conflicts.

**Only applies to wiki body conflicts.** Everything else is
conflict-free by design (events.jsonl is append-only;
memory/lesson/session bodies are immutable).

### Pseudocode

```typescript
async function attemptAutoResolve(
  repoPath: string,
  conflictPath: string,
  base_sha: string,
  our_sha: string,
  their_sha: string,
) {
  // 1. Pre-merge tags — always, before any merge attempt.
  const ts = Date.now();
  await git(`tag memory-pre-merge/${ts}-ours HEAD`, { cwd: repoPath });
  await git(`tag memory-pre-merge/${ts}-theirs FETCH_HEAD`, { cwd: repoPath });

  // 2. Safety gates
  if (config.auto_resolve_conflicts !== "auto") return haltAndInbox(...);
  if (!isUnderWikiSubtree(conflictPath))         return haltAndInbox(...);
  if (conflictsInLastHour(conflictPath) >= 3)    return haltAndInbox(...);
  if (conflictDiffLines(conflictPath) > 100)     return haltAndInbox(...);

  // 3. Build the inline merge prompt
  const prompt = `
You're resolving a 3-way merge conflict in a team memory wiki page.

Repo: ${repoPath}
File: ${conflictPath}

Read all three versions:
  git show ${base_sha}:${conflictPath}     # common ancestor
  git show ${our_sha}:${conflictPath}      # our edit
  git show ${their_sha}:${conflictPath}    # their edit

Produce a merged body preserving both teammates' intent. If sections
genuinely conflict, prefer the more recent edit and add an Obsidian
callout pointing to ${their_sha} for the alternate version.

When done:
  git add ${conflictPath}
  git commit -m "wiki: auto-resolve merge for ${conflictPath}"
  exit 0

If you cannot safely merge (file deleted on either side, frontmatter
conflicts, > 100 line diff, etc.):
  git merge --abort
  exit 1
`;

  // 4. Spawn a fresh CLI session via session.send
  const result = await spawnAgent({
    cwd: repoPath,
    prompt,
    timeout_ms: config.auto_resolve.spawn_timeout_ms,
  });

  // 5. Outcome
  if (result.exit_code === 0 && (await hasNewCommitOn(conflictPath))) {
    await inbox.add({
      severity: "info",
      title: `Auto-merged ${conflictPath} — please review`,
      hint: `Revert with: git reset --hard memory-pre-merge/${ts}-ours`,
    });
    return resumePush();
  } else {
    await inbox.add({
      severity: "warning",
      title: `Auto-merge declined for ${conflictPath}`,
      hint: `Resolve manually. Pre-merge tag: memory-pre-merge/${ts}-ours`,
    });
    return halt();
  }
}
```

`spawnAgent({ cwd, prompt, timeout_ms })` uses
`session.send({ session_id, prompt, ... })`. The spawned session is
visible in the Terminals tab so the user can step in to oversee.

### Safety guarantees

- **Pre-merge git tags** survive for `config.auto_resolve.pre_merge_tag_ttl_days`
  (default 30). `git reset --hard memory-pre-merge/<ts>-ours` reverts
  any auto-merge.
- **Inbox entry on every auto-merge** — never silent. `info` on success,
  `warning` on failure.
- **Safety gates** prevent the worst auto-merge failure modes:
  - Only wiki bodies (other types can't conflict).
  - Max 3 conflicts per file per hour (signal of real disagreement).
  - Max 100-line diff (likely needs a human).
  - Spawn timeout fallback to halt.
- **Opt-in only.** Default `"manual"` preserves halt-and-inbox behavior.

### Known risks

- LLM merges are softer than text-based merges. A confidently-wrong
  merge in a runbook can cause real damage. Pre-merge tag is the
  ultimate backstop.
- LLM cost / latency per auto-merge (~5-30s, real tokens).
- Sub-agent failure modes (model down, tool error). Timeout fallback
  handles this.

## Failure modes & recovery

| Failure | Detection | Response | User surface |
|---|---|---|---|
| Push rejected (remote ahead) | git exit code | auto `pull --rebase`; retry push | silent (success) |
| Pull-rebase conflict | git exit code | per `auto_resolve_conflicts` config | inbox entry |
| Network down | retry timeout | exponential backoff (10s → 1m → 5m → capped) | `memory_status.git.last_push_attempt`; inbox after 5min sustained |
| Git not configured | `git config user.email` empty at startup + no fallback username | refuse all writes | hard error with `git config --global user.email` hint |
| Disk full | `ENOSPC` on write | refuse write; surface in status | hard error |
| qmd model download fails (no internet, first call) | catch in `store.search` | return zero results; retry next call | `memory_status.qmd.models_loaded: false` |
| qmd embed crash | catch in debounced embed | fall back to BM25-only search (works without vectors); flag in status | `memory_status.qmd.last_embed_error` |
| qmd index corruption | health check on startup | `store.cleanup()` then full re-embed | `memory_status.qmd.last_health_check` |
| events.jsonl line is malformed JSON | per-line parse try/catch | skip the bad line; log warning; continue fold | `memory_status.warnings` |
| File has `schema:` > supported | frontmatter check | skip in search; count in status | `memory_status.unsupported_schema_count` |
| Frontmatter missing required fields | yaml parse | skip in search; count in status | `memory_status.malformed_files` |

### Inbox integration

Sync failures escalate via clawdevbox's existing inbox tools. Severity
escalates with duration:

- **0–5min**: silent (in `memory_status` only).
- **5–60min**: `warning` inbox entry, one per failure type per repo per
  hour.
- **> 60min**: `severe` inbox entry, daily.

Each entry includes: failure reason, the failing repo path, suggested
fix, and the timestamp of the most recent successful operation of that
type.

## `memory_status` shape

```typescript
{
  git: {
    [vaultId: string]: {                       // vault.id from loadVaultChain()
      branch: "main",
      ahead: 0,
      behind: 0,
      dirty: false,
      last_push: "2026-06-07T07:38:00Z",
      last_push_ok: true,
      last_pull: "2026-06-07T07:35:00Z",
      last_pull_ok: true,
      pending_push_queue: 0,
      conflict: null,  // or { path, since }
    }
  },
  qmd: {
    db_path: "~/.cache/qmd/clawdevbox-memory.sqlite",
    db_size_bytes: 12_345_678,
    collections: [{ name, doc_count, last_modified }],
    models_loaded: true,
    last_embed: "2026-06-07T07:38:05Z",
    last_embed_error: null,
    pending_index_queue: 0,
  },
  config: {
    vaults: [                                  // from loadVaultChain()
      { id: "my-notes", kind: "personal", path: "C:/git/my-notes", has_remote: false },
      { id: "engineering", kind: "team", path: "C:/git/team-engineering", has_remote: true },
    ],
    decay: { floor: 0.2, half_life_days: 30 },
    duplicate_threshold: 0.85,
    auto_resolve_conflicts: "manual",
  },
  warnings: string[],
}
```

---

# Implementation phases

This design is substantial (13 tools, qmd integration, sync daemon,
optional conflict auto-resolve). The writing-plans skill should
decompose into phases roughly along these lines. Each phase produces
a usable subset of the surface; phases compose rather than block.

| Phase | Scope | Output |
|---|---|---|
| **0 — Plumbing** | `memory-config.ts` (re-exports `loadVaultChain()` + loads memory-config.json defaults + identity resolution); test-config fixtures with a stub vault chain; per-vault mutex helper; `mcp-server/package.json` adds `@tobilu/qmd`; smoke-test `createStore + search` on Windows | Foundational utilities; no agent-facing tools yet |
| **1 — Write tools (no sync)** | `add_memory`, `add_lesson` (without dedup), `add_session_summary`, `add_wiki_page`; file naming; common + per-type frontmatter; events.jsonl `created` events; inline `git add + commit` per write | 4 tools that produce well-formed files in a registered vault |
| **2 — Read tools (no qmd yet)** | `get_memory`, `events fold` + decay function, `memory_status` (config-only sections) | Round-trip: write a memory, read it back with folded state |
| **3 — qmd integration** | `memory-qmd.ts`; collection + context registration (looping over vault chain); debounced `update + embed`; `memory_init` (no approval flow — vaults already exist); `search_memory` with confidence-weighted ranking; `get_wiki_index` | Fully searchable substrate; `memory_init` becomes the canonical onboarding entry |
| **4 — Lesson dedup** | qmd vector-similarity dedup in `add_lesson`; `reinforced` events; confidence delta application | Lessons auto-strengthen on near-duplicate content |
| **5 — Voting** | `vote_memory`, `vote_lesson`, `vote_wiki`; `voted` events; per-actor latest-vote dedup; rank uplift in `search_memory` | Voting changes search ranking |
| **6 — Background sync** | `memory-sync.ts` (push debounce, idle pull, state machine); `memory_status.git` populated; inbox-routed failure escalation | Tool calls return fast; sync runs in background |
| **7 — Wiki updates** | `update_wiki` (synchronous pull-rebase, `edited` events, README regeneration) | Wiki bodies become mutable safely |
| **8 — Conflict auto-resolve (optional)** | `auto_resolve_conflicts` config; safety gates; `attemptAutoResolve` via `session.send`; pre-merge tags; per-conflict inbox entries | Wiki merge conflicts can auto-resolve when opted in |

Phase 0–3 form the minimum useful release. Phases 4–7 add the
higher-value differentiators. Phase 8 is opt-in and can ship later
without breaking 0–7.

# Implementation prerequisites

Before writing any SDK code:

1. **Read the qmd README in full**: https://github.com/tobi/qmd/blob/main/README.md
   — confirm the SDK surface, model lifecycle, and Node.js / Bun
   requirements.
2. **Verify Node version**: qmd requires Node.js ≥ 22. Check
   `mcp-server/package.json` engines and `node --version` baseline.
3. **Smoke-test the SDK install on Windows**: `npm install @tobilu/qmd`
   pulls in `node-llama-cpp` which has native bindings. Build chain
   issues on Windows are the highest-risk implementation hurdle. Run a
   minimal `createStore + search` end-to-end before integrating into
   `memory.ts`.
4. **Confirm `session.send` API surface** used by `attemptAutoResolve`:
   what does it return, how do we await exit, what's the timeout
   semantics? See `plugins/dev-buddy/skills/dev-buddy/TOOLS.md`.
5. **Decide GGUF model storage**: default `~/.cache/qmd/models/` is
   fine for personal use; if a shared dev box, consider a tenant-scoped
   `dbPath` to avoid index collisions.
6. **Windows quirks**: per qmd docs, set `QMD_EMBED_PARALLELISM=1` for
   Windows CUDA stability.

# Deferred / v1.1+

- `delete_memory` / `delete_lesson` / `delete_wiki` (with soft-delete events)
- `memory_migrate(from, to)` for schema evolution
- `get_wiki_backlinks(path)` — full-corpus link scan
- Dataview body footers (auto-injected folded state for Dataview queries)
- Tag taxonomy / autocomplete (agent-side concern)
- Permission model beyond git-repo access
- Multi-machine cache reconciliation (each clone embeds independently
  today; not a problem since git is source of truth)
- `.obsidian/` vault scaffold management
- Per-vault `auto_resolve_conflicts` override via `vault.yaml`'s `memory:` block (today it's global)

# Open questions

None blocking. All decisions captured above. Specific
implementation-time decisions (test framework, sub-module boundaries,
exact SDK signature changes from qmd version drift) deferred to the
implementation plan.

# Glossary

- **Scope**: `personal` or `team`. Maps to `vault.kind` in clawdevbox's
  vault chain. Selects which vault(s) the tool operates on.
- **Vault**: A clawdevbox-registered memory store (`VaultInfo` from
  `loadVaultChain()`). Has stable `id`, on-disk `path`, `kind`
  (personal/team), and optional `remote` git URL.
- **Vault id**: The stable user-facing identifier for a vault. Also
  used as the qmd collection name. Passed as the `vault_id` tool arg
  when more than one vault of a given `kind` is registered.
- **Project**: Project slug (e.g., `clawdevbox`, `billing-service`, or
  `_general`). Top-level folder inside a vault.
- **Type**: `memory`, `lesson`, `session`, or `wiki`. Second-level
  folder inside `<project>/`.
- **Slug**: Slugified title used in filenames. Date-prefixed for
  memory/lesson/session.
- **Identity**: The actor stamped on writes and votes. Resolved as
  `git config user.email` → `git config user.name` →
  `os.userInfo().username`.
- **Folded state**: The structured summary computed by replaying an
  `.events.jsonl` log. Includes votes, confidence (lesson, decay-
  adjusted), and edit history (wiki).
- **Confidence decay**: Lesson confidence decreases over time without
  reinforcement, asymptoting to a floor. Computed at read time, never
  mutated. Formula:
  `floor + (stored - floor) * 0.5^(days_since_last_reinforce / half_life_days)`.
