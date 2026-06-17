import type { LLMResponse } from '@code-agent/types';

/**
 * LLMResponse 构造工厂 — 所有 Provider 必须通过此函数构建响应。
 *
 * 设计目的 (ADR-20):
 *   1. 单一入口 → 新增字段时所有 Provider 自动获得类型检查覆盖
 *   2. 厂商特有数据 → vendorExtensions 统一收容
 */
export function createLLMResponse(params: {
  content: string;
  thinkingContent?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    vendorExtensions?: Record<string, unknown>;
  }>;
  usage?: { promptTokens: number; completionTokens: number };
  vendorExtensions?: Record<string, unknown>;
}): LLMResponse {
  return {
    content: params.content,
    thinkingContent: params.thinkingContent,
    toolCalls: params.toolCalls as LLMResponse['toolCalls'],
    usage: params.usage,
    vendorExtensions: params.vendorExtensions,
  };
}
