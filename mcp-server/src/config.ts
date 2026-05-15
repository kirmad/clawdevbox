/**
 * config.ts
 *
 * `.clawdevbox/config.json` schema + resolver.
 *
 * Two on-disk layers:
 *   1. Global config at `<globalDir>/config.json`. Account-wide settings
 *      (HTTP port, token, tunnel, notifications) that apply to every
 *      project the MCP server is run against. Written by
 *      `clawdevbox init` when the user picks the "global" install scope.
 *   2. Project config at `<projectDir>/.clawdevbox/config.json`. Overrides
 *      the global layer for a specific project. Written by the legacy
 *      "project-specific" install scope.
 *
 * Precedence (highest first):
 *   1. Explicit options passed to resolveConfig() (CLI flags)
 *   2. Environment variables (CLAWDEVBOX_PROJECT_DIR, CLAWDEVBOX_PORT, ...)
 *   3. Project config (`<projectDir>/.clawdevbox/config.json`)
 *   4. Global config (`<globalDir>/config.json`)
 *   5. Built-in defaults
 *
 * The resolver returns absolute paths and a complete `http` block so callers
 * don't have to re-derive anything. It does NOT mutate process.env — the CLI
 * does that explicitly before booting subprocesses.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const CONFIG_DIRNAME = '.clawdevbox';
export const CONFIG_FILENAME = 'config.json';
/** Name of the global config file under `<globalDir>/`. */
export const GLOBAL_CONFIG_FILENAME = 'config.json';
export const DEFAULT_HTTP_PORT = 5201;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const CONFIG_VERSION = 1 as const;

export interface ClawdevboxHttpConfig {
  port?: number;
  host?: string;
  /** Bearer token required on /mcp. Treat as a secret. */
  token?: string;
}

export type TunnelKind = 'none' | 'devtunnel';

export interface ClawdevboxTunnelConfig {
  kind: TunnelKind;
  /**
   * Stable tunnel name. Becomes the devtunnel tunnel-id; the public URL is
   * deterministic from this name + the registered port (e.g.
   * `https://<name>-5201.usw2.devtunnels.ms`). Lowercase alnum + hyphens.
   */
  name?: string;
  /**
   * When true, the tunnel is created with `--allow-anonymous` so external
   * clients can reach `/mcp` without a devtunnel access token. The HTTP
   * server's bearer-token auth on `/mcp` is still in effect, so this is the
   * normal/safe default.
   */
  allow_anonymous?: boolean;
  /**
   * When true (default), `clawdevbox start` brings the tunnel up automatically.
   */
  auto_start?: boolean;
}

export interface ClawdevboxVapidKeys {
  /** Base64url-encoded uncompressed P-256 public key. Safe to ship to the browser. */
  publicKey: string;
  /** Base64url-encoded P-256 private key. SECRET — only used server-side by web-push. */
  privateKey: string;
  /** mailto: or http(s):// — push services require an identity for VAPID. */
  subject: string;
}

export interface ClawdevboxNotificationsConfig {
  /** Master switch — when false, /api/push/* still respond but no setup is performed. */
  enabled?: boolean;
  /** VAPID keypair. Generated once by `clawdevbox init` and reused forever. */
  vapid?: ClawdevboxVapidKeys;
}

export interface ClawdevboxConfig {
  version: typeof CONFIG_VERSION;
  /**
   * Project the config was authored against. Required for project-scope
   * configs (`<projectDir>/.clawdevbox/config.json`); omitted for global
   * configs (`<globalDir>/config.json`) where the project is the cwd at
   * server-launch time.
   */
  project_dir?: string;
  global_dir?: string;
  workspaces_root?: string;
  http?: ClawdevboxHttpConfig;
  tunnel?: ClawdevboxTunnelConfig;
  notifications?: ClawdevboxNotificationsConfig;
}

export interface ResolvedConfig {
  projectDir: string;
  globalDir: string;
  workspacesRoot: string;
  http: {
    port: number;
    host: string;
    token: string | null;
  };
  tunnel: {
    kind: TunnelKind;
    name: string | null;
    allow_anonymous: boolean;
    auto_start: boolean;
  };
  notifications: {
    enabled: boolean;
    vapid: ClawdevboxVapidKeys | null;
  };
  /** Path to the config file that produced this (null if defaults-only). */
  configPath: string | null;
}

export class ConfigError extends Error {
  readonly code = 'CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function configPath(projectDir: string): string {
  return join(projectDir, CONFIG_DIRNAME, CONFIG_FILENAME);
}

