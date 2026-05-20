# Vault Init + paths.get MCP Tool — Design Spec

**Date:** 2026-05-20
**Status:** Approved
**Scope:** Add vault registration to `clawdevbox init`, vault chain loader, and `paths.get` MCP tool.

---

## 1. Overview

Agents need to know where to read/write memory, skills, and other artifacts across three tiers: workspace (local), personal vault (user-scoped, git-backed), and team vault chain (shared, git-backed). This spec adds:

1. Config schema extension for vault entries
2. Init flow additions for personal + team vault setup
3. Vault chain loader module
4. `paths.get` MCP tool that returns all resolved paths

---

## 2. Config schema extension

Add `vaults` array to `ClawdevboxConfig` (on-disk `config.json`):

```jsonc
{
  "vaults": [
    {
      "id": "personal",
      "path": "C:/Users/user/.clawdevbox/personal-vault",
      "kind": "personal",
      "remote": null
    },
    {
      "id": "feature-crew-vault",
      "path": "C:/Users/user/.clawdevbox/vaults/feature-crew-vault",
      "kind": "team",
      "remote": "git@github.com:org/feature-crew-vault.git"
    },
    {
      "id": "meetings-vault",
      "path": "C:/Users/user/.clawdevbox/vaults/meetings-vault",
      "kind": "team",
      "remote": "git@github.com:org/meetings-vault.git"
    }
  ]
}
```

`ResolvedConfig` gains:

```typescript
interface VaultEntry {
  id: string;
  path: string;
  kind: 'personal' | 'team';
  remote: string | null;
}

// In ResolvedConfig:
vaults: VaultEntry[];
```

---

## 3. Init flow — vault setup step

Inserted after plugin install, before final config write.

### 3.1 Personal vault

Prompt: "Where should your personal vault live?" with choices:
- Default: `~/.clawdevbox/personal-vault` (recommended)
- Custom path (freeform)

Logic for the chosen path:
1. If path exists and is a git repo → use as-is, detect remote via `git remote get-url origin`
2. If path exists but not a git repo → scaffold + `git init` + `git add -A` + `git commit -m "init personal vault"`
3. If path doesn't exist → create dir + scaffold + `git init` + commit

**Scaffolding** (applied to any new or empty vault to make it a proper marketplace/plugin):

```
<vault-root>/
├── vault.yaml              # id, title, kind
├── .claude-plugin/
│   └── plugin.json         # minimal manifest so agent CLI treats it as a plugin
├── skills/
├── agents/
├── recipes/
├── triggers/
├── memory/
└── README.md               # brief description
```

Minimal `vault.yaml`:
```yaml
id: personal
title: Personal Vault
description: Personal knowledge, skills, and agents
tier_label: personal
```

Minimal `.claude-plugin/plugin.json`:
```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "<vault-id>",
  "version": "1.0.0",
  "description": "<vault title> — clawdevbox vault",
  "author": { "name": "<user>" },
  "license": "UNLICENSED"
}
```

This ensures every vault is immediately recognizable as both a clawdevbox vault (via `vault.yaml`) and a valid agent CLI plugin (via `.claude-plugin/plugin.json`).

The personal vault entry always has `kind: "personal"`.

### 3.2 Team vault

Prompt: "Do you have a team vault? Enter a git URL or local folder path, or press Enter to skip."

**If git URL provided:**
1. Derive `id` from repo basename (strip `.git` suffix)
2. Clone to `~/.clawdevbox/vaults/<id>/`
3. Read `vault.yaml` at root — parse `parent_vault.git_url`
4. If parent exists → recursively clone parent (same logic), building chain
5. Cycle detection: track seen `git_url` values; error if duplicate
6. Max depth: 10 (error with clear message if exceeded)
7. Add all vaults (leaf + parents) to `vaults[]` in config

**If local folder provided:**
1. Validate path exists and is a directory
2. Check if git repo: `git -C <path> rev-parse --is-inside-work-tree`
   - If yes: read remote via `git -C <path> remote get-url origin` (may be null)
   - If no: scaffold (same structure as personal vault but with team-appropriate vault.yaml) + `git init` + `git add -A` + `git commit -m "init team vault"`
