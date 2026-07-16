# Deep-Dive Sub-Agent Prompt Template

After scoring identifies a candidate session, dispatch ONE `general-purpose` sub-agent per candidate using the template below. The sub-agent reads the normalized session + the skill catalog and produces a draft inbox item.

## Why a sub-agent

The main retro loop is doing many things (fetching, scoring, batching). Deep-dive analysis benefits from a focused context window per session. One sub-agent = one session = one draft.

## Template

```
You are doing a session retrospective. Read the inputs below, then produce ONE inbox-item draft.

## Inputs

1. Normalized session (JSON):
```
<paste the full normalized session object here>
```

2. Available skills (`skill.list` output):
```
<paste the JSON array of {id, name, description} for every available skill>
```

## Your task

1. Read the session turn-by-turn. Note any patterns that suggest a process gap (thrashing, no plan, premature completion, user correction).

2. Read the skill catalog. For each candidate gap, FIRST check whether an existing skill addresses it. The skill description's "Use when..." clause is your match target.

3. Classify the gap as exactly ONE of:
   - `skill-invocation-missed` (existing skill exists; agent didn't invoke it)
   - `new-skill-needed` (no existing skill covers it; pattern likely recurs)
   - `tool-missing` (an MCP tool would have eliminated repeated work)
   - `memory-needed` (a repo-scoped fact would have prevented the gap)
   - `claude-md-guidance` (a project-specific convention to document)

4. Produce the draft inbox item matching this exact schema:

```jsonc
{
  "id":          "retro-<classification>-<session.id>-<artifact-slug>",
  "title":       "<≤80 chars; names classification + artifact>",
  "preview":     "<≤160 chars; cites session.id + one-line summary>",
  "description": "<markdown — see required sections below>",
  "labels":      ["session-retro", "<classification>", ...]
}
```

### `description` required sections (in this order)

```
## Classification
<one of the 5 values>

## Missed/proposed artifact
<name/identify the artifact>

## Evidence
- Turn <N>: <what happened — brief, 1 line>
- Turn <M>: <what happened — brief, 1 line>
- (minimum TWO specific turn indices; more is better)

## Recommended action
<one paragraph: what the agent should do differently next time>
```

## Hard requirements (you will be checked against these)

- MUST check the skill catalog before classifying as `new-skill-needed`.
- MUST cite specific turn indices in the Evidence section (not "the session had failures" — WHICH turns?).
- MUST NOT propose code changes for any bug shown in the session.
- MUST NOT call any MCP write tools (inbox.upsert, store_memory, skill.upsert, etc.). Produce only the draft.
- MUST include `"session-retro"` in labels.
- MUST use the deterministic id format. No timestamps. No random suffixes.

## Output

Return ONLY the JSON object. No prose. The caller will validate and queue it for human approval.
```

## Calling the sub-agent

Use the `task` tool with `general-purpose` agent_type, `mode: "sync"` if you need the result immediately for further batching, or `mode: "background"` for parallel deep-dives across many candidates.

Per the `dispatching-parallel-agents` skill, when you have N >= 3 candidate sessions, dispatch them in parallel (one tool call per session, all in the same message).
