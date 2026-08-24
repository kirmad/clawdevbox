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

    [switch] $SkipHerdr
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

# ---- 3. Fetch the first-run bootstrapper ------------------------------------
$target = Join-Path $root 'clawdevbox-bootstrap.mjs'
try {
    Invoke-WebRequest -Uri "$BaseUrl/clawdevbox-bootstrap.mjs" -OutFile $target -UseBasicParsing -TimeoutSec 120
    Write-Log "staged bootstrapper: $target ($([Math]::Round((Get-Item $target).Length / 1KB)) KB)"
} catch {
    Write-Log "ERROR: could not download the bootstrapper: $($_.Exception.Message)"
}

# ---- 4. Launch it, and arm a logon fallback ---------------------------------
if ((Test-Path $target) -and (Test-Cmd 'node')) {
    $node = (Get-Command node).Source
    $argList = @("`"$target`"", '--if-needed', "--$LaunchMode")
    if ($Repo) { $argList += @('--repo', "`"$Repo`"") }

    try {
        Start-Process -FilePath $node -ArgumentList $argList -WindowStyle Hidden -ErrorAction Stop
        Write-Log "launched the first-run experience ($LaunchMode)"
    } catch {
        Write-Log "could not launch the first-run experience: $($_.Exception.Message)"
    }

    # Per-user Run key needs no privileges, unlike a root scheduled task.
    try {
        $runCmd = '"' + $node + '" ' + ($argList -join ' ')
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
            -Name 'ClawDevboxFirstRun' -Value $runCmd -ErrorAction Stop
        Write-Log 'armed the HKCU Run fallback'
    } catch {
        Write-Log "could not arm the Run fallback: $($_.Exception.Message)"
    }
}

Write-Log "first-run setup finished. Log: $log"
exit 0
