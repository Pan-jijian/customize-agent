/**
 * documentKnowledgeCoverage 单测：章节标题→事实域映射、域事实存在性判定、
 * 证据标签兜底确认、得分/补救语与 knowledgeCoverageIssues 门禁。
 */
import { describe, expect, it } from 'vitest';
import { buildKnowledgeCoverageReport, knowledgeCoverageIssues } from './documentKnowledgeCoverage';
import type { DocumentDraftChapter, DocumentEvidence, DocumentFactsModel, DocumentTemplateChapter } from './types';

function makeFact(key: string, value: string): DocumentFactsModel['project'][number] {
  return { key, value, sourceFile: '/proj/facts.json', roleId: 'role-fact', confidence: 1 };
}

function makeFactsModel(overrides: Partial<DocumentFactsModel> = {}): DocumentFactsModel {
  return {
    project: [], schedule: [], quality: [], safety: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [],
    tables: [], schemaFacts: {},
    factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] },
    missing: [], conflicts: [],
    ...overrides,
  };
}

function makeChapter(id: string, title: string, evidence: DocumentEvidence[] = []): DocumentDraftChapter {
  return { id, title, content: '', evidence, missingFacts: [] };
}

describe('buildKnowledgeCoverageReport', () => {
  it('标题关键词映射事实域：概况→project、进度→schedule、质量→quality+rules、安全→safety+rules', () => {
    const report = buildKnowledgeCoverageReport({
      chapters: [
        makeChapter('c1', '工程概况'),
        makeChapter('c2', '施工进度计划'),
        makeChapter('c3', '质量目标与验收'),
        makeChapter('c4', '安全文明施工'),
        makeChapter('c5', '资源配置计划'),
        makeChapter('c6', '主要施工方案'),
      ],
      templateChapters: [],
      factsModel: makeFactsModel(),
      evidence: [],
    });
    expect(report.chapterReports.map(item => item.requiredDomains)).toEqual([
      ['project'],
      ['project', 'schedule', 'quantities'], // 含 '施工' 追加 quantities
      ['project', 'quality', 'rules'],
      ['project', 'safety', 'rules', 'quantities'], // 含 '施工' 追加 quantities
      ['project', 'resources'],
      ['project', 'quantities'],
    ]);
  });

  it('域事实存在判定：各域对应事实数组', () => {
    const factsModel = makeFactsModel({
      project: [makeFact('k1', '项目名称')],
      schedule: [makeFact('k2', '工期 600 天')],
      quality: [makeFact('k3', '质量目标')],
      safety: [makeFact('k4', '安全目标')],
      resources: [makeFact('k5', '机械 10 台')],
      bills: [makeFact('k6', '清单项')],
      drawings: [makeFact('k7', '图纸')],
      rules: [makeFact('k8', '规范')],
    });
    const report = buildKnowledgeCoverageReport({
      chapters: [makeChapter('c1', '施工进度计划'), makeChapter('c2', '质量目标与验收'), makeChapter('c3', '安全文明施工'), makeChapter('c4', '资源配置计划'), makeChapter('c5', '主要施工方案')],
      templateChapters: [],
      factsModel,
      evidence: [],
    });
    const byTitle = new Map(report.chapterReports.map(item => [item.title, item]));
    expect(byTitle.get('施工进度计划')?.confirmedDomains).toEqual(['project', 'schedule', 'quantities']);
    expect(byTitle.get('质量目标与验收')?.confirmedDomains).toEqual(['project', 'quality', 'rules']);
    expect(byTitle.get('安全文明施工')?.confirmedDomains).toEqual(['project', 'safety', 'rules', 'quantities']);
    expect(byTitle.get('资源配置计划')?.confirmedDomains).toEqual(['project', 'resources']);
    // quantities 域：bills/drawings/tables 任一即可
    expect(byTitle.get('主要施工方案')?.confirmedDomains).toEqual(['project', 'quantities']);
  });

  it('章节证据命中域标签文本也可确认（事实模型缺失时兜底）', () => {
    const evidence: DocumentEvidence[] = [{
      chapterId: 'c1', filePath: '/proj/a.pdf', score: 0,
      content: '本章质量目标与验收：合格率 100%，材料验收执行见证取样制度，符合规范规则与验收要求。',
    }];
    const report = buildKnowledgeCoverageReport({
      chapters: [makeChapter('c1', '质量目标与验收', evidence)],
      templateChapters: [],
      factsModel: makeFactsModel({ project: [makeFact('k1', '项目名称')] }),
      evidence,
    });
    expect(report.chapterReports[0].confirmedDomains).toEqual(['project', 'quality', 'rules']);
  });

  it('单章得分 = 确认域/必需域，整体得分为平均分', () => {
    const factsModel = makeFactsModel({
      project: [makeFact('k1', '项目名称')],
      rules: [makeFact('k8', '规范')],
    });
    const report = buildKnowledgeCoverageReport({
      chapters: [makeChapter('c1', '工程概况'), makeChapter('c2', '安全文明施工')],
      templateChapters: [],
      factsModel,
      evidence: [],
    });
    // c1: 仅 project 域 → 100；c2: project 确认、safety+rules 被 rules 事实共同确认、quantities 缺失 → 3/4 → 75
    expect(report.chapterReports[0].score).toBe(100);
    expect(report.chapterReports[1].score).toBe(75);
    expect(report.score).toBe(88); // round((100+75)/2)=88
  });

  it('证据文件去重计数与 evidenceCount', () => {
    const evidence: DocumentEvidence[] = [
      { chapterId: 'c1', filePath: '/proj/a.pdf', score: 0, content: '' },
      { chapterId: 'c1', filePath: '/proj/a.pdf', score: 0, content: '' },
      { chapterId: 'c1', filePath: '/proj/b.pdf', score: 0, content: '' },
    ];
    const report = buildKnowledgeCoverageReport({
      chapters: [makeChapter('c1', '工程概况')],
      templateChapters: [],
      factsModel: makeFactsModel({ project: [makeFact('k1', '项目名称')] }),
      evidence,
    });
    expect(report.evidenceCount).toBe(3);
    expect(report.confirmedFiles).toBe(2);
  });

  it('全确认（score>=95）补救语为高置信口径，否则为扩大检索口径', () => {
    const factsModel = makeFactsModel({ project: [makeFact('k1', '项目名称')] });
    const high = buildKnowledgeCoverageReport({
      chapters: [makeChapter('c1', '工程概况')],
      templateChapters: [],
      factsModel,
      evidence: [],
    });
    expect(high.score).toBe(100);
    expect(high.remediation).toContain('高置信交付');
    const low = buildKnowledgeCoverageReport({
      chapters: [makeChapter('c1', '安全文明施工')],
      templateChapters: [],
      factsModel,
      evidence: [],
    });
    expect(low.remediation).toContain('扩大本地知识库检索');
  });

  it('章节缺失全部事实域时 unconfirmedDomains 汇总去重', () => {
    const report = buildKnowledgeCoverageReport({
      chapters: [makeChapter('c1', '安全文明施工'), makeChapter('c2', '质量目标与验收')],
      templateChapters: [],
      factsModel: makeFactsModel(),
      evidence: [],
    });
    expect(report.unconfirmedDomains).toEqual(['project', 'safety', 'rules', 'quantities', 'quality']);
  });
});

describe('knowledgeCoverageIssues', () => {
  it('score >= 85 无问题', () => {
    const report = buildKnowledgeCoverageReport({
      chapters: [makeChapter('c1', '工程概况')],
      templateChapters: [],
      factsModel: makeFactsModel({ project: [makeFact('k1', '项目名称')] }),
      evidence: [],
    });
    expect(knowledgeCoverageIssues(report)).toEqual([]);
  });

  it('score < 85 产出 warning 并带未确认事实域', () => {
    const report = buildKnowledgeCoverageReport({
      chapters: [makeChapter('c1', '安全文明施工')],
      templateChapters: [],
      factsModel: makeFactsModel({ project: [makeFact('k1', '项目名称')] }),
      evidence: [],
    });
    const issues = knowledgeCoverageIssues(report);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('25%');
    expect(issues[0].suggestion).toContain('安全文明要求');
  });
});
