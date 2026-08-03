import type { DocumentTemplate } from '../document-workflow/types';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';
import { materialRoleSatisfactionRate, type ResolvedMaterialRole } from '../document-core/materialRoleResolver';

export interface DocumentGenerationReadiness {
  ready: boolean;
  materialCoverageRate: number;
  roleSatisfactionRate: number;
  specCompletenessRate: number;
  missingRoles: string[];
  weakRoles: string[];
  blockingIssues: string[];
  warnings: string[];
}

export function evaluateDocumentReadiness(input: {
  template: DocumentTemplate;
  spec: AutoDocumentSpecPackage;
  summary: ProjectMaterialSummary;
  resolvedRoles: ResolvedMaterialRole[];
}): DocumentGenerationReadiness {
  const missingRoles = input.resolvedRoles.filter(role => role.required && !role.satisfied).map(role => role.role);
  const weakRoles = input.resolvedRoles.filter(role => role.weak).map(role => role.role);
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  if (input.template.chapters.length === 0) warnings.push('模板未配置章节，建议通过模板章节或显式 OUTLINE 提供文档结构');
  if (input.template.chapters.some(chapter => !chapter.purpose && (!chapter.queries || chapter.queries.length === 0) && (!chapter.requiredFacts || chapter.requiredFacts.length === 0))) warnings.push('部分模板章节缺少 purpose、queries 或 requiredFacts，生成质量可能不稳定');
  if (input.summary.source.ambiguous) blockingIssues.push(input.summary.source.selectionReason);
  if (input.summary.fingerprint.confidence < 0.34) warnings.push('材料指纹置信度较低，建议绑定明确的材料文件');
  if (input.summary.coverage.materialCompletenessRate < 0.5) blockingIssues.push('绑定材料覆盖率过低，无法支撑文档生成');
  if (missingRoles.length > 0) warnings.push(`模板必需材料角色未完全满足：${missingRoles.join('、')}`);
  if (weakRoles.length > 0) warnings.push(`部分材料角色证据较弱：${weakRoles.join('、')}`);
  const specParts = [input.spec.factFields.length > 0, input.spec.chapterRules.length > 0, input.spec.gateRules.length > 0];
  return {
    ready: blockingIssues.length === 0,
    materialCoverageRate: input.summary.coverage.materialCompletenessRate,
    roleSatisfactionRate: materialRoleSatisfactionRate(input.resolvedRoles),
    specCompletenessRate: specParts.filter(Boolean).length / specParts.length,
    missingRoles,
    weakRoles,
    blockingIssues,
    warnings,
  };
}

export function readinessPrompt(readiness: DocumentGenerationReadiness, options: { publicSafe?: boolean } = {}) {
  if (options.publicSafe) {
    return [
      '## 生成事实使用边界',
      `资料覆盖程度：${Math.round(readiness.materialCoverageRate * 100)}%`,
      `资料角色满足程度：${Math.round(readiness.roleSatisfactionRate * 100)}%`,
      '资料不足的事实不得编造；仅施工组织、计划安排、资源配置类数据可在文档要求允许时进行计划推导并标注。',
    ].join('\n');
  }
  return [
    '## 后台生成准备度',
    `可生成：${readiness.ready ? '是' : '否'}`,
    `资料覆盖率：${Math.round(readiness.materialCoverageRate * 100)}%`,
    `资料角色满足率：${Math.round(readiness.roleSatisfactionRate * 100)}%`,
    `优化建议完整度：${Math.round(readiness.specCompletenessRate * 100)}%`,
    readiness.missingRoles.length ? `缺失角色：${readiness.missingRoles.join('、')}` : '',
    readiness.weakRoles.length ? `较弱角色：${readiness.weakRoles.join('、')}` : '',
  ].filter(Boolean).join('\n');
}
