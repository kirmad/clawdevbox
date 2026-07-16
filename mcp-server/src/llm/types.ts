/**
 * llm/types.ts
 *
 * Provider-agnostic types for the lightweight llm_ask API.
 * Designed for fast, single-turn LLM calls — NOT for multi-turn sessions.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** For assistant messages that include tool calls. */
  tool_calls?: LlmToolCall[];
  /** For tool-role messages: the id of the tool call this responds to. */
  tool_call_id?: string;
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  /**
   * Optional handler for executing this tool. When provided, `executeWithTools()`
   * will call this handler when the model invokes the tool, then feed the result
   * back to the model for a follow-up response.
   */
  _handler?: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface LlmAskRequest {
  /** The messages to send (OpenAI chat-completions format). */
  messages: LlmMessage[];
  /**
   * Model identifier. Provider-specific — e.g. "openai/gpt-4o-mini" for
   * the github-models provider. When omitted, the provider uses its default.
   */
  model?: string;
  /**
   * Sampling temperature (0–2). Lower = more deterministic.
   * Default: 0 (fully deterministic — ideal for classification tasks).
   */
  temperature?: number;
  /**
   * Max tokens to generate. Default: provider-specific (typically 1024).
   */
  max_tokens?: number;
  /**
   * Which provider to use. When omitted, uses the first available.
   */
  provider?: string;
  /**
   * Tool definitions (OpenAI function-calling format). When provided,
   * the model may respond with tool_calls instead of text content.
   */
  tools?: LlmToolDefinition[];
  /**
   * Controls whether the model must call a tool. Values:
   *   "auto" — model decides (default)
   *   "none" — never call tools
   *   "required" — must call at least one tool
   *   { type: "function", function: { name: "..." } } — force specific tool
   */
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

export interface LlmAskResponse {
  /** The assistant's response text (null when tool_calls are returned). */
  content: string | null;
  /** Tool calls requested by the model (when tools were provided). */
  tool_calls?: LlmToolCall[];
  /** The model that actually served the request. */
  model: string;
  /** Provider that handled the request. */
  provider: string;
  /** Token usage (when reported by the upstream API). */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Wall-clock latency in milliseconds. */
  latency_ms: number;
}

/**
 * A pluggable LLM provider. Implementations handle auth, endpoint routing,
 * and response parsing. The contract is intentionally minimal — one method.
 */
export interface LlmProvider {
  /** Unique id for this provider (e.g. "github-models", "azure-openai"). */
  readonly id: string;
  /** Human-friendly display name. */
  readonly displayName: string;
  /**
   * Returns true when this provider has valid credentials and can serve
   * requests. Called at startup and on-demand to skip misconfigured providers.
   */
  isAvailable(): Promise<boolean>;
  /**
   * Execute a single completion request. Throws on transient/auth errors
   * (caller decides retry policy).
   */
  ask(req: LlmAskRequest): Promise<LlmAskResponse>;
}
