#!/usr/bin/env bash
#
# setup-ado.sh
#
# Set up real Azure DevOps test fixtures for the Clawdevbox trigger harness.
#
# What it does:
#   1. Verify az cli + azure-devops extension are installed.
#   2. Verify az login session and read defaults from `az devops configure --list`.
#   3. Resolve ADO_ORG / ADO_PROJECT (env > az defaults).
#   4. Resolve ADO_REPO + ADO_PR_ID (env, or auto-pick most-recent active PR by current user).
#   5. Mint an ADO bearer token via `az account get-access-token` (Azure DevOps app id
#      499b84ac-1321-427f-aa17-267ca6975798).
#   6. Post a real comment to the specified PR (a new thread with one comment).
#   7. Write the resolved config + bearer token + comment id to test-config.json.
#
# Auth model:
#   - The bearer token is minted from the user's `az login` session — no PAT required.
#   - The token is written to test-config.json (gitignored) and consumed by the
#     test driver, which passes it to the trigger script as ADO_BEARER_TOKEN.
#
# This script does NOT auto-create a PR — that's destructive. If no active PR is
# owned by the current user, the script exits with instructions.
#
# Output: test-config.json (next to this script).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_OUT="${SCRIPT_DIR}/test-config.json"

# shellcheck source=./_ado-helpers.sh
source "${SCRIPT_DIR}/_ado-helpers.sh"

# ---------------------------------------------------------------------------
# Step 1+2: az cli + login
# ---------------------------------------------------------------------------

AZ_USER="$(require_az)"
ok "az cli present and logged in as: ${AZ_USER}"

# ---------------------------------------------------------------------------
# Step 3: resolve ADO_ORG / ADO_PROJECT
# ---------------------------------------------------------------------------

RESOLVED="$(resolve_org_project "${ADO_ORG:-}" "${ADO_PROJECT:-}")"
ADO_ORG="$(printf '%s' "${RESOLVED}" | sed -n '1p')"
ADO_PROJECT="$(printf '%s' "${RESOLVED}" | sed -n '2p')"

ORG_URL="https://dev.azure.com/${ADO_ORG}"
TRIGGER_ADO_ORG="$(build_trigger_ado_org "${ADO_ORG}" "${ADO_PROJECT}")"

# ---------------------------------------------------------------------------
# Step 4: resolve ADO_REPO + ADO_PR_ID (auto-discover if not provided)
# ---------------------------------------------------------------------------

if [[ -z "${ADO_PR_ID:-}" ]]; then
  info "ADO_PR_ID not set; looking up most-recent active PR owned by ${AZ_USER}..."
  PICKED="$(auto_pick_pr "${ORG_URL}" "${ADO_PROJECT}" "${AZ_USER}")"
  ADO_PR_ID="$(printf '%s' "${PICKED}" | json_field id)"
  PICKED_REPO="$(printf '%s' "${PICKED}" | json_field repo)"
  PICKED_TITLE="$(printf '%s' "${PICKED}" | json_field title)"
  if [[ -z "${ADO_REPO:-}" ]]; then
    ADO_REPO="${PICKED_REPO}"
  fi
  ok "auto-picked PR ${ADO_PR_ID} (${ADO_REPO}): \"${PICKED_TITLE}\""
fi

if [[ -z "${ADO_REPO:-}" ]]; then
  fail "ADO_REPO is required when ADO_PR_ID is set explicitly. Example: export ADO_REPO=auth-svc"
fi

ok "config (ADO_ORG=${ADO_ORG}, ADO_PROJECT=${ADO_PROJECT}, ADO_REPO=${ADO_REPO}, ADO_PR_ID=${ADO_PR_ID})"

# ---------------------------------------------------------------------------
# Step 5: mint a bearer token for the ADO REST API
# ---------------------------------------------------------------------------

info "minting ADO bearer token via az account get-access-token..."
ADO_BEARER_TOKEN="$(mint_ado_bearer_token)"
ok "got ADO bearer token (length=${#ADO_BEARER_TOKEN})"

# ---------------------------------------------------------------------------
# Step 6: verify the PR exists
# ---------------------------------------------------------------------------

info "verifying PR ${ADO_PR_ID} exists in ${ADO_ORG}/${ADO_PROJECT}/${ADO_REPO}..."
PR_INFO="$(verify_pr_exists "${ORG_URL}" "${ADO_PR_ID}")"
PR_TITLE="$(printf '%s' "${PR_INFO}" | json_field title)"
PR_REPO="$(printf '%s' "${PR_INFO}" | json_field repo)"
ok "PR ${ADO_PR_ID}: \"${PR_TITLE}\" (repo=${PR_REPO})"

if [[ -n "${PR_REPO}" ]] && [[ "${PR_REPO}" != "${ADO_REPO}" ]]; then
  warn "ADO_REPO=${ADO_REPO} but PR's repo is ${PR_REPO}. Using ADO_REPO from env (the trigger reads it from state)."
fi

# ---------------------------------------------------------------------------
# Step 7: post a real comment to the PR
# ---------------------------------------------------------------------------

TIMESTAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
COMMENT_TEXT="Test comment from Clawdevbox trigger harness at ${TIMESTAMP}"

info "posting test comment to PR ${ADO_PR_ID}..."
TEST_COMMENT_ID="$(post_pr_comment "${ORG_URL}" "${ADO_PROJECT}" "${ADO_REPO}" "${ADO_PR_ID}" "${COMMENT_TEXT}")"
ok "posted test comment id=${TEST_COMMENT_ID}: \"${COMMENT_TEXT}\""

# ---------------------------------------------------------------------------
# Step 8: write test-config.json
# ---------------------------------------------------------------------------

# Use node for safe JSON encoding (handles any special chars in the token).
ADO_ORG="${ADO_ORG}" \
TRIGGER_ADO_ORG="${TRIGGER_ADO_ORG}" \
ADO_PROJECT="${ADO_PROJECT}" \
ADO_REPO="${ADO_REPO}" \
ADO_PR_ID="${ADO_PR_ID}" \
TEST_COMMENT_ID="${TEST_COMMENT_ID}" \
COMMENT_TEXT="${COMMENT_TEXT}" \
AZ_USER="${AZ_USER}" \
ADO_BEARER_TOKEN="${ADO_BEARER_TOKEN}" \
TIMESTAMP="${TIMESTAMP}" \
node -e '
  const cfg = {
    org: process.env.ADO_ORG,
    trigger_ado_org: process.env.TRIGGER_ADO_ORG,
    project: process.env.ADO_PROJECT,
    repo: process.env.ADO_REPO,
    pr_id: parseInt(process.env.ADO_PR_ID, 10),
    test_comment_id: parseInt(process.env.TEST_COMMENT_ID, 10),
    test_comment_text: process.env.COMMENT_TEXT,
    az_user: process.env.AZ_USER,
    ado_bearer_token: process.env.ADO_BEARER_TOKEN,
    created_at: process.env.TIMESTAMP,
  };
  process.stdout.write(JSON.stringify(cfg, null, 2));
' > "${CONFIG_OUT}"

ok "wrote ${CONFIG_OUT}"
echo
info "Cleanup: this script does NOT delete the test comment. Resolve or delete it"
info "         manually from the PR UI when done. PR: ${ORG_URL}/_git/${ADO_REPO}/pullrequest/${ADO_PR_ID}"
echo
ok "setup complete. Now run:  npm run test"
