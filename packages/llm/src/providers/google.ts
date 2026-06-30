import type { Message } from '@customize-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk } from '../interface.js';
import { withRetry } from '../retry.js';
import { createLLMResponse } from '../utils/response.js';

/** Google Gemini 模型能力声明 */
const GOOGLE_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 1_000_000,
  maxOutputTokens: 8_192,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: true,
  supportsThinking: true,
  supportsEmbedding: false,
};

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

/**
 * Google Gemini Provider — 支持 100 万 token 上下文窗口。
 * 默认模型: gemini-2.5-pro，通过 CUSTOMIZE_AGENT_GOOGLE_API_KEY 环境变量配置。
 */
export class GoogleProvider implements ILLMProvider {
  readonly name = 'google';
  readonly capabilities = GOOGLE_CAPABILITIES;
  readonly modelName: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(options: { apiKey?: string; modelName?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.CUSTOMIZE_AGENT_GOOGLE_API_KEY ?? '';
    this.modelName = options.modelName ?? 'gemini-2.5-pro';
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}`;
  }

  private _convertMessages(messages: Message[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        contents.push({ role: 'user', parts: [{ text: `[System Instruction]: ${m.content}` }] });
        contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
      } else if (m.role === 'tool') {
        // tool 消息转为 Gemini functionResponse 格式
        contents.push({ role: 'function', parts: [{ functionResponse: { name: m.toolCallId ?? '', response: { result: m.content } } } as unknown as { text?: string }] });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        // assistant 中的 tool_calls 转为 Gemini functionCall 格式
        const parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
        contents.push({ role: 'model', parts });
      } else {
        const role = m.role === 'assistant' ? 'model' : 'user';
        contents.push({ role, parts: [{ text: m.content }] });
      }
    }
    return contents;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    return withRetry(async () => {
      const contents = this._convertMessages(messages);
      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: options?.temperature ?? 0.2,
          maxOutputTokens: options?.maxTokens ?? 8192,
        },
      };
      if (options?.tools?.length) {
        body.tools = [{ functionDeclarations: options.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      }

      const url = `${this.baseUrl}:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Google API error (${response.status}): ${text}`);
      }

      const data = await response.json() as {
        candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
        usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
      };

      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const text = parts.filter(p => p.text).map(p => p.text).join('');

      // 提取 functionCall
      const toolCalls = parts
        .filter(p => p.functionCall)
        .map((p, i) => ({
          id: `call_${i}`,
          name: p.functionCall!.name,
          arguments: p.functionCall!.args,
        }));

      return createLLMResponse({
        content: text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: data.usageMetadata ? {
          promptTokens: data.usageMetadata.promptTokenCount,
          completionTokens: data.usageMetadata.candidatesTokenCount,
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
        const contents = this._convertMessages(messages);
        const body: Record<string, unknown> = {
          contents,
          generationConfig: {
            temperature: options?.temperature ?? 0.2,
            maxOutputTokens: options?.maxTokens ?? 8192,
          },
        };
        if (options?.tools?.length) {
          body.tools = [{ functionDeclarations: options.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
        }

        const url = `${this.baseUrl}:streamGenerateContent?alt=sse`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Google API error (${response.status}): ${text}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';
        let textContent = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let tcIdx = 0;

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

            try {
              const event = JSON.parse(jsonStr) as {
                candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
                usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
              };

              const parts = event.candidates?.[0]?.content?.parts ?? [];
              for (const p of parts) {
                if (p.text) {
                  textContent += p.text;
                  onChunk({ type: 'content', text: p.text });
                }
                if (p.functionCall) {
                  onChunk({ type: 'tool_call', call: { id: `call_${tcIdx++}`, name: p.functionCall.name, arguments: p.functionCall.args } });
                }
              }
              if (event.usageMetadata?.promptTokenCount) promptTokens = event.usageMetadata.promptTokenCount;
              if (event.usageMetadata?.candidatesTokenCount) completionTokens = event.usageMetadata.candidatesTokenCount;
            } catch {
              // 跳过无法解析的 SSE 行
            }
          }
        }

        onChunk({ type: 'done' });

        return createLLMResponse({
          content: textContent,
          usage: { promptTokens, completionTokens },
        });
      },
      { onRetry: () => { onChunk({ type: 'reset' }); } },
    );
  }

  async countTokens(messages: Message[]): Promise<number> {
    try {
      const contents = this._convertMessages(messages);
      const url = `${this.baseUrl}:countTokens`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({ contents }),
      });
      if (response.ok) {
        const data = await response.json() as { totalTokens: number };
        return data.totalTokens;
      }
    } catch { /* fallback */ }
    const text = messages.map(m => m.content).join('\n');
    return Math.ceil(text.length / 4);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
