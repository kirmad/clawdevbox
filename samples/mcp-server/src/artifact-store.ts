/**
 * artifact-store.ts
 *
 * Disk storage for "artifacts" — agent-produced renderable bundles
 * (design docs, PR reviews, walkthroughs, mermaid diagrams, …).
 *
 * Layout:
 *
 *   <workspace>/
 *     artifacts/                ← top-level, sibling of .conductor/
 *       <artifact_id>/
 *         manifest.json         ← always present
 *         <free-form files>     ← content for the renderer
 *
 * The folder name == artifact id. One artifact per folder (so a folder
 * always represents exactly one renderable view). The renderer dispatches
 * on `manifest.type`, which is matched to a `.mjs` renderer module.
 *
 * Canonical authoring flow:
 *   1. agent runs a skill that writes files into `<workspace>/artifacts/<id>/`
 *   2. agent calls `artifact.add(id, type, title, …)` to drop a manifest.json
 *      next to those files → artifact becomes visible to `artifact.list`
 *      and gets a `view_url`.
 *
 * `artifact.add` also accepts an inline `files` map as a convenience, but
 * the disk-first flow is preferred for large outputs (diffs, multi-MB
 * walkthroughs) since the MCP boundary doesn't have to serialize them.
 *
 * Artifacts are workspace-scoped. They don't bind to a recipe instance or
 * step — if a recipe needs to publish step-level artifacts the agent
 * can encode that in the artifact id (e.g. `pr-1234-step-3-walkthrough`)
 * or in `meta`. Keeping scope flat avoids GC headaches when recipes
 * complete and step ids vanish from active state.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fs-util.ts';

// ============================================================================
// Types
// ============================================================================

export interface ArtifactManifest {
  /** Folder name. Must match `/^[a-z0-9][a-z0-9._-]*$/i` per validateId. */
  id: string;
  /** Renderer discriminator. Looked up against renderer registry. */
  type: string;
  /** Human-readable title used in headers / breadcrumbs. */
  title: string;
  /** Owning workspace id. */
  workspace_id: string;
  /**
   * Optional link to a recipe instance — purely for UI grouping. Does NOT
   * affect storage (artifacts live flat under .conductor/artifacts/). The
   * renderer / dashboards can filter "show me everything this recipe run
   * produced" without making artifact lifetimes depend on recipe state.
   */
  recipe_instance_id?: string | null;
  /** Same idea for a step inside that recipe instance (opaque step id). */
  step_id?: string | null;
  /** ms since epoch when first written. */
  created_at: number;
  /** Free-form metadata interpreted by the renderer (e.g. { entry: "content.md" }). */
  meta?: Record<string, unknown>;
}

export interface ArtifactRecord {
  manifest: ArtifactManifest;
  /** Absolute path of the artifact folder. */
  dir: string;
}

// ============================================================================
// Path helpers
// ============================================================================

export function artifactsRoot(workspacePath: string): string {
  return join(workspacePath, 'artifacts');
}

export function artifactDir(workspacePath: string, id: string): string {
  return join(artifactsRoot(workspacePath), id);
}

export function artifactManifestPath(workspacePath: string, id: string): string {
  return join(artifactDir(workspacePath, id), 'manifest.json');
}

export function artifactFilePath(workspacePath: string, id: string, filename: string): string {
  return join(artifactDir(workspacePath, id), filename);
}

// ============================================================================
// Validation
// ============================================================================

const ARTIFACT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Throws if id is unsafe to use as a folder name. We disallow path separators,
 * leading dots, and characters that would let an agent escape the artifacts/
 * root via the folder name.
 */
export function validateArtifactId(id: string): void {
  if (!ARTIFACT_ID_RE.test(id)) {
    throw new Error(
      `Invalid artifact id "${id}". Must match ${ARTIFACT_ID_RE.source} (alphanumeric, dots, dashes, underscores; no leading dot/dash).`,
    );
  }
}

/** Reject filenames that would write outside the artifact folder. */
export function validateArtifactFilename(name: string): void {
  if (
    name.length === 0 ||
    name.includes('..') ||
    name.includes('/') ||
    name.includes('\\') ||
    name === 'manifest.json'
  ) {
    throw new Error(
      `Invalid artifact filename "${name}". No path separators, no traversal, and "manifest.json" is reserved.`,
    );
  }
}

// ============================================================================
// Read / write
// ============================================================================

export function readArtifact(workspacePath: string, id: string): ArtifactRecord | null {
  const dir = artifactDir(workspacePath, id);
  const manifestFile = artifactManifestPath(workspacePath, id);
  if (!existsSync(manifestFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as ArtifactManifest;
    return { manifest: parsed, dir };
  } catch {
    return null;
  }
}

export interface WriteArtifactArgs {
  workspacePath: string;
  manifest: ArtifactManifest;
  /** Filename → content. String values are written as-is (utf-8); objects are JSON.stringify'd with 2-space indent. */
  files: Record<string, string | unknown>;
}

export function writeArtifact(args: WriteArtifactArgs): void {
  validateArtifactId(args.manifest.id);
  const dir = artifactDir(args.workspacePath, args.manifest.id);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(
    artifactManifestPath(args.workspacePath, args.manifest.id),
    JSON.stringify(args.manifest, null, 2) + '\n',
  );
  for (const [name, value] of Object.entries(args.files)) {
    validateArtifactFilename(name);
    const body =
      typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2) + '\n';
    writeFileAtomic(artifactFilePath(args.workspacePath, args.manifest.id, name), body);
  }
}

export function deleteArtifact(workspacePath: string, id: string): boolean {
  const dir = artifactDir(workspacePath, id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * List all artifacts in this workspace. Returns manifests sorted by created_at
 * ascending. Silently skips folders whose manifest.json is missing or invalid.
 */
export function listArtifacts(workspacePath: string): ArtifactRecord[] {
  const root = artifactsRoot(workspacePath);
  if (!existsSync(root)) return [];
  const entries: ArtifactRecord[] = [];
  for (const name of readdirSync(root)) {
    try {
      const stat = statSync(join(root, name));
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const rec = readArtifact(workspacePath, name);
    if (rec) entries.push(rec);
  }
  entries.sort((a, b) => a.manifest.created_at - b.manifest.created_at);
  return entries;
}

/**
 * List the content files (excluding manifest.json) inside an artifact folder.
 * Returns names only — callers fetch content via artifactFilePath.
 */
export function listArtifactFiles(workspacePath: string, id: string): string[] {
  const dir = artifactDir(workspacePath, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n !== 'manifest.json');
}
