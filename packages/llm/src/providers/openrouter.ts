import OpenAI from 'openai';
import type { Message } from '@code-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk } from '../interface.js';
import { withRetry } from '../network/retry.js';

const OPENROUTER_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 200_000,
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
 * 通过 CODE_AGENT_OPENROUTER_API_KEY 环境变量配置。
 */
export class OpenRouterProvider implements ILLMProvider {
  readonly name = 'openrouter';
  readonly capabilities = OPENROUTER_CAPABILITIES;
  readonly modelName: string;
  private client: OpenAI;

  constructor(options: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.CODE_AGENT_OPENROUTER_API_KEY ?? '',
      baseURL: options.baseUrl ?? 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/code-agent/code-agent',
        'X-Title': 'Code Agent',
      },
    });
    this.modelName = options.modelName ?? 'deepseek/deepseek-chat';
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    return withRetry(async () => {
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error('LLM returned empty choices');

      return {
        content: choice.message.content ?? '',
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
        } : undefined,
      };
    });
  }

  async chatStream(
    messages: Message[],
    onChunk: (chunk: StreamChunk) => void,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    return withRetry(
      async () => {
        const stream = await this.client.chat.completions.create({
          model: this.modelName,
          messages: messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
          temperature: options?.temperature ?? 0.2,
          max_tokens: options?.maxTokens,
          stream: true,
        });

        let content = '';
        let promptTokens = 0;
        let completionTokens = 0;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onChunk({ type: 'content', text: delta.content });
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        }

        onChunk({ type: 'done' });
        return { content, usage: { promptTokens, completionTokens } };
      },
      { onRetry: () => { onChunk({ type: 'reset' }); } },
    );
  }

  async countTokens(messages: Message[]): Promise<number> {
    const text = messages.map(m => m.content).join('\n');
    return Math.ceil(text.length / 4);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.client.models.list();
      return result.data.length > 0;
    } catch {
      return false;
    }
  }
}
