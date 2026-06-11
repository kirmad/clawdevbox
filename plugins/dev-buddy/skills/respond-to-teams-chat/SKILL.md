---
name: respond-to-teams-chat
description: Use when the user asks you to "respond to this Teams chat", "draft a reply", "compose a chat reply", "respond on Teams", or paste in a Teams thread for you to answer. Keeps replies short and scannable; escalates to artifacts for long content and to a spawned recipe session for implementation work.
---

# Respond to Teams chat

You are drafting a reply to a Microsoft Teams chat message. Teams chat is a
**casual, async, mobile-first** medium. Walls of text get skimmed; tables
get mangled; nested lists get flattened. Your reply has to be **clear at a
glance** and easy to skim on a phone.

## When to use

- The user pasted a Teams chat message and asked you to reply.
- The user said "respond on chat", "compose a chat reply", "reply to this
  thread", "what should I say to X".
- Output is going to a Teams composer (1:1 chat, group chat, or channel
  reply).

**Do NOT use for:**

- Email drafts (different medium, longer-form OK).
- ADO PR comments (use the `analyze-pr-comment` skill instead).
- Inbox replies inside clawdevbox (those go through `inbox.reply`).

## The 3-tier decision

Decide the reply tier BEFORE you start writing.

```
┌─────────────────────────┬─────────────────────────────────────────────┐
│ Tier                    │ How to deliver                              │
├─────────────────────────┼─────────────────────────────────────────────┤
│ 1. SHORT (≤4 lines)     │ Plain text in the chat. Done.               │
│ 2. ELABORATE            │ One-line chat summary + artifact URL.       │
│    (long, has tables,   │ Use artifact.add for the long content.      │
│    code, walkthroughs)  │                                             │
│ 3. IMPLEMENTATION       │ One-line chat ack + spawn a recipe session  │
│    (build feature,      │ that does the actual work. Share the        │
│    refactor, fix bug,   │ session URL (or wait for its artifact).     │
│    investigate)         │                                             │
└─────────────────────────┴─────────────────────────────────────────────┘
```

**Default to Tier 1.** Most Teams replies should be ≤4 lines. If you're
about to type more, ask yourself: "is the reader going to read this on
their phone in the elevator?" If no, escalate to Tier 2 or 3.

## Tier 1 — Short reply (the default)

Hard rules:

1. **≤4 lines.** If you can't fit it in 4 lines, escalate.
2. **Lead with the answer.** First sentence = the conclusion / decision /
   next step. Justification (if any) follows.
3. **One thought per line.** No semicolon-soup.
4. **Inline code spans (`` `like this` ``) for identifiers, file names,
   PR numbers, build ids. Never paste a fenced multi-line code block in
   tier 1 — that's a tier 2 trigger.
5. **Use the person's vocabulary.** Mirror their phrasing, not yours.
   "ECS" if they wrote "ECS"; "feature flag" if they wrote "feature
   flag".
6. **Bullets only when you have 3+ parallel items.** Two items just go
   inline ("X and Y").
7. **No headings.** Headings in chat look like shouting and don't render
   on mobile in some clients.

Allowed markdown that renders cleanly in Teams:

- `**bold**`, `*italic*`, `` `code` ``
- `[link text](url)` — but for raw URLs, paste the URL directly so Teams
  unfurls it (often more useful than a link).
- `- bullet` (single level only — Teams flattens nested lists).
- `> quote` for one-line context references.

Avoid:

