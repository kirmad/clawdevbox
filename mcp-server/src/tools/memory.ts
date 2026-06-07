/**
 * tools/memory.ts
 *
 * MCP tools for the memory subsystem:
 *
 *   Writes (Phase 1):
 *     - add_memory, add_lesson (no dedup), add_session_summary, add_wiki_page
 *   Reads  (Phase 2):
 *     - get_memory, memory_status
 *   qmd-backed (Phase 3 — added in memory-qmd-tools.ts):
 *     - memory_init, search_memory, get_wiki_index
 *
 * Each handler is exported as a pure function (testable in isolation)
 * with its own `ToolCtx` argument so tests can stub the vault chain,
 * identity, and `now` without needing a real Workspace.
 */

import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import type { Workspace } from '../workspace.ts';
import { resolveConfig } from '../config.ts';
import {
  loadVaultChain, type VaultInfo,
  loadMemoryConfig, resolveIdentity, type Identity, type MemoryConfig,
  DEFAULT_MEMORY_CONFIG,
} from './memory-config.ts';
import {
  buildFilename, resolveVault, vaultPathFor, eventsPathFor,
  withCollisionSuffix, type MemoryType, type Scope, typeFolder,
} from './memory-paths.ts';
import { withVaultLock } from './memory-vault-lock.ts';
import {
  buildFrontmatter, splitFrontmatterAndBody,
  type AnyFrontmatter, type MemoryFrontmatter, type LessonFrontmatter,
  type SessionFrontmatter, type WikiFrontmatter,
} from './memory-frontmatter.ts';
import { appendEvent, readEvents, foldEvents, decayConfidence } from './memory-events.ts';
import { commitInline } from './memory-git.ts';
import {
  getStore, registerVaultCollections, registerProjectContexts,
  scheduleReindex, flushReindex, searchAcrossCollections,
  decomposeDisplayPath, type QmdSearchHit,
} from './memory-qmd.ts';

// ---------------------------------------------------------------------------
// ToolCtx — pure-function handlers consume this; the MCP registration layer
// builds a real ctx from the workspace; tests build a stub.
// ---------------------------------------------------------------------------

export interface ToolCtx {
  chain: VaultInfo[];
  identity: Identity;
  config: MemoryConfig;
  now: () => Date;
}

// ---------------------------------------------------------------------------
// Shared write path
// ---------------------------------------------------------------------------

interface WriteRequest {
  type: MemoryType;
  scope: Scope;
  vault_id?: string;
  project: string;
  title: string;
  body: string;
  /** Build frontmatter from common fields + provided type-specific fields. */
  buildExtras: (common: {
    id: string; title: string; created: string; created_by: string;
    scope: Scope; vault_id: string; project: string; tags: string[];
  }) => AnyFrontmatter;
  tags: string[];
  /** Optional: passed to `created` event (lesson uses initial_confidence). */
  extraCreatedFields?: Record<string, unknown>;
  /** Wiki only — the explicit relative path the agent provided. */
  wikiPath?: string;
}

interface WriteResult {
  slug: string;
  path: string;
  vault_id: string;
  action: 'created';
}

async function writeNewDoc(ctx: ToolCtx, req: WriteRequest): Promise<WriteResult> {
  const vault = resolveVault(ctx.chain, req.scope, req.vault_id);
  const now = ctx.now();
  const filename = buildFilename(req.type, req.wikiPath ?? req.title, now);

  return withVaultLock(vault.id, async () => {
    // Collision handling: append -2, -3 if the file already exists.
    let finalFilename = filename;
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = withCollisionSuffix(filename, attempt);
      const candidatePath = vaultPathFor(vault, req.project, req.type, candidate);
      if (!existsSync(candidatePath)) {
        finalFilename = candidate;
        break;
      }
      if (req.type === 'wiki') {
        // Wiki paths are hand-curated; collision = explicit error rather than suffix.
        throw new Error(`wiki page already exists: ${req.project}/wiki/${candidate}`);
      }
      if (attempt === 49) {
        throw new Error(`too many filename collisions for ${candidate}`);
      }
    }

    const filePath = vaultPathFor(vault, req.project, req.type, finalFilename);
    const eventsPath = eventsPathFor(vault, req.project, req.type, finalFilename);
    mkdirSync(dirname(filePath), { recursive: true });

    const id = randomUUID();
    const created = now.toISOString();
    const fm = req.buildExtras({
      id, title: req.title, created, created_by: ctx.identity.email,
      scope: req.scope, vault_id: vault.id, project: req.project, tags: req.tags,
    });

    const yaml = buildFrontmatter(fm);
    const body = req.body.endsWith('\n') ? req.body : req.body + '\n';
    writeFileSync(filePath, `${yaml}\n${body}`, 'utf8');

    appendEvent(eventsPath, {
      ts: created,
      actor: ctx.identity.email,
      type: 'created',
      ...(req.extraCreatedFields ?? {}),
    });

    const relFile = relative(vault.path, filePath).split(sep).join('/');
    const relEvents = relative(vault.path, eventsPath).split(sep).join('/');
    commitInline(vault.path, [relFile, relEvents], `${req.type}: ${req.title}`);

    // Best-effort: schedule a reindex on this vault's qmd collection.
    // Failure here is non-fatal — the file is already committed.
    try {
      const store = await getStore(ctx.config);
      scheduleReindex(store, vault.id, ctx.config);
    } catch {
      // qmd not initialized yet; memory_init will pick this up on next run
    }

    return {
      slug: finalFilename,
      path: relFile,
      vault_id: vault.id,
      action: 'created',
    };
  });
}

