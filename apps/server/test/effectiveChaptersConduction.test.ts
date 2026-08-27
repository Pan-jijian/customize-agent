import { describe, expect, it } from 'vitest';
import { buildStandardFinalValidationIssues } from '../src/services/document-workflow/documentFinalValidation';
import { innovationTechCoverageIssues } from '../src/services/document-workflow/qualityValidation';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplate, DocumentTemplateChapter, PromptBinding, ValidationIssue } from '../src/services/document-workflow/types';

/**
 * effectiveChapters（模块挂靠后大纲）承接传导集成测试：
 * 最终校验的承诺承接检查必须使用模块挂靠后的大纲（含四新等承诺小节），
 * 原始模板未挂靠时承诺检测会静默落空（真实生成缺陷：四新整篇 0 次出现仍评分 100）。
 */
function makeTemplateChapter(id: string, title: string, sections: string[]): DocumentTemplateChapter {
  return { id, title, purpose: '', queries: [], requiredFacts: [], sections };
}

function makeTemplate(chapters: DocumentTemplateChapter[]): DocumentTemplate {
  return {
    id: 'tpl-test',
    name: '施工组织设计',
    description: '测试模板',
    category: 'construction-org',
    outputTitle: '施工组织设计',
    chapters,
    promptBindings: [] as PromptBinding[],
  };
}

function makeEmptyFactsModel(): DocumentFactsModel {
  return {
    project: [],
    schedule: [],
    quality: [],
    safety: [],
    resources: [],
    tables: [],
    drawings: [],
    bills: [],
    preciseFacts: [],
    rules: [],
    specifications: [],
    schemaFacts: {},
    factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] },
    missing: [],
    conflicts: [],
  };
}

function makeDraftChapter(id: string, title: string, content: string): DocumentDraftChapter {
  return { id, title, content, evidence: [], missingFacts: [], sections: [] };
}

const FORMAL_BODY = '本章依据项目实际条件组织施工，责任岗位落实到人，检查频次每班一次，整改复查销项闭环，量化参数与工艺参数落位完整，资料归档同步推进。'.repeat(2);

function runValidation(input: { markdown: string; templateChapters: DocumentTemplateChapter[]; effectiveChapters?: DocumentTemplateChapter[] }) {
  return buildStandardFinalValidationIssues({
    markdown: input.markdown,
    chapters: [makeDraftChapter('ch1', '确保工期与质量的保障体系与措施', input.markdown)],
    factsModel: makeEmptyFactsModel(),
    template: makeTemplate(input.templateChapters),
    promptBindings: [],
    effectiveChapters: input.effectiveChapters,
  });
}

describe('buildStandardFinalValidationIssues effectiveChapters 传导', () => {
  it('原始模板无四新小节但 effectiveChapters 有承诺时，承接检查按 effectiveChapters 生效', () => {
    const committed = makeTemplateChapter('ch1', '确保工期与质量的保障体系与措施', ['新技术、新工艺、新材料、新设备的应用']);
    const raw = makeTemplateChapter('ch1', '确保工期与质量的保障体系与措施', []);
    const markdown = '### 施工方案\n\n本章按传统做法组织施工。' + FORMAL_BODY;
    const issues = runValidation({ markdown, templateChapters: [raw], effectiveChapters: [committed] });
    expect(issues.some((issue: ValidationIssue) => /未在正文成稿/u.test(issue.message))).toBe(true);
  });

  it('原始模板无四新小节且未传 effectiveChapters 时不制造新义务（回退 template.chapters）', () => {
    const raw = makeTemplateChapter('ch1', '确保工期与质量的保障体系与措施', []);
    const markdown = '### 施工方案\n\n本章按传统做法组织施工。' + FORMAL_BODY;
    const issues = runValidation({ markdown, templateChapters: [raw] });
    expect(issues.some((issue: ValidationIssue) => /未在正文成稿/u.test(issue.message))).toBe(false);
  });

  it('effectiveChapters 承诺且正文已成稿时零承接 issue', () => {
    const committed = makeTemplateChapter('ch1', '确保工期与质量的保障体系与措施', ['新技术、新工艺、新材料、新设备的应用']);
    const raw = makeTemplateChapter('ch1', '确保工期与质量的保障体系与措施', []);
    const body = '本项目针对既有建筑改造场景采用激光扫描逆向建模技术建立现状模型，全面应用预制装配式隔墙与管线分离新工艺，主要结构改造采用碳纤维布加固与无收缩灌浆料新材料，配置智能施工升降平台与降噪除尘一体化拆除设备等新设备。'.repeat(3);
    const markdown = `### 新技术、新工艺、新材料、新设备的应用\n\n${body}`;
    const issues = runValidation({ markdown, templateChapters: [raw], effectiveChapters: [committed] });
    expect(issues.some((issue: ValidationIssue) => /未在正文成稿/u.test(issue.message))).toBe(false);
  });

  it('template.chapters 与 effectiveChapters 都含四新承诺时以 effectiveChapters 为准（不重复报）', () => {
    const committed = makeTemplateChapter('ch1', '确保工期与质量的保障体系与措施', ['新技术、新工艺、新材料、新设备的应用']);
    const templateAlsoCommitted = makeTemplateChapter('ch1', '确保工期与质量的保障体系与措施', ['科技创新与四新技术应用']);
    const markdown = '### 施工方案\n\n本章按传统做法组织施工。' + FORMAL_BODY;
    const issues = runValidation({ markdown, templateChapters: [templateAlsoCommitted], effectiveChapters: [committed] });
    const coverage = issues.filter((issue: ValidationIssue) => /未在正文成稿/u.test(issue.message));
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.message).toContain('新技术、新工艺、新材料、新设备的应用');
  });
});

describe('innovationTechCoverageIssues 与 buildStandardFinalValidationIssues 口径一致性', () => {
  it('同一输入下两个入口的承接结论一致（直接调用 vs 集成调用）', () => {
    const committed = makeTemplateChapter('ch1', '确保工期与质量的保障体系与措施', ['新技术、新工艺、新材料、新设备的应用']);
    const markdown = '### 施工方案\n\n本章按传统做法组织施工。' + FORMAL_BODY;
    const direct = innovationTechCoverageIssues(markdown, [committed]);
    const integrated = runValidation({ markdown, templateChapters: [committed], effectiveChapters: [committed] })
      .filter((issue: ValidationIssue) => /未在正文成稿/u.test(issue.message));
    expect(integrated).toHaveLength(direct.length);
    expect(integrated[0]!.message).toContain(direct[0]!.message.slice(0, 20));
  });
});
