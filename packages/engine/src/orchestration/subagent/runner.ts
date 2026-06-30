import type { Message } from '@customize-agent/types';
import type { SubagentConfig, SubagentResult } from './types.js';
import { ExecutionController } from '../../execution-controller.js';
import { buildToolDefinitions, runToolLoop } from '../../tool-loop-runner.js';

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
    const controller = new ExecutionController({
      maxBudgetUsd: 1.0,
      deadLoopThreshold: 3,
      checkpointInterval: 9999,
    });
    const findings: string[] = [];
    const filesModified: string[] = [];
    const history: Message[] = [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: task },
    ];

    try {
      const result = await runToolLoop({
        provider: config.provider,
        registry: config.tools,
        messages: history,
        tools: buildToolDefinitions(config.tools),
        maxLoops: config.maxLoops,
        temperature: config.temperature,
        controller,
        taskGoal: task,
        onResponse: response => {
          const summary = this._extractTaskFinish(response.content);
          if (summary) findings.push(summary);
        },
        onToolResult: (toolCall, toolResult) => {
          if (toolCall.name === 'write_file') {
            const filePath = toolCall.arguments.path;
            if (typeof filePath === 'string') filesModified.push(filePath);
          }
          if (toolResult) findings.push(`[${toolCall.name}]: ${toolResult.slice(0, 200)}`);
        },
      });

      const lastAssistant = [...result.messages].reverse().find(message => message.role === 'assistant');
      const finishSummary = this._extractTaskFinish(lastAssistant?.content ?? '');
      return {
        success: result.finishReason === 'completed' || Boolean(finishSummary),
        role: config.role,
        summary: finishSummary ?? result.summary,
        findings,
        filesModified: [...new Set(filesModified)],
        tokensUsed: result.totalTokens,
        costUsd: result.totalCostUsd,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        role: config.role,
        summary: `执行失败: ${(err as Error).message}`,
        findings,
        filesModified: [...new Set(filesModified)],
        tokensUsed: 0,
        costUsd: 0,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private _extractTaskFinish(content: string): string | undefined {
    const match = content.match(/<task_finish>([\s\S]*?)<\/task_finish>/);
    return match?.[1]?.trim();
  }
}
