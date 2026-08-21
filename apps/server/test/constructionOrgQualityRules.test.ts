import { describe, expect, it } from 'vitest';
import { constructionOrgChapterRulePrompt, constructionOrgControlLoopIssues, constructionOrgGenericLanguageIssues, replaceConstructionOrgGenericPhrases } from '../src/services/document-workflow/constructionOrgQualityRules';
import { constructionOrgConsistencyIssues } from '../src/services/document-workflow/constructionOrgConsistency';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplateChapter } from '../src/services/document-workflow/types';

function templateChapter(title: string, sections: string[] = []): DocumentTemplateChapter {
  return { id: title, title, purpose: title, queries: [title], requiredFacts: [], sections };
}

function draft(title: string, content: string, sections: string[] = []): DocumentDraftChapter {
  return { id: title, title, content, sections, evidence: [], missingFacts: [] };
}

const factsModel: DocumentFactsModel = {
  project: [{ key: 'projectName', fieldName: '工程名称', value: '合肥示例项目', sourceFile: '招标文件.docx', confidence: 0.9, roleId: 'project' }],
  schedule: [{ key: 'duration', fieldName: '计划工期', value: '120日历天', sourceFile: '招标文件.docx', confidence: 0.9, roleId: 'schedule' }],
  quality: [],
  safety: [],
  resources: [],
  preciseFacts: [],
  bills: [],
  drawings: [],
  rules: [],
  specifications: [],
  tables: [],
  schemaFacts: {},
  factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] },
  missing: [],
  conflicts: [],
};

describe('construction organization quality rules', () => {
  it('injects closed-loop and anti-generic writing prompts', () => {
    const prompt = constructionOrgChapterRulePrompt(templateChapter('质量安全保障措施', ['质量管理体系与质量保证措施', '安全管理、风险分级与危大工程管控']));
    expect(prompt).toContain('禁止空话套话');
    expect(prompt).toContain('质量类内容必须形成');
    expect(prompt).toContain('安全类内容必须形成');
  });

  it('detects generic language and missing control loops', () => {
    const chapters = [draft('安全管理措施', '本章将加强管理，确保质量，做好安全管理。', ['安全管理、风险分级与危大工程管控'])];
    expect(constructionOrgGenericLanguageIssues(chapters)[0]?.message).toContain('空泛套话');
    expect(constructionOrgControlLoopIssues(chapters)[0]?.message).toContain('安全闭环');
  });

  it('replaces weak generic phrases in generated content', () => {
    const content = replaceConstructionOrgGenericPhrases('加强管理，严格控制，及时处理。');
    expect(content).toContain('责任岗位');
    expect(content).toContain('复查销项');
  });

  it('flags consistency risk against known project facts', () => {
    const issues = constructionOrgConsistencyIssues('施工组织设计\n工程名称：其他项目\n计划工期：90日历天', factsModel);
    expect(issues.some(issue => issue.message.includes('工程名称'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('总工期'))).toBe(true);
  });

  it('does not treat ordinary duration text as total construction period', () => {
    const issues = constructionOrgConsistencyIssues('施工组织设计\n混凝土养护不少于14日历天。\n计划工期：120日历天', factsModel);
    expect(issues.some(issue => issue.message.includes('总工期'))).toBe(false);
  });
});
