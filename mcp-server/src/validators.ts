/**
 * validators.ts
 *
 * Shape-only validators for recipe (spec §7.4), skill (markdown frontmatter
 * convention), trigger (spec §8 + §8.1 — the JSON shape), and plugin manifest
 * (spec §10.2 / §10.7).
 *
 * Every validator returns `{ ok: true } | { ok: false, errors: [{path, code,
 * message}] }`. No graph checks, no tool-reference checks, no MiniJinja —
 * just enough to keep malformed data off disk.
 */

import { load as yamlLoad } from 'js-yaml';
import type {
  PluginManifest as PluginManifestJson,
  AgencyJson,
  MarketplaceJson,
  MarketplaceConfig,
  PluginStatus,
  ClawdevboxExtensions,
  McpServerConfig,
} from './manifest/types.ts';

export interface ValidationError {
  path: string;
  code: string;
  message: string;
}
export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

// ============================================================================
// Internal helpers
// ============================================================================

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const STEP_PARAM_NAME_PATTERN = /^[a-z][a-z0-9_]*$/i;
const STEP_PARAM_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object']);
/**
 * Hostable-tool ids are namespaced: <plugin>.<verb>. Both halves use snake_case
 * (underscores allowed) — a deliberate divergence from the kebab-case ID_PATTERN
 * because MCP tool naming conventions in the wild lean snake_case.
 */
const TOOL_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
/**
 * Trigger-type ids are also namespaced: <plugin>.<kebab-verb>. Plugin half
 * uses kebab-case (the plugin id pattern). The verb half is kebab-case too
 * (e.g. `ado.new-pr-watcher`) — distinct from tool ids which lean snake_case.
 */
const TRIGGER_TYPE_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const TRIGGER_PARAM_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object']);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const RECIPE_KINDS = new Set(['pr_review', 'workitem', 'incident', 'epic', 'custom']);

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

/**
 * Derive a short (≤ 200 char) human-readable TL;DR from a long-form step
 * `goal` that pre-dates the new ai_instructions field. Tries (in order):
 *   1. The first non-empty line.
 *   2. The first sentence (split on `.`, `?`, `!`).
 *   3. The first 200 chars + ellipsis.
 *
 * Stops trying at the first candidate that fits in 200 chars.
 */
function synthesizeShortGoal(longGoal: string): string {
  const lines = longGoal.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length <= 200) return line;
    const sentences = line.split(/(?<=[.?!])\s+/);
    for (const s of sentences) {
      if (s.length > 0 && s.length <= 200) return s.trim();
    }
    return line.slice(0, 197).trim() + '…';
  }
  return longGoal.slice(0, 197).trim() + '…';
}

// ============================================================================
// Recipe (TaskDock shape — spec §7.4)
// ============================================================================

export function validateRecipeSource(source: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = parseRecipeSource(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const trimmed = source.trimStart();
    const code =
      trimmed.startsWith('{') || trimmed.startsWith('[')
        ? 'JSON_PARSE_ERROR'
        : 'YAML_PARSE_ERROR';
    return { ok: false, errors: [{ path: '$', code, message: msg }] };
  }
  return validateRecipeParsed(parsed);
}

/**
 * Sniff a recipe source string and parse it as either JSON or YAML.
 *
 * Sniff rule (spec §4.4): skip leading whitespace; if the first non-whitespace
 * character is `{` or `[`, parse as JSON; otherwise parse as YAML. This means
 * agents and humans can mix formats freely — `recipe.run({source: '...'})`,
 * `recipe.upsert({source: '...'})`, and on-disk recipe files all go through
 * this single helper.
 */
export function parseRecipeSource(source: string): unknown {
  let i = 0;
  while (i < source.length && /\s/.test(source[i])) i++;
  const first = source[i];
  if (first === '{' || first === '[') {
    return JSON.parse(source);
  }
  return yamlLoad(source);
}

