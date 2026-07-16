# Artifact Comment Reply Chains + State

**Date:** 2026-06-16  
**Status:** Approved

## Problem

When users leave comments on artifacts, the agent receives them as a markdown bundle but has no way to:
1. Reply to individual comments (creating a conversation thread)
2. Update comment state (mark as resolved, in-progress)

Comments are currently fire-and-forget from the agent's perspective.

## Design

### 1. Dispatch format change (overlay → agent)

`buildMarkdownBundle()` in `_comment-overlay.mjs` embeds the comment id:

**Before:**
```
— Comment 1 (on §"Introduction"):
> Fix the typo here
```

**After:**
```
— Comment 1 [id: c_abc12345] (on §"Introduction"):
> Fix the typo here
```

Backward-compatible — agents that don't parse `[id: ...]` still get readable markdown.

### 2. New MCP tool: `artifact.comment_reply`

```ts
{
  artifact_id: string,       // required — which artifact
  comment_id: string,        // required — the c_xxxx id from the bundle
  reply: string,             // the agent's response text
  state?: 'in_progress' | 'resolved',  // optional state transition
}
```

Behavior:
1. Reads drafts from `/api/store/artifact-comments/<artifact_id>`
2. Finds the comment by id
3. Appends a reply to the comment's `replies` array
4. Updates `comment.state` if provided
5. Persists back to the store
6. Emits a `change` SSE event so the overlay refreshes

### 3. Comment data model extension

Each draft gains two optional fields:

```ts
{
  // ...existing fields (id, created_at, updated_at, anchor, comment, sent, sent_at)
  state?: 'open' | 'in_progress' | 'resolved',  // default: 'open'
  replies?: Array<{
    id: string,           // auto-minted (r_xxxx)
    author: 'agent',
    text: string,
    created_at: string,   // ISO timestamp
  }>
}
```

### 4. UI changes (overlay sidebar)

- **State badge** on each comment card: colored chip next to the anchor label
  - `open`: no badge (default)
  - `in_progress`: blue chip "In progress"
  - `resolved`: green chip "Resolved" + dimmed card
- **Reply thread** below the comment body: agent replies rendered as indented bubbles with distinct styling (agent avatar/color, timestamp)
- Resolved comments get reduced opacity (0.7) but remain visible

### 5. Backward compatibility

- Comments without `state`/`replies` render unchanged
- Old markdown bundles without `[id: ...]` still dispatch fine
- The MCP tool is purely additive
