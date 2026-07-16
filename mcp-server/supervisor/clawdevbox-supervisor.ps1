<#
.SYNOPSIS
  Supervisor for `clawdevbox start`. Spawn the daemon, wait for it to
  exit, restart with exponential backoff, repeat forever. Logs to files
  in the repo root. Entry point for the Task Scheduler "run at logon"
  trigger.

.DESCRIPTION
  Loop:
    1. Spawn `node mcp-server/dist/cli.js start` via Start-Process with
       native stdout/stderr file redirection (rotated each iteration
       so the previous run is preserved as .prev for post-mortem).
    2. Wait for it to exit.
    3. Log the exit (code + uptime).
    4. Sleep for the current backoff (1s, 2s, 5s, 15s, 30s, 60s, capped).
       Backoff resets after a run that lasted > 5 minutes.
    5. Repeat.

  We deliberately use `Start-Process -RedirectStandardOutput/Error` (which
  uses the WINDOWS native handle redirection inside Start-Process) rather
  than `[Diagnostics.Process]` + `BeginOutputReadLine`, because the
  async-callback path crashed the supervisor itself in testing (Powershell
  event-handler delegates dying on stream close).

  Logs (in the repo root):
    .clawdevbox-supervisor.log         – supervisor's own log
    .clawdevbox-supervisor.stdout.log  – child stdout (latest run)
    .clawdevbox-supervisor.stderr.log  – child stderr (latest run)
    .clawdevbox-supervisor.{stdout,stderr}.log.prev – previous run
       (preserved across one crash for post-mortem)
#>
[CmdletBinding()]
param(
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

$SupervisorLog = Join-Path $RepoRoot '.clawdevbox-supervisor.log'
$StdoutLog     = Join-Path $RepoRoot '.clawdevbox-supervisor.stdout.log'
$StderrLog     = Join-Path $RepoRoot '.clawdevbox-supervisor.stderr.log'
$NodeBin       = (Get-Command node -ErrorAction Stop).Source
$CliJs         = Join-Path $RepoRoot 'mcp-server\dist\cli.js'

function Write-Supervisor-Log {
  param([string]$Message)
  $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
  $line = "[$ts] PID=$PID $Message"
  try {
    Add-Content -Path $SupervisorLog -Value $line -Encoding UTF8
  } catch {
    # file lock — ignore
  }
  Write-Host $line
}

function Rotate-Log {
  param([string]$Path)
  if (Test-Path $Path) {
    Move-Item -Path $Path -Destination "$Path.prev" -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path $CliJs)) {
  Write-Supervisor-Log "FATAL: $CliJs not found. Run 'npm run build' in mcp-server\ first."
  exit 1
}

Write-Supervisor-Log "supervisor starting repo=$RepoRoot node=$NodeBin"

$BackoffSec = @(1, 2, 5, 15, 30, 60)
$FailIndex = 0

while ($true) {
  Rotate-Log $StdoutLog
  Rotate-Log $StderrLog

  $startTs = Get-Date
  Write-Supervisor-Log "spawning: $NodeBin $CliJs start"

  try {
    $child = Start-Process `
      -FilePath $NodeBin `
      -ArgumentList @("`"$CliJs`"", 'start') `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Hidden `
      -PassThru `
      -RedirectStandardOutput $StdoutLog `
      -RedirectStandardError $StderrLog
  } catch {
    Write-Supervisor-Log "ERROR: Start-Process threw: $($_.Exception.Message)"
    Start-Sleep -Seconds 10
    continue
  }

  Write-Supervisor-Log "child PID=$($child.Id) started"
  $child.WaitForExit()
  $exitCode = $child.ExitCode
  $uptimeSec = [math]::Round(((Get-Date) - $startTs).TotalSeconds)
  Write-Supervisor-Log "child PID=$($child.Id) EXITED code=$exitCode uptime=${uptimeSec}s"

  # Fast-fail detection.
  if ($uptimeSec -lt 10) {
    $FailIndex = [Math]::Min($FailIndex + 1, $BackoffSec.Length - 1)
  } elseif ($uptimeSec -gt 300) {
    $FailIndex = 0
  }
  $wait = $BackoffSec[$FailIndex]
  Write-Supervisor-Log "restarting in ${wait}s (backoff index=$FailIndex)"
  Start-Sleep -Seconds $wait
}