export function validateRecipeParsed(parsed: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'Recipe must be a YAML map.' }] };
  }
  const r = parsed as Record<string, unknown>;

  if (!isNonEmptyString(r.id)) {
    errors.push({ path: 'id', code: 'REQUIRED', message: 'id is required and must be a non-empty string.' });
  } else if (!ID_PATTERN.test(r.id)) {
    errors.push({ path: 'id', code: 'PATTERN', message: `id must match ${ID_PATTERN}.` });
  }
  if (!isNonEmptyString(r.name)) {
    errors.push({ path: 'name', code: 'REQUIRED', message: 'name is required and must be a non-empty string.' });
  }
  if (!isNonEmptyString(r.description)) {
    errors.push({ path: 'description', code: 'REQUIRED', message: 'description is required and must be a non-empty string.' });
  }
  if (r.kind !== undefined) {
    if (!isNonEmptyString(r.kind) || !RECIPE_KINDS.has(r.kind)) {
      errors.push({
        path: 'kind',
        code: 'ENUM',
        message: `kind must be one of: ${[...RECIPE_KINDS].join(', ')} (got ${JSON.stringify(r.kind)}).`,
      });
    }
  }
  if (r.default_client !== undefined) {
    if (
      typeof r.default_client !== 'string' ||
      r.default_client.length === 0 ||
      !/^[a-z0-9][a-z0-9._-]*$/i.test(r.default_client)
    ) {
      errors.push({
        path: 'default_client',
        code: 'INVALID_VALUE',
        message: `default_client must be a non-empty provider id (e.g. 'copilot', 'claude').`,
      });
    }
  }
  if (r.agent !== undefined) {
    // The agent name maps to `<plugin>/agents/<name>.agent.md`. When set,
    // recipe-runner forwards it to the CLI via the provider's `--agent`
    // flag so the spawned session loads that persona. Validate the name
    // shape only here; existence is checked lazily at `recipe.run` time
    // (the recipe may reference an agent from a plugin scheduled for
    // later install).
    if (
      typeof r.agent !== 'string' ||
      r.agent.length === 0 ||
      !/^[a-z0-9][a-z0-9._-]*$/i.test(r.agent)
    ) {
      errors.push({
        path: 'agent',
        code: 'INVALID_VALUE',
        message: `agent must be a non-empty agent name (e.g. 'dev-buddy', 'icm-investigator').`,
      });
    }
  }
  if (r.mcp_servers !== undefined) {
    if (!Array.isArray(r.mcp_servers) || !r.mcp_servers.every((s) => typeof s === 'string')) {
      errors.push({ path: 'mcp_servers', code: 'TYPE', message: 'mcp_servers must be an array of strings.' });
    }
  }
  if (r.timeout_minutes !== undefined) {
    if (typeof r.timeout_minutes !== 'number' || r.timeout_minutes < 0) {
      errors.push({ path: 'timeout_minutes', code: 'TYPE', message: 'timeout_minutes must be a non-negative number.' });
    }
  }
  if (r.steps !== undefined) {
    if (!Array.isArray(r.steps)) {
      errors.push({ path: 'steps', code: 'TYPE', message: 'steps must be an array.' });
    } else {
      // First pass: resolve every step's id to a string (coercing integer ids)
      // so we can build the declared-id set used by depends[] resolution.
      const declaredIds = new Set<string>();
      r.steps.forEach((step) => {
        if (!isPlainObject(step)) return;
        if (typeof step.id === 'number' && Number.isInteger(step.id)) {
          step.id = String(step.id);
        }
        if (typeof step.id === 'string') declaredIds.add(step.id);
      });

      const seenIds = new Set<string>();
      r.steps.forEach((step, i) => {
        const pathPrefix = `steps[${i}]`;
        if (!isPlainObject(step)) {
          errors.push({ path: pathPrefix, code: 'TYPE', message: 'step must be an object.' });
          return;
        }
        // id — accept string matching STEP_ID_PATTERN, OR an integer which
        // was already coerced to its string form in the first pass.
        if (typeof step.id !== 'string' || step.id.length === 0) {
          errors.push({ path: `${pathPrefix}.id`, code: 'REQUIRED', message: 'step.id is required and must be a string or integer.' });
        } else if (!STEP_ID_PATTERN.test(step.id)) {
          errors.push({ path: `${pathPrefix}.id`, code: 'PATTERN', message: `step.id must match ${STEP_ID_PATTERN}.` });
        } else if (seenIds.has(step.id)) {
          errors.push({ path: `${pathPrefix}.id`, code: 'DUPLICATE', message: `step id ${JSON.stringify(step.id)} duplicated.` });
        } else {
          seenIds.add(step.id);
        }

        // name — optional. Kept as a back-compat synonym for `goal`; new
        // recipes should set `goal` directly. When name is set, it must be a
        // non-empty string ≤ 200 chars.
        if (step.name !== undefined) {
          if (typeof step.name !== 'string') {
            errors.push({ path: `${pathPrefix}.name`, code: 'TYPE', message: 'step.name must be a string.' });
          } else if (step.name.length === 0) {
            errors.push({ path: `${pathPrefix}.name`, code: 'INVALID_VALUE', message: 'step.name must not be empty.' });
          } else if (step.name.length > 200) {
            errors.push({ path: `${pathPrefix}.name`, code: 'INVALID_VALUE', message: 'step.name must be ≤ 200 characters.' });
          }
        }

        // goal — required, human-readable TL;DR shown as the step title in
        // the UI. Should be ≤ 200 chars. For back-compat with older recipes
        // that put long agent instructions in `goal`: when goal > 200 chars,
        // auto-promote the long form into `ai_instructions` (if unset) and
        // synthesize a short goal from the first sentence/line. This keeps
        // legacy recipes working without a hard break.
        if (!isNonEmptyString(step.goal)) {
          errors.push({ path: `${pathPrefix}.goal`, code: 'REQUIRED', message: 'step.goal is required and must be a non-empty string (human-readable TL;DR ≤ 200 chars).' });
        } else if ((step.goal as string).length > 200) {
          // Auto-promote: long goal → ai_instructions + synthesize short goal.
          const longGoal = step.goal as string;
          if (typeof step.ai_instructions !== 'string' || step.ai_instructions.length === 0) {
            step.ai_instructions = longGoal;
          }
          step.goal = synthesizeShortGoal(longGoal);
        }

        // ai_instructions — optional. The full agent-facing prompt for this
        // step. Use when the step requires meaningful agent work; omit for
        // purely-informational / gate steps that don't need agent execution.
        // Max 16000 chars (room for detailed multi-paragraph instructions).
        if (step.ai_instructions !== undefined) {
          if (typeof step.ai_instructions !== 'string') {
            errors.push({ path: `${pathPrefix}.ai_instructions`, code: 'TYPE', message: 'step.ai_instructions must be a string.' });
          } else if (step.ai_instructions.length === 0) {
            errors.push({ path: `${pathPrefix}.ai_instructions`, code: 'INVALID_VALUE', message: 'step.ai_instructions must not be empty (omit the field if no agent work is needed).' });
          } else if (step.ai_instructions.length > 16000) {
            errors.push({ path: `${pathPrefix}.ai_instructions`, code: 'INVALID_VALUE', message: 'step.ai_instructions must be ≤ 16000 characters.' });
          }
        }

        // depends — accept array of strings or integers (integers coerced in place).
        if (step.depends !== undefined) {
          if (!Array.isArray(step.depends)) {
            errors.push({ path: `${pathPrefix}.depends`, code: 'TYPE', message: 'step.depends must be an array of step ids.' });
          } else {
            const coerced: string[] = [];
            let bad = false;
            step.depends.forEach((d, j) => {
              if (typeof d === 'number' && Number.isInteger(d)) {
                coerced.push(String(d));
              } else if (typeof d === 'string' && d.length > 0) {
                coerced.push(d);
              } else {
                bad = true;
                errors.push({ path: `${pathPrefix}.depends[${j}]`, code: 'TYPE', message: 'step.depends entries must be strings or integers.' });
              }
            });
            if (!bad) {
              step.depends = coerced;
              coerced.forEach((d, j) => {
                if (!declaredIds.has(d)) {
                  errors.push({
                    path: `${pathPrefix}.depends[${j}]`,
                    code: 'UNRESOLVED_REF',
                    message: `depends[] references step id ${JSON.stringify(d)}, which is not declared.`,
                  });
                }
              });
            }
          }
        }

        // params — optional array of {name, type, required?, default?, description?}.
        if (step.params !== undefined) {
          if (!Array.isArray(step.params)) {
            errors.push({ path: `${pathPrefix}.params`, code: 'TYPE', message: 'step.params must be an array.' });
          } else {
            step.params.forEach((p, j) => {
              const pp = `${pathPrefix}.params[${j}]`;
              if (!isPlainObject(p)) {
                errors.push({ path: pp, code: 'TYPE', message: 'param must be an object.' });
                return;
              }
              if (!isNonEmptyString(p.name)) {
                errors.push({ path: `${pp}.name`, code: 'REQUIRED', message: 'param.name is required and must be a non-empty string.' });
              } else if (!STEP_PARAM_NAME_PATTERN.test(p.name)) {
                errors.push({ path: `${pp}.name`, code: 'PATTERN', message: `param.name must match ${STEP_PARAM_NAME_PATTERN}.` });
              }
              if (!isNonEmptyString(p.type) || !STEP_PARAM_TYPES.has(p.type)) {
                errors.push({
                  path: `${pp}.type`,
                  code: 'INVALID_VALUE',
                  message: `param.type must be one of: ${[...STEP_PARAM_TYPES].join(', ')}.`,
                });
              }
              if (p.required !== undefined && typeof p.required !== 'boolean') {
                errors.push({ path: `${pp}.required`, code: 'TYPE', message: 'param.required must be a boolean.' });
              }
              if (p.description !== undefined && typeof p.description !== 'string') {
                errors.push({ path: `${pp}.description`, code: 'TYPE', message: 'param.description must be a string.' });
              }
            });
          }
        }

        // triggers — optional array of trigger declarations.
        if (step.triggers !== undefined) {
          if (!Array.isArray(step.triggers)) {
            errors.push({ path: `${pathPrefix}.triggers`, code: 'TYPE', message: 'step.triggers must be an array.' });
          } else {
            step.triggers.forEach((t, j) => {
              const tp = `${pathPrefix}.triggers[${j}]`;
              if (!isPlainObject(t)) {
                errors.push({ path: tp, code: 'TYPE', message: 'trigger declaration must be an object.' });
                return;
              }
              if (!isNonEmptyString(t.type)) {
                errors.push({ path: `${tp}.type`, code: 'REQUIRED', message: 'trigger.type is required and must be a non-empty string.' });
              }
              if (t.params !== undefined && !isPlainObject(t.params)) {
                errors.push({ path: `${tp}.params`, code: 'TYPE', message: 'trigger.params must be an object.' });
              }
              if (t.cron !== undefined && t.cron !== null && t.cron !== false && typeof t.cron !== 'string') {
                errors.push({ path: `${tp}.cron`, code: 'TYPE', message: 'trigger.cron must be a string, null, or false.' });
              }
              if (t.once !== undefined && typeof t.once !== 'boolean') {
                errors.push({ path: `${tp}.once`, code: 'TYPE', message: 'trigger.once must be a boolean.' });
              }
              if (t.expires_at !== undefined && (typeof t.expires_at !== 'number' || !Number.isFinite(t.expires_at))) {
                errors.push({ path: `${tp}.expires_at`, code: 'TYPE', message: 'trigger.expires_at must be a number.' });
              }
              if (t.max_attempts !== undefined) {
                if (!Number.isInteger(t.max_attempts) || (t.max_attempts as number) < 1) {
                  errors.push({ path: `${tp}.max_attempts`, code: 'INVALID_VALUE', message: 'trigger.max_attempts must be an integer ≥ 1.' });
                }
              }
              if (t.backoff_ms !== undefined) {
                if (!Array.isArray(t.backoff_ms) || !t.backoff_ms.every((x) => Number.isInteger(x))) {
                  errors.push({ path: `${tp}.backoff_ms`, code: 'TYPE', message: 'trigger.backoff_ms must be an array of integers.' });
                }
              }
            });
          }
        }

        // artifacts — optional array of {id, type, title?}.
        if (step.artifacts !== undefined) {
          if (!Array.isArray(step.artifacts)) {
            errors.push({ path: `${pathPrefix}.artifacts`, code: 'TYPE', message: 'step.artifacts must be an array.' });
          } else {
            step.artifacts.forEach((a, j) => {
              const ap = `${pathPrefix}.artifacts[${j}]`;
              if (!isPlainObject(a)) {
                errors.push({ path: ap, code: 'TYPE', message: 'artifact declaration must be an object.' });
                return;
              }
              if (!isNonEmptyString(a.id)) {
                errors.push({ path: `${ap}.id`, code: 'REQUIRED', message: 'artifact.id is required and must be a non-empty string.' });
              } else if (!STEP_ID_PATTERN.test(a.id)) {
                errors.push({ path: `${ap}.id`, code: 'PATTERN', message: `artifact.id must match ${STEP_ID_PATTERN}.` });
              }
              if (!isNonEmptyString(a.type)) {
                errors.push({ path: `${ap}.type`, code: 'REQUIRED', message: 'artifact.type is required and must be a non-empty string.' });
              }
              if (a.title !== undefined && typeof a.title !== 'string') {
                errors.push({ path: `${ap}.title`, code: 'TYPE', message: 'artifact.title must be a string.' });
              }
            });
          }
        }
      });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ============================================================================
// Skill (markdown frontmatter)
// ============================================================================

/**
 * Skills are markdown files with a YAML frontmatter block starting and ending
 * with `---` delimiters. We require `name` and `description` in the frontmatter
 * — everything else is free-form prose.
 */
export interface ParsedSkill {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseSkill(source: string): { ok: true; value: ParsedSkill } | { ok: false; errors: ValidationError[] } {
  const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = source.match(fmRegex);
  if (!match) {
    return {
      ok: false,
      errors: [
        {
          path: '$',
          code: 'FRONTMATTER_MISSING',
          message: 'Skill must begin with a `---`-delimited YAML frontmatter block.',
        },
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = yamlLoad(match[1]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [{ path: 'frontmatter', code: 'YAML_PARSE_ERROR', message: msg }] };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      errors: [{ path: 'frontmatter', code: 'NOT_OBJECT', message: 'Skill frontmatter must be a YAML map.' }],
    };
  }
  return { ok: true, value: { frontmatter: parsed, body: match[2] } };
}

export function validateSkillSource(source: string): ValidationResult {
  const parsed = parseSkill(source);
  if (!parsed.ok) return parsed;
  const errors: ValidationError[] = [];
  const fm = parsed.value.frontmatter;
  if (!isNonEmptyString(fm.name)) {
    errors.push({ path: 'frontmatter.name', code: 'REQUIRED', message: 'Skill frontmatter must include a non-empty `name`.' });
  } else if (!ID_PATTERN.test(fm.name as string)) {
    errors.push({ path: 'frontmatter.name', code: 'PATTERN', message: `frontmatter.name must match ${ID_PATTERN}.` });
  }
  if (!isNonEmptyString(fm.description)) {
    errors.push({ path: 'frontmatter.description', code: 'REQUIRED', message: 'Skill frontmatter must include a non-empty `description`.' });
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ============================================================================
// Plugin manifest (spec §10.2 / §10.7)
// ============================================================================

export function validatePluginManifest(parsed: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'plugin manifest must be an object.' }] };
  }
  const m = parsed as Record<string, unknown>;

  if (!isNonEmptyString(m.id)) {
    errors.push({ path: 'id', code: 'REQUIRED', message: 'plugin.id is required.' });
  } else if (!ID_PATTERN.test(m.id)) {
    errors.push({ path: 'id', code: 'PATTERN', message: 'plugin.id must match [a-z][a-z0-9-]*.' });
  }
  if (!isNonEmptyString(m.name)) {
    errors.push({ path: 'name', code: 'REQUIRED', message: 'plugin.name is required.' });
  }
  if (!isNonEmptyString(m.version)) {
    errors.push({ path: 'version', code: 'REQUIRED', message: 'plugin.version is required.' });
  } else if (!SEMVER.test(m.version)) {
    errors.push({ path: 'version', code: 'PATTERN', message: 'plugin.version must be a valid semver.' });
  }
  if (!isNonEmptyString(m.description)) {
    errors.push({ path: 'description', code: 'REQUIRED', message: 'plugin.description is required.' });
  }
  if (m.provides !== undefined) {
    if (!isPlainObject(m.provides)) {
      errors.push({ path: 'provides', code: 'TYPE', message: 'provides must be an object.' });
    } else {
      const provides = m.provides as Record<string, unknown>;
      // skills / recipes / tools / mcp_servers share the simple { id, file } shape.
      // trigger_types is richer — see validateTriggerTypeEntry below.
      for (const family of ['skills', 'recipes', 'tools', 'mcp_servers']) {
        const list = provides[family];
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          errors.push({ path: `provides.${family}`, code: 'TYPE', message: `provides.${family} must be an array.` });
          continue;
        }
        const seen = new Set<string>();
        const idPattern = family === 'tools' ? TOOL_ID_PATTERN : ID_PATTERN;
        const idRule =
          family === 'tools'
            ? `${TOOL_ID_PATTERN} (namespaced — e.g., 'ado.get_pr')`
            : `${ID_PATTERN}`;
        list.forEach((entry, i) => {
          const p = `provides.${family}[${i}]`;
          if (!isPlainObject(entry)) {
            errors.push({ path: p, code: 'TYPE', message: 'entry must be an object.' });
            return;
          }
          if (!isNonEmptyString(entry.id)) {
            errors.push({ path: `${p}.id`, code: 'REQUIRED', message: 'entry.id required.' });
          } else if (!idPattern.test(entry.id)) {
            errors.push({ path: `${p}.id`, code: 'PATTERN', message: `entry.id must match ${idRule}.` });
          } else if (seen.has(entry.id)) {
            errors.push({ path: `${p}.id`, code: 'DUPLICATE', message: `id ${entry.id} duplicated within ${family}.` });
          } else {
            seen.add(entry.id);
          }
          if (!isNonEmptyString(entry.file)) {
            errors.push({ path: `${p}.file`, code: 'REQUIRED', message: 'entry.file required.' });
          } else if ((entry.file as string).includes('..')) {
            errors.push({ path: `${p}.file`, code: 'PATH_ESCAPE', message: 'entry.file may not contain ".."' });
          } else if (family === 'tools' && !/\.(ts|js|mjs)$/i.test(entry.file as string)) {
            // Hostable tool files must be importable. Manifest-time check is path-only;
            // the runtime additionally validates the module's exported shape.
            errors.push({
              path: `${p}.file`,
              code: 'TOOL_FILE_EXT',
              message: 'tools[].file must end in .ts, .js, or .mjs.',
            });
          }
        });
      }

      // trigger_types — capability declarations (spec §8.2 / §10.2).
      if (provides.trigger_types !== undefined) {
        if (!Array.isArray(provides.trigger_types)) {
          errors.push({
            path: 'provides.trigger_types',
            code: 'TYPE',
            message: 'provides.trigger_types must be an array.',
          });
        } else {
          const seenTypeIds = new Set<string>();
          provides.trigger_types.forEach((entry, i) => {
            const p = `provides.trigger_types[${i}]`;
            const entryErrors = validateTriggerTypeEntry(entry, p);
            if (entryErrors.length > 0) {
              errors.push(...entryErrors);
              return;
            }
            const e = entry as Record<string, unknown>;
            const id = e.id as string;
            if (seenTypeIds.has(id)) {
              errors.push({
                path: `${p}.id`,
                code: 'DUPLICATE',
                message: `trigger_type id ${id} duplicated within plugin.`,
              });
            } else {
              seenTypeIds.add(id);
            }
          });
        }
      }

      // agent_clis — AgentCliProvider declarations (spec §4).
      if (provides.agent_clis !== undefined) {
        if (!Array.isArray(provides.agent_clis)) {
          errors.push({
            path: 'provides.agent_clis',
            code: 'TYPE',
            message: 'provides.agent_clis must be an array.',
          });
        } else {
          const seenCliIds = new Set<string>();
          provides.agent_clis.forEach((entry, i) => {
            const entryErrors = validatePluginAgentCliEntry(entry, i);
            if (entryErrors.length > 0) {
              errors.push(...entryErrors);
              return;
            }
            const e = entry as Record<string, unknown>;
            const id = e.id as string;
            if (seenCliIds.has(id)) {
              errors.push({
                path: `provides.agent_clis[${i}].id`,
                code: 'DUPLICATE',
                message: `agent_cli id ${id} duplicated within plugin.`,
              });
            } else {
              seenCliIds.add(id);
            }
          });
        }
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ============================================================================
// Trigger-type entry validator (used inside plugin-manifest validation)
// ============================================================================

/**
 * Cron-expression shape check — 5- or 6-field cron with character-class
 * limits. Same lenient pattern used for trigger registrations.
 */
const CRON_FIELD = /^[*?\/0-9,A-Za-z-]+$/;
export function isValidCronExpression(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  const fields = s.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  return fields.every((f) => CRON_FIELD.test(f));
}

/**
 * Validate a `max_attempts` value for a registered trigger (spec §6.2).
 * Must be a positive integer; capped at 100 to keep dead-letter loops bounded.
 */
export function validateMaxAttempts(
  v: unknown,
): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return { ok: false, message: 'max_attempts must be an integer.' };
  }
  if (v < 1) return { ok: false, message: 'max_attempts must be >= 1.' };
  if (v > 100) return { ok: false, message: 'max_attempts must be <= 100.' };
  return { ok: true, value: v };
}

/**
 * Validate a `backoff_ms` value for a registered trigger (spec §6.2).
 * Must be a non-empty array of non-negative integers; each value capped at
 * 24h (86_400_000 ms) to prevent runaway retry windows.
 */
export function validateBackoffMs(
  v: unknown,
): { ok: true; value: number[] } | { ok: false; message: string } {
  if (!Array.isArray(v)) return { ok: false, message: 'backoff_ms must be an array.' };
  if (v.length === 0) return { ok: false, message: 'backoff_ms must be non-empty.' };
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const n = v[i];
    if (typeof n !== 'number' || !Number.isInteger(n)) {
      return { ok: false, message: `backoff_ms[${i}] must be an integer.` };
    }
    if (n < 0) return { ok: false, message: `backoff_ms[${i}] must be >= 0.` };
    if (n > 86_400_000) {
      return { ok: false, message: `backoff_ms[${i}] must be <= 86400000 (24h).` };
    }
    out.push(n);
  }
  return { ok: true, value: out };
}

/**
 * `provides.agent_clis[]` entry validator (spec §4). Mirrors the
 * `validateTriggerTypeEntry` pattern. Ids must match the standard pattern;
 * module is a relative path with no `..` segments and no absolute roots.
 */
export function validatePluginAgentCliEntry(entry: unknown, i: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const path = `provides.agent_clis[${i}]`;
  if (!isPlainObject(entry)) {
    errors.push({ path, code: 'TYPE', message: 'agent_clis entry must be an object.' });
    return errors;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(e.id)) {
    errors.push({
      path: `${path}.id`,
      code: 'INVALID_VALUE',
      message: 'id is required and must match /^[a-z0-9][a-z0-9._-]*$/i',
    });
  }
  if (typeof e.module !== 'string' || (e.module as string).trim() === '') {
    errors.push({ path: `${path}.module`, code: 'REQUIRED', message: 'module is required.' });
  } else {
    const m = e.module as string;
    if (
      m.split(/[\\/]/).some((seg) => seg === '..') ||
      m.startsWith('/') ||
      m.startsWith('\\') ||
      /^[A-Z]:/i.test(m)
    ) {
      errors.push({
        path: `${path}.module`,
        code: 'INVALID_VALUE',
        message: 'module must be a relative path with no .. segments.',
      });
    }
  }
  if (e.display_name !== undefined && typeof e.display_name !== 'string') {
    errors.push({ path: `${path}.display_name`, code: 'TYPE', message: 'display_name must be a string.' });
  }
  if (e.description !== undefined && typeof e.description !== 'string') {
    errors.push({ path: `${path}.description`, code: 'TYPE', message: 'description must be a string.' });
  }
  return errors;
}

function validateTriggerTypeEntry(entry: unknown, p: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isPlainObject(entry)) {
    errors.push({ path: p, code: 'TYPE', message: 'trigger_type entry must be an object.' });
    return errors;
  }
  const e = entry as Record<string, unknown>;

  // id
  if (!isNonEmptyString(e.id)) {
    errors.push({ path: `${p}.id`, code: 'REQUIRED', message: 'trigger_type.id required.' });
  } else if (!TRIGGER_TYPE_ID_PATTERN.test(e.id)) {
    errors.push({
      path: `${p}.id`,
      code: 'PATTERN',
      message: `trigger_type.id must match ${TRIGGER_TYPE_ID_PATTERN} (e.g. 'ado.new-pr-watcher').`,
    });
  }

  // file
  if (!isNonEmptyString(e.file)) {
    errors.push({ path: `${p}.file`, code: 'REQUIRED', message: 'trigger_type.file required.' });
  } else if ((e.file as string).includes('..')) {
    errors.push({
      path: `${p}.file`,
      code: 'PATH_ESCAPE',
      message: 'trigger_type.file may not contain ".."',
    });
  }

  // description (optional but typed)
  if (e.description !== undefined && typeof e.description !== 'string') {
    errors.push({ path: `${p}.description`, code: 'TYPE', message: 'description must be a string.' });
  }

  // default_cron (optional)
  if (e.default_cron !== undefined && e.default_cron !== null) {
    if (typeof e.default_cron !== 'string') {
      errors.push({ path: `${p}.default_cron`, code: 'TYPE', message: 'default_cron must be a string.' });
    } else if (!isValidCronExpression(e.default_cron)) {
      errors.push({
        path: `${p}.default_cron`,
        code: 'CRON_INVALID',
        message: 'default_cron must be a valid 5- or 6-field cron expression.',
      });
    }
  }

  // accepts_webhook (optional)
  if (e.accepts_webhook !== undefined && typeof e.accepts_webhook !== 'boolean') {
    errors.push({
      path: `${p}.accepts_webhook`,
      code: 'TYPE',
      message: 'accepts_webhook must be a boolean.',
    });
  }

  // parameters (optional)
  const paramNames = new Set<string>();
  if (e.parameters !== undefined) {
    if (!Array.isArray(e.parameters)) {
      errors.push({ path: `${p}.parameters`, code: 'TYPE', message: 'parameters must be an array.' });
    } else {
      e.parameters.forEach((param, j) => {
        const pp = `${p}.parameters[${j}]`;
        if (!isPlainObject(param)) {
          errors.push({ path: pp, code: 'TYPE', message: 'parameter must be an object.' });
          return;
        }
        const pm = param as Record<string, unknown>;
        if (!isNonEmptyString(pm.name)) {
          errors.push({ path: `${pp}.name`, code: 'REQUIRED', message: 'parameter.name required.' });
        } else if (paramNames.has(pm.name)) {
          errors.push({
            path: `${pp}.name`,
            code: 'DUPLICATE',
            message: `parameter name ${JSON.stringify(pm.name)} duplicated.`,
          });
        } else {
          paramNames.add(pm.name);
        }
        if (!isNonEmptyString(pm.type) || !TRIGGER_PARAM_TYPES.has(pm.type as string)) {
          errors.push({
            path: `${pp}.type`,
            code: 'ENUM',
            message: `parameter.type must be one of: ${[...TRIGGER_PARAM_TYPES].join(', ')} (got ${JSON.stringify(pm.type)}).`,
          });
        }
        if (pm.required !== undefined && typeof pm.required !== 'boolean') {
          errors.push({ path: `${pp}.required`, code: 'TYPE', message: 'required must be a boolean.' });
        }
        if (pm.description !== undefined && typeof pm.description !== 'string') {
          errors.push({ path: `${pp}.description`, code: 'TYPE', message: 'description must be a string.' });
        }
        // `default` must match declared type when both are present.
        if (
          pm.default !== undefined &&
          isNonEmptyString(pm.type) &&
          TRIGGER_PARAM_TYPES.has(pm.type as string) &&
          !defaultMatchesType(pm.default, pm.type as string)
        ) {
          errors.push({
            path: `${pp}.default`,
            code: 'DEFAULT_TYPE_MISMATCH',
            message: `default value does not match declared type ${pm.type}.`,
          });
        }
      });
    }
  }

  // identity_param (optional) must reference an existing parameter name.
  if (e.identity_param !== undefined) {
    if (!isNonEmptyString(e.identity_param)) {
      errors.push({
        path: `${p}.identity_param`,
        code: 'TYPE',
        message: 'identity_param must be a string.',
      });
    } else if (!paramNames.has(e.identity_param)) {
      errors.push({
        path: `${p}.identity_param`,
        code: 'UNRESOLVED_REF',
        message: `identity_param ${JSON.stringify(e.identity_param)} does not match any declared parameter.`,
      });
    }
  }

  // runtime (optional on plugin-shipped types — defaults to 'tsx')
  if (e.runtime !== undefined) {
    const r = validateRuntime(e.runtime);
    if (!r.ok) {
      errors.push({ path: `${p}.runtime`, code: 'ENUM', message: r.message });
    }
  }

  return errors;
}

function defaultMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

// ============================================================================
// Registered-trigger param validation (spec §8.3)
// ============================================================================

/**
 * Minimal param-schema shape used by `validateTriggerParams`. Mirrors
 * PluginTriggerType['parameters'][number] from workspace.ts.
 */
export interface ParamSchema {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  default?: unknown;
}

/**
 * Validate a `params` object against a trigger type's parameter declarations.
 * Returns `{ ok, params }` where `params` has defaults applied; or an error
 * list. Extra params (not declared on the type) are kept as-is — types are
 * forward-compatible.
 */
export function validateTriggerParams(
  schema: ParamSchema[] | undefined,
  raw: unknown,
):
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    return {
      ok: false,
      errors: [{ path: 'params', code: 'TYPE', message: 'params must be an object.' }],
    };
  }
  const input = (raw as Record<string, unknown> | null | undefined) ?? {};
  const out: Record<string, unknown> = { ...input };

  for (const p of schema ?? []) {
    const present = Object.prototype.hasOwnProperty.call(input, p.name);
    const value = input[p.name];
    if (!present || value === undefined || value === null) {
      if (p.required) {
        errors.push({
          path: `params.${p.name}`,
          code: 'REQUIRED',
          message: `param ${p.name} is required.`,
        });
      } else if (p.default !== undefined) {
        out[p.name] = p.default;
      }
      continue;
    }
    if (!defaultMatchesType(value, p.type)) {
      errors.push({
        path: `params.${p.name}`,
        code: 'TYPE',
        message: `param ${p.name} must be of type ${p.type} (got ${describeType(value)}).`,
      });
    }
  }

  return errors.length === 0 ? { ok: true, params: out } : { ok: false, errors };
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ============================================================================
// Agent-authored trigger template validators (Task 0.2)
// ============================================================================

