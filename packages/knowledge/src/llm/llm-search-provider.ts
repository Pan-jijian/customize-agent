/**
 * 轻量级 LLM 搜索 Provider 接口。
 *
 * 定义在 knowledge 包内部，避免直接依赖 @customize-agent/llm。
 * CLI 层的 ILLMProvider 在结构上兼容此接口，可直接传入。
 */
export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface LLMChatResponse {
  content: string;
}

/**
 * LLM 搜索 Provider —— 用于查询扩展和语义重排序。
 */
export interface LLMSearchProvider {
  chat(messages: LLMChatMessage[], options?: LLMChatOptions): Promise<LLMChatResponse>;
}
