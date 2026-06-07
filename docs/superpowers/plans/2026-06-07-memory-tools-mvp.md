# Memory Tools MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP (spec Phases 0-3) of the memory-tools subsystem so agents can write, read, and search Obsidian-compatible markdown memories/lessons/sessions/wiki pages stored as git-versioned files in clawdevbox-registered vaults.

**Architecture:** 8 new TypeScript modules under `mcp-server/src/tools/memory*.ts` plus `mcp-server/src/tools/memory.ts` registering 9 MCP tools. Reuses clawdevbox's existing `loadVaultChain()` for repo paths. Storage: `.md` files + `.events/<stem>.jsonl` sidecars per the spec. Search via `@tobilu/qmd` SDK in-process, defaulting to **BM25-only `lex` mode** so machines without a GPU can run E2E tests without GGUF model loading.

**Tech Stack:** TypeScript 5.4, Node 22+ (qmd requires ≥22, bumped from 20), `@tobilu/qmd` SDK, Zod, `js-yaml` (already a dep), git CLI via `child_process`, `node:test` framework.

**Scope (this plan):** spec Phases 0-3. The 9 tools shipped: `add_memory`, `add_lesson` (no dedup), `add_session_summary`, `add_wiki_page`, `get_memory`, `get_wiki_index`, `search_memory`, `memory_init`, `memory_status`.

**Explicitly OUT of scope (follow-on plans):** voting (Phase 4), lesson dedup (Phase 4), background sync daemon push/pull (Phase 6), `update_wiki` body mutation (Phase 7), conflict auto-resolve (Phase 8).

**Critical constraints:**
- This machine has **NO GPU**. All tests MUST default to qmd's BM25-only `lex` mode. Hybrid/vector modes are user-opt-in via config.
- Real E2E tests against a real temp git repo + real `loadVaultChain` setup + real qmd SDK (lex-only).
- TDD: failing test before implementation in every task.
- Commit after every task that ships with passing tests.

**Spec reference:** `docs/superpowers/specs/2026-06-07-memory-tools-design.md`.

---

## File Structure (created by this plan)

| File | Responsibility |
|---|---|
| `mcp-server/src/tools/memory-config.ts` | Load `~/.clawdevbox/memory-config.json` with defaults; re-export `loadVaultChain()`; resolve git identity |
| `mcp-server/src/tools/memory-paths.ts` | Slug rule, filename builder, vault resolution by scope/vault_id, path utils |
| `mcp-server/src/tools/memory-vault-lock.ts` | Per-vault async mutex (chained Promises in a Map) |
| `mcp-server/src/tools/memory-frontmatter.ts` | YAML I/O — build/parse frontmatter per type via `js-yaml` |
| `mcp-server/src/tools/memory-events.ts` | Append events, fold events into FoldedState, decay formula |
| `mcp-server/src/tools/memory-git.ts` | Inline `git add + commit` helper using `child_process` |
| `mcp-server/src/tools/memory-qmd.ts` | Lazy `@tobilu/qmd` createStore wrapper, register collections, search helpers |
| `mcp-server/src/tools/memory.ts` | 9 MCP tool registrations + handlers |

| Test file | Coverage |
|---|---|
| `mcp-server/tests/memory-config.test.mjs` | config defaults, identity resolution |
| `mcp-server/tests/memory-paths.test.mjs` | slug, filename, vault resolution, collision suffix |
| `mcp-server/tests/memory-vault-lock.test.mjs` | sequential lock behavior under concurrency |
| `mcp-server/tests/memory-frontmatter.test.mjs` | round-trip parse/build per type |
| `mcp-server/tests/memory-events.test.mjs` | append, fold, decay, per-actor latest vote |
| `mcp-server/tests/memory-git.test.mjs` | commit against real temp git repo |
| `mcp-server/tests/memory-tools-e2e.test.mjs` | Full E2E: real vault chain + 9 tools + real qmd `searchLex` |

**Modified files:**
- `mcp-server/package.json` — add `@tobilu/qmd` dep, bump `engines.node` to `>=22.0.0`, bump `@types/node` to `^22.0.0`, add 7 new test files to `scripts.test`.
- `mcp-server/src/server.ts` — import & call `registerMemoryEntries(ws)`.

---

# Phase 0 — Plumbing

### Task 0.1: Add @tobilu/qmd dependency and bump Node engines

**Files:**
- Modify: `mcp-server/package.json` (deps + engines + test script later)

- [ ] **Step 1: Install @tobilu/qmd**

Run: `cd mcp-server && npm install @tobilu/qmd --save`
Expected: install completes; package.json updated; node_modules populated. If native build fails on this machine, capture the error and proceed — we still need the dep listed for the user's GPU machine, and lex-only mode does not need the GGUF binaries.

- [ ] **Step 2: Bump engines.node and @types/node**

Edit `mcp-server/package.json`:
- `engines.node` from `>=20.0.0` to `>=22.0.0`
- `devDependencies["@types/node"]` from `^20.0.0` to `^22.0.0`

Then: `cd mcp-server && npm install` to refresh lockfile.

- [ ] **Step 3: Verify typecheck still passes**

Run: `cd mcp-server && npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/package.json mcp-server/package-lock.json
git commit -m "feat(memory): add @tobilu/qmd dep and bump Node to >=22"
```

---

### Task 0.2: memory-config.ts — defaults + identity + vault chain re-export

**Files:**
- Create: `mcp-server/src/tools/memory-config.ts`
- Create: `mcp-server/tests/memory-config.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `mcp-server/tests/memory-config.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMemoryConfig, resolveIdentity, DEFAULT_MEMORY_CONFIG } from '../src/tools/memory-config.ts';

