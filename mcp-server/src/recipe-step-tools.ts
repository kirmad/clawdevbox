/**
 * recipe-step-tools.ts
 *
 * Pure DB-level helpers backing the `recipe.update_steps` and
 * `recipe.steps.update_status` MCP tools (spec §10.5). Keeping the logic
 * out of `tools/recipe.ts` lets us unit-test the side-effect graph
 * (transitions, trigger registration, terminal-cascade, audit events)
 * without spawning a full MCP server.
 */

import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  addSteps,
  getStep,
  listSteps,
  removeSteps,
  StepValidationError,
  updateMeta,
  type RecipeStepRow,
  type Step,
  type TriggerDecl,
} from './db/recipe-steps-store.ts';
import { appendEvent } from './db/step-events-store.ts';

export interface UpdateStepsOpts {
  recipe_instance_id: string;
  add?: Step[];
  remove?: string[];
  update_meta?: Array<Partial<Step> & { id: string }>;
  agent_session_id?: string | null;
}

export interface UpdateStepsResult {
  added: RecipeStepRow[];
  removed: string[];
  updated: RecipeStepRow[];
  trigger_changes: Array<{
    step_id: string;
    added_triggers: TriggerDecl[];
    removed_triggers: TriggerDecl[];
    registered_trigger_ids: string[];
    disabled_trigger_ids: string[];
  }>;
}

export interface ToolError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export class ToolErrorBox extends Error {
  constructor(public payload: ToolError) {
    super(payload.message);
  }
}

function mintAutoTriggerId(type: string): string {
  return `${type}#auto-${randomBytes(4).toString('hex')}`;
}

function ensureNoCycle(
  recipe_instance_id: string,
  db: Database,
): void {
  const all = listSteps(db, recipe_instance_id);
  const adj = new Map<string, string[]>();
  for (const r of all) adj.set(r.step_id, JSON.parse(r.depends_json));
  // DFS cycle detection. WHITE=0 GREY=1 BLACK=2
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, 0);
  const visit = (n: string): void => {
    color.set(n, 1);
    for (const dep of adj.get(n) ?? []) {
      const c = color.get(dep) ?? 0;
      if (c === 1) {
        throw new ToolErrorBox({
          code: 'CIRCULAR_DEPENDENCY',
          message: `circular dependency involving step '${n}' → '${dep}'`,
          detail: { from: n, to: dep },
        });
      }
      if (c === 0) visit(dep);
    }
    color.set(n, 2);
  };
  for (const id of adj.keys()) {
    if ((color.get(id) ?? 0) === 0) visit(id);
  }
}

/**
 * Register an auto-declared trigger for a step. Inserts directly into the
 * `triggers` table. The id is `<type>#auto-<4hex>` so multiple steps can
 * declare the same trigger type without collision.
 */
function registerAutoTrigger(
  db: Database,
  opts: {
    workspace_id: string;
    recipe_instance_id: string;
    recipe_step_id: string;
    decl: TriggerDecl;
  },
): string {
  const id = mintAutoTriggerId(opts.decl.type);
  const cron = opts.decl.cron;
  let cron_mode: 'inherit' | 'override' | 'disabled';
  let cron_expression: string | null;
  if (cron === undefined || cron === null) {
    cron_mode = 'inherit';
    cron_expression = null;
  } else if (cron === false || cron === '') {
    cron_mode = 'disabled';
    cron_expression = null;
  } else {
    cron_mode = 'override';
    cron_expression = cron;
  }
  db.prepare(
    `INSERT INTO triggers (
       id, workspace_id, type, params_json,
       cron_mode, cron_expression, enabled,
       recipe_instance_id, recipe_step_id,
       binds_callback_to, binds_callback_to_recipe,
       auto_declared, auto_registered_by_step_id,
       expires_at, once, max_attempts, backoff_ms_json,
       registered_at, state_json
     ) VALUES (
       ?, ?, ?, ?,
       ?, ?, 1,
       ?, ?,
       ?, ?,
       1, ?,
       ?, ?, ?, ?,
       ?, '{}'
     )`,
  ).run(
    id,
    opts.workspace_id,
    opts.decl.type,
    JSON.stringify(opts.decl.params ?? {}),
    cron_mode,
    cron_expression,
    opts.recipe_instance_id,
    opts.recipe_step_id,
    opts.decl.binds_callback_to ?? null,
    opts.decl.binds_callback_to_recipe ?? null,
    opts.recipe_step_id,
    opts.decl.expires_at ?? null,
    opts.decl.once ? 1 : 0,
    opts.decl.max_attempts ?? 3,
    JSON.stringify(opts.decl.backoff_ms ?? [30000, 120000, 600000]),
    Date.now(),
  );
  return id;
}

function lookupInstanceWorkspace(
  db: Database,
  recipe_instance_id: string,
): { workspace_id: string } | null {
  const row = db
    .prepare('SELECT workspace_id FROM recipe_instances WHERE id = ?')
    .get(recipe_instance_id) as { workspace_id: string } | undefined;
  return row ?? null;
}

function disableAutoTriggers(
  db: Database,
  recipe_step_id: string,
  type?: string,
): string[] {
  const rows = (type
    ? db
        .prepare(
          `SELECT id FROM triggers
           WHERE auto_registered_by_step_id = ? AND type = ? AND enabled = 1`,
        )
        .all(recipe_step_id, type)
    : db
        .prepare(
          `SELECT id FROM triggers
           WHERE auto_registered_by_step_id = ? AND enabled = 1`,
        )
        .all(recipe_step_id)) as Array<{ id: string }>;
  for (const r of rows) {
    db.prepare('UPDATE triggers SET enabled = 0 WHERE id = ?').run(r.id);
  }
  return rows.map((r) => r.id);
}

