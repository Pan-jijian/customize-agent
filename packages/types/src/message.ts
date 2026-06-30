// @customize-agent/types — Message & LLM 响应类型

/** 消息体 — Agent 与 LLM 之间的对话单元 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 原生 function calling: assistant 消息中返回的工具调用列表 */
  toolCalls?: ToolCall[];
  /** 原生 function calling: tool 消息中的 tool_call_id */
  toolCallId?: string;
}

/**
 * LLM 返回体 — 单次模型调用的完整响应。
 *
 * 设计原则 (ADR-20 厂商无关抽象):
 *   - 所有字段为所有厂商能力的超集
 *   - 厂商不支持某字段时填入 undefined（不删除字段）
 *   - vendorExtensions 收容厂商特有数据，避免核心类型随厂商变更而修改
 */
export interface LLMResponse {
  content: string;
  thinkingContent?: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
  /** 厂商特有扩展字段（如 x-openai-*, x-anthropic-* 前缀命名空间） */
  vendorExtensions?: Record<string, unknown>;
}

/**
 * 单次工具调用 — LLM function calling / tool_use 的抽象表示。
 * 对齐 MCP CallToolResult 语义，是各厂商原生格式的超集。
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** 厂商特有扩展（如 Anthropic 的 tool_use 原始 content_block） */
  vendorExtensions?: Record<string, unknown>;
}

/** 流式输出的切块类型 — Provider 无关的流式事件 */
export type StreamChunk =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call_preview'; id: string; name: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'error'; message: string }
  | { type: 'reset' }
  | { type: 'done' };

/**
 * Function calling 工具定义（Provider 无关的抽象格式）。
 * 基于 JSON Schema 子集，所有厂商均可表达。
 */
export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** 厂商特有扩展 */
  vendorExtensions?: Record<string, unknown>;
}
