/**
 * A4 两可表述唯一化 fixer 扩展单测（4.27.0）：
 * - 基线实测句式表新增（打桩机打入或混凝土基础固定 / 放坡或加设挡板支护 / 放坡或挡板支护）；
 * - supportForm 权威选定侧机制（未命中选定值侧或缺失时取默认侧）；
 * - 残留缺口记录（不静默，不参与 fixedCount 防哑火循环）；幂等。
 */
import { describe, expect, it } from 'vitest';
import { ambiguousEitherOrIssues, fixAmbiguousEitherOrCandidates } from '@/services/document-workflow/documentIntegrityChecks';

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

describe('ambiguousEitherOrIssues C5 连接工艺豁免（安装工法二选一）', () => {
  it('C5-1 正样本：箱体与基础预埋件焊接或螺栓连接 → 豁免（词族「基础」命中构件名非决策对象）', () => {
    // s28l 实机误报：左组「基础预埋件焊接」的「基础」是构件名（非基础形式决策），全句语境为
    // 成品设备与混凝土基础的安装固定工艺（焊接/螺栓连接为现场按底脚形式选配的工法自由度）→
    // 连接工艺二选一豁免；检测端豁免后修复端不产生两可缺口（检测定位=修复定位）
    expect(ambiguousEitherOrIssues('落地安装的AL1、AL3箱体，先施工C20混凝土基础，基础顶面标高按设计确定，箱体与基础预埋件焊接或螺栓连接，柜体垂直度偏差不大于1.5mm/m。')).toEqual([]);
  });
  it('C5-2 反例：真两可决策不受豁免（桩基或独立基础 → 照报）', () => {
    expect(ambiguousEitherOrIssues('基础采用桩基或独立基础，按图纸施工。').length).toBe(1);
  });
  it('C5-3 反例：左组尾非连接工艺词不豁免（放坡或钢板桩 → 照报）', () => {
    expect(ambiguousEitherOrIssues('沟槽开挖采用放坡或钢板桩支护。').length).toBe(1);
  });
  it('C5-4 右组尾缀形态豁免（焊接或铆接固定 → 工艺词+固定尾缀容忍）', () => {
    // 右组贪婪 {2,8} 吞紧邻尾缀「固定」——TERM 容忍工艺词+固定/安装尾缀，防豁免面因尾随字失效
    expect(ambiguousEitherOrIssues('落地安装的AL1、AL3箱体，先施工C20混凝土基础，基础顶面标高按设计确定，箱体与基础预埋件焊接或铆接固定，柜体垂直度偏差不大于1.5mm/m。')).toEqual([]);
  });
});
