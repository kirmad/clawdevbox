# Clawdevbox Supervisor

Auto-restart wrapper for `clawdevbox start`. Survives daemon crashes
and starts at user logon via Windows Task Scheduler.

## Why

The clawdevbox daemon can die for reasons that are hard to fix at the
source — most commonly, **native crashes inside node-pty on Windows**
when many tmux-attach IPty children accumulate over a long session. The
process exits silently (no `uncaughtException` log) and the user is left
with a dead port 5201.

The supervisor:

1. Spawns `node mcp-server/dist/cli.js start`.
2. Waits for it to exit.
3. Logs the exit (code + uptime) and respawns after an exponential
   backoff (1s → 2s → 5s → 15s → 30s → 60s, capped). Backoff resets if
   the child ran for over 5 minutes.
4. Rotates the child's stdout/stderr to `.prev` files on each respawn
   so the previous crash's last lines are preserved for post-mortem.

## Install

From an ordinary (non-elevated) PowerShell:

```powershell
& 'C:\git\clawdevbox\mcp-server\supervisor\install-task.ps1'
```

This registers a scheduled task **Clawdevbox Supervisor** that runs at
your next logon. To start it immediately without rebooting:

```powershell
Start-ScheduledTask -TaskName 'Clawdevbox Supervisor'
```

## Verify

```powershell
# Is the task registered?
Get-ScheduledTask -TaskName 'Clawdevbox Supervisor'

# Is the supervisor running right now?
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object CommandLine -match 'clawdevbox-supervisor.ps1'

# Is the daemon alive?
(Invoke-WebRequest http://127.0.0.1:5201/healthz -UseBasicParsing).Content
```

## Logs (in the repo root)

* `.clawdevbox-supervisor.log` — supervisor's own log (spawn/exit
  decisions, backoff timing).
* `.clawdevbox-supervisor.stdout.log` — child stdout for the current
  run.
* `.clawdevbox-supervisor.stderr.log` — child stderr for the current
  run.
* `.clawdevbox-supervisor.{stdout,stderr}.log.prev` — previous run's
  output, kept across one crash so a post-mortem doesn't lose the
  smoking gun.

## Uninstall

```powershell
& 'C:\git\clawdevbox\mcp-server\supervisor\uninstall-task.ps1'
```

Stops the scheduled task, unregisters it, and best-effort kills any
orphan supervisor / clawdevbox child still hanging around.
