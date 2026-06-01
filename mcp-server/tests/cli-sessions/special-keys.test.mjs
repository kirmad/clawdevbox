// mcp-server/tests/cli-sessions/special-keys.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { specialKeyToTmux, isSpecialKey } from '../../src/cli-sessions/special-keys.ts';

test('specialKeyToTmux maps every documented SpecialKey to a tmux key-name', () => {
  assert.equal(specialKeyToTmux('Enter'), 'Enter');
  assert.equal(specialKeyToTmux('Escape'), 'Escape');
  assert.equal(specialKeyToTmux('Tab'), 'Tab');
  assert.equal(specialKeyToTmux('Backspace'), 'BSpace');
  assert.equal(specialKeyToTmux('C-q'), 'C-q');
  assert.equal(specialKeyToTmux('C-c'), 'C-c');
  assert.equal(specialKeyToTmux('C-d'), 'C-d');
  assert.equal(specialKeyToTmux('C-u'), 'C-u');
  assert.equal(specialKeyToTmux('Up'), 'Up');
  assert.equal(specialKeyToTmux('Down'), 'Down');
  assert.equal(specialKeyToTmux('Left'), 'Left');
  assert.equal(specialKeyToTmux('Right'), 'Right');
});

test('isSpecialKey discriminates valid keys', () => {
  assert.equal(isSpecialKey('Enter'), true);
  assert.equal(isSpecialKey('hello'), false);
  assert.equal(isSpecialKey('enter'), false);
  assert.equal(isSpecialKey(''), false);
});

test('specialKeyToTmux throws on unknown key', () => {
  assert.throws(() => specialKeyToTmux('Bogus'), /unknown SpecialKey/);
});
