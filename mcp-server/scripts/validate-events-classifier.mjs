/**
 * validate-events-classifier.mjs — replay a real Copilot events.jsonl file
 * through our classifier and surface anything we don't recognize.
 *
 * Usage: node validate-events-classifier.mjs <path-to-events.jsonl>
 *        (defaults to the largest events.jsonl under ~/.copilot/session-state)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Mirror the constants from src/agent-clis/copilot-events.ts
const BUSY_EVENTS = new Set([
  'user.message', 'assistant.turn_start', 'assistant.message',
  'tool.execution_start', 'subagent.started',
  'skill.invoked', 'session.compaction_start',
]);
const IDLE_EVENTS = new Set(['assistant.turn_end', 'session.task_complete']);
const TERMINAL_EVENTS = new Set(['session.shutdown', 'session.error', 'abort']);
const NEUTRAL_EVENTS = new Set([
  'session.context_changed', 'hook.start', 'hook.end',
  'tool.execution_complete', 'subagent.completed', 'subagent.failed',
  'session.start', 'session.resume',
  'system.message', 'system.notification',
  'session.workspace_file_changed', 'session.plan_changed',
  'session.info', 'session.warning',
  'session.compaction_complete', 'session.truncation',
  'session.mode_changed',
]);

function classifyEvent(type) {
  if (TERMINAL_EVENTS.has(type)) return 'terminal';
  if (BUSY_EVENTS.has(type)) return 'busy';
  if (IDLE_EVENTS.has(type)) return 'idle';
  if (NEUTRAL_EVENTS.has(type)) return 'neutral';
  return 'unknown';
}

function findLargestEventsFile() {
  const dir = join(homedir(), '.copilot', 'session-state');
  if (!existsSync(dir)) return null;
  let best = null;
  for (const sess of readdirSync(dir)) {
    const p = join(dir, sess, 'events.jsonl');
    if (!existsSync(p)) continue;
    const sz = statSync(p).size;
    if (!best || sz > best.size) best = { path: p, size: sz, sess };
  }
  return best;
}

const path = process.argv[2] ?? findLargestEventsFile()?.path;
if (!path) { console.error('No events.jsonl found'); process.exit(1); }
console.log(`replaying: ${path}`);
console.log(`size: ${(statSync(path).size / 1024).toFixed(1)} KB`);

const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
console.log(`lines: ${lines.length}`);

const typeCount = new Map();
const transitions = [];  // [{type, classification, idleStateBefore, idleStateAfter}]
let idleState = 'unknown';  // unknown | idle | busy | terminal
let lastIdleStateChangeAt = null;
let stillBusy = 0, stillIdle = 0;

for (let i = 0; i < lines.length; i++) {
  let evt;
  try { evt = JSON.parse(lines[i]); } catch { continue; }
  const type = evt?.type;
  if (typeof type !== 'string') continue;
  typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
  const cls = classifyEvent(type);
  const before = idleState;
  if (cls === 'idle') idleState = 'idle';
  else if (cls === 'busy') idleState = 'busy';
  else if (cls === 'terminal') idleState = 'terminal';
  // 'neutral' and 'unknown' leave state unchanged
  if (idleState !== before) {
    transitions.push({ idx: i, type, cls, before, after: idleState, ts: evt.timestamp });
    lastIdleStateChangeAt = evt.timestamp;
  } else if (cls === 'busy' && idleState === 'busy') stillBusy++;
  else if (cls === 'idle' && idleState === 'idle') stillIdle++;
}

console.log('');
console.log('=== Event type frequency ===');
const sorted = [...typeCount.entries()].sort((a, b) => b[1] - a[1]);
for (const [type, count] of sorted) {
  const cls = classifyEvent(type);
  const marker = cls === 'unknown' ? ' ⚠️ UNKNOWN' : '';
  console.log(`  ${String(count).padStart(6)}  ${type.padEnd(35)} ${cls}${marker}`);
}

console.log('');
console.log(`=== State transitions: ${transitions.length} ===`);
console.log(`(stillBusy: ${stillBusy} same-state stays, stillIdle: ${stillIdle})`);
console.log('');
console.log('first 5 transitions:');
for (const t of transitions.slice(0, 5)) console.log(`  [${t.idx}] ${t.before} -> ${t.after}  via ${t.type}  ${t.ts}`);
console.log('last 5 transitions:');
for (const t of transitions.slice(-5)) console.log(`  [${t.idx}] ${t.before} -> ${t.after}  via ${t.type}  ${t.ts}`);

console.log('');
const final = transitions[transitions.length - 1];
console.log(`=== Final state: ${idleState} (last change: ${final?.ts ?? 'n/a'} via ${final?.type ?? 'n/a'}) ===`);

// Sanity check: count idle/busy events, ensure no malformed patterns
const unknownTypes = sorted.filter(([t]) => classifyEvent(t) === 'unknown');
if (unknownTypes.length > 0) {
  console.log('');
  console.log('⚠️ Unknown event types — review whether to add to BUSY/IDLE/NEUTRAL/TERMINAL:');
  for (const [type, count] of unknownTypes) console.log(`  ${type}  ×${count}`);
}
