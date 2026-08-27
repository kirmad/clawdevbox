<#
.SYNOPSIS
    First-login setup runner for a Microsoft Dev Box.

.DESCRIPTION
    Generic bootstrap glue. It carries no organisation-specific identifiers:
    the repository to install from is supplied by -Repo, so the caller (a
    private workload.yaml) decides what gets installed.

    WHY THIS FILE IS FETCHED FROM A URL
    A Dev Box user customization cannot run an inline `command:`. The agent
    stages inline commands in SYSTEM-only C:\Windows\SystemTemp and then reads
    them back as the signed-in user, which fails with "Access is denied" while
    still sometimes reporting success. The `script:` parameter takes a URL, is
    downloaded by the agent and executed with -File, and that path works. So the
    logic lives here and workload.yaml just points at it:

        - name: ~/powershell
          parameters:
            script: https://raw.githubusercontent.com/<owner>/<repo>/<branch>/devbox/firstrun.ps1
            scriptArgs: -Repo "https://.../your-repo.git"

    What it does, in order:
      1. Log everything to a known path, so a failed unattended run can be
         diagnosed from one file.
      2. Make sure Node.js is present (winget tasks normally install it).
      3. Install Herdr (public download, no credentials).
      4. Fetch the first-run bootstrapper next to this script and launch it
         full screen, then arm a logon fallback in case that launch is lost.

    It never throws: provisioning should not fail because setup did.

.NOTES
    Log: %LOCALAPPDATA%\ClawDevbox\logs\firstrun.log
