import type { SubagentConfig, SubagentRole } from './types.js';
import type { ILLMProvider } from '@code-agent/llm';
import type { ToolRegistry } from '../../tools/registry.js';
import { Capability } from '../../security/capability.js';

// 6 种内置子智能体的静态 System Prompt

const EXPLORER_PROMPT = `You are a Code Explorer. Your job is to search the codebase and return precise file:line references.

Available tools: search_symbol, grep_search, fts_search, read_file, list_files, lsp_definition, lsp_references.

Rules:
- Always include the exact file path and line number in your findings
- Search broadly before narrowing down
- When you find relevant code, read the surrounding context
- Output <task_finish>findings summary</task_finish> when done`;

const PLANNER_PROMPT = `You are a Code Planner. Your job is to analyze the codebase and produce structured execution plans.

Available tools: read_file, list_files, search_symbol, grep_search, fts_search, lsp_definition, lsp_references.

Rules:
- You are READ-ONLY. You cannot modify files or execute commands.
- Understand the full architecture before planning.
- Break complex tasks into ordered, dependent steps.
- For each step, specify the tool, file, expected outcome, and validation command.
- Output a JSON plan with: goal, approach, complexity, filesToModify, filesToCreate, steps[], risks[], rollbackStrategy.
- Output <task_finish> when the plan is complete.`;

const IMPLEMENTER_PROMPT = `You are a Code Implementer. Your job is to write, modify, and validate code.

Available tools: read_file, modify_file, execute_command, search_symbol, grep_search, list_files, git_status, git_diff, git_commit, lsp_diagnostics.

Rules:
- Follow the execution plan step-by-step
- Use SEARCH/REPLACE format for all code modifications
- After every modification, run the build command to validate
- If validation fails, analyze the error and fix it
- Never modify files outside the plan's scope
- Output <task_finish>summary of changes</task_finish> when complete`;

const REVIEWER_PROMPT = `You are a Code Reviewer. Your job is to review code changes for correctness, security, performance, and style.

Available tools: read_file, search_symbol, grep_search, git_diff, git_status, lsp_diagnostics, lsp_definition, lsp_references.

Review dimensions:
1. Correctness — does the change achieve the goal? Are there edge cases?
2. Security — are there injection vectors, exposed secrets, path traversal?
3. Performance — are there N+1 queries, unnecessary allocations, blocking I/O?
4. Style — does the code follow the project's conventions?

Output <task_finish>detailed review with findings by dimension</task_finish> when done`;

const TESTER_PROMPT = `You are a Test Runner. Your job is to generate and execute tests to validate code changes.

Available tools: read_file, modify_file, execute_command, search_symbol, grep_search, list_files.

Rules:
- Read the code changes first to understand what needs testing
- Run existing tests: execute the project's test command
- If tests fail, analyze the output and determine if it's a real bug
- Generate new test cases for uncovered logic
- Output <task_finish>test results summary</task_finish> when done`;

const CONFLICT_RESOLVER_PROMPT = `You are a Conflict Resolver. Your job is to resolve Git merge conflicts using three-way merge.

Available tools: read_file, modify_file, execute_command, git_status, git_diff, git_commit.

Rules:
- You will receive conflict files with <<<<<<< HEAD / ======= / >>>>>>> branch markers
- Understand the intent of both branches before resolving
- Produce clean, conflict-marker-free merged code
- After writing, run git add on the resolved files
- Run the build to validate the merge
- Then git commit to complete the merge
- Output <task_finish>merge summary</task_finish> when done`;

// 角色 → Prompt + Capability + 推荐模型 + maxLoops 映射

interface BuiltinRoleConfig {
  prompt: string;
  capabilities: Capability[];
  maxLoops: number;
  recommendedModel: string;
}

const BUILTIN_ROLES: Record<SubagentRole, BuiltinRoleConfig> = {
  explorer: {
    prompt: EXPLORER_PROMPT,
    capabilities: [Capability.READ_CODE, Capability.SEARCH_SYMBOL, Capability.LSP_QUERY, Capability.EMBEDDING_SEARCH],
    maxLoops: 4,
    recommendedModel: 'deepseek-v4-flash',
  },
  planner: {
    prompt: PLANNER_PROMPT,
    capabilities: [Capability.READ_CODE, Capability.SEARCH_SYMBOL, Capability.LSP_QUERY, Capability.EMBEDDING_SEARCH, Capability.MEMORY_ACCESS],
    maxLoops: 8,
    recommendedModel: 'claude-sonnet-4-6',
  },
  implementer: {
    prompt: IMPLEMENTER_PROMPT,
    capabilities: [
      Capability.READ_CODE, Capability.WRITE_CODE, Capability.SEARCH_SYMBOL,
      Capability.EXECUTE_COMMAND, Capability.GIT_OPERATION, Capability.LSP_QUERY,
    ],
    maxLoops: 12,
    recommendedModel: 'gpt-5.3-codex',
  },
  reviewer: {
    prompt: REVIEWER_PROMPT,
    capabilities: [Capability.READ_CODE, Capability.SEARCH_SYMBOL, Capability.LSP_QUERY, Capability.GIT_OPERATION],
    maxLoops: 4,
    recommendedModel: 'claude-sonnet-4-6',
  },
  tester: {
    prompt: TESTER_PROMPT,
    capabilities: [Capability.READ_CODE, Capability.WRITE_CODE, Capability.EXECUTE_COMMAND, Capability.SEARCH_SYMBOL],
    maxLoops: 8,
    recommendedModel: 'deepseek-v4-pro',
  },
  conflictResolver: {
    prompt: CONFLICT_RESOLVER_PROMPT,
    capabilities: [Capability.READ_CODE, Capability.WRITE_CODE, Capability.GIT_OPERATION],
    maxLoops: 4,
    recommendedModel: 'claude-sonnet-4-6',
  },
};

/**
 * 从内置配置创建子智能体配置。
 * 角色定义是静态的（6 种），实例数量是动态的（按任务规模伸缩）。
 */
export function createBuiltinSubagentConfig(
  role: SubagentRole,
  name: string,
  provider: ILLMProvider,
  tools: ToolRegistry,
): SubagentConfig {
  const builtin = BUILTIN_ROLES[role];
  if (!builtin) {
    throw new Error(`未知的内置角色: ${role}`);
  }

  return {
    role,
    name,
    description: `${role} agent — ${name}`,
    systemPrompt: builtin.prompt,
    provider,
    tools,
    maxLoops: builtin.maxLoops,
    allowedCapabilities: builtin.capabilities,
  };
}

/** 获取内置角色的 System Prompt */
export function getBuiltinPrompt(role: SubagentRole): string {
  return BUILTIN_ROLES[role].prompt;
}

/** 获取内置角色的推荐模型 */
export function getRecommendedModel(role: SubagentRole): string {
  return BUILTIN_ROLES[role].recommendedModel;
}
