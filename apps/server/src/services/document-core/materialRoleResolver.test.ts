/**
 * materialRoleResolver 纯函数单测：
 * resolveTemplateMaterialRoles（必需角色推断/库存满足判定/弱证据判定/原因文案）。
 * 覆盖：文本关键词触发与库存兜底触发、weak 阈值（必需 2 份 / 可选 1 份）、合并去重。
 */
import { describe, expect, it } from 'vitest';
import type { MaterialEvidenceRef, MaterialRole, ProjectMaterialSummary } from './projectMaterialService';
import type { DocumentTemplate, DocumentTemplateChapter } from '../document-workflow/types';
import { resolveTemplateMaterialRoles } from './materialRoleResolver';

function makeChapter(partial: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'ch1', title: '工程概况', purpose: '概述', queries: [], requiredFacts: [], ...partial };
}

function makeTemplate(partial: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: 'tpl-1',
    name: '通用文档',
    description: '',
    category: '报告',
    outputTitle: '',
    chapters: [makeChapter()],
    ...partial,
  };
}

function makeRef(filePath: string, role: MaterialRole = 'project_overview'): MaterialEvidenceRef {
  return { filePath, fileName: filePath, role };
}

function makeInventory(partial: Partial<Record<MaterialRole, MaterialEvidenceRef[]>> = {}): ProjectMaterialSummary['materialInventory'] {
  return {
    project_overview: [],
    requirement_document: [],
    addendum: [],
    structured_data: [],
    budget_cost: [],
    design_specification: [],
    resource_recommendation: [],
    schedule_quality_safety: [],
    scope_description: [],
    technical_specification: [],
    risk_constraints: [],
    ...partial,
  };
}

function makeSummary(inventory: Partial<Record<MaterialRole, MaterialEvidenceRef[]>> = {}): ProjectMaterialSummary {
  return {
    projectId: 'p1',
    projectName: '示例项目',
    generatedAt: Date.now(),
    fingerprint: { projectNames: [], documentNos: [], fileGroups: [], confidence: 0.9 },
    contaminationCandidates: [],
    source: { totalFiles: 5, selectedFiles: 5, selectionReason: '已绑定', ambiguous: false },
    facts: {},
    materialInventory: makeInventory(inventory),
    extractedSections: {
      projectOverview: '', scopeSummary: '', designSummary: '', structuredDataSummary: '', scheduleQualitySafetySummary: '', constraintsAndRisks: '',
    },
    coverage: { requiredRoles: [], satisfiedRoles: [], missingRoles: [] },
  };
}

describe('resolveTemplateMaterialRoles 必需角色推断', () => {
  it('恒有 project_overview 与 scope_description 且为必需', () => {
    const roles = resolveTemplateMaterialRoles(makeTemplate(), makeSummary());
    const overview = roles.find(role => role.role === 'project_overview');
    const scope = roles.find(role => role.role === 'scope_description');
    expect(overview?.required).toBe(true);
    expect(scope?.required).toBe(true);
  });

  it('模板含施工组织 → 需求文档与结构化数据必需', () => {
    const roles = resolveTemplateMaterialRoles(makeTemplate({ name: '施工组织设计' }), makeSummary());
    expect(roles.find(role => role.role === 'requirement_document')?.required).toBe(true);
    expect(roles.find(role => role.role === 'structured_data')?.required).toBe(true);
  });

  it('模板含安全/质量/进度词 → 进度质量合规必需', () => {
    const roles = resolveTemplateMaterialRoles(makeTemplate({ name: '安全文明施工专项方案' }), makeSummary());
    expect(roles.find(role => role.role === 'schedule_quality_safety')?.required).toBe(true);
  });

  it('模板含设计/图纸词 → 设计资料必需', () => {
    const roles = resolveTemplateMaterialRoles(makeTemplate({ name: '图纸会审说明' }), makeSummary());
    expect(roles.find(role => role.role === 'design_specification')?.required).toBe(true);
  });

  it('模板含风险/危大词 → 风险约束必需', () => {
    const roles = resolveTemplateMaterialRoles(makeTemplate({ name: '危大工程风险控制方案' }), makeSummary());
    expect(roles.find(role => role.role === 'risk_constraints')?.required).toBe(true);
  });

  it('文本无关词但库存触发 → 角色必需（库存兜底）', () => {
    const roles = resolveTemplateMaterialRoles(
      makeTemplate({ name: '会议纪要' }),
      makeSummary({ design_specification: [makeRef('a.dwg', 'design_specification')] }),
    );
    expect(roles.find(role => role.role === 'design_specification')?.required).toBe(true);
  });

  it('通用模板无特殊词 → 仅基础角色必需', () => {
    const roles = resolveTemplateMaterialRoles(makeTemplate(), makeSummary());
    const required = roles.filter(role => role.required).map(role => role.role);
    expect(required.sort()).toEqual(['project_overview', 'scope_description'].sort());
  });

  it('章节文本参与关键词推断', () => {
    const template = makeTemplate({
      chapters: [makeChapter({ title: '质量保证措施', purpose: '质量验收流程' })],
    });
    const roles = resolveTemplateMaterialRoles(template, makeSummary());
    expect(roles.find(role => role.role === 'schedule_quality_safety')?.required).toBe(true);
  });
});

