/**
 * 4.60 I2 块级篇幅显示校准系数（**用无偏数据重标定**）。
 *
 * ## 实测依据（`doc-1790188130107-5e94ff6e` 块级篇幅账，32 块**含首轮直通者**）
 *
 * ```
 * 实际/目标 中位 0.85；块目标命中率 34%；首轮通过率 34%
 * ```
 *
 * 即 s=0.75 时产出中位 **0.85×真实目标**——**正好压在达标区 [0.85,1.15] 的下沿**，
 * 于是约 2/3 的块落在窗外必然重试。
 *
 * ## 为什么必须用无偏数据
 *
 * v13 当年定 s=0.75 用的是**失败样本**（日志里只有被判欠产/超产的块留痕，干净通过的块不留痕），
 * 中位被拉低到 0.70 → "证明" 0.75 合适——**这是自我实现**（把门线调到恰好一半块过不了）。
 * 本仓现在有 `blockLedger`（无条件记录每一块），故本次定标基于无偏分布。
 *
 * ## 反解
 *
 * 产出 ≈ 1.13 × cap = 1.13 × s × T；落在窗中心（1.0×T）需 s ≈ 0.885，取 **0.9**。
 */
import { describe, expect, it } from 'vitest';
import { BLOCK_LENGTH_DISPLAY_SCALE, displayWordCap, renderLengthContractLine } from '@/services/document-workflow/chapterGeneration';

/** 达标区（与块质检同源的口径：[0.85, 1.15]×块目标） */
const ACCEPT_LOW = 0.85;
const ACCEPT_HIGH = 1.15;
/** 模型对被展示上限的执行偏差（4.43 实验链：对绝对字数无计数能力、只对上限有反应） */
const MODEL_EXECUTION_FACTOR = 1.13;

describe('4.60 I2 块级篇幅显示校准系数', () => {
  // ───────────────── ① 正向：系数应把产出中位带进达标区 ─────────────────

  it('正向-1：系数使预期产出落在达标区 [0.85,1.15] 内', () => {
    const expected = BLOCK_LENGTH_DISPLAY_SCALE * MODEL_EXECUTION_FACTOR;
    expect(expected, `系数 ${BLOCK_LENGTH_DISPLAY_SCALE} 的预期产出 ${expected.toFixed(3)}×T 低于达标区下沿`).toBeGreaterThanOrEqual(ACCEPT_LOW);
    expect(expected, `预期产出 ${expected.toFixed(3)}×T 高于达标区上沿`).toBeLessThanOrEqual(ACCEPT_HIGH);
  });

  it('正向-2：系数显著高于 v13 的 0.75（0.75 的预期产出 0.85×T 正好压在下沿）', () => {
    expect(BLOCK_LENGTH_DISPLAY_SCALE).toBeGreaterThan(0.75);
    // 反证：0.75 的预期产出正好是达标区下沿 —— 约一半块落在窗外
    expect(0.75 * MODEL_EXECUTION_FACTOR).toBeCloseTo(ACCEPT_LOW, 2);
  });

  // ───────────────── ② 反向：防过度（不得把产出推过上限区） ─────────────────

  it('反向-1：系数不得大到让预期产出超出达标区上沿', () => {
    // 反解上界：s ≤ 1.15/1.13 ≈ 1.018；留余量断言 ≤1.05
    expect(BLOCK_LENGTH_DISPLAY_SCALE).toBeLessThanOrEqual(1.05);
  });

  it('反向-2：**严重超产仍必须失败**——系数不改变超产侧判定（超产线仍由 1.15/1.4 承担）', () => {
    const contract = renderLengthContractLine(1020);
    expect(contract).toContain('超出即不合格');
    // 合同行给出的上限即 displayWordCap，模型超出它仍会触发超产阻断（判定在别处，此处只锁措辞不变）
    expect(contract).toContain(String(displayWordCap(1020)));
  });

  // ───────────────── ③ 边界 ─────────────────

  it('边界-1：displayWordCap 换算与取整', () => {
    expect(displayWordCap(1020)).toBe(Math.round(1020 * BLOCK_LENGTH_DISPLAY_SCALE));
    expect(displayWordCap(0)).toBe(1);
    expect(displayWordCap(-100)).toBe(1);
  });

  it('边界-2：合同行的下限为上限的 0.85×（与达标区同源）', () => {
    const cap = displayWordCap(1020);
    const contract = renderLengthContractLine(1020);
    expect(contract).toContain(`${Math.round(cap * 0.85)}~${cap}`);
  });

  it('边界-3：极小/极大目标不产生非法数值', () => {
    for (const target of [1, 10, 100, 100000]) {
      const cap = displayWordCap(target);
      expect(Number.isFinite(cap)).toBe(true);
      expect(cap).toBeGreaterThanOrEqual(1);
      expect(renderLengthContractLine(target)).toContain('不超过');
    }
  });

  // ───────────────── ④ 不变 ─────────────────

  it('不变-1：合同行仍保留「保留章节标题」与上限语义（4.43 上限语义是唯一有效指令）', () => {
    const contract = renderLengthContractLine(500);
    expect(contract).toContain('保留章节标题');
    expect(contract).toContain('不超过');
  });

  it('不变-2：换算是纯函数（同入同出）', () => {
    expect(displayWordCap(888)).toBe(displayWordCap(888));
    expect(renderLengthContractLine(888)).toBe(renderLengthContractLine(888));
  });
});