test('loadMemoryConfig returns defaults when file missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-cfg-'));
  try {
    const cfg = loadMemoryConfig(join(dir, 'memory-config.json'));
    assert.deepEqual(cfg.decay, DEFAULT_MEMORY_CONFIG.decay);
    assert.equal(cfg.duplicate_threshold, 0.85);
    assert.equal(cfg.qmd_search_mode, 'lex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMemoryConfig merges user values over defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-cfg-'));
  try {
    const cfgPath = join(dir, 'memory-config.json');
    writeFileSync(cfgPath, JSON.stringify({
      decay: { floor: 0.3, half_life_days: 60 },
      qmd_search_mode: 'hybrid',
    }));
    const cfg = loadMemoryConfig(cfgPath);
    assert.equal(cfg.decay.floor, 0.3);
    assert.equal(cfg.decay.half_life_days, 60);
    assert.equal(cfg.qmd_search_mode, 'hybrid');
    assert.equal(cfg.duplicate_threshold, 0.85, 'unspecified field keeps default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveIdentity falls back to os.userInfo when git config empty', async () => {
  const identity = await resolveIdentity({
    gitConfigEmail: async () => '',
    gitConfigName: async () => '',
    osUsername: () => 'fallback-user',
  });
  assert.equal(identity.email, 'fallback-user@local');
  assert.equal(identity.name, 'fallback-user');
  assert.equal(identity.source, 'os');
});

test('resolveIdentity uses git config when available', async () => {
  const identity = await resolveIdentity({
    gitConfigEmail: async () => 'jane@team.com',
    gitConfigName: async () => 'Jane Engineer',
    osUsername: () => 'fallback-user',
  });
  assert.equal(identity.email, 'jane@team.com');
  assert.equal(identity.name, 'Jane Engineer');
  assert.equal(identity.source, 'git');
});
```

- [ ] **Step 2: Run test — expect FAIL (module not found)**

Run: `cd mcp-server && node --import tsx --test tests/memory-config.test.mjs`
Expected: FAIL — Cannot find module './src/tools/memory-config.ts'.

- [ ] **Step 3: Implement memory-config.ts**

Create `mcp-server/src/tools/memory-config.ts`:

```typescript
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
  if (!existsSync(path)) return { ...DEFAULT_MEMORY_CONFIG };
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
    } catch { return ''; }
  },
  gitConfigName: async () => {
    try {
      const { stdout } = await execFileP('git', ['config', '--get', 'user.name']);
      return stdout.trim();
    } catch { return ''; }
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
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd mcp-server && node --import tsx --test tests/memory-config.test.mjs`
Expected: 4 tests pass.

- [ ] **Step 5: Typecheck**

Run: `cd mcp-server && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/tools/memory-config.ts mcp-server/tests/memory-config.test.mjs
git commit -m "feat(memory): memory-config.ts — defaults, identity, vault chain re-export"
```

---

### Task 0.3: memory-paths.ts — slug, filename, vault resolution

**Files:**
- Create: `mcp-server/src/tools/memory-paths.ts`
- Create: `mcp-server/tests/memory-paths.test.mjs`

- [ ] **Step 1: Write tests**

Create `mcp-server/tests/memory-paths.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, buildFilename, resolveVault, vaultPathFor, eventsPathFor,
} from '../src/tools/memory-paths.ts';

test('slugify lowercases, strips non-alphanumeric, caps at 60 chars', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Multiple   Spaces  '), 'multiple-spaces');
  assert.equal(slugify('UPPER123 mixed'), 'upper123-mixed');
  assert.equal(slugify('a'.repeat(100)).length, 60);
  assert.equal(slugify('---weird---chars!!!'), 'weird-chars');
});

test('buildFilename uses date prefix for memory/lesson, datetime for session', () => {
  const created = new Date('2026-06-07T10:38:15Z');
  assert.equal(buildFilename('memory', 'JWT validation', created), '2026-06-07-jwt-validation.md');
  assert.equal(buildFilename('lesson', 'Prefer events', created), '2026-06-07-prefer-events.md');
  assert.equal(buildFilename('session', 'Design memory', created), '2026-06-07T10-38-design-memory.md');
});

test('buildFilename wiki strips .md if present and slugifies last segment', () => {
  const created = new Date();
  assert.equal(buildFilename('wiki', 'architecture/data-flow', created), 'architecture/data-flow.md');
  assert.equal(buildFilename('wiki', 'architecture/Data Flow.md', created), 'architecture/data-flow.md');
});

test('resolveVault picks first matching kind when vault_id omitted', () => {
  const chain = [
    { id: 'my-notes', path: '/p/personal', kind: 'personal', remote: null },
    { id: 'team-eng', path: '/p/team', kind: 'team', remote: 'git@x:t.git' },
  ];
  assert.equal(resolveVault(chain, 'personal').id, 'my-notes');
  assert.equal(resolveVault(chain, 'team').id, 'team-eng');
});

test('resolveVault uses vault_id when provided', () => {
  const chain = [
    { id: 'a', path: '/a', kind: 'personal', remote: null },
    { id: 'b', path: '/b', kind: 'personal', remote: null },
  ];
  assert.equal(resolveVault(chain, 'personal', 'b').id, 'b');
});

test('resolveVault throws when no vault matches', () => {
  const chain = [{ id: 'a', path: '/a', kind: 'personal', remote: null }];
  assert.throws(() => resolveVault(chain, 'team'), /no vault registered with kind=team/i);
  assert.throws(() => resolveVault(chain, 'personal', 'nonexistent'), /vault_id "nonexistent" not found/i);
});

test('vaultPathFor builds the correct file path', () => {
  const vault = { id: 'x', path: '/v', kind: 'personal', remote: null };
  assert.equal(
    vaultPathFor(vault, 'clawdevbox', 'memory', '2026-06-07-jwt.md').replace(/\\/g, '/'),
    '/v/clawdevbox/memories/2026-06-07-jwt.md',
  );
});

test('eventsPathFor maps to sibling .events folder', () => {
  const vault = { id: 'x', path: '/v', kind: 'personal', remote: null };
  assert.equal(
    eventsPathFor(vault, 'clawdevbox', 'memory', '2026-06-07-jwt.md').replace(/\\/g, '/'),
    '/v/clawdevbox/memories/.events/2026-06-07-jwt.jsonl',
  );
});

