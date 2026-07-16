#!/usr/bin/env bash
#
# _ado-helpers.sh
#
# Shared helpers for Azure DevOps test fixtures. Sourced by:
#   - setup-ado.sh   (the test harness fixture script)
#   - demo.sh        (the standalone demo script)
#
# All functions here use stderr for human-readable logs and stdout for the
# single value the caller is asking for. Functions exit non-zero on hard
# failures and call `fail` (which exits 1).
#
# Conventions
# -----------
#   - Functions never modify global state. They read inputs as args + env,
#     return values via stdout.
#   - All `info`/`ok`/`warn`/`fail` go to stderr so callers can capture stdout
#     into shell variables cleanly.
#   - Node is used for safe JSON parsing (no jq dependency required).

# Azure DevOps app id — the standard resource id for ADO REST API tokens.
ADO_APP_ID="${ADO_APP_ID:-499b84ac-1321-427f-aa17-267ca6975798}"

# ---------------------------------------------------------------------------
# Pretty logging (stderr — keep stdout clean for value-returning functions)
# ---------------------------------------------------------------------------

ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m[info]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# require_az
#
# Verify that az cli + the azure-devops extension are installed and the user
# is logged in. Echoes the logged-in user's UPN (e.g. user@example.com) on
# stdout. Calls `fail` if anything is missing.
# ---------------------------------------------------------------------------

require_az() {
  if ! command -v az >/dev/null 2>&1; then
    fail "az cli not found. Install from https://learn.microsoft.com/cli/azure/install-azure-cli"
  fi

  if ! az extension show --name azure-devops >/dev/null 2>&1; then
    info "azure-devops extension not installed; installing..."
    az extension add --name azure-devops >/dev/null
  fi

  if ! az account show >/dev/null 2>&1; then
    warn "Not logged in. Running 'az login'..."
    az login >/dev/null
  fi

  az account show --query user.name -o tsv
}

# ---------------------------------------------------------------------------
# read_az_devops_defaults
#
# Echo two lines on stdout:
#   <organization-url-or-empty>
#   <project-name-or-empty>
# Reads from `az devops configure --list`.
# ---------------------------------------------------------------------------

read_az_devops_defaults() {
  local raw org_url project
  raw="$(az devops configure --list 2>/dev/null || true)"
  org_url="$(printf '%s' "${raw}" | awk -F' = ' '/^organization /{print $2}' | tr -d '\r')"
  project="$(printf '%s' "${raw}" | awk -F' = ' '/^project /{print $2}' | tr -d '\r')"
  printf '%s\n%s\n' "${org_url}" "${project}"
}

# ---------------------------------------------------------------------------
# url_to_org_slug <url>
#
# Convert an org URL like https://dev.azure.com/foo or https://foo.visualstudio.com
# to the slug "foo" used in the REST API path. If the input doesn't match,
# echo it back unchanged (assume it's already a slug).
# ---------------------------------------------------------------------------

url_to_org_slug() {
  local url="$1"
  url="${url%/}"
  if [[ "${url}" =~ ^https?://dev\.azure\.com/([^/]+)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "${url}" =~ ^https?://([^.]+)\.visualstudio\.com$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "${url}"
  fi
}

# ---------------------------------------------------------------------------
# urlencode <value>
#
# URL-encode a value via node (handles all special characters safely).
# ---------------------------------------------------------------------------

urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

# ---------------------------------------------------------------------------
# resolve_org_project [<env_org>] [<env_project>]
#
# Resolve ADO_ORG and ADO_PROJECT from env (preferred) or az defaults.
# Echoes on stdout (one per line):
#   <org-slug>
#   <project-name>
# Calls `fail` if neither env nor az defaults provide a value.
# ---------------------------------------------------------------------------

resolve_org_project() {
  local env_org="${1:-}"
  local env_project="${2:-}"
  local defaults default_org_url default_project org project

  defaults="$(read_az_devops_defaults)"
  default_org_url="$(printf '%s' "${defaults}" | sed -n '1p')"
  default_project="$(printf '%s' "${defaults}" | sed -n '2p')"

  if [[ -n "${env_org}" ]]; then
    org="${env_org}"
  elif [[ -n "${default_org_url}" ]]; then
    org="$(url_to_org_slug "${default_org_url}")"
    info "ADO_ORG resolved from az defaults: ${org}"
  else
    fail "ADO_ORG is not set and no az devops default exists. Run:
        az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>
      then re-run."
  fi

  if [[ -n "${env_project}" ]]; then
    project="${env_project}"
  elif [[ -n "${default_project}" ]]; then
    project="${default_project}"
    info "ADO_PROJECT resolved from az defaults: ${project}"
  else
    fail "ADO_PROJECT is not set and no az devops default exists."
  fi

  printf '%s\n%s\n' "${org}" "${project}"
}

# ---------------------------------------------------------------------------
# auto_pick_pr <org-url> <project> <az-user>
#
# Find the most-recent active PR owned by <az-user> in the given org/project.
# Echoes JSON on stdout: { "id": <prId>, "repo": "<repoName>", "title": "<title>" }
# Calls `fail` if no active PRs exist.
# ---------------------------------------------------------------------------

auto_pick_pr() {
  local org_url="$1"
  local project="$2"
  local az_user="$3"
  local pr_list_json picked

  pr_list_json="$(az repos pr list \
    --status active \
    --creator "${az_user}" \
    --top 5 \
    --org "${org_url}" \
    --project "${project}" \
    --output json 2>/dev/null || true)"

  if [[ -z "${pr_list_json}" ]] || [[ "${pr_list_json}" == "[]" ]]; then
    fail "no active PRs owned by ${az_user} in ${org_url}. Create a draft PR you don't mind testing against, then re-run (or set ADO_PR_ID + ADO_REPO explicitly)."
  fi

  picked="$(printf '%s' "${pr_list_json}" | node -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      try {
        const arr = JSON.parse(s);
        if (!Array.isArray(arr) || arr.length === 0) { process.stdout.write(""); return; }
        arr.sort((a,b) => new Date(b.creationDate||0) - new Date(a.creationDate||0));
        const p = arr[0];
        process.stdout.write(JSON.stringify({
          id: p.pullRequestId,
          repo: (p.repository && p.repository.name) || "",
          title: p.title || ""
        }));
      } catch (e) { process.stdout.write(""); }
    });
  ')"

  if [[ -z "${picked}" ]]; then
    fail "could not parse az repos pr list output"
  fi
  printf '%s' "${picked}"
}

