// Register tsx's ESM loader so the rest of the process can import .ts
// files at runtime. Plugin hostable tools live as `.ts` files in
// `<global_dir>/plugins/<id>/tools/*.ts`; without this hook
// the bundled `dist/cli.js` (run by plain Node) chokes on the .ts
// extension. The register() call is a no-op when we're already running
// under `node --import tsx`. Failures here are non-fatal — the server
// still boots, plugin tool imports just won't work.
try {
  const { register } = await import('tsx/esm/api');
  register();
} catch {
  /* tsx not installed (rare in real deployments) — proceed without .ts support */
}

/**
 * clawdevbox — CLI entry point.
 *
 * Dispatches to subcommands:
 *   clawdevbox init      Interactive project setup. Writes .clawdevbox/config.json.
 *   clawdevbox mcp       Run the MCP server over stdio.
 *   clawdevbox start     Run the MCP server over Streamable HTTP + terminal/artifact viewer.
 *   clawdevbox --help    Show usage.
 *
 * Subcommands accept these common flags (all optional, all override config):
 *   --project <dir>       project directory (default: cwd or CLAWDEVBOX_PROJECT_DIR)
 *   --global <dir>        global directory (default: ~/.clawdevbox)
 *   --port <n>            HTTP port for `start` (default: 5201)
 *   --host <h>            HTTP bind host for `start` (default: 127.0.0.1)
 *   --token <s>           HTTP bearer token for `start` (default: from config)
 *   --plugin <src>        (init only, repeatable) git url or absolute folder
 *                         to discover plugins from. Each --plugin source is
 *                         scanned for a single plugin (root plugin.yaml) or
 *                         a collection (subdirs with plugin.yaml); init then
 *                         prompts to pick which discovered plugins to install.
 */

import { logger } from '../logger.ts';

/**
 * Parsed CLI flag value. Most flags are scalars; flags that may be
 * specified more than once (`--plugin <src>` …) accumulate into an
 * array in argv order. Subcommand handlers use the `str()` / `arr()`
 * helpers in this directory to read out the type they expect.
 */
export type FlagValue = string | boolean | string[];
export type Flags = Record<string, FlagValue>;

interface ParsedArgv {
  command: string | null;
  positional: string[];
  flags: Flags;
}

function setFlag(flags: Flags, key: string, value: string | boolean): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
    return;
  }
  // Repeated boolean flags collapse to `true` (idempotent). Repeated
  // string-valued flags accumulate into a string[] so subcommands like
  // `init --plugin a --plugin b` can read every source.
  if (typeof value === 'boolean') {
    flags[key] = existing === false ? value : existing;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  if (typeof existing === 'string') {
    flags[key] = [existing, value];
    return;
  }
  // existing is boolean — string wins.
  flags[key] = value;
}

