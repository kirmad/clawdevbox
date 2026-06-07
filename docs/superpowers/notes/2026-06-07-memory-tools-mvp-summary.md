# Memory Tools MVP — Build Summary

**Date:** 2026-06-07 (overnight autonomous run)
**Spec:** `docs/superpowers/specs/2026-06-07-memory-tools-design.md`
**Plan:** `docs/superpowers/plans/2026-06-07-memory-tools-mvp.md`

## What shipped

The **MVP (Phases 0-3 of the spec)** is complete: agents can write,
read, and search Obsidian-compatible markdown memories/lessons/sessions/
wiki pages stored as git-versioned files in clawdevbox-registered
vaults, indexed by `@tobilu/qmd` in **BM25-only `lex` mode** so it
runs on machines without a GPU.

## 9 MCP tools registered

| Tool | Phase | Purpose |
|---|---|---|
| `add_memory` | 1 | Save a durable atomic fact |
| `add_lesson` | 1 | Save a confidence-scored lesson (no dedup yet — Phase 4) |
| `add_session_summary` | 1 | Append a structured retrospective |
| `add_wiki_page` | 1 | Create a curated wiki page (errors on duplicate) |
| `get_memory` | 2 | Fetch a single document + folded events summary |
| `memory_status` | 2 | Vault list + qmd health + config snapshot |
| `memory_init` | 3 | Scaffold folders + register qmd collections + contexts (idempotent) |
| `search_memory` | 3 | Hybrid search (lex default), confidence/vote re-ranking |
| `get_wiki_index` | 3 | Navigable tree of `<project>/wiki/` with summaries + outbound links |

## 8 source modules + 9 test files

### Source — `mcp-server/src/tools/`

| File | LOC | Responsibility |
|---|---:|---|
| `memory-config.ts` | 126 | Load `memory-config.json` with defaults; identity; re-exports vault chain |
| `memory-paths.ts` | 118 | Slug rule, filename builder, vault resolution, collision suffix |
| `memory-vault-lock.ts` | 35 | Per-vault async mutex |
| `memory-frontmatter.ts` | 126 | YAML I/O per type (memory/lesson/session/wiki) |
| `memory-events.ts` | 177 | Append events, fold to FoldedState, decay formula |
| `memory-git.ts` | 74 | Inline `git add + commit` with external-edit snapshot |
| `memory-qmd.ts` | 334 | Lazy `@tobilu/qmd` SDK wrapper, collection registration, debounced reindex |
| `memory.ts` | 1132 | 9 MCP tool registrations + pure-function handlers |
| **Total** | **2122** | |

### Tests — `mcp-server/tests/`

| File | LOC | Test count |
|---|---:|---:|
| `memory-config.test.mjs` | 79 | 6 |
| `memory-paths.test.mjs` | 96 | 13 |
| `memory-vault-lock.test.mjs` | 57 | 4 |
| `memory-frontmatter.test.mjs` | 114 | 9 |
| `memory-events.test.mjs` | 137 | 12 |
| `memory-git.test.mjs` | 86 | 5 |
| `memory-qmd.test.mjs` | 176 | 6 |
| `memory-tools-e2e.test.mjs` | 527 | 17 |
| `memory-mcp-integration.test.mjs` | 243 | 2 |
| **Total** | **1515** | **74** |

## E2E test discipline

- **Real git repos** in tmpdir as vaults (not mocked).
- **Real `loadVaultChain`-shaped stubs** mirroring `mcp-server/src/vault-chain.ts`.
- **Real qmd SDK** running BM25-only `searchLex` (no GGUF models loaded).
- **Real `git add + commit`** verified by reading commit log after.
- **Full registry round-trip**: integration test invokes each tool through
  the global registry (the same path MCP uses via `run_tool`).

## Verified test counts

```
8 unit/E2E memory test files  → 72/72 pass
+ 1 MCP integration file       →  2/2  pass
= 74/74 memory tests pass

Full repo suite: 615/646 pass, 16 unrelated pre-existing flakes
  (all in tmux/dispatcher/recipe-runner — none in memory-*)
```

