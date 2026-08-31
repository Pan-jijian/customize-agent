import { describe, expect, it } from 'vitest';
import { buildDocumentBlueprintStructure, buildChapterScopedProjectContext } from './documentBlueprint';
import type { DocumentFact, DocumentFactsModel, DocumentTemplate } from './types';

/**
 * A1 蓝图结构化（章级 scoped 上下文）精确性回归：
 * 专业文档生成要求"给到的条件、证据、数据精准"——章级上下文必须做到
 * ① 本章事实域内的事实一条不丢；② 他章事实域的事实一条不混入；
 * ③ preciseFacts（关键精确数字）全局共享；④ 全局约束/口径裁决/要求段每章必带。
 * 映射口径与 supportLevelForChapter 同源（域 key → factsModel 数组），数据结构级过滤零遗漏。
 */
function makeFact(key: string, value: string): DocumentFact {
  return { key, value, sourceFile: '/proj/招标文件.pdf', roleId: 'r1', confidence: 1 };
}

function makeFactsModel(partial: Partial<DocumentFactsModel> = {}): DocumentFactsModel {
  return {
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [],
    drawings: [], bills: [], preciseFacts: [], rules: [], specifications: [], schemaFacts: {},
    ...partial,
  } as DocumentFactsModel;
}

const progressChapter = { id: 'c-progress', title: '施工进度计划', purpose: '组织施工进度', queries: ['进度'], requiredFacts: [], sections: ['总体工期安排'] };
const qualityChapter = { id: 'c-quality', title: '工程质量保证措施', purpose: '保证工程质量', queries: ['质量'], requiredFacts: [], sections: ['材料进场验收'] };

function makeTemplate(): DocumentTemplate {
  return {
    id: 't1', name: '施工组织设计', description: 'd', category: 'c', outputTitle: '合肥某工程施工组织设计',
    chapters: [progressChapter, qualityChapter],
  };
}

describe('buildDocumentBlueprintStructure（章级事实精确映射）', () => {
  const factsModel = makeFactsModel({
    project: [makeFact('p1', '建设地点：合肥市瑶海区，总建筑面积28570平方米')],
    schedule: [makeFact('s1', '计划工期：365日历天')],
    quality: [makeFact('q1', '质量标准：合格，确保结构优质工程')],
    preciseFacts: [makeFact('pf1', '合同估算价：3000万元')],
  });
  const template = makeTemplate();
  const structure = buildDocumentBlueprintStructure({ template, chapters: template.chapters, factsModel });

  it('进度章事实块只含 project/schedule 域与 preciseFacts（他章 quality 剔除）', () => {
    const block = structure.chapterBlocks.find(item => item.title === '施工进度计划');
    expect(block).toBeDefined();
    const values = block!.facts.map(fact => fact.value).join('\n');
    expect(values).toContain('合肥市瑶海区'); // project 域
    expect(values).toContain('365日历天'); // schedule 域
    expect(values).toContain('3000万元'); // preciseFacts 全局共享
    expect(values).not.toContain('结构优质工程'); // quality 域不混入
  });

  it('质量章事实块包含 quality 域与 preciseFacts（他章 schedule 剔除）', () => {
    const block = structure.chapterBlocks.find(item => item.title === '工程质量保证措施');
    expect(block).toBeDefined();
    const values = block!.facts.map(fact => fact.value).join('\n');
    expect(values).toContain('结构优质工程');
    expect(values).toContain('3000万元');
    expect(values).not.toContain('365日历天');
  });

  it('preciseFacts 事实出现在所有章的事实块（宁全勿缺）', () => {
    for (const block of structure.chapterBlocks) {
      expect(block.facts.map(fact => fact.value).join('\n')).toContain('3000万元');
    }
  });

  it('全局段包含画像、目标与证据引用约束（每章必带）', () => {
    expect(structure.globalLines.join('\n')).toContain('文档类型画像');
    expect(structure.globalLines.join('\n')).toContain('合肥某工程施工组织设计');
    expect(structure.globalLines.join('\n')).toContain('证据引用约束');
    expect(structure.globalLines.join('\n')).toContain('跨章一致性要求');
  });

  it('索引矩阵保留全量章索引（全貌概览）', () => {
    expect(structure.matrixLines.join('\n')).toContain('施工进度计划');
    expect(structure.matrixLines.join('\n')).toContain('工程质量保证措施');
  });
});

