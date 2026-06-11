import type { IPty } from 'node-pty';
import type { PluginEntry, Workspace } from '../workspace.ts';
import type { ResolvedConfig } from '../config.ts';
import type { logger as Logger } from '../logger.ts';
import type { CliSession, CliSessionSpawnOpts } from '../cli-sessions/types.ts';

export type SessionMode = 'interactive' | 'headless';

/**
 * How a provider's interactive REPL can stage a follow-up prompt while the
 * agent is mid-turn.
 *
 * - `ctrl-q`: provider's REPL accepts ASCII DC1 (`\x11`) to enqueue the
 *   current input box content instead of submitting it. Empirically verified
 *   for GitHub Copilot CLI and Agency (which wraps Copilot). Drains FIFO.
 * - `none`: provider has no built-in queue mechanism; the conductor must
 *   buffer locally and write a coalesced prompt on next idle.
 */
export type PromptQueueMode = 'ctrl-q' | 'none';

/**
 * Caller-supplied hint to `SessionConductor.dispatch`. The conductor
 * resolves to a concrete byte strategy based on the provider's
 * `capabilities.queueMode` and the live session state:
 *
 * - `submit`: always submit immediately; if the session is busy, buffer
 *   in the conductor's local queue and drain on next idle.
 * - `queue`: prefer provider-native queue (Ctrl+Q) when supported; on
 *   providers without queue support, downgrade to local-buffer (same as
 *   `submit` while busy) and log a warning.
 * - `auto` (default): use provider queue when busy and supported, submit
 *   when idle, buffer locally otherwise.
 */
export type PromptStrategy = 'submit' | 'queue' | 'auto';

export interface ProviderCapabilities {
  /** How follow-up prompts can be staged while the agent is mid-turn. */
  queueMode: PromptQueueMode;
  /**
   * Byte-level submit strategy for the provider's REPL. Empirically
   * required for Copilot/Agency: a single bulk `pty.write(text + '\r')`
   * only edits the input box and does not submit; the text and the Enter
   * byte must arrive in separate writes with a ~250ms gap. Claude accepts
   * `bulk-cr` (one combined write).
   */
  promptSubmitStrategy: 'split-cr-250ms' | 'bulk-cr';
  /**
   * Regex matching the visible prompt-ready glyph on a stable terminal
   * tail. Used by the conductor as a SECONDARY done signal — only after
   * the tail has been stable for `stableTailMs` and no `busyIndicators`
   * are present. Multiline anchors recommended.
   */
  promptReadyRegex: RegExp;
  /**
   * Regexes matching mid-turn busy indicators. While any of these match
   * the current screen tail, the conductor treats the session as busy
   * even if other heuristics might otherwise fire.
   */
  busyIndicators: RegExp[];
  /**
   * Out-of-band idle signal source. When set to `'copilot-events'`, the
   * dispatcher waits on `<copilotDir>/session-state/<sessionId>/events.jsonl`
   * for `assistant.turn_end` / `session.task_complete` before sending the
   * next follow-up prompt. Defaults to `'none'` (rely on TUI snapshot +
   * glyph only).
   *
   * Copilot CLI and Agency (which wraps Copilot under the hood) both
   * write to the same Copilot events stream — both should set this.
   *
   * (Seed prompts are NOT gated by this — they ride the CLI's own argv
   * hook, see provider.spawnSession.)
   */
  idleSignal?: 'copilot-events' | 'none';
}

/**
 * Resolved arguments to `AgentCliProvider.writePrompt`. `strategy` is
 * narrowed to a concrete operation (no `auto`) — the conductor resolves
 * the caller's `PromptStrategy` before calling the provider.
 */
