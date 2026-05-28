/**
 * template-store.ts
 *
 * Disk I/O for agent-authored trigger templates and one-off auto-templates.
 * Mirrors the per-template directory layout used by plugin-shipped types:
 *   <root>/trigger-types/<id>/template.yaml
 *   <root>/trigger-types/<id>/trigger.<ext>
 *
 * Atomic writes via writeFileAtomic. Deletes go through rename-to-tomb +
 * rmSync(recursive) so a crash mid-delete leaves a recoverable .deleted-<ts>
 * sibling instead of a half-deleted directory.
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { writeFileAtomic } from './fs-util.ts';
import { mintId } from './store.ts';
import {
  globalTriggerTypesDir, oneoffTemplatesDir, projectTriggerTypesDir,
  type RegisteredTriggerType, type TriggerTypeParameter,
  type WritableScope, type Workspace,
} from './workspace.ts';
import type { TriggerRuntime } from './validators.ts';

const RUNTIME_EXT: Record<TriggerRuntime, string> = {
  node: 'js', tsx: 'ts', python: 'py', bash: 'sh',
};

export function runtimeExt(runtime: TriggerRuntime): string {
  return RUNTIME_EXT[runtime];
}

export interface TemplateManifest {
  id: string;
  file: string;
  runtime: TriggerRuntime;
  description?: string;
  default_cron?: string;
  identity_param?: string;
  accepts_webhook?: boolean;
  parameters?: TriggerTypeParameter[];
}

export interface LoadedTemplate {
  manifest: TemplateManifest;
  scriptAbs: string;
  dir: string;
  scope: 'project' | 'global';
}

function templateDirRoot(ws: Workspace, scope: WritableScope): string {
  return scope === 'project' ? projectTriggerTypesDir(ws) : globalTriggerTypesDir(ws);
}

export function templateDir(ws: Workspace, scope: WritableScope, id: string): string {
  return join(templateDirRoot(ws, scope), id);
}

export function templateExists(ws: Workspace, scope: WritableScope, id: string): boolean {
  return existsSync(join(templateDir(ws, scope, id), 'template.yaml'));
}

export function findTemplate(ws: Workspace, id: string): LoadedTemplate | null {
  for (const scope of ['project', 'global'] as const) {
    if (templateExists(ws, scope, id)) {
      const loaded = loadTemplate(ws, scope, id);
      if (loaded) return loaded;
    }
  }
  return null;
}

export function loadTemplate(
  ws: Workspace, scope: WritableScope, id: string,
): LoadedTemplate | null {
  const dir = templateDir(ws, scope, id);
  const manifestPath = join(dir, 'template.yaml');
  if (!existsSync(manifestPath)) return null;
  let manifest: TemplateManifest;
  try {
    manifest = yamlLoad(readFileSync(manifestPath, 'utf8')) as TemplateManifest;
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object') return null;
  const scriptAbs = resolveScriptAbs(dir, manifest.file);
  if (!scriptAbs) return null;
  return { manifest, scriptAbs, dir, scope };
}

function resolveScriptAbs(dir: string, file: string): string | null {
  if (typeof file !== 'string' || file.length === 0) return null;
  const abs = resolve(dir, file);
  if (!abs.startsWith(dir + sep) && abs !== dir) return null;
  return abs;
}

export interface WriteOptions {
  manifest: TemplateManifest;
  scriptContent: string;
}

export function writeTemplate(
  ws: Workspace, scope: WritableScope, opts: WriteOptions,
): { dir: string; scriptAbs: string } {
  const dir = templateDir(ws, scope, opts.manifest.id);
  mkdirSync(dir, { recursive: true });
  const scriptName = `trigger.${RUNTIME_EXT[opts.manifest.runtime]}`;
  const manifestToWrite: TemplateManifest = { ...opts.manifest, file: scriptName };
  const scriptAbs = join(dir, scriptName);
  writeFileAtomic(scriptAbs, opts.scriptContent);
  writeFileAtomic(join(dir, 'template.yaml'), yamlDump(manifestToWrite));
  return { dir, scriptAbs };
}

export function deleteTemplate(ws: Workspace, scope: WritableScope, id: string): boolean {
  const dir = templateDir(ws, scope, id);
  if (!existsSync(dir)) return false;
  const tomb = `${dir}.deleted-${Date.now()}`;
  renameSync(dir, tomb);
  try { rmSync(tomb, { recursive: true, force: true }); } catch { /* ignore */ }
  return true;
}

export function listAgentAuthoredTemplates(
  ws: Workspace, scope: WritableScope,
): LoadedTemplate[] {
  const root = templateDirRoot(ws, scope);
  if (!existsSync(root)) return [];
  let entries: string[];
  try { entries = readdirSync(root); } catch { return []; }
  const out: LoadedTemplate[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (scope === 'project' && entry === '_oneoff') continue;
    const dir = join(root, entry);
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const loaded = loadTemplate(ws, scope, entry);
    if (loaded) out.push(loaded);
  }
  return out;
}

// One-off auto-templates --------------------------------------------------

export function mintOneOffId(): string {
  const seed = mintId('oneoff').replace(/^oneoff_/, '');
  return `local.oneoff.${seed}`;
}

export interface OneOffWriteOptions {
  id: string;
  runtime: TriggerRuntime;
  scriptContent: string;
  description?: string;
}

export function writeOneOffTemplate(
  ws: Workspace, opts: OneOffWriteOptions,
): { dir: string; scriptAbs: string } {
  const dir = join(oneoffTemplatesDir(ws), opts.id);
  mkdirSync(dir, { recursive: true });
  const scriptName = `trigger.${RUNTIME_EXT[opts.runtime]}`;
  const scriptAbs = join(dir, scriptName);
  writeFileAtomic(scriptAbs, opts.scriptContent);
  const manifest: TemplateManifest = {
    id: opts.id, file: scriptName, runtime: opts.runtime,
    accepts_webhook: true,
    description: opts.description ?? `One-off trigger registered at ${new Date().toISOString()}.`,
    parameters: [],
  };
  writeFileAtomic(join(dir, 'template.yaml'), yamlDump(manifest));
  return { dir, scriptAbs };
}

export function loadOneOffTemplate(ws: Workspace, id: string): LoadedTemplate | null {
  const dir = join(oneoffTemplatesDir(ws), id);
  const manifestPath = join(dir, 'template.yaml');
  if (!existsSync(manifestPath)) return null;
  let manifest: TemplateManifest;
  try { manifest = yamlLoad(readFileSync(manifestPath, 'utf8')) as TemplateManifest; } catch { return null; }
  const scriptAbs = resolveScriptAbs(dir, manifest.file);
  if (!scriptAbs) return null;
  return { manifest, scriptAbs, dir, scope: 'project' };
}

export function deleteOneOffTemplate(ws: Workspace, id: string): boolean {
  const dir = join(oneoffTemplatesDir(ws), id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function toRegisteredType(loaded: LoadedTemplate): RegisteredTriggerType {
  return {
    ...loaded.manifest,
    source_plugin_id: '',
    scope: loaded.scope,
    file_abs: loaded.scriptAbs,
  } as unknown as RegisteredTriggerType;
}