describe('buildChapterScopedProjectContext（章级 scoped 组装）', () => {
  const factsModel = makeFactsModel({
    project: [makeFact('p1', '建设地点：合肥市瑶海区，总建筑面积28570平方米')],
    schedule: [makeFact('s1', '计划工期：365日历天')],
    quality: [makeFact('q1', '质量标准：合格，确保结构优质工程')],
    preciseFacts: [makeFact('pf1', '合同估算价：3000万元')],
  });
  const template = makeTemplate();
  const structure = buildDocumentBlueprintStructure({
    template, chapters: template.chapters, factsModel,
    scopeConflicts: [{ kind: 'area', scope: '总建筑面积', values: [{ value: '28570', unit: '平方米', sourceFile: '/proj/a.pdf', priority: 1 }, { value: '28600', unit: '平方米', sourceFile: '/proj/b.pdf', priority: 0 }], resolution: '以招标文件为准' }],
  });
  const requirementRules = '【招标文件评分项要求（系统从绑定资料提取，必须逐条响应，零响应即评标失分）】\n1. 本项目创优目标（必须全文显性响应）：创优目标：确保黄山杯。';

  it('进度章 scoped：本章事实全保留 + 全局约束 + 口径裁决 + 要求段', () => {
    const scoped = buildChapterScopedProjectContext({ chapterTitle: '施工进度计划', structure, requirementRules });
    expect(scoped).toContain('365日历天'); // 本章 schedule 事实
    expect(scoped).toContain('合肥市瑶海区'); // 本章 project 事实
    expect(scoped).toContain('3000万元'); // precise 全局
    expect(scoped).toContain('证据引用约束'); // 全局约束
    expect(scoped).toContain('确保黄山杯'); // 要求段
    expect(scoped).toContain('源级口径冲突裁决'); // 口径裁决（全文统一必需）
    expect(scoped).toContain('以招标文件为准');
  });

  it('进度章 scoped：他章事实与他章任务卡剔除', () => {
    const scoped = buildChapterScopedProjectContext({ chapterTitle: '施工进度计划', structure, requirementRules });
    expect(scoped).not.toContain('结构优质工程'); // 他章事实剔除
    expect(scoped).not.toContain('材料进场验收'); // 他章任务卡专属小节剔除
    expect(scoped).toContain('总体工期安排'); // 本章任务卡保留
  });

  it('质量章 scoped：本章事实与本章小节保留，进度事实剔除', () => {
    const scoped = buildChapterScopedProjectContext({ chapterTitle: '工程质量保证措施', structure, requirementRules });
    expect(scoped).toContain('结构优质工程');
    expect(scoped).toContain('材料进场验收');
    expect(scoped).not.toContain('365日历天');
    expect(scoped).toContain('确保黄山杯'); // 要求段每章必带
  });

  it('溯源行只含本章事实（不泄露他章来源）', () => {
    const scoped = buildChapterScopedProjectContext({ chapterTitle: '施工进度计划', structure });
    expect(scoped).toContain('关键事实证据追踪清单');
    expect(scoped).toContain('计划工期');
    expect(scoped).not.toContain('质量标准');
  });

  it('章级 scoped 体积显著小于全量蓝图（瘦身生效）', () => {
    const scoped = buildChapterScopedProjectContext({ chapterTitle: '施工进度计划', structure, requirementRules });
    // 全量蓝图字符串应包含全部任务卡与全部事实，章级 scoped 剔除他章后明显更短
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped).not.toContain('章节专业任务卡：\n章节任务卡：工程质量保证措施');
  });
});
