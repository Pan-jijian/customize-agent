/**
 * G 线接线锁定（防复发固化）：源文本静态断言 + 计量行为断言。
 *
 * 覆盖三条「改回去就出事」的口径：
 * - **P2-2** 停用删除型修复器：`demoteUnsourcedNumericTokens` 恒返回 null（不得重新引入「删数值通过门禁」），
 *   postReviewSurface 不得再出现该调用与已死的 `numeric-traceability-demote` 进度事件。
 * - **P2-4** 修复动作计量：`quality.repairedCount` 必须有真实写入出口（此前全仓只初始化、永不写入，
 *   导出闭环报告恒称「0 处修复」），且关键修复轮均已接线。
 * - **P2-5** 修复停机条件：内容深度补写轮以「达标线」停机，轮次常量只作预算兜底（不得退回 2）。
 *
 * 行为语义由各轮专项用例覆盖（documentFactTrace / contentDepthRepair / postReviewSurface 等）；
 * 本文件只锁「降采样后仍必须存在」的字面接线与计量出口。
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createGenerationDiagnostics, recordRepairActions } from '@/services/document-workflow/rolePipeline';
import { PENDING_FIXER_DISPOSITION, assertRegistryConsistency, fixerDispositionErrors, FULL_VALIDATION_DETECTORS, STANDARD_FINAL_DETECTORS, AUXILIARY_DETECTORS, DETERMINISTIC_FIXER_ANCHORS, NUMERIC_ARBITER_FIXERS, CHAPTER_DETERMINISTIC_FIXERS, CHAIN_INTERNAL_DETERMINISTIC_FIXERS, LLM_PATCH_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import type { DetectorEntry, FixerEntry } from '@/services/document-workflow/detectorFixerRegistry';
import { buildDocumentTelemetryReport } from '@/services/document-workflow/documentTelemetry';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');
const read = (relative: string) => readFileSync(path.join(SRC_DIR, relative), 'utf8');

const factTraceSrc = read('documentFactTrace.ts');
const postReviewSrc = read('finalize/repairRounds/postReviewSurface.ts');
const stage5Src = read('finalize/repairRounds/deterministicStage5.ts');
const contentDepthSrc = read('finalize/repairRounds/contentDepthRepair.ts');
const deliveryClosureSrc = read('finalize/repairRounds/deliveryStructureClosure.ts');
const sectionSweepSrc = read('finalize/repairRounds/sectionAlignmentSweep.ts');
const rolePipelineSrc = read('rolePipeline.ts');

/** P2-2：禁止以「删除数值」通过门禁 */
describe('G 线 P2-2 删除型修复器停用锁定', () => {
  it('demoteUnsourcedNumericTokens 体已停用：不再有删除替换，恒返回 null', () => {
    expect(factTraceSrc).toContain('void input;');
    expect(factTraceSrc).toContain('  return null;');
    // 原删除动作（逆序切片拼接移除 token）不得复活
    expect(factTraceSrc).not.toContain('next.slice(0, finding.index)');
    expect(factTraceSrc).not.toContain('tidyRemovalArtifacts(next)');
  });

  it('postReviewSurface 不再消费该修复器（调用与已死的进度事件一并移除）', () => {
    expect(postReviewSrc).not.toContain('demoteUnsourcedNumericTokens({');
    expect(postReviewSrc).not.toContain("roleId: 'numeric-traceability-demote'");
  });
});

/** 4.55.34：名称绑定两个变体（无源 / 错位）都必须在可重放清洗组内有确定性消费端。
 * 实机归因：错位变体长期只有检测（D4.6a）没有修复器——删掉本块即退回「blocker 直坠终门禁」，
 * 故与 P2-2 同类做字面接线锁定（行为语义见 batch1-d4-fact-reconciliation 正反例）。 */
describe('名称绑定确定性收敛接线锁定', () => {
  it('错位变体在可重放清洗组内（检测定位=修复定位，随 runSurfaceDeterministicCleans 重放）', () => {
    const cleansBody = postReviewSrc.slice(postReviewSrc.indexOf('export async function runSurfaceDeterministicCleans'));
    expect(cleansBody).toContain('fixMislocatedNameBindings(session.finalMarkdown, {');
    expect(cleansBody).toContain("roleId: 'mislocated-binding-clean'");
    expect(cleansBody).toContain('recordRepairActions(session.generationDiagnostics, mislocatedBindingFix.fixedCount);');
    // 与无源变体同组同口径（两个变体共用删除引擎，不得只留其一）
    expect(cleansBody).toContain('fixUnsourcedNameBindings(session.finalMarkdown, {');
  });
});

