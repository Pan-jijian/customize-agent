/**
 * constructionOrgConsistency 单测：施组数据一致性 8 规则（工程名称/建设地点/总工期/建设规模/
 * 机械型号/劳动力/危大清单/环保指标）的冲突检出、通用术语与否定语境豁免，
 * 以及章节项目事实支撑检测。
 */
import { describe, expect, it } from 'vitest';
import { constructionOrgChapterDataCoverageIssues, constructionOrgConsistencyIssues } from '@/services/document-workflow/constructionOrgConsistency';
import type { DocumentDraftChapter, DocumentFactsModel } from '@/services/document-workflow/types';

function makeFact(key: string, value: string, group: 'project' | 'schedule' | 'quality' | 'safety' | 'resources' | 'preciseFacts' = 'project'): DocumentFactsModel[typeof group][number] {
  return { key, value, sourceFile: '/proj/facts.json', roleId: 'role-fact', confidence: 1 } as never;
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

/** 工程名称/建设地点/总工期/建设规模全部与图谱一致的基准正文 */
const CONSISTENT_MARKDOWN = [
  '# 某某安置小区项目施工组织设计',
  '工程名称：某某安置小区项目',
  '建设地点：合肥市高新区',
  '总工期：600 日历天',
  '建设规模：建筑面积 28570.36 平方米',
].join('\n');

const FULL_FACTS = makeFactsModel({
  project: [makeFact('name', '某某安置小区项目', 'project'), makeFact('loc', '合肥市高新区', 'project'), makeFact('scale', '28570.36 平方米', 'project')],
  schedule: [makeFact('dur', '600 日历天', 'schedule')],
});

describe('constructionOrgConsistencyIssues', () => {
  it('数据全部与图谱一致时不产生问题', () => {
    expect(constructionOrgConsistencyIssues(CONSISTENT_MARKDOWN, FULL_FACTS)).toEqual([]);
  });

  it('工程名称不一致产生 warning', () => {
    const issues = constructionOrgConsistencyIssues(CONSISTENT_MARKDOWN.replaceAll('某某安置小区项目', '幸福家园项目'), FULL_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('工程名称');
    expect(issues[0].message).toContain('幸福家园项目');
  });

  it('总工期不一致产生 warning', () => {
    const issues = constructionOrgConsistencyIssues(CONSISTENT_MARKDOWN.replace('600 日历天', '400 日历天'), FULL_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('总工期');
    expect(issues[0].message).toContain('400日历天');
  });

  it('建设规模口径不一致产生 warning', () => {
    const issues = constructionOrgConsistencyIssues(CONSISTENT_MARKDOWN.replace('28570.36 平方米', '10970 平方米'), FULL_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('建设规模');
  });

  it('机械型号：非通用术语且与资源事实不一致时检出', () => {
    const facts = makeFactsModel({ resources: [makeFact('machine', '塔式起重机 2 台', 'resources')] });
    const issues = constructionOrgConsistencyIssues(`${CONSISTENT_MARKDOWN}\n现场配置挖掘机 3 台。`, facts);
    expect(issues.some(item => item.message.includes('机械数量型号') && item.message.includes('挖掘机'))).toBe(true);
  });

  it('通用术语（塔式起重机/脚手架/PM2.5 等）不要求事实逐字支持', () => {
    const markdown = `${CONSISTENT_MARKDOWN}\n现场配置塔式起重机 2 台、脚手架 500 吨，PM2.5 与噪声在线监测。`;
    expect(constructionOrgConsistencyIssues(markdown, FULL_FACTS)).toEqual([]);
  });

  it('否定语境（不使用/不配置）不参与一致性核对', () => {
    const markdown = `${CONSISTENT_MARKDOWN}\n危大工程：不使用深基坑支护工艺。`;
    expect(constructionOrgConsistencyIssues(markdown, FULL_FACTS)).toEqual([]);
  });

  it('劳动力人数：常规数字被贪婪量词吞至末位（1 字）被长度过滤，超长数字才触发冲突', () => {
    const facts = makeFactsModel({ resources: [makeFact('labor', '劳动力 200 人', 'resources')] });
    // 实现事实：pattern 的 [^\n|]{0,12} 贪婪吃数字，'劳动力 350 人' 捕获组 (\d+) 只剩 '0'（1 字被 2-80 长度过滤）→ 不冲突
    expect(constructionOrgConsistencyIssues(`${CONSISTENT_MARKDOWN}\n劳动力 350 人。`, facts)).toEqual([]);
    // 数字超过 13 位：贪婪量词耗尽 12 字符后 (\d+) 捕获剩余多位 → 触发冲突
    const issues = constructionOrgConsistencyIssues(`${CONSISTENT_MARKDOWN}\n劳动力 12345678901234567890123456 人。`, facts);
    expect(issues.some(item => item.message.includes('劳动力人数') && item.message.includes('34567890123456'))).toBe(true);
    // 资源事实为空时 hasCompatibleFact 直接放行
    expect(constructionOrgConsistencyIssues(`${CONSISTENT_MARKDOWN}\n劳动力 12345678901234567890123456 人。`, FULL_FACTS)).toEqual([]);
  });

  it('危大工程清单与安全事实不一致检出', () => {
    const facts = makeFactsModel({ safety: [makeFact('risk', '深基坑工程专项方案', 'safety')] });
    const issues = constructionOrgConsistencyIssues(`${CONSISTENT_MARKDOWN}\n危大工程：高支模工程。`, facts);
    expect(issues.some(item => item.message.includes('危大工程清单') && item.message.includes('高支模工程'))).toBe(true);
  });

  it('非施组文档（无质量/安全/施组关键词）直接返回空', () => {
    expect(constructionOrgConsistencyIssues('纯技术文档，无施组语境。工程名称：某某安置小区项目', FULL_FACTS)).toEqual([]);
  });

  it('冲突最多截取 5 条且带核对位置建议', () => {
    const markdown = `${CONSISTENT_MARKDOWN}\n工程名称：甲项目\n工程名称：乙项目\n工程名称：丙项目\n工程名称：丁项目\n工程名称：戊项目\n工程名称：己项目`;
    const issues = constructionOrgConsistencyIssues(markdown, FULL_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestion).toContain('封面、工程概况');
  });
});

describe('constructionOrgChapterDataCoverageIssues', () => {
  it('项目事实为空时不检查', () => {
    const chapters: DocumentDraftChapter[] = [{ id: 'c1', title: '工程概况', content: '模板化内容。', evidence: [], missingFacts: [] }];
    expect(constructionOrgChapterDataCoverageIssues(chapters, makeFactsModel())).toEqual([]);
  });

  it('关键章节缺少项目图谱事实支撑时警告', () => {
    const chapters: DocumentDraftChapter[] = [
      { id: 'c1', title: '工程概况', content: '本工程位于现场，施工内容为通用表述，无任何项目专属数据。', evidence: [], missingFacts: [] },
    ];
    const issues = constructionOrgChapterDataCoverageIssues(chapters, FULL_FACTS);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('工程概况');
  });

  it('章节正文引用项目事实前 10 字即视为有支撑', () => {
    const chapters: DocumentDraftChapter[] = [
      { id: 'c1', title: '工程概况', content: '本工程为某某安置小区项目，位于合肥市高新区。', evidence: [], missingFacts: [] },
    ];
    expect(constructionOrgChapterDataCoverageIssues(chapters, FULL_FACTS)).toEqual([]);
  });

  it('非关键章节（如附录/编制说明以外）跳过检查', () => {
    const chapters: DocumentDraftChapter[] = [
      { id: 'c1', title: '附录 A 参考资料', content: '纯参考资料目录。', evidence: [], missingFacts: [] },
    ];
    expect(constructionOrgChapterDataCoverageIssues(chapters, FULL_FACTS)).toEqual([]);
  });
});
