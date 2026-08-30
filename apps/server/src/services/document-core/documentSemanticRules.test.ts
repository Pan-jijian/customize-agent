/**
 * documentSemanticRules 纯函数单测：
 * applyKeywordRules（多规则命中合并/去重/顺序稳定/lastIndex 副作用隔离）
 * 与 firstKeywordRuleOutput（首命中即返回）。正则均为共享模块级实例，
 * 重点回归 lastIndex 在全局标志下的跨调用污染问题。
 */
import { describe, expect, it } from 'vitest';
import { applyKeywordRules, firstKeywordRuleOutput, FACT_RULES, MATERIAL_ROLE_RULES, type KeywordRule } from './documentSemanticRules';

describe('applyKeywordRules 命中与合并', () => {
  it('单规则单模式命中，返回该规则全部 output', () => {
    expect(applyKeywordRules('本项目的实施范围与边界', FACT_RULES)).toContain('实施范围');
    expect(applyKeywordRules('本项目的实施范围与边界', FACT_RULES)).toContain('对象范围');
  });

  it('同一规则多模式命中不重复', () => {
    // '范围' 与 '工作内容' 同属 scope 规则，输出只出现一次
    const result = applyKeywordRules('工作内容与范围边界', FACT_RULES);
    expect(result.filter(item => item === '实施范围')).toHaveLength(1);
  });

  it('多规则命中输出合并且按规则顺序稳定', () => {
    // 质量 + 进度两个规则都命中，输出顺序 = 规则定义顺序
    const result = applyKeywordRules('质量验收与进度计划', FACT_RULES);
    expect(result.indexOf('质量要求')).toBeLessThan(result.indexOf('周期要求'));
  });

  it('英文关键词命中（大小写不敏感）', () => {
    expect(applyKeywordRules('DATA SHEET', MATERIAL_ROLE_RULES)).toContain('structured_data');
    expect(applyKeywordRules('BUDGET', MATERIAL_ROLE_RULES)).toContain('budget_cost');
    expect(applyKeywordRules('PRICE', MATERIAL_ROLE_RULES)).toContain('budget_cost');
  });

  it('无命中返回空数组', () => {
    expect(applyKeywordRules('，。；', FACT_RULES)).toEqual([]);
    expect(applyKeywordRules('', FACT_RULES)).toEqual([]);
  });

  it('空文本安全', () => {
    expect(applyKeywordRules('', MATERIAL_ROLE_RULES)).toEqual([]);
  });
});

describe('applyKeywordRules lastIndex 副作用回归', () => {
  const rules: KeywordRule<string>[] = [
    { id: 'x', label: 'x', patterns: [/测试/giu], output: ['hit'] },
  ];

  it('同一文本连续调用结果一致（lastIndex 不漂移）', () => {
    expect(applyKeywordRules('测试测试', rules)).toEqual(['hit']);
    expect(applyKeywordRules('测试测试', rules)).toEqual(['hit']);
  });

  it('先命中后未命中交替调用不互相污染', () => {
    expect(applyKeywordRules('测试文本', rules)).toEqual(['hit']);
    expect(applyKeywordRules('无关文本', rules)).toEqual([]);
    expect(applyKeywordRules('测试文本', rules)).toEqual(['hit']);
  });

  it('不同规则数组间共享实例不互相影响', () => {
    expect(applyKeywordRules('测试', rules)).toEqual(['hit']);
    // FACT_RULES 与 MATERIAL_ROLE_RULES 均为共享实例，交替调用结果稳定
    expect(applyKeywordRules('需求', FACT_RULES)).toContain('需求约束');
    expect(applyKeywordRules('需求', MATERIAL_ROLE_RULES)).toContain('requirement_document');
  });

  it('firstKeywordRuleOutput 返回首个命中规则第一个输出', () => {
    // '计划' 命中 schedule 规则（output[0] 为周期要求），且它先于任何后续规则
    const output = firstKeywordRuleOutput('施工进度计划书', FACT_RULES);
    expect(output).toBe('周期要求');
  });

  it('firstKeywordRuleOutput 在首个规则命中时直接返回', () => {
    // '需求' 命中首个规则 requirement，output[0] 为需求约束
    expect(firstKeywordRuleOutput('需求', FACT_RULES)).toBe('需求约束');
  });

  it('firstKeywordRuleOutput 未命中返回 undefined', () => {
    expect(firstKeywordRuleOutput('，', FACT_RULES)).toBeUndefined();
    expect(firstKeywordRuleOutput('', FACT_RULES)).toBeUndefined();
  });
});

describe('MATERIAL_ROLE_RULES 角色映射矩阵', () => {
  const cases: Array<[string, string]> = [
    ['招标需求条款', 'requirement_document'],
    ['澄清与变更', 'addendum'],
    ['表格与明细', 'structured_data'],
    ['预算金额', 'budget_cost'],
    ['设计说明图纸', 'design_specification'],
    ['人员设备配置', 'resource_recommendation'],
    ['质量安全环保', 'schedule_quality_safety'],
    ['工作范围', 'scope_description'],
    ['技术规范标准', 'technical_specification'],
    ['风险与现场约束', 'risk_constraints'],
  ];
  it.each(cases)('%s → %s', (text, role) => {
    expect(applyKeywordRules(text, MATERIAL_ROLE_RULES)).toContain(role);
  });

  it('一条文本可同时命中多角色', () => {
    const roles = applyKeywordRules('质量安全要求及预算费用', MATERIAL_ROLE_RULES);
    expect(roles).toContain('schedule_quality_safety');
    expect(roles).toContain('budget_cost');
  });
});
