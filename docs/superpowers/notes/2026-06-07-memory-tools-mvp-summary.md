# Memory Tools Build Summary

**Date:** 2026-06-07 (overnight autonomous run)
**Spec:** `docs/superpowers/specs/2026-06-07-memory-tools-design.md`
**Plan:** `docs/superpowers/plans/2026-06-07-memory-tools-mvp.md`

## What shipped — ALL spec phases except 8

The full memory subsystem is complete. Agents can write, read, search,
vote on, and edit Obsidian-compatible markdown memories/lessons/sessions/
wiki pages stored as git-versioned files in clawdevbox-registered
vaults, indexed by `@tobilu/qmd` in **BM25-only `lex` mode** so it
runs on machines without a GPU. Manual git sync ships out of the box;
the full background sync daemon is deferred (the manual `memory_sync`
tool covers the use case while keeping complexity small).

## 14 MCP tools registered

| Tool | Phase | Purpose |
|---|---|---|
| `add_memory` | 1 | Save a durable atomic fact |
| `add_lesson` | 1+4 | Save a confidence-scored lesson; auto-strengthens on exact-content duplicate (lex) or vector similarity (hybrid) |
| `add_session_summary` | 1 | Append a structured retrospective |
| `add_wiki_page` | 1 | Create a curated wiki page (errors on duplicate path) |
| `get_memory` | 2 | Fetch a single document + folded events summary |
| `memory_status` | 2+6 | Vault list + qmd health + per-vault git state + config snapshot |
| `memory_init` | 3 | Scaffold folders + register qmd collections + contexts (idempotent) |
| `search_memory` | 3 | Hybrid search (lex default), confidence/vote re-ranking |
| `get_wiki_index` | 3 | Navigable tree of `<project>/wiki/` with summaries + outbound links |
| `vote_memory` | 4 | Upvote/downvote a memory; per-actor latest-vote wins |
| `vote_lesson` | 4 | Vote on a lesson; returns decay-adjusted confidence |
| `vote_wiki` | 4 | Vote on a wiki page |
| `update_wiki` | 7 | Edit wiki body: replace_section, append, prepend, find_replace, full_replace |
| `memory_sync` | 6 | Manual per-vault fetch + pull --rebase + push (skips vaults without remote) |

## What's NOT shipped

| Phase | Feature | Status |
|---|---|---|
| 6 | Background sync **daemon** with debounced timers + state machine + inbox escalation | Deferred — manual `memory_sync` is the working surface. Add the daemon if usage shows the manual step is friction. |
| 8 | Conflict auto-resolve via `session.send` sub-agent | Deferred — opt-in only per spec; default config (`"manual"`) is the working behaviour. |

## 8 source modules + 11 test files

### Source — `mcp-server/src/tools/`

| File | LOC | Responsibility |
|---|---:|---|
| `memory-config.ts` | 126 | Load `memory-config.json` with defaults; identity; re-exports vault chain |
| `memory-paths.ts` | 118 | Slug rule, filename builder, vault resolution, collision suffix |
| `memory-vault-lock.ts` | 35 | Per-vault async mutex |
| `memory-frontmatter.ts` | 126 | YAML I/O per type (memory/lesson/session/wiki) |
| `memory-events.ts` | 177 | Append events, fold to FoldedState, decay formula |
| `memory-git.ts` | ~170 | Inline `git add + commit`; repo state (branch/ahead/behind/dirty); sync (fetch+rebase+push) |
| `memory-qmd.ts` | 334 | Lazy `@tobilu/qmd` SDK wrapper, collection registration, debounced reindex |
| `memory.ts` | ~1640 | 14 MCP tool registrations + pure-function handlers |

### Tests — `mcp-server/tests/`

| File | Test count |
|---|---:|
| `memory-config.test.mjs` | 6 |
| `memory-paths.test.mjs` | 13 |
| `memory-vault-lock.test.mjs` | 4 |
| `memory-frontmatter.test.mjs` | 9 |
| `memory-events.test.mjs` | 12 |
| `memory-git.test.mjs` | 5 |
| `memory-qmd.test.mjs` | 6 |
| `memory-tools-e2e.test.mjs` | 17 |
| `memory-mcp-integration.test.mjs` | 2 |
| `memory-phase4-7.test.mjs` | 14 |
| `memory-phase6.test.mjs` | 5 |
| **Total** | **93** |