// ---------------------------------------------------------------------------
// add_memory
// ---------------------------------------------------------------------------

const addMemorySchema = z.object({
  content: z.string().min(1),
  scope: z.enum(['personal', 'team']),
  project: z.string().min(1),
  citations: z.string().min(1),
  reason: z.string().min(1),
  vault_id: z.string().optional(),
  category: z.enum(['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact']).optional(),
  concepts: z.array(z.string()).optional(),
  title: z.string().optional(),
});

export type AddMemoryArgs = z.infer<typeof addMemorySchema>;

export async function handleAddMemory(ctx: ToolCtx, args: AddMemoryArgs): Promise<WriteResult> {
  const title = args.title ?? deriveTitle(args.content);
  return writeNewDoc(ctx, {
    type: 'memory',
    scope: args.scope,
    vault_id: args.vault_id,
    project: args.project,
    title,
    body: args.content,
    tags: args.concepts ?? [],
    buildExtras: (c) => ({
      ...c,
      type: 'memory',
      category: args.category,
      citations: args.citations,
      reason: args.reason,
    } as MemoryFrontmatter),
  });
}

// ---------------------------------------------------------------------------
// add_lesson (Phase 1 — no dedup; Phase 4 adds qmd vector dedup)
// ---------------------------------------------------------------------------

const addLessonSchema = z.object({
  content: z.string().min(1),
  scope: z.enum(['personal', 'team']),
  project: z.string().min(1),
  vault_id: z.string().optional(),
  context: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  title: z.string().optional(),
});

export type AddLessonArgs = z.infer<typeof addLessonSchema>;

export async function handleAddLesson(ctx: ToolCtx, args: AddLessonArgs): Promise<WriteResult> {
  const title = args.title ?? deriveTitle(args.content);
  const confidence = args.confidence ?? 0.5;
  return writeNewDoc(ctx, {
    type: 'lesson',
    scope: args.scope,
    vault_id: args.vault_id,
    project: args.project,
    title,
    body: args.content,
    tags: args.tags ?? [],
    extraCreatedFields: { initial_confidence: confidence },
    buildExtras: (c) => ({
      ...c,
      type: 'lesson',
      context: args.context,
      initial_confidence: confidence,
    } as LessonFrontmatter),
  });
}

// ---------------------------------------------------------------------------
// add_session_summary
// ---------------------------------------------------------------------------

const addSessionSummarySchema = z.object({
  title: z.string().min(1).max(100),
  narrative: z.string().min(1),
  scope: z.enum(['personal', 'team']),
  project: z.string().min(1),
  vault_id: z.string().optional(),
  decisions: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  concepts: z.array(z.string()).optional(),
  session_id: z.string().optional(),
});

export type AddSessionSummaryArgs = z.infer<typeof addSessionSummarySchema>;

export async function handleAddSessionSummary(
  ctx: ToolCtx,
  args: AddSessionSummaryArgs,
): Promise<WriteResult> {
  const body = renderSessionBody(args);
  return writeNewDoc(ctx, {
    type: 'session',
    scope: args.scope,
    vault_id: args.vault_id,
    project: args.project,
    title: args.title,
    body,
    tags: args.concepts ?? [],
    buildExtras: (c) => ({
      ...c,
      type: 'session',
      session_id: args.session_id,
      decisions: args.decisions,
      files: args.files,
    } as SessionFrontmatter),
  });
}

