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
      // r28h 行内嵌标题拆行（s28h2 实测：正文行尾粘连章/节标题致结构误判；拆出编号由链尾 section-renumber 重放）
      'embedded-heading-split',
      'repeated-words',
      'finish-thickness',
      // 4.31 显式快照变更（丰乐镇 v6 #3/#70/#86-87/#90/#71 五类误报修复器接入链，
      // 均与锚定检测器同源；顺序约束：槽位数值紧随 finish-thickness、基础表/兜底行紧随
      // table 修复族、标题覆盖紧随 collision-numbered-heading、法规补写紧随元语言清理）
      'slot-depth-value',
      // r17 丰乐镇归因 #B1：规格-数值绑定错位原位替换（与检测器 fact-reconciliation D4.2 同源）
      'spec-quantity-binding',
      'labor-peak',
      // V5 P4b-2 阶段劳动力确定性回写（与检测器 phase-labor-mixing 同源双通道扫描）
      'phase-labor-values',
      'resource-breakdown',
      // r17 丰乐镇归因 #B2/B3：机械分批台数矛盾删除 later 批数字（与检测器 equipment-batch-conflict 同源）
      'equipment-batch-values',
      'internal-table-row-dup',
      'duplicate-basic-info-tables',
      'fallback-placeholder-rows',
      'greening-maintenance',
      'paragraph-opening-repeat',
      'paragraph-tail-repeat',
      'collision-numbered-heading',
      'heading-uncovered-items',
      'inverted-date-range',
      // r28j 同日零长区间修复（M15：锚定 cross-chapter-consistency「同日起止区间校验」，紧随区间族）
      'zero-length-date-range',
      'truncated-sentence',
      'meta-discourse',
      'formula-residue',
      'self-undermining',
      'ambiguous-either-or',
      // 4.27.2 招标元语言清理 + 重复响应行去重（条幅剥离后重复判定同帧）
      'tender-meta-language',
      // 4.32 配置禁用词清洗（丰乐镇 v6 #59）
      'forbidden-configuration',
      'duplicate-response-line',
      'atlas-reference',
      // 4.31 internal-term-heading 启用 stage5（丰乐镇 v6 #66/#88 表格行替换）
      'internal-term-heading',
      // 4.40 d5d 同章同名 H3 小节确定性合并（与检测器 heading-duplicate 同源）：紧随其后 section-renumber 编号重放
      'heading-duplicate-merge',
      // 4.36 A2 小节编号重放（结构事务化 · 编号不变量 INV-1：链尾原子重放，清洗层删 H3 行后的编号空档在此收敛）
      'section-renumber',
    ]);
  });

  it('round-2 全文链顺序与原硬编码清单一致', () => {
    expect(round2FixSteps().map(step => step.key)).toEqual([
      'table-line-residue',
      'templated-labels',
      // V2 批1 结构完整性确定性清理（与检测器 structure-integrity 同源单扫描）
      'structure-integrity',
      // r28h 行内嵌标题拆行（s28h2 实测：正文行尾粘连章/节标题致结构误判；拆出编号由链尾 section-renumber 重放）
      'embedded-heading-split',
      'repeated-words',
      'duplicate-tables',
      'finish-thickness',
      // 4.31 显式快照变更（同 stage5 链五类修复器：丰乐镇 v6 #3/#70/#86-87/#90/#71）
      'slot-depth-value',
      // r17 丰乐镇归因 #B1：规格-数值绑定错位原位替换（与检测器 fact-reconciliation D4.2 同源）
      'spec-quantity-binding',
      'labor-peak',
      // V5 P4b-2 阶段劳动力确定性回写（与检测器 phase-labor-mixing 同源双通道扫描）
      'phase-labor-values',
      'resource-breakdown',
      // r17 丰乐镇归因 #B2/B3：机械分批台数矛盾删除 later 批数字（与检测器 equipment-batch-conflict 同源）
      'equipment-batch-values',
      'internal-table-row-dup',
      'duplicate-basic-info-tables',
      'fallback-placeholder-rows',
      'greening-maintenance',
      'paragraph-opening-repeat',
      'paragraph-tail-repeat',
      'collision-numbered-heading',
      'heading-uncovered-items',
      'inverted-date-range',
      // r28j 同日零长区间修复（M15：锚定 cross-chapter-consistency「同日起止区间校验」，紧随区间族）
      'zero-length-date-range',
      'truncated-sentence',
      'meta-discourse',
      'formula-residue',
      'self-undermining',
      'ambiguous-either-or',
      // 4.27.2 招标元语言清理 + 重复响应行去重
      'tender-meta-language',
      // 4.32 配置禁用词清洗（丰乐镇 v6 #59）
      'forbidden-configuration',
      'duplicate-response-line',
      // 4.36.2 复查修正：图集引用清洗补接 round-2 链（stage5 后 LLM 补写轮可再引入）
      'atlas-reference',
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
      // 4.40 d5d 同章同名 H3 小节确定性合并（与检测器 heading-duplicate 同源）：紧随其后 section-renumber 编号重放
      'heading-duplicate-merge',
      // 4.36 A2 小节编号重放（结构事务化 · 编号不变量 INV-1：链尾原子重放，H4 父前缀同步）
      'section-renumber',
    ]);
  });
});
