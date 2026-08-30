/**
 * documentWritingTaskBrief 单测：L3 写作任务书构建——章节标题→写作目标规则匹配（13 条规则）、
 * 必覆盖/事实域/证据引用/BOQ 目标卡构建、施组全局写作焦点（规模事实卡/前附表响应/可信事实卡）。
 */
import { describe, expect, it } from 'vitest';
import { buildWritingTaskBrief } from './documentWritingTaskBrief';
import type { CanonicalFact, DocumentFactsModel, DocumentTemplateChapter, ProjectGraph, TenderRequirementModel } from './types';

function makeChapter(id: string, title: string, extra: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id, title, purpose: '测试用途', queries: [], requiredFacts: [], ...extra };
}

function makeCanonicalFact(label: string, value: string): CanonicalFact {
  return { key: label, label, value, normalizedValue: value, sourceType: 'tender', sourceFile: '/proj/a.pdf', confidence: 1, priority: 1, locked: true };
}

function makeTenderRequirements(frontScheduleClauses: Array<{ text: string }>): TenderRequirementModel {
  return {
    frontScheduleClauses: frontScheduleClauses.map(item => ({ text: item.text, coreTerms: [] })),
    awardObjectives: [], specialQualityStandards: [], awardClauses: [], systematicBenchmarks: [],
    dateFabricationProhibited: false, prohibitionNotes: [], extracted: true,
  };
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

describe('buildWritingTaskBrief', () => {
  it('章节标题规则匹配：概况/施工内容/分部分项方案/重点难点/部署', () => {
    const brief = buildWritingTaskBrief({
      chapters: [
        makeChapter('c1', '工程概况'),
        makeChapter('c2', '主要施工内容'),
        makeChapter('c3', '主要分部分项工程施工方案'),
        makeChapter('c4', '重点难点分析'),
        makeChapter('c5', '施工部署'),
        makeChapter('c6', '无规则章节'),
      ],
      templateName: '某项目施工组织设计',
    });
    const goals = new Map(brief.chapters.map(item => [item.chapterId, item.writingGoal]));
    expect(goals.get('c1')).toContain('工程概况与总体理解');
    expect(goals.get('c2')).toContain('专业工程展开');
    expect(goals.get('c3')).toContain('分项工程方案展开');
    expect(goals.get('c4')).toContain('重点难点并给出针对性对策');
    expect(goals.get('c5')).toContain('施工部署逻辑');
    expect(goals.get('c6')).toContain('避免泛化叙述');
  });

  it('进度/质量/安全/资源/文明/应急/竣工/劳务规则各自命中', () => {
    const brief = buildWritingTaskBrief({
      chapters: [
        makeChapter('c1', '施工进度计划'),
        makeChapter('c2', '质量保证措施'),
        makeChapter('c3', '安全文明施工'),
        makeChapter('c4', '资源配置计划'),
        makeChapter('c5', '绿色施工与环保'),
        makeChapter('c6', '应急预案'),
        makeChapter('c7', '竣工验收移交'),
        makeChapter('c8', '劳务工资保障'),
      ],
      templateName: '某项目施工组织设计',
    });
    const goals = new Map(brief.chapters.map(item => [item.chapterId, item.writingGoal]));
    expect(goals.get('c1')).toContain('总工期与关键节点');
    expect(goals.get('c2')).toContain('质量闭环');
    expect(goals.get('c3')).toContain('危大工程专项方案');
    expect(goals.get('c4')).toContain('资源配置依据');
    expect(goals.get('c5')).toContain('扬尘噪声管控');
    expect(goals.get('c6')).toContain('应急组织');
    expect(goals.get('c7')).toContain('竣工清理');
    expect(goals.get('c8')).toContain('劳务实名制');
  });

  it('mustCover 合并规则清单与章节 requiredFacts（前 6 条）', () => {
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '施工进度计划', { requiredFacts: ['总工期', '关键节点', '纠偏措施'] })],
      templateName: '某项目施工组织设计',
    });
    const chapter = brief.chapters[0];
    expect(chapter.mustCover).toEqual(['总进度计划与关键节点', '周/日计划分解', '进度偏差识别与纠偏措施', '总工期', '关键节点', '纠偏措施']);
  });

  it('evidenceRefs 取章节 queries 前 6 条', () => {
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '工程概况', { queries: ['项目概况', '建设规模', '现场条件', '招标范围', '编制依据', '适用范围', '多余查询'] })],
      templateName: '某项目施工组织设计',
    });
    expect(brief.chapters[0].evidenceRefs).toEqual([
      { filePath: '项目概况', kind: 'query', priority: 'should' },
      { filePath: '建设规模', kind: 'query', priority: 'should' },
      { filePath: '现场条件', kind: 'query', priority: 'should' },
      { filePath: '招标范围', kind: 'query', priority: 'should' },
      { filePath: '编制依据', kind: 'query', priority: 'should' },
      { filePath: '适用范围', kind: 'query', priority: 'should' },
    ]);
  });

  it('BOQ 目标卡：标题匹配概况/资源类章节时取资源清单前 12 条', () => {
    const projectGraph: ProjectGraph = {
      works: [], methods: [],
      resources: [
        { name: '商品混凝土 C30', type: 'material', spec: 'C30', quantity: '1000', unit: 'm3', sourceFiles: [] },
        { name: '钢筋 HRB400', type: 'material', spec: 'HRB400', quantity: '500', unit: 't', sourceFiles: [] },
      ],
      schedule: [], standards: [], risks: [], requirements: [], siteConditions: [], addendumChanges: [], gaps: [], generatedAt: 0,
    };
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '工程概况'), makeChapter('c2', '施工部署')],
      projectGraph,
      templateName: '某项目施工组织设计',
    });
    const overview = brief.chapters[0];
    expect(overview.boqTargets).toEqual([
      { itemCode: '', itemName: '商品混凝土 C30', quantity: '1000', unit: 'm3' },
      { itemCode: '', itemName: '钢筋 HRB400', quantity: '500', unit: 't' },
    ]);
    // 施工部署 标题不匹配 /概况|资源|总体|施工内容|方案/ → 无 BOQ 目标
    expect(brief.chapters[1].boqTargets).toEqual([]);
  });

  it('factDomains 合并 requiredFacts 与图谱工作包名（前 10 条）', () => {
    const projectGraph: ProjectGraph = {
      works: [{ name: '土方开挖', scope: '基坑', sourceFiles: [], relatedItems: [] }],
      methods: [], resources: [], schedule: [], standards: [], risks: [], requirements: [], siteConditions: [], addendumChanges: [], gaps: [], generatedAt: 0,
    };
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '工程概况', { requiredFacts: ['建设规模'] })],
      projectGraph,
      templateName: '某项目施工组织设计',
    });
    expect(brief.chapters[0].factDomains).toEqual(['建设规模', '土方开挖']);
  });

  it('施组文档类型判定与全局写作焦点（含前附表响应与规模事实卡）', () => {
    const factsModel = makeFactsModel({
      project: [],
    });
    factsModel.canonical = {
      byKey: {
        'scale': makeCanonicalFact('建设规模', '总建筑面积 28570.36㎡'),
        'other': makeCanonicalFact('其他事实', '普通内容'),
      },
      projectIdentity: {}, projectScope: {}, schedule: {}, quality: {}, safety: {}, resources: {}, environment: {}, constraints: {}, conflicts: [], gaps: [], scopeConflicts: [],
    };
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '工程概况')],
      factsModel,
      templateName: '某项目施工组织设计',
      tenderRequirements: makeTenderRequirements([{ text: '质量标准：确保黄山杯' }]),
    });
    expect(brief.documentType).toBe('施工组织设计');
    // 固定 5 条 + 前附表响应 + 招标硬性要求 + 规模事实卡 + 可信基础事实卡 = 9 条
    expect(brief.globalWritingFocus).toHaveLength(9);
    expect(brief.globalWritingFocus[0]).toContain('模板化空话');
    expect(brief.globalWritingFocus[5]).toContain('投标人须知前附表响应条款');
    expect(brief.globalWritingFocus[5]).toContain('确保黄山杯');
    expect(brief.globalWritingFocus[7]).toContain('项目规模事实卡');
    expect(brief.globalWritingFocus[7]).toContain('建设规模=总建筑面积 28570.36㎡');
    expect(brief.globalWritingFocus[8]).toContain('项目可信基础事实');
  });

  it('规模事实卡只收录规模口径事实（前 8 条），非规模事实不进卡', () => {
    const factsModel = makeFactsModel();
    factsModel.canonical = {
      byKey: {
        'a': makeCanonicalFact('计划工期', '600天'),
        'b': makeCanonicalFact('建筑高度', '99米'),
      },
      projectIdentity: {}, projectScope: {}, schedule: {}, quality: {}, safety: {}, resources: {}, environment: {}, constraints: {}, conflicts: [], gaps: [], scopeConflicts: [],
    };
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '工程概况')],
      factsModel,
      templateName: '某项目施工组织设计',
    });
    const scaleLine = brief.globalWritingFocus.find(line => line.includes('项目规模事实卡'));
    expect(scaleLine).toContain('建筑高度=99米');
    expect(scaleLine).not.toContain('计划工期');
  });

  it('无任何输入增强（factsModel/projectGraph/tenderRequirements 缺省）时输出最小任务书', () => {
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '工程概况')],
      templateName: '某项目施工组织设计',
    });
    expect(brief.documentType).toBe('施工组织设计');
    expect(brief.globalWritingFocus).toHaveLength(6); // 固定 5 条 + 招标硬性要求
    const chapter = brief.chapters[0];
    expect(chapter.drawingTargets).toEqual([]);
    expect(chapter.gaps).toEqual([]);
    expect(chapter.boqTargets).toEqual([]);
  });
});
