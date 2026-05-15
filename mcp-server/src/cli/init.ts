/**
 * cli/init.ts
 *
 * `clawdevbox init` — interactive project setup.
 *
 * Asks the user for project dir / global dir / HTTP port, mints a bearer
 * token, and writes `<projectDir>/.clawdevbox/config.json`. Also scaffolds
 * the standard subdirectories the MCP server expects (recipes/, skills/,
 * triggers/, plugins/, artifacts/) so the first `mcp` or `start` boot has
 * a populated workspace.
 *
 * Cancelling (Ctrl+C, Esc) exits cleanly without writing anything.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancel, confirm, intro, isCancel, multiselect, note, outro, select, text } from '@clack/prompts';
import {
  BUILTIN_PLUGINS,
  ensureGlobalNodeModulesLink,
  installBuiltinPlugin,
} from '../builtin-plugins.ts';
import {
  CONFIG_DIRNAME,
  ClawdevboxConfig,
  ClawdevboxNotificationsConfig,
  CONFIG_VERSION,
  configPath,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  globalConfigPath,
  readConfig,
  readGlobalConfig,
  writeConfig,
  writeGlobalConfig,
  type TunnelKind,
} from '../config.ts';
import { DEFAULT_VAPID_SUBJECT, generateVapidKeys } from '../notifications.ts';
import { deriveTunnelName } from '../tunnel.ts';
import { loadWorkspaceFromEnv } from '../workspace.ts';
import type { Flags } from './index.ts';
import {
  discoverPluginsInDir,
  installPluginFromDir,
  resolvePluginSource,
  type DiscoveredPlugin,
  type ResolvedSource,
} from './plugin-sources.ts';

// Plugin storage is now global (see §10 in docs/design.md). The project
// dir keeps recipes/skills/triggers/artifacts only; plugins live under
// <globalDir>/plugins/.
const PROJECT_SUBDIRS = ['recipes', 'skills', 'triggers', 'artifacts'];

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function arrFlag(flags: Flags, key: string): string[] {
  const v = flags[key];
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

function abortIfCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('init cancelled — no changes written');
    process.exit(0);
  }
  return value as T;
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function validateDir(input: string): string | void {
  if (input.length === 0) return 'directory is required';
  // Trailing whitespace is almost always a paste/typo error.
  if (input !== input.trim()) return 'no leading/trailing whitespace';
}

function validatePort(input: string): string | void {
  const n = Number.parseInt(input, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    return 'port must be an integer in 1..65535';
  }
}

function validateTunnelName(input: string): string | void {
  if (input.length === 0) return 'tunnel name is required';
  if (!/^[a-z][a-z0-9-]*$/.test(input)) {
    return 'lowercase letters, digits, and hyphens only (must start with a letter)';
  }
  if (input.length > 50) return 'keep it under 50 chars (devtunnel limit)';
}

export async function runInit(flags: Flags): Promise<void> {
  intro('clawdevbox init');

  const cwd = process.cwd();
  const projectDirFlag = str(flags, 'project');
  const scopeFlag = str(flags, 'scope'); // 'global' | 'project' (optional)

  // ---- Install scope ----------------------------------------------------
  // Global (default + recommended): writes <globalDir>/config.json once.
  // Project: legacy per-project config under <projectDir>/.clawdevbox/.
  let installScope: 'global' | 'project';
  if (scopeFlag === 'global' || scopeFlag === 'project') {
    installScope = scopeFlag;
  } else {
    installScope = abortIfCancel(
      await select<Array<{ value: 'global' | 'project'; label: string; hint?: string }>, 'global' | 'project'>({
        message: 'Install scope',
        options: [
          {
            value: 'global',
            label: 'Global (recommended)',
            hint: 'Account-wide config at <globalDir>/config.json — one MCP install for every project.',
          },
          {
            value: 'project',
            label: 'Project-specific',
            hint: 'Per-project config at <projectDir>/.clawdevbox/config.json. Choose this only if you need a different port/token/tunnel per project.',
          },
        ],
        initialValue: 'global',
      }),
    );
  }

  // ---- Project directory -----------------------------------------------
  // Always needed: even global mode anchors plugin lookups and gives a
  // sensible default for project_dir at server-launch time. For global
  // scope the user can just hit Enter to accept cwd — they won't be tied
  // to it in any meaningful way.
  let projectDir: string;
  if (installScope === 'project') {
    const projectDirRaw = abortIfCancel(
      await text({
        message: 'Project directory',
        placeholder: cwd,
        initialValue: projectDirFlag ?? cwd,
        validate: validateDir,
      }),
    );
    projectDir = isAbsolute(projectDirRaw)
      ? resolve(projectDirRaw)
      : resolve(cwd, projectDirRaw);

    if (!existsSync(projectDir)) {
      const create = abortIfCancel(
        await confirm({
          message: `${projectDir} doesn't exist — create it?`,
          initialValue: true,
        }),
      );
      if (!create) {
        cancel('init cancelled — project directory must exist');
        process.exit(0);
      }
      mkdirSync(projectDir, { recursive: true });
    }
  } else {
    // Global scope — use cwd as the project anchor for this install run
    // (mostly so the legacy code that reads `projectDir` keeps working).
    projectDir = projectDirFlag
      ? isAbsolute(projectDirFlag)
        ? resolve(projectDirFlag)
        : resolve(cwd, projectDirFlag)
      : cwd;
    if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });
  }

  // ---- Global directory ------------------------------------------------
  const globalDirDefault = join(homedir(), '.clawdevbox');
  const globalDirRaw = abortIfCancel(
    await text({
      message: 'Global directory (shared across projects)',
      placeholder: globalDirDefault,
      initialValue: globalDirDefault,
      validate: validateDir,
    }),
  );
  const globalDir = isAbsolute(globalDirRaw)
    ? resolve(globalDirRaw)
    : resolve(projectDir, globalDirRaw);

  // ---- Don't silently clobber an existing config -----------------------
  const targetConfigPath =
    installScope === 'global' ? globalConfigPath(globalDir) : configPath(projectDir);
  const existing =
    installScope === 'global' ? readGlobalConfig(globalDir) : readConfig(projectDir);
  if (existing) {
    const overwrite = abortIfCancel(
      await confirm({
        message: `${targetConfigPath} already exists — overwrite?`,
        initialValue: false,
      }),
    );
    if (!overwrite) {
      cancel('init cancelled — existing config left untouched');
      process.exit(0);
    }
  }

  const portRaw = abortIfCancel(
    await text({
      message: 'HTTP port for `clawdevbox start`',
      placeholder: String(DEFAULT_HTTP_PORT),
      initialValue: String(DEFAULT_HTTP_PORT),
      validate: validatePort,
    }),
  );
  const port = Number.parseInt(portRaw, 10);

  const generateNewToken = abortIfCancel(
    await confirm({
      message: 'Generate a new bearer token for the HTTP MCP port?',
      initialValue: true,
    }),
  );
  const token = generateNewToken ? generateToken() : (existing?.http?.token ?? generateToken());

  // ----- Tunnel ---------------------------------------------------------
  const tunnelKind = abortIfCancel(
    await select<Array<{ value: TunnelKind; label: string; hint?: string }>, TunnelKind>({
      message: 'Expose the HTTP MCP port over a public tunnel?',
      options: [
        {
          value: 'none',
          label: 'None — local only',
          hint: 'Loopback access only. Pick this for offline / private dev.',
        },
        {
          value: 'devtunnel',
          label: 'Microsoft Dev Tunnels (stable URL)',
          hint: 'Named tunnel; same URL across restarts. Requires `devtunnel` CLI + `devtunnel user login`.',
        },
      ],
      initialValue: existing?.tunnel?.kind ?? 'none',
    }),
  );

  let tunnelName: string | undefined;
  let tunnelAllowAnon = true;
  if (tunnelKind === 'devtunnel') {
    const derived = existing?.tunnel?.name ?? deriveTunnelName(projectDir);
    const nameRaw = abortIfCancel(
      await text({
        message: 'Tunnel name (becomes part of the URL; must be unique in your dev-tunnels account)',
        placeholder: derived,
        initialValue: derived,
        validate: validateTunnelName,
      }),
    );
    tunnelName = nameRaw.trim();

    tunnelAllowAnon = abortIfCancel(
      await confirm({
        message:
          'Allow anonymous access on the tunnel? Default NO — clients will need a devtunnel access token in addition to the bearer token.',
        initialValue: existing?.tunnel?.allow_anonymous ?? false,
      }),
    );
  }

  // ----- Notifications --------------------------------------------------
  // VAPID keys are minted ONCE and persisted to config — every device that
  // subscribes (via the home-page "Enable notifications" button) is bound
  // to this keypair. Regenerating it invalidates every existing
  // subscription, so we reuse the existing pair if it's already there.
  const wantNotifications = abortIfCancel(
    await confirm({
      message:
        tunnelKind === 'devtunnel'
          ? 'Enable browser push notifications? Strongly recommended for tunnel setups so the agent can ping your phone.'
          : 'Enable browser push notifications? Works on devices that have the home page open. Real-device push requires HTTPS — set up a tunnel for that.',
      initialValue: existing?.notifications?.enabled ?? (tunnelKind === 'devtunnel'),
    }),
  );

  let notificationsConfig: ClawdevboxNotificationsConfig | undefined;
  if (wantNotifications) {
    // Reuse existing keys to keep already-subscribed devices working.
    const existingVapid = existing?.notifications?.vapid;
    if (existingVapid) {
      notificationsConfig = { enabled: true, vapid: existingVapid };
    } else {
      const subject = abortIfCancel(
        await text({
          message: 'Contact identity for push (a `mailto:` or `https://` URL — push services require one)',
          placeholder: DEFAULT_VAPID_SUBJECT,
          initialValue: DEFAULT_VAPID_SUBJECT,
          validate: (v) => {
            if (v.length === 0) return 'required';
            if (!/^(mailto:.+@.+|https?:\/\/.+)$/.test(v)) {
              return 'must start with `mailto:` (and include an @) or `https://`';
            }
          },
        }),
      );
      const keys = generateVapidKeys();
      notificationsConfig = {
        enabled: true,
        vapid: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: subject.trim() },
      };
    }
  } else if (existing?.notifications) {
    notificationsConfig = { ...existing.notifications, enabled: false };
  }

  // ----- Built-in plugins ----------------------------------------------
  // Multi-select from the bundled catalog. Already-installed plugins are
  // pre-checked so re-running init doesn't accidentally drop one. Plugins
  // now live in the global store so the check looks under <globalDir>.
  const globalPluginsDirPath = join(globalDir, 'plugins');
  const alreadyInstalled = new Set<string>();
  for (const p of BUILTIN_PLUGINS) {
    if (existsSync(join(globalPluginsDirPath, p.id))) alreadyInstalled.add(p.id);
  }
  const selectedPluginIds = abortIfCancel(
    await multiselect<
      Array<{ value: string; label: string; hint?: string }>,
      string
    >({
      message:
        'Install built-in plugins? (Space to toggle, Enter to confirm. Plugins are installed once into the global store at <globalDir>/plugins/ and visible to every project.)',
      options: BUILTIN_PLUGINS.map((p) => ({
        value: p.id,
        label: `${p.name} (${p.id})`,
        hint:
          p.description +
          (p.required_env.length ? `  needs: ${p.required_env.join(', ')}` : ''),
      })),
      initialValues: [...alreadyInstalled],
      required: false,
    }),
  );

  // ----- External plugin sources (--plugin <git-url-or-folder>) --------
  // Each --plugin source is resolved (git clone or local path), scanned
  // for plugin.yaml manifests, and the user is asked which discovered
  // plugins to install. Sources are processed sequentially so prompts
  // are ordered. Resolved sources are kept open until the install pass
  // below — git clones live in a temp dir we copy from, then clean up.
  const pluginSourceRaws = arrFlag(flags, 'plugin');
  interface ExternalPick {
    origin: string;
    plugin: DiscoveredPlugin;
    source: ResolvedSource;
    isSinglePluginAtRoot: boolean;
  }
  const externalPicks: ExternalPick[] = [];
  const resolvedSources: ResolvedSource[] = [];
  const sourceDiagnostics: string[] = [];
  try {
    for (const raw of pluginSourceRaws) {
      let source: ResolvedSource;
      try {
        source = resolvePluginSource(raw);
      } catch (err) {
        sourceDiagnostics.push(
          `--plugin ${raw}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      resolvedSources.push(source);
      const { plugins, errors, isSinglePluginAtRoot } = discoverPluginsInDir(source.dir);
      for (const e of errors) {
        sourceDiagnostics.push(`--plugin ${raw}: skipped ${e.dir} (${e.message})`);
      }
      if (plugins.length === 0) {
        sourceDiagnostics.push(
          `--plugin ${raw}: no plugin.yaml found at the root or any subdirectory.`,
        );
        continue;
      }
      // Pre-check plugins that already live in the global plugins store
      // so a re-run doesn't accidentally drop them. Install won't overwrite
      // an existing directory anyway, but the pre-check makes the intent
      // obvious to the user.
      const preChecked = plugins
        .filter((p) => existsSync(join(globalPluginsDirPath, p.id)))
        .map((p) => p.id);
      const chosenIds = abortIfCancel(
        await multiselect<
          Array<{ value: string; label: string; hint?: string }>,
          string
        >({
          message: `Plugins discovered in ${raw} — pick which to install:`,
          options: plugins.map((p) => ({
            value: p.id,
            label: `${p.name} (${p.id}@${p.version})`,
            hint:
              (p.description?.trim() ? p.description.trim().split('\n')[0] : '') +
              (p.required_env.length ? `  needs: ${p.required_env.join(', ')}` : ''),
          })),
          initialValues: preChecked,
          required: false,
        }),
      );
      for (const id of chosenIds) {
        const plugin = plugins.find((p) => p.id === id);
        if (plugin) externalPicks.push({ origin: source.origin, plugin, source, isSinglePluginAtRoot });
      }
    }

    // Scaffold workspace directories so the MCP server finds the expected tree.
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(join(globalDir, 'workspaces'), { recursive: true });
    mkdirSync(globalPluginsDirPath, { recursive: true });
    if (installScope === 'project') {
      mkdirSync(join(projectDir, CONFIG_DIRNAME), { recursive: true });
      for (const sub of PROJECT_SUBDIRS) {
        mkdirSync(join(projectDir, CONFIG_DIRNAME, sub), { recursive: true });
      }
    }

    // Install selected built-in plugins. Errors per-plugin are reported in
    // the summary; we don't abort init if one plugin fails to install.
    // NOTE: plugin install happens BEFORE the config-file write so the
    // workspace reload below sees freshly-installed `provides.agent_clis[]`
    // entries when the chooser builds its options.
    interface PluginResult {
      id: string;
      origin: string;
      status: 'installed' | 'kept' | 'error';
      detail?: string;
      required_env: string[];
    }
    const pluginResults: PluginResult[] = [];
    for (const id of selectedPluginIds) {
      const def = BUILTIN_PLUGINS.find((p) => p.id === id);
      const requiredEnv = def?.required_env ?? [];
      try {
        const r = installBuiltinPlugin(globalDir, id);
        pluginResults.push({
          id,
          origin: 'built-in',
          status: r.copied ? 'installed' : 'kept',
          required_env: requiredEnv,
        });
      } catch (err) {
        pluginResults.push({
          id,
          origin: 'built-in',
          status: 'error',
          detail: err instanceof Error ? err.message : String(err),
          required_env: requiredEnv,
        });
      }
    }

    // Install plugins picked from --plugin sources. Git single-plugin
    // sources are moved (preserving .git for plugin.update); collection
    // subdirs are copied; local folders are junctioned. Sidecar records
    // capture the origin so plugin.update knows what to do.
    for (const pick of externalPicks) {
      try {
        const r = installPluginFromDir({
          globalDir,
          plugin: pick.plugin,
          origin: pick.origin,
          source: pick.source,
        });
        pluginResults.push({
          id: pick.plugin.id,
          origin: pick.origin,
          status: r.copied ? 'installed' : 'kept',
          required_env: pick.plugin.required_env,
        });
      } catch (err) {
        pluginResults.push({
          id: pick.plugin.id,
          origin: pick.origin,
          status: 'error',
          detail: err instanceof Error ? err.message : String(err),
          required_env: pick.plugin.required_env,
        });
      }
    }

    // Make sure node_modules is junctioned into <globalDir> so plugin
    // tools that `import 'zod'` resolve from the global plugin store.
    // installBuiltinPlugin() already calls this; the call here also
    // covers the external-plugins-only case (no built-ins picked).
    if (pluginResults.length > 0) {
      ensureGlobalNodeModulesLink(globalDir);
    }

    // ---- Workspace reload -------------------------------------------------
    // Plugins were just installed; load a workspace so reloadTypeRegistries
    // picks up their provides.agent_clis[] entries. Subsequent phases (the
    // CLI chooser) read `ws.agentCliProviders` off this. Failure is
    // non-fatal — the user can fix and rerun.
    try {
      const tmpEnv = {
        ...process.env,
        CLAWDEVBOX_PROJECT_DIR: projectDir,
        CLAWDEVBOX_GLOBAL_DIR: globalDir,
      };
      await loadWorkspaceFromEnv(tmpEnv);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[clawdevbox] post-install workspace load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const cfg: ClawdevboxConfig = {
      version: CONFIG_VERSION,
      // Global configs omit project_dir — the project is the cwd at
      // server-launch time.
      ...(installScope === 'project' ? { project_dir: projectDir } : {}),
      global_dir: globalDir,
      workspaces_root: join(globalDir, 'workspaces'),
      http: { port, host: DEFAULT_HTTP_HOST, token },
      tunnel:
        tunnelKind === 'devtunnel'
          ? {
              kind: 'devtunnel',
              name: tunnelName,
              allow_anonymous: tunnelAllowAnon,
              auto_start: true,
            }
          : { kind: 'none' },
      notifications: notificationsConfig,
    };

    const written =
      installScope === 'global'
        ? writeGlobalConfig(globalDir, cfg)
        : writeConfig(projectDir, cfg);

    const tunnelLine =
      tunnelKind === 'devtunnel'
        ? `Tunnel:      devtunnel "${tunnelName}" (auto-starts; URL stable across restarts)`
        : `Tunnel:      none (local only)`;
    const notificationsLine =
      notificationsConfig?.enabled
        ? `Notifications: enabled (VAPID keys minted — devices subscribe via the home page)`
        : `Notifications: disabled`;

    const tunnelNextSteps =
      tunnelKind === 'devtunnel'
        ? [
            `  • devtunnel user login              (one-time, if you haven't already)`,
          ]
        : [];

    const pluginLines: string[] = [];
    if (pluginResults.length > 0) {
      pluginLines.push('Plugins:');
      for (const r of pluginResults) {
        const sym = r.status === 'installed' ? '+' : r.status === 'kept' ? '=' : 'x';
        const originLabel = r.origin === 'built-in' ? '' : ` ← ${r.origin}`;
        pluginLines.push(
          `  ${sym} ${r.id}${originLabel}${
            r.status === 'kept'
              ? ' (already installed — left untouched)'
              : r.status === 'error'
                ? ` (failed: ${r.detail ?? '?'})`
                : ''
          }`,
        );
      }
    }

    if (sourceDiagnostics.length > 0) {
      pluginLines.push('', 'Source warnings:');
      for (const d of sourceDiagnostics) pluginLines.push(`  ! ${d}`);
    }

    // Surface env-var requirements so the user can export them right away.
    const envHints = new Map<string, string[]>();
    for (const r of pluginResults) {
      if (r.status === 'error') continue;
      for (const e of r.required_env) {
        const list = envHints.get(e) ?? [];
        list.push(r.id);
        envHints.set(e, list);
      }
    }
    const envLines: string[] = [];
    if (envHints.size > 0) {
      envLines.push('Required env vars:');
      for (const [env, ids] of envHints) {
        envLines.push(`  ${env}    (used by: ${ids.join(', ')})`);
      }
    }

    note(
      [
        `Scope:       ${installScope}`,
        `Config:      ${written}`,
        ...(installScope === 'project' ? [`Project dir: ${projectDir}`] : []),
        `Global dir:  ${globalDir}`,
        `HTTP:        ${DEFAULT_HTTP_HOST}:${port}  (bearer token saved to config)`,
        tunnelLine,
        notificationsLine,
        ...(pluginLines.length ? ['', ...pluginLines] : []),
        ...(envLines.length ? ['', ...envLines] : []),
        '',
        `Next steps:`,
        ...tunnelNextSteps,
        `  • clawdevbox mcp                    stdio MCP for Claude Code / Copilot CLI`,
        `  • clawdevbox start                  HTTP MCP server on port ${port}`,
        `  • clawdevbox start --service        run as background service (auto-starts at login)`,
        ...(notificationsConfig?.enabled
          ? [
              `  • open the tunnel URL on your phone → tap Enable Notifications to subscribe`,
            ]
          : []),
      ].join('\n'),
      'Initialized',
    );

    // ---- Optional: install as background service now ------------------
    // Only offered when the user picked the global scope. The service is
    // an account-wide installation, so per-project init shouldn't tempt
    // the user into bundling it.
    if (installScope === 'global') {
      const installNow = abortIfCancel(
        await confirm({
          message:
            'Install Clawdevbox as a background service now? (auto-starts at login; stop later with `clawdevbox stop`)',
          initialValue: true,
        }),
      );
      if (installNow) {
        const r = await tryInstallService({ globalDir, projectDir, port, token });
        if (r.ok) {
          note(
            [
              `pid:        ${r.pid}`,
              `port:       ${port}`,
              `health:     http://${DEFAULT_HTTP_HOST}:${port}/healthz`,
              `state file: ${join(globalDir, 'service.json')}`,
              ...(r.logPath ? [`log file:   ${r.logPath}`] : []),
              r.autoStart
                ? `auto-start: ${r.autoStart.platform} (${r.autoStart.path})`
                : `auto-start: SKIPPED (${r.autoStartError ?? 'unsupported'})`,
              ``,
              `Stop with: clawdevbox stop`,
            ].join('\n'),
            'Service installed',
          );

          // If the user picked devtunnel, surface the public URL + QR
          // code so a phone can connect immediately. Poll for up to 30s
          // since devtunnel cold-start can take a few seconds after the
          // HTTP server is healthy.
          if (tunnelKind === 'devtunnel') {
            const { fetchTunnelStatus } = await import('../service.ts');
            const { renderTunnelInfo } = await import('./tunnel-display.ts');
            const tunnel = await fetchTunnelStatus({
              host: DEFAULT_HTTP_HOST,
              port,
              token,
              timeoutMs: 30000,
              waitForUrl: true,
            });
            if (tunnel?.url) {
              renderTunnelInfo({
                url: tunnel.url,
                token,
                inspectUrl: tunnel.inspect_url ?? null,
              });
            } else if (tunnel?.error) {
              note(
                `Tunnel did not come up: ${tunnel.error}`,
                'Tunnel error',
              );
            } else {
              note(
                `Tunnel URL not yet available — run \`clawdevbox status\` once the tunnel finishes registering.`,
                'Tunnel pending',
              );
            }
          }
        } else {
          const lines = [`Service install failed: ${r.error}`];
          if (r.logPath) {
            lines.push(`See log: ${r.logPath}`);
          }
          lines.push(`Try running \`clawdevbox start\` in the foreground to see the underlying error.`);
          note(lines.join('\n'), 'Service install failed');
        }
      }
    }

    outro('Ready.');
  } finally {
    for (const s of resolvedSources) s.cleanup();
  }
}

/**
 * Best-effort service install from inside `init`. We mirror the logic in
 * `cli/start.ts::installAsService` but inline so init doesn't depend on
 * the start module. The detached child runs `clawdevbox start` with the
 * resolved port/token so it picks up the just-written config.
 */
