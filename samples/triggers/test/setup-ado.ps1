#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Set up real Azure DevOps test fixtures for the Conductor trigger harness.

.DESCRIPTION
  Mirror of setup-ado.sh for Windows / PowerShell users.

  1. Verifies az cli + azure-devops extension are installed.
  2. Verifies az login session and reads defaults from `az devops configure --list`.
  3. Resolves ADO_ORG / ADO_PROJECT (env > az defaults).
  4. Resolves ADO_REPO + ADO_PR_ID (env, or auto-picks most-recent active PR by current user).
  5. Mints an ADO bearer token via `az account get-access-token`
     (Azure DevOps app id 499b84ac-1321-427f-aa17-267ca6975798).
  6. Posts a real comment to the specified PR (a new thread with one comment).
  7. Writes the resolved config + bearer token + comment id to test-config.json.

.NOTES
  Auth model: the bearer token is minted from the user's `az login` session,
  written to test-config.json (gitignored), and consumed by the test driver,
  which passes it to the trigger script as ADO_BEARER_TOKEN. No PAT required.

  This script does NOT auto-create a PR. If no active PR is owned by the
  current user, the script exits with instructions.
#>

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigOut = Join-Path $ScriptDir 'test-config.json'

# Azure DevOps app id — the standard resource id for ADO REST API tokens.
$AdoAppId = '499b84ac-1321-427f-aa17-267ca6975798'

function Write-Ok($msg)   { Write-Host "[ok] $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "[info] $msg" -ForegroundColor Cyan }
function Write-Warning2($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "[fail] $msg" -ForegroundColor Red; exit 1 }

# --- Step 1: az cli + extension ---
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  Write-Fail "az cli not found. Install from https://learn.microsoft.com/cli/azure/install-azure-cli"
}
$azVersion = (az --version 2>$null | Select-Object -First 1)
Write-Ok "az cli present: $azVersion"

$ext = az extension show --name azure-devops 2>$null
if (-not $ext) {
  Write-Info "azure-devops extension not installed; installing..."
  az extension add --name azure-devops | Out-Null
}
Write-Ok "azure-devops extension present"

# --- Step 2: az login + defaults ---
$account = az account show 2>$null
if (-not $account) {
  Write-Warning2 "Not logged in. Running 'az login'..."
  az login | Out-Null
}
$AzUser = az account show --query user.name -o tsv
Write-Ok "az logged in as: $AzUser"

# Read az devops defaults — used as fallback for ADO_ORG / ADO_PROJECT.
$DefaultsRaw = az devops configure --list 2>$null
$DefaultOrgUrl = ''
$DefaultProject = ''
if ($DefaultsRaw) {
  foreach ($line in ($DefaultsRaw -split "`n")) {
    if ($line -match '^\s*organization\s*=\s*(.+?)\s*$') { $DefaultOrgUrl = $Matches[1] }
    elseif ($line -match '^\s*project\s*=\s*(.+?)\s*$') { $DefaultProject = $Matches[1] }
  }
}

function Convert-OrgUrlToSlug([string]$url) {
  if (-not $url) { return '' }
  $u = $url.TrimEnd('/')
  if ($u -match '^https?://dev\.azure\.com/([^/]+)$') { return $Matches[1] }
  if ($u -match '^https?://([^.]+)\.visualstudio\.com$') { return $Matches[1] }
  return $u   # assume already a slug
}

# --- Step 3: resolve ADO_ORG / ADO_PROJECT ---
$AdoOrg = $env:ADO_ORG
if ([string]::IsNullOrEmpty($AdoOrg)) {
  if ([string]::IsNullOrEmpty($DefaultOrgUrl)) {
    Write-Fail @"
ADO_ORG is not set and no az devops default exists. Run:
    az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>
then re-run this script.
"@
  }
  $AdoOrg = Convert-OrgUrlToSlug $DefaultOrgUrl
  Write-Info "ADO_ORG resolved from az defaults: $AdoOrg"
}

$AdoProject = $env:ADO_PROJECT
if ([string]::IsNullOrEmpty($AdoProject)) {
  if ([string]::IsNullOrEmpty($DefaultProject)) {
    Write-Fail @"
ADO_PROJECT is not set and no az devops default exists. Run:
    az devops configure --defaults project=<project>
then re-run this script.
"@
  }
  $AdoProject = $DefaultProject
  Write-Info "ADO_PROJECT resolved from az defaults: $AdoProject"
}

$OrgUrl = "https://dev.azure.com/$AdoOrg"

# Trigger script builds REST URLs as
#   https://dev.azure.com/${ADO_ORG}/_apis/git/repositories/<repo>/pullRequests/<id>/threads
# but referring to a repo by name requires a project in the path. So we pass
# the trigger an org-with-project value: "<org>/<urlencoded project>". Keeps
# the trigger script unchanged (it interpolates ADO_ORG raw).
Add-Type -AssemblyName System.Web
$AdoProjectEnc = [System.Web.HttpUtility]::UrlEncode($AdoProject)
$TriggerAdoOrg = "$AdoOrg/$AdoProjectEnc"

# --- Step 4: resolve ADO_REPO + ADO_PR_ID ---
$AdoPrId = $env:ADO_PR_ID
$AdoRepo = $env:ADO_REPO

