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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
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
  type RecipeInstance,
  type RecipeInstanceStatus,
} from '../recipe-instances-store.ts';
import { runRecipe } from '../recipe-runner.ts';
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
import { emitChange } from '../event-bus.ts';
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

export function registerRecipeTools(server: McpServer, ws: Workspace): void {
  // -- recipe.list ----------------------------------------------------------
  server.registerTool(
    'recipe.list',
    {
      description:
        'List recipes across scopes (spec §6.1 + §10.4). Project shadows plugin shadows global on id collision in `all` mode; the listing reports every (id, scope) pair so customizations are visible.',
      inputSchema: {
        scope: scopeFilter,
        search: z
          .string()
          .min(1)
          .optional()
          .describe('Substring filter against id, name, or description.'),
      },
    },
    async (args) => {
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
  );

  // -- recipe.read ----------------------------------------------------------
  server.registerTool(
    'recipe.read',
    {
      description:
        'Read a recipe by id, with scope precedence project → plugin → global (spec §10.4). Returns raw YAML + parsed object + the scope it resolved from.',
      inputSchema: {
        id: z.string().min(1).describe('Recipe id ([a-z][a-z0-9-]*).'),
        scope: scopeFilter,
      },
    },
    async (args) => {
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
  );

  // -- recipe.upsert --------------------------------------------------------
  server.registerTool(
    'recipe.upsert',
    {
      description:
        'Write a recipe to project or global scope. Plugin scope is read-only — copy to project to customize (spec §10.6). Shape-validates before disk write (spec §7.4). `format` selects the on-disk encoding: `yaml` (default) writes `<id>.yaml`; `json` writes `<id>.json`. Whichever format you pick, the duplicate-id file in the other format is atomically removed so a recipe always lives in exactly one extension.',
      inputSchema: {
        id: z.string().min(1).describe('Recipe id; must match [a-z][a-z0-9-]*.'),
        scope: writableScope,
        source: z.string().min(1).describe('Full YAML or JSON body of the recipe.'),
        format: z
          .enum(['yaml', 'json'])
          .optional()
          .describe("On-disk format. Default 'yaml'."),
      },
    },
    async (args) => {
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

      return {
        content: [{ type: 'text', text: `Wrote recipe ${args.id} to ${args.scope} scope (${format}).` }],
        structuredContent: {
          id: args.id,
          scope: args.scope,
          path: target,
          format,
          removed_siblings: removedPaths,
        },
      };
    },
  );

  // -- recipe.delete --------------------------------------------------------
  server.registerTool(
    'recipe.delete',
    {
      description: 'Delete a recipe from project or global scope. Plugin scope is read-only.',
      inputSchema: {
        id: z.string().min(1),
        scope: writableScope,
      },
    },
    async (args) => {
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
  );

  // -- recipe.run -----------------------------------------------------------
  server.registerTool(
    'recipe.run',
    {
      description:
        'Spawn a fresh agent CLI session running a recipe in a workspace. Two ways to specify the recipe: (a) `id` — load an already-saved recipe via the scope chain (project→plugin→global); or (b) `source` — pass the recipe YAML inline for an ad-hoc run without persisting it. Exactly one of `id` or `source` is required. Either way, mints a recipe-instance row in `<workspace>/.clawdevbox/recipe-instances/`, writes `.mcp.json` so the spawned CLI sees the Clawdevbox MCP server, then detach-spawns the agent CLI and returns immediately with ids + pid. The spawned agent calls `recipe.done` to signal completion.',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .optional()
          .describe('Recipe id to load from the scope chain. Mutually exclusive with `source`.'),
        source: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Inline recipe YAML for an ad-hoc run (not persisted to disk). The YAML must include valid `id`, `name`, and `description` fields — they validate against the same rules as `recipe.upsert`. Mutually exclusive with `id`.',
          ),
        prompt: z.string().min(1).describe('The first user message handed to the spawned agent.'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional parameter overrides recorded on the instance.'),
        workspace_id: z
          .string()
          .min(1)
          .optional()
          .describe('Existing workspace id to run in. If omitted, a new workspace is created with `inherit_plugins: true`.'),
        attach_to_inbox_item_id: z
          .string()
          .min(1)
          .optional()
          .describe('Optional inbox item to associate the instance with.'),
        agent_cli: z
          .enum(['copilot', 'claude', 'echo-stub'])
          .optional()
          .describe('Which CLI to spawn. `echo-stub` is a no-op spawn for tests.'),
        session_id: z
          .string()
          .min(1)
          .optional()
          .describe('Explicit CLI session id. Recommended — lets the UI offer a "Resume" action later. Auto-minted if omitted.'),
        resume_of: z
          .string()
          .min(1)
          .optional()
          .describe('Recipe-instance id to resume. When set, the agent CLI is spawned with --resume <session_id_of_resume_of> and the new instance is recorded as a continuation.'),
      },
    },
    async (args) => {
      // 1. Resolve the recipe — either by id (saved) or by inline source (ad-hoc).
      //    Exactly one of {id, source} must be supplied.
      const hasId = typeof args.id === 'string' && args.id.length > 0;
      const hasSource = typeof args.source === 'string' && args.source.length > 0;
      if (hasId && hasSource) {
        return structuredError(
          'INVALID_REQUEST',
          'Pass either `id` (load saved recipe) or `source` (inline ad-hoc YAML), not both.',
        );
      }
      if (!hasId && !hasSource) {
        return structuredError(
          'INVALID_REQUEST',
          'Either `id` (load saved recipe) or `source` (inline ad-hoc YAML) is required.',
        );
      }

      let recipeId: string;
      let recipeSnapshot: string;
      let isAdhoc: boolean;
      if (hasId) {
        const idCheck = validateId(args.id!);
        if (!idCheck.ok) return structuredError('INVALID_ID', idCheck.message!);
        const hit = resolveRead(ws, 'all', 'recipe', args.id!, recipePath);
        if (!hit) return notFound('recipe', args.id!);
        recipeId = args.id!;
        recipeSnapshot = hit.source;
        isAdhoc = false;
      } else {
        const validation = validateRecipeSource(args.source!);
        if (!validation.ok) {
          return validationError(validation.errors);
        }
        const parsed = parseRecipeSource(args.source!) as { id: string };
        recipeId = parsed.id;
        recipeSnapshot = args.source!;
        isAdhoc = true;
      }

      // 2. Resolve / create the workspace.
      const workspacesRoot = resolveWorkspacesRoot();
      let workspaceInfo;
      if (args.workspace_id) {
        workspaceInfo = getWorkspace(workspacesRoot, args.workspace_id);
        if (!workspaceInfo) {
          return structuredError(
            'WORKSPACE_NOT_FOUND',
            `Workspace ${args.workspace_id} not found in registry.`,
            { id: args.workspace_id },
          );
        }
      } else {
        try {
          const created = createWorkspace({
            inherit_plugins: true,
            callerProjectDir: ws.projectDir,
          });
          workspaceInfo = created.info;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return structuredError('WORKSPACE_CREATE_FAILED', msg);
        }
      }

      // 3. Delegate spawn to the recipe-runner.
      const agentCli = args.agent_cli ?? 'copilot';
      const cfg = resolveConfig({ projectDir: ws.projectDir, globalDir: ws.globalDir });
      const result = await runRecipe({
        recipeId,
        recipeSnapshot,
        isAdhoc,
        prompt: args.prompt,
        params: args.params as Record<string, unknown> | undefined,
        workspaceInfo: { id: workspaceInfo.id, path: workspaceInfo.path },
        attachToInboxItemId: args.attach_to_inbox_item_id,
        agentCli,
        sessionId: args.session_id,
        resumeOf: args.resume_of,
        workspacesRoot,
        ws,
        cfg,
      });

      if (result.spawn_error) {
        return structuredError(result.spawn_error.code, result.spawn_error.message, {
          agent_cli: agentCli,
          instance_id: result.recipe_instance_id,
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: `Spawned ${agentCli} for recipe ${recipeId}${isAdhoc ? ' (ad-hoc)' : ''} (instance=${result.recipe_instance_id}, session=${result.session_id}, workspace=${workspaceInfo.id}, pid=${result.pid ?? 'n/a'}${result.resume_of ? `, resume_of=${result.resume_of}` : ''}).`,
          },
        ],
        structuredContent: {
          recipe_instance_id: result.recipe_instance_id,
          recipe_id: result.recipe_id,
          adhoc: result.adhoc,
          workspace_id: result.workspace_id,
          workspace_path: result.workspace_path,
          attach_to_inbox_item_id: result.attach_to_inbox_item_id,
          pid: result.pid,
          agent_cli: result.agent_cli,
          session_id: result.session_id,
          resume_of: result.resume_of,
          status: result.status,
          log_path: result.log_path,
          view_url: result.view_url,
        },
      };
    },
  );

  // -- recipe.done ----------------------------------------------------------
  server.registerTool(
    'recipe.done',
    {
      description:
        'Called by the agent inside a spawned recipe-run session to signal completion. Requires CLAWDEVBOX_RECIPE_INSTANCE_ID and CLAWDEVBOX_WORKSPACE_ID env vars (set automatically by recipe.run). Updates the instance file with status / completed_at / result / message.',
      inputSchema: {
        status: z
          .enum(['success', 'failure', 'cancelled'])
          .optional()
          .describe('Final status. Default: success.'),
        result: z
          .unknown()
          .optional()
          .describe('Optional structured result the parent can consume.'),
        message: z.string().optional().describe('Optional human summary.'),
      },
    },
    async (args) => {
      const instanceId = process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
      const workspaceId = process.env.CLAWDEVBOX_WORKSPACE_ID;
      if (!instanceId) {
        return structuredError(
          'NOT_IN_RECIPE_INSTANCE',
          'CLAWDEVBOX_RECIPE_INSTANCE_ID env var required — recipe.done can only run inside a spawned recipe-run session.',
        );
      }
      if (!workspaceId) {
        return structuredError(
          'NOT_IN_RECIPE_INSTANCE',
          'CLAWDEVBOX_WORKSPACE_ID env var required — recipe.done can only run inside a spawned recipe-run session.',
        );
      }
      const root = resolveWorkspacesRoot();
      const wsInfo = getWorkspace(root, workspaceId);
      if (!wsInfo) {
        return structuredError(
          'WORKSPACE_NOT_FOUND',
          `Workspace ${workspaceId} not found in registry.`,
          { id: workspaceId },
        );
      }
      const instance = readRecipeInstance(wsInfo.path, instanceId);
      if (!instance) {
        return structuredError(
          'RECIPE_INSTANCE_NOT_FOUND',
          `Recipe instance ${instanceId} not found in workspace ${workspaceId}.`,
          { instance_id: instanceId, workspace_id: workspaceId },
        );
      }
      const status: RecipeInstanceStatus = args.status ?? 'success';
      const completedAt = Date.now();
      const updated: RecipeInstance = {
        ...instance,
        status,
        completed_at: completedAt,
        result: args.result ?? null,
        message: args.message ?? null,
      };
      writeRecipeInstance(wsInfo.path, updated);
      return {
        content: [
          {
            type: 'text',
            text: `Recorded recipe.done for ${instanceId} (status=${status}).`,
          },
        ],
        structuredContent: {
          recipe_instance_id: instanceId,
          recorded_at: completedAt,
          status,
        },
      };
    },
  );

  // -- recipe.instance_info -------------------------------------------------
  server.registerTool(
    'recipe.instance_info',
    {
      description:
        'Read a recipe-run instance by id, or — when no id is passed — by reading CLAWDEVBOX_RECIPE_INSTANCE_ID + CLAWDEVBOX_WORKSPACE_ID env vars inside a spawned session. Returns the full instance row.',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .optional()
          .describe('Optional recipe-instance id. When omitted, falls back to env vars.'),
      },
    },
    async (args) => {
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

      // No explicit id — read env.
      instanceId = process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
      const workspaceId = process.env.CLAWDEVBOX_WORKSPACE_ID;
      if (!instanceId || !workspaceId) {
        return structuredError(
          'NOT_IN_RECIPE_INSTANCE',
          'No id provided and CLAWDEVBOX_RECIPE_INSTANCE_ID / CLAWDEVBOX_WORKSPACE_ID env vars are not set.',
        );
      }
      const wsInfo = getWorkspace(root, workspaceId);
      if (!wsInfo) {
        return structuredError(
          'WORKSPACE_NOT_FOUND',
          `Workspace ${workspaceId} not found in registry.`,
          { id: workspaceId },
        );
      }
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
  );

  // -- recipe.view_url ------------------------------------------------------
  // Returns the browser URL that hooks an xterm.js view into the hidden pty
  // session for a running recipe instance. Mirrors the pattern from
  // taskdock's chat-terminal:watch — many viewers can attach to the same
  // session, and each gets a scrollback snapshot followed by live data.
  server.registerTool(
    'recipe.view_url',
    {
      description:
        'Return a browser URL that opens an xterm.js viewer attached to the hidden pty running the given recipe instance. Viewers receive a scrollback snapshot, then live data, and can send keystrokes / resize / kill back. Multiple clients may attach simultaneously. Errors if the instance is unknown or already cleaned up.',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Recipe-instance id. When omitted, falls back to CLAWDEVBOX_RECIPE_INSTANCE_ID (useful from inside a spawned agent).',
          ),
      },
    },
    async (args) => {
      const instanceId = args.id ?? process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
      if (!instanceId) {
        return structuredError(
          'MISSING_INSTANCE_ID',
          'No id provided and CLAWDEVBOX_RECIPE_INSTANCE_ID env var is not set.',
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
  );

  // -- recipe.kill ----------------------------------------------------------
  // Forcibly terminate a running pty session. Marks the instance as cancelled
  // so subsequent recipe.instance_info reads reflect the truth.
  server.registerTool(
    'recipe.kill',
    {
      description:
        'Terminate a running recipe pty. Sends a signal to the underlying agent process, marks the recipe instance as cancelled, and disconnects all attached viewers via the regular exit event.',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .optional()
          .describe('Recipe-instance id. Falls back to CLAWDEVBOX_RECIPE_INSTANCE_ID.'),
        signal: z
          .string()
          .optional()
          .describe('Optional POSIX signal name (default: SIGTERM). Ignored on Windows ptys; ConPTY closes the pseudoconsole regardless.'),
      },
    },
    async (args) => {
      const instanceId = args.id ?? process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
      if (!instanceId) {
        return structuredError(
          'MISSING_INSTANCE_ID',
          'No id provided and CLAWDEVBOX_RECIPE_INSTANCE_ID env var is not set.',
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
  );

  // -- recipe.list_running ---------------------------------------------------
  // Convenience listing of every pty session currently registered. Useful for
  // dashboards and Playwright tests.
  server.registerTool(
    'recipe.list_running',
    {
      description:
        'List every recipe-instance currently holding a live pty session in this MCP server. Returns view_url per entry when the terminal server is running.',
      inputSchema: {},
    },
    async () => {
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
  );
  // -- recipe.update_steps --------------------------------------------------
  server.registerTool(
    'recipe.update_steps',
    {
      description:
        'Mutate the step plan of a running recipe instance (spec §10.5). Supports three operations in one call: `add` new steps, `remove` pending steps by step_id, and `update_meta` to patch existing step declarations. All mutations run inside a single DB transaction; any failure rolls everything back. Added triggers on running steps register immediately; removed triggers disable matching auto-declared rows. Defaults `recipe_instance_id` from $CLAWDEVBOX_RECIPE_INSTANCE_ID when omitted.',
      inputSchema: {
        recipe_instance_id: z.string().min(1).optional(),
        add: z.array(z.record(z.string(), z.unknown())).optional(),
        remove: z.array(z.string()).optional(),
        update_meta: z.array(z.record(z.string(), z.unknown())).optional(),
      },
    },
    async (args) => {
      const instanceId =
        args.recipe_instance_id ?? process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
      if (!instanceId) {
        return structuredError(
          'RECIPE_INSTANCE_NOT_FOUND',
          'recipe_instance_id not provided and CLAWDEVBOX_RECIPE_INSTANCE_ID env var is not set.',
        );
      }
      const opts: UpdateStepsOpts = {
        recipe_instance_id: instanceId,
        add: args.add as Step[] | undefined,
        remove: args.remove,
        update_meta: args.update_meta as Array<Partial<Step> & { id: string }> | undefined,
        agent_session_id: process.env.CLAWDEVBOX_AGENT_SESSION_ID ?? null,
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
  );

  // -- recipe.steps.update_status -------------------------------------------
  server.registerTool(
    'recipe.steps.update_status',
    {
      description:
        'Update the status, state, or attachments of a single step in a recipe instance (spec §10.5). Enforces the monotonic transition rule. Entry hook: transitioning into `running` registers the step\'s declared triggers. Exit hook: transitioning into a terminal state (`done`/`failed`/`skipped`) disables auto-declared triggers and cascades the instance to terminal when all siblings are terminal. `request_user_input` atomically transitions to `awaiting_user` and creates a linked inbox item. `state` merges; `state_replace` overwrites (mutually exclusive). Defaults `recipe_instance_id` from $CLAWDEVBOX_RECIPE_INSTANCE_ID when omitted.',
      inputSchema: {
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
      },
    },
    async (args) => {
      const instanceId =
        args.recipe_instance_id ?? process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID;
      if (!instanceId) {
        return structuredError(
          'RECIPE_INSTANCE_NOT_FOUND',
          'recipe_instance_id not provided and CLAWDEVBOX_RECIPE_INSTANCE_ID env var is not set.',
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
        agent_session_id: process.env.CLAWDEVBOX_AGENT_SESSION_ID ?? null,
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
  );
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
