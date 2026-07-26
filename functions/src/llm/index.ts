/**
 * Provider factory — the single seam where a different LLM is swapped in.
 *
 * The options are provider-NEUTRAL (apiKey/model), so a new adapter needs:
 *   1. an LLMProvider implementation (./claude.ts or ./openai.ts),
 *   2. a case below,
 *   3. its API-key secret declared in config.ts and bound on the generate
 *      endpoint (Firebase requires secrets to be statically declared).
 * The generation pipeline itself depends only on LLMProvider.stream().
 */
import { GeminiProvider } from './gemini.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

export interface ProviderOptions {
  provider: string;
  apiKey: string;
  model: string;
}

export function createProvider(opts: ProviderOptions): LLMProvider {
  switch (opts.provider) {
    case 'gemini':
      return new GeminiProvider(opts.apiKey, opts.model);
    // case 'claude': return new ClaudeProvider(opts.apiKey, opts.model);
    // case 'openai': return new OpenAIProvider(opts.apiKey, opts.model);
    default:
      throw new Error(`Unknown LLM_PROVIDER "${opts.provider}"`);
  }
}