if ([string]::IsNullOrEmpty($AdoPrId)) {
  Write-Info "ADO_PR_ID not set; looking up most-recent active PR owned by $AzUser..."
  $prListRaw = az repos pr list --status active --creator $AzUser --top 5 --org $OrgUrl --project $AdoProject --output json 2>$null
  if (-not $prListRaw) {
    Write-Fail "no active PRs owned by $AzUser in $OrgUrl. Create a draft PR you don't mind testing against, then re-run (or set ADO_PR_ID + ADO_REPO explicitly)."
  }
  $prList = $prListRaw | ConvertFrom-Json
  if (-not $prList -or $prList.Count -eq 0) {
    Write-Fail "no active PRs owned by $AzUser in $OrgUrl."
  }
  # Most recent first.
  $picked = $prList | Sort-Object -Property creationDate -Descending | Select-Object -First 1
  $AdoPrId = "$($picked.pullRequestId)"
  if ([string]::IsNullOrEmpty($AdoRepo)) {
    $AdoRepo = $picked.repository.name
  }
  Write-Ok "auto-picked PR ${AdoPrId} (${AdoRepo}): `"$($picked.title)`""
}

if ([string]::IsNullOrEmpty($AdoRepo)) {
  Write-Fail "ADO_REPO is required when ADO_PR_ID is set explicitly. Example: `$env:ADO_REPO = 'auth-svc'"
}

Write-Ok "config (ADO_ORG=$AdoOrg, ADO_PROJECT=$AdoProject, ADO_REPO=$AdoRepo, ADO_PR_ID=$AdoPrId)"

# --- Step 5: mint a bearer token for the ADO REST API ---
Write-Info "minting ADO bearer token via az account get-access-token..."
$AdoBearerToken = az account get-access-token --resource $AdoAppId --query accessToken -o tsv 2>$null
if ([string]::IsNullOrEmpty($AdoBearerToken)) {
  Write-Fail "failed to mint ADO bearer token. Try: az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47"
}
Write-Ok "got ADO bearer token (length=$($AdoBearerToken.Length))"

# --- Step 6: verify PR exists ---
Write-Info "verifying PR $AdoPrId exists in $AdoOrg/$AdoProject/$AdoRepo..."
$prRaw = az repos pr show --id $AdoPrId --org $OrgUrl --output json 2>$null
if (-not $prRaw) {
  Write-Fail "could not load PR $AdoPrId. Check ADO_PR_ID and that you have access."
}
$pr = $prRaw | ConvertFrom-Json
$prTitle = $pr.title
$prRepo = if ($pr.repository) { $pr.repository.name } else { '' }
Write-Ok "PR ${AdoPrId}: `"$prTitle`" (repo=$prRepo)"
if ($prRepo -and $prRepo -ne $AdoRepo) {
  Write-Warning2 "ADO_REPO=$AdoRepo but PR's repo is $prRepo. Using ADO_REPO from env."
}

# --- Step 7: post a test comment ---
$Timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$CommentText = "Test comment from Conductor trigger harness at $Timestamp"
Write-Info "posting test comment to PR $AdoPrId..."

$bodyObj = @{
  comments = @(
    @{ parentCommentId = 0; content = $CommentText; commentType = 1 }
  )
  status = 1
}
$bodyFile = New-TemporaryFile
$bodyObj | ConvertTo-Json -Depth 5 | Set-Content -Path $bodyFile.FullName -Encoding UTF8

try {
  $threadRaw = az devops invoke `
    --org $OrgUrl `
    --area git `
    --resource pullRequestThreads `
    --route-parameters project=$AdoProject repositoryId=$AdoRepo pullRequestId=$AdoPrId `
    --http-method POST `
    --in-file $bodyFile.FullName `
    --api-version 7.1 `
    --output json
} finally {
  Remove-Item $bodyFile.FullName -Force -ErrorAction SilentlyContinue
}

if (-not $threadRaw) {
  Write-Fail "az devops invoke returned empty response"
}

$thread = $threadRaw | ConvertFrom-Json
if (-not $thread.comments -or $thread.comments.Count -eq 0) {
  Write-Host $threadRaw -ForegroundColor Red
  Write-Fail "could not extract comment id from new thread response"
}
$TestCommentId = $thread.comments[0].id
Write-Ok "posted test comment id=$TestCommentId : `"$CommentText`""

# --- Step 8: write test-config.json ---
$config = [ordered]@{
  org               = $AdoOrg
  trigger_ado_org   = $TriggerAdoOrg
  project           = $AdoProject
  repo              = $AdoRepo
  pr_id             = [int]$AdoPrId
  test_comment_id   = [int]$TestCommentId
  test_comment_text = $CommentText
  az_user           = $AzUser
  ado_bearer_token  = $AdoBearerToken
  created_at        = $Timestamp
}
$config | ConvertTo-Json -Depth 5 | Set-Content -Path $ConfigOut -Encoding UTF8
Write-Ok "wrote $ConfigOut"

Write-Host ""
Write-Info "Cleanup: this script does NOT delete the test comment. Resolve or delete it"
Write-Info "         manually from the PR UI when done. PR: $OrgUrl/_git/$AdoRepo/pullrequest/$AdoPrId"
Write-Host ""
Write-Ok "setup complete. Now run:  npm run test"
