import { describe, expect, it } from 'vitest';
import type { EngineeringTechnicalFact, FactCategoryInput } from '@/services/types/engineeringTechnicalFactTypes';
import {
  CHAPTER_FACT_MATCHERS,
  COST_RE,
  COVERAGE_LABEL_MIN_LENGTH,
  DEFAULT_ENGINEERING_TEMPLATE_MATCHERS,
  DISCIPLINE_PATTERNS,
  FACT_CATEGORY_RULES,
  FACT_DEDUPE_NUMBER_RE,
  FACT_KEEP_PATTERNS,
  FACT_KEEP_WORD_GROUPS,
  FACT_SENTENCE_SPLIT_RE,
  FACT_WHITESPACE_RE,
  FREQUENCY_RE,
  MARKDOWN_TABLE_PIPE_RE,
  METHOD_CHAPTER_TITLE_RE,
  PARAMETER_RE,
  QUANTITY_RE,
  RESOURCE_RE,
  SCHEDULE_RE,
  STANDARD_RE,
} from '@/services/constants/engineeringTechnicalFactConstants';

describe('结构化参数正则', () => {
  it('PARAMETER_RE 抽取型号/数值/单位/规格', () => {
    expect('C30混凝土 25mm 3×4 GB/T12345 8@200'.match(PARAMETER_RE)?.length).toBeGreaterThanOrEqual(4);
    PARAMETER_RE.lastIndex = 0;
  });

  it('QUANTITY_RE 抽取数量词', () => {
    expect(QUANTITY_RE.test('共10台设备')).toBe(true);
    QUANTITY_RE.lastIndex = 0;
    expect(QUANTITY_RE.test('没有数字')).toBe(false);
  });

  it('SCHEDULE_RE 抽取工期与频率', () => {
    expect(SCHEDULE_RE.test('540天')).toBe(true);
    SCHEDULE_RE.lastIndex = 0;
    expect(SCHEDULE_RE.test('每天检查')).toBe(true);
    SCHEDULE_RE.lastIndex = 0;
    expect(SCHEDULE_RE.test('没有时间词')).toBe(false);
  });

  it('COST_RE 抽取金额', () => {
    expect(COST_RE.test('预算100万元')).toBe(true);
    COST_RE.lastIndex = 0;
    expect(COST_RE.test('没有金额')).toBe(false);
  });

  it('FREQUENCY_RE 抽取频次', () => {
    expect(FREQUENCY_RE.test('不少于3次')).toBe(true);
    FREQUENCY_RE.lastIndex = 0;
    expect(FREQUENCY_RE.test('100%全数检查')).toBe(true);
  });

  it('RESOURCE_RE 抽取资源投入', () => {
    expect(RESOURCE_RE.test('配备5名工程师')).toBe(true);
    RESOURCE_RE.lastIndex = 0;
    expect(RESOURCE_RE.test('项目负责人')).toBe(true);
  });

  it('STANDARD_RE 抽取标准号', () => {
    expect(STANDARD_RE.test('GB 50300-2013')).toBe(true);
    STANDARD_RE.lastIndex = 0;
    expect(STANDARD_RE.test('T/CECS 100-2020')).toBe(true);
  });
});

describe('行业词库默认空集合（防跨行业污染）', () => {
  it('DISCIPLINE_PATTERNS / 过程词表均为空', () => {
    expect(DISCIPLINE_PATTERNS).toEqual([]);
    expect(DEFAULT_ENGINEERING_TEMPLATE_MATCHERS).toEqual([]);
  });

  it('FACT_KEEP_PATTERNS 包含 7 类保留正则', () => {
    expect(FACT_KEEP_PATTERNS).toHaveLength(7);
    expect(FACT_KEEP_PATTERNS).toContain(PARAMETER_RE);
    expect(FACT_KEEP_PATTERNS).toContain(STANDARD_RE);
  });

  it('FACT_KEEP_WORD_GROUPS 包含 6 组词表（默认空）', () => {
    expect(FACT_KEEP_WORD_GROUPS).toHaveLength(6);
    for (const group of FACT_KEEP_WORD_GROUPS) expect(group).toEqual([]);
  });
});

describe('工具正则与常量', () => {
  it('FACT_SENTENCE_SPLIT_RE 按句号分号换行拆分', () => {
    expect('句一。句二；句三\n句四'.split(FACT_SENTENCE_SPLIT_RE)).toEqual(['句一', '句二', '句三', '句四']);
  });

  it('FACT_WHITESPACE_RE 归一空白', () => {
    expect('a\t b'.replace(FACT_WHITESPACE_RE, '_')).toBe('a_b');
  });

  it('FACT_DEDUPE_NUMBER_RE 抹平数字', () => {
    expect('C30混凝土25mm'.replace(FACT_DEDUPE_NUMBER_RE, '#')).toBe('C#混凝土#mm');
  });

  it('MARKDOWN_TABLE_PIPE_RE 识别竖线', () => {
    expect(MARKDOWN_TABLE_PIPE_RE.test('|')).toBe(true);
  });

  it('METHOD_CHAPTER_TITLE_RE 识别方法流程类标题', () => {
    expect(METHOD_CHAPTER_TITLE_RE.test('施工方法')).toBe(true);
    expect(METHOD_CHAPTER_TITLE_RE.test('工程概况')).toBe(false);
  });

  it('COVERAGE_LABEL_MIN_LENGTH 为 2', () => {
    expect(COVERAGE_LABEL_MIN_LENGTH).toBe(2);
  });
});

