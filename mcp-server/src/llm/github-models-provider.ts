/**
 * llm/github-models-provider.ts
 *
 * LLM provider backed by GitHub Models API (https://models.github.ai).
 * Auth: GitHub token from `gh auth token`, GITHUB_TOKEN env, or GH_TOKEN env.
 *
 * Endpoint: POST https://models.github.ai/inference/chat/completions
 * Format: OpenAI-compatible chat completions.
 */

import { execSync } from 'node:child_process';
import type { LlmAskRequest, LlmAskResponse, LlmProvider } from './types.ts';

const API_BASE = 'https://models.github.ai/inference';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

function resolveToken(): string | null {
  // 1. Explicit env vars (fastest path)
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  // 2. gh CLI keyring (works when gh is authenticated)
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (token && token.length > 10) return token;
  } catch {
    // gh not installed or not logged in
  }
  return null;
}

// Cache the token for the lifetime of the process (it rarely changes).
let cachedToken: string | null | undefined;
function getToken(): string | null {
  if (cachedToken === undefined) cachedToken = resolveToken();
  return cachedToken;
}

/** Force re-resolve on next call (useful after `gh auth login`). */
export function clearTokenCache(): void {
  cachedToken = undefined;
}

export const githubModelsProvider: LlmProvider = {
  id: 'github-models',
  displayName: 'GitHub Models',

  async isAvailable(): Promise<boolean> {
    return getToken() !== null;
  },

  async ask(req: LlmAskRequest): Promise<LlmAskResponse> {
    const token = getToken();
    if (!token) {
      throw new Error(
        'github-models provider: no GitHub token found. ' +
        'Set GITHUB_TOKEN / GH_TOKEN env, or run `gh auth login`.',
      );
    }

    const model = req.model ?? DEFAULT_MODEL;
    const isReasoningModel = /\b(o[1-9]|o3|o4|gpt-5)/.test(model);

    const payload: Record<string, unknown> = {
      model,
      messages: req.messages,
      temperature: isReasoningModel ? undefined : (req.temperature ?? 0),
    };

    // Reasoning models use max_completion_tokens; standard models use max_tokens
    if (isReasoningModel) {
      payload.max_completion_tokens = req.max_tokens ?? 4096;
    } else {
      payload.max_tokens = req.max_tokens ?? 1024;
    }

    if (req.tools?.length) payload.tools = req.tools;
    if (req.tool_choice) payload.tool_choice = req.tool_choice;

    const body = JSON.stringify(payload);

    const t0 = performance.now();
    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `github-models: ${resp.status} ${resp.statusText}` +
        (text ? ` — ${text.slice(0, 300)}` : ''),
      );
    }

    const json = await resp.json() as {
      choices?: { message?: { content?: string | null; tool_calls?: LlmAskResponse['tool_calls'] } }[];
      model?: string;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const latency_ms = Math.round(performance.now() - t0);

    const message = json.choices?.[0]?.message;
    const content = message?.content ?? null;

    return {
      content,
      tool_calls: message?.tool_calls,
      model: json.model ?? model,
      provider: 'github-models',
      usage: json.usage,
      latency_ms,
    };
  },
};
