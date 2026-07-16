#!/usr/bin/env bash
#
# demo.sh
#
# Standalone linear demo of the Clawdevbox trigger flow against real Azure DevOps.
#
# Unlike the test-driver (which runs 5 scenarios and asserts), this demo walks
# a single happy-path flow with narrative output:
#
#   1. Auto-discover a real PR via az
#   2. Spawn a local mock-clawdevbox and capture its port + secret
#   3. Post ONE comment to the PR via az devops invoke
#   4. Fire /hooks/<trigger-id> on the mock-clawdevbox (cron-style empty body),
#      which spawns ado-comment-watcher.ts as a subprocess
#   5. Verify the mock-clawdevbox received a callback whose prompt mentions our
#      comment text and whose context.comment_id matches the comment we posted
#
# This is the "show, don't tell" complement to the test suite: it demonstrates
# that the entire flow works end-to-end as a single linear story.
#
# Usage: bash demo.sh
#
# Constraints honored:
#   - Posts at most ONE comment to the PR.
#   - No npm dependencies. Uses node for inline JSON parsing (no jq required).
#   - Trigger script (ado-comment-watcher.ts) is run unmodified.

set -euo pipefail

# Git Bash for Windows auto-converts POSIX-looking paths (e.g. "/callback/...")
# to Windows paths when launching native binaries (node.exe, curl.exe). That
# corrupts URL paths and JSON-body strings. Disable conversion script-wide
# and convert real filesystem paths to native form via cygpath where needed.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# Convert a POSIX-looking path to a native (Windows) path when running under
# Git Bash / MSYS; on Linux/macOS this is a no-op.
to_native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIGGER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCRIPT_DIR_NATIVE="$(to_native_path "${SCRIPT_DIR}")"
TRIGGER_DIR_NATIVE="$(to_native_path "${TRIGGER_DIR}")"
TS_TRIGGER_NATIVE="$(to_native_path "${TRIGGER_DIR}/ado-comment-watcher.ts")"

# shellcheck source=./_ado-helpers.sh
source "${SCRIPT_DIR}/_ado-helpers.sh"

# ---------------------------------------------------------------------------
# Demo-local logging — STEP banner + plain → / ✅ / ❌
# ---------------------------------------------------------------------------

step()    { printf '\n\033[1;36mSTEP %s: %s\033[0m\n' "$1" "$2"; }
arrow()   { printf '  → %s\n' "$*"; }
checkmk() { printf '  \033[32m✓ %s\033[0m\n' "$*"; }
xmark()   { printf '\033[31m❌ DEMO FAILED: %s\033[0m\n' "$*" >&2; }

THREAD_ID="thr_DEMO"
TRIGGER_ID="ado-comments-${THREAD_ID}"
CALLBACK_PATH="/callback/threads/${THREAD_ID}/resume"

# ---------------------------------------------------------------------------
# Cleanup: kill the mock-clawdevbox on any exit path
# ---------------------------------------------------------------------------

MOCK_PID=""
MOCK_LOG=""

