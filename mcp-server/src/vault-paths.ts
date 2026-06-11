/**
 * vault-paths.ts
 *
 * Path layout for vault-stored recipes and trigger templates.
 *
 *   <vault.path>/recipes/<id>.{yaml|json}
 *   <vault.path>/trigger-types/<id>/{template.yaml, trigger.<ext>}
 *
 * Mirrors `projectRecipesDir` / `projectTriggerTypesDir` etc. for the
 * vault scope. These on-disk locations sync via the vault's git remote,
 * so a recipe / trigger template saved to a team vault propagates to
 * every teammate on the next `memory_sync` (or git pull).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultInfo } from './vault-chain.ts';
import { loadVaultChain } from './vault-chain.ts';
import { resolveConfig } from './config.ts';
import type { Workspace } from './workspace.ts';

// ----------------------------------------------------------------------------
// Path builders
// ----------------------------------------------------------------------------

export function vaultRecipesDir(vault: VaultInfo): string {
  return join(vault.path, 'recipes');
}

export function vaultRecipePath(vault: VaultInfo, id: string, ext = 'yaml'): string {
  return join(vaultRecipesDir(vault), `${id}.${ext}`);
}

export function vaultTriggerTypesDir(vault: VaultInfo): string {
  return join(vault.path, 'trigger-types');
}

export function vaultTriggerTemplateDir(vault: VaultInfo, id: string): string {
  return join(vaultTriggerTypesDir(vault), id);
}

// ----------------------------------------------------------------------------
// Vault-chain loading — shared with the memory subsystem so a single
// config.vaults entry powers both memory storage AND recipe/trigger storage.
// ----------------------------------------------------------------------------

/**
 * Load the configured vault chain for this workspace. Returns an empty array
 * if no vaults are configured (vault-aware tools then no-op gracefully).
 */
export function loadVaultChainForWorkspace(ws: Workspace): VaultInfo[] {
  try {
    const cfg = resolveConfig({ projectDir: ws.projectDir, globalDir: ws.globalDir });
    return loadVaultChain(cfg.vaults);
  } catch {
    return [];
  }
}

/** Resolve a vault by id, throw a useful error listing valid ids if not found. */
export function resolveVaultById(chain: VaultInfo[], vault_id: string): VaultInfo {
  const v = chain.find((v) => v.id === vault_id);
  if (!v) {
    const ids = chain.map((v) => `'${v.id}' (${v.kind})`).join(', ') || '(none configured)';
    throw new Error(`Vault '${vault_id}' not found. Configured vaults: ${ids}`);
  }
  return v;
}

// ----------------------------------------------------------------------------
// Listing — used by recipe.template.list and trigger.template.list
// ----------------------------------------------------------------------------

export interface VaultRecipeListing {
  vault: VaultInfo;
  files: Array<{ id: string; path: string }>;
}

/**
 * List recipes across ALL vaults. Each file's basename (sans extension)
 * is the id. Accepts .yaml, .yml, .json.
 */
export function listAllVaultRecipes(chain: VaultInfo[]): VaultRecipeListing[] {
  const out: VaultRecipeListing[] = [];
  for (const vault of chain) {
    const root = vaultRecipesDir(vault);
    if (!existsSync(root)) continue;
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    const files: Array<{ id: string; path: string }> = [];
    for (const name of names) {
      const m = name.match(/^([a-z][a-z0-9-]*)\.(yaml|yml|json)$/i);
      if (!m) continue;
      const full = join(root, name);
      try {
        if (!statSync(full).isFile()) continue;
      } catch { continue; }
      files.push({ id: m[1], path: full });
    }
    if (files.length > 0) out.push({ vault, files });
  }
  return out;
}

export interface VaultTemplateListing {
  vault: VaultInfo;
  dirs: Array<{ id: string; dir: string; manifestPath: string }>;
}

/**
 * List trigger TEMPLATE directories across ALL vaults. Each subdirectory
 * of <vault>/trigger-types/ that contains template.yaml is a template.
 */
export function listAllVaultTriggerTemplates(chain: VaultInfo[]): VaultTemplateListing[] {
  const out: VaultTemplateListing[] = [];
  for (const vault of chain) {
    const root = vaultTriggerTypesDir(vault);
    if (!existsSync(root)) continue;
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    const dirs: Array<{ id: string; dir: string; manifestPath: string }> = [];
    for (const name of names) {
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch { continue; }
      const manifestPath = join(dir, 'template.yaml');
      if (!existsSync(manifestPath)) continue;
      dirs.push({ id: name, dir, manifestPath });
    }
    if (dirs.length > 0) out.push({ vault, dirs });
  }
  return out;
}
