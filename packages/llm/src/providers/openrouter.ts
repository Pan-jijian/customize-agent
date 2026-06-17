import OpenAI from 'openai';
import type { Message } from '@code-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk, ToolCall } from '../interface.js';
import { withRetry } from '../network/retry.js';
import { toOpenAIMessages } from '../utils/messages.js';
import { countTokensFromMessages } from '../utils/tokens.js';
import { openAIHealthCheck } from '../utils/messages.js';
import { createLLMResponse } from '../utils/response.js';

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
        messages: toOpenAIMessages(messages),
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens,
        tools: options?.tools?.length ? options.tools.map(t => ({ type: 'function' as const, function: t })) : undefined,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error('LLM returned empty choices');

      const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map(tc => {
        const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
        try { return { id: tc.id, name: fn?.name ?? '', arguments: JSON.parse(fn?.arguments ?? '{}') }; }
        catch { return { id: tc.id, name: fn?.name ?? '', arguments: {} }; }
      });

      return createLLMResponse({
        content: choice.message.content ?? '',
        toolCalls: toolCalls?.length ? toolCalls : undefined,
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
          stream: true,
          tools: options?.tools?.length ? options.tools.map(t => ({ type: 'function' as const, function: t })) : undefined,
        });

        let content = '';
        let promptTokens = 0;
        let completionTokens = 0;
        const toolCalls = new Map<number, { id: string; name: string; args: string }>();

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onChunk({ type: 'content', text: delta.content });
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls.has(idx)) toolCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
              const acc = toolCalls.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        }

        for (const [, tc] of toolCalls) {
          if (tc.id) {
            try { onChunk({ type: 'tool_call', call: { id: tc.id, name: tc.name, arguments: JSON.parse(tc.args || '{}') } }); }
            catch { /* skip malformed */ }
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
    return openAIHealthCheck(this.client);
  }
}
