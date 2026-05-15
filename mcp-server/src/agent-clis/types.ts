import type { IPty } from 'node-pty';
import type { Workspace } from '../workspace.ts';
import type { ResolvedConfig } from '../config.ts';
import type { logger as Logger } from '../logger.ts';

export type SessionMode = 'interactive' | 'headless';

export type SessionInit =
  | { kind: 'new'; session_id: string }
  | { kind: 'resume'; session_id: string };

export type SessionRole = 'main-agent' | 'recipe-instance' | 'sub-agent';

export interface SpawnSessionOpts {
  mode: SessionMode;
  init: SessionInit;
  role: SessionRole;
  /** Required when mode === 'headless'. Optional in interactive mode. */
  prompt?: string;
  workspaceInfo: { id: string; path: string };
  /** Env vars the kernel wants the child process to see (ambient context). */
  ambientEnv: Record<string, string>;
  /** MCP server the child should connect back to. */
  mcp: { url: string; secret: string };
  recipeInstanceId?: string;
  agentSessionId?: string;
  triggerId?: string;
  fireId?: string;
  ptyCols?: number;
  ptyRows?: number;
}

export interface AgentHandle {
  pid: number | null;
  sessionId: string;
  pty: IPty;
  exited: Promise<{ exitCode: number; signal?: string }>;
}

export interface DetectResult {
  available: boolean;
  binary?: string;
  version?: string;
  reason?: string;
}

export interface SetupOptions {
  scope: 'project' | 'global';
}

export interface PtySpawnOpts {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  name?: string;
}

export interface ProviderCtx {
  ws: Workspace;
  cfg: ResolvedConfig;
  logger: typeof Logger;
  spawnPty(file: string, args: string[], opts: PtySpawnOpts): IPty;
  writeWorkspaceFile(relativePath: string, contents: string): void;
}

export interface AgentCliProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: 'builtin' | `plugin:${string}`;
  readonly internal?: boolean;
  detect?(ctx: ProviderCtx): Promise<DetectResult>;
  setup?(ctx: ProviderCtx, opts: SetupOptions): Promise<void>;
  spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle>;
}

/** Error captured when a plugin-provided provider fails to load. */
export interface AgentCliProviderError {
  plugin_id?: string;
  provider_id?: string;
  module?: string;
  error: string;
  code:
    | 'IMPORT_FAILED'
    | 'INVALID_PROVIDER_SHAPE'
    | 'BUILTIN_COLLISION'
    | 'PLUGIN_COLLISION'
    | 'MODULE_PATH_TRAVERSAL'
    | 'MODULE_NOT_FOUND';
}
