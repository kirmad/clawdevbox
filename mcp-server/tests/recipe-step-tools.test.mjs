/**
 * Unit tests for the recipe.update_steps tool implementation (spec §10.5).
 * Drives the pure helper `updateStepsImpl` in `src/recipe-step-tools.ts`
 * against an in-memory SQLite DB so we can exercise add/remove/update_meta
 * paths and the trigger registration/disable side effects without spawning
 * a full MCP server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { materializeSteps } from '../src/db/recipe-steps-store.ts';
import { ToolErrorBox, updateStepsImpl } from '../src/recipe-step-tools.ts';

function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db, opts = {}) {
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_test_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (
       id, recipe_id, workspace_id, workspace_path, prompt,
       params_json, started_at, status
     ) VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  const initial = opts.steps ?? [
    { id: 's1', goal: 'first' },
    { id: 's2', goal: 'second', depends: ['s1'] },
  ];
  materializeSteps(db, instanceId, initial);
  return { ws, instanceId };
}

function getStepRow(db, instanceId, step_id) {
  return db
    .prepare('SELECT * FROM recipe_steps WHERE recipe_instance_id = ? AND step_id = ?')
    .get(instanceId, step_id);
}

function forceRunning(db, instanceId, stepId) {
  db.prepare(
    `UPDATE recipe_steps SET status = 'running', started_at = ?
     WHERE recipe_instance_id = ? AND step_id = ?`,
  ).run(Date.now(), instanceId, stepId);
}

test('update_steps: add new step appears in DB with step_added event', () => {
  const db = open();
  const { instanceId } = seed(db);
  const res = updateStepsImpl(db, {
    recipe_instance_id: instanceId,
    add: [{ id: 's3', goal: 'third', depends: ['s2'] }],
  });
  assert.equal(res.added.length, 1);
  assert.equal(res.added[0].step_id, 's3');
  const row = getStepRow(db, instanceId, 's3');
  assert.ok(row);
  assert.equal(row.status, 'pending');
  assert.deepEqual(JSON.parse(row.depends_json), ['s2']);
  const evs = db
    .prepare('SELECT * FROM step_events WHERE recipe_instance_id = ?')
    .all(instanceId);
  assert.ok(
    evs.some(
      (e) => e.type === 'step_added' && JSON.parse(e.payload_json).step_id === 's3',
    ),
  );
});

test('update_steps: remove pending step succeeds', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  const res = updateStepsImpl(db, {
    recipe_instance_id: instanceId,
    remove: ['s1'],
  });
  assert.deepEqual(res.removed, ['s1']);
  assert.equal(getStepRow(db, instanceId, 's1'), undefined);
});

test('update_steps: remove running step returns CANNOT_REMOVE_RUNNING_STEP', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  forceRunning(db, instanceId, 's1');
  assert.throws(
    () =>
      updateStepsImpl(db, {
        recipe_instance_id: instanceId,
        remove: ['s1'],
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'CANNOT_REMOVE_RUNNING_STEP',
  );
});

test('update_steps: add with unknown dependency returns INVALID_DEPENDENCY', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  assert.throws(
    () =>
      updateStepsImpl(db, {
        recipe_instance_id: instanceId,
        add: [{ id: 's2', goal: 'b', depends: ['ghost'] }],
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'INVALID_DEPENDENCY',
  );
});

test('update_steps: circular dependency via update_meta returns CIRCULAR_DEPENDENCY', () => {
  const db = open();
  const { instanceId } = seed(db, {
    steps: [
      { id: 'a', goal: 'A' },
      { id: 'b', goal: 'B', depends: ['a'] },
    ],
  });
  assert.throws(
    () =>
      updateStepsImpl(db, {
        recipe_instance_id: instanceId,
        update_meta: [{ id: 'a', depends: ['b'] }],
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'CIRCULAR_DEPENDENCY',
  );
});

test('update_steps: update_meta on running step with new trigger registers it', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  forceRunning(db, instanceId, 's1');
  const res = updateStepsImpl(db, {
    recipe_instance_id: instanceId,
    update_meta: [
      {
        id: 's1',
        triggers: [{ type: 'demo.poll', params: { every: '5m' }, cron: false }],
      },
    ],
  });
  assert.equal(res.trigger_changes.length, 1);
  assert.equal(res.trigger_changes[0].added_triggers.length, 1);
  assert.equal(res.trigger_changes[0].registered_trigger_ids.length, 1);
  const rsRow = getStepRow(db, instanceId, 's1');
  const trigRows = db
    .prepare('SELECT * FROM triggers WHERE auto_registered_by_step_id = ? AND enabled = 1')
    .all(rsRow.id);
  assert.equal(trigRows.length, 1);
  assert.equal(trigRows[0].type, 'demo.poll');
  assert.equal(trigRows[0].auto_declared, 1);
});

test('update_steps: update_meta removing a trigger on running step disables it', () => {
  const db = open();
  const { instanceId, ws } = seed(db, {
    steps: [
      {
        id: 's1',
        goal: 'a',
        triggers: [{ type: 'demo.poll', params: { every: '5m' }, cron: false }],
      },
    ],
  });
  forceRunning(db, instanceId, 's1');
  // Pre-register an auto-declared trigger as if entry hook had run.
  const rsRow = getStepRow(db, instanceId, 's1');
  db.prepare(
    `INSERT INTO triggers (
       id, workspace_id, type, params_json,
       cron_mode, cron_expression, enabled,
       recipe_instance_id, recipe_step_id,
       auto_declared, auto_registered_by_step_id,
       once, max_attempts, backoff_ms_json, registered_at, state_json
     ) VALUES (?, ?, 'demo.poll', '{"every":"5m"}',
       'disabled', NULL, 1,
       ?, ?,
       1, ?,
       0, 3, '[30000,120000,600000]', ?, '{}')`,
  ).run(
    'demo.poll#auto-aaaa',
    ws.id,
    instanceId,
    rsRow.id,
    rsRow.id,
    Date.now(),
  );

  let trigs = db
    .prepare('SELECT * FROM triggers WHERE auto_registered_by_step_id = ?')
    .all(rsRow.id);
  assert.equal(trigs.length, 1);
  assert.equal(trigs[0].enabled, 1);

  updateStepsImpl(db, {
    recipe_instance_id: instanceId,
    update_meta: [{ id: 's1', triggers: [] }],
  });
  trigs = db
    .prepare('SELECT * FROM triggers WHERE auto_registered_by_step_id = ?')
    .all(rsRow.id);
  assert.equal(trigs.length, 1, 'row should still exist (soft-disable)');
  assert.equal(trigs[0].enabled, 0);
});

test('update_steps: unknown step in update_meta returns STEP_NOT_FOUND', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  assert.throws(
    () =>
      updateStepsImpl(db, {
        recipe_instance_id: instanceId,
        update_meta: [{ id: 'ghost', goal: 'g' }],
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'STEP_NOT_FOUND',
  );
});

test('update_steps: unknown recipe instance returns RECIPE_INSTANCE_NOT_FOUND', () => {
  const db = open();
  assert.throws(
    () =>
      updateStepsImpl(db, {
        recipe_instance_id: 'ri_nope',
        add: [{ id: 's1', goal: 'g' }],
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'RECIPE_INSTANCE_NOT_FOUND',
  );
});

test('update_steps: ambient env fallback (CLAWDEVBOX_RECIPE_INSTANCE_ID)', () => {
  // The tool wrapper reads process.env, but the impl explicitly takes
  // recipe_instance_id, so we just verify the bare contract here — the
  // tool-level env fallback is covered indirectly by smoke tests.
  const db = open();
  const { instanceId } = seed(db);
  const res = updateStepsImpl(db, {
    recipe_instance_id: instanceId,
    add: [{ id: 's3', goal: 'g' }],
  });
  assert.equal(res.added.length, 1);
});


// ============================================================ update_status

import { updateStatusImpl } from '../src/recipe-step-tools.ts';

test('update_status: pending → running sets started_at and registers declared triggers', () => {
  const db = open();
  const { instanceId } = seed(db, {
    steps: [{ id: 's1', goal: 'a', triggers: [{ type: 'demo.poll', cron: false }] }],
  });
  const res = updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's1',
    status: 'running',
  });
  assert.equal(res.step.status, 'running');
  assert.ok(res.step.started_at);
  assert.equal(res.registered_trigger_ids.length, 1);
  const evs = db
    .prepare('SELECT * FROM step_events WHERE recipe_instance_id = ?')
    .all(instanceId);
  assert.ok(evs.some((e) => e.type === 'status_changed'));
  assert.ok(evs.some((e) => e.type === 'trigger_registered'));
});

test('update_status: running → done sets completed_at and disables auto triggers', () => {
  const db = open();
  const { instanceId } = seed(db, {
    steps: [{ id: 's1', goal: 'a', triggers: [{ type: 'demo.poll', cron: false }] }],
  });
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's1', status: 'running' });
  const res = updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's1',
    status: 'done',
    result: 'ok',
  });
  assert.equal(res.step.status, 'done');
  assert.ok(res.step.completed_at);
  assert.equal(res.disabled_trigger_ids.length, 1);
  const rsRow = getStepRow(db, instanceId, 's1');
  const trigs = db
    .prepare('SELECT * FROM triggers WHERE auto_registered_by_step_id = ?')
    .all(rsRow.id);
  assert.equal(trigs[0].enabled, 0);
});

test('update_status: running → pending is rejected with INVALID_STEP_TRANSITION', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's1', status: 'running' });
  assert.throws(
    () =>
      updateStatusImpl(db, {
        recipe_instance_id: instanceId,
        step_id: 's1',
        status: 'pending',
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'INVALID_STEP_TRANSITION',
  );
});

test('update_status: request_user_input → awaiting_user + inbox row', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's1', status: 'running' });
  const res = updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's1',
    request_user_input: {
      message: 'Pick one',
      options: ['a', 'b'],
      inbox_item: { title: 'Choose', labels: ['needs-input'] },
    },
  });
  assert.equal(res.step.status, 'awaiting_user');
  assert.ok(res.created_inbox_item_id);
  const inbox = db
    .prepare('SELECT * FROM inbox_items WHERE id = ?')
    .get(res.created_inbox_item_id);
  assert.equal(inbox.recipe_instance_id, instanceId);
  assert.equal(inbox.recipe_step_id, res.step.id);
  assert.equal(inbox.title, 'Choose');
  assert.deepEqual(JSON.parse(inbox.labels_json), ['needs-input']);
});

test('update_status: attach_artifact_ids updates the artifact row', () => {
  const db = open();
  const { instanceId, ws } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  db.prepare(
    `INSERT INTO artifacts (id, workspace_id, type, dir_path, metadata_json, created_at, updated_at)
     VALUES ('art1', ?, 'document', 'C:/x', '{}', ?, ?)`,
  ).run(ws.id, Date.now(), Date.now());
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's1', status: 'running' });
  const res = updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's1',
    attach_artifact_ids: ['art1'],
  });
  assert.deepEqual(res.attached_artifact_ids, ['art1']);
  const art = db.prepare('SELECT recipe_step_id FROM artifacts WHERE id = ?').get('art1');
  assert.equal(art.recipe_step_id, res.step.id);
});

test('update_status: all-siblings-terminal cascades recipe_instance to success', () => {
  const db = open();
  const { instanceId } = seed(db, {
    steps: [
      { id: 's1', goal: 'a' },
      { id: 's2', goal: 'b' },
    ],
  });
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's1', status: 'running' });
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's1', status: 'done' });
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's2', status: 'running' });
  const res = updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's2',
    status: 'done',
  });
  assert.equal(res.recipe_instance_status, 'success');
  const row = db
    .prepare('SELECT status, completed_at FROM recipe_instances WHERE id = ?')
    .get(instanceId);
  assert.equal(row.status, 'success');
  assert.ok(row.completed_at);
});

test('update_status: any-failed-sibling cascades to failure', () => {
  const db = open();
  const { instanceId } = seed(db, {
    steps: [
      { id: 's1', goal: 'a' },
      { id: 's2', goal: 'b' },
    ],
  });
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's1', status: 'running' });
  updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's1',
    status: 'failed',
    error: 'boom',
  });
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's2', status: 'running' });
  const res = updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's2',
    status: 'done',
  });
  assert.equal(res.recipe_instance_status, 'failure');
});

test('update_status: state and state_replace cannot be combined', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  assert.throws(
    () =>
      updateStatusImpl(db, {
        recipe_instance_id: instanceId,
        step_id: 's1',
        state: { x: 1 },
        state_replace: { y: 2 },
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'MUTUALLY_EXCLUSIVE_STATE_FIELDS',
  );
});

test('update_status: state merges; state_replace overwrites', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's1',
    state: { a: 1, b: 2 },
  });
  let row = getStepRow(db, instanceId, 's1');
  assert.deepEqual(JSON.parse(row.state_json), { a: 1, b: 2 });

  updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's1',
    state: { b: 99, c: 3 },
  });
  row = getStepRow(db, instanceId, 's1');
  assert.deepEqual(JSON.parse(row.state_json), { a: 1, b: 99, c: 3 });

  updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 's1',
    state_replace: { only: 'this' },
  });
  row = getStepRow(db, instanceId, 's1');
  assert.deepEqual(JSON.parse(row.state_json), { only: 'this' });
});

test('update_status: unknown step → STEP_NOT_FOUND', () => {
  const db = open();
  const { instanceId } = seed(db);
  assert.throws(
    () =>
      updateStatusImpl(db, {
        recipe_instance_id: instanceId,
        step_id: 'ghost',
        status: 'running',
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'STEP_NOT_FOUND',
  );
});

test('update_status: unknown artifact → ARTIFACT_NOT_FOUND', () => {
  const db = open();
  const { instanceId } = seed(db, { steps: [{ id: 's1', goal: 'a' }] });
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 's1', status: 'running' });
  assert.throws(
    () =>
      updateStatusImpl(db, {
        recipe_instance_id: instanceId,
        step_id: 's1',
        attach_artifact_ids: ['ghost'],
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'ARTIFACT_NOT_FOUND',
  );
});
