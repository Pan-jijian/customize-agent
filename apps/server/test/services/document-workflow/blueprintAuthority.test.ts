/**
 * P14/P24 蓝图分层权威（替代二元 passed）：
 * 1. computeBlueprintAuthorityAvailability per-check 映射——某道校验失败只使依赖它的权威不可用；
 * 2. chapterBlueprintAuthoritiesNeeded / chapterBlueprintAuthorityGaps——数值密集章所需权威判定与缺口计算；
 * 3. documentGenerator 源码防回归——阻断判定与消息已按权威粒度精确化，旧泛化文案与旧正则不残留。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chapterBlueprintAuthoritiesNeeded,
  chapterBlueprintAuthorityGaps,
  computeBlueprintAuthorityAvailability,
} from '@/services/document-workflow/integratedBlueprint';
import type { BlueprintValidationReport } from '@/services/document-workflow/integratedBlueprint';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

const availability = (input: Parameters<typeof computeBlueprintAuthorityAvailability>[0]) => computeBlueprintAuthorityAvailability(input);

describe('computeBlueprintAuthorityAvailability（P14 per-check 映射）', () => {
  it('四道校验全通过 → 全部权威可用', () => {
    expect(availability({ schemaPassed: true, factPassed: true, coveragePassed: true, consistencyErrors: [] })).toEqual({
      laborPeak: true,
      schedule: true,
      blueprint: true,
    });
  });

  it('Schema 失败 → 数值无源，全部权威不可用', () => {
    const result = availability({ schemaPassed: false, factPassed: true, coveragePassed: true, consistencyErrors: [] });
    expect(result).toEqual({ laborPeak: false, schedule: false, blueprint: false });
  });

  it('事实锚定失败 → 全部权威不可用', () => {
    const result = availability({ schemaPassed: true, factPassed: false, coveragePassed: true, consistencyErrors: [] });
    expect(result).toEqual({ laborPeak: false, schedule: false, blueprint: false });
  });

  it('覆盖校验失败 → 仅蓝图整体可用性受损，劳动力/进度权威不受连坐（P14 放行场景）', () => {
    const result = availability({ schemaPassed: true, factPassed: true, coveragePassed: false, consistencyErrors: [] });
    expect(result.laborPeak).toBe(true);
    expect(result.schedule).toBe(true);
    expect(result.blueprint).toBe(false);
  });

  it('内部一致性劳动力错误（峰值区间/口径）→ 仅 laborPeak 不可用', () => {
    const result = availability({ schemaPassed: true, factPassed: true, coveragePassed: true, consistencyErrors: ['劳动力峰值区间异常（min 60 > max 40）'] });
    expect(result.laborPeak).toBe(false);
    expect(result.schedule).toBe(true);
    expect(result.blueprint).toBe(true);
  });

  it('内部一致性里程碑错误 → 仅 schedule 不可用', () => {
    const result = availability({ schemaPassed: true, factPassed: true, coveragePassed: true, consistencyErrors: ['里程碑总和 900 天超过总工期 730 天'] });
    expect(result.schedule).toBe(false);
    expect(result.laborPeak).toBe(true);
    expect(result.blueprint).toBe(true);
  });

  it('内部一致性机械区间错误 → 仅 blueprint（资源章权威）不可用', () => {
    const result = availability({ schemaPassed: true, factPassed: true, coveragePassed: true, consistencyErrors: ['机械「挖掘机」台数区间异常'] });
    expect(result.blueprint).toBe(false);
    expect(result.laborPeak).toBe(true);
    expect(result.schedule).toBe(true);
  });

  it('内部一致性无关错误（六百分百板块）→ 不损伤任何权威', () => {
    const result = availability({ schemaPassed: true, factPassed: true, coveragePassed: true, consistencyErrors: ['扬尘治理六个百分百板块条目数 5 条（应为恰六条）'] });
    expect(result).toEqual({ laborPeak: true, schedule: true, blueprint: true });
  });

  it('决策锁缺失条目按归属细分（labor_peak 锁缺失仅 laborPeak 不可用）', () => {
    const result = availability({ schemaPassed: true, factPassed: true, coveragePassed: true, consistencyErrors: ['决策锁缺失数据条目 labor_peak（劳动力峰值 60 人未入锁）'] });
    expect(result.laborPeak).toBe(false);
    expect(result.schedule).toBe(true);
    expect(result.blueprint).toBe(true);
  });
});

describe('chapterBlueprintAuthoritiesNeeded（P14 现正则映射）', () => {
  it('劳动力章 → laborPeak', () => {
    expect(chapterBlueprintAuthoritiesNeeded('劳动力配置计划')).toEqual(['laborPeak']);
  });

  it('资源/机械章 → blueprint', () => {
    expect(chapterBlueprintAuthoritiesNeeded('资源配置计划')).toEqual(['blueprint']);
    expect(chapterBlueprintAuthoritiesNeeded('主要施工机械设备投入')).toEqual(['blueprint']);
  });

  it('进度/工期章 → schedule', () => {
    expect(chapterBlueprintAuthoritiesNeeded('施工进度计划')).toEqual(['schedule']);
    expect(chapterBlueprintAuthoritiesNeeded('工期保证措施')).toEqual(['schedule']);
  });

  it('复合标题（劳动力+进度）→ 多权威去重合并', () => {
    expect(chapterBlueprintAuthoritiesNeeded('劳动力资源配置与施工进度计划').sort()).toEqual(['blueprint', 'laborPeak', 'schedule'].sort());
  });

  it('非数值密集章 → 无所需权威（整体失败也不阻断）', () => {
    expect(chapterBlueprintAuthoritiesNeeded('质量保证措施')).toEqual([]);
    expect(chapterBlueprintAuthoritiesNeeded('安全文明施工')).toEqual([]);
  });
});

describe('chapterBlueprintAuthorityGaps（P14 阻断判定消费点）', () => {
  const validationReport = (overrides: Partial<BlueprintValidationReport>): BlueprintValidationReport => ({
    passed: true,
    checks: [
      { name: '1. Schema 校验', passed: true, message: '' },
      { name: '2. 事实锚定校验', passed: true, message: '' },
      { name: '3. 覆盖校验', passed: false, message: '清单条目零丢失校验失败' },
      { name: '4. 内部一致性校验', passed: true, message: '' },
    ],
    ...overrides,
  });

  it('validation 缺失（蓝图构建失败）→ 所需权威全阻断、无失败校验项', () => {
    const gaps = chapterBlueprintAuthorityGaps('劳动力配置计划', undefined);
    expect(gaps).toEqual({ missing: ['laborPeak'], failedChecks: [] });
  });

  it('无 authorityAvailability（旧数据/占位构造）→ 保守全阻断 + 列出失败校验项', () => {
    const validation = validationReport({ authorityAvailability: undefined });
    const gaps = chapterBlueprintAuthorityGaps('劳动力配置计划', validation);
    expect(gaps.missing).toEqual(['laborPeak']);
    expect(gaps.failedChecks).toEqual(['3. 覆盖校验']);
  });

  it('所需权威全部可用 → 放行（missing 为空）', () => {
    const validation = validationReport({ authorityAvailability: { laborPeak: true, schedule: true, blueprint: false } });
    const gaps = chapterBlueprintAuthorityGaps('劳动力配置计划', validation);
    expect(gaps.missing).toEqual([]);
  });

  it('所需权威部分缺失 → 精确列出缺失清单（劳动力章只报 laborPeak 不报 blueprint）', () => {
    const validation = validationReport({ authorityAvailability: { laborPeak: false, schedule: true, blueprint: false } });
    const gaps = chapterBlueprintAuthorityGaps('劳动力配置计划', validation);
    expect(gaps.missing).toEqual(['laborPeak']);
  });

  it('复合标题缺两个权威 → 两个都列出', () => {
    const validation = validationReport({ authorityAvailability: { laborPeak: false, schedule: false, blueprint: true } });
    const gaps = chapterBlueprintAuthorityGaps('劳动力资源配置与施工进度计划', validation);
    expect(gaps.missing.sort()).toEqual(['laborPeak', 'schedule']);
  });

  it('非数值密集章 → 永不阻断（missing 恒为空）', () => {
    const validation = validationReport({ authorityAvailability: { laborPeak: false, schedule: false, blueprint: false } });
    expect(chapterBlueprintAuthorityGaps('质量保证措施', validation).missing).toEqual([]);
  });
});

describe('documentGenerator 源码防回归（P14/P24）', () => {
  // P1 六阶段拆分：阶段 4（章节循环）已迁至 generationStages/stageChapterLoop.ts，防回归断言覆盖两者拼接文本
  const generator =
    readFileSync(path.join(SRC_DIR, 'documentGenerator.ts'), 'utf8') +
    readFileSync(path.join(SRC_DIR, 'generationStages', 'stageChapterLoop.ts'), 'utf8');

  it('阻断判定已替换为 chapterBlueprintAuthorityGaps（旧正则不残留；P17 语义分类器已传入）', () => {
    expect(generator).toContain('chapterBlueprintAuthorityGaps(chapter.title, session.blueprint.integratedBlueprint?.validation, session.planning.chapterIntentClassifier)');
    expect(generator).not.toMatch(/劳动力\|资源配置\|资源\|进度计划\|进度\|工期/u);
  });

  it('阻断消息精确列出缺失权威与失败校验项（旧泛化文案不残留）', () => {
    expect(generator).toContain('依赖蓝图权威 [${blueprintGaps.missing.join(\'、\')}]');
    expect(generator).toContain('蓝图校验项「${blueprintGaps.failedChecks.join(\'、\')}」未通过');
    expect(generator).not.toContain('依赖一体化蓝图参数桶权威');
  });

  it('章切片注入按章级权威可用性（整体失败但所需权威全可用仍注入）', () => {
    expect(generator).toContain('chapterBlueprintAuthoritiesNeeded(chapter.title, session.planning.chapterIntentClassifier).length > 0');
    expect(generator).toContain('blueprintGaps.missing.length === 0');
  });

  it('validateBlueprint 返回 authorityAvailability（per-check 映射落点）', () => {
    const blueprint = readFileSync(path.join(SRC_DIR, 'integratedBlueprint.ts'), 'utf8');
    expect(blueprint).toContain('return { passed: checks.every(check => check.passed), checks, authorityAvailability }');
    expect(blueprint).toContain('computeBlueprintAuthorityAvailability({');
  });
});
