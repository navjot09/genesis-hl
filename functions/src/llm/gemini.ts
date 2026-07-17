/**
 * Google Gemini adapter (@google/genai — the current unified SDK).
 *
 * Streams plain text; the caller feeds each delta into the marker-protocol parser
 * and forwards it over SSE. We never ask Gemini for native JSON structured output —
 * the model emits `<file …>` marker blocks so file bodies stream unescaped and
 * partial output survives truncation.
 */
import { GoogleGenAI } from '@google/genai';
import type {
  GenerateParams,
  LLMProvider,
  LlmStopReason,
  LlmStreamResult,
} from './types.js';

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly ai: GoogleGenAI;
  private readonly defaultModel: string;

  constructor(apiKey: string, defaultModel: string) {
    this.ai = new GoogleGenAI({ apiKey });
    this.defaultModel = defaultModel;
  }

  async stream(
    params: GenerateParams,
    onDelta: (text: string) => void,
  ): Promise<LlmStreamResult> {
    const contents = params.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    let full = '';
    let finishReason: string | undefined;
    let blockReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      const stream = await this.ai.models.generateContentStream({
        model: params.model || this.defaultModel,
        contents,
        config: {
          systemInstruction: params.system,
          maxOutputTokens: params.maxOutputTokens ?? 32000,
        },
      });

      for await (const chunk of stream) {
        if (params.signal?.aborted) {
          return { text: full, stopReason: 'aborted', detail: 'client aborted' };
        }
        // Input-level safety block: zero candidates, prompt was rejected.
        const pf = chunk.promptFeedback?.blockReason;
        if (pf) blockReason = pf;

        const t = chunk.text;
        if (t) {
          full += t;
          onDelta(t);
        }

        const fr = chunk.candidates?.[0]?.finishReason;
        if (fr) finishReason = fr as string;

        const usage = chunk.usageMetadata;
        if (usage) {
          inputTokens = usage.promptTokenCount ?? inputTokens;
          outputTokens = usage.candidatesTokenCount ?? outputTokens;
        }
      }
    } catch (err) {
      if (params.signal?.aborted) {
        return { text: full, stopReason: 'aborted', detail: 'client aborted' };
      }
      return {
        text: full,
        stopReason: 'error',
        detail: err instanceof Error ? err.message : String(err),
        usage: { inputTokens, outputTokens },
      };
    }

    let stopReason: LlmStopReason = 'stop';
    if (blockReason) stopReason = 'blocked';
    else if (finishReason === 'MAX_TOKENS') stopReason = 'max_tokens';
    else if (finishReason && finishReason !== 'STOP') stopReason = 'blocked';

    return {
      text: full,
      stopReason,
      detail: blockReason ?? finishReason,
      usage: { inputTokens, outputTokens },
    };
  }
}
