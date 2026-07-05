import type { Message, ToolCall, StreamChunk, FunctionDefinition, LLMResponse } from '@customize-agent/types';

// 从 shared 重导出跨包类型（向后兼容）
export type { ToolCall, StreamChunk, FunctionDefinition, LLMResponse };

/** 模型能力声明 */
export interface ModelCapabilities {
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsEmbedding: boolean;
}

/** 单次聊天请求选项 */
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  tools?: FunctionDefinition[];
  signal?: AbortSignal;
}

export interface ImageGenerationOptions {
  size?: '1024x1024' | '1024x1536' | '1536x1024' | '1792x1024' | '1024x1792';
  quality?: 'standard' | 'hd' | 'low' | 'medium' | 'high';
  format?: 'png' | 'jpeg' | 'webp';
  signal?: AbortSignal;
}

export interface ImageGenerationResult {
  mimeType: string;
  data: Buffer;
  revisedPrompt?: string;
}

export interface FileUnderstandingInput {
  name: string;
  mimeType: string;
  data: Buffer;
}

export interface FileUnderstandingOptions {
  signal?: AbortSignal;
  maxTokens?: number;
}

/**
 * LLM Provider 统一接口。
 * 所有模型提供商（DeepSeek, OpenAI, Anthropic 等）必须实现此接口。
 */
export interface ILLMProvider {
  readonly name: string;
  readonly modelName: string;
  readonly capabilities: ModelCapabilities;

  /** 单次聊天（阻塞等待完整响应） */
  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;

  /** 流式聊天（逐字回传 chunk） */
  chatStream(
    messages: Message[],
    onChunk: (chunk: StreamChunk) => void,
    options?: ChatOptions,
  ): Promise<LLMResponse>;

  /** 估算消息 token 数 */
  countTokens(messages: Message[]): Promise<number>;

  /** 健康检查 */
  healthCheck(): Promise<boolean>;

  /** 文本向量化（可选，Embedding 搜索使用） */
  embed?(texts: string[]): Promise<number[][]>;

  /** 单条查询向量化（可选） */
  embedQuery?(query: string): Promise<number[]>;

  /** 图片生成（可选，多模态模型使用） */
  generateImage?(prompt: string, options?: ImageGenerationOptions): Promise<ImageGenerationResult>;

  /** 文件理解（可选，多模态模型使用） */
  understandFiles?(files: FileUnderstandingInput[], prompt: string, options?: FileUnderstandingOptions): Promise<LLMResponse>;
}

/** 默认模型能力（未知 Provider 兜底使用） */
export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
  supportsStreaming: false,
  supportsFunctionCalling: false,
  supportsVision: false,
  supportsThinking: false,
  supportsEmbedding: false,
};
