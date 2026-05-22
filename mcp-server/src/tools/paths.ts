/**
 * tools/paths.ts
 *
 * MCP tool: paths.get — returns all resolved paths for the current installation:
 * global dir, project dir, workspaces root, and vault chain (ordered leaf→root).
 *
 * This lets agents discover where vaults live so they can read/write skills,
 * agents, memory, etc. without hardcoding paths.
 */

import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { defineTool } from './registry.ts';
import type { Workspace } from '../workspace.ts';
import { resolveConfig } from '../config.ts';
import { loadVaultChain, type VaultInfo } from '../vault-chain.ts';

export interface PathsPayload {
  global_dir: string;
  project_dir: string;
  workspaces_root: string;
  vaults: Array<{
    id: string;
    path: string;
    kind: 'personal' | 'team';
    remote: string | null;
    title?: string;
  }>;
}

/**
 * Resolve paths payload from dirs. Exported for testability.
 */
export function resolvePathsPayload(dirs: { globalDir: string; projectDir: string }): PathsPayload {
  const cfg = resolveConfig({ projectDir: dirs.projectDir, globalDir: dirs.globalDir });
  const chain = loadVaultChain(cfg.vaults);

  return {
    global_dir: dirs.globalDir,
    project_dir: dirs.projectDir,
    workspaces_root: cfg.workspacesRoot,
    vaults: chain.map((v: VaultInfo) => ({
      id: v.id,
      path: v.path,
      kind: v.kind,
      remote: v.remote,
      ...(v.title ? { title: v.title } : {}),
    })),
  };
}

export function registerPathsEntries(ws: Workspace): void {
  defineTool({
    name: 'paths.get',
    description:
      'Returns resolved installation paths: global dir, project dir, workspaces root, and registered vault chain (ordered leaf→root). Use this to discover vault locations for reading/writing skills, agents, memory.',
    parameters: z.object({
      workspace_id: z.string().optional().describe('Workspace ID override (uses caller context if omitted).'),
    }),
    handler: async () => {
      const payload = resolvePathsPayload({
        globalDir: ws.globalDir,
        projectDir: ws.projectDir,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
    examples: [{ description: 'Get all resolved paths', args: {} }],
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
