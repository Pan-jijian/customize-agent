/**
 * documentWritingTaskBrief 单测：L3 写作任务书构建——章节标题→写作目标规则匹配（13 条规则）、
 * 必覆盖/事实域/证据引用/BOQ 目标卡构建、施组全局写作焦点（写作红线约束/规模事实卡/可信事实卡）。
 */
import { describe, expect, it } from 'vitest';
import { B7_AUTHORITY_NUMERIC_RULE, B8_EFFECTIVE_CALIBER_RULE, buildWriteTimeFixedBlocks, buildWritingTaskBrief } from '@/services/document-workflow/documentWritingTaskBrief';
import type { CanonicalFact, DocumentFactsModel, DocumentTemplateChapter, ProjectGraph } from '@/services/document-workflow/types';

function makeChapter(id: string, title: string, extra: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id, title, purpose: '测试用途', queries: [], requiredFacts: [], ...extra };
}

function makeCanonicalFact(label: string, value: string): CanonicalFact {
  return { key: label, label, value, normalizedValue: value, sourceType: 'tender', sourceFile: '/proj/a.pdf', confidence: 1, priority: 1, locked: true };
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

  it('施组文档类型判定与全局写作焦点（含规模事实卡与可信基础事实）', () => {
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
    });
    expect(brief.documentType).toBe('施工组织设计');
    // 基础 7 条（含五要素链与规范术语显性落位 2 条 R12 新增）+ 写作红线 5 条（V2 批1-5 四条 + 批2-1 工期时序与分批口径，与结构/表格/口径检测口径同源）+ 招标硬性要求 + 规模事实卡 + 可信基础事实卡 = 17 条
    // 4.55.20：新增 B8 现行口径铁律（禁止旧值/禁止变更过程叙述）与 B7 蓝图权威值写作要求
    expect(brief.globalWritingFocus).toHaveLength(21);
    expect(brief.globalWritingFocus[0]).toContain('模板化空话');
    expect(brief.globalWritingFocus[2]).toContain('五要素链');
    expect(brief.globalWritingFocus[3]).toContain('规范术语显性落位');
    expect(brief.globalWritingFocus[7]).toContain('属地创优目标');
    expect(brief.globalWritingFocus[8]).toContain('表格数据一致性');
    expect(brief.globalWritingFocus[9]).toContain('结构完整性红线');
    expect(brief.globalWritingFocus[10]).toContain('表格规范红线');
    expect(brief.globalWritingFocus[11]).toContain('数据口径红线');
    expect(brief.globalWritingFocus[12]).toContain('禁止资料堆砌伪段落');
    // 4.55.22 新增两条写作前红线（原只存在于链尾字面改写表）：自伤式假设/短板、两可表述
    expect(brief.globalWritingFocus[13]).toContain('禁止自伤式假设与短板表述');
    expect(brief.globalWritingFocus[14]).toContain('禁止两可表述');
    expect(brief.globalWritingFocus[15]).toContain('工期时序与分批口径红线');
    // 尾部顺序（4.55.20）：B8 现行口径铁律 → 招标硬性要求 → 规模事实卡 → 可信基础事实 → B7 蓝图权威值
    expect(brief.globalWritingFocus[16]).toContain('B8 现行口径铁律');
    expect(brief.globalWritingFocus[17]).toContain('招标硬性要求必须逐项明确响应');
    expect(brief.globalWritingFocus[18]).toContain('项目规模事实卡');
    expect(brief.globalWritingFocus[18]).toContain('建设规模=总建筑面积 28570.36㎡');
    expect(brief.globalWritingFocus[19]).toContain('项目可信基础事实');
    expect(brief.globalWritingFocus[20]).toContain('B7 蓝图权威值');
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

  it('无任何输入增强（factsModel/projectGraph 缺省）时输出最小任务书', () => {
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '工程概况')],
      templateName: '某项目施工组织设计',
    });
    expect(brief.documentType).toBe('施工组织设计');
    expect(brief.globalWritingFocus).toHaveLength(19); // 基础 7 条 + 红线 5 条 + 招标硬性 + B8 现行口径铁律 + B7 蓝图权威值（4.55.20）
    const chapter = brief.chapters[0];
    expect(chapter.drawingTargets).toEqual([]);
    expect(chapter.gaps).toEqual([]);
    expect(chapter.boqTargets).toEqual([]);
  });
});

/**
 * 写作前定死块注入（4.55.22 断链修复的护栏用例）。
 *
 * 实测缺陷（本会话发现的最根本一条）：`buildWritingTaskBrief` 产出的 `globalWritingFocus`
 * （含 B8 现行口径铁律 / B7 权威值必须写数字 / 规模事实卡 / 可信事实卡）与
 * `session.planning.truthConstraint`（真值层现行口径硬约束）**从未进入任何写作提示词**——
 * 前者的全部消费点是「传递给 finalize」与「渲染一条给人看的进度节点」，后者全仓零读取点。
 * 后果：终稿 4 处现行「365日历天」、劳动力峰值全篇 0 个数字。
 *
 * 本组用例守住「写作前定死块必须可达且不重复」这一契约，防止断链再次发生。
 */
