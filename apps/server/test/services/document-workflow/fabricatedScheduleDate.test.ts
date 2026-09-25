/**
 * 4.60 I2-c 编造开/竣工日期确定性收口回归。
 *
 * ## 为什么需要确定性修复
 *
 * 「禁止编造具体日期」是写作期硬约束（FORMAL_WRITING_RULES），但实测仍漏网：上一版巢湖正文写出
 * 「开工日期为2026年10月10日」，绑定资料并未提供该日期（招标文件明确「以开工令时间为准」）——
 * 命中终检 `fabricated-start-date` blocker（category=fact_consistency，直接压低「事实完整与一致性」维度）。
 * 该检测器此前 `fixerDisposition: 'manual'`（无存量修复路径），故残留必落门禁。
 *
 * ## 判据与检测端同源
 *
 * 只改「开/竣工日期」语境，且日期**不在可溯源集合**（事实抽取表 ∪ 绑定资料原文）内。
 * 资料里真有的日期一律不动——4.59 巢湖实测「答疑文件落款 2026年08月05日」曾被误判编造，
 * 口径修正后并入资料日期；修复端必须用同一集合，否则修复器会改写检测器认为合法的日期。
 */
import { describe, expect, it } from 'vitest';
import { fixFabricatedScheduleDates } from '@/services/document-workflow/documentIntegrityChecks';

const NO_TRACE = new Set<string>();

describe('fixFabricatedScheduleDates 形态矩阵', () => {
  it('实机同形态：编造开工日期 → 改为招标口径相对表述（保留句子锚点，不整句删除）', () => {
    const result = fixFabricatedScheduleDates('开工日期为2026年10月10日。工期330日历天，自开工令下发之日起算。', NO_TRACE);
    expect(result.markdown).toBe('开工日期以开工令载明时间为准。工期330日历天，自开工令下发之日起算。');
    expect(result.fixedCount).toBe(1);
  });

  it('覆盖形态：计划开工日期：X / 合同竣工日期为 X / 半角冒号', () => {
    const input = '计划开工日期：2026年9月1日；合同竣工日期为2027年7月28日；开工日期: 2026年9月1日。';
    const result = fixFabricatedScheduleDates(input, NO_TRACE);
    expect(result.fixedCount).toBe(3);
    expect(result.markdown).not.toMatch(/(?:19|20)\d{2}\s*年/u);
    expect(result.markdown).toContain('开工日期以开工令载明时间为准');
    expect(result.markdown).toContain('竣工日期以合同约定并经竣工验收确认的时间为准');
  });

  it('不误伤：日期在可溯源集合内（资料/事实表已提供）→ 一字不动', () => {
    const input = '开工日期为2026年10月10日。';
    const traceable = new Set(['2026年10月10日']);
    expect(fixFabricatedScheduleDates(input, traceable)).toEqual({ markdown: input, fixedCount: 0, details: [] });
  });

  it('不误伤：非开/竣工语境的其他日期（招标文件发布、答疑落款、社保条款）一律不动', () => {
    for (const innocent of [
      '招标文件于2026年9月1日发布，答疑澄清文件同日发出。',
      '投标人须提供2025年1月1日（含）以来任意连续三个月社保缴费证明。',
      '本工程执行《建设工程质量管理条例》（国务院令第279号，2019年4月23日修订）。',
      '自2026年9月1日起施行的《危险性较大的分部分项工程专项施工方案严重缺陷清单》',
    ]) {
      expect(fixFabricatedScheduleDates(innocent, NO_TRACE), innocent).toEqual({ markdown: innocent, fixedCount: 0, details: [] });
    }
  });

  it('幂等：已改写文本再跑零命中（链尾重放安全）', () => {
    const once = fixFabricatedScheduleDates('开工日期为2026年10月10日。', NO_TRACE).markdown;
    expect(fixFabricatedScheduleDates(once, NO_TRACE)).toEqual({ markdown: once, fixedCount: 0, details: [] });
  });

  // ─── 真值层权威口径：有权威值时落位权威值（而非改成相对表述） ───

  it('权威口径优先：有真值层生效值时，编造日期改为**权威值**（同时满足 caliber-consistency）', () => {
    // 反例动机：只改成相对表述会命中「真值层生效值未在正文落位」blocker——
    // 实测把 2 条「编造开工日期」修成 1 条「口径不一致」，问题只是换了名字
    const result = fixFabricatedScheduleDates('开工日期为2026年9月1日。', NO_TRACE, { startDate: '2026年10月10日' });
    expect(result.markdown).toBe('开工日期为2026年10月10日。');
    expect(result.fixedCount).toBe(1);
    expect(result.details[0]).toContain('落位权威口径');
  });

  it('权威口径幂等：正文已是权威值时一字不动；竣工日期同理', () => {
    const already = '开工日期为2026年10月10日；竣工日期为2027年8月8日。';
    expect(fixFabricatedScheduleDates(already, NO_TRACE, { startDate: '2026年10月10日', completionDate: '2027年8月8日' }))
      .toEqual({ markdown: already, fixedCount: 0, details: [] });
    const wrong = fixFabricatedScheduleDates(already, NO_TRACE, { startDate: '2026年10月10日', completionDate: '2027年9月9日' });
    expect(wrong.fixedCount).toBe(1);
    expect(wrong.markdown).toContain('竣工日期为2027年9月9日');
  });
});

