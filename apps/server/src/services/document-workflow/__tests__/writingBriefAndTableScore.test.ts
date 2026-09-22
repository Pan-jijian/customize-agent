/**
 * 两处口径修复的防回归：
 * 1. 安全目标进写作焦点规则（此前质量目标有要求、安全目标无要求 → 实测整篇 0 处，评标响应度 4/5 唯一缺项）
 * 2. 表格评分遵守写时红线的两条 `—` 例外（规格型号列无型号 / 合计行）
 */
import { describe, expect, it } from 'vitest';
import { chapterFocusRule } from '@/services/document-workflow/documentWritingTaskBrief';
import { WRITING_INTEGRITY_CONSTRAINTS } from '@/services/document-workflow/documentWritingTaskBrief';
import { countIncompleteTableCells } from '@/services/document-workflow/documentProfessionalScore';
import { QUANTIFIED_TARGET_RE } from '@/services/document-workflow/tenderBidChecks';

describe('重难点「归因+量化」要求与检测正则同源', () => {
  it('要求里的示例必须都能被 QUANTIFIED_TARGET_RE 命中（否则写了也不算达标）', () => {
    // 与 requirement 文本中给出的示例逐条对应
    for (const example of ['开挖深度不超过 3m', '每 200m 划分一段', '压实度不低于 95%', '巡检 1 次日', '导行通道宽度不小于 4m']) {
      expect(QUANTIFIED_TARGET_RE.test(example)).toBe(true);
    }
  });

  it('纯定性表述确实不达标（证明这条要求有实际约束力）', () => {
    for (const vague of ['雨季管网沟槽开挖易塌方、积水', '分段开挖、快速回填，沟槽边坡按土质放坡并做好排水']) {
      expect(QUANTIFIED_TARGET_RE.test(vague)).toBe(false);
    }
  });

  it('概况章与重难点章的焦点规则都带该要求（重难点内容两章都可能承载）', () => {
    const requirement = (title: string) => chapterFocusRule(title)!.mustCover.join('\n').includes('量化控制目标');
    expect(requirement('工程概况')).toBe(true);
    expect(requirement('工程重点难点及危大工程的保障体系与措施')).toBe(true);
  });
});

describe('安全章写作焦点规则', () => {
  it('安全章必须要求写出「安全目标」且含量化控制指标', () => {
    const rule = chapterFocusRule('确保安全生产的技术组织措施');
    expect(rule).toBeDefined();
    const target = rule!.mustCover.find(item => item.includes('安全目标'));
    expect(target).toBeDefined();
    expect(target).toContain('量化');
    // 与质量章同构（质量章要求「质量目标与验收依据」）——评标响应度五项承诺语境口径对称
    expect(chapterFocusRule('确保工程质量的技术组织措施')!.mustCover.some(item => item.includes('质量目标'))).toBe(true);
  });

  it('安全章原有要求不被覆盖（危大/临时用电/应急预案仍在）', () => {
    const must = chapterFocusRule('确保安全生产的技术组织措施')!.mustCover.join('\n');
    expect(must).toContain('危大工程辨识清单');
    expect(must).toContain('三级配电两级保护');
    expect(must).toContain('应急预案与应急演练');
  });
});

describe('表格不完整单元格计数 · 写时红线例外口径', () => {
  const table = (...rows: string[]) => rows;

  // 4.55.22 用户红线：取消规格型号列的「—」豁免——评分必须与阻断层同口径，
  // 否则出现「闸门阻断 + 表格完整度 100」的自相矛盾报告；写时红线同步已改为要求写具体型号。
  it('规格型号列的「—」计为不完整（与阻断层同口径，写时红线已不再允许）', () => {
    const cells = countIncompleteTableCells(table(
      '| 机械名称 | 规格型号 | 数量 |',
      '| --- | --- | --- |',
      '| 挖掘机 | 0.6~1.0m³ | 5台 |',
      '| 蛙式打夯机 | — | 5台 |',
      '| 洒水车 | — | 5台 |',
    ));
    expect(cells).toBe(2);
  });

  it('合计行的「—」不计为不完整（该列无可加总明细）', () => {
    const cells = countIncompleteTableCells(table(
      '| 分项 | 工程量 | 单价 | 合价 |',
      '| --- | --- | --- | --- |',
      '| 土方 | 100 | 20 | 2000 |',
      '| 合计 | 100 | — | 2000 |',
    ));
    expect(cells).toBe(0);
  });

  it('非规格型号列的「—」仍计为不完整（例外不得被泛化）', () => {
    const cells = countIncompleteTableCells(table(
      '| 工序 | 控制指标 | 责任人 |',
      '| --- | --- | --- |',
      '| 开挖 | — | 施工员 |',
      '| 回填 | 压实度≥95% | 质检员 |',
    ));
    expect(cells).toBe(1);
  });

  it('合计行之外的空白单元格仍计为不完整', () => {
    const cells = countIncompleteTableCells(table(
      '| 项目 | 数值 |',
      '| --- | --- |',
      '| 甲 | 1 |',
      '| 乙 |  |',
    ));
    expect(cells).toBe(1);
  });

  it('表头行与分隔行不参与计数（仅数据行）', () => {
    const cells = countIncompleteTableCells(table(
      '| --- | --- |',
      '| --- | --- |',
      '| A | 1 |',
    ));
    expect(cells).toBe(0);
  });
});

describe('写时红线与评分器口径同源', () => {
  it('红线里确实写着这两条例外（评分器豁免的依据可追溯）', () => {
    const redline = WRITING_INTEGRITY_CONSTRAINTS.find(item => item.includes('表格规范红线'));
    expect(redline).toBeDefined();
    expect(redline).toContain('规格型号列');
    expect(redline).toContain('合计行');
  });
});
