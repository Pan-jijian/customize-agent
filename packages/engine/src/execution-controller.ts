// 子组件类型定义

/** 工具调用哈希条目 — 用于语义死循环检测 */
interface HashEntry {
  toolName: string;
  argsHash: string;
  resultHash: string;
}

/** 死循环检测结果 */
interface DeadLoopResult {
  isDeadLoop: boolean;
  reason?: string;
}

/** 预算检查结果 */
interface BudgetResult {
  isOverBudget: boolean;
  used: number;
  limit: number;
}

/** Goal 检测结果 */
interface GoalResult {
  achieved: boolean;
  reason?: string;
}

/** 检查点结果 */
interface CheckpointResult {
  shouldPause: boolean;
  message?: string;
}

/** 子组件执行评估后的决策 */
export type EvalAction = 'continue' | 'stop' | 'replan' | 'pause';

export interface EvalResult {
  action: EvalAction;
  reason: string;
}

// LoopGuard — 语义死循环检测

/** 连续 N 轮相同的 toolName+args+result 哈希 → 判定为死循环 */
export class LoopGuard {
  private recentCalls: HashEntry[] = [];
  private threshold: number;

  constructor(threshold: number = 3) {
    this.threshold = threshold;
  }

  /** 记录一轮工具调用结果 */
  recordCall(toolName: string, args: Record<string, unknown>, result: string): void {
    const entry: HashEntry = {
      toolName,
      argsHash: this._hash(JSON.stringify(args)),
      resultHash: this._hash(result.slice(0, 500)),
    };
    this.recentCalls.push(entry);
    // 只保留最近 N+2 轮
    if (this.recentCalls.length > this.threshold + 2) {
      this.recentCalls.shift();
    }
  }

  /** 检测是否存在语义死循环 */
  detectDeadLoop(): DeadLoopResult {
    if (this.recentCalls.length < this.threshold) {
      return { isDeadLoop: false };
    }

    const recent = this.recentCalls.slice(-this.threshold);
    const first = recent[0]!;
    const allSame = recent.every(
      e => e.toolName === first.toolName &&
           e.argsHash === first.argsHash &&
           e.resultHash === first.resultHash,
    );

    if (allSame) {
      return {
        isDeadLoop: true,
        reason: `连续 ${this.threshold} 轮执行相同操作: tool="${first.toolName}"，可能陷入死循环，建议重新规划`,
      };
    }

    return { isDeadLoop: false };
  }

  /** 重置检测历史 */
  reset(): void {
    this.recentCalls = [];
  }

  /** 简单字符串哈希（FNV-1a） */
  private _hash(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }
}

// BudgetManager — 财务熔断

/** 对标 Claude Code ANTHROPIC_COST_BUDGET */
export class BudgetManager {
  private usedCost: number = 0;
  private maxBudget: number;

  constructor(maxBudgetUsd: number = 3.0) {
    this.maxBudget = maxBudgetUsd;
  }

  /** 累加费用 */
  addCost(usd: number): void {
    this.usedCost += usd;
  }

  /** 检查是否超出预算 */
  checkBudget(): BudgetResult {
    return {
      isOverBudget: this.usedCost >= this.maxBudget,
      used: this.usedCost,
      limit: this.maxBudget,
    };
  }

  /** 获取剩余预算 */
  remaining(): number {
    return Math.max(0, this.maxBudget - this.usedCost);
  }

  /** 获取当前使用金额 */
  get used(): number { return this.usedCost; }

  /** 重置预算 */
  reset(): void { this.usedCost = 0; }
}

// GoalManager — Goal 完成检测

/** 触发 Goal 检测的里程碑事件 */
const GOAL_TRIGGER_EVENTS = new Set([
  'modify_file',
  'git_commit',
  'execute_command',
]);

/** 只读工具 — 永远不触发 Goal 检测 */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_files', 'search_symbol',
  'grep_search', 'fts_search', 'semantic_search',
  'lsp_definition', 'lsp_references', 'lsp_diagnostics',
  'git_status', 'git_diff',
]);

export interface GoalCheckContext {
  taskGoal: string;
  lastToolName: string;
  lastToolResult: string;
  gitDiff: string;
}

/**
 * Goal 完成检测器。
 * 启发式前置过滤（非轮询式）:
 *   - Agent 输出 <task_finish> → 直接判定完成
 *   - 上一轮是 git_commit → 触发检测
 *   - execute_command 返回测试通过 → 触发检测
 *   - 只读工具 → 跳过检测
 *   - 步长保底：每 5 轮触发一次轻量检测
 */
export class GoalManager {
  private roundsSinceLastCheck = 0;
  private stepInterval = 5;

  /** 判断当前轮次是否需要触发 Goal 检测 */
  shouldCheck(lastToolName: string, hasTaskFinishTag: boolean): boolean {
    // Agent 主动声明完成
    if (hasTaskFinishTag) return true;

    // 只读工具不触发
    if (READ_ONLY_TOOLS.has(lastToolName)) {
      this.roundsSinceLastCheck++;
      return false;
    }

    // 里程碑事件触发
    if (GOAL_TRIGGER_EVENTS.has(lastToolName)) {
      this.roundsSinceLastCheck = 0;
      return true;
    }

    // 步长保底：每 N 轮检查一次
    this.roundsSinceLastCheck++;
    if (this.roundsSinceLastCheck >= this.stepInterval) {
      this.roundsSinceLastCheck = 0;
      return true;
    }

    return false;
  }

