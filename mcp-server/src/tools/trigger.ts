/**
 * tools/trigger.ts
 *
 * The trigger MCP surface (spec §6.1 + §8) — split cleanly into TYPES
 * (capabilities shipped by plugins) and REGISTERED instances (concrete
 * bindings persisted in `.clawdevbox/triggers.json`).
 *
 * Seven tools:
 *
 *   - trigger.list_types        — capabilities available from loaded plugins
 *   - trigger.list_registered   — active registered instances
 *   - trigger.register          — bind a type to concrete params (writes
 *                                 to triggers.json `registered[]`)
 *   - trigger.unregister        — remove a registered instance (type stays)
 *   - trigger.update_params     — modify params and/or cron without
 *                                 unregister/re-register
 *   - trigger.enable / .disable — toggle the `enabled` flag
 *   - trigger.fire              — manually fire a registered trigger; emits
 *                                 a queued run_id. The actual webhook POST
 *                                 to the registered instance's `/hooks/<id>`
 *                                 endpoint is the scheduler's job.
 *
 * Cron has three states per registration (spec §8.4):
 *
 *   - string                      → override the type's default_cron
 *   - null / undefined            → inherit the type's default_cron
 *   - false / ""                  → cron disabled (webhook/manual only)
 *
 * Param validation: the type's `parameters[]` declaration is converted into
 * a hand-rolled validator. Defaults are applied for absent optional params.
 * Required params missing surface as PARAM_VALIDATION with structured errors.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve as pathResolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../logger.ts';
import {
  isValidCronExpression,
  validateAgentAuthoredTemplate,
  validateRuntime,
  validateTriggerParams,
  type TriggerRuntime,
} from '../validators.ts';
import { mintId } from '../store.ts';
import {
  mintRegisteredId,
  readTriggersFile,
  writeTriggersFile,
  type RegisteredTrigger,
} from '../triggers-store.ts';
import {
  deleteOneOffTemplate,
  deleteTemplate,
  findTemplate,
  loadOneOffTemplate,
  mintOneOffId,
  templateExists,
  toRegisteredType,
  writeOneOffTemplate,
  writeTemplate,
  type TemplateManifest,
} from '../template-store.ts';
import {
  reloadTypeRegistries,
  triggersJsonPath,
  type RegisteredTriggerType,
  type Workspace,
} from '../workspace.ts';
import { notFound, structuredError, validationError } from '../scope.ts';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

function ensureFileUnderClawdevbox(projectDir: string, relPath: string):
  { ok: true; path: string } | { ok: false; error: CallToolResult } {
  const root = pathResolve(projectDir, '.clawdevbox');
  const abs = pathResolve(projectDir, relPath);
  if (!abs.startsWith(root + sep) && abs !== root) {
    return { ok: false, error: structuredError('SCRIPT_FILE_OUTSIDE_WORKSPACE',
      `script_file must resolve under .clawdevbox/. Got: ${relPath}`,
      { script_file: relPath, resolved: abs }) };
  }
  if (!existsSync(abs)) {
    return { ok: false, error: structuredError('SCRIPT_FILE_NOT_FOUND',
      `script_file does not exist: ${relPath}`,
      { script_file: relPath, resolved: abs }) };
  }
  return { ok: true, path: abs };
}

// ============================================================================
// Helpers
// ============================================================================

/** Build the structured-error response for a parameter-validation failure. */
function paramValidationError(
  errors: Array<{ path: string; code: string; message: string }>,
): CallToolResult {
  const text = errors.map((e) => `${e.path}: ${e.message}`).join('\n');
  return {
    isError: true,
    content: [{ type: 'text', text: `Parameter validation failed:\n${text}` }],
    structuredContent: { code: 'PARAM_VALIDATION', message: 'Parameter validation failed.', errors },
  };
}

/** Resolve a `cron` field on a registration into one of three normalized values. */
function normalizeCron(raw: unknown): { ok: true; cron: string | null | false } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, cron: null };
  if (raw === null) return { ok: true, cron: null };
  if (raw === false || raw === '') return { ok: true, cron: false };
  if (typeof raw === 'string') {
    if (!isValidCronExpression(raw)) {
      return { ok: false, message: `cron expression ${JSON.stringify(raw)} is not a valid 5- or 6-field cron.` };
    }
    return { ok: true, cron: raw };
  }
  return { ok: false, message: 'cron must be a string (override), null (inherit), or false (disable).' };
}

