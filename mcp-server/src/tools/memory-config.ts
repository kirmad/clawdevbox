/**
 * tools/memory-config.ts
 *
 * Loads `~/.clawdevbox/memory-config.json` with sensible defaults.
 * Re-exports `loadVaultChain()` from the existing vault-chain module
 * so memory tools have a single import for "where are my repos."
 * Resolves git identity for stamping writes and vote events.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { loadVaultChain, type VaultInfo } from '../vault-chain.ts';

export { loadVaultChain, type VaultInfo };

export interface MemoryConfig {
  decay: { floor: number; half_life_days: number };
  duplicate_threshold: number;
  sync: { push_debounce_ms: number; pull_interval_ms: number; index_debounce_ms: number };
  auto_resolve_conflicts: 'manual' | 'auto';
  auto_resolve: {
    max_conflicts_per_file_per_hour: number;
    max_diff_lines: number;
    pre_merge_tag_ttl_days: number;
    spawn_timeout_ms: number;
  };
  qmd_db_path: string;
  /** 'lex' = BM25 only (no GGUF models needed). Default — works without a GPU. */
  qmd_search_mode: 'lex' | 'hybrid' | 'vec';
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  decay: { floor: 0.2, half_life_days: 30 },
  duplicate_threshold: 0.85,
  sync: { push_debounce_ms: 30_000, pull_interval_ms: 300_000, index_debounce_ms: 5_000 },
  auto_resolve_conflicts: 'manual',
  auto_resolve: {
    max_conflicts_per_file_per_hour: 3,
    max_diff_lines: 100,
    pre_merge_tag_ttl_days: 30,
    spawn_timeout_ms: 300_000,
  },
  qmd_db_path: '~/.cache/qmd/clawdevbox-memory.sqlite',
  qmd_search_mode: 'lex',
};

export function loadMemoryConfig(path: string): MemoryConfig {
  if (!existsSync(path)) return cloneDefaults();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`memory-config.json at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`memory-config.json at ${path} must be a JSON object`);
  }
  const user = raw as Partial<MemoryConfig>;
  return {
    decay: { ...DEFAULT_MEMORY_CONFIG.decay, ...(user.decay ?? {}) },
    duplicate_threshold: user.duplicate_threshold ?? DEFAULT_MEMORY_CONFIG.duplicate_threshold,
    sync: { ...DEFAULT_MEMORY_CONFIG.sync, ...(user.sync ?? {}) },
    auto_resolve_conflicts: user.auto_resolve_conflicts ?? DEFAULT_MEMORY_CONFIG.auto_resolve_conflicts,
    auto_resolve: { ...DEFAULT_MEMORY_CONFIG.auto_resolve, ...(user.auto_resolve ?? {}) },
    qmd_db_path: user.qmd_db_path ?? DEFAULT_MEMORY_CONFIG.qmd_db_path,
    qmd_search_mode: user.qmd_search_mode ?? DEFAULT_MEMORY_CONFIG.qmd_search_mode,
  };
}

function cloneDefaults(): MemoryConfig {
  return JSON.parse(JSON.stringify(DEFAULT_MEMORY_CONFIG));
}

export interface Identity {
  email: string;
  name: string;
  source: 'git' | 'os';
}

export interface IdentityResolvers {
  gitConfigEmail: () => Promise<string>;
  gitConfigName: () => Promise<string>;
  osUsername: () => string;
}

const execFileP = promisify(execFile);

export const defaultIdentityResolvers: IdentityResolvers = {
  gitConfigEmail: async () => {
    try {
      const { stdout } = await execFileP('git', ['config', '--get', 'user.email']);
      return stdout.trim();
    } catch {
      return '';
    }
  },
  gitConfigName: async () => {
    try {
      const { stdout } = await execFileP('git', ['config', '--get', 'user.name']);
      return stdout.trim();
    } catch {
      return '';
    }
  },
  osUsername: () => userInfo().username,
};

export async function resolveIdentity(
  resolvers: IdentityResolvers = defaultIdentityResolvers,
): Promise<Identity> {
  const email = await resolvers.gitConfigEmail();
  const name = await resolvers.gitConfigName();
  if (email) {
    return { email, name: name || email, source: 'git' };
  }
  const user = resolvers.osUsername();
  if (!user) {
    throw new Error(
      'Could not resolve identity: git config user.email empty and os.userInfo().username also empty. ' +
      'Run: git config --global user.email "you@example.com"',
    );
  }
  return { email: `${user}@local`, name: user, source: 'os' };
}
