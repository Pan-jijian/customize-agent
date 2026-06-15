import type { Message } from '@code-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk } from '../interface.js';
import { withRetry } from '../network/retry.js';

/** Google Gemini 模型能力声明 */
const GEMINI_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 1_000_000,
  maxOutputTokens: 8_192,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: true,
  supportsThinking: true,
  supportsEmbedding: false,
};

interface GeminiContent {
  role: string;
  parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }>;
}

/**
 * Google Gemini Provider — 支持 100 万 token 上下文窗口。
 * 默认模型: gemini-2.5-pro，通过 CODE_AGENT_GOOGLE_API_KEY 环境变量配置。
 */
export class GoogleProvider implements ILLMProvider {
  readonly name = 'google';
  readonly capabilities = GEMINI_CAPABILITIES;
  readonly modelName: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(options: { apiKey?: string; modelName?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.CODE_AGENT_GOOGLE_API_KEY ?? '';
    this.modelName = options.modelName ?? 'gemini-2.5-pro';
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}`;
  }

  private _convertMessages(messages: Message[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        // Gemini 将 system 转为第一个 user 消息的前缀
        contents.push({
          role: 'user',
          parts: [{ text: `[System Instruction]: ${m.content}` }],
        });
        // 紧跟着一个 model 确认
        contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
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

      const url = `${this.baseUrl}:generateContent?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Google API error (${response.status}): ${text}`);
      }

      const data = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
      };

      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map(p => p.text ?? '').join('') ?? '';

      return {
        content: text,
        usage: data.usageMetadata ? {
          promptTokens: data.usageMetadata.promptTokenCount,
          completionTokens: data.usageMetadata.candidatesTokenCount,
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
        const contents = this._convertMessages(messages);
        const body: Record<string, unknown> = {
          contents,
          generationConfig: {
            temperature: options?.temperature ?? 0.2,
            maxOutputTokens: options?.maxTokens ?? 8192,
          },
        };

        const url = `${this.baseUrl}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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
                candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
                usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
              };

              const text = event.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('');
              if (text) {
                textContent += text;
                onChunk({ type: 'content', text });
              }
              if (event.usageMetadata?.promptTokenCount) {
                promptTokens = event.usageMetadata.promptTokenCount;
              }
              if (event.usageMetadata?.candidatesTokenCount) {
                completionTokens = event.usageMetadata.candidatesTokenCount;
              }
            } catch {
              // 跳过无法解析的 SSE 行
            }
          }
        }

        onChunk({ type: 'done' });

        return {
          content: textContent,
          usage: { promptTokens, completionTokens },
        };
      },
      { onRetry: () => { onChunk({ type: 'reset' }); } },
    );
  }

  async countTokens(messages: Message[]): Promise<number> {
    try {
      const contents = this._convertMessages(messages);
      const url = `${this.baseUrl}:countTokens?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const response = await fetch(`${this.baseUrl}:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
