/**
 * main-agent-session-id.test.mjs
 *
 * Verifies the sticky main-agent session id persistence:
 *   - First load mints a fresh UUID, persists it, returns isNew=true.
 *   - Second load reads the same UUID back, returns isNew=false.
 *   - reset() forgets the id so the next load mints again (new UUID).
 *   - Garbage on disk is replaced (defense against manual edits).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadOrCreateMainAgentSessionId,
  resetMainAgentSessionId,
} from '../src/main-agent-session-id.ts';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeTmpProject() {
  const root = mkdtempSync(join(tmpdir(), 'clawdevbox-sticky-session-'));
  const projectDir = join(root, 'project');
  mkdirSync(projectDir, { recursive: true });
  return {
    projectDir,
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

test('loadOrCreate mints + persists on first call', () => {
  const { projectDir, cleanup } = makeTmpProject();
  try {
    const file = join(projectDir, '.clawdevbox', 'main-agent-session-id');
    assert.equal(existsSync(file), false, 'file should not exist before first load');
    const r = loadOrCreateMainAgentSessionId(projectDir);
    assert.equal(r.isNew, true);
    assert.match(r.id, UUID_REGEX);
    assert.equal(existsSync(file), true);
    assert.equal(readFileSync(file, 'utf8').trim(), r.id);
  } finally { cleanup(); }
});

test('loadOrCreate returns the same id on subsequent calls', () => {
  const { projectDir, cleanup } = makeTmpProject();
  try {
    const first = loadOrCreateMainAgentSessionId(projectDir);
    const second = loadOrCreateMainAgentSessionId(projectDir);
    const third = loadOrCreateMainAgentSessionId(projectDir);
    assert.equal(second.isNew, false);
    assert.equal(third.isNew, false);
    assert.equal(second.id, first.id);
    assert.equal(third.id, first.id);
  } finally { cleanup(); }
});

test('reset forgets the id; next load mints a different one', () => {
  const { projectDir, cleanup } = makeTmpProject();
  try {
    const first = loadOrCreateMainAgentSessionId(projectDir);
    resetMainAgentSessionId(projectDir);
    const second = loadOrCreateMainAgentSessionId(projectDir);
    assert.equal(second.isNew, true);
    assert.notEqual(second.id, first.id);
  } finally { cleanup(); }
});

test('garbage on disk is replaced with a fresh UUID', () => {
  const { projectDir, cleanup } = makeTmpProject();
  try {
    const file = join(projectDir, '.clawdevbox', 'main-agent-session-id');
    mkdirSync(join(projectDir, '.clawdevbox'), { recursive: true });
    writeFileSync(file, 'not-a-uuid\n', 'utf8');
    const r = loadOrCreateMainAgentSessionId(projectDir);
    assert.equal(r.isNew, true, 'garbage should count as "new" so callers init kind=new');
    assert.match(r.id, UUID_REGEX);
    assert.equal(readFileSync(file, 'utf8').trim(), r.id);
  } finally { cleanup(); }
});

test('reset is a no-op when no file exists', () => {
  const { projectDir, cleanup } = makeTmpProject();
  try {
    // Should not throw.
    resetMainAgentSessionId(projectDir);
    const r = loadOrCreateMainAgentSessionId(projectDir);
    assert.equal(r.isNew, true);
  } finally { cleanup(); }
});
