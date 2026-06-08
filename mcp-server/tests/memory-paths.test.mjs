import test from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, buildFilename, resolveVault, vaultPathFor, eventsPathFor, withCollisionSuffix,
} from '../src/tools/memory-paths.ts';

test('slugify lowercases, strips non-alphanumeric, caps at 60 chars', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Multiple   Spaces  '), 'multiple-spaces');
  assert.equal(slugify('UPPER123 mixed'), 'upper123-mixed');
  assert.equal(slugify('a'.repeat(100)).length, 60);
  assert.equal(slugify('---weird---chars!!!'), 'weird-chars');
});

test('slugify returns empty string when nothing slugifiable', () => {
  assert.equal(slugify('---'), '');
  assert.equal(slugify('!!!'), '');
});

test('buildFilename uses date prefix for memory/lesson, datetime for session', () => {
  const created = new Date('2026-06-07T10:38:15Z');
  assert.equal(buildFilename('memory', 'JWT validation', created), '2026-06-07-jwt-validation.md');
  assert.equal(buildFilename('lesson', 'Prefer events', created), '2026-06-07-prefer-events.md');
  assert.equal(buildFilename('session', 'Design memory', created), '2026-06-07T10-38-design-memory.md');
});

test('buildFilename falls back to "untitled" when slug empty', () => {
  const created = new Date('2026-06-07T10:38:15Z');
  assert.equal(buildFilename('memory', '!!!', created), '2026-06-07-untitled.md');
});

test('buildFilename wiki strips .md and slugifies each segment', () => {
  const created = new Date();
  assert.equal(buildFilename('wiki', 'architecture/data-flow', created), 'architecture/data-flow.md');
  assert.equal(buildFilename('wiki', 'architecture/Data Flow.md', created), 'architecture/data-flow.md');
  assert.equal(buildFilename('wiki', 'Top Level Page', created), 'top-level-page.md');
});

test('resolveVault picks first matching kind when vault_id omitted', () => {
  const chain = [
    { id: 'my-notes', path: '/p/personal', kind: 'personal', remote: null },
    { id: 'team-eng', path: '/p/team',     kind: 'team',     remote: 'git@x:t.git' },
  ];
  assert.equal(resolveVault(chain, 'personal').id, 'my-notes');
  assert.equal(resolveVault(chain, 'team').id, 'team-eng');
});

test('resolveVault uses vault_id when provided', () => {
  const chain = [
    { id: 'a', path: '/a', kind: 'personal', remote: null },
    { id: 'b', path: '/b', kind: 'personal', remote: null },
  ];
  assert.equal(resolveVault(chain, 'personal', 'b').id, 'b');
});

test('resolveVault throws when no vault matches', () => {
  const chain = [{ id: 'a', path: '/a', kind: 'personal', remote: null }];
  assert.throws(() => resolveVault(chain, 'team'), /no vault registered with kind=team/i);
  assert.throws(() => resolveVault(chain, 'personal', 'nonexistent'), /vault_id "nonexistent" not found/i);
});

test('vaultPathFor builds the correct file path under the memories/ subroot', () => {
  const vault = { id: 'x', path: '/v', kind: 'personal', remote: null };
  assert.equal(
    vaultPathFor(vault, 'clawdevbox', 'memory', '2026-06-07-jwt.md').replace(/\\/g, '/'),
    '/v/memories/clawdevbox/memories/2026-06-07-jwt.md',
  );
});

test('vaultPathFor rejects project path traversal', () => {
  const vault = { id: 'x', path: '/v', kind: 'personal', remote: null };
  assert.throws(() => vaultPathFor(vault, '..', 'memory', 'a.md'), /illegal characters/i);
  assert.throws(() => vaultPathFor(vault, 'a/b', 'memory', 'a.md'), /illegal characters/i);
});

test('eventsPathFor maps to sibling .events folder for flat types', () => {
  const vault = { id: 'x', path: '/v', kind: 'personal', remote: null };
  assert.equal(
    eventsPathFor(vault, 'clawdevbox', 'memory', '2026-06-07-jwt.md').replace(/\\/g, '/'),
    '/v/memories/clawdevbox/memories/.events/2026-06-07-jwt.jsonl',
  );
});

test('eventsPathFor handles nested wiki paths', () => {
  const vault = { id: 'x', path: '/v', kind: 'personal', remote: null };
  assert.equal(
    eventsPathFor(vault, 'clawdevbox', 'wiki', 'architecture/data-flow.md').replace(/\\/g, '/'),
    '/v/memories/clawdevbox/wiki/.events/architecture/data-flow.jsonl',
  );
});

test('withCollisionSuffix appends -2, -3 to filename stem', () => {
  assert.equal(withCollisionSuffix('a.md', 0), 'a.md');
  assert.equal(withCollisionSuffix('a.md', 1), 'a-2.md');
  assert.equal(withCollisionSuffix('a.md', 2), 'a-3.md');
});