/** P2-4：修复动作必须可计量 */
describe('G 线 P2-4 修复动作计量接线锁定', () => {
  it('统一出口导出不缺失', () => {
    expect(rolePipelineSrc).toContain('export function recordRepairActions(diagnostics: DocumentGenerationDiagnostics, count: number): void {');
  });

  it('关键修复轮均已接线（删任一处即静默退化为不可计量）', () => {
    expect(stage5Src).toContain("import { recordRepairActions } from '../../rolePipeline';");
    expect(postReviewSrc).toContain("import { recordRepairActions } from '../../rolePipeline';");
    expect(contentDepthSrc).toContain('recordRepairActions(session.generationDiagnostics, resolvedTotal);');
    expect(deliveryClosureSrc).toContain("import { recordRepairActions } from '../../rolePipeline';");
    expect(sectionSweepSrc).toContain('recordRepairActions(session.generationDiagnostics, total + renumberedChapters);');
  });

  it('计量累加进 diagnostics.quality 且经 telemetry 透出（导出报告消费同一对象）', () => {
    const diagnostics = createGenerationDiagnostics({ mode: 'balanced', enableChapterReview: true, enableGlobalReview: false, enableFinalQualityReview: true });
    expect(diagnostics.quality.repairedCount).toBe(0);
    recordRepairActions(diagnostics, 5);
    recordRepairActions(diagnostics, 3);
    expect(diagnostics.quality.repairedCount).toBe(8);
    // 非正数/非法数不计数（修复器零命中时不得虚增）
    recordRepairActions(diagnostics, 0);
    recordRepairActions(diagnostics, -2);
    recordRepairActions(diagnostics, Number.NaN);
    expect(diagnostics.quality.repairedCount).toBe(8);
    // telemetry 构建取 diagnostics.quality 快照——导出闭环报告的 repairedCount 来源即此
    expect(buildDocumentTelemetryReport({ diagnostics }).qualityIssues.repairedCount).toBe(8);
  });
});

/** P2-5：修复停机条件是达标线，不是轮次上限 */
describe('G 线 P2-5 修复停机条件锁定', () => {
  it('轮次常量语义为预算兜底（2 → 4），不得退回质量上限口径', () => {
    expect(contentDepthSrc).toContain('const MAX_CONTENT_DEPTH_REPAIR_ROUNDS = 4;');
  });

  it('收敛判定保留「达标即停」与「严格下降才续轮」双闸', () => {
    expect(contentDepthSrc).toContain('if (afterResidual === 0 || afterResidual >= beforeResidual || rounds >= roundCap) break;');
  });
});

/**
 * P2-3：修复器覆盖声明闸门。两类断言缺一不可——
 * ① **闸门真的会响**：用合成数据直接验证每条拒绝路径（只测「当前通过」等于没测）；
 * ② **欠账只减不增**：PENDING 清单指纹锁定，缩小必须同时改本文件（可复核），
 *    新检测器上线既进不了清单、又必须有声明，故不会再产生沉默孤儿。
 */
