import type { DocumentTemplate } from '../document-workflow/types';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { MaterialRole, ProjectMaterialSummary } from '../document-core/projectMaterialService';
import { materialRoleSatisfactionRate, type ResolvedMaterialRole } from '../document-core/materialRoleResolver';
import { applyKeywordRules, MATERIAL_ROLE_RULES } from '../document-core/documentSemanticRules';

export interface ChapterReadinessDiagnostic {
  chapterId: string;
  title: string;
  requiredFacts: string[];
  coveredFacts: string[];
  missingFacts: string[];
  requiredRoles: MaterialRole[];
  satisfiedRoles: MaterialRole[];
  evidenceCount: number;
  readinessRate: number;
}

export interface DocumentGenerationReadiness {
  ready: boolean;
  materialCoverageRate: number;
  roleSatisfactionRate: number;
  specCompletenessRate: number;
  missingRoles: string[];
  weakRoles: string[];
  chapterDiagnostics: ChapterReadinessDiagnostic[];
  blockingIssues: string[];
  warnings: string[];
}

function unique<T>(items: T[]) {
  return [...new Set(items.filter(Boolean))];
}

function factNamesForChapter(chapter: DocumentTemplate['chapters'][number], spec: AutoDocumentSpecPackage) {
  const rule = spec.chapterRules.find(item => item.id === chapter.id || item.title === chapter.title);
  const specFacts = (rule?.requiredFactIds || [])
    .map(id => spec.factFields.find(field => field.id === id)?.name)
    .filter(Boolean) as string[];
  return unique([...(chapter.requiredFacts || []), ...specFacts]);
}

function inferMaterialRoles(text: string): MaterialRole[] {
  const roles = applyKeywordRules(text, MATERIAL_ROLE_RULES);
  if (roles.length > 0) return roles;
  return ['project_overview'];
}

function evaluateChapterDiagnostics(template: DocumentTemplate, spec: AutoDocumentSpecPackage, summary: ProjectMaterialSummary): ChapterReadinessDiagnostic[] {
  return template.chapters.map(chapter => {
    const requiredFacts = factNamesForChapter(chapter, spec);
    const chapterText = [chapter.title, chapter.purpose, ...(chapter.queries || []), ...(chapter.sections || [])].join('\n');
    const roleHints = unique([
      ...inferMaterialRoles(chapterText),
      ...requiredFacts.flatMap(fact => inferMaterialRoles(fact)),
    ]);
    const satisfiedRoles = roleHints.filter(role => (summary.materialInventory[role] || []).length > 0);
    const evidenceCount = satisfiedRoles.reduce((sum, role) => sum + (summary.materialInventory[role] || []).length, 0);
    const coveredFacts = requiredFacts.filter(fact => inferMaterialRoles(fact).some(role => satisfiedRoles.includes(role)));
    const missingFacts = requiredFacts.filter(fact => !coveredFacts.includes(fact));
    const factScore = requiredFacts.length > 0 ? coveredFacts.length / requiredFacts.length : 1;
    const roleScore = roleHints.length > 0 ? satisfiedRoles.length / roleHints.length : 1;
    const evidenceScore = evidenceCount > 0 ? 1 : 0;
    return {
      chapterId: chapter.id,
      title: chapter.title,
      requiredFacts,
      coveredFacts,
      missingFacts,
      requiredRoles: roleHints,
      satisfiedRoles,
      evidenceCount,
      readinessRate: Math.min(1, (factScore * 0.5) + (roleScore * 0.3) + (evidenceScore * 0.2)),
    };
  });
}

