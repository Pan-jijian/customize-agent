import { Capability } from '../security/capability.js';

/** 执行计划的单一步骤 */
export interface PlanStep {
  /** 步骤编号 */
  id: number;
  /** 步骤描述 */
  description: string;
  /** 使用的工具 */
  tool: string;
  /** 目标文件 */
  file: string;
  /** 预期结果 */
  expectedOutcome: string;
  /** 依赖的前置步骤 ID */
  dependsOn: number[];
  /** 验证命令 */
  validation: string;
}

/** 结构化执行计划 — Planner 只读探索后输出的 JSON */
export interface ExecutionPlan {
  /** 任务目标 */
  goal: string;
  /** 技术方案 */
  approach: string;
  /** 复杂度：simple / medium / complex */
  complexity: 'simple' | 'medium' | 'complex';
  /** 需要修改的文件列表 */
  filesToModify: string[];
  /** 需要新建的文件列表 */
  filesToCreate: string[];
  /** 有序执行步骤 */
  steps: PlanStep[];
  /** 潜在风险 */
  risks: string[];
  /** 回滚策略 */
  rollbackStrategy: string;
}

/** Planner System Prompt — 只读探索 → 输出结构化 JSON 计划 */
const PLANNER_SYSTEM_PROMPT = `You are a Code Planner. Your job is to analyze the codebase and produce a structured execution plan.

You have READ-ONLY access to search tools. You CANNOT modify files or execute commands.

Workflow:
1. Explore the codebase to understand the current architecture
2. Identify all files that need to be modified or created
3. Define ordered steps with dependencies
4. Specify validation commands for each step
5. Output the plan in strict JSON format

Output ONLY the following JSON structure (no markdown wrapping):

{
  "goal": "任务目标的一句话描述",
  "approach": "技术方案的简述",
  "complexity": "simple|medium|complex",
  "filesToModify": ["path/to/file.ts"],
  "filesToCreate": ["path/to/new.ts"],
  "steps": [
    {
      "id": 1,
      "description": "具体做什么",
      "tool": "edit_file/write_file 或 execute_command",
      "file": "目标文件路径",
      "expectedOutcome": "预期结果",
      "dependsOn": [],
      "validation": "验证命令，如 pnpm build"
    }
  ],
  "risks": ["潜在风险"],
  "rollbackStrategy": "回滚方式"
}`;

/**
 * Plan Mode 管理器。
 * 双阶段工作流：
 *   Phase A: Planner（只读 Capability）探索 → 输出执行计划
 *   Phase B: 用户审批 → Implementer（完整 Capability）按计划执行
 */
export class PlanModeManager {
  /** Planner 可用的 Capability（只读 + 搜索 + LSP + Embedding） */
  static readonly PLANNER_CAPABILITIES: Capability[] = [
    Capability.READ_CODE,
    Capability.SEARCH_SYMBOL,
    Capability.LSP_QUERY,
    Capability.EMBEDDING_SEARCH,
  ];

  /** 获取 Planner System Prompt */
  static getSystemPrompt(): string {
    return PLANNER_SYSTEM_PROMPT;
  }

  /** 验证 LLM 输出的 JSON 是否为合法的执行计划 */
  static validatePlan(json: unknown): { valid: boolean; plan?: ExecutionPlan; errors: string[] } {
    const errors: string[] = [];

    if (!json || typeof json !== 'object') {
      return { valid: false, errors: ['计划必须是 JSON 对象'] };
    }

    const plan = json as Record<string, unknown>;

    if (typeof plan.goal !== 'string' || !plan.goal) errors.push('缺少 goal');
    if (typeof plan.approach !== 'string' || !plan.approach) errors.push('缺少 approach');
    if (!['simple', 'medium', 'complex'].includes(String(plan.complexity))) errors.push('complexity 必须是 simple/medium/complex');
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) errors.push('steps 必须是非空数组');
    if (!Array.isArray(plan.risks)) errors.push('risks 必须是数组');

    // 验证每个步骤
    if (Array.isArray(plan.steps)) {
      for (const step of plan.steps as Array<Record<string, unknown>>) {
        if (typeof step.id !== 'number') errors.push(`步骤 ${JSON.stringify(step)} 缺少 id`);
        if (typeof step.description !== 'string') errors.push(`步骤 ${JSON.stringify(step)} 缺少 description`);
        if (typeof step.tool !== 'string') errors.push(`步骤 ${JSON.stringify(step)} 缺少 tool`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      plan: {
        goal: String(plan.goal),
        approach: String(plan.approach),
        complexity: String(plan.complexity) as ExecutionPlan['complexity'],
        filesToModify: Array.isArray(plan.filesToModify) ? plan.filesToModify.map(String) : [],
        filesToCreate: Array.isArray(plan.filesToCreate) ? plan.filesToCreate.map(String) : [],
        steps: (plan.steps as Array<Record<string, unknown>>).map(s => ({
          id: Number(s.id),
          description: String(s.description),
          tool: String(s.tool),
          file: String(s.file ?? ''),
          expectedOutcome: String(s.expectedOutcome ?? ''),
          dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(Number) : [],
          validation: String(s.validation ?? ''),
        })),
        risks: Array.isArray(plan.risks) ? plan.risks.map(String) : [],
        rollbackStrategy: String(plan.rollbackStrategy ?? 'git checkout -- .'),
      },
      errors: [],
    };
  }

  /** 格式化计划为可读文本（用户审批时展示） */
  static formatPlan(plan: ExecutionPlan): string {
    const lines = [
      '═══════════════════════════════════',
      `目标: ${plan.goal}`,
      `方案: ${plan.approach}`,
      `复杂度: ${plan.complexity}`,
      '───────────────────────────────────',
      `拟修改文件 (${plan.filesToModify.length}):`,
      ...plan.filesToModify.map(f => `  - ${f}`),
      `拟新建文件 (${plan.filesToCreate.length}):`,
      ...plan.filesToCreate.map(f => `  + ${f}`),
      '───────────────────────────────────',
      `执行步骤 (${plan.steps.length}):`,
      ...plan.steps.map(s =>
        `  ${s.id}. [${s.tool}] ${s.description} ${s.dependsOn.length > 0 ? `(依赖: ${s.dependsOn.join(',')})` : ''}`
      ),
      '───────────────────────────────────',
      `风险:`,
      ...plan.risks.map(r => `  ⚠ ${r}`),
      `回滚策略: ${plan.rollbackStrategy}`,
      '═══════════════════════════════════',
    ];
    return lines.join('\n');
  }
}
