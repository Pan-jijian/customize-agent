import type { ModelCapabilities, StreamChunk } from '../interface.js';
import { OpenAICompatProvider } from './openai-base.js';

/** DeepSeek 模型能力声明 */
const DEEPSEEK_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: false,
  supportsThinking: true,
  supportsEmbedding: false,
};

/**
 * DeepSeek Provider — 基于 OpenAI 兼容 API，支持 reasoning_content 思维链提取 + 原生 function calling。
 * 默认模型: deepseek-v4-flash，可通过 CUSTOMIZE_AGENT_DEEPSEEK_API_KEY 配置。
 */
export class DeepSeekProvider extends OpenAICompatProvider {
  readonly name = 'deepseek';
  readonly capabilities = DEEPSEEK_CAPABILITIES;

  constructor(options: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    super({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      modelName: options.modelName,
      defaultApiKey: process.env.CUSTOMIZE_AGENT_DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY,
      defaultBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1',
      defaultModel: process.env.CUSTOMIZE_AGENT_DEEPSEEK_MODEL_NAME ?? process.env.DEEPSEEK_MODEL_NAME ?? 'deepseek-v4-flash',
    });
  }

  /** DeepSeek 特有：处理 reasoning_content 思维链 */
  protected _processDelta(
    delta: Record<string, unknown>,
    onChunk: (chunk: StreamChunk) => void,
  ): void {
    if (typeof delta.reasoning_content === 'string') {
      this._thinkingContent += delta.reasoning_content;
      onChunk({ type: 'thinking', text: delta.reasoning_content });
    }
  }
}
