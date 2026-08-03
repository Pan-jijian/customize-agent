import { DEFAULT_DOCUMENT_DOMAIN_PROFILE, factFieldForLabel, isDiagnosticFactValue, isForbiddenFactValue, type DocumentDomainProfile } from '../document-core/documentDomainProfileService';
import type { DocumentFact, ValidationIssue } from '../document-workflow/types';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';

function normalize(value: string) {
  return value.replace(/[（(]\d+[）)]/gu, '').replace(/副本|最终版|扫描件|定稿/gu, '').replace(/\s+/gu, '').replace(/[，。,.;；：:《》“”‘’()（）_-]/gu, '').toLowerCase();
}

function comparableValue(value: string, profile: DocumentDomainProfile) {
  const trimmed = value.trim();
  if (isDiagnosticFactValue(profile, trimmed) || isForbiddenFactValue(profile, trimmed)) return '';
  const normalized = normalize(trimmed);
  if (!normalized || normalized.length > 80) return '';
  return normalized;
}

function shouldCheckStrictConflict(label: string, profile: DocumentDomainProfile) {
  const field = factFieldForLabel(profile, label);
  if (field) return field.cardinality === 'single' && field.conflictPolicy !== 'allow_multiple' && field.conflictPolicy !== 'ignore';
  return /项目名称|工程名称|招标人|建设地点|建筑面积|结构形式|层数|工期|质量标准|合同价格形式|绿色建筑等级|投标有效期|质保期/u.test(label);
}

function looksLikePathBundleName(value: string) {
  return /--|延期到|资料|附件|扫描|目录|汇总|打包|备份|招标工程量清单封面|招标工程量清单扉页|工程量清单表|清单封面|清单扉页|\d{1,2}\.\d{1,2}/u.test(value);
}

export function validateFactConsistency(input: { markdown: string; facts: DocumentFact[]; summary: ProjectMaterialSummary; profile?: DocumentDomainProfile }): ValidationIssue[] {
  const profile = input.profile || DEFAULT_DOCUMENT_DOMAIN_PROFILE;
  const issues: ValidationIssue[] = [];
  const factsByName = new Map<string, Array<{ value: string; source: string }>>();
  for (const fact of input.facts) {
    const label = fact.fieldName || fact.key;
    if (!label || !shouldCheckStrictConflict(label, profile)) continue;
    const value = comparableValue(String(fact.value), profile);
    if (!value) continue;
    factsByName.set(label, [...(factsByName.get(label) || []), { value: String(fact.value), source: fact.sourceFile }]);
  }
  for (const [label, values] of factsByName) {
    const grouped = new Map<string, Array<{ value: string; source: string }>>();
    for (const item of values) {
      const key = comparableValue(item.value, profile);
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) || []), item]);
    }
    if (grouped.size > 1) {
      const detail = [...grouped.values()].map(group => `${group[0]!.value}（${group.map(item => item.source).filter(Boolean).join('、') || '未知来源'}）`).join(' vs ');
      issues.push({ level: 'error', message: `事实一致性冲突：${label} 存在多个值：${detail}`, suggestion: '请确认当前绑定材料组，或在模板绑定中只绑定当前文档所需材料。' });
    }
  }
  const projectName = input.summary.facts.projectName;
  if (projectName && projectName !== '当前知识库项目' && !looksLikePathBundleName(projectName)) {
    const normalizedMarkdown = normalize(input.markdown);
    const coreNames = [projectName, ...input.summary.fingerprint.projectNames]
      .flatMap(name => [name, name.replace(/^\d+(?:\.\d+)?[^\u4e00-\u9fa5]*/u, ''), name.replace(/\([^)]*\)|（[^）]*）/gu, '')])
      .map(name => normalize(name))
      .filter(name => name.length >= 8);
    if (!coreNames.some(name => normalizedMarkdown.includes(name) || (name.length >= 12 && normalizedMarkdown.includes(name.slice(0, Math.max(8, Math.floor(name.length * 0.72))))))) {
      issues.push({ level: 'warning', message: `正文未包含当前对象名称：${projectName}`, suggestion: '请确认标题、概况或背景信息是否已体现当前对象名称。' });
    }
  }
  return issues;
}