function parseArgv(argv: string[]): ParsedArgv {
  const out: ParsedArgv = { command: null, positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        setFlag(out.flags, a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          setFlag(out.flags, a.slice(2), next);
          i++;
        } else {
          setFlag(out.flags, a.slice(2), true);
        }
      }
    } else if (a.startsWith('-')) {
      const next = argv[i + 1];
      const name = a.slice(1);
      if (next !== undefined && !next.startsWith('-')) {
        setFlag(out.flags, name, next);
        i++;
      } else {
        setFlag(out.flags, name, true);
      }
    } else if (out.command === null) {
      out.command = a;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(`clawdevbox — toolkit for running AI coding agents headlessly.

Usage:
  clawdevbox init [--project <dir>] [--scope global|project] [--plugin <src> ...]
      Interactive project setup. Writes either <project>/.clawdevbox/config.json
      (project scope) or <globalDir>/config.json (global scope, recommended)
      with project_dir, global_dir, http port + bearer token.

      --scope global  Account-wide install. Config lives in <globalDir>/config.json
                      and the MCP server can run from any directory.
      --scope project Per-project install (legacy behavior).

      --plugin <src>  Repeatable. Each <src> is a git URL (e.g.
                      https://github.com/ic3-microsoft/clawdevbox-plugins.git
                      or git+ssh://...) or an absolute folder path
                      (e.g. C:\\git\\clawdevbox-plugins). The folder/repo
                      can be either a single plugin (plugin.yaml at root)
                      or a collection (subdirs with plugin.yaml). init
                      discovers the plugins and asks which to install.

  clawdevbox mcp [--project <dir>] [--global <dir>]
      Run the MCP server over stdio. Connect via:
        { "command": "npx", "args": ["-y", "clawdevbox", "mcp"] }

  clawdevbox start [--project <dir>] [--port <n>] [--host <h>] [--token <s>]
      Run the Streamable HTTP MCP server (default port 5201) alongside
      the terminal/artifact viewer. /mcp requires Authorization: Bearer <token>.

  clawdevbox start --service
      Spawn the HTTP MCP server as a detached background process and
      register OS auto-start (Windows registry Run key / macOS LaunchAgent /
      Linux systemd-user) so it relaunches at every login. PID + port are
      recorded in <globalDir>/service.json.

  clawdevbox stop
      Stop the background service started by \`clawdevbox start --service\`.
      Does NOT remove the OS auto-start registration.

  clawdevbox restart
      Stop the running background service (if any) and re-install it with
      the current config. Idempotent: if nothing is running, behaves like
      \`clawdevbox start --service\`. Auto-start registration is preserved.

  clawdevbox status
      Print whether the background service is running and whether OS
      auto-start is registered.

  clawdevbox uninstall-service
      Stop the background service AND remove the OS auto-start registration.

  clawdevbox config set <key> <value> [--global|--project]
      Mutate a single field of the project- or global-scope config.json.
      Currently supported keys:
        default_agent_cli  Provider id used by the main agent and recipe.run
                           when no explicit agent_cli is supplied. Validated
                           against the live provider registry.

  clawdevbox --help
      Show this message.

Env vars override config. Flags override env vars.
`);
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));

  if (parsed.flags.help || parsed.flags.h || parsed.command === 'help') {
    printUsage();
    return;
  }

  if (parsed.command === null) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  switch (parsed.command) {
    case 'init': {
      const { runInit } = await import('./init.ts');
      await runInit(parsed.flags);
      return;
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp.ts');
      await runMcp(parsed.flags);
      return;
    }
    case 'start': {
      const { runStart } = await import('./start.ts');
      await runStart(parsed.flags);
      return;
    }
    case 'stop': {
      const { runStop } = await import('./stop.ts');
      await runStop(parsed.flags);
      return;
    }
    case 'restart': {
      const { runRestart } = await import('./restart.ts');
      await runRestart(parsed.flags);
      return;
    }
    case 'status': {
      const { runStatus } = await import('./status.ts');
      await runStatus(parsed.flags);
      return;
    }
    case 'uninstall-service': {
      const { runUninstallService } = await import('./uninstall-service.ts');
      await runUninstallService(parsed.flags);
      return;
    }
    case 'config': {
      const { runConfigSet } = await import('./config-set.ts');
      // Pass the raw subcommand args (positional list begins after `config`),
      // preserving the trailing --global / --project tokens parseArgv consumed
      // into the flags map.
      const sub: string[] = [...parsed.positional];
      if (parsed.flags.global === true) sub.push('--global');
      if (parsed.flags.project === true) sub.push('--project');
      // parseArgv strips the leading subcommand from positional; re-add it so
      // runConfigSet sees ['set', '<key>', '<value>', ...].
      process.exit(await runConfigSet(sub));
    }
    default:
      process.stderr.write(`unknown command: ${parsed.command}\n\n`);
      printUsage();
      process.exitCode = 2;
      return;
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  logger.fatal({ err: msg }, 'fatal');
  process.exit(1);
});
