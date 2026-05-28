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
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
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
  PluginRendererEntry,
} from './types.ts';
import type { PluginTriggerType, PluginAgentCliEntry } from '../workspace.ts';

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

export interface ResolvedRenderer {
  type: string;
  module: string;
  absoluteFile: string;
  description?: string;
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
  renderers: ResolvedRenderer[];
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
  | 'agent_clis'
  | 'renderers';

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

  // clawdevbox extensions — polymorphic fields (`string | string[] | Entry[]`)
  // are resolved by `resolveCapability` against the per-capability convention
  // directory. Tier 3 (explicit Entry[]) bypasses auto-discovery; other shapes
  // trigger directory scans. See docs/specs/2026-05-15-plugin-capability-autodiscovery-design.md.
  const cdb = manifest.clawdevbox;
  const pluginName = manifest.name;

  const recipes = await discoverRecipes(pluginDir, cdb?.recipes, loadErrors);
  const tools = await discoverTools(pluginDir, cdb?.tools, pluginName, loadErrors);
  const triggerTypes = await discoverTriggerTypes(pluginDir, cdb?.trigger_types, pluginName, loadErrors);
  const agentClis = await discoverAgentClis(pluginDir, cdb?.agent_clis, loadErrors);
  const renderers = await discoverRenderers(pluginDir, cdb?.renderers, loadErrors);

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
    renderers,
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

// ============================================================================
// clawdevbox capability auto-discovery (spec
// docs/specs/2026-05-15-plugin-capability-autodiscovery-design.md)
//
// Every clawdevbox.* field accepts `string | string[] | Entry[]`:
//
//   - undefined ⇒ scan <pluginDir>/<defaultDir>
//   - string    ⇒ scan <pluginDir>/<value> as a single directory
//   - string[]  ⇒ for each: scan if directory, else treat as a single file
//   - Entry[]   ⇒ use as-is (Tier 3: explicit author control)
// ============================================================================

function isObjectEntryArray(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  );
}

async function resolveCapability<E>(opts: {
  manifestValue: string | string[] | E[] | undefined;
  pluginDir: string;
  defaultDir: string;
  scope: LoadErrorScope;
  errors: LoadError[];
  scanDir: (absoluteDir: string) => Promise<E[]>;
  fileToEntry?: (absoluteFile: string) => E | null;
  fromExplicit?: (entries: E[]) => E[];
}): Promise<E[]> {
  const { manifestValue, pluginDir, defaultDir, scope, errors, scanDir, fileToEntry, fromExplicit } =
    opts;

  // Tier 3: explicit Entry[] — author controls every entry.
  if (isObjectEntryArray(manifestValue)) {
    const arr = manifestValue as unknown as E[];
    return fromExplicit ? fromExplicit(arr) : [...arr];
  }

  // Tier 2b: explicit string[] — each entry is a path (dir or file).
  if (Array.isArray(manifestValue) && manifestValue.every((v) => typeof v === 'string')) {
    const out: E[] = [];
    for (const rel of manifestValue as string[]) {
      const abs = resolve(pluginDir, rel);
      if (!isUnderPlugin(abs, pluginDir)) {
        errors.push({ scope, path: rel, message: `${scope} path escapes plugin directory: ${rel}` });
        continue;
      }
      if (!existsSync(abs)) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        out.push(...(await scanDir(abs)));
      } else if (st.isFile() && fileToEntry) {
        const entry = fileToEntry(abs);
        if (entry) out.push(entry);
      }
    }
    return out;
  }

  // Tier 2a: explicit string — scan that directory in place of the default.
  if (typeof manifestValue === 'string') {
    const abs = resolve(pluginDir, manifestValue);
    if (!isUnderPlugin(abs, pluginDir)) {
      errors.push({
        scope,
        path: manifestValue,
        message: `${scope} path escapes plugin directory: ${manifestValue}`,
      });
      return [];
    }
    if (!existsSync(abs)) return [];
    return scanDir(abs);
  }

  // Tier 1: undefined — auto-discover from the convention dir if it exists.
  const abs = join(pluginDir, defaultDir);
  if (!existsSync(abs)) return [];
  return scanDir(abs);
}

