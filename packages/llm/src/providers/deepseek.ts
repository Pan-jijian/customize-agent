import OpenAI from 'openai';
import type { Message, ToolCall } from '@code-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk, FunctionDefinition } from '../interface.js';
import { withRetry } from '../network/retry.js';

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

/** 将内部 Message 转为 OpenAI 格式，处理 tool_calls 和 tool_call_id */
function toOpenAIMessage(m: Message): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
  }

  if (m.role === 'tool' && m.toolCallId) {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId,
      content: m.content,
    } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
  }

  return {
    role: m.role as 'system' | 'user' | 'assistant',
    content: m.content,
  };
}

/** 将内部 FunctionDefinition 转为 OpenAI tools 格式 */
function toOpenAITools(tools: FunctionDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** 从 OpenAI 响应中提取 ToolCall[]，处理 ChatCompletionMessageToolCall 联合类型 */
function extractToolCalls(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined,
): ToolCall[] | undefined {
  const raw = choice?.message?.tool_calls;
  if (!raw?.length) return undefined;

  const result: ToolCall[] = [];
  for (const tc of raw) {
    // ChatCompletionMessageToolCall 是联合类型，只有标准类型才有 function 属性
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

/**
 * DeepSeek Provider — 基于 OpenAI 兼容 API，支持 reasoning_content 思维链提取 + 原生 function calling。
 * 默认模型: deepseek-v4-flash，可通过 CODE_AGENT_DEEPSEEK_API_KEY 配置。
 */
export class DeepSeekProvider implements ILLMProvider {
  readonly name = 'deepseek';
  readonly capabilities = DEEPSEEK_CAPABILITIES;
  readonly modelName: string;
  private client: OpenAI;

  constructor(options: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.CODE_AGENT_DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1',
    });
    this.modelName = options.modelName ?? process.env.DEEPSEEK_MODEL_NAME ?? 'deepseek-v4-flash';
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    return withRetry(async () => {
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: messages.map(toOpenAIMessage),
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens,
        tools: options?.tools?.length ? toOpenAITools(options.tools) : undefined,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error('LLM returned empty choices');

      const msg = choice.message as { reasoning_content?: string; content?: string | null };
      return {
        content: msg.content ?? '',
        thinkingContent: msg.reasoning_content,
        toolCalls: extractToolCalls(choice),
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
          messages: messages.map(toOpenAIMessage),
          temperature: options?.temperature ?? 0.2,
          max_tokens: options?.maxTokens,
          tools: options?.tools?.length ? toOpenAITools(options.tools) : undefined,
          stream: true,
        });

        let content = '';
        let thinkingContent = '';
        let promptTokens = 0;
        let completionTokens = 0;

        // 流式 tool_calls 累积: index → { id, name, arguments }
        const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          // thinking 内容
          if (typeof delta.reasoning_content === 'string') {
            thinkingContent += delta.reasoning_content;
            onChunk({ type: 'thinking', text: delta.reasoning_content });
          }

          // 文本内容
          if (typeof delta.content === 'string') {
            content += delta.content;
            onChunk({ type: 'content', text: delta.content });
          }

          // 流式 tool_calls 增量
          const toolCallDeltas = delta.tool_calls as Array<{
            index: number; id?: string; function?: { name?: string; arguments?: string };
          }> | undefined;
          if (toolCallDeltas) {
            for (const tcDelta of toolCallDeltas) {
              const acc = toolCallAccum.get(tcDelta.index) ?? { id: '', name: '', args: '' };
              if (tcDelta.id) acc.id = tcDelta.id;
              if (tcDelta.function?.name) acc.name = tcDelta.function.name;
              if (tcDelta.function?.arguments) acc.args += tcDelta.function.arguments;
              toolCallAccum.set(tcDelta.index, acc);
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
              arguments: JSON.parse(acc.args) as Record<string, unknown>,
            });
          } catch {
            // 参数不完整则跳过
          }
        }

        // 流式 tool_calls 逐条发射
        for (const tc of toolCalls) {
          onChunk({ type: 'tool_call', call: tc });
        }

        onChunk({ type: 'done' });

        return {
          content,
          thinkingContent: thinkingContent || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: { promptTokens, completionTokens },
        };
      },
      { onRetry: (_a, _e) => { onChunk({ type: 'reset' }); } },
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
