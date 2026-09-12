/**
 * factCoverage 单测（V5 P6）：事实落位候选坏值拦截与引用形态泛化匹配。
 * run1 实测：30 条「已确认事实未在正文中落位」告警中近半为不可落位的坏值（清单表行/
 * 图纸签章 OCR/表单残片），其余为引用形态差异（断折号/引导词改写/双主体拆分）。
 */
import { describe, expect, it } from 'vitest';
import { factValueAppears, isMisExtractedFactText, uncoveredImportantFacts } from '@/services/document-workflow/helpers/factCoverage';
import type { DocumentFact } from '@/services/document-workflow/types';

function makeFact(partial: Partial<DocumentFact>): DocumentFact {
  return { key: 'k', value: 'v', sourceFile: '材料.pdf', roleId: 'tender_document', confidence: 0.9, ...partial };
}

describe('isMisExtractedFactText 坏值候选过滤（run1 实测）', () => {
  it.each([
    ['项目名称', '招标补疑-舒城县城镇功能活力品质提升一期项目（一标）——公共广场空间改造等提升工程.doc', '文件名残留'],
    ['项目名称', '2225111舒城县城镇功能活力品质提升ANHUIURBANCONSTRUCTIONDESIGNIPROJECT施工图INSTITUTECORP.,LTD.', 'OCR 大写乱串'],
    ['项目名称', '2225111舒城县城镇功能活力品质提升魏永魏永', '章体人名连续重复'],
    ['项目名称', '建设单位：（签章）施工单位：（签章）', '签章表单残片'],
    ['项目名称', 'R2C3计量单位：', '标签冒号结尾'],
    ['项目名称', '见投标人须知前附表', '指引语'],
    ['项目名称', '项目所在地', '纯标签词'],
    ['项目名称', '项目编号：舒城县城镇功能活力品质提升一期项目勘察设计总承包2225111', '编号指引前缀'],
    ['招标人', '不再承担该费用', '机构字段句子混入'],
    ['招标人', '本公司（单位）拟参加项目的投标', '机构字段句子混入'],
  ])('坏值 %s=%s（%s）→ 过滤', (label, value) => {
    expect(isMisExtractedFactText(label, value)).toBe(true);
  });

  it('真实事实不误杀', () => {
    for (const [label, value] of [
      ['项目名称', '舒城县城镇功能活力品质提升一期项目（一标）——公共广场空间改造等提升工程'],
      ['招标人', '舒城县住房和城乡建设局,安徽龙舒智慧城市发展有限责任公司'],
      ['招标范围', '主要施工内容包含公共广场改造、停车场改造、绿化工程、人行道拆除及更新'],
      ['计划工期', '360日历天'],
    ]) {
      expect(isMisExtractedFactText(label, value)).toBe(false);
    }
  });
});

describe('factValueAppears 引用形态泛化匹配（run1 实测）', () => {
  it('断折号族差异（-- vs ——）视为同值', () => {
    expect(factValueAppears('舒城县城镇功能活力品质提升一期项目（一标）——公共广场空间改造等提升工程实施。', '舒城县城镇功能活力品质提升一期项目（一标）--公共广场空间改造等提升工程')).toBe(true);
  });

  it('引导词改写（包含→涵盖）按短语分片判定已使用', () => {
    const markdown = '工程内容涵盖公共广场改造、停车场改造、绿化工程、人行道拆除及更新、木栈道更新及改造。';
    expect(factValueAppears(markdown, '主要施工内容包含公共广场改造、停车场改造、绿化工程、人行道拆除及更新')).toBe(true);
  });

  it('双主体被拆开分别引用视为已使用', () => {
    const markdown = '建设单位为舒城县住房和城乡建设局，代建单位为安徽龙舒智慧城市发展有限责任公司。';
    expect(factValueAppears(markdown, '舒城县住房和城乡建设局,安徽龙舒智慧城市发展有限责任公司')).toBe(true);
  });

  it('长值 70% 前缀泛化（尾部差异失配）', () => {
    expect(factValueAppears('舒城县城镇功能活力品质提升一期项目（一标）——公共广场空间改造等提升工程施工。', '舒城县城镇功能活力品质提升一期项目（一标）——公共广场空间改造等提升工程（含配套附属设施）')).toBe(true);
  });

  it('真未落位仍判未使用（含短语分片不命中）', () => {
    expect(factValueAppears('本工程仅包含道路工程内容。', '舒城县城镇功能活力品质提升一期项目（一标）——公共广场空间改造等提升工程')).toBe(false);
    expect(factValueAppears('工程内容涵盖绿化工程。', '主要施工内容包含公共广场改造、停车场改造、室内装修')).toBe(false);
  });
});

describe('uncoveredImportantFacts 候选过滤（run1 实测）', () => {
  it('清单表「项目名称」列条目不作落位候选', () => {
    const facts = [
      makeFact({ key: '项目名称', processingType: 'table', roleId: 'bill_of_quantities', value: '钢筋混凝土污水检查井（污水）' }),
      makeFact({ key: '项目名称', processingType: 'table', roleId: 'bill_of_quantities', value: '分部小计' }),
    ];
    expect(uncoveredImportantFacts('正文无相关内容。', facts)).toEqual([]);
  });

  it('坏值过滤后真值未落位仍报', () => {
    const facts = [
      makeFact({ key: '项目名称', processingType: 'rule', value: '项目所在地' }),
      makeFact({ key: '项目名称', processingType: 'rule', value: '舒城县城镇功能活力品质提升一期项目（一标）——公共广场空间改造等提升工程' }),
    ];
    const missing = uncoveredImportantFacts('正文无相关内容。', facts);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.value).toContain('舒城县城镇功能活力品质提升一期项目');
  });
});
