import type { DocumentTemplate } from './documentWorkflowService';
import type { AutoDocumentSpecPackage } from './autoDocumentSpecTypes';
import type { ProjectMaterialSummary } from './projectMaterialService';
import { materialRoleSatisfactionRate, type ResolvedMaterialRole } from './materialRoleResolver';

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
  if (input.template.chapters.length === 0 && input.spec.chapterRules.length === 0 && input.spec.chapterMode !== 'dynamic') blockingIssues.push('模板缺少章节，后台自动规范无法形成稳定结构');
  if (input.template.chapters.some(chapter => !chapter.purpose && (!chapter.queries || chapter.queries.length === 0) && (!chapter.requiredFacts || chapter.requiredFacts.length === 0))) warnings.push('部分模板章节缺少 purpose、queries 或 requiredFacts，生成质量可能不稳定');
  if (input.summary.source.ambiguous) blockingIssues.push(input.summary.source.selectionReason);
  if (input.summary.fingerprint.confidence < 0.34) warnings.push('项目指纹置信度较低，建议绑定明确的项目资料文件');
  if (input.summary.coverage.materialCompletenessRate < 0.5) blockingIssues.push('项目资料覆盖率过低，无法支撑正式文件生成');
  if (missingRoles.length > 0) warnings.push(`模板必需资料角色未完全满足：${missingRoles.join('、')}`);
  if (weakRoles.length > 0) warnings.push(`部分资料角色证据较弱：${weakRoles.join('、')}`);
  const specParts = [input.spec.factFields.length > 0, input.spec.chapterRules.length > 0 || input.spec.chapterMode === 'dynamic', input.spec.gateRules.length > 0];
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

export function readinessPrompt(readiness: DocumentGenerationReadiness) {
  return [
    '## 后台生成准备度',
    `可生成：${readiness.ready ? '是' : '否'}`,
    `资料覆盖率：${Math.round(readiness.materialCoverageRate * 100)}%`,
    `资料角色满足率：${Math.round(readiness.roleSatisfactionRate * 100)}%`,
    `规范完整度：${Math.round(readiness.specCompletenessRate * 100)}%`,
    readiness.missingRoles.length ? `缺失角色：${readiness.missingRoles.join('、')}` : '',
    readiness.weakRoles.length ? `较弱角色：${readiness.weakRoles.join('、')}` : '',
  ].filter(Boolean).join('\n');
}
