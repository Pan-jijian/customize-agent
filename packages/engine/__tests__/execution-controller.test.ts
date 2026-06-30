import { describe, expect, it } from 'vitest';
import { ExecutionController } from '../src/execution-controller.js';

describe('ExecutionController GoalManager', () => {
  it('触发 Goal 检测时应调用 LLM 判定器并在达成时停止', async () => {
    const controller = new ExecutionController({
      goalEvaluator: async context => ({ achieved: context.taskGoal === '完成任务', reason: 'YES 已完成' }),
    });

    const result = await controller.evaluate(1, 'execute_command', 'tests passed', '完成任务');

    expect(result.action).toBe('stop');
    expect(result.reason).toBe('YES 已完成');
  });

  it('未配置判定器时应保持继续执行', async () => {
    const controller = new ExecutionController();

    const result = await controller.evaluate(1, 'execute_command', 'tests passed', '完成任务');

    expect(result.action).toBe('continue');
    expect(result.reason).toContain('no evaluator');
  });

  it('task_finish 标记应直接停止且不调用判定器', async () => {
    let called = false;
    const controller = new ExecutionController({
      goalEvaluator: async () => {
        called = true;
        return { achieved: false };
      },
    });

    const result = await controller.evaluate(1, 'read_file', '', '完成任务', { hasTaskFinishTag: true });

    expect(result.action).toBe('stop');
    expect(called).toBe(false);
  });
});