const RUNTIMES = new Set(['node', 'tsx', 'python', 'bash']);
const LOCAL_TRIGGER_ID_PATTERN = /^local\.[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

export type TriggerRuntime = 'node' | 'tsx' | 'python' | 'bash';

export function validateRuntime(
  value: unknown,
): { ok: true; runtime: TriggerRuntime } | { ok: false; message: string } {
  if (typeof value !== 'string' || !RUNTIMES.has(value)) {
    return { ok: false, message: `runtime must be one of: ${[...RUNTIMES].join(', ')}` };
  }
  return { ok: true, runtime: value as TriggerRuntime };
}

export function validateLocalTriggerTypeId(
  id: string,
): { ok: true } | { ok: false; message: string } {
  if (typeof id !== 'string' || !LOCAL_TRIGGER_ID_PATTERN.test(id)) {
    return { ok: false, message: `id must match ${LOCAL_TRIGGER_ID_PATTERN} (start with 'local.')` };
  }
  return { ok: true };
}

/**
 * Full-shape validator for an agent-authored template manifest. Reuses the
 * plugin-side validateTriggerTypeEntry but layers on the local. id requirement
 * and the required runtime field.
 */
export function validateAgentAuthoredTemplate(parsed: unknown): ValidationResult {
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'template must be a YAML map.' }] };
  }
  const errors: ValidationError[] = [];
  const e = parsed as Record<string, unknown>;

  if (typeof e.id === 'string') {
    const idCheck = validateLocalTriggerTypeId(e.id);
    if (!idCheck.ok) {
      errors.push({ path: 'id', code: 'PATTERN', message: idCheck.message });
    }
  } else {
    errors.push({ path: 'id', code: 'REQUIRED', message: 'id is required.' });
  }

  if (e.runtime === undefined) {
    errors.push({ path: 'runtime', code: 'REQUIRED', message: 'runtime is required for agent-authored templates.' });
  } else {
    const runtimeCheck = validateRuntime(e.runtime);
    if (!runtimeCheck.ok) {
      errors.push({ path: 'runtime', code: 'ENUM', message: runtimeCheck.message });
    }
  }

  // Reuse the plugin-side per-entry validator for everything else (file, parameters,
  // cron, binding XOR, identity_param, accepts_webhook). It writes paths prefixed
  // with the passed-in `p`; we strip the prefix to keep our error paths flat.
  const reused = validateTriggerTypeEntry(parsed, '$');
  for (const err of reused) {
    if (err.path === '$.id') continue; // we already validated id with the local. rule
    errors.push({ ...err, path: err.path.startsWith('$.') ? err.path.slice(2) : err.path });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}



