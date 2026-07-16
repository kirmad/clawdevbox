/**
 * tools/pr-walkthrough.ts
 *
 * MCP tool: pr-walkthrough.answer — agents call this to reply to a
 * reviewer Q&A question on a PR walkthrough artifact.
 *
 * Server-side this calls qa-store.appendAnswer, which patches the
 * matching question entry in <artifactDir>/qa/step-<N>.json with `a`
 * (the answer text) and `ts` (ISO timestamp).
 *
 * Resolution: the artifact is located via the shared `findArtifact`
 * helper in artifact-store.ts (same chain the /artifact/* HTTP routes
 * use — project dir first, then every registered workspace).
 */

import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { appendAnswer } from '../qa-store.ts';
import { artifactDir, findArtifact } from '../artifact-store.ts';
import type { Workspace } from '../workspace.ts';

/** Cap answer length — generous enough for thorough explanations, not a novel. */
const ANSWER_TEXT_CAP = 16_000;

const answerParams = z.object({
  artifact_id: z
    .string()
    .min(1)
    .describe('The PR walkthrough artifact id, e.g. "pr-walkthrough-1426766".'),
  step_n: z
    .number()
    .int()
    .positive()
    .describe('The step number the question was asked on (1-indexed).'),
  question_id: z
    .string()
    .min(1)
    .describe('The id of the question to answer (the q_xxx id from the prompt or the GET/POST qa endpoint).'),
  text: z
    .string()
    .min(1)
    .max(ANSWER_TEXT_CAP)
    .describe(
      "The agent's answer. Markdown supported (backticks render as <code>, **bold** as <strong>). Cite files + line ranges where relevant.",
    ),
});

export type AnswerArgs = z.infer<typeof answerParams>;

export interface AnswerResult {
  ok: true;
}

/**
 * Internal handler — exported for unit tests. Resolves the artifact via
 * findArtifact (CLAWDEVBOX_PROJECT_DIR + registered workspaces), then
 * delegates to qa-store.appendAnswer for the file lock + atomic write.
 *
 * Throws:
 *   - "no such artifact: <id>"      when findArtifact returns null
 *   - "question not found: <id>"    re-thrown from qa-store.appendAnswer
 */
export async function handleAnswer(args: AnswerArgs): Promise<AnswerResult> {
  const found = findArtifact(args.artifact_id);
  if (!found) {
    throw new Error(`no such artifact: ${args.artifact_id}`);
  }
  const dir = artifactDir(found.workspacePath, args.artifact_id);
  await appendAnswer({
    artifactDir: dir,
    stepN: args.step_n,
    questionId: args.question_id,
    text: args.text,
  });
  return { ok: true };
}

export function registerPrWalkthroughEntries(_ws: Workspace): void {
  defineTool({
    name: 'pr-walkthrough.answer',
    description: `Reply to a reviewer's Q&A question on a PR walkthrough artifact.

Use this whenever you receive a prompt formatted as:
  Question on step N of artifact pr-walkthrough-<prId>
  File: <path>
  ...
  Question (id: q_xxx):
  > <text>

Pass:
  - artifact_id  : the "pr-walkthrough-<prId>" id from the prompt
  - step_n       : the step number
  - question_id  : the q_xxx id from the prompt
  - text         : your thorough answer (markdown OK; cite files + line ranges)

Be substantive — the reviewer is reading your reply to decide whether to
approve the PR. Don't gloss. Include code references and reasoning.`,
    parameters: answerParams,
    handler: async (args) => {
      const result = await handleAnswer(args as AnswerArgs);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
    examples: [
      {
        description: 'Answer a question on step 3 of a PR walkthrough',
        args: {
          artifact_id: 'pr-walkthrough-1426766',
          step_n: 3,
          question_id: 'q_a1b2c3d4e5f6',
          text: 'The retry uses exponential backoff (see `src/http/retry.ts:42-78`) capped at 5 attempts.',
        },
      },
    ],
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