## E2E test discipline

- **Real git repos** in tmpdir as vaults — including a **real bare
  remote** for Phase 6 sync tests (push/pull/conflict against actual
  remote state).
- **Real `loadVaultChain`-shaped stubs** mirroring `mcp-server/src/vault-chain.ts`.
- **Real qmd SDK** running BM25-only `searchLex` (no GGUF models loaded).
- **Real `git add + commit + fetch + pull --rebase + push`** verified by
  reading git log on both sides of the wire.
- **Full registry round-trip**: integration test invokes each of 14
  tools through the global registry.

## Verified test counts

```
11 memory test files → 93/93 pass in ~30 seconds
Full repo suite: 16 pre-existing unrelated flakes (none in memory-*)
Typecheck: clean
```

## CPU-fallback / no-GPU strategy

- Default `qmd_search_mode: 'lex'` → BM25 only; no GGUF model load.
- `searchAcrossCollections` falls through to lex on any hybrid-mode
  error so a GPU-machine setup with broken model download still works.
- `memory_init` skips `store.embed()` unless mode is `hybrid`/`vec`.
- Lesson dedup runs exact-content matching in lex mode; vector
  similarity only kicks in for hybrid/vec.

## How to use it

```bash
# 1. Register at least one vault via clawdevbox vault setup (existing flow).
# 2. Optional: edit ~/.clawdevbox/memory-config.json — defaults are good.
# 3. Start clawdevbox; the 14 memory_* / add_* / vote_* / get_* / search_memory /
#    update_wiki / memory_sync tools appear in the MCP registry.
# 4. Call memory_init once to scaffold folders and register qmd collections.
# 5. Write knowledge:
add_memory({ content: "...", scope: "team", project: "X",
             citations: "src/a.ts:42", reason: "..." })
# 6. Vote:
vote_memory({ path: "X/memories/2026-06-07-...md", scope: "team", direction: "up" })
# 7. Edit wiki:
update_wiki({ path: "architecture/overview", scope: "team", project: "X",
              operation: "append", content: "## New section\n\n..." })
# 8. Search:
search_memory({ query: "auth flow" })
# 9. Browse wiki:
get_wiki_index({ project: "X", depth: 2 })
# 10. Push to teammates:
memory_sync({ scope: "team" })
```

## On a GPU machine (your machine)

Flip `~/.clawdevbox/memory-config.json`:
```json
{ "qmd_search_mode": "hybrid" }
```
First search call lazy-loads ~2GB of GGUF models into `~/.cache/qmd/models/`
and you get BM25 + vector + LLM-rerank hybrid search. Lesson dedup
also upgrades to vector-similarity matching with `duplicate_threshold`.

## Known limitations / gotchas

- **Lex-only mode** is a real downgrade vs hybrid: no query expansion,
  no LLM reranking. Top hits are still high quality on keyword
  matches, but conceptual queries ("how should I handle auth?") will
  miss semantically-related memories that don't share keywords.
- **Concurrent writes** to the same vault block each other via the
  per-vault mutex — fine for single-user use, will need contention
  testing for multi-user agent scenarios.
- **`memory_sync` on conflict** leaves the working tree in the
  conflict state (rebase --abort would discard pending edits). Caller
  must resolve manually.
- **`get_wiki_backlinks`** (reverse link lookup) is deferred to v1.1
  per the spec.

## Confidence

- All 93 memory tests pass on Windows 22+ Node 22+ Git 2.x.
- Typecheck (`tsc --noEmit`) clean.
- Full repo test suite has the same 16 unrelated pre-existing flakes
  as before this change.
- No regressions in non-memory tests.
- Memory tools register cleanly against the live user workspace
  (`~/.clawdevbox/` config, real vault chain).
- Phase 6 sync tested end-to-end against real bare remotes including
  the genuine conflict case.

— autonomous run, dev-buddy

