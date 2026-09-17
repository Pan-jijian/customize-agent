/**
 * V2 批2-1 数据口径族边界矩阵（M/N/P 组，与 dicCrossProjectCopyBoundary 的 L 组互补——
 * L 组覆盖 phaseLaborMixingIssues 检测面，本文件补齐同批新增的机械分批/前期动作时限检测器
 * 与阶段劳动力确定性修复器）：
 * - equipmentBatchConflicts（M1-M6）——首批+剩余并存组合成立放行/不成立阻断、维持句豁免
 *   （保持/控制类存量表述非分批投入口径）、负向声明行豁免、表格行豁免、多名称列举归属、
 *   多值组合「任一成立即放行」、非法台数条目静默跳过；
 * - preliminaryActionTimingIssues（N1-N8）——开工后第 N 日且 N ≥ 总工期命中、N < 总工期放行、
 *   无前期动作词放行、总工期未知不判、表格行/负向声明豁免（负向词仅 ±40 字窗口内命中方豁免）、
 *   「第 N 个日历日」变体、动作词位于数字之后的 ±40 字窗口、「第 N 日内」豁免收窄（r14 丰乐镇
 *   门禁 #5b：窗口含前期动作词照报，末期语境才豁免）、尾随「内」吞并改写、上限 5 条；
 * - fixPhaseLaborValues（P1-P6）——权威值硬替换（基础通道/枚举列举通道同源）、多值降序替换
 *   互不位移、值相符零动作、无权威原样返回、阶段名拼接歧义不进确定性修复、表格行不触碰；
 * - fixEquipmentBatchConflicts（Q1-Q4，r17 丰乐镇归因 #B2/B3）——分批矛盾命中删除 later 批
 *   「N 台」数字（前缀量词随删）、检测复检零残留、已修复文本幂等零变更、组合成立/无权威零动作。
 * 全部用例为确定性判定，无语义/网络依赖。
 */
import { describe, expect, it } from 'vitest';
import { equipmentBatchConflicts, fixEquipmentBatchConflicts, fixPhaseLaborValues, fixPreliminaryActionTimingDeterministically, preliminaryActionTimingIssues } from '@/services/document-workflow/documentIntegrityChecks';

const excavators = [{ name: '挖掘机', count: 5 }];

describe('equipmentBatchTimingBoundary · M 组：机械分批台数矛盾', () => {
  it('M1 首批+剩余并存且组合之和不等于汇总 → blocker', () => {
    const issues = equipmentBatchConflicts('首批挖掘机5台进场，剩余挖掘机5台补充进场。', excavators);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('机械设备分批台数矛盾');
    expect(issues[0].message).toContain('挖掘机');
    expect(issues[0].message).toContain('5 台');
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].category).toBe('fact_consistency');
  });

  it('M2 分批组合之和等于蓝图汇总（3+2=5）→ 0 条', () => {
    const issues = equipmentBatchConflicts('首批挖掘机3台进场，剩余挖掘机2台进场。', excavators);
    expect(issues).toHaveLength(0);
  });

  it('M3 维持句豁免（保持类存量表述非分批投入口径）→ 0 条', () => {
    const issues = equipmentBatchConflicts('首批挖掘机3台进场，剩余挖掘机保持3台。', excavators);
    expect(issues).toHaveLength(0);
  });

  it('M4 负向声明行豁免（引用旧值的修复声明）→ 0 条', () => {
    const issues = equipmentBatchConflicts('首批挖掘机3台进场。\n不再出现剩余挖掘机3台补充进场的表述。', excavators);
    expect(issues).toHaveLength(0);
  });

  it('M5 表格行（分批明细表合法承载）→ 0 条', () => {
    const issues = equipmentBatchConflicts('| 首批挖掘机5台 | 剩余挖掘机5台 |', excavators);
    expect(issues).toHaveLength(0);
  });

  it('M6 无首批/剩余批词或非法台数条目 → 0 条', () => {
    expect(equipmentBatchConflicts('现场配备挖掘机10台。', excavators)).toHaveLength(0);
    expect(equipmentBatchConflicts('首批挖掘机5台，剩余挖掘机5台。', [{ name: '挖掘机', count: 0 }])).toHaveLength(0);
    expect(equipmentBatchConflicts('首批挖掘机5台，剩余挖掘机5台。', [])).toHaveLength(0);
  });

  it('M7 多名称列举归属同句批词（两台组合均成立）→ 0 条', () => {
    const issues = equipmentBatchConflicts(
      '首批挖掘机3台、自卸汽车2台进场，剩余挖掘机2台、自卸汽车3台进场。',
      [{ name: '挖掘机', count: 5 }, { name: '自卸汽车', count: 5 }],
    );
    expect(issues).toHaveLength(0);
  });

  it('M8 多值组合「任一成立即放行」（2+3=5 存在）→ 0 条；无组合成立 → 1 条', () => {
    const pass = equipmentBatchConflicts('首批挖掘机2台、挖掘机4台进场，剩余挖掘机1台、挖掘机3台进场。', excavators);
    expect(pass).toHaveLength(0);
    const fail = equipmentBatchConflicts('首批挖掘机2台、挖掘机4台进场，剩余挖掘机4台进场。', excavators);
    expect(fail).toHaveLength(1);
  });
});

