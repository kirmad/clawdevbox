/**
 * cli/library-api.ts
 *
 * Read-only "Library" API — a browsable catalog of everything the agent
 * can do, surfaced in the web UI's Library tab. Four families:
 *
 *   Templates
 *     GET /api/library/recipes                     → recipe templates (list)
 *     GET /api/library/recipes/<id>                → one recipe: source +
 *                                                     parsed steps (flow viz)
 *     GET /api/library/skills                      → skills (list)
 *     GET /api/library/skills/<id>                 → one skill: SKILL.md body +
 *                                                     supporting script files
 *     GET /api/library/trigger-templates           → trigger TYPES (list)
 *     GET /api/library/trigger-templates/<id>/script → one trigger type script
 *
 *   Memory
 *     GET /api/library/memory?type=fact|lesson|wiki → memory docs (list)
 *     GET /api/library/memory/doc?key=<key>         → one memory doc (body)
 *
 * Every route is GET-only and shares the loopback-server bearer auth (same
 * as /api/agent-clis). The heavy enumeration reuses the same on-disk
 * loaders the MCP tools use (scope walker, vault chain, memory fold), so
 * this view can never drift from what the agent actually resolves.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Workspace } from '../workspace.ts';
import { recipePath, skillPath, validateId } from '../workspace.ts';
import { listAllInScope, resolveRead } from '../scope.ts';
import { parseRecipeSource, parseSkill } from '../validators.ts';
import { normalizeValidation } from '../db/recipe-steps-store.ts';
import { loadVaultChainForWorkspace } from '../vault-paths.ts';
import type { VaultInfo } from '../vault-chain.ts';
import {
  eventsPathFor,
  typeFolder,
  vaultMemoryRoot,
  type MemoryType,
} from '../tools/memory-paths.ts';
import { splitFrontmatterAndBody } from '../tools/memory-frontmatter.ts';
import { decayConfidence, foldEvents, readEvents } from '../tools/memory-events.ts';
import { DEFAULT_MEMORY_CONFIG } from '../tools/memory-config.ts';

// ---------------------------------------------------------------------------
// Auth (mirrors agent-clis-api.ts — loopback bearer, no WWW-Authenticate)
// ---------------------------------------------------------------------------

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function reject401(res: ServerResponse, msg: string): void {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: msg } }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse, kind: string, id: string): void {
  json(res, 404, { error: { code: 'NOT_FOUND', message: `${kind} not found: ${id}` } });
}

// ---------------------------------------------------------------------------
// File-read helpers
// ---------------------------------------------------------------------------

const SCRIPT_CAP_BYTES = 256 * 1024;
const SKILL_FILE_CAP_BYTES = 128 * 1024;

/** Extensions whose contents we inline as text; others are listed by metadata only. */
const TEXT_EXTS = new Set([
  '.md', '.mdx', '.txt', '.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx',
  '.py', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.yaml', '.yml', '.json', '.jsonc',
  '.toml', '.ini', '.cfg', '.env', '.sql', '.rb', '.go', '.rs', '.java', '.cs', '.php',
  '.html', '.css', '.scss', '.xml', '.csv', '.tsv', '.dockerfile', '.gitignore',
]);

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readCapped(path: string, cap: number): { source: string | null; truncated: boolean } {
  const raw = safeRead(path);
  if (raw === null) return { source: null, truncated: false };
  if (raw.length > cap) return { source: raw.slice(0, cap) + `\n\n…(truncated at ${Math.round(cap / 1024)} KiB)…`, truncated: true };
  return { source: raw, truncated: false };
}

