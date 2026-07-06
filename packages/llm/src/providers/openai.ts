import type { ModelCapabilities } from '../interface.js';
import { OpenAICompatProvider } from './openai-base.js';
import { withRetry } from '../retry.js';

const OPENAI_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 1_000_000,
  maxOutputTokens: 16_384,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: true,
  supportsThinking: false,
  supportsEmbedding: true,
};

/**
 * OpenAI Provider — 原生 function calling + Embedding。
 * 默认模型: gpt-5.3-codex，支持 CUSTOMIZE_AGENT_OPENAI_API_KEY 环境变量配置。
 */
export class OpenAIProvider extends OpenAICompatProvider {
  readonly name = 'openai';
  readonly capabilities = OPENAI_CAPABILITIES;

  constructor(options: { apiKey?: string; baseUrl?: string; modelName?: string; directEndpoint?: boolean } = {}) {
    super({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      modelName: options.modelName,
      directEndpoint: options.directEndpoint,
      defaultApiKey: process.env.CUSTOMIZE_AGENT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      defaultBaseUrl: process.env.OPENAI_BASE_URL,
      defaultModel: 'gpt-5.3-codex',
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await withRetry(async () => {
      return this.client.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
      });
    });
    return response.data.map(d => d.embedding);
  }

  async embedQuery(query: string): Promise<number[]> {
    const result = await this.embed([query]);
    return result[0]!;
  }
}
