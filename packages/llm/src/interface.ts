import type { Message, ToolCall, StreamChunk, FunctionDefinition, LLMResponse } from '@customize-agent/types';

// 从 shared 重导出跨包类型（向后兼容）
export type { ToolCall, StreamChunk, FunctionDefinition, LLMResponse };

export type ThinkingDisableMode =
  /** DeepSeek：extra_body {"thinking":{"type":"disabled"}}（思考与正文共享输出池） */
  | 'deepseek-thinking'
  /** OpenAI GPT-5 系列：{"reasoning":{"effort":"none"}}（none 等同非推理模型） */
  | 'openai-reasoning-effort'
  /** 通义千问 Qwen3 混合推理：{"enable_thinking": false} */
  | 'qwen-enable-thinking'
  /** 智谱 GLM：{"thinking":{"type":"disabled"}}（接入时按官方文档验证参数格式） */
  | 'glm-thinking'
  /** Gemini：thinkingBudget:0（仅 2.5 系列有效，3.x 忽略） */
  | 'gemini-budget'
  /** 模型不支持关闭思考（如 Gemini 3/3.1 Pro） */
  | 'unsupported';

/**
 * 思考能力画像：描述模型的思维链行为与关闭方式。
 * 思考策略必须按模型能力自适应（不是所有模型都能关思考），
 * 新增模型（qwen/glm 等）只需在 MODEL_THINKING_PROFILES 注册一条画像。
 */
export interface ThinkingCapability {
  /** 模型默认是否开启思考 */
  defaultEnabled: boolean;
  /** 关闭思考的方式（厂商 API 格式） */
  disable: ThinkingDisableMode;
  /** 思考 token 与正文输出池的关系：shared=共享同一预算池（思考抢正文）、separate=独立预算 */
  budgetPolicy: 'shared' | 'separate';
}

/** 模型能力声明 */
export interface ModelCapabilities {
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsEmbedding: boolean;
  /** 思考能力画像（可选）：声明后 supportsThinking 以画像为准 */
  thinking?: ThinkingCapability;
}

/** 单次聊天请求选项 */
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  tools?: FunctionDefinition[];
  signal?: AbortSignal;
  /** 关闭模型思考（思维链）：provider 按模型能力翻译为厂商参数；模型不支持时抛出显式错误 */
  disableThinking?: boolean;
  /** 透传给厂商 API 的原生参数（如 thinking、reasoning 等），顶层合并进请求体 */
  extraBody?: Record<string, unknown>;
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
