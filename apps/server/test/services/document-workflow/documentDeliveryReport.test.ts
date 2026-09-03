import { describe, expect, it } from 'vitest';
import { chapterDependencyIssues, documentDeliveryScoreIssues, evidenceUsageCoverageIssues, paragraphGenericIssues } from '@/services/document-workflow/documentDeliveryReport';
import type { DocumentDraftChapter, DocumentFactsModel, EvidenceFactIndex } from '@/services/document-workflow/types';
import type { ProfessionalDepthAnalysis, ProfessionalDepthClassifier } from '@/services/document-workflow/professionalDepthClassifier';

function factsModel(overrides: Partial<DocumentFactsModel> = {}): DocumentFactsModel {
  const emptyIndex: EvidenceFactIndex = { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] };
  return { project: [], schedule: [], quality: [], safety: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [], tables: [], schemaFacts: {}, factIndex: emptyIndex, missing: [], conflicts: [], ...overrides };
}

const fact = (fieldName: string, value: string): DocumentFactsModel['schedule'][number] => ({ fieldId: 'f1', fieldName, key: fieldName, value, sourceFile: '招标文件.pdf', roleId: '', confidence: 1 });

const analysis = (overrides: Partial<ProfessionalDepthAnalysis> = {}): ProfessionalDepthAnalysis => ({
  dimensions: { factuality: false, structure: false, depth: false, executable: false, specificity: false, consistency: false },
  contentNeeds: { schedule: false, quality: false, safety: false, resource: false, construction: false },
  concrete: false,
  closedLoop: false,
  ...overrides,
});

const classifier = (result?: ProfessionalDepthAnalysis): ProfessionalDepthClassifier => ({ analyze: async () => result });

describe('evidenceUsageCoverageIssues（证据使用覆盖率）', () => {
  it('正文提及工期但未使用工期事实报 warning', () => {
    const issues = evidenceUsageCoverageIssues('本工程计划工期540日历天。', factsModel());
    expect(issues.length).toBe(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('工期');
  });

  it('正文使用工期事实不报（归一化口径对齐）', () => {
    const markdown = '本工程计划工期45日历天，各节点按计划推进。';
    const model = factsModel({ schedule: [fact('计划工期', '45日历天')] });
    expect(evidenceUsageCoverageIssues(markdown, model)).toHaveLength(0);
  });

  it('正文未提及维度时不检查该维度', () => {
    const markdown = '本工程质量目标为合格。';
    const issues = evidenceUsageCoverageIssues(markdown, factsModel());
    expect(issues.some(issue => issue.message.includes('工期'))).toBe(false);
    expect(issues.some(issue => issue.message.includes('质量'))).toBe(true);
  });
});

describe('paragraphGenericIssues（段落空泛语义检测）', () => {
  const genericParagraph = '本项目加强组织领导，严格执行规范，落实责任制度，确保工程质量，强化过程管理，提高思想认识，完善管理体系，形成闭环管理，统筹推进各项工作。'.repeat(2);

  it('≥2 处泛化模式且语义判定不具体报 warning', async () => {
    const issues = await paragraphGenericIssues(genericParagraph, classifier(analysis({ concrete: false })));
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('空泛表述');
  });

  it('语义判定具体（concrete）不报', async () => {
    const issues = await paragraphGenericIssues(genericParagraph, classifier(analysis({ concrete: true })));
    expect(issues).toHaveLength(0);
  });

  it('语义分析返回 undefined 跳过（不误报）', async () => {
    const issues = await paragraphGenericIssues(genericParagraph, classifier(undefined));
    expect(issues).toHaveLength(0);
  });

  it('短段落不进入语义分析', async () => {
    let called = false;
    const mock = { analyze: async () => { called = true; return analysis({ concrete: false }); } };
    const issues = await paragraphGenericIssues('加强组织领导、严格执行规范。', mock);
    expect(issues).toHaveLength(0);
    expect(called).toBe(false);
  });
});

describe('chapterDependencyIssues（章节逻辑依赖检测）', () => {
  const chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>> = [
    { title: '进度计划与工期保障', content: '进度内容。' },
    { title: '资源配置计划', content: '资源内容。' },
  ];

  it('未提供语义分析时跳过', () => {
    expect(chapterDependencyIssues(chapters)).toHaveLength(0);
  });

  it('进度章节缺少资源支撑报 warning', () => {
    const analyses = new Map([['资源配置计划', analysis()]]);
    const issues = chapterDependencyIssues(chapters, analyses);
    expect(issues.some(issue => issue.message.includes('进度章节与资源章节'))).toBe(true);
  });

  it('资源章节覆盖投入调配不报', () => {
    const analyses = new Map([['资源配置计划', analysis({ contentNeeds: { schedule: false, quality: false, safety: false, resource: true, construction: false } })]]);
    expect(chapterDependencyIssues(chapters, analyses)).toHaveLength(0);
  });

  it('质量章节未支撑施工工艺控制报 warning', () => {
    const qualityChapters = [{ title: '质量管理体系', content: '质量内容。' }, { title: '主要施工方法', content: '施工内容。' }];
    const analyses = new Map([['质量管理体系', analysis()], ['主要施工方法', analysis()]]);
    const issues = chapterDependencyIssues(qualityChapters, analyses);
    expect(issues.some(issue => issue.message.includes('质量章节未明显支撑'))).toBe(true);
  });

  it('安全章节缺少检查整改应急支撑报 warning', () => {
    const safetyChapters = [{ title: '安全管理', content: '安全内容。' }];
    const analyses = new Map([['安全管理', analysis()]]);
    const issues = chapterDependencyIssues(safetyChapters, analyses);
    expect(issues.some(issue => issue.message.includes('安全章节缺少检查整改'))).toBe(true);
  });
});

describe('documentDeliveryScoreIssues（交付评分报告）', () => {
  const chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>> = [
    { title: '第一章 工程概况', content: '项目位于合肥市，建设规模明确。'.repeat(40) },
  ];
  const markdown = '第一章 工程概况\n项目位于合肥市，建设规模明确。'.repeat(10);

  it('输出唯一 info 级评分报告并含总分', () => {
    const issues = documentDeliveryScoreIssues(markdown, chapters, factsModel());
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('info');
    expect(issues[0].message).toMatch(/总分 \d+\/10/);
  });

  it('结构不满足时结构分降档', () => {
    const shortChapters = [{ title: '第一章 工程概况', content: '短内容。' }];
    const issues = documentDeliveryScoreIssues('第一章 工程概况\n短内容。', shortChapters, factsModel());
    expect(issues[0].message).toMatch(/总分 \d+\/10/);
    expect(issues[0].message).toContain('结构1');
  });
});
