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

// ============================================================================
// Recipe (TaskDock shape — spec §7.4)
// ============================================================================

export function validateRecipeSource(source: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = yamlLoad(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [{ path: '$', code: 'YAML_PARSE_ERROR', message: msg }] };
  }
  return validateRecipeParsed(parsed);
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
  if (r.default_client !== undefined && r.default_client !== 'claude' && r.default_client !== 'copilot') {
    errors.push({
      path: 'default_client',
      code: 'ENUM',
      message: `default_client must be 'claude' or 'copilot'.`,
    });
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

        // name — optional, but when present must be a non-empty string ≤ 200 chars.
        if (step.name !== undefined) {
          if (typeof step.name !== 'string') {
            errors.push({ path: `${pathPrefix}.name`, code: 'TYPE', message: 'step.name must be a string.' });
          } else if (step.name.length === 0) {
            errors.push({ path: `${pathPrefix}.name`, code: 'INVALID_VALUE', message: 'step.name must not be empty.' });
          } else if (step.name.length > 200) {
            errors.push({ path: `${pathPrefix}.name`, code: 'INVALID_VALUE', message: 'step.name must be ≤ 200 characters.' });
          }
        }

        if (!isNonEmptyString(step.goal)) {
          errors.push({ path: `${pathPrefix}.goal`, code: 'REQUIRED', message: 'step.goal is required and must be a non-empty string.' });
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
              if (t.binds_callback_to !== undefined && t.binds_callback_to !== 'agent_session_resume') {
                errors.push({
                  path: `${tp}.binds_callback_to`,
                  code: 'INVALID_VALUE',
                  message: `trigger.binds_callback_to must be 'agent_session_resume'.`,
                });
              }
              if (t.binds_callback_to_recipe !== undefined && !isNonEmptyString(t.binds_callback_to_recipe)) {
                errors.push({ path: `${tp}.binds_callback_to_recipe`, code: 'TYPE', message: 'trigger.binds_callback_to_recipe must be a non-empty string.' });
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
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'plugin.yaml must be a YAML map.' }] };
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

  // binds_callback_to_recipe and binds_callback_to are mutually exclusive.
  const hasRecipeBinding = e.binds_callback_to_recipe !== undefined;
  const hasActionBinding = e.binds_callback_to !== undefined;
  if (hasRecipeBinding && hasActionBinding) {
    errors.push({
      path: p,
      code: 'MUTUALLY_EXCLUSIVE',
      message: 'binds_callback_to_recipe and binds_callback_to are mutually exclusive.',
    });
  }
  if (hasRecipeBinding && !isNonEmptyString(e.binds_callback_to_recipe)) {
    errors.push({
      path: `${p}.binds_callback_to_recipe`,
      code: 'TYPE',
      message: 'binds_callback_to_recipe must be a non-empty string recipe id.',
    });
  }
  if (hasActionBinding && e.binds_callback_to !== 'thread_resume') {
    errors.push({
      path: `${p}.binds_callback_to`,
      code: 'ENUM',
      message: `binds_callback_to must be 'thread_resume' (got ${JSON.stringify(e.binds_callback_to)}).`,
    });
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

