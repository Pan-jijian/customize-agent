import { describe, expect, it } from 'vitest';
import type { DocumentTemplateChapter } from './types';
import { concatenatedSectionTitleFixes, extractEvaluationCriteriaItems, prioritizeOverviewSections, representativeTitleForPattern, validateBidStructureBeforeGeneration } from './constructionBidStructure';
import { cleanSectionTitleArtifacts, normalizePlannedSections } from './promptRuleExtraction';

const chapter = (title: string, sections: string[]): DocumentTemplateChapter => ({
  id: `c-${title}`,
  title,
  purpose: '',
  requiredFacts: [],
  queries: [],
  sections,
});

describe('representativeTitleForPattern（改8：补挂标题拼接根因）', () => {
  it('候选词正则取首个候选词为代表标题', () => {
    expect(representativeTitleForPattern(/现场踏勘|施工条件|现场条件/u)).toBe('现场踏勘');
    expect(representativeTitleForPattern(/编制依据|编制说明/u)).toBe('编制依据');
    expect(representativeTitleForPattern(/工程概况|项目概况|基本概况/u)).toBe('工程概况');
  });

  it('单候选词原样返回', () => {
    expect(representativeTitleForPattern(/质量/u)).toBe('质量');
  });
});

describe('concatenatedSectionTitleFixes（粘连产物精确回退表）', () => {
  it('粘连产物逐字映射回代表词', () => {
    const fixes = concatenatedSectionTitleFixes();
    expect(fixes['现场踏勘施工条件现场条件']).toBe('现场踏勘');
    expect(fixes['编制依据编制说明']).toBe('编制依据');
  });

  it('代表词本身不在回退表内（避免二次清洗）', () => {
    const fixes = concatenatedSectionTitleFixes();
    expect(fixes['现场踏勘']).toBeUndefined();
    expect(fixes['编制依据']).toBeUndefined();
  });
});

describe('cleanSectionTitleArtifacts（清单层确定性清洗）', () => {
  it('词尾等长严格重复去重', () => {
    expect(cleanSectionTitleArtifacts('要点要点')).toBe('要点');
    expect(cleanSectionTitleArtifacts('现场条件现场条件')).toBe('现场条件');
  });

  it('补挂 bug 产生的粘连脏标题精确回退为代表词', () => {
    expect(cleanSectionTitleArtifacts('现场踏勘施工条件现场条件')).toBe('现场踏勘');
  });

  it('合法标题不受影响', () => {
    expect(cleanSectionTitleArtifacts('安全文明施工与安全管理')).toBe('安全文明施工与安全管理');
    expect(cleanSectionTitleArtifacts('编制说明与工程概况')).toBe('编制说明与工程概况');
  });
});

describe('normalizePlannedSections 清洗接入', () => {
  it('脏标题进入小节清单前被清洗', () => {
    expect(normalizePlannedSections(['项目主要施工内容', '现场踏勘施工条件现场条件', '编制说明与工程概况'], '工程重点难点及危大工程的保障体系')).toEqual(['项目主要施工内容', '现场踏勘', '编制说明与工程概况']);
  });
});

describe('prioritizeOverviewSections（概况小节置首）', () => {
  it('首章中概况小节置首且其余顺序稳定', () => {
    const result = prioritizeOverviewSections([
      chapter('工程重点难点及危大工程的保障体系', ['项目主要施工内容', '现场踏勘', '编制说明与工程概况', '资源配置计划']),
      chapter('确保工期与质量的保障体系与措施', ['a', 'b']),
    ]);
    expect(result[0].sections).toEqual(['编制说明与工程概况', '项目主要施工内容', '现场踏勘', '资源配置计划']);
    expect(result[1].sections).toEqual(['a', 'b']);
  });

  it('概况小节已在首位时不改变', () => {
    const result = prioritizeOverviewSections([chapter('工程重点难点及危大工程的保障体系', ['编制说明与工程概况', '项目主要施工内容'])]);
    expect(result[0].sections).toEqual(['编制说明与工程概况', '项目主要施工内容']);
  });

  it('无概况小节的首章与非承载章均不动', () => {
    const result = prioritizeOverviewSections([
      chapter('第一章无概况小节', ['a', 'b']),
      chapter('确保安全生产的管理体系与措施', ['x', '编制说明', 'y']),
    ]);
    expect(result[0].sections).toEqual(['a', 'b']);
    expect(result[1].sections).toEqual(['x', '编制说明', 'y']);
  });
});

describe('extractEvaluationCriteriaItems 条款碎片过滤（真实生成回归：碎片条目补挂阻断章节任务）', () => {
  it('条款碎片条目不提取为评分标准条目', () => {
    const items = extractEvaluationCriteriaItems([
      '1.委员会确定中标人后向招标人提交评标报告。',
      '2.7.3项规定不得修改。',
      '3.如我方中标，我方承诺：响应全部条款。',
      '4.相当于或不低于以下品牌的要求。',
      '5.00天，计划完成时间：540日历天。',
      '6.确保黄山杯奖项创建目标实现。',
      '7.针对工程项目整体理解的要求。',
    ]);
    expect(items.map(item => item.title)).toEqual(['黄山杯奖项创建目标实现', '工程项目整体理解的要求']);
  });

  it('合法评分条目标题不受影响', () => {
    const items = extractEvaluationCriteriaItems([
      '1.拟采用的新技术、新工艺。',
      '2.确保黄山杯。',
    ]);
    expect(items.map(item => item.title)).toEqual(['拟采用的新技术、新工艺', '黄山杯']);
  });
});

describe('validateBidStructureBeforeGeneration 碎片条目不补挂（补挂层拦截）', () => {
  it('评分条目标题为条款碎片时不补入章节 sections', () => {
    const chapters = [
      chapter('确保人、材、机的保障体系与措施', ['劳动力配置计划与高峰期人数安排']),
      chapter('确保安全文明生产的管理体系与措施', ['安全生产管理与教育培训要求']),
    ];
    const result = validateBidStructureBeforeGeneration({
      template: { id: 'tpl-x', name: '测试施组', chapters, version: 1, updatedAt: 0 } as never,
      chapters,
      evaluationItems: [
        { index: 1, text: '委员会确定中标人', title: '1委员会确定中' },
        { index: 2, text: '如我方中标，我方承诺', title: '如我方中标，我方承诺：' },
        { index: 3, text: '确保黄山杯', title: '黄山杯' },
      ],
    });
    const allSections = result.enrichedChapters.flatMap(item => item.sections || []);
    expect(allSections).not.toContain('1委员会确定中');
    expect(allSections).not.toContain('如我方中标，我方承诺：');
    expect(allSections).toContain('黄山杯');
  });
});