  /**
   * 构建 Goal 检测的 Prompt（极致压缩上下文 ~500 token）。
   * 不传全量对话历史，只传：任务目标 + 最新 git diff + 最后一轮工具结果。
   */
  buildGoalCheckPrompt(ctx: GoalCheckContext): string {
    return [
      `判断以下任务是否已完全达成：`,
      `任务目标: ${ctx.taskGoal}`,
      `最后一次操作: ${ctx.lastToolName}`,
      `操作结果: ${ctx.lastToolResult.slice(0, 300)}`,
      `Git Diff 摘要: ${ctx.gitDiff.slice(0, 300)}`,
      ``,
      `任务目标是否已完全达成？请仅回答 YES（附原因）或 NO（附原因）。`,
    ].join('\n');
  }

  /** 解析 Goal 检测模型的响应 */
  parseGoalResponse(response: string): GoalResult {
    const upper = response.trim().toUpperCase();
    if (upper.startsWith('YES')) {
      return { achieved: true, reason: response };
    }
    return { achieved: false, reason: response };
  }

  /** 重置步长计数器 */
  reset(): void {
    this.roundsSinceLastCheck = 0;
  }
}

// CheckpointManager — 人机检查点

/** 对标 Codex CLI turn_budget 模式 — 每 N 轮弹窗询问 */
export class CheckpointManager {
  private interval: number;

  constructor(interval: number = 15) {
    this.interval = interval;
  }

  shouldCheckpoint(loopCount: number): CheckpointResult {
    if (loopCount > 0 && loopCount % this.interval === 0) {
      return {
        shouldPause: true,
        message: `已完成 ${loopCount} 轮操作，是否继续？`,
      };
    }
    return { shouldPause: false };
  }
}

// ExecutionController — 编排器（委托给各子组件）

export interface ExecutionControllerConfig {
  /** 语义死循环检测连续次数阈值 */
  deadLoopThreshold?: number;
  /** 财务预算上限（美元） */
  maxBudgetUsd?: number;
  /** 人机检查点间隔（轮数） */
  checkpointInterval?: number;
}

/**
 * 执行控制器 — 对齐 Claude Code / Codex CLI 的
 * 财务预算 + Goal 检测 + 死循环检测 三层模式。
 *
 * 明确替代硬编码固定 8 轮熔断。
 */
export class ExecutionController {
  private loopGuard: LoopGuard;
  private budgetManager: BudgetManager;
  private goalManager: GoalManager;
  private checkpointManager: CheckpointManager;

  constructor(config: ExecutionControllerConfig = {}) {
    this.loopGuard = new LoopGuard(config.deadLoopThreshold ?? 3);
    this.budgetManager = new BudgetManager(config.maxBudgetUsd ?? 3.0);
    this.goalManager = new GoalManager();
    this.checkpointManager = new CheckpointManager(config.checkpointInterval ?? 15);
  }

  get budget(): BudgetManager { return this.budgetManager; }
  get loopDetector(): LoopGuard { return this.loopGuard; }
  get goalDetector(): GoalManager { return this.goalManager; }

  /**
   * 每一轮工具执行后按优先级链式检查：
   *   L1 死循环 → L2 预算 → L3 Goal 完成 → L4 检查点 → 继续
   */
  async evaluate(
    loopCount: number,
    lastToolName: string,
    _lastToolResult: string,
    _taskGoal: string,
    options: {
      hasTaskFinishTag?: boolean;
      gitDiff?: string;
      costThisRound?: number;
    } = {},
  ): Promise<EvalResult> {
    // L1 — 语义死循环检测
    const deadLoop = this.loopGuard.detectDeadLoop();
    if (deadLoop.isDeadLoop) {
      this.loopGuard.reset();
      return { action: 'replan', reason: deadLoop.reason! };
    }

    // L2 — 财务熔断
    if (options.costThisRound) {
      this.budgetManager.addCost(options.costThisRound);
    }
    const budget = this.budgetManager.checkBudget();
    if (budget.isOverBudget) {
      return {
        action: 'stop',
        reason: `预算 $${budget.limit.toFixed(2)} 已用完，已执行 ${loopCount} 轮，总费用 $${budget.used.toFixed(4)}`,
      };
    }

    // L3 — Goal 完成检测
    const shouldCheckGoal = this.goalManager.shouldCheck(
      lastToolName,
      options.hasTaskFinishTag ?? false,
    );
    if (shouldCheckGoal && options.hasTaskFinishTag) {
      // Agent 声明完成 → 直接停止，不需要 LLM 判定
      return { action: 'stop', reason: 'Agent 主动声明任务完成 <task_finish>' };
    }
    // 触发式 Goal 检测（里程碑事件/步长保底）→ 标记需要 LLM 判定
    if (shouldCheckGoal) {
      // 留给外部用轻量模型执行 Goal 检测
      return { action: 'continue', reason: 'Goal check triggered (delegated to lightweight model)' };
    }

    // L4 — 人机检查点
    const checkpoint = this.checkpointManager.shouldCheckpoint(loopCount);
    if (checkpoint.shouldPause) {
      return { action: 'pause', reason: checkpoint.message! };
    }

    return { action: 'continue', reason: 'OK' };
  }

  /** 记录工具调用（供 LoopGuard 使用） */
  recordToolCall(toolName: string, args: Record<string, unknown>, result: string): void {
    this.loopGuard.recordCall(toolName, args, result);
  }

  /** 重置全部状态 */
  reset(): void {
    this.loopGuard.reset();
    this.budgetManager.reset();
    this.goalManager.reset();
  }
}
