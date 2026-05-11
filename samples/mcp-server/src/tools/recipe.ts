/**
 * tools/recipe.ts
 *
 * Implements recipe.list / read / upsert / delete.
 * - File-backed: reads/writes `.conductor/recipes/<id>.yaml` (project),
 *   `~/.conductor/recipes/<id>.yaml` (global), and looks up plugin recipes
 *   through the manifest's `provides.recipes` list.
 * - Scope semantics from spec §10.4: project shadows plugin shadows global.
 * - Plugin scope is read-only (writes return PLUGIN_SCOPE_READONLY).
 * - Shape validation per spec §7.4 happens server-side before disk writes.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as pty from 'node-pty';
import { z } from 'zod';
import {
  hasSession as ptyHasSession,
  killPty as ptyKill,
  listSessions as ptyListSessions,
  registerPty,
} from '../pty-registry.ts';
import { getTerminalServer } from '../terminal-server.ts';
import { writeFileAtomic } from '../fs-util.ts';
import {
  mintRecipeInstanceId,
  readRecipeInstance,
  recipeInstancesDir,
  writeRecipeInstance,
  type RecipeInstance,
  type RecipeInstanceStatus,
} from '../recipe-instances-store.ts';
import {
  ensureWritableScope,
  listAllInScope,
  notFound,
  resolveRead,
  structuredError,
  validationError,
} from '../scope.ts';
import { validateRecipeSource } from '../validators.ts';
import { recipePath, validateId, type Workspace } from '../workspace.ts';
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  resolveWorkspacesRoot,
} from '../workspaces-store.ts';

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
        'Write a recipe to project or global scope. Plugin scope is read-only — copy to project to customize (spec §10.6). Shape-validates before disk write (spec §7.4).',
      inputSchema: {
        id: z.string().min(1).describe('Recipe id; must match [a-z][a-z0-9-]*.'),
        scope: writableScope,
        source: z.string().min(1).describe('Full YAML body of the recipe.'),
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

      const target = recipePath(ws, args.scope as 'project' | 'global', args.id);
      writeFileAtomic(target, args.source);
      return {
        content: [{ type: 'text', text: `Wrote recipe ${args.id} to ${args.scope} scope.` }],
        structuredContent: { id: args.id, scope: args.scope, path: target },
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
      if (!existsSync(target)) return notFound('recipe', args.id);
      unlinkSync(target);
      return {
        content: [{ type: 'text', text: `Deleted recipe ${args.id} from ${args.scope} scope.` }],
        structuredContent: { id: args.id, scope: args.scope, path: target },
      };
    },
  );

  // -- recipe.run -----------------------------------------------------------
  server.registerTool(
    'recipe.run',
    {
      description:
        'Spawn a fresh agent CLI session running a recipe in a workspace. Creates (or reuses) a workspace, writes its `.mcp.json` so the spawned CLI sees the Conductor MCP server, mints a recipe-instance row in `<workspace>/.conductor/recipe-instances/`, then detach-spawns the agent CLI and returns immediately with ids + pid. The spawned agent calls `recipe.done` to signal completion.',
      inputSchema: {
        id: z.string().min(1).describe('Recipe id to run.'),
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
      },
    },
    async (args) => {
      // 1. Resolve the recipe (any scope).
      const idCheck = validateId(args.id);
      if (!idCheck.ok) return structuredError('INVALID_ID', idCheck.message!);
      const hit = resolveRead(ws, 'all', 'recipe', args.id, recipePath);
      if (!hit) return notFound('recipe', args.id);

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

      // 3. Mint instance id + write the `.mcp.json` for the spawned CLI.
      const agentCli = args.agent_cli ?? 'copilot';
      const instanceId = mintRecipeInstanceId();
      const mcpSecret = randomBytes(16).toString('hex');
      const serverEntry = serverEntryPath();
      const mcpConfigPath = resolvePath(workspaceInfo.path, '.mcp.json');
      const mcpConfig = {
        mcpServers: {
          conductor: {
            type: 'local',
            command: 'npx',
            args: ['-y', 'tsx', serverEntry],
            env: pruneUndefined({
              CONDUCTOR_PROJECT_DIR: workspaceInfo.path,
              CONDUCTOR_RECIPE_INSTANCE_ID: instanceId,
              CONDUCTOR_WORKSPACE_ID: workspaceInfo.id,
              CONDUCTOR_WORKSPACES_ROOT: workspacesRoot,
              CONDUCTOR_MCP_URL: process.env.CONDUCTOR_MCP_URL,
              CONDUCTOR_MCP_SECRET: mcpSecret,
              ADO_ORG: process.env.ADO_ORG,
              ADO_PROJECT: process.env.ADO_PROJECT,
              ADO_BEARER_TOKEN: process.env.ADO_BEARER_TOKEN,
            }),
            tools: ['*'],
          },
        },
      };
      writeFileAtomic(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');

      // 4. Write the instance file (pid=null, status=running) before spawning.
      const instance: RecipeInstance = {
        id: instanceId,
        recipe_id: args.id,
        recipe_snapshot: hit.source,
        workspace_id: workspaceInfo.id,
        workspace_path: workspaceInfo.path,
        prompt: args.prompt,
        params: (args.params as Record<string, unknown> | undefined) ?? {},
        agent_cli: agentCli,
        pid: null,
        started_at: Date.now(),
        status: 'running',
        completed_at: null,
        result: null,
        message: null,
      };
      writeRecipeInstance(workspaceInfo.path, instance);

      // 5. Spawn the agent CLI inside a pseudo-terminal (node-pty). PTYs
      //    don't create OS-level console windows on Windows (ConPTY runs the
      //    child against a virtual terminal buffer), so this is the only
      //    cross-platform way to get fully-hidden agent runs with output
      //    capture. Output is streamed to a single per-instance log file
      //    (a pty has no stdout/stderr split — both end up in one stream).
      //
      //    Trade-off vs. `child_process.spawn({detached:true})`: the pty is
      //    bound to this MCP-server process. If the server exits while a
      //    recipe is running, the agent dies with it. That's acceptable for
      //    Conductor — the MCP server lives as long as the client (Claude
      //    Code, Conductor app, etc.) is open, and recipes finish in tens
      //    of seconds.
      const spawnEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') spawnEnv[k] = v;
      }
      spawnEnv.CONDUCTOR_PROJECT_DIR = workspaceInfo.path;
      spawnEnv.CONDUCTOR_RECIPE_INSTANCE_ID = instanceId;
      spawnEnv.CONDUCTOR_WORKSPACE_ID = workspaceInfo.id;
      spawnEnv.CONDUCTOR_WORKSPACES_ROOT = workspacesRoot;
      spawnEnv.CONDUCTOR_MCP_SECRET = mcpSecret;

      const instancesDir = recipeInstancesDir(workspaceInfo.path);
      mkdirSync(instancesDir, { recursive: true });
      const logPath = resolvePath(instancesDir, `${instanceId}.log`);
      const logStream = createWriteStream(logPath, { flags: 'a' });

      // Resolve the binary + args for each agent CLI. We unify dispatch to a
      // single `pty.spawn(...)` call below so window-hiding and log-piping
      // logic isn't duplicated per branch.
      let ptyFile: string;
      let ptyArgs: string[];

      if (agentCli === 'echo-stub') {
        // Test mode — confirms the pty pipeline works without a real CLI.
        ptyFile = process.execPath;
        ptyArgs = [
          '-e',
          'process.stdout.write("[echo-stub recipe.run] ok\\n"); process.exit(0);',
        ];
      } else if (agentCli === 'copilot') {
        // Use Microsoft's `agency copilot` wrapper.
        //
        // Why agency.toml is needed even though we already wrote `.mcp.json`:
        //   `copilot mcp --help` claims workspace `.mcp.json` is auto-loaded,
        //   but agency invokes copilot as:
        //     copilot --resume <fixed-session-id> --additional-mcp-config @<merged-temp.json>
        //   The merged temp config is built from agency built-ins + global
        //   `~/.copilot/mcp-config.json` + workspace `agency.toml`. Workspace
        //   `.mcp.json` is NOT included, and because the same session is
        //   resumed regardless of cwd, the resumed tool inventory excludes
        //   anything declared only in `.mcp.json`. So we mirror the same
        //   server entry into `agency.toml` at the workspace root — agency
        //   merges that in, the temp config carries it, and copilot sees the
        //   Conductor MCP server. We still write `.mcp.json` above so that
        //   other clients (Claude Code, copilot run directly without
        //   --resume, etc.) work without needing agency-specific config.
        const agencyTomlPath = resolvePath(workspaceInfo.path, 'agency.toml');
        const serverEntry = mcpConfig.mcpServers.conductor;
        const tomlEscape = (s: string) =>
          s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const envLines = Object.entries(serverEntry.env)
          .map(([k, v]) => `${k} = "${tomlEscape(String(v))}"`)
          .join('\n');
        const argsLine = serverEntry.args
          .map((a) => `"${tomlEscape(a)}"`)
          .join(', ');
        const agencyToml =
          `[mcps.servers.conductor]\n` +
          `type = "stdio"\n` +
          `command = "${tomlEscape(serverEntry.command)}"\n` +
          `args = [${argsLine}]\n` +
          `tools = ["*"]\n` +
          `\n` +
          `[mcps.servers.conductor.env]\n` +
          `${envLines}\n`;
        writeFileAtomic(agencyTomlPath, agencyToml);

        const isWin = process.platform === 'win32';
        const agencyBin =
          process.env.CONDUCTOR_AGENCY_PATH ??
          (isWin ? 'agency.exe' : 'agency');
        ptyFile = agencyBin;
        ptyArgs = ['copilot', '-p', args.prompt];
      } else if (agentCli === 'claude') {
        // Claude Code is typically installed as `claude.cmd` on Windows. We
        // route through cmd.exe so PATHEXT resolution finds it; on Unix the
        // binary is on PATH directly.
        if (process.platform === 'win32') {
          ptyFile = 'cmd.exe';
          ptyArgs = ['/d', '/s', '/c', 'claude', '-p', args.prompt];
        } else {
          ptyFile = 'claude';
          ptyArgs = ['-p', args.prompt];
        }
      } else {
        // Type-narrow exhaustiveness (agentCli is `'echo-stub' | 'copilot' | 'claude'`).
        ptyFile = '';
        ptyArgs = [];
      }

      const ptyCols = 120;
      const ptyRows = 30;
      let pid: number | undefined;
      let spawnError: unknown = null;
      try {
        const ptyProc = pty.spawn(ptyFile, ptyArgs, {
          name: 'xterm-256color',
          cols: ptyCols,
          rows: ptyRows,
          cwd: workspaceInfo.path,
          env: spawnEnv,
        });
        pid = ptyProc.pid;
        // Hand the pty to the registry. From here, browser viewers can attach
        // through the terminal-server's `/terminal/:id/ws` endpoint and see
        // a snapshot of the scrollback + live data + send input/resize/kill.
        registerPty({
          instanceId,
          workspaceId: workspaceInfo.id,
          cols: ptyCols,
          rows: ptyRows,
          ipty: ptyProc,
        });
        // Persist a copy of the pty stream to disk for post-mortem inspection.
        // Registry already broadcasts to viewers; this is just durable history.
        ptyProc.onData((data) => {
          logStream.write(data);
        });
        ptyProc.onExit(({ exitCode, signal }) => {
          logStream.end();
          // If the agent exited without calling recipe.done, mark the
          // instance failed so the caller isn't left polling forever.
          const current = readRecipeInstance(workspaceInfo.path, instanceId);
          if (current && current.status === 'running') {
            const reason =
              signal !== undefined && signal !== 0
                ? `agent exited via signal ${signal} without calling recipe.done`
                : `agent exited with code ${exitCode} without calling recipe.done`;
            writeRecipeInstance(workspaceInfo.path, {
              ...current,
              status: 'failure',
              completed_at: Date.now(),
              message: reason,
            });
          }
        });
      } catch (err) {
        spawnError = err;
        try { logStream.end(); } catch { /* ignore */ }
      }
      if (spawnError) {
        const msg = spawnError instanceof Error ? spawnError.message : String(spawnError);
        // The instance file is already on disk — mark it failed so the user
        // can see why. recipe.done won't fire if the spawn never started.
        const failed: RecipeInstance = {
          ...instance,
          status: 'failure',
          completed_at: Date.now(),
          message: `spawn failed: ${msg}`,
        };
        writeRecipeInstance(workspaceInfo.path, failed);
        return structuredError('SPAWN_FAILED', msg, { agent_cli: agentCli, instance_id: instanceId });
      }

      // 6. Update the instance with the pid we got back.
      if (typeof pid === 'number') {
        writeRecipeInstance(workspaceInfo.path, { ...instance, pid });
      }

      return {
        content: [
          {
            type: 'text',
            text: `Spawned ${agentCli} for recipe ${args.id} (instance=${instanceId}, workspace=${workspaceInfo.id}, pid=${pid ?? 'n/a'}).`,
          },
        ],
        structuredContent: {
          recipe_instance_id: instanceId,
          workspace_id: workspaceInfo.id,
          workspace_path: workspaceInfo.path,
          attach_to_inbox_item_id: args.attach_to_inbox_item_id ?? null,
          pid: pid ?? null,
          agent_cli: agentCli,
          status: 'spawned',
          log_path: logPath,
          view_url: getTerminalServer()?.url(instanceId) ?? null,
        },
      };
    },
  );

  // -- recipe.done ----------------------------------------------------------
  server.registerTool(
    'recipe.done',
    {
      description:
        'Called by the agent inside a spawned recipe-run session to signal completion. Requires CONDUCTOR_RECIPE_INSTANCE_ID and CONDUCTOR_WORKSPACE_ID env vars (set automatically by recipe.run). Updates the instance file with status / completed_at / result / message.',
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
      const instanceId = process.env.CONDUCTOR_RECIPE_INSTANCE_ID;
      const workspaceId = process.env.CONDUCTOR_WORKSPACE_ID;
      if (!instanceId) {
        return structuredError(
          'NOT_IN_RECIPE_INSTANCE',
          'CONDUCTOR_RECIPE_INSTANCE_ID env var required — recipe.done can only run inside a spawned recipe-run session.',
        );
      }
      if (!workspaceId) {
        return structuredError(
          'NOT_IN_RECIPE_INSTANCE',
          'CONDUCTOR_WORKSPACE_ID env var required — recipe.done can only run inside a spawned recipe-run session.',
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
        'Read a recipe-run instance by id, or — when no id is passed — by reading CONDUCTOR_RECIPE_INSTANCE_ID + CONDUCTOR_WORKSPACE_ID env vars inside a spawned session. Returns the full instance row.',
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
      instanceId = process.env.CONDUCTOR_RECIPE_INSTANCE_ID;
      const workspaceId = process.env.CONDUCTOR_WORKSPACE_ID;
      if (!instanceId || !workspaceId) {
        return structuredError(
          'NOT_IN_RECIPE_INSTANCE',
          'No id provided and CONDUCTOR_RECIPE_INSTANCE_ID / CONDUCTOR_WORKSPACE_ID env vars are not set.',
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
            'Recipe-instance id. When omitted, falls back to CONDUCTOR_RECIPE_INSTANCE_ID (useful from inside a spawned agent).',
          ),
      },
    },
    async (args) => {
      const instanceId = args.id ?? process.env.CONDUCTOR_RECIPE_INSTANCE_ID;
      if (!instanceId) {
        return structuredError(
          'MISSING_INSTANCE_ID',
          'No id provided and CONDUCTOR_RECIPE_INSTANCE_ID env var is not set.',
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
          .describe('Recipe-instance id. Falls back to CONDUCTOR_RECIPE_INSTANCE_ID.'),
        signal: z
          .string()
          .optional()
          .describe('Optional POSIX signal name (default: SIGTERM). Ignored on Windows ptys; ConPTY closes the pseudoconsole regardless.'),
      },
    },
    async (args) => {
      const instanceId = args.id ?? process.env.CONDUCTOR_RECIPE_INSTANCE_ID;
      if (!instanceId) {
        return structuredError(
          'MISSING_INSTANCE_ID',
          'No id provided and CONDUCTOR_RECIPE_INSTANCE_ID env var is not set.',
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
}

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

function serverEntryPath(): string {
  // The MCP server lives in `<conductor-mcp-server>/src/index.ts`. From this
  // file (`src/tools/recipe.ts`) that's `../index.ts`. Compute against the
  // current module URL so the resolved path survives tsx + ESM.
  const here = fileURLToPath(import.meta.url);
  return resolvePath(dirname(here), '..', 'index.ts');
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function safeParse(source: string): unknown {
  try {
    return yamlLoad(source);
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