export interface WritePromptOpts {
  text: string;
  strategy: 'submit' | 'queue';
}

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
  /**
   * Optional agent persona to launch the CLI with. Maps to the CLI's
   * `--agent <name>` flag (supported by both `copilot` and `claude`).
   * The name must resolve to an `agents/<name>.agent.md` definition
   * loaded by one of the registered plugins. Providers that don't
   * support a named-agent flag (e.g. `echo-stub`) ignore this field.
   */
  agent?: string;
  /**
   * Optional model name. Maps to the CLI's `--model <name>` flag.
   * Supported by copilot (e.g. `gpt-5.2`, `claude-opus-4.7-1m-internal`),
   * claude (e.g. `sonnet`, `opus`, `claude-sonnet-4-6`), and agency
   * (which forwards to copilot). Providers that don't expose a
   * `--model` flag (`e2e-test-runner`, `echo-stub`) ignore this field.
   */
  model?: string;
  workspaceInfo: { id: string; path: string };
  /** Env vars the kernel wants the child process to see (ambient context). */
  ambientEnv: Record<string, string>;
  /**
   * MCP server the spawned agent connects back to. Headers are injected
   * per-spawn so the long-lived HTTP MCP server can identify the calling
   * agent (workspace_id, recipe_instance_id, etc.) on every request via
   * `extra.requestInfo.headers`. See context-resolver.ts.
   */
  mcp: {
    url: string;
    secret: string;
    /** Workspace this agent is acting in. Becomes X-Clawdevbox-Workspace-Id. */
    workspaceId?: string;
    /** Recipe instance the agent is running, if any. Becomes X-Clawdevbox-Recipe-Instance-Id. */
    recipeInstanceId?: string;
    /** Project dir hint for fallback resolution. Becomes X-Clawdevbox-Project-Dir. */
    projectDir?: string;
    /** Agent session id. Becomes X-Clawdevbox-Session-Id. */
    sessionId?: string;
  };
  recipeInstanceId?: string;
  agentSessionId?: string;
  triggerId?: string;
  fireId?: string;
  ptyCols?: number;
  ptyRows?: number;
  /** Vault directories to pass as --plugin-dir flags to the CLI. */
  pluginDirs?: string[];
}

export interface AgentHandle {
  pid: number | null;
  sessionId: string;
  /**
   * Legacy node-pty handle. Populated by providers that haven't migrated to
   * tmux yet. Will be removed once all providers populate `session` (T19+).
   * Consumers should prefer `session` and treat `pty` as fallback only.
   */
  pty?: IPty;
  /**
   * Tmux-backed CliSession. Populated by tmux-migrated providers. New code
   * should read from this (sendText/sendKey/snapshot/resize/kill).
   */
  session?: CliSession;
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
  /**
   * Spawn an agent inside a tmux session. Populated when the tmux session
   * runtime has been booted (T13+). tmux-migrated providers prefer this
   * over `spawnPty` and populate `AgentHandle.session`. Optional during
   * the staged migration; assert presence in provider code before calling.
   */
  spawnTmuxSession?(opts: CliSessionSpawnOpts): Promise<CliSession>;
  writeWorkspaceFile(relativePath: string, contents: string): void;
}

export interface AgentCliProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: 'builtin' | `plugin:${string}`;
  readonly internal?: boolean;
  /**
   * Declarative metadata describing how the provider's interactive REPL
   * behaves. Required for any provider that will be driven by
   * `SessionConductor`; providers that only spawn headless sessions may
   * omit this field. The conductor refuses to wrap a handle whose
   * provider lacks `capabilities`.
   */
  readonly capabilities?: ProviderCapabilities;
  /**
   * Whether this provider supports resuming a prior CLI session (typically
   * via `--resume <session_id>`). When false (or absent), the Terminals
   * Panel UI disables the [Resume] button and the /api/sessions/<id>/resume
   * endpoint returns 422.
   */
  readonly supportsResume?: boolean;
  detect?(ctx: ProviderCtx): Promise<DetectResult>;
  setup?(ctx: ProviderCtx, opts: SetupOptions): Promise<void>;
  spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle>;
  /**
   * Deliver a prompt to a live interactive session by writing the
   * provider-specific byte sequence to the pty. Implementations MUST
   * honor the resolved strategy:
   *
   * - `submit`: write the prompt and commit it (e.g. text → Enter).
   * - `queue`: stage the prompt without starting a new turn (e.g.
   *   text → Ctrl+Q on Copilot). Providers whose `capabilities.queueMode`
   *   is `'none'` MUST throw on `strategy: 'queue'` — the conductor only
   *   calls writePrompt with a strategy the provider supports.
   *
   * Required for any provider that will be driven by `SessionConductor`.
   */
  writePrompt?(handle: AgentHandle, opts: WritePromptOpts): Promise<void>;
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
