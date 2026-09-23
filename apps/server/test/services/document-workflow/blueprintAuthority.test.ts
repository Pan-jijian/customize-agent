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
  isBlueprintPlanShapedChapter,
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

  /**
   * 4.56.3 N-4b 计划形态门：远端用户实测「清单未解析出条目 → 4/7 章整章阻断」的直接回放。
   * 该用户失败标题为「针对工程项目整体理解」「确保工期与质量的保障体系与措施」——
   * 二者交付物是**理解与措施**，不是计划数值；被 `/进度|工期/` 正则与「施工部署」语义锚点
   * 命中后整章不产出，用户拿到 3/7 篇残文档。本组用例锁定「非计划形态章一律不阻断」。
   */
  describe('4.56.3 N-4b 计划形态门（阻断判据，非注入判据）', () => {
    const allUnavailable = validationReport({ authorityAvailability: { laborPeak: false, schedule: false, blueprint: false } });

    it('远端用户实测标题 → 不再阻断（措施/理解章）', () => {
      expect(chapterBlueprintAuthorityGaps('确保工期与质量的保障体系与措施', allUnavailable).missing).toEqual([]);
      expect(chapterBlueprintAuthorityGaps('针对工程项目整体理解', allUnavailable).missing).toEqual([]);
      // validation 缺失（蓝图整体构建失败）时同样不阻断——非计划形态章可由证据独立成稿
      expect(chapterBlueprintAuthorityGaps('确保工期与质量的保障体系与措施', undefined).missing).toEqual([]);
    });

    it('真实计划章仍阻断（升级门不放行数值密集章：P0-6 口径不变）', () => {
      const cases: Array<[string, string]> = [
        ['施工进度计划', 'schedule'],
        ['施工总进度计划', 'schedule'],
        ['工期安排', 'schedule'],
        ['劳动力配置计划', 'laborPeak'],
        ['主要资源配置计划', 'blueprint'],
        ['主要施工机械设备表', 'blueprint'],
      ];
      for (const [title, authority] of cases) {
        expect(chapterBlueprintAuthorityGaps(title, allUnavailable).missing, title).toEqual([authority]);
      }
    });

    it('注入判据不受形态门影响（该注入什么照旧，不缩小已注入数据）', () => {
      // 形态门只作用于阻断：非计划形态标题在 needsBlueprintAuthority 上仍是原口径
      expect(chapterBlueprintAuthoritiesNeeded('工期保证措施')).toEqual(['schedule']);
      expect(chapterBlueprintAuthoritiesNeeded('确保工期与质量的保障体系与措施')).toEqual(['schedule']);
      // 而阻断侧为空
      expect(chapterBlueprintAuthorityGaps('工期保证措施', allUnavailable).missing).toEqual([]);
    });

    it('程序化判据：isBlueprintPlanShapedChapter 与形态门一致', () => {
      expect(isBlueprintPlanShapedChapter('主要施工机械设备表')).toBe(true);
      expect(isBlueprintPlanShapedChapter('确保工期与质量的保障体系与措施')).toBe(false);
      expect(isBlueprintPlanShapedChapter('针对工程项目整体理解')).toBe(false);
      // 「施工总体部署」是形态门内（部署）但**正则路径**无 进度/工期 关键词 —— 其 schedule 归属
      // 由语义锚点（分类器）给出，本测试不传分类器故为 []。锁定该分工，防有人误以为形态门把部署章挡掉。
      expect(isBlueprintPlanShapedChapter('施工总体部署')).toBe(true);
      expect(chapterBlueprintAuthoritiesNeeded('施工总体部署')).toEqual([]);
    });
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

  /**
   * 4.56.3 N-5：清单不可用时的**具体诊断**必须到达用户。原实现把 `resolveBillOfQuantities` 产出的
   * 精确原因（未识别到清单文件 / 索引不存在 / 解析出 0 条目 / 仅封面类结构性文件）写进
   * `diagnostics.warnings` 后**无人消费**，用户只看到「请检查清单解析与蓝图构建诊断后重试」。
   */
  it('N-5 阻断消息携带清单侧具体诊断（不再只有「请重试」）', () => {
    // 诊断源确实存在且分四类可辨识原因（改动 parse.ts 的措辞会红，提醒同步 N-5 的过滤正则）
    const parse = readFileSync(path.join(SRC_DIR, 'integratedBlueprint', 'parse.ts'), 'utf8');
    expect(parse).toContain('绑定资料中未识别到工程量清单');
    expect(parse).toContain('项目知识库索引不存在');
    expect(parse).toContain('解析出 0 条目');
    expect(parse).toContain('结构性文件');
    // 消费点：阻断阶段读取 blueprint.diagnostics.warnings 并按清单相关词过滤后写入 details
    expect(generator).toContain('session.blueprint.integratedBlueprint?.diagnostics?.warnings');
    expect(generator).toContain('const boqDiagnostics =');
    expect(generator).toContain('...boqDiagnostics,');
    expect(generator).toContain('以上为清单侧诊断');
  });

  /**
   * 4.56.3 N-4c：「不阻断」必须配「不编数」。N-4b 让非计划形态章不再整章阻断，若不同时给写作层
   * 一条「计划类推导值一律不写」的硬约束，就是 P0-6 的反方向（拿不到权威值却以为齐备 → 模型自产数值）。
   */
  it('N-4c 缺权威章注入「计划类权威不可用」约束（阻断改约束的前提）', () => {
    expect(generator).toContain('noBlueprintAuthorityConstraint');
    expect(generator).toContain('【计划类权威本次不可用】');
    expect(generator).toContain('不得输出');
    // 约束必须真的进写作输入（只在常量里定义而没接线是本仓反复出现的缺陷形态）
    expect(generator).toContain('roleContext: [roleContext, noBlueprintAuthorityConstraint].filter(Boolean).join(\'\\n\')');
    // 触发条件：原口径属蓝图权威章 且 实际未注入章切片
    expect(generator).toContain('!chapterBlueprintSlice && chapterNeedsBlueprintAuthority');
  });

  it('validateBlueprint 返回 authorityAvailability（per-check 映射落点）', () => {
    // S6 模块拆分：校验层已迁至 integratedBlueprint/validate.ts，防回归断言覆盖拆分后归属文件
    const blueprint = readFileSync(path.join(SRC_DIR, 'integratedBlueprint', 'validate.ts'), 'utf8');
    expect(blueprint).toContain('return { passed: checks.every(check => check.passed), checks, authorityAvailability }');
    expect(blueprint).toContain('computeBlueprintAuthorityAvailability({');
  });
});