function renderSessionBody(args: AddSessionSummaryArgs): string {
  const sections: string[] = [];
  sections.push(`# ${args.title}\n`);
  sections.push(args.narrative.trim() + '\n');
  if (args.decisions && args.decisions.length) {
    sections.push('## Decisions\n');
    sections.push(args.decisions.map((d) => `- ${d}`).join('\n') + '\n');
  }
  if (args.files && args.files.length) {
    sections.push('## Files touched\n');
    sections.push(args.files.map((f) => `- \`${f}\``).join('\n') + '\n');
  }
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// add_wiki_page
// ---------------------------------------------------------------------------

const addWikiPageSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
  scope: z.enum(['personal', 'team']),
  project: z.string().min(1),
  vault_id: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  title: z.string().optional(),
});

export type AddWikiPageArgs = z.infer<typeof addWikiPageSchema>;

export async function handleAddWikiPage(
  ctx: ToolCtx,
  args: AddWikiPageArgs,
): Promise<WriteResult> {
  const title = args.title ?? deriveTitleFromPath(args.path);
  return writeNewDoc(ctx, {
    type: 'wiki',
    scope: args.scope,
    vault_id: args.vault_id,
    project: args.project,
    title,
    body: args.content,
    tags: args.keywords ?? [],
    wikiPath: args.path,
    buildExtras: (c) => ({ ...c, type: 'wiki' } as WikiFrontmatter),
  });
}

// ---------------------------------------------------------------------------
// get_memory
// ---------------------------------------------------------------------------

const getMemorySchema = z.object({
  path: z.string().min(1),
  scope: z.enum(['personal', 'team']).optional(),
  vault_id: z.string().optional(),
});

export type GetMemoryArgs = z.infer<typeof getMemorySchema>;

export interface GetMemoryResult {
  vault_id: string;
  path: string;                      // vault-relative
  type: MemoryType;
  frontmatter: AnyFrontmatter;
  body: string;
  events_summary: ReturnType<typeof foldEvents>;
}

export async function handleGetMemory(
  ctx: ToolCtx,
  args: GetMemoryArgs,
): Promise<GetMemoryResult> {
  const candidates: VaultInfo[] = args.vault_id
    ? [resolveVault(ctx.chain, args.scope ?? 'personal', args.vault_id)]
    : args.scope
      ? ctx.chain.filter((v) => v.kind === args.scope)
      : [...ctx.chain];
  if (candidates.length === 0) {
    throw new Error(`no vaults match the requested scope/vault_id`);
  }

  const relPath = args.path.endsWith('.md') ? args.path : `${args.path}.md`;
  let found: { vault: VaultInfo; abs: string } | null = null;
  for (const v of candidates) {
    const abs = join(v.path, relPath);
    if (existsSync(abs)) {
      found = { vault: v, abs };
      break;
    }
  }
  if (!found) {
    const tried = candidates.map((v) => v.id).join(', ');
    throw new Error(`memory file not found: ${relPath} (searched vaults: ${tried})`);
  }

  const raw = readFileSync(found.abs, 'utf8');
  const { frontmatter, body } = splitFrontmatterAndBody(raw);
  const type = frontmatter.type;

  // Map frontmatter type to its sidecar file
  const segments = relPath.split('/').filter(Boolean);
  // Expected layout: <project>/<typeFolder>/<rest>.md
  // Build events path from same logic as eventsPathFor by reusing it.
  const project = segments[0];
  const eventsPath = eventsPathFor(found.vault, project, type, segments.slice(2).join('/'));
  const events = readEvents(eventsPath);
  const folded = foldEvents(events, {
    isLesson: type === 'lesson',
    isWiki: type === 'wiki',
  });

  return {
    vault_id: found.vault.id,
    path: relPath,
    type,
    frontmatter,
    body,
    events_summary: folded,
  };
}

// ---------------------------------------------------------------------------
// memory_status (config + vault sections; qmd + git populated later)
// ---------------------------------------------------------------------------

const memoryStatusSchema = z.object({}).strict();

export type MemoryStatusArgs = z.infer<typeof memoryStatusSchema>;

