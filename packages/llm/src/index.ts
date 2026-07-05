export type {
  ILLMProvider,
  LLMResponse,
  ChatOptions,
  ModelCapabilities,
  ImageGenerationOptions,
  ImageGenerationResult,
  FileUnderstandingInput,
  FileUnderstandingOptions,
  FunctionDefinition,
  ToolCall,
  StreamChunk,
} from './interface.js';

export { DEFAULT_CAPABILITIES } from './interface.js';
export { DeepSeekProvider } from './providers/deepseek.js';
export { OpenAIProvider } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { GoogleProvider } from './providers/google.js';
export { OpenRouterProvider } from './providers/openrouter.js';
export { OllamaProvider } from './providers/ollama.js';
export { withRetry, isRetryableError, type RetryOptions } from './retry.js';

export { estimateTokens, countTokensFromMessages } from './utils/tokens.js';
export { estimateCostUsd, getModelPricing, type ModelPricing } from './utils/pricing.js';
export { toOpenAIMessages, openAIHealthCheck } from './utils/messages.js';
export { createLLMResponse } from './utils/response.js';

import { DeepSeekProvider } from './providers/deepseek.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { OllamaProvider } from './providers/ollama.js';
import type { ILLMProvider } from './interface.js';

/** 工厂函数：按名称创建 Provider 实例 */
export function createProvider(name: string, options?: Record<string, unknown>): ILLMProvider {
  const opts = options ?? {};
  type ProviderOpts = { apiKey?: string; baseUrl?: string; modelName?: string };
  switch (name) {
    case 'deepseek':
      return new DeepSeekProvider(opts as ProviderOpts);
    case 'openai':
      return new OpenAIProvider(opts as ProviderOpts);
    case 'anthropic':
      return new AnthropicProvider(opts as ProviderOpts);
    case 'google':
      return new GoogleProvider(opts as ProviderOpts);
    case 'openrouter':
      return new OpenRouterProvider(opts as ProviderOpts);
    case 'ollama':
      return new OllamaProvider(opts as ProviderOpts);
    default:
      throw new Error(`Unknown provider: "${name}". Available: deepseek, openai, anthropic, google, openrouter, ollama`);
  }
}
