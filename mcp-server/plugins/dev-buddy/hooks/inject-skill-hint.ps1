# dev-buddy userPromptSubmitted hook — prepends a "search skills first" hint
# to the user's prompt via `modifiedPrompt`.
#
# IMPORTANT (Copilot CLI 1.0.62 quirk): userPromptSubmitted hooks return
# `additionalContext` correctly in events.jsonl but the model never sees it.
# We use `modifiedPrompt` instead, which literally rewrites the user.message
# content. We always include the original prompt verbatim after the hint so
# the user's intent is preserved.
#
# Skips empty / whitespace-only / very short prompts (likely "yes" / "ok").

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$raw = [Console]::In.ReadToEnd()
$payload = $null
if ($raw) {
    try { $payload = $raw | ConvertFrom-Json -ErrorAction Stop } catch { $payload = $null }
}

$prompt = ''
if ($payload -and ($payload.PSObject.Properties.Name -contains 'prompt')) {
    $prompt = [string]$payload.prompt
}

$trimmed = $prompt -replace '\s', ''
if (-not $trimmed -or $trimmed.Length -lt 12) {
    '{}'
    exit 0
}

$reminder = @"


<system-reminder>[[AUTO-LEARN]]</system-reminder>
"@

$modified = $prompt + $reminder
@{ modifiedPrompt = $modified } | ConvertTo-Json -Compress
