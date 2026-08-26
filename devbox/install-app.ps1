<#
.SYNOPSIS
    Upgrade ClawDevbox on a dev box and re-run the desktop-app install.

.DESCRIPTION
    Reinstalls the CLI from the given repo, makes sure the service is serving,
    then invokes `clawdevbox welcome --install-app-only` so the Desktop /
    Start-menu shortcuts, the logon auto-start entry and the Edge PWA policy
    are (re)created against the running port.

    Exists because a dev box has no other reliable channel: the RDP web client
    has no canvas, keyboard focus is unreliable, and a kiosk window swallows
    Win+R. A customization task's stdout lands in the task log, so this is how
    you both act on the box and see what happened.

    Run as a `~/powershell` task with `runAs: User`.

.NOTES
    Read the output with:  devbox.ps1 tail -Name <box> -GroupName <group>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Repo,
    [string] $NpmRegistry = '',
    [int] $Port = 5201
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Section([string] $Title) {
    Write-Output ''
    Write-Output ('=' * 70)
    Write-Output "== $Title"
    Write-Output ('=' * 70)
}

function Sync-Path {
    try {
        $m = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
        $u = [Environment]::GetEnvironmentVariable('PATH', 'User')
        $env:PATH = ($m, $u | Where-Object { $_ }) -join ';'
    } catch { }
}
Sync-Path

Section 'before'
Write-Output "clawdevbox : $((Get-Command clawdevbox -ea 0).Source)"
Write-Output "version    : $(& clawdevbox --version 2>&1)"

Section 'upgrading from source'
if ($NpmRegistry) {
    & npm config set registry $NpmRegistry --location=user 2>&1 | ForEach-Object { "  $_" }
}
# The prepare script must run for the CLI to be usable, and passing
# --allow-scripts on the command line DISABLES the .npmrc setting, so set it
# in config and pass no flag.
& npm config set allow-scripts=clawdevbox-ms --location=user 2>&1 | ForEach-Object { "  $_" }
& npm install --global "git+$Repo" 2>&1 | Select-Object -Last 20 | ForEach-Object { "  $_" }
Sync-Path
Write-Output "version after : $(& clawdevbox --version 2>&1)"

Section 'restarting the service'
& clawdevbox stop 2>&1 | ForEach-Object { "  $_" }
& clawdevbox start --service 2>&1 | Select-Object -Last 12 | ForEach-Object { "  $_" }

$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
    Start-Sleep -Seconds 5
    try { $healthy = (Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { }
}
Write-Output "healthy    : $healthy"

Section 'installing the desktop app'
& clawdevbox welcome --install-app-only 2>&1 | ForEach-Object { "  $_" }

Section 'verification'
$desktop = Join-Path $env:USERPROFILE 'Desktop\ClawDevbox.lnk'
$start = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ClawDevbox.lnk'
Write-Output "desktop shortcut  : $(Test-Path $desktop)"
Write-Output "start menu        : $(Test-Path $start)"
$run = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name ClawDevboxApp -ErrorAction SilentlyContinue).ClawDevboxApp
Write-Output "logon auto-start  : $(if ($run) { $run } else { '(not set)' })"
$icon = Join-Path $env:USERPROFILE '.clawdevbox\clawdevbox.ico'
Write-Output "app icon          : $(Test-Path $icon)"
if (Test-Path $desktop) {
    $w = New-Object -ComObject WScript.Shell
    $s = $w.CreateShortcut($desktop)
    Write-Output "shortcut target   : $($s.TargetPath) $($s.Arguments)"
    Write-Output "shortcut icon     : $($s.IconLocation)"
}
try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 8
    Write-Output "UI on :$Port      : $($r.StatusCode)"
} catch { Write-Output "UI on :$Port      : FAILED $($_.Exception.Message)" }

Section 'done'
exit 0
