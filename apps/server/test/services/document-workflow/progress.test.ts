/**
 * progress 单测：执行阶段标题/角色名/展示阶段/阶段 upsert 身份判定。
 */
import { describe, expect, it } from 'vitest';
import { displayStage, elapsedMessage, stageRoleDisplayName, stageTitle, upsertProgressStage } from '@/services/document-workflow/progress';
import type { DocumentExecutionStage } from '@/services/document-workflow/types';

function makeStage(overrides: Partial<DocumentExecutionStage> = {}): DocumentExecutionStage {
  return { type: 'chapter_generation', roleId: 'llm', status: 'running', ...overrides };
}

describe('stageTitle', () => {
  it('llm_review 统一标题（历史 agent-reviewer/repairer 区分已随章级审查循环删除）', () => {
    expect(stageTitle('llm_review')).toBe('LLM 审查优化');
  });

  it('其余类型映射', () => {
    expect(stageTitle('chapter_generation')).toBe('章节正文生成');
    expect(stageTitle('role_binding')).toBe('项目角色配置绑定');
    expect(stageTitle('validation')).toBe('内容优化与质量校验');
  });
});

describe('stageRoleDisplayName', () => {
  it('已知角色名映射', () => {
    expect(stageRoleDisplayName('knowledge-base')).toBe('知识库');
    expect(stageRoleDisplayName('document-readiness')).toBe('生成准备度检查');
  });

  it('未知/空角色返回 undefined', () => {
    expect(stageRoleDisplayName('unknown')).toBeUndefined();
    expect(stageRoleDisplayName()).toBeUndefined();
  });
});

describe('displayStage', () => {
  it('补全 title/group/roleName/subtitle', () => {
    const stage = displayStage(makeStage({ roleId: 'knowledge-base' }));
    expect(stage.title).toBe('章节正文生成');
    expect(stage.group).toBe('chapter_generation');
    expect(stage.roleName).toBe('知识库');
    expect(stage.subtitle).toBe('知识库');
    expect(stage.executionVersion).toBe(2);
  });

  it('显式 subtitle/roleName 优先', () => {
    const stage = displayStage(makeStage({ roleId: 'knowledge-base', roleName: '自定义', subtitle: '自定义副标题' }));
    expect(stage.roleName).toBe('自定义');
    expect(stage.subtitle).toBe('自定义副标题');
  });
});

describe('upsertProgressStage', () => {
  it('新阶段追加并返回下标', () => {
    const stages: DocumentExecutionStage[] = [];
    expect(upsertProgressStage(stages, makeStage({ type: 'role_binding', roleId: 'r1' }))).toBe(0);
    expect(upsertProgressStage(stages, makeStage({ type: 'validation', roleId: 'r1' }))).toBe(1);
    expect(stages).toHaveLength(2);
  });

  it('同身份阶段原位更新并保留 order', () => {
    const stages: DocumentExecutionStage[] = [{ ...makeStage({ type: 'validation', roleId: 'r1', status: 'success', order: 7 }) }];
    const index = upsertProgressStage(stages, makeStage({ type: 'validation', roleId: 'r1', status: 'failed' }));
    expect(index).toBe(0);
    expect(stages[0].status).toBe('failed');
    expect(stages[0].order).toBe(7);
  });

  it('chapter_generation 身份含 subtitle 区分小节', () => {
    const stages: DocumentExecutionStage[] = [makeStage({ type: 'chapter_generation', roleId: 'llm', subtitle: '1.1 小节' })];
    const index = upsertProgressStage(stages, makeStage({ type: 'chapter_generation', roleId: 'llm', subtitle: '1.2 小节' }));
    expect(index).toBe(1);
    expect(stages).toHaveLength(2);
  });

  it('agent-chapter-task 身份含 subtitle 与 order（历史 agent-reviewer 前缀已随章级审查循环删除）', () => {
    const stages: DocumentExecutionStage[] = [];
    upsertProgressStage(stages, makeStage({ type: 'validation', roleId: 'agent-chapter-task-a', subtitle: '章1', order: 1 }));
    const index = upsertProgressStage(stages, makeStage({ type: 'validation', roleId: 'agent-chapter-task-a', subtitle: '章2', order: 2 }));
    expect(index).toBe(1);
  });
});

describe('elapsedMessage', () => {
  it('追加耗时秒数', () => {
    const now = Date.now();
    const message = elapsedMessage('生成完成', now - 3000);
    expect(message).toBe('生成完成，耗时 3 秒');
  });
});
