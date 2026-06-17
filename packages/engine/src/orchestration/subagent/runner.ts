import type { Message, FunctionDefinition } from '@code-agent/types';
import type { SubagentConfig, SubagentResult } from './types.js';
import { BudgetManager, LoopGuard } from '../../execution/controller.js';

/**
 * 子智能体运行器 — 独立上下文，完成后仅返回摘要。
 *
 * 每个子智能体实例独立创建 history: Message[]，独立调用 LLM。
 * 同角色不同 Worker（如 Implementer-Worker-A vs Implementer-Worker-B）上下文完全隔离。
 * 完成后仅将 SubagentResult.summary 灌回 Orchestrator，不共享 conversation history。
 *
 * 使用原生 Function Calling（非 XML 解析）。
 */
export class SubagentRunner {
  async run(config: SubagentConfig, task: string): Promise<SubagentResult> {
    const startTime = Date.now();
    const budget = new BudgetManager(1.0); // 子智能体独立 $1 预算
    const loopGuard = new LoopGuard(3);
    let totalTokens = 0;
    // 成本追踪待集成 Provider 定价表，当前 token 累加见 LLM 响应 usage 字段
    let totalCost = 0;

    const history: Message[] = [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: task },
    ];

    // 构建原生 Function Calling 工具定义
    const tools = this._buildToolDefinitions(config);

    const findings: string[] = [];
    const filesModified: string[] = [];

    let deadLoop = false;
    for (let round = 1; round <= config.maxLoops && !deadLoop; round++) {
      // 财务熔断
      if (budget.checkBudget().isOverBudget) break;

      // 调用 LLM（原生 Function Calling）
      let responseContent: string;
      let toolCalls: Message['toolCalls'];
      try {
        const response = await config.provider.chat(history, {
          temperature: config.temperature,
          tools,
        });
        responseContent = response.content;
        toolCalls = response.toolCalls;
        if (response.usage) {
          totalTokens += response.usage.promptTokens + response.usage.completionTokens;
          // 粗略成本估算：混合费率约 $3/1M token
          totalCost += (response.usage.promptTokens + response.usage.completionTokens) * 3 / 1_000_000;
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

      history.push({ role: 'assistant', content: responseContent, toolCalls });

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

      // 执行原生工具调用
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          try {
            const result = await config.tools.dispatch(tc.name, tc.arguments);

            // 死循环检测
            loopGuard.recordCall(tc.name, tc.arguments, result);
            if (loopGuard.detectDeadLoop().isDeadLoop) { deadLoop = true; break; }

            if (tc.name === 'modify_file' || tc.name === 'write_file') {
              const fp = tc.arguments.path;
              if (typeof fp === 'string') filesModified.push(fp);
            }
            if (result) {
              findings.push(`[${tc.name}]: ${result.slice(0, 200)}`);
            }
            history.push({ role: 'tool', content: result, toolCallId: tc.id });
          } catch (err) {
            const errMsg = `[${tc.name} 错误]: ${(err as Error).message}`;
            history.push({ role: 'tool', content: errMsg, toolCallId: tc.id });
          }
        }
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

  /** 从 ToolRegistry 构建 FunctionDefinition[] 传给 Provider */
  private _buildToolDefinitions(config: SubagentConfig): FunctionDefinition[] {
    return config.tools.listAll().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as FunctionDefinition['parameters'],
    }));
  }
}
