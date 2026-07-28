import type { DocumentFact, ValidationIssue } from '../document-workflow/types';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';

function normalize(value: string) {
  return value.replace(/\s+/gu, '').replace(/[，。,.;；：:]/gu, '').toLowerCase();
}

function comparableValue(value: string) {
  const trimmed = value.trim();
  const normalized = normalize(trimmed);
  if (!normalized || normalized.length > 80) return '';
  return normalized;
}

export function validateFactConsistency(input: { markdown: string; facts: DocumentFact[]; summary: ProjectMaterialSummary }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const factsByName = new Map<string, Array<{ value: string; source: string }>>();
  for (const fact of input.facts) {
    const label = fact.fieldName || fact.key;
    if (!label) continue;
    const value = comparableValue(String(fact.value));
    if (!value) continue;
    factsByName.set(label, [...(factsByName.get(label) || []), { value: String(fact.value), source: fact.sourceFile }]);
  }
  for (const [label, values] of factsByName) {
    const grouped = new Map<string, Array<{ value: string; source: string }>>();
    for (const item of values) {
      const key = comparableValue(item.value);
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    if (grouped.size > 1) {
      const detail = [...grouped.values()].map(group => `${group[0]!.value}（${group.map(item => item.source).filter(Boolean).join('、') || '未知来源'}）`).join(' vs ');
      issues.push({ level: 'error', message: `事实一致性冲突：${label} 存在多个值：${detail}`, suggestion: '请确认当前绑定材料组，或在模板绑定中只绑定当前文档所需材料。' });
    }
  }
  const projectName = input.summary.facts.projectName;
  if (projectName && projectName !== '当前知识库项目') {
    const coreNames = [projectName, ...input.summary.fingerprint.projectNames]
      .flatMap(name => [name, name.replace(/^\d+(?:\.\d+)?[^\u4e00-\u9fa5]*/u, ''), name.replace(/\([^)]*\)|（[^）]*）/gu, '')])
      .map(name => name.trim())
      .filter(name => name.length >= 8);
    if (!coreNames.some(name => input.markdown.includes(name))) {
      issues.push({ level: 'error', message: `正文未包含当前对象名称：${projectName}`, suggestion: '请重新生成，确保标题、概况或背景信息体现当前对象名称。' });
    }
  }
  return issues;
}
