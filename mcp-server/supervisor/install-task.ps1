<#
.SYNOPSIS
  Register / re-register the Windows Task Scheduler task that runs the
  clawdevbox supervisor on user logon (and on demand).

.DESCRIPTION
  Creates a scheduled task named "Clawdevbox Supervisor" that:
    * Triggers AT LOGON for the current user
    * Runs powershell.exe → clawdevbox-supervisor.ps1
    * Runs HIDDEN (no flashing console window each logon)
    * Restarts itself if it ever exits (RestartCount=99, RestartInterval=1m)
    * Persists for hours so a long boot doesn't miss the trigger
    * Runs in the user's context (not SYSTEM) so it has access to
      $HOME, devtunnels auth, agency binary etc.

  Idempotent — unregisters any existing task with the same name first.

.NOTES
  Run from an ELEVATED PowerShell if Group Policy restricts non-admin
  task creation; usually unprivileged user-context tasks work fine.

  After install: the supervisor starts automatically on next logon.
  To start it RIGHT NOW without rebooting: `Start-ScheduledTask -TaskName
  "Clawdevbox Supervisor"`. To stop: `Stop-ScheduledTask` + Disable.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Clawdevbox Supervisor',
  [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

if (-not $PSScriptRoot) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
  $scriptDir = $PSScriptRoot
}
if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
}

$SupervisorScript = Join-Path $scriptDir 'clawdevbox-supervisor.ps1'

if (-not (Test-Path $SupervisorScript)) {
  Write-Error "Supervisor script not found at $SupervisorScript"
  exit 1
}

# Drop any prior version of this task so re-running install is safe.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Unregistering existing scheduled task '$TaskName'..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# -WindowStyle Hidden = no console window flashes on logon.
# -ExecutionPolicy Bypass = ignore any user-scope script restriction.
$action = New-ScheduledTaskAction `
  -Execute (Get-Command powershell.exe).Source `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$SupervisorScript`" -RepoRoot `"$RepoRoot`""

# AtLogOn for the CURRENT user — runs in the user's session so $HOME,
# .clawdevbox/, devtunnel auth etc. are all available.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)

# Settings: keep retrying, allow long runs, don't kill on idle, don't
# require AC power, allow concurrent instances=disallow (1 supervisor only).
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 99 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 365) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd

# Run as the current user, interactively (we want stdout in the user's
# session even if no console window shows — the supervisor pipes stdout
# to log files).
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited

$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Auto-restart wrapper for `clawdevbox start`. Runs at user logon, restarts the daemon on crash with exponential backoff.'

Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null

Write-Host "Scheduled task '$TaskName' installed."
Write-Host "  Trigger:    at user logon"
Write-Host "  Supervisor: $SupervisorScript"
Write-Host "  Repo root:  $RepoRoot"
Write-Host ""
Write-Host "Start NOW (without rebooting):"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "Stop:"
Write-Host "  Stop-ScheduledTask  -TaskName '$TaskName'"
Write-Host ""
Write-Host "Uninstall:"
Write-Host "  & '$PSScriptRoot\uninstall-task.ps1'"
