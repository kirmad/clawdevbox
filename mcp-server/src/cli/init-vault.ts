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
      `readonly: false`,
      `memory: true`,
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

interface VaultInclude {
  git_url: string;
  branch?: string;
  /** Subfolder within the repo that is the vault root. Defaults to '/' (repo root). */
  vault_path?: string;
}

interface VaultYamlInfo {
  id: string | null;
  /** Legacy single-parent pointer. */
  parentGitUrl: string | null;
  /** List of included vault dependencies (DAG, not linear chain). */
  includes: VaultInclude[];
}

function parseVaultYaml(vaultRoot: string): VaultYamlInfo {
  const yamlPath = join(vaultRoot, 'vault.yaml');
  if (!existsSync(yamlPath)) return { id: null, parentGitUrl: null, includes: [] };

  let content: string;
  try {
    content = readFileSync(yamlPath, 'utf8');
  } catch {
    return { id: null, parentGitUrl: null, includes: [] };
  }

  let id: string | null = null;
  let parentGitUrl: string | null = null;
  const includes: VaultInclude[] = [];
  let inParentVault = false;
  let inIncludes = false;
  // Track current include object being built (for multi-line object form)
  let currentInclude: Partial<VaultInclude> | null = null;

  function flushInclude(): void {
    if (currentInclude?.git_url) {
      includes.push({
        git_url: currentInclude.git_url,
        branch: currentInclude.branch,
        vault_path: currentInclude.vault_path,
      });
    }
    currentInclude = null;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    const idMatch = trimmed.match(/^id:\s*(.+)/);
    if (idMatch && !inParentVault && !inIncludes) {
      id = idMatch[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    // Legacy: parent_vault.git_url (single parent)
    if (/^parent_vault:\s*$/.test(trimmed)) {
      inParentVault = true;
      inIncludes = false;
      flushInclude();
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
    // includes[] — list of URLs or {git_url, branch} objects
    if (/^includes:\s*$/.test(trimmed)) {
      inIncludes = true;
      inParentVault = false;
      flushInclude();
      continue;
    }
    if (inIncludes && /^\s+/.test(line)) {
      // New list item starting with "- "
      const dashMatch = trimmed.match(/^\s+-\s*(.*)/);
      if (dashMatch) {
        flushInclude();
        const rest = dashMatch[1].trim();
        // Check if it's "- git_url: ..." (object form, first field)
        const objStart = rest.match(/^git_url:\s*(.+)/);
        if (objStart) {
          currentInclude = { git_url: objStart[1].trim().replace(/^['"]|['"]$/g, '') };
          continue;
        }
        // Simple string form: "- git@..."
        if (rest.length > 0) {
          includes.push({ git_url: rest.replace(/^['"]|['"]$/g, '') });
          continue;
        }
        // Bare "- " → start empty object, fields on next lines
        currentInclude = {};
        continue;
      }
      // Continuation of current object (indented, no dash)
      if (currentInclude) {
        const gitUrlMatch = trimmed.match(/^\s+git_url:\s*(.+)/);
        if (gitUrlMatch) {
          currentInclude.git_url = gitUrlMatch[1].trim().replace(/^['"]|['"]$/g, '');
          continue;
        }
        const branchMatch = trimmed.match(/^\s+branch:\s*(.+)/);
        if (branchMatch) {
          currentInclude.branch = branchMatch[1].trim().replace(/^['"]|['"]$/g, '');
          continue;
        }
        const vpMatch = trimmed.match(/^\s+vault_path:\s*(.+)/);
        if (vpMatch) {
          currentInclude.vault_path = vpMatch[1].trim().replace(/^['"]|['"]$/g, '');
          continue;
        }
      }
      continue;
    }
    if (inIncludes && !/^\s+/.test(line) && trimmed.length > 0) {
      flushInclude();
      inIncludes = false;
    }
  }
  flushInclude();

  return { id, parentGitUrl, includes };
}

// ============================================================================
// Dependency walker (includes[] + legacy parent_vault)
// ============================================================================

/**
 * Walk the includes[] (and legacy parent_vault) graph starting from a vault.
 * Clones included vaults as needed. Handles DAGs (multiple includes per vault)
 * with cycle detection. Returns all discovered VaultEntry objects in
 * breadth-first order. Supports per-include `branch` for private branches.
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

  // BFS queue: each item is a vault directory to scan for includes
  const queue: string[] = [startDir];
  let processed = 0;
  const MAX_TOTAL = 50; // safety cap on total included vaults

  while (queue.length > 0 && processed < MAX_TOTAL) {
    const currentDir = queue.shift()!;
    const yaml = parseVaultYaml(currentDir);

    // Collect all dependencies: includes[] first, then legacy parent_vault
    const deps: VaultInclude[] = [...yaml.includes];
    if (yaml.parentGitUrl && !deps.some((d) => d.git_url === yaml.parentGitUrl)) {
      deps.push({ git_url: yaml.parentGitUrl });
    }

    for (const dep of deps) {
      // Deduplicate by git_url + vault_path — the same repo can host
      // multiple vaults at different paths.
      const dedupeKey = `${dep.git_url}::${dep.vault_path ?? '/'}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const depId = deriveVaultIdFromSource(dep.git_url);
      const depDir = join(vaultsDir, depId);

      if (!existsSync(depDir)) {
        log.info(`Cloning included vault: ${dep.git_url}${dep.branch ? ` (branch: ${dep.branch})` : ''}`);
        const cloneArgs = dep.branch
          ? ['clone', '--branch', dep.branch, dep.git_url, depDir]
          : undefined; // use default cloneRepo
        const ok = cloneArgs
          ? (() => {
              const r = spawnSync('git', cloneArgs, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
              return r.status === 0;
            })()
          : cloneRepo(dep.git_url, depDir);
        if (!ok) {
          log.warn(`Failed to clone included vault: ${dep.git_url}`);
          continue;
        }
      } else if (dep.branch) {
        // Already cloned — ensure correct branch
        const currentBranch = spawnSync('git', ['-C', depDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
          encoding: 'utf8', windowsHide: true,
        }).stdout?.trim();
        if (currentBranch && currentBranch !== dep.branch) {
          log.info(`Switching ${depId} to branch: ${dep.branch}`);
          spawnSync('git', ['-C', depDir, 'checkout', dep.branch], { encoding: 'utf8', windowsHide: true });
        }
      }

      // The vault root is either the repo root or a subfolder within it
      const vaultRoot = dep.vault_path && dep.vault_path !== '/'
        ? join(depDir, dep.vault_path.replace(/^\//, ''))
        : depDir;

      // For multi-vault-per-repo, derive a unique id from path suffix
      const vaultId = dep.vault_path && dep.vault_path !== '/'
        ? `${depId}-${dep.vault_path.replace(/^\//, '').replace(/[\\/]/g, '-')}`
        : depId;

      entries.push({ id: vaultId, path: vaultRoot, kind: 'team', remote: dep.git_url, branch: dep.branch });
      queue.push(vaultRoot); // scan this vault's vault.yaml for transitive includes
      processed++;
    }
  }

  if (processed >= MAX_TOTAL) {
    log.warn(`Included vault graph exceeds max count (${MAX_TOTAL}).`);
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
