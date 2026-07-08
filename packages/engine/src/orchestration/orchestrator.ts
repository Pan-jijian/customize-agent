import { reportNonFatalError, type Message } from '@customize-agent/types';
import { estimateCostUsd } from '@customize-agent/llm';
import type { SubagentConfig, SubagentResult, SubagentTask } from './subagent/types.js';
import { SubagentRunner } from './subagent/runner.js';
import type { IsolationStrategy, IsolationContext } from './isolation.js';

// 编排器 — DAG 任务分解 + 动态 Worker 派生

/** 协作模式 */
export type CollaborationMode = 'orchestrator' | 'pipeline' | 'swarm';

/** 带并发限制的 Promise.all：最多 maxConcurrency 个异步任务同时执行 */
async function limitedParallel<T>(tasks: Array<() => Promise<T>>, maxConcurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]!();
    }
  }
  const workers = Array.from({ length: Math.min(maxConcurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

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
/** 同层最大并发子智能体数 */
const MAX_CONCURRENT_SUBAGENTS = 4;

export class Orchestrator {
  private runner = new SubagentRunner();
  private isolation?: IsolationStrategy;

  constructor(isolation?: IsolationStrategy) {
    this.isolation = isolation;
  }

  /**
   * 执行编排 — 接收任务拆解和子智能体配置，协调执行并汇总结果。
   */
  async orchestrate(
    tasks: SubagentTask[],
    configFactory: (task: SubagentTask, index: number, worktreePath?: string) => SubagentConfig,
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

  /** Orchestrator 模式：按 DAG 依赖层并发执行 */
  private async _runOrchestrator(
    tasks: SubagentTask[],
    configFactory: (task: SubagentTask, index: number, worktreePath?: string) => SubagentConfig,
  ): Promise<OrchestrationResult> {
    const completed = new Map<string, SubagentResult>();
    const skipped = new Set<string>();
    const allResults: SubagentResult[] = [];
    let totalTokens = 0;
    let totalCost = 0;
    const startTime = Date.now();
    const remaining = new Map(tasks.map(task => [task.id, task]));

    while (remaining.size > 0) {
      const blocked = Array.from(remaining.values()).filter(task =>
        task.dependsOn.some(depId => skipped.has(depId) || (completed.has(depId) && !completed.get(depId)!.success))
      );
      for (const task of blocked) {
        remaining.delete(task.id);
        skipped.add(task.id);
      }

      const ready = Array.from(remaining.values()).filter(task =>
        task.dependsOn.every(depId => completed.has(depId))
      );

      if (ready.length === 0) break;

      const results = await limitedParallel(ready.map((task, index) => async () => {
        const baseName = `${task.id}-${allResults.length + index + 1}`;
        let isoCtx: IsolationContext | undefined;
        if (task.expectedFiles.length > 0 && this.isolation) {
          isoCtx = await this.isolation.create(baseName, task);
        }
        const config = configFactory(task, allResults.length + index, isoCtx?.path);

        const result = await this.runner.run(config, task.description);
        if (isoCtx) {
          try {
            const merge = await this.isolation!.merge(isoCtx, result.success);
            if (!merge.success) {
              result.success = false;
              result.summary += `\n[${isoCtx.strategy}] merge conflicts: ${merge.conflicts.join(', ')}`;
            }
          } catch (err) {
            result.success = false;
            result.summary += `\n[${isoCtx.strategy}] merge failed: ${(err as Error).message}`;
          } finally {
            // 始终销毁隔离上下文 — 即使 merge 抛出异常
            try {
              await this.isolation!.destroy(isoCtx);
            } catch (cleanupErr) {
              reportNonFatalError({
                source: 'orchestrator.destroy_isolation',
                error: cleanupErr,
                details: { strategy: isoCtx.strategy, path: isoCtx.path },
              });
            }
          }
        }
        return { task, result };
      }), MAX_CONCURRENT_SUBAGENTS);

      for (const { task, result } of results) {
        remaining.delete(task.id);
        completed.set(task.id, result);
        allResults.push(result);
        totalTokens += result.tokensUsed;
        totalCost += result.costUsd;
        if (!result.success) skipped.add(task.id);
      }
    }

    return {
      success: allResults.length === tasks.length && allResults.every(r => r.success),
      summary: `${allResults.length}/${tasks.length} 子任务完成${skipped.size > 0 ? `，跳过 ${skipped.size} 个依赖失败任务` : ''}`,
      subagentResults: allResults,
      totalTokens,
      totalCost,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /** Pipeline 模式：串行流水线（A→B→C），每阶段结果作为下一阶段输入 */
  private async _runPipeline(
    tasks: SubagentTask[],
    configFactory: (task: SubagentTask, index: number, worktreePath?: string) => SubagentConfig,
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
    configFactory: (task: SubagentTask, index: number, worktreePath?: string) => SubagentConfig,
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

    const successful = results.filter(r => r.success);
    const judgeConfig = configFactory(mainTask, swarmSize);
    const judged = await this._judgeSwarmResults(mainTask.description, results, judgeConfig);
    totalTokens += judged.tokensUsed;
    totalCost += judged.costUsd;
    const best = results[judged.bestIndex] ?? successful[0] ?? results[0]!;

    return {
      success: best.success,
      summary: `Swarm: ${successful.length}/${swarmSize} 方案成功，评判选择方案 ${judged.bestIndex + 1}:\n${best.summary}\n\n评判理由:\n${judged.reason}`,
      subagentResults: allResults,
      totalTokens,
      totalCost,
      totalDurationMs: Date.now() - startTime,
    };
  }

  private async _judgeSwarmResults(
    task: string,
    results: SubagentResult[],
    config: SubagentConfig,
  ): Promise<{ bestIndex: number; reason: string; tokensUsed: number; costUsd: number }> {
    const messages: Message[] = [
      {
        role: 'system',
        content: 'You are a strict evaluator. Compare candidate agent results and choose the best one for correctness, completeness, safety, and usefulness. Return only JSON: {"bestIndex":0,"reason":"..."}.',
      },
      {
        role: 'user',
        content: [
          `Task: ${task}`,
          '',
          ...results.map((result, index) => [
            `Candidate ${index}:`,
            `success=${result.success}`,
            `summary=${result.summary}`,
            `findings=${result.findings.join('\n')}`,
            `filesModified=${result.filesModified.join(', ')}`,
          ].join('\n')),
        ].join('\n\n'),
      },
    ];

    try {
      const response = await config.provider.chat(messages, { temperature: 0, maxTokens: 800 });
      const usage = response.usage;
      const tokensUsed = usage ? usage.promptTokens + usage.completionTokens : 0;
      const costUsd = usage ? estimateCostUsd(config.provider, usage) : 0;
      const jsonText = response.content.match(/\{[\s\S]*\}/)?.[0] ?? response.content;
      const parsed = JSON.parse(jsonText) as { bestIndex?: number; reason?: string };
      const bestIndex = Number.isInteger(parsed.bestIndex) && parsed.bestIndex! >= 0 && parsed.bestIndex! < results.length
        ? parsed.bestIndex!
        : this._fallbackBestIndex(results);
      return { bestIndex, reason: parsed.reason ?? response.content.trim(), tokensUsed, costUsd };
    } catch {
      return { bestIndex: this._fallbackBestIndex(results), reason: '评判模型不可用，回退为优先成功且内容更完整的方案。', tokensUsed: 0, costUsd: 0 };
    }
  }

  private _fallbackBestIndex(results: SubagentResult[]): number {
    const successful = results
      .map((result, index) => ({ result, index }))
      .filter(item => item.result.success);
    const candidates = successful.length > 0 ? successful : results.map((result, index) => ({ result, index }));
    return candidates.reduce((best, item) =>
      item.result.summary.length > best.result.summary.length ? item : best
    ).index;
  }

}
