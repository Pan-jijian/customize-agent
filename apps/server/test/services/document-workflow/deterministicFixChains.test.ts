/**
 * 确定性修复链注册表顺序锁死单测（第 1 期 P10）：
 * stage5 逐章链与 round-2 全文链的顺序即修复执行顺序，顺序漂移会改变「修复器互相引入
 * 问题」的收敛路径；此处以 key 序列快照锁死两条链的过滤结果。
 */
import { describe, expect, it } from 'vitest';
import { SURFACE_FIX_STEPS, stage5FixSteps, round2FixSteps } from '../../../src/services/document-workflow/deterministicFixChains';

describe('SURFACE_FIX_STEPS 链顺序锁死（P10 单源）', () => {
  it('注册键唯一且无空修复函数', () => {
    const keys = SURFACE_FIX_STEPS.map(step => step.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const step of SURFACE_FIX_STEPS) expect(typeof step.fix).toBe('function');
  });

  it('每条链至少被 stage5 或 round2 消费（无孤儿修复器）', () => {
    for (const step of SURFACE_FIX_STEPS) expect(step.stage5 || step.round2).toBe(true);
  });

  it('stage5 逐章链顺序与原硬编码清单一致', () => {
    expect(stage5FixSteps().map(step => step.key)).toEqual([
      'table-line-residue',
      'templated-labels',
      // V2 批1 结构完整性确定性清理（与检测器 structure-integrity 同源单扫描）
      'structure-integrity',
      'repeated-words',
      'finish-thickness',
      'labor-peak',
      // V5 P4b-2 阶段劳动力确定性回写（与检测器 phase-labor-mixing 同源双通道扫描）
      'phase-labor-values',
      'resource-breakdown',
      'internal-table-row-dup',
      'greening-maintenance',
      'paragraph-opening-repeat',
      'paragraph-tail-repeat',
      'collision-numbered-heading',
      'inverted-date-range',
      'truncated-sentence',
      'meta-discourse',
      'formula-residue',
      'self-undermining',
      'ambiguous-either-or',
      'empty-scoring-response',
      // 4.27.2 招标元语言清理 + 重复响应行去重（紧随空响应句改写，条幅剥离后重复判定同帧）
      'tender-meta-language',
      'duplicate-response-line',
      'atlas-reference',
    ]);
  });

  it('round-2 全文链顺序与原硬编码清单一致', () => {
    expect(round2FixSteps().map(step => step.key)).toEqual([
      'table-line-residue',
      'templated-labels',
      // V2 批1 结构完整性确定性清理（与检测器 structure-integrity 同源单扫描）
      'structure-integrity',
      'repeated-words',
      'duplicate-tables',
      'finish-thickness',
      'labor-peak',
      // V5 P4b-2 阶段劳动力确定性回写（与检测器 phase-labor-mixing 同源双通道扫描）
      'phase-labor-values',
      'resource-breakdown',
      'internal-table-row-dup',
      'greening-maintenance',
      'paragraph-opening-repeat',
      'paragraph-tail-repeat',
      'collision-numbered-heading',
      'inverted-date-range',
      'truncated-sentence',
      'meta-discourse',
      'formula-residue',
      'self-undermining',
      'ambiguous-either-or',
      'empty-scoring-response',
      // 4.27.2 招标元语言清理 + 重复响应行去重
      'tender-meta-language',
      'duplicate-response-line',
      'tertiary-h4-dedupe',
      'internal-term-heading',
      // WS4 骨架指纹确定性兜底（round-2 链末尾、终检前最后一道）
      'skeleton-fingerprint-variants',
      // WS3 工序形式确定性兜底（相邻同形式轮换转换清零）
      'flow-form-variants',
      // WS1 残缺标题确定性补全（正文取证补全 <4 字残缺标题）
      'truncated-title-completion',
      // 4.27.2 句化标题切分（标题合并治理 · round-2 链最后：标题还原规划标题+续写句转正文）
      'sentence-like-heading-split',
    ]);
  });
});
