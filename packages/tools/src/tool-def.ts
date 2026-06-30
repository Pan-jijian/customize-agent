// @customize-agent/tools — 工具声明式定义

export interface ToolParamDef {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  enum?: string[];
}

export interface ToolDef {
  /** 工具名称（LLM 可见） */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数 Schema */
  params: Record<string, ToolParamDef>;
  /** 必填参数 */
  required: string[];
  /** 所需能力 */
  capabilities: string[];
  /** 是否需要用户审批 */
  needsApproval: boolean;
}
