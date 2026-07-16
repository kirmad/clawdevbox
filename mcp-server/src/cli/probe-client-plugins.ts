/**
 * cli/probe-client-plugins.ts
 *
 * Phase 4 — Init probe step (spec §10).
 *
 * Walks every non-internal `AgentCliProvider` that exposes both `detect` and
 * `discoverInstalledPlugins`, asks each for its installed-plugin inventory,
 * loads each plugin via `loadPluginFromDir`, and filters to those that ship a
 * non-empty `clawdevbox.*` extension block. The result is a `ProbedPlugin[]`
 * with per-capability metadata + best-effort harvested descriptions, ready
 * for the interactive opt-in card UI (`init-probe-prompt.ts`).
 *
 * All probing runs concurrently. Per-provider failures degrade gracefully
 * (WARN log, skip that provider). Per-plugin failures (bad manifest, etc.)
 * are skipped with a one-line WARN.
 */

import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { logger } from '../logger.ts';
import { loadPluginFromDir, type LoadedPlugin } from '../manifest/load-plugin.ts';
import { buildProviderCtx } from '../agent-clis/shared.ts';
import type { ResolvedConfig } from '../config.ts';
import type { Workspace } from '../workspace.ts';
import type { AgentCliProvider, DiscoveredPlugin } from '../agent-clis/types.ts';

export interface ProbedPlugin {
  pluginName: string;
  pluginDir: string;
  providerId: string;
  manifestPath: string;
  clawdevbox: {
    recipes: Array<{ id: string; description?: string; file: string }>;
    tools: Array<{ id: string; runtime: string; description?: string; file: string }>;
    trigger_types: Array<{ id: string; description?: string; default_cron?: string; file: string }>;
    agent_clis: Array<{ id: string; display_name: string; description?: string }>;
    renderers: Array<{ type: string; description?: string; file: string }>;
  };
  clientSide: {
    skills: Array<{ id: string; description?: string }>;
    agents: Array<{ id: string; description?: string }>;
    commands: Array<{ id: string; description?: string }>;
    mcpServers: Array<{ id: string }>;
  };
}

// ---------------------------------------------------------------------------
// Description harvesting helpers (best-effort; missing -> undefined)
// ---------------------------------------------------------------------------