// ============================================================================
// Claude-aligned plugin.json manifest (spec §3) + Marketplace (§4)
//
// These validators operate on the new `.claude-plugin/plugin.json` shape and
// its marketplace siblings. They coexist with the legacy yaml-shaped
// `validatePluginManifest` above until Phase 2 cuts the loader over.
//
// All return `ValidationError[]` (empty = ok) — easier to compose than the
// `ValidationResult` discriminated union the older validators use.
// ============================================================================

const KEBAB_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const ENGINE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Reject path strings that try to escape the plugin root: any `..` segment,
 * a leading POSIX root (`/`), a leading backslash, or a Windows drive prefix
 * (`C:` etc.). Used by every Claude-style path field (skills, agents, etc.).
 */
function isUnsafeRelPath(p: string): boolean {
  if (typeof p !== 'string') return true;
  if (p.length === 0) return true;
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  return p.split(/[\\/]/).some((seg) => seg === '..');
}

/**
 * Validate a path field that may be a string or string[]. Each entry is
 * checked with `isUnsafeRelPath`. The field is optional — undefined is fine.
 */
function checkStringOrStringArrayPath(
  value: unknown,
  fieldPath: string,
  errors: ValidationError[],
): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    if (isUnsafeRelPath(value)) {
      errors.push({
        path: fieldPath,
        code: 'PATH_ESCAPE',
        message: `${fieldPath} must be a relative path with no ".." segments.`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => {
      if (typeof entry !== 'string') {
        errors.push({
          path: `${fieldPath}[${i}]`,
          code: 'TYPE',
          message: `${fieldPath}[${i}] must be a string.`,
        });
      } else if (isUnsafeRelPath(entry)) {
        errors.push({
          path: `${fieldPath}[${i}]`,
          code: 'PATH_ESCAPE',
          message: `${fieldPath}[${i}] must be a relative path with no ".." segments.`,
        });
      }
    });
    return;
  }
  errors.push({
    path: fieldPath,
    code: 'TYPE',
    message: `${fieldPath} must be a string or array of strings.`,
  });
}