describe('equipmentBatchTimingBoundary · N 组：前期动作时限矛盾', () => {
  it('N1 前期动作时限 = 总工期（开工后第 90 日 / 总工期 90 日）→ blocker', () => {
    // 4.32.0：原用例尾部「内」使句子成为范围承诺（「90 日内完成」），按丰乐镇复测 #77 甄别豁免
    // （见 N8）；本用例去「内」保留「第 90 日完成」的竣工日动作形态，核心契约不变
    const issues = preliminaryActionTimingIssues('制度交底安排在开工令下发后第90日完成。', 90);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('前期动作时限矛盾');
    expect(issues[0].message).toContain('第 90 日');
    expect(issues[0].severity).toBe('blocker');
  });

  it('N2 N < 总工期（第 30 日 < 90 日）→ 0 条', () => {
    const issues = preliminaryActionTimingIssues('技术交底安排在开工令下发后第30日内完成。', 90);
    expect(issues).toHaveLength(0);
  });

  it('N3 无前期动作词（竣工类表述）→ 0 条', () => {
    const issues = preliminaryActionTimingIssues('开工令下发后第120日工程完工。', 90);
    expect(issues).toHaveLength(0);
  });

  it('N4 总工期未知/非法 → 0 条（不判）', () => {
    expect(preliminaryActionTimingIssues('交底安排在开工令下发后第90日内完成。', undefined)).toHaveLength(0);
    expect(preliminaryActionTimingIssues('交底安排在开工令下发后第90日内完成。', 0)).toHaveLength(0);
    expect(preliminaryActionTimingIssues('交底安排在开工令下发后第90日内完成。', Number.NaN)).toHaveLength(0);
  });

  it('N5 表格行与负向声明行豁免 → 0 条', () => {
    expect(preliminaryActionTimingIssues('| 交底 | 开工令下发后第90日内 |', 90)).toHaveLength(0);
    expect(preliminaryActionTimingIssues('本章不再出现“交底安排在开工令下发后第90日内”的表述。', 90)).toHaveLength(0);
  });

  it('N6 「第 N 个日历日」变体与动作词位于数字之后（±40 字窗口）→ blocker', () => {
    const variant = preliminaryActionTimingIssues('开工令下发后第90个日历日组织技术交底。', 90);
    expect(variant).toHaveLength(1);
    const afterNumber = preliminaryActionTimingIssues('开工令下发后第90日组织安全技术交底。', 90);
    expect(afterNumber).toHaveLength(1);
  });

  it('N8 「第 N 日内」豁免收窄（r14 丰乐镇门禁 #5b）：±40 字窗口含前期动作词照报 → 1 条', () => {
    // 4.32.0 曾对「内」全量豁免（丰乐镇复测 #77）；r13 实测全免漏网「开工令下发后第90日内完成
    // 首批封样清单编制」（封样双控要求早期完成，写作红线本禁此形态）——收窄为：窗口含前期
    // 动作词时不豁免「内」，末期语境（窗口无动作词）维持豁免
    const train = preliminaryActionTimingIssues('消防培训与应急演练同步落实。开工后第90日内，由安全员组织全体作业人员进行1次消防器材使用培训。', 90);
    expect(train).toHaveLength(1);
    expect(train[0].message).toContain('前期动作时限矛盾');
    expect(train[0].severity).toBe('blocker');
    expect(preliminaryActionTimingIssues('开工令下发后第90个日历日内完成技术交底。', 90)).toHaveLength(1);
  });

  it('N8b 「第 N 日内」末期语境仍豁免（窗口无前期动作词）→ 0 条', () => {
    expect(preliminaryActionTimingIssues('开工令下发后第90日内完成全部竣工资料组卷移交。', 90)).toHaveLength(0);
  });

  it('N8c 「内」形态确定性改写：尾随「内」一并吞并（无「阶段内内」），复检清零', () => {
    const fixed = fixPreliminaryActionTimingDeterministically('项目部在开工令下发后第90日内完成首批封样清单编制。', 90);
    expect(fixed.fixedCount).toBe(1);
    expect(fixed.markdown).toContain('施工准备阶段内完成');
    expect(fixed.markdown).not.toContain('内内');
    expect(preliminaryActionTimingIssues(fixed.markdown, 90)).toHaveLength(0);
  });

  it('N7 上限 5 条（6 处命中截断）', () => {
    const markdown = Array.from({ length: 6 }, (_, index) => `开工令下发后第${90 + index}日组织技术交底。`).join('\n');
    expect(preliminaryActionTimingIssues(markdown, 90)).toHaveLength(5);
  });
});

