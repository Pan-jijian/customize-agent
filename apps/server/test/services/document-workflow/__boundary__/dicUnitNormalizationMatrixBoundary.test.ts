/**
 * 边界矩阵（P1 第 32 批 · RR 组 · 厚度修复谱系 + 单位变体归一矩阵）
 * 断言按探测锁定的真实行为推导。
 *  - R1 fixFinishThickness：≥100 的 mm 值 ÷10 修正（999→100 四舍五入、99 不匹配）
 *  - R2 单位变体归一：UNIT_GROUPS 五组全变体 × 清单量校正（大写/中文/符号互认）
 */
import { describe, expect, it } from 'vitest';
import { fixFinishThickness, fixQuantityAuthorityConflicts } from '@/services/document-workflow/documentIntegrityChecks';

// ── R1. 装饰厚度修复：数值谱系（≥100 → ÷10） ──

const R1_TABLE: Array<{ x: string; fixed: number; result: string }> = [
  { x: '99', fixed: 0, result: '找平层厚度99mm。' },
  { x: '100', fixed: 1, result: '找平层厚度10mm。' },
  { x: '180', fixed: 1, result: '找平层厚度18mm。' },
  { x: '1800', fixed: 1, result: '找平层厚度180mm。' },
  { x: '999', fixed: 1, result: '找平层厚度100mm。' },
  { x: '1000', fixed: 1, result: '找平层厚度100mm。' },
  { x: '18000', fixed: 1, result: '找平层厚度1800mm。' },
];

describe('R1 装饰厚度修复：≥100 数值 ÷10 谱系', () => {
  it.each(R1_TABLE)('R1 「找平层厚度$x mm」→ fixedCount $fixed、$result', ({ x, fixed, result }) => {
    const r = fixFinishThickness(`找平层厚度${x}mm。`);
    expect(r.fixedCount).toBe(fixed);
    expect(r.markdown).toBe(result);
  });
  it('R1 后置形态：「1800mm厚找平层」→ 180mm', () => {
    const r = fixFinishThickness('1800mm厚找平层。');
    expect(r.fixedCount).toBe(1);
    expect(r.markdown).toContain('180mm厚找平层');
  });
});

// ── R2. 单位变体归一：UNIT_GROUPS 五组 × 清单量校正 ──

const UNIT_MATRIX: Array<{ v: string; unit: string }> = [
  // 面积组
  { v: '50㎡', unit: 'm²' },
  { v: '50m²', unit: 'm²' },
  { v: '50m2', unit: 'm²' },
  { v: '50M2', unit: 'm²' },
  // 体积组
  { v: '50m³', unit: 'm³' },
  { v: '50m3', unit: 'm³' },
  { v: '50M3', unit: 'm³' },
  // 重量组
  { v: '50t', unit: 't' },
  { v: '50吨', unit: 't' },
  { v: '50T', unit: 't' },
  // 长度组
  { v: '50m', unit: 'm' },
  { v: '50M', unit: 'm' },
  // 数量组
  { v: '50座', unit: '座' },
  { v: '50套', unit: '套' },
  { v: '50台', unit: '台' },
  { v: '50个', unit: '个' },
  { v: '50项', unit: '项' },
  { v: '50处', unit: '处' },
  { v: '50樘', unit: '樘' },
  { v: '50株', unit: '株' },
  { v: '50系统', unit: '系统' },
];

describe('R2 单位变体归一：同物理口径不同写法互认', () => {
  it.each(UNIT_MATRIX)('R2 正文「$v」vs 清单单位「$unit」→ 归一匹配 → 修复 100', ({ v, unit }) => {
    const r = fixQuantityAuthorityConflicts(`C.1项铺装 ${v}。`, [{ name: 'C.1项铺装', value: 100, unit }]);
    expect(r.fixedCount).toBe(1);
    expect(r.markdown).toContain('100');
  });
});