describe('4.61 日期槽位写了非日期（实机缺陷：把工期当开工日期）', () => {
  it('「计划开工日期为330日历天」→ 落位权威日期（旧实现只匹配「日期为日期」，此形态漏网）', () => {
    const result = fixFabricatedScheduleDates('计划开工日期为330日历天，具体开工日期以招标人出具的书面开工通知为准。', NO_TRACE, { startDate: '2026年10月10日' });
    expect(result.markdown).toContain('开工日期为2026年10月10日');
    expect(result.markdown).toContain('具体开工日期以招标人出具的书面开工通知为准');
    expect(result.fixedCount).toBe(1);
  });

  it('「开工日期以…为准」这类合法相对表述**不得**被改写（分隔符为/是/：是必需项）', () => {
    const innocent = '开工日期以招标人出具的书面开工通知为准，竣工日期以竣工验收合格之日为准。';
    expect(fixFabricatedScheduleDates(innocent, NO_TRACE, { startDate: '2026年10月10日' }))
      .toEqual({ markdown: innocent, fixedCount: 0, details: [] });
  });

  it('无权威值时，非日期内容不动（只处理"日期槽位写了日期"的编造形态）', () => {
    const input = '计划开工日期为330日历天。';
    expect(fixFabricatedScheduleDates(input, NO_TRACE)).toEqual({ markdown: input, fixedCount: 0, details: [] });
  });

  it('已是权威值 → 幂等不动', () => {
    const input = '计划开工日期为2026年10月10日，具体开工日期以书面通知为准。';
    expect(fixFabricatedScheduleDates(input, NO_TRACE, { startDate: '2026年10月10日' }).fixedCount).toBe(0);
  });
});

describe('4.61 日期槽位无分隔符形态（实测缺陷）', () => {
  it('「计划开工日期330日历天」——无「为/是/：」但后随数字 → 落位权威值', () => {
    const result = fixFabricatedScheduleDates('总工期330日历天（计划开工日期330日历天，具体开工日期以招标人出具的书面开工通知为准），涵盖1#厂房。', NO_TRACE, { startDate: '2026年10月10日' });
    expect(result.markdown).toContain('开工日期为2026年10月10日');
    expect(result.markdown, '合法的相对表述不得被改写').toContain('具体开工日期以招标人出具的书面开工通知为准');
    expect(result.fixedCount).toBe(1);
  });

  it('无分隔符但后随非数字 → 不命中（「开工日期以…为准」是合法相对表述）', () => {
    const innocent = '开工日期以招标人出具的书面开工通知为准。';
    expect(fixFabricatedScheduleDates(innocent, NO_TRACE, { startDate: '2026年10月10日' })).toEqual({ markdown: innocent, fixedCount: 0, details: [] });
  });

  it('无分隔符且是日期形态 → 同样落位权威值', () => {
    const result = fixFabricatedScheduleDates('计划开工日期2026年08月31日实施。', NO_TRACE, { startDate: '2026年10月10日' });
    expect(result.markdown).toContain('开工日期为2026年10月10日');
  });
});
