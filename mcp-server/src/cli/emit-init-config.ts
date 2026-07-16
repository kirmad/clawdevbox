/**
 * emit-init-config.ts
 *
 * `clawdevbox init --emit-config <path>` — dump a fully-populated
 * init-config JSON file derived from the CURRENT installed state
 * (read from `<globalDir>/config.json` if present, otherwise
 * documented defaults). The output is a ready-to-share recipe that
 * another machine can feed to `clawdevbox init --config-file <path>`
 * for an unattended reinstall.
 *
 * The emitted file:
 *   - Strips the VAPID keypair (per-install secret; the new install
 *     will mint its own) but keeps `notifications.subject` so the
 *     same `mailto:` shows up on every device.
 *   - Strips the bearer token and uses the `"GENERATE"` sentinel so
 *     each install gets a fresh secret (don't share tokens across
 *     machines).
 *   - Includes `install_supervisor: true` on Windows so the new
 *     install gets crash recovery out of the box.
 *
 * Caveats: external plugin sources you installed by hand
 * (--plugin <git-url>) are NOT recorded in the on-disk config —
 * they were applied once at init time. If you want a config-file
 * recipe to include them, edit the emitted file and add them under
 * `external_plugins`.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readGlobalConfig,
  readConfig,
  globalConfigPath,
  configPath,
  DEFAULT_HTTP_PORT,
} from '../config.ts';
import type { Flags } from './index.ts';
import { INIT_CONFIG_FILE_VERSION, type InitConfigFile } from './init-config-file.ts';

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export async function emitInitConfig(opts: { path: string; flags: Flags }): Promise<number> {
  const cwd = process.cwd();
  const projectDirFlag = str(opts.flags, 'project');
  const projectDir = projectDirFlag
    ? (isAbsolute(projectDirFlag) ? resolve(projectDirFlag) : resolve(cwd, projectDirFlag))
    : cwd;
  const globalDirDefault = join(homedir(), '.clawdevbox');
  const globalDirFlag = str(opts.flags, 'global');
  const globalDir = globalDirFlag
    ? (isAbsolute(globalDirFlag) ? resolve(globalDirFlag) : resolve(projectDir, globalDirFlag))
    : globalDirDefault;

  const existingGlobal = readGlobalConfig(globalDir);
  const existingProject = readConfig(projectDir);
  const existing = existingGlobal ?? existingProject;
  const scope: 'global' | 'project' = existingGlobal ? 'global' : (existingProject ? 'project' : 'global');

  const out: InitConfigFile = {
    version: INIT_CONFIG_FILE_VERSION,
    scope,
    global_dir: existing?.global_dir ?? globalDir,
    http: {
      port: existing?.http?.port ?? DEFAULT_HTTP_PORT,
      token: 'GENERATE',  // never share tokens; each install mints fresh
    },
    tunnel: existing?.tunnel?.kind === 'devtunnel'
      ? {
          kind: 'devtunnel',
          name: existing.tunnel.name,
          allow_anonymous: existing.tunnel.allow_anonymous ?? false,
        }
      : { kind: 'none' },
    notifications: {
      enabled: existing?.notifications?.enabled ?? false,
      // Strip the VAPID keypair on purpose — it's a per-install secret;
      // re-init mints its own pair so old device subscriptions stay
      // bound to the original install.
      ...(existing?.notifications?.vapid?.subject
        ? { subject: existing.notifications.vapid.subject }
        : {}),
    },
    ...(existing?.default_agent_cli ? { default_agent_cli: existing.default_agent_cli } : {}),
    builtin_plugins: { enabled: true, auto_install_all: false },
    external_plugins: [],
    vaults: existing?.vaults ?? [],
    overwrite_existing: true,
    install_service: true,
    install_supervisor: process.platform === 'win32',
  };

  if (scope === 'project') {
    out.project_dir = existing?.project_dir ?? projectDir;
  }

  // Pretty-print 2 spaces, write atomically (mkdir parent first).
  const outPath = isAbsolute(opts.path) ? opts.path : resolve(cwd, opts.path);
  try {
    mkdirSync(dirname(outPath), { recursive: true });
  } catch { /* */ }
  const json = JSON.stringify(out, null, 2) + '\n';
  writeFileSync(outPath, json, 'utf8');

  process.stdout.write(`emitted init config to ${outPath}\n`);
  process.stdout.write(`source:        ${existingGlobal ? globalConfigPath(globalDir) : (existingProject ? configPath(projectDir) : '(defaults — no existing config found)')}\n`);
  process.stdout.write(`apply on a new machine: clawdevbox init --config-file ${outPath}\n`);
  return 0;
}