# ---------------------------------------------------------------------------
# json_field <field>
#
# Stdin: a JSON object. Stdout: the value at <field> (top-level key only).
# Used for trivial JSON extractions where jq isn't available.
# ---------------------------------------------------------------------------

json_field() {
  local field="$1"
  node -e '
    const field = process.argv[1];
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      try {
        const j = JSON.parse(s);
        const v = j[field];
        process.stdout.write(v == null ? "" : String(v));
      } catch { process.stdout.write(""); }
    });
  ' "${field}"
}

# ---------------------------------------------------------------------------
# mint_ado_bearer_token
#
# Mint an AAD access token for the ADO REST API resource. Echoes the token
# on stdout. Calls `fail` if minting fails.
# ---------------------------------------------------------------------------

mint_ado_bearer_token() {
  local token
  token="$(az account get-access-token \
    --resource "${ADO_APP_ID}" \
    --query accessToken \
    -o tsv 2>/dev/null || true)"

  if [[ -z "${token}" ]]; then
    fail "failed to mint ADO bearer token. Try: az login --tenant 00000000-0000-0000-0000-000000000000"
  fi
  printf '%s' "${token}"
}

# ---------------------------------------------------------------------------
# verify_pr_exists <org-url> <pr-id>
#
# Echoes JSON on stdout: { "title": "<title>", "repo": "<repoName>" }
# Calls `fail` if the PR cannot be loaded.
# ---------------------------------------------------------------------------

verify_pr_exists() {
  local org_url="$1"
  local pr_id="$2"
  local pr_json

  pr_json="$(az repos pr show \
    --id "${pr_id}" \
    --org "${org_url}" \
    --output json 2>/dev/null || true)"

  if [[ -z "${pr_json}" ]] || [[ "${pr_json}" == "null" ]]; then
    fail "could not load PR ${pr_id}. Check ADO_PR_ID and that you have access."
  fi

  printf '%s' "${pr_json}" | node -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      try {
        const j = JSON.parse(s);
        process.stdout.write(JSON.stringify({
          title: j.title || "",
          repo: (j.repository && j.repository.name) || ""
        }));
      } catch { process.stdout.write(""); }
    });
  '
}

# ---------------------------------------------------------------------------
# post_pr_comment <org-url> <project> <repo> <pr-id> <comment-text>
#
# Post a new comment thread (one comment) to the PR. Echoes the new comment
# id on stdout. Calls `fail` if the response can't be parsed.
# ---------------------------------------------------------------------------

post_pr_comment() {
  local org_url="$1"
  local project="$2"
  local repo="$3"
  local pr_id="$4"
  local comment_text="$5"
  local body_file thread_json comment_id

  body_file="$(mktemp)"
  # The trap is set in the parent shell that called us; we clean up our own
  # temp file inline.
  node -e '
    const body = {
      comments: [{ parentCommentId: 0, content: process.argv[1], commentType: 1 }],
      status: 1,
    };
    process.stdout.write(JSON.stringify(body));
  ' "${comment_text}" > "${body_file}"

  thread_json="$(az devops invoke \
    --org "${org_url}" \
    --area git \
    --resource pullRequestThreads \
    --route-parameters project="${project}" repositoryId="${repo}" pullRequestId="${pr_id}" \
    --http-method POST \
    --in-file "${body_file}" \
    --api-version 7.1 \
    --output json 2>/dev/null || true)"

  rm -f "${body_file}"

  if [[ -z "${thread_json}" ]]; then
    fail "az devops invoke returned empty response when posting comment"
  fi

  comment_id="$(printf '%s' "${thread_json}" | node -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
      try {
        const j = JSON.parse(s);
        const c = (j.comments && j.comments[0]) || null;
        process.stdout.write(c && c.id ? String(c.id) : "");
      } catch { process.stdout.write(""); }
    });
  ')"

  if [[ -z "${comment_id}" ]]; then
    printf '%s' "${thread_json}" >&2
    fail "could not extract comment id from new thread response"
  fi
  printf '%s' "${comment_id}"
}

# ---------------------------------------------------------------------------
# build_trigger_ado_org <org-slug> <project>
#
# The trigger script builds REST URLs as
#   https://dev.azure.com/${ADO_ORG}/_apis/git/repositories/<repo>/pullRequests/<id>/threads
# but referring to a repo by name requires a project in the path. So we pass
# the trigger an org-with-project value: "<org>/<urlencoded project>".
# Keeps the trigger script unchanged (it interpolates ADO_ORG raw).
# ---------------------------------------------------------------------------

build_trigger_ado_org() {
  local org="$1"
  local project="$2"
  printf '%s/%s' "${org}" "$(urlencode "${project}")"
}
