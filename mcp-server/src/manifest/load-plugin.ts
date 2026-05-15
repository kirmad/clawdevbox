/**
 * manifest/load-plugin.ts
 *
 * Load a plugin from disk using the Claude-Code-aligned
 * `.claude-plugin/plugin.json` shape (spec §3, §3.6, §3.7).
 *
 * - Manifest path: `<pluginDir>/.claude-plugin/plugin.json`. Missing,
 *   malformed, or schema-invalid manifests throw a typed `LoadPluginError`
 *   (caller catches and records a plugin-load error).
 * - Capabilities are resolved from either explicit `manifest.<field>` paths
 *   OR Claude's auto-discovery conventions (`skills/<id>/SKILL.md`,
 *   `agents/<id>.agent.md`, `commands/<id>.md`, `.mcp.json`).
 * - clawdevbox-specific capabilities (`recipes`, `tools`, `trigger_types`,
 *   `agent_clis`) come from the `manifest.clawdevbox` extension subtree.
 * - Sibling `agency.json` (Microsoft per-plugin sidecar) is loaded warn-only;
 *   malformed agency.json never blocks plugin load.
 *
 * Failures resolving individual capabilities do not block the load — each is
 * recorded as a `LoadError` and the offending entry is skipped.
 */

import { promises as fsp } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  validatePluginManifestJson,
  validateAgencyJson,
  parseSkill,
  type ValidationError,
} from '../validators.ts';
import type {
  PluginManifest,
  AgencyJson,
  McpServerConfig,
  PluginStatus,
  PluginProvideEntry,
  ClawdevboxToolEntry,
} from './types.ts';
import type { PluginTriggerType, PluginAgentCliEntry } from '../workspace.ts';

/**
 * Type-guard: a `clawdevbox.*` polymorphic field that is an array of objects
 * (Tier 3 of the spec: explicit entries). Returns false for strings,
 * string[], and undefined.
 */
function isEntryArray<E>(value: unknown): value is E[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  );
}

// ============================================================================
// Public types
// ============================================================================

export interface ResolvedSkill {
  id: string;
  dir: string;
  absoluteDir: string;
  manifestName?: string;
}

export interface ResolvedAgent {
  id: string;
  file: string;
  absoluteFile: string;
}

export interface ResolvedCommand {
  id: string;
  file: string;
  absoluteFile: string;
}

export interface ResolvedRecipe {
  id: string;
  file: string;
  absoluteFile: string;
}

export interface ResolvedTool {
  id: string;
  file: string;
  absoluteFile: string;
  runtime?: string;
}

export interface ResolvedCapabilities {
  skills: ResolvedSkill[];
  agents: ResolvedAgent[];
  commands: ResolvedCommand[];
  mcpServers: Record<string, McpServerConfig>;
  hooks?: object;
  recipes: ResolvedRecipe[];
  tools: ResolvedTool[];
  triggerTypes: PluginTriggerType[];
  agentClis: PluginAgentCliEntry[];
  status?: PluginStatus;
}

export type LoadErrorScope =
  | 'manifest'
  | 'agency'
  | 'skills'
  | 'agents'
  | 'commands'
  | 'mcp'
  | 'hooks'
  | 'recipes'
  | 'tools'
  | 'trigger_types'
  | 'agent_clis';

export interface LoadError {
  scope: LoadErrorScope;
  message: string;
  path?: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  agencyJson?: AgencyJson;
  capabilities: ResolvedCapabilities;
  loadErrors: LoadError[];
}

export type LoadPluginErrorCode =
  | 'MISSING_MANIFEST'
  | 'INVALID_MANIFEST_JSON'
  | 'INVALID_MANIFEST_SHAPE';

export class LoadPluginError extends Error {
  readonly code: LoadPluginErrorCode;
  readonly validationErrors?: ValidationError[];
  readonly path?: string;
  constructor(
    code: LoadPluginErrorCode,
    message: string,
    opts?: { validationErrors?: ValidationError[]; path?: string },
  ) {
    super(message);
    this.name = 'LoadPluginError';
    this.code = code;
    this.validationErrors = opts?.validationErrors;
    this.path = opts?.path;
  }
}