function makeInput(overrides: Partial<FactCategoryInput> = {}): FactCategoryInput {
  return {
    text: '',
    parameters: [],
    quantities: [],
    scheduleValues: [],
    costValues: [],
    frequencyValues: [],
    resourceValues: [],
    standards: [],
    inspection: [],
    riskControl: [],
    ...overrides,
  };
}

function categorize(input: FactCategoryInput) {
  const rule = FACT_CATEGORY_RULES.find(r => r.match(input));
  return rule?.category;
}

describe('FACT_CATEGORY_RULES 顺序命中', () => {
  it('cost_commitment 优先于其他（含金额即命中）', () => {
    expect(categorize(makeInput({ costValues: ['100万元'], scheduleValues: ['540天'] }))).toBe('cost_commitment');
  });

  it('risk_response 优先于 schedule_milestone（工期+风险控制）', () => {
    expect(categorize(makeInput({ scheduleValues: ['540天'], riskControl: ['应急预案'] }))).toBe('risk_response');
  });

  it('schedule_milestone 仅有工期时命中', () => {
    expect(categorize(makeInput({ scheduleValues: ['540天'] }))).toBe('schedule_milestone');
  });

  it('inspection_ratio 优先于 management_frequency（频次+检查）', () => {
    expect(categorize(makeInput({ frequencyValues: ['不少于3次'], inspection: ['每日检查'] }))).toBe('inspection_ratio');
  });

  it('management_frequency 仅频次时命中', () => {
    expect(categorize(makeInput({ frequencyValues: ['每周一次'] }))).toBe('management_frequency');
  });

  it('resource_allocation 资源值命中', () => {
    expect(categorize(makeInput({ resourceValues: ['5名工程师'] }))).toBe('resource_allocation');
  });

  it('engineering_quantity 工程量命中', () => {
    expect(categorize(makeInput({ quantities: ['10台'] }))).toBe('engineering_quantity');
  });

  it('standard_requirement 标准号命中', () => {
    expect(categorize(makeInput({ standards: ['GB 50300'] }))).toBe('standard_requirement');
  });

  it('无任何命中返回 undefined', () => {
    expect(categorize(makeInput())).toBeUndefined();
  });
});

function makeFact(overrides: Partial<EngineeringTechnicalFact> = {}): EngineeringTechnicalFact {
  return {
    id: 'f1',
    category: 'technical_parameter',
    discipline: '',
    workItem: '',
    text: '',
    confidence: 0.5,
    ...overrides,
  };
}

describe('CHAPTER_FACT_MATCHERS', () => {
  it('质量类章节匹配检查/标准类事实', () => {
    const quality = CHAPTER_FACT_MATCHERS[0];
    expect(quality.pattern.test('质量保证措施')).toBe(true);
    expect(quality.match(makeFact({ qualityControl: ['三检制'] }))).toBe(true);
    expect(quality.match(makeFact({ category: 'inspection_ratio' }))).toBe(true);
    expect(quality.match(makeFact())).toBe(false);
  });

  it('进度类章节匹配工期/频次事实', () => {
    const schedule = CHAPTER_FACT_MATCHERS[1];
    expect(schedule.pattern.test('施工进度计划')).toBe(true);
    expect(schedule.match(makeFact({ scheduleValues: ['540天'] }))).toBe(true);
    expect(schedule.match(makeFact({ category: 'management_frequency' }))).toBe(true);
    expect(schedule.match(makeFact())).toBe(false);
  });

  it('资源类章节匹配资源/工程量事实', () => {
    const resource = CHAPTER_FACT_MATCHERS[2];
    expect(resource.pattern.test('人员配备计划')).toBe(true);
    expect(resource.match(makeFact({ resourceValues: ['5名'] }))).toBe(true);
    expect(resource.match(makeFact({ quantities: ['10台'] }))).toBe(true);
    expect(resource.match(makeFact())).toBe(false);
  });

  it('费用类章节匹配成本事实', () => {
    const cost = CHAPTER_FACT_MATCHERS[3];
    expect(cost.pattern.test('工程预算')).toBe(true);
    expect(cost.match(makeFact({ costValues: ['100万元'] }))).toBe(true);
    expect(cost.match(makeFact({ category: 'cost_commitment' }))).toBe(true);
    expect(cost.match(makeFact())).toBe(false);
  });

  it('风险类章节匹配风险控制事实', () => {
    const risk = CHAPTER_FACT_MATCHERS[4];
    expect(risk.pattern.test('安全生产应急预案')).toBe(true);
    expect(risk.match(makeFact({ riskControl: ['预案'] }))).toBe(true);
    expect(risk.match(makeFact({ category: 'risk_response' }))).toBe(true);
    expect(risk.match(makeFact())).toBe(false);
  });

  it('重难点章节匹配高置信度事实', () => {
    const key = CHAPTER_FACT_MATCHERS[5];
    expect(key.pattern.test('工程重点难点')).toBe(true);
    expect(key.match(makeFact({ confidence: 0.8 }))).toBe(true);
    expect(key.match(makeFact({ confidence: 0.3 }))).toBe(false);
  });
});