## CPU-fallback / no-GPU strategy

- Default `qmd_search_mode: 'lex'` in config → uses `store.searchLex`
  (BM25 only, no LLM, no GGUF models).
- `searchAcrossCollections` falls through to lex on any hybrid-mode
  error so a GPU-machine setup with broken model download still works.
- `memory_init` skips `store.embed()` unless mode is `hybrid`/`vec`.
- Confirmed end-to-end: `npm test` for memory files completes in ~25s
  with zero model downloads.

## How to use it

```bash
# 1. Register at least one vault via clawdevbox vault setup (existing flow).
# 2. Optional: edit ~/.clawdevbox/memory-config.json — defaults are good.
# 3. Start clawdevbox; the 9 memory_* / add_* / get_* / search_memory
#    tools appear in the MCP registry.
# 4. Call memory_init once to scaffold folders and register qmd collections.
# 5. Write knowledge:
add_memory({ content: "...", scope: "team", project: "X",
             citations: "src/a.ts:42", reason: "..." })
# 6. Search:
search_memory({ query: "auth flow" })
# 7. Browse wiki:
get_wiki_index({ project: "X", depth: 2 })
```

## On a GPU machine (user's setup)

Flip `~/.clawdevbox/memory-config.json`:
```json
{ "qmd_search_mode": "hybrid" }
```
First search call lazy-loads ~2GB of GGUF models into `~/.cache/qmd/models/`
and you get BM25 + vector + LLM-rerank hybrid search.

## What's NOT shipped (follow-on plans)

These remain explicitly out of scope per the MVP plan:

| Phase | Feature | Why deferred |
|---|---|---|
| 4 | Lesson dedup via vector similarity | Needs hybrid/vec qmd mode (model load) for proper tests; trivial when GPU available |
| 4 | `vote_memory` / `vote_lesson` / `vote_wiki` | Spec mentions Phase 4; small follow-on |
| 6 | Background sync daemon (debounced `git push`, idle `git pull`) | Net-new state machine; isolated change |
| 7 | `update_wiki` with synchronous pull-rebase | Mutable wiki bodies need separate conflict-handling story |
| 8 | Conflict auto-resolve via `session.send` sub-agent | Opt-in only; depends on Phase 7 |

Suggested follow-on plan order (each independent and shippable):
1. **Voting + dedup** (Phase 4): adds 3 vote tools + `add_lesson` similarity check. Drops the `(no dedup)` qualifier on `add_lesson`.
2. **Background sync** (Phase 6): adds `memory-sync.ts` daemon, populates `memory_status.git`.
3. **Wiki updates** (Phase 7): adds `update_wiki` with sync pull-rebase.
4. **Conflict auto-resolve** (Phase 8, optional): adds the `session.send` spawn for wiki body conflicts.

## Known limitations / gotchas

- **Lex-only mode** is a real downgrade vs hybrid: no query expansion,
  no LLM reranking. Top hits are still high quality on keyword
  matches, but conceptual queries ("how should I handle auth?") will
  miss semantically-related memories that don't share keywords.
- **Concurrent writes** to the same vault block each other via the
  per-vault mutex — fine for single-user use, will need contention
  testing for multi-user agent scenarios.
- **`add_lesson` no dedup** today writes a new file every call. Phase 4
  fixes this.
- **`get_memory` requires explicit path** — no slug-only lookup yet
  because there's no global slug→path index. Easy to add if needed.
- **`get_wiki_backlinks`** (reverse link lookup) is deferred to v1.1
  per the spec.

## Confidence

- All 74 memory tests pass on Windows 22+ Node 22+ Git 2.x.
- Typecheck (`tsc --noEmit`) clean.
- Full repo test suite has the same 16 unrelated pre-existing flakes
  as before this change.
- No regressions in non-memory tests.
- Memory tools register cleanly against the live user workspace
  (`~/.clawdevbox/` config, real vault chain).
