# dev-buddy sessionStart hook — injects the clawdevbox primer as additionalContext.
#
# Gated to fire only when the session source is "startup" (a brand-new session).
# Skipping on "resume", "clear", and "compact" avoids re-loading the same primer
# every time the session is rehydrated.

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$raw = [Console]::In.ReadToEnd()

$payload = $null
if ($raw) {
    try { $payload = $raw | ConvertFrom-Json -ErrorAction Stop } catch { $payload = $null }
}

$source = ''
if ($payload -and ($payload.PSObject.Properties.Name -contains 'source')) {
    $source = [string]$payload.source
}

# Inject on every fresh session and on /clear; skip on resume and compact
# (the primer would already be in context).
$skipSources = @('resume', 'compact')
if ($source -and $skipSources -contains $source) {
    '{}'
    exit 0
}

$primerPath = Join-Path $PSScriptRoot 'primer.md'
if (-not (Test-Path -LiteralPath $primerPath)) {
    '{}'
    exit 0
}

$primer = Get-Content -LiteralPath $primerPath -Raw
$bar    = ('=' * 60)
$framed = "$bar`n[!] MANDATORY clawdevbox primer - apply every rule on every turn.`n$bar`n`n$primer"

@{ additionalContext = $framed } | ConvertTo-Json -Compress




