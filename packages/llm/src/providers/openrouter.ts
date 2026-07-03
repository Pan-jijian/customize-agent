import type { ModelCapabilities } from '../interface.js';
import { OpenAICompatProvider } from './openai-base.js';

const OPENROUTER_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 1_000_000,
  maxOutputTokens: 16_384,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: false,
  supportsThinking: false,
  supportsEmbedding: false,
};

/**
 * OpenRouter Provider — 300+ 模型统一入口，OpenAI 兼容 API。
 * 默认模型: deepseek/deepseek-chat，路由信息通过 HTTP 头传递。
 * 通过 CUSTOMIZE_AGENT_OPENROUTER_API_KEY 环境变量配置。
 */
export class OpenRouterProvider extends OpenAICompatProvider {
  readonly name = 'openrouter';
  readonly capabilities = OPENROUTER_CAPABILITIES;

  constructor(options: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    super({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      modelName: options.modelName,
      defaultApiKey: process.env.CUSTOMIZE_AGENT_OPENROUTER_API_KEY ?? '',
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'deepseek/deepseek-chat',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/customize-agent/customize-agent',
        'X-Title': 'Customize Agent',
      },
    });
  }
}