- Tables (Teams renders them as flat pipe-delimited text on mobile).
- Fenced code blocks (` ``` `) for anything > 5 lines.
- Numbered lists with explanations (the numbers get lost). Bullets are
  better.
- Emoji unless the chat is clearly casual and the user already uses them.

## Tier 2 — Elaborate reply via artifact

Trigger when the answer needs ANY of: tables, multi-line code, a
walkthrough, a numbered procedure with > 3 steps, a screenshot/diagram
description, or > ~300 words of prose.

**Pattern:**

1. Write the full content as markdown (or HTML for richer layout).
2. Call `artifact.add` with `type: "markdown"` and the content as
   `files: { "content.md": "..." }`. (Or `type: "walkthrough"` for a
   guided multi-step doc.)
3. The tool returns a `view_url`. Paste THAT into the chat with a
   one-line teaser:

   > "Wrote it up — full details here: <view_url>. TL;DR: <one sentence>."

Use HTML when the content needs layout the markdown renderer can't give
you (multi-column comparison, collapsible sections, syntax-highlighted
code with line numbers): write `files: { "content.html": "..." }` and
set `type` to a custom HTML renderer if you've added one, otherwise
keep `type: "markdown"` and link to the HTML file directly inside
content.md.

## Tier 3 — Implementation work via spawned session

Trigger when the request would require **doing**, not just describing:
"build X", "fix Y", "investigate why Z is happening", "ship a config
change", "draft the PRD", anything with verbs of action that you would
otherwise spend > 10 minutes on yourself.

**Don't** start implementing inside this current session. The user is
in a chat — they expect a quick ack and the work to happen in the
background.

**Pattern:**

1. Identify the right recipe. The common ones:
   - `implement-work-item` — pick up an ADO WI, plan, implement, PR.
   - `forge-prd-draft` — draft a PRD for an Epic.
   - `forge-spec-handoff` — spec-to-implementation handoff.
   - For investigation, use `session.send` with a fresh agent (no
     recipe), passing the question as the prompt.
2. Spawn:
   - For a recipe: `recipe.instance.begin({ recipe_id: "<id>", args: {...} })`.
   - For a free-form investigation: `session.send({ prompt: "...", agent: "copilot" })`.
3. Reply in chat with the spawned session's URL or a one-line ack:

   > "Picked up — running in a fresh session. I'll ping back here when
   > the PR / artifact is ready. Session: <url>."

4. Optionally register an inbox alert with `inbox.upsert` so the spawned
   session can post its result back to you (and the user) when done.

## Worked examples

### Tier 1 — short factual

> **Them:** "Is the malformed-UIO backfill flag landed yet?"
>
> **You:** "Not yet — PR `4582534` is in review. Should merge today and
> roll out behind the `RepairUIOFromBackfill` ECS flag (default off).
> I'll ping when it's safe to enable."

### Tier 1 — short decision

> **Them:** "Should we ship this in CY26 H2 or wait for H1 next year?"
>
> **You:** "H2 this year. The customer commitment is Q3, and the
> dependency on `MeetingCollab` ships in H2 anyway. Bumping it would
> stretch the commit by 6 months."

### Tier 2 — too long for chat, used artifact

> **Them:** "Can you write up the design for the UIO backfill flag?"
>
> **You [in chat]:** "Wrote it up — full design here:
> https://localhost/.../wi-4582534-uio-backfill-design. TL;DR: one ECS
> flag, opt-in per-tenant, idempotent backfill job, no data loss path."
>
> **What happened behind the scenes:** called `artifact.add` with
> `type: "markdown"`, `id: "wi-4582534-uio-backfill-design"`, and a
> `content.md` file containing the full design doc.

### Tier 3 — implementation work, spawned

> **Them:** "Can you go fix the malformed-UIO backfill bug and put up a
> PR by EOD?"
>
> **You [in chat]:** "Picked up — running in a fresh session against
> WI `4582534`. I'll post the PR link back here when it's ready.
> Session: https://localhost/.../sessions/wi-4582534."
>
> **What happened behind the scenes:** called
> `recipe.instance.begin({ recipe_id: "implement-work-item",
> args: { work_item_id: 4582534 } })`. Optionally wired an
> `inbox.upsert` so the spawned session pings back when the PR opens.

## Anti-patterns

- **Tier-creep.** Don't pad a tier 1 answer to look thorough. "Yes" is
  a complete reply if the question is yes/no.
- **Mid-tier indecision.** Don't paste 15 lines of plain text "because
  it's not THAT long". 15 lines on mobile is a wall. Either trim to 4
  or escalate to an artifact.
- **Implementing inline when asked to ship.** If the user said "fix
  it", spawn — don't try to fix it in the current chat-reply session.
  You'll lose the user's attention and the work will be half-done when
  they come back.
- **Headings in chat.** `## My answer` looks like a doc, not a chat.
  Save headings for the artifact.
- **Walls of bullets.** Use prose for 1-2 items. Bullets only when
  parallel structure helps scanning.
- **Pasting raw stack traces.** Trim to the relevant 3-5 lines and
  inline-code them, OR escalate to an artifact.
- **Forgetting the TL;DR.** When you escalate to tier 2, the chat
  message MUST still convey the bottom line. Don't make the reader
  click through to learn the answer to a yes/no question.

## Quick checklist before you hit Send

- [ ] First sentence states the answer / decision / next step?
- [ ] ≤4 lines for tier 1, OR a one-line teaser + URL for tier 2/3?
- [ ] No tables / multi-line code blocks / headings in the chat text?
- [ ] Identifiers wrapped in `` ` `` so they don't get autolinked weirdly?
- [ ] If tier 3: spawned, NOT promised in the chat as future work I'll
      do "later" in this session?
