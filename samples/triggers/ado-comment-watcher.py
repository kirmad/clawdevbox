#!/usr/bin/env python3
"""
ado-comment-watcher.py

Same trigger as ado-comment-watcher.ts, written in Python.

Demonstrates that the Conductor trigger protocol is language-agnostic:
  - stdin:  one JSON envelope
  - env:    CONDUCTOR_MCP_URL, CONDUCTOR_MCP_SECRET (required for Mode B POSTs),
            ADO_ORG, ADO_BEARER_TOKEN (preferred) or ADO_PAT (fallback)
  - stdout: { state, systemMessage } JSON  (no `callback` field — Mode B)
  - exit:   0 ok, 2 blocking error, other non-blocking error

Two execution modes are supported by the protocol — this script uses Mode B.

  Mode A (NOT used here): respond via stdout.
    Set a single `callback: { body: {...} }` object on the JSON response.
    Conductor delivers that one entry to env["callback_url"]. Mode A's
    `callback` is SINGULAR (at most one delivery per run).

  Mode B (USED HERE): script POSTs to env["callback_url"] directly during
    the run, once per detected event. Required when a single run may need
    to deliver more than one event. The stdout response carries only
    `{ state, systemMessage }` — no `callback`.

To use, register this trigger in .conductor/triggers.json with:
  "command": "python3 $CONDUCTOR_PROJECT_DIR/.conductor/triggers/ado-comment-watcher.py"

Standard library only — no `requests`, no `httpx`, no SDK. Just `urllib`,
`json`, `os`, `sys`, `base64`. Runs on any Python 3.8+.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any
from datetime import datetime


# ============================================================================
# Config from env
# ============================================================================

ADO_ORG = os.environ.get("ADO_ORG", "")
ADO_PAT = os.environ.get("ADO_PAT", "")
ADO_BEARER_TOKEN = os.environ.get("ADO_BEARER_TOKEN", "")

# Mode B requires this for the Authorization header on direct callback POSTs.
CONDUCTOR_MCP_SECRET = os.environ.get("CONDUCTOR_MCP_SECRET", "")


def ado_auth_header() -> str:
    """Bearer token preferred; PAT (basic auth) as fallback."""
    if ADO_BEARER_TOKEN:
        return f"Bearer {ADO_BEARER_TOKEN}"
    if ADO_PAT:
        return "Basic " + base64.b64encode(f":{ADO_PAT}".encode()).decode()
    raise RuntimeError("ADO_BEARER_TOKEN or ADO_PAT environment variable required")


# ============================================================================
# I/O helpers
# ============================================================================

def write_stdout(response: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(response))


def blocking_error(reason: str) -> None:
    sys.stderr.write(f"{reason}\n")
    sys.exit(2)


# ============================================================================
# ADO client (stdlib urllib — bearer token preferred, basic-auth with PAT fallback)
# ============================================================================

def list_pr_comments(repo: str, pr_id: int, since_id: int) -> list[dict[str, Any]]:
    """Return ADO PR comments with id > since_id, sorted ascending by id."""
    if not ADO_ORG:
        raise RuntimeError("ADO_ORG environment variable required")

    url = (
        f"https://dev.azure.com/{ADO_ORG}/_apis/git/repositories/"
        f"{urllib.parse.quote(repo)}/pullRequests/{pr_id}/threads"
        f"?api-version=7.1-preview.1"
    )

    req = urllib.request.Request(url, headers={"Authorization": ado_auth_header()})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ADO {e.code}: {e.read().decode(errors='replace')}") from e

    comments: list[dict[str, Any]] = []
    for thread in body.get("value", []):
        for c in thread.get("comments", []):
            if c.get("commentType") == "system":
                continue                       # skip status changes, votes
            cid = c.get("id")
            if cid is None or cid <= since_id:
                continue                       # already-seen
            author = c.get("author") or {}
            comments.append({
                "id": cid,
                "content": c.get("content") or "",
                "author": {
                    "uniqueName": author.get("uniqueName"),
                    "displayName": author.get("displayName"),
                },
                "publishedDate": c.get("publishedDate") or datetime.utcnow().isoformat() + "Z",
            })

    comments.sort(key=lambda c: c["id"])       # monotonic order
    return comments


# ============================================================================
# Prompt construction — the actual "intelligence" of this trigger
# ============================================================================

def comment_to_prompt(pr_id: int, comment: dict[str, Any]) -> str:
    """Translate a raw ADO comment into a human-framed instruction for the agent."""
    author = (
        comment["author"].get("displayName")
        or comment["author"].get("uniqueName")
        or "a reviewer"
    )
    try:
        at = datetime.fromisoformat(comment["publishedDate"].replace("Z", "+00:00")).strftime(
            "%Y-%m-%d %H:%M"
        )
    except Exception:
        at = comment["publishedDate"]

    quoted = "\n> ".join(comment["content"].split("\n"))

    return "\n".join([
        f"New comment on PR {pr_id} from {author} ({at}):",
        "",
        f"> {quoted}",
        "",
        "Look at this comment in the context of your current review.",
        "If it's a question, draft a clear answer grounded in the diff.",
        "If it's a change request, draft a plan and ask the user via approval.request before applying.",
        "If it's affirming, acknowledge briefly and continue.",
        "Consult the respond-to-pr-comment template for tone and structure.",
    ])


# ============================================================================
# Mode B — POST a single callback directly to env["callback_url"].
# ============================================================================

def post_callback(callback_url: str, body: dict[str, Any]) -> None:
    if not CONDUCTOR_MCP_SECRET:
        raise RuntimeError(
            "CONDUCTOR_MCP_SECRET environment variable required for Mode B callback POSTs"
        )
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        callback_url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {CONDUCTOR_MCP_SECRET}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            # Drain so the connection is reusable; we don't need the body.
            resp.read()
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace") if hasattr(e, "read") else "<no body>"
        raise RuntimeError(f"callback POST {e.code}: {text}") from e


def body_for_comment(pr_id: int, comment: dict[str, Any]) -> dict[str, Any]:
    return {
        "prompt": comment_to_prompt(pr_id, comment),
        "context": {
            "source": "ado",
            "kind": "pr.commented",
            "pr_id": pr_id,
            "comment_id": comment["id"],
        },
    }


# ============================================================================
# Main
# ============================================================================

def main() -> None:
    stdin_text = sys.stdin.read()
    if not stdin_text.strip():
        write_stdout({"systemMessage": "No stdin envelope received."})
        return

    try:
        env = json.loads(stdin_text)
    except json.JSONDecodeError as e:
        blocking_error(f"Invalid JSON on stdin: {e}")

    # Hydrate state with defaults
    state = {
        "prId": 0,
        "repo": "",
        "lastCommentId": 0,
        "selfUser": "",
        **(env.get("state") or {}),
    }

    if not state["prId"] or not state["repo"]:
        blocking_error("state.prId and state.repo must be set when the trigger is registered")

    callback_url = env.get("callback_url")
    if not callback_url:
        blocking_error("env.callback_url missing — required for Mode B live POSTs")

    # Note: env["trigger_data_dir"] is available as a per-trigger scratch dir at
    # <project_dir>/.conductor/triggers/<trigger_id>/data/. This script doesn't
    # need it (lastCommentId fits in state), but a richer trigger could write
    # blobs there, e.g.:
    #   import pathlib
    #   data = pathlib.Path(env["trigger_data_dir"])
    #   data.mkdir(parents=True, exist_ok=True)
    #   (data / f"comment-{c['id']}.json").write_text(json.dumps(c))

    posted = 0

    payload = env.get("payload") or {}
    resource = payload.get("resource") or {}
    external_comment = resource.get("comment")
    external_pr = resource.get("pullRequest") or {}
    external_pr_matches = external_pr.get("pullRequestId") == state["prId"]

    # ----- Real-time path: ADO service hook delivered the comment -----
    if env.get("fired_by") == "external" and external_comment and external_pr_matches:
        author = external_comment.get("author") or {}
        if (
            external_comment.get("commentType") != "system"
            and author.get("uniqueName") != state["selfUser"]
        ):
            c = {
                "id": external_comment["id"],
                "content": external_comment["content"],
                "author": {"uniqueName": author.get("uniqueName")},
                "publishedDate": external_comment.get("publishedDate")
                or datetime.utcnow().isoformat() + "Z",
            }
            post_callback(callback_url, body_for_comment(state["prId"], c))
            state["lastCommentId"] = c["id"]
            posted += 1

        write_stdout({
            "state": state,
            "systemMessage": (
                f"Forwarded 1 comment from ADO service hook (PR {state['prId']})."
                if posted
                else "Skipped self/system comment."
            ),
        })
        return

    # ----- Cron / manual / agent: poll ADO for new comments -----
    new_comments = list_pr_comments(state["repo"], state["prId"], state["lastCommentId"])

    for c in new_comments:
        if c["author"].get("uniqueName") == state["selfUser"]:
            continue
        post_callback(callback_url, body_for_comment(state["prId"], c))
        state["lastCommentId"] = c["id"]
        posted += 1

    write_stdout({
        "state": state,
        "systemMessage": (
            f"Forwarded {posted} new comment(s) on PR {state['prId']} "
            f"(fired_by={env.get('fired_by')})."
            if posted
            else f"No new comments on PR {state['prId']} (fired_by={env.get('fired_by')})."
        ),
    })


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:
        sys.stderr.write(f"{type(err).__name__}: {err}\n")
        sys.exit(1)