/**
 * Project a registered trigger to the structured-content shape returned by
 * `trigger.list_registered`. Resolves cron inheritance from the type so the
 * agent sees the effective schedule without a second lookup.
 */
function projectRegistered(
  reg: RegisteredTrigger,
  ws: Workspace,
): RegisteredTrigger & { resolved_cron: string | false | null; type_exists: boolean } {
  const type = ws.triggerTypes.get(reg.type);
  let resolved: string | false | null;
  if (reg.cron === false) {
    resolved = false; // disabled
  } else if (reg.cron === null) {
    resolved = type?.default_cron ?? null; // inherit, may still be null
  } else {
    resolved = reg.cron;
  }
  return { ...reg, resolved_cron: resolved, type_exists: !!type };
}

/** Convert a RegisteredTriggerType to the projection returned by trigger.list_types. */
function projectType(t: RegisteredTriggerType): Record<string, unknown> {
  const binding =
    t.binds_callback_to_recipe !== undefined
      ? { binds_callback_to_recipe: t.binds_callback_to_recipe }
      : t.binds_callback_to !== undefined
        ? { binds_callback_to: t.binds_callback_to }
        : {};
  return {
    id: t.id,
    source_plugin_id: t.source_plugin_id,
    scope: t.scope,
    description: t.description ?? '',
    file: t.file,
    file_abs: t.file_abs,
    default_cron: t.default_cron ?? null,
    accepts_webhook: t.accepts_webhook ?? true,
    identity_param: t.identity_param ?? null,
    parameters: t.parameters ?? [],
    ...binding,
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerTriggerTools(server: McpServer, ws: Workspace): void {
  // -- trigger.list_types ---------------------------------------------------
  server.registerTool(
    'trigger.list_types',
    {
      description:
        'List trigger TYPES (capabilities) discovered from enabled plugins (spec §8.2 / §10.4). Each entry carries the parameter schema, default cron, callback binding, and source plugin. Use trigger.register to create a concrete instance from one.',
      inputSchema: {
        scope: z
          .string()
          .regex(/^plugin:[a-z][a-z0-9-]*$/, 'plugin:<id>')
          .optional()
          .describe('Filter to a single plugin scope (e.g. "plugin:ado"). Default: all plugins.'),
        search: z
          .string()
          .min(1)
          .optional()
          .describe('Substring filter against id or description.'),
      },
    },
    async (args) => {
      const all = [...ws.triggerTypes.values()].sort((a, b) => a.id.localeCompare(b.id));
      let filtered = all;
      if (args.scope) {
        filtered = filtered.filter((t) => t.scope === args.scope);
      }
      if (args.search) {
        const q = args.search.toLowerCase();
        filtered = filtered.filter(
          (t) =>
            t.id.toLowerCase().includes(q) ||
            (t.description ?? '').toLowerCase().includes(q),
        );
      }
      const projected = filtered.map(projectType);
      return {
        content: [
          {
            type: 'text',
            text: `Found ${projected.length} trigger type(s)${ws.triggerTypeErrors.length > 0 ? ` (with ${ws.triggerTypeErrors.length} load error(s))` : ''}.`,
          },
        ],
        structuredContent: {
          trigger_types: projected,
          count: projected.length,
          load_errors: ws.triggerTypeErrors,
        },
      };
    },
  );

  // -- trigger.list_registered ----------------------------------------------
  server.registerTool(
    'trigger.list_registered',
    {
      description:
        'List REGISTERED trigger instances from `.clawdevbox/triggers.json` (spec §8.3). Each entry shows the bound params, cron resolution (inherited/overridden/disabled), and last-run status. Use trigger.list_types to see available capabilities.',
      inputSchema: {
        enabled: z.boolean().optional(),
        type_id: z.string().min(1).optional().describe('Filter to a single trigger type id.'),
        subscriber_thread_id: z
          .string()
          .min(1)
          .optional()
          .describe('Filter to hot triggers bound to this thread.'),
      },
    },
    async (args) => {
      const file = readTriggersFile(triggersJsonPath(ws));
      let rows = file.registered.map((r) => projectRegistered(r, ws));
      if (args.enabled !== undefined) {
        rows = rows.filter((r) => r.enabled === args.enabled);
      }
      if (args.type_id) {
        rows = rows.filter((r) => r.type === args.type_id);
      }
      if (args.subscriber_thread_id) {
        rows = rows.filter((r) => r.subscriber_thread_id === args.subscriber_thread_id);
      }
      return {
        content: [{ type: 'text', text: `Found ${rows.length} registered trigger(s).` }],
        structuredContent: { registered: rows, count: rows.length },
      };
    },
  );

  // -- trigger.register -----------------------------------------------------
  server.registerTool(
    'trigger.register',
    {
      description:
        'Register a trigger instance. Three mutually-exclusive sources: (a) `type_id` for a saved TYPE; (b) `script` for an inline one-off; (c) `script_file` for a file under `.clawdevbox/`. One-off paths default to `once: true`, `cron: false` (manual/webhook only). Validates params against the type schema (where one exists), mints `<type_id>#<key>` (or auto-template id for one-offs), and writes to `triggers.json`.',
      inputSchema: {
        type_id: z.string().min(1).optional(),
        script: z.string().optional(),
        script_file: z.string().optional(),
        runtime: z.enum(['node', 'tsx', 'python', 'bash']).optional()
          .describe('Required when script or script_file is supplied.'),
        params: z.record(z.string(), z.unknown()).optional(),
        cron: z.union([z.string(), z.null(), z.literal(false), z.literal('')]).optional(),
        subscriber_thread_id: z.string().min(1).optional(),
        expires_at: z.number().optional(),
        once: z.boolean().optional(),
      },
    },
    async (args) => {
      const sources = [args.type_id, args.script, args.script_file].filter((x) => typeof x === 'string').length;
      if (sources !== 1) {
        return structuredError('INVALID_REQUEST',
          'Provide exactly one of `type_id`, `script`, or `script_file`.',
          { type_id_provided: !!args.type_id, script_provided: !!args.script, script_file_provided: !!args.script_file });
      }

      let typeId: string;
      let isAdhoc = false;
      let oneoffTemplateId: string | null = null;

      if (args.type_id) {
        typeId = args.type_id;
      } else {
        if (!args.runtime) {
          return structuredError('RUNTIME_REQUIRED',
            'runtime is required when supplying script or script_file.', {});
        }
        let scriptContent: string;
        if (args.script) {
          scriptContent = args.script;
        } else {
          const guard = ensureFileUnderClawdevbox(ws.projectDir, args.script_file!);
          if (!guard.ok) return guard.error;
          scriptContent = readFileSync(guard.path, 'utf8');
        }
        oneoffTemplateId = mintOneOffId();
        writeOneOffTemplate(ws, {
          id: oneoffTemplateId,
          runtime: args.runtime as TriggerRuntime,
          scriptContent,
          bindsCallbackTo: args.subscriber_thread_id ? 'thread_resume' : undefined,
        });
        const loaded = loadOneOffTemplate(ws, oneoffTemplateId);
        if (!loaded) {
          return structuredError('TRIGGER_TEMPLATE_WRITE_FAILED',
            'Failed to read back the one-off template just written.', { id: oneoffTemplateId });
        }
        ws.triggerTypes.set(oneoffTemplateId, toRegisteredType(loaded));
        typeId = oneoffTemplateId;
        isAdhoc = true;
      }

      const type = ws.triggerTypes.get(typeId);
      if (!type) {
        return structuredError('TRIGGER_TYPE_NOT_FOUND',
          `Trigger type ${typeId} is not declared by any loaded plugin or template.`,
          { type_id: typeId });
      }

      const params = args.params ?? {};
      const paramsCheck = validateTriggerParams(type.parameters, params);
      if (!paramsCheck.ok) {
        if (isAdhoc && oneoffTemplateId) deleteOneOffTemplate(ws, oneoffTemplateId);
        return paramValidationError(paramsCheck.errors);
      }

      const cronInput = args.cron === undefined && isAdhoc ? false : args.cron;
      const cronCheck = normalizeCron(cronInput);
      if (!cronCheck.ok) {
        if (isAdhoc && oneoffTemplateId) deleteOneOffTemplate(ws, oneoffTemplateId);
        return paramValidationError([{ path: 'cron', code: 'CRON_INVALID', message: cronCheck.message }]);
      }

      const id = mintRegisteredId(type.id, paramsCheck.params, type.identity_param);
      const path = triggersJsonPath(ws);
      const file = readTriggersFile(path);
      if (file.registered.some((r) => r.id === id)) {
        if (isAdhoc && oneoffTemplateId) deleteOneOffTemplate(ws, oneoffTemplateId);
        return structuredError('TRIGGER_ALREADY_REGISTERED',
          `A registered trigger with id ${id} already exists.`,
          { id, type_id: type.id });
      }

      const initialState: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(paramsCheck.params)) initialState[k] = v;

      const row: RegisteredTrigger = {
        id, type: type.id, params: paramsCheck.params,
        cron: cronCheck.cron, enabled: true,
        subscriber_thread_id: args.subscriber_thread_id ?? null,
        expires_at: args.expires_at ?? null,
        once: args.once ?? (isAdhoc ? true : false),
        registered_at: Date.now(),
        state: initialState,
        last_run_at: null, last_run_status: null, last_run_error: null,
      };
      file.registered = [...file.registered, row];
      writeTriggersFile(path, file);

      return {
        content: [{ type: 'text', text: `Registered trigger ${id} (type=${type.id}${isAdhoc ? ', adhoc' : ''}).` }],
        structuredContent: {
          id, type: type.id, registered: projectRegistered(row, ws),
          adhoc: isAdhoc, template_id: oneoffTemplateId,
        },
      };
    },
  );

  // -- trigger.unregister ---------------------------------------------------
  server.registerTool(
    'trigger.unregister',
    {
      description:
        'Remove a registered trigger instance by id. For one-off registrations, also drops the auto-template directory under `_oneoff/`. The underlying TYPE stays available for non-oneoff types.',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const path = triggersJsonPath(ws);
      const file = readTriggersFile(path);
      const row = file.registered.find((r) => r.id === args.id);
      if (!row) return notFound('registered_trigger', args.id);
      file.registered = file.registered.filter((r) => r.id !== args.id);
      writeTriggersFile(path, file);
      let oneoffRemoved = false;
      if (row.type.startsWith('local.oneoff.')) {
        oneoffRemoved = deleteOneOffTemplate(ws, row.type);
        ws.triggerTypes.delete(row.type);
      }
      return {
        content: [
          { type: 'text', text: `Unregistered trigger ${args.id}${oneoffRemoved ? ' (template removed)' : ''}.` },
        ],
        structuredContent: { id: args.id, removed: 1, oneoff_template_removed: oneoffRemoved },
      };
    },
  );

  // -- trigger.update_params ------------------------------------------------
  server.registerTool(
    'trigger.update_params',
    {
      description:
        'Modify the params and/or cron of a registered trigger without unregister/re-register (spec §8.3). Re-validates params against the type schema. The registered id is stable — even when an identity param changes, the id is NOT remitted (use unregister + register if you want a new id).',
      inputSchema: {
        id: z.string().min(1),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('When present, REPLACES params entirely; re-validated against the type schema.'),
        cron: z
          .union([z.string(), z.null(), z.literal(false), z.literal('')])
          .optional()
          .describe('When present, replaces the cron field. Pass null to inherit; false/"" to disable.'),
      },
    },
    async (args) => {
      const path = triggersJsonPath(ws);
      const file = readTriggersFile(path);
      const idx = file.registered.findIndex((r) => r.id === args.id);
      if (idx < 0) return notFound('registered_trigger', args.id);
      const row = file.registered[idx];

      if (args.params === undefined && args.cron === undefined) {
        return structuredError(
          'NO_CHANGES',
          'trigger.update_params requires at least one of `params` or `cron`.',
          { id: args.id },
        );
      }

      let nextParams = row.params;
      if (args.params !== undefined) {
        const type = ws.triggerTypes.get(row.type);
        if (!type) {
          return structuredError(
            'TRIGGER_TYPE_NOT_FOUND',
            `Cannot validate params: trigger type ${row.type} is no longer declared by any plugin.`,
            { id: args.id, type_id: row.type },
          );
        }
        const check = validateTriggerParams(type.parameters, args.params);
        if (!check.ok) return paramValidationError(check.errors);
        nextParams = check.params;
      }

      let nextCron = row.cron;
      if (args.cron !== undefined) {
        const cronCheck = normalizeCron(args.cron);
        if (!cronCheck.ok) {
          return paramValidationError([{ path: 'cron', code: 'CRON_INVALID', message: cronCheck.message }]);
        }
        nextCron = cronCheck.cron;
      }

      const updated: RegisteredTrigger = { ...row, params: nextParams, cron: nextCron };
      file.registered[idx] = updated;
      writeTriggersFile(path, file);
      return {
        content: [{ type: 'text', text: `Updated trigger ${args.id}.` }],
        structuredContent: { id: args.id, registered: projectRegistered(updated, ws) },
      };
    },
  );

  // -- trigger.enable / trigger.disable -------------------------------------
  for (const action of ['enable', 'disable'] as const) {
    server.registerTool(
      `trigger.${action}`,
      {
        description: `${action === 'enable' ? 'Enable' : 'Disable'} a registered trigger by flipping its 'enabled' flag (spec §8.3). The registration row stays on disk; disabled triggers are skipped by the cron daemon but can still be fired manually via trigger.fire.`,
        inputSchema: { id: z.string().min(1) },
      },
      async (args) => {
        const path = triggersJsonPath(ws);
        const file = readTriggersFile(path);
        const idx = file.registered.findIndex((r) => r.id === args.id);
        if (idx < 0) return notFound('registered_trigger', args.id);
        const next: RegisteredTrigger = { ...file.registered[idx], enabled: action === 'enable' };
        file.registered[idx] = next;
        writeTriggersFile(path, file);
        return {
          content: [
            { type: 'text', text: `${action === 'enable' ? 'Enabled' : 'Disabled'} trigger ${args.id}.` },
          ],
          structuredContent: { id: args.id, enabled: action === 'enable' },
        };
      },
    );
  }

  // -- trigger.fire ---------------------------------------------------------
  server.registerTool(
    'trigger.fire',
    {
      description:
        'Manually fire a registered trigger by id. Returns a queued run_id and logs the fire intent. A future in-process cron daemon (or external scheduler) handles the actual webhook POST to `/hooks/<id>`. Works regardless of cron state — manual fires always succeed.',
      inputSchema: {
        id: z.string().min(1),
        payload: z.unknown().optional(),
      },
    },
    async (args) => {
      const path = triggersJsonPath(ws);
      const file = readTriggersFile(path);
      const reg = file.registered.find((r) => r.id === args.id);
      if (!reg) return notFound('registered_trigger', args.id);
      const runId = mintId('run');
      logger.info(
        { triggerId: reg.id, triggerType: reg.type, runId, payload: args.payload ?? null },
        'trigger.fire queued',
      );
      return {
        content: [{ type: 'text', text: `Queued trigger ${reg.id} (run_id=${runId}).` }],
        structuredContent: { id: reg.id, type: reg.type, run_id: runId, status: 'queued' },
      };
    },
  );

  // -- trigger.create_template ---------------------------------------------
  server.registerTool(
    'trigger.create_template',
    {
      description:
        'Create a new agent-authored trigger TYPE on disk. Persisted as `<scope>/trigger-types/<id>/template.yaml + trigger.<ext>`. Reloads `ws.triggerTypes` so `trigger.register` can immediately consume it. Id must start with `local.`.',
      inputSchema: {
        id: z.string().min(1).describe("Type id; must match /^local\\.[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$/."),
        scope: z.enum(['project', 'global']).optional().describe("Default 'project'."),
        description: z.string().min(1),
        runtime: z.enum(['node', 'tsx', 'python', 'bash']),
        script: z.string().optional().describe('Inline script source. XOR with script_file.'),
        script_file: z.string().optional().describe('Path under <projectDir>/.clawdevbox/. Copied into the template dir.'),
        default_cron: z.string().optional(),
        identity_param: z.string().optional(),
        accepts_webhook: z.boolean().optional(),
        binds_callback_to_recipe: z.string().optional(),
        binds_callback_to: z.literal('thread_resume').optional(),
        parameters: z.array(z.record(z.string(), z.unknown())).optional(),
      },
    },
    async (args) => {
      const scope = args.scope ?? 'project';
      const hasScript = typeof args.script === 'string';
      const hasFile = typeof args.script_file === 'string';
      if (hasScript === hasFile) {
        return structuredError('INVALID_REQUEST',
          'Provide exactly one of `script` (inline) or `script_file` (path).',
          { script_provided: hasScript, script_file_provided: hasFile });
      }

      const manifest: TemplateManifest = {
        id: args.id,
        file: `trigger.${args.runtime === 'tsx' ? 'ts' : args.runtime === 'node' ? 'js' : args.runtime === 'python' ? 'py' : 'sh'}`,
        runtime: args.runtime as TriggerRuntime,
        description: args.description,
      };
      if (args.default_cron !== undefined) manifest.default_cron = args.default_cron;
      if (args.identity_param !== undefined) manifest.identity_param = args.identity_param;
      if (args.accepts_webhook !== undefined) manifest.accepts_webhook = args.accepts_webhook;
      if (args.binds_callback_to_recipe !== undefined) manifest.binds_callback_to_recipe = args.binds_callback_to_recipe;
      if (args.binds_callback_to !== undefined) manifest.binds_callback_to = args.binds_callback_to;
      if (Array.isArray(args.parameters)) manifest.parameters = args.parameters as TemplateManifest['parameters'];

      const validation = validateAgentAuthoredTemplate(manifest);
      if (!validation.ok) {
        return validationError(validation.errors);
      }

      if (templateExists(ws, scope, args.id)) {
        return structuredError('TRIGGER_TEMPLATE_EXISTS',
          `A template with id ${args.id} already exists in scope ${scope}.`,
          { id: args.id, scope });
      }

      let scriptContent: string;
      if (hasScript) {
        scriptContent = args.script!;
      } else {
        const fileGuard = ensureFileUnderClawdevbox(ws.projectDir, args.script_file!);
        if (!fileGuard.ok) return fileGuard.error;
        scriptContent = readFileSync(fileGuard.path, 'utf8');
      }

      const written = writeTemplate(ws, scope, { manifest, scriptContent });
      reloadTypeRegistries(ws);

      return {
        content: [{ type: 'text', text: `Created template ${args.id} (scope=${scope}).` }],
        structuredContent: {
          id: args.id, scope, path: written.dir,
          script_path: written.scriptAbs, type_exists: true,
        },
      };
    },
  );

  // -- trigger.list_templates ----------------------------------------------
  server.registerTool(
    'trigger.list_templates',
    {
      description:
        'List agent-authored trigger TYPES (project + global scopes). Equivalent to `trigger.list_types` filtered to scope in {project, global}.',
      inputSchema: {
        scope: z.enum(['project', 'global']).optional(),
        search: z.string().min(1).optional(),
      },
    },
    async (args) => {
      const all = [...ws.triggerTypes.values()].sort((a, b) => a.id.localeCompare(b.id));
      let filtered = all.filter((t) => t.scope === 'project' || t.scope === 'global');
      if (args.scope) filtered = filtered.filter((t) => t.scope === args.scope);
      if (args.search) {
        const q = args.search.toLowerCase();
        filtered = filtered.filter((t) =>
          t.id.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q),
        );
      }
      const projected = filtered.map(projectType);
      return {
        content: [{ type: 'text', text: `Found ${projected.length} agent-authored template(s).` }],
        structuredContent: { trigger_types: projected, count: projected.length },
      };
    },
  );

  // -- trigger.update_template --------------------------------------------
  server.registerTool(
    'trigger.update_template',
    {
      description:
        'Update an agent-authored trigger template in place (project or global). Manifest fields omitted from the call are preserved; script is replaced only when `script` or `script_file` is supplied. Reloads `ws.triggerTypes` on success.',
      inputSchema: {
        id: z.string().min(1),
        description: z.string().optional(),
        runtime: z.enum(['node', 'tsx', 'python', 'bash']).optional(),
        script: z.string().optional(),
        script_file: z.string().optional(),
        default_cron: z.string().optional(),
        identity_param: z.string().optional(),
        accepts_webhook: z.boolean().optional(),
        binds_callback_to_recipe: z.string().optional(),
        binds_callback_to: z.literal('thread_resume').optional(),
        parameters: z.array(z.record(z.string(), z.unknown())).optional(),
      },
    },
    async (args) => {
      const existing = findTemplate(ws, args.id);
      if (!existing) return structuredError('TRIGGER_TEMPLATE_NOT_FOUND',
        `Template ${args.id} not found.`, { id: args.id });

      const hasScript = typeof args.script === 'string';
      const hasFile = typeof args.script_file === 'string';
      if (hasScript && hasFile) {
        return structuredError('INVALID_REQUEST',
          'Provide at most one of `script` or `script_file`.',
          { script_provided: true, script_file_provided: true });
      }
      const manifestKeys: Array<keyof typeof args> = [
        'description', 'runtime', 'default_cron', 'identity_param',
        'accepts_webhook', 'binds_callback_to_recipe', 'binds_callback_to', 'parameters',
      ];
      const anyManifestChange = manifestKeys.some((k) => args[k] !== undefined);
      if (!hasScript && !hasFile && !anyManifestChange) {
        return structuredError('NO_CHANGES',
          'trigger.update_template requires at least one field to change.',
          { id: args.id });
      }

      const merged: TemplateManifest = { ...existing.manifest };
      if (args.runtime !== undefined) {
        const r = validateRuntime(args.runtime);
        if (!r.ok) return validationError([{ path: 'runtime', code: 'ENUM', message: r.message }]);
        merged.runtime = r.runtime;
        merged.file = `trigger.${r.runtime === 'tsx' ? 'ts' : r.runtime === 'node' ? 'js' : r.runtime === 'python' ? 'py' : 'sh'}`;
      }
      if (args.description !== undefined) merged.description = args.description;
      if (args.default_cron !== undefined) merged.default_cron = args.default_cron;
      if (args.identity_param !== undefined) merged.identity_param = args.identity_param;
      if (args.accepts_webhook !== undefined) merged.accepts_webhook = args.accepts_webhook;
      if (args.binds_callback_to_recipe !== undefined) merged.binds_callback_to_recipe = args.binds_callback_to_recipe;
      if (args.binds_callback_to !== undefined) merged.binds_callback_to = args.binds_callback_to;
      if (Array.isArray(args.parameters)) merged.parameters = args.parameters as TemplateManifest['parameters'];

      const validation = validateAgentAuthoredTemplate(merged);
      if (!validation.ok) return validationError(validation.errors);

      let scriptContent: string;
      if (hasScript) {
        scriptContent = args.script!;
      } else if (hasFile) {
        const guard = ensureFileUnderClawdevbox(ws.projectDir, args.script_file!);
        if (!guard.ok) return guard.error;
        scriptContent = readFileSync(guard.path, 'utf8');
      } else {
        scriptContent = readFileSync(existing.scriptAbs, 'utf8');
      }

      if (args.runtime !== undefined && existing.manifest.runtime !== merged.runtime) {
        try { rmSync(existing.scriptAbs, { force: true }); } catch { /* ignore */ }
      }

      const written = writeTemplate(ws, existing.scope, { manifest: merged, scriptContent });
      reloadTypeRegistries(ws);

      return {
        content: [{ type: 'text', text: `Updated template ${args.id}.` }],
        structuredContent: { id: args.id, scope: existing.scope, path: written.dir },
      };
    },
  );

  // -- trigger.delete_template -------------------------------------------
  server.registerTool(
    'trigger.delete_template',
    {
      description:
        'Delete an agent-authored trigger template by id. Refuses to delete plugin-shipped TYPES (use plugin.uninstall) or templates referenced by registered instances (unregister first).',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const existing = findTemplate(ws, args.id);
      if (!existing) {
        const inMap = ws.triggerTypes.get(args.id);
        if (inMap && inMap.scope.startsWith('plugin:')) {
          return structuredError('TRIGGER_TEMPLATE_NOT_AUTHORED',
            `${args.id} is a plugin-shipped trigger type. Use plugin.uninstall to remove it.`,
            { id: args.id, scope: inMap.scope });
        }
        return structuredError('TRIGGER_TEMPLATE_NOT_FOUND',
          `Template ${args.id} not found.`, { id: args.id });
      }
      const file = readTriggersFile(triggersJsonPath(ws));
      const refs = file.registered.filter((r) => r.type === args.id).map((r) => r.id);
      if (refs.length > 0) {
        return structuredError('TRIGGER_TEMPLATE_IN_USE',
          `Template ${args.id} is referenced by ${refs.length} registered instance(s). Unregister them first.`,
          { id: args.id, registered_ids: refs });
      }
      const removed = deleteTemplate(ws, existing.scope, args.id);
      reloadTypeRegistries(ws);
      return {
        content: [{ type: 'text', text: `Deleted template ${args.id} (scope=${existing.scope}).` }],
        structuredContent: { id: args.id, scope: existing.scope, removed },
      };
    },
  );
}
