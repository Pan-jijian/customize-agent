import type { DocumentExecutionStage } from './types';

export function stageTitle(type: DocumentExecutionStage['type']) {
  const titles: Record<DocumentExecutionStage['type'], string> = {
    role_binding: '项目角色配置绑定',
    knowledge_retrieval: '知识库证据检索',
    file_understanding: '文件角色读取',
    fact_extraction: '事实抽取',
    chapter_generation: '章节正文生成',
    asset_generation: '生成资源处理',
    llm_review: 'LLM 审查优化',
    validation: '内容优化与质量校验',
    formatting: '正式排版整理',
    export_ready: '导出就绪检查',
    reference: '资料增强',
  };
  return titles[type];
}

export function stageRoleDisplayName(roleId?: string) {
  const names: Record<string, string> = {
    'knowledge-base': '知识库', 'document-readiness': '生成准备度检查', 'quality-repair': '质量补写', 'export-gate': '导出门禁',
    'final-format': '正式排版', 'multimodal-files': '多模态文件理解', 'llm-json': 'LLM 事实抽取',
    'llm-review': 'LLM 审查', 'document-workflow': '最终规范校验',
  };
  return roleId ? names[roleId] : undefined;
}

export function displayStage(stage: DocumentExecutionStage, overrides: Partial<DocumentExecutionStage> = {}): DocumentExecutionStage {
  const next = { executionVersion: 2 as const, title: stageTitle(stage.type), group: stage.type, ...stage, ...overrides };
  return { ...next, roleName: next.roleName || stageRoleDisplayName(next.roleId), subtitle: next.subtitle || next.roleName || stageRoleDisplayName(next.roleId) };
}

export function upsertProgressStage(stages: DocumentExecutionStage[], stage: DocumentExecutionStage): number {
  const index = stages.findIndex(item => item.type === stage.type && item.roleId === stage.roleId && item.promptId === stage.promptId);
  if (index >= 0) {
    stages[index] = { ...stage, order: stages[index]?.order ?? stage.order };
    return index;
  }
  stages.push(stage);
  return stages.length - 1;
}

export function elapsedMessage(message: string, startedAt: number) {
  return `${message}，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`;
}
