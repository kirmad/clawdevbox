import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitInline, getCurrentSha, hasUnstagedChanges } from '../src/tools/memory-git.ts';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  return dir;
}

test('commitInline stages and commits the given paths', () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'a.md'), 'hello');
    commitInline(dir, ['sub/a.md'], 'memory: hello');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
    assert.match(log, /memory: hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitInline pre-commits external changes before its own commit', () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, 'README.md'), '# Edited externally\n');
    writeFileSync(join(dir, 'new.md'), 'tool wrote this');
    commitInline(dir, ['new.md'], 'memory: new');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
    const lines = log.trim().split('\n');
    assert.equal(lines.length, 3, `expected 3 commits, got log:\n${log}`);
    assert.match(lines[0], /memory: new/);
    assert.match(lines[1], /external edits detected/);
    assert.match(lines[2], /initial/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitInline with multiple paths in one commit', () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, 'a'), { recursive: true });
    mkdirSync(join(dir, 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'x.md'), 'a');
    writeFileSync(join(dir, 'b', 'y.md'), 'b');
    commitInline(dir, ['a/x.md', 'b/y.md'], 'memory: pair');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
    const lines = log.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /memory: pair/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasUnstagedChanges reports correctly', () => {
  const dir = initRepo();
  try {
    assert.equal(hasUnstagedChanges(dir), false);
    writeFileSync(join(dir, 'README.md'), '# changed');
    assert.equal(hasUnstagedChanges(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getCurrentSha returns 40-char sha', () => {
  const dir = initRepo();
  try {
    const sha = getCurrentSha(dir);
    assert.match(sha, /^[a-f0-9]{40}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
