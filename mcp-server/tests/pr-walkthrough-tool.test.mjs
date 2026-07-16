/**
 * pr-walkthrough-tool.test.mjs — unit tests for the pr-walkthrough.answer
 * MCP tool's pure handler.
 *
 * handleAnswer resolves the artifact via findArtifact() which honours
 * CLAWDEVBOX_PROJECT_DIR — so each test points the env at a fresh tmp
 * dir, drops a manifest under `<tmp>/artifacts/<id>/`, and verifies
 * the tool persists the answer through qa-store.appendAnswer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendQuestion, readThread } from '../src/qa-store.ts';
import { handleAnswer } from '../src/tools/pr-walkthrough.ts';

/**
 * Build a fresh project dir + artifact folder + manifest, point
 * CLAWDEVBOX_PROJECT_DIR at it, and return the artifact dir so the
 * test can seed questions via qa-store directly.
 *
 * Also points CLAWDEVBOX_WORKSPACES_ROOT at an empty dir to keep the
 * cross-workspace lookup fast and isolated from the user's real registry.
 */
function setupArtifact(artifactId) {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-wt-tool-'));
  const projectDir = join(tmp, 'project');
  const artifactDir = join(projectDir, 'artifacts', artifactId);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'manifest.json'),
    JSON.stringify(
      {
        id: artifactId,
        type: 'pr-walkthrough',
        title: 'Test',
        workspace_id: 'project',
        created_at: Date.now(),
      },
      null,
      2,
    ),
  );
  process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
  process.env.CLAWDEVBOX_WORKSPACES_ROOT = join(tmp, 'workspaces-empty');
  mkdirSync(process.env.CLAWDEVBOX_WORKSPACES_ROOT, { recursive: true });
  return { tmp, artifactDir };
}

test('handleAnswer attaches answer to existing question', async () => {
  const artifactId = `pr-walkthrough-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { tmp, artifactDir } = setupArtifact(artifactId);
  try {
    const q = await appendQuestion({ artifactDir, stepN: 1, text: 'why?' });
    const result = await handleAnswer({
      artifact_id: artifactId,
      step_n: 1,
      question_id: q.id,
      text: 'because',
    });
    assert.deepEqual(result, { ok: true });
    const thread = await readThread({ artifactDir, stepN: 1 });
    assert.equal(thread.length, 1);
    assert.equal(thread[0].id, q.id);
    assert.equal(thread[0].a, 'because');
    assert.equal(typeof thread[0].ts, 'string');
    assert.doesNotThrow(() => new Date(thread[0].ts).toISOString());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('handleAnswer throws on missing artifact', async () => {
  const { tmp } = setupArtifact(`pr-walkthrough-real-${Date.now()}`);
  try {
    await assert.rejects(
      () =>
        handleAnswer({
          artifact_id: 'pr-walkthrough-does-not-exist',
          step_n: 1,
          question_id: 'q_x',
          text: 'a',
        }),
      /no such artifact/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('handleAnswer throws on missing question id', async () => {
  const artifactId = `pr-walkthrough-test-missing-q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { tmp, artifactDir } = setupArtifact(artifactId);
  try {
    // Seed at least one question so the qa/step-1.json file exists; the
    // tool should still reject an answer to a different question id.
    await appendQuestion({ artifactDir, stepN: 1, text: 'real question' });
    await assert.rejects(
      () =>
        handleAnswer({
          artifact_id: artifactId,
          step_n: 1,
          question_id: 'q_doesnt_exist',
          text: 'a',
        }),
      /question not found/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