async function safeRead(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function parseFrontmatterDescription(text: string): string | undefined {
  if (!text.startsWith('---')) return undefined;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return undefined;
  const fm = text.slice(3, end);
  try {
    const obj = yamlLoad(fm);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const d = (obj as Record<string, unknown>).description;
      if (typeof d === 'string') return d;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

async function harvestRecipeDescription(absFile: string): Promise<string | undefined> {
  const text = await safeRead(absFile);
  if (!text) return undefined;
  const ext = extname(absFile).toLowerCase();
  try {
    if (ext === '.json') {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object' && typeof obj.description === 'string') return obj.description;
      return undefined;
    }
    const obj = yamlLoad(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const d = (obj as Record<string, unknown>).description;
      if (typeof d === 'string') return d;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

async function harvestToolDescription(absFile: string): Promise<string | undefined> {
  const text = await safeRead(absFile);
  if (!text) return undefined;
  const head = text.split('\n').slice(0, 20).join('\n');
  // /** description */ — single-line jsdoc.
  const jsdocSingle = head.match(/\/\*\*\s*([^\n*][^\n]*?)\s*\*\//);
  if (jsdocSingle) return jsdocSingle[1].trim();
  // /** \n * description \n */ — first non-empty line in jsdoc block.
  const jsdocBlock = head.match(/\/\*\*([\s\S]*?)\*\//);
  if (jsdocBlock) {
    const lines = jsdocBlock[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .filter((l) => l.length > 0 && !l.startsWith('@'));
    if (lines.length > 0) return lines[0];
  }
  // /// description: …
  const tripleSlash = head.match(/\/\/\/\s*description\s*:\s*(.+)/i);
  if (tripleSlash) return tripleSlash[1].trim();
  // # description: …  (python/bash)
  const hashDesc = head.match(/^#\s*description\s*:\s*(.+)$/im);
  if (hashDesc) return hashDesc[1].trim();
  return undefined;
}

async function harvestAgentCliMetadata(
  absFile: string,
): Promise<{ description?: string; displayName?: string }> {
  const text = await safeRead(absFile);
  if (!text) return {};
  // Static regex scan — never dynamic-import a plugin module at init time.
  const out: { description?: string; displayName?: string } = {};
  const desc = text.match(/\bdescription\s*:\s*(["'`])([^"'`\n]+)\1/);
  if (desc) out.description = desc[2];
  const dn = text.match(/\bdisplayName\s*:\s*(["'`])([^"'`\n]+)\1/);
  if (dn) out.displayName = dn[2];
  else {
    const dn2 = text.match(/\bdisplay_name\s*:\s*(["'`])([^"'`\n]+)\1/);
    if (dn2) out.displayName = dn2[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build a ProbedPlugin record from a loaded plugin.
// ---------------------------------------------------------------------------

async function buildRecord(
  loaded: LoadedPlugin,
  pluginDir: string,
  providerId: string,
): Promise<ProbedPlugin | null> {
  const m = loaded.manifest;
  const cdb = m.clawdevbox;
  const caps = loaded.capabilities;
  const hasCdb =
    cdb !== undefined &&
    (caps.recipes.length > 0 ||
      caps.tools.length > 0 ||
      caps.triggerTypes.length > 0 ||
      caps.agentClis.length > 0 ||
      caps.renderers.length > 0);
  if (!hasCdb) return null;

  const recipes = await Promise.all(
    caps.recipes.map(async (r) => ({
      id: r.id,
      description: await harvestRecipeDescription(r.absoluteFile),
      file: r.file,
    })),
  );

  const tools = await Promise.all(
    caps.tools.map(async (t) => ({
      id: t.id,
      runtime: t.runtime ?? 'unknown',
      description: await harvestToolDescription(t.absoluteFile),
      file: t.file,
    })),
  );

  const trigger_types = caps.triggerTypes.map((t) => ({
    id: t.id,
    description: t.description,
    default_cron: t.default_cron,
    file: t.file,
  }));

  const agent_clis = await Promise.all(
    caps.agentClis.map(async (a) => {
      const abs = join(pluginDir, a.module);
      const scanned = await harvestAgentCliMetadata(abs);
      return {
        id: a.id,
        display_name: a.display_name ?? scanned.displayName ?? a.id,
        description: a.description ?? scanned.description,
      };
    }),
  );

  const renderers = caps.renderers.map((r) => ({
    type: r.type,
    description: r.description,
    file: r.module,
  }));

  // Client-side capabilities (transparency only — not registered by clawdevbox).
  const skills = await Promise.all(
    caps.skills.map(async (s) => {
      const text = await safeRead(join(s.absoluteDir, 'SKILL.md'));
      return {
        id: s.id,
        description: text ? parseFrontmatterDescription(text) : undefined,
      };
    }),
  );

  const agents = await Promise.all(
    caps.agents.map(async (a) => {
      const text = await safeRead(a.absoluteFile);
      return {
        id: a.id,
        description: text ? parseFrontmatterDescription(text) : undefined,
      };
    }),
  );

  const commands = await Promise.all(
    caps.commands.map(async (c) => {
      const text = await safeRead(c.absoluteFile);
      return {
        id: c.id,
        description: text ? parseFrontmatterDescription(text) : undefined,
      };
    }),
  );

  const mcpServers = Object.keys(caps.mcpServers).map((id) => ({ id }));

  return {
    pluginName: m.name,
    pluginDir,
    providerId,
    manifestPath: join(pluginDir, '.claude-plugin', 'plugin.json'),
    clawdevbox: { recipes, tools, trigger_types, agent_clis, renderers },
    clientSide: { skills, agents, commands, mcpServers },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function probeClientPlugins(
  ws: Workspace,
  cfg: ResolvedConfig,
): Promise<ProbedPlugin[]> {
  const providers = [...ws.agentCliProviders.values()].filter(
    (p): p is AgentCliProvider =>
      !p.internal && typeof p.detect === 'function' && typeof p.discoverInstalledPlugins === 'function',
  );

  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const ctx = buildProviderCtx(ws, cfg);
        const detect = await provider.detect!(ctx);
        if (!detect.available) return [] as ProbedPlugin[];
        const discovered = await provider.discoverInstalledPlugins!(ctx);
        if (!discovered || discovered.length === 0) return [] as ProbedPlugin[];

        const records: ProbedPlugin[] = [];
        for (const d of discovered as DiscoveredPlugin[]) {
          // Sanity: skip if the manifest is missing — loadPluginFromDir will throw.
          const manifestPath = join(d.absoluteDir, '.claude-plugin', 'plugin.json');
          if (!existsSync(manifestPath)) continue;
          let loaded: LoadedPlugin;
          try {
            loaded = await loadPluginFromDir(d.absoluteDir);
          } catch (err) {
            logger.warn(
              { provider: provider.id, plugin: d.name, error: err instanceof Error ? err.message : String(err) },
              'probeClientPlugins: failed to load plugin manifest, skipping',
            );
            continue;
          }
          const rec = await buildRecord(loaded, d.absoluteDir, provider.id);
          if (rec) records.push(rec);
        }
        return records;
      } catch (err) {
        logger.warn(
          { provider: provider.id, error: err instanceof Error ? err.message : String(err) },
          'probeClientPlugins: provider probe failed, skipping',
        );
        return [] as ProbedPlugin[];
      }
    }),
  );

  const flat = results.flat();
  flat.sort((a, b) => a.pluginName.localeCompare(b.pluginName));
  return flat;
}

