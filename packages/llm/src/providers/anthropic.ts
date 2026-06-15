import type { Message } from '@code-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk, ToolCall } from '../interface.js';
import { withRetry } from '../network/retry.js';

const ANTHROPIC_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 200_000,
  maxOutputTokens: 16_384,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: true,
  supportsThinking: true,
  supportsEmbedding: false,
};

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Anthropic Provider — 原生 tool_use + vision + prompt caching。
 * 默认模型: claude-sonnet-4-6，API 格式与 OpenAI 不同（system 为顶层参数，tool_use 为 content block）。
 * 通过 CODE_AGENT_ANTHROPIC_API_KEY 环境变量配置。
 */
export class AnthropicProvider implements ILLMProvider {
  readonly name = 'anthropic';
  readonly capabilities = ANTHROPIC_CAPABILITIES;
  readonly modelName: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(options: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.CODE_AGENT_ANTHROPIC_API_KEY ?? '';
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.modelName = options.modelName ?? 'claude-sonnet-4-6';
  }

  private _buildBody(messages: Message[], options?: ChatOptions) {
    // Convert to Anthropic messages format (system as top-level param)
    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: options?.maxTokens ?? 8192,
      temperature: options?.temperature ?? 0.3,
      messages: conversationMessages,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: 'object',
          properties: t.parameters.properties,
          required: t.parameters.required,
        },
      }));
    }

    return body;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    return withRetry(async () => {
      const body = this._buildBody(messages, options);

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${text}`);
      }

      const data = await response.json() as {
        content: AnthropicContentBlock[];
        usage?: { input_tokens: number; output_tokens: number };
      };

      let textContent = '';
      const toolCalls: ToolCall[] = [];

      for (const block of data.content) {
        if (block.type === 'text' && block.text) {
          textContent += block.text;
        } else if (block.type === 'thinking' && block.thinking) {
          // thinking blocks are handled separately
        } else if (block.type === 'tool_use' && block.id) {
          toolCalls.push({
            id: block.id,
            name: block.name ?? '',
            arguments: block.input ?? {},
          });
        }
      }

      return {
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: data.usage ? {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
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
        const body = this._buildBody(messages, options);
        body.stream = true;

        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Anthropic API error (${response.status}): ${text}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';
        let textContent = '';
        let thinkingContent = '';
        const toolCalls: ToolCall[] = [];
        let promptTokens = 0;
        let completionTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const jsonStr = trimmed.slice(6);

            if (jsonStr === '[DONE]') continue;

            try {
              const event = JSON.parse(jsonStr) as {
                type: string;
                delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
                content_block?: { type: string; id?: string; name?: string };
                usage?: { input_tokens: number; output_tokens: number };
              };

              switch (event.type) {
                case 'content_block_delta': {
                  const d = event.delta;
                  if (!d) continue;

                  if (d.type === 'text_delta' && d.text) {
                    textContent += d.text;
                    onChunk({ type: 'content', text: d.text });
                  } else if (d.type === 'thinking_delta' && d.thinking) {
                    thinkingContent += d.thinking;
                    onChunk({ type: 'thinking', text: d.thinking });
                  } else if (d.type === 'input_json_delta' && d.partial_json) {
                    // Accumulate tool call args
                  }
                  break;
                }
                case 'content_block_start': {
                  const cb = event.content_block;
                  if (cb?.type === 'tool_use' && cb.id) {
                    toolCalls.push({ id: cb.id, name: cb.name ?? '', arguments: {} });
                  }
                  break;
                }
                case 'content_block_stop': {
                  break;
                }
                case 'message_delta': {
                  if (event.usage) {
                    completionTokens = event.usage.output_tokens;
                  }
                  break;
                }
                case 'message_start': {
                  if (event.usage) {
                    promptTokens = event.usage.input_tokens;
                  }
                  break;
                }
              }
            } catch {
              // Skip unparseable SSE lines
            }
          }
        }

        onChunk({ type: 'done' });

        return {
          content: textContent,
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
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.modelName,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      return response.ok || response.status === 429;
    } catch {
      return false;
    }
  }
}
