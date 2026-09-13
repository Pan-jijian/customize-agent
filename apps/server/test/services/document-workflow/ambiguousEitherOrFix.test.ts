/**
 * A4 两可表述唯一化 fixer 扩展单测（4.27.0）：
 * - 基线实测句式表新增（打桩机打入或混凝土基础固定 / 放坡或加设挡板支护 / 放坡或挡板支护）；
 * - supportForm 权威选定侧机制（未命中选定值侧或缺失时取默认侧）；
 * - 残留缺口记录（不静默，不参与 fixedCount 防哑火循环）；幂等。
 */
import { describe, expect, it } from 'vitest';
import { fixAmbiguousEitherOrCandidates } from '@/services/document-workflow/documentIntegrityChecks';

describe('fixAmbiguousEitherOrCandidates A4 基线句式扩展', () => {
  it('打桩机打入或混凝土基础固定 → 打桩机打入（无权威默认侧）', () => {
    const result = fixAmbiguousEitherOrCandidates('波形梁护栏立柱采用打桩机打入或混凝土基础固定。');
    expect(result.markdown).toBe('波形梁护栏立柱采用打桩机打入。');
    expect(result.fixedCount).toBe(1);
  });

  it('放坡或加设挡板支护 → 放坡支护（1:0.5 坡率锚定放坡侧）', () => {
    const result = fixAmbiguousEitherOrCandidates('沟槽开挖采用放坡或加设挡板支护。');
    expect(result.markdown).toBe('沟槽开挖采用放坡支护。');
    expect(result.fixedCount).toBe(1);
  });

  it('放坡或挡板支护（表格形态）→ 放坡支护', () => {
    const result = fixAmbiguousEitherOrCandidates('| 沟槽开挖 | 放坡或挡板支护 |');
    expect(result.markdown).toBe('| 沟槽开挖 | 放坡支护 |');
  });

  it('supportForm=钢板桩 → 沟槽支护归一到挡板侧', () => {
    const result = fixAmbiguousEitherOrCandidates('沟槽开挖采用放坡或加设挡板支护。', { supportForm: '钢板桩' });
    expect(result.markdown).toBe('沟槽开挖采用挡板支护。');
  });

  it('supportForm=放坡（未命中选定值侧）→ 取默认侧放坡支护', () => {
    const result = fixAmbiguousEitherOrCandidates('沟槽开挖采用放坡或加设挡板支护。', { supportForm: '放坡' });
    expect(result.markdown).toBe('沟槽开挖采用放坡支护。');
  });

  it('残留句式缺口记录（句式表未覆盖的悬置形态不静默）', () => {
    const result = fixAmbiguousEitherOrCandidates('沟槽开挖采用放坡或加设挡板支护。基础采用桩基（或独立基础按图纸实施）。', {});
    expect(result.fixedCount).toBe(1);
    expect(result.details.some(detail => detail.includes('两可表述缺口待复核'))).toBe(true);
  });

  it('幂等：修复后重跑零命中且不再记录缺口', () => {
    const first = fixAmbiguousEitherOrCandidates('沟槽开挖采用放坡或加设挡板支护。');
    const second = fixAmbiguousEitherOrCandidates(first.markdown);
    expect(second.fixedCount).toBe(0);
    expect(second.markdown).toBe(first.markdown);
    expect(second.details).toEqual([]);
  });
});
