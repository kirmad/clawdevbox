import { join } from 'node:path';
import os from 'node:os';
import { writeMcpJson, probeBinary, cliPluginSync, cliPluginDiscover } from './shared.ts';
import type {
  AgentCliProvider,
  AgentHandle,
  DiscoveredPlugin,
  ProviderCtx,
  SpawnSessionOpts,
  SyncPluginInventoryOpts,
  SyncReport,
} from './types.ts';

function resolveBinary(): string {
  const isWin = process.platform === 'win32';
  return process.env.CLAWDEVBOX_COPILOT_PATH ?? (isWin ? 'copilot.exe' : 'copilot');
}

const COPILOT_PLUGIN_CACHE = join(os.homedir(), '.copilot', 'plugins');

export const copilotProvider: AgentCliProvider = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  description: 'The official GitHub Copilot CLI (`copilot`). Supports headless prompts and resumable sessions.',
  source: 'builtin',

  async detect(_ctx: ProviderCtx) {
    return probeBinary(resolveBinary(), ['--version']);
  },

  async spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle> {
    const bin = resolveBinary();
    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);
    const mcpPath = join(opts.workspaceInfo.path, '.mcp.json');

    const sessionFlag = opts.init.kind === 'new'
      ? `--name=${opts.init.session_id}`
      : `--resume=${opts.init.session_id}`;

    const argv: string[] = [sessionFlag, '--additional-mcp-config', `@${mcpPath}`];
    if (opts.mode === 'headless') {
      if (!opts.prompt) throw new Error('copilot: headless mode requires opts.prompt');
      argv.push('--allow-all-tools', '-p', opts.prompt);
    }

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    const pty = ctx.spawnPty(bin, argv, {
      cwd: opts.workspaceInfo.path, env,
      cols: opts.ptyCols ?? 120, rows: opts.ptyRows ?? 30,
    });

    return {
      pid: pty.pid ?? null,
      sessionId: opts.init.session_id,
      pty,
      exited: new Promise((resolveExit) => pty.onExit(({ exitCode, signal }) =>
        resolveExit({ exitCode, signal: signal != null ? String(signal) : undefined }))),
    };
  },

  async syncPluginInventory(ctx: ProviderCtx, opts: SyncPluginInventoryOpts): Promise<SyncReport> {
    return cliPluginSync(ctx, opts, {
      binary: resolveBinary(),
      pluginCacheDir: COPILOT_PLUGIN_CACHE,
    });
  },

  async discoverInstalledPlugins(ctx: ProviderCtx): Promise<DiscoveredPlugin[]> {
    return cliPluginDiscover(ctx, {
      binary: resolveBinary(),
      pluginCacheDir: COPILOT_PLUGIN_CACHE,
    });
  },
};
