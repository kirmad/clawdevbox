/**
 * tools/daemon.ts — MCP tool surface for the daemon supervisor.
 *
 * Daemons are scripts that should ALWAYS be running. The supervisor
 * (started in `cli/start.ts`) keeps them alive: spawns them at boot,
 * restarts them with exponential backoff on exit, and respects user
 * stop/restart/disable commands via generation-guarded reconciliation.
 *
 * Five tools:
 *   - daemon.register  — upsert a daemon spec (auto-starts on next tick)
 *   - daemon.list      — enumerate daemons + their live runs
 *   - daemon.get       — full status incl. recent runs
 *   - daemon.stop      — disable + kill the live process
 *   - daemon.start     — re-enable (the supervisor respawns)
 *   - daemon.restart   — kill the live process; supervisor respawns
 *   - daemon.delete    — stop + remove
 *   - daemon.read_logs — tail the latest run's log file
 */

import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { structuredError } from '../scope.ts';
import type { Workspace } from '../workspace.ts';
import type { Database } from 'better-sqlite3';
import type { DaemonSupervisor } from '../daemon-supervisor.ts';
import {
  upsertDaemon,
  listDaemons,
  getDaemon,
  setEnabled,
  deleteDaemon,
  getLiveRun,
  listRecentRuns,
  type DaemonRow,
  type DaemonRunRow,
} from '../db/daemons-store.ts';
import { readDaemonLog } from '../daemon-process-runner.ts';
import { ensureWorkspace } from '../db/workspaces-store.ts';

export interface DaemonToolCtx {
  db: Database;
  supervisor: DaemonSupervisor;
  /** Default workspace path used when neither workspace_id nor workspace_path is supplied. */
  defaultWorkspacePath: string;
}

function buildCtx(): DaemonToolCtx {
  const ctx = (globalThis as any).__clawdevboxDaemonToolCtx as DaemonToolCtx | undefined;
  if (!ctx) {
    throw new Error('daemon-tool context not initialized (only available inside `clawdevbox start`)');
  }
  return ctx;
}

function resolveWorkspaceId(
  ctx: DaemonToolCtx,
  args: { workspace_id?: string | null; workspace_path?: string | null },
): string {
  if (args.workspace_id) return args.workspace_id;
  const path = args.workspace_path ?? ctx.defaultWorkspacePath;
  const ws = ensureWorkspace(ctx.db, { path });
  return ws.id;
}

function projectDaemon(d: DaemonRow, live: DaemonRunRow | null): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name,
    workspace_id: d.workspace_id,
    kind: d.kind,
    runtime: d.runtime,
    command: JSON.parse(d.command_json),
    cwd: d.cwd,
    env: JSON.parse(d.env_json),
    enabled: !!d.enabled,
    generation: d.generation,
    restart_policy: JSON.parse(d.restart_policy_json),
    restart_count: d.restart_count,
    last_exit_at: d.last_exit_at,
    last_error: d.last_error,
    next_restart_at: d.next_restart_at,
    stable_since: d.stable_since,
    created_at: d.created_at,
    updated_at: d.updated_at,
    live_run: live
      ? {
          id: live.id,
          status: live.status,
          pid: live.pid,
          started_at: live.started_at,
          log_path: live.log_path,
        }
      : null,
  };
}