test('eventsPathFor handles nested wiki paths', () => {
  const vault = { id: 'x', path: '/v', kind: 'personal', remote: null };
  assert.equal(
    eventsPathFor(vault, 'clawdevbox', 'wiki', 'architecture/data-flow.md').replace(/\\/g, '/'),
    '/v/clawdevbox/wiki/.events/architecture/data-flow.jsonl',
  );
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd mcp-server && node --import tsx --test tests/memory-paths.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement memory-paths.ts**

Create `mcp-server/src/tools/memory-paths.ts`:

```typescript
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

export function vaultPathFor(
  vault: VaultInfo,
  project: string,
  type: MemoryType,
  filename: string,
): string {
  if (project.includes('..') || project.includes('/') || project.includes('\\')) {
    throw new Error(`project slug "${project}" contains illegal characters (.. or path separator)`);
  }
  return join(vault.path, project, typeFolder(type), filename);
}

export function eventsPathFor(
  vault: VaultInfo,
  project: string,
  type: MemoryType,
  filename: string,
): string {
  if (project.includes('..') || project.includes('/') || project.includes('\\')) {
    throw new Error(`project slug "${project}" contains illegal characters`);
  }
  const stem = filename.replace(/\.md$/i, '');
  const dir = dirname(stem);
  const base = basename(stem);
  const eventsDir = dir === '.'
    ? join(vault.path, project, typeFolder(type), '.events')
    : join(vault.path, project, typeFolder(type), '.events', dir);
  return join(eventsDir, `${base}.jsonl`);
}

export function withCollisionSuffix(filename: string, attempt: number): string {
  if (attempt === 0) return filename;
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return `${stem}-${attempt + 1}${ext}`;
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd mcp-server && node --import tsx --test tests/memory-paths.test.mjs`
Expected: 9 tests pass.

- [ ] **Step 5: Typecheck**

Run: `cd mcp-server && npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/tools/memory-paths.ts mcp-server/tests/memory-paths.test.mjs
git commit -m "feat(memory): memory-paths.ts — slug, filename, vault resolution"
```

---

### Task 0.4: memory-vault-lock.ts — per-vault async mutex

**Files:**
- Create: `mcp-server/src/tools/memory-vault-lock.ts`
- Create: `mcp-server/tests/memory-vault-lock.test.mjs`

- [ ] **Step 1: Write tests**

Create `mcp-server/tests/memory-vault-lock.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { withVaultLock } from '../src/tools/memory-vault-lock.ts';

test('withVaultLock serializes calls on the same vault', async () => {
  const events = [];
  const tasks = [0, 1, 2].map((i) =>
    withVaultLock('v1', async () => {
      events.push(`start-${i}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end-${i}`);
      return i;
    })
  );
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2]);
  assert.deepEqual(events, ['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
});

test('withVaultLock allows concurrent calls on different vaults', async () => {
  const events = [];
  const tasks = [
    withVaultLock('v1', async () => {
      events.push('v1-start');
      await new Promise((r) => setTimeout(r, 30));
      events.push('v1-end');
    }),
    withVaultLock('v2', async () => {
      events.push('v2-start');
      await new Promise((r) => setTimeout(r, 10));
      events.push('v2-end');
    }),
  ];
  await Promise.all(tasks);
  assert.equal(events[0], 'v1-start');
  assert.equal(events[1], 'v2-start');
  // v2 finishes before v1
  assert.equal(events[2], 'v2-end');
  assert.equal(events[3], 'v1-end');
});

test('withVaultLock releases on error', async () => {
  await assert.rejects(
    withVaultLock('v3', async () => { throw new Error('boom'); }),
    /boom/,
  );
  // next call should not deadlock
  const result = await withVaultLock('v3', async () => 'ok');
  assert.equal(result, 'ok');
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-server && node --import tsx --test tests/memory-vault-lock.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `mcp-server/src/tools/memory-vault-lock.ts`:

```typescript
/**
 * tools/memory-vault-lock.ts
 *
 * Per-vault async mutex. JS is single-threaded but our git operations
 * spawn child processes; without this lock two concurrent write tools
 * could interleave `git add` / `git commit` and produce inconsistent
 * commits.
 */

const queues: Map<string, Promise<unknown>> = new Map();

export async function withVaultLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(vaultId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  queues.set(vaultId, prev.then(() => next));
  try {
    await prev;
  } catch {
    // upstream error — still proceed; their rejection was their own caller's problem
  }
  try {
    return await fn();
  } finally {
    release();
    // if no one queued behind us, clean up the map entry
    if (queues.get(vaultId) === next) queues.delete(vaultId);
  }
}

/** For test isolation: clear all queues. */
export function _resetVaultLocks(): void {
  queues.clear();
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd mcp-server && node --import tsx --test tests/memory-vault-lock.test.mjs`
Expected: 3 tests pass.

- [ ] **Step 5: Typecheck**

Run: `cd mcp-server && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/tools/memory-vault-lock.ts mcp-server/tests/memory-vault-lock.test.mjs
git commit -m "feat(memory): memory-vault-lock.ts — per-vault async mutex"
```

---

# Phase 1 — Write tools

### Task 1.1: memory-frontmatter.ts — YAML I/O per type

**Files:**
- Create: `mcp-server/src/tools/memory-frontmatter.ts`
- Create: `mcp-server/tests/memory-frontmatter.test.mjs`

- [ ] **Step 1: Write tests**

Create `mcp-server/tests/memory-frontmatter.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrontmatter, parseFrontmatter, splitFrontmatterAndBody } from '../src/tools/memory-frontmatter.ts';

test('buildFrontmatter emits required common fields', () => {
  const yaml = buildFrontmatter({
    id: 'abc-123',
    title: 'JWT pitfall',
    created: '2026-06-07T07:30:00Z',
    created_by: 'jane@team.com',
    scope: 'team',
    vault_id: 'engineering',
    project: 'clawdevbox',
    type: 'memory',
    tags: ['auth', 'jwt'],
  });
  assert.ok(yaml.startsWith('---\n'));
  assert.ok(yaml.endsWith('---\n'));
  assert.match(yaml, /id: abc-123/);
  assert.match(yaml, /scope: team/);
  assert.match(yaml, /tags:\n  - auth\n  - jwt/);
});

test('buildFrontmatter for memory adds category/citations/reason', () => {
  const yaml = buildFrontmatter({
    id: 'a', title: 't', created: '2026-06-07T00:00:00Z', created_by: 'x@y',
    scope: 'personal', vault_id: 'v', project: 'p', type: 'memory',
    tags: [],
    category: 'bug',
    citations: 'file.ts:42',
    reason: 'because reasons',
  });
  assert.match(yaml, /category: bug/);
  assert.match(yaml, /citations:/);
});

test('buildFrontmatter for lesson adds context/initial_confidence', () => {
  const yaml = buildFrontmatter({
    id: 'a', title: 't', created: '2026-06-07T00:00:00Z', created_by: 'x@y',
    scope: 'personal', vault_id: 'v', project: 'p', type: 'lesson',
    tags: [],
    context: 'during debugging',
    initial_confidence: 0.7,
  });
  assert.match(yaml, /context: during debugging/);
  assert.match(yaml, /initial_confidence: 0\.7/);
});

test('parseFrontmatter round-trips', () => {
  const yaml = buildFrontmatter({
    id: 'abc', title: 'Hello', created: '2026-06-07T07:30:00Z', created_by: 'x@y',
    scope: 'team', vault_id: 'eng', project: 'clawdevbox', type: 'memory',
    tags: ['a', 'b'],
  });
  const parsed = parseFrontmatter(yaml);
  assert.equal(parsed.id, 'abc');
  assert.equal(parsed.title, 'Hello');
  assert.equal(parsed.scope, 'team');
  assert.deepEqual(parsed.tags, ['a', 'b']);
});

test('splitFrontmatterAndBody separates correctly', () => {
  const full = '---\nid: x\ntitle: T\n---\n\n# Body\n\nContent here.\n';
  const { frontmatter, body } = splitFrontmatterAndBody(full);
  assert.equal(frontmatter.id, 'x');
  assert.equal(body, '# Body\n\nContent here.\n');
});

test('splitFrontmatterAndBody throws when no frontmatter', () => {
  assert.throws(
    () => splitFrontmatterAndBody('# Just a body\n'),
    /must start with --- frontmatter/i,
  );
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-server && node --import tsx --test tests/memory-frontmatter.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `mcp-server/src/tools/memory-frontmatter.ts`:

```typescript
/**
 * tools/memory-frontmatter.ts
 *
 * Build and parse YAML frontmatter for memory/lesson/session/wiki types.
 * Backed by js-yaml (already a project dep).
 */

import { dump, load } from 'js-yaml';
import type { MemoryType, Scope } from './memory-paths.ts';

export interface CommonFrontmatter {
  id: string;
  title: string;
  created: string;          // ISO 8601
  created_by: string;
  scope: Scope;
  vault_id: string;
  project: string;
  type: MemoryType;
  tags: string[];
  aliases?: string[];
  schema?: number;
}

export interface MemoryFrontmatter extends CommonFrontmatter {
  type: 'memory';
  category?: 'pattern' | 'preference' | 'architecture' | 'bug' | 'workflow' | 'fact';
  citations?: string;
  reason?: string;
}

export interface LessonFrontmatter extends CommonFrontmatter {
  type: 'lesson';
  context?: string;
  initial_confidence?: number;
}

export interface SessionFrontmatter extends CommonFrontmatter {
  type: 'session';
  session_id?: string;
  decisions?: string[];
  files?: string[];
}

export interface WikiFrontmatter extends CommonFrontmatter {
  type: 'wiki';
}

export type AnyFrontmatter =
  | MemoryFrontmatter
  | LessonFrontmatter
  | SessionFrontmatter
  | WikiFrontmatter;

export function buildFrontmatter(fm: AnyFrontmatter): string {
  const ordered: Record<string, unknown> = {
    id: fm.id,
    title: fm.title,
    created: fm.created,
    created_by: fm.created_by,
    scope: fm.scope,
    vault_id: fm.vault_id,
    project: fm.project,
    type: fm.type,
    tags: fm.tags ?? [],
  };
  if (fm.aliases !== undefined) ordered.aliases = fm.aliases;
  ordered.schema = fm.schema ?? 1;
  if (fm.type === 'memory') {
    if (fm.category) ordered.category = fm.category;
    if (fm.citations) ordered.citations = fm.citations;
    if (fm.reason) ordered.reason = fm.reason;
  } else if (fm.type === 'lesson') {
    if (fm.context) ordered.context = fm.context;
    if (typeof fm.initial_confidence === 'number') ordered.initial_confidence = fm.initial_confidence;
  } else if (fm.type === 'session') {
    if (fm.session_id) ordered.session_id = fm.session_id;
    if (fm.decisions && fm.decisions.length) ordered.decisions = fm.decisions;
    if (fm.files && fm.files.length) ordered.files = fm.files;
  }
  const yaml = dump(ordered, { lineWidth: 100, noRefs: true });
  return `---\n${yaml}---\n`;
}

export function parseFrontmatter(yaml: string): AnyFrontmatter {
  const trimmed = yaml.trim();
  if (!trimmed.startsWith('---')) {
    throw new Error('frontmatter must start with --- delimiter');
  }
  const inner = trimmed.replace(/^---\s*/, '').replace(/---\s*$/, '');
  const obj = load(inner) as AnyFrontmatter;
  if (!obj || typeof obj !== 'object') {
    throw new Error('frontmatter did not parse to an object');
  }
  return obj;
}

export function splitFrontmatterAndBody(full: string): { frontmatter: AnyFrontmatter; body: string } {
  if (!full.startsWith('---')) {
    throw new Error('file must start with --- frontmatter delimiter');
  }
  const end = full.indexOf('\n---', 3);
  if (end === -1) throw new Error('frontmatter not terminated by closing ---');
  const yaml = full.slice(0, end + 4);
  const body = full.slice(end + 4).replace(/^\r?\n/, '');
  return { frontmatter: parseFrontmatter(yaml), body };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd mcp-server && node --import tsx --test tests/memory-frontmatter.test.mjs`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/memory-frontmatter.ts mcp-server/tests/memory-frontmatter.test.mjs
git commit -m "feat(memory): memory-frontmatter.ts — YAML I/O per type"
```

---

### Task 1.2: memory-events.ts — append + initial fold

**Files:**
- Create: `mcp-server/src/tools/memory-events.ts`
- Create: `mcp-server/tests/memory-events.test.mjs`

- [ ] **Step 1: Write tests for `created` append + basic fold**

Create `mcp-server/tests/memory-events.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents, foldEvents, decayConfidence } from '../src/tools/memory-events.ts';

test('appendEvent creates the file if missing and writes one line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-ev-'));
  try {
    const path = join(dir, 'sub', 'x.jsonl');
    appendEvent(path, {
      ts: '2026-06-07T07:30:00Z', actor: 'jane@team.com', type: 'created',
    });
    assert.ok(existsSync(path));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.type, 'created');
    assert.equal(parsed.actor, 'jane@team.com');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendEvent appends to existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-ev-'));
  try {
    const path = join(dir, 'a.jsonl');
    appendEvent(path, { ts: '2026-06-07T07:30:00Z', actor: 'a@b', type: 'created' });
    appendEvent(path, { ts: '2026-06-07T07:31:00Z', actor: 'c@d', type: 'voted', direction: 'up' });
    const events = readEvents(path);
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'voted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEvents skips malformed lines but reports them in warnings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-ev-'));
  try {
    const path = join(dir, 'corrupt.jsonl');
    appendEvent(path, { ts: '2026-06-07T07:30:00Z', actor: 'a@b', type: 'created' });
    // manually append a bad line
    require('node:fs').appendFileSync(path, 'NOT JSON\n');
    appendEvent(path, { ts: '2026-06-07T07:31:00Z', actor: 'a@b', type: 'voted', direction: 'down' });
    const events = readEvents(path);
    assert.equal(events.length, 2, 'should skip the bad line, keep two valid ones');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foldEvents returns created info and empty votes for a fresh log', () => {
  const folded = foldEvents([
    { ts: '2026-06-07T07:30:00Z', actor: 'jane@team.com', type: 'created' },
  ]);
  assert.equal(folded.created.by, 'jane@team.com');
  assert.equal(folded.votes.up, 0);
  assert.equal(folded.votes.down, 0);
});

