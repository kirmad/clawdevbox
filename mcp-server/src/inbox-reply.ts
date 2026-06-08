/**
 * inbox-reply.ts
 *
 * Pure helpers for validating + compiling answers to inbox questions.
 * Supports both legacy single-question items AND multi-question items
 * (batch UX where the user fills out every question and submits once).
 *
 * The HTTP layer (`/api/inbox/<id>/reply`) calls `validateBatchAnswer`
 * then `compileBatchAnswer`, appends the reply via InboxStore, and
 * dispatches via `spawnDispatchOrResume`. The MCP `inbox.reply` tool
 * only appends and does NOT dispatch (agents are expected to handle
 * their own follow-ups).
 */

import type { InboxQuestion, InboxQuestionOption } from './store.ts';

export type InboxReplyValidationError =
  | { code: 'NO_QUESTION'; message: string }
  | { code: 'QUESTION_CLOSED'; message: string }
  | { code: 'UNKNOWN_OPTION'; message: string; valid_ids: string[]; question_id?: string }
  | { code: 'TEXT_REQUIRED'; message: string; question_id?: string }
  | { code: 'EXPECTED_ONE_OPTION'; message: string; question_id?: string }
  | { code: 'EXPECTED_OPTIONS'; message: string; question_id?: string }
  | { code: 'UNKNOWN_QUESTION'; message: string; valid_ids: string[] }
  | { code: 'MISSING_ANSWER'; message: string; question_id: string };

export interface RawAnswer {
  option_ids?: string[];
  /** Raw freeform text contributed by the user. */
  text?: string;
}

/** Raw batched-answer payload (one entry per question on the item). */
export interface RawBatchAnswer extends RawAnswer {
  question_id?: string;
}

export interface ValidatedAnswer {
  /** Normalized option ids (deduplicated, in the order the user sent them). */
  option_ids: string[];
  /** Trimmed freeform text. */
  freeform: string;
  /** Effective mode after defaults are applied. */
  mode: 'single' | 'multi' | 'text';
  /** Selected option objects (preserves `value` for prompt compilation). */
  selected: InboxQuestionOption[];
}

export interface ValidatedBatchEntry extends ValidatedAnswer {
  question: InboxQuestion;
}

export interface CompiledAnswer {
  /** Display text to render in the reply bubble. */
  answer_text: string;
  /** Prompt to dispatch to the agent (after prompt_template substitution). */
  dispatch_prompt: string;
}

/** Per-question compiled answer for batched replies. */
export interface CompiledBatchEntry {
  question_id: string;
  question_prompt: string;
  question_title?: string;
  /** User-facing text rendered in the reply bubble. */
  answer_text: string;
  /** Raw option ids selected. */
  option_ids: string[];
  /** Raw freeform text. */
  freeform: string;
}

export interface CompiledBatchAnswer {
  /** Full reply bubble text (per-question lines joined with newlines). */
  answer_text: string;
  /** Full dispatch prompt (per-question lines joined with newlines). */
  dispatch_prompt: string;
  /** Per-question breakdown for storing in the reply's `answers[]` field. */
  entries: CompiledBatchEntry[];
}

/**
 * Compute the effective question mode given defaults:
 *   - explicit `question.mode` wins
 *   - else 'single' when options exist
 *   - else 'text'
 */
export function effectiveMode(q: InboxQuestion): 'single' | 'multi' | 'text' {
  if (q.mode) return q.mode;
  return q.options && q.options.length > 0 ? 'single' : 'text';
}

/**
 * Validate a raw user answer against a single question. Returns either a
 * validated answer ready for compilation, or a structured error code.
 *
 * Caller is responsible for checking the question exists / isn't closed
 * — those errors have their own codes for distinct HTTP status mapping
 * (404 vs 409 vs 400).
 */
