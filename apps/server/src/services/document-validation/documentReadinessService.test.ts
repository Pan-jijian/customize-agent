/**
 * documentReadinessService 纯函数单测：
 * evaluateDocumentReadiness（角色缺失/弱证据/阻断与警告聚合/章节诊断）
 * 与 readinessPrompt（公开安全版与后台版输出差异）。
 */
import { describe, expect, it } from 'vitest';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { MaterialRole, ProjectMaterialSummary, MaterialEvidenceRef } from '../document-core/projectMaterialService';
import type { ResolvedMaterialRole } from '../document-core/materialRoleResolver';
import type { DocumentTemplate, DocumentTemplateChapter } from '../document-workflow/types';
import { evaluateDocumentReadiness, readinessPrompt, type DocumentGenerationReadiness } from './documentReadinessService';

function makeChapter(partial: Partial<DocumentTemplateChapter>): DocumentTemplateChapter {
  return { id: 'ch1', title: '工程概况', purpose: '介绍工程概况', queries: ['工程基本情况'], requiredFacts: [], ...partial };
}

function makeTemplate(chapters: DocumentTemplateChapter[]): DocumentTemplate {
  return {
    id: 'tpl-1',
    name: '施工组织设计',
    description: '施工组织设计模板',
    category: '施工方案',
    outputTitle: '施工组织设计',
    chapters,
  };
}

function makeSpec(): AutoDocumentSpecPackage {
  return {
    id: 'spec-1',
    name: '测试规范包',
    description: '',
    factFields: [
      { id: 'f-area', name: '总建筑面积', type: 'auto', required: true },
      { id: 'f-quality', name: '质量要求', type: 'auto', required: true },
    ],
    chapterMode: 'fixed',
    chapterRules: [
      { id: 'ch1', title: '工程概况', required: true, order: 0, requiredFactIds: ['f-area'] },
      { id: 'ch2', title: '质量管理措施', required: true, order: 1, requiredFactIds: ['f-quality'] },
    ],
    dynamicChapterRule: { source: 'ai_plan', minChapters: 0, maxChapters: 0 },
    gateRules: [],
  };
}

function makeRef(filePath: string, role: MaterialRole = 'project_overview'): MaterialEvidenceRef {
  return { filePath, fileName: filePath.split('/').pop() || filePath, role };
}

function makeSummary(partial: Partial<ProjectMaterialSummary> = {}): ProjectMaterialSummary {
  return {
    projectId: 'p1',
    projectName: '示例项目',
    generatedAt: Date.now(),
    fingerprint: { projectNames: [], documentNos: [], fileGroups: [], confidence: 0.9 },
    contaminationCandidates: [],
    source: { totalFiles: 5, selectedFiles: 5, selectionReason: '已绑定 5 份资料', ambiguous: false },
    facts: {},
    materialInventory: {
      project_overview: [makeRef('材料1.pdf')],
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
    },
    extractedSections: {
      projectOverview: '', scopeSummary: '', designSummary: '', structuredDataSummary: '', scheduleQualitySafetySummary: '', constraintsAndRisks: '',
    },
    coverage: { requiredRoles: ['project_overview'], satisfiedRoles: ['project_overview'], missingRoles: [] },
    ...partial,
  };
}

function makeResolvedRole(partial: Partial<ResolvedMaterialRole>): ResolvedMaterialRole {
  return {
    role: 'project_overview',
    required: true,
    satisfied: true,
    weak: false,
    evidenceCount: 1,
    filePaths: ['材料1.pdf'],
    reason: '已匹配 1 个资料文件',
    ...partial,
  };
}

