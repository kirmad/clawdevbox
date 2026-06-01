# Tmux-backed CLI sessions

clawdevbox runs interactive agent CLIs (Copilot, Claude Code, Agency) inside
**tmux sessions** instead of raw `node-pty` handles. This document explains
why and how it works.

## Why tmux?

Three reasons drove the migration (May 2026):

1. **Eliminates the viewer-input race.** Multiple users / browsers attaching
   to the same terminal previously caused xterm.js capability-query replies
   (DA1, cursor position) to land in the agent's input box, corrupting it
   or stealing focus. With tmux, viewers attach via `tmux attach` — a TUI
   consumer that absorbs those replies — and they never reach the agent.
2. **Easy debug attach from any shell.** Run `tmux -L clawdevbox attach -t
   cdb_<instance_id>` from a separate terminal and you see exactly what the
   agent sees, side-by-side with the browser viewer. Detach (`Ctrl-B d`)
   without disturbing the session.
3. **Session survival across kernel restarts.** If clawdevbox crashes or you
   `Ctrl-C` it, the agent processes keep running inside their tmux sessions.
   On restart, `reconcileOnStartup()` queries `tmux list-sessions` and
   re-adopts any `cdb_<id>` sessions whose DB rows are still marked
   `status='running'`.

## Topology

```
                    +-------------------+
                    | clawdevbox kernel |
                    | (node process)    |
                    +---------+---------+
                              |
                              | (spawns, registers, dispatches)
                              v
                +-------------+---------------+
                | tmux session: cdb_<id>      |
                |                             |
                |   +---------------------+   |
                |   | agent process       |   |
                |   | (copilot, claude,   |   |
                |   |  agency, echo-stub) |   |
                |   +---------------------+   |
                +--+-------------+------+-----+
                   ^             ^      ^
       +-----------+             |      +------------+
       |                         |                   |
+------+------+         +--------+--------+   +------+------+
| browser     |         | terminal A      |   | mobile/iPad |
| viewer A    |         | (tmux attach    |   | viewer C    |
| (ws + tmux  |         |  for dev debug) |   | (ws + tmux  |
|  attach)    |         |                 |   |  attach)    |
+-------------+         +-----------------+   +-------------+
```

Each browser viewer spawns its OWN per-viewer `tmux attach` IPty
(see `terminal-server.ts:attachWebsocketViaTmux`). Closing one viewer
doesn't disturb the others or the agent.

## Lifecycle

### Spawn

```
provider.spawnSession(ctx, opts)
   │
   ├─ argv = [provider-specific flags]
   ├─ session = ctx.spawnTmuxSession ?? tmuxSessionRuntime().spawn({...})
   │     └─ tmux new-session -d -s cdb_<instance_id> -- <command> <argv>
   ├─ tmuxSessionRegistry.register(instanceId, session)
   │     └─ auto-unregister on session.exited
   └─ handle = { pid, sessionId, session, exited }
```

### Dispatch (follow-up prompt to a live agent)

```
POST /dispatch { instance_id, prompt }
   │
   ├─ dispatcher.dispatchToInstance(instanceId, prompt)
   │     ├─ session = tmuxSessionRegistry.get(instanceId)  // returns null = 404
   │     ├─ { dispatchId, promise } = registerPending(instanceId, prompt)
   │     ├─ await session.sendKey('Escape')
   │     ├─ await sleep(200)
   │     ├─ await session.sendText(prompt)
   │     ├─ await sleep(250)
   │     ├─ await session.sendKey('Enter')
   │     └─ background: Promise.race([promise, 5min-timeout])
   │           └─ if timeout: resolvePendingTimeout
   └─ HTTP 200 { ok, dispatchId } (returns immediately)
```

### Done detection

The agent itself signals completion by calling the `update_status` MCP tool:

```
agent → POST /mcp { tool: 'update_status', args: { status_text, task_complete: true } }
   │
   ├─ tools/update-status.ts:handleUpdateStatus
   │     ├─ updateStatus(db, instanceId, {text, needs_user_input, ts})
   │     ├─ if (task_complete || needs_user_input):
   │     │     resolvePending(instanceId, getPending(instanceId).dispatchId, {...})
   │     └─ emitChange('sessions')
   └─ HTTP 200 { ok: true }
```

