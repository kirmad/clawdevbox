/**
 * tools/memory-paths.ts
 *
 * Slug rule, filename construction, vault resolution from scope/vault_id,
 * and on-disk path layout (project/type/file + .events sidecar).
 */

import { join, dirname, basename, extname } from 'node:path';
import type { VaultInfo } from '../vault-chain.ts';

export type MemoryType = 'memory' | 'lesson' | 'session' | 'wiki';
export type Scope = 'personal' | 'team';

/**
 * Top-level subdirectory under each vault that holds all clawdevbox
 * memory artifacts. Keeps memory data isolated so the vault can host
 * other kinds of content (Obsidian notes, skills, agents) at the root
 * without colliding with the per-project memory layout.
 */
export const MEMORY_ROOT_DIR = 'memories';

/**
 * Absolute path to the memory subsystem's root within a vault:
 *   <vault.path>/memories
 * All other path builders compose on top of this.
 */
export function vaultMemoryRoot(vault: VaultInfo): string {
  return join(vault.path, MEMORY_ROOT_DIR);
}

const TYPE_TO_FOLDER: Record<MemoryType, string> = {
  memory: 'memories',
  lesson: 'lessons',
  session: 'sessions',
  wiki: 'wiki',
};

export function typeFolder(type: MemoryType): string {
  return TYPE_TO_FOLDER[type];
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function dateOnly(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dateMinute(d: Date): string {
  return `${dateOnly(d)}T${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}`;
}

export function buildFilename(type: MemoryType, title: string, created: Date): string {
  if (type === 'wiki') {
    const trimmed = title.replace(/\.md$/i, '');
    const segments = trimmed.split('/').map((s) => slugify(s)).filter(Boolean);
    if (segments.length === 0) return 'untitled.md';
    return `${segments.join('/')}.md`;
  }
  const slug = slugify(title) || 'untitled';
  const prefix = type === 'session' ? dateMinute(created) : dateOnly(created);
  return `${prefix}-${slug}.md`;
}

export function resolveVault(chain: VaultInfo[], scope: Scope, vault_id?: string): VaultInfo {
  if (vault_id) {
    const v = chain.find((v) => v.id === vault_id);
    if (!v) {
      const ids = chain.map((v) => v.id).join(', ') || '(none)';
      throw new Error(`vault_id "${vault_id}" not found in vault chain. Registered: ${ids}`);
    }
    return v;
  }
  const match = chain.find((v) => v.kind === scope);
  if (!match) {
    throw new Error(
      `no vault registered with kind=${scope}. Use paths.get to inspect the current chain, ` +
      `or register a vault via clawdevbox vault setup.`,
    );
  }
  return match;
}

function assertProjectSafe(project: string): void {
  if (
    project.includes('..') ||
    project.includes('/') ||
    project.includes('\\') ||
    project.startsWith('.')
  ) {
    throw new Error(`project slug "${project}" contains illegal characters (.. / \\ or leading .)`);
  }
}

export function vaultPathFor(
  vault: VaultInfo,
  project: string,
  type: MemoryType,
  filename: string,
): string {
  assertProjectSafe(project);
  return join(vaultMemoryRoot(vault), project, typeFolder(type), filename);
}

export function eventsPathFor(
  vault: VaultInfo,
  project: string,
  type: MemoryType,
  filename: string,
): string {
  assertProjectSafe(project);
  const stem = filename.replace(/\.md$/i, '');
  const dir = dirname(stem);
  const base = basename(stem);
  const eventsDir = dir === '.'
    ? join(vaultMemoryRoot(vault), project, typeFolder(type), '.events')
    : join(vaultMemoryRoot(vault), project, typeFolder(type), '.events', dir);
  return join(eventsDir, `${base}.jsonl`);
}

export function withCollisionSuffix(filename: string, attempt: number): string {
  if (attempt === 0) return filename;
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return `${stem}-${attempt + 1}${ext}`;
}