function relTo(ws: Workspace, abs: string): string {
  try {
    const r = relative(ws.projectDir, abs);
    // If the file is outside the project dir the relative path escapes with
    // '..'; fall back to the absolute path so the label stays meaningful.
    return r.startsWith('..') ? abs : r;
  } catch {
    return abs;
  }
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

interface RecipeStepView {
  id: string;
  goal: string;
  depends: string[];
  has_ai_instructions: boolean;
  /** Present when the step declares a `validation:` gate. */
  validation?: { gates: Array<{ name: string; mode: string; criteria?: string }> };
  params?: unknown;
  artifacts?: unknown;
  triggers?: unknown;
}

export function projectValidation(v: unknown): { gates: Array<{ name: string; mode: string; criteria?: string }> } | undefined {
  const cfg = normalizeValidation(v);
  if (!cfg) return undefined;
  return { gates: cfg.gates.map((g) => ({ name: g.name, mode: g.mode, ...(g.criteria ? { criteria: g.criteria } : {}) })) };
}

function projectRecipeSteps(parsed: unknown): RecipeStepView[] {
  const obj = parsed as Record<string, unknown> | null;
  if (!obj || !Array.isArray(obj.steps)) return [];
  return (obj.steps as Record<string, unknown>[]).map((s) => {
    const validation = projectValidation(s.validation);
    return {
      id: String(s.id ?? ''),
      goal: typeof s.goal === 'string' ? s.goal : '',
      depends: Array.isArray(s.depends) ? (s.depends as unknown[]).map(String) : [],
      has_ai_instructions: typeof s.ai_instructions === 'string' || typeof s.ai_prompt === 'string',
      ...(validation ? { validation } : {}),
      ...(s.params !== undefined ? { params: s.params } : {}),
      ...(s.artifacts !== undefined ? { artifacts: s.artifacts } : {}),
      ...(s.triggers !== undefined ? { triggers: s.triggers } : {}),
    };
  });
}

function recipeMeta(parsed: unknown, id: string): { name: string; description: string; stepCount: number } {
  const obj = parsed as Record<string, unknown> | null;
  const name = obj && typeof obj.name === 'string' && obj.name ? obj.name : id;
  const description = obj && typeof obj.description === 'string' ? obj.description : '';
  const stepCount = obj && Array.isArray(obj.steps) ? obj.steps.length : 0;
  return { name, description, stepCount };
}

function listRecipes(ws: Workspace): unknown {
  const items: Array<{ id: string; scope: string; name: string; description: string; step_count: number }> = [];

  for (const e of listAllInScope(ws, 'all', 'recipe', recipePath)) {
    const src = safeRead(e.path);
    const parsed = src ? tryParseRecipe(src) : null;
    const { name, description, stepCount } = recipeMeta(parsed, e.id);
    items.push({ id: e.id, scope: e.scope, name, description, step_count: stepCount });
  }

  // Vault recipes: <vault>/recipes/<id>.{yaml,yml,json}
  for (const vault of loadVaultChainForWorkspace(ws)) {
    const root = join(vault.path, 'recipes');
    if (!existsSync(root)) continue;
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      const m = name.match(/^([a-z][a-z0-9-]*)\.(yaml|yml|json)$/i);
      if (!m) continue;
      const full = join(root, name);
      try { if (!statSync(full).isFile()) continue; } catch { continue; }
      const src = safeRead(full);
      const parsed = src ? tryParseRecipe(src) : null;
      const meta = recipeMeta(parsed, m[1]);
      items.push({ id: m[1], scope: `vault:${vault.id}`, name: meta.name, description: meta.description, step_count: meta.stepCount });
    }
  }

  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, count: items.length };
}

function tryParseRecipe(source: string): unknown {
  try {
    return parseRecipeSource(source);
  } catch {
    return null;
  }
}

