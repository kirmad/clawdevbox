/**
 * init-config-file.ts
 *
 * Loader + validator for the optional `clawdevbox init --config-file
 * <path>` JSON file. When supplied, the file pre-populates ANSWERS to
 * every interactive prompt in `runInit()`, turning the wizard into a
 * fully unattended setup that's safe to run from a provisioning script
 * or share between machines.
 *
 * Absent fields fall back to the *interactive* prompt — so you can use
 * a partial file to skip just the questions you've already decided on
 * and still get prompted for the rest. To force fully-unattended mode
 * even when some fields are missing, pass `--non-interactive`; missing
 * fields then resolve to documented defaults (see `defaultAnswer`).
 *
 * Companion command: `clawdevbox init --emit-config <path>` writes a
 * fully-populated init-config JSON file derived from the current
 * installed state, ready to be checked into a dotfiles repo.
 */

import { existsSync, readFileSync } from 'node:fs';

/**
 * Shape of the init-config JSON file. EVERY field is optional —
 * missing fields fall through to the original interactive prompts.
 *
 * Versioning: bump CONFIG_FILE_VERSION when adding/removing required
 * fields; older files keep working through best-effort field mapping.
 */
export const INIT_CONFIG_FILE_VERSION = 1;

export interface InitConfigFile {
  /** Schema version. Required so older files can warn-and-skip new fields. */
  version?: number;

  /** 'global' (account-wide config) or 'project' (per-project). Default 'global'. */
  scope?: 'global' | 'project';

  /** Project directory. Default: cwd. */
  project_dir?: string;

  /** Global directory. Default: ~/.clawdevbox. */
  global_dir?: string;

  /** HTTP listener config for `clawdevbox start`. */
  http?: {
    /** Port. Default 5201. */
    port?: number;
    /** Bearer token. Default: mint a fresh one. Set to literal string
     *  "GENERATE" to force a fresh one; set to "PRESERVE" to keep the
     *  existing token in an overwritten config. */
    token?: string | 'GENERATE' | 'PRESERVE';
  };

  /** Public-tunnel config. Default: none. */
  tunnel?:
    | { kind: 'none' }
    | { kind: 'devtunnel'; name?: string; allow_anonymous?: boolean };

  /** Browser push notifications. Default: enabled iff tunnel is devtunnel. */
  notifications?: {
    enabled?: boolean;
    /** mailto: or https:// URL. Required for VAPID per Web Push spec. */
    subject?: string;
  };

  /**
   * Default agent CLI provider id (e.g. "copilot", "agency", "claude").
   * Skips the chooser prompt. Must match a provider that's actually
   * registered after plugin install — init will warn if the id is
   * unknown and fall through to runtime fallback.
   */
  default_agent_cli?: string;

  /**
   * Built-in marketplace plugin install behaviour. Default behaviour
   * matches the interactive flow: auto-install `required`, prompt for
   * `recommended` (pre-checked) and `optional` (unchecked). With
   * `auto_install_all: true`, install every tier without prompting.
   */
  builtin_plugins?: {
    enabled?: boolean;                  // false = same as --no-builtin
    auto_install_all?: boolean;         // skip per-tier prompts
  };

  /** External plugin sources — each is a git URL or absolute folder. */
  external_plugins?: string[];

  /**
   * Vault entries. `path` is optional when `remote` is set (auto-computed
   * from global vaults dir). `remote` enables auto-clone on init.
   */
  vaults?: Array<{
    id: string;
    path?: string;
    kind?: 'personal' | 'team';
    scope?: 'project' | 'team';
    remote?: string | null;
    branch?: string;
  }>;

  /** Overwrite an existing config without asking. Default false. */
  overwrite_existing?: boolean;

  /**
   * Install background service (legacy `clawdevbox start --service`)?
   * Default: prompt the user in global scope, skip in project scope.
   */
  install_service?: boolean;

  /**
   * Install the auto-restart supervisor + Windows Task Scheduler
   * "Clawdevbox Supervisor" task. Default: true on Windows when scope
   * is 'global', false otherwise. See mcp-server/supervisor/README.md.
   */
  install_supervisor?: boolean;

  /**
   * Daemons to register on init. Each entry maps to a `daemon.register`
   * call. If a daemon with the same `id` already exists, it's skipped.
   *
   * `plugin` resolves the command path relative to the plugin's installed
   * dir (e.g. "teams" → ~/.clawdevbox/plugins/teams/).
   */
  daemons?: Array<{
    /** Stable id. Used as-is (no auto-minting). */
    id: string;
    /** Human-readable label. */
    name: string;
    /** Plugin id — command paths resolve relative to its installed dir. */
    plugin?: string;
    /** Runtime: 'node', 'tsx', 'python', 'bash', 'pwsh', 'direct'. */
    runtime: string;
    /** Argv handed to the runtime. Relative paths resolved from plugin dir. */
    command: string[];
    /** Extra env vars merged into process.env at spawn time. */
    env?: Record<string, string>;
    /** Working directory. Defaults to plugin dir or global dir. */
    cwd?: string;
    /** Defaults to true. */
    enabled?: boolean;
  }>;