#>
[CmdletBinding()]
param(
    # Repository the first-run wizard installs the product from.
    [string] $Repo = '',

    # Where this script and its sibling bootstrapper live. Defaults to the
    # location this file is published at.
    [string] $BaseUrl = 'https://raw.githubusercontent.com/kirmad/clawdevbox/devbox-bootstrap/devbox',

    # kiosk = edge-to-edge full screen, app = chromeless window, tab = normal tab.
    [ValidateSet('kiosk', 'app', 'tab')]
    [string] $LaunchMode = 'kiosk',

    # npm registry to use on this machine. Managed networks often block
    # registry.npmjs.org (TLS alert 40), so the caller supplies whichever feed
    # actually works there rather than hardcoding one here.
    [string] $NpmRegistry = '',

    [switch] $SkipHerdr,

    # Skip the Agency CLI install (the default agent provider).
    [switch] $SkipAgency
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$root = Join-Path $env:LOCALAPPDATA 'ClawDevbox'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'firstrun.log'

function Write-Log {
    param([string] $Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try { Add-Content -Path $log -Value $line -Encoding utf8 } catch { }
    Write-Host $line
}

function Test-Cmd { param([string] $Name) [bool] (Get-Command $Name -ErrorAction SilentlyContinue) }

function Sync-Path {
    # winget installed Node moments ago; this process inherited the older
    # environment block, so read PATH back from the registry.
    $env:Path = @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User')
    ) -join ';'
}

Write-Log '============================================================'
Write-Log "first-run setup starting as $env:USERNAME on $env:COMPUTERNAME"
Write-Log "repo=$Repo launchMode=$LaunchMode baseUrl=$BaseUrl"
Sync-Path

# ---- 1. Node -----------------------------------------------------------------
if (-not (Test-Cmd 'node')) {
    Write-Log 'Node.js not found - installing via winget'
    foreach ($scope in 'user', 'machine') {
        & winget install --id OpenJS.NodeJS.LTS --exact --silent `
            --accept-package-agreements --accept-source-agreements `
            --scope $scope --disable-interactivity 2>&1 |
            ForEach-Object { Add-Content -Path $log -Value "    $_" -Encoding utf8 }
        Sync-Path
        if (Test-Cmd 'node') { break }
    }
}
if (Test-Cmd 'node') { Write-Log "node $((& node --version) 2>&1)" }
else { Write-Log 'ERROR: Node.js is unavailable; the first-run wizard cannot start.' }

# ---- 1b. Git ----------------------------------------------------------------
# Deliberately NOT a ~/winget task in workload.yaml: on these images Git.Git
# fails every time and, worse, burns the task type's hard 20 minute cap, which
# blocks every task queued behind it. Most dev box images already ship git
# (Visual Studio does), so check first and only install if it is genuinely
# missing - and never let it block the wizard.
if (Test-Cmd 'git') {
    Write-Log "git already present: $((& git --version) 2>&1)"
} else {
    Write-Log 'git not found - attempting a bounded install'
    $job = Start-Job {
        & winget install --id Git.Git --exact --silent --accept-package-agreements `
            --accept-source-agreements --scope user --disable-interactivity 2>&1
    }
    if (Wait-Job $job -Timeout 240) { Receive-Job $job | ForEach-Object { Add-Content -Path $log -Value "    $_" -Encoding utf8 } }
    else { Write-Log 'git install exceeded 4 minutes - continuing without it'; Stop-Job $job }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    Sync-Path
    if (Test-Cmd 'git') { Write-Log "git installed: $((& git --version) 2>&1)" }
    else { Write-Log 'git is unavailable; the wizard will report it if needed' }
}

# ---- 2. Herdr ----------------------------------------------------------------
if (-not $SkipHerdr) {
    if (Test-Cmd 'herdr') {
        Write-Log "Herdr already installed: $((& herdr --version) 2>&1)"
    } else {
        Write-Log 'Installing Herdr'
        try {
            Invoke-Expression (Invoke-RestMethod 'https://herdr.dev/install.ps1' -UseBasicParsing -TimeoutSec 180)
            Sync-Path
            if (Test-Cmd 'herdr') { Write-Log "Herdr installed: $((& herdr --version) 2>&1)" }
            else { Write-Log 'Herdr installer ran but no herdr command appeared.' }
        } catch { Write-Log "Herdr install failed: $($_.Exception.Message)" }
    }
}

# ---- 2b. Agency (the default agent CLI) --------------------------------------
# Agency ships as an internal NuGet package with its own self-updating ring
# layout, so there is no npm package to install - aka.ms/InstallTool.ps1 is its
# supported bootstrap. Installed here rather than in the wizard so the binary
# is already on PATH when the wizard probes for it, which keeps the "Microsoft
# Agency" row green on the very first screen.
#
# Never fatal: a box without agency still gets a working ClawDevbox, and the
# wizard offers Copilot and Claude as alternatives.
if (-not $SkipAgency) {
    if (Test-Cmd 'agency') {
        Write-Log "Agency already installed: $((& agency --version) 2>&1)"
    } else {
        Write-Log 'Installing Agency'
        try {
            Invoke-Expression 'iex "& { $(irm aka.ms/InstallTool.ps1)} agency"'
            Sync-Path
            if (Test-Cmd 'agency') { Write-Log "Agency installed: $((& agency --version) 2>&1)" }
            else { Write-Log 'Agency installer ran but no agency command appeared.' }
        } catch { Write-Log "Agency install failed: $($_.Exception.Message)" }
    }
}

# ---- 3. Fetch the first-run bootstrapper ------------------------------------
$target = Join-Path $root 'clawdevbox-bootstrap.mjs'
try {
    Invoke-WebRequest -Uri "$BaseUrl/clawdevbox-bootstrap.mjs" -OutFile $target -UseBasicParsing -TimeoutSec 120
    Write-Log "staged bootstrapper: $target ($([Math]::Round((Get-Item $target).Length / 1KB)) KB)"
} catch {
    Write-Log "ERROR: could not download the bootstrapper: $($_.Exception.Message)"
}

# ---- 4. Start it in the USER'S INTERACTIVE SESSION --------------------------
# A Dev Box `runAs: User` customization task runs in the user's security
# context but in SESSION 0, which has no desktop. Anything GUI we spawn from
# here is therefore invisible: the wizard's HTTP server comes up fine (it is
# headless) but the kiosk browser renders onto a station nobody can see, and
# the orphaned node process then squats port 5320 for the life of the box, so
# every later attempt dies with EADDRINUSE. That is exactly how a dev box ends
# up with "no wizard, ClawDevbox never installed".
#
# The fix is to never run the wizard from session 0. Register a scheduled task
# with /IT ("interactive only"), which Windows runs INSIDE the logged-on user's
# session, and kick it with `schtasks /Run`. /SC ONLOGON keeps it armed for the
# next sign-in if nobody is logged on yet.
if ((Test-Path $target) -and (Test-Cmd 'node')) {
    $node = (Get-Command node).Source
    $argList = @("`"$target`"", '--if-needed', "--$LaunchMode")
    if ($Repo) { $argList += @('--repo', "`"$Repo`"") }
    if ($NpmRegistry) { $argList += @('--npm-registry', "`"$NpmRegistry`"") }
    $runCmd = '"' + $node + '" ' + ($argList -join ' ')

    $sessionId = (Get-Process -Id $PID).SessionId
    $interactive = $sessionId -ne 0
    Write-Log "running in session $sessionId (interactive=$interactive)"

    $taskName = 'ClawDevbox First-Run Setup'
    $scheduled = $false
    try {
        # Register-ScheduledTask, not schtasks.exe: /TR takes the executable AND
        # its arguments as ONE string, so "C:\Program Files\nodejs\node.exe"
        # gets split on the space no matter how the quotes are escaped. The
        # cmdlets keep -Execute and -Argument separate and sidestep it entirely.
        # LogonType Interactive is the equivalent of schtasks /IT: it pins the
        # task to the logged-on user's session, which is the whole point.
        $action = New-ScheduledTaskAction -Execute $node -Argument ($argList -join ' ')
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
            -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
        $scheduled = $true
        Write-Log "registered the logon task '$taskName'"
    } catch {
        Write-Log "could not register the logon task: $($_.Exception.Message)"
    }

    if ($scheduled) {
        # Runs NOW, in the interactive session, so the wizard appears on this
        # very first sign-in rather than the next one.
        try {
            Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
            Write-Log "started the first-run experience in the interactive session ($LaunchMode)"
        } catch { Write-Log "could not start the logon task: $($_.Exception.Message)" }
    } elseif ($interactive) {
        # No scheduler: a direct launch is fine because we already have a desktop.
        try {
            Start-Process -FilePath $node -ArgumentList $argList -WindowStyle Hidden -ErrorAction Stop
            Write-Log "launched the first-run experience directly ($LaunchMode)"
        } catch { Write-Log "could not launch the first-run experience: $($_.Exception.Message)" }
    } else {
        Write-Log 'no scheduler and no desktop - leaving the Run key to handle the next sign-in'
    }

    # Belt and braces: a per-user Run value needs no privileges and covers the
    # case where the scheduled task could not be registered at all.
    try {
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
            -Name 'ClawDevboxFirstRun' -Value $runCmd -ErrorAction Stop
        Write-Log 'armed the HKCU Run fallback'
    } catch {
        Write-Log "could not arm the Run fallback: $($_.Exception.Message)"
    }

    # Report the outcome.
    #
    # POLL, don't sample once. This used to sleep 25s and probe a single time,
    # which on a cold dev box declared failure 34 seconds BEFORE the wizard
    # finished starting:
    #
    #   16:23:44  started the first-run experience (kiosk)
    #   16:24:11  "did not come up"          <- gave up here
    #   16:24:45  Bootstrap ready at http://127.0.0.1:5320/
    #
    # It then popped Notepad over a wizard that was about to appear, so a
    # perfectly good deployment looked broken. First boot has to fetch and
    # start Node, so ~60s is normal and the ceiling needs real headroom.
    $deadline = (Get-Date).AddSeconds(180)
    $up = $false
    while (-not $up -and (Get-Date) -lt $deadline) {
        try {
            $probe = Invoke-WebRequest -Uri 'http://127.0.0.1:5320/' -UseBasicParsing -TimeoutSec 5
            $up = ($probe.StatusCode -eq 200)
        } catch { $up = $false }
        if (-not $up) { Start-Sleep -Seconds 5 }
    }

    if ($up) {
        Write-Log 'the first-run experience is serving on 127.0.0.1:5320'
    } elseif ($interactive) {
        # Only pop Notepad when we actually have a desktop to pop it onto - in
        # session 0 it would be one more invisible orphan - and only after the
        # full budget has genuinely elapsed.
        Write-Log 'the first-run experience did not come up within 180s - opening the log so it is visible'
        try { Start-Process notepad.exe -ArgumentList "`"$log`"" } catch { }
    } else {
        Write-Log 'the first-run experience is not serving yet; the logon task will start it in the user session'
    }
}
Write-Log "first-run setup finished. Log: $log"
exit 0