cleanup() {
  if [[ -n "${MOCK_PID}" ]] && kill -0 "${MOCK_PID}" 2>/dev/null; then
    kill "${MOCK_PID}" 2>/dev/null || true
    # On Windows / Git Bash, the tsx wrapper may spawn a child node process.
    # Wait briefly for graceful shutdown, then SIGKILL the process tree.
    sleep 0.3
    kill -9 "${MOCK_PID}" 2>/dev/null || true
  fi
  if [[ -n "${MOCK_LOG}" ]] && [[ -f "${MOCK_LOG}" ]]; then
    rm -f "${MOCK_LOG}"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers used only by the demo (callback parsing, jq-free assertions)
# ---------------------------------------------------------------------------

# jq_query <script> — pipe JSON in via stdin, get a string out via stdout.
# Uses node since jq isn't guaranteed to be on PATH.
jq_query() {
  local script="$1"
  node -e '
    const fn = new Function("d", `return (${process.argv[1]});`);
    let s = "";
    process.stdin.on("data", c => s += c).on("end", () => {
      try {
        const result = fn(JSON.parse(s));
        process.stdout.write(result == null ? "" : typeof result === "string" ? result : JSON.stringify(result));
      } catch (e) {
        process.stderr.write("jq_query error: " + e.message + "\n");
        process.exit(1);
      }
    });
  ' "${script}"
}

# fail_demo <reason> [<extra-context>]
fail_demo() {
  local reason="$1"
  local extra="${2:-}"
  xmark "${reason}"
  if [[ -n "${extra}" ]]; then
    printf '\n%s\n' "${extra}" >&2
  fi
  exit 1
}

# ---------------------------------------------------------------------------
# STEP 1: pick a target PR via az
# ---------------------------------------------------------------------------

step 1 "Picking a target PR via az"

AZ_USER="$(require_az)"

RESOLVED="$(resolve_org_project "${ADO_ORG:-}" "${ADO_PROJECT:-}")"
ADO_ORG="$(printf '%s' "${RESOLVED}" | sed -n '1p')"
ADO_PROJECT="$(printf '%s' "${RESOLVED}" | sed -n '2p')"
ORG_URL="https://dev.azure.com/${ADO_ORG}"
TRIGGER_ADO_ORG="$(build_trigger_ado_org "${ADO_ORG}" "${ADO_PROJECT}")"

# Honor explicit ADO_PR_ID + ADO_REPO; otherwise auto-discover.
if [[ -z "${ADO_PR_ID:-}" ]]; then
  PICKED="$(auto_pick_pr "${ORG_URL}" "${ADO_PROJECT}" "${AZ_USER}")"
  ADO_PR_ID="$(printf '%s' "${PICKED}" | json_field id)"
  PICKED_REPO="$(printf '%s' "${PICKED}" | json_field repo)"
  PICKED_TITLE="$(printf '%s' "${PICKED}" | json_field title)"
  if [[ -z "${ADO_REPO:-}" ]]; then
    ADO_REPO="${PICKED_REPO}"
  fi
else
  PR_INFO="$(verify_pr_exists "${ORG_URL}" "${ADO_PR_ID}")"
  PICKED_TITLE="$(printf '%s' "${PR_INFO}" | json_field title)"
  PICKED_REPO="$(printf '%s' "${PR_INFO}" | json_field repo)"
  if [[ -z "${ADO_REPO:-}" ]]; then
    ADO_REPO="${PICKED_REPO}"
  fi
fi

if [[ -z "${ADO_REPO:-}" ]] || [[ -z "${ADO_PR_ID:-}" ]]; then
  fail_demo "could not resolve PR (ADO_REPO=${ADO_REPO:-} ADO_PR_ID=${ADO_PR_ID:-})"
fi

PR_URL="${ORG_URL}/_git/${ADO_REPO}/pullrequest/${ADO_PR_ID}"

arrow "Auto-discovered PR ${ADO_PR_ID} in ${ADO_REPO} (\"${PICKED_TITLE}\")"
arrow "URL: ${PR_URL}"

# Mint the bearer token now — the trigger subprocess will need it via env.
ADO_BEARER_TOKEN="$(mint_ado_bearer_token)"
arrow "Minted ADO bearer token from az login (length=${#ADO_BEARER_TOKEN})"

# ---------------------------------------------------------------------------
# STEP 2: start the local mock Clawdevbox server
# ---------------------------------------------------------------------------

step 2 "Starting local mock Clawdevbox server"

MOCK_LOG="$(mktemp)"
# Run mock-clawdevbox.ts in the background; its banner is on stdout.
# Use npx tsx (matches what test-driver uses) — Node 20+ + tsx loader.
( npx --yes tsx "${SCRIPT_DIR_NATIVE}/mock-clawdevbox.ts" >"${MOCK_LOG}" 2>&1 ) &
MOCK_PID=$!

# Wait up to ~10s for the parseable ready banner.
MOCK_PORT=""
MOCK_SECRET=""
for _ in $(seq 1 100); do
  if [[ -s "${MOCK_LOG}" ]] && grep -q '^MOCK_CLAWDEVBOX_READY ' "${MOCK_LOG}"; then
    READY_LINE="$(grep -m1 '^MOCK_CLAWDEVBOX_READY ' "${MOCK_LOG}")"
    # shellcheck disable=SC2206
    READY_PARTS=( ${READY_LINE} )
    MOCK_PORT="${READY_PARTS[1]:-}"
    MOCK_SECRET="${READY_PARTS[2]:-}"
    break
  fi
  if ! kill -0 "${MOCK_PID}" 2>/dev/null; then
    fail_demo "mock-clawdevbox exited before ready" "$(cat "${MOCK_LOG}")"
  fi
  sleep 0.1
done

if [[ -z "${MOCK_PORT}" ]] || [[ -z "${MOCK_SECRET}" ]]; then
  fail_demo "mock-clawdevbox did not print ready banner within 10s" "$(cat "${MOCK_LOG}")"
fi

MOCK_URL="http://127.0.0.1:${MOCK_PORT}"
arrow "Mock Clawdevbox running on ${MOCK_URL}"
arrow "Will capture callbacks at ${CALLBACK_PATH}"

# ---------------------------------------------------------------------------
# STEP 3: post ONE comment to the PR
# ---------------------------------------------------------------------------

step 3 "Posting a new comment to the PR"

TIMESTAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
COMMENT_TEXT="Demo comment — what's the rationale here? ${TIMESTAMP}"

arrow "Comment text: \"${COMMENT_TEXT}\""

COMMENT_ID="$(post_pr_comment "${ORG_URL}" "${ADO_PROJECT}" "${ADO_REPO}" "${ADO_PR_ID}" "${COMMENT_TEXT}")"
arrow "Posted; comment id = ${COMMENT_ID}"

# ---------------------------------------------------------------------------
# STEP 4: configure the mock-clawdevbox's trigger map, then fire /hooks/<id>
# ---------------------------------------------------------------------------

step 4 "Firing the trigger via /hooks/${TRIGGER_ID}"

# The mock-clawdevbox needs to know how to spawn the trigger when /hooks/<id>
# is hit. Configure the mapping via /test/configure-trigger before firing.
# The trigger script will receive the envelope on stdin (the mock-clawdevbox
# builds it from cfg.state) and ADO_ORG / ADO_BEARER_TOKEN via env.
SELF_USER_SENTINEL="__not_${AZ_USER}__"

CONFIGURE_BODY="$(TRIGGER_ID="${TRIGGER_ID}" \
  TS_TRIGGER="${TS_TRIGGER}" \
  ADO_PR_ID="${ADO_PR_ID}" \
  ADO_REPO="${ADO_REPO}" \
  SELF_USER_SENTINEL="${SELF_USER_SENTINEL}" \
  THREAD_ID="${THREAD_ID}" \
  CALLBACK_PATH="${CALLBACK_PATH}" \
  TRIGGER_DIR="${TRIGGER_DIR}" \
  TRIGGER_ADO_ORG="${TRIGGER_ADO_ORG}" \
  ADO_BEARER_TOKEN="${ADO_BEARER_TOKEN}" \
  node -e '
    const cfg = {
      id: process.env.TRIGGER_ID,
      command: ["tsx", process.env.TS_TRIGGER],
      state: {
        prId: parseInt(process.env.ADO_PR_ID, 10),
        repo: process.env.ADO_REPO,
        lastCommentId: 0,
        selfUser: process.env.SELF_USER_SENTINEL,
      },
      subscriberThreadId: process.env.THREAD_ID,
      callbackPath: process.env.CALLBACK_PATH,
      cwd: process.env.TRIGGER_DIR,
      timeoutMs: 60000,
      extraEnv: {
        ADO_ORG: process.env.TRIGGER_ADO_ORG,
        ADO_BEARER_TOKEN: process.env.ADO_BEARER_TOKEN,
      },
    };
    process.stdout.write(JSON.stringify(cfg));
  ')"

CONFIGURE_RESP_FILE="$(mktemp)"
CONFIGURE_HTTP="$(curl -sS -o "${CONFIGURE_RESP_FILE}" -w '%{http_code}' \
  -X POST "${MOCK_URL}/test/configure-trigger" \
  -H 'Content-Type: application/json' \
  -d "${CONFIGURE_BODY}")"

if [[ "${CONFIGURE_HTTP}" != "200" ]]; then
  fail_demo "/test/configure-trigger returned HTTP ${CONFIGURE_HTTP}" "$(cat "${CONFIGURE_RESP_FILE}" 2>/dev/null || true)"
fi
rm -f "${CONFIGURE_RESP_FILE}"

arrow "Trigger runs as subprocess (tsx ado-comment-watcher.ts)"
arrow "Trigger envelope state: { prId: ${ADO_PR_ID}, repo: ${ADO_REPO}, lastCommentId: 0, selfUser: <sentinel> }"

# Fire /hooks/<trigger-id> with empty body (cron-style).
HOOK_RESP_FILE="$(mktemp)"
HOOK_HTTP="$(curl -sS -o "${HOOK_RESP_FILE}" -w '%{http_code}' \
  -X POST "${MOCK_URL}/hooks/${TRIGGER_ID}" \
  -H "Authorization: Bearer ${MOCK_SECRET}" \
  -H 'Content-Type: application/json' \
  -d '')"

HOOK_BODY="$(cat "${HOOK_RESP_FILE}")"
rm -f "${HOOK_RESP_FILE}"

if [[ "${HOOK_HTTP}" != "200" ]]; then
  fail_demo "/hooks/${TRIGGER_ID} returned HTTP ${HOOK_HTTP}" "${HOOK_BODY}"
fi

EXIT_CODE="$(printf '%s' "${HOOK_BODY}" | jq_query 'd.exit_code')"
DURATION_MS="$(printf '%s' "${HOOK_BODY}" | jq_query 'd.duration_ms')"
TRIGGER_STDERR="$(printf '%s' "${HOOK_BODY}" | jq_query 'd.stderr')"

if [[ "${EXIT_CODE}" != "0" ]]; then
  fail_demo "trigger exited non-zero (exit_code=${EXIT_CODE})" "stderr:\n${TRIGGER_STDERR}"
fi

arrow "Trigger ran successfully (exit_code=0, duration_ms=${DURATION_MS})"

# ---------------------------------------------------------------------------
# STEP 5: verify the mock-clawdevbox captured the callback
# ---------------------------------------------------------------------------

step 5 "Verifying the mock Clawdevbox received the callback"

CB_RESP_FILE="$(mktemp)"
CB_HTTP="$(curl -sS -o "${CB_RESP_FILE}" -w '%{http_code}' "${MOCK_URL}/test/received-callbacks")"
CB_BODY="$(cat "${CB_RESP_FILE}")"
rm -f "${CB_RESP_FILE}"

if [[ "${CB_HTTP}" != "200" ]]; then
  fail_demo "/test/received-callbacks returned HTTP ${CB_HTTP}" "${CB_BODY}"
fi

# Find a callback whose body.context.comment_id matches the one we just posted.
MATCH_JSON="$(printf '%s' "${CB_BODY}" | COMMENT_ID="${COMMENT_ID}" node -e '
  const target = parseInt(process.env.COMMENT_ID, 10);
  let s = "";
  process.stdin.on("data", c => s += c).on("end", () => {
    try {
      const j = JSON.parse(s);
      const list = (j && j.callbacks) || [];
      const m = list.find(c => c && c.body && c.body.context && c.body.context.comment_id === target);
      if (!m) { process.stdout.write(""); return; }
      process.stdout.write(JSON.stringify(m));
    } catch { process.stdout.write(""); }
  });
')"

if [[ -z "${MATCH_JSON}" ]]; then
  TOTAL="$(printf '%s' "${CB_BODY}" | jq_query 'd.callbacks ? d.callbacks.length : 0')"
  CONTEXTS="$(printf '%s' "${CB_BODY}" | jq_query 'd.callbacks ? d.callbacks.map(c => (c.body && c.body.context) || null) : []')"
  fail_demo "no callback found with context.comment_id=${COMMENT_ID}" \
    "received ${TOTAL} callback(s); contexts=${CONTEXTS}"
fi

CB_PATH="$(printf '%s' "${MATCH_JSON}" | jq_query 'd.path')"
CB_PROMPT="$(printf '%s' "${MATCH_JSON}" | jq_query 'd.body.prompt')"
CB_PR_ID="$(printf '%s' "${MATCH_JSON}" | jq_query 'd.body.context.pr_id')"
CB_SOURCE="$(printf '%s' "${MATCH_JSON}" | jq_query 'd.body.context.source')"
CB_KIND="$(printf '%s' "${MATCH_JSON}" | jq_query 'd.body.context.kind')"
CB_COMMENT_ID="$(printf '%s' "${MATCH_JSON}" | jq_query 'd.body.context.comment_id')"

TOTAL_CB="$(printf '%s' "${CB_BODY}" | jq_query 'd.callbacks ? d.callbacks.length : 0')"

arrow "${TOTAL_CB} callback(s) received at ${CB_PATH}"
# Render the prompt with a leading 4-space indent (preserves the script's
# multi-line "New comment...\n>...\nLook at this comment..." formatting).
printf '  → prompt:\n%s\n' "$(printf '%s' "${CB_PROMPT}" | sed 's/^/      /')"
printf '  → context: { source: %s, kind: %s, pr_id: %s, comment_id: %s }\n' \
  "${CB_SOURCE}" "${CB_KIND}" "${CB_PR_ID}" "${CB_COMMENT_ID}"

# Assertions.
if ! printf '%s' "${CB_PROMPT}" | grep -qF "${COMMENT_TEXT}"; then
  fail_demo "prompt does not contain demo comment text" "expected substring: ${COMMENT_TEXT}\nprompt: ${CB_PROMPT}"
fi
checkmk "Verified: prompt mentions the comment text we just posted"

if [[ "${CB_COMMENT_ID}" != "${COMMENT_ID}" ]]; then
  fail_demo "context.comment_id (${CB_COMMENT_ID}) != posted comment id (${COMMENT_ID})"
fi
checkmk "Verified: context.comment_id matches the comment we posted"

if [[ "${CB_PR_ID}" != "${ADO_PR_ID}" ]]; then
  fail_demo "context.pr_id (${CB_PR_ID}) != target PR id (${ADO_PR_ID})"
fi
checkmk "Verified: context.pr_id matches the target PR"

if [[ "${CB_SOURCE}" != "ado" ]] || [[ "${CB_KIND}" != "pr.commented" ]]; then
  fail_demo "context.source/kind unexpected (source=${CB_SOURCE}, kind=${CB_KIND})"
fi
checkmk "Verified: context.source=ado, context.kind=pr.commented"

if [[ "${CB_PATH}" != "${CALLBACK_PATH}" ]]; then
  fail_demo "callback path (${CB_PATH}) != expected (${CALLBACK_PATH})"
fi
checkmk "Verified: callback hit the routing-baked URL ${CALLBACK_PATH}"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

printf '\n\033[1;32m✅ DEMO PASSED:\033[0m agent took the PR, added a comment, verified the notification arrived end-to-end.\n\n'
printf '(Optional cleanup: resolve the comment thread at %s)\n' "${PR_URL}"
