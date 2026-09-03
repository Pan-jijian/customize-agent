/**
 * referenceQualityProfile 单测：工程类型自动分类（强判别词竞争制+密度兜底仲裁）、
 * 质量画像字段（参数密度/工序链/重复率/表格/标题分层/五要素块/参数词条）。
 *
 * buildReferenceQualityProfile 内部调 fiveElementBlockStats（不透传 embedDocuments），
 * 其 plan/process 两要素走语义相似度 → mock './semanticSimilarity'（前缀子串方案）：
 * 块内包含锚点原型文本即可命中；role/frequency/acceptance 走词面正则无需语义。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  buildSemanticSimilarity: async () => (left: string, right: string) => (left.includes(right.slice(0, 6)) ? 1 : 0),
}));

import {
  buildReferenceQualityProfile,
  REFERENCE_PROJECT_TYPES,
  suggestProjectType,
} from '@/services/document-workflow/referenceQualityProfile';

describe('REFERENCE_PROJECT_TYPES', () => {
  it('覆盖建筑行业 13 种主要招标类型', () => {
    expect(REFERENCE_PROJECT_TYPES).toHaveLength(13);
    expect(REFERENCE_PROJECT_TYPES).toContain('房建');
    expect(REFERENCE_PROJECT_TYPES).toContain('市政');
    expect(REFERENCE_PROJECT_TYPES).toContain('桥梁与隧道');
    expect(REFERENCE_PROJECT_TYPES).toContain('水利水电');
    expect(REFERENCE_PROJECT_TYPES).toContain('电力');
    expect(REFERENCE_PROJECT_TYPES).toContain('机电安装');
    expect(REFERENCE_PROJECT_TYPES).toContain('装饰装修');
    expect(REFERENCE_PROJECT_TYPES).toContain('园林绿化');
    expect(REFERENCE_PROJECT_TYPES).toContain('铁路');
    expect(REFERENCE_PROJECT_TYPES).toContain('港口与航道');
    expect(REFERENCE_PROJECT_TYPES).toContain('矿山冶金');
    expect(REFERENCE_PROJECT_TYPES).toContain('其他');
  });
});

describe('suggestProjectType', () => {
  it('强判别词 ≥3 次且频次最高 → 市政', () => {
    expect(suggestProjectType('本工程实施老旧小区改造、雨污分流与管网改造三项内容。')).toBe('市政');
  });

  it('桥梁/隧道/盾构强判别 → 桥梁与隧道', () => {
    expect(suggestProjectType('本工程包含桥梁、隧道、盾构区间三项施工内容。')).toBe('桥梁与隧道');
  });

  it('强判别词均不足 3 次 → 密度兜底房建', () => {
    expect(suggestProjectType('本工程为高层住宅建筑，主体结构采用框架结构，地下室一层。')).toBe('房建');
  });

  it('无任何类型信号 → 其他', () => {
    expect(suggestProjectType('本文件为通用技术说明，适用于各类工程。')).toBe('其他');
  });

  it('强判别冠军稳定（市政 5 次、密度兜底同类型）不触发仲裁', () => {
    expect(suggestProjectType('市政管网改造工程，实施雨污分流、老旧小区改造、管廊建设、海绵城市建设。')).toBe('市政');
  });

  it('竞争接近仲裁：冠军不足亚军 2 倍且密度兜底更强 → 改判密度最佳类型', () => {
    // 市政强判别 3 次（冠军）、公路强判别 3 次（亚军，secondCount=3）、房建密度 4 次最高
    const text = '本工程实施老旧小区改造、雨污分流与管网改造，主要建筑为高层住宅，楼栋采用结构施工，同步实施市政公路与公路路基配套工程。';
    expect(suggestProjectType(text)).toBe('房建');
  });

  it('密度兜底显著强于冠军密度与判别频次 → 改判密度最佳类型', () => {
    // 市政强判别 3 次（冠军），但房建密度 7 次 > 市政密度 2 次×2 且 ≥ 3×2
    const text = '本工程实施老旧小区、雨污分流、管网改造三项内容，主要建筑为高层住宅，楼栋结构采用主体结构现浇，基坑支护按设计实施。';
    expect(suggestProjectType(text)).toBe('房建');
  });
});

describe('buildReferenceQualityProfile', () => {
  it('基本画像：字数口径/正文段落/章节标题/每章均字数', async () => {
    const text = '第一章 工程概况\n本项目总建筑面积12345㎡，计划工期420日历天，质量目标为一次性验收合格。\n第二章 施工部署与总体安排\n本工程施工部署按流水顺序组织施工，模板制作→钢筋绑扎→混凝土浇筑各工序依次推进。';
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.wordCount).toBe(text.replace(/\s/gu, '').length);
    expect(profile.segmentCount).toBe(2);
    expect(profile.effectiveWordCount).toBe(79);
    expect(profile.headingStructure).toEqual(['工程概况', '施工部署与总体安排']);
    expect(profile.sectionCount).toBe(2);
    expect(profile.avgSectionWords).toBe(40);
    expect(profile.subsectionCount).toBe(0);
    expect(profile.subitemCount).toBe(0);
  });

  it('工艺参数密度：中文参数词+数值单位千字口径', async () => {
    const text = '混凝土强度等级C30，钢筋搭接长度按规范确定，浇筑完成后养护7天。';
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.paramCount).toBe(4); // 强度等级/搭接长度/养护/7天
    expect(profile.paramDensity).toBe((4 * 1000) / profile.effectiveWordCount);
  });

  it('工序链覆盖：含→段落计数与覆盖率', async () => {
    const text = '模板制作→钢筋绑扎→混凝土浇筑，各工序按顺序流水施工。\n本段描述现场临时用电三级配电布置要求。';
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.segmentCount).toBe(2);
    expect(profile.arrowChainSegmentCount).toBe(1);
    expect(profile.arrowChainCoverage).toBe(0.5);
  });

  it('段落重复率：语义骨架一致的段落计为重复', async () => {
    const dup = '本工程工期紧张任务繁重需要科学组织施工确保按期完成。';
    const text = `${dup}\n${dup}\n另一段落描述现场平面布置与临时设施设置要求。`;
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.segmentCount).toBe(3);
    expect(profile.duplicatedSegmentCount).toBe(2);
    expect(profile.duplicationRate).toBeCloseTo(2 / 3);
  });

  it('表格计数：标题行/框线表各 1 张，管道表格连续块 1 张', async () => {
    const text = [
      '主要工程量清单',
      '┌─────────────┐',
      '│  表格内容   │',
      '└─────────────┘',
      '| 序号 | 名称 | 数量 |',
      '|---|---|---|',
      '| 1 | 水泥 | 10 |',
      '| 2 | 钢材 | 20 |',
      '施工机械设备配置表',
    ].join('\n');
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.tableCount).toBe(4);
    expect(profile.tableTitles).toEqual(['主要工程量清单', '施工机械设备配置表']);
  });

  it('标题分层：第X章 → 第X节 → 一、/（一）/1.1 严格分层', async () => {
    const text = '第一章 编制总说明\n第一节 编制依据\n本工程编制依据包括招标文件及施工图纸等。\n第二节 主要施工方法\n一、施工准备\n（一）技术准备\n1.1 编制专项方案';
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.sectionCount).toBe(1);
    expect(profile.headingStructure).toEqual(['编制总说明']);
    expect(profile.subsectionCount).toBe(2);
    expect(profile.subitemCount).toBe(3);
  });

  it('简短施组降级：无第X章时"一、"提升为一级章节且不再计入子目', async () => {
    const text = '一、编制依据\n二、工程概况\n三、施工部署';
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.sectionCount).toBe(3);
    expect(profile.headingStructure).toEqual(['编制依据', '工程概况', '施工部署']);
    expect(profile.subitemCount).toBe(0);
  });

  it('单级数字编号章节：1、/2、形态且 1.1 单独计为子目', async () => {
    const text = '1、工程概况\n2、施工部署\n1.1 编制说明';
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.sectionCount).toBe(2);
    expect(profile.headingStructure).toEqual(['工程概况', '施工部署']);
    expect(profile.subitemCount).toBe(1);
  });

  it('目录噪声行（点线+页码/页码横线）不计入标题', async () => {
    const text = '第一章 工程概况 ....... 2\n第二章 施工部署 .. 26\n第三章 质量保证措施—45—\n第四章 绿色施工';
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.headingStructure).toEqual(['绿色施工']);
    expect(profile.sectionCount).toBe(1);
  });

  it('五要素闭合块：方案/流程语义+岗位/频次/闭环词面齐全', async () => {
    const text = '制定专项施工方案与管理制度，明确技术措施并落实施工工序流程与工艺步骤顺序，由项目经理每周组织检查，发现问题及时整改销项闭环。';
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.fiveElementCompleteBlocks).toBe(1);
  });

  it('参数词条：中文参数词按词计数、数值参数归并、按频次排序', async () => {
    const text = '混凝土浇筑后养护7天，二次养护不得少于7天，钢筋搭接长度按规范确定。';
    const profile = await buildReferenceQualityProfile(text);
    expect(profile.paramTokens[0]).toEqual({ token: '养护', count: 2 });
    expect(profile.paramTokens.find(item => item.token === '数值参数（数字+单位）')?.count).toBe(2);
    expect(profile.paramTokens.find(item => item.token === '搭接长度')?.count).toBe(1);
  });

  it('空文本：全部零值兜底', async () => {
    const profile = await buildReferenceQualityProfile('');
    expect(profile.wordCount).toBe(0);
    expect(profile.effectiveWordCount).toBe(0);
    expect(profile.paramDensity).toBe(0);
    expect(profile.arrowChainCoverage).toBe(0);
    expect(profile.duplicationRate).toBe(0);
    expect(profile.tableCount).toBe(0);
    expect(profile.sectionCount).toBe(0);
    expect(profile.avgSectionWords).toBe(0);
    expect(profile.headingStructure).toEqual([]);
    expect(profile.fiveElementCompleteBlocks).toBe(0);
  });
});
