/**
 * tools/memory-qmd.ts
 *
 * Thin wrapper around the @tobilu/qmd SDK. Owns:
 *   - A lazy singleton `QMDStore` keyed by db path.
 *   - Collection / context registration from the vault chain.
 *   - Search helpers that default to BM25-only `searchLex` (no GGUF
 *     models needed) and only fall back to hybrid `search()` when
 *     config opts in.
 *   - Debounced `update + embed` so writes can return fast and let
 *     indexing catch up in the background.
 */

import { createStore, type QMDStore } from '@tobilu/qmd';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import type { VaultInfo } from '../vault-chain.ts';
import type { MemoryConfig } from './memory-config.ts';
import type { MemoryType } from './memory-paths.ts';

let cachedStore: { store: QMDStore; dbPath: string } | null = null;

/** Resolve `~/...` to the home dir; passthrough absolute paths. */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return p;
}

/**
 * Lazy singleton store. The first call creates it; subsequent calls
 * return the same instance. Tests may pass `force: true` to rebuild
 * against a fresh dbPath.
 */
export async function getStore(
  config: MemoryConfig,
  opts: { force?: boolean } = {},
): Promise<QMDStore> {
  const dbPath = expandHome(config.qmd_db_path);
  if (!opts.force && cachedStore && cachedStore.dbPath === dbPath) {
    return cachedStore.store;
  }
  if (cachedStore && opts.force) {
    try { await cachedStore.store.close(); } catch { /* ignore */ }
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = await createStore({ dbPath });
  cachedStore = { store, dbPath };
  return store;
}

/** Test helper: drop the cached store (does not close it). */
export function _resetStoreCache(): void {
  cachedStore = null;
}

/** Close and drop the cached store. */
export async function closeStore(): Promise<void> {
  if (cachedStore) {
    try { await cachedStore.store.close(); } catch { /* ignore */ }
    cachedStore = null;
  }
}

const STANDARD_IGNORE = [
  '**/.events/**',
  '**/.git/**',
  'README.md',
  'vault.yaml',
];

/**
 * Register one qmd collection per vault, using `vault.id` as the
 * collection name. Idempotent: if a collection with the same name
 * already exists, it's left alone.
 */
export async function registerVaultCollections(
  store: QMDStore,
  chain: VaultInfo[],
): Promise<void> {
  const existing = new Set((await store.listCollections()).map((c) => c.name));
  for (const vault of chain) {
    if (existing.has(vault.id)) continue;
    await store.addCollection(vault.id, {
      path: vault.path,
      pattern: '**/*.md',
      ignore: STANDARD_IGNORE,
    });
  }
}

const TYPE_FOLDERS: Record<MemoryType, string> = {
  memory: 'memories',
  lesson: 'lessons',
  session: 'sessions',
  wiki: 'wiki',
};

/**
 * Set qmd path contexts for every `<project>/<type>/` subtree that
 * exists on disk. Contexts surface alongside search results and help
 * the LLM pick the right hit. Per qmd README: "Don't sleep on it."
 */
export async function registerProjectContexts(
  store: QMDStore,
  chain: VaultInfo[],
): Promise<void> {
  for (const vault of chain) {
    if (!existsSync(vault.path)) continue;
    const projects = readdirSync(vault.path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
    for (const project of projects) {
      for (const [type, folder] of Object.entries(TYPE_FOLDERS) as Array<[MemoryType, string]>) {
        const subtree = join(vault.path, project, folder);
        if (!existsSync(subtree) || !statSync(subtree).isDirectory()) continue;
        const ctxPath = `/${project}/${folder}`;
        const description = contextDescription(vault.kind, project, type);
        try {
          await store.addContext(vault.id, ctxPath, description);
        } catch {
          // addContext may upsert or error on duplicate depending on qmd version;
          // either way it's not fatal.
        }
      }
    }
  }
}

function contextDescription(kind: 'personal' | 'team', project: string, type: MemoryType): string {
  switch (type) {
    case 'memory':
      return `${kind} memories about ${project} — high-confidence facts; vote-weighted`;
    case 'lesson':
      return `${kind} lessons learned about ${project}; confidence decays over time`;
    case 'wiki':
      return `${kind} curated documentation for ${project}`;
    case 'session':
      return `${kind} session retrospectives from agent work on ${project}`;
  }
}

// ---------------------------------------------------------------------------
// Indexing — debounced update + (optionally) embed
// ---------------------------------------------------------------------------

interface IndexDebouncer {
  pending: Map<string, NodeJS.Timeout>;
}

const indexDebouncer: IndexDebouncer = { pending: new Map() };

/**
 * Schedule an indexing pass for a given collection. Coalesces multiple
 * writes within the debounce window into a single `store.update()` call.
 * Embedding is skipped unless `mode !== 'lex'`.
 */
export function scheduleReindex(
  store: QMDStore,
  collectionName: string,
  config: MemoryConfig,
): void {
  const prior = indexDebouncer.pending.get(collectionName);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(async () => {
    indexDebouncer.pending.delete(collectionName);
    try {
      await store.update({ collections: [collectionName] });
      if (config.qmd_search_mode !== 'lex') {
        await store.embed({});
      }
    } catch {
      // index failures are surfaced via memory_status; never crash the daemon
    }
  }, config.sync.index_debounce_ms);
  // Don't keep the event loop alive solely for the debounce timer.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  indexDebouncer.pending.set(collectionName, timer);
}

/** Flush any pending index updates synchronously (for tests). */
export async function flushReindex(store: QMDStore, config: MemoryConfig): Promise<void> {
  const pendings = Array.from(indexDebouncer.pending.entries());
  for (const [name, timer] of pendings) {
    clearTimeout(timer);
    indexDebouncer.pending.delete(name);
    await store.update({ collections: [name] });
    if (config.qmd_search_mode !== 'lex') {
      await store.embed({});
    }
  }
}

// ---------------------------------------------------------------------------
// Search across collections
// ---------------------------------------------------------------------------

export interface QmdSearchHit {
  collectionName: string;
  displayPath: string;          // collection-relative
  title: string;
  docid: string;
  score: number;
  body: string;
  bodyLength: number;
  context: string | null;
}

export interface SearchAcrossOptions {
  collections: string[];
  query: string;
  limit?: number;
  minScore?: number;
  mode: 'lex' | 'hybrid' | 'vec';
}

/**
 * Search one or more qmd collections. `lex` mode uses BM25 only
 * (no GGUF models). `hybrid` and `vec` require the user to have set
 * `qmd_search_mode` in config and to have a machine where the GGUF
 * models can load — fall through to `searchLex` on error.
 */
export async function searchAcrossCollections(
  store: QMDStore,
  opts: SearchAcrossOptions,
): Promise<QmdSearchHit[]> {
  const { collections, query, limit = 30, minScore = 0 } = opts;
  if (!query.trim()) return [];
  if (collections.length === 0) return [];

  if (opts.mode === 'lex') {
    return await runLex(store, collections, query, limit, minScore);
  }
  try {
    const out: QmdSearchHit[] = [];
    for (const collection of collections) {
      const results = await store.search({
        query, collection, limit, minScore,
      });
      for (const r of results) out.push(adaptHybrid(r, collection));
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  } catch {
    return await runLex(store, collections, query, limit, minScore);
  }
}

async function runLex(
  store: QMDStore,
  collections: string[],
  query: string,
  limit: number,
  minScore: number,
): Promise<QmdSearchHit[]> {
  const out: QmdSearchHit[] = [];
  for (const collection of collections) {
    const results = await store.searchLex(query, { collection, limit });
    for (const r of results) {
      const hit = adaptLex(r, collection);
      if (hit.score >= minScore) out.push(hit);
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function adaptLex(r: any, collection: string): QmdSearchHit {
  return {
    collectionName: collection,
    displayPath: r.displayPath ?? r.path ?? '',
    title: r.title ?? '',
    docid: r.docid ?? '',
    score: typeof r.score === 'number' ? r.score : 0,
    body: r.body ?? '',
    bodyLength: r.bodyLength ?? (r.body?.length ?? 0),
    context: r.context ?? null,
  };
}

function adaptHybrid(r: any, collection: string): QmdSearchHit {
  return {
    collectionName: collection,
    displayPath: r.displayPath ?? r.path ?? '',
    title: r.title ?? '',
    docid: r.docid ?? '',
    score: typeof r.score === 'number' ? r.score : 0,
    body: r.body ?? r.snippet ?? '',
    bodyLength: r.bodyLength ?? 0,
    context: r.context ?? null,
  };
}

// ---------------------------------------------------------------------------
// Path parsing — extract scope/project/type from a collection-relative path
// ---------------------------------------------------------------------------

const FOLDER_TO_TYPE: Record<string, MemoryType> = {
  memories: 'memory',
  lessons: 'lesson',
  sessions: 'session',
  wiki: 'wiki',
};

export interface DecomposedPath {
  project: string;
  type: MemoryType;
  rest: string;        // path under the type folder (e.g. "architecture/data-flow.md")
}

export function decomposeDisplayPath(displayPath: string): DecomposedPath | null {
  const parts = displayPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const project = parts[0];
  const folder = parts[1];
  const type = FOLDER_TO_TYPE[folder];
  if (!type) return null;
  return { project, type, rest: parts.slice(2).join('/') };
}