describe('写作前定死块（4.55.22 断链修复护栏）', () => {
  it('真值层硬约束与澄清口径必须进块（值在写作前定死的唯一载体）', () => {
    const blocks = buildWriteTimeFixedBlocks({
      truthConstraint: '【现行口径（真值层裁决，硬约束）】计划工期：现行为「330日历天」；被取代（不得作为现行口径）：365日历天',
      clarificationConstraint: '【答疑澄清生效口径】最高投标限价 157166591.34元',
    });
    expect(blocks.join('\n')).toContain('330日历天');
    expect(blocks.join('\n')).toContain('157166591.34元');
  });

  it('B7/B8 铁律与规模事实卡随块注入（从任务书单源引用）', () => {
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '第一章 工程概况')],
      templateName: '施工组织设计',
    });
    const blocks = buildWriteTimeFixedBlocks({ globalWritingFocus: brief.globalWritingFocus });
    const text = blocks.join('\n');
    expect(text).toContain('B8 现行口径铁律');
    expect(text).toContain('B7 蓝图权威值必须写具体数字');
    expect(text).toContain('禁止出现被取代的旧值');
  });

  it('B8 铁律不得写死具体数值（曾内嵌被取代的旧值 172460314.52元）', () => {
    expect(B8_EFFECTIVE_CALIBER_RULE).not.toMatch(/\d{6,}/u);
    expect(B8_EFFECTIVE_CALIBER_RULE).toContain('禁止出现被取代的旧值');
    expect(B7_AUTHORITY_NUMERIC_RULE).toContain('劳动力峰值');
  });

  it('不注入整份 globalWritingFocus（WRITING_INTEGRITY_CONSTRAINTS 已在 roleContext 单独注入，避免重复）', () => {
    const brief = buildWritingTaskBrief({
      chapters: [makeChapter('c1', '第一章 工程概况')],
      templateName: '施工组织设计',
    });
    const blocks = buildWriteTimeFixedBlocks({ globalWritingFocus: brief.globalWritingFocus });
    expect(blocks.join('\n')).not.toContain('【结构完整性红线】');
  });

  it('危大判定块随块注入', () => {
    const blocks = buildWriteTimeFixedBlocks({ hazardBindingBlock: '【危大判定（写作前已按清单实测参数定死，硬约束）】- 脚手架工程：结论：**不属危大**' });
    expect(blocks.join('\n')).toContain('不属危大');
  });

  it('空输入返回空数组（不产出空块）', () => {
    expect(buildWriteTimeFixedBlocks({})).toEqual([]);
    expect(buildWriteTimeFixedBlocks({ truthConstraint: '   ' })).toEqual([]);
  });
});

/**
 * 盲区回归（4.55.22）：`too_short` 缺口原先**生产者有、三个消费点全都不收**
 *（缺节/空节两处过滤 + 导出服务只取 empty），即「标题下只有一两句」的小节
 * 在整个流程里不可见、不可修。它正是补写轮该处理的形态。
 */
describe('小节内容缺口：too_short 必须可达（不再是无消费方的死值）', () => {
  const chapters = [{
    title: '第一章 主要施工方法',
    content: [
      '## 第一章 主要施工方法',
      '',
      '### 1.1 资源配置计划',
      '钢筋工十五人、木工二十人，分阶段进退场。',
    ].join('\n'),
    sections: ['资源配置计划'],
  }];

  it('正文过短（<180 字）→ sectionContentIntegrityIssues 报出（进问题流）', async () => {
    const { sectionContentIntegrityIssues } = await import('@/services/document-workflow/qualityValidation');
    const issues = sectionContentIntegrityIssues('', chapters as never);
    expect(issues.some(issue => issue.message.includes('正文过短'))).toBe(true);
  });

  it('正文充分（≥180 字）→ 不报（不是无差别告警）', async () => {
    const { sectionContentIntegrityIssues } = await import('@/services/document-workflow/qualityValidation');
    const long = {
      title: '第一章 主要施工方法',
      content: `## 第一章 主要施工方法\n\n### 1.1 资源配置计划\n${'按施工进度分阶段配置劳动力，各工种进退场由施工员按周计划核定，进场前完成三级安全教育与技能核验。'.repeat(4)}`,
      sections: ['资源配置计划'],
    };
    expect(sectionContentIntegrityIssues('', [long] as never)).toEqual([]);
  });
});
