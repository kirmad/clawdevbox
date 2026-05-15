import type { IPty } from 'node-pty';
import type { PluginEntry, Workspace } from '../workspace.ts';
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
  /**
   * Reconcile the configured CLI's plugin inventory with the given clawdevbox
   * plugin/marketplace state. Idempotent. Uses the CLI's own `plugin install`
   * / `plugin marketplace add` commands.
   */
  syncPluginInventory?(ctx: ProviderCtx, opts: SyncPluginInventoryOpts): Promise<SyncReport>;
  /**
   * Enumerate plugins this CLI has already installed. clawdevbox loads each
   * one and (in Direction B) registers any `clawdevbox.*` extension
   * capabilities into the workspace.
   */
  discoverInstalledPlugins?(ctx: ProviderCtx): Promise<DiscoveredPlugin[]>;
}

/**
 * Shape of a marketplace record passed to `syncPluginInventory`. The CLI
 * `mcp-server/src/cli/marketplace.ts` already persists this on disk under
 * `<globalDir>/marketplaces/<id>.json`; we keep this interface narrow so the
 * helper doesn't need to import that module's full shape.
 */
export interface MarketplaceRecord {
  id: string;
  kind: 'git' | 'local';
  source: string;
  ref?: string | null;
  name?: string;
  description?: string;
  version?: string;
  pluginCount?: number;
  addedAt?: number;
  localPath?: string;
}

export interface SyncPluginInventoryOpts {
  /** clawdevbox-installed plugins to make available to the CLI. */
  plugins: PluginEntry[];
  /** clawdevbox-known marketplaces to register with the CLI. */
  marketplaces: MarketplaceRecord[];
  /** When true, report what would change without making any changes. */
  dryRun?: boolean;
  /** When true (default), uninstall plugins removed from clawdevbox. */
  bidirectionalUninstall?: boolean;
}

export interface SyncReport {
  marketplacesAdded: string[];
  marketplacesPresent: string[];
  pluginsInstalled: string[];
  pluginsPresent: string[];
  pluginsUninstalled: string[];
  failed: Array<{ kind: 'marketplace' | 'plugin'; id: string; error: string }>;
  method: 'cli-command' | 'config-write' | 'mixed';
}

export interface DiscoveredPlugin {
  name: string;
  /** Absolute path to the plugin's root dir. Has .claude-plugin/plugin.json. */
  absoluteDir: string;
  source: 'cli-marketplace' | 'cli-direct' | 'cli-cache';
  marketplaceId: string | null;
}

export interface PluginCliBinding {
  /** Resolved binary name or absolute path. */
  binary: string;
  /** Optional argv prefix injected before the user-supplied args (e.g. Windows shell wrapper). */
  argsPrefix?: string[];
  /** Reserved for CLIs that nest `plugin` under a sub-command. */
  subcommandPrefix?: string[];
  /** Conventional on-disk plugin cache directory for this CLI. */
  pluginCacheDir: string;
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