/**
 * Apply add / remove / update_meta against a recipe instance, registering or
 * disabling auto-declared triggers as needed. Throws ToolErrorBox on failure.
 */
export function updateStepsImpl(
  db: Database,
  opts: UpdateStepsOpts,
): UpdateStepsResult {
  const inst = lookupInstanceWorkspace(db, opts.recipe_instance_id);
  if (!inst) {
    throw new ToolErrorBox({
      code: 'RECIPE_INSTANCE_NOT_FOUND',
      message: `recipe_instance ${opts.recipe_instance_id} not found`,
      detail: { recipe_instance_id: opts.recipe_instance_id },
    });
  }

  const result: UpdateStepsResult = {
    added: [],
    removed: [],
    updated: [],
    trigger_changes: [],
  };

  const tx = db.transaction(() => {
    // 1. Removals first so a subsequent add can re-use a removed step_id.
    if (opts.remove && opts.remove.length > 0) {
      try {
        // Pre-check each removal target before delegating.
        const all = listSteps(db, opts.recipe_instance_id);
        const byId = new Map(all.map((r) => [r.step_id, r]));
        for (const sid of opts.remove) {
          const row = byId.get(sid);
          if (!row) {
            throw new ToolErrorBox({
              code: 'STEP_NOT_FOUND',
              message: `step '${sid}' not in instance`,
              detail: { step_id: sid },
            });
          }
          if (row.status === 'running' || row.status === 'awaiting_user') {
            throw new ToolErrorBox({
              code: 'CANNOT_REMOVE_RUNNING_STEP',
              message: `cannot remove step '${sid}' in status '${row.status}'`,
              detail: { step_id: sid, status: row.status },
            });
          }
        }
        removeSteps(db, opts.recipe_instance_id, opts.remove);
        result.removed.push(...opts.remove);
      } catch (e) {
        if (e instanceof ToolErrorBox) throw e;
        if (e instanceof StepValidationError) {
          throw new ToolErrorBox({
            code: 'INVALID_STEP_SCHEMA',
            message: e.message,
          });
        }
        throw e;
      }
    }

    // 2. Adds.
    if (opts.add && opts.add.length > 0) {
      try {
        const rows = addSteps(db, opts.recipe_instance_id, opts.add);
        result.added.push(...rows);
      } catch (e) {
        if (e instanceof StepValidationError) {
          const code = /unknown step|depends/.test(e.message)
            ? 'INVALID_DEPENDENCY'
            : 'INVALID_STEP_SCHEMA';
          throw new ToolErrorBox({ code, message: e.message });
        }
        throw e;
      }
    }

    // 3. update_meta.
    if (opts.update_meta && opts.update_meta.length > 0) {
      for (const patch of opts.update_meta) {
        const { id, ...rest } = patch;
        const existing = getStep(db, opts.recipe_instance_id, id);
        if (!existing) {
          throw new ToolErrorBox({
            code: 'STEP_NOT_FOUND',
            message: `step '${id}' not in instance`,
            detail: { step_id: id },
          });
        }
        let diff;
        try {
          diff = updateMeta(db, opts.recipe_instance_id, id, rest);
        } catch (e) {
          if (e instanceof StepValidationError) {
            const code = /unknown step|depends/.test(e.message)
              ? 'INVALID_DEPENDENCY'
              : 'INVALID_STEP_SCHEMA';
            throw new ToolErrorBox({ code, message: e.message });
          }
          throw e;
        }
        result.updated.push(diff.row);

        const registered_trigger_ids: string[] = [];
        const disabled_trigger_ids: string[] = [];
        // Register added triggers only if the step is already running.
        // Pending steps register on entry (see updateStatusImpl below).
        if (diff.row.status === 'running' || diff.row.status === 'awaiting_user') {
          for (const decl of diff.added_triggers) {
            const trigId = registerAutoTrigger(db, {
              workspace_id: inst.workspace_id,
              recipe_instance_id: opts.recipe_instance_id,
              recipe_step_id: diff.row.id,
              decl,
            });
            registered_trigger_ids.push(trigId);
            appendEvent(db, {
              recipe_step_id: diff.row.id,
              recipe_instance_id: opts.recipe_instance_id,
              agent_session_id: opts.agent_session_id ?? null,
              type: 'trigger_registered',
              payload: { trigger_id: trigId, type: decl.type, auto_declared: true },
            });
          }
        }
        // Disable matching auto-declared triggers for each removed decl.
        for (const decl of diff.removed_triggers) {
          const ids = disableAutoTriggers(db, diff.row.id, decl.type);
          disabled_trigger_ids.push(...ids);
          for (const tid of ids) {
            appendEvent(db, {
              recipe_step_id: diff.row.id,
              recipe_instance_id: opts.recipe_instance_id,
              agent_session_id: opts.agent_session_id ?? null,
              type: 'trigger_unregistered',
              payload: { trigger_id: tid, type: decl.type, reason: 'meta_patch' },
            });
          }
        }
        result.trigger_changes.push({
          step_id: id,
          added_triggers: diff.added_triggers,
          removed_triggers: diff.removed_triggers,
          registered_trigger_ids,
          disabled_trigger_ids,
        });
      }
    }

    // Post-mutation cycle check.
    ensureNoCycle(opts.recipe_instance_id, db);
  });

  try {
    tx();
  } catch (e) {
    if (e instanceof ToolErrorBox) throw e;
    if (e instanceof StepValidationError) {
      const code = /unknown step|depends/.test(e.message)
        ? 'INVALID_DEPENDENCY'
        : 'INVALID_STEP_SCHEMA';
      throw new ToolErrorBox({ code, message: e.message });
    }
    throw e;
  }
  return result;
}
