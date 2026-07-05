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

  async understandFiles(files: FileUnderstandingInput[], prompt: string, options?: FileUnderstandingOptions): Promise<LLMResponse> {
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
    });
  }

  async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<ImageGenerationResult> {
    return withRetry(async () => {
      const response = await this.client.images.generate({
        model: this.modelName,
        prompt,
        size: options?.size ?? '1536x1024',
        quality: options?.quality ?? 'high',
        n: 1,
      } as OpenAI.Images.ImageGenerateParams, { signal: options?.signal }) as unknown as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
      const image = response.data?.[0];
      if (!image) throw new Error('Image generation returned empty data');
      if (image.b64_json) return { mimeType: `image/${options?.format ?? 'png'}`, data: Buffer.from(image.b64_json, 'base64'), revisedPrompt: image.revised_prompt };
      if (image.url) {
        const fetched = await fetch(image.url, { signal: options?.signal });
        if (!fetched.ok) throw new Error(`Failed to download generated image: ${fetched.status}`);
        const contentType = fetched.headers.get('content-type') || `image/${options?.format ?? 'png'}`;
        return { mimeType: contentType, data: Buffer.from(await fetched.arrayBuffer()), revisedPrompt: image.revised_prompt };
      }
      throw new Error('Image generation returned no URL or base64 data');
    });
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
        }, { signal: options?.signal });

        let content = '';
        this._thinkingContent = '';
        const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
        const previewedToolCalls = new Set<number>();
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
