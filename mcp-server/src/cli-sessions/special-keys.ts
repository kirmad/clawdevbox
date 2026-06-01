// mcp-server/src/cli-sessions/special-keys.ts
import type { SpecialKey } from './types.ts';

/**
 * Translation table: our `SpecialKey` vocabulary → tmux send-keys key names.
 * Tmux uses 'BSpace' for backspace (not 'Backspace'); other names match.
 * Verified against tmux 3.3.2 (`man tmux` → KEY BINDINGS section).
 */
const TABLE: Record<SpecialKey, string> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'BSpace',
  'C-q': 'C-q',
  'C-c': 'C-c',
  'C-d': 'C-d',
  'C-u': 'C-u',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
};

export function isSpecialKey(s: string): s is SpecialKey {
  return Object.prototype.hasOwnProperty.call(TABLE, s);
}

export function specialKeyToTmux(key: SpecialKey): string {
  const v = TABLE[key];
  if (!v) throw new Error(`unknown SpecialKey: ${key}`);
  return v;
}
