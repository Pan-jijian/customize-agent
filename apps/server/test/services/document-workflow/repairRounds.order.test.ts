/**
 * P22 第 2 项 / P6 修复轮单源声明防回归：
 * 1. finalizeGeneration 执行侧的 stage 调用序列锁定（顺序变更必须显式改本测试）；
 * 2. FINALIZE_REPAIR_ROUNDS 声明表 29 轮顺序与执行侧注释映射逐一对应（单源声明不漂移）；
 * 3. 每轮"修复落地后必触发 recompute"——含修复逻辑的轮文件必须调用
 *    session.recomputeFinalValidationBundle()（纯检测轮 semanticChoice 无修复落地，豁免）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 执行侧线性链（documentPipeline.finalizeGeneration 内 await stageXxx(session) 的调用序列） */
const EXECUTION_STAGE_ORDER = [
  'stageRebuildFacts',
  'stageValidationPack',
  'stageComposeFinal',
  'stageRebuildAndRecompute',
  'stageFactLanding',
  'stageTableRepair',
  'stageSemanticChoice',
  'stageDeterministicStage5',
  'stageNumericVerification',
  'stageRequirementResponseRepair',
  'stageRequirementVerification',
  'stageContentDepthRepair',
  // D-T2 评审关注闭环链补写轮（同族补写轮；位于深度补写轮之后、post-review-surface 之前）
  'stageControlLoopRepair',
  // D-T9 工序链与项目属性适配修复轮（同族补写轮；位于 control-loop-repair 之后、post-review-surface 之前）
  'stageProfessionalChainRepair',
  'stagePostReviewSurface',
  // D-T3 成稿篇幅压缩轮（draft-mutating + rebuild；位于全部 LLM 补写轮之后、扩散轮之前）
  'stageLengthCompressionRepair',
  'stageFactDistribution',
  // C-T3 表内算术自洽修复轮（draft-mutating + rebuild；链尾 markdown-only 重放之前）
  'stageTableArithmeticRepair',
  // D-T3 无依据空壳小节链尾清扫（确定性 draft-mutating + rebuild；链尾最后 draft-mutating、markdown-only 重放之前）
  'stageEmptySectionSweep',
  // D-T6 小节结构对齐链尾重放（确定性 draft-mutating + rebuild；empty-section-sweep 之后、链尾 markdown-only 重放之前）
  'stageSectionAlignmentSweep',
  // D-T7 模板化清理链尾重放（确定性 draft-mutating + rebuild；section-alignment-sweep 之后、链尾 markdown-only 重放之前）
  'stageTemplatingSweep',
  // D-T7 重复主题小节合并（确定性 draft-mutating + rebuild；templating-sweep 之后、delivery-structure-closure 之前）
  'stageDuplicateThemeMerge',
  // 4.55.29 正文表格题名补全轮（draft-mutating + rebuild；**链尾最后 draft-mutating 位置**）——
  // 原位于 factDistribution 之后，其实测其后各结构类修复轮重建成稿时引入新无题表，终稿残留无题表；
  // 题注是结构属性，须在结构类修复全部收敛之后再收口
  'stageTableCaptionRepair',
  // D-T6 交付结构收口（markdown-only；最后净变更点之后、stageFinalGate 之前）
  'stageDeliveryStructureClosure',
  // C8 S3 句模复读链尾收口（markdown-only；delivery-structure-closure 之后、链尾标点兜底之前）
  'stageSentencePatternSweep',
  // C8 S5 句级复读坍塌链尾收口（markdown-only；sentence-pattern-sweep 之后、链尾标点兜底之前）
  'stageDuplicateSentenceCollapse',
  // C8 S6 A' 对象错位（markdown 版 templating 重放；duplicate-sentence-collapse 之后、链尾标点兜底之前）
  'stageTemplatingTailReplay',
  'stageFinalGate',
  // P18 自动健康诊断：finalize 末尾零 LLM 成本告警（纯读 telemetry，不参与修复轮）
  'stageHealthDiagnosis',
] as const;

