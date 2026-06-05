// mcp-server/src/cli-sessions/tmux-client.ts
import { spawnSync, spawn } from 'node:child_process';

export interface TmuxClientOpts {
  /** -L flag value, or null to share the default socket. */
  socket: string | null;
  /** -f flag value (config file path), or null for tmux defaults. */
  configPath: string | null;
}

export interface TmuxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TmuxRunOpts {
  input?: string;
  cwd?: string;
  env?: Record<string, string>;
}

function buildArgs(client: TmuxClientOpts, args: string[]): string[] {
  const prefix: string[] = [];
  if (client.socket) prefix.push('-L', client.socket);
  if (client.configPath) prefix.push('-f', client.configPath);
  return [...prefix, ...args];
}

export function tmuxRun(
  client: TmuxClientOpts,
  args: string[],
  opts: TmuxRunOpts = {},
): TmuxRunResult {
  const r = spawnSync('tmux', buildArgs(client, args), {
    encoding: 'utf8',
    input: opts.input,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    // Suppress the brief console-window flash on Windows. tmuxRun is on the
    // hot path (500ms pane-dead poller, send-keys dispatch, etc.) so without
    // this every call pops a window for the SPA/dispatcher user. No effect
    // on non-Windows platforms.
    windowsHide: true,
  });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

export function tmuxRunAsync(
  client: TmuxClientOpts,
  args: string[],
  opts: TmuxRunOpts = {},
): Promise<TmuxRunResult> {
  return new Promise((resolve) => {
    const child = spawn('tmux', buildArgs(client, args), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // Same rationale as tmuxRun above — every cached-list miss
      // (~once/second under SPA polling) would otherwise flash a window.
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (r: TmuxRunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const onError = (err: Error) => {
      settle({ exitCode: -1, stdout, stderr: stderr || err.message });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('error', onError);
    child.stderr.on('error', onError);
    child.on('error', onError);
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
    child.on('close', (exitCode) => settle({ exitCode: exitCode ?? -1, stdout, stderr }));
  });
}
