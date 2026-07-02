import { executeCommand } from '@customize-agent/tools';

/** Hook 触发事件 */
export type HookEvent =
  | 'on_session_start'
  | 'pre_tool_call'
  | 'post_tool_call'
  | 'pre_task_finish'
  | 'on_error'
  | 'on_session_end';

/** Hook 执行类型 */
export type HookType = 'command' | 'prompt';

/** 单个 Hook 配置 */
export interface HookConfig {
  /** Hook 唯一名称 */
  name: string;
  /** 触发事件 */
  event: HookEvent;
  /** 触发条件（可选，表达式如 "toolName === 'modify_file'"） */
  condition?: string;
  /** Hook 类型 */
  type: HookType;
  /** 执行内容（command: shell 命令, prompt: LLM 提示词文本） */
  action: string;
  /** 超时 ms（仅 command 类型有效，默认 60000） */
  timeout?: number;
}

/** Hook 执行结果 */
export interface HookResult {
  name: string;
  event: HookEvent;
  type: HookType;
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Hooks 引擎 — 事件驱动的自定义逻辑。
 *
 * 6 种事件类型:
 *   on_session_start    → 加载项目配置、检查环境
 *   pre_tool_call       → lint 检查、pre-commit 验证
 *   post_tool_call      → 记录日志、触发通知
 *   pre_task_finish     → 运行完整测试套件
 *   on_error            → 错误诊断、自动恢复
 *   on_session_end      → 清理资源、生成报告
 */
export class HooksEngine {
  private hooks: HookConfig[] = [];

  /** 注册 Hook */
  register(hook: HookConfig): void {
    this.hooks.push(hook);
  }

  /** 批量注册 */
  registerAll(hooks: HookConfig[]): void {
    for (const h of hooks) this.register(h);
  }

  /** 获取所有 Hook */
  getAll(): HookConfig[] {
    return [...this.hooks];
  }

  /**
   * 触发指定事件的 Hook。
   * @param context 传给条件表达式的上下文（如 { toolName, args }）
   * @returns 所有匹配 Hook 的执行结果
   */
  async trigger(event: HookEvent, context: Record<string, unknown> = {}): Promise<HookResult[]> {
    const matched = this.hooks.filter(h => h.event === event && this._evaluateCondition(h.condition, context));
    const results: HookResult[] = [];

    for (const hook of matched) {
      const result: HookResult = { name: hook.name, event, type: hook.type, success: false };

      try {
        if (hook.type === 'command') {
          const cmdResult = await this._executeCommand(hook.action, hook.timeout ?? 60_000);
          result.output = cmdResult.stdout;
          result.success = cmdResult.code === 0;
          if (!result.success) result.error = cmdResult.stderr;
        } else if (hook.type === 'prompt') {
          // prompt 类型：返回提示词文本注入 LLM
          result.output = hook.action;
          result.success = true;
        }
      } catch (err) {
        result.success = false;
        result.error = (err as Error).message;
      }

      results.push(result);
    }

    return results;
  }

  /** 收集 prompt 类型 Hook 的输出（合并为一段文本） */
  collectPrompts(results: HookResult[]): string {
    return results
      .filter(r => r.type === 'prompt' && r.success && r.output)
      .map(r => r.output!)
      .join('\n\n');
  }

  /** 执行 shell 命令 */
  private async _executeCommand(command: string, timeout: number): Promise<{ stdout: string; stderr: string; code: number }> {
    return executeCommand(command, { timeout });
  }

  /** 简单条件表达式求值（支持 === 和 !== 等基本操作符） */
  private _evaluateCondition(condition: string | undefined, context: Record<string, unknown>): boolean {
    if (!condition) return true;

    try {
      // 安全求值：将 context 的 key 作为变量，限制表达式语法
      const fn = new Function(...Object.keys(context), `"use strict"; return !!(${condition});`);
      return Boolean(fn(...Object.values(context)));
    } catch {
      return false; // 条件求值失败 → 不触发
    }
  }
}