test('foldEvents counts per-actor latest vote only', () => {
  const folded = foldEvents([
    { ts: '2026-06-07T07:30:00Z', actor: 'a@x', type: 'created' },
    { ts: '2026-06-07T07:31:00Z', actor: 'jane@team.com', type: 'voted', direction: 'up' },
    { ts: '2026-06-07T07:32:00Z', actor: 'bob@team.com',  type: 'voted', direction: 'up' },
    { ts: '2026-06-07T07:33:00Z', actor: 'jane@team.com', type: 'voted', direction: 'down' },  // flipped
  ]);
  assert.equal(folded.votes.up, 1);    // bob
  assert.equal(folded.votes.down, 1);  // jane (flipped)
  assert.equal(folded.voters['jane@team.com'], 'down');
  assert.equal(folded.voters['bob@team.com'], 'up');
});

test('foldEvents computes lesson confidence with reinforcement', () => {
  const folded = foldEvents([
    { ts: '2026-06-07T00:00:00Z', actor: 'a@x', type: 'created', initial_confidence: 0.5 },
    { ts: '2026-06-07T01:00:00Z', actor: 'a@x', type: 'reinforced', source_content: 'dup', confidence_delta: 0.1 },
    { ts: '2026-06-07T02:00:00Z', actor: 'b@y', type: 'voted', direction: 'up' },
  ], { isLesson: true });
  assert.equal(folded.reinforcement_count, 1);
  assert.equal(folded.confidence_stored, 0.5 + 0.1 + 0.05); // 0.65
});

