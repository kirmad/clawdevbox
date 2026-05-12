/**
 * tools/skill.ts
 *
 * skill.list / read / upsert / delete. Same pattern as recipe.ts, but skills
 * are markdown files with a YAML frontmatter block (see validators.ts ::
 * parseSkill). The frontmatter is the structured metadata Conductor displays
 * in the skills panel; the body is freeform prose the agent consults at
 * runtime.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
import { skillPath, validateId, type Workspace } from '../workspace.ts';

const scopeFilter = z
  .enum(['project', 'global', 'all'])
  .or(z.string().regex(/^plugin:[a-z][a-z0-9-]*$/, 'plugin:<id>'))
  .optional();

const writableScope = z
  .enum(['project', 'global'])
  .or(z.string().regex(/^plugin:[a-z][a-z0-9-]*$/, 'plugin:<id> (will be rejected)'));

export function registerSkillTools(server: McpServer, ws: Workspace): void {
  // -- skill.list -----------------------------------------------------------
  server.registerTool(
    'skill.list',
    {
      description:
        'List skills across scopes (spec §6.1 + §10.4). Returns id, name, description, scope. Frontmatter parse errors are skipped silently.',
      inputSchema: {
        scope: scopeFilter,
        search: z.string().min(1).optional(),
      },
    },
    async (args) => {
      const scope = (args.scope ?? 'all') as 'project' | 'global' | 'all' | `plugin:${string}`;
      const entries = listAllInScope(ws, scope, 'skill', skillPath);
      const skills = entries.map((e) => {
        const src = safeRead(e.path);
        const parsed = src ? parseSkill(src) : null;
        const fm = parsed && parsed.ok ? parsed.value.frontmatter : {};
        const name = typeof fm.name === 'string' ? fm.name : e.id;
        const description = typeof fm.description === 'string' ? fm.description : '';
        return { id: e.id, scope: e.scope, name, description };
      });
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
  );

  // -- skill.read -----------------------------------------------------------
  server.registerTool(
    'skill.read',
    {
      description:
        'Read a skill by id. Returns the full markdown source plus parsed frontmatter + body split, plus the scope it resolved from.',
      inputSchema: { id: z.string().min(1), scope: scopeFilter },
    },
    async (args) => {
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
  );

  // -- skill.upsert ---------------------------------------------------------
  server.registerTool(
    'skill.upsert',
    {
      description:
        'Write a skill to project or global scope. Plugin scope is read-only. Frontmatter is validated for shape (name + description required).',
      inputSchema: {
        id: z.string().min(1),
        scope: writableScope,
        source: z.string().min(1).describe('Full markdown body, including the leading `---` frontmatter block.'),
      },
    },
    async (args) => {
      const idCheck = validateId(args.id);
      if (!idCheck.ok) return structuredError('INVALID_ID', idCheck.message!);
      const guard = ensureWritableScope(args.scope);
      if (guard) return guard;
      const validation = validateSkillSource(args.source);
      if (!validation.ok) return validationError(validation.errors);
      const target = skillPath(ws, args.scope as 'project' | 'global', args.id);
      writeFileAtomic(target, args.source);
      return {
        content: [{ type: 'text', text: `Wrote skill ${args.id} to ${args.scope} scope.` }],
        structuredContent: { id: args.id, scope: args.scope, path: target },
      };
    },
  );

  // -- skill.delete ---------------------------------------------------------
  server.registerTool(
    'skill.delete',
    {
      description: 'Delete a skill from project or global scope. Plugin scope is read-only.',
      inputSchema: { id: z.string().min(1), scope: writableScope },
    },
    async (args) => {
      const guard = ensureWritableScope(args.scope);
      if (guard) return guard;
      const target = skillPath(ws, args.scope as 'project' | 'global', args.id);
      if (!existsSync(target)) return notFound('skill', args.id);
      unlinkSync(target);
      return {
        content: [{ type: 'text', text: `Deleted skill ${args.id} from ${args.scope} scope.` }],
        structuredContent: { id: args.id, scope: args.scope, path: target },
      };
    },
  );
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
