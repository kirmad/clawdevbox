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
  MONOTONIC_TRANSITIONS,
  removeSteps,
  StepTransitionError,
  StepValidationError,
  transitionStatus,
  updateMeta,
  type RecipeStepRow,
  type RecipeStepStatus,
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
  // Note: explicit field declaration + assignment in the body (rather than
  // a TypeScript parameter property like `constructor(public payload: ...)`)
  // because Node's --experimental-strip-types mode used by the test runner
  // does not support parameter property syntax.
  readonly payload: ToolError;
  constructor(payload: ToolError) {
    super(payload.message);
    this.payload = payload;
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
       auto_declared, auto_registered_by_step_id,
       expires_at, once, max_attempts, backoff_ms_json,
       registered_at, state_json
     ) VALUES (
       ?, ?, ?, ?,
       ?, ?, 1,
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


// ============================================================================
// recipe.steps.update_status
// ============================================================================

export interface UpdateStatusOpts {
  recipe_instance_id: string;
  step_id: string;
  status?: RecipeStepStatus;
  message?: string;
  state?: Record<string, unknown>;
  state_replace?: Record<string, unknown>;
  result?: string;
  error?: string;
  attach_artifact_ids?: string[];
  attach_inbox_item_ids?: string[];
  request_user_input?: {
    message: string;
    options?: string[];
    inbox_item?: { title?: string; labels?: string[] };
  };
  agent_session_id?: string | null;
}

export interface UpdateStatusResult {
  step: RecipeStepRow;
  registered_trigger_ids: string[];
  disabled_trigger_ids: string[];
  attached_artifact_ids: string[];
  attached_inbox_item_ids: string[];
  created_inbox_item_id: string | null;
  recipe_instance_status: string | null;
  trigger_registration_errors: Array<{ type: string; message: string }>;
}

function mintInboxItemId(): string {
  return `inb_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

export function updateStatusImpl(
  db: Database,
  opts: UpdateStatusOpts,
): UpdateStatusResult {
  if (opts.state && opts.state_replace) {
    throw new ToolErrorBox({
      code: 'MUTUALLY_EXCLUSIVE_STATE_FIELDS',
      message: 'state and state_replace are mutually exclusive.',
    });
  }
  const inst = lookupInstanceWorkspace(db, opts.recipe_instance_id);
  if (!inst) {
    throw new ToolErrorBox({
      code: 'RECIPE_INSTANCE_NOT_FOUND',
      message: `recipe_instance ${opts.recipe_instance_id} not found`,
      detail: { recipe_instance_id: opts.recipe_instance_id },
    });
  }
  const current = getStep(db, opts.recipe_instance_id, opts.step_id);
  if (!current) {
    throw new ToolErrorBox({
      code: 'STEP_NOT_FOUND',
      message: `step '${opts.step_id}' not in instance`,
      detail: { step_id: opts.step_id },
    });
  }

  const out: UpdateStatusResult = {
    step: current,
    registered_trigger_ids: [],
    disabled_trigger_ids: [],
    attached_artifact_ids: [],
    attached_inbox_item_ids: [],
    created_inbox_item_id: null,
    recipe_instance_status: null,
    trigger_registration_errors: [],
  };

  const tx = db.transaction(() => {
    let registerAtEntry = false;
    if (opts.status === 'running' && current.status !== 'running') {
      registerAtEntry = true;
    }

    let workingRow: RecipeStepRow = current;
    if (
      opts.status !== undefined ||
      opts.state !== undefined ||
      opts.state_replace !== undefined ||
      opts.result !== undefined ||
      opts.error !== undefined ||
      opts.message !== undefined
    ) {
      try {
        workingRow = transitionStatus(db, current.id, {
          status: opts.status,
          message: opts.message,
          state: opts.state,
          state_replace: opts.state_replace,
          result: opts.result,
          error: opts.error,
          agent_session_id: opts.agent_session_id ?? undefined,
        });
      } catch (e) {
        if (e instanceof StepTransitionError) {
          throw new ToolErrorBox({
            code: 'INVALID_STEP_TRANSITION',
            message: e.message,
            detail: { from: e.from, to: e.to },
          });
        }
        if (e instanceof StepValidationError) {
          throw new ToolErrorBox({ code: 'INVALID_STEP_SCHEMA', message: e.message });
        }
        throw e;
      }
    }

    if (registerAtEntry) {
      const decls = JSON.parse(workingRow.triggers_decl_json) as TriggerDecl[];
      const errors: Array<{ type: string; message: string }> = [];
      for (const decl of decls) {
        try {
          const trigId = registerAutoTrigger(db, {
            workspace_id: inst.workspace_id,
            recipe_instance_id: opts.recipe_instance_id,
            recipe_step_id: workingRow.id,
            decl,
          });
          out.registered_trigger_ids.push(trigId);
          appendEvent(db, {
            recipe_step_id: workingRow.id,
            recipe_instance_id: opts.recipe_instance_id,
            agent_session_id: opts.agent_session_id ?? null,
            type: 'trigger_registered',
            payload: { trigger_id: trigId, type: decl.type, auto_declared: true },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push({ type: decl.type, message: msg });
          appendEvent(db, {
            recipe_step_id: workingRow.id,
            recipe_instance_id: opts.recipe_instance_id,
            agent_session_id: opts.agent_session_id ?? null,
            type: 'trigger_registration_failed',
            message: msg,
            payload: { type: decl.type },
          });
        }
      }
      if (errors.length > 0) {
        out.trigger_registration_errors = errors;
        const prevState = JSON.parse(workingRow.state_json) as Record<string, unknown>;
        const merged = { ...prevState, trigger_registration_errors: errors };
        db.prepare(`UPDATE recipe_steps SET state_json = ? WHERE id = ?`).run(
          JSON.stringify(merged),
          workingRow.id,
        );
      }
    }

    if (opts.request_user_input) {
      try {
        workingRow = transitionStatus(db, workingRow.id, {
          status: 'awaiting_user',
          awaiting_user_message: opts.request_user_input.message,
          agent_session_id: opts.agent_session_id ?? undefined,
        });
      } catch (e) {
        if (e instanceof StepTransitionError) {
          throw new ToolErrorBox({
            code: 'INVALID_STEP_TRANSITION',
            message: e.message,
            detail: { from: e.from, to: e.to },
          });
        }
        throw e;
      }
      const inboxId = mintInboxItemId();
      const optsList = opts.request_user_input.options ?? [];
      const body =
        opts.request_user_input.message +
        (optsList.length > 0 ? '\n\nOptions:\n' + optsList.map((o) => `- ${o}`).join('\n') : '');
      const now = Date.now();
      db.prepare(
        `INSERT INTO inbox_items (
           id, workspace_id, title, preview, body_path,
           labels_json, source, status,
           recipe_instance_id, recipe_step_id, agent_session_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, 'user_input', 'unread', ?, ?, ?, ?, ?)`,
      ).run(
        inboxId,
        inst.workspace_id,
        opts.request_user_input.inbox_item?.title ?? 'User input requested',
        body.slice(0, 200),
        JSON.stringify(opts.request_user_input.inbox_item?.labels ?? []),
        opts.recipe_instance_id,
        workingRow.id,
        opts.agent_session_id ?? null,
        now,
        now,
      );
      out.created_inbox_item_id = inboxId;
      appendEvent(db, {
        recipe_step_id: workingRow.id,
        recipe_instance_id: opts.recipe_instance_id,
        agent_session_id: opts.agent_session_id ?? null,
        type: 'user_input_requested',
        message: opts.request_user_input.message,
        payload: { inbox_item_id: inboxId, options: optsList },
      });
    }

    if (opts.attach_artifact_ids && opts.attach_artifact_ids.length > 0) {
      for (const aid of opts.attach_artifact_ids) {
        const exists = db
          .prepare('SELECT id FROM artifacts WHERE id = ?')
          .get(aid) as { id: string } | undefined;
        if (!exists) {
          throw new ToolErrorBox({
            code: 'ARTIFACT_NOT_FOUND',
            message: `artifact ${aid} not found`,
            detail: { artifact_id: aid },
          });
        }
        db.prepare('UPDATE artifacts SET recipe_step_id = ?, updated_at = ? WHERE id = ?')
          .run(workingRow.id, Date.now(), aid);
        out.attached_artifact_ids.push(aid);
        appendEvent(db, {
          recipe_step_id: workingRow.id,
          recipe_instance_id: opts.recipe_instance_id,
          agent_session_id: opts.agent_session_id ?? null,
          type: 'artifact_attached',
          payload: { artifact_id: aid },
        });
      }
    }

    if (opts.attach_inbox_item_ids && opts.attach_inbox_item_ids.length > 0) {
      for (const iid of opts.attach_inbox_item_ids) {
        const exists = db
          .prepare('SELECT id FROM inbox_items WHERE id = ?')
          .get(iid) as { id: string } | undefined;
        if (!exists) {
          throw new ToolErrorBox({
            code: 'INBOX_ITEM_NOT_FOUND',
            message: `inbox_item ${iid} not found`,
            detail: { inbox_item_id: iid },
          });
        }
        db.prepare('UPDATE inbox_items SET recipe_step_id = ? WHERE id = ?').run(
          workingRow.id,
          iid,
        );
        out.attached_inbox_item_ids.push(iid);
        appendEvent(db, {
          recipe_step_id: workingRow.id,
          recipe_instance_id: opts.recipe_instance_id,
          agent_session_id: opts.agent_session_id ?? null,
          type: 'inbox_attached',
          payload: { inbox_item_id: iid },
        });
      }
    }

    const TERMINAL = new Set<RecipeStepStatus>(['done', 'failed', 'skipped']);
    if (TERMINAL.has(workingRow.status)) {
      const ids = disableAutoTriggers(db, workingRow.id);
      out.disabled_trigger_ids.push(...ids);
      for (const tid of ids) {
        appendEvent(db, {
          recipe_step_id: workingRow.id,
          recipe_instance_id: opts.recipe_instance_id,
          agent_session_id: opts.agent_session_id ?? null,
          type: 'trigger_unregistered',
          payload: { trigger_id: tid, reason: 'step_terminal' },
        });
      }
      const siblings = listSteps(db, opts.recipe_instance_id);
      const allTerminal = siblings.every((r) => TERMINAL.has(r.status));
      if (allTerminal && siblings.length > 0) {
        const anyFailed = siblings.some((r) => r.status === 'failed');
        const newStatus = anyFailed ? 'failure' : 'success';
        db.prepare(
          `UPDATE recipe_instances
           SET status = ?, completed_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(newStatus, Date.now(), opts.recipe_instance_id);
        const row = db
          .prepare('SELECT status FROM recipe_instances WHERE id = ?')
          .get(opts.recipe_instance_id) as { status: string } | undefined;
        out.recipe_instance_status = row?.status ?? null;
      }
    }

    out.step = workingRow;
  });

  try {
    tx();
  } catch (e) {
    if (e instanceof ToolErrorBox) throw e;
    if (e instanceof StepTransitionError) {
      throw new ToolErrorBox({
        code: 'INVALID_STEP_TRANSITION',
        message: e.message,
        detail: { from: e.from, to: e.to },
      });
    }
    if (e instanceof StepValidationError) {
      throw new ToolErrorBox({ code: 'INVALID_STEP_SCHEMA', message: e.message });
    }
    throw e;
  }
  return out;
}

export { MONOTONIC_TRANSITIONS };
