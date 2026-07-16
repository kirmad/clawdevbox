---
name: analyze-pr-comment
description: How to read an inbound ADO PR comment and decide whether it's a question, a change request, or an affirmation — and what response style fits each.
triggers:
  - "PR comment received"
  - "respond-to-pr-comment recipe is invoked"
  - "the user asks 'how should I handle this comment'"
---

# Analyzing a PR comment

Every ADO PR comment falls into one of three buckets. Classify it first;
the response style follows from the classification.

## 1. The three kinds

**Question.** The reviewer is asking *why*, *what*, or *how*. They want
context, not a code change.

> "Why are we catching `Error` here instead of the specific subclass?"
> "How does this interact with the retry policy in `ClientFactory`?"
> "Is there a reason you went with a Set over a Map?"

**Change request.** The reviewer is asking for code to move. They may be
direct ("rename this to ...") or hedged ("might be cleaner if ...").
Distinguishing hedge from direct request matters less than recognising
that *something needs to happen on the diff*.

> "Rename `tmp` to `pendingBatch` — `tmp` is meaningless here."
> "We should probably extract this whole branch into a helper."
> "Can you add a test for the empty-array case?"

**Affirmation.** The reviewer is noting that something is fine, or
agreeing with a prior reply. Often a thumbs-up emoji, "lgtm", "nice",
"thanks for the explanation".

Affirmations are *closures*, not work. Acknowledge briefly and move on.

## 2. Disambiguation rules

- **A question that contains a suggestion ("...have you considered X?")**
  is a question first. Answer the *why*; then offer to apply X if the
  reviewer wants. Don't pre-emptively edit the code — that escalates a
  question into an unrequested change.
- **A change request phrased as a question ("can you rename this?")** is
  a change request. The question mark is politeness, not uncertainty.
- **A multi-paragraph comment** often contains one of each. Treat each
  paragraph independently. The reply mirrors the structure.

## 3. Response style by kind

| Kind | Tone | Action | Use `approval.request`? |
|---|---|---|---|
| Question | Crisp, grounded in the diff. Cite line numbers. | Reply via `ado.comment_pr`. No code change. | No. |
| Change request | Direct. Acknowledge, then state your plan. | Draft the change, run `approval.request` so the user can approve/reject/edit, then apply. | **Yes** — never apply code changes silently. |
| Affirmation | Two words. "Thanks!" or a thumbs-up reply. | Reply via `ado.comment_pr`. | No. |

## 4. Linking back to the recipe

When invoked from the `respond-to-pr-comment` recipe (whether inline from
`pr-review` or by the `ado-comment-watcher` trigger), follow the recipe's
step ordering. This skill is the *style guide* — the recipe is the
sequence. Don't restate the recipe's steps in your reply; just apply the
right tone and structure.

## 5. What not to do

- **Don't argue.** If the reviewer pushes back, acknowledge first, then
  state your reasoning, then ask "do you still want me to revise?"
  Clawdevbox surfaces the disagreement to the user via the inbox card.
- **Don't quote the entire comment back.** A short paraphrase ("on your
  question about `Error` catching: ...") is enough; the comment is right
  above your reply on the PR.
- **Don't auto-resolve threads.** Leave that to the human author of the
  PR. Clawdevbox only writes comments; the user clicks "resolve".
