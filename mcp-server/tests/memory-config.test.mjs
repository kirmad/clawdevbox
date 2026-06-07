import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMemoryConfig, resolveIdentity, DEFAULT_MEMORY_CONFIG } from '../src/tools/memory-config.ts';

test('loadMemoryConfig returns defaults when file missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-cfg-'));
  try {
    const cfg = loadMemoryConfig(join(dir, 'memory-config.json'));
    assert.deepEqual(cfg.decay, DEFAULT_MEMORY_CONFIG.decay);
    assert.equal(cfg.duplicate_threshold, 0.85);
    assert.equal(cfg.qmd_search_mode, 'lex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMemoryConfig merges user values over defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-cfg-'));
  try {
    const cfgPath = join(dir, 'memory-config.json');
    writeFileSync(cfgPath, JSON.stringify({
      decay: { floor: 0.3, half_life_days: 60 },
      qmd_search_mode: 'hybrid',
    }));
    const cfg = loadMemoryConfig(cfgPath);
    assert.equal(cfg.decay.floor, 0.3);
    assert.equal(cfg.decay.half_life_days, 60);
    assert.equal(cfg.qmd_search_mode, 'hybrid');
    assert.equal(cfg.duplicate_threshold, 0.85, 'unspecified field keeps default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMemoryConfig throws on malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-cfg-'));
  try {
    const cfgPath = join(dir, 'memory-config.json');
    writeFileSync(cfgPath, 'this is not json {');
    assert.throws(() => loadMemoryConfig(cfgPath), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveIdentity falls back to os.userInfo when git config empty', async () => {
  const identity = await resolveIdentity({
    gitConfigEmail: async () => '',
    gitConfigName: async () => '',
    osUsername: () => 'fallback-user',
  });
  assert.equal(identity.email, 'fallback-user@local');
  assert.equal(identity.name, 'fallback-user');
  assert.equal(identity.source, 'os');
});

test('resolveIdentity uses git config when available', async () => {
  const identity = await resolveIdentity({
    gitConfigEmail: async () => 'jane@team.com',
    gitConfigName: async () => 'Jane Engineer',
    osUsername: () => 'fallback-user',
  });
  assert.equal(identity.email, 'jane@team.com');
  assert.equal(identity.name, 'Jane Engineer');
  assert.equal(identity.source, 'git');
});

test('resolveIdentity uses email as name when git name empty', async () => {
  const identity = await resolveIdentity({
    gitConfigEmail: async () => 'jane@team.com',
    gitConfigName: async () => '',
    osUsername: () => 'x',
  });
  assert.equal(identity.email, 'jane@team.com');
  assert.equal(identity.name, 'jane@team.com');
});
