#!/usr/bin/env node
/**
 * Bundle `src/cli/index.ts` to `dist/cli.js` with esbuild.
 *
 * - Platform: node, target ESM.
 * - Externalizes Node built-ins and packaged deps so we don't ship copies
 *   of zod / ws / node-pty / pino / @modelcontextprotocol/sdk inside the
 *   bundle. They resolve via `node_modules` at install time.
 * - Externalizes `node-pty` specifically because it has prebuilt native
 *   binaries that must not be bundled.
 * - Copies the renderer `.mjs` files verbatim — they're loaded over HTTP as
 *   browser modules, not imported by the bundle.
 */

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'dist');

// Read deps from package.json so we don't drift.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const externalDeps = [
  ...Object.keys(pkg.dependencies ?? {}),
  // Sub-paths of bundled deps must also be external.
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
  '@modelcontextprotocol/sdk/types.js',
  // tsx is dynamically imported at startup to enable .ts plugin tool
  // loading. Keeping it external means we don't pull its loader+source
  // through the bundler (which would be slow + huge).
  'tsx',
  'tsx/esm/api',
];

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src/cli/index.ts')],
  outfile: join(outDir, 'cli.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: 'linked',
  legalComments: 'none',
  external: externalDeps,
  banner: {
    // ESM-safe shebang + __filename/__dirname shim. esbuild doesn't add
    // these automatically for ESM output.
    js:
      '#!/usr/bin/env node\n' +
      "import { createRequire as __cdbCreateRequire } from 'node:module';\n" +
      "import { fileURLToPath as __cdbFileURLToPath } from 'node:url';\n" +
      "import { dirname as __cdbDirname } from 'node:path';\n" +
      'const require = __cdbCreateRequire(import.meta.url);\n' +
      'const __filename = __cdbFileURLToPath(import.meta.url);\n' +
      'const __dirname = __cdbDirname(__filename);',
  },
});

// Make `dist/cli.js` executable on POSIX. On Windows `chmod` is a no-op
// but npm's bin shim handles the .cmd wrapping regardless.
try {
  chmodSync(join(outDir, 'cli.js'), 0o755);
} catch {
  /* windows / non-fatal */
}

// Copy renderer modules verbatim — they're served as browser ES modules
// by the terminal-server's /__renderer/<type>.mjs route, NOT bundled.
const rendererSrc = join(root, 'src/renderers');
const rendererDst = join(outDir, 'renderers');
if (existsSync(rendererSrc)) {
  mkdirSync(rendererDst, { recursive: true });
  cpSync(rendererSrc, rendererDst, { recursive: true });
}

// Copy built-in plugins (samples/plugins/) into dist/plugins/ so the
// published package can install them via `clawdevbox init` without
// shipping the entire `samples/` tree. Dev mode (tsx) still resolves
// from samples/plugins/ via the fallback chain in builtin-plugins.ts.
const pluginsSrc = join(root, '..', 'samples', 'plugins');
const pluginsDst = join(outDir, 'plugins');
if (existsSync(pluginsSrc)) {
  mkdirSync(pluginsDst, { recursive: true });
  cpSync(pluginsSrc, pluginsDst, {
    recursive: true,
    filter: (src) => !/[/\\]node_modules([/\\]|$)/.test(src) && !/[/\\]_legacy/.test(src),
  });
}

// Build the Vue + PrimeVue SPA in web/ (if it exists) and copy its
// dist/ output to dist/web/. We invoke `vite build` directly when the
// SPA's node_modules already exist; otherwise we skip and the server's
// home-page.ts fallback HTML asks the user to run `npm --prefix web ci`.
const webDir = join(root, 'web');
const webDist = join(webDir, 'dist');
const webOut = join(outDir, 'web');
const webPkg = join(webDir, 'package.json');
const webNodeModules = join(webDir, 'node_modules');
if (existsSync(webPkg)) {
  if (!existsSync(webNodeModules)) {
    process.stdout.write('web/: node_modules missing — run `npm --prefix web ci` to enable SPA build.\n');
  } else {
    const { spawnSync } = await import('node:child_process');
    process.stdout.write('building web/ SPA...\n');
    const r = spawnSync('npm', ['--prefix', webDir, 'run', 'build'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) {
      process.stderr.write(`web build failed (exit ${r.status})\n`);
      process.exit(r.status ?? 1);
    }
    if (existsSync(webDist)) {
      mkdirSync(webOut, { recursive: true });
      cpSync(webDist, webOut, { recursive: true });
    }
  }
}

process.stdout.write(
  `built dist/cli.js (+ ${existsSync(rendererDst) ? 'renderers/' : 'no renderers'}` +
    `, ${existsSync(pluginsDst) ? 'plugins/' : 'no plugins'}` +
    `, ${existsSync(webOut) ? 'web/' : 'no web'})\n`,
);
