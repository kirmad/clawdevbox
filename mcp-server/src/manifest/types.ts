/**
 * manifest/types.ts
 *
 * Canonical TypeScript types for the Claude-Code-aligned plugin manifest
 * (`.claude-plugin/plugin.json`), marketplace catalog
 * (`.claude-plugin/marketplace.json`), Microsoft's `marketplace-config.json`
 * overlay, and per-plugin `agency.json` sidecar.
 *
 * Spec: docs/specs/2026-05-15-marketplace-and-plugin-schema-design.md (§3, §4).
 *
 * These types coexist with the legacy `PluginManifest` in `workspace.ts`
 * during Phase 1/2 of the migration. The legacy shape is removed in Phase 2
 * once the loader cuts over.
 */

import type { PluginTriggerType } from '../workspace.ts';
import type { PluginAgentCliEntry } from '../workspace.ts';

// ============================================================================
// Plugin manifest (§3)
// ============================================================================

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

/**
 * Microsoft `status` extension (§3.4). Surfaced in listings; `experimental`
 * renders a warning badge but does not block install.
 */
export interface PluginStatus {
  testedWith: string;
  experimental?: boolean;
  notes?: string;
}

/** Shared `{ id, file }` shape used by clawdevbox.recipes (§3.5). */
export interface PluginProvideEntry {
  id: string;
  file: string;
  cron?: string;
}

/** `clawdevbox.tools[]` entry: hostable single-file tool (§3.5). */
export interface ClawdevboxToolEntry {
  id: string;
  file: string;
  runtime?: 'node' | 'tsx' | 'python' | 'bash';
}

/**
 * `clawdevbox.daemons[]` entry: a long-running background process the
 * plugin wants the clawdevbox supervisor to keep alive.
 *
 * The daemon is upserted into the `daemons` table whenever the plugin
 * is loaded (status='enabled'); disabled when the plugin is disabled;
 * deleted when the plugin is uninstalled. The supervisor reads
 * desired-state from the same table, so this is the bridge from
 * "plugin declares X should run" to "process X is alive".
 *
 * Fields map directly to DaemonsStore.UpsertDaemonInput:
 *   - `id`               — stable id (e.g. "dmn-teams-listener"). Used
 *                          as the upsert key, so renaming = recreate.
 *   - `name`             — human-readable name in the dashboard.
 *   - `file`             — path to the script, relative to the plugin
 *                          directory. Resolved + passed as command[1].
 *   - `runtime`          — defaults to 'direct' (Node executes the script
 *                          via process.execPath). Use 'tsx' for .ts.
 *   - `env`              — base env vars; the loader merges in
 *                          per-runtime/process additions before upserting.
 *   - `restart_policy`   — optional partial overrides for the supervisor's
 *                          default policy. See RestartPolicy in
 *                          db/daemons-store.ts.
 *   - `description`      — surfaced in tooling listings.
 */
export interface ClawdevboxDaemonEntry {
  id: string;
  name: string;
  file: string;
  runtime?: 'node' | 'tsx' | 'python' | 'bash' | 'pwsh' | 'direct';
  env?: Record<string, string>;
  restart_policy?: {
    backoff_ms?: number[];
    stable_after_ms?: number;
    max_restarts?: number;
  };
  description?: string;
}

/**
 * `clawdevbox.renderers[]` entry: a `.mjs` artifact renderer module shipped
 * by a plugin. `type` matches the `artifact.type` field at resolution time.
 */
export interface PluginRendererEntry {
  type: string;
  module: string;
  description?: string;
}

/**
 * The `clawdevbox` extension subtree (§3.5). Carries every capability that
 * isn't part of Claude Code's vocabulary. Claude Code ignores unknown keys,
 * so one manifest can target both runtimes.
 *
 * Each field is polymorphic, matching Claude Code's `skills` / `agents` /
 * `commands` pattern:
 *   - `undefined` ⇒ auto-discover from the convention directory.
 *   - `string`    ⇒ scan the given relative directory.
 *   - `string[]`  ⇒ scan/include each entry (directory or single file).
 *   - `Entry[]`   ⇒ explicit list; no auto-discovery.
 *
 * See `docs/specs/2026-05-15-plugin-capability-autodiscovery-design.md`.
 */
