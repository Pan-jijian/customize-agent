import OpenAI from 'openai';
import type { Message } from '@customize-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk } from '../interface.js';
import { withRetry } from '../retry.js';
import { countTokensFromMessages } from '../utils/tokens.js';
import { createLLMResponse } from '../utils/response.js';

const OLLAMA_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
  supportsStreaming: true,
  supportsFunctionCalling: false,  // Ollama 对 tool calling 支持有限
  supportsVision: false,
  supportsThinking: false,
  supportsEmbedding: true,          // Ollama 支持 embed API
};

/**
 * Ollama Provider — 本地开源模型运行在 http://localhost:11434。
 * 默认模型: qwen3:14b（可通过 --model 覆盖）。
 * 数据不出机器，适用于敏感代码。
 * 通过 CUSTOMIZE_AGENT_OLLAMA_API_KEY 环境变量配置（本地通常不需要）。
 */
export class OllamaProvider implements ILLMProvider {
  readonly name = 'ollama';
  readonly capabilities = OLLAMA_CAPABILITIES;
  readonly modelName: string;
  private client: OpenAI;

  constructor(options: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.CUSTOMIZE_AGENT_OLLAMA_API_KEY ?? 'ollama',
      baseURL: options.baseUrl ?? 'http://localhost:11434/v1',
    });
    this.modelName = options.modelName ?? 'qwen3:14b';
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

      return createLLMResponse({
        content: choice.message.content ?? '',
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
        } : undefined,
      });
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
        return createLLMResponse({ content, usage: { promptTokens, completionTokens } });
      },
      { onRetry: () => { onChunk({ type: 'reset' }); } },
    );
  }

  async countTokens(messages: Message[]): Promise<number> {
    return countTokensFromMessages(messages);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch('http://localhost:11434/api/tags');
      return response.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await withRetry(async () => {
      return this.client.embeddings.create({
        model: this.modelName,
        input: texts,
      });
    });
    // OpenAI-compatible embedding 返回
    const data = response as unknown as { data: Array<{ embedding: number[] }> };
    return data.data.map(d => d.embedding);
  }

  async embedQuery(query: string): Promise<number[]> {
    const result = await this.embed([query]);
    return result[0]!;
  }
}
