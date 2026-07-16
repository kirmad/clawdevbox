/**
 * tools/memory-frontmatter.ts
 *
 * Build and parse YAML frontmatter for memory/lesson/session/wiki types.
 * Backed by js-yaml (already a project dep).
 *
 * Field-name normalization (per spec §3): the agent-facing `concepts` /
 * `keywords` tool args are NORMALIZED to a single `tags:` field in
 * frontmatter so Obsidian's Tags pane works uniformly across types.
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
  type: 'fact';
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

  if (fm.type === 'fact') {
    if (fm.category) ordered.category = fm.category;
    if (fm.citations) ordered.citations = fm.citations;
    if (fm.reason) ordered.reason = fm.reason;
  } else if (fm.type === 'lesson') {
    if (fm.context) ordered.context = fm.context;
    if (typeof fm.initial_confidence === 'number') {
      ordered.initial_confidence = fm.initial_confidence;
    }
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
  // strip leading and trailing ---
  const inner = trimmed.replace(/^---\s*\n?/, '').replace(/\n?---\s*$/, '');
  const obj = load(inner) as AnyFrontmatter;
  if (!obj || typeof obj !== 'object') {
    throw new Error('frontmatter did not parse to an object');
  }
  return obj;
}

export function splitFrontmatterAndBody(
  full: string,
): { frontmatter: AnyFrontmatter; body: string } {
  if (!full.startsWith('---')) {
    throw new Error('file must start with --- frontmatter delimiter');
  }
  // Find closing '---' on its own line after the opening one.
  // Skip past the opening "---\n" then look for "\n---".
  const afterOpen = full.indexOf('\n', 3);
  if (afterOpen === -1) {
    throw new Error('frontmatter not terminated by closing ---');
  }
  const closeIdx = full.indexOf('\n---', afterOpen);
  if (closeIdx === -1) {
    throw new Error('frontmatter not terminated by closing ---');
  }
  const yaml = full.slice(0, closeIdx + 4); // include "\n---"
  const body = full.slice(closeIdx + 4).replace(/^[\r\n]+/, '');
  return { frontmatter: parseFrontmatter(yaml), body };
}
