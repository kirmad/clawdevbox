<#
.SYNOPSIS
  Stop and remove the "Clawdevbox Supervisor" scheduled task. Also
  best-effort kills the running supervisor + its child node process so
  the next install starts cleanly.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Clawdevbox Supervisor'
)

$ErrorActionPreference = 'Continue'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Stopping scheduled task '$TaskName'..."
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "Unregistering scheduled task '$TaskName'..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Task removed."
} else {
  Write-Host "No scheduled task named '$TaskName' was registered."
}

# Best-effort cleanup of any orphan supervisor / clawdevbox child still
# running. Limited to PROCESSES we can identify with high confidence:
# (a) powershell.exe whose command line references clawdevbox-supervisor.ps1
# (b) node.exe whose command line references mcp-server\dist\cli.js start
Write-Host ""
Write-Host "Looking for orphan supervisor / clawdevbox processes..."
$orphans = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and (
    $_.CommandLine -match 'clawdevbox-supervisor\.ps1' -or
    $_.CommandLine -match 'mcp-server\\dist\\cli\.js"?\s+start'
  )
}
if ($orphans) {
  foreach ($p in $orphans) {
    Write-Host "  killing PID $($p.ProcessId) — $($p.Name)"
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { Write-Host "    (already gone)" }
  }
} else {
  Write-Host "  none found."
}
Write-Host "Done."