function checkOptionalString(value: unknown, fieldPath: string, errors: ValidationError[]): void {
  if (value !== undefined && typeof value !== 'string') {
    errors.push({ path: fieldPath, code: 'TYPE', message: `${fieldPath} must be a string.` });
  }
}

function checkOptionalStringArray(
  value: unknown,
  fieldPath: string,
  errors: ValidationError[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path: fieldPath, code: 'TYPE', message: `${fieldPath} must be an array.` });
    return;
  }
  value.forEach((entry, i) => {
    if (typeof entry !== 'string') {
      errors.push({
        path: `${fieldPath}[${i}]`,
        code: 'TYPE',
        message: `${fieldPath}[${i}] must be a string.`,
      });
    }
  });
}

/**
 * Validate the Microsoft `status` extension subtree.
 * `testedWith` is required when the status object is present.
 */
function validatePluginStatus(value: unknown, errors: ValidationError[]): void {
  if (!isPlainObject(value)) {
    errors.push({ path: 'status', code: 'TYPE', message: 'status must be an object.' });
    return;
  }
  const s = value as Record<string, unknown>;
  if (!isNonEmptyString(s.testedWith)) {
    errors.push({
      path: 'status.testedWith',
      code: 'REQUIRED',
      message: 'status.testedWith is required when status is present.',
    });
  }
  if (s.experimental !== undefined && typeof s.experimental !== 'boolean') {
    errors.push({
      path: 'status.experimental',
      code: 'TYPE',
      message: 'status.experimental must be a boolean.',
    });
  }
  if (s.notes !== undefined && typeof s.notes !== 'string') {
    errors.push({ path: 'status.notes', code: 'TYPE', message: 'status.notes must be a string.' });
  }
}