/** Path to the account-wide config under the global dir. */
export function globalConfigPath(globalDir: string): string {
  return join(globalDir, GLOBAL_CONFIG_FILENAME);
}

export function readConfig(projectDir: string): ClawdevboxConfig | null {
  return readConfigAt(configPath(projectDir));
}

/** Read the global config at `<globalDir>/config.json`, if present. */
export function readGlobalConfig(globalDir: string): ClawdevboxConfig | null {
  return readConfigAt(globalConfigPath(globalDir));
}

function readConfigAt(p: string): ClawdevboxConfig | null {
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `failed to read ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `${p} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateConfig(parsed, p);
}

export function writeConfig(projectDir: string, cfg: ClawdevboxConfig): string {
  const p = configPath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return p;
}

/** Write a global config to `<globalDir>/config.json`. */
export function writeGlobalConfig(globalDir: string, cfg: ClawdevboxConfig): string {
  const p = globalConfigPath(globalDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return p;
}

/**
 * Merge the project + global config layers and return the consolidated
 * `notifications` block. MCP tools (which only have `Workspace` —
 * `projectDir` + `globalDir` — and not a ResolvedConfig) call this to see
 * the same `notifications.enabled` + VAPID keys the HTTP server uses.
 *
 * Precedence matches resolveConfig: project layer wins over global layer.
 * Returns `{ enabled: false, vapid: null }` if neither layer enables push.
 */
export function loadNotificationsConfig(args: {
  projectDir: string;
  globalDir: string;
}): { enabled: boolean; vapid: ClawdevboxVapidKeys | null } {
  let projectCfg: ClawdevboxConfig | null = null;
  let globalCfg: ClawdevboxConfig | null = null;
  try { projectCfg = readConfig(args.projectDir); } catch { /* ignore — fall through */ }
  try { globalCfg = readGlobalConfig(args.globalDir); } catch { /* ignore */ }

  // Project layer wins. A layer "wins" only if its `notifications` block
  // is actually present; otherwise fall through to the next layer.
  const fromProject = projectCfg?.notifications;
  const fromGlobal = globalCfg?.notifications;
  const enabled =
    fromProject?.enabled !== undefined
      ? !!fromProject.enabled
      : !!fromGlobal?.enabled;
  const vapid =
    fromProject?.vapid ?? fromGlobal?.vapid ?? null;
  return { enabled: enabled && !!vapid, vapid };
}

function validateConfig(parsed: unknown, source: string): ClawdevboxConfig {
  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError(`${source}: root must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CONFIG_VERSION) {
    throw new ConfigError(
      `${source}: unsupported config version ${obj.version} (expected ${CONFIG_VERSION})`,
    );
  }
  if (obj.project_dir !== undefined && (typeof obj.project_dir !== 'string' || obj.project_dir.length === 0)) {
    throw new ConfigError(`${source}: project_dir, when present, must be a non-empty string`);
  }
  if (obj.global_dir !== undefined && typeof obj.global_dir !== 'string') {
    throw new ConfigError(`${source}: global_dir must be a string`);
  }
  if (obj.workspaces_root !== undefined && typeof obj.workspaces_root !== 'string') {
    throw new ConfigError(`${source}: workspaces_root must be a string`);
  }
  let tunnel: ClawdevboxTunnelConfig | undefined;
  if (obj.tunnel !== undefined) {
    if (!obj.tunnel || typeof obj.tunnel !== 'object') {
      throw new ConfigError(`${source}: tunnel must be an object`);
    }
    const t = obj.tunnel as Record<string, unknown>;
    if (t.kind !== 'none' && t.kind !== 'devtunnel') {
      throw new ConfigError(`${source}: tunnel.kind must be 'none' or 'devtunnel'`);
    }
    tunnel = { kind: t.kind };
    if (t.name !== undefined) {
      if (typeof t.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(t.name)) {
        throw new ConfigError(
          `${source}: tunnel.name must match [a-z][a-z0-9-]* (devtunnel naming rule)`,
        );
      }
      tunnel.name = t.name;
    }
    if (t.allow_anonymous !== undefined) {
      if (typeof t.allow_anonymous !== 'boolean') {
        throw new ConfigError(`${source}: tunnel.allow_anonymous must be a boolean`);
      }
      tunnel.allow_anonymous = t.allow_anonymous;
    }
    if (t.auto_start !== undefined) {
      if (typeof t.auto_start !== 'boolean') {
        throw new ConfigError(`${source}: tunnel.auto_start must be a boolean`);
      }
      tunnel.auto_start = t.auto_start;
    }
  }

  let notifications: ClawdevboxNotificationsConfig | undefined;
  if (obj.notifications !== undefined) {
    if (!obj.notifications || typeof obj.notifications !== 'object') {
      throw new ConfigError(`${source}: notifications must be an object`);
    }
    const n = obj.notifications as Record<string, unknown>;
    notifications = {};
    if (n.enabled !== undefined) {
      if (typeof n.enabled !== 'boolean') {
        throw new ConfigError(`${source}: notifications.enabled must be a boolean`);
      }
      notifications.enabled = n.enabled;
    }
    if (n.vapid !== undefined) {
      if (!n.vapid || typeof n.vapid !== 'object') {
        throw new ConfigError(`${source}: notifications.vapid must be an object`);
      }
      const v = n.vapid as Record<string, unknown>;
      if (typeof v.publicKey !== 'string' || v.publicKey.length === 0) {
        throw new ConfigError(`${source}: notifications.vapid.publicKey is required`);
      }
      if (typeof v.privateKey !== 'string' || v.privateKey.length === 0) {
        throw new ConfigError(`${source}: notifications.vapid.privateKey is required`);
      }
      if (typeof v.subject !== 'string' || v.subject.length === 0) {
        throw new ConfigError(`${source}: notifications.vapid.subject is required`);
      }
      notifications.vapid = {
        publicKey: v.publicKey,
        privateKey: v.privateKey,
        subject: v.subject,
      };
    }
  }

  let http: ClawdevboxHttpConfig | undefined;
  if (obj.http !== undefined) {
    if (!obj.http || typeof obj.http !== 'object') {
      throw new ConfigError(`${source}: http must be an object`);
    }
    const h = obj.http as Record<string, unknown>;
    http = {};
    if (h.port !== undefined) {
      if (typeof h.port !== 'number' || !Number.isInteger(h.port) || h.port <= 0 || h.port > 65535) {
        throw new ConfigError(`${source}: http.port must be an integer in 1..65535`);
      }
      http.port = h.port;
    }
    if (h.host !== undefined) {
      if (typeof h.host !== 'string' || h.host.length === 0) {
        throw new ConfigError(`${source}: http.host must be a non-empty string`);
      }
      http.host = h.host;
    }
    if (h.token !== undefined) {
      if (typeof h.token !== 'string') {
        throw new ConfigError(`${source}: http.token must be a string`);
      }
      http.token = h.token;
    }
  }
  return {
    version: CONFIG_VERSION,
    project_dir: obj.project_dir,
    global_dir: obj.global_dir as string | undefined,
    workspaces_root: obj.workspaces_root as string | undefined,
    http,
    tunnel,
    notifications,
  };
}

export interface ResolveOptions {
  /** CLI --project flag, or undefined to read env / cwd. */
  projectDir?: string;
  /** CLI --global flag. */
  globalDir?: string;
  /** CLI --workspaces-root flag. */
  workspacesRoot?: string;
  /** CLI --port flag. */
  port?: number;
  /** CLI --host flag. */
  host?: string;
  /** CLI --token flag (rarely used; usually comes from config). */
  token?: string;
  /** Environment object (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Override cwd (for testing). */
  cwd?: string;
}

/**
 * Resolve the runtime config from (in order): CLI flags, env vars, project
 * config (`<projectDir>/.clawdevbox/config.json`), global config
 * (`<globalDir>/config.json`), defaults. Both file layers are optional.
 *
 * The project dir is the anchor for the project layer; it defaults to cwd
 * when no flag / env var is provided. The global dir defaults to
 * `~/.clawdevbox` (or whatever either config layer explicitly sets) and is
 * where the account-wide layer lives.
 *
 * Resolution does NOT require either config to exist — defaults cover
 * everything except the bearer token. If the caller needs a token
 * (e.g. `start` subcommand) they should check `resolved.http.token` and
 * fail or generate as appropriate.
 */
export function resolveConfig(opts: ResolveOptions = {}): ResolvedConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const projectDirRaw =
    opts.projectDir ?? env.CLAWDEVBOX_PROJECT_DIR ?? cwd;
  const projectDir = isAbsolute(projectDirRaw)
    ? resolve(projectDirRaw)
    : resolve(cwd, projectDirRaw);

  if (!existsSync(projectDir)) {
    throw new ConfigError(`project directory does not exist: ${projectDir}`);
  }

  // Read the project-scope config first — it (optionally) tells us where
  // the global dir lives. If absent, we fall through to env / default.
  const projectCfg = readConfig(projectDir);

  const globalDirRaw =
    opts.globalDir ??
    env.CLAWDEVBOX_GLOBAL_DIR ??
    projectCfg?.global_dir ??
    join(homedir(), '.clawdevbox');
  const globalDir = isAbsolute(globalDirRaw)
    ? resolve(globalDirRaw)
    : resolve(projectDir, globalDirRaw);

  // Read the global config layer. Per project > global precedence, project
  // values win when both are set.
  const globalCfg = readGlobalConfig(globalDir);

  /** Layered lookup: project field, falling back to global field. */
  const layered = <T>(pick: (c: ClawdevboxConfig) => T | undefined): T | undefined => {
    const fromProject = projectCfg ? pick(projectCfg) : undefined;
    if (fromProject !== undefined) return fromProject;
    const fromGlobal = globalCfg ? pick(globalCfg) : undefined;
    return fromGlobal;
  };

  const workspacesRootRaw =
    opts.workspacesRoot ??
    env.CLAWDEVBOX_WORKSPACES_ROOT ??
    layered((c) => c.workspaces_root) ??
    join(globalDir, 'workspaces');
  const workspacesRoot = isAbsolute(workspacesRootRaw)
    ? resolve(workspacesRootRaw)
    : resolve(globalDir, workspacesRootRaw);

  const portRaw =
    opts.port ??
    parsePortEnv(env.CLAWDEVBOX_PORT) ??
    layered((c) => c.http?.port) ??
    DEFAULT_HTTP_PORT;
  const host =
    opts.host ?? env.CLAWDEVBOX_HOST ?? layered((c) => c.http?.host) ?? DEFAULT_HTTP_HOST;
  const token =
    opts.token ?? env.CLAWDEVBOX_TOKEN ?? layered((c) => c.http?.token) ?? null;

  const tunnelKind: TunnelKind =
    (env.CLAWDEVBOX_TUNNEL_KIND as TunnelKind | undefined) ??
    layered((c) => c.tunnel?.kind) ??
    'none';
  const tunnelName =
    env.CLAWDEVBOX_TUNNEL_NAME ?? layered((c) => c.tunnel?.name) ?? null;
  const tunnelAllowAnon = layered((c) => c.tunnel?.allow_anonymous) ?? false;
  const tunnelAutoStart = layered((c) => c.tunnel?.auto_start) ?? true;

  const notificationsEnabled = !!layered((c) => c.notifications?.enabled);
  const notificationsVapid = layered((c) => c.notifications?.vapid) ?? null;

  // Pick a representative configPath: prefer project layer when present,
  // otherwise the global layer, otherwise null.
  const configPathUsed = projectCfg
    ? configPath(projectDir)
    : globalCfg
      ? globalConfigPath(globalDir)
      : null;

  return {
    projectDir,
    globalDir,
    workspacesRoot,
    http: { port: portRaw, host, token },
    tunnel: {
      kind: tunnelKind,
      name: tunnelName,
      allow_anonymous: tunnelAllowAnon,
      auto_start: tunnelAutoStart,
    },
    notifications: {
      enabled: notificationsEnabled,
      vapid: notificationsVapid,
    },
    configPath: configPathUsed,
  };
}

function parsePortEnv(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new ConfigError(`CLAWDEVBOX_PORT must be an integer in 1..65535 (got ${v})`);
  }
  return n;
}

/**
 * Apply a resolved config to the environment of the current process so
 * existing modules (workspace.ts, terminal-server.ts, etc.) that read
 * env vars pick them up. Idempotent — only fills keys that aren't already
 * set so explicit env wins.
 */
export function applyConfigToEnv(cfg: ResolvedConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.CLAWDEVBOX_PROJECT_DIR) env.CLAWDEVBOX_PROJECT_DIR = cfg.projectDir;
  if (!env.CLAWDEVBOX_GLOBAL_DIR) env.CLAWDEVBOX_GLOBAL_DIR = cfg.globalDir;
  if (!env.CLAWDEVBOX_WORKSPACES_ROOT) env.CLAWDEVBOX_WORKSPACES_ROOT = cfg.workspacesRoot;
  if (!env.CLAWDEVBOX_PORT) env.CLAWDEVBOX_PORT = String(cfg.http.port);
  if (!env.CLAWDEVBOX_HOST) env.CLAWDEVBOX_HOST = cfg.http.host;
  if (cfg.http.token && !env.CLAWDEVBOX_TOKEN) env.CLAWDEVBOX_TOKEN = cfg.http.token;
}
