/**
 * inbox-reply.ts
 *
 * Pure helpers for validating + compiling answers to inbox questions.
 * Extracted from the HTTP handler so unit tests can cover the rules
 * without spinning up a server.
 *
 * The HTTP layer (`/api/inbox/<id>/reply`) calls `validateAnswer` then
 * `compileAnswer`, appends the reply via InboxStore, and dispatches via
 * `spawnDispatchOrResume`. The MCP `inbox.reply` tool only appends and
 * does NOT dispatch (agents are expected to handle their own follow-ups).
 */

import type { InboxQuestion, InboxQuestionOption } from './store.ts';

export type InboxReplyValidationError =
  | { code: 'NO_QUESTION'; message: string }
  | { code: 'QUESTION_CLOSED'; message: string }
  | { code: 'UNKNOWN_OPTION'; message: string; valid_ids: string[] }
  | { code: 'TEXT_REQUIRED'; message: string }
  | { code: 'EXPECTED_ONE_OPTION'; message: string }
  | { code: 'EXPECTED_OPTIONS'; message: string };

export interface RawAnswer {
  option_ids?: string[];
  /** Raw freeform text contributed by the user. */
  text?: string;
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

export interface CompiledAnswer {
  /** Display text to render in the reply bubble. */
  answer_text: string;
  /** Prompt to dispatch to the agent (after prompt_template substitution). */
  dispatch_prompt: string;
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
 * Validate a raw user answer against a question. Returns either a
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
        },
      };
    }
  }

  if (mode === 'text') {
    if (!freeform) {
      return { ok: false, error: { code: 'TEXT_REQUIRED', message: 'text required for text-mode question' } };
    }
  } else if (mode === 'single') {
    if (optionIds.length !== 1) {
      if (!(allowFreeform && optionIds.length === 0 && freeform)) {
        return {
          ok: false,
          error: { code: 'EXPECTED_ONE_OPTION', message: 'single-mode question requires exactly one option_id' },
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
        },
      };
    }
  }

  const selected = options.filter((o) => optionIds.includes(o.id));
  return { ok: true, value: { option_ids: optionIds, freeform, mode, selected } };
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
