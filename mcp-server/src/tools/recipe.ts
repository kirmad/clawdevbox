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

import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { parseRecipeSource, validateRecipeSource } from '../validators.ts';
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
        // Ad-hoc: validate the inline YAML and pull the embedded id.
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

      // 3. Mint instance id + write the `.mcp.json` for the spawned CLI.
      const agentCli = args.agent_cli ?? 'copilot';
      const instanceId = mintRecipeInstanceId();
      // Mint a stable session id for the CLI. We ALWAYS pass an explicit
      // id to the CLI rather than let it auto-mint, so:
      //   - the recipe instance can be resumed deterministically later;
      //   - the UI can show the id and offer a "Resume" action;
      //   - logs in <workspace>/.clawdevbox/sessions/<id>/ are addressable.
      const sessionId =
        typeof args.session_id === 'string' && args.session_id.length > 0
          ? args.session_id
          : `cdb_${instanceId.slice(3)}`;
      const isResume = !!args.resume_of;
      const mcpSecret = randomBytes(16).toString('hex');
      const { command: spawnCmd, args: spawnArgs } = resolveSpawnedMcpCommand();
      const mcpConfigPath = resolvePath(workspaceInfo.path, '.mcp.json');
      const mcpConfig = {
        mcpServers: {
          clawdevbox: {
            type: 'local',
            command: spawnCmd,
            args: spawnArgs,
            env: pruneUndefined({
              CLAWDEVBOX_PROJECT_DIR: workspaceInfo.path,
              CLAWDEVBOX_RECIPE_INSTANCE_ID: instanceId,
              CLAWDEVBOX_WORKSPACE_ID: workspaceInfo.id,
              CLAWDEVBOX_WORKSPACES_ROOT: workspacesRoot,
              CLAWDEVBOX_MCP_URL: process.env.CLAWDEVBOX_MCP_URL,
              CLAWDEVBOX_MCP_SECRET: mcpSecret,
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
        recipe_id: recipeId,
        recipe_snapshot: recipeSnapshot,
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
        session_id: sessionId,
        resume_of: args.resume_of ?? null,
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
      //    Clawdevbox — the MCP server lives as long as the client (Claude
      //    Code, Clawdevbox app, etc.) is open, and recipes finish in tens
      //    of seconds.
      const spawnEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') spawnEnv[k] = v;
      }
      spawnEnv.CLAWDEVBOX_PROJECT_DIR = workspaceInfo.path;
      spawnEnv.CLAWDEVBOX_RECIPE_INSTANCE_ID = instanceId;
      spawnEnv.CLAWDEVBOX_WORKSPACE_ID = workspaceInfo.id;
      spawnEnv.CLAWDEVBOX_WORKSPACES_ROOT = workspacesRoot;
      spawnEnv.CLAWDEVBOX_MCP_SECRET = mcpSecret;
      spawnEnv.CLAWDEVBOX_SESSION_ID = sessionId;

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
        // The agent script writes a real artifact AND marks the recipe
        // instance success on exit, so the end-to-end "trigger fires →
        // recipe runs → artifact appears" flow can be demonstrated
        // without depending on a real agent CLI being installed.
        //
        // The script is large; we write it to a temp file rather than
        // passing it via `node -e` to avoid command-line escaping issues
        // on Windows.
        const artifactId = `${recipeId}-${instanceId.slice(3)}-${isResume ? 'resume' : 'first'}`;
        const scriptPath = resolvePath(instancesDir, `${instanceId}.script.cjs`);
        const banner = isResume
          ? `[echo-stub recipe.run] resume session=${sessionId} (was=${args.resume_of}) prompt=${JSON.stringify(args.prompt)}`
          : `[echo-stub recipe.run] new session=${sessionId} prompt=${JSON.stringify(args.prompt)}`;
        const scriptBody =
`const fs = require('node:fs');
const path = require('node:path');
process.stdout.write(${JSON.stringify(banner + '\n')});
const artifactsRoot = path.join(process.env.CLAWDEVBOX_PROJECT_DIR, 'artifacts');
const artifactId = ${JSON.stringify(artifactId)};
const dir = path.join(artifactsRoot, artifactId);
fs.mkdirSync(dir, { recursive: true });
const manifest = {
  id: artifactId,
  type: 'markdown',
  title: ${JSON.stringify(args.prompt.slice(0, 80))},
  workspace_id: process.env.CLAWDEVBOX_WORKSPACE_ID,
  recipe_instance_id: process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID,
  step_id: null,
  created_at: Date.now(),
  meta: { entry: 'content.md', session_id: process.env.CLAWDEVBOX_SESSION_ID },
};
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const body = [
  '# ' + manifest.title,
  '',
  'Generated by echo-stub recipe run.',
  '',
  '- session_id: \`' + process.env.CLAWDEVBOX_SESSION_ID + '\`',
  '- recipe_instance_id: \`' + process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID + '\`',
  '- workspace_id: \`' + process.env.CLAWDEVBOX_WORKSPACE_ID + '\`',
  '- resume: ' + ${JSON.stringify(isResume ? 'true' : 'false')},
  '',
  '## Prompt',
  '',
  ${JSON.stringify(args.prompt)},
].join('\\n');
fs.writeFileSync(path.join(dir, 'content.md'), body);
const instPath = path.join(process.env.CLAWDEVBOX_PROJECT_DIR, '.clawdevbox', 'recipe-instances', process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID + '.json');
try {
  const inst = JSON.parse(fs.readFileSync(instPath, 'utf8'));
  inst.status = 'success';
  inst.completed_at = Date.now();
  inst.result = { artifact_id: artifactId };
  inst.message = 'echo-stub recipe complete; artifact ' + artifactId + ' written.';
  inst.steps = [
    { id: 'spawn', title: 'Spawn agent CLI', status: 'done', started_at: inst.started_at, completed_at: inst.started_at + 50, message: 'session_id=' + process.env.CLAWDEVBOX_SESSION_ID },
    { id: 'write-artifact', title: 'Write artifact', status: 'done', started_at: inst.started_at + 50, completed_at: Date.now(), message: 'wrote ' + artifactId + '/content.md', artifact_id: artifactId },
  ];
  fs.writeFileSync(instPath, JSON.stringify(inst, null, 2));
} catch (err) {
  process.stderr.write('failed to mark instance done: ' + err.message + '\\n');
}
process.stdout.write('[echo-stub recipe.run] wrote artifact ' + artifactId + '\\n');
process.exit(0);
`;
        writeFileAtomic(scriptPath, scriptBody);
        ptyFile = process.execPath;
        ptyArgs = [scriptPath];
      } else if (agentCli === 'copilot') {
        // Real GitHub Copilot CLI. Bypass the agency wrapper and call
        // `copilot.exe` directly so we get explicit session-id control
        // without depending on agency's internal --resume handling.
        //
        // First run uses `--name=<sessionId>` to associate the new copilot
        // session with our explicit id; subsequent resume calls use
        // `--resume=<sessionId>`. This is the pattern straight out of
        // `copilot --help`:
        //     $ copilot --name="my feature"
        //     $ copilot --resume=0cb916db-26aa-40f2-86b5-1ba81b225fd2
        //
        // MCP config is fed via `--additional-mcp-config @<path>` so the
        // spawned agent sees the clawdevbox MCP server. We also pass
        // --allow-all-tools so the run is fully non-interactive.
        const isWin = process.platform === 'win32';
        const copilotBin = process.env.CLAWDEVBOX_COPILOT_PATH ?? (isWin ? 'copilot.exe' : 'copilot');
        ptyFile = copilotBin;
        const sessionFlag = isResume ? `--resume=${sessionId}` : `--name=${sessionId}`;
        ptyArgs = [
          sessionFlag,
          '--allow-all-tools',
          '--additional-mcp-config',
          `@${mcpConfigPath}`,
          '-p',
          args.prompt,
        ];
      } else if (agentCli === 'claude') {
        // Claude Code is typically installed as `claude.cmd` on Windows. We
        // route through cmd.exe so PATHEXT resolution finds it; on Unix the
        // binary is on PATH directly.
        const claudeArgs = isResume
          ? ['--resume', sessionId, '-p', args.prompt]
          : ['--session-id', sessionId, '-p', args.prompt];
        if (process.platform === 'win32') {
          ptyFile = 'cmd.exe';
          ptyArgs = ['/d', '/s', '/c', 'claude', ...claudeArgs];
        } else {
          ptyFile = 'claude';
          ptyArgs = claudeArgs;
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
          // If the agent exited without calling recipe.done, derive
          // status from the exit code. Real CLIs (claude, copilot)
          // don't know about recipe.done — exiting cleanly (code 0) is
          // a successful run from their perspective. Non-zero exit or
          // a signal means failure.
          const current = readRecipeInstance(workspaceInfo.path, instanceId);
          if (current && current.status === 'running') {
            const ok = (signal === undefined || signal === 0) && exitCode === 0;
            writeRecipeInstance(workspaceInfo.path, {
              ...current,
              status: ok ? 'success' : 'failure',
              completed_at: Date.now(),
              message:
                signal !== undefined && signal !== 0
                  ? `agent exited via signal ${signal}`
                  : `agent exited with code ${exitCode}${ok ? ' (no recipe.done call; treating as success)' : ''}`,
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

      // 6. Update the instance with the pid we got back. RE-READ first so
      //    we don't clobber a fast-completing agent (echo-stub) that has
      //    already written status=success in the time between spawn and
      //    this line.
      if (typeof pid === 'number') {
        const current = readRecipeInstance(workspaceInfo.path, instanceId);
        if (current) {
          writeRecipeInstance(workspaceInfo.path, { ...current, pid });
        } else {
          writeRecipeInstance(workspaceInfo.path, { ...instance, pid });
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `Spawned ${agentCli} for recipe ${recipeId}${isAdhoc ? ' (ad-hoc)' : ''} (instance=${instanceId}, session=${sessionId}, workspace=${workspaceInfo.id}, pid=${pid ?? 'n/a'}${isResume ? `, resume_of=${args.resume_of}` : ''}).`,
          },
        ],
        structuredContent: {
          recipe_instance_id: instanceId,
          recipe_id: recipeId,
          adhoc: isAdhoc,
          workspace_id: workspaceInfo.id,
          workspace_path: workspaceInfo.path,
          attach_to_inbox_item_id: args.attach_to_inbox_item_id ?? null,
          pid: pid ?? null,
          agent_cli: agentCli,
          session_id: sessionId,
          resume_of: args.resume_of ?? null,
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
  // The MCP server lives in `<clawdevbox-mcp-server>/src/index.ts`. From this
  // file (`src/tools/recipe.ts`) that's `../index.ts`. Compute against the
  // current module URL so the resolved path survives tsx + ESM.
  const here = fileURLToPath(import.meta.url);
  return resolvePath(dirname(here), '..', 'index.ts');
}

/**
 * Pick the command spawned recipe-run agents use to talk back to the same
 * MCP server. Production path: `npx -y clawdevbox mcp` — works whenever the
 * package is on the PATH (global install, `npm link`, or workspace install).
 * Dev fallback: when CLAWDEVBOX_SPAWN_CMD is set (typically by tests), we use
 * `tsx <src/index.ts>` so the workflow runs against unbuilt source.
 */
function resolveSpawnedMcpCommand(): { command: string; args: string[] } {
  if (process.env.CLAWDEVBOX_SPAWN_TSX === '1') {
    return { command: 'npx', args: ['-y', 'tsx', serverEntryPath()] };
  }
  return { command: 'npx', args: ['-y', 'clawdevbox', 'mcp'] };
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
