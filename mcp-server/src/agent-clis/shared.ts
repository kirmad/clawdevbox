import { spawn } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { mkdirSync } from 'node:fs';
import * as pty from 'node-pty';
import { writeFileAtomic } from '../fs-util.ts';
import type { Workspace } from '../workspace.ts';
import type { ResolvedConfig } from '../config.ts';
import { logger } from '../logger.ts';
import type { DetectResult, ProviderCtx, PtySpawnOpts } from './types.ts';

/** Spawn the binary with `args` and capture exit. Used by provider.detect(). */
export async function probeBinary(
  bin: string,
  args: string[] = ['--version'],
  timeoutMs = 5000,
): Promise<DetectResult> {
  return new Promise((resolveDetect) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, shell: false });
    } catch (err) {
      resolveDetect({ available: false, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolveDetect({ available: false, binary: bin, reason: `probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolveDetect({ available: false, binary: bin, reason: err.message });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const version = (stdout || stderr).trim().split('\n')[0] || undefined;
        resolveDetect({ available: true, binary: bin, version });
      } else {
        resolveDetect({ available: false, binary: bin, reason: `exit ${code}: ${(stderr || stdout).trim().split('\n')[0]}` });
      }
    });
  });
}

/** Write `.mcp.json` so the spawned CLI sees the clawdevbox MCP server. */
export function writeMcpJson(
  ctx: ProviderCtx,
  _wsPath: string,
  mcp: { url: string; secret: string },
): void {
  const config = {
    mcpServers: {
      clawdevbox: {
        type: 'streamable-http',
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.secret}` },
        tools: ['*'],
      },
    },
  };
  ctx.writeWorkspaceFile('.mcp.json', JSON.stringify(config, null, 2) + '\n');
}

/** Build the ProviderCtx the kernel hands to a provider for one call. */
export function buildProviderCtx(ws: Workspace, cfg: ResolvedConfig): ProviderCtx {
  return {
    ws,
    cfg,
    logger,
    spawnPty(file: string, args: string[], opts: PtySpawnOpts) {
      return pty.spawn(file, args, {
        name: opts.name ?? 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
      });
    },
    writeWorkspaceFile(rel: string, contents: string) {
      const abs = resolve(ws.projectDir, rel);
      const rel2 = relative(ws.projectDir, abs);
      if (rel2.startsWith('..') || resolve(ws.projectDir, rel2) !== abs) {
        throw new Error(`writeWorkspaceFile: path '${rel}' escapes the workspace`);
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileAtomic(abs, contents);
    },
  };
}

/** Pretty-print an Error for use in `DetectResult.reason`. */
export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
