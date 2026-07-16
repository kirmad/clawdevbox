/**
 * tools/memory-events.ts
 *
 * Append events to .events sidecar JSONL files, read them back, fold
 * them into a structured FoldedState (votes, confidence, edit history),
 * and compute decay-adjusted confidence at read time.
 *
 * Events are append-only — git auto-merges line-disjoint concurrent
 * appends without conflict, so no mutex is needed for the file itself
 * (per-vault mutex still applies for the surrounding git operations).
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BaseEvent {
  ts: string;          // ISO 8601
  actor: string;
  type: string;
}

export interface CreatedEvent extends BaseEvent {
  type: 'created';
  initial_confidence?: number;  // lesson only
}

export interface VotedEvent extends BaseEvent {
  type: 'voted';
  direction: 'up' | 'down';
  reason?: string;
}

export interface ReinforcedEvent extends BaseEvent {
  type: 'reinforced';
  source_content: string;
  confidence_delta?: number;
}

export interface EditedEvent extends BaseEvent {
  type: 'edited';
  operation: string;
  section?: string;
  lines_changed: number;
}

export type AnyEvent =
  | CreatedEvent
  | VotedEvent
  | ReinforcedEvent
  | EditedEvent
  | (BaseEvent & Record<string, unknown>);

export function appendEvent(eventsPath: string, event: AnyEvent): void {
  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');
}

export function readEvents(eventsPath: string): AnyEvent[] {
  if (!existsSync(eventsPath)) return [];
  const raw = readFileSync(eventsPath, 'utf8');
  const out: AnyEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AnyEvent);
    } catch {
      // skip malformed line; do not fail the read
    }
  }
  return out;
}

export interface FoldedState {
  created: { at: string; by: string };
  votes: { up: number; down: number };
  voters: Record<string, 'up' | 'down'>;
  // lesson-only
  confidence_stored?: number;
  last_reinforced?: string;
  reinforcement_count?: number;
  // wiki-only
  edit_count?: number;
  last_edited?: { at: string; by: string };
}

export interface FoldOptions {
  isLesson?: boolean;
  isWiki?: boolean;
}

export function foldEvents(events: AnyEvent[], opts: FoldOptions = {}): FoldedState {
  let created: { at: string; by: string } | null = null;
  const voters: Record<string, 'up' | 'down'> = {};
  let confidenceDeltaSum = 0;
  let initialConfidence = 0.5;
  let reinforcementCount = 0;
  let lastReinforced: string | undefined;
  let editCount = 0;
  let lastEdited: { at: string; by: string } | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case 'created':
        created = { at: ev.ts, by: ev.actor };
        if (opts.isLesson && typeof (ev as CreatedEvent).initial_confidence === 'number') {
          initialConfidence = (ev as CreatedEvent).initial_confidence as number;
        }
        lastReinforced = ev.ts;
        break;
      case 'voted':
        voters[ev.actor] = (ev as VotedEvent).direction;
        break;
      case 'reinforced':
        reinforcementCount++;
        lastReinforced = ev.ts;
        confidenceDeltaSum += (ev as ReinforcedEvent).confidence_delta ?? 0.1;
        break;
      case 'edited':
        editCount++;
        lastEdited = { at: ev.ts, by: ev.actor };
        break;
    }
  }

  let votesUp = 0;
  let votesDown = 0;
  for (const dir of Object.values(voters)) {
    if (dir === 'up') votesUp++;
    else votesDown++;
  }

  const result: FoldedState = {
    created: created ?? { at: '', by: '' },
    votes: { up: votesUp, down: votesDown },
    voters,
  };

  if (opts.isLesson) {
    const fromVotes = 0.05 * (votesUp - votesDown);
    const stored = clamp01(initialConfidence + confidenceDeltaSum + fromVotes);
    result.confidence_stored = stored;
    result.last_reinforced = lastReinforced;
    result.reinforcement_count = reinforcementCount;
  }
  if (opts.isWiki) {
    result.edit_count = editCount;
    if (lastEdited) result.last_edited = lastEdited;
  }
  return result;
}

export interface DecayInput {
  confidence_stored: number;
  last_reinforced_at: number;  // ms epoch
  now: number;                 // ms epoch
  floor: number;
  half_life_days: number;
}

export function decayConfidence({
  confidence_stored,
  last_reinforced_at,
  now,
  floor,
  half_life_days,
}: DecayInput): number {
  const days = Math.max(0, (now - last_reinforced_at) / 86400_000);
  const decayed = floor + (confidence_stored - floor) * Math.pow(0.5, days / half_life_days);
  return clamp01(decayed);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