test('decayConfidence: no decay at t=0', () => {
  const now = decayConfidence({
    confidence_stored: 0.8,
    last_reinforced_at: new Date('2026-06-07T00:00:00Z').getTime(),
    now: new Date('2026-06-07T00:00:00Z').getTime(),
    floor: 0.2,
    half_life_days: 30,
  });
  assert.equal(now, 0.8);
});

test('decayConfidence halves toward floor after half_life_days', () => {
  const t0 = new Date('2026-06-07T00:00:00Z').getTime();
  const t30 = t0 + 30 * 86400_000;
  const now = decayConfidence({
    confidence_stored: 1.0,
    last_reinforced_at: t0,
    now: t30,
    floor: 0.2,
    half_life_days: 30,
  });
  // floor + (1.0 - 0.2) * 0.5 = 0.2 + 0.4 = 0.6
  assert.ok(Math.abs(now - 0.6) < 1e-9, `expected 0.6, got ${now}`);
});

test('decayConfidence asymptotes to floor as t -> infinity', () => {
  const t0 = new Date('2026-06-07T00:00:00Z').getTime();
  const tFar = t0 + 365 * 10 * 86400_000;
  const now = decayConfidence({
    confidence_stored: 1.0,
    last_reinforced_at: t0,
    now: tFar,
    floor: 0.2,
    half_life_days: 30,
  });
  assert.ok(Math.abs(now - 0.2) < 0.001);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-server && node --import tsx --test tests/memory-events.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `mcp-server/src/tools/memory-events.ts`:

```typescript
/**
 * tools/memory-events.ts
 *
 * Append events to .events sidecar JSONL files, read them back, fold
 * them into a structured FoldedState (votes, confidence, edit history),
 * and compute decay-adjusted confidence at read time.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BaseEvent {
  ts: string;          // ISO 8601
  actor: string;
  type: string;
}

export interface CreatedEvent extends BaseEvent {
  type: 'created';
  initial_confidence?: number;  // lesson only
}

export interface VotedEvent extends BaseEvent {
  type: 'voted';
  direction: 'up' | 'down';
  reason?: string;
}

export interface ReinforcedEvent extends BaseEvent {
  type: 'reinforced';
  source_content: string;
  confidence_delta?: number;
}

export interface EditedEvent extends BaseEvent {
  type: 'edited';
  operation: string;
  section?: string;
  lines_changed: number;
}

export type AnyEvent = CreatedEvent | VotedEvent | ReinforcedEvent | EditedEvent | (BaseEvent & Record<string, unknown>);

export function appendEvent(eventsPath: string, event: AnyEvent): void {
  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');
}

export function readEvents(eventsPath: string): AnyEvent[] {
  if (!existsSync(eventsPath)) return [];
  const raw = readFileSync(eventsPath, 'utf8');
  const out: AnyEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AnyEvent);
    } catch {
      // skip malformed line; do not fail the read
    }
  }
  return out;
}

export interface FoldedState {
  created: { at: string; by: string };
  votes: { up: number; down: number };
  voters: Record<string, 'up' | 'down'>;
  // lesson-only
  confidence_stored?: number;
  last_reinforced?: string;
  reinforcement_count?: number;
  // wiki-only
  edit_count?: number;
  last_edited?: { at: string; by: string };
}

export interface FoldOptions {
  isLesson?: boolean;
  isWiki?: boolean;
}

export function foldEvents(events: AnyEvent[], opts: FoldOptions = {}): FoldedState {
  let created: { at: string; by: string } | null = null;
  const voters: Record<string, 'up' | 'down'> = {};
  let confidenceStored = 0;
  let initialConfidence = 0.5;
  let reinforcementCount = 0;
  let lastReinforced: string | undefined;
  let editCount = 0;
  let lastEdited: { at: string; by: string } | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case 'created':
        created = { at: ev.ts, by: ev.actor };
        if (opts.isLesson && typeof (ev as CreatedEvent).initial_confidence === 'number') {
          initialConfidence = (ev as CreatedEvent).initial_confidence!;
        }
        lastReinforced = ev.ts;
        break;
      case 'voted':
        voters[ev.actor] = (ev as VotedEvent).direction;
        break;
      case 'reinforced':
        reinforcementCount++;
        lastReinforced = ev.ts;
        confidenceStored += (ev as ReinforcedEvent).confidence_delta ?? 0.1;
        break;
      case 'edited':
        editCount++;
        lastEdited = { at: ev.ts, by: ev.actor };
        break;
    }
  }

  let votesUp = 0, votesDown = 0;
  for (const dir of Object.values(voters)) {
    if (dir === 'up') votesUp++; else votesDown++;
  }

  const result: FoldedState = {
    created: created ?? { at: '', by: '' },
    votes: { up: votesUp, down: votesDown },
    voters,
  };
  if (opts.isLesson) {
    const fromVotes = 0.05 * (votesUp - votesDown);
    const stored = clamp01(initialConfidence + confidenceStored + fromVotes);
    result.confidence_stored = stored;
    result.last_reinforced = lastReinforced;
    result.reinforcement_count = reinforcementCount;
  }
  if (opts.isWiki) {
    result.edit_count = editCount;
    if (lastEdited) result.last_edited = lastEdited;
  }
  return result;
}

export interface DecayInput {
  confidence_stored: number;
  last_reinforced_at: number;  // ms epoch
  now: number;                 // ms epoch
  floor: number;
  half_life_days: number;
}

export function decayConfidence({
  confidence_stored, last_reinforced_at, now, floor, half_life_days,
}: DecayInput): number {
  const days = Math.max(0, (now - last_reinforced_at) / 86400_000);
  const decayed = floor + (confidence_stored - floor) * Math.pow(0.5, days / half_life_days);
  return clamp01(decayed);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd mcp-server && node --import tsx --test tests/memory-events.test.mjs`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/memory-events.ts mcp-server/tests/memory-events.test.mjs
git commit -m "feat(memory): memory-events.ts — append/fold/decay"
```

---

### Task 1.3: memory-git.ts — inline commit helper

**Files:**
- Create: `mcp-server/src/tools/memory-git.ts`
- Create: `mcp-server/tests/memory-git.test.mjs`

- [ ] **Step 1: Write tests against a real temp git repo**

Create `mcp-server/tests/memory-git.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitInline, getCurrentSha, hasUnstagedChanges } from '../src/tools/memory-git.ts';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  return dir;
}