/** 修复轮文件 → 声明表轮 id 映射（轮文件名与声明 id 的对应关系，P2 拆分约定） */
const REPAIR_ROUND_FILES = {
  'finalize/repairRounds/factLanding.ts': ['fact-landing-round'],
  'finalize/repairRounds/tableRepair.ts': ['table-repair-round'],
  'finalize/repairRounds/semanticChoice.ts': ['semantic-choice-conflict'],
  'finalize/repairRounds/deterministicStage5.ts': ['deterministic-stage5', 'formal-source-clean'],
  'finalize/repairRounds/postReviewSurface.ts': ['planned-section-final', 'commercial-strip', 'table-deterministic-repair', 'post-review-surface', 'terminology-strip', 'regulation-number-typo', 'toc-consistency'],
  'finalize/repairRounds/numericVerification.ts': ['numeric-verification'],
  'finalize/repairRounds/requirementResponseRepair.ts': ['requirement-response-repair'],
  'finalize/repairRounds/requirementVerification.ts': ['requirement-verification'],
  // r8 终门禁归因新增：内容深度补写轮（六类内容深度检测器统一收口消费）
  'finalize/repairRounds/contentDepthRepair.ts': ['content-depth-repair'],
  // D-T2 归因新增：评审关注闭环链补写轮（质量三检/进度纠偏/工资代发链主责章全要素成链，B8 前半根治）
  'finalize/repairRounds/controlLoopRepair.ts': ['control-loop-repair'],
  // D-T9 归因新增：工序链与项目属性适配修复轮（节级域错位改写/文档级缺失链补写，根治 #30/#31）
  'finalize/repairRounds/professionalChainRepair.ts': ['professional-chain-repair'],
  // r4 门禁归因新增：引文成对性残缺链尾修复轮（独立文件，postReviewSurface 链尾调用）
  'finalize/repairRounds/quotationBalanceRepair.ts': ['quotation-balance-repair'],
  // 丰乐镇实机终门禁归因 #8 新增：编制依据法规漏列链尾修复轮（独立文件，postReviewSurface 链尾调用）
  'finalize/repairRounds/basisRegulationsRepair.ts': ['basis-regulations-repair'],
  // C5 一致性类 P6 新增：编制依据↔正文双向对账链尾收口轮（独立文件，postReviewSurface 链尾调用：basis 之后、dangerous 之前）
  'finalize/repairRounds/basisRegulationsCrossRepair.ts': ['basis-regulations-cross-repair'],
  // r28j 归因新增：危大辨识清单漏项链尾修复轮（独立文件，postReviewSurface 链尾调用：basis 之后、autoSpec 之前）
  'finalize/repairRounds/dangerousApplicabilityRepair.ts': ['dangerous-applicability-repair'],
  // D-T8 归因新增：配置必要内容缺失链尾修复轮（独立文件，basis-regulations-repair 之后、链尾 markdown-only 重放之前调用）
  'finalize/repairRounds/autoSpecGateRepair.ts': ['auto-spec-gate-repair'],
  // R12 方案针对性分布归因新增：关键事实跨章扩散轮（独立文件，postReviewSurface 之后链尾调用）
  'finalize/repairRounds/factDistribution.ts': ['fact-distribution-round'],
  // r24 B8 实机归因新增：正文表格题名补全轮（独立文件，扩展轮之后链尾调用）
  'finalize/repairRounds/tableCaptionRepair.ts': ['table-caption-repair'],
  // C-T3 归因新增：表内算术自洽修复轮（独立文件，题名补全轮之后、链尾 markdown-only 重放之前调用）
  'finalize/repairRounds/tableArithmeticRepair.ts': ['table-arithmetic-repair'],
  // D-T3 归因新增：成稿篇幅压缩轮（独立文件，全部 LLM 补写轮之后、扩散轮之前调用）
  'finalize/repairRounds/lengthCompressionRepair.ts': ['length-compression-repair'],
  // D-T3 归因新增：无依据空壳小节链尾清扫轮（独立文件，链尾最后 draft-mutating、markdown-only 重放之前调用）
  'finalize/repairRounds/emptySectionSweep.ts': ['empty-section-sweep'],
  // D-T6 归因新增：小节结构对齐链尾重放轮（独立文件，empty-section-sweep 之后、链尾 markdown-only 重放之前调用）
  'finalize/repairRounds/sectionAlignmentSweep.ts': ['section-alignment-sweep'],
  // D-T7 归因新增：模板化清理链尾重放轮（独立文件，section-alignment-sweep 之后、链尾 markdown-only 重放之前调用）
  'finalize/repairRounds/templatingSweep.ts': ['templating-sweep'],
  // D-T7 归因新增：重复主题小节合并轮（独立文件，templating-sweep 之后、delivery-structure-closure 之前调用）
  'finalize/repairRounds/duplicateThemeMerge.ts': ['duplicate-theme-merge'],
  // D-T6 归因新增：交付结构收口轮（独立文件，最后净变更点之后、stageFinalGate 之前调用）
  'finalize/repairRounds/deliveryStructureClosure.ts': ['delivery-structure-closure'],
  // C8 S3 归因新增：句模复读链尾收口轮（独立文件，delivery-structure-closure 之后、链尾标点兜底之前调用）
  'finalize/repairRounds/sentencePatternSweep.ts': ['sentence-pattern-sweep'],
  // C8 S5 归因新增：句级复读坍塌链尾收口轮（独立文件，sentence-pattern-sweep 之后、链尾标点兜底之前调用）
  'finalize/repairRounds/duplicateSentenceCollapse.ts': ['duplicate-sentence-collapse'],
  // C8 S6 归因新增：模板化清理链尾重放轮（markdown 版，独立文件，duplicate-sentence-collapse 之后、链尾标点兜底之前调用）
  'finalize/repairRounds/templatingTailReplay.ts': ['templating-tail-replay'],
} as const;

