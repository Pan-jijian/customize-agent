import type { SubagentConfig, SubagentResult, SubagentTask } from './subagent/types.js';
import { SubagentRunner } from './subagent/runner.js';
import type { SafeWorktreeManager, WorktreeContext } from './subagent/worktree.js';

// 编排器 — DAG 任务分解 + 动态 Worker 派生

/** 协作模式 */
export type CollaborationMode = 'orchestrator' | 'pipeline' | 'swarm';

/** 编排执行结果 */
export interface OrchestrationResult {
  /** 是否全部子任务成功 */
  success: boolean;
  /** 结果摘要 */
  summary: string;
  /** 各子智能体的执行结果 */
  subagentResults: SubagentResult[];
  /** Token 总消耗 */
  totalTokens: number;
  /** 费用总计（美元） */
  totalCost: number;
  /** 执行总耗时（毫秒） */
  totalDurationMs: number;
}

/**
 * 多智能体编排器。
 *
 * 三种协作模式：
 *   - Orchestrator: 按 DAG 拓扑序串行委派，每步 1 Worker
 *   - Pipeline: 每阶段 1 Worker，流水线传递（A→B→C）
 *   - Swarm: 同任务派生 N 个同角色 Worker 并行，评判模型选最优
 *
 * 动态性体现在"任务拆解"和"实例克隆"，而非"角色发明"。
 */
export class Orchestrator {
  private runner = new SubagentRunner();
  private worktreeManager?: SafeWorktreeManager;

  constructor(worktreeManager?: SafeWorktreeManager) {
    this.worktreeManager = worktreeManager;
  }

  /**
   * 执行编排 — 接收任务拆解和子智能体配置，协调执行并汇总结果。
   */
  async orchestrate(
    tasks: SubagentTask[],
    configFactory: (task: SubagentTask, index: number) => SubagentConfig,
    mode: CollaborationMode = 'orchestrator',
  ): Promise<OrchestrationResult> {
    switch (mode) {
      case 'orchestrator':
        return this._runOrchestrator(tasks, configFactory);
      case 'pipeline':
        return this._runPipeline(tasks, configFactory);
      case 'swarm':
        return this._runSwarm(tasks, configFactory);
    }
  }

  /** Orchestrator 模式：按 DAG 拓扑序串行执行 */
  private async _runOrchestrator(
    tasks: SubagentTask[],
    configFactory: (task: SubagentTask, index: number) => SubagentConfig,
  ): Promise<OrchestrationResult> {
    const completed = new Map<string, SubagentResult>();
    const allResults: SubagentResult[] = [];
    let totalTokens = 0;
    let totalCost = 0;
    const startTime = Date.now();

    // 拓扑排序：按依赖关系确定执行顺序
    const sorted = this._topologicalSort(tasks);

    for (const task of sorted) {
      // 检查依赖是否全部完成
      const depsFailed = task.dependsOn.filter(depId => {
        const dep = completed.get(depId);
        return !dep || !dep.success;
      });
      if (depsFailed.length > 0) {
        continue; // 跳过依赖失败的步骤
      }

      // 派生子智能体
      const config = configFactory(task, allResults.length);

      // 如果需要修改文件，创建临时 Worktree
      let worktree: WorktreeContext | undefined;
      if (task.expectedFiles.length > 0 && this.worktreeManager) {
        try {
          worktree = await this.worktreeManager.createWorktree(config.name);
        } catch {
          // Worktree 不可用则直接在主线执行
        }
      }

      const result = await this.runner.run(config, task.description);
      allResults.push(result);
      completed.set(task.description, result);
      totalTokens += result.tokensUsed;
      totalCost += result.costUsd;

      // 清理 Worktree
      if (worktree) {
        try {
          await this.worktreeManager!.destroyWorktree(worktree, result.success);
        } catch {
          // 最好清理
        }
      }
    }

    return {
      success: allResults.every(r => r.success),
      summary: `${allResults.length}/${tasks.length} 子任务完成`,
      subagentResults: allResults,
      totalTokens,
      totalCost,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /** Pipeline 模式：串行流水线（A→B→C），每阶段结果作为下一阶段输入 */
  private async _runPipeline(
    tasks: SubagentTask[],
    configFactory: (task: SubagentTask, index: number) => SubagentConfig,
  ): Promise<OrchestrationResult> {
    const allResults: SubagentResult[] = [];
    let totalTokens = 0;
    let totalCost = 0;
    const startTime = Date.now();
    let previousSummary = '';

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      // 将上一阶段结果注入当前阶段任务描述
      const enrichedDescription = previousSummary
        ? `${task.description}\n\n上一阶段结果摘要:\n${previousSummary}`
        : task.description;

      const config = configFactory(task, i);
      const result = await this.runner.run(config, enrichedDescription);
      allResults.push(result);
      totalTokens += result.tokensUsed;
      totalCost += result.costUsd;

      if (result.success) {
        previousSummary = result.summary;
      } else {
        break; // 流水线中断
      }
    }

    return {
      success: allResults.every(r => r.success),
      summary: `Pipeline: ${allResults.length}/${tasks.length} 阶段完成`,
      subagentResults: allResults,
      totalTokens,
      totalCost,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /** Swarm 模式：同任务多方案并发执行，返回最优结果 */
  private async _runSwarm(
    tasks: SubagentTask[],
    configFactory: (task: SubagentTask, index: number) => SubagentConfig,
  ): Promise<OrchestrationResult> {
    const allResults: SubagentResult[] = [];
    let totalTokens = 0;
    let totalCost = 0;
    const startTime = Date.now();

    // 每个任务派生 3 个同角色 Worker 并发执行
    const swarmSize = 3;
    const mainTask = tasks[0];
    if (!mainTask) {
      return { success: false, summary: '无任务', subagentResults: [], totalTokens: 0, totalCost: 0, totalDurationMs: 0 };
    }

    const promises = Array.from({ length: swarmSize }, (_, i) => {
      const config = configFactory(mainTask, i);
      return this.runner.run(config, mainTask.description);
    });

    const results = await Promise.all(promises);
    for (const r of results) {
      allResults.push(r);
      totalTokens += r.tokensUsed;
      totalCost += r.costUsd;
    }

    // 选择最优：优先选择成功的结果，其中选 summary 最长的（内容最详细）
    const successful = results.filter(r => r.success);
    const best = successful.length > 0
      ? successful.reduce((a, b) => a.summary.length > b.summary.length ? a : b)
      : results[0]!;

    return {
      success: best.success,
      summary: `Swarm: ${successful.length}/${swarmSize} 方案成功，采纳最优方案:\n${best.summary}`,
      subagentResults: allResults,
      totalTokens,
      totalCost,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /** 简单拓扑排序（Kahn 算法） */
  private _topologicalSort(tasks: SubagentTask[]): SubagentTask[] {
    const taskMap = new Map(tasks.map(t => [t.description, t]));
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const t of tasks) {
      inDegree.set(t.description, t.dependsOn.length);
      for (const dep of t.dependsOn) {
        if (!adjacency.has(dep)) adjacency.set(dep, []);
        adjacency.get(dep)!.push(t.description);
      }
    }

    const queue = tasks.filter(t => t.dependsOn.length === 0).map(t => t.description);
    const sorted: SubagentTask[] = [];

    while (queue.length > 0) {
      const desc = queue.shift()!;
      const task = taskMap.get(desc);
      if (task) sorted.push(task);

      for (const neighbor of adjacency.get(desc) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    return sorted;
  }
}
