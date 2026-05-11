/**
 * tools/plugin.ts
 *
 * plugin.list / read / install / update / uninstall / enable / disable.
 *
 * install / update use real `git clone` / `git pull`, or `cp -r` for local
 * paths. We invoke `git` via `child_process.spawnSync` (no extra dep). On
 * Windows this hits the user's installed `git.exe`; if git isn't on PATH the
 * install fails with a clear stderr forward.
 *
 * enable/disable persist their flag in `<global>/state.json` so the in-memory
 * plugin registry can reflect the toggle on reload.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notFound, structuredError, validationError } from '../scope.ts';
import { validatePluginManifest } from '../validators.ts';
import {
  pluginDir,
  reloadPluginRegistry,
  stateJsonPath,
  type Workspace,
} from '../workspace.ts';
import { load as yamlLoad } from 'js-yaml';

interface StateFile {
  plugins?: Record<string, { enabled?: boolean }>;
}

function readStateFile(ws: Workspace): StateFile {
  const p = stateJsonPath(ws);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StateFile;
  } catch {
    return {};
  }
}

function writeStateFile(ws: Workspace, file: StateFile): void {
  const p = stateJsonPath(ws);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

function summarizeProvides(manifest: {
  provides?: {
    skills?: unknown[];
    recipes?: unknown[];
    triggers?: unknown[];
    tools?: unknown[];
    mcp_servers?: unknown[];
  };
}): string {
  const counts: Record<string, number> = {
    skills: manifest.provides?.skills?.length ?? 0,
    recipes: manifest.provides?.recipes?.length ?? 0,
    triggers: manifest.provides?.triggers?.length ?? 0,
    tools: manifest.provides?.tools?.length ?? 0,
    mcp_servers: manifest.provides?.mcp_servers?.length ?? 0,
  };
  const parts: string[] = [];
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) parts.push(`${v} ${k}`);
  }
  return parts.join(', ') || 'no provides';
}

export function registerPluginTools(server: McpServer, ws: Workspace): void {
  // -- plugin.list ----------------------------------------------------------
  server.registerTool(
    'plugin.list',
    {
      description:
        'List installed plugins under `<project_dir>/.conductor/plugins/*`. Returns id, name, version, description, status, and a one-line provides summary (spec §10.3).',
      inputSchema: {},
    },
    async () => {
      const plugins = [...ws.plugins.values()].map((p) => ({
        id: p.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        status: p.status,
        provides_summary: summarizeProvides(p.manifest),
        error: p.error,
      }));
      return {
        content: [{ type: 'text', text: `Found ${plugins.length} plugin(s).` }],
        structuredContent: { plugins, count: plugins.length },
      };
    },
  );

  // -- plugin.read ----------------------------------------------------------
  server.registerTool(
    'plugin.read',
    {
      description:
        'Read a plugin\'s full manifest plus provides listing + install origin (.install.json if present).',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const plugin = ws.plugins.get(args.id);
      if (!plugin) return notFound('plugin', args.id);
      let origin: unknown = null;
      const installJsonPath = join(plugin.dir, '.install.json');
      if (existsSync(installJsonPath)) {
        try {
          origin = JSON.parse(readFileSync(installJsonPath, 'utf8'));
        } catch {
          // ignore
        }
      }
      return {
        content: [{ type: 'text', text: `plugin ${plugin.id} v${plugin.manifest.version} [${plugin.status}]` }],
        structuredContent: {
          id: plugin.id,
          dir: plugin.dir,
          status: plugin.status,
          error: plugin.error,
          manifest: plugin.manifest,
          origin,
        },
      };
    },
  );

  // -- plugin.install -------------------------------------------------------
  server.registerTool(
    'plugin.install',
    {
      description:
        'Install a plugin from `git+https://`, `git+ssh://`, or an absolute local path (spec §10.5). Validates the manifest, copies to `.conductor/plugins/<manifest.id>/`, and reloads the registry. `ref` is an optional branch/tag/sha for git sources.',
      inputSchema: {
        from: z.string().min(1),
        ref: z.string().optional(),
      },
    },
    async (args) => {
      const tmp = join(ws.projectDir, '.conductor', 'plugins', `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(dirname(tmp), { recursive: true });

      try {
        if (args.from.startsWith('git+')) {
          const gitUrl = args.from.slice('git+'.length);
          const cloneArgs = ['clone', '--depth', '1'];
          if (args.ref) cloneArgs.push('--branch', args.ref);
          cloneArgs.push(gitUrl, tmp);
          const result = spawnSync('git', cloneArgs, { stdio: 'pipe', encoding: 'utf8' });
          if (result.status !== 0) {
            return structuredError(
              'GIT_CLONE_FAILED',
              `git clone failed (exit ${result.status}): ${result.stderr ?? result.stdout ?? ''}`,
            );
          }
          // Strip .git so .conductor/plugins/<id>/ is clean
          const gitDir = join(tmp, '.git');
          if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true });
        } else if (resolve(args.from) === args.from && existsSync(args.from)) {
          // absolute local path
          const stat = statSync(args.from);
          if (!stat.isDirectory()) {
            return structuredError('INVALID_SOURCE', `from must be a directory (got file): ${args.from}`);
          }
          cpSync(args.from, tmp, { recursive: true });
        } else {
          return structuredError(
            'UNSUPPORTED_FROM',
            `from must be 'git+https://...', 'git+ssh://...', or an absolute existing directory. Got: ${args.from}`,
          );
        }

        // Validate manifest
        const manifestPath = join(tmp, 'plugin.yaml');
        if (!existsSync(manifestPath)) {
          return structuredError('MANIFEST_MISSING', 'plugin.yaml not found at the source root.');
        }
        let parsed: unknown;
        try {
          parsed = yamlLoad(readFileSync(manifestPath, 'utf8'));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return structuredError('MANIFEST_PARSE_ERROR', msg);
        }
        const validation = validatePluginManifest(parsed);
        if (!validation.ok) return validationError(validation.errors);

        const manifest = parsed as { id: string };
        const destDir = pluginDir(ws, manifest.id);
        if (existsSync(destDir)) {
          return structuredError(
            'PLUGIN_ALREADY_INSTALLED',
            `Plugin '${manifest.id}' is already installed. Uninstall first to reinstall.`,
            { id: manifest.id },
          );
        }
        mkdirSync(dirname(destDir), { recursive: true });
        cpSync(tmp, destDir, { recursive: true });

        // Write .install.json
        const installJson = {
          from: args.from,
          ref: args.ref ?? null,
          installed_at: Date.now(),
        };
        writeFileSync(join(destDir, '.install.json'), JSON.stringify(installJson, null, 2) + '\n', 'utf8');

        reloadPluginRegistry(ws);
        return {
          content: [{ type: 'text', text: `Installed plugin ${manifest.id} from ${args.from}.` }],
          structuredContent: { id: manifest.id, dir: destDir, origin: installJson },
        };
      } finally {
        if (existsSync(tmp)) {
          try {
            rmSync(tmp, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      }
    },
  );

  // -- plugin.update --------------------------------------------------------
  server.registerTool(
    'plugin.update',
    {
      description:
        'Run `git pull` inside the installed plugin\'s directory and re-validate. Errors clearly if the plugin was not installed from a git source.',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const plugin = ws.plugins.get(args.id);
      if (!plugin) return notFound('plugin', args.id);
      const installJsonPath = join(plugin.dir, '.install.json');
      if (!existsSync(installJsonPath)) {
        return structuredError(
          'NOT_GIT_INSTALLED',
          'Plugin has no .install.json — cannot auto-update. Update manually.',
        );
      }
      const result = spawnSync('git', ['pull'], { cwd: plugin.dir, stdio: 'pipe', encoding: 'utf8' });
      if (result.status !== 0) {
        return structuredError(
          'GIT_PULL_FAILED',
          `git pull failed (exit ${result.status}): ${result.stderr ?? result.stdout ?? ''}`,
        );
      }
      reloadPluginRegistry(ws);
      return {
        content: [{ type: 'text', text: `Updated plugin ${args.id}.` }],
        structuredContent: { id: args.id, output: result.stdout?.trim() ?? '' },
      };
    },
  );

  // -- plugin.uninstall -----------------------------------------------------
  server.registerTool(
    'plugin.uninstall',
    {
      description:
        'Remove a plugin\'s directory under `.conductor/plugins/<id>/`. Any project-scope copies the user made survive (spec §10.5).',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const plugin = ws.plugins.get(args.id);
      if (!plugin) return notFound('plugin', args.id);
      rmSync(plugin.dir, { recursive: true, force: true });
      reloadPluginRegistry(ws);
      return {
        content: [{ type: 'text', text: `Uninstalled plugin ${args.id}.` }],
        structuredContent: { id: args.id, dir: plugin.dir },
      };
    },
  );

  // -- plugin.enable / plugin.disable ---------------------------------------
  for (const action of ['enable', 'disable'] as const) {
    server.registerTool(
      `plugin.${action}`,
      {
        description: `${action[0].toUpperCase() + action.slice(1)} a plugin (flag in global state.json; provides un/re-register on reload).`,
        inputSchema: { id: z.string().min(1) },
      },
      async (args) => {
        const plugin = ws.plugins.get(args.id);
        if (!plugin) return notFound('plugin', args.id);
        const state = readStateFile(ws);
        state.plugins ??= {};
        state.plugins[args.id] = { enabled: action === 'enable' };
        writeStateFile(ws, state);
        reloadPluginRegistry(ws);
        return {
          content: [
            { type: 'text', text: `${action === 'enable' ? 'Enabled' : 'Disabled'} plugin ${args.id}.` },
          ],
          structuredContent: { id: args.id, enabled: action === 'enable' },
        };
      },
    );
  }
}