export function evaluateDocumentReadiness(input: {
  template: DocumentTemplate;
  spec: AutoDocumentSpecPackage;
  summary: ProjectMaterialSummary;
  resolvedRoles: ResolvedMaterialRole[];
}): DocumentGenerationReadiness {
  const missingRoles = input.resolvedRoles.filter(role => role.required && !role.satisfied).map(role => role.role);
  const weakRoles = input.resolvedRoles.filter(role => role.weak).map(role => role.role);
  const chapterDiagnostics = evaluateChapterDiagnostics(input.template, input.spec, input.summary);
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  if (input.template.chapters.length === 0) warnings.push('模板未配置章节，建议通过模板章节或显式 OUTLINE 提供文档结构');
  if (input.template.chapters.some(chapter => !chapter.purpose && (!chapter.queries || chapter.queries.length === 0) && (!chapter.requiredFacts || chapter.requiredFacts.length === 0))) warnings.push('部分模板章节缺少 purpose、queries 或 requiredFacts，生成质量可能不稳定');
  if (input.summary.source.ambiguous) blockingIssues.push(input.summary.source.selectionReason);
  if (input.summary.fingerprint.confidence < 0.34) warnings.push('材料指纹置信度较低，建议绑定明确的材料文件');
  if (input.summary.source.selectedFiles === 0) blockingIssues.push('未绑定可用项目资料文件，无法支撑文档生成');
  if (missingRoles.length > 0 && input.summary.source.selectedFiles === 0) warnings.push('模板未绑定可用项目资料文件，请先绑定参与生成的资料');
  if (weakRoles.length > 0 && input.summary.source.selectedFiles === 0) warnings.push('绑定资料证据较弱，请确认资料已完成索引');
  const weakChapters = chapterDiagnostics.filter(chapter => chapter.readinessRate < 0.5);
  if (weakChapters.length > 0) warnings.push(`章节级证据覆盖较弱：${weakChapters.slice(0, 5).map(chapter => `${chapter.title} ${Math.round(chapter.readinessRate * 100)}%`).join('、')}`);
  const emptyEvidenceChapters = chapterDiagnostics.filter(chapter => chapter.requiredFacts.length > 0 && chapter.evidenceCount === 0);
  if (emptyEvidenceChapters.length > 0) warnings.push(`部分章节缺少匹配证据：${emptyEvidenceChapters.slice(0, 5).map(chapter => chapter.title).join('、')}`);
  const specParts = [input.spec.factFields.length > 0, input.spec.chapterRules.length > 0, input.spec.gateRules.length > 0];
  return {
    ready: blockingIssues.length === 0,
    materialCoverageRate: input.summary.coverage.materialCompletenessRate,
    roleSatisfactionRate: materialRoleSatisfactionRate(input.resolvedRoles),
    specCompletenessRate: specParts.filter(Boolean).length / specParts.length,
    missingRoles,
    weakRoles,
    chapterDiagnostics,
    blockingIssues,
    warnings,
  };
}

export function readinessPrompt(readiness: DocumentGenerationReadiness, options: { publicSafe?: boolean } = {}) {
  const weakChapterLines = readiness.chapterDiagnostics
    .filter(chapter => chapter.readinessRate < 0.7 || chapter.missingFacts.length > 0)
    .slice(0, 8)
    .map(chapter => `${chapter.title}：${Math.round(chapter.readinessRate * 100)}%，证据 ${chapter.evidenceCount} 条${chapter.missingFacts.length ? `，缺失 ${chapter.missingFacts.slice(0, 6).join('、')}` : ''}`);
  if (options.publicSafe) {
    return [
      '## 生成事实使用边界',
      `资料覆盖程度：${Math.round(readiness.materialCoverageRate * 100)}%`,
      `资料角色满足程度：${Math.round(readiness.roleSatisfactionRate * 100)}%`,
      weakChapterLines.length ? `章节证据风险：\n${weakChapterLines.join('\n')}` : '',
      '资料不足的事实不得编造；仅施工组织、计划安排、资源配置类数据可在文档要求允许时进行计划推导并标注。',
    ].filter(Boolean).join('\n');
  }
  return [
    '## 后台生成准备度',
    `可生成：${readiness.ready ? '是' : '否'}`,
    `资料覆盖率：${Math.round(readiness.materialCoverageRate * 100)}%`,
    `资料角色满足率：${Math.round(readiness.roleSatisfactionRate * 100)}%`,
    `优化建议完整度：${Math.round(readiness.specCompletenessRate * 100)}%`,
    readiness.missingRoles.length ? `资料诊断：部分模板期望资料类型未从绑定文件中明确识别，生成时仅使用已绑定资料中的事实` : '',
    readiness.weakRoles.length ? `资料诊断：部分资料类型证据较弱，生成时不得补写资料未明确的事实` : '',
    weakChapterLines.length ? `章节级证据风险：\n${weakChapterLines.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}
