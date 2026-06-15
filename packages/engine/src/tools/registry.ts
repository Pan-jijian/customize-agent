/** JSON Schema 工具参数定义 */
export interface JSONSchema {
  type: string;
  properties?: Record<string, { type: string; description: string; enum?: string[] }>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 已注册的工具描述 */
export interface RegisteredTool {
  /** 工具唯一名称（LLM function calling 使用） */
  name: string;
  /** 工具功能描述 */
  description: string;
  /** 参数 JSON Schema */
  parameters: JSONSchema;
  /** 是否需要用户审批 */
  requiresApproval: boolean;
  /** 绑定的 Capability（权限检查用） */
  capabilities: string[];
  /** 工具执行函数 */
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * 工具注册表 — 注册、查找、分发。
 * 不关心 Schema 格式、权限检查、MCP 导出（这些由 SchemaAdapter/ PermissionEngine/MCPAdapter 各自负责）。
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  /** 注册一个工具（重复名称会抛异常） */
  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`[ToolRegistry] Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 按名称分发执行工具 */
  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Unknown tool: "${name}". Available tools: ${this.listNames().join(', ')}`;
    }
    return tool.handler(args);
  }

  /** 按名称查找工具 */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** 列出全部已注册工具 */
  listAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /** 列出全部工具名称 */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
