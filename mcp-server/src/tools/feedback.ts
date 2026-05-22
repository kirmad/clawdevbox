/**
 * tools/feedback.ts
 *
 * skill.feedback.record  — log an implicit signal (used/skipped/corrected/error)
 * skill.feedback.aggregate — collapse local.jsonl → agg.json
 * skill.feedback.pending   — list pending corrections and promotion candidates
 *
 * Privacy contract (spec §3.1 of skill-feedback-loop-design.md):
 *   - session_hash = SHA-1(hostname + process.pid + UTC-date)[0:8]
 *   - No user identity, no message text, no prompt content stored.
 *   - local.jsonl is gitignored and never leaves the local clone.
 *   - agg.json contains only counts and scores — safe to share via PR.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { writeFileAtomic, ensureDirSync } from '../fs-util.ts';
import type { Workspace } from '../workspace.ts';

// -- Policy thresholds (kept here so code and docs/skills-promotion-policy.md
//    reference the same values) -----------------------------------------------
export const PROMOTION_SCORE_THRESHOLD = 0.75;
export const PROMOTION_USES_THRESHOLD = 10;
export const DEMOTION_SCORE_THRESHOLD = 0.30;
export const DEMOTION_ERROR_HARD_FLOOR = 3;
export const CORRECTION_MIN_SESSIONS = 2;
export const CORRECTION_MAX_BYTES = 8192;

// -- Internal types -----------------------------------------------------------

const SIGNALS = ['used', 'skipped', 'corrected', 'error'] as const;
type Signal = (typeof SIGNALS)[number];

interface RawSignal {
  skill_id: string;
  signal: Signal;
  day: string;          // YYYY-MM-DD UTC — not a full timestamp
  session_hash: string; // SHA-1(hostname+pid+day)[0:8] — not user-identifying
  correction?: string;  // unified diff, only when signal=corrected
}

interface SkillAgg {
  skill_id: string;
  uses_7d: number;
  uses_30d: number;
  skips_7d: number;
  skips_30d: number;
  corrections_30d: number;
  errors_30d: number;
  /** (uses − skips − 2×errors) / max(total, 1), bounded [−1, 1] */
  score_30d: number;
  last_correction_patch?: string;
}

// -- Helpers ------------------------------------------------------------------

function feedbackDir(ws: Workspace): string {
  return join(ws.projectDir, '.clawdevbox', 'feedback');
}

function sessionHash(): string {
  const raw = `${hostname()}:${process.pid}:${utcDay()}`;
  return createHash('sha1').update(raw).digest('hex').slice(0, 8);
}

function utcDay(daysAgo = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function readSignals(dir: string): RawSignal[] {
  const p = join(dir, 'local.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RawSignal];
      } catch {
        return [];
      }
    });
}

