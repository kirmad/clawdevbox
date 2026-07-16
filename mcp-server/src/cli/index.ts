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
 *                         scanned for a single plugin (root
 *                         `.claude-plugin/plugin.json`), a marketplace
 *                         catalog (`.claude-plugin/marketplace.json`),
 *                         or a collection (subdirs with manifests); init
 *                         then prompts to pick which discovered plugins
 *                         to install.
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
                  [--no-builtin] [--config-file <path>] [--non-interactive]
      Interactive project setup. Writes either <project>/.clawdevbox/config.json
      (project scope) or <globalDir>/config.json (global scope, recommended)
      with project_dir, global_dir, http port + bearer token.

      --scope global  Account-wide install. Config lives in <globalDir>/config.json
                      and the MCP server can run from any directory.
      --scope project Per-project install (legacy behavior).

      --plugin <src>  Repeatable. Each <src> is a git URL (e.g.
                      https://github.com/example/clawdevbox-plugins.git
                      or git+ssh://...) or an absolute folder path
                      (e.g. C:\\git\\clawdevbox-plugins). The folder/repo
                      can be either a single plugin
                      (.claude-plugin/plugin.json at root), a marketplace
                      catalog (.claude-plugin/marketplace.json at root),
                      or a collection (subdirs with manifests). init
                      discovers the plugins and asks which to install.

      --no-builtin    Skip the built-in marketplace install step. By default
                      init auto-installs install_tier: required plugins
                      (clawdevbox-mcp) and prompts for recommended
                      (dev-buddy) and optional (ado) ones.

      --config-file <path>
                      Read answers to every interactive prompt from a JSON
                      file so init runs unattended. Absent fields fall
                      through to the original prompts. Schema:
                      mcp-server/src/cli/init-config-file.ts.

      --non-interactive
                      Force unattended mode even when fields are missing
                      from --config-file. Missing answers use documented
                      defaults.

      On Windows, init also offers to install the auto-restart supervisor
      (Task Scheduler "Clawdevbox Supervisor" at logon). Configurable via
      \`install_supervisor: true|false\` in the config file.

  clawdevbox init --emit-config <path>
      Dump a fully-populated init-config JSON file derived from the
      current installed state (or defaults), ready to share between
      machines. Strips per-install secrets (bearer token, VAPID keys).
      Apply on a new machine via \`clawdevbox init --config-file <path>\`.

  clawdevbox mcp [--project <dir>] [--global <dir>]
      Run the MCP server over stdio (legacy; prefer the HTTP server).
      The HTTP server at localhost:5201/mcp is the recommended connection
      method — it survives agent restarts and supports multiple clients.
      Configure your agent CLI with:
        { "type": "http", "url": "http://127.0.0.1:5201/mcp" }

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

  clawdevbox marketplace add <source>
  clawdevbox marketplace list
  clawdevbox marketplace update [<id>]
  clawdevbox marketplace remove <id>
      Manage plugin marketplace catalogs under <globalDir>/marketplaces/.
      <source> is a git URL or absolute folder; catalogs are read via
      .claude-plugin/marketplace.json (or .github/plugin/marketplace.json
      fallback). Removing a marketplace does not uninstall plugins that
      came from it.

  clawdevbox plugin sync [--direction=both|push|pull] [--dry-run] [--respect-config]
      Bidirectional plugin sync with the configured agent CLI. Direction A
      installs clawdevbox-managed plugins/marketplaces into the CLI via its
      own \`plugin install\` / \`plugin marketplace add\` commands; Direction
      B registers CLI-installed plugins that ship clawdevbox.* extensions
      into the clawdevbox workspace. Honors cfg.client_sync only when
      --respect-config is passed.

  clawdevbox --help
      Show this message.

  clawdevbox --version
      Print the installed version.

  clawdevbox update
      Update clawdevbox to the latest npm version.

Env vars override config. Flags override env vars.
`);
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));

  // --version / -v: print version and exit
  if (parsed.flags.version || parsed.flags.v) {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    try {
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      console.log(`clawdevbox ${pkg.version}`);
    } catch {
      console.log('clawdevbox (version unknown)');
    }
    return;
  }

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
    case 'update': {
      const { spawnSync } = await import('node:child_process');
      process.stderr.write('Checking for updates...\n');
      const result = spawnSync('npm', ['install', '-g', 'clawdevbox@latest'], {
        stdio: 'inherit',
        timeout: 120_000,
        windowsHide: true,
        shell: true,
      });
      if (result.status === 0) {
        process.stderr.write('✓ clawdevbox updated to latest.\n');
      } else {
        process.stderr.write('✗ Update failed. Try: npm install -g clawdevbox@latest\n');
        process.exitCode = 1;
      }
      return;
    }
    case 'init': {
      const { runInit } = await import('./init.ts');
      // `--emit-config <path>` is a side-channel: dump a fully-populated
      // init-config JSON to <path> derived from the current installed
      // state (or sensible defaults if nothing is installed), then exit.
      // Useful for sharing a known-good init recipe between machines.
      const emitPath = parsed.flags['emit-config'];
      if (typeof emitPath === 'string') {
        const { emitInitConfig } = await import('./emit-init-config.ts');
        process.exit(await emitInitConfig({ path: emitPath, flags: parsed.flags }));
      }
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
    case 'marketplace': {
      const { runMarketplace } = await import('./marketplace.ts');
      process.exit(await runMarketplace(parsed.positional));
    }
    case 'plugin': {
      // Today the only `plugin` subcommand exposed via the CLI is `sync`.
      // Plugin install / uninstall / list / etc. are MCP tools.
      const sub = parsed.positional[0];
      if (sub === 'sync') {
        const { runPluginSync } = await import('./plugin-sync.ts');
        const rest = parsed.positional.slice(1);
        // Re-thread boolean flags that parseArgv consumed.
        if (parsed.flags['dry-run'] === true) rest.push('--dry-run');
        if (parsed.flags['respect-config'] === true) rest.push('--respect-config');
        if (typeof parsed.flags.direction === 'string') rest.push(`--direction=${parsed.flags.direction}`);
        const result = await runPluginSync(rest);
        process.exit(result.exitCode);
      }
      process.stderr.write(`unknown plugin subcommand: ${sub ?? '(none)'}\n`);
      process.stderr.write(`Usage: clawdevbox plugin sync [--direction=both|push|pull] [--dry-run] [--respect-config]\n`);
      process.exitCode = 2;
      return;
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