test('commitInline stages and commits the given paths', () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'a.md'), 'hello');
    commitInline(dir, ['sub/a.md'], 'memory: hello');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
    assert.match(log, /memory: hello/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitInline pre-commits external changes before its own commit', () => {
  const dir = initRepo();
  try {
    // user manually edited an existing file
    writeFileSync(join(dir, 'README.md'), '# Edited externally\n');
    writeFileSync(join(dir, 'new.md'), 'tool wrote this');
    commitInline(dir, ['new.md'], 'memory: new');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
    const lines = log.trim().split('\n');
    // We expect: tool commit, external-edits commit, initial
    assert.equal(lines.length, 3, log);
    assert.match(lines[0], /memory: new/);
    assert.match(lines[1], /external edits detected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hasUnstagedChanges reports correctly', () => {
  const dir = initRepo();
  try {
    assert.equal(hasUnstagedChanges(dir), false);
    writeFileSync(join(dir, 'README.md'), '# changed');
    assert.equal(hasUnstagedChanges(dir), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getCurrentSha returns 40-char sha', () => {
  const dir = initRepo();
  try {
    const sha = getCurrentSha(dir);
    assert.match(sha, /^[a-f0-9]{40}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-server && node --import tsx --test tests/memory-git.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `mcp-server/src/tools/memory-git.ts`:

```typescript
/**
 * tools/memory-git.ts
 *
 * Inline `git add + commit` helper. Detects external (manual) changes
 * to the working tree before our own commit and snapshots them in a
 * preceding "memory: external edits detected" commit so they survive.
 */

import { execFileSync } from 'node:child_process';

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

export function hasUnstagedChanges(repoPath: string): boolean {
  const out = run(repoPath, ['status', '--porcelain']);
  return out.trim().length > 0;
}

export function getCurrentSha(repoPath: string): string {
  return run(repoPath, ['rev-parse', 'HEAD']).trim();
}

export function commitInline(repoPath: string, paths: string[], message: string): string {
  // If there are pre-existing changes that aren't ours, snapshot them first.
  if (hasOtherChanges(repoPath, paths)) {
    run(repoPath, ['add', '-A']);
    try {
      run(repoPath, ['commit', '-q', '-m', 'memory: external edits detected']);
    } catch {
      // nothing to commit (paths overlap entirely) — fine
    }
  }
  run(repoPath, ['add', '--', ...paths]);
  run(repoPath, ['commit', '-q', '-m', message]);
  return getCurrentSha(repoPath);
}

function hasOtherChanges(repoPath: string, ourPaths: string[]): boolean {
  const out = run(repoPath, ['status', '--porcelain']);
  if (!out.trim()) return false;
  const oursSet = new Set(ourPaths.map((p) => p.replace(/\\/g, '/')));
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // format: " M path", "?? path", " A path", etc.
    const path = trimmed.slice(3).replace(/\\/g, '/');
    if (!oursSet.has(path)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd mcp-server && node --import tsx --test tests/memory-git.test.mjs`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/memory-git.ts mcp-server/tests/memory-git.test.mjs
git commit -m "feat(memory): memory-git.ts — inline commit with external-edit snapshot"
```

---

### Task 1.4: memory.ts — register 4 add_* tools + tests

**Files:**
- Create: `mcp-server/src/tools/memory.ts`
- Create: `mcp-server/tests/memory-tools-e2e.test.mjs`
- Modify: `mcp-server/src/server.ts` (register entries)

- [ ] **Step 1: Write E2E test for `add_memory` against a real vault**

Create `mcp-server/tests/memory-tools-e2e.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleAddMemory, handleAddLesson, handleAddSessionSummary, handleAddWikiPage, handleGetMemory } from '../src/tools/memory.ts';

function makeVaultChain() {
  const personalDir = mkdtempSync(join(tmpdir(), 'vault-p-'));
  const teamDir     = mkdtempSync(join(tmpdir(), 'vault-t-'));
  for (const dir of [personalDir, teamDir]) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'tester@local'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# vault\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  }
  return {
    chain: [
      { id: 'my-notes', path: personalDir, kind: 'personal', remote: null },
      { id: 'team-eng', path: teamDir,     kind: 'team',     remote: null },
    ],
    cleanup: () => {
      rmSync(personalDir, { recursive: true, force: true });
      rmSync(teamDir, { recursive: true, force: true });
    },
  };
}

test('handleAddMemory writes file, sidecar event, commits, and is reproducible', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = {
      chain,
      identity: { email: 'jane@team.com', name: 'Jane', source: 'git' },
      now: () => new Date('2026-06-07T07:30:00Z'),
    };
    const result = await handleAddMemory(ctx, {
      content: 'Always validate JWT exp before iat',
      scope: 'team',
      project: 'clawdevbox',
      citations: 'src/auth/jwt.ts:42',
      reason: 'We hit this in production twice; future auth work must validate exp first.',
    });
    const teamRoot = chain[1].path;
    const expectedFile = join(teamRoot, 'clawdevbox', 'memories', `${result.slug}.md`);
    assert.ok(existsSync(expectedFile), `expected ${expectedFile} to exist`);
    const md = readFileSync(expectedFile, 'utf8');
    assert.match(md, /scope: team/);
    assert.match(md, /vault_id: team-eng/);
    assert.match(md, /project: clawdevbox/);
    assert.match(md, /Always validate JWT exp before iat/);

    const eventsFile = join(teamRoot, 'clawdevbox', 'memories', '.events', `${result.slug.replace(/\.md$/,'')}.jsonl`);
    assert.ok(existsSync(eventsFile));
    const ev = JSON.parse(readFileSync(eventsFile, 'utf8').trim());
    assert.equal(ev.type, 'created');
    assert.equal(ev.actor, 'jane@team.com');

    const log = execFileSync('git', ['log', '--oneline'], { cwd: teamRoot, encoding: 'utf8' });
    assert.match(log, /memory:/);

    // Now round-trip via handleGetMemory
    const got = await handleGetMemory(ctx, { path: `clawdevbox/memories/${result.slug}`, scope: 'team' });
    assert.equal(got.frontmatter.title.length > 0, true);
    assert.equal(got.type, 'memory');
  } finally { cleanup(); }
});

test('handleAddLesson writes to lessons/ folder', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = {
      chain,
      identity: { email: 'a@b', name: 'A', source: 'git' },
      now: () => new Date('2026-06-07T08:00:00Z'),
    };
    const result = await handleAddLesson(ctx, {
      content: 'Prefer events.jsonl over in-frontmatter mutable state',
      scope: 'personal',
      project: '_general',
      confidence: 0.7,
    });
    const path = join(chain[0].path, '_general', 'lessons', `${result.slug}.md`);
    assert.ok(existsSync(path));
    const md = readFileSync(path, 'utf8');
    assert.match(md, /type: lesson/);
    assert.match(md, /initial_confidence: 0\.7/);
  } finally { cleanup(); }
});

test('handleAddSessionSummary writes to sessions/ with structured decisions', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = {
      chain,
      identity: { email: 'a@b', name: 'A', source: 'git' },
      now: () => new Date('2026-06-07T09:38:15Z'),
    };
    const result = await handleAddSessionSummary(ctx, {
      title: 'Design memory tools',
      narrative: 'Picked event-sourced sidecars and the qmd SDK in-process.',
      scope: 'personal',
      project: 'clawdevbox',
      decisions: ['sidecar over frontmatter', 'qmd SDK over MCP'],
      files: ['mcp-server/src/tools/memory.ts'],
    });
    assert.match(result.slug, /^2026-06-07T09-38-design-memory-tools/);
    const md = readFileSync(join(chain[0].path, 'clawdevbox', 'sessions', result.slug + (result.slug.endsWith('.md')?'':'.md')), 'utf8');
    assert.match(md, /sidecar over frontmatter/);
  } finally { cleanup(); }
});

