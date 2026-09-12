/**
 * repairRounds/deterministicStage5：交付前确定性清洗轮（FINALIZE_REPAIR_ROUNDS: deterministic-stage5 + formal-source-clean）。
 * P2 拆分（方案 5.2）：由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 * 修复器清单与顺序由 SURFACE_FIX_STEPS（deterministicFixChains）注册表单源定义。
 */
import { applyDeterministicConsistencyFixes, applyDeterministicConsistencyFixesToMarkdown } from '../../qualityValidation';
import { applyNumericConsistencyDeterministicFixes, extractGreeningMaintenanceAuthority, fixTableBorneContentSections, stripDuplicateTablesAcrossChapters, runFixUntilClean } from '../../documentIntegrityChecks';
import { blueprintLaborPeakAuthority, buildAuthorityIndex } from '../../authorityIndex';
import { fixScoringRequirementResponses } from '../../tenderRequirements';
import { cleanFormalSourcePhrases } from '../../markdownComposer';
import { SURFACE_FIX_STEPS, type SurfaceFixerContext } from '../../deterministicFixChains';
import { displayStage, upsertProgressStage } from '../../progress';
import type { FinalizeSession } from '../finalizeSession';

export async function stageDeterministicStage5(session: FinalizeSession): Promise<void> {
  // 阶段 5 交付前确定性清洗（数值定点兜底）：blocker 修复循环已删除，导出前做最后一次确定性定点修复，
  // 修复后重算校验组，避免残留冲突被导出门禁硬阻断。章节级修复原地改正文后重建全文，
  // 全文级修复覆盖封面/信息表合成区的败选数值（章节修复覆盖不到），最后定点替换跨章数值矛盾。
  const stage5ChapterFix = await applyDeterministicConsistencyFixes(session.finalChapterDrafts, session.factsModel, session.scopeConflicts);
  // D1 劳动力峰值三层锚点统一：蓝图 labor.peakValue（造价锚定）> 分阶段投入明细表峰值 > 正文表述。
  // 章节级频率投票修复器与全文级定点替换修复器共用同一权威口径，检测器也按该口径豁免——
  // 否则修复器把正文对齐蓝图后，表格互查检测器又会把正文拉回表峰值，形成修复循环拉扯
  session.laborPeakAuthority = blueprintLaborPeakAuthority(session.blueprintData);
  // B2 绿化养护期权威（丰乐镇实测「养护一年」漏网）：养护期红线事实无章级锚定时，
  // 从 factsModel 清单/精确事实抽取权威养护年限，与检测器同源（extractGreeningMaintenanceAuthority）
  session.greeningMaintenanceAuthority = extractGreeningMaintenanceAuthority(session.factsModel);
  // B1 评分项响应强制：交付前对零命中/部分响应的实质条款按路由责任章节补写响应句（锚点同源判定）
  const stage5ScoringFix = await fixScoringRequirementResponses({
    chapters: session.finalChapterDrafts, model: session.tenderRequirements, similarity: session.requirementsSimilarity, signal: session.signal,
  });
  if (stage5ChapterFix.fixedCount > 0 || stage5ScoringFix.fixedCount > 0) session.finalMarkdown = session.rebuildFinalMarkdown();
  if (stage5ScoringFix.fixedCount > 0) {
    upsertProgressStage(session.progressStages, displayStage({ type: 'validation', roleId: 'scoring-requirement-fix', status: 'success', message: `评分项响应确定性补写 ：${stage5ScoringFix.fixedCount} 条（${stage5ScoringFix.details.slice(0, 3).join('、')}）`, details: stage5ScoringFix.details.slice(3) }, { subtitle: '交付前确 定性清洗' }));
  }
  // B6 交付前确定性清洗（丰乐镇第五轮实测）：跨章表格去重/断行残片合并/叠词收敛此前只有
  // 检测器无修复器——「工程名称表两处重复」「延长有效作业时间 |残行」「分部分项叠词误报」
  // 被导出门禁硬阻断且修复轮循环无效；检测定位=修复定位同源，章节级原地修复后统一重建全文，
  // 重建发生在全文级数值修复之前，避免覆盖 stage5MarkdownFix/stage5NumericFix 的修复成果。
  const stage5TableDup = stripDuplicateTablesAcrossChapters(session.finalChapterDrafts);
  // 交付前确定性清洗链（P10 单源）：修复器清单与顺序由 SURFACE_FIX_STEPS 注册表统一定义，
  // 逐章闭环（每个修复器 runFixUntilClean 2 轮自收敛），权威口径与检测器同源注入
  session.surfaceFixContext = { laborPeakAuthority: session.laborPeakAuthority, greeningMaintenanceAuthority: session.greeningMaintenanceAuthority };
  const surfaceFixCounts = new Map<string, number>();
  const addSurfaceFixCount = (key: string, count: number) => { if (count > 0) surfaceFixCounts.set(key, (surfaceFixCounts.get(key) ?? 0) + count); };
  for (const chapter of session.finalChapterDrafts) {
    for (const step of SURFACE_FIX_STEPS) {
      if (!step.stage5) continue;
      const fix = runFixUntilClean(markdown => step.fix(markdown, session.surfaceFixContext), chapter.content, 2);
      if (fix.fixedCount > 0) { chapter.content = fix.markdown; addSurfaceFixCount(step.key, fix.fixedCount); }
    }
  }
  const countOf = (key: string) => surfaceFixCounts.get(key) ?? 0;
  const stage5ResidueCount = countOf('table-line-residue');
  const stage5FinishFixCount = countOf('finish-thickness');
  const stage5LaborFixCount = countOf('labor-peak');
  const stage5SelfFixCount = countOf('self-undermining');
  const stage5EmptyRespCount = countOf('empty-scoring-response');
  const stage5AtlasRefCount = countOf('atlas-reference');
  const stage5MetaFixCount = countOf('meta-discourse');
  const stage5FormulaFixCount = countOf('formula-residue');
  const stage5OpeningFixCount = countOf('paragraph-opening-repeat');
  const stage5TruncatedFixCount = countOf('truncated-sentence');
  const stage5TableRowDupCount = countOf('internal-table-row-dup');
  const stage5MaintenanceFixCount = countOf('greening-maintenance');
  const stage5TailRepeatCount = countOf('paragraph-tail-repeat');
  if (stage5TableDup.removedCount > 0 || stage5ResidueCount > 0 || stage5FinishFixCount > 0 || stage5LaborFixCount > 0 || stage5SelfFixCount > 0 || stage5EmptyRespCount > 0 || stage5AtlasRefCount > 0 || stage5MetaFixCount > 0 || stage5FormulaFixCount > 0 || stage5OpeningFixCount > 0 || stage5TruncatedFixCount > 0 || stage5TableRowDupCount > 0 || stage5MaintenanceFixCount > 0 || stage5TailRepeatCount > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    upsertProgressStage(session.progressStages, displayStage({ type: 'validation', roleId: 'deterministic-surface-fix', status: 'success', message: `交付前确定性清洗：跨章表格去重 ${stage5TableDup.removedCount} 行、断行残片合并 ${stage5ResidueCount} 处、装饰层厚度修复 ${stage5FinishFixCount} 处、劳动力峰值统一 ${stage5LaborFixCount} 处、段首机械重复剥离 ${stage5OpeningFixCount} 处、截断句残留收敛 ${stage5TruncatedFixCount} 处、元话语声明清洗 ${stage5MetaFixCount} 处、公式形态清洗 ${stage5FormulaFixCount} 处、自伤句式改写 ${stage5SelfFixCount} 处、空响应句改写 ${stage5EmptyRespCount} 处、图集引用清洗 ${stage5AtlasRefCount} 处、表内重复行删除 ${stage5TableRowDupCount} 行、绿化养护期统一 ${stage5MaintenanceFixCount} 处、段内句级复读剥离 ${stage5TailRepeatCount} 处、叠词收敛` }, { subtitle: '交付前确定性清洗' }));
  }
  const stage5MarkdownFix = await applyDeterministicConsistencyFixesToMarkdown(session.finalMarkdown, session.factsModel, session.scopeConflicts);
  if (stage5MarkdownFix.fixedCount > 0) session.finalMarkdown = stage5MarkdownFix.markdown;
  // 跨章数值矛盾（劳动力峰值/节点工期/材料设备数量）确定性定点替换：检测定位=修复定位同源
  const stage5NumericFix = applyNumericConsistencyDeterministicFixes(session.finalMarkdown, { authorityIndex: session.blueprintData ? buildAuthorityIndex(session.blueprintData) : undefined, scheduleAuthority: session.scheduleAuthority, assemblyRateAuthority: session.assemblyRateAuthority, supportAuthority: session.supportAuthority });
  if (stage5NumericFix.fixedCount > 0) session.finalMarkdown = stage5NumericFix.markdown;
  // B3 表格承载正文确定性兜底（丰乐镇实测「1.2 项目主要施工内容」全表格小节）：
  // 关键小节正文全为表格时从表格行确定性生成段落叙述插入标题后（表格保留），
  // 覆盖 majorContentGovernanceIssues 的 error blocker，全文级一次收敛
  const stage5TableProseFix = fixTableBorneContentSections(session.finalMarkdown);
  if (stage5TableProseFix.fixedCount > 0) session.finalMarkdown = stage5TableProseFix.markdown;
  if (stage5TableProseFix.fixedCount > 0) {
    upsertProgressStage(session.progressStages, displayStage({ type: 'validation', roleId: 'table-borne-prose-fix', status: 'success', message: `表格承载正文段落改写兜底：${stage5TableProseFix.fixedCount} 处（${stage5TableProseFix.details.slice(0, 3).join('、')}）`, details: stage5TableProseFix.details.slice(3) }, { subtitle: '交付前确定性清洗' }));
  }
  if (stage5ChapterFix.fixedCount > 0 || stage5MarkdownFix.fixedCount > 0 || stage5NumericFix.fixedCount > 0) {
    await session.recomputeFinalValidationBundle();
    const totalFixed = stage5ChapterFix.fixedCount + stage5MarkdownFix.fixedCount + stage5NumericFix.fixedCount;
    const totalDetails = [...new Set([...stage5ChapterFix.details, ...stage5MarkdownFix.details, ...stage5NumericFix.details])];
    upsertProgressStage(session.progressStages, displayStage({ type: 'validation', roleId: 'deterministic-consistency-fix', status: 'success', message: `交付前确定性清洗：${totalFixed} 处（${totalDetails.slice(0, 4).join('、')}）`, details: totalDetails.slice(4) }, { subtitle: '交付前确定性清洗' }));
  }
  // 来源罗列话术确定性清洗兜底（十一度实测缺陷）：patch 类修复更新章节内容后若 未触发 rebuild，最终校验用
  // markdown 可能残留“依据招标文件…”罗列句被导出门禁硬阻断；交付前用与导出侧一致的清洗函数兜底再重算
  const cleanedFinalMarkdown = cleanFormalSourcePhrases(session.finalMarkdown);
  if (cleanedFinalMarkdown !== session.finalMarkdown) {
    session.finalMarkdown = cleanedFinalMarkdown;
    await session.recomputeFinalValidationBundle();
  }
}
