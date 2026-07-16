# Memory Vault Sync Trigger — Design Spec

**Date:** 2026-06-17
**Status:** Draft

## Summary

A cron trigger (`memory-sync`) that runs every 30 minutes and manages bidirectional git sync for personal and team memory vaults. It commits local changes with meaningful agent-authored commit messages, fetches from origin (when configured), audits incoming changes for malicious content, auto-resolves merge conflicts, and always notifies the user via inbox.

## Scope

- Personal vault (`~/.clawdevbox/personal-vault/`)
- Team vault (`~/.clawdevbox/team-vault/`) — may or may not have a remote

Both local-only (no remote) and remote-backed vaults are handled. Local-only vaults only get the commit step.

## Flow

```
Cron fires (*/30 * * * *)
│
├─ For each vault (personal, team):
│
│  1. DETECT LOCAL CHANGES
│  │  └─ `git status --porcelain`
│  │     ├─ No changes → skip to step 2
│  │     └─ Has changes:
│  │        ├─ `git diff` (staged + unstaged)
│  │        ├─ Agent reviews diff → writes meaningful commit message
│  │        └─ `git add -A && git commit -m "<message>"`
│  │
│  2. CHECK FOR REMOTE
│  │  └─ `git remote get-url origin`
│  │     ├─ No remote → done for this vault
│  │     └─ Has remote → continue
│  │
│  3. FETCH + CHECK INCOMING
│  │  └─ `git fetch origin`
│  │  └─ `git log HEAD..origin/main --oneline`
│  │     ├─ No incoming commits → skip to step 5
│  │     └─ Has incoming commits:
│  │        ├─ Get diff: `git diff HEAD...origin/main`
│  │        ├─ AUDIT: scan for malicious content
│  │        │   ├─ SAFE → auto-pull (step 4)
│  │        │   └─ BLOCKED → inbox notification, wait for user
│  │        └─ Send inbox notification (always, even if safe)
│  │
│  4. PULL + AUTO-RESOLVE CONFLICTS
│  │  └─ `git pull --rebase origin main`
│  │     ├─ Clean → done
│  │     └─ Conflicts:
│  │        ├─ For each conflicted file:
│  │        │   Strategy: accept both (concatenate), preferring incoming
│  │        │   for metadata/frontmatter, keeping both bodies
│  │        ├─ `git add <resolved>` + `git rebase --continue`
│  │        └─ Log resolution in inbox notification
│  │
│  5. PUSH (if local ahead)
│     └─ `git push origin main`
│        ├─ Success → done
│        └─ Rejected → fetch + rebase + retry once
```

## Audit Rules (Incoming Content)

The audit scans the incoming diff for:

1. **Prompt injection patterns** — content designed to override agent instructions (e.g., "ignore all previous instructions", system prompt markers)
2. **Credential-like strings** — patterns matching API keys, tokens, passwords (regex-based)
3. **Suspicious encoded payloads** — large base64 blobs, hex-encoded shellcode patterns
4. **Executable content** — shell commands disguised as memory notes, script blocks that would execute on read

If ANY rule triggers, the pull is **blocked** and the user is notified with specifics.

## Inbox Notifications

### Safe pull (informational)
```
Title: "Memory sync: team-vault — 3 new commits"
State: new
Labels: [memory, sync, team-vault]
Body: Summary of what was pulled (file list + commit messages)
```

### Local commit (informational)
```
Title: "Memory sync: committed local changes in personal-vault"
State: new  
Labels: [memory, sync, personal-vault]
Body: Commit message + files changed
```

### Blocked pull (actionable)
```
Title: "⚠️ Memory sync: suspicious content in team-vault"
State: new
Labels: [memory, sync, security, team-vault]
Body: What triggered the block, which files, which patterns matched
Questions:
  - "Pull anyway — I trust this content"
  - "Reject — do not pull these commits"
  - "Show me the full diff" (opens an artifact)
Dispatch: session_id → agent session that handles the user's choice
```

### Conflict resolution (informational)
```
Title: "Memory sync: auto-resolved N conflicts in personal-vault"
Labels: [memory, sync, conflict, personal-vault]
Body: Which files conflicted, how they were resolved
```

## Merge Conflict Resolution Strategy

Memory vault files are markdown notes with YAML frontmatter. Resolution strategy:

1. **Frontmatter conflicts:** Accept incoming (remote) version — it likely has newer metadata (confidence scores, timestamps, vote counts).
2. **Body conflicts:** Concatenate both versions with a separator comment `<!-- merge: local kept below, remote above -->`. The next agent review pass can clean this up.
3. **New files on both sides:** Both kept (no conflict).
4. **Deleted on one side, modified on other:** Keep the modified version.

## Trigger Registration

```yaml
id: memory-sync
type: script
cron: "*/30 * * * *"
script: triggers/memory-sync.ts
description: "Periodic memory vault git sync — commit, fetch, audit, pull, push"
params: {}
```

The trigger script is a TypeScript file executed by the trigger runner. It uses the clawdevbox MCP tools (`memory.status`, `memory.sync`, `inbox.upsert`) via HTTP calls to the local server, plus direct git commands for fine-grained control.

## Implementation Components

1. **`triggers/memory-sync.ts`** — the trigger script (main orchestrator)
2. **`src/memory-sync.ts`** — shared logic: audit function, conflict resolver, diff summarizer
3. **Registration** — auto-registered on `clawdevbox start` if not already present (idempotent)
4. **Config** — `memory-config.json` gains:
   - `sync.cron`: override schedule (default `*/30 * * * *`)
   - `sync.auto_push`: boolean (default true)
   - `sync.audit_rules`: array of rule ids to enable/disable

## Edge Cases

- **No vaults exist:** Skip silently.
- **Vault has no `.git`:** Skip (not git-managed).
- **Remote unreachable (network down):** Log warning, skip fetch/push, retry next cycle.
- **Push rejected after rebase:** Retry once; if still rejected, notify user via inbox.
- **Agent can't determine commit message (empty diff?):** Use fallback `"memory: sync <ISO timestamp>"`.
- **Very large diffs (>50 files):** Summarize as "N files changed" rather than listing each.

## Non-Goals

- Real-time file watching (explicitly out of scope — cron only).
- Conflict resolution UI (auto-resolve only; user can manually fix if unhappy).
- Multi-remote support (only `origin` is synced).
- Branch management (assumes single branch, typically `main`).
