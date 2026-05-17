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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancel, confirm, intro, isCancel, log, multiselect, note, outro, select, spinner, text } from '@clack/prompts';
import {
  ensureBuiltinMarketplaceRegistered,
  ensureGlobalNodeModulesLink,
} from '../builtin-marketplace.ts';
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
  resolveConfig,
  writeConfig,
  writeGlobalConfig,
  type ResolvedConfig,
  type TunnelKind,
} from '../config.ts';
import { DEFAULT_VAPID_SUBJECT, generateVapidKeys } from '../notifications.ts';
import { deriveTunnelName } from '../tunnel.ts';
import { loadWorkspaceFromEnv, type Workspace } from '../workspace.ts';
import { buildProviderCtx } from '../agent-clis/shared.ts';
import type { DetectResult } from '../agent-clis/types.ts';
import type { Flags } from './index.ts';
import { probeClientPlugins } from './probe-client-plugins.ts';
import { runClientPluginProbePrompt } from './init-probe-prompt.ts';
import {
  discoverPluginsInDir,
  installPluginFromDir,
  resolvePluginSource,
  type DiscoveredPlugin,
  type ResolvedSource,
} from './plugin-sources.ts';
import { filterByEngines, loadMarketplace } from '../manifest/load-marketplace.ts';
import { validateAgencyJson } from '../validators.ts';
import { readFileSync } from 'node:fs';
import type { AgencyJson } from '../manifest/types.ts';
import { logger } from '../logger.ts';

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

function boolFlag(flags: Flags, key: string): boolean {
  const v = flags[key];
  return v === true || v === 'true' || v === '1';
}

/**
 * Format the linked/copied breakdown shown after the install spinner.
 * Returns an empty string when nothing was installed (so the caller can
 * tack it onto either the success or error message without padding).
 *
 * Examples:
 *   linked=3, copied=0 → " (linked to source — edits auto-flow)"
 *   linked=0, copied=2 → ""                      // not noteworthy
 *   linked=2, copied=1 → " (2 linked, 1 copied)"
 */
function describeInstallBreakdown(linked: number, copied: number): string {
  if (linked === 0) return '';
  if (copied === 0) return ' (linked to source — edits auto-flow)';
  return ` (${linked} linked, ${copied} copied)`;
}

