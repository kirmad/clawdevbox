/**
 * llm/index.ts
 *
 * Central registry for LLM providers + the `ask()` entry point.
 *
 * Usage:
 *   import { ask } from './llm/index.ts';
 *   const resp = await ask({ messages: [...] });
 *
 * Providers are registered at module load. To add a new provider:
 *   1. Implement `LlmProvider` (see types.ts)
 *   2. Import + push into `providers` array below
 */

import type { LlmAskRequest, LlmAskResponse, LlmMessage, LlmProvider, LlmToolDefinition } from './types.ts';
import { githubModelsProvider } from './github-models-provider.ts';
import { copilotSdkProvider } from './copilot-sdk-provider.ts';

const providers: LlmProvider[] = [
  githubModelsProvider,
  copilotSdkProvider,
];

/** List registered providers (id + displayName + availability). */
export async function listProviders(): Promise<{ id: string; displayName: string; available: boolean }[]> {
  return Promise.all(
    providers.map(async (p) => ({
      id: p.id,
      displayName: p.displayName,
      available: await p.isAvailable(),
    })),
  );
}

/**
 * Execute a single-turn LLM call. Fast path — no history, no tools.
 *
 * Provider resolution:
 *   1. If `req.provider` is set, use that provider (error if unavailable).
 *   2. Otherwise, use the first available provider.
 */
export async function ask(req: LlmAskRequest): Promise<LlmAskResponse> {
  let provider: LlmProvider | undefined;

  if (req.provider) {
    provider = providers.find((p) => p.id === req.provider);
    if (!provider) {
      throw new Error(
        `llm_ask: unknown provider "${req.provider}". ` +
        `Available: ${providers.map((p) => p.id).join(', ')}`,
      );
    }
    if (!(await provider.isAvailable())) {
      throw new Error(`llm_ask: provider "${req.provider}" is not available (missing credentials?).`);
    }
  } else {
    for (const p of providers) {
      if (await p.isAvailable()) { provider = p; break; }
    }
    if (!provider) {
      throw new Error(
        'llm_ask: no LLM provider available. ' +
        'Set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`.',
      );
    }
  }

  return provider.ask(req);
}

export type { LlmAskRequest, LlmAskResponse, LlmProvider, LlmToolDefinition } from './types.ts';
export { getMcpToolsForLlm, getMcpTool, mcpToolToLlmTool } from './mcp-tools-bridge.ts';
export { shutdownCopilotClient } from './copilot-sdk-provider.ts';

/**
 * Execute an LLM call with automatic tool execution loop.
 * When the model returns tool_calls and the tools have `_handler` functions,
 * this runs the handlers and feeds results back for a follow-up response.
 *
 * maxSteps limits the number of tool-calling rounds (default: 5).
 * Returns the final text response after all tool calls are resolved.
 */
export async function executeWithTools(
  req: LlmAskRequest & { maxSteps?: number },
): Promise<LlmAskResponse> {
  const maxSteps = req.maxSteps ?? 5;
  const toolMap = new Map<string, LlmToolDefinition>();
  for (const t of req.tools ?? []) {
    if (t._handler) toolMap.set(t.function.name, t);
  }

  let messages: LlmMessage[] = [...req.messages];
  let totalLatency = 0;
  let lastResponse: LlmAskResponse | undefined;

  for (let step = 0; step < maxSteps; step++) {
    const response = await ask({ ...req, messages });
    totalLatency += response.latency_ms;
    lastResponse = response;

    // If no tool calls or no handlers, we're done
    if (!response.tool_calls?.length) break;

    const hasHandlers = response.tool_calls.some(
      (tc) => toolMap.has(tc.function.name),
    );
    if (!hasHandlers) break;

    // Add assistant message with tool calls
    messages = [
      ...messages,
      { role: 'assistant', content: null, tool_calls: response.tool_calls },
    ];

    // Execute each tool call and add results
    for (const tc of response.tool_calls) {
      const toolDef = toolMap.get(tc.function.name);
      let result: string;
      if (toolDef?._handler) {
        try {
          const args = JSON.parse(tc.function.arguments);
          result = await toolDef._handler(args);
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        result = `Error: no handler for tool "${tc.function.name}"`;
      }
      messages.push({ role: 'tool', content: result, tool_call_id: tc.id });
    }
  }

  return { ...lastResponse!, latency_ms: totalLatency };
}