/** 纯检测轮（无修复落地，不需要 recompute 触发） */
const DETECTION_ONLY_ROUNDS = new Set(['semantic-choice-conflict']);

describe('finalize 修复轮调度（P6 单源声明防回归）', () => {
  it('执行侧 stage 调用序列锁定（documentPipeline.finalizeGeneration）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    // stageComposeFinal 为同步调用（无 await），单独断言其位置在 rebuildAndRecompute 之前
    const composeIndex = source.indexOf('stageComposeFinal(session)');
    const rebuildIndex = source.indexOf('await stageRebuildAndRecompute(session)');
    expect(composeIndex).toBeGreaterThan(-1);
    expect(rebuildIndex).toBeGreaterThan(-1);
    expect(composeIndex).toBeLessThan(rebuildIndex);
    const stages = [...source.matchAll(/await (stage\w+)\(session\)/gu)].map(match => match[1]);
    expect(stages).toEqual(EXECUTION_STAGE_ORDER.filter(stage => stage !== 'stageComposeFinal'));
  });

  it('FINALIZE_REPAIR_ROUNDS 35 轮顺序与执行侧注释映射逐一对应（顺序无漂移）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    // 提取执行侧注释块（P6 注释按声明顺序逐一罗列轮 id）
    const commentBlock = source.match(/P6：修复轮顺序.*$(?:\s*\/\/.*$){0,6}/um)?.[0] ?? '';
    expect(FINALIZE_REPAIR_ROUNDS).toHaveLength(35);
    let lastIndex = -1;
    for (const round of FINALIZE_REPAIR_ROUNDS) {
      const index = commentBlock.indexOf(round);
      expect(index, `轮 ${round} 未按声明顺序出现在执行侧注释映射中`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it('每轮修复落地后必触发 recompute（含修复逻辑轮文件均调用 recomputeFinalValidationBundle）', () => {
    for (const [file, rounds] of Object.entries(REPAIR_ROUND_FILES)) {
      const source = readFileSync(path.join(SRC_DIR, file), 'utf8');
      const hasRepair = rounds.some(round => !DETECTION_ONLY_ROUNDS.has(round));
      const recomputeCalls = (source.match(/session\.recomputeFinalValidationBundle\(\)/gu) ?? []).length;
      if (hasRepair) {
        expect(recomputeCalls, `${file}（${rounds.join('+')}）修复落地后必须重算校验组`).toBeGreaterThan(0);
      } else {
        // 纯检测轮：不写正文，无需 recompute（声明语义一致性）
        expect(recomputeCalls, `${file} 为纯检测轮，不应触发 recompute`).toBe(0);
      }
    }
  });

  it('修复轮文件与声明表轮 id 完整覆盖（35 轮均有落点，无哑火轮）', () => {
    const mapped = Object.values(REPAIR_ROUND_FILES).flat();
    expect(mapped.sort()).toEqual([...FINALIZE_REPAIR_ROUNDS].sort());
  });
});
