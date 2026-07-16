/**
 * vault-chain.ts
 *
 * Loads configured vaults from disk and returns them ordered leaf→root:
 * personal vaults first, then team vaults in registration order.
 *
 * Each VaultInfo carries parsed metadata from vault.yaml (if present)
 * plus the paths needed for --plugin-dir resolution.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultEntry } from './config.ts';

export interface VaultInfo {
  /** Vault id from config (stable, user-facing). */
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** personal | team (from config entry). */
  kind: 'personal' | 'team';
  /** Remote git URL if cloned, null if local-only. */
  remote: string | null;
  /** If true, the vault is read-only — no writes allowed. Default false. */
  readonly: boolean;
  /** If true, the vault participates in memory storage and indexing. Default true. */
  memory: boolean;
  /** Title from vault.yaml, if present. */
  title?: string;
  /** tier_label from vault.yaml, if present. */
  tierLabel?: string;
  /** Description from vault.yaml, if present. */
  description?: string;
}

/**
 * Parse vault.yaml metadata from a vault root.
 * Simple line-based parser — no yaml dependency.
 */
function parseVaultYaml(vaultRoot: string): { title?: string; tierLabel?: string; description?: string; readonly?: boolean; memory?: boolean } {
  const yamlPath = join(vaultRoot, 'vault.yaml');
  if (!existsSync(yamlPath)) return {};

  let content: string;
  try {
    content = readFileSync(yamlPath, 'utf8');
  } catch {
    return {};
  }

  let title: string | undefined;
  let tierLabel: string | undefined;
  let description: string | undefined;
  let readonly: boolean | undefined;
  let memory: boolean | undefined;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const titleMatch = trimmed.match(/^title:\s*(.+)/);
    if (titleMatch) { title = titleMatch[1].replace(/^['"]|['"]$/g, ''); continue; }
    const tierMatch = trimmed.match(/^tier_label:\s*(.+)/);
    if (tierMatch) { tierLabel = tierMatch[1].replace(/^['"]|['"]$/g, ''); continue; }
    const descMatch = trimmed.match(/^description:\s*(.+)/);
    if (descMatch) { description = descMatch[1].replace(/^['"]|['"]$/g, ''); continue; }
    const readonlyMatch = trimmed.match(/^readonly:\s*(.+)/);
    if (readonlyMatch) { readonly = readonlyMatch[1].replace(/^['"]|['"]$/g, '') === 'true'; continue; }
    const memoryMatch = trimmed.match(/^memory:\s*(.+)/);
    if (memoryMatch) { memory = memoryMatch[1].replace(/^['"]|['"]$/g, '') === 'true'; continue; }
  }

  return { title, tierLabel, description, readonly, memory };
}

/**
 * Load vault chain from config entries. Skips entries whose path doesn't exist.
 * Returns personal vaults first, then team vaults, preserving registration order within each tier.
 */
export function loadVaultChain(entries: VaultEntry[]): VaultInfo[] {
  const personal: VaultInfo[] = [];
  const team: VaultInfo[] = [];

  for (const entry of entries) {
    if (!existsSync(entry.path)) continue;

    const yaml = parseVaultYaml(entry.path);
    const info: VaultInfo = {
      id: entry.id,
      path: entry.path,
      kind: entry.kind,
      remote: entry.remote,
      // Config entry takes precedence over vault.yaml; defaults: readonly=false, memory=true
      readonly: entry.readonly ?? yaml.readonly ?? false,
      memory: entry.memory ?? yaml.memory ?? true,
      title: yaml.title,
      tierLabel: yaml.tierLabel,
      description: yaml.description,
    };

    if (entry.kind === 'personal') {
      personal.push(info);
    } else {
      team.push(info);
    }
  }

  return [...personal, ...team];
}
