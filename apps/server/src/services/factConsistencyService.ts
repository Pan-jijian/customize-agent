import type { DocumentFact, ValidationIssue } from './documentWorkflowService';
import type { ProjectMaterialSummary } from './projectMaterialService';

function normalize(value: string) {
  return value.replace(/\s+/gu, '').replace(/[，。,.;；：:]/gu, '').toLowerCase();
}

function valuesFor(facts: DocumentFact[], keys: string[]) {
  return facts.filter(fact => keys.some(key => fact.key.includes(key) || fact.fieldName?.includes(key))).map(fact => ({ value: String(fact.value), source: fact.sourceFile }));
}

export function validateFactConsistency(input: { markdown: string; facts: DocumentFact[]; summary: ProjectMaterialSummary }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const checks = [
    { label: '项目名称', keys: ['项目名称', '工程名称'] },
    { label: '招标编号', keys: ['招标编号', '项目编号'] },
    { label: '工期要求', keys: ['工期', '进度节点'] },
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
    issues.push({ level: 'error', message: `正文未包含当前项目名称：${projectName}`, suggestion: '请重新生成，确保标题或工程概况体现当前项目名称。' });
  }
  return issues;
}
