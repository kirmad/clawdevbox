// mcp-server/src/cli-sessions/tmux-session.ts
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmuxRun, tmuxRunAsync, type TmuxClientOpts } from './tmux-client.ts';
import { specialKeyToTmux } from './special-keys.ts';
import type { AgentExit, CliSession, CliSessionSpawnOpts, SpecialKey } from './types.ts';

/** How often we poll for pane-exit. */
const EXIT_POLL_MS = 500;

const psmuxCache = new Map<string, boolean>();

function isPsmux(client: TmuxClientOpts): boolean {
  const key = client.socket ?? '__default__';
  const cached = psmuxCache.get(key);
  if (cached !== undefined) return cached;
  const r = tmuxRun(client, ['--help']);
  const detected = /\bpsmux\b|Terminal multiplexer for Windows/i.test(`${r.stdout}\n${r.stderr}`);
  psmuxCache.set(key, detected);
  return detected;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellBasename(command: string): string {
  return command.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? command.toLowerCase();
}

function isPortableShell(command: string): boolean {
  return ['sh', 'sh.exe', 'bash', 'bash.exe'].includes(shellBasename(command));
}

function shellWorks(command: string): boolean {
  const r = spawnSync(command, ['-c', 'echo OK'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'OK';
}

function findPortableShell(preferred?: string): string | null {
  const probes = [
    ...(preferred ? [preferred] : []),
    'sh',
    'sh.exe',
    'bash',
    'bash.exe',
    '/bin/sh',
    'C:/Program Files/Git/usr/bin/sh.exe',
  ];
  for (const candidate of probes) {
    if (shellWorks(candidate)) return candidate;
  }
  return null;
}

function buildPsmuxShellScript(opts: CliSessionSpawnOpts): string | null {
  const shell = findPortableShell(isPortableShell(opts.command) ? opts.command : undefined);
  if (!shell) return null;

  const exports = ['export PATH=/usr/bin:/bin:$PATH'];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) exports.push(`export ${k}=${shQuote(v)}`);
  }

  const command = [opts.command, ...opts.args].map(shQuote).join(' ');
  return `${exports.join('; ')}; exec ${command}`;
}

async function waitForPane(client: TmuxClientOpts, sessionName: string, extraDelayMs: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const r = await tmuxRunAsync(client, [
      'display-message', '-p', '-t', sessionName, '#{pane_pid}|#{pane_dead}',
    ]);
    if (r.exitCode === 0) {
      if (extraDelayMs > 0) await sleep(extraDelayMs);
      return;
    }
    await sleep(50);
  }
}

