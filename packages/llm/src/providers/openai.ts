import OpenAI from 'openai';
import type { Message } from '@code-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk, ToolCall } from '../interface.js';
import { withRetry } from '../network/retry.js';
import { toOpenAIMessages } from '../utils/messages.js';
import { countTokensFromMessages } from '../utils/tokens.js';
import { openAIHealthCheck } from '../utils/messages.js';
import { createLLMResponse } from '../utils/response.js';

const OPENAI_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 200_000,
  maxOutputTokens: 16_384,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: false,
  supportsThinking: false, // OpenAI 无 Anthropic 风格的 thinking 块
  supportsEmbedding: true,
};

/**
 * OpenAI Provider — 原生 function calling + Embedding。
 * 默认模型: gpt-5.3-codex，支持 CODE_AGENT_OPENAI_API_KEY 环境变量配置。
 */
export class OpenAIProvider implements ILLMProvider {
  readonly name = 'openai';
  readonly capabilities = OPENAI_CAPABILITIES;
  readonly modelName: string;
  private client: OpenAI;

  constructor(options: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.CODE_AGENT_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: options.baseUrl ?? process.env.OPENAI_BASE_URL,
    });
    this.modelName = options.modelName ?? 'gpt-5.3-codex';
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    return withRetry(async () => {
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: toOpenAIMessages(messages),
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens,
        tools: options?.tools?.map(t => ({ type: 'function' as const, function: t })),
      });

      const choice = response.choices[0];
      if (!choice) throw new Error('LLM returned empty choices');

      const msg = choice.message;
      const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map(tc => {
        const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
        return {
          id: tc.id,
          name: fn?.name ?? '',
          arguments: JSON.parse(fn?.arguments ?? '{}'),
        };
      });

      return createLLMResponse({
        content: msg.content ?? '',
        toolCalls,
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
          messages: toOpenAIMessages(messages),
          temperature: options?.temperature ?? 0.2,
          max_tokens: options?.maxTokens,
          tools: options?.tools?.map(t => ({ type: 'function' as const, function: t })),
          stream: true,
        });

        let content = '';
        const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>();
        let promptTokens = 0;
        let completionTokens = 0;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            content += delta.content;
            onChunk({ type: 'content', text: delta.content });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>) {
              const idx = tc.index;
              if (!toolCallAccumulators.has(idx)) {
                toolCallAccumulators.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: tc.function?.arguments ?? '' });
              } else {
                const acc = toolCallAccumulators.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
              }
            }
          }

          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        }

        onChunk({ type: 'done' });

        const toolCalls: ToolCall[] = Array.from(toolCallAccumulators.values()).map(acc => ({
          id: acc.id,
          name: acc.name,
          arguments: JSON.parse(acc.args || '{}'),
        }));

        return createLLMResponse({
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: { promptTokens, completionTokens },
        });
      },
      { onRetry: () => { onChunk({ type: 'reset' }); } },
    );
  }

  async countTokens(messages: Message[]): Promise<number> {
    return countTokensFromMessages(messages);
  }

  async healthCheck(): Promise<boolean> {
    return openAIHealthCheck(this.client);
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
