/**
 * 轻量级 LLM 搜索 Provider 接口。
 *
 * 定义在 knowledge 包内部，避免直接依赖 @customize-agent/llm。
 * CLI 层的 ILLMProvider 在结构上兼容此接口，可直接传入。
 *
 * 接入状态（P1-10 检索语义澄清）：当前未接入。
 * apps/server 的 getMultiProjectManager() 刻意不注入 llmProvider（见 kbService.ts），
 * 检索查询重写因此退化为本地规则扩展；若未来启用，需配独立低并发 LLM 通道，
 * 避免与文档正文生成争抢全局 LLM 信号量。
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