3. If git repo but missing `vault.yaml` or `.claude-plugin/plugin.json`: scaffold the missing pieces, commit
4. Derive `id` from folder basename
4. If it has a remote → `kind: "team"`, `remote: <url>`
5. If no remote → `kind: "team"`, `remote: null`
6. Read `vault.yaml` → walk parent chain (same as git URL case)
7. Local folder vaults are NOT copied — used in-place (path stored directly)

### 3.3 Vault ID derivation

- Git URL: extract basename from URL path, strip `.git` suffix
  - `git@github.com:org/feature-crew-vault.git` → `feature-crew-vault`
  - `https://github.com/org/my-vault` → `my-vault`
- Local folder: use folder basename
  - `/home/user/vaults/my-team` → `my-team`

### 3.4 Idempotency

If `vaults[]` already has entries in config (re-running init), skip vault setup unless user explicitly wants to reconfigure. Show: "Vaults already configured: personal, feature-crew-vault. Reconfigure?" → yes/no.

---

## 4. Vault chain loader

New module: `mcp-server/src/vault-chain.ts`

```typescript
interface VaultInfo {
  id: string;
  kind: 'personal' | 'team';
  root: string;
  remote: string | null;
  memory: string;   // <root>/memory
  skills: string;   // <root>/skills
  recipes: string;  // <root>/recipes
  triggers: string; // <root>/triggers
  agents: string;   // <root>/agents
  hasRemote: boolean;
  depth: number;    // 0 = leaf team vault, 1 = its parent, etc.
}

interface VaultChain {
  personal: VaultInfo | null;
  teamVaults: VaultInfo[];  // ordered leaf→root
  chainOrder: string[];     // ['workspace', 'personal', '<leaf-id>', '<parent-id>', ...]
}

function loadVaultChain(config: ResolvedConfig): VaultChain;
```

`loadVaultChain` reads config.vaults, separates personal from team, then for team vaults orders them by reading each vault's `vault.yaml` parent link to determine depth (leaf = 0, first parent = 1, etc.). If `vault.yaml` is missing or unparseable, treat as standalone (depth 0).

---

## 5. `paths.get` MCP tool

New file: `mcp-server/src/tools/paths.ts`

Registered as `paths.get` in the MCP server.

**Input schema:** `{}` (empty — workspace resolved from request context via context-resolver)

**Resolution:**
1. Use `resolveWorkspaceContext(extra)` to get workspace ID + project path
2. Read `config.vaults` to load vault chain
3. Build response with all paths

**Output schema:**
```jsonc
{
  "workspace": {
    "id": "project",
    "root": "/path/to/project/.clawdevbox",
    "memory": "/path/to/project/.clawdevbox/memory.md",
    "skills": "/path/to/project/.clawdevbox/skills",
    "recipes": "/path/to/project/.clawdevbox/recipes",
    "triggers": "/path/to/project/.clawdevbox/triggers",
    "project_path": "/path/to/project"
  },
  "personal_vault": {
    "id": "personal",
    "root": "~/.clawdevbox/personal-vault",
    "memory": "~/.clawdevbox/personal-vault/memory",
    "skills": "~/.clawdevbox/personal-vault/skills",
    "recipes": "~/.clawdevbox/personal-vault/recipes",
    "triggers": "~/.clawdevbox/personal-vault/triggers",
    "agents": "~/.clawdevbox/personal-vault/agents"
  },
  "team_vaults": [
    {
      "id": "feature-crew-vault",
      "depth": 0,
      "root": "~/.clawdevbox/vaults/feature-crew-vault",
      "memory": "~/.clawdevbox/vaults/feature-crew-vault/memory",
      "skills": "~/.clawdevbox/vaults/feature-crew-vault/skills",
      "recipes": "~/.clawdevbox/vaults/feature-crew-vault/recipes",
      "triggers": "~/.clawdevbox/vaults/feature-crew-vault/triggers",
      "agents": "~/.clawdevbox/vaults/feature-crew-vault/agents",
      "has_remote": true
    }
  ],
  "chain_order": ["workspace", "personal", "feature-crew-vault"]
}
```

All paths are absolute. `~` is expanded. The tool uses forward slashes on all platforms for consistency.

---

## 6. vault.yaml schema (reference from parent spec)