export function registerDaemonEntries(_ws: Workspace): void {
  // --- daemon.register ----------------------------------------------------
  defineTool({
    name: 'daemon.register',
    description:
      'Register (or update) a daemon — a script the clawdevbox supervisor keeps ALWAYS running. On exit, it is automatically restarted with exponential backoff; on stop/disable it stays down until re-enabled. Use for long-lived listeners (e.g. a Teams trouter WebSocket loop), background watchers, or any process you want supervised. Returns the daemon row; the supervisor starts it on the next tick (~0-30s).',
    parameters: z.object({
      id: z.string().min(1).optional().describe('Stable id — pass to update an existing daemon. Omit to mint a new one.'),
      name: z.string().min(1).describe('Human-readable label.'),
      runtime: z.enum(['node', 'tsx', 'python', 'bash', 'pwsh', 'direct']).describe(
        "How to invoke `command`. 'direct' means command[0] is the binary and the rest are args (no wrapper).",
      ),
      command: z.array(z.string().min(1)).min(1).describe('Argv handed to the runtime.'),
      cwd: z.string().min(1).optional().describe('Working dir. Defaults to the workspace path.'),
      env: z.record(z.string(), z.string()).optional().describe('Extra env vars (merged into process.env).'),
      workspace_id: z.string().min(1).optional().describe('Workspace to attach to. Defaults to current workspace.'),
      workspace_path: z.string().min(1).optional().describe('Alternative to workspace_id; creates a workspace if missing.'),
      enabled: z.boolean().optional().describe('Defaults to true.'),
      restart_policy: z.object({
        backoff_ms: z.array(z.number().int().nonnegative()).optional(),
        stable_after_ms: z.number().int().nonnegative().optional(),
        max_restarts: z.number().int().nonnegative().optional(),
      }).optional().describe('Override the default {5s,30s,2m,10m,30m} backoff schedule + 5min stability + unlimited restarts.'),
    }),
    handler: async (args) => {
      const ctx = buildCtx();
      const workspace_id = resolveWorkspaceId(ctx, {
        workspace_id: args.workspace_id ?? null,
        workspace_path: args.workspace_path ?? null,
      });
      const row = upsertDaemon(ctx.db, {
        id: args.id,
        name: args.name,
        workspace_id,
        runtime: args.runtime,
        command: args.command,
        cwd: args.cwd ?? null,
        env: args.env,
        enabled: args.enabled,
        restart_policy: args.restart_policy,
      });
      // Trigger an immediate supervisor tick so the daemon spins up now,
      // not at the next 30s wake.
      ctx.supervisor.tick();
      const live = getLiveRun(ctx.db, row.id);
      const projected = projectDaemon(row, live);
      return {
        content: [{
          type: 'text',
          text: `Daemon ${row.id} (${row.name}) registered. The supervisor will start it on the next tick.`,
        }],
        structuredContent: projected,
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- daemon.list --------------------------------------------------------
  defineTool({
    name: 'daemon.list',
    description: 'List all registered daemons + their live runs. Filter by workspace.',
    parameters: z.object({
      workspace_id: z.string().min(1).optional(),
    }),
    handler: async (args) => {
      const ctx = buildCtx();
      const rows = listDaemons(ctx.db, args.workspace_id ? { workspace_id: args.workspace_id } : {});
      const items = rows.map((r) => projectDaemon(r, getLiveRun(ctx.db, r.id)));
      return {
        content: [{ type: 'text', text: `Found ${items.length} daemon(s).` }],
        structuredContent: { items },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- daemon.get ---------------------------------------------------------
  defineTool({
    name: 'daemon.get',
    description: 'Get the full status of a daemon — spec, live run (if any), and the N most-recent runs.',
    parameters: z.object({
      id: z.string().min(1),
      recent_runs: z.number().int().min(0).max(50).optional().describe('Default 5.'),
    }),
    handler: async (args) => {
      const ctx = buildCtx();
      const row = getDaemon(ctx.db, args.id);
      if (!row) return structuredError('NOT_FOUND', `daemon ${args.id} not found`);
      const live = getLiveRun(ctx.db, row.id);
      const recent = listRecentRuns(ctx.db, row.id, args.recent_runs ?? 5);
      return {
        content: [{ type: 'text', text: `Daemon ${row.id} (${row.name}): ${live ? 'running' : 'down'}` }],
        structuredContent: { ...projectDaemon(row, live), recent_runs: recent },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- daemon.stop --------------------------------------------------------
  defineTool({
    name: 'daemon.stop',
    description: 'Stop a daemon — disables auto-restart AND kills the live process if any. To re-enable later, call daemon.start.',
    parameters: z.object({ id: z.string().min(1) }),
    handler: async (args) => {
      const ctx = buildCtx();
      const row = getDaemon(ctx.db, args.id);
      if (!row) return structuredError('NOT_FOUND', `daemon ${args.id} not found`);
      setEnabled(ctx.db, args.id, false);
      await ctx.supervisor.stopDaemon(args.id);
      const updated = getDaemon(ctx.db, args.id)!;
      return {
        content: [{ type: 'text', text: `Daemon ${args.id} stopped.` }],
        structuredContent: projectDaemon(updated, null),
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- daemon.start -------------------------------------------------------
  defineTool({
    name: 'daemon.start',
    description: 'Re-enable a previously stopped daemon. The supervisor will spawn it on the next tick (clears backoff).',
    parameters: z.object({ id: z.string().min(1) }),
    handler: async (args) => {
      const ctx = buildCtx();
      const row = getDaemon(ctx.db, args.id);
      if (!row) return structuredError('NOT_FOUND', `daemon ${args.id} not found`);
      setEnabled(ctx.db, args.id, true);
      ctx.db.prepare(
        `UPDATE daemons SET restart_count = 0, next_restart_at = NULL, last_error = NULL WHERE id = ?`,
      ).run(args.id);
      ctx.supervisor.tick();
      const updated = getDaemon(ctx.db, args.id)!;
      const live = getLiveRun(ctx.db, args.id);
      return {
        content: [{ type: 'text', text: `Daemon ${args.id} started.` }],
        structuredContent: projectDaemon(updated, live),
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- daemon.restart -----------------------------------------------------
  defineTool({
    name: 'daemon.restart',
    description: 'Kill the live run (if any) and immediately respawn. Clears backoff state.',
    parameters: z.object({ id: z.string().min(1) }),
    handler: async (args) => {
      const ctx = buildCtx();
      const row = getDaemon(ctx.db, args.id);
      if (!row) return structuredError('NOT_FOUND', `daemon ${args.id} not found`);
      await ctx.supervisor.restart(args.id);
      const updated = getDaemon(ctx.db, args.id)!;
      const live = getLiveRun(ctx.db, args.id);
      return {
        content: [{ type: 'text', text: `Daemon ${args.id} restart requested.` }],
        structuredContent: projectDaemon(updated, live),
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- daemon.delete ------------------------------------------------------
  defineTool({
    name: 'daemon.delete',
    description: 'Stop and remove a daemon. Run rows are deleted via ON DELETE CASCADE. Log files on disk are NOT removed.',
    parameters: z.object({ id: z.string().min(1) }),
    handler: async (args) => {
      const ctx = buildCtx();
      const row = getDaemon(ctx.db, args.id);
      if (!row) return structuredError('NOT_FOUND', `daemon ${args.id} not found`);
      await ctx.supervisor.stopDaemon(args.id);
      deleteDaemon(ctx.db, args.id);
      return {
        content: [{ type: 'text', text: `Daemon ${args.id} deleted.` }],
        structuredContent: { id: args.id, deleted: true },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- daemon.read_logs ---------------------------------------------------
  defineTool({
    name: 'daemon.read_logs',
    description: 'Tail the latest run\'s log file for a daemon. Default tail: 32 KB; cap: 256 KB.',
    parameters: z.object({
      id: z.string().min(1),
      run_id: z.string().min(1).optional().describe('Optional — defaults to the latest run.'),
      tail_bytes: z.number().int().min(256).max(262_144).optional(),
    }),
    handler: async (args) => {
      const ctx = buildCtx();
      const row = getDaemon(ctx.db, args.id);
      if (!row) return structuredError('NOT_FOUND', `daemon ${args.id} not found`);
      const runs = listRecentRuns(ctx.db, args.id, 50);
      const run = args.run_id
        ? runs.find((r) => r.id === args.run_id)
        : runs[0];
      if (!run) return structuredError('NOT_FOUND', `no runs for daemon ${args.id}`);
      if (!run.log_path) return structuredError('NOT_FOUND', `run ${run.id} has no log_path`);
      const text = readDaemonLog(run.log_path, args.tail_bytes ?? 32_768);
      return {
        content: [{ type: 'text', text: text || '(empty log)' }],
        structuredContent: { run_id: run.id, log_path: run.log_path, tail: text },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