export interface ClawdevboxExtensions {
  recipes?: string | string[] | PluginProvideEntry[];
  tools?: string | string[] | ClawdevboxToolEntry[];
  trigger_types?: string | string[] | PluginTriggerType[];
  agent_clis?: string | string[] | PluginAgentCliEntry[];
  renderers?: string | string[] | PluginRendererEntry[];
  /**
   * Long-running background processes the supervisor should keep alive
   * while the plugin is enabled. Auto-discovery is NOT supported (a
   * plugin's daemons must be enumerated explicitly to keep the
   * "what's running on my machine?" surface deliberate).
   */
  daemons?: ClawdevboxDaemonEntry[];
}

/**
 * MCP server config — matches the Claude / MCP standard shape. Permissive
 * (index signature) because the upstream spec evolves and we don't want to
 * fail manifests that carry forward-compatible fields.
 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  [key: string]: unknown;
}

/**
 * `.claude-plugin/plugin.json` — the canonical clawdevbox plugin manifest.
 *
 * Required: `name`. Everything else is optional; auto-discovery fills in
 * skills/agents/commands/mcpServers from convention-named directories when
 * the corresponding field is absent (see §3.6).
 */
export interface PluginManifest {
  $schema?: string;
  name: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];

  // Claude-discoverable component path fields. String or array of strings,
  // or (for mcpServers/hooks) inline object.
  skills?: string | string[];
  agents?: string | string[];
  commands?: string | string[];
  mcpServers?: string | { mcpServers: Record<string, McpServerConfig> } | Record<string, McpServerConfig>;
  hooks?: string | object;
  lspServers?: string | object;
  outputStyles?: string | string[];
  experimental?: {
    themes?: string | string[];
    monitors?: string | string[];
  };
  userConfig?: Record<string, unknown>;
  channels?: unknown[];
  dependencies?: unknown[];

  // Microsoft `status` extension (§3.4).
  status?: PluginStatus;

  // clawdevbox-specific capabilities (§3.5).
  clawdevbox?: ClawdevboxExtensions;

  // Engine + env requirements.
  requires?: {
    clawdevbox_version?: string;
    env?: string[];
  };
}

// ============================================================================
// agency.json (Microsoft extension, §4.4)
// ============================================================================

export interface AgencyJson {
  /**
   * Engines this plugin targets. Each entry is a lowercase kebab-case engine
   * id (e.g. `"claude"`, `"copilot"`, `"clawdevbox"`) or `"*"` for any.
   * Missing file ⇒ no filter; empty array ⇒ ship nowhere.
   */
  engines?: string[];
  category?: string;
}

// ============================================================================
// Marketplace catalog (§4.2)
// ============================================================================

export interface MarketplaceOwner {
  name: string;
  email?: string;
}

/**
 * Discriminated object form of `MarketplacePluginEntry.source`. A string
 * `source` is also allowed (relative path or git URL); see `MarketplacePluginEntry`.
 */
export type MarketplaceSourceObject =
  | { source: 'github'; repo: string; ref?: string }
  | { source: 'git'; url: string; ref?: string }
  | { source: 'path'; path: string };

export interface MarketplacePluginEntry {
  name: string;
  source: string | MarketplaceSourceObject;
  // Any plugin.json field acts as an override:
  version?: string;
  description?: string;
  author?: PluginAuthor;
  keywords?: string[];
  // Marketplace-specific fields:
  category?: string;
  strict?: boolean;
  tags?: string[];
  status?: PluginStatus;
}

export interface MarketplaceJson {
  $schema?: string;
  name: string;
  owner: MarketplaceOwner;
  description?: string;
  version?: string;
  metadata?: {
    description?: string;
    version?: string;
    pluginRoot?: string;
  };
  plugins: MarketplacePluginEntry[];
  allowCrossMarketplaceDependenciesOn?: string[];
}

// ============================================================================
// marketplace-config.json (Microsoft extension, §4.3)
// ============================================================================

export interface MarketplaceConfigShared {
  name: string;
  metadata?: { description?: string; version?: string };
  owner?: MarketplaceOwner;
}

/**
 * Repo-root `marketplace-config.json`. The `shared` slot is merged on top of
 * the marketplace.json's top-level metadata; the `clawdevbox` slot (if
 * present) is merged on top of that. Other engine slots (`claude`,
 * `copilot`, …) are ignored by clawdevbox but kept for forward compat.
 */
export interface MarketplaceConfig {
  shared: MarketplaceConfigShared;
  claude?: Partial<MarketplaceConfigShared>;
  copilot?: Partial<MarketplaceConfigShared>;
  clawdevbox?: Partial<MarketplaceConfigShared>;
  [engine: string]: unknown;
}