/** True for filenames the auto-discovery scan should ignore (private helpers, dotfiles). */
function isSkippedFilename(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.');
}

const RUNTIME_BY_EXT: Record<string, 'tsx' | 'node' | 'python' | 'bash'> = {
  '.ts': 'tsx',
  '.js': 'node',
  '.py': 'python',
  '.sh': 'bash',
};

async function listFilesByExt(absDir: string, exts: string[]): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (isSkippedFilename(e.name)) continue;
    const ext = extname(e.name).toLowerCase();
    if (!exts.includes(ext)) continue;
    out.push(e.name);
  }
  out.sort();
  return out;
}

function relFromPlugin(pluginDir: string, abs: string): string {
  return relative(pluginDir, abs).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// 1. Recipes
// ---------------------------------------------------------------------------

async function discoverRecipes(
  pluginDir: string,
  manifestValue: string | string[] | PluginProvideEntry[] | undefined,
  errors: LoadError[],
): Promise<ResolvedRecipe[]> {
  const RECIPE_EXTS = ['.yaml', '.yml', '.json'];

  const scanDir = async (absDir: string): Promise<ResolvedRecipe[]> => {
    const files = await listFilesByExt(absDir, RECIPE_EXTS);
    return files.map((name) => {
      const abs = join(absDir, name);
      return {
        id: name.replace(/\.(ya?ml|json)$/i, ''),
        file: relFromPlugin(pluginDir, abs),
        absoluteFile: abs,
      };
    });
  };

  const fileToEntry = (abs: string): ResolvedRecipe | null => {
    const name = basename(abs);
    if (isSkippedFilename(name)) return null;
    if (!RECIPE_EXTS.includes(extname(name).toLowerCase())) return null;
    return {
      id: name.replace(/\.(ya?ml|json)$/i, ''),
      file: relFromPlugin(pluginDir, abs),
      absoluteFile: abs,
    };
  };

  const fromExplicit = (entries: PluginProvideEntry[]): ResolvedRecipe[] =>
    entries.map((r) => ({
      id: r.id,
      file: r.file,
      absoluteFile: resolve(pluginDir, r.file),
    }));

  return resolveCapability<ResolvedRecipe>({
    manifestValue: manifestValue as string | string[] | ResolvedRecipe[] | undefined,
    pluginDir,
    defaultDir: 'recipes',
    scope: 'recipes',
    errors,
    scanDir,
    fileToEntry,
    fromExplicit: (e) => fromExplicit(e as unknown as PluginProvideEntry[]),
  });
}

// ---------------------------------------------------------------------------
// 2. Hostable tools
// ---------------------------------------------------------------------------

async function discoverTools(
  pluginDir: string,
  manifestValue: string | string[] | ClawdevboxToolEntry[] | undefined,
  pluginName: string,
  errors: LoadError[],
): Promise<ResolvedTool[]> {
  const TOOL_EXTS = ['.ts', '.js', '.py', '.sh'];

  const buildAuto = (abs: string): ResolvedTool => {
    const name = basename(abs);
    const ext = extname(name).toLowerCase();
    const stem = name.slice(0, -ext.length);
    return {
      id: `${pluginName}.${stem}`,
      file: relFromPlugin(pluginDir, abs),
      absoluteFile: abs,
      runtime: RUNTIME_BY_EXT[ext],
    };
  };

  const scanDir = async (absDir: string): Promise<ResolvedTool[]> => {
    const files = await listFilesByExt(absDir, TOOL_EXTS);
    return files.map((name) => buildAuto(join(absDir, name)));
  };

  const fileToEntry = (abs: string): ResolvedTool | null => {
    const name = basename(abs);
    if (isSkippedFilename(name)) return null;
    if (!TOOL_EXTS.includes(extname(name).toLowerCase())) return null;
    return buildAuto(abs);
  };

  const fromExplicit = (entries: ClawdevboxToolEntry[]): ResolvedTool[] =>
    entries.map((t) => ({
      id: t.id,
      file: t.file,
      absoluteFile: resolve(pluginDir, t.file),
      runtime: t.runtime ?? RUNTIME_BY_EXT[extname(t.file).toLowerCase()],
    }));

  return resolveCapability<ResolvedTool>({
    manifestValue: manifestValue as string | string[] | ResolvedTool[] | undefined,
    pluginDir,
    defaultDir: 'tools',
    scope: 'tools',
    errors,
    scanDir,
    fileToEntry,
    fromExplicit: (e) => fromExplicit(e as unknown as ClawdevboxToolEntry[]),
  });
}

// ---------------------------------------------------------------------------
// 3. Trigger types (script + YAML sidecar)
// ---------------------------------------------------------------------------

const TRIGGER_SCRIPT_EXTS = ['.ts', '.js', '.py', '.sh'];
const TRIGGER_SIDECAR_SUFFIX = '.trigger.yaml';

function buildTriggerType(
  pluginDir: string,
  pluginName: string,
  scriptAbs: string,
  sidecar: Record<string, unknown>,
): PluginTriggerType {
  const scriptName = basename(scriptAbs);
  const ext = extname(scriptName).toLowerCase();
  const stem = scriptName.slice(0, -ext.length);
  const runtime = (sidecar.runtime as PluginTriggerType['runtime']) ?? RUNTIME_BY_EXT[ext];
  return {
    id: `${pluginName}.${stem}`,
    file: relFromPlugin(pluginDir, scriptAbs),
    description: typeof sidecar.description === 'string' ? sidecar.description : undefined,
    default_cron: typeof sidecar.default_cron === 'string' ? sidecar.default_cron : undefined,
    identity_param:
      typeof sidecar.identity_param === 'string' ? sidecar.identity_param : undefined,
    accepts_webhook:
      typeof sidecar.accepts_webhook === 'boolean' ? sidecar.accepts_webhook : undefined,
    parameters: Array.isArray(sidecar.parameters)
      ? (sidecar.parameters as PluginTriggerType['parameters'])
      : undefined,
    runtime,
  };
}

async function discoverTriggerTypes(
  pluginDir: string,
  manifestValue: string | string[] | PluginTriggerType[] | undefined,
  pluginName: string,
  errors: LoadError[],
): Promise<PluginTriggerType[]> {
  const scanDir = async (absDir: string): Promise<PluginTriggerType[]> => {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
    const scripts = fileNames.filter(
      (n) => !isSkippedFilename(n) && TRIGGER_SCRIPT_EXTS.includes(extname(n).toLowerCase()),
    );
    const sidecars = fileNames.filter((n) => !isSkippedFilename(n) && n.endsWith(TRIGGER_SIDECAR_SUFFIX));

    const out: PluginTriggerType[] = [];
    const scriptStems = new Set<string>();
    for (const script of scripts) {
      const ext = extname(script).toLowerCase();
      const stem = script.slice(0, -ext.length);
      scriptStems.add(stem);
      const sidecarName = `${stem}${TRIGGER_SIDECAR_SUFFIX}`;
      const sidecarAbs = join(absDir, sidecarName);
      const scriptAbs = join(absDir, script);
      if (!existsSync(sidecarAbs)) {
        errors.push({
          scope: 'trigger_types',
          path: relFromPlugin(pluginDir, scriptAbs),
          message: `trigger '${stem}' has no sidecar (${sidecarName})`,
        });
        continue;
      }
      let parsed: unknown;
      try {
        const text = await fsp.readFile(sidecarAbs, 'utf8');
        parsed = yamlLoad(text);
      } catch (err) {
        errors.push({
          scope: 'trigger_types',
          path: relFromPlugin(pluginDir, sidecarAbs),
          message: `failed to parse trigger sidecar: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push({
          scope: 'trigger_types',
          path: relFromPlugin(pluginDir, sidecarAbs),
          message: `trigger sidecar must be a YAML object`,
        });
        continue;
      }
      out.push(
        buildTriggerType(
          pluginDir,
          pluginName,
          scriptAbs,
          parsed as Record<string, unknown>,
        ),
      );
    }

    // Orphan sidecars (sidecar present, no matching script).
    for (const sc of sidecars) {
      const stem = sc.slice(0, -TRIGGER_SIDECAR_SUFFIX.length);
      if (scriptStems.has(stem)) continue;
      errors.push({
        scope: 'trigger_types',
        path: relFromPlugin(pluginDir, join(absDir, sc)),
        message: `trigger sidecar '${sc}' has no matching script (looked for ${stem}.{ts,js,py,sh})`,
      });
    }
    return out;
  };

  return resolveCapability<PluginTriggerType>({
    manifestValue,
    pluginDir,
    defaultDir: 'triggers',
    scope: 'trigger_types',
    errors,
    scanDir,
    // string[] file refs aren't meaningful here without a sidecar — skipped silently.
  });
}

// ---------------------------------------------------------------------------
// 4. Agent CLI providers
// ---------------------------------------------------------------------------

async function discoverAgentClis(
  pluginDir: string,
  manifestValue: string | string[] | PluginAgentCliEntry[] | undefined,
  errors: LoadError[],
): Promise<PluginAgentCliEntry[]> {
  const PROVIDER_EXTS = ['.mjs', '.js'];

  const buildAuto = (abs: string): PluginAgentCliEntry => {
    const name = basename(abs);
    const ext = extname(name).toLowerCase();
    const stem = name.slice(0, -ext.length);
    return {
      id: stem,
      module: relFromPlugin(pluginDir, abs),
    };
  };

  const scanDir = async (absDir: string): Promise<PluginAgentCliEntry[]> => {
    const files = await listFilesByExt(absDir, PROVIDER_EXTS);
    return files.map((name) => buildAuto(join(absDir, name)));
  };

  const fileToEntry = (abs: string): PluginAgentCliEntry | null => {
    const name = basename(abs);
    if (isSkippedFilename(name)) return null;
    if (!PROVIDER_EXTS.includes(extname(name).toLowerCase())) return null;
    return buildAuto(abs);
  };

  return resolveCapability<PluginAgentCliEntry>({
    manifestValue,
    pluginDir,
    defaultDir: 'agent-clis',
    scope: 'agent_clis',
    errors,
    scanDir,
    fileToEntry,
  });
}

// ---------------------------------------------------------------------------
// 5. Renderers
// ---------------------------------------------------------------------------

async function discoverRenderers(
  pluginDir: string,
  manifestValue: string | string[] | PluginRendererEntry[] | undefined,
  errors: LoadError[],
): Promise<ResolvedRenderer[]> {
  const RENDERER_EXTS = ['.mjs', '.js'];

  const buildAuto = (abs: string): ResolvedRenderer => {
    const name = basename(abs);
    const ext = extname(name).toLowerCase();
    const stem = name.slice(0, -ext.length);
    return {
      type: stem,
      module: relFromPlugin(pluginDir, abs),
      absoluteFile: abs,
    };
  };

  const scanDir = async (absDir: string): Promise<ResolvedRenderer[]> => {
    const files = await listFilesByExt(absDir, RENDERER_EXTS);
    return files.map((name) => buildAuto(join(absDir, name)));
  };

  const fileToEntry = (abs: string): ResolvedRenderer | null => {
    const name = basename(abs);
    if (isSkippedFilename(name)) return null;
    if (!RENDERER_EXTS.includes(extname(name).toLowerCase())) return null;
    return buildAuto(abs);
  };

  const fromExplicit = (entries: PluginRendererEntry[]): ResolvedRenderer[] =>
    entries.map((e) => ({
      type: e.type,
      module: e.module,
      absoluteFile: resolve(pluginDir, e.module),
      description: e.description,
    }));

  return resolveCapability<ResolvedRenderer>({
    manifestValue: manifestValue as string | string[] | ResolvedRenderer[] | undefined,
    pluginDir,
    defaultDir: 'renderers',
    scope: 'renderers',
    errors,
    scanDir,
    fileToEntry,
    fromExplicit: (e) => fromExplicit(e as unknown as PluginRendererEntry[]),
  });
}
