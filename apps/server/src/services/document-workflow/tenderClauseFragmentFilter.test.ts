/**
 * round-25 条款碎片标题过滤回归测试：
 * 1. isTenderClauseFragmentTitle 对评标办法条款碎片/编号残留标题全部拦截；
 * 2. 正常施工组织小节标题零误伤；
 * 3. extractGeneratedSections（写手正文 H3 提取）不再把条款碎片收进 sections；
 * 4. stripTenderClauseFragmentHeadings 剥离正文脏 H3 行、保留行下正文；
 * 5. stripDataConsistencyLeakSentences 剥离「上表…一致/修正为」表格口径自查泄漏段。
 * 历史缺陷：fix4 只在显式 OUTLINE 提取环节加条款句过滤，写手正文 H3 提取环节漏接，
 * 导致「3项规定」「56m15：…」等碎片进入小节目录（评分报告（19）问题 2）。
 */
import { describe, expect, it } from 'vitest';
import { isTenderClauseFragmentTitle } from './outline';
import { extractGeneratedSections } from './markdownComposer';
import { stripDataConsistencyLeakSentences, stripTenderClauseFragmentHeadings } from './documentGeneratorHelpers';

describe('isTenderClauseFragmentTitle 条款碎片拦截', () => {
  it('评标办法条款碎片标题全部拦截', () => {
    const dirty = [
      '3项规定',
      '如我方中标，我方承诺',
      '1委员会确定中',
      '56m15：我单位复核工程量与清单工程量相比误差',
      '4对与评标活动有关的工作人员的纪律要求',
      '2（3）目，报价在最高限价90%-100%之',
      '其他要求',
      '需要补充的其他内容',
      '相当于或不低于以下品牌',
    ];
    for (const title of dirty) expect(isTenderClauseFragmentTitle(title), title).toBe(true);
  });

  it('正常施工组织小节标题零误伤', () => {
    const clean = [
      '项目管理组织机构与职责',
      '进度计划与工期保障',
      '质量管理体系与质量保证措施',
      '季节性施工保障',
      '应急管理体系',
      '文明施工、扬尘、噪声与绿色施工',
      '工期、质量与招标范围实质性响应规定',
      '主要分部分项工程施工方案',
      '材料设备品牌响应原则',
    ];
    for (const title of clean) expect(isTenderClauseFragmentTitle(title), title).toBe(false);
  });
});

describe('extractGeneratedSections 不再收编条款碎片', () => {
  it('正文 H3 中的条款碎片被过滤，正常小节保留', () => {
    const markdown = [
      '### 项目管理组织机构与职责',
      '正文内容',
      '### 3项规定',
      '### 工期、质量与招标范围实质性响应规定',
      '### 56m15：我单位复核工程量与清单工程量相比误差',
      '### 应急管理体系',
    ].join('\n');
    const sections = extractGeneratedSections(markdown);
    expect(sections).toEqual(['项目管理组织机构与职责', '工期、质量与招标范围实质性响应规定', '应急管理体系']);
  });
});

describe('stripTenderClauseFragmentHeadings 正文脏 H3 行剥离', () => {
  it('删除条款碎片标题行，行下正文保留', () => {
    const content = [
      '### 质量管理体系与质量保证措施',
      '质量措施正文。',
      '### 如我方中标，我方承诺',
      '### # 工期履约承诺与关键线路控制',
      '承诺正文内容保留。',
      '### 应急管理体系',
      '应急正文。',
    ].join('\n');
    const cleaned = stripTenderClauseFragmentHeadings(content);
    expect(cleaned).not.toContain('### 如我方中标，我方承诺');
    expect(cleaned).toContain('### # 工期履约承诺与关键线路控制');
    expect(cleaned).toContain('承诺正文内容保留。');
    expect(cleaned).toContain('### 质量管理体系与质量保证措施');
  });

  it('无条款碎片时原样返回', () => {
    const content = '### 进度计划与工期保障\n进度正文。';
    expect(stripTenderClauseFragmentHeadings(content)).toBe(content);
  });
});

describe('stripDataConsistencyLeakSentences 表格口径自查泄漏剥离', () => {
  it('「上表…一致/修正为」自查段落整体删除，表格与后续内容保留', () => {
    const content = [
      '| 施工阶段 | 阶段高峰人数 |',
      '| --- | --- |',
      '| 主体结构阶段 | 160 |',
      '| 合计 | 180 |',
      '',
      '上表合计行中“阶段平均人数 385 人”为四个阶段平均人数的算术平均值，与各阶段平均人数之和 385 人一致；“阶段高峰人数 130 人”为四个阶段高峰人数中的最大值，与各阶段高峰人数 120、160、180、90 人中的最大值 180 人不一致，故以分阶段投入明细表为准，将合计行阶段高峰人数修正为 130 人；“劳动力总量 58800 工日”为四个阶段劳动力总量之和。',
      '',
      '| 施工阶段 | 工种 | 人数 |',
      '| --- | --- | --- |',
      '| 地下结构阶段 | 钢筋工 | 25 |',
    ].join('\n');
    const cleaned = stripDataConsistencyLeakSentences(content);
    expect(cleaned).not.toContain('不一致');
    expect(cleaned).not.toContain('修正为');
    expect(cleaned).toContain('| 主体结构阶段 | 160 |');
    expect(cleaned).toContain('| 地下结构阶段 | 钢筋工 | 25 |');
  });

  it('无泄漏段时原样返回', () => {
    const content = '| 施工阶段 | 阶段高峰人数 |\n| --- | --- |\n| 主体结构阶段 | 160 |';
    expect(stripDataConsistencyLeakSentences(content)).toBe(content);
  });
});