export interface MemoryStatusResult {
  git: Record<string, unknown>;
  qmd: {
    db_path: string;
    db_size_bytes: number;
    collections: Array<{ name: string; doc_count: number }>;
    models_loaded: boolean;
    last_embed: string | null;
    last_embed_error: string | null;
    pending_index_queue: number;
  };
  config: {
    vaults: Array<{ id: string; kind: 'personal' | 'team'; path: string; has_remote: boolean }>;
    decay: { floor: number; half_life_days: number };
    duplicate_threshold: number;
    qmd_search_mode: 'lex' | 'hybrid' | 'vec';
    auto_resolve_conflicts: 'manual' | 'auto';
  };
  identity: { email: string; name: string; source: 'git' | 'os' };
  warnings: string[];
}

export async function handleMemoryStatus(
  ctx: ToolCtx,
  _args: MemoryStatusArgs,
): Promise<MemoryStatusResult> {
  return {
    git: {},
    qmd: {
      db_path: ctx.config.qmd_db_path,
      db_size_bytes: 0,
      collections: [],
      models_loaded: false,
      last_embed: null,
      last_embed_error: null,
      pending_index_queue: 0,
    },
    config: {
      vaults: ctx.chain.map((v) => ({
        id: v.id,
        kind: v.kind,
        path: v.path,
        has_remote: v.remote !== null,
      })),
      decay: ctx.config.decay,
      duplicate_threshold: ctx.config.duplicate_threshold,
      qmd_search_mode: ctx.config.qmd_search_mode,
      auto_resolve_conflicts: ctx.config.auto_resolve_conflicts,
    },
    identity: ctx.identity,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// memory_init — scaffold folders, register qmd collections + contexts
// ---------------------------------------------------------------------------

const memoryInitSchema = z.object({}).strict();

export type MemoryInitArgs = z.infer<typeof memoryInitSchema>;

export interface MemoryInitResult {
  vaults: Array<{
    id: string;
    kind: Scope;
    path: string;
    has_remote: boolean;
    skeleton_status: 'ok';
  }>;
  qmd_status: {
    collections: number;
    indexed_docs: number;
    models_loaded: boolean;
  };
}

const TYPE_FOLDERS_LIST: MemoryType[] = ['memory', 'lesson', 'session', 'wiki'];

export async function handleMemoryInit(
  ctx: ToolCtx,
  _args: MemoryInitArgs,
): Promise<MemoryInitResult> {
  if (ctx.chain.length === 0) {
    throw new Error(
      'No vaults registered. Use clawdevbox vault setup to register at least one vault, ' +
      'then re-run memory_init. (paths.get inspects the current chain.)',
    );
  }

  // Scaffold the _general/<type>/ folders in each vault. Existing
  // folders are left alone; this is purely idempotent mkdirSync.
  for (const vault of ctx.chain) {
    if (!existsSync(vault.path)) {
      throw new Error(`vault ${vault.id} path does not exist on disk: ${vault.path}`);
    }
    for (const type of TYPE_FOLDERS_LIST) {
      mkdirSync(join(vault.path, '_general', typeFolder(type)), { recursive: true });
    }
  }

  // Register qmd collections + per-path contexts + initial index.
  const store = await getStore(ctx.config);
  await registerVaultCollections(store, ctx.chain);
  await registerProjectContexts(store, ctx.chain);
  await store.update();
  // Skip embed unless hybrid/vec mode — embed loads GGUF models.
  if (ctx.config.qmd_search_mode !== 'lex') {
    try { await store.embed({}); } catch { /* ignore; lex still works */ }
  }

  const collections = await store.listCollections();
  const indexedDocs = collections.reduce((acc, c) => acc + (c.doc_count ?? 0), 0);

  return {
    vaults: ctx.chain.map((v) => ({
      id: v.id,
      kind: v.kind,
      path: v.path,
      has_remote: v.remote !== null,
      skeleton_status: 'ok',
    })),
    qmd_status: {
      collections: collections.length,
      indexed_docs: indexedDocs,
      models_loaded: ctx.config.qmd_search_mode !== 'lex',
    },
  };
}

// ---------------------------------------------------------------------------
// search_memory — qmd-backed with confidence-weighted ranking
// ---------------------------------------------------------------------------

const searchMemorySchema = z.object({
  query: z.string().min(1),
  scope: z.enum(['personal', 'team', 'all']).optional(),
  vault_id: z.string().optional(),
  types: z.array(z.enum(['memory', 'lesson', 'session', 'wiki'])).optional(),
  project: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  min_score: z.number().min(0).max(1).optional(),
  mode: z.enum(['hybrid', 'lex', 'vec']).optional(),
});

export type SearchMemoryArgs = z.infer<typeof searchMemorySchema>;

export interface SearchMemoryHit {
  path: string;
  type: MemoryType;
  scope: Scope;
  vault_id: string;
  project: string;
  title: string;
  snippet: string;
  score: number;
  confidence?: number;
  votes?: { up: number; down: number };
  last_modified: string;
}

export interface SearchMemoryResult {
  results: SearchMemoryHit[];
  total: number;
}

export async function handleSearchMemory(
  ctx: ToolCtx,
  args: SearchMemoryArgs,
): Promise<SearchMemoryResult> {
  const scope = args.scope ?? 'all';
  const types = args.types ?? ['memory', 'lesson', 'session', 'wiki'];
  const limit = args.limit ?? 10;
  const minScore = args.min_score ?? 0;
  const mode = args.mode ?? ctx.config.qmd_search_mode;

  // Resolve vault ids
  const vaultsForScope = args.vault_id
    ? ctx.chain.filter((v) => v.id === args.vault_id)
    : scope === 'all'
      ? ctx.chain
      : ctx.chain.filter((v) => v.kind === scope);
  if (vaultsForScope.length === 0) {
    return { results: [], total: 0 };
  }
  const vaultById = new Map(vaultsForScope.map((v) => [v.id, v]));

  // Ensure collections are registered (lazy init on first search)
  const store = await getStore(ctx.config);
  await registerVaultCollections(store, vaultsForScope);

  const rawHits = await searchAcrossCollections(store, {
    collections: vaultsForScope.map((v) => v.id),
    query: args.query,
    limit: limit * 3,
    minScore: 0,
    mode,
  });

  const now = ctx.now().getTime();
  const adapted: SearchMemoryHit[] = [];

  for (const hit of rawHits) {
    const vault = vaultById.get(hit.collectionName);
    if (!vault) continue;
    const decomposed = decomposeDisplayPath(hit.displayPath);
    if (!decomposed) continue;
    if (!types.includes(decomposed.type)) continue;
    if (args.project && decomposed.project !== args.project) continue;

    // Load events + frontmatter for ranking & last_modified
    const absMd = join(vault.path, hit.displayPath);
    let folded;
    let lastModified = '';
    try {
      lastModified = statSync(absMd).mtime.toISOString();
    } catch { /* ignore */ }

    try {
      const eventsPath = eventsPathFor(vault, decomposed.project, decomposed.type, decomposed.rest);
      const events = readEvents(eventsPath);
      folded = foldEvents(events, {
        isLesson: decomposed.type === 'lesson',
        isWiki: decomposed.type === 'wiki',
      });
    } catch { /* missing events — fine, treat as unrated */ }

    let finalScore = hit.score;
    let confidence: number | undefined;
    if (folded) {
      if (decomposed.type === 'lesson' && typeof folded.confidence_stored === 'number') {
        const lastReinforcedAt = folded.last_reinforced
          ? new Date(folded.last_reinforced).getTime()
          : new Date(folded.created.at || lastModified || now).getTime();
        confidence = decayConfidence({
          confidence_stored: folded.confidence_stored,
          last_reinforced_at: lastReinforcedAt,
          now,
          floor: ctx.config.decay.floor,
          half_life_days: ctx.config.decay.half_life_days,
        });
        finalScore = hit.score * (0.5 + 0.5 * confidence);
      } else if (decomposed.type !== 'session') {
        const net = (folded.votes.up - folded.votes.down);
        const voteBoost = 1 + 0.1 * Math.log1p(Math.max(0, net));
        finalScore = hit.score * voteBoost;
      }
    }

    if (finalScore < minScore) continue;

    adapted.push({
      path: hit.displayPath,
      type: decomposed.type,
      scope: vault.kind,
      vault_id: vault.id,
      project: decomposed.project,
      title: hit.title || decomposed.rest,
      snippet: hit.body.slice(0, 280),
      score: finalScore,
      confidence,
      votes: folded ? { up: folded.votes.up, down: folded.votes.down } : undefined,
      last_modified: lastModified,
    });
  }

  adapted.sort((a, b) => b.score - a.score);
  const truncated = adapted.slice(0, limit);
  return { results: truncated, total: adapted.length };
}

// ---------------------------------------------------------------------------
// get_wiki_index — navigable tree of <vault>/<project>/wiki/
// ---------------------------------------------------------------------------

const getWikiIndexSchema = z.object({
  scope: z.enum(['personal', 'team', 'all']).optional(),
  vault_id: z.string().optional(),
  project: z.string().optional(),
  root: z.string().optional(),
  depth: z.number().int().optional(),
  include: z.object({
    summaries: z.boolean().optional(),
    tags: z.boolean().optional(),
    metadata: z.boolean().optional(),
    links: z.boolean().optional(),
  }).optional(),
});

export type GetWikiIndexArgs = z.infer<typeof getWikiIndexSchema>;

export type WikiTreeNode =
  | {
      type: 'folder';
      path: string;
      page_count: number;
      children: WikiTreeNode[];
    }
  | {
      type: 'page';
      path: string;
      title: string;
      summary?: string;
      tags?: string[];
      author?: string;
      last_modified?: string;
      votes?: { up: number; down: number };
      links_out?: string[];
    };

export interface GetWikiIndexResult {
  root: string;
  total_pages: number;
  truncated_at_depth: boolean;
  tree: WikiTreeNode[];
}

interface ResolvedInclude {
  summaries: boolean;
  tags: boolean;
  metadata: boolean;
  links: boolean;
}

export async function handleGetWikiIndex(
  ctx: ToolCtx,
  args: GetWikiIndexArgs,
): Promise<GetWikiIndexResult> {
  const scope = args.scope ?? 'all';
  const depth = args.depth ?? 2;
  const include: ResolvedInclude = {
    summaries: args.include?.summaries ?? true,
    tags: args.include?.tags ?? true,
    metadata: args.include?.metadata ?? true,
    links: args.include?.links ?? false,
  };

  const vaults = args.vault_id
    ? ctx.chain.filter((v) => v.id === args.vault_id)
    : scope === 'all'
      ? ctx.chain
      : ctx.chain.filter((v) => v.kind === scope);

  const tree: WikiTreeNode[] = [];
  let totalPages = 0;
  let truncated = false;

  for (const vault of vaults) {
    const projects = args.project
      ? [args.project]
      : safeReaddir(vault.path).filter((d) => !d.startsWith('.') && !d.startsWith('_'));

    for (const project of projects) {
      const wikiRoot = join(vault.path, project, 'wiki');
      if (!existsSync(wikiRoot)) continue;
      const subroot = args.root ? join(wikiRoot, args.root.replace(/^\/+/, '')) : wikiRoot;
      if (!existsSync(subroot)) continue;

      const result = walkWiki({
        absRoot: wikiRoot,
        absDir: subroot,
        relPrefix: args.root?.replace(/^\/+|\/+$/g, '') ?? '',
        depthRemaining: depth < 0 ? Infinity : depth,
        include,
        vault,
        project,
      });
      totalPages += result.pageCount;
      if (result.truncated) truncated = true;
      tree.push(...result.nodes);
    }
  }

  return {
    root: args.root ?? '/',
    total_pages: totalPages,
    truncated_at_depth: truncated,
    tree,
  };
}

interface WalkArgs {
  absRoot: string;
  absDir: string;
  relPrefix: string;
  depthRemaining: number;
  include: ResolvedInclude;
  vault: VaultInfo;
  project: string;
}

function walkWiki(args: WalkArgs): { nodes: WikiTreeNode[]; pageCount: number; truncated: boolean } {
  const entries = safeReaddirEntries(args.absDir);
  const nodes: WikiTreeNode[] = [];
  let pageCount = 0;
  let truncated = false;

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childAbs = join(args.absDir, entry.name);
    const childRel = args.relPrefix ? `${args.relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const recursiveCount = countMdFiles(childAbs);
      pageCount += recursiveCount;
      if (args.depthRemaining <= 0) {
        truncated = true;
        nodes.push({
          type: 'folder',
          path: childRel + '/',
          page_count: recursiveCount,
          children: [],
        });
        continue;
      }
      const sub = walkWiki({
        ...args,
        absDir: childAbs,
        relPrefix: childRel,
        depthRemaining: args.depthRemaining - 1,
      });
      if (sub.truncated) truncated = true;
      nodes.push({
        type: 'folder',
        path: childRel + '/',
        page_count: recursiveCount,
        children: sub.nodes,
      });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      pageCount++;
      nodes.push(buildPageNode(childAbs, childRel, args.include, args.vault, args.project));
    }
  }

  return { nodes, pageCount, truncated };
}

function safeReaddir(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path);
  } catch { return []; }
}

function safeReaddirEntries(path: string): import('node:fs').Dirent[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch { return []; }
}

function countMdFiles(dir: string): number {
  let count = 0;
  for (const entry of safeReaddirEntries(dir)) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) count += countMdFiles(abs);
    else if (entry.isFile() && entry.name.endsWith('.md')) count++;
  }
  return count;
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const MDLINK_RE = /\[[^\]]*\]\(([^)]+\.md(?:#[^)]*)?)\)/g;

function buildPageNode(
  absPath: string,
  relPath: string,
  include: ResolvedInclude,
  vault: VaultInfo,
  project: string,
): WikiTreeNode {
  const node: WikiTreeNode = { type: 'page', path: relPath, title: relPath };
  let body = '';
  let frontmatter: AnyFrontmatter | null = null;
  try {
    const raw = readFileSync(absPath, 'utf8');
    const split = splitFrontmatterAndBody(raw);
    frontmatter = split.frontmatter;
    body = split.body;
    node.title = frontmatter.title || relPath;
  } catch {
    // Read fallback — file without frontmatter is allowed for plain wiki pages.
    try { body = readFileSync(absPath, 'utf8'); } catch { /* ignore */ }
  }

  if (include.summaries) {
    node.summary = firstParagraphAfterH1(body);
  }
  if (include.tags && frontmatter?.tags) {
    node.tags = [...frontmatter.tags];
  }
  if (include.metadata) {
    try {
      const stat = statSync(absPath);
      node.last_modified = stat.mtime.toISOString();
    } catch { /* ignore */ }
    if (frontmatter?.created_by) node.author = frontmatter.created_by;
    try {
      const eventsPath = eventsPathFor(vault, project, 'wiki', relPath);
      const folded = foldEvents(readEvents(eventsPath), { isWiki: true });
      if (folded.votes.up || folded.votes.down) {
        node.votes = { up: folded.votes.up, down: folded.votes.down };
      }
    } catch { /* ignore */ }
  }
  if (include.links) {
    node.links_out = extractLinks(body);
  }
  return node;
}

function firstParagraphAfterH1(body: string): string {
  const lines = body.split('\n');
  let idx = 0;
  while (idx < lines.length && (!lines[idx].trim() || lines[idx].trim().startsWith('#'))) idx++;
  const paragraph: string[] = [];
  while (idx < lines.length && lines[idx].trim()) {
    paragraph.push(lines[idx].trim());
    idx++;
  }
  return paragraph.join(' ').slice(0, 280);
}

function extractLinks(body: string): string[] {
  const out = new Set<string>();
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(body))) {
    out.add(normalizeLink(m[1]));
  }
  MDLINK_RE.lastIndex = 0;
  while ((m = MDLINK_RE.exec(body))) {
    out.add(normalizeLink(m[1]));
  }
  return [...out];
}

function normalizeLink(link: string): string {
  // Strip anchor + extension for wiki-style display
  return link.replace(/#.*$/, '').replace(/\.md$/i, '');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveTitle(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  if (firstLine.length <= 60) return firstLine || 'untitled';
  return firstLine.slice(0, 60);
}

function deriveTitleFromPath(path: string): string {
  const stem = path.replace(/\.md$/i, '');
  const last = stem.split('/').pop() ?? stem;
  return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

interface MemoryRegistrationOptions {
  /** Override config path (used by tests to provide a temp file). */
  configPath?: string;
}

export function registerMemoryEntries(
  ws: Workspace,
  opts: MemoryRegistrationOptions = {},
): void {
  const sourceFile = fileURLToPath(import.meta.url);

  // Build a fresh ctx per call so config / identity are re-read
  // (cheap; lets the user edit memory-config.json without restart).
  async function buildCtx(): Promise<ToolCtx> {
    const configPath = opts.configPath ?? defaultConfigPath(ws);
    const config = loadMemoryConfig(configPath);
    const identity = await resolveIdentity();
    const chain = loadVaultChainSafe(ws);
    return {
      chain,
      identity,
      config,
      now: () => new Date(),
    };
  }

  function asJson(payload: unknown) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }

  defineTool({
    name: 'add_memory',
    description:
      'Save a durable atomic fact to a project memories folder in a clawdevbox vault. ' +
      'Use for conventions, gotchas, decisions, or any insight a future agent should remember. ' +
      'Requires content + scope + project + citations + reason.',
    parameters: addMemorySchema,
    handler: async (args) => asJson(await handleAddMemory(await buildCtx(), args as AddMemoryArgs)),
    source: 'builtin',
    sourceFile,
    examples: [{
      description: 'Add a memory about JWT validation',
      args: {
        content: 'Always validate JWT exp before iat',
        scope: 'team',
        project: 'clawdevbox',
        citations: 'src/auth/jwt.ts:42',
        reason: 'We hit this in prod twice; future auth work must validate exp first.',
      },
    }],
  });

  defineTool({
    name: 'add_lesson',
    description:
      'Save a lesson learned to a project lessons folder. Lessons have confidence scores ' +
      'that will strengthen with reinforcement (Phase 4) and decay over time without it.',
    parameters: addLessonSchema,
    handler: async (args) => asJson(await handleAddLesson(await buildCtx(), args as AddLessonArgs)),
    source: 'builtin',
    sourceFile,
  });

  defineTool({
    name: 'add_session_summary',
    description:
      'Append a structured retrospective for the current session: title + narrative + ' +
      'decisions + files touched + concepts.',
    parameters: addSessionSummarySchema,
    handler: async (args) =>
      asJson(await handleAddSessionSummary(await buildCtx(), args as AddSessionSummaryArgs)),
    source: 'builtin',
    sourceFile,
  });

  defineTool({
    name: 'add_wiki_page',
    description:
      'Create a new curated wiki page at the given path within a project. Errors if the ' +
      'page already exists — use update_wiki (Phase 7) to modify existing pages.',
    parameters: addWikiPageSchema,
    handler: async (args) =>
      asJson(await handleAddWikiPage(await buildCtx(), args as AddWikiPageArgs)),
    source: 'builtin',
    sourceFile,
  });

  defineTool({
    name: 'get_memory',
    description:
      'Fetch a single memory/lesson/session/wiki document by vault-relative path. ' +
      'Returns frontmatter + body + folded events (votes, confidence, edit history).',
    parameters: getMemorySchema,
    handler: async (args) => asJson(await handleGetMemory(await buildCtx(), args as GetMemoryArgs)),
    source: 'builtin',
    sourceFile,
  });

  defineTool({
    name: 'memory_status',
    description:
      'Report sync state, qmd index health, queue depths, and a snapshot of the active ' +
      'memory configuration including the registered vault chain.',
    parameters: memoryStatusSchema,
    handler: async (args) =>
      asJson(await handleMemoryStatus(await buildCtx(), args as MemoryStatusArgs)),
    source: 'builtin',
    sourceFile,
  });

  defineTool({
    name: 'memory_init',
    description:
      'One-time setup: scaffold the _general/<type>/ folder skeleton in each registered ' +
      'vault, register qmd collections (one per vault) and per-path contexts, run an ' +
      'initial filesystem index. Idempotent — safe to re-run anytime.',
    parameters: memoryInitSchema,
    handler: async (args) => asJson(await handleMemoryInit(await buildCtx(), args as MemoryInitArgs)),
    source: 'builtin',
    sourceFile,
  });

  defineTool({
    name: 'search_memory',
    description:
      'Hybrid search across memory/lesson/session/wiki documents in one or more vaults. ' +
      'Scope filter (personal/team/all) maps to vault.kind; types filter selects which ' +
      'document folders. Lessons are re-ranked by decay-adjusted confidence; ' +
      'memories/wiki by vote tally.',
    parameters: searchMemorySchema,
    handler: async (args) => asJson(await handleSearchMemory(await buildCtx(), args as SearchMemoryArgs)),
    source: 'builtin',
    sourceFile,
  });

  defineTool({
    name: 'get_wiki_index',
    description:
      'Return a navigable tree of <project>/wiki/ across one or more vaults. Use ' +
      'depth/root to drill in. Includes title + summary + tags + outbound links per page.',
    parameters: getWikiIndexSchema,
    handler: async (args) => asJson(await handleGetWikiIndex(await buildCtx(), args as GetWikiIndexArgs)),
    source: 'builtin',
    sourceFile,
  });
}

function defaultConfigPath(ws: Workspace): string {
  return join(ws.globalDir, 'memory-config.json');
}

function loadVaultChainSafe(ws: Workspace): VaultInfo[] {
  const cfg = resolveConfig({ projectDir: ws.projectDir, globalDir: ws.globalDir });
  return loadVaultChain(cfg.vaults);
}

// Re-export DEFAULT_MEMORY_CONFIG for tests that want a baseline config
// without touching disk.
export { DEFAULT_MEMORY_CONFIG };
