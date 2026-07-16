/**
 * tools/skill.ts
 *
 * skill.list / read / upsert / delete. Same pattern as recipe.ts, but skills
 * are markdown files with a YAML frontmatter block (see validators.ts ::
 * parseSkill). The frontmatter is the structured metadata Clawdevbox displays
 * in the skills panel; the body is freeform prose the agent consults at
 * runtime.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump as yamlDump } from 'js-yaml';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { writeFileAtomic } from '../fs-util.ts';
import {
  ensureWritableScope,
  listAllInScope,
  notFound,
  resolveRead,
  structuredError,
  validationError,
} from '../scope.ts';
import { parseSkill, validateSkillSource } from '../validators.ts';
import {
  legacySkillFilePath,
  skillDirPath,
  skillPath,
  validateId,
  type Workspace,
} from '../workspace.ts';

const scopeFilter = z
  .enum(['project', 'global', 'all'])
  .or(z.string().regex(/^plugin:[a-z][a-z0-9-]*$/, 'plugin:<id>'))
  .optional();

const writableScope = z
  .enum(['project', 'global'])
  .or(z.string().regex(/^plugin:[a-z][a-z0-9-]*$/, 'plugin:<id> (will be rejected)'));

export function registerSkillEntries(ws: Workspace): void {
  // -- skill.list -----------------------------------------------------------
  defineTool({
    name: 'skill.list',
    description:
      'List skills across scopes (spec §6.1 + §10.4). Returns id, name, description, scope. Frontmatter parse errors are skipped silently. Pass `dir` to scan an arbitrary folder for skills/commands (.claude/commands, .github/copilot-instructions.md, CLAUDE.md, .cursorrules, etc.).',
    parameters: z.object({
      scope: scopeFilter,
      search: z.string().min(1).optional(),
      dirs: z.array(z.string().min(1)).optional().describe('Additional folders to scan for skills/commands. Looks in .claude/commands/, .claude/skills/, .github/, CLAUDE.md, .cursorrules, copilot-instructions.md in each. Results merged with the normal scope-based listing.'),
    }),
    handler: async (args) => {
      const scope = (args.scope ?? 'all') as 'project' | 'global' | 'all' | `plugin:${string}`;
      const entries = listAllInScope(ws, scope, 'skill', skillPath);
      const skills: Array<{ id: string; scope: string; name: string; description: string; path?: string }> = entries.map((e) => {
        const src = safeRead(e.path);
        const parsed = src ? parseSkill(src) : null;
        const fm = parsed && parsed.ok ? parsed.value.frontmatter : {};
        const name = typeof fm.name === 'string' ? fm.name : e.id;
        const description = typeof fm.description === 'string' ? fm.description : '';
        return { id: e.id, scope: e.scope, name, description };
      });

      // Merge skills from additional dirs
      if (args.dirs && args.dirs.length > 0) {
        for (const dir of args.dirs) {
          const scanned = scanDirForSkills(dir);
          skills.push(...scanned);
        }
      }

      const filtered = args.search
        ? skills.filter((s) => {
            const q = args.search!.toLowerCase();
            return (
              s.id.toLowerCase().includes(q) ||
              s.name.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q)
            );
          })
        : skills;
      return {
        content: [{ type: 'text', text: `Found ${filtered.length} skill(s).` }],
        structuredContent: { skills: filtered, count: filtered.length },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- skill.read -----------------------------------------------------------
  defineTool({
    name: 'skill.read',
    description:
      'Read a skill by id. Returns the full markdown source plus parsed frontmatter + body split, plus the scope it resolved from.',
    parameters: z.object({
      id: z.string().min(1),
      scope: scopeFilter,
    }),
    handler: async (args) => {
      const idCheck = validateId(args.id);
      if (!idCheck.ok) return structuredError('INVALID_ID', idCheck.message!);
      const scope = (args.scope ?? 'all') as 'project' | 'global' | 'all' | `plugin:${string}`;
      const hit = resolveRead(ws, scope, 'skill', args.id, skillPath);
      if (!hit) return notFound('skill', args.id);
      const parsed = parseSkill(hit.source);
      const frontmatter = parsed.ok ? parsed.value.frontmatter : {};
      const body = parsed.ok ? parsed.value.body : hit.source;
      return {
        content: [{ type: 'text', text: `skill ${args.id} [scope=${hit.scope}]` }],
        structuredContent: {
          id: args.id,
          scope: hit.scope,
          source: hit.source,
          frontmatter,
          body,
        },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- skill.upsert ---------------------------------------------------------
  defineTool({
    name: 'skill.upsert',
    description:
      'Write a skill to project or global scope. Plugin scope is read-only. Frontmatter is validated for shape (name + description required).',
    parameters: z.object({
      id: z.string().min(1),
      scope: writableScope,
      source: z.string().min(1).describe('Full markdown body, including the leading `---` frontmatter block.'),
    }),
    handler: async (args) => {
      const idCheck = validateId(args.id);
      if (!idCheck.ok) return structuredError('INVALID_ID', idCheck.message!);
      const guard = ensureWritableScope(args.scope);
      if (guard) return guard;

      // Inject `name: <id>` into the frontmatter if absent, or reject when
      // present-but-mismatched. Easier than forcing callers to repeat the id
      // in two places.
      const parsed = parseSkill(args.source);
      let source = args.source;
      if (parsed.ok) {
        const fm = parsed.value.frontmatter;
        const fmName = fm.name;
        if (typeof fmName === 'string' && fmName !== args.id) {
          return structuredError(
            'NAME_MISMATCH',
            `frontmatter.name '${fmName}' does not match requested id '${args.id}'.`,
            { id: args.id, frontmatterName: fmName },
          );
        }
        if (fmName === undefined) {
          const merged: Record<string, unknown> = { name: args.id, ...fm };
          const dumped = yamlDump(merged, { lineWidth: 1000, noRefs: true }).trimEnd();
          source = `---\n${dumped}\n---\n${parsed.value.body}`;
        }
      }

      const validation = validateSkillSource(source);
      if (!validation.ok) return validationError(validation.errors);
      const scope = args.scope as 'project' | 'global';
      const dir = skillDirPath(ws, scope, args.id);
      mkdirSync(dir, { recursive: true });
      const target = skillPath(ws, scope, args.id);
      writeFileAtomic(target, source);
      // Drop any legacy `<scope>/skills/<id>.md` after the new SKILL.md is in
      // place so the loader doesn't report the id twice.
      const legacy = legacySkillFilePath(ws, scope, args.id);
      if (existsSync(legacy)) {
        try {
          if (statSync(legacy).isFile()) unlinkSync(legacy);
        } catch {
          // best-effort
        }
      }
      return {
        content: [{ type: 'text', text: `Wrote skill ${args.id} to ${args.scope} scope.` }],
        structuredContent: { id: args.id, scope: args.scope, path: target },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- skill.delete ---------------------------------------------------------
  defineTool({
    name: 'skill.delete',
    description: 'Delete a skill from project or global scope. Plugin scope is read-only.',
    parameters: z.object({
      id: z.string().min(1),
      scope: writableScope,
    }),
    handler: async (args) => {
      const guard = ensureWritableScope(args.scope);
      if (guard) return guard;
      const scope = args.scope as 'project' | 'global';
      const dir = skillDirPath(ws, scope, args.id);
      const legacy = legacySkillFilePath(ws, scope, args.id);
      const dirExists = existsSync(dir);
      const legacyExists = existsSync(legacy);
      if (!dirExists && !legacyExists) return notFound('skill', args.id);
      if (dirExists) {
        rmSync(dir, { recursive: true, force: true });
      }
      if (legacyExists) {
        try {
          if (statSync(legacy).isFile()) unlinkSync(legacy);
        } catch {
          // best-effort
        }
      }
      return {
        content: [{ type: 'text', text: `Deleted skill ${args.id} from ${args.scope} scope.` }],
        structuredContent: { id: args.id, scope: args.scope, path: dir },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// scanDirForSkills — scan a repo/folder for skills/commands in common locations
// ---------------------------------------------------------------------------

/** Well-known paths where repos store agent skills/commands/instructions. */
const SKILL_SCAN_PATHS = [
  '.claude/commands',
  '.claude/skills',
  '.github',
  '.copilot',
  '.cursor',
];

