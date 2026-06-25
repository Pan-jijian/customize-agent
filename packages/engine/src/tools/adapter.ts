import type { ToolRegistry } from './registry.js';

/** OpenAI function calling 格式 */
export interface OpenAIFunctionDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
      additionalProperties: boolean;
    };
  };
}

/** Anthropic tool_use 格式 */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

/** MCP tools/list 工具格式（仅保留 type + description，剥离 enum/additionalProperties） */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

/**
 * Schema 适配器 — 将 ToolRegistry 中的工具定义转换为各 Provider/协议原生格式。
 * 新增 Provider 或协议时只改这里，不碰 ToolRegistry。
 */
export class SchemaAdapter {
  /** 转为 OpenAI / DeepSeek function calling 工具定义 */
  static toOpenAIFunctions(registry: ToolRegistry): OpenAIFunctionDefinition[] {
    return registry.listAll().map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object' as const,
          properties: tool.parameters.properties ?? {},
          required: tool.parameters.required,
          additionalProperties: tool.parameters.additionalProperties ?? false,
        },
      },
    }));
  }

  /** 转为 Anthropic tool_use 工具定义 */
  static toAnthropicTools(registry: ToolRegistry): AnthropicToolDefinition[] {
    return registry.listAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: tool.parameters.properties ?? {},
        required: tool.parameters.required,
      },
    }));
  }

  /** 转为 MCP tools/list 工具定义（仅保留 type + description，剥离枚举约束） */
  static toMcpTools(registry: ToolRegistry): McpToolDefinition[] {
    return registry.listAll().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(t.parameters.properties ?? {}).map(([k, v]) => [
            k, { type: v.type, description: v.description },
          ]),
        ),
        required: t.parameters.required,
      },
    }));
  }
}
