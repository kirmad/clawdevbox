<#
.SYNOPSIS
    Bring the ClawDevbox HTTP service up on a dev box, and if it will not come
    up, capture WHY.

.DESCRIPTION
    `clawdevbox init` installs the service by spawning a detached `start` and
    then probing /healthz for 30s. When that probe times out the installer
    reports "Service install failed" and moves on -- leaving a box with a valid
    config.json, no service.json, and nothing listening.

    The 30s budget is the fragile part: the server probes every agent CLI
    during boot, and a single slow `--version` (copilot.exe is the usual
    culprit) can push first boot past the deadline on a cold dev box.

    This script retries with a realistic budget and, if it still fails, runs
    `start` in the FOREGROUND and echoes its output -- which is the only place
    the underlying error is ever printed.

    Run as a `~/powershell` task with `runAs: User`; the service is per-user.

.NOTES
    Read the output with:  devbox.ps1 tail -Name <box> -GroupName <group>
#>
[CmdletBinding()]
param(
    [int] $Port = 5201,

    # How long to let the service become healthy before declaring failure.
    [int] $WaitSeconds = 150,

    # How long to let a foreground start run while capturing its output.
    [int] $ForegroundSeconds = 75
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Section([string] $Title) {
    Write-Output ''
    Write-Output ('=' * 70)
    Write-Output "== $Title"
    Write-Output ('=' * 70)
}

# The agent's PATH predates the npm install that put clawdevbox on disk.
try {
    $machine = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $env:PATH = ($machine, $user | Where-Object { $_ }) -join ';'
} catch { }

function Test-Health {
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 5
        return $r.StatusCode -eq 200
    } catch { return $false }
}

Section 'before'
$cli = Get-Command clawdevbox -ErrorAction SilentlyContinue
Write-Output "clawdevbox : $(if ($cli) { $cli.Source } else { 'NOT FOUND' })"
if (-not $cli) { Write-Output 'Cannot continue without the CLI.'; exit 0 }
Write-Output "healthy    : $(Test-Health)"

if (Test-Health) {
    Section 'already up'
    Write-Output "The service is already serving on $Port. Nothing to do."
    exit 0
}

Section 'stopping any half-started instance'
& clawdevbox stop 2>&1 | ForEach-Object { "  $_" }

Section 'installing the service'
# --service spawns the detached child and writes service.json. Its own health
# probe may still time out; we do our own, longer, wait below.
$out = & clawdevbox start --service 2>&1
$out | ForEach-Object { "  $_" }

Section "waiting up to ${WaitSeconds}s for /healthz"
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$ok = $false
while ((Get-Date) -lt $deadline) {
    if (Test-Health) { $ok = $true; break }
    Start-Sleep -Seconds 5
}
Write-Output "healthy    : $ok  (after $([int]((Get-Date) - $deadline).TotalSeconds + $WaitSeconds)s)"

if (-not $ok) {
    Section "foreground start (capturing the real error, ${ForegroundSeconds}s)"
    # This is what the installer's own failure message tells you to do by hand.
    # A foreground start prints the error that the detached child swallows.
    $job = Start-Job -ScriptBlock {
        param($p)
        $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('PATH', 'User')
        & clawdevbox start --port $p 2>&1
    } -ArgumentList $Port

    $null = Wait-Job $job -Timeout $ForegroundSeconds
    Receive-Job $job 2>&1 | Select-Object -First 120 | ForEach-Object { "  $_" }
    Write-Output "  healthy during foreground run: $(Test-Health)"
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
}

Section 'after'
Write-Output "healthy    : $(Test-Health)"
$svc = Join-Path $env:USERPROFILE '.clawdevbox\service.json'
if (Test-Path $svc) { Write-Output '--- service.json ---'; Get-Content $svc -Raw }
else { Write-Output 'service.json still MISSING' }

Section 'service.log tail'
$log = Join-Path $env:USERPROFILE '.clawdevbox\service.log'
if (Test-Path $log) { Get-Content $log -Tail 40 } else { Write-Output '(missing)' }

Section 'done'
exit 0