// ============================================================================
// Entry point
// ============================================================================

export async function loadPluginFromDir(pluginDir: string): Promise<LoadedPlugin> {
  const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) {
    throw new LoadPluginError(
      'MISSING_MANIFEST',
      `plugin manifest not found at ${manifestPath}`,
      { path: manifestPath },
    );
  }

  const rawText = await fsp.readFile(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LoadPluginError(
      'INVALID_MANIFEST_JSON',
      `failed to parse plugin.json: ${msg}`,
      { path: manifestPath },
    );
  }

  const validation = validatePluginManifestJson(parsed);
  if (validation.length > 0) {
    const summary = validation
      .slice(0, 3)
      .map((e) => `${e.path}: ${e.message}`)
      .join('; ');
    throw new LoadPluginError(
      'INVALID_MANIFEST_SHAPE',
      `plugin.json failed validation: ${summary}`,
      { validationErrors: validation, path: manifestPath },
    );
  }

  const manifest = parsed as PluginManifest;
  const loadErrors: LoadError[] = [];

  // ---- agency.json (warn-only) ---------------------------------------------
  let agencyJson: AgencyJson | undefined;
  const agencyPath = join(pluginDir, 'agency.json');
  if (existsSync(agencyPath)) {
    try {
      const text = await fsp.readFile(agencyPath, 'utf8');
      const agencyParsed = JSON.parse(text);
      const agencyErrs = validateAgencyJson(agencyParsed);
      if (agencyErrs.length > 0) {
        loadErrors.push({
          scope: 'agency',
          path: agencyPath,
          message: `agency.json failed validation: ${agencyErrs
            .map((e) => `${e.path}: ${e.message}`)
            .join('; ')}`,
        });
      } else {
        agencyJson = agencyParsed as AgencyJson;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadErrors.push({
        scope: 'agency',
        path: agencyPath,
        message: `failed to read/parse agency.json: ${msg}`,
      });
    }
  }

  // ---- Capabilities --------------------------------------------------------
  const skills = await resolveSkills(pluginDir, manifest.skills, loadErrors);
  const agents = await resolveAgents(pluginDir, manifest.agents, loadErrors);
  const commands = await resolveCommands(pluginDir, manifest.commands, loadErrors);
  const mcpServers = await resolveMcpServers(pluginDir, manifest.mcpServers, loadErrors);
  const hooks = await resolveHooks(pluginDir, manifest.hooks, loadErrors);

  // clawdevbox extensions — pass-through (file existence is a runtime concern).
  // NOTE: the polymorphic `string | string[] | Entry[]` shapes are fully
  // resolved by the auto-discovery code path added later. For now we treat
  // only the explicit Entry[] case (Tier 3) and leave the other shapes as
  // empty until that lands.
  const cdb = manifest.clawdevbox;
  const recipesIn = isEntryArray<PluginProvideEntry>(cdb?.recipes) ? cdb!.recipes as PluginProvideEntry[] : [];
  const toolsIn = isEntryArray<ClawdevboxToolEntry>(cdb?.tools) ? cdb!.tools as ClawdevboxToolEntry[] : [];
  const triggerTypesIn = isEntryArray<PluginTriggerType>(cdb?.trigger_types) ? cdb!.trigger_types as PluginTriggerType[] : [];
  const agentClisIn = isEntryArray<PluginAgentCliEntry>(cdb?.agent_clis) ? cdb!.agent_clis as PluginAgentCliEntry[] : [];

  const recipes: ResolvedRecipe[] = recipesIn.map((r) => ({
    id: r.id,
    file: r.file,
    absoluteFile: resolve(pluginDir, r.file),
  }));
  const tools: ResolvedTool[] = toolsIn.map((t) => ({
    id: t.id,
    file: t.file,
    absoluteFile: resolve(pluginDir, t.file),
    runtime: t.runtime,
  }));
  const triggerTypes: PluginTriggerType[] = [...triggerTypesIn];
  const agentClis: PluginAgentCliEntry[] = [...agentClisIn];

  const capabilities: ResolvedCapabilities = {
    skills,
    agents,
    commands,
    mcpServers,
    hooks,
    recipes,
    tools,
    triggerTypes,
    agentClis,
    status: manifest.status,
  };

  return { manifest, agencyJson, capabilities, loadErrors };
}

