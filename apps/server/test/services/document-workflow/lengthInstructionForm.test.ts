/**
 * 4.60 I2-b 篇幅**指令形态**（不是系数）——A/B 实测驱动的修正。
 *
 * ## 实测结论（`.dbg/length-ab.mjs`，**直接调 API**，非沿用历史结论）
 *
 * | 长度指令形态 | 中位字数（目标 600） | 中位/目标 | 落在 [0.85,1.15] 窗内 |
 * |---|---|---|---|
 * | 「篇幅约 N 字」（**目标语义**） | 574 | **0.96** | 3/5 |
 * | 「按 k 个要点，每点 N/k 字」（**结构化预算**） | 549 | **0.92** | 4/5 |
 * | 「写完自数并修订」 | 590 | 0.98 | 4/5 |
 * | **「不超过 N 字」（上限语义 —— 生产现行路线）** | **317** | **0.53** | **0/5** |
 * | 不给任何长度指令（对照） | 834 | 1.39 | 0/5 |
 *
 * ## 由此推翻的两条
 *
 * 1. **4.43 的「目标语义零咬合、上限语义唯一有效」不再成立**——那个结论来自旧模型/旧 prompt 形态，
 *    本次现场实测直接推翻：目标语义中位 **0.96**（准），上限语义中位 **0.53**（腰斩）。
 * 2. **`BLOCK_LENGTH_DISPLAY_SCALE = 0.75` 这个系数是错的补偿**——它用"显示值打折"去抵消
 *    「上限语义导致欠产」的副作用。既然模型**按目标语义就能写准**，就该**给对指令**而不是给错指令再乘系数。
 *
 * ## 生产侧佐证（`doc-1790192978315-5e3bbdd6` 块级篇幅账，重试原因分布）
 *
 * ```
 * 欠产 ×6 ｜ 归因量化 ×4 ｜ 超产 ×3 ｜ 数值 ×1 ｜ 结构标题 ×1     （26 块，首轮通过 58%）
 * ```
 * **欠产是最大重试原因**——与 A/B 预测「上限语义→腰斩→欠产」完全吻合，因果链闭合。
 */
import { describe, expect, it } from 'vitest';
import { renderLengthContractLine } from '@/services/document-workflow/chapterGeneration';

describe('4.60 I2-b 篇幅指令形态', () => {
  // ── ① 正向：必须是**目标语义**（实测能让模型写准的形态） ──

  it('正向-1：合同行以目标语义下达（「篇幅约 N 字」），而非仅给上限', () => {
    const line = renderLengthContractLine(600);
    expect(line, 'A/B 实测：目标语义中位 0.96×，上限语义中位 0.53×').toContain('约 600 字');
  });

  it('正向-2：携带**可执行的容差**（实测「±10%」形态中位 0.88×）', () => {
    const line = renderLengthContractLine(600);
    expect(line).toMatch(/±\s*\d+%/u);
  });

  it('正向-3：目标即为真实目标，**不再经系数打折**', () => {
    // 系数是"用显示值补偿模型偏差"的错补偿：模型按指令写，就该给真实数字
    expect(renderLengthContractLine(600)).toContain('600');
    expect(renderLengthContractLine(1234)).toContain('1234');
  });

  // ── ② 反向：防过度（上限仍须保留，但降为极端保护而非主指令） ──

  it('反向-1：**不得**写上限——宽松上限给出漂移空间，反而把产出推高', () => {
    const line = renderLengthContractLine(600);
    // 实机实测（本版首轮）：带「不超过 1.4×」时块产出比中位 1.27×、块目标命中率 25%，
    // 文档超目标 55%——模型把 40% 的"合法余量"当成了可写空间。A/B 里 target 单独用才是 0.90×。
    // 系统仍判 >1.4× 为失败，但阈值不写进指令（"最多可到 1.4 倍"与"目标是 T"互相抵消）。
    expect(line).not.toMatch(/不超过\s*\d+/u);
  });

  it('反向-2：不得出现"控制在 X~Y"这类**下限即上限**的窄窗措辞（那等于把上限当前目标）', () => {
    const line = renderLengthContractLine(600);
    // 旧措辞「控制在 0.85cap~cap 字之间」的窄窗会把模型压到窗底（A/B 实测上限语义腰斩）
    expect(line).not.toMatch(/控制在\s*\d+\s*~\s*\d+\s*字之间/u);
  });

  // ── ③ 边界 ──

  it('边界-1：极小与极大目标不产生非法数值', () => {
    for (const target of [1, 10, 100, 5000]) {
      const line = renderLengthContractLine(target);
      expect(Number.isFinite(target)).toBe(true);
      expect(line).toContain(String(target));
    }
  });

  it('边界-2：上限与目标的比值固定（不随目标大小漂移）', () => {
    const ratioOf = (target: number) => {
      const cap = Number(/不超过\s*(\d+)/u.exec(renderLengthContractLine(target))?.[1] || '0');
      return cap / target;
    };
    expect(Math.abs(ratioOf(600) - ratioOf(3000))).toBeLessThan(0.05);
  });

  // ── ④ 不变 ──

  it('不变-1：仍要求保留章节标题（块外壳契约不变）', () => {
    expect(renderLengthContractLine(600)).toContain('保留章节标题');
  });

  it('不变-2：纯函数（同入同出）', () => {
    expect(renderLengthContractLine(888)).toBe(renderLengthContractLine(888));
  });
});
