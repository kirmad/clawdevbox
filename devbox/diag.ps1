<#
.SYNOPSIS
    Dump the state of a ClawDevbox first-run install to stdout.

.DESCRIPTION
    A Dev Box customization task streams its stdout into the task log, which is
    readable over the DevCenter data-plane API. That makes this script the only
    RELIABLE way to inspect a dev box you have no other channel into: the RDP
    web client has no canvas, keyboard focus is unreliable, and a full-screen
    kiosk window swallows Win+R entirely.

    Run it as a `~/powershell` task with `runAs: User` -- the state it reports
    (HKCU, %LOCALAPPDATA%, per-user npm prefix) only exists in the user's own
    context. Under SYSTEM every answer is misleading rather than wrong.

    It reports, never changes:
      - whether the CLI resolved, and from where
      - the service record and whether that PID is actually alive
      - whether the HTTP port answers
      - the first-run marker, logon task and Run value
      - the tail of every relevant log

.NOTES
    Read the output with:  devbox.ps1 tail -Name <box> -GroupName <group>
#>
[CmdletBinding()]
param(
    # HTTP port the ClawDevbox service should be serving on.
    [int] $Port = 5201,

    # Lines of each log to echo.
    [int] $Tail = 25
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Section([string] $Title) {
    Write-Output ''
    Write-Output ('=' * 70)
    Write-Output "== $Title"
    Write-Output ('=' * 70)
}

function Show([string] $Label, $Value) {
    Write-Output ('{0,-22} {1}' -f $Label, $Value)
}

# A customization task inherits the PATH from when the agent started, which
# predates anything npm just installed. Rebuild it from the registry or every
# lookup below reports a false negative.
try {
    $machine = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $env:PATH = ($machine, $user | Where-Object { $_ }) -join ';'
} catch { }

Section 'identity'
Show 'user'        $env:USERNAME
Show 'host'        $env:COMPUTERNAME
Show 'session'     (Get-Process -Id $PID).SessionId
Show 'time'        (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

Section 'toolchain'
foreach ($t in 'node', 'npm', 'git', 'gh', 'herdr', 'clawdevbox') {
    $cmd = Get-Command $t -ErrorAction SilentlyContinue
    if ($cmd) {
        $v = try { (& $t --version 2>&1 | Select-Object -First 1) } catch { '(version failed)' }
        Show $t "$v   [$($cmd.Source)]"
    } else {
        Show $t 'NOT FOUND'
    }
}

Section 'npm global prefix'
try {
    $prefix = (& npm prefix -g 2>&1 | Select-Object -First 1)
    Show 'prefix' $prefix
    $modules = Join-Path $prefix 'node_modules\clawdevbox-ms'
    Show 'package dir' (Test-Path $modules)
    if (Test-Path $modules) {
        Show '  has bin/' (Test-Path (Join-Path $modules 'bin'))
        Show '  has dist/' (Test-Path (Join-Path $modules 'mcp-server\dist'))
        Show '  has scripts/' (Test-Path (Join-Path $modules 'scripts'))
        $pkg = Join-Path $modules 'package.json'
        if (Test-Path $pkg) {
            Show '  version' ((Get-Content $pkg -Raw | ConvertFrom-Json).version)
        }
    }
} catch { Show 'prefix' "ERROR: $($_.Exception.Message)" }

Section 'clawdevbox config + service'
$global = Join-Path $env:USERPROFILE '.clawdevbox'
Show 'global dir' "$global  (exists=$(Test-Path $global))"
foreach ($f in 'config.json', 'service.json') {
    $p = Join-Path $global $f
    if (Test-Path $p) {
        Write-Output "--- $f ---"
        Get-Content $p -Raw
    } else {
        Show $f 'MISSING'
    }
}

$svc = Join-Path $global 'service.json'
if (Test-Path $svc) {
    try {
        $s = Get-Content $svc -Raw | ConvertFrom-Json
        $alive = $null -ne (Get-Process -Id $s.pid -ErrorAction SilentlyContinue)
        Show 'recorded pid' "$($s.pid)  alive=$alive"
    } catch { Show 'service.json' "unparseable: $($_.Exception.Message)" }
}

Section "http :$Port"
foreach ($path in '/healthz', '/api/cron/status') {
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$Port$path" -UseBasicParsing -TimeoutSec 8
        $body = $r.Content
        if ($body.Length -gt 200) { $body = $body.Substring(0, 200) + '...' }
        Show $path "$($r.StatusCode)  $body"
    } catch {
        Show $path "FAILED: $($_.Exception.Message)"
    }
}

Section 'listening ports 5200-5400'
try {
    Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -ge 5200 -and $_.LocalPort -le 5400 } |
        ForEach-Object {
            $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
            Show "  :$($_.LocalPort)" "$($p.ProcessName) (pid $($_.OwningProcess))"
        }
} catch { Show 'ports' "ERROR: $($_.Exception.Message)" }

Section 'first-run arming'
$root = Join-Path $env:LOCALAPPDATA 'ClawDevbox'
Show 'root'           "$root  (exists=$(Test-Path $root))"
Show 'first-run.json' (Test-Path (Join-Path $root 'first-run.json'))
Show 'browser.json'   (Test-Path (Join-Path $root 'browser.json'))
$run = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name ClawDevboxFirstRun -ErrorAction SilentlyContinue).ClawDevboxFirstRun
Show 'HKCU Run'    ($(if ($run) { $run } else { '(not set)' }))
$task = Get-ScheduledTask -TaskName 'ClawDevbox First-Run Setup' -ErrorAction SilentlyContinue
Show 'logon task'  ($(if ($task) { "$($task.State)  logon=$($task.Principal.LogonType)" } else { '(not registered)' }))

Section 'processes'
foreach ($n in 'node', 'msedge') {
    $procs = @(Get-Process $n -ErrorAction SilentlyContinue)
    Show $n "$($procs.Count) running"
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cl = $_.CommandLine
    if ($cl -and $cl.Length -gt 150) { $cl = $cl.Substring(0, 150) + '...' }
    Show "  pid $($_.ProcessId)" $cl
}

foreach ($log in @(
    (Join-Path $root 'logs\firstrun.log'),
    (Join-Path $root 'logs\bootstrap.log'),
    (Join-Path $root 'logs\welcome.log'),
    (Join-Path $global 'service.log')
)) {
    Section "log: $log"
    if (Test-Path $log) {
        Get-Content $log -Tail $Tail -ErrorAction SilentlyContinue
    } else {
        Write-Output '(missing)'
    }
}

Section 'done'
exit 0