describe('resolveTemplateMaterialRoles 满足与弱证据', () => {
  it('必需角色无库存 → 不满足且不弱', () => {
    const roles = resolveTemplateMaterialRoles(makeTemplate({ name: '安全专项方案' }), makeSummary());
    const safety = roles.find(role => role.role === 'schedule_quality_safety');
    expect(safety?.satisfied).toBe(false);
    expect(safety?.weak).toBe(false);
    expect(safety?.reason).toBe('必需资料角色缺失');
  });

  it('必需角色 1 份库存 → 满足且弱', () => {
    const roles = resolveTemplateMaterialRoles(
      makeTemplate({ name: '安全专项方案' }),
      makeSummary({ schedule_quality_safety: [makeRef('a.pdf', 'schedule_quality_safety')] }),
    );
    const safety = roles.find(role => role.role === 'schedule_quality_safety');
    expect(safety?.satisfied).toBe(true);
    expect(safety?.weak).toBe(true);
    expect(safety?.evidenceCount).toBe(1);
  });

  it('必需角色 2 份库存 → 满足且不弱', () => {
    const roles = resolveTemplateMaterialRoles(
      makeTemplate({ name: '安全专项方案' }),
      makeSummary({ schedule_quality_safety: [makeRef('a.pdf', 'schedule_quality_safety'), makeRef('b.pdf', 'schedule_quality_safety')] }),
    );
    const safety = roles.find(role => role.role === 'schedule_quality_safety');
    expect(safety?.satisfied).toBe(true);
    expect(safety?.weak).toBe(false);
  });

  it('可选角色 1 份库存 → 满足且不弱', () => {
    const roles = resolveTemplateMaterialRoles(
      makeTemplate({ name: '预算说明' }),
      makeSummary({ budget_cost: [makeRef('a.xlsx', 'budget_cost')] }),
    );
    const budget = roles.find(role => role.role === 'budget_cost');
    expect(budget?.required).toBe(false);
    expect(budget?.satisfied).toBe(true);
    expect(budget?.weak).toBe(false);
    expect(budget?.reason).toBe('已匹配 1 个资料文件');
  });

  it('可选角色无库存 → 不满足不弱', () => {
    const roles = resolveTemplateMaterialRoles(makeTemplate({ name: '预算说明' }), makeSummary());
    const budget = roles.find(role => role.role === 'budget_cost');
    expect(budget).toBeDefined();
    expect(budget?.satisfied).toBe(false);
    expect(budget?.weak).toBe(false);
    expect(budget?.reason).toBe('可选资料角色缺失');
  });

  it('filePaths 映射库存文件路径', () => {
    const roles = resolveTemplateMaterialRoles(
      makeTemplate(),
      makeSummary({ project_overview: [makeRef('路径/材料.pdf'), makeRef('路径/材料2.pdf')] }),
    );
    const overview = roles.find(role => role.role === 'project_overview');
    expect(overview?.filePaths).toEqual(['路径/材料.pdf', '路径/材料2.pdf']);
  });

  it('结果角色无重复', () => {
    const roles = resolveTemplateMaterialRoles(makeTemplate({ name: '需求方案' }), makeSummary());
    const ids = roles.map(role => role.role);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
