import OpenAI from 'openai';
import type { Message, ToolCall } from '@customize-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk, FunctionDefinition } from '../interface.js';
import { withRetry } from '../retry.js';
import { toOpenAIMessages, toOpenAITools, openAIHealthCheck } from '../utils/messages.js';
import { countTokensFromMessages } from '../utils/tokens.js';
import { createLLMResponse } from '../utils/response.js';

/**
 * OpenAI 兼容 Provider 抽象基类。
 * 封装 OpenAI/DeepSeek/OpenRouter 共用的 ~90% 逻辑：
 *   - 构造函数（client + modelName）
 *   - countTokens / healthCheck
 *   - chat / chatStream 模板方法
 * 子类仅需声明 name + capabilities + 默认值，可选覆盖 _extractToolCalls / _processDelta。
 */
export abstract class OpenAICompatProvider implements ILLMProvider {
  abstract readonly name: string;
  abstract readonly capabilities: ModelCapabilities;
  readonly modelName: string;
  protected client: OpenAI;

  constructor(params: {
    apiKey?: string;
    baseUrl?: string;
    modelName?: string;
    defaultApiKey?: string;
    defaultBaseUrl?: string;
    defaultModel: string;
    defaultHeaders?: Record<string, string>;
  }) {
    this.client = new OpenAI({
      apiKey: params.apiKey || params.defaultApiKey || 'sk-placeholder', // 占位符避免 SDK 崩溃，空串也回退
      baseURL: params.baseUrl ?? params.defaultBaseUrl,
      defaultHeaders: params.defaultHeaders,
    });
    this.modelName = params.modelName ?? params.defaultModel;
  }

  // ── 共享方法 ──

  async countTokens(messages: Message[]): Promise<number> {
    return countTokensFromMessages(messages);
  }

  async healthCheck(): Promise<boolean> {
    return openAIHealthCheck(this.client);
  }

  // ── chat 模板方法 ──

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    return withRetry(async () => {
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: toOpenAIMessages(messages),
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens,
        tools: this._buildTools(options?.tools),
      }, { signal: options?.signal });

      const choice = response.choices[0];
      if (!choice) throw new Error('LLM returned empty choices');

      const msg = choice.message as { reasoning_content?: string; content?: string | null };
      return createLLMResponse({
        content: msg.content ?? '',
        thinkingContent: msg.reasoning_content,
        toolCalls: this._extractToolCalls(choice),
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
        } : undefined,
      });
    });
  }

  // ── chatStream 模板方法 ──

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
          tools: this._buildTools(options?.tools),
          stream: true,
        });

        let content = '';
        this._thinkingContent = '';
        const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
        let promptTokens = 0;
        let completionTokens = 0;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          // 子类钩子：处理 thinking 等特殊 delta（DeepSeek reasoning_content）
          this._processDelta(delta, onChunk);

          if (typeof delta.content === 'string') {
            content += delta.content;
            onChunk({ type: 'content', text: delta.content });
          }

          // 流式 tool_calls 累加
          const toolCallDeltas = delta.tool_calls as Array<{
            index: number; id?: string; function?: { name?: string; arguments?: string };
          }> | undefined;
          if (toolCallDeltas) {
            for (const tc of toolCallDeltas) {
              const acc = toolCallAccum.get(tc.index) ?? { id: '', name: '', args: '' };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
              toolCallAccum.set(tc.index, acc);
            }
          }

          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        }

        // 解析累积的 tool_calls
        const toolCalls: ToolCall[] = [];
        for (const acc of toolCallAccum.values()) {
          try {
            toolCalls.push({
              id: acc.id,
              name: acc.name,
              arguments: JSON.parse(acc.args || '{}') as Record<string, unknown>,
            });
          } catch { /* 参数不完整则跳过 */ }
        }

        // 流式 tool_calls 逐条发射
        for (const tc of toolCalls) {
          onChunk({ type: 'tool_call', call: tc });
        }

        onChunk({ type: 'done' });

        return createLLMResponse({
          content,
          thinkingContent: this._thinkingContent || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: { promptTokens, completionTokens },
        });
      },
      { onRetry: () => { onChunk({ type: 'reset' }); } },
    );
  }

  // ── 子类可选覆盖的钩子 ──

  /** 构建 tools 参数（默认使用 toOpenAITools） */
  protected _buildTools(tools?: FunctionDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
    return tools?.length ? toOpenAITools(tools) : undefined;
  }

  /** 从响应中提取 ToolCall[]（默认实现带 try/catch 保护） */
  protected _extractToolCalls(
    choice: OpenAI.Chat.Completions.ChatCompletion.Choice,
  ): ToolCall[] | undefined {
    const raw = choice.message.tool_calls;
    if (!raw?.length) return undefined;

    const result: ToolCall[] = [];
    for (const tc of raw) {
      const func = (tc as unknown as Record<string, unknown>).function as
        | { name?: string; arguments?: string }
        | undefined;
      if (!func?.name) continue;
      try {
        result.push({
          id: tc.id,
          name: func.name,
          arguments: JSON.parse(func.arguments ?? '{}') as Record<string, unknown>,
        });
      } catch { /* skip malformed */ }
    }
    return result.length > 0 ? result : undefined;
  }

  /** 处理流式 delta 中的特殊字段（如 reasoning_content），默认空操作 */
  protected _processDelta(
    _delta: Record<string, unknown>,
    _onChunk: (chunk: StreamChunk) => void,
  ): void {
    // 默认无操作，DeepSeek 覆盖以处理 reasoning_content
  }

  /** 流式处理中累积的 thinking 内容（子类 _processDelta 写入，chatStream 自动包含到响应） */
  protected _thinkingContent = '';
}
