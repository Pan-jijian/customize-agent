/**
 * referenceQualityProfile 单测：工程类型自动分类（强判别词竞争制+密度兜底仲裁）。
 * 4.26.0 起画像提取（buildReferenceQualityProfile）随模板参考库移除，仅保留类型判别测试。
 */
import { describe, expect, it } from 'vitest';

import {
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
