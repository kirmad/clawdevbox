/**
 * cli/init-vault.ts
 *
 * Vault setup logic for `clawdevbox init`. Handles:
 * - Personal vault prompt + scaffold
 * - Team vault prompt (git URL or local folder)
 * - Clone + chain-walk for git vaults
 * - Scaffold for new/empty vaults
 * - Git init for non-git directories
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { confirm, isCancel, log, spinner, text } from '@clack/prompts';
import type { VaultEntry } from '../config.ts';

// ============================================================================
// Exported helpers (also used by tests)
// ============================================================================

/**
 * Derive a vault ID from a git URL or local path.
 * - Git SSH: git@github.com:org/name.git → name
 * - HTTPS: https://github.com/org/name → name
 * - Local: /path/to/folder → folder
 */
export function deriveVaultIdFromSource(source: string): string {
  // Strip trailing slashes and .git
  let s = source.replace(/[/\\]+$/, '').replace(/\.git$/, '');

  // For SSH URLs like git@host:org/name (but not Windows drive letters)
  // SSH URLs always contain @, so we can use that to disambiguate
  if (s.includes('@')) {
    const sshMatch = s.match(/[:\/]([^/:]+)$/);
    if (sshMatch) return sshMatch[1];
  }

  // For HTTPS or local paths, take the last path segment
  const segments = s.split(/[/\\]/);
  return segments[segments.length - 1] || 'vault';
}

/** Check if a directory is inside a git working tree. */
export function isGitRepo(dir: string): boolean {
  try {
    const result = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return result.status === 0 && result.stdout.toString().trim() === 'true';
  } catch {
    return false;
  }
}

/** Get the origin remote URL for a git repo, or null. */
export function getGitRemote(dir: string): string | null {
  try {
    const result = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    if (result.status !== 0) return null;
    const url = result.stdout.toString().trim();
    return url || null;
  } catch {
    return null;
  }
}

export interface ScaffoldOpts {
  id: string;
  title: string;
  kind: 'personal' | 'team';
}

/**
 * Scaffold a vault directory with the standard structure.
 * Does NOT overwrite existing files (additive only).
 */
export function scaffoldVault(dir: string, opts: ScaffoldOpts): void {
  mkdirSync(dir, { recursive: true });

  // vault.yaml
  const yamlPath = join(dir, 'vault.yaml');
  if (!existsSync(yamlPath)) {
    writeFileSync(yamlPath, [
      `id: ${opts.id}`,
      `title: ${opts.title}`,
      `description: ${opts.title} — clawdevbox vault`,
      `tier_label: ${opts.kind}`,
      '',
    ].join('\n'));
  }

  // .claude-plugin/plugin.json
  const pluginDir = join(dir, '.claude-plugin');
  const pluginJsonPath = join(pluginDir, 'plugin.json');
  if (!existsSync(pluginJsonPath)) {
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(pluginJsonPath, JSON.stringify({
      $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
      name: opts.id,
      version: '1.0.0',
      description: `${opts.title} — clawdevbox vault`,
      author: { name: homedir().split(/[/\\]/).pop() || 'user' },
      license: 'UNLICENSED',
    }, null, 2) + '\n');
  }

  // Subdirectories
  for (const sub of ['skills', 'agents', 'recipes', 'triggers', 'memory']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }

  // README.md
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, [
      `# ${opts.title}`,
      '',
      `A clawdevbox ${opts.kind} vault.`,
      '',
      '## Structure',
      '',
      '- `skills/` — Reusable skill definitions',
      '- `agents/` — Agent persona definitions',
      '- `recipes/` — Automation recipes',
      '- `triggers/` — Trigger type definitions',
      '- `memory/` — Knowledge pages',
      '',
    ].join('\n'));
  }
}

/** Initialize git in a directory + initial commit. */
export function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "init vault" --allow-empty', { cwd: dir, stdio: 'ignore' });
}

