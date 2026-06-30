import type { ILLMProvider } from '../interface.js';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PROVIDER_PRICING: Record<string, ModelPricing> = {
  deepseek: { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  openai: { inputPerMillion: 5, outputPerMillion: 15 },
  anthropic: { inputPerMillion: 3, outputPerMillion: 15 },
  google: { inputPerMillion: 1.25, outputPerMillion: 5 },
  openrouter: { inputPerMillion: 3, outputPerMillion: 15 },
  ollama: { inputPerMillion: 0, outputPerMillion: 0 },
};

const MODEL_PRICING: Array<{ pattern: RegExp; pricing: ModelPricing }> = [
  { pattern: /deepseek.*flash/i, pricing: { inputPerMillion: 0.07, outputPerMillion: 0.27 } },
  { pattern: /deepseek/i, pricing: { inputPerMillion: 0.27, outputPerMillion: 1.1 } },
  { pattern: /gpt-4o-mini/i, pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 } },
  { pattern: /gpt-4o\b/i, pricing: { inputPerMillion: 2.5, outputPerMillion: 10 } },
  { pattern: /gpt-5|codex/i, pricing: { inputPerMillion: 5, outputPerMillion: 15 } },
  { pattern: /claude.*haiku/i, pricing: { inputPerMillion: 0.8, outputPerMillion: 4 } },
  { pattern: /claude.*sonnet/i, pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  { pattern: /gemini.*flash/i, pricing: { inputPerMillion: 0.35, outputPerMillion: 1.05 } },
  { pattern: /gemini/i, pricing: { inputPerMillion: 1.25, outputPerMillion: 5 } },
];

export function getModelPricing(provider: ILLMProvider): ModelPricing {
  const model = provider.modelName;
  const matched = MODEL_PRICING.find(item => item.pattern.test(model));
  return matched?.pricing ?? PROVIDER_PRICING[provider.name] ?? { inputPerMillion: 3, outputPerMillion: 15 };
}

export function estimateCostUsd(
  provider: ILLMProvider,
  usage: { promptTokens: number; completionTokens: number },
): number {
  const pricing = getModelPricing(provider);
  return (
    usage.promptTokens * pricing.inputPerMillion +
    usage.completionTokens * pricing.outputPerMillion
  ) / 1_000_000;
}
