/** Provider factory — the single seam where a different LLM is swapped in. */
import { GeminiProvider } from './gemini.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

export interface ProviderOptions {
  provider: string;
  geminiApiKey: string;
  geminiModel: string;
}

export function createProvider(opts: ProviderOptions): LLMProvider {
  switch (opts.provider) {
    case 'gemini':
      return new GeminiProvider(opts.geminiApiKey, opts.geminiModel);
    // To satisfy the brief's Claude/OpenAI requirement, implement LLMProvider in
    // ./claude.ts / ./openai.ts and add cases here — the pipeline is unaffected.
    // case 'claude': return new ClaudeProvider(opts.anthropicApiKey, opts.claudeModel);
    // case 'openai': return new OpenAIProvider(opts.openaiApiKey, opts.openaiModel);
    default:
      throw new Error(`Unknown LLM_PROVIDER "${opts.provider}"`);
  }
}