function validateAuthor(value: unknown, fieldPath: string, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    errors.push({ path: fieldPath, code: 'TYPE', message: `${fieldPath} must be an object.` });
    return;
  }
  const a = value as Record<string, unknown>;
  if (!isNonEmptyString(a.name)) {
    errors.push({
      path: `${fieldPath}.name`,
      code: 'REQUIRED',
      message: `${fieldPath}.name is required.`,
    });
  }
  if (a.email !== undefined && typeof a.email !== 'string') {
    errors.push({
      path: `${fieldPath}.email`,
      code: 'TYPE',
      message: `${fieldPath}.email must be a string.`,
    });
  }
  if (a.url !== undefined && typeof a.url !== 'string') {
    errors.push({
      path: `${fieldPath}.url`,
      code: 'TYPE',
      message: `${fieldPath}.url must be a string.`,
    });
  }
}

/**
 * Validate a single `clawdevbox.recipes[]` or `clawdevbox.tools[]` entry:
 * `id` kebab/dotted, `file` a safe relative path.
 */
function validateSimpleProvideEntry(
  entry: unknown,
  fieldPath: string,
  idPattern: RegExp,
  errors: ValidationError[],
): void {
  if (!isPlainObject(entry)) {
    errors.push({ path: fieldPath, code: 'TYPE', message: `${fieldPath} must be an object.` });
    return;
  }
  const e = entry as Record<string, unknown>;
  if (!isNonEmptyString(e.id)) {
    errors.push({
      path: `${fieldPath}.id`,
      code: 'REQUIRED',
      message: `${fieldPath}.id is required.`,
    });
  } else if (!idPattern.test(e.id)) {
    errors.push({
      path: `${fieldPath}.id`,
      code: 'PATTERN',
      message: `${fieldPath}.id must match ${idPattern}.`,
    });
  }
  if (!isNonEmptyString(e.file)) {
    errors.push({
      path: `${fieldPath}.file`,
      code: 'REQUIRED',
      message: `${fieldPath}.file is required.`,
    });
  } else if (isUnsafeRelPath(e.file)) {
    errors.push({
      path: `${fieldPath}.file`,
      code: 'PATH_ESCAPE',
      message: `${fieldPath}.file must be a relative path with no ".." segments.`,
    });
  }
}

function validateClawdevboxToolEntry(
  entry: unknown,
  fieldPath: string,
  errors: ValidationError[],
): void {
  validateSimpleProvideEntry(entry, fieldPath, TOOL_ID_PATTERN, errors);
  if (!isPlainObject(entry)) return;
  const e = entry as Record<string, unknown>;
  if (e.runtime !== undefined) {
    const r = validateRuntime(e.runtime);
    if (!r.ok) {
      errors.push({ path: `${fieldPath}.runtime`, code: 'ENUM', message: r.message });
    }
  }
}

/**
 * Validate a single `clawdevbox.renderers[]` entry. The `type` is a
 * filename-stem (kebab-or-snake mix is allowed via the standard id regex).
 * `module` is a relative path with no escape segments.
 */
function validatePluginRendererEntry(entry: unknown, fieldPath: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isPlainObject(entry)) {
    errors.push({ path: fieldPath, code: 'TYPE', message: 'renderer entry must be an object.' });
    return errors;
  }
  const e = entry as Record<string, unknown>;
  if (!isNonEmptyString(e.type)) {
    errors.push({
      path: `${fieldPath}.type`,
      code: 'REQUIRED',
      message: 'renderer.type is required.',
    });
  } else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(e.type)) {
    errors.push({
      path: `${fieldPath}.type`,
      code: 'PATTERN',
      message: 'renderer.type must match /^[a-z0-9][a-z0-9._-]*$/i.',
    });
  }
  if (!isNonEmptyString(e.module)) {
    errors.push({
      path: `${fieldPath}.module`,
      code: 'REQUIRED',
      message: 'renderer.module is required.',
    });
  } else if (isUnsafeRelPath(e.module)) {
    errors.push({
      path: `${fieldPath}.module`,
      code: 'PATH_ESCAPE',
      message: 'renderer.module must be a relative path with no ".." segments.',
    });
  }
  if (e.description !== undefined && typeof e.description !== 'string') {
    errors.push({
      path: `${fieldPath}.description`,
      code: 'TYPE',
      message: 'renderer.description must be a string.',
    });
  }
  return errors;
}

/**
 * Validate a `clawdevbox.<capability>` field that accepts the polymorphic
 * `string | string[] | Entry[]` shape (auto-discovery design §2).
 *
 *   - `string`   ⇒ a relative directory path (no `..`).
 *   - `string[]` ⇒ each entry is a relative path (file or directory).
 *   - `object[]` ⇒ each entry is validated by `entryValidator`.
 *
 * The `entryValidator` is invoked with the entry, the index, and the parent
 * field path (e.g. `clawdevbox.recipes`); it returns the errors for that one
 * entry. The duplicate-id pass is delegated to the caller because not every
 * capability shares the same id-field name.
 */
function validateCapabilityField(
  value: unknown,
  fieldPath: string,
  errors: ValidationError[],
  entryValidator: (entry: unknown, fp: string) => void,
): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    if (isUnsafeRelPath(value)) {
      errors.push({
        path: fieldPath,
        code: 'PATH_ESCAPE',
        message: `${fieldPath} must be a relative path with no ".." segments.`,
      });
    }
    return;
  }
  if (!Array.isArray(value)) {
    errors.push({
      path: fieldPath,
      code: 'TYPE',
      message: `${fieldPath} must be a string, array of strings, or array of entry objects.`,
    });
    return;
  }
  if (value.length === 0) return;
  // Decide between string[] and Entry[] by inspecting the first non-null item.
  const first = value.find((v) => v !== undefined && v !== null);
  if (typeof first === 'string') {
    value.forEach((entry, i) => {
      const fp = `${fieldPath}[${i}]`;
      if (typeof entry !== 'string') {
        errors.push({ path: fp, code: 'TYPE', message: `${fp} must be a string.` });
      } else if (isUnsafeRelPath(entry)) {
        errors.push({
          path: fp,
          code: 'PATH_ESCAPE',
          message: `${fp} must be a relative path with no ".." segments.`,
        });
      }
    });
    return;
  }
  // Default: array of entry objects.
  value.forEach((entry, i) => {
    entryValidator(entry, `${fieldPath}[${i}]`);
  });
}

