import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrontmatter, parseFrontmatter, splitFrontmatterAndBody,
} from '../src/tools/memory-frontmatter.ts';

test('buildFrontmatter emits required common fields', () => {
  const yaml = buildFrontmatter({
    id: 'abc-123',
    title: 'JWT pitfall',
    created: '2026-06-07T07:30:00Z',
    created_by: 'jane@team.com',
    scope: 'team',
    vault_id: 'engineering',
    project: 'clawdevbox',
    type: 'fact',
    tags: ['auth', 'jwt'],
  });
  assert.ok(yaml.startsWith('---\n'));
  assert.ok(yaml.endsWith('---\n'));
  assert.match(yaml, /id: abc-123/);
  assert.match(yaml, /scope: team/);
  assert.match(yaml, /vault_id: engineering/);
  assert.match(yaml, /tags:[\s\S]*- auth[\s\S]*- jwt/);
  assert.match(yaml, /schema: 1/);
});

test('buildFrontmatter for fact adds category/citations/reason', () => {
  const yaml = buildFrontmatter({
    id: 'a', title: 't', created: '2026-06-07T00:00:00Z', created_by: 'x@y',
    scope: 'personal', vault_id: 'v', project: 'p', type: 'fact',
    tags: [],
    category: 'bug',
    citations: 'file.ts:42',
    reason: 'because reasons',
  });
  assert.match(yaml, /category: bug/);
  assert.match(yaml, /citations:/);
  assert.match(yaml, /reason: because reasons/);
});

test('buildFrontmatter for lesson adds context/initial_confidence', () => {
  const yaml = buildFrontmatter({
    id: 'a', title: 't', created: '2026-06-07T00:00:00Z', created_by: 'x@y',
    scope: 'personal', vault_id: 'v', project: 'p', type: 'lesson',
    tags: [],
    context: 'during debugging',
    initial_confidence: 0.7,
  });
  assert.match(yaml, /context: during debugging/);
  assert.match(yaml, /initial_confidence: 0\.7/);
});

test('buildFrontmatter for session adds session_id/decisions/files', () => {
  const yaml = buildFrontmatter({
    id: 'a', title: 't', created: '2026-06-07T00:00:00Z', created_by: 'x@y',
    scope: 'personal', vault_id: 'v', project: 'p', type: 'session',
    tags: [],
    session_id: 'sess-uuid',
    decisions: ['decision A', 'decision B'],
    files: ['src/a.ts'],
  });
  assert.match(yaml, /session_id: sess-uuid/);
  assert.match(yaml, /decisions:[\s\S]*- decision A/);
  assert.match(yaml, /files:[\s\S]*- src\/a\.ts/);
});

test('buildFrontmatter for wiki — no type-specific extra fields', () => {
  const yaml = buildFrontmatter({
    id: 'a', title: 't', created: '2026-06-07T00:00:00Z', created_by: 'x@y',
    scope: 'team', vault_id: 'v', project: 'p', type: 'wiki',
    tags: ['keyword1'],
  });
  assert.match(yaml, /type: wiki/);
  assert.doesNotMatch(yaml, /session_id|category|context|initial_confidence/);
});

test('parseFrontmatter round-trips', () => {
  const yaml = buildFrontmatter({
    id: 'abc', title: 'Hello', created: '2026-06-07T07:30:00Z', created_by: 'x@y',
    scope: 'team', vault_id: 'eng', project: 'clawdevbox', type: 'fact',
    tags: ['a', 'b'],
  });
  const parsed = parseFrontmatter(yaml);
  assert.equal(parsed.id, 'abc');
  assert.equal(parsed.title, 'Hello');
  assert.equal(parsed.scope, 'team');
  assert.deepEqual(parsed.tags, ['a', 'b']);
});

test('splitFrontmatterAndBody separates correctly', () => {
  const fm = buildFrontmatter({
    id: 'x', title: 'T', created: '2026-06-07T00:00:00Z', created_by: 'a@b',
    scope: 'personal', vault_id: 'v', project: 'p', type: 'fact', tags: [],
  });
  const full = fm + '\n# Body\n\nContent here.\n';
  const { frontmatter, body } = splitFrontmatterAndBody(full);
  assert.equal(frontmatter.id, 'x');
  assert.equal(body, '# Body\n\nContent here.\n');
});

test('splitFrontmatterAndBody throws when no frontmatter', () => {
  assert.throws(
    () => splitFrontmatterAndBody('# Just a body\n'),
    /must start with --- frontmatter/i,
  );
});

test('splitFrontmatterAndBody throws when frontmatter not closed', () => {
  assert.throws(
    () => splitFrontmatterAndBody('---\nid: x\ntitle: T\n\n# Body without closing'),
    /not terminated/i,
  );
});