describe('G 线 P2-3 修复器覆盖声明闸门', () => {
  const detector = (over: Partial<DetectorEntry> & { id: string }): DetectorEntry => ({ scope: 'full-document', category: 'structure', ...over });
  const fixer = (anchoredTo: string): FixerEntry => ({ id: `fix-${anchoredTo}`, kind: 'deterministic', anchoredTo, giveUpOnFailure: true });

  it('闸门对当前真实注册表通过（assertRegistryConsistency 不抛错）', () => {
    expect(() => assertRegistryConsistency()).not.toThrow();
  });

  it('① 孤儿无声明且不在欠账清单 → 报错（新检测器无法沉默上线）', () => {
    const errors = fixerDispositionErrors({ detectors: [detector({ id: 'brand-new' })], fixers: [], pending: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('既无修复器锚定、也未声明 fixerDisposition');
  });

  it('② 声明与事实不符 → 报错（fixed 无锚定 / exempt·manual 有锚定）', () => {
    expect(fixerDispositionErrors({ detectors: [detector({ id: 'd1', fixerDisposition: 'fixed' })], fixers: [], pending: [] })[0])
      .toContain("声明 fixerDisposition='fixed' 但无任何 FixerEntry 锚定");
    expect(fixerDispositionErrors({ detectors: [detector({ id: 'd2', fixerDisposition: 'manual', fixerDispositionReason: 'x' })], fixers: [fixer('d2')], pending: [] })[0])
      .toContain("声明 fixerDisposition='manual' 但已有修复器锚定");
  });

  it('③ exempt/manual 缺理由 → 报错（防「随手标一个」使声明失去信息量）', () => {
    const errors = fixerDispositionErrors({ detectors: [detector({ id: 'd3', fixerDisposition: 'exempt' })], fixers: [], pending: [] });
    expect(errors[0]).toContain('但未给出理由');
    // 空白理由同样不算（trim 后为空即报错）
    expect(fixerDispositionErrors({ detectors: [detector({ id: 'd4', fixerDisposition: 'manual', fixerDispositionReason: '   ' })], fixers: [], pending: [] })[0])
      .toContain('但未给出理由');
  });

  it('④ 非法处置值 / 欠账清单脏数据 → 报错', () => {
    expect(fixerDispositionErrors({ detectors: [detector({ id: 'd5', fixerDisposition: 'maybe' as never })], fixers: [], pending: [] })[0])
      .toContain('声明了非法 fixerDisposition');
    expect(fixerDispositionErrors({ detectors: [detector({ id: 'd6' })], fixers: [], pending: ['ghost'] })[0])
      .toContain('声明了未登记的检测器 ghost');
    expect(fixerDispositionErrors({ detectors: [detector({ id: 'd7' })], fixers: [], pending: ['d7', 'd7'] })[0])
      .toContain('存在重复 id');
  });

  it('⑤ 已完成处置或已有修复器却仍挂欠账 → 报错（清单只能缩小）', () => {
    expect(fixerDispositionErrors({ detectors: [detector({ id: 'd8', fixerDisposition: 'exempt', fixerDispositionReason: 'r' })], fixers: [], pending: ['d8'] })[0])
      .toContain('已完成处置声明（exempt）却仍在 PENDING_FIXER_DISPOSITION 中');
    expect(fixerDispositionErrors({ detectors: [detector({ id: 'd9' })], fixers: [fixer('d9')], pending: ['d9'] })[0])
      .toContain('已有修复器锚定却仍在 PENDING_FIXER_DISPOSITION 中');
  });

  it('⑥ 合法状态静默通过（有锚定不声明 / 有锚定声明 fixed / exempt 带理由）', () => {
    expect(fixerDispositionErrors({
      detectors: [
        detector({ id: 'a' }),
        detector({ id: 'b', fixerDisposition: 'exempt', fixerDispositionReason: '纯度量信号' }),
        detector({ id: 'c', fixerDisposition: 'fixed', fixerDispositionReason: '部分覆盖：仅口径词族' }),
      ],
      fixers: [fixer('a'), fixer('c')],
      pending: [],
    })).toEqual([]);
  });

  it('⑦ 只写理由不写处置 → 报错（部分覆盖说明必须挂在明确处置上）', () => {
    const errors = fixerDispositionErrors({ detectors: [detector({ id: 'd10', fixerDispositionReason: '仅口径词族' })], fixers: [fixer('d10')], pending: [] });
    expect(errors[0]).toContain('写了 fixerDispositionReason 却未声明 fixerDisposition');
  });

  it('覆盖率下限锁定（单调不减）：删除锚定 + 把声明降级为 manual 会被此用例拦下', () => {
    // 闸门只能保证「声明与事实一致」，保证不了「事实本身没退化」——把 FixerEntry 删掉同时把
    // 该检测器从 'fixed' 改成 'manual' 是一条自洽的路径，闸门不会响，但覆盖率会静默下跌。
    // 故此处锁一个下限：覆盖率只许升不许降，下降必须显式改本行（可复核）。
    const covered = new Set<string>();
    for (const entry of [...DETERMINISTIC_FIXER_ANCHORS, ...NUMERIC_ARBITER_FIXERS, ...CHAPTER_DETERMINISTIC_FIXERS, ...CHAIN_INTERNAL_DETERMINISTIC_FIXERS, ...LLM_PATCH_REPAIR_ROUNDS]) {
      covered.add(entry.anchoredTo);
      for (const extra of entry.alsoAnchoredTo ?? []) covered.add(extra);
    }
    const declared = [...FULL_VALIDATION_DETECTORS, ...STANDARD_FINAL_DETECTORS, ...AUXILIARY_DETECTORS];
    const coveredDetectorCount = declared.filter(detector => covered.has(detector.id)).length;
    // 上限治理 · 旧代码清理：`important-unplaced-facts` / `table-plan-execution` 两个**幻影检测器**
    //（全仓无发出点，仅作 llm 轮的 anchoredTo）已删除，对应轮改锚真实检测器（fact-coverage /
    // bid-composition-body-table）⇒ 覆盖计数由 97 降为 95（总数 151→149）。这是**去伪**而非退化。
    // 幻影锚点收口（第二批）：`templating-filler`/`workpackage-skeleton`/`planned-section-completeness`/
    // `global-consistency-review` 四条悬空声明已删除，4 轮改锚同族真实检测器 ⇒ 检测器总数 149→145、
    // 覆盖计数 97→92。**这是去伪而非退化**：被删的都是「全仓零发出点」的假检测器。
    expect(coveredDetectorCount).toBeGreaterThanOrEqual(92);
  });

  it('欠账清单指纹锁定：只允许缩小，缩小必须同时改本用例（可复核）', () => {
    expect(PENDING_FIXER_DISPOSITION).toHaveLength(0);
    expect(PENDING_FIXER_DISPOSITION).toEqual([...new Set(PENDING_FIXER_DISPOSITION)]);
    const fingerprint = createHash('sha256').update([...PENDING_FIXER_DISPOSITION].sort().join('\n')).digest('hex').slice(0, 12);
    expect(fingerprint).toBe('e3b0c44298fc');
  });
});