The pending-dispatch-registry resolves; the dispatcher's background
`Promise.race` wins on `promise` (not timeout); the next `/dispatch` to the
same instance proceeds.

### Viewer

```
browser → WS /terminal/<instance_id>/ws
   │
   └─ terminal-server.attachWebsocket(ws, instanceId)
         ├─ session = tmuxSessionRegistry.get(instanceId)
         ├─ if session: spawn a per-viewer `tmux -L clawdevbox attach -t cdb_<id>` IPty
         │     ├─ ipty.onData → ws.send(JSON {type:'data', chunk})
         │     ├─ ws.message → ipty.write(data) | ipty.resize(cols,rows)
         │     └─ ws.close → ipty.kill()        ← agent keeps running
         └─ if no session: fall back to pty-registry (e2e-test-runner, legacy)
```

## Reconcile on startup

```
on `clawdevbox start`:
  initTmuxSessionRuntime({ socket: 'clawdevbox', configPath: bundledTmuxConfPath() })
  → fire-and-forget reconcileOnStartup(db):
      tmuxLive = tmux -L clawdevbox list-sessions -F '#{session_name}'
                  filter prefix='cdb_'
      runningRows = SELECT id FROM agent_sessions WHERE status='running'
      for row in runningRows:
        if row.id in tmuxLive:
          attach + register in tmuxSessionRegistry  → adopted++
        else:
          UPDATE status='failure' ended_at=now    → orphaned++
```

## Configuration

In `~/.clawdevbox/config.json`:

```json
{
  "tmux": {
    "socket": "clawdevbox"
  }
}
```

- `socket`: name passed to `tmux -L <name>`. Default `"clawdevbox"`. Set
  to `null` to share the default tmux socket (not recommended — leaks
  clawdevbox sessions into the user's interactive workspace).

## Platform notes

### Windows (psmux)

On Windows, `tmux.exe` on PATH typically resolves to **psmux** — a native
Rust port using Windows ConPTY. It's not 100% drop-in compatible with
Unix tmux:

- `tmux list-sessions` on a fresh socket returns exit code 0 with empty
  stdout (Unix tmux returns exit 1). `tmuxSessionRuntime.list()` handles both.
- `resize-window -x -y` is a no-op (terminal size is controlled by the
  attached client). We call `resize-pane` AND `resize-window` and accept
  either as best-effort.
- Multi-line `sendText` uses `load-buffer` + `paste-buffer` on Unix tmux,
  but psmux's paste-buffer doesn't preserve newlines through the pane.
  The session shim falls back to per-line `send-keys -l <line>` +
  `send-keys Enter` for psmux.
- `pane_dead_status` always returns `0` regardless of actual exit code
  on psmux — agent exit codes are unreliable. The kernel infers exit
  via the `session.exited` promise resolving (set up via `wait` in the
  tmux session shell).

### Linux / macOS

Stock tmux >= 3.0. No special config needed beyond `npm install`.

## Files

| Path | Role |
|---|---|
| `src/cli-sessions/types.ts` | CliSession interface, SpecialKey union |
| `src/cli-sessions/tmux-client.ts` | `tmuxRun` / `tmuxRunAsync` subprocess wrapper |
| `src/cli-sessions/tmux-session.ts` | `createTmuxSession`, `adoptTmuxSession` |
| `src/cli-sessions/tmux-session-runtime.ts` | Singleton runtime + registry + reconcile |
| `src/cli-sessions/wait-for-ready.ts` | Snapshot-poll readiness gate |
| `src/cli-sessions/special-keys.ts` | SpecialKey → tmux name translation |
| `src/pending-dispatch-registry.ts` | One-in-flight FIFO dispatch queue per instance |
| `src/tools/update-status.ts` | MCP tool agents call to signal completion |
| `assets/cdb.tmux.conf` | Bundled tmux config (history, default-size, etc.) |

## Migration history

See `docs/superpowers/specs/2026-05-31-tmux-cli-sessions-design.md` and
`docs/superpowers/plans/2026-05-31-tmux-cli-sessions.md` for the design
rationale and step-by-step migration that landed this in
`feat/tmux-migration`.