async function tryInstallService(args: {
  globalDir: string;
  projectDir: string;
  port: number;
  token: string;
}): Promise<
  | {
      ok: true;
      pid: number;
      logPath: string | null;
      autoStart: { installed: boolean; path: string; platform: string } | null;
      autoStartError: string | null;
    }
  | { ok: false; error: string; logPath: string | null }
> {
  const service = await import('../service.ts');
  // If a previous install is still alive, refuse to spawn a second.
  const existing = service.readServiceState(args.globalDir);
  if (existing && service.isProcessAlive(existing.pid)) {
    return {
      ok: true,
      pid: existing.pid,
      logPath: service.serviceLogPath(args.globalDir),
      autoStart: null,
      autoStartError: 'service already running — skipping spawn',
    };
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const cliCandidates = [
    process.argv[1],
    resolve(here, '..', '..', 'dist', 'cli.js'),
    resolve(here, '..', 'cli.js'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const cliPath = cliCandidates.find((p) => existsSync(p)) ?? cliCandidates[0] ?? '';
  if (!cliPath) {
    return { ok: false, error: 'could not resolve clawdevbox CLI entry path', logPath: null };
  }

  const execPath = process.execPath;
  const childArgs = [cliPath, 'start', '--global', args.globalDir];

  let pid: number;
  let logPath: string | null = null;
  try {
    const r = service.spawnDetached(execPath, childArgs, { logDir: args.globalDir });
    pid = r.pid;
    logPath = r.logPath;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      logPath: null,
    };
  }
  service.writeServiceState(args.globalDir, {
    pid,
    port: args.port,
    started_at: Date.now(),
    version: '0.0.0',
    exec_path: execPath,
    exec_args: childArgs,
  });

  // Probe /healthz so init reports the service as installed only when it's
  // actually serving. 30s is generous to cover cold-starts with many
  // plugins. On failure, clean up the state file + best-effort kill the
  // child so a follow-up `clawdevbox stop` is a clean no-op.
  const probe = await service.probeHealth({
    host: '127.0.0.1',
    port: args.port,
    timeoutMs: 30000,
  });
  if (!probe.ok) {
    try {
      if (service.isProcessAlive(pid)) {
        if (process.platform === 'win32') {
          const { spawnSync } = await import('node:child_process');
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGTERM');
        }
      }
    } catch {
      /* best-effort */
    }
    service.clearServiceState(args.globalDir);
    return { ok: false, error: `health probe failed: ${probe.reason}`, logPath };
  }

  let autoStart: { installed: boolean; path: string; platform: string } | null = null;
  let autoStartError: string | null = null;
  if (service.autoStartPlatform() !== 'unsupported') {
    try {
      autoStart = service.installAutoStart({ execPath, args: childArgs });
    } catch (err) {
      autoStartError = err instanceof Error ? err.message : String(err);
    }
  } else {
    autoStartError = 'platform not supported';
  }

  return { ok: true, pid, logPath, autoStart, autoStartError };
}