export function aggregate(signals: RawSignal[]): SkillAgg[] {
  const day7 = utcDay(7);
  const day30 = utcDay(30);

  // One effective vote per (skill_id, signal, session_hash, day)
  const seen = new Set<string>();
  const deduped = signals.filter((s) => {
    const key = `${s.skill_id}|${s.signal}|${s.session_hash}|${s.day}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const map = new Map<string, SkillAgg>();
  for (const s of deduped) {
    if (!map.has(s.skill_id)) {
      map.set(s.skill_id, {
        skill_id: s.skill_id,
        uses_7d: 0, uses_30d: 0,
        skips_7d: 0, skips_30d: 0,
        corrections_30d: 0, errors_30d: 0,
        score_30d: 0,
      });
    }
    const agg = map.get(s.skill_id)!;
    const in30 = s.day >= day30;
    const in7 = s.day >= day7;
    if (s.signal === 'used')      { if (in7) agg.uses_7d++;    if (in30) agg.uses_30d++; }
    if (s.signal === 'skipped')   { if (in7) agg.skips_7d++;   if (in30) agg.skips_30d++; }
    if (s.signal === 'error')     {                              if (in30) agg.errors_30d++; }
    if (s.signal === 'corrected' && in30) {
      agg.corrections_30d++;
      if (s.correction) agg.last_correction_patch = s.correction;
    }
  }

  for (const agg of map.values()) {
    const total = agg.uses_30d + agg.skips_30d + agg.errors_30d;
    const raw = (agg.uses_30d - agg.skips_30d - 2 * agg.errors_30d) / Math.max(total, 1);
    agg.score_30d = Math.round(Math.max(-1, Math.min(1, raw)) * 100) / 100;
  }

  return [...map.values()];
}

// -- Tool registration -------------------------------------------------------

export function registerFeedbackEntries(ws: Workspace): void {
  // -- skill.feedback.record -------------------------------------------------
  defineTool({
    name: 'skill.feedback.record',
    description:
      'Record an implicit feedback signal for a skill. ' +
      'Privacy-safe: no user identity or message content is stored. ' +
      'One effective vote per session per skill per day after deduplication.',
    parameters: z.object({
      skill_id: z.string().min(1).describe('Skill id as returned by skill.list'),
      signal: z
        .enum(SIGNALS)
        .describe(
          'used=applied and helpful, skipped=considered but not used, ' +
          'corrected=agent had to fix the skill output (include diff), ' +
          'error=skill caused a tool or parsing failure',
        ),
      correction: z
        .string()
        .optional()
        .describe(
          'Unified diff of the skill markdown when signal=corrected. ' +
          `Must start with --- or "diff ". Max ${CORRECTION_MAX_BYTES} bytes.`,
        ),
    }),
    handler: async (args) => {
      if (args.signal === 'corrected' && args.correction !== undefined) {
        const isValidDiff =
          args.correction.startsWith('---') || args.correction.startsWith('diff ');
        if (!isValidDiff) {
          return {
            content: [{ type: 'text', text: 'correction must be a unified diff starting with --- or "diff "' }],
            isError: true,
          };
        }
        if (Buffer.byteLength(args.correction, 'utf8') > CORRECTION_MAX_BYTES) {
          return {
            content: [{ type: 'text', text: `correction patch exceeds ${CORRECTION_MAX_BYTES} byte limit` }],
            isError: true,
          };
        }
      }

      const dir = feedbackDir(ws);
      ensureDirSync(dir);

      const entry: RawSignal = {
        skill_id: args.skill_id,
        signal: args.signal,
        day: utcDay(),
        session_hash: sessionHash(),
        ...(args.signal === 'corrected' && args.correction
          ? { correction: args.correction }
          : {}),
      };
      appendFileSync(join(dir, 'local.jsonl'), JSON.stringify(entry) + '\n', 'utf8');

      return {
        content: [
          { type: 'text', text: `Recorded ${args.signal} signal for skill ${args.skill_id}.` },
        ],
        structuredContent: {
          recorded: true,
          skill_id: args.skill_id,
          signal: args.signal,
          day: entry.day,
        },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- skill.feedback.aggregate ----------------------------------------------
  defineTool({
    name: 'skill.feedback.aggregate',
    description:
      'Aggregate local.jsonl → agg.json. Deduplicates votes and computes ' +
      'rolling 7d/30d counters and score_30d per skill. Safe to run multiple times.',
    parameters: z.object({}),
    handler: async () => {
      const dir = feedbackDir(ws);
      const signals = readSignals(dir);
      const skills = aggregate(signals);
      ensureDirSync(dir);
      writeFileAtomic(
        join(dir, 'agg.json'),
        JSON.stringify({ updated_at: new Date().toISOString(), skills }, null, 2) + '\n',
      );
      return {
        content: [
          {
            type: 'text',
            text: `Aggregated ${signals.length} raw signal(s) → ${skills.length} skill summary(ies).`,
          },
        ],
        structuredContent: { signal_count: signals.length, skill_count: skills.length, skills },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- skill.feedback.pending ------------------------------------------------
  defineTool({
    name: 'skill.feedback.pending',
    description:
      'List skills with pending corrections or promotion/demotion candidates. ' +
      'Run skill.feedback.aggregate first to refresh agg.json.',
    parameters: z.object({
      kind: z
        .enum(['corrections', 'promotions', 'demotions', 'all'])
        .optional()
        .default('all')
        .describe('Filter output to a specific category.'),
    }),
    handler: async (args) => {
      const aggPath = join(feedbackDir(ws), 'agg.json');
      if (!existsSync(aggPath)) {
        return {
          content: [
            { type: 'text', text: 'No agg.json found. Run skill.feedback.aggregate first.' },
          ],
        };
      }

      const { skills } = JSON.parse(readFileSync(aggPath, 'utf8')) as { skills: SkillAgg[] };
      const kind = args.kind ?? 'all';

      const corrections =
        kind !== 'promotions' && kind !== 'demotions'
          ? skills
              .filter((s) => s.corrections_30d >= CORRECTION_MIN_SESSIONS && s.last_correction_patch)
              .map((s) => ({ skill_id: s.skill_id, corrections_30d: s.corrections_30d, score_30d: s.score_30d }))
          : [];

      const promotions =
        kind !== 'corrections' && kind !== 'demotions'
          ? skills
              .filter((s) => s.score_30d > PROMOTION_SCORE_THRESHOLD && s.uses_30d >= PROMOTION_USES_THRESHOLD && s.errors_30d === 0)
              .map((s) => ({ skill_id: s.skill_id, score_30d: s.score_30d, uses_30d: s.uses_30d }))
          : [];

      const demotions =
        kind !== 'corrections' && kind !== 'promotions'
          ? skills
              .filter((s) => s.score_30d < DEMOTION_SCORE_THRESHOLD || s.errors_30d >= DEMOTION_ERROR_HARD_FLOOR)
              .map((s) => ({ skill_id: s.skill_id, score_30d: s.score_30d, errors_30d: s.errors_30d }))
          : [];

      const lines = [
        `${corrections.length} correction(s) ready`,
        `${promotions.length} promotion candidate(s)`,
        `${demotions.length} demotion candidate(s)`,
      ];

      return {
        content: [{ type: 'text', text: lines.join(', ') + '.' }],
        structuredContent: {
          ...(kind !== 'promotions' && kind !== 'demotions' ? { pending_corrections: corrections } : {}),
          ...(kind !== 'corrections' && kind !== 'demotions' ? { promotion_candidates: promotions } : {}),
          ...(kind !== 'corrections' && kind !== 'promotions' ? { demotion_candidates: demotions } : {}),
        },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
