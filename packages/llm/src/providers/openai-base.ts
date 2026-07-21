import OpenAI from 'openai';
import type { Message, ToolCall } from '@customize-agent/types';
import type { ILLMProvider, LLMResponse, ChatOptions, ModelCapabilities, StreamChunk, FunctionDefinition, ImageGenerationOptions, ImageGenerationResult, FileUnderstandingInput, FileUnderstandingOptions } from '../interface.js';
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
  protected apiKey: string;
  protected baseUrl?: string;
  protected directEndpoint: boolean;

  constructor(params: {
    apiKey?: string;
    baseUrl?: string;
    modelName?: string;
    defaultApiKey?: string;
    defaultBaseUrl?: string;
    defaultModel: string;
    defaultHeaders?: Record<string, string>;
    directEndpoint?: boolean;
  }) {
    this.apiKey = params.apiKey || params.defaultApiKey || 'sk-placeholder';
    this.baseUrl = params.baseUrl ?? params.defaultBaseUrl;
    this.directEndpoint = params.directEndpoint === true;
    this.client = new OpenAI({
      apiKey: this.apiKey, // 占位符避免 SDK 崩溃，空串也回退
      baseURL: this.baseUrl,
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

  async understandFiles(files: FileUnderstandingInput[], prompt: string, options?: FileUnderstandingOptions): Promise<LLMResponse> {
    if (options?.signal?.aborted) throw new Error('File understanding request was aborted');
    return withRetry(async () => {
      const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [{ type: 'text', text: prompt }];
      for (const file of files) {
        if (file.mimeType.startsWith('image/')) {
          content.push({ type: 'text', text: `参考图片：${file.name}` });
          content.push({ type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${file.data.toString('base64')}` } });
        } else {
          content.push({ type: 'text', text: `参考文件：${file.name}（${file.mimeType}，${file.data.length} bytes）。当前 OpenAI-compatible 文件理解接口未上传原始二进制，系统会结合本地解析文本使用该文件。` });
        }
      }
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [{ role: 'user', content }],
        max_tokens: options?.maxTokens,
        temperature: 0.1,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { signal: options?.signal });
      const choice = response.choices[0];
      return createLLMResponse({
        content: choice?.message?.content ?? '',
        usage: response.usage ? { promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens } : undefined,
      });
    }, { signal: options?.signal });
  }

  async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<ImageGenerationResult> {
    return withRetry(async () => this._generateImageWithOpenAICompatibleEndpoint(prompt, options), { signal: options?.signal });
  }

  private async _generateImageWithOpenAICompatibleEndpoint(prompt: string, options?: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const standardBody = {
      model: this.modelName,
      prompt,
      size: options?.size ?? '1536x1024',
      quality: options?.quality ?? 'high',
      n: 1,
    };
    const first = await this._postImageGeneration(standardBody, options);
    if (first.ok) return first.result;
    if (!/field messages is required|messages.*required/iu.test(first.error)) throw new Error(first.error);
    const messagesBody = {
      model: this.modelName,
      messages: [{ role: 'user', content: prompt }],
      size: options?.size ?? '1536x1024',
      quality: options?.quality ?? 'high',
      n: 1,
    };
    const second = await this._postImageGeneration(messagesBody, options);
    if (second.ok) return second.result;
    if (!/Unknown parameter|unknown_parameter/iu.test(second.error)) throw new Error(`${first.error} | ${second.error}`);
    const minimalMessagesBody = {
      model: this.modelName,
      messages: [{ role: 'user', content: prompt }],
    };
    const third = await this._postImageGeneration(minimalMessagesBody, options);
    if (third.ok) return third.result;
    throw new Error(`${first.error} | ${second.error} | ${third.error}`);
  }

  private async _postImageGeneration(body: Record<string, unknown>, options?: ImageGenerationOptions): Promise<{ ok: true; result: ImageGenerationResult } | { ok: false; error: string }> {
    try {
      const response = await fetch(this._endpoint('/images/generations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      const text = await response.text();
      if (!response.ok) return { ok: false, error: `OpenAI-compatible image endpoint error (${response.status}): ${text}` };
      const data = JSON.parse(text) as unknown;
      const image = this._findInlineImage(data);
      if (image) return { ok: true, result: { mimeType: image.mimeType || `image/${options?.format ?? 'png'}`, data: Buffer.from(image.data, 'base64') } };
      const url = this._findImageUrl(data);
      if (url) return { ok: true, result: await this._downloadImageUrl(url, options) };
      const content = this._findTextContent(data);
      if (content?.trim().startsWith('<svg')) return { ok: true, result: { mimeType: 'image/svg+xml', data: Buffer.from(content) } };
      return { ok: false, error: content ? `OpenAI-compatible image endpoint returned text instead of image: ${content.slice(0, 240)}` : `OpenAI-compatible image endpoint returned no image: ${text.slice(0, 300)}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private _findImageUrl(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this._findImageUrl(item);
        if (found) return found;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.url === 'string') return record.url;
    for (const item of Object.values(record)) {
      const found = this._findImageUrl(item);
      if (found) return found;
    }
    return null;
  }

  private async _downloadImageUrl(url: string, options?: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const dataUrl = /^data:(image\/[^;]+);base64,(.+)$/u.exec(url);
    if (dataUrl?.[1] && dataUrl[2]) return { mimeType: dataUrl[1], data: Buffer.from(dataUrl[2], 'base64') };
    const fetched = await fetch(url, { signal: options?.signal });
    if (!fetched.ok) throw new Error(`Failed to download generated image: ${fetched.status}`);
    const contentType = fetched.headers.get('content-type') || `image/${options?.format ?? 'png'}`;
    return { mimeType: contentType, data: Buffer.from(await fetched.arrayBuffer()) };
  }

  private _findTextContent(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      const texts = value.map(item => this._findTextContent(item)).filter((text): text is string => Boolean(text));
      return texts.length > 0 ? texts.join('\n') : null;
    }
    const record = value as Record<string, unknown>;
    for (const key of ['content', 'text', 'output_text']) {
      const field = record[key];
      if (typeof field === 'string' && field.trim()) return field;
      const found = this._findTextContent(field);
      if (found) return found;
    }
    const message = record.message;
    if (message && typeof message === 'object') {
      const found = this._findTextContent(message);
      if (found) return found;
    }
    const choices = record.choices;
    if (Array.isArray(choices)) {
      const found = this._findTextContent(choices);
      if (found) return found;
    }
    return null;
  }

  private _findInlineImage(value: unknown): { mimeType?: string; data: string } | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const inline = record.inlineData || record.inline_data;
    if (inline && typeof inline === 'object') {
      const inlineRecord = inline as Record<string, unknown>;
      if (typeof inlineRecord.data === 'string') return { mimeType: typeof inlineRecord.mimeType === 'string' ? inlineRecord.mimeType : typeof inlineRecord.mime_type === 'string' ? inlineRecord.mime_type : undefined, data: inlineRecord.data };
    }
    if (typeof record.b64_json === 'string') return { data: record.b64_json };
    for (const item of Object.values(record)) {
      if (Array.isArray(item)) {
        for (const child of item) {
          const found = this._findInlineImage(child);
          if (found) return found;
        }
      } else {
        const found = this._findInlineImage(item);
        if (found) return found;
      }
    }
    return null;
  }

  private _endpoint(suffix: string) {
    const base = (this.baseUrl || '').replace(/\/$/u, '');
    return this.directEndpoint ? base : `${base}${suffix}`;
  }

  private async _postChat(messages: Message[], options?: ChatOptions): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const body = {
      model: this.modelName,
      messages: toOpenAIMessages(messages),
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens,
      tools: this._buildTools(options?.tools),
    };
    if (!this.directEndpoint) return this.client.chat.completions.create(body as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { signal: options?.signal });
    const first = await this._postDirectChat(body, options);
    if (first.ok) return first.response;
    if (!/temperature.*default|unsupported.*temperature|Unsupported value: 'temperature'/iu.test(first.error)) throw new Error(first.error);
    const { temperature: _temperature, ...retryBody } = body;
    const second = await this._postDirectChat(retryBody, options);
    if (second.ok) return second.response;
    throw new Error(`${first.error} | ${second.error}`);
  }

  private async _postDirectChat(body: Record<string, unknown>, options?: ChatOptions): Promise<{ ok: true; response: OpenAI.Chat.Completions.ChatCompletion } | { ok: false; error: string }> {
    const response = await fetch(this._endpoint('/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, error: `OpenAI-compatible chat endpoint error (${response.status}): ${text}` };
    return { ok: true, response: JSON.parse(text) as OpenAI.Chat.Completions.ChatCompletion };
  }

  // ── chat 模板方法 ──

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    return withRetry(async () => {
      const response = await this._postChat(messages, options);

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
    }, { signal: options?.signal });
  }

  // ── chatStream 模板方法 ──

  async chatStream(
    messages: Message[],
    onChunk: (chunk: StreamChunk) => void,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    if (this.directEndpoint) {
      const response = await this.chat(messages, options);
      if (response.content) onChunk({ type: 'content', text: response.content });
      for (const call of response.toolCalls ?? []) onChunk({ type: 'tool_call', call });
      onChunk({ type: 'done' });
      return response;
    }
    return withRetry(
      async () => {
        const stream = await this.client.chat.completions.create({
          model: this.modelName,
          messages: toOpenAIMessages(messages),
          temperature: options?.temperature ?? 0.2,
          max_tokens: options?.maxTokens,
          tools: this._buildTools(options?.tools),
          stream: true,
        }, { signal: options?.signal });

        let content = '';
        this._thinkingContent = '';
        const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
        const previewedToolCalls = new Set<number>();
        let promptTokens = 0;
        let completionTokens = 0;

        for await (const chunk of stream) {
          if (options?.signal?.aborted) throw new Error('Chat stream request was aborted');
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
              if (acc.name && !previewedToolCalls.has(tc.index)) {
                previewedToolCalls.add(tc.index);
                onChunk({ type: 'tool_call_preview', id: acc.id || `call_${tc.index}`, name: acc.name });
              }
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
      { signal: options?.signal, onRetry: () => { onChunk({ type: 'reset' }); } },
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
      } catch { /* 跳过格式错误的工具调用 */ }
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