  /**
   * Triggers to register on init. Each entry maps to a
   * `trigger.instance.register` call. If a trigger with the same `id`
   * already exists, it's skipped.
   */
  triggers?: Array<{
    /** Trigger type (e.g. "ado.assigned-items-watcher"). */
    type: string;
    /** Instance id suffix — combined as `<type>#<key>`. */
    key: string;
    /** Human-readable label. */
    name?: string;
    /** Params passed to the trigger script. */
    params?: Record<string, unknown>;
    /** Cron expression (e.g. "0,30 * * * *"). Null/false for webhook-only. */
    cron?: string | null | false;
  }>;
}

/** Default value used when --non-interactive is set and the field is absent. */
function defaultAnswer<K extends keyof InitConfigFile>(key: K): InitConfigFile[K] | undefined {
  const defaults: InitConfigFile = {
    scope: 'global',
    http: { port: 5201, token: 'GENERATE' },
    tunnel: { kind: 'none' },
    notifications: { enabled: false },
    builtin_plugins: { enabled: true, auto_install_all: false },
    external_plugins: [],
    vaults: [],
    overwrite_existing: true,
    install_service: true,
    install_supervisor: process.platform === 'win32',
  };
  return defaults[key];
}

/**
 * Load + validate a config file. Returns the parsed object or throws
 * with a precise error message that the CLI surfaces to the user.
 */
export async function loadInitConfigFile(pathOrUrl: string): Promise<InitConfigFile> {
  let raw: string;

  // Support https:// URLs — fetch the config remotely
  if (/^https?:\/\//.test(pathOrUrl)) {
    try {
      const res = await fetch(pathOrUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      raw = await res.text();
    } catch (err) {
      throw new Error(`failed to fetch ${pathOrUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    if (!existsSync(pathOrUrl)) {
      throw new Error(`init config file not found: ${pathOrUrl}`);
    }
    try {
      raw = readFileSync(pathOrUrl, 'utf8');
    } catch (err) {
      throw new Error(`failed to read ${pathOrUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${pathOrUrl} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${pathOrUrl} must be a JSON object`);
  }
  const cfg = parsed as Record<string, unknown>;

  // Soft version check — warn but accept.
  if (typeof cfg.version === 'number' && cfg.version > INIT_CONFIG_FILE_VERSION) {
    process.stderr.write(
      `[init-config] ${pathOrUrl} declares version ${cfg.version}, newer than supported ${INIT_CONFIG_FILE_VERSION}. ` +
      `Unknown fields will be ignored.\n`,
    );
  }

  // Minimal structural validation. Avoid full JSON Schema to keep
  // dependencies light; checks below mirror the prompt validators.
  if (cfg.scope != null && cfg.scope !== 'global' && cfg.scope !== 'project') {
    throw new Error(`${pathOrUrl}: "scope" must be "global" or "project"`);
  }
  if (cfg.http != null && typeof cfg.http !== 'object') {
    throw new Error(`${pathOrUrl}: "http" must be an object`);
  }
  if (cfg.http && typeof cfg.http === 'object') {
    const h = cfg.http as { port?: unknown; token?: unknown };
    if (h.port != null && (typeof h.port !== 'number' || h.port < 1 || h.port > 65535)) {
      throw new Error(`${pathOrUrl}: "http.port" must be 1..65535`);
    }
    if (h.token != null && typeof h.token !== 'string') {
      throw new Error(`${pathOrUrl}: "http.token" must be a string (or "GENERATE" / "PRESERVE")`);
    }
  }
  if (cfg.tunnel && typeof cfg.tunnel === 'object') {
    const t = cfg.tunnel as { kind?: unknown };
    if (t.kind !== 'none' && t.kind !== 'devtunnel') {
      throw new Error(`${pathOrUrl}: "tunnel.kind" must be "none" or "devtunnel"`);
    }
  }
  if (cfg.external_plugins != null && !Array.isArray(cfg.external_plugins)) {
    throw new Error(`${pathOrUrl}: "external_plugins" must be an array of strings`);
  }
  if (cfg.vaults != null && !Array.isArray(cfg.vaults)) {
    throw new Error(`${pathOrUrl}: "vaults" must be an array`);
  }

  return cfg as InitConfigFile;
}

/**
 * Wrap an interactive prompt so a config-file answer (if any) is used
 * instead of asking the user. Used pervasively in runInit() to keep
 * the surgery small:
 *
 *     const port = await answer(
 *       answers?.http?.port,            // resolved value (or undefined)
 *       () => text({ message: 'HTTP port', ... }),
 *       { nonInteractive, defaultValue: 5201 },
 *     );
 *
 * When `--non-interactive` is set and the answer is undefined, the
 * default is returned without prompting (so unattended runs never
 * hang on missing TTY input).
 */
export async function answer<T>(
  resolved: T | undefined,
  promptFn: () => Promise<T>,
  opts: { nonInteractive: boolean; defaultValue?: T },
): Promise<T> {
  if (resolved !== undefined) return resolved;
  if (opts.nonInteractive) {
    if (opts.defaultValue !== undefined) return opts.defaultValue;
    throw new Error('non-interactive mode requested but no answer or default for required prompt');
  }
  return promptFn();
}

/** Re-export the default-table for use by --emit-config. */
export { defaultAnswer };