```yaml
id: feature-crew-alpha-vault
title: Feature Crew Alpha
description: Vault for Feature Crew Alpha team
tier_label: feature-crew

self:
  provider: github
  repo: org/feature-crew-alpha-vault
  pr_remote: origin

parent_vault:
  git_url: git@github.com:org/meetings-vault.git
```

The loader only needs `id` and `parent_vault.git_url` from this file. Other fields are consumed by higher-level vault operations (share, endorse, etc.) not in this spec's scope.

---

## 6.5 Client sync — vault as plugin source

Vault skills/agents must be available to the agent CLI (copilot/agency) as if they were installed marketplace plugins. Each vault directory follows the same layout as a copilot plugin:

```
<vault-root>/
├── vault.yaml
├── skills/<id>/SKILL.md
├── agents/<id>.agent.md
├── recipes/<id>/recipe.yaml
└── ...
```

This maps directly to the copilot plugin structure (`.claude-plugin/` + `skills/` + `agents/`).

**Sync strategy:** During client sync (at boot and after init), each vault in `config.vaults` is registered as a plugin source in the agent CLI's plugin cache via symlink/junction — exactly like marketplace plugins:

1. For each vault entry, create a symlink at `~/.copilot/installed-plugins/<vault-id>/` → `<vault-path>/`
2. If the vault doesn't have a `.claude-plugin/plugin.json`, synthesize a minimal one at sync time (in-memory or written to the vault only if it's personal)
3. The agent CLI then auto-discovers skills/agents from the symlinked directory

**Chain precedence:** When the same skill ID exists in multiple vaults, the leaf vault's version takes precedence (child shadows parent). The agent CLI handles this naturally since plugin-dir order determines load priority — we pass `--plugin-dir` flags in chain order (leaf first).

**At agent spawn time:** The agency-provider already passes `--plugin-dir` for the dev-buddy plugin. Extend this to also pass vault plugin dirs:

```
--plugin-dir ~/.copilot/installed-plugins/personal
--plugin-dir ~/.copilot/installed-plugins/feature-crew-vault
--plugin-dir ~/.copilot/installed-plugins/meetings-vault
```

**Sync triggers:**
- `clawdevbox init` (after vault setup)
- `clawdevbox start` (at boot, during workspace load)
- `vault sync` command (future, explicit pull + re-sync)

---

## 7. Files to create/modify

| File | Action |
|------|--------|
| `mcp-server/src/config.ts` | Add `VaultEntry` type, `vaults` to config schema + resolver |
| `mcp-server/src/vault-chain.ts` | New — vault chain loader |
| `mcp-server/src/tools/paths.ts` | New — `paths.get` MCP tool |
| `mcp-server/src/server.ts` | Register `paths.get` tool |
| `mcp-server/src/cli/init.ts` | Add vault setup step after plugin install |
| `mcp-server/src/cli/init-vault.ts` | New — vault init logic (clone, chain-walk, git init) |
| `mcp-server/src/cli/vault-sync.ts` | New — symlink vaults into agent CLI plugin cache |
| `mcp-server/src/agent-clis/shared.ts` | Pass vault `--plugin-dir` flags at spawn |
| `mcp-server/tests/vault-chain.test.mjs` | Tests for chain loader |
| `mcp-server/tests/paths-tool.test.mjs` | Tests for paths.get tool |

---

## 8. Error handling

- **Clone failure:** surface git error, ask user to check credentials/URL, allow retry or skip
- **vault.yaml missing:** treat vault as standalone (no parent), log warning
- **vault.yaml parse error:** same as missing — warn + treat as standalone
- **Cycle detected:** error with message showing the cycle path
- **Max depth exceeded:** error with message showing chain so far
- **No workspace registered (paths.get):** return `NO_TARGET_WORKSPACE` error code via context-resolver (existing behavior)

---

## 9. Testing

- **vault-chain.test.mjs:** Unit tests with mock filesystem — test chain ordering, cycle detection, max depth, missing vault.yaml
- **paths-tool.test.mjs:** Boot MCP server with test config containing vaults, call `paths.get`, verify output shape
- **init-vault integration:** Manual testing (git clone is side-effectful); unit test the ID derivation and vault.yaml parsing logic

---

## 10. Out of scope (deferred)

- Vault sync/pull (periodic git fetch)
- vault.share / vault.endorse / vault.veto tools
- Artifact shadowing resolution
- Search across vault chain
- Promotion/demotion workflows