function validateClawdevboxExtensions(value: unknown, errors: ValidationError[]): void {
  if (!isPlainObject(value)) {
    errors.push({ path: 'clawdevbox', code: 'TYPE', message: 'clawdevbox must be an object.' });
    return;
  }
  const c = value as Record<string, unknown>;

  const recipeSeen = new Set<string>();
  validateCapabilityField(c.recipes, 'clawdevbox.recipes', errors, (entry, p) => {
    validateSimpleProvideEntry(entry, p, ID_PATTERN, errors);
    if (isPlainObject(entry) && isNonEmptyString((entry as Record<string, unknown>).id)) {
      const id = (entry as Record<string, unknown>).id as string;
      if (recipeSeen.has(id)) {
        errors.push({
          path: `${p}.id`,
          code: 'DUPLICATE',
          message: `recipe id ${id} duplicated within plugin.`,
        });
      } else {
        recipeSeen.add(id);
      }
    }
  });

  const toolSeen = new Set<string>();
  validateCapabilityField(c.tools, 'clawdevbox.tools', errors, (entry, p) => {
    validateClawdevboxToolEntry(entry, p, errors);
    if (isPlainObject(entry) && isNonEmptyString((entry as Record<string, unknown>).id)) {
      const id = (entry as Record<string, unknown>).id as string;
      if (toolSeen.has(id)) {
        errors.push({
          path: `${p}.id`,
          code: 'DUPLICATE',
          message: `tool id ${id} duplicated within plugin.`,
        });
      } else {
        toolSeen.add(id);
      }
    }
  });

  const triggerSeen = new Set<string>();
  validateCapabilityField(c.trigger_types, 'clawdevbox.trigger_types', errors, (entry, p) => {
    const entryErrors = validateTriggerTypeEntry(entry, p);
    errors.push(...entryErrors);
    if (isPlainObject(entry) && isNonEmptyString((entry as Record<string, unknown>).id)) {
      const id = (entry as Record<string, unknown>).id as string;
      if (triggerSeen.has(id)) {
        errors.push({
          path: `${p}.id`,
          code: 'DUPLICATE',
          message: `trigger_type id ${id} duplicated within plugin.`,
        });
      } else {
        triggerSeen.add(id);
      }
    }
  });

  const cliSeen = new Set<string>();
  validateCapabilityField(c.agent_clis, 'clawdevbox.agent_clis', errors, (entry, p) => {
    // validatePluginAgentCliEntry prefixes paths with `provides.agent_clis[i]`;
    // remap to the actual caller-supplied field path for readability.
    const m = p.match(/\[(\d+)\]$/);
    const i = m ? Number(m[1]) : 0;
    const reused = validatePluginAgentCliEntry(entry, i).map((err) => ({
      ...err,
      path: err.path.replace(/^provides\.agent_clis\[\d+\]/, p),
    }));
    errors.push(...reused);
    if (isPlainObject(entry) && isNonEmptyString((entry as Record<string, unknown>).id)) {
      const id = (entry as Record<string, unknown>).id as string;
      if (cliSeen.has(id)) {
        errors.push({
          path: `${p}.id`,
          code: 'DUPLICATE',
          message: `agent_cli id ${id} duplicated within plugin.`,
        });
      } else {
        cliSeen.add(id);
      }
    }
  });

  const rendererSeen = new Set<string>();
  validateCapabilityField(c.renderers, 'clawdevbox.renderers', errors, (entry, p) => {
    const entryErrors = validatePluginRendererEntry(entry, p);
    errors.push(...entryErrors);
    if (isPlainObject(entry) && isNonEmptyString((entry as Record<string, unknown>).type)) {
      const type = (entry as Record<string, unknown>).type as string;
      if (rendererSeen.has(type)) {
        errors.push({
          path: `${p}.type`,
          code: 'DUPLICATE',
          message: `renderer type ${type} duplicated within plugin.`,
        });
      } else {
        rendererSeen.add(type);
      }
    }
  });
}

function validateMcpServersField(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    if (isUnsafeRelPath(value)) {
      errors.push({
        path: 'mcpServers',
        code: 'PATH_ESCAPE',
        message: 'mcpServers path must be a relative path with no ".." segments.',
      });
    }
    return;
  }
  if (isPlainObject(value)) {
    // Permissive: either a wrapper `{ mcpServers: {...} }` or a flat
    // `{ <serverId>: {...} }` map. We don't validate server config shape —
    // the upstream MCP spec evolves and forward-compat matters.
    return;
  }
  errors.push({
    path: 'mcpServers',
    code: 'TYPE',
    message: 'mcpServers must be a path string or inline object.',
  });
}

function validateHooksField(value: unknown, fieldPath: string, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    if (isUnsafeRelPath(value)) {
      errors.push({
        path: fieldPath,
        code: 'PATH_ESCAPE',
        message: `${fieldPath} path must be a relative path with no ".." segments.`,
      });
    }
    return;
  }
  if (isPlainObject(value)) return;
  errors.push({
    path: fieldPath,
    code: 'TYPE',
    message: `${fieldPath} must be a path string or inline object.`,
  });
}

/**
 * Validate `.claude-plugin/plugin.json`. Coexists with the legacy
 * `validatePluginManifest` (yaml shape) above. Returns `ValidationError[]`
 * — empty array means valid.
 */
export function validatePluginManifestJson(parsed: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isPlainObject(parsed)) {
    return [{ path: '$', code: 'NOT_OBJECT', message: 'plugin.json must be a JSON object.' }];
  }
  const m = parsed as Record<string, unknown>;

  // name (required, kebab-case)
  if (!isNonEmptyString(m.name)) {
    errors.push({ path: 'name', code: 'REQUIRED', message: 'name is required.' });
  } else if (!KEBAB_NAME_PATTERN.test(m.name)) {
    errors.push({
      path: 'name',
      code: 'PATTERN',
      message: `name must match ${KEBAB_NAME_PATTERN}.`,
    });
  }

  checkOptionalString(m.$schema, '$schema', errors);
  checkOptionalString(m.version, 'version', errors);
  checkOptionalString(m.description, 'description', errors);
  validateAuthor(m.author, 'author', errors);
  checkOptionalString(m.homepage, 'homepage', errors);
  checkOptionalString(m.repository, 'repository', errors);
  checkOptionalString(m.license, 'license', errors);
  checkOptionalStringArray(m.keywords, 'keywords', errors);

  // Component path fields.
  checkStringOrStringArrayPath(m.skills, 'skills', errors);
  checkStringOrStringArrayPath(m.agents, 'agents', errors);
  checkStringOrStringArrayPath(m.commands, 'commands', errors);
  checkStringOrStringArrayPath(m.outputStyles, 'outputStyles', errors);
  validateMcpServersField(m.mcpServers, errors);
  validateHooksField(m.hooks, 'hooks', errors);
  validateHooksField(m.lspServers, 'lspServers', errors);

  if (m.experimental !== undefined) {
    if (!isPlainObject(m.experimental)) {
      errors.push({ path: 'experimental', code: 'TYPE', message: 'experimental must be an object.' });
    } else {
      const x = m.experimental as Record<string, unknown>;
      checkStringOrStringArrayPath(x.themes, 'experimental.themes', errors);
      checkStringOrStringArrayPath(x.monitors, 'experimental.monitors', errors);
    }
  }

  if (m.userConfig !== undefined && !isPlainObject(m.userConfig)) {
    errors.push({ path: 'userConfig', code: 'TYPE', message: 'userConfig must be an object.' });
  }
  if (m.channels !== undefined && !Array.isArray(m.channels)) {
    errors.push({ path: 'channels', code: 'TYPE', message: 'channels must be an array.' });
  }
  if (m.dependencies !== undefined && !Array.isArray(m.dependencies)) {
    errors.push({ path: 'dependencies', code: 'TYPE', message: 'dependencies must be an array.' });
  }

  if (m.status !== undefined) {
    validatePluginStatus(m.status, errors);
  }

  if (m.clawdevbox !== undefined) {
    validateClawdevboxExtensions(m.clawdevbox, errors);
  }

  if (m.requires !== undefined) {
    if (!isPlainObject(m.requires)) {
      errors.push({ path: 'requires', code: 'TYPE', message: 'requires must be an object.' });
    } else {
      const r = m.requires as Record<string, unknown>;
      checkOptionalString(r.clawdevbox_version, 'requires.clawdevbox_version', errors);
      checkOptionalStringArray(r.env, 'requires.env', errors);
    }
  }

  return errors;
}

/**
 * Validate `agency.json` (Microsoft per-plugin sidecar). Both fields optional.
 * Each engine id must be lowercase kebab or `"*"`.
 */
export function validateAgencyJson(parsed: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isPlainObject(parsed)) {
    return [{ path: '$', code: 'NOT_OBJECT', message: 'agency.json must be a JSON object.' }];
  }
  const a = parsed as Record<string, unknown>;

  if (a.engines !== undefined) {
    if (!Array.isArray(a.engines)) {
      errors.push({ path: 'engines', code: 'TYPE', message: 'engines must be an array.' });
    } else {
      a.engines.forEach((entry, i) => {
        if (typeof entry !== 'string') {
          errors.push({
            path: `engines[${i}]`,
            code: 'TYPE',
            message: `engines[${i}] must be a string.`,
          });
        } else if (entry !== '*' && !ENGINE_NAME_PATTERN.test(entry)) {
          errors.push({
            path: `engines[${i}]`,
            code: 'PATTERN',
            message: `engines[${i}] must match ${ENGINE_NAME_PATTERN} or be "*".`,
          });
        }
      });
    }
  }

  if (a.category !== undefined) {
    if (typeof a.category !== 'string' || a.category.length === 0) {
      errors.push({
        path: 'category',
        code: 'TYPE',
        message: 'category must be a non-empty string.',
      });
    }
  }

  return errors;
}

