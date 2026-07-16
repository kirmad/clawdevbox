/**
 * cli/config-set.ts
 *
 * `clawdevbox config set <key> <value> [--global|--project]` — mutate a
 * single field of the project- or global-scope config.json.
 *
 * Currently supported keys:
 *   default_agent_cli   Provider id used by the main agent and by
 *                       `recipe.run` when no `agent_cli` arg is supplied.
 *                       Validated against the live provider registry — only
 *                       a currently-registered id (built-in or plugin) is
 *                       accepted.
 *
 * Exit codes:
 *   0  success
 *   1  workspace / I/O error
 *   2  bad usage or invalid value
 *
 * Unsupported keys / unknown provider ids fail with a helpful message and
 * exit code 2 — we deliberately don't allow blind writes of arbitrary
 * fields here. Use `clawdevbox init` (or hand-edit the file) for the rest.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveConfig, configPath, globalConfigPath, CONFIG_VERSION } from '../config.ts';
import { loadWorkspaceFromEnv } from '../workspace.ts';

const SUPPORTED_KEYS = new Set(['default_agent_cli']);

export async function runConfigSet(argv: string[]): Promise<number> {
  let globalFlag = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--global') globalFlag = true;
    else if (arg === '--project') globalFlag = false;
    else positional.push(arg);
  }

  if (positional.length < 3 || positional[0] !== 'set') {
    process.stderr.write(
      'usage: clawdevbox config set <key> <value> [--global|--project]\n',
    );
    return 2;
  }
  const key = positional[1]!;
  const value = positional[2]!;
  const scope: 'project' | 'global' = globalFlag ? 'global' : 'project';

  if (!SUPPORTED_KEYS.has(key)) {
    process.stderr.write(
      `unsupported key '${key}'. Supported: ${[...SUPPORTED_KEYS].join(', ')}\n`,
    );
    return 2;
  }

  let ws;
  try {
    ws = await loadWorkspaceFromEnv();
  } catch (err) {
    process.stderr.write(
      `failed to load workspace: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (key === 'default_agent_cli') {
    if (!ws.agentCliProviders.has(value)) {
      const available = [...ws.agentCliProviders.keys()].join(', ');
      process.stderr.write(
        `provider '${value}' is not registered. Available: ${available}\n`,
      );
      return 2;
    }
  }

  let cfg;
  try {
    cfg = resolveConfig();
  } catch (err) {
    process.stderr.write(
      `failed to resolve config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const p =
    scope === 'global'
      ? globalConfigPath(cfg.globalDir)
      : configPath(cfg.projectDir);

  let obj: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        obj = parsed as Record<string, unknown>;
      }
    } catch (err) {
      process.stderr.write(
        `failed to read existing config at ${p}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  } else {
    mkdirSync(dirname(p), { recursive: true });
    obj.version = CONFIG_VERSION;
  }
  if (obj.version === undefined) obj.version = CONFIG_VERSION;
  obj[key] = value;

  try {
    writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(
      `failed to write ${p}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  process.stdout.write(`set ${key}=${value} in ${p}\n`);
  return 0;
}