test('handleAddWikiPage with nested path', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = {
      chain,
      identity: { email: 'a@b', name: 'A', source: 'git' },
      now: () => new Date(),
    };
    const result = await handleAddWikiPage(ctx, {
      path: 'architecture/data-flow',
      content: '# Data flow\n\nSee [[architecture/overview]].\n',
      scope: 'team',
      project: 'clawdevbox',
    });
    const file = join(chain[1].path, 'clawdevbox', 'wiki', 'architecture', 'data-flow.md');
    assert.ok(existsSync(file));
  } finally { cleanup(); }
});

test('handleAddWikiPage rejects if path already exists', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = {
      chain,
      identity: { email: 'a@b', name: 'A', source: 'git' },
      now: () => new Date(),
    };
    const args = { path: 'overview', content: '# hi', scope: 'personal', project: 'p' };
    await handleAddWikiPage(ctx, args);
    await assert.rejects(() => handleAddWikiPage(ctx, args), /already exists/i);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd mcp-server && node --import tsx --test tests/memory-tools-e2e.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement memory.ts with 4 add_* tools + get_memory**

Create `mcp-server/src/tools/memory.ts`:

The file should:
- Export `handleAddMemory(ctx, args)`, `handleAddLesson`, `handleAddSessionSummary`, `handleAddWikiPage`, `handleGetMemory` as testable functions (separate from MCP registration).
- Export `registerMemoryEntries(ws)` that calls `defineTool({...})` for each, passing through ctx built from real workspace.
- `ToolCtx` shape: `{ chain: VaultInfo[], identity: Identity, now: () => Date }`.
- Each handler: validates args via Zod, resolves vault via `resolveVault`, builds filename via `buildFilename`, creates dirs, writes .md (frontmatter + body), appends `created` event, commits via `commitInline`, returns `{ slug, path, action: 'created' }`.
- `handleGetMemory`: reads .md, splits frontmatter/body, reads events, returns `{ path, type, frontmatter, body, events_summary }`.

Implementation skeleton — fill in details:

```typescript
/**
 * tools/memory.ts
 *
 * 9 MCP tools for the memory subsystem: add_memory, add_lesson,
 * add_session_summary, add_wiki_page, get_memory, get_wiki_index,
 * search_memory, memory_init, memory_status.
 *
 * Phase 0-2 tools (writes + reads) are implemented here; Phase 3
 * tools (qmd-backed search, init, status) are added in Task 3.x.
 */

import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import type { Workspace } from '../workspace.ts';
import {
  loadVaultChain, type VaultInfo,
  loadMemoryConfig, resolveIdentity, type Identity,
} from './memory-config.ts';
import {
  slugify, buildFilename, resolveVault, vaultPathFor, eventsPathFor,
  withCollisionSuffix, typeFolder, type MemoryType, type Scope,
} from './memory-paths.ts';
import { withVaultLock } from './memory-vault-lock.ts';
import {
  buildFrontmatter, splitFrontmatterAndBody, type AnyFrontmatter,
} from './memory-frontmatter.ts';
import { appendEvent, readEvents, foldEvents } from './memory-events.ts';
import { commitInline } from './memory-git.ts';

export interface ToolCtx {
  chain: VaultInfo[];
  identity: Identity;
  now: () => Date;
}

// ... Zod schemas for each tool ...
// ... handlers ...
// ... registerMemoryEntries(ws) ...
```

Write full implementations following these contracts (full source in commit).

- [ ] **Step 4: Wire registration into server.ts**

Modify `mcp-server/src/server.ts`:
- Add `import { registerMemoryEntries } from './tools/memory.ts';`
- After the existing register calls, add `registerMemoryEntries(ws);`

- [ ] **Step 5: Add new test files to npm test script**

Modify `mcp-server/package.json` `scripts.test`: append `tests/memory-config.test.mjs tests/memory-paths.test.mjs tests/memory-vault-lock.test.mjs tests/memory-frontmatter.test.mjs tests/memory-events.test.mjs tests/memory-git.test.mjs tests/memory-tools-e2e.test.mjs`.

- [ ] **Step 6: Run all memory tests**

Run: `cd mcp-server && node --import tsx --test tests/memory-*.test.mjs`
Expected: all tests pass.

- [ ] **Step 7: Typecheck**

Run: `cd mcp-server && npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add mcp-server/src/tools/memory.ts mcp-server/tests/memory-tools-e2e.test.mjs mcp-server/src/server.ts mcp-server/package.json
git commit -m "feat(memory): 4 add_* tools + get_memory with real E2E test against git repos"
```

---

# Phase 2 — Read tools

### Task 2.1: memory_status tool (config-only sections)

**Files:**
- Modify: `mcp-server/src/tools/memory.ts` (add handler + registration)
- Modify: `mcp-server/tests/memory-tools-e2e.test.mjs` (add test)

- [ ] **Step 1: Add E2E test**

Append to `memory-tools-e2e.test.mjs`:

```javascript
import { handleMemoryStatus } from '../src/tools/memory.ts';

test('handleMemoryStatus returns vault list, qmd placeholder, config snapshot', async () => {
  const { chain, cleanup } = makeVaultChain();
  try {
    const ctx = { chain, identity: { email: 'a@b', name: 'A', source: 'git' }, now: () => new Date() };
    const status = await handleMemoryStatus(ctx, {});
    assert.equal(status.config.vaults.length, 2);
    assert.equal(status.config.vaults[0].kind, 'personal');
    assert.ok(status.config.decay);
    assert.equal(typeof status.config.qmd_search_mode, 'string');
    assert.deepEqual(status.warnings, []);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Implement `handleMemoryStatus` in memory.ts**

Add a handler that returns:
```typescript
{
  git: {},  // Phase 6 — empty for now
  qmd: { models_loaded: false, db_size_bytes: 0 },  // Phase 3 fills this
  config: {
    vaults: chain.map(...),
    decay, duplicate_threshold, qmd_search_mode, auto_resolve_conflicts,
  },
  warnings: [],
}
```

Register as `memory_status` via `defineTool`.

- [ ] **Step 3: Run, typecheck, commit**

```bash
cd mcp-server && node --import tsx --test tests/memory-tools-e2e.test.mjs && npm run typecheck
git add mcp-server/src/tools/memory.ts mcp-server/tests/memory-tools-e2e.test.mjs
git commit -m "feat(memory): memory_status tool (config sections only — Phase 6 fills git/qmd)"
```

---

# Phase 3 — qmd integration

### Task 3.1: memory-qmd.ts — lazy createStore wrapper

**Files:**
- Create: `mcp-server/src/tools/memory-qmd.ts`
- Create: `mcp-server/tests/memory-qmd.test.mjs`

- [ ] **Step 1: Write tests using lex-only mode against a temp vault**

Test must:
- Create a temp vault dir with a couple of .md files.
- Call `getStore({ dbPath: ':memory-test:' })` (or temp sqlite path).
- Register the collection.
- Call `store.update()` (file scan only — no embeddings).
- Call `searchLex('jwt')` — expect the matching file to come back.
- Assert this does NOT load GGUF models (verify by checking no `~/.cache/qmd/models` activity, or by timing the call < 2s).

- [ ] **Step 2: Implement memory-qmd.ts**

Provide:
- `getStore(cfg)` — lazy singleton; first call creates the store. Always returns same instance.
- `registerVaultCollections(store, chain)` — loops over chain, calls `store.addCollection(vault.id, ...)`.
- `registerProjectContexts(store, chain)` — discovers projects in each vault, sets context strings per `<project>/<type>` subtree.
- `indexAndEmbedDebounced(store, vaultId)` — debounces `store.update({ collections: [vaultId] })`. Embedding only triggered if `qmd_search_mode !== 'lex'`.
- `searchAcrossCollections(store, query, opts)` — wraps `store.searchLex` (or `store.search` for hybrid) with collection list, returns scored results.

- [ ] **Step 3: Run, typecheck, commit**

```bash
git add mcp-server/src/tools/memory-qmd.ts mcp-server/tests/memory-qmd.test.mjs
git commit -m "feat(memory): memory-qmd.ts — lazy qmd SDK wrapper with lex-only default"
```

---

### Task 3.2: memory_init tool

**Files:**
- Modify: `mcp-server/src/tools/memory.ts`

- [ ] **Step 1: E2E test**

Add to e2e test file: call `handleMemoryInit(ctx)`. Assert:
- Folder skeleton created in each vault (`_general/<type>/`).
- README.md generated.
- qmd collections registered (verify via `store.listCollections()` returning entries for each vault.id).
- Subsequent calls are idempotent (no error).

- [ ] **Step 2: Implement `handleMemoryInit`**

- [ ] **Step 3: Run, commit**

```bash
git commit -m "feat(memory): memory_init tool — scaffolds folders, registers qmd collections"
```

---

### Task 3.3: search_memory tool with confidence-weighted ranking

**Files:**
- Modify: `mcp-server/src/tools/memory.ts`

- [ ] **Step 1: E2E test**

Setup: add a few memories across personal & team, with different vote counts. Search for a keyword. Assert:
- Scope filter works (`personal` only returns personal vault hits).
- Type filter works.
- Project filter works.
- For lessons, confidence affects ranking.

- [ ] **Step 2: Implement `handleSearchMemory`**

- [ ] **Step 3: Run, commit**

```bash
git commit -m "feat(memory): search_memory tool with confidence-weighted ranking (lex mode default)"
```

---

### Task 3.4: get_wiki_index tool

**Files:**
- Modify: `mcp-server/src/tools/memory.ts`

- [ ] **Step 1: E2E test**

Setup: create wiki tree with nested folders. Call `handleGetWikiIndex` with depth=1, depth=2, root='architecture/'. Assert tree structure.

- [ ] **Step 2: Implement `handleGetWikiIndex`**

Walk the directory, read frontmatter for summaries/tags, extract `[[wikilinks]]` and `[md links](x.md)` when `include.links === true`.

- [ ] **Step 3: Run, commit**

```bash
git commit -m "feat(memory): get_wiki_index tool — navigable tree with depth + links"
```

---

# Final integration

### Task F.1: Run full test suite

- [ ] **Step 1: Add ALL memory test files to npm test script**
- [ ] **Step 2: Run `npm test`**
- [ ] **Step 3: Run `npm run typecheck`**
- [ ] **Step 4: Commit any fixes**

### Task F.2: Smoke test — register and call via real MCP server

- [ ] **Step 1: Start MCP server with `npm run mcp` against a stub vault chain**
- [ ] **Step 2: Call `add_memory` via MCP client (or via a smoke-test script that imports the server)**
- [ ] **Step 3: Call `search_memory` and verify it returns the added memory**
- [ ] **Step 4: Commit**

```bash
git commit -m "test(memory): smoke test against live MCP server"
```

---

# Self-Review Checklist

After implementation, walk through:
- [ ] All 9 tools registered in `memory.ts` and wired into `server.ts`
- [ ] No `TBD`/`TODO`/placeholders in source
- [ ] Types consistent across modules (`Scope`, `MemoryType`, `Identity`, `VaultInfo`)
- [ ] All test files added to `scripts.test`
- [ ] `npm test` passes end-to-end
- [ ] `npm run typecheck` passes
- [ ] CPU-fallback (lex mode) is the default; hybrid requires user opt-in via config
- [ ] All commits follow conventional-commit style with Copilot co-author trailer

---

# Notes for the executor

- **No GPU on this machine.** Default `qmd_search_mode: 'lex'`. Tests must NOT trigger GGUF model loading.
- **Real test data, real clients.** Tests instantiate real git repos in tmp dirs, real `loadVaultChain`-shaped stubs, real qmd `store.searchLex`.
- **Commit cadence:** one commit per task minimum. Tasks already shipped don't get re-shaped — append new tasks for new requirements.
- **If qmd native bindings fail to install:** capture the error, document it in the commit message of Task 0.1, but still proceed — `searchLex` requires only the FTS5 SQLite index, not the GGUF binaries.
- **Phases 4-8 (voting, sync, wiki update, conflict resolve)** are explicitly out of scope; follow-on plans will cover them.
