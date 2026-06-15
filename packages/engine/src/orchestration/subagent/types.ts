import type { ILLMProvider } from '@code-agent/llm';
import type { ToolRegistry } from '../../tools/registry.js';
import type { Capability } from '../../security/capability.js';

/** 子智能体角色（静态定义，不可动态发明） */
export type SubagentRole =
  | 'explorer'
  | 'planner'
  | 'implementer'
  | 'reviewer'
  | 'tester'
  | 'conflictResolver';

/** 子智能体配置 */
export interface SubagentConfig {
  role: SubagentRole;
  /** 唯一实例标识，如 "implementer-worker-A" */
  name: string;
  /** 自然语言描述 */
  description: string;
  /** 角色绑定的静态 System Prompt（非动态生成，经数百次微调保证稳定性） */
  systemPrompt: string;
  /** 该实例使用的 LLM Provider */
  provider: ILLMProvider;
  /** 独立的工具子集（由角色静态决定） */
  tools: ToolRegistry;
  /** 最大循环轮数 */
  maxLoops: number;
  /** 允许的 Capability 列表 */
  allowedCapabilities: Capability[];
  /** 模型温度 */
  temperature?: number;
}

/** 子智能体执行结果（仅将摘要灌回主 Agent，非完整对话） */
export interface SubagentResult {
  success: boolean;
  role: SubagentRole;
  /** 结果摘要（灌回主 Agent） */
  summary: string;
  /** 发现项列表 */
  findings: string[];
  /** 修改的文件列表 */
  filesModified: string[];
  /** Token 消耗 */
  tokensUsed: number;
  /** 费用（美元） */
  costUsd: number;
  /** 执行耗时（毫秒） */
  durationMs: number;
}

/** 子智能体执行任务 */
export interface SubagentTask {
  /** 任务描述 */
  description: string;
  /** 依赖的前置任务 ID */
  dependsOn: string[];
  /** 预期产出的文件 */
  expectedFiles: string[];
}
