// Real-ADO smoke driver. Spawns each tool with a real ToolContext-shaped object
// and prints the structured result. Reads env from process.env (ADO_ORG +
// ADO_BEARER_TOKEN/ADO_PAT) so callers can set them in the parent shell.
//
// Usage:
//   node --experimental-strip-types tools/_smoke.ts <toolName> [JSON args]
//
// (Run from within plugins/ado/ so the dynamic import resolves correctly.)

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [, , toolName, argsJson] = process.argv;
if (!toolName) {
  console.error('usage: node --experimental-strip-types tools/_smoke.ts <toolFile> [argsJson]');
  process.exit(2);
}

const toolPath = resolve(process.cwd(), 'tools', `${toolName}.ts`);
const mod = await import(pathToFileURL(toolPath).href);
const args = argsJson ? JSON.parse(argsJson) : {};

const ctx = {
  env: {
    ADO_ORG: process.env.ADO_ORG ?? '',
    ADO_PROJECT: process.env.ADO_PROJECT ?? '',
    ADO_BEARER_TOKEN: process.env.ADO_BEARER_TOKEN ?? '',
    ADO_PAT: process.env.ADO_PAT ?? '',
  },
  workspace: {
    project_dir: process.cwd(),
    plugin_dir: process.cwd(),
    plugin_data_dir: process.cwd(),
  },
  fetch: globalThis.fetch.bind(globalThis),
  logger: { info: console.log, warn: console.warn, error: console.error },
  signal: new AbortController().signal,
};

try {
  const out = await mod.default(mod.parameters.parse(args), ctx);
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  const e = err as Error & { code?: string; status?: number; body?: string };
  console.error('ERROR:', e.message);
  if (e.code) console.error('  code:', e.code);
  if (e.status) console.error('  status:', e.status);
  if (e.body) console.error('  body:', String(e.body).slice(0, 800));
  process.exit(1);
}