export function validateAnswer(
  question: InboxQuestion,
  raw: RawAnswer,
): { ok: true; value: ValidatedAnswer } | { ok: false; error: InboxReplyValidationError } {
  const mode = effectiveMode(question);
  const allowFreeform = question.allow_freeform === true || mode === 'text';
  const rawIds = Array.isArray(raw.option_ids) ? raw.option_ids.filter((x) => typeof x === 'string') : [];

  // De-duplicate while preserving order.
  const seen = new Set<string>();
  const optionIds: string[] = [];
  for (const id of rawIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    optionIds.push(id);
  }
  const freeform = typeof raw.text === 'string' ? raw.text.trim() : '';

  const options = question.options ?? [];
  const knownIds = new Set(options.map((o) => o.id));
  for (const oid of optionIds) {
    if (!knownIds.has(oid)) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_OPTION',
          message: `unknown option id: ${oid}`,
          valid_ids: [...knownIds],
          question_id: question.id,
        },
      };
    }
  }

  if (mode === 'text') {
    if (!freeform) {
      return { ok: false, error: { code: 'TEXT_REQUIRED', message: 'text required for text-mode question', question_id: question.id } };
    }
  } else if (mode === 'single') {
    if (optionIds.length !== 1) {
      if (!(allowFreeform && optionIds.length === 0 && freeform)) {
        return {
          ok: false,
          error: { code: 'EXPECTED_ONE_OPTION', message: 'single-mode question requires exactly one option_id', question_id: question.id },
        };
      }
    }
  } else if (mode === 'multi') {
    if (optionIds.length === 0 && !(allowFreeform && freeform)) {
      return {
        ok: false,
        error: {
          code: 'EXPECTED_OPTIONS',
          message: 'multi-mode question requires at least one option_id (or freeform when allowed)',
          question_id: question.id,
        },
      };
    }
  }

  const selected = options.filter((o) => optionIds.includes(o.id));
  return { ok: true, value: { option_ids: optionIds, freeform, mode, selected } };
}

/**
 * Validate a batched answer against multiple questions. Every question
 * MUST have a matching answer entry (by `question_id`). Returns the
 * full validated batch in the same order as `questions`.
 *
 * Back-compat: if the caller passes a single `RawAnswer` without
 * `question_id` and the item has exactly one question, we apply that
 * answer to the sole question — preserving the pre-multi-question API.
 */
export function validateBatchAnswer(
  questions: InboxQuestion[],
  raw: RawBatchAnswer[] | RawAnswer,
): { ok: true; value: ValidatedBatchEntry[] } | { ok: false; error: InboxReplyValidationError } {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: { code: 'NO_QUESTION', message: 'item has no questions to answer' } };
  }

  // Legacy single-answer shorthand: only valid when the item has exactly
  // one question. We treat the raw payload as that question's answer.
  let entries: RawBatchAnswer[];
  if (!Array.isArray(raw)) {
    if (questions.length !== 1) {
      return {
        ok: false,
        error: {
          code: 'MISSING_ANSWER',
          message: `item has ${questions.length} questions; the request must include answers[] with one entry per question`,
          question_id: questions.map((q) => q.id).join(','),
        },
      };
    }
    entries = [{ question_id: questions[0].id, option_ids: raw.option_ids, text: raw.text }];
  } else {
    entries = raw;
  }

  // Index incoming entries by question_id, tolerating missing ids only
  // when the item has a single question (and the entry omits it).
  const byId = new Map<string, RawBatchAnswer>();
  for (const e of entries) {
    const qid = e.question_id ?? (questions.length === 1 ? questions[0].id : null);
    if (!qid) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_QUESTION',
          message: 'answer entry missing question_id; item has multiple questions',
          valid_ids: questions.map((q) => q.id),
        },
      };
    }
    if (!questions.some((q) => q.id === qid)) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_QUESTION',
          message: `unknown question_id: ${qid}`,
          valid_ids: questions.map((q) => q.id),
        },
      };
    }
    byId.set(qid, e);
  }

  const validated: ValidatedBatchEntry[] = [];
  for (const q of questions) {
    const entry = byId.get(q.id);
    if (!entry) {
      return {
        ok: false,
        error: {
          code: 'MISSING_ANSWER',
          message: `no answer provided for question_id: ${q.id}`,
          question_id: q.id,
        },
      };
    }
    const v = validateAnswer(q, { option_ids: entry.option_ids, text: entry.text });
    if (!v.ok) return v;
    validated.push({ ...v.value, question: q });
  }
  return { ok: true, value: validated };
}