export async function createTmuxSession(
  client: TmuxClientOpts,
  opts: CliSessionSpawnOpts,
): Promise<CliSession> {
  const sessionName = `cdb_${opts.name}`;
  const usingPsmux = isPsmux(client);

  // Build env-arg list: tmux new-session -e KEY=VAL takes one per flag.
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    envArgs.push('-e', `${k}=${v}`);
  }

  const spawnSession = async (cols: number, rows: number): Promise<void> => {
    const baseArgs = [
      'new-session', '-d',
      '-s', sessionName,
      '-x', String(cols),
      '-y', String(rows),
      '-c', opts.cwd,
    ];

    let args: string[];
    if (usingPsmux) {
      const script = buildPsmuxShellScript(opts);
      args = script
        ? [...baseArgs, '--', findPortableShell(isPortableShell(opts.command) ? opts.command : undefined)!, '-c', script]
        : [...baseArgs, '--', opts.command, ...opts.args];
    } else {
      args = [...baseArgs, ...envArgs, opts.command, ...opts.args];
    }

    const r = tmuxRun(client, args);
    if (r.exitCode !== 0) {
      throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    await waitForPane(client, sessionName, usingPsmux ? 100 : 0);
  };

  await spawnSession(opts.cols, opts.rows);

  // Exit-poller: poll #{pane_dead}|#{pane_dead_status} until pane_dead == 1,
  // then resolve `exited`. If the session is killed externally (display-
  // message fails), resolve with exitCode null.
  let exitResolve!: (e: AgentExit) => void;
  const exited = new Promise<AgentExit>((res) => { exitResolve = res; });
  let stopped = false;
  let resolvedAlready = false;

  const poll = async () => {
    while (!stopped && !resolvedAlready) {
      await sleep(EXIT_POLL_MS);
      if (stopped || resolvedAlready) break;
      const r = tmuxRun(client, [
        'display-message', '-p', '-t', sessionName,
        '#{pane_dead}|#{pane_dead_status}',
      ]);
      if (r.exitCode !== 0) {
        // Session gone before we could read status.
        resolvedAlready = true;
        exitResolve({ exitCode: null });
        return;
      }
      const [dead, status] = r.stdout.trim().split('|');
      if (dead === '1') {
        resolvedAlready = true;
        const code = status === '' ? null : Number(status);
        exitResolve({ exitCode: Number.isFinite(code as number) ? (code as number) : null });
        return;
      }
    }
  };
  void poll();

  const sendLiteral = async (text: string): Promise<void> => {
    if (text.length === 0) return;
    const r = await tmuxRunAsync(client, ['send-keys', '-t', sessionName, '-l', text]);
    if (r.exitCode !== 0) throw new Error(`send-keys -l failed: ${r.stderr}`);
  };

  const sendTmuxKey = async (key: string): Promise<void> => {
    const r = await tmuxRunAsync(client, ['send-keys', '-t', sessionName, key]);
    if (r.exitCode !== 0) throw new Error(`send-keys ${key} failed: ${r.stderr}`);
  };

  const session: CliSession = {
    name: sessionName,
    exited,

    async pid() {
      const r = await tmuxRunAsync(client, [
        'display-message', '-p', '-t', sessionName, '#{pane_pid}',
      ]);
      if (r.exitCode !== 0) return null;
      const n = Number(r.stdout.trim());
      return Number.isFinite(n) ? n : null;
    },

    async sendText(text: string): Promise<void> {
      if (text.length === 0) return;
      if (usingPsmux && text.includes('\n')) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          if (line.length > 4096) {
            // Single line larger than send-keys command-line limit — use
            // load-buffer + paste-buffer to inject just this line.
            const buf = `cdb_${sessionName}_line${i}`;
            const load = await tmuxRunAsync(client, ['load-buffer', '-b', buf, '-'], { input: line });
            if (load.exitCode !== 0) throw new Error(`load-buffer failed: ${load.stderr}`);
            try {
              const paste = await tmuxRunAsync(client, ['paste-buffer', '-t', sessionName, '-b', buf, '-d', '-p']);
              if (paste.exitCode !== 0) throw new Error(`paste-buffer failed: ${paste.stderr}`);
            } finally {
              await tmuxRunAsync(client, ['delete-buffer', '-b', buf]);
            }
          } else {
            await sendLiteral(line);
          }
          if (i < lines.length - 1) await sendTmuxKey('Enter');
        }
        return;
      }
      if (text.includes('\n') || text.length > 4096) {
        // Multi-line / large text: use load-buffer + paste-buffer so
        // newlines aren't interpreted as key boundaries by send-keys.
        // paste-buffer goes through the pane (real terminal), unlike
        // show-buffer which escapes newlines on Windows MSYS tmux.
        const buf = `cdb_${sessionName}`;
        const load = await tmuxRunAsync(client, ['load-buffer', '-b', buf, '-'], { input: text });
        if (load.exitCode !== 0) throw new Error(`load-buffer failed: ${load.stderr}`);
        try {
          const paste = await tmuxRunAsync(client, [
            'paste-buffer', '-t', sessionName, '-b', buf, '-d', '-p',
          ]);
          if (paste.exitCode !== 0) throw new Error(`paste-buffer failed: ${paste.stderr}`);
        } finally {
          await tmuxRunAsync(client, ['delete-buffer', '-b', buf]);
        }
        return;
      }
      await sendLiteral(text);
    },

    async sendKey(key: SpecialKey): Promise<void> {
      await sendTmuxKey(specialKeyToTmux(key));
    },

    async resize(cols: number, rows: number): Promise<void> {
      // Two-step strategy:
      //   1. tmux resize-window — works on real tmux (sends SIGWINCH via TIOCSWINSZ
      //      to the pty controlled by tmux).
      //   2. tmux resize-pane    — works on psmux (Windows) where resize-window is
      //      a documented no-op (terminal client controls size). resize-pane calls
      //      ResizePseudoConsole to actually resize the pane's ConPTY.
      //
      // We try BOTH for portability. Whichever applies on the current platform
      // changes the size; the other is a harmless no-op. Both return exit 0 on
      // psmux even when one is the no-op.
      //
      // We do NOT verify dimensions afterward via display-message: on psmux the
      // pane_width/pane_height format vars track the internal model and may lag
      // the actual ConPTY size. The contract is "ask tmux to resize"; the rest is
      // the platform's job. If neither call succeeds, that's a real error and we
      // throw — but we never kill+respawn the session (would destroy an agent
      // mid-work).
      const rw = await tmuxRunAsync(client, [
        'resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows),
      ]);
      if (rw.exitCode !== 0) {
        throw new Error(`resize-window failed: ${rw.stderr.trim() || 'no stderr'}`);
      }
      const rp = await tmuxRunAsync(client, [
        'resize-pane', '-t', sessionName, '-x', String(cols), '-y', String(rows),
      ]);
      if (rp.exitCode !== 0) {
        throw new Error(`resize-pane failed: ${rp.stderr.trim() || 'no stderr'}`);
      }
    },

    async snapshot(opts?: { ansi?: boolean }): Promise<string> {
      const args = ['capture-pane', '-p', '-t', sessionName, '-S', '-', '-E', '-'];
      if (opts?.ansi) args.push('-e');
      const r = await tmuxRunAsync(client, args);
      if (r.exitCode !== 0) throw new Error(`capture-pane failed: ${r.stderr}`);
      return r.stdout;
    },

    async kill(): Promise<void> {
      stopped = true;
      const r = await tmuxRunAsync(client, ['kill-session', '-t', sessionName]);
      // "can't find session" / "no such session" stderr is OK (idempotent).
      if (
        r.exitCode !== 0 &&
        !/can't find session/i.test(r.stderr) &&
        !/no such session/i.test(r.stderr) &&
        !/session not found/i.test(r.stderr) &&
        !/no server running/i.test(r.stderr)
      ) {
        throw new Error(`kill-session failed: ${r.stderr}`);
      }
      if (!resolvedAlready) {
        resolvedAlready = true;
        exitResolve({ exitCode: null });
      }
    },
  };

  return session;
}