// ============================================================================
// Skills (§3.6, §3.7) — directory shape `skills/<id>/SKILL.md`.
// ============================================================================

async function resolveSkills(
  pluginDir: string,
  field: string | string[] | undefined,
  errors: LoadError[],
): Promise<ResolvedSkill[]> {
  const roots = pathsFromField(field, ['skills']);
  const out: ResolvedSkill[] = [];
  for (const rel of roots) {
    const root = resolve(pluginDir, rel);
    if (!isUnderPlugin(root, pluginDir)) {
      errors.push({ scope: 'skills', path: rel, message: `skills path escapes plugin directory: ${rel}` });
      continue;
    }
    if (!existsSync(root)) {
      // Auto-discovery: a missing default `skills/` is fine. Explicit paths
      // that don't exist are silently skipped (matches Claude's leniency).
      continue;
    }
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (err) {
      errors.push({
        scope: 'skills',
        path: rel,
        message: `failed to read skills dir: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const skillDir = join(root, id);
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      // Parse frontmatter to validate name === <directory-name>.
      let manifestName: string | undefined;
      try {
        const text = await fsp.readFile(skillFile, 'utf8');
        const parsed = parseSkill(text);
        if (parsed.ok) {
          const fmName = parsed.value.frontmatter.name;
          if (typeof fmName === 'string') {
            manifestName = fmName;
            if (fmName !== id) {
              errors.push({
                scope: 'skills',
                path: skillFile,
                message: `skill frontmatter.name '${fmName}' does not match directory name '${id}'`,
              });
              continue;
            }
          }
        }
      } catch {
        // ignore — capability still registers; downstream skill.read surfaces errors
      }
      out.push({
        id,
        dir: rel === '.' ? id : `${rel}/${id}`,
        absoluteDir: skillDir,
        manifestName,
      });
    }
  }
  return out;
}

// ============================================================================
// Agents (§3.6) — `agents/<id>.agent.md`.
// ============================================================================

async function resolveAgents(
  pluginDir: string,
  field: string | string[] | undefined,
  errors: LoadError[],
): Promise<ResolvedAgent[]> {
  return resolveFileCapability(pluginDir, field, ['agents'], '.agent.md', 'agents', errors);
}

// ============================================================================
// Commands (§3.6) — `commands/<id>.md`.
// ============================================================================

async function resolveCommands(
  pluginDir: string,
  field: string | string[] | undefined,
  errors: LoadError[],
): Promise<ResolvedCommand[]> {
  return resolveFileCapability(pluginDir, field, ['commands'], '.md', 'commands', errors);
}

async function resolveFileCapability(
  pluginDir: string,
  field: string | string[] | undefined,
  defaults: string[],
  suffix: string,
  scope: LoadErrorScope,
  errors: LoadError[],
): Promise<Array<{ id: string; file: string; absoluteFile: string }>> {
  // If the field points at a file (`*.md`), treat it as a single file
  // capability. Otherwise treat it as a directory to scan.
  const items = pathsFromField(field, defaults);
  const out: Array<{ id: string; file: string; absoluteFile: string }> = [];
  for (const rel of items) {
    const abs = resolve(pluginDir, rel);
    if (!isUnderPlugin(abs, pluginDir)) {
      errors.push({ scope, path: rel, message: `${scope} path escapes plugin directory: ${rel}` });
      continue;
    }
    if (!existsSync(abs)) continue;
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isFile() && abs.endsWith(suffix)) {
      out.push({
        id: deriveId(basename(abs), suffix),
        file: rel,
        absoluteFile: abs,
      });
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      errors.push({
        scope,
        path: rel,
        message: `failed to read ${scope} dir: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(suffix)) continue;
      out.push({
        id: deriveId(entry.name, suffix),
        file: `${rel}/${entry.name}`,
        absoluteFile: join(abs, entry.name),
      });
    }
  }
  return out;
}

function deriveId(filename: string, suffix: string): string {
  return filename.slice(0, filename.length - suffix.length);
}

// ============================================================================
// MCP servers (§3.6) — `.mcp.json` or inline.
// ============================================================================

async function resolveMcpServers(
  pluginDir: string,
  field: PluginManifest['mcpServers'],
  errors: LoadError[],
): Promise<Record<string, McpServerConfig>> {
  let raw: unknown;
  let sourcePath: string | undefined;
  if (typeof field === 'string') {
    const abs = resolve(pluginDir, field);
    if (!isUnderPlugin(abs, pluginDir)) {
      errors.push({ scope: 'mcp', path: field, message: `mcpServers path escapes plugin directory: ${field}` });
      return {};
    }
    if (!existsSync(abs)) return {};
    sourcePath = abs;
    try {
      raw = JSON.parse(await fsp.readFile(abs, 'utf8'));
    } catch (err) {
      errors.push({
        scope: 'mcp',
        path: abs,
        message: `failed to parse mcpServers JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return {};
    }
  } else if (field && typeof field === 'object') {
    raw = field;
  } else {
    // Auto-discovery: <pluginDir>/.mcp.json
    const auto = join(pluginDir, '.mcp.json');
    if (!existsSync(auto)) return {};
    sourcePath = auto;
    try {
      raw = JSON.parse(await fsp.readFile(auto, 'utf8'));
    } catch (err) {
      errors.push({
        scope: 'mcp',
        path: auto,
        message: `failed to parse .mcp.json: ${err instanceof Error ? err.message : String(err)}`,
      });
      return {};
    }
  }

  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  // Accept both `{ mcpServers: {...} }` and flat `{ <id>: {...} }`.
  let inner: Record<string, unknown>;
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    inner = obj.mcpServers as Record<string, unknown>;
  } else {
    inner = obj;
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [id, cfg] of Object.entries(inner)) {
    if (cfg && typeof cfg === 'object' && typeof (cfg as Record<string, unknown>).command === 'string') {
      out[id] = cfg as McpServerConfig;
    } else {
      errors.push({
        scope: 'mcp',
        path: sourcePath,
        message: `mcpServers.${id} is missing required 'command' string`,
      });
    }
  }
  return out;
}

// ============================================================================
// Hooks (§3.6) — load only, no firing.
// ============================================================================

async function resolveHooks(
  pluginDir: string,
  field: PluginManifest['hooks'],
  errors: LoadError[],
): Promise<object | undefined> {
  if (field && typeof field === 'object') return field as object;
  if (typeof field !== 'string') return undefined;
  const abs = resolve(pluginDir, field);
  if (!isUnderPlugin(abs, pluginDir)) {
    errors.push({ scope: 'hooks', path: field, message: `hooks path escapes plugin directory: ${field}` });
    return undefined;
  }
  if (!existsSync(abs)) return undefined;
  try {
    const parsed = JSON.parse(await fsp.readFile(abs, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed as object;
    return undefined;
  } catch (err) {
    errors.push({
      scope: 'hooks',
      path: abs,
      message: `failed to parse hooks JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function pathsFromField(
  field: string | string[] | undefined,
  defaults: string[],
): string[] {
  if (typeof field === 'string') return [field];
  if (Array.isArray(field)) return field.filter((s) => typeof s === 'string');
  return defaults;
}

function isUnderPlugin(abs: string, pluginDir: string): boolean {
  if (isAbsolute(abs) === false) return false;
  const root = resolve(pluginDir);
  const target = resolve(abs);
  if (target === root) return true;
  return target.startsWith(root + sep);
}

// Suppress unused-import warning for dirname (kept for future hook resolution).
void dirname;
