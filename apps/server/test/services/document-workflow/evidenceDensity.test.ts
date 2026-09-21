/**
 * G 线 P1-14 生成前「证据密度体检」。
 *
 * 缺陷背景：资料只够写 3 万字却把目标定成 14 万字时，系统此前**照常开写**——
 * 结果是篇幅注水、无依据的正文（正是「降级交付」）。本体检在**写作之前**估算
 * 「资料能支撑的字数**下界**」，低于目标即明确失败并给出差额与补料清单。
 *
 * 口径必须是**下界**：这是一道前置硬失败，估高的代价是把本来能交付的项目挡在门外，
 * 估低只是少拦一次（由后续质检兜底）——故宁可放过，不可误伤。
 */
import { describe, expect, it } from 'vitest';
import { assessEvidenceDensity, EVIDENCE_DENSITY_MIN_RATIO, EVIDENCE_DENSITY_WEIGHTS } from '@/services/document-workflow/budget';

describe('assessEvidenceDensity 证据密度体检', () => {
  it('资料充足：可支撑字数下界高于目标 ⇒ 通过、无补料清单', () => {
    const result = assessEvidenceDensity({ targetWords: 100000, parameters: 800, boqRows: 1200, drawingFacts: 200, basicFacts: 300 });
    expect(result.supportableWords).toBeGreaterThanOrEqual(100000);
    expect(result.sufficient).toBe(true);
    expect(result.remediation).toEqual([]);
    expect(result.shortfall).toBeLessThanOrEqual(0);
  });

  it('资料不足：下界远低于目标 ⇒ 失败并给出差额与补料清单', () => {
    const result = assessEvidenceDensity({ targetWords: 140000, parameters: 50, boqRows: 0, drawingFacts: 0, basicFacts: 20 });
    expect(result.sufficient).toBe(false);
    // 差额=目标−可支撑（正数）
    expect(result.shortfall).toBeGreaterThan(0);
    // 补料清单必须可操作：给出差额、逐源计数、补料方向、以及「下调目标」的替代路径
    const text = result.remediation.join(' ');
    expect(text).toContain('差额约');
    expect(text).toContain('量化参数 50 个');
    expect(text).toContain('补充工程量清单');
    expect(text).toContain('下调目标字数');
  });

  it('20% 容差生效：恰好等于目标 80% 时判通过（估算不确定度内的保守放过）', () => {
    const w = EVIDENCE_DENSITY_WEIGHTS;
    // 构造 supportable = target × 0.8 的输入
    const target = 100000;
    const need = target * EVIDENCE_DENSITY_MIN_RATIO;
    const parameters = Math.round(need / w.parameter);
    const result = assessEvidenceDensity({ targetWords: target, parameters, boqRows: 0, drawingFacts: 0, basicFacts: 0 });
    expect(result.sufficient).toBe(true);
  });

  it('零目标字数不判失败（未指定篇幅时不作前置阻断）', () => {
    const result = assessEvidenceDensity({ targetWords: 0, parameters: 0, boqRows: 0, drawingFacts: 0, basicFacts: 0 });
    expect(result.sufficient).toBe(true);
  });

  it('各来源按权重计入（清单行权重低于量化参数，计数可审计）', () => {
    const w = EVIDENCE_DENSITY_WEIGHTS;
    const result = assessEvidenceDensity({ targetWords: 1, parameters: 3, boqRows: 5, drawingFacts: 7, basicFacts: 11 });
    expect(result.supportableWords).toBe(3 * w.parameter + 5 * w.boqRow + 7 * w.drawingFact + 11 * w.basicFact);
    expect(result.sources).toEqual({ parameters: 3, boqRows: 5, drawingFacts: 7, basicFacts: 11 });
  });
});
