/**
 * tools/recipe.ts
 *
 * Implements recipe.list / read / upsert / delete.
 * - File-backed: reads/writes `.clawdevbox/recipes/<id>.yaml` (project),
 *   `~/.clawdevbox/recipes/<id>.yaml` (global), and looks up plugin recipes
 *   through the manifest's `provides.recipes` list.
 * - Scope semantics from spec §10.4: project shadows plugin shadows global.
 * - Plugin scope is read-only (writes return PLUGIN_SCOPE_READONLY).
 * - Shape validation per spec §7.4 happens server-side before disk writes.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { dump as yamlDump } from 'js-yaml';
import {
  hasSession as ptyHasSession,
  killPty as ptyKill,
  listSessions as ptyListSessions,
} from '../pty-registry.ts';
import { getTerminalServer } from '../terminal-server.ts';
import { writeFileAtomic } from '../fs-util.ts';
import {
  readRecipeInstance,
  writeRecipeInstance,
  mintRecipeInstanceId,
  type RecipeInstance,
  type RecipeInstanceStatus,
} from '../recipe-instances-store.ts';
import { resolveConfig } from '../config.ts';
import {
  ensureWritableScope,
  listAllInScope,
  notFound,
  resolveRead,
  structuredError,
  validationError,
} from '../scope.ts';
import { parseRecipeSource, validateRecipeSource } from '../validators.ts';
import { recipePath, validateId, type Workspace } from '../workspace.ts';
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  resolveWorkspacesRoot,
} from '../workspaces-store.ts';
import { getDatabase } from '../db/index.ts';
import {
  resolveWorkspaceContext,
  resolveRecipeInstanceId,
  resolveAgentSessionId,
  type ResolveExtra,
} from '../context-resolver.ts';
import { emitChange } from '../event-bus.ts';
import { logger } from '../logger.ts';
import {
  ToolErrorBox,
  updateStatusImpl,
  updateStepsImpl,
  type UpdateStatusOpts,
  type UpdateStepsOpts,
} from '../recipe-step-tools.ts';
import type { RecipeStepStatus, Step } from '../db/recipe-steps-store.ts';

const scopeFilter = z
  .enum(['project', 'global', 'all'])
  .or(z.string().regex(/^plugin:[a-z][a-z0-9-]*$/, 'plugin:<id>'))
  .optional()
  .describe("'project' | 'plugin:<id>' | 'global' | 'all' (default 'all').");

const writableScope = z
  .enum(['project', 'global'])
  .or(z.string().regex(/^plugin:[a-z][a-z0-9-]*$/, 'plugin:<id> (will be rejected)'))
  .describe("Write target. Plugin scope is rejected with PLUGIN_SCOPE_READONLY.");

export function registerRecipeEntries(ws: Workspace): void {
  // -- recipe.list ----------------------------------------------------------
  defineTool({
    name: 'recipe.list',
    description: 'List recipes across scopes (spec §6.1 + §10.4). Project shadows plugin shadows global on id collision in `all` mode; the listing reports every (id, scope) pair so customizations are visible.',
    parameters: z.object({
        scope: scopeFilter,
        search: z
          .string()
          .min(1)
          .optional()
          .describe('Substring filter against id, name, or description.'),
      }),
    handler: async (args) => {
      const scope = (args.scope ?? 'all') as 'project' | 'global' | 'all' | `plugin:${string}`;
      const entries = listAllInScope(ws, scope, 'recipe', recipePath);
      const recipes = entries.map((e) => {
        const source = safeRead(e.path);
        const parsed = source ? safeParse(source) : null;
        return {
          id: e.id,
          scope: e.scope,
          name: pickString(parsed, 'name') ?? e.id,
          description: pickString(parsed, 'description') ?? '',
          kind: pickString(parsed, 'kind'),
          mcp_servers: Array.isArray((parsed as Record<string, unknown> | null)?.mcp_servers)
            ? ((parsed as Record<string, unknown>).mcp_servers as string[])
            : undefined,
          step_count: Array.isArray((parsed as Record<string, unknown> | null)?.steps)
            ? ((parsed as Record<string, unknown>).steps as unknown[]).length
            : 0,
        };
      });
      const filtered = args.search
        ? recipes.filter((r) => {
            const q = args.search!.toLowerCase();
            return (
              r.id.toLowerCase().includes(q) ||
              (r.name ?? '').toLowerCase().includes(q) ||
              (r.description ?? '').toLowerCase().includes(q)
            );
          })
        : recipes;

      return {
        content: [{ type: 'text', text: `Found ${filtered.length} recipe(s).` }],
        structuredContent: { recipes: filtered, count: filtered.length },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- recipe.read ----------------------------------------------------------
  defineTool({
    name: 'recipe.read',
    description: 'Read a recipe by id, with scope precedence project → plugin → global (spec §10.4). Returns raw YAML + parsed object + the scope it resolved from.',
    parameters: z.object({
        id: z.string().min(1).describe('Recipe id ([a-z][a-z0-9-]*).'),
        scope: scopeFilter,
      }),
    handler: async (args) => {
      const idCheck = validateId(args.id);
      if (!idCheck.ok) return structuredError('INVALID_ID', idCheck.message!);
      const scope = (args.scope ?? 'all') as 'project' | 'global' | 'all' | `plugin:${string}`;
      const hit = resolveRead(ws, scope, 'recipe', args.id, recipePath);
      if (!hit) return notFound('recipe', args.id);
      const parsed = safeParse(hit.source);
      return {
        content: [{ type: 'text', text: `recipe ${args.id} [scope=${hit.scope}]` }],
        structuredContent: {
          id: args.id,
          scope: hit.scope,
          source: hit.source,
          parsed,
        },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- recipe.upsert --------------------------------------------------------
  defineTool({
    name: 'recipe.upsert',
    description: [
      'Create or update a recipe template (TaskDock-shape, spec §6.2 + §7.4). Recipes are reusable multi-step pipelines that agents execute via `recipe.begin`; each step has a stable id, a human-readable goal, and (optionally) full agent instructions.',
      '',
      'Plugin scope is read-only — copy to project to customize.',
      '',
      '====================================================================',
      'RECIPE BODY SHAPE — required fields:',
      '====================================================================',
      '  id:              kebab-case recipe id (must match the `id` arg).',
      '  name:            short display name shown in recipe.list.',
      '  description:     1-3 sentence summary of what the recipe does.',
      '  kind:            workitem | pr_review | incident | epic | custom',
      '  default_client:  copilot | claude | echo-stub (which CLI runs it)',
      '  mcp_servers:     [array of MCP server ids the recipe needs]',
      '  steps:           ordered array of step objects (see below)',
      '',
      '====================================================================',
      'STEP SHAPE — fields per item in `steps[]`:',
      '====================================================================',
      '  id:              REQUIRED kebab-case id, unique within this recipe.',
      '                   Used by recipe.steps.update_status to address each',
      '                   step. Example: "fetch-context", "design-gate".',
      '',
      '  goal:            REQUIRED ≤ 200 char HUMAN-READABLE TL;DR.',
      '                   Surfaced as the step title in the SPA UI; the user',
      '                   reads this to understand at a glance what the step',
      '                   does. Be terse and concrete. Example:',
      '                   "Fetch work item details and load related memory"',
      '                   NOT: "Phase 1 — Intake + memory load. Read the WI',
      '                        via `ado.get_work_item(...)` and capture title,',
      '                        description, acceptance criteria..."',
      '                   (Back-compat: long goals > 200 chars are auto-',
      '                   promoted into ai_instructions and the first',
      '                   sentence/line becomes the short goal.)',
      '',
      '  ai_instructions: OPTIONAL full agent-facing prompt. The detailed',
      '                   instructions the executing agent reads to perform',
      '                   the step. Can be multi-paragraph (≤ 16000 chars).',
      '                   Reference specific tools, commands, and skills.',
      '                   The SPA renders this in a collapsible "Agent',
      '                   instructions" panel beneath the goal so the user',
      '                   can drill in without losing scannability.',
      '                   Omit when the step is purely informational/gate-',
      '                   only (no agent execution required).',
      '',
      '  depends:         OPTIONAL array of step ids this step waits on.',
      '                   Enforces topological order in the step machine.',
      '',
      '  params:          OPTIONAL array of param declarations (spec §7.4).',
      '  artifacts:       OPTIONAL array of artifact declarations.',
      '  triggers:        OPTIONAL array of triggers this step registers.',
      '',
      '====================================================================',
      'EXAMPLE — a small 2-step recipe:',
      '====================================================================',
      '  id: cleanup-stale-branches',
      '  name: "Prune merged remote branches"',
      '  description: >',
      '    Delete branches that have already been merged to main.',
      '    Idempotent — safe to re-run.',
      '  kind: custom',
      '  default_client: copilot',
      '  mcp_servers: [clawdevbox]',
      '  steps:',
      '    - id: scan',
      '      goal: "List branches merged into main"',
      '      ai_instructions: |',
      '        Run `git branch --merged main` and parse the output.',
      '        Exclude `main`, `master`, and any branch matching',
      '        the pattern `release/*`. Save the list to working memory',
      '        for the next step to consume.',
      '    - id: prune',
      '      goal: "Delete each merged branch (with confirmation)"',
      '      ai_instructions: |',
      '        For each branch from step `scan`, ask the user via',
      '        approval.request before deleting. On confirmation, run',
      '        `git branch -d <branch>` and `git push origin :<branch>`.',
      '        On rejection, skip and log.',
      '      depends: [scan]',
      '',
      'Format note: `format` selects the on-disk encoding (yaml default; json',
      'also supported). Whichever format you pick, the sibling file in the',
      'other format is atomically removed so each recipe lives in exactly',
      'one extension.',
    ].join('\n'),
    parameters: z.object({
        id: z.string().min(1).describe('Recipe id; must match [a-z][a-z0-9-]* and equal the `id` field in the body.'),
        scope: writableScope,
        source: z.string().min(1).describe(
          'Full YAML or JSON body of the recipe. See the tool description for the required shape — top-level fields plus a `steps[]` array where each step has id + goal (≤200 char TL;DR) + optional ai_instructions (full agent prompt) + optional depends/params/artifacts/triggers.',
        ),
        format: z
          .enum(['yaml', 'json'])
          .optional()
          .describe("On-disk format. Default 'yaml' writes <id>.yaml; 'json' writes <id>.json."),
      }),
    handler: async (args) => {
      const idCheck = validateId(args.id);
      if (!idCheck.ok) return structuredError('INVALID_ID', idCheck.message!);
      const guard = ensureWritableScope(args.scope);
      if (guard) return guard;

      const validation = validateRecipeSource(args.source);
      if (!validation.ok) return validationError(validation.errors);

      // Ensure id-in-body matches the id arg
      const parsed = safeParse(args.source) as Record<string, unknown> | null;
      if (parsed && parsed.id !== args.id) {
        return validationError([
          {
            path: 'id',
            code: 'ID_MISMATCH',
            message: `Recipe body's id (${JSON.stringify(parsed.id)}) does not match upsert id (${JSON.stringify(args.id)}).`,
          },
        ]);
      }

      const format = (args.format ?? 'yaml') as 'yaml' | 'json';
      const dir = dirname(recipePath(ws, args.scope as 'project' | 'global', args.id));
      const target = join(dir, `${args.id}.${format}`);
      const body =
        format === 'json'
          ? JSON.stringify(parsed ?? {}, null, 2) + '\n'
          : yamlDump(parsed ?? {});
      writeFileAtomic(target, body);

      // Remove any sibling file in the other format so a single recipe id
      // never resolves through two extensions simultaneously.
      const otherExts = format === 'yaml' ? ['json'] : ['yaml', 'yml'];
      const removedPaths: string[] = [];
      for (const ext of otherExts) {
        const sibling = join(dir, `${args.id}.${ext}`);
        if (existsSync(sibling)) {
          try {
            unlinkSync(sibling);
            removedPaths.push(sibling);
          } catch {
            // best-effort
          }
        }
      }

      // Lenient default_client check (spec §7.5): upsert tolerates references
      // to providers that aren't installed yet (e.g. a plugin scheduled for
      // later install). We surface a warning but don't fail the write.
      const warnings: Array<{ code: string; message: string; field: string; value: unknown }> = [];
      const declaredClient = parsed && typeof parsed.default_client === 'string' ? parsed.default_client : null;
      if (declaredClient && !ws.agentCliProviders.has(declaredClient)) {
        const available = [...ws.agentCliProviders.entries()]
          .filter(([, p]) => !p.internal)
          .map(([id]) => id);
        warnings.push({
          code: 'UNKNOWN_AGENT_CLI',
          field: 'default_client',
          value: declaredClient,
          message: `default_client '${declaredClient}' is not currently registered (available: ${available.join(', ') || '<none>'}). The recipe was written; install the provider before running it.`,
        });
      }

      // Same lenient pattern for `agent`: the recipe can reference an
      // agent persona that's defined in a plugin not yet installed.
      // We warn but don't block the write.
      const declaredAgent = parsed && typeof parsed.agent === 'string' ? parsed.agent : null;
      if (declaredAgent) {
        const knownAgents = new Set<string>();
        for (const plugin of ws.plugins.values()) {
          for (const a of plugin.capabilities.agents ?? []) knownAgents.add(a.id);
        }
        if (!knownAgents.has(declaredAgent)) {
          warnings.push({
            code: 'UNKNOWN_AGENT',
            field: 'agent',
            value: declaredAgent,
            message: `agent '${declaredAgent}' is not currently registered (available: ${[...knownAgents].sort().join(', ') || '<none>'}). The recipe was written; install the plugin that ships this agent before running it.`,
          });
        }
      }

      return {
        content: [{ type: 'text', text: `Wrote recipe ${args.id} to ${args.scope} scope (${format}).` }],
        structuredContent: {
          id: args.id,
          scope: args.scope,
          path: target,
          format,
          removed_siblings: removedPaths,
          warnings,
        },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- recipe.delete --------------------------------------------------------
  defineTool({
    name: 'recipe.delete',
    description: 'Delete a recipe from project or global scope. Plugin scope is read-only.',
    parameters: z.object({
        id: z.string().min(1),
        scope: writableScope,
      }),
    handler: async (args) => {
      const guard = ensureWritableScope(args.scope);
      if (guard) return guard;
      const target = recipePath(ws, args.scope as 'project' | 'global', args.id);
      const dir = dirname(target);
      const candidates = [target, join(dir, `${args.id}.yml`), join(dir, `${args.id}.json`)];
      const removed: string[] = [];
      for (const p of candidates) {
        if (existsSync(p)) {
          try {
            unlinkSync(p);
            removed.push(p);
          } catch {
            // best-effort
          }
        }
      }
      if (removed.length === 0) return notFound('recipe', args.id);
      return {
        content: [{ type: 'text', text: `Deleted recipe ${args.id} from ${args.scope} scope.` }],
        structuredContent: { id: args.id, scope: args.scope, path: target, removed },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- recipe.begin ---------------------------------------------------------
  // Agent-executes-recipe model (new in 2026-06):
  //
  // The CALLING agent — not a child — executes the recipe. recipe.begin
  // just records the start of a run: it mints a recipe-instance row,
  // materializes the declared steps into the DB, and returns the
  // recipe_instance_id + initial step list. The agent then iterates the
  // steps in its own session by calling recipe.steps.update_status (and
  // optionally artifact.add) with the returned recipe_instance_id.
  //
  // No agent CLI is spawned by recipe.begin. No prompt is delivered. No
  // workspace is freshly created unless the caller asks for one — by
  // default the recipe runs in the caller's current workspace context.
  //
  // For collaboration (multiple CLIs working on the same instance): the
  // caller hands the returned recipe_instance_id to other agents (via
  // prompts, dispatch, inbox cards, etc.). Each agent calls update_status
  // with the same id. The step machine's monotonic transitions + DB row
  // locking give first-writer-wins "claim" semantics for free.
  //
  // Replaces the deleted recipe.run tool, which spawned a child agent and
  // tried to propagate identity via HTTP headers (fragile when wrappers
  // like agency redeclared the MCP server entry).
  defineTool({
    name: 'recipe.begin',
    description: 'Start executing a recipe IN THE CALLING AGENT\'S SESSION. Creates a recipe-instance row, materializes the declared steps into the DB, and returns the recipe_instance_id plus the initial step list. The calling agent then iterates the steps itself using recipe.steps.update_status (status: running → done/failed/skipped) with the returned recipe_instance_id. For multi-agent collaboration, hand the returned recipe_instance_id to other agents (via prompts, dispatch, inbox) — they call update_status with the same id. First-writer-wins via the monotonic step machine. Specify the recipe by either `template_id` (load saved recipe via scope chain) or inline `source` YAML.',
    parameters: z.object({
      template_id: z
        .string()
        .min(1)
        .optional()
        .describe('Saved recipe id to load via the scope chain (project → plugin → global). Mutually exclusive with `source`.'),
      source: z
        .string()
        .min(1)
        .optional()
        .describe('Inline recipe YAML for an ad-hoc run (not persisted). Must include `id`, `name`, `description`. Mutually exclusive with `template_id`.'),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional parameter overrides recorded on the instance.'),
      workspace_id: z
        .string()
        .min(1)
        .optional()
        .describe('Workspace to bind the instance to. Defaults to the calling agent\'s current workspace (resolved via context).'),
      name: z
        .string()
        .min(1)
        .optional()
        .describe('Optional display name for this run (overrides the recipe\'s `name` field for the instance only).'),
      attach_to_inbox_item_id: z
        .string()
        .min(1)
        .optional()
        .describe('Optional inbox item id to associate this run with.'),
    }),
    handler: async (args, extra) => {
      // 1. Validate args — exactly one of template_id / source.
      const hasId = typeof args.template_id === 'string' && args.template_id.length > 0;
      const hasSource = typeof args.source === 'string' && args.source.length > 0;
      if (hasId && hasSource) {
        return structuredError(
          'INVALID_REQUEST',
          'Pass either `template_id` (load saved recipe) or `source` (inline YAML), not both.',
        );
      }
      if (!hasId && !hasSource) {
        return structuredError(
          'INVALID_REQUEST',
          'Either `template_id` (load saved recipe) or `source` (inline YAML) is required.',
        );
      }

      // 2. Resolve recipe — id-load or inline-parse.
      let recipeId: string;
      let recipeSnapshot: string;
      let isAdhoc: boolean;
      let parsedRecipe: Record<string, unknown> | null = null;
      if (hasId) {
        const idCheck = validateId(args.template_id!);
        if (!idCheck.ok) return structuredError('INVALID_ID', idCheck.message!);
        const hit = resolveRead(ws, 'all', 'recipe', args.template_id!, recipePath);
        if (!hit) return notFound('recipe', args.template_id!);
        recipeId = args.template_id!;
        recipeSnapshot = hit.source;
        isAdhoc = false;
        try {
          const p = parseRecipeSource(hit.source);
          if (p && typeof p === 'object' && !Array.isArray(p)) {
            parsedRecipe = p as Record<string, unknown>;
          }
        } catch {
          // Saved recipe failed to parse — surface the failure rather than
          // silently materializing zero steps.
          return structuredError(
            'RECIPE_PARSE_FAILED',
            `Saved recipe ${args.template_id} failed to parse as YAML.`,
            { template_id: args.template_id },
          );
        }
      } else {
        const validation = validateRecipeSource(args.source!);
        if (!validation.ok) return validationError(validation.errors);
        const parsed = parseRecipeSource(args.source!) as { id: string } & Record<string, unknown>;
        recipeId = parsed.id;
        recipeSnapshot = args.source!;
        isAdhoc = true;
        parsedRecipe = parsed;
      }

      // 3. Resolve / create workspace.
      // Default: use the calling agent's workspace (via context-resolver
      // chain). Explicit workspace_id arg always wins. We do NOT auto-mint
      // a new workspace here — recipe.begin runs IN-PROCESS for the calling
      // agent, so its workspace is the natural binding. Callers that want
      // a fresh workspace (e.g. an orchestrator wanting per-run isolation)
      // can pass workspace_id explicitly after a `workspace.create` call.
      const workspacesRoot = resolveWorkspacesRoot();
      let workspaceInfo: { id: string; path: string };
      if (args.workspace_id) {
        const wsInfo = getWorkspace(workspacesRoot, args.workspace_id);
        if (!wsInfo) {
          return structuredError(
            'WORKSPACE_NOT_FOUND',
            `Workspace ${args.workspace_id} not found in registry.`,
            { id: args.workspace_id },
          );
        }
        workspaceInfo = { id: wsInfo.id, path: wsInfo.path };
      } else {
        const resolved = resolveWorkspaceContext(extra as ResolveExtra | undefined, {});
        if (!resolved.ok) return resolved.error;
        workspaceInfo = {
          id: resolved.ctx.workspaceInfo.id,
          path: resolved.ctx.workspaceInfo.path,
        };
      }

      // 4. Mint instance + write the instance row (file + DB mirror).
      const instanceId = mintRecipeInstanceId();
      const instance: RecipeInstance = {
        id: instanceId,
        recipe_id: isAdhoc ? `__adhoc_${instanceId}` : recipeId,
        recipe_snapshot: recipeSnapshot,
        workspace_id: workspaceInfo.id,
        workspace_path: workspaceInfo.path,
        // No prompt — agent executes inline. Empty string keeps disk JSON
        // schema consistent with legacy readers.
        prompt: '',
        params: args.params ?? {},
        // Bookkeeping: there's no spawned CLI, but the calling agent IS the
        // executor. We record its session id (best-effort via the standard
        // resolver) so the SPA can link the recipe-instance to the agent.
        agent_cli: 'inline',
        pid: null,
        started_at: Date.now(),
        status: 'running',
        completed_at: null,
        result: null,
        message: null,
        session_id: resolveAgentSessionId(extra as ResolveExtra | undefined) ?? '',
        resume_of: null,
        parent_recipe_instance_id: null,
      };
      writeRecipeInstance(workspaceInfo.path, instance, { interactive: false });

      // 5. Materialize step rows from the recipe's `steps:` declaration.
      // This is what lets the agent immediately call update_status without
      // first having to call recipe.update_steps to recreate what the
      // template already declared.
      const materializedSteps: Array<{ id: string; goal: string; status: 'pending' }> = [];
      try {
        const rawSteps = parsedRecipe && Array.isArray(parsedRecipe.steps)
          ? parsedRecipe.steps as unknown[]
          : [];
        const stepDecls: Step[] = rawSteps
          .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
          .map((s) => ({
            id: String(s.id ?? ''),
            name: typeof s.name === 'string' ? s.name : undefined,
            goal: String(s.goal ?? s.title ?? ''),
            ai_instructions: typeof s.ai_instructions === 'string' ? s.ai_instructions : undefined,
            depends: Array.isArray(s.depends) ? s.depends.map(String) : undefined,
          }))
          .filter((s) => s.id && s.goal);
        if (stepDecls.length > 0) {
          const { materializeSteps } = await import('../db/recipe-steps-store.ts');
          const rows = materializeSteps(getDatabase(), instanceId, stepDecls);
          for (const r of rows) {
            materializedSteps.push({ id: r.step_id, goal: r.goal, status: 'pending' });
          }
        }
      } catch (err) {
        // Materialization failure is non-fatal — the instance still exists
        // and the agent can call recipe.update_steps to retry. Log loudly
        // so we notice infrastructure bugs.
        logger.warn(
          { err: String(err), instanceId },
          'recipe.begin: step materialization failed — agent must call recipe.update_steps before update_status',
        );
      }

      const displayName = args.name
        ?? (parsedRecipe && typeof parsedRecipe.name === 'string' ? parsedRecipe.name : recipeId);

      return {
        content: [
          {
            type: 'text',
            text: `Started recipe ${recipeId}${isAdhoc ? ' (ad-hoc)' : ''} as instance ${instanceId} with ${materializedSteps.length} step(s). Iterate by calling recipe.steps.update_status with recipe_instance_id="${instanceId}".`,
          },
        ],
        structuredContent: {
          recipe_instance_id: instanceId,
          recipe_id: recipeId,
          adhoc: isAdhoc,
          name: displayName,
          status: 'running' as const,
          workspace_id: workspaceInfo.id,
          workspace_path: workspaceInfo.path,
          steps: materializedSteps,
        },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });


  // -- recipe.instance_info -------------------------------------------------
  defineTool({
    name: 'recipe.instance_info',
    description: 'Read a recipe-run instance by id, or — when no id is passed — by reading CLAWDEVBOX_RECIPE_INSTANCE_ID + CLAWDEVBOX_WORKSPACE_ID env vars inside a spawned session. Returns the full instance row.',
    parameters: z.object({
        id: z
          .string()
          .min(1)
          .optional()
          .describe('Optional recipe-instance id. When omitted, falls back to env vars.'),
      }),
    handler: async (args, extra) => {
      const root = resolveWorkspacesRoot();
      let instanceId = args.id;

      if (instanceId) {
        // Search every registered workspace for this instance. The recipe-instance
        // id is globally unique by construction (timestamp+random); scanning the
        // registry costs O(workspaces) — fine for the MVP.
        for (const wsi of listWorkspaces(root)) {
          const inst = readRecipeInstance(wsi.path, instanceId);
          if (inst) {
            return successResponse(inst);
          }
        }
        return structuredError(
          'RECIPE_INSTANCE_NOT_FOUND',
          `Recipe instance ${instanceId} not found in any registered workspace.`,
          { instance_id: instanceId },
        );
      }

      // No explicit id — resolve via header → env (per-request, not just server env).
      instanceId = resolveRecipeInstanceId(extra) ?? undefined;
      const wsResult = resolveWorkspaceContext(extra);
      if (!instanceId || !wsResult.ok) {
        return structuredError(
          'NOT_IN_RECIPE_INSTANCE',
          'No id provided and X-Clawdevbox-Recipe-Instance-Id header / CLAWDEVBOX_RECIPE_INSTANCE_ID env are not set, or workspace cannot be resolved.',
        );
      }
      const wsInfo = wsResult.ctx.workspaceInfo;
      const workspaceId = wsResult.ctx.workspaceId;
      const inst = readRecipeInstance(wsInfo.path, instanceId);
      if (!inst) {
        return structuredError(
          'RECIPE_INSTANCE_NOT_FOUND',
          `Recipe instance ${instanceId} not found in workspace ${workspaceId}.`,
          { instance_id: instanceId, workspace_id: workspaceId },
        );
      }
      return successResponse(inst);
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- recipe.view_url ------------------------------------------------------
  // Returns the browser URL that hooks an xterm.js view into the hidden pty
  // session for a running recipe instance. Mirrors the pattern from
  // taskdock's chat-terminal:watch — many viewers can attach to the same
  // session, and each gets a scrollback snapshot followed by live data.
  defineTool({
    name: 'recipe.view_url',
    description: 'Return a browser URL that opens an xterm.js viewer attached to the hidden pty running the given recipe instance. Viewers receive a scrollback snapshot, then live data, and can send keystrokes / resize / kill back. Multiple clients may attach simultaneously. Errors if the instance is unknown or already cleaned up.',
    parameters: z.object({
        id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Recipe-instance id. When omitted, falls back to CLAWDEVBOX_RECIPE_INSTANCE_ID (useful from inside a spawned agent).',
          ),
      }),
    handler: async (args, extra) => {
      const instanceId = args.id ?? resolveRecipeInstanceId(extra);
      if (!instanceId) {
        return structuredError(
          'MISSING_INSTANCE_ID',
          'No id provided and X-Clawdevbox-Recipe-Instance-Id header / CLAWDEVBOX_RECIPE_INSTANCE_ID env are not set.',
        );
      }
      if (!ptyHasSession(instanceId)) {
        return structuredError(
          'PTY_SESSION_NOT_FOUND',
          `No live pty session for instance ${instanceId} (either it never spawned, the agent exited and was cleaned up, or the MCP server was restarted).`,
          { instance_id: instanceId },
        );
      }
      const handle = getTerminalServer();
      if (!handle) {
        return structuredError(
          'TERMINAL_SERVER_NOT_RUNNING',
          'Terminal HTTP server was not started by this MCP-server boot. Make sure index.ts called startTerminalServer().',
        );
      }
      const url = handle.url(instanceId);
      return {
        content: [{ type: 'text' as const, text: `Open ${url}` }],
        structuredContent: {
          recipe_instance_id: instanceId,
          view_url: url,
          terminal_port: handle.port(),
        },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- recipe.kill ----------------------------------------------------------
  // Forcibly terminate a running pty session. Marks the instance as cancelled
  // so subsequent recipe.instance_info reads reflect the truth.
  defineTool({
    name: 'recipe.kill',
    description: 'Terminate a running recipe pty. Sends a signal to the underlying agent process, marks the recipe instance as cancelled, and disconnects all attached viewers via the regular exit event.',
    parameters: z.object({
        id: z
          .string()
          .min(1)
          .optional()
          .describe('Recipe-instance id. Falls back to X-Clawdevbox-Recipe-Instance-Id header / CLAWDEVBOX_RECIPE_INSTANCE_ID env.'),
        signal: z
          .string()
          .optional()
          .describe('Optional POSIX signal name (default: SIGTERM). Ignored on Windows ptys; ConPTY closes the pseudoconsole regardless.'),
      }),
    handler: async (args, extra) => {
      const instanceId = args.id ?? resolveRecipeInstanceId(extra);
      if (!instanceId) {
        return structuredError(
          'MISSING_INSTANCE_ID',
          'No id provided and X-Clawdevbox-Recipe-Instance-Id header / CLAWDEVBOX_RECIPE_INSTANCE_ID env are not set.',
        );
      }
      if (!ptyHasSession(instanceId)) {
        return structuredError(
          'PTY_SESSION_NOT_FOUND',
          `No live pty session for instance ${instanceId}.`,
          { instance_id: instanceId },
        );
      }
      const ok = ptyKill(instanceId, args.signal);
      if (!ok) {
        return structuredError(
          'PTY_KILL_FAILED',
          `Failed to signal the pty for instance ${instanceId} (it may have just exited).`,
          { instance_id: instanceId },
        );
      }
      // Mark the recipe instance cancelled so polling consumers stop waiting.
      const root = resolveWorkspacesRoot();
      for (const wsi of listWorkspaces(root)) {
        const inst = readRecipeInstance(wsi.path, instanceId);
        if (inst && inst.status === 'running') {
          writeRecipeInstance(wsi.path, {
            ...inst,
            status: 'cancelled',
            completed_at: Date.now(),
            message: 'Cancelled via recipe.kill',
          });
          break;
        }
      }
      return {
        content: [{ type: 'text' as const, text: `Killed recipe instance ${instanceId}.` }],
        structuredContent: {
          recipe_instance_id: instanceId,
          status: 'cancelled',
        },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- recipe.list_running ---------------------------------------------------
  // Convenience listing of every pty session currently registered. Useful for
  // dashboards and Playwright tests.
  defineTool({
    name: 'recipe.list_running',
    description: 'List every recipe-instance currently holding a live pty session in this MCP server. Returns view_url per entry when the terminal server is running.',
    parameters: z.object({}),
    handler: async () => {
      const handle = getTerminalServer();
      const items = ptyListSessions().map((s) => ({
        recipe_instance_id: s.instanceId,
        workspace_id: s.workspaceId,
        exited: s.exited,
        view_url: handle ? handle.url(s.instanceId) : null,
      }));
      return {
        content: [{ type: 'text' as const, text: `${items.length} running pty session(s).` }],
        structuredContent: { sessions: items },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
  // -- recipe.update_steps --------------------------------------------------
  defineTool({
    name: 'recipe.update_steps',
    description: [
      'Mutate the step plan of a running recipe instance (spec §10.5). Supports three operations in one call: `add` new steps, `remove` pending steps by step_id, and `update_meta` to patch existing step declarations. All mutations run inside a single DB transaction; any failure rolls everything back. Added triggers on running steps register immediately; removed triggers disable matching auto-declared rows. Defaults `recipe_instance_id` from $CLAWDEVBOX_RECIPE_INSTANCE_ID when omitted.',
      '',
      'Step shape for `add[]` / `update_meta[]` is the same as recipe.upsert:',
      '  id:              kebab-case unique step id',
      '  goal:            ≤200 char human-readable TL;DR (shown as title in SPA)',
      '  ai_instructions: full agent-facing prompt (optional, ≤16000 chars,',
      '                   collapsible "Agent instructions" panel in SPA)',
      '  depends:         array of step ids this step waits on',
      '  params, artifacts, triggers: same as recipe.upsert',
      'See recipe.upsert for full per-field semantics + a worked example.',
    ].join('\n'),
    parameters: z.object({
        recipe_instance_id: z.string().min(1).optional(),
        add: z.array(z.record(z.string(), z.unknown())).optional()
          .describe('Steps to append to the plan. Each entry: {id, goal, ai_instructions?, depends?, params?, artifacts?, triggers?}.'),
        remove: z.array(z.string()).optional()
          .describe('Step ids to remove. Removing a step that has already run is rejected.'),
        update_meta: z.array(z.record(z.string(), z.unknown())).optional()
          .describe('Patches to apply to existing step declarations. Each entry: {id, ...fields to update}.'),
      }),
    handler: async (args, extra) => {
      const instanceId =
        args.recipe_instance_id ?? resolveRecipeInstanceId(extra);
      if (!instanceId) {
        return structuredError(
          'RECIPE_INSTANCE_NOT_FOUND',
          'recipe_instance_id not provided and X-Clawdevbox-Recipe-Instance-Id header / CLAWDEVBOX_RECIPE_INSTANCE_ID env are not set.',
        );
      }
      const opts: UpdateStepsOpts = {
        recipe_instance_id: instanceId,
        add: args.add as Step[] | undefined,
        remove: args.remove,
        update_meta: args.update_meta as Array<Partial<Step> & { id: string }> | undefined,
        agent_session_id: resolveAgentSessionId(extra),
      };
      try {
        const db = getDatabase();
        const result = updateStepsImpl(db, opts);
        emitChange('recipes');
        return {
          content: [
            {
              type: 'text',
              text: `Updated recipe_steps for ${instanceId}: +${result.added.length} added, -${result.removed.length} removed, ~${result.updated.length} updated.`,
            },
          ],
          structuredContent: {
            recipe_instance_id: instanceId,
            added: result.added.map((r) => ({ id: r.id, step_id: r.step_id })),
            removed: result.removed,
            updated: result.updated.map((r) => ({ id: r.id, step_id: r.step_id })),
            trigger_changes: result.trigger_changes,
          },
        };
      } catch (e) {
        if (e instanceof ToolErrorBox) {
          return structuredError(e.payload.code, e.payload.message, e.payload.detail ?? {});
        }
        const msg = e instanceof Error ? e.message : String(e);
        return structuredError('INTERNAL_ERROR', msg);
      }
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- recipe.steps.update_status -------------------------------------------
  defineTool({
    name: 'recipe.steps.update_status',
    description: 'Update the status, state, or attachments of a single step in a recipe instance (spec §10.5). Enforces the monotonic transition rule. Entry hook: transitioning into `running` registers the step\'s declared triggers. Exit hook: transitioning into a terminal state (`done`/`failed`/`skipped`) disables auto-declared triggers and cascades the instance to terminal when all siblings are terminal. `request_user_input` atomically transitions to `awaiting_user` and creates a linked inbox item. `state` merges; `state_replace` overwrites (mutually exclusive). Defaults `recipe_instance_id` from $CLAWDEVBOX_RECIPE_INSTANCE_ID when omitted.',
    parameters: z.object({
        recipe_instance_id: z.string().min(1).optional(),
        step_id: z.string().min(1),
        status: z
          .enum(['running', 'done', 'failed', 'skipped', 'awaiting_user'])
          .optional(),
        message: z.string().optional(),
        state: z.record(z.string(), z.unknown()).optional(),
        state_replace: z.record(z.string(), z.unknown()).optional(),
        result: z.string().optional(),
        error: z.string().optional(),
        attach_artifact_ids: z.array(z.string()).optional(),
        attach_inbox_item_ids: z.array(z.string()).optional(),
        request_user_input: z
          .object({
            message: z.string().min(1),
            options: z.array(z.string()).optional(),
            inbox_item: z
              .object({
                title: z.string().optional(),
                labels: z.array(z.string()).optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    handler: async (args, extra) => {
      const instanceId =
        args.recipe_instance_id ?? resolveRecipeInstanceId(extra);
      if (!instanceId) {
        return structuredError(
          'RECIPE_INSTANCE_NOT_FOUND',
          'recipe_instance_id not provided and X-Clawdevbox-Recipe-Instance-Id header / CLAWDEVBOX_RECIPE_INSTANCE_ID env are not set.',
        );
      }
      const opts: UpdateStatusOpts = {
        recipe_instance_id: instanceId,
        step_id: args.step_id,
        status: args.status as RecipeStepStatus | undefined,
        message: args.message,
        state: args.state as Record<string, unknown> | undefined,
        state_replace: args.state_replace as Record<string, unknown> | undefined,
        result: args.result,
        error: args.error,
        attach_artifact_ids: args.attach_artifact_ids,
        attach_inbox_item_ids: args.attach_inbox_item_ids,
        request_user_input: args.request_user_input as UpdateStatusOpts['request_user_input'],
        agent_session_id: resolveAgentSessionId(extra),
      };
      try {
        const db = getDatabase();
        const result = updateStatusImpl(db, opts);
        emitChange('recipes');
        if (result.created_inbox_item_id) emitChange('inbox');
        return {
          content: [
            {
              type: 'text',
              text: `Step ${args.step_id} → ${result.step.status}.`,
            },
          ],
          structuredContent: {
            recipe_instance_id: instanceId,
            step: {
              id: result.step.id,
              step_id: result.step.step_id,
              status: result.step.status,
              started_at: result.step.started_at,
              completed_at: result.step.completed_at,
              message: result.step.message,
              awaiting_user_message: result.step.awaiting_user_message,
              state: JSON.parse(result.step.state_json),
            },
            registered_trigger_ids: result.registered_trigger_ids,
            disabled_trigger_ids: result.disabled_trigger_ids,
            attached_artifact_ids: result.attached_artifact_ids,
            attached_inbox_item_ids: result.attached_inbox_item_ids,
            created_inbox_item_id: result.created_inbox_item_id,
            recipe_instance_status: result.recipe_instance_status,
            trigger_registration_errors: result.trigger_registration_errors,
          },
        };
      } catch (e) {
        if (e instanceof ToolErrorBox) {
          return structuredError(e.payload.code, e.payload.message, e.payload.detail ?? {});
        }
        const msg = e instanceof Error ? e.message : String(e);
        return structuredError('INTERNAL_ERROR', msg);
      }
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function successResponse(inst: RecipeInstance): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: `recipe instance ${inst.id} (status=${inst.status})` }],
    structuredContent: {
      recipe_instance_id: inst.id,
      workspace_id: inst.workspace_id,
      workspace_path: inst.workspace_path,
      recipe_id: inst.recipe_id,
      prompt: inst.prompt,
      params: inst.params,
      agent_cli: inst.agent_cli,
      pid: inst.pid,
      started_at: inst.started_at,
      status: inst.status,
      completed_at: inst.completed_at,
      result: inst.result,
      message: inst.message,
    },
  };
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function safeParse(source: string): unknown {
  try {
    return parseRecipeSource(source);
  } catch {
    return null;
  }
}

function pickString(obj: unknown, field: string): string | undefined {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const v = (obj as Record<string, unknown>)[field];
    if (typeof v === 'string') return v;
  }
  return undefined;
}