describe('evaluateDocumentReadiness 角色与阻断', () => {
  it('无阻断时 ready=true 且含资料范围诊断', () => {
    const result = evaluateDocumentReadiness({
      template: makeTemplate([makeChapter({})]),
      spec: makeSpec(),
      summary: makeSummary(),
      resolvedRoles: [makeResolvedRole({})],
    });
    expect(result.ready).toBe(true);
    expect(result.blockingIssues).toEqual([]);
    expect(result.diagnostics.join('\n')).toContain('资料范围');
  });

  it('资料选择模糊 → 阻断并携带原因', () => {
    const summary = makeSummary({ source: { totalFiles: 5, selectedFiles: 2, selectionReason: '存在多组同名资料', ambiguous: true } });
    const result = evaluateDocumentReadiness({
      template: makeTemplate([makeChapter({})]),
      spec: makeSpec(),
      summary,
      resolvedRoles: [],
    });
    expect(result.ready).toBe(false);
    expect(result.blockingIssues).toContain('存在多组同名资料');
  });

  it('未绑定文件 → 阻断', () => {
    const summary = makeSummary({ source: { totalFiles: 3, selectedFiles: 0, selectionReason: '未绑定', ambiguous: false } });
    const result = evaluateDocumentReadiness({
      template: makeTemplate([makeChapter({})]),
      spec: makeSpec(),
      summary,
      resolvedRoles: [],
    });
    expect(result.ready).toBe(false);
    expect(result.blockingIssues).toContain('未绑定可用项目资料文件，无法支撑文档生成');
  });

  it('missingRoles 收集必需且未满足的角色', () => {
    const result = evaluateDocumentReadiness({
      template: makeTemplate([makeChapter({})]),
      spec: makeSpec(),
      summary: makeSummary(),
      resolvedRoles: [
        makeResolvedRole({ role: 'design_specification', required: true, satisfied: false }),
        makeResolvedRole({ role: 'budget_cost', required: false, satisfied: false }),
      ],
    });
    expect(result.missingRoles).toEqual(['design_specification']);
  });

  it('weakRoles 收集弱证据角色', () => {
    const result = evaluateDocumentReadiness({
      template: makeTemplate([makeChapter({})]),
      spec: makeSpec(),
      summary: makeSummary(),
      resolvedRoles: [
        makeResolvedRole({ role: 'requirement_document', required: true, satisfied: true, weak: true }),
      ],
    });
    expect(result.weakRoles).toEqual(['requirement_document']);
  });

  it('可选角色未满足不阻断且不进入 missingRoles', () => {
    const result = evaluateDocumentReadiness({
      template: makeTemplate([makeChapter({})]),
      spec: makeSpec(),
      summary: makeSummary(),
      resolvedRoles: [makeResolvedRole({ role: 'addendum', required: false, satisfied: false, weak: false })],
    });
    expect(result.ready).toBe(true);
    expect(result.missingRoles).toEqual([]);
    expect(result.diagnostics.some(line => line.includes('可选资料角色未识别：addendum'))).toBe(true);
  });
});

describe('evaluateDocumentReadiness 警告聚合', () => {
  const baseInput = () => ({
    template: makeTemplate([makeChapter({})]),
    spec: makeSpec(),
    summary: makeSummary(),
    resolvedRoles: [makeResolvedRole({})],
  });

  it('空章节模板 → 警告', () => {
    const result = evaluateDocumentReadiness({ ...baseInput(), template: makeTemplate([]) });
    expect(result.warnings).toContain('模板未配置章节，建议通过模板章节或显式 OUTLINE 提供文档结构');
  });

  it('章节缺 purpose 且无 queries/requiredFacts → 警告', () => {
    const chapter = makeChapter({ purpose: '', queries: [], requiredFacts: [] });
    const result = evaluateDocumentReadiness({ ...baseInput(), template: makeTemplate([chapter]) });
    expect(result.warnings).toContain('部分模板章节缺少 purpose、queries 或 requiredFacts，生成质量可能不稳定');
  });

  it('指纹置信度过低 → 警告', () => {
    const summary = makeSummary({ fingerprint: { projectNames: [], documentNos: [], fileGroups: [], confidence: 0.2 } });
    const result = evaluateDocumentReadiness({ ...baseInput(), summary });
    expect(result.warnings).toContain('材料指纹置信度较低，建议绑定明确的材料文件');
  });

  it('未绑定且缺角色 → 双警告', () => {
    const summary = makeSummary({ source: { totalFiles: 3, selectedFiles: 0, selectionReason: '未绑定', ambiguous: false } });
    const result = evaluateDocumentReadiness({
      ...baseInput(),
      summary,
      resolvedRoles: [makeResolvedRole({ role: 'design_specification', required: true, satisfied: false })],
    });
    expect(result.warnings).toContain('模板未绑定可用项目资料文件，请先绑定参与生成的资料');
  });

  it('未绑定且有弱证据角色 → 警告', () => {
    const summary = makeSummary({ source: { totalFiles: 3, selectedFiles: 0, selectionReason: '未绑定', ambiguous: false } });
    const result = evaluateDocumentReadiness({
      ...baseInput(),
      summary,
      resolvedRoles: [makeResolvedRole({ role: 'requirement_document', required: true, satisfied: true, weak: true })],
    });
    expect(result.warnings).toContain('绑定资料证据较弱，请确认资料已完成索引');
  });

  it('章节证据为 0 → 弱章节警告（罗列标题）', () => {
    // summary 库存仅 project_overview；ch2 质量管理规则要求质量事实，其角色推断为 schedule_quality_safety 无库存
    const template = makeTemplate([
      makeChapter({ id: 'ch1', title: '工程概况' }),
      makeChapter({ id: 'ch2', title: '质量管理措施', purpose: '质量保障措施', queries: ['质量控制'], requiredFacts: [] }),
    ]);
    const result = evaluateDocumentReadiness({ ...baseInput(), template });
    expect(result.warnings.some(warning => warning.includes('章节级证据覆盖较弱'))).toBe(true);
  });

  it('全部满足 → 无警告', () => {
    const result = evaluateDocumentReadiness(baseInput());
    expect(result.warnings).toEqual([]);
  });
});