function getRecipe(ws: Workspace, id: string): unknown | null {
  // Guard against path traversal: `id` is used to build on-disk paths via
  // recipePath()/resolveRead(), so it must match the loader's id rule
  // (mirrors recipe.template.get's validateId check).
  if (!validateId(id).ok) return null;
  // Non-vault scopes via the shared resolver (project → plugin → global).
  const hit = resolveRead(ws, 'all', 'recipe', id, recipePath);
  if (hit) {
    const parsed = tryParseRecipe(hit.source);
    const meta = recipeMeta(parsed, id);
    return {
      id, scope: hit.scope, name: meta.name, description: meta.description,
      source: hit.source, steps: projectRecipeSteps(parsed), found: true,
    };
  }
  // Vault fallback.
  for (const vault of loadVaultChainForWorkspace(ws)) {
    for (const ext of ['yaml', 'yml', 'json'] as const) {
      const p = join(vault.path, 'recipes', `${id}.${ext}`);
      if (!existsSync(p)) continue;
      const src = safeRead(p);
      if (src === null) continue;
      const parsed = tryParseRecipe(src);
      const meta = recipeMeta(parsed, id);
      return {
        id, scope: `vault:${vault.id}`, name: meta.name, description: meta.description,
        source: src, steps: projectRecipeSteps(parsed), found: true,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function listSkills(ws: Workspace): unknown {
  const items = listAllInScope(ws, 'all', 'skill', skillPath).map((e) => {
    const src = safeRead(e.path);
    const parsed = src ? parseSkill(src) : null;
    const fm = parsed && parsed.ok ? parsed.value.frontmatter : {};
    return {
      id: e.id,
      scope: e.scope,
      name: typeof fm.name === 'string' ? fm.name : e.id,
      description: typeof fm.description === 'string' ? fm.description : '',
    };
  });
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, count: items.length };
}

interface SkillFileView {
  name: string;
  rel: string;
  ext: string;
  size: number;
  is_text: boolean;
  source: string | null;
  truncated: boolean;
}

/** Recursively collect supporting files beside SKILL.md (skips SKILL.md, hidden, node_modules). */
function collectSkillFiles(skillDir: string, cur: string, depth: number, out: SkillFileView[]): void {
  if (depth > 4 || out.length > 200) return;
  let entries: string[];
  try { entries = readdirSync(cur); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(cur, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      collectSkillFiles(skillDir, full, depth + 1, out);
      continue;
    }
    if (!st.isFile()) continue;
    // Skip the top-level SKILL.md — it's returned separately as the body.
    if (depth === 0 && entry === 'SKILL.md') continue;
    const ext = extname(entry).toLowerCase();
    const isText = TEXT_EXTS.has(ext) || entry.toLowerCase() === 'dockerfile' || entry.toLowerCase() === 'makefile';
    const capped = isText ? readCapped(full, SKILL_FILE_CAP_BYTES) : { source: null, truncated: false };
    out.push({
      name: entry,
      rel: relative(skillDir, full).replace(/\\/g, '/'),
      ext: ext.replace(/^\./, ''),
      size: st.size,
      is_text: isText,
      source: capped.source,
      truncated: capped.truncated,
    });
  }
}

function getSkill(ws: Workspace, id: string): unknown | null {
  // Guard against path traversal — `id` builds on-disk paths via
  // skillPath()/resolveRead() (mirrors skill.read's validateId check).
  if (!validateId(id).ok) return null;
  const hit = resolveRead(ws, 'all', 'skill', id, skillPath);
  if (!hit) return null;
  const parsed = parseSkill(hit.source);
  const fm = parsed.ok ? parsed.value.frontmatter : {};
  const body = parsed.ok ? parsed.value.body : hit.source;
  const skillDir = dirname(hit.path);
  const files: SkillFileView[] = [];
  collectSkillFiles(skillDir, skillDir, 0, files);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    id,
    scope: hit.scope,
    name: typeof fm.name === 'string' ? fm.name : id,
    description: typeof fm.description === 'string' ? fm.description : '',
    frontmatter: fm,
    body,
    source: hit.source,
    path_rel: relTo(ws, hit.path),
    files,
  };
}

// ---------------------------------------------------------------------------
// Trigger templates (TYPES)
// ---------------------------------------------------------------------------

function listTriggerTemplates(ws: Workspace): unknown {
  const items = [...ws.triggerTypes.values()]
    .map((t) => ({
      id: t.id,
      scope: t.scope,
      source_plugin_id: t.source_plugin_id,
      description: t.description ?? '',
      default_cron: t.default_cron ?? null,
      accepts_webhook: t.accepts_webhook ?? true,
      identity_param: t.identity_param ?? null,
      runtime: (t as unknown as { runtime?: string }).runtime ?? 'tsx',
      param_count: t.parameters?.length ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { items, count: items.length, errors: ws.triggerTypeErrors };
}

function getTriggerTemplateScript(ws: Workspace, id: string): unknown | null {
  const type = ws.triggerTypes.get(id);
  if (!type) return null;
  const runtime = (type as unknown as { runtime?: string }).runtime ?? 'tsx';
  const scriptAbs = type.file_abs;
  if (!scriptAbs) {
    return { id, runtime, path: null, path_rel: null, source: null, found: false, parameters: type.parameters ?? [], error: { code: 'SCRIPT_NOT_FOUND', message: `no script resolved for type ${id}` } };
  }
  const capped = readCapped(scriptAbs, SCRIPT_CAP_BYTES);
  return {
    id,
    runtime,
    path: scriptAbs,
    path_rel: relTo(ws, scriptAbs),
    source: capped.source,
    truncated: capped.truncated,
    found: capped.source !== null,
    parameters: type.parameters ?? [],
    description: type.description ?? '',
    default_cron: type.default_cron ?? null,
    error: capped.source === null ? { code: 'READ_FAILED', message: `could not read ${scriptAbs}` } : null,
  };
}

// ---------------------------------------------------------------------------
// Memory (facts / lessons / wiki)
// ---------------------------------------------------------------------------

const MEMORY_TYPES: MemoryType[] = ['fact', 'lesson', 'wiki'];

function isMemoryType(t: string): t is MemoryType {
  return (MEMORY_TYPES as string[]).includes(t);
}

/** Encode a stable, URL-safe key for a memory doc: "<vault>::<type>::<relpath>". */
function memoryKey(vaultId: string, type: MemoryType, relPath: string): string {
  return `${vaultId}::${type}::${relPath.replace(/\\/g, '/')}`;
}

function parseMemoryKey(key: string): { vaultId: string; type: MemoryType; relPath: string } | null {
  const idx1 = key.indexOf('::');
  if (idx1 < 0) return null;
  const idx2 = key.indexOf('::', idx1 + 2);
  if (idx2 < 0) return null;
  const vaultId = key.slice(0, idx1);
  const type = key.slice(idx1 + 2, idx2);
  const relPath = key.slice(idx2 + 2);
  if (!isMemoryType(type) || !vaultId || !relPath) return null;
  // Reject traversal — relPath must stay within the type folder.
  if (relPath.includes('..')) return null;
  return { vaultId, type, relPath };
}

/** Recursively list *.md files under a memory type folder, returning paths relative to that folder. */
function walkMemoryFiles(root: string, cur: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(cur); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // skips .events sidecar dir
    const full = join(cur, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walkMemoryFiles(root, full, out);
    } else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
      out.push(relative(root, full).replace(/\\/g, '/'));
    }
  }
}

function foldDoc(vault: VaultInfo, type: MemoryType, relPath: string) {
  const events = readEvents(eventsPathFor(vault, type, relPath));
  return foldEvents(events, { isLesson: type === 'lesson', isWiki: type === 'wiki' });
}

function confidenceOf(folded: ReturnType<typeof foldEvents>): number | null {
  if (typeof folded.confidence_stored !== 'number') return null;
  const lastReinforced = folded.last_reinforced
    ? new Date(folded.last_reinforced).getTime()
    : (folded.created.at ? new Date(folded.created.at).getTime() : Date.now());
  return decayConfidence({
    confidence_stored: folded.confidence_stored,
    last_reinforced_at: Number.isFinite(lastReinforced) ? lastReinforced : Date.now(),
    now: Date.now(),
    floor: DEFAULT_MEMORY_CONFIG.decay.floor,
    half_life_days: DEFAULT_MEMORY_CONFIG.decay.half_life_days,
  });
}

function deriveTitle(fm: Record<string, unknown>, body: string, relPath: string): string {
  if (typeof fm.title === 'string' && fm.title.trim()) return fm.title.trim();
  const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#'));
  if (firstLine) return firstLine.slice(0, 80);
  return basename(relPath).replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
}

function listMemory(ws: Workspace, type: MemoryType): unknown {
  const items: Array<Record<string, unknown>> = [];
  for (const vault of loadVaultChainForWorkspace(ws)) {
    if (vault.memory === false) continue;
    const dir = join(vaultMemoryRoot(vault), typeFolder(type));
    if (!existsSync(dir)) continue;
    const rels: string[] = [];
    walkMemoryFiles(dir, dir, rels);
    for (const relPath of rels) {
      const abs = join(dir, relPath);
      const raw = safeRead(abs);
      if (raw === null) continue;
      let fm: Record<string, unknown> = {};
      let body = raw;
      try {
        const split = splitFrontmatterAndBody(raw);
        fm = split.frontmatter as unknown as Record<string, unknown>;
        body = split.body;
      } catch {
        // Tolerate a doc without valid frontmatter — still list it.
      }
      const folded = foldDoc(vault, type, relPath);
      items.push({
        key: memoryKey(vault.id, type, relPath),
        vault_id: vault.id,
        scope: vault.kind,
        type,
        title: deriveTitle(fm, body, relPath),
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        created: typeof fm.created === 'string' ? fm.created : (folded.created.at || null),
        created_by: typeof fm.created_by === 'string' ? fm.created_by : (folded.created.by || null),
        category: typeof fm.category === 'string' ? fm.category : null,
        votes: folded.votes,
        confidence: confidenceOf(folded),
        reinforcement_count: folded.reinforcement_count ?? null,
        path_rel: `${typeFolder(type)}/${relPath}`,
      });
    }
  }
  // Sort: facts/wiki by newest created; lessons by confidence desc.
  if (type === 'lesson') {
    items.sort((a, b) => ((b.confidence as number) ?? 0) - ((a.confidence as number) ?? 0));
  } else {
    items.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
  }
  return { items, count: items.length, type };
}

function getMemoryDoc(ws: Workspace, key: string): unknown | null {
  const parsed = parseMemoryKey(key);
  if (!parsed) return null;
  const vault = loadVaultChainForWorkspace(ws).find((v) => v.id === parsed.vaultId);
  if (!vault) return null;
  const abs = join(vaultMemoryRoot(vault), typeFolder(parsed.type), parsed.relPath);
  const raw = safeRead(abs);
  if (raw === null) return null;
  let fm: Record<string, unknown> = {};
  let body = raw;
  try {
    const split = splitFrontmatterAndBody(raw);
    fm = split.frontmatter as unknown as Record<string, unknown>;
    body = split.body;
  } catch {
    // fall through with raw body
  }
  const folded = foldDoc(vault, parsed.type, parsed.relPath);
  return {
    key,
    vault_id: vault.id,
    scope: vault.kind,
    type: parsed.type,
    title: deriveTitle(fm, body, parsed.relPath),
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    created: typeof fm.created === 'string' ? fm.created : (folded.created.at || null),
    created_by: typeof fm.created_by === 'string' ? fm.created_by : (folded.created.by || null),
    category: typeof fm.category === 'string' ? fm.category : null,
    citations: typeof fm.citations === 'string' ? fm.citations : null,
    reason: typeof fm.reason === 'string' ? fm.reason : null,
    context: typeof fm.context === 'string' ? fm.context : null,
    votes: folded.votes,
    confidence: confidenceOf(folded),
    reinforcement_count: folded.reinforcement_count ?? null,
    frontmatter: fm,
    body,
    path_rel: `${typeFolder(parsed.type)}/${parsed.relPath}`,
    found: true,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Returns true if the request was handled (response sent), false otherwise.
 */
export async function handleLibraryApi(
  req: IncomingMessage,
  res: ServerResponse,
  ws: Workspace,
  expectedToken: string | null,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/library/')) return false;
  if (req.method !== 'GET') {
    json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Library API is read-only (GET).' } });
    return true;
  }

  // Loopback bearer auth (opt-in, same policy as the other /api/* routes).
  if (expectedToken) {
    const presented = bearer(req);
    if (!presented) { reject401(res, 'missing bearer token'); return true; }
    if (!constantTimeEquals(presented, expectedToken)) { reject401(res, 'invalid bearer token'); return true; }
  }

  const p = url.pathname;

  try {
    // -- Recipes -----------------------------------------------------------
    if (p === '/api/library/recipes') { json(res, 200, listRecipes(ws)); return true; }
    {
      const m = p.match(/^\/api\/library\/recipes\/([^/]+)\/?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const doc = getRecipe(ws, id);
        if (!doc) { notFound(res, 'recipe', id); return true; }
        json(res, 200, doc);
        return true;
      }
    }

    // -- Skills ------------------------------------------------------------
    if (p === '/api/library/skills') { json(res, 200, listSkills(ws)); return true; }
    {
      const m = p.match(/^\/api\/library\/skills\/([^/]+)\/?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const doc = getSkill(ws, id);
        if (!doc) { notFound(res, 'skill', id); return true; }
        json(res, 200, doc);
        return true;
      }
    }

    // -- Trigger templates -------------------------------------------------
    if (p === '/api/library/trigger-templates') { json(res, 200, listTriggerTemplates(ws)); return true; }
    {
      const m = p.match(/^\/api\/library\/trigger-templates\/(.+)\/script\/?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const doc = getTriggerTemplateScript(ws, id);
        if (!doc) { notFound(res, 'trigger template', id); return true; }
        json(res, 200, doc);
        return true;
      }
    }

    // -- Memory ------------------------------------------------------------
    if (p === '/api/library/memory') {
      const type = url.searchParams.get('type') ?? 'fact';
      if (!isMemoryType(type)) {
        json(res, 400, { error: { code: 'BAD_TYPE', message: `type must be one of ${MEMORY_TYPES.join(', ')}` } });
        return true;
      }
      json(res, 200, listMemory(ws, type));
      return true;
    }
    if (p === '/api/library/memory/doc') {
      const key = url.searchParams.get('key') ?? '';
      if (!key) { json(res, 400, { error: { code: 'MISSING_KEY', message: 'key query param is required' } }); return true; }
      const doc = getMemoryDoc(ws, key);
      if (!doc) { notFound(res, 'memory doc', key); return true; }
      json(res, 200, doc);
      return true;
    }
  } catch (err) {
    json(res, 500, { error: { code: 'LIBRARY_ERROR', message: (err as Error).message } });
    return true;
  }

  // Unknown /api/library/* path.
  json(res, 404, { error: { code: 'NOT_FOUND', message: `unknown library route: ${p}` } });
  return true;
}