describe('equipmentBatchTimingBoundary · P 组：阶段劳动力确定性修复（写时对齐同源）', () => {
  const phaseAuthorities = [{ phase: '污水管网工程', value: 35, trace: '按工效推导' }];
  const roadAuthorities = [
    { phase: '污水管网工程', value: 35, trace: '按工效推导' },
    { phase: '道路铺装工程', value: 68 },
  ];

  it('P1 基础通道命中硬替换为权威值 → fixedCount 1 且复检零残留', () => {
    const result = fixPhaseLaborValues('污水管网工程阶段投入劳动力约50人。', phaseAuthorities);
    expect(result.fixedCount).toBe(1);
    expect(result.residualCount).toBe(0);
    expect(result.markdown).toContain('约35人');
    expect(result.markdown).not.toContain('50人');
    expect(result.details.join('')).toContain('污水管网工程 50人→35人');
  });

  it('P2 多值降序替换互不位移（两处同时回填）', () => {
    const result = fixPhaseLaborValues('污水管网工程阶段投入劳动力约50人，道路铺装工程阶段投入劳动力约70人。', roadAuthorities);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('约35人');
    expect(result.markdown).toContain('约68人');
    expect(result.markdown).not.toContain('50人');
    expect(result.markdown).not.toContain('70人');
  });

  it('P3 数值已相符 → 零动作原样返回', () => {
    const input = '污水管网工程阶段投入劳动力约35人。';
    const result = fixPhaseLaborValues(input, phaseAuthorities);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(input);
    expect(result.residualCount).toBe(0);
  });

  it('P4 无权威/空权威 → 原样返回（静默跳过契约）', () => {
    const input = '污水管网工程阶段投入劳动力约50人。';
    expect(fixPhaseLaborValues(input, undefined).markdown).toBe(input);
    expect(fixPhaseLaborValues(input, []).fixedCount).toBe(0);
  });

  it('P5 阶段名拼接歧义不进确定性修复（留 LLM 修复轮改述）', () => {
    const input = '景观与绿化亮化与收尾工程阶段投入43人。';
    const result = fixPhaseLaborValues(input, [{ phase: '景观与绿化工程', value: 206 }, { phase: '亮化与收尾工程', value: 14 }]);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(input);
  });

  it('P6 枚举列举通道同源修复 + 表格行不触碰', () => {
    const enumerated = fixPhaseLaborValues('各阶段同时在场人数按污水管网工程50人执行。', phaseAuthorities);
    expect(enumerated.fixedCount).toBe(1);
    expect(enumerated.markdown).toContain('污水管网工程35人');
    const tableRow = '| 污水管网工程 | 50人 |';
    expect(fixPhaseLaborValues(tableRow, phaseAuthorities).markdown).toBe(tableRow);
  });
});

describe('equipmentBatchTimingBoundary · Q 组：机械分批台数确定性修复（r17 归因 #B2/B3，写时对齐同源）', () => {
  const equipAuthority = [{ name: '挖掘机', count: 5 }, { name: '自卸汽车', count: 5 }];

  it('Q1 分批矛盾命中：删除 later 批「N 台」数字，检测复检零残留', () => {
    const result = fixEquipmentBatchConflicts('首批进场挖掘机5台、自卸汽车5台，剩余挖掘机5台、自卸汽车5台在第4日至第5日补充进场。', equipAuthority);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('剩余挖掘机、自卸汽车在第4日');
    expect(equipmentBatchConflicts(result.markdown, equipAuthority)).toHaveLength(0);
  });

  it('Q2 幂等：已修复文本（later 批无数值）重放零变更', () => {
    const input = '首批进场挖掘机5台、自卸汽车5台，剩余挖掘机、自卸汽车在第4日至第5日补充进场。';
    const result = fixEquipmentBatchConflicts(input, equipAuthority);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(input);
  });

  it('Q3 组合成立（3+2=5）零动作；无权威/空权威原样返回', () => {
    expect(fixEquipmentBatchConflicts('首批挖掘机3台进场，剩余挖掘机2台进场。', [{ name: '挖掘机', count: 5 }]).fixedCount).toBe(0);
    const input = '首批挖掘机5台进场，剩余挖掘机5台进场。';
    expect(fixEquipmentBatchConflicts(input, undefined).markdown).toBe(input);
    expect(fixEquipmentBatchConflicts(input, []).markdown).toBe(input);
  });

  it('Q4 前缀量词随删除（「剩余挖掘机约5台」→「剩余挖掘机补充进场」）', () => {
    const result = fixEquipmentBatchConflicts('首批挖掘机3台进场，剩余挖掘机约5台补充进场。', [{ name: '挖掘机', count: 5 }]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('剩余挖掘机补充进场');
    expect(result.markdown).not.toContain('约5台');
  });
});