describe('evaluateDocumentReadiness 章节诊断', () => {
  it('角色推断与满足判定', () => {
    // ch2 质量章节 → 推断 schedule_quality_safety；库存有该角色 2 份 → 满足且证据数 2
    const summary = makeSummary({
      materialInventory: {
        project_overview: [makeRef('材料1.pdf')],
        requirement_document: [],
        addendum: [],
        structured_data: [],
        budget_cost: [],
        design_specification: [],
        resource_recommendation: [],
        schedule_quality_safety: [makeRef('材料2.pdf', 'schedule_quality_safety'), makeRef('材料3.pdf', 'schedule_quality_safety')],
        scope_description: [],
        technical_specification: [],
        risk_constraints: [],
      },
    });
    const template = makeTemplate([
      makeChapter({ id: 'ch2', title: '质量管理措施', purpose: '质量保障', queries: [], requiredFacts: [] }),
    ]);
    const result = evaluateDocumentReadiness({
      template,
      spec: makeSpec(),
      summary,
      resolvedRoles: [],
    });
    const diag = result.chapterDiagnostics.find(item => item.chapterId === 'ch2');
    expect(diag).toBeDefined();
    expect(diag!.satisfiedRoles).toContain('schedule_quality_safety');
    expect(diag!.evidenceCount).toBe(2);
  });

  it('事实覆盖判定：库存角色满足时事实视为覆盖', () => {
    const summary = makeSummary();
    const template = makeTemplate([makeChapter({ id: 'ch1', title: '工程概况' })]);
    const result = evaluateDocumentReadiness({ template, spec: makeSpec(), summary, resolvedRoles: [] });
    const diag = result.chapterDiagnostics.find(item => item.chapterId === 'ch1');
    // ch1 要求 f-area（总建筑面积）→ inferMaterialRoles('总建筑面积') 无关键词命中 → 兜底 project_overview
    // 库存有 project_overview → 覆盖
    expect(diag!.requiredFacts).toContain('总建筑面积');
    expect(diag!.coveredFacts).toContain('总建筑面积');
    expect(diag!.missingFacts).toEqual([]);
  });
});

describe('readinessPrompt 输出', () => {
  function makeReadiness(partial: Partial<DocumentGenerationReadiness> = {}): DocumentGenerationReadiness {
    return {
      ready: true,
      missingRoles: [],
      weakRoles: [],
      diagnostics: ['资料范围：已绑定'],
      chapterDiagnostics: [
        {
          chapterId: 'ch1',
          title: '工程概况',
          requiredFacts: ['总建筑面积'],
          coveredFacts: [],
          missingFacts: ['总建筑面积'],
          requiredRoles: ['project_overview'],
          satisfiedRoles: ['project_overview'],
          evidenceCount: 1,
        },
      ],
      blockingIssues: [],
      warnings: [],
      ...partial,
    };
  }

  it('后台版含可生成状态与标题', () => {
    const prompt = readinessPrompt(makeReadiness());
    expect(prompt).toContain('## 后台生成准备度');
    expect(prompt).toContain('可生成：是');
  });

  it('后台版 ready=false 显示否', () => {
    const prompt = readinessPrompt(makeReadiness({ ready: false, blockingIssues: ['未绑定'] }));
    expect(prompt).toContain('可生成：否');
  });

  it('后台版缺角色与弱证据时输出对应诊断行', () => {
    const prompt = readinessPrompt(makeReadiness({ missingRoles: ['design_specification'], weakRoles: ['budget_cost'] }));
    expect(prompt).toContain('部分模板期望资料类型未从绑定文件中明确识别');
    expect(prompt).toContain('部分资料类型证据较弱');
  });

  it('后台版弱章节证据风险行包含缺失事实', () => {
    const prompt = readinessPrompt(makeReadiness());
    expect(prompt).toContain('章节级证据风险');
    expect(prompt).toContain('总建筑面积');
  });

  it('公开安全版使用事实使用边界标题且不含后台字样', () => {
    const prompt = readinessPrompt(makeReadiness(), { publicSafe: true });
    expect(prompt).toContain('## 生成事实使用边界');
    expect(prompt).not.toContain('后台');
    expect(prompt).toContain('资料不足的事实不得编造');
  });

  it('公开安全版无弱章节时不输出风险行', () => {
    const prompt = readinessPrompt(makeReadiness({ chapterDiagnostics: [] }), { publicSafe: true });
    expect(prompt).not.toContain('章节证据风险');
  });
});
