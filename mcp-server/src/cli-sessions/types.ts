// mcp-server/src/cli-sessions/types.ts
/**
 * Tmux-backed CLI session abstraction. Replaces direct node-pty handles
 * for agent processes. All input goes through sendText/sendKey — no raw
 * byte channel exists, which structurally eliminates the viewer-input
 * race class (xterm.js DA1/cursor capability replies cannot reach the
 * agent because the only input path is tmux send-keys).
 */
export type SpecialKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'Backspace'
  | 'C-q'
  | 'C-c'
  | 'C-d'
  | 'C-u'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right';

export interface AgentExit {
  exitCode: number | null;
}

export interface CliSession {
  readonly name: string;
  pid(): Promise<number | null>;
  readonly exited: Promise<AgentExit>;
  sendText(text: string): Promise<void>;
  sendKey(key: SpecialKey): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  snapshot(opts?: { ansi?: boolean }): Promise<string>;
  kill(): Promise<void>;
}

export interface CliSessionSpawnOpts {
  /** Becomes `cdb_${name}` as the tmux session name. Must be unique. */
  name: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  command: string;
  args: string[];
}

export interface CliSessionRuntime {
  spawn(opts: CliSessionSpawnOpts): Promise<CliSession>;
  attach(name: string): Promise<CliSession | null>;
  list(): Promise<Array<{ name: string; alive: boolean }>>;
}
