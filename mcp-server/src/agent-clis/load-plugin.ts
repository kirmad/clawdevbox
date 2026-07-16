/**
 * Plugin-provided AgentCliProvider loader (spec §4 "Module loading", §14).
 *
 * Walks each enabled plugin's `manifest.clawdevbox.agent_clis[]` (sorted by
 * plugin id for deterministic first-loaded-wins precedence), dynamic-imports
 * each module under the plugin directory, validates the exported provider
 * shape, and inserts it into `ws.agentCliProviders`.
 *
 * Loader failures are recorded into `ws.agentCliProviderErrors` with a typed
 * `code`; the offending entry is skipped but other entries (and other plugin
 * capabilities) continue to load.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger.ts';
import type { Workspace, PluginAgentCliEntry } from '../workspace.ts';
import type { AgentCliProvider, AgentCliProviderError } from './types.ts';

function shapeOk(obj: unknown): obj is AgentCliProvider {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.displayName === 'string' &&
    typeof p.description === 'string' &&
    typeof p.spawnSession === 'function'
  );
}

/** Walk every enabled plugin's resolved agent_clis capability and dynamic-import each. */
export async function loadPluginProviders(ws: Workspace): Promise<void> {
  // Sort plugins for deterministic collision precedence (first-loaded wins).
  const sorted = [...ws.plugins.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const plugin of sorted) {
    if (plugin.status !== 'enabled') continue;
    const entries = plugin.capabilities.agentClis ?? [];
    for (const entry of entries) {
      await loadOne(ws, plugin.id, plugin.dir, entry);
    }
  }
}

async function loadOne(
  ws: Workspace,
  pluginId: string,
  pluginDir: string,
  entry: PluginAgentCliEntry,
): Promise<void> {
  const record = (code: AgentCliProviderError['code'], error: string, providerId?: string): void => {
    ws.agentCliProviderErrors.push({
      plugin_id: pluginId,
      provider_id: providerId ?? entry.id,
      module: entry.module,
      error,
      code,
    });
  };

  // Collision check: built-in always wins; plugin-vs-plugin first-loaded wins.
  if (ws.agentCliProviders.has(entry.id)) {
    const existing = ws.agentCliProviders.get(entry.id)!;
    if (existing.source === 'builtin') {
      record(
        'BUILTIN_COLLISION',
        `plugin '${pluginId}' tried to register built-in provider id '${entry.id}'`,
      );
      return;
    }
    record(
      'PLUGIN_COLLISION',
      `plugin '${pluginId}' tried to register provider id '${entry.id}', already provided by ${existing.source}`,
    );
    return;
  }

  // Resolve module path, reject traversal & absolute paths.
  if (isAbsolute(entry.module)) {
    record('MODULE_PATH_TRAVERSAL', `module '${entry.module}' escapes plugin directory`);
    return;
  }
  const abs = resolve(pluginDir, entry.module);
  const rel = relative(pluginDir, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    record('MODULE_PATH_TRAVERSAL', `module '${entry.module}' escapes plugin directory`);
    return;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    record('MODULE_NOT_FOUND', `module file not found at ${abs}`);
    return;
  }

  let mod: any;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (err) {
    record('IMPORT_FAILED', err instanceof Error ? err.message : String(err));
    return;
  }

  const candidate = mod?.provider ?? mod?.default ?? mod;
  if (!shapeOk(candidate)) {
    record(
      'INVALID_PROVIDER_SHAPE',
      "module default export does not conform to AgentCliProvider (must have id, displayName, description, spawnSession)",
    );
    return;
  }
  if (candidate.id !== entry.id) {
    record(
      'INVALID_PROVIDER_SHAPE',
      `module's provider.id ('${candidate.id}') does not match manifest entry.id ('${entry.id}')`,
    );
    return;
  }

  const finalProvider: AgentCliProvider = {
    ...(candidate as AgentCliProvider),
    source: `plugin:${pluginId}`,
    displayName: entry.display_name ?? candidate.displayName,
    description: entry.description ?? candidate.description,
  };
  ws.agentCliProviders.set(entry.id, finalProvider);
  logger.info(
    { providerId: entry.id, pluginId, module: entry.module },
    'agent-cli provider loaded',
  );
}
