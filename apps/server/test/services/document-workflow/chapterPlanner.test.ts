/**
 * chapterPlanner 单测：fallbackStructureForSections 块目标字数分配（4.12.17）。
 * 历史缺陷：fallback 路径按 ceil(细目数/6) 预估块数把单块目标虚高到 4000（章 8333 字时），
 * 块质检 0.5×目标=2000 字卡在模型单块自然输出（1600~2000 字）上方，实测 4/6 章大面积块判失败
 * → 整章紧凑降级 → 全文字数雪崩；修复后与 LLM 规划路径同口径加权分配 + 目标驱动拆块。
 */
import { describe, expect, it } from 'vitest';
import { fallbackStructureForSections } from '@/services/document-workflow/chapterPlanner';

describe('fallbackStructureForSections 块目标分配（4.12.17）', () => {
  it('7 条细目 4 域、章目标 8333：块目标按块数加权分配而非全部虚高 4000', () => {
    const sections = [
      '施工安全管理体系',
      '危大工程管控措施',
      '三检制度与质量验收',
      '样板引路与实测实量',
      '进度计划与工期保障',
      '组织机构与岗位职责',
      '人员管理与劳务实名制',
    ];
    const structure = fallbackStructureForSections(sections, '测试章', 8333);
    expect(structure.blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of structure.blocks) {
      // 修复前每块一律 4000（阈值 2000 卡死自然输出）；修复后按块数/点数加权，单块目标显著低于 4000
      expect(block.targetWords).toBeLessThanOrEqual(3000);
      expect(block.targetWords).toBeGreaterThanOrEqual(1200);
      // 0.4 质检阈值下，模型自然输出（≥1600 字）应能通过：0.4×目标 ≤ 1200
      expect(Math.floor(block.targetWords * 0.4)).toBeLessThanOrEqual(1200);
    }
    // 块目标总和应承接章目标量级（加权后不丢失篇幅预算）
    const total = structure.blocks.reduce((sum, block) => sum + block.targetWords, 0);
    expect(total).toBeGreaterThanOrEqual(5000);
  });

  it('3 条细目同域、章目标 8333：目标驱动拆块为 3 块，单块目标不虚高', () => {
    const sections = ['三检制度落实', '隐蔽工程验收', '质量通病防治'];
    const structure = fallbackStructureForSections(sections, '测试章', 8333);
    // 1 块装不下 8333 字（上限 4000）→ 拆成 3 块（1 点/块）
    expect(structure.blocks.length).toBe(3);
    for (const block of structure.blocks) {
      expect(block.targetWords).toBeLessThanOrEqual(3000);
      expect(block.targetWords).toBeGreaterThanOrEqual(1200);
    }
  });

  it('2 条细目 2 域、章目标 8333：无法再拆时单块目标封顶 4000，0.4 阈值 1600 放行自然输出', () => {
    const sections = ['智慧工地基本级实施', '绿色施工与扬尘控制'];
    const structure = fallbackStructureForSections(sections, '测试章', 8333);
    expect(structure.blocks.length).toBe(2);
    for (const block of structure.blocks) {
      expect(block.targetWords).toBe(4000);
      // 0.4 阈值 1600 字：模型自然输出 1600~2000 字可通过（0.5 阈值 2000 曾卡死）
      expect(Math.floor(block.targetWords * 0.4)).toBe(1600);
    }
  });
});

describe('fallbackStructureForSections 人材机三小节独立成块（h16）', () => {
  it('人/材/机保障体系三节各自独立成块（H3），不被同域 bigram 合并吞并', () => {
    const sections = [
      '确保人的保障体系与措施',
      '确保材的保障体系与措施',
      '确保机的保障体系与措施',
      '劳动力配置计划与高峰期人数安排',
    ];
    const structure = fallbackStructureForSections(sections, '确保人、材、机的保障体系与措施', 6000);
    // 三节同落「综合管理」域且 bigram 重叠 ≥0.75，修复前被合并成单块；修复后 3 个独立块 + 非标准小节块
    const triadBlocks = structure.blocks.filter(block => /^确保[人材机](?:员|力|料|械|工)?的保障体系与措施$/u.test(block.title));
    expect(triadBlocks.length).toBe(3);
    for (const block of triadBlocks) {
      expect(block.subPoints.length).toBe(1);
      expect(block.subPoints[0].title).toBe(block.title);
    }
  });

  it('非资源三小节章不受影响：同域可合并细目保持原行为', () => {
    const structure = fallbackStructureForSections(['三检制度落实', '隐蔽工程验收'], '测试章', 2400);
    expect(structure.blocks.length).toBeGreaterThanOrEqual(1);
  });
});
