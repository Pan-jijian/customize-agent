import type { Message } from '@code-agent/types';
import type { SubagentConfig, SubagentResult } from './types.js';
import { BudgetManager, LoopGuard } from '../../execution/controller.js';

/**
 * 子智能体运行器 — 独立上下文，完成后仅返回摘要。
 *
 * 每个子智能体实例独立创建 history: Message[]，独立调用 LLM。
 * 同角色不同 Worker（如 Implementer-Worker-A vs Implementer-Worker-B）上下文完全隔离。
 * 完成后仅将 SubagentResult.summary 灌回 Orchestrator，不共享 conversation history。
 */
export class SubagentRunner {
  async run(config: SubagentConfig, task: string): Promise<SubagentResult> {
    const startTime = Date.now();
    const budget = new BudgetManager(1.0); // 子智能体独立 $1 预算
    const loopGuard = new LoopGuard(3);
    let totalTokens = 0;
    const totalCost = 0;

    const history: Message[] = [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: task },
    ];

    const findings: string[] = [];
    const filesModified: string[] = [];

    for (let round = 1; round <= config.maxLoops; round++) {
      // 财务熔断
      if (budget.checkBudget().isOverBudget) break;

      // 调用 LLM
      let responseContent: string;
      try {
        const response = await config.provider.chat(history, { temperature: config.temperature });
        responseContent = response.content;
        if (response.usage) {
          totalTokens += response.usage.promptTokens + response.usage.completionTokens;
        }
      } catch (err) {
        return {
          success: false,
          role: config.role,
          summary: `执行失败: ${(err as Error).message}`,
          findings,
          filesModified,
          tokensUsed: totalTokens,
          costUsd: totalCost,
          durationMs: Date.now() - startTime,
        };
      }

      history.push({ role: 'assistant', content: responseContent });

      // 检查完成标记
      if (responseContent.includes('<task_finish>')) {
        const summaryMatch = responseContent.match(/<task_finish>([\s\S]*?)<\/task_finish>/);
        return {
          success: true,
          role: config.role,
          summary: summaryMatch?.[1]?.trim() ?? '任务完成',
          findings,
          filesModified,
          tokensUsed: totalTokens,
          costUsd: totalCost,
          durationMs: Date.now() - startTime,
        };
      }

      // 解析工具调用
      const toolResult = await this._dispatchTools(config, responseContent);
      if (toolResult.toolName) {
        // 死循环检测
        loopGuard.recordCall(toolResult.toolName, {}, toolResult.result);
        if (loopGuard.detectDeadLoop().isDeadLoop) break;

        if (toolResult.toolName === 'modify_file') {
          filesModified.push(String(toolResult.args?.path ?? ''));
        }
        if (toolResult.result) {
          findings.push(`[${toolResult.toolName}]: ${toolResult.result.slice(0, 200)}`);
        }
        history.push({ role: 'user', content: `[Observation]:\n${toolResult.result}` });
      }
    }

    return {
      success: false,
      role: config.role,
      summary: `达到最大循环次数 (${config.maxLoops} 轮)`,
      findings,
      filesModified: [...new Set(filesModified)],
      tokensUsed: totalTokens,
      costUsd: totalCost,
      durationMs: Date.now() - startTime,
    };
  }

  /** 解析 XML 工具调用并分发 */
  private async _dispatchTools(config: SubagentConfig, text: string): Promise<{
    toolName?: string;
    result: string;
    args?: Record<string, unknown>;
  }> {
    const toolRegex = /<call_tool\s+name="([^"]+)"(?:\s+path="([^"]+)")?>([\s\S]*?)<\/call_tool>/g;
    let match;
    let result = '';

    while ((match = toolRegex.exec(text)) !== null) {
      const toolName = match[1];
      const path = match[2];
      const body = match[3]?.trim();

      if (!toolName || !body) continue;

      try {
        const args: Record<string, unknown> = { input: body };
        if (path) args.path = path;
        const toolResult = await config.tools.dispatch(toolName, args);
        result += toolResult + '\n';
        return { toolName, result, args };
      } catch (err) {
        result += `[${toolName} 错误]: ${(err as Error).message}\n`;
        return { toolName, result };
      }
    }

    return { result };
  }
}
