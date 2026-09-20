/**
 * P22 第 3 项 / P6 修复轮顺序快照：锁定 FINALIZE_REPAIR_ROUNDS 与
 * LLM_PATCH_REPAIR_ROUNDS 的声明顺序。
 * 顺序变更必须显式修改本快照并附理由（修复轮先后影响正文改写语义，无意识调整即回归）。
 */
import { describe, expect, it } from 'vitest';
import { FINALIZE_REPAIR_ROUNDS, LLM_PATCH_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';

describe('修复轮顺序快照（变更必须显式改快照并附理由）', () => {
  it('FINALIZE_REPAIR_ROUNDS 31 轮顺序快照', () => {
    expect([...FINALIZE_REPAIR_ROUNDS]).toEqual([
      'fact-landing-round',          // 重要事实落位补写轮（uncoveredImportantFacts 触发）
      'table-repair-round',          // 表格数据完整性修复轮（markdownTableQualityIssues error 触发）
      'semantic-choice-conflict',    // 决策锁语义矛盾检测（semanticChoiceConflicts，无修复）
      'deterministic-stage5',        // 交付前确定性清洗（章级数值/SURFACE_FIX_STEPS/全文数值/表承载正文）
      'formal-source-clean',         // 来源罗列话术确定性清洗兜底（cleanFormalSourcePhrases）
      'planned-section-final',       // 缺节/空小节补写终兜底（enforcePlannedSectionCompleteness）
      'commercial-strip',            // 商务条款数据交付前兜底清洗（stripCommercialDataBodyLines）
      'table-deterministic-repair',  // 表格空单元格交付前确定性修复（repairTableBlocksInMarkdownDeterministically）
      'numeric-verification',        // C2 正文数值 vs 资料原文确定性核对轮（stageNumericVerification）
      'requirement-response-repair', // 招标要求响应定向补写轮（requirements-coverage blocker 消费；r3 门禁归因新增）
      'requirement-verification',    // C3 生成后用户要求执行核验闭环（stageRequirementVerification）
      'content-depth-repair',        // r8 内容深度补写轮（六类深度检测器统一收口：critical/emergency-depth、construction-org、precise-fact-usage、overview-recap）
      'control-loop-repair',         // D-T2 评审关注闭环链补写轮（质量三检/进度纠偏/工资代发链主责章全要素成链；位于 content-depth-repair 之后、post-review-surface 之前）
      'professional-chain-repair',   // D-T9 工序链与项目属性适配修复轮（节级域错位改写/文档级缺失链补写；位于 control-loop-repair 之后、post-review-surface 之前）
      'post-review-surface',         // 评审轮后表面修复兜底（SURFACE_FIX_STEPS round-2 链，含句级复读剥离；后置覆盖用户要求补写引入的复读）
      'terminology-strip',           // 内部术语句子确定性删除兜底（stripInternalTerminologySentences）
      'regulation-number-typo',      // 4.44 法规文号残缺链尾收口（stage5 后 LLM patch 轮可再引入「（国务院令第279订）」类残缺）
      'quotation-balance-repair',    // r4 引文成对性残缺链尾修复（法规列举句自吞噬拼接丢失：终检报出后无轮消费直坠门禁）
      'basis-regulations-repair',    // 丰乐镇实机终门禁 #8：编制依据法规/规范漏列链尾修复（照抄招标文件引用法规 + 按分部选列现行规范）
      'dangerous-applicability-repair', // r28j 危大辨识清单漏项链尾修复（s28i 连续两轮：定位含危大辨识区章 + LLM 定向补列遗漏适用项，复检覆盖数 + 变差回滚）
      'auto-spec-gate-repair',       // D-T8 配置必要内容缺失链尾收口（autoSpecGates 术语缺口 bigram 归属到章 + LLM 定向补写；位于 basis-regulations-repair 之后、toc-consistency 之前）
      'toc-consistency',             // 目录与正文一致性兜底（fixTocFromBody）
      'length-compression-repair',   // D-T3 成稿篇幅压缩轮（成稿超目标 20% 时章级超额定位 + LLM 合并重复段落；位于 toc-consistency 之后、扩散轮之前）
      'fact-distribution-round',     // R12 关键事实跨章扩散轮（stageFactDistribution，链尾收口：全部 LLM 补写轮之后、终门禁之前）
      'table-caption-repair',        // r24 B8 正文表格题名补全轮（无题表确定性补名 + 残留 LLM 补名；位于 stageFactDistribution 之后、链尾 markdown-only 重放之前）
      'table-arithmetic-repair',     // C-T3 表内算术自洽修复轮（合计行/列与分项和对账 + LLM 定向重算表内数值；位于 table-caption-repair 之后、链尾 markdown-only 重放之前）
      'empty-section-sweep',         // D-T3 无依据空壳小节链尾清扫（确定性整行移除 + 章内编号原子重放；链尾最后 draft-mutating、markdown-only 重放之前）
      'section-alignment-sweep',     // D-T6 小节结构对齐链尾重放（近名合并/漂移改名 + 非近名规划外 H3 降 H4；empty-section-sweep 之后、链尾 markdown-only 重放之前）
      'templating-sweep',            // D-T7 模板化清理链尾重放（零信息前缀句确定性删除 + 逐章段落完全重复去重；section-alignment-sweep 之后、链尾 markdown-only 重放之前）
      'duplicate-theme-merge',       // D-T7 重复主题小节链尾合并（同桶规划小节 ≥2 确定性合并 + 规划数组同步 + 章内编号原子重放；templating-sweep 之后、delivery-structure-closure 之前）
      'delivery-structure-closure',  // D-T6 交付结构收口（超长段落切分 + 目录按正文实际结构重建；最后净变更点之后、stageFinalGate 之前）
    ]);
  });

  it('LLM_PATCH_REPAIR_ROUNDS 17 轮顺序快照（P11 全链接入的登记载体）', () => {
    expect(LLM_PATCH_REPAIR_ROUNDS.map(round => round.id)).toEqual([
      'fact-landing',
      'table-repair',
      'table-execution-repair',
      'templating-repair',
      'workpackage-skeleton-repair',
      'planned-section-repair',
      'global-consistency-repair',
      'quotation-balance-repair',
      'content-depth-repair',
      'control-loop-repair',
      'professional-chain-repair',
      'basis-regulations-repair',
      'dangerous-applicability-repair',
      'auto-spec-gate-repair',
      'length-compression-repair',
      'table-caption-repair',
      'table-arithmetic-repair',
    ]);
  });

  it('LLM 修复轮 anchoredTo 检测器锚定不变（修复定位=检测定位契约）', () => {
    expect(LLM_PATCH_REPAIR_ROUNDS.map(round => ({ id: round.id, anchoredTo: round.anchoredTo }))).toEqual([
      { id: 'fact-landing', anchoredTo: 'important-unplaced-facts' },
      { id: 'table-repair', anchoredTo: 'table-quality' },
      { id: 'table-execution-repair', anchoredTo: 'table-plan-execution' },
      { id: 'templating-repair', anchoredTo: 'templating-filler' },
      { id: 'workpackage-skeleton-repair', anchoredTo: 'workpackage-skeleton' },
      { id: 'planned-section-repair', anchoredTo: 'planned-section-completeness' },
      { id: 'global-consistency-repair', anchoredTo: 'global-consistency-review' },
      { id: 'quotation-balance-repair', anchoredTo: 'punctuation-artifact' },
      { id: 'content-depth-repair', anchoredTo: 'critical-section-depth' },
      { id: 'control-loop-repair', anchoredTo: 'construction-org-control-loop' },
      { id: 'professional-chain-repair', anchoredTo: 'construction-org-professional-chain' },
      { id: 'basis-regulations-repair', anchoredTo: 'basis-regulations-coverage' },
      { id: 'dangerous-applicability-repair', anchoredTo: 'dangerous-applicability' },
      { id: 'auto-spec-gate-repair', anchoredTo: 'planned-auto-spec-gate' },
      { id: 'length-compression-repair', anchoredTo: 'document-budget' },
      { id: 'table-caption-repair', anchoredTo: 'table-caption' },
      { id: 'table-arithmetic-repair', anchoredTo: 'table-arithmetic-consistency' },
    ]);
  });
});