function validateMarketplacePluginEntry(
  entry: unknown,
  fieldPath: string,
  errors: ValidationError[],
): void {
  if (!isPlainObject(entry)) {
    errors.push({ path: fieldPath, code: 'TYPE', message: `${fieldPath} must be an object.` });
    return;
  }
  const e = entry as Record<string, unknown>;

  if (!isNonEmptyString(e.name)) {
    errors.push({
      path: `${fieldPath}.name`,
      code: 'REQUIRED',
      message: `${fieldPath}.name is required.`,
    });
  } else if (!KEBAB_NAME_PATTERN.test(e.name)) {
    errors.push({
      path: `${fieldPath}.name`,
      code: 'PATTERN',
      message: `${fieldPath}.name must match ${KEBAB_NAME_PATTERN}.`,
    });
  }

  if (e.source === undefined) {
    errors.push({
      path: `${fieldPath}.source`,
      code: 'REQUIRED',
      message: `${fieldPath}.source is required.`,
    });
  } else if (typeof e.source === 'string') {
    if (e.source.length === 0) {
      errors.push({
        path: `${fieldPath}.source`,
        code: 'TYPE',
        message: `${fieldPath}.source must be a non-empty string.`,
      });
    }
  } else if (isPlainObject(e.source)) {
    const s = e.source as Record<string, unknown>;
    const kind = s.source;
    if (kind !== 'github' && kind !== 'git' && kind !== 'path') {
      errors.push({
        path: `${fieldPath}.source.source`,
        code: 'ENUM',
        message: `${fieldPath}.source.source must be one of: github, git, path.`,
      });
    }
  } else {
    errors.push({
      path: `${fieldPath}.source`,
      code: 'TYPE',
      message: `${fieldPath}.source must be a string or object.`,
    });
  }

  checkOptionalString(e.version, `${fieldPath}.version`, errors);
  checkOptionalString(e.description, `${fieldPath}.description`, errors);
  validateAuthor(e.author, `${fieldPath}.author`, errors);
  checkOptionalStringArray(e.keywords, `${fieldPath}.keywords`, errors);
  checkOptionalString(e.category, `${fieldPath}.category`, errors);
  if (e.strict !== undefined && typeof e.strict !== 'boolean') {
    errors.push({
      path: `${fieldPath}.strict`,
      code: 'TYPE',
      message: `${fieldPath}.strict must be a boolean.`,
    });
  }
  checkOptionalStringArray(e.tags, `${fieldPath}.tags`, errors);
  if (e.status !== undefined) {
    // Reuse validatePluginStatus but remap the `status.*` prefix.
    const before = errors.length;
    validatePluginStatus(e.status, errors);
    for (let i = before; i < errors.length; i++) {
      errors[i] = {
        ...errors[i],
        path: errors[i].path.replace(/^status/, `${fieldPath}.status`),
      };
    }
  }
}

/**
 * Validate `.claude-plugin/marketplace.json`. Verifies the catalog skeleton:
 * name, owner, plugins[] with name+source on each entry.
 */
export function validateMarketplaceJson(parsed: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isPlainObject(parsed)) {
    return [
      { path: '$', code: 'NOT_OBJECT', message: 'marketplace.json must be a JSON object.' },
    ];
  }
  const m = parsed as Record<string, unknown>;

  checkOptionalString(m.$schema, '$schema', errors);

  if (!isNonEmptyString(m.name)) {
    errors.push({ path: 'name', code: 'REQUIRED', message: 'name is required.' });
  } else if (!KEBAB_NAME_PATTERN.test(m.name)) {
    errors.push({
      path: 'name',
      code: 'PATTERN',
      message: `name must match ${KEBAB_NAME_PATTERN}.`,
    });
  }

  if (m.owner === undefined) {
    errors.push({ path: 'owner', code: 'REQUIRED', message: 'owner is required.' });
  } else if (!isPlainObject(m.owner)) {
    errors.push({ path: 'owner', code: 'TYPE', message: 'owner must be an object.' });
  } else {
    const o = m.owner as Record<string, unknown>;
    if (!isNonEmptyString(o.name)) {
      errors.push({ path: 'owner.name', code: 'REQUIRED', message: 'owner.name is required.' });
    }
    if (o.email !== undefined && typeof o.email !== 'string') {
      errors.push({ path: 'owner.email', code: 'TYPE', message: 'owner.email must be a string.' });
    }
  }

  checkOptionalString(m.description, 'description', errors);
  checkOptionalString(m.version, 'version', errors);

  if (m.metadata !== undefined) {
    if (!isPlainObject(m.metadata)) {
      errors.push({ path: 'metadata', code: 'TYPE', message: 'metadata must be an object.' });
    } else {
      const md = m.metadata as Record<string, unknown>;
      checkOptionalString(md.description, 'metadata.description', errors);
      checkOptionalString(md.version, 'metadata.version', errors);
      checkOptionalString(md.pluginRoot, 'metadata.pluginRoot', errors);
    }
  }

  if (m.plugins === undefined) {
    errors.push({ path: 'plugins', code: 'REQUIRED', message: 'plugins is required.' });
  } else if (!Array.isArray(m.plugins)) {
    errors.push({ path: 'plugins', code: 'TYPE', message: 'plugins must be an array.' });
  } else {
    m.plugins.forEach((entry, i) => {
      validateMarketplacePluginEntry(entry, `plugins[${i}]`, errors);
    });
  }

  checkOptionalStringArray(
    m.allowCrossMarketplaceDependenciesOn,
    'allowCrossMarketplaceDependenciesOn',
    errors,
  );

  return errors;
}

/**
 * Validate `marketplace-config.json` (Microsoft extension, §4.3). Permissive:
 * only `shared.name` is required. Engine-specific slots (`claude`, `copilot`,
 * `clawdevbox`, …) are type-checked as objects only; their contents are
 * forward-compat.
 */
export function validateMarketplaceConfig(parsed: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isPlainObject(parsed)) {
    return [
      {
        path: '$',
        code: 'NOT_OBJECT',
        message: 'marketplace-config.json must be a JSON object.',
      },
    ];
  }
  const c = parsed as Record<string, unknown>;

  if (c.shared === undefined) {
    errors.push({ path: 'shared', code: 'REQUIRED', message: 'shared is required.' });
  } else if (!isPlainObject(c.shared)) {
    errors.push({ path: 'shared', code: 'TYPE', message: 'shared must be an object.' });
  } else {
    const s = c.shared as Record<string, unknown>;
    if (!isNonEmptyString(s.name)) {
      errors.push({
        path: 'shared.name',
        code: 'REQUIRED',
        message: 'shared.name is required.',
      });
    }
    if (s.metadata !== undefined) {
      if (!isPlainObject(s.metadata)) {
        errors.push({
          path: 'shared.metadata',
          code: 'TYPE',
          message: 'shared.metadata must be an object.',
        });
      } else {
        const md = s.metadata as Record<string, unknown>;
        checkOptionalString(md.description, 'shared.metadata.description', errors);
        checkOptionalString(md.version, 'shared.metadata.version', errors);
      }
    }
    if (s.owner !== undefined) {
      if (!isPlainObject(s.owner)) {
        errors.push({
          path: 'shared.owner',
          code: 'TYPE',
          message: 'shared.owner must be an object.',
        });
      } else {
        const o = s.owner as Record<string, unknown>;
        if (o.name !== undefined && typeof o.name !== 'string') {
          errors.push({
            path: 'shared.owner.name',
            code: 'TYPE',
            message: 'shared.owner.name must be a string.',
          });
        }
        if (o.email !== undefined && typeof o.email !== 'string') {
          errors.push({
            path: 'shared.owner.email',
            code: 'TYPE',
            message: 'shared.owner.email must be a string.',
          });
        }
      }
    }
  }

  // Engine slots — permissive: must be an object if present, contents free-form.
  for (const key of Object.keys(c)) {
    if (key === 'shared') continue;
    if (c[key] !== undefined && c[key] !== null && !isPlainObject(c[key])) {
      errors.push({
        path: key,
        code: 'TYPE',
        message: `${key} must be an object.`,
      });
    }
  }

  return errors;
}