/**
 * Compile a validated answer into the user-visible bubble text + the
 * prompt to dispatch back to the agent. The agent sees the option
 * `value` (falling back to `label`) joined by commas, with prompt template
 * substitutions applied:
 *
 *   {answer}      → joined option `value`s (or freeform when no options)
 *   {option_ids}  → joined ids ("yes,no")
 *   {freeform}    → raw freeform text (empty when none)
 *
 * `bubble_text` shown in the chain prefers `label` for human readability
 * (e.g. "Yes" rather than "yes"), with freeform appended via " — ".
 */
export function compileAnswer(
  question: InboxQuestion,
  validated: ValidatedAnswer,
): CompiledAnswer {
  const labelText = validated.selected.map((o) => o.label).join(', ');
  const valueText = validated.selected.map((o) => o.value ?? o.label).join(', ');

  const answer_text = validated.freeform
    ? (labelText ? `${labelText} — ${validated.freeform}` : validated.freeform)
    : labelText;

  const template = question.dispatch?.prompt_template ?? '{answer}';
  const answerForPrompt = valueText || validated.freeform || labelText;
  const dispatch_prompt = template
    .replace(/\{answer\}/g, answerForPrompt)
    .replace(/\{option_ids\}/g, validated.option_ids.join(','))
    .replace(/\{freeform\}/g, validated.freeform);

  return { answer_text, dispatch_prompt };
}

/**
 * Compile a batched validated answer (one per question on the item) into
 * a single composite reply + dispatch payload. The bubble text and
 * dispatch prompt are per-question blocks separated by blank lines so
 * the receiving agent can easily route each answer.
 *
 * Dispatch routing: the FIRST question whose `dispatch.session_id` is
 * set wins; its `prompt_template` (when present) is applied with
 * substitutions on the BATCHED answer text (i.e. {answer} expands to
 * the multi-line per-question block).
 */
export function compileBatchAnswer(
  validated: ValidatedBatchEntry[],
): CompiledBatchAnswer {
  const entries: CompiledBatchEntry[] = [];
  const bubbleLines: string[] = [];
  const dispatchLines: string[] = [];

  for (const v of validated) {
    const single = compileAnswer(v.question, v);
    const label = v.question.title || v.question.prompt;
    entries.push({
      question_id: v.question.id,
      question_prompt: v.question.prompt,
      question_title: v.question.title,
      answer_text: single.answer_text,
      option_ids: v.option_ids,
      freeform: v.freeform,
    });
    // Per-question lines in the bubble + dispatch prompt. Format:
    //   Q: <label or prompt>
    //   A: <answer>
    bubbleLines.push(`**${label}**`, single.answer_text, '');
    dispatchLines.push(`Q (${v.question.id}): ${label}`, `A: ${single.dispatch_prompt}`, '');
  }
  // Drop trailing blank line.
  while (bubbleLines[bubbleLines.length - 1] === '') bubbleLines.pop();
  while (dispatchLines[dispatchLines.length - 1] === '') dispatchLines.pop();

  // Routing: first question with a configured dispatch wins.
  const router = validated.find((v) => v.question.dispatch?.session_id)?.question;
  const template = router?.dispatch?.prompt_template;
  let dispatch_prompt = dispatchLines.join('\n');
  if (template) {
    dispatch_prompt = template
      .replace(/\{answer\}/g, dispatch_prompt)
      .replace(/\{option_ids\}/g, validated.flatMap((v) => v.option_ids).join(','))
      .replace(/\{freeform\}/g, validated.map((v) => v.freeform).join('\n').trim());
  }
  return {
    answer_text: bubbleLines.join('\n'),
    dispatch_prompt,
    entries,
  };
}

/**
 * Pick the routing question from a multi-question item. Returns the
 * first question whose `dispatch.session_id` is set, or null if none.
 * Caller decides whether to dispatch or just store the reply.
 */
export function pickDispatchRouter(questions: InboxQuestion[]): InboxQuestion | null {
  return questions.find((q) => q.dispatch?.session_id) ?? null;
}