/** Clone a git repo to a target directory. Returns true on success. */
export function cloneRepo(url: string, targetDir: string): boolean {
  try {
    const result = spawnSync('git', ['clone', url, targetDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// vault.yaml parsing (simple line-based, no YAML dep needed)
// ============================================================================

interface VaultYamlInfo {
  id: string | null;
  parentGitUrl: string | null;
}

function parseVaultYaml(vaultRoot: string): VaultYamlInfo {
  const yamlPath = join(vaultRoot, 'vault.yaml');
  if (!existsSync(yamlPath)) return { id: null, parentGitUrl: null };

  let content: string;
  try {
    content = readFileSync(yamlPath, 'utf8');
  } catch {
    return { id: null, parentGitUrl: null };
  }

  let id: string | null = null;
  let parentGitUrl: string | null = null;
  let inParentVault = false;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    const idMatch = trimmed.match(/^id:\s*(.+)/);
    if (idMatch && !inParentVault) {
      id = idMatch[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^parent_vault:\s*$/.test(trimmed)) {
      inParentVault = true;
      continue;
    }
    if (inParentVault && /^\s+/.test(line)) {
      const gitUrlMatch = trimmed.match(/^\s+git_url:\s*(.+)/);
      if (gitUrlMatch) {
        parentGitUrl = gitUrlMatch[1].trim().replace(/^['"]|['"]$/g, '');
      }
      continue;
    }
    if (inParentVault && !/^\s+/.test(line) && trimmed.length > 0) {
      inParentVault = false;
    }
  }

  return { id, parentGitUrl };
}

// ============================================================================
// Chain walker
// ============================================================================

/**
 * Walk the parent_vault chain starting from a vault directory.
 * Clones parent vaults as needed. Returns all discovered VaultEntry objects.
 */
export function walkParentChain(
  startDir: string,
  _startId: string,
  startRemote: string | null,
  vaultsDir: string,
): VaultEntry[] {
  const entries: VaultEntry[] = [];
  const seen = new Set<string>();
  if (startRemote) seen.add(startRemote);

  let currentDir = startDir;
  let depth = 0;
  const MAX_DEPTH = 10;

  while (depth < MAX_DEPTH) {
    const yaml = parseVaultYaml(currentDir);
    if (!yaml.parentGitUrl) break;
    if (seen.has(yaml.parentGitUrl)) {
      log.warn(`Cycle detected in vault parent chain at: ${yaml.parentGitUrl}`);
      break;
    }
    seen.add(yaml.parentGitUrl);

    const parentId = deriveVaultIdFromSource(yaml.parentGitUrl);
    const parentDir = join(vaultsDir, parentId);

    if (!existsSync(parentDir)) {
      log.info(`Cloning parent vault: ${yaml.parentGitUrl}`);
      if (!cloneRepo(yaml.parentGitUrl, parentDir)) {
        log.warn(`Failed to clone parent vault: ${yaml.parentGitUrl}`);
        break;
      }
    }

    entries.push({ id: parentId, path: parentDir, kind: 'team', remote: yaml.parentGitUrl });
    currentDir = parentDir;
    depth++;
  }

  if (depth >= MAX_DEPTH) {
    log.warn(`Parent vault chain exceeds max depth (${MAX_DEPTH}).`);
  }
  return entries;
}

// ============================================================================
// Interactive prompts (called from init.ts)
// ============================================================================

export interface VaultSetupResult {
  vaults: VaultEntry[];
}

export async function runVaultSetup(globalDir: string): Promise<VaultSetupResult> {
  const vaults: VaultEntry[] = [];
  const vaultsDir = join(globalDir, 'vaults');

  // ---- Personal vault ----
  const defaultPersonalPath = join(globalDir, 'personal-vault');
  const personalPathRaw = await text({
    message: 'Where should your personal vault live?',
    placeholder: defaultPersonalPath,
    defaultValue: defaultPersonalPath,
    validate: (val) => {
      if (!val || val.trim().length === 0) return 'Path cannot be empty';
      return undefined;
    },
  });
  if (isCancel(personalPathRaw)) return { vaults };

  const personalPath = resolve(String(personalPathRaw || defaultPersonalPath));
  let personalRemote: string | null = null;

  if (existsSync(personalPath) && isGitRepo(personalPath)) {
    personalRemote = getGitRemote(personalPath);
    scaffoldVault(personalPath, { id: 'personal', title: 'Personal Vault', kind: 'personal' });
  } else {
    scaffoldVault(personalPath, { id: 'personal', title: 'Personal Vault', kind: 'personal' });
    if (!isGitRepo(personalPath)) {
      initGitRepo(personalPath);
    }
  }
  vaults.push({ id: 'personal', path: personalPath, kind: 'personal', remote: personalRemote });

  // ---- Team vault ----
  const teamInput = await text({
    message: 'Team vault — enter a git URL or local folder path (or press Enter to skip):',
    placeholder: 'git@github.com:org/team-vault.git',
    defaultValue: '',
  });
  if (isCancel(teamInput)) return { vaults };

  const teamSource = String(teamInput).trim();
  if (teamSource.length > 0) {
    // Detect git URLs vs local paths. Windows drive letters (C:\...) are NOT URLs.
    const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(teamSource);
    const teamId = deriveVaultIdFromSource(teamSource);

    if (isUrl) {
      mkdirSync(vaultsDir, { recursive: true });
      const targetDir = join(vaultsDir, teamId);
      if (existsSync(targetDir)) {
        log.info(`Team vault already exists at ${targetDir}`);
      } else {
        const cloneSpinner = spinner();
        cloneSpinner.start(`Cloning ${teamSource}...`);
        if (!cloneRepo(teamSource, targetDir)) {
          cloneSpinner.stop('Clone failed — check credentials/URL.');
          return { vaults };
        }
        cloneSpinner.stop(`Cloned to ${targetDir}`);
      }
      vaults.push({ id: teamId, path: targetDir, kind: 'team', remote: teamSource });
      const parents = walkParentChain(targetDir, teamId, teamSource, vaultsDir);
      vaults.push(...parents);
    } else {
      const localPath = resolve(teamSource);
      if (!existsSync(localPath)) mkdirSync(localPath, { recursive: true });
      let remote: string | null = null;
      if (isGitRepo(localPath)) {
        remote = getGitRemote(localPath);
        scaffoldVault(localPath, { id: teamId, title: teamId, kind: 'team' });
      } else {
        scaffoldVault(localPath, { id: teamId, title: teamId, kind: 'team' });
        initGitRepo(localPath);
      }
      vaults.push({ id: teamId, path: localPath, kind: 'team', remote });
      const parents = walkParentChain(localPath, teamId, remote, vaultsDir);
      vaults.push(...parents);
    }
  }

  return { vaults };
}
