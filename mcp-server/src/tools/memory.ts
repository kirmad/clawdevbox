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
  existsSync, mkdirSync, readFileSync, writeFileSync,
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
  withCollisionSuffix, type MemoryType, type Scope,
} from './memory-paths.ts';
import { withVaultLock } from './memory-vault-lock.ts';
import {
  buildFrontmatter, splitFrontmatterAndBody,
  type AnyFrontmatter, type MemoryFrontmatter, type LessonFrontmatter,
  type SessionFrontmatter, type WikiFrontmatter,
} from './memory-frontmatter.ts';
import { appendEvent, readEvents, foldEvents } from './memory-events.ts';
import { commitInline } from './memory-git.ts';

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