function isClawdevboxOnPath(): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, ['clawdevbox'], { stdio: 'pipe', windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

interface BuiltinInstallContext {
  marketplaceDir: string;
  globalDir: string;
  globalPluginsDirPath: string;
  results: Array<{
    name: string;
    status: 'installed' | 'kept' | 'error';
    detail?: string;
    required_env: string[];
  }>;
}

/**
 * Tier-driven install pass over the bundled marketplace at
 * `<globalDir>/marketplaces/clawdevbox/`. Auto-installs `required`
 * entries, then prompts for `recommended` + `optional` ones with the
 * appropriate pre-checked state. Each entry's `clawdevbox` slot
 * (`install_tier`, `required_env`) is read from the raw marketplace.json
 * since those are clawdevbox-specific extensions not carried on
 * `ResolvedMarketplacePluginEntry`.
 */
async function runBuiltinMarketplaceInstall(ctx: BuiltinInstallContext): Promise<void> {
  const { marketplaceDir, globalDir, globalPluginsDirPath, results } = ctx;

  // Validate the catalog (and surface load errors as a single note).
  await loadMarketplace(marketplaceDir);

  // Read the raw catalog so we can pick up the clawdevbox.* extension
  // fields (install_tier, required_env) that the resolver drops.
  type RawEntry = {
    name: string;
    description?: string;
    version?: string;
    clawdevbox?: { install_tier?: string; required_env?: string[] };
  };
  const raw = JSON.parse(
    readFileSync(join(marketplaceDir, '.claude-plugin', 'marketplace.json'), 'utf8'),
  ) as { plugins: RawEntry[] };

  // Discover on-disk plugin dirs (sync; we need DiscoveredPlugin → installPluginFromDir).
  const { plugins: discovered, errors: discoverErrors } =
    discoverPluginsInDir(marketplaceDir);
  if (discoverErrors.length > 0) {
    const lines = discoverErrors.map((e) => `  • ${e.message}`).join('\n');
    log.warn(`Built-in marketplace: ${discoverErrors.length} entr${discoverErrors.length === 1 ? 'y' : 'ies'} skipped\n${lines}`);
  }
  const byName = new Map<string, DiscoveredPlugin>();
  for (const p of discovered) byName.set(p.id, p);

  const fakeSource: ResolvedSource = {
    origin: 'built-in',
    dir: marketplaceDir,
    isGitClone: false,
    isLocalFolder: false,
    cleanup() {
      /* nothing to clean for built-in marketplace */
    },
  };

  function installOne(rawEntry: RawEntry): void {
    const plugin = byName.get(rawEntry.name);
    if (!plugin) {
      results.push({
        name: rawEntry.name,
        status: 'error',
        detail: 'plugin directory not found in bundled marketplace',
        required_env: rawEntry.clawdevbox?.required_env ?? [],
      });
      return;
    }
    try {
      const r = installPluginFromDir({
        globalDir,
        plugin,
        origin: 'built-in',
        source: fakeSource,
      });
      results.push({
        name: rawEntry.name,
        status: r.copied ? 'installed' : 'kept',
        required_env: rawEntry.clawdevbox?.required_env ?? plugin.required_env,
      });
    } catch (err) {
      results.push({
        name: rawEntry.name,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
        required_env: rawEntry.clawdevbox?.required_env ?? [],
      });
    }
  }

  // Auto-install required tier.
  const requiredEntries = raw.plugins.filter(
    (p) => p.clawdevbox?.install_tier === 'required',
  );
  let installedAnyRequired = false;
  for (const e of requiredEntries) {
    const before = results.length;
    installOne(e);
    const r = results[before];
    if (r?.status === 'installed') installedAnyRequired = true;
  }
  if (installedAnyRequired && !isClawdevboxOnPath()) {
    log.warn(
      `'clawdevbox' is not on PATH. Run \`npm install -g clawdevbox\` so the CLI integration installed by clawdevbox-mcp works.`,
    );
  }

  // Multi-select for recommended + optional.
  const choosable = raw.plugins.filter((p) => {
    const tier = p.clawdevbox?.install_tier;
    return tier === 'recommended' || tier === 'optional';
  });
  if (choosable.length === 0) return;

  const alreadyInstalled = new Set<string>();
  for (const e of choosable) {
    if (existsSync(join(globalPluginsDirPath, e.name))) alreadyInstalled.add(e.name);
  }
  const initialValues = choosable
    .filter(
      (e) =>
        e.clawdevbox?.install_tier === 'recommended' || alreadyInstalled.has(e.name),
    )
    .map((e) => e.name);

  const selected = abortIfCancel(
    await multiselect<Array<{ value: string; label: string; hint?: string }>, string>({
      message: 'Install built-in plugins from clawdevbox marketplace?',
      options: choosable.map((e) => {
        const tier = e.clawdevbox?.install_tier ?? 'optional';
        const reqEnv = e.clawdevbox?.required_env ?? [];
        const tierLabel = tier === 'recommended' ? ' (recommended)' : '';
        return {
          value: e.name,
          label: `${e.name}${e.version ? `@${e.version}` : ''}${tierLabel}`,
          hint:
            (e.description ?? '') +
            (reqEnv.length ? `  needs: ${reqEnv.join(', ')}` : ''),
        };
      }),
      initialValues,
      required: false,
    }),
  );

  if (selected.length === 0) return;
  const instSpinner = spinner();
  instSpinner.start(`Installing ${selected.length} built-in plugin${selected.length === 1 ? '' : 's'}...`);
  for (const name of selected) {
    instSpinner.message(`Installing ${name}...`);
    if (alreadyInstalled.has(name)) {
      // The install function itself reports `kept` when the dir exists,
      // but recording it explicitly keeps the summary line.
      const e = choosable.find((x) => x.name === name);
      if (e) installOne(e);
      continue;
    }
    const e = choosable.find((x) => x.name === name);
    if (e) installOne(e);
  }
  const installedNow = ctx.results.filter((r) => r.status === 'installed').length;
  const keptNow = ctx.results.filter((r) => r.status === 'kept').length;
  const errCount = ctx.results.filter((r) => r.status === 'error').length;
  const parts = [];
  if (installedNow > 0) parts.push(`+${installedNow}`);
  if (keptNow > 0) parts.push(`${keptNow} kept`);
  if (errCount > 0) parts.push(`${errCount} failed`);
  instSpinner.stop(`Built-in install: ${parts.join(', ') || 'no changes'}.`);
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
  // Silence the pino info-level chatter (e.g. 'agent-cli provider loaded',
  // 'client plugin sync done') for the duration of the interactive flow.
  // Real warnings/errors still come through. Restored on exit.
  const priorLogLevel = logger.level;
  logger.level = process.env.CLAWDEVBOX_LOG_LEVEL ?? 'warn';
  try {
    return await runInitInner(flags);
  } finally {
    logger.level = priorLogLevel;
  }
}

async function runInitInner(flags: Flags): Promise<void> {
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

  // ----- Built-in marketplace plugins -----------------------------------
  // Auto-installs `install_tier: required` (e.g. clawdevbox-mcp), pre-checks
  // `install_tier: recommended` (e.g. dev-buddy), leaves `optional` (e.g.
  // ado) unchecked. Skipped if --no-builtin flag is set. The bundled
  // marketplace lives at <repoRoot>/.claude-plugin/marketplace.json
  // (dev) or <dist>/marketplace/.claude-plugin/marketplace.json (prod);
  // `ensureBuiltinMarketplaceRegistered` plants the sidecar that the
  // marketplace.* tools later read.
  const globalPluginsDirPath = join(globalDir, 'plugins');
  const builtinResults: Array<{
    name: string;
    status: 'installed' | 'kept' | 'error';
    detail?: string;
    required_env: string[];
  }> = [];
  if (!boolFlag(flags, 'no-builtin')) {
    const tmpCfgForBuiltin = resolveConfig({ projectDir, globalDir });
    ensureBuiltinMarketplaceRegistered(tmpCfgForBuiltin);

    const builtinMarketplaceDir = join(globalDir, 'marketplaces', 'clawdevbox');
    if (existsSync(builtinMarketplaceDir)) {
      try {
        await runBuiltinMarketplaceInstall({
          marketplaceDir: builtinMarketplaceDir,
          globalDir,
          globalPluginsDirPath,
          results: builtinResults,
        });
      } catch (err) {
        log.warn(
          `Built-in marketplace install skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      log.warn(
        `Built-in marketplace unavailable at ${builtinMarketplaceDir}; skipping built-in plugin install.`,
      );
    }
  }

  // ----- External plugin sources (--plugin <git-url-or-folder>) --------
  // Each --plugin source is resolved (git clone or local path), scanned
  // for `.claude-plugin/plugin.json` manifests (single plugin or
  // marketplace catalog), and the user is asked which discovered
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
      const srcSpinner = spinner();
      const isGit = /^(git\+|https?:|git@|ssh:)/.test(raw);
      srcSpinner.start(
        isGit
          ? `Cloning ${raw} to scan for plugins...`
          : `Scanning ${raw} for plugins...`,
      );
      let source: ResolvedSource;
      try {
        source = resolvePluginSource(raw);
      } catch (err) {
        srcSpinner.stop(`Failed to resolve --plugin ${raw}.`, 1);
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
        srcSpinner.stop(`No plugins found in ${raw}.`);
        sourceDiagnostics.push(
          `--plugin ${raw}: no .claude-plugin/plugin.json found at the root or any subdirectory.`,
        );
        continue;
      }
      srcSpinner.stop(`Found ${plugins.length} plugin${plugins.length === 1 ? '' : 's'} in ${raw}.`);
      // Engines filter (spec §4.4): each discovered plugin may have a
      // sibling agency.json. Hide incompatible plugins from the prompt
      // (and surface a diagnostic line). configuredAgentCli is whatever
      // the existing global config records — the new provider isn't
      // picked until later in init.
      const cliId = readExistingDefaultAgentCli(globalDir);
      const compatible: DiscoveredPlugin[] = [];
      for (const p of plugins) {
        const agency = readAgencyJsonAt(p.dir);
        const flt = filterByEngines(agency, cliId);
        if (flt.include) {
          compatible.push(p);
        } else {
          sourceDiagnostics.push(`--plugin ${raw}: skipped ${p.id} (${flt.reason})`);
        }
      }
      if (compatible.length === 0) {
        sourceDiagnostics.push(
          `--plugin ${raw}: no engine-compatible plugins to install.`,
        );
        continue;
      }
      // Pre-check plugins that already live in the global plugins store
      // so a re-run doesn't accidentally drop them. Install won't overwrite
      // an existing directory anyway, but the pre-check makes the intent
      // obvious to the user.
      const preChecked = compatible
        .filter((p) => existsSync(join(globalPluginsDirPath, p.id)))
        .map((p) => p.id);
      const chosenIds = abortIfCancel(
        await multiselect<
          Array<{ value: string; label: string; hint?: string }>,
          string
        >({
          message: `Plugins discovered in ${raw} — pick which to install:`,
          options: compatible.map((p) => ({
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
        const plugin = compatible.find((p) => p.id === id);
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
    for (const r of builtinResults) {
      pluginResults.push({
        id: r.name,
        origin: 'built-in',
        status: r.status,
        detail: r.detail,
        required_env: r.required_env,
      });
    }

    // Install plugins picked from --plugin sources. Git single-plugin
    // sources are moved (preserving .git for plugin.update); collection
    // subdirs are copied; local folders are junctioned. Sidecar records
    // capture the origin so plugin.update knows what to do.
    if (externalPicks.length > 0) {
      const instSpinner = spinner();
      instSpinner.start(
        `Installing ${externalPicks.length} plugin${externalPicks.length === 1 ? '' : 's'} into global store...`,
      );
      let installedCount = 0;
      let errorCount = 0;
      let linkedCount = 0;
      let copiedCount = 0;
      for (const pick of externalPicks) {
        instSpinner.message(`Installing ${pick.plugin.id}...`);
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
          installedCount++;
          if (r.copied) {
            if (r.kind === 'local') linkedCount++;
            else copiedCount++;
          }
        } catch (err) {
          pluginResults.push({
            id: pick.plugin.id,
            origin: pick.origin,
            status: 'error',
            detail: err instanceof Error ? err.message : String(err),
            required_env: pick.plugin.required_env,
          });
          errorCount++;
        }
      }
      const breakdown = describeInstallBreakdown(linkedCount, copiedCount);
      instSpinner.stop(
        errorCount === 0
          ? `Installed ${installedCount} plugin${installedCount === 1 ? '' : 's'}${breakdown}.`
          : `Installed ${installedCount}${breakdown}, ${errorCount} failed.`,
      );
    }

    // Make sure node_modules is junctioned into <globalDir> so plugin
    // tools that `import 'zod'` resolve from the global plugin store.
    if (pluginResults.length > 0) {
      ensureGlobalNodeModulesLink(globalDir);
    }

    // ---- Workspace reload + agent-CLI chooser -----------------------------
    // Plugins were just installed; load a workspace so reloadTypeRegistries
    // picks up their provides.agent_clis[] entries, then ask the user which
    // provider should be the default for this install. Failure here is
    // non-fatal — the user can fix and rerun, or set default_agent_cli later
    // via `clawdevbox config set`.
    let chosenProviderId: string | null = null;
    let chosenProviderLabel: string | null = null;
    let probedSelections: Array<{ provider: string; name: string }> = [];
    try {
      const tmpEnv = {
        ...process.env,
        CLAWDEVBOX_PROJECT_DIR: projectDir,
        CLAWDEVBOX_GLOBAL_DIR: globalDir,
      };

      const wsSpinner = spinner();
      wsSpinner.start('Loading installed plugins and agent CLI providers...');
      const ws = await loadWorkspaceFromEnv(tmpEnv);
      const tmpCfg = resolveConfig({ projectDir, globalDir });
      wsSpinner.stop(
        `Loaded ${ws.plugins.size} plugin(s), ${ws.agentCliProviders.size} agent CLI provider(s).`,
      );

      // Probe client-installed plugins for clawdevbox.* extensions BEFORE
      // the agent-CLI chooser (spec §10). The probe surfaces plugins the
      // CLI already has; the chooser then picks which CLI is default. The
      // probe is skipped entirely when client_sync.mode === 'off'.
      if (tmpCfg.clientSync.mode !== 'off') {
        try {
          const probeSpinner = spinner();
          probeSpinner.start('Scanning CLI-installed plugins for clawdevbox extensions...');
          const probed = await probeClientPlugins(ws, tmpCfg);
          probeSpinner.stop(
            probed.length === 0
              ? 'No CLI-installed clawdevbox plugins found.'
              : `Found ${probed.length} CLI-installed plugin${probed.length === 1 ? '' : 's'} with clawdevbox extensions.`,
          );
          if (probed.length > 0) {
            const targetConfigPath =
              installScope === 'global' ? globalConfigPath(globalDir) : configPath(projectDir);
            probedSelections = await runClientPluginProbePrompt(probed, tmpCfg, {
              configPath: targetConfigPath,
              preselect: tmpCfg.clientSync.discoveredPlugins,
            });
          }
        } catch (err) {
          log.warn(
            `Skipping client plugin probe: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      chosenProviderId = await runAgentCliChooser(ws, tmpCfg, installScope);
      if (chosenProviderId) {
        chosenProviderLabel =
          ws.agentCliProviders.get(chosenProviderId)?.displayName ?? chosenProviderId;
      }
    } catch (err) {
      log.warn(
        `Skipping agent-CLI chooser: ${err instanceof Error ? err.message : String(err)}`,
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
      ...(chosenProviderId ? { default_agent_cli: chosenProviderId } : {}),
      ...(probedSelections.length > 0
        ? { client_sync: { discovered_plugins: probedSelections } }
        : {}),
    };

    const written =
      installScope === 'global'
        ? writeGlobalConfig(globalDir, cfg)
        : writeConfig(projectDir, cfg);

    // ---- Direction A: push installed plugins + bundled marketplace into
    // the chosen agent CLI. This lets the user start a Claude/Copilot/Agency
    // session with /commands, MCP servers, and skills already wired up from
    // the plugins we just installed — no second 'plugin install' step.
    //
    // Reloads the workspace (now that the .install.json sidecars are on
    // disk and the manifest registry is current) and re-resolves config
    // from disk so resolveConfiguredProvider() picks up default_agent_cli.
    // Skipped silently when no provider was chosen or client_sync is off.
    let clientSyncSummary: {
      provider: string;
      installed: number;
      failed: number;
      marketplacesAdded: number;
      reason?: string;
    } | null = null;
    if (chosenProviderId && pluginResults.some((r) => r.status !== 'error')) {
      try {
        const tmpEnv = {
          ...process.env,
          CLAWDEVBOX_PROJECT_DIR: projectDir,
          CLAWDEVBOX_GLOBAL_DIR: globalDir,
        };
        const syncSpinner = spinner();
        syncSpinner.start(
          `Syncing marketplace + plugins to ${chosenProviderLabel ?? chosenProviderId}... (this can take a minute)`,
        );
        const ws = await loadWorkspaceFromEnv(tmpEnv);
        const freshCfg = resolveConfig({ projectDir, globalDir });
        const { maybeRunClientSync } = await import('../agent-clis/lifecycle.ts');
        const result = await maybeRunClientSync(ws, freshCfg, 'init');
        if (result.ran && result.syncReport) {
          const r = result.syncReport;
          const parts: string[] = [];
          if (r.marketplacesAdded.length > 0) {
            parts.push(`+${r.marketplacesAdded.length} marketplace${r.marketplacesAdded.length === 1 ? '' : 's'}`);
          }
          if (r.pluginsInstalled.length > 0) {
            parts.push(`+${r.pluginsInstalled.length} plugin${r.pluginsInstalled.length === 1 ? '' : 's'}`);
          }
          if (r.failed.length > 0) {
            parts.push(`${r.failed.length} failed`);
          }
          const tail = parts.length > 0 ? ` (${parts.join(', ')})` : ' (already in sync)';
          syncSpinner.stop(`Synced to ${chosenProviderLabel ?? chosenProviderId}${tail}.`);
          clientSyncSummary = {
            provider: chosenProviderLabel ?? chosenProviderId,
            installed: r.pluginsInstalled.length,
            failed: r.failed.length,
            marketplacesAdded: r.marketplacesAdded.length,
          };
        } else if (!result.ran) {
          syncSpinner.stop(`Client sync skipped (${result.reason ?? 'unknown'}).`);
          clientSyncSummary = {
            provider: chosenProviderLabel ?? chosenProviderId,
            installed: 0,
            failed: 0,
            marketplacesAdded: 0,
            reason: result.reason,
          };
        } else {
          syncSpinner.stop('Client sync done.');
        }
      } catch (err) {
        log.warn(
          `Client sync skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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

    const clientSyncLines: string[] = [];
    if (clientSyncSummary) {
      if (clientSyncSummary.reason) {
        clientSyncLines.push(
          `Client sync:   skipped (${clientSyncSummary.reason})`,
        );
      } else {
        const parts: string[] = [];
        if (clientSyncSummary.marketplacesAdded > 0) {
          parts.push(
            `+${clientSyncSummary.marketplacesAdded} marketplace${clientSyncSummary.marketplacesAdded > 1 ? 's' : ''}`,
          );
        }
        if (clientSyncSummary.installed > 0) {
          parts.push(
            `+${clientSyncSummary.installed} plugin${clientSyncSummary.installed > 1 ? 's' : ''}`,
          );
        }
        if (clientSyncSummary.failed > 0) {
          parts.push(`${clientSyncSummary.failed} failed`);
        }
        const detail = parts.length > 0 ? ` (${parts.join(', ')})` : ' (no changes)';
        clientSyncLines.push(`Client sync:   ${clientSyncSummary.provider}${detail}`);
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
        chosenProviderLabel
          ? `Agent CLI:   ${chosenProviderLabel}`
          : `Agent CLI:   not selected (runtime fallback: copilot)`,
        ...clientSyncLines,
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
        const svcSpinner = spinner();
        svcSpinner.start('Starting service in background + verifying /healthz...');
        const r = await tryInstallService({ globalDir, projectDir, port, token });
        if (r.ok) {
          svcSpinner.stop(`Service installed (pid ${r.pid}, port ${port}).`);
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
            const tunnelSpinner = spinner();
            tunnelSpinner.start('Waiting for devtunnel URL (up to 30s)...');
            const tunnel = await fetchTunnelStatus({
              host: DEFAULT_HTTP_HOST,
              port,
              token,
              timeoutMs: 30000,
              waitForUrl: true,
            });
            if (tunnel?.url) {
              tunnelSpinner.stop(`Tunnel ready: ${tunnel.url}`);
              renderTunnelInfo({
                url: tunnel.url,
                token,
                inspectUrl: tunnel.inspect_url ?? null,
              });
            } else if (tunnel?.error) {
              tunnelSpinner.stop(`Tunnel did not come up: ${tunnel.error}`, 1);
            } else {
              tunnelSpinner.stop('Tunnel URL not yet available — run `clawdevbox status` once the tunnel finishes registering.');
            }
          }
        } else {
          svcSpinner.stop(`Service install failed.`, 1);
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

// ============================================================================
// Agent-CLI chooser
// ============================================================================

/**
 * Prompt the user to pick the default agent-CLI provider for this install,
 * running each provider's `detect()` in parallel (with a 5s timeout) so the
 * options carry an "available / not installed" hint. If the picked provider
 * exposes a `setup()` hook, it's invoked with the requested scope; setup
 * failures are logged but non-fatal.
 *
 * Returns the chosen provider id, or `null` when the user picks `__skip`.
 *
 * Exported (rather than inlined) so tests can supply a fake `prompt` instead
 * of driving the real `@clack/prompts.select` TTY UI.
 */
export type AgentCliChooserPrompt = (args: {
  message: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  initialValue: string;
}) => Promise<string | symbol>;

export async function runAgentCliChooser(
  ws: Workspace,
  cfg: ResolvedConfig,
  installScope: 'project' | 'global',
  prompt: AgentCliChooserPrompt = (args) =>
    select<Array<{ value: string; label: string; hint?: string }>, string>(args) as Promise<
      string | symbol
    >,
): Promise<string | null> {
  const visibleProviders = [...ws.agentCliProviders.values()].filter((p) => !p.internal);

  // Run detect() in parallel; cap each at 5s so a stuck binary can't hang init.
  const detectResults = await Promise.all(
    visibleProviders.map(async (p) => {
      if (!p.detect) {
        return { provider: p, detect: { available: true } as DetectResult };
      }
      try {
        const ctx = buildProviderCtx(ws, cfg);
        const result = await Promise.race<DetectResult>([
          p.detect(ctx),
          new Promise<DetectResult>((r) =>
            setTimeout(() => r({ available: false, reason: 'detect timed out' }), 5000),
          ),
        ]);
        return { provider: p, detect: result };
      } catch (err) {
        return {
          provider: p,
          detect: {
            available: false,
            reason: err instanceof Error ? err.message : String(err),
          } as DetectResult,
        };
      }
    }),
  );

  const defaultProvider = detectResults.find((r) => r.detect.available)?.provider.id;

  const cliPick = abortIfCancel(
    await prompt({
      message: 'Which agent CLI should this workspace use by default?',
      options: [
        ...detectResults.map(({ provider, detect }) => ({
          value: provider.id,
          label: provider.displayName,
          hint: detect.available
            ? `✓ ${detect.binary ?? provider.id}${detect.version ? ` ${detect.version}` : ''}`
            : `✗ ${detect.reason ?? 'not installed'}`,
        })),
        { value: '__skip', label: '[skip — pick later via `clawdevbox config set`]', hint: '' },
      ],
      initialValue: defaultProvider ?? '__skip',
    }),
  );

  if (cliPick === '__skip') return null;

  const chosenProviderId = cliPick as string;
  const provider = ws.agentCliProviders.get(chosenProviderId);
  if (provider?.setup) {
    try {
      await provider.setup(buildProviderCtx(ws, cfg), { scope: installScope });
    } catch (err) {
      // Setup failures are non-fatal; the user can fix and rerun.
      // eslint-disable-next-line no-console
      console.warn(
        `[clawdevbox] provider.setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return chosenProviderId;
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

// ----- Engine-filter helpers (Phase 5 / spec sec 4.4) -----------------------

function readExistingDefaultAgentCli(globalDir: string): string | null {
  try {
    const cfg = readGlobalConfig(globalDir);
    return cfg?.default_agent_cli ?? null;
  } catch {
    return null;
  }
}

function readAgencyJsonAt(pluginDir: string): AgencyJson | undefined {
  const p = join(pluginDir, 'agency.json');
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    const errs = validateAgencyJson(parsed);
    if (errs.length > 0) return undefined;
    return parsed as AgencyJson;
  } catch {
    return undefined;
  }
}