/** Single files that are effectively "skills" (repo-level instructions). */
const SKILL_SINGLE_FILES = [
  'CLAUDE.md',
  '.cursorrules',
  'copilot-instructions.md',
  '.github/copilot-instructions.md',
  '.clawdevbox/skills',
];

function scanDirForSkills(dir: string): Array<{ id: string; scope: string; name: string; description: string; path: string }> {
  const results: Array<{ id: string; scope: string; name: string; description: string; path: string }> = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return results;

  const repoName = basename(dir);

  // Scan well-known directories for .md files
  for (const relDir of SKILL_SCAN_PATHS) {
    const scanPath = join(dir, relDir);
    if (!existsSync(scanPath) || !statSync(scanPath).isDirectory()) continue;
    walkMdFiles(scanPath, (filePath) => {
      const src = safeRead(filePath);
      if (!src) return;
      const parsed = parseSkill(src);
      const fm = parsed && parsed.ok ? parsed.value.frontmatter : {};
      const name = typeof fm.name === 'string' ? fm.name : basename(filePath, '.md');
      const description = typeof fm.description === 'string' ? fm.description : extractFirstLine(src);
      const id = `${repoName}:${relative(dir, filePath).replace(/\\/g, '/').replace(/\.md$/, '')}`;
      results.push({ id, scope: `dir:${repoName}`, name, description, path: filePath });
    });
  }

  // Check single instruction files
  for (const relFile of SKILL_SINGLE_FILES) {
    const filePath = join(dir, relFile);
    if (!existsSync(filePath)) continue;
    if (statSync(filePath).isDirectory()) {
      // .clawdevbox/skills is a directory
      walkMdFiles(filePath, (fp) => {
        const src = safeRead(fp);
        if (!src) return;
        const parsed = parseSkill(src);
        const fm = parsed && parsed.ok ? parsed.value.frontmatter : {};
        const name = typeof fm.name === 'string' ? fm.name : basename(fp, '.md');
        const description = typeof fm.description === 'string' ? fm.description : extractFirstLine(src);
        const id = `${repoName}:${relative(dir, fp).replace(/\\/g, '/').replace(/\.md$/, '')}`;
        results.push({ id, scope: `dir:${repoName}`, name, description, path: fp });
      });
      continue;
    }
    const src = safeRead(filePath);
    if (!src) continue;
    const name = basename(filePath, '.md') || relFile;
    const description = extractFirstLine(src);
    const id = `${repoName}:${relFile.replace(/\.md$/, '')}`;
    results.push({ id, scope: `dir:${repoName}`, name, description, path: filePath });
  }

  return results;
}

function walkMdFiles(dir: string, cb: (filePath: string) => void, depth = 0): void {
  if (depth > 3) return; // limit recursion
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walkMdFiles(full, cb, depth + 1);
      else if (st.isFile() && entry.endsWith('.md')) cb(full);
    } catch { /* skip */ }
  }
}

function extractFirstLine(src: string): string {
  // Skip frontmatter, get first non-empty line
  let body = src;
  if (body.startsWith('---')) {
    const end = body.indexOf('---', 3);
    if (end > 0) body = body.slice(end + 3);
  }
  const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
  return (lines[0] ?? '').slice(0, 120);
}
