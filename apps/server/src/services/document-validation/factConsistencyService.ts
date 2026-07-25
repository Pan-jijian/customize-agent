import type { DocumentFact, ValidationIssue } from '../document-workflow/types';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';

function normalize(value: string) {
  return value.replace(/\s+/gu, '').replace(/[，。,.;；：:]/gu, '').toLowerCase();
}

function valuesFor(facts: DocumentFact[], keys: string[]) {
  return facts.filter(fact => keys.some(key => fact.key.includes(key) || fact.fieldName?.includes(key))).map(fact => ({ value: String(fact.value), source: fact.sourceFile }));
}

export function validateFactConsistency(input: { markdown: string; facts: DocumentFact[]; summary: ProjectMaterialSummary }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const checks = [
    { label: '项目名称', keys: ['项目名称', '任务名称', '文档名称'] },
    { label: '项目编号', keys: ['项目编号', '任务编号', '文档编号', '合同编号'] },
    { label: '周期要求', keys: ['周期', '进度节点', '完成期限', '交付周期'] },
    { label: '质量要求', keys: ['质量'] },
  ];
  for (const check of checks) {
    const grouped = new Map<string, Array<{ value: string; source: string }>>();
    for (const item of valuesFor(input.facts, check.keys)) {
      const key = normalize(item.value);
      if (!key || key.length < 2) continue;
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    if (grouped.size > 1) {
      const detail = [...grouped.values()].map(group => `${group[0]!.value}（${group.map(item => item.source).filter(Boolean).join('、') || '未知来源'}）`).join(' vs ');
      issues.push({ level: 'error', message: `事实一致性冲突：${check.label} 存在多个值：${detail}`, suggestion: '请确认当前项目资料组，或在模板绑定中只绑定当前项目资料。' });
    }
  }
  const projectName = input.summary.facts.projectName;
  if (projectName && projectName !== '当前知识库项目' && !input.markdown.includes(projectName)) {
    issues.push({ level: 'error', message: `正文未包含当前项目名称：${projectName}`, suggestion: '请重新生成，确保标题、概况或背景信息体现当前项目名称。' });
  }
  return issues;
}
