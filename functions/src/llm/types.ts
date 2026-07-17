/**
 * Provider-agnostic streaming LLM interface.
 *
 * Genesis's brief lists Claude/OpenAI; the default adapter here is Gemini (the
 * available key). Swapping providers is implementing this one interface and wiring
 * it in `createProvider()` — the generation pipeline depends only on `LLMProvider`.
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateParams {
  /** System instruction (the large, cacheable HighLevel API reference + rules). */
  system: string;
  /** Conversation history + the current user prompt, already assembled. */
  messages: LlmMessage[];
  /** Optional model override (e.g. a heavier model for hard generations). */
  model?: string;
  maxOutputTokens?: number;
  /** Cooperative cancellation for mid-stream aborts. */
  signal?: AbortSignal;
}

/** Normalised terminal state, mapped from each provider's finish/stop reason. */
export type LlmStopReason = 'stop' | 'max_tokens' | 'blocked' | 'error' | 'aborted';

export interface LlmStreamResult {
  /** Full accumulated text (the salvage buffer — always populated, even on failure). */
  text: string;
  stopReason: LlmStopReason;
  /** Provider-specific detail (finishReason / blockReason / error message). */
  detail?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LLMProvider {
  readonly name: string;
  /**
   * Stream a completion. `onDelta` is called with each text chunk as it arrives;
   * the promise resolves with the accumulated text + normalised stop reason.
   * Implementations MUST NOT throw for model-level failures (blocked/truncated) —
   * they return a result with the appropriate `stopReason`. They may throw only for
   * unexpected transport errors, which callers treat as `stopReason: 'error'`.
   */
  stream(params: GenerateParams, onDelta: (text: string) => void): Promise<LlmStreamResult>;
}
