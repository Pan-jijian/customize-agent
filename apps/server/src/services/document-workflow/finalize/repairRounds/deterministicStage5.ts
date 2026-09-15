/**
 * repairRounds/deterministicStage5：交付前确定性清洗轮（FINALIZE_REPAIR_ROUNDS: deterministic-stage5 + formal-source-clean）。
 * P2 拆分（方案 5.2）：由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 * 修复器清单与顺序由 SURFACE_FIX_STEPS（deterministicFixChains）注册表单源定义。
 */
import { applyDeterministicConsistencyFixes, applyDeterministicConsistencyFixesToMarkdown } from '../../qualityValidation';
import { applyNumericConsistencyDeterministicFixes, extractGreeningMaintenanceAuthority, stripDuplicateTablesAcrossChapters, runFixUntilClean, collectLocalBasisRegulations } from '../../documentIntegrityChecks';
import { blueprintLaborPeakAuthority, blueprintPhaseLaborAuthorities, buildAuthorityIndex } from '../../authorityIndex';
import { blueprintCitationVerdict, type QuantityConflictAnchor } from '../../integratedBlueprint';
import { fixScoringRequirementResponses } from '../../tenderRequirements';
import { cleanFormalSourcePhrases } from '../../markdownComposer';
import { SURFACE_FIX_STEPS, type SurfaceFixerContext } from '../../deterministicFixChains';
import { buildResourceBreakdownAuthority } from '../../resourceBreakdownNumbers';
import { displayStage, upsertProgressStage } from '../../progress';
import type { FinalizeSession } from '../finalizeSession';

export async function stageDeterministicStage5(session: FinalizeSession): Promise<void> {
  // 阶段 5 交付前确定性清洗（数值定点兜底）：blocker 修复循环已删除，导出前做最后一次确定性定点修复，
  // 修复后重算校验组，避免残留冲突被导出门禁硬阻断。章节级修复原地改正文后重建全文，
  // 全文级修复覆盖封面/信息表合成区的败选数值（章节修复覆盖不到），最后定点替换跨章数值矛盾。
  const stage5ChapterFix = await applyDeterministicConsistencyFixes(session.finalChapterDrafts, session.factsModel, session.scopeConflicts);
  // D1 劳动力峰值三层锚点统一：蓝图 labor.peakValue（清单工效推导）> 分阶段投入明细表峰值 > 正文表述。
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
    // 第十六版诊断盲区修复：stage 双写 progressStages + finalGateRepairStages——
    // 该段历史仅写 progressStages，而最终阶段列表 finalStages=executionStages+finalGateRepairStages，
    // 导致生成后复盘无法从执行阶段看到补写是否发生（B 专题「补写器是否执行」诊断盲区根因）
    const scoringFixStage = displayStage({ type: 'validation', roleId: 'scoring-requirement-fix', status: 'success', message: `评分项响应确定性补写：${stage5ScoringFix.fixedCount} 条（${stage5ScoringFix.details.slice(0, 3).join('、')}）`, details: stage5ScoringFix.details.slice(3) }, { subtitle: '交付前确定性清洗' });
    upsertProgressStage(session.progressStages, scoringFixStage);
    upsertProgressStage(session.finalGateRepairStages, scoringFixStage);
  }
  // B6 交付前确定性清洗（丰乐镇第五轮实测）：跨章表格去重/断行残片合并/叠词收敛此前只有
  // 检测器无修复器——「工程名称表两处重复」「延长有效作业时间 |残行」「分部分项叠词误报」
  // 被导出门禁硬阻断且修复轮循环无效；检测定位=修复定位同源，章节级原地修复后统一重建全文，
  // 重建发生在全文级数值修复之前，避免覆盖 stage5MarkdownFix/stage5NumericFix 的修复成果。
  const stage5TableDup = stripDuplicateTablesAcrossChapters(session.finalChapterDrafts);
  // 交付前确定性清洗链（P10 单源）：修复器清单与顺序由 SURFACE_FIX_STEPS 注册表统一定义，
  // 逐章闭环（每个修复器 runFixUntilClean 2 轮自收敛），权威口径与检测器同源注入
  session.surfaceFixContext = {
    laborPeakAuthority: session.laborPeakAuthority,
    // V5 P4b-2 阶段劳动力权威（蓝图 byPhase 推导投影；与检测器 phase-labor-mixing 同源，
    // phase-labor-values 定点回写消费）
    phaseLaborAuthorities: blueprintPhaseLaborAuthorities(session.blueprintData),
    greeningMaintenanceAuthority: session.greeningMaintenanceAuthority,
    // A3 资源拆分权威（蓝图资源清单推导；与检测器 resourceBreakdownConsistencyIssues 同源同扫描）
    resourceBreakdownAuthority: buildResourceBreakdownAuthority(session.blueprintData),
    // A4 支护形式选定值（支护体系权威映射；缺失时两可表述按正文主流侧默认归一）
    supportFormAuthority: session.supportAuthority === 'slope' ? '放坡' : session.supportAuthority === 'pile' ? '钢板桩' : undefined,
    // 4.36 D3 决策锁条目（rebuildFacts 阶段已计算；两可表述归一按锁定值裁决——有锁归一/无锁缺口，
    // 与检测器 ambiguous-either-or 同源）
    decisionLockEntries: session.decisionLockEntries,
    // 4.27.2 句化标题切分权威（规划小节标题全集）：模板/生效章节/最终草稿三源合并去重
    // （与装配层 markdownComposer 前缀匹配消费同一规划标题数据源），sentence-like-heading-split 消费
    plannedSectionTitles: [...new Set([
      ...(session.effectiveChapters || []).flatMap(chapter => chapter.sections || []),
      ...session.template.chapters.flatMap(chapter => chapter.sections || []),
      ...session.finalChapterDrafts.flatMap(chapter => chapter.sections || []),
    ].filter(Boolean))],
    // 4.31 招标文件引用法规清单（#71 编制依据地方性法规补写；与检测器 basisRegulationsCoverageIssues 同源）
    // 4.32 #56 死结根治：章级检索证据在 stage5 时点已全部入池——从全量证据二次提取含本建设
    // 地点地名的地方法规条目与蓝图清单合并（4.31 只吃蓝图清单，章级召回的《合肥市公共资源
    // 交易管理条例》彼时不在其中，fixer 静默、检测死结）
    basisRegulations: collectLocalBasisRegulations(
      session.blueprintData?.basisRegulations,
      session.allEvidence.map(item => String(item.content || '')).join('\n'),
      session.blueprintData?.project.location || '',
    ),
  };
  const surfaceFixCounts = new Map<string, number>();
  const addSurfaceFixCount = (key: string, count: number) => { if (count > 0) surfaceFixCounts.set(key, (surfaceFixCounts.get(key) ?? 0) + count); };
  // 4.36 A2 章片段重放章号：章片段无「## 第N章」行，section-renumber 需按章序整段重放（章序=草案下标+1
  // = 装配层「## 第{index+1}章」渲染序 = 终检 sectionNumberingIssues 口径，三源同值）；
  // 按章派生 ctx 不写回 session.surfaceFixContext——round-2 全文链复用共享对象时保持不注入（走章标题解析）
  let chapterSeq = 0;
  for (const chapter of session.finalChapterDrafts) {
    chapterSeq += 1;
    const chapterContext: SurfaceFixerContext = { ...session.surfaceFixContext, chapterNumber: chapterSeq };
    for (const step of SURFACE_FIX_STEPS) {
      if (!step.stage5) continue;
      const fix = runFixUntilClean(markdown => step.fix(markdown, chapterContext), chapter.content, 2);
      if (fix.fixedCount > 0) { chapter.content = fix.markdown; addSurfaceFixCount(step.key, fix.fixedCount); }
    }
  }
  const countOf = (key: string) => surfaceFixCounts.get(key) ?? 0;
  const stage5ResidueCount = countOf('table-line-residue');
  const stage5FinishFixCount = countOf('finish-thickness');
  const stage5LaborFixCount = countOf('labor-peak');
  const stage5PhaseLaborFixCount = countOf('phase-labor-values');
  const stage5ResourceFixCount = countOf('resource-breakdown');
  const stage5AmbiguousFixCount = countOf('ambiguous-either-or');
  const stage5SelfFixCount = countOf('self-undermining');
  const stage5EmptyRespCount = countOf('empty-scoring-response');
  const stage5TenderMetaCount = countOf('tender-meta-language');
  const stage5DupResponseCount = countOf('duplicate-response-line');
  const stage5AtlasRefCount = countOf('atlas-reference');
  const stage5MetaFixCount = countOf('meta-discourse');
  const stage5FormulaFixCount = countOf('formula-residue');
  const stage5OpeningFixCount = countOf('paragraph-opening-repeat');
  const stage5TruncatedFixCount = countOf('truncated-sentence');
  const stage5TableRowDupCount = countOf('internal-table-row-dup');
  const stage5MaintenanceFixCount = countOf('greening-maintenance');
  const stage5TailRepeatCount = countOf('paragraph-tail-repeat');
  const stage5SlotDepthCount = countOf('slot-depth-value');
  const stage5DupInfoTableCount = countOf('duplicate-basic-info-tables');
  const stage5FallbackRowCount = countOf('fallback-placeholder-rows');
  const stage5HeadingCoverCount = countOf('heading-uncovered-items');
  const stage5BasisRegCount = countOf('basis-regulation-region');
  const stage5ForbiddenCfgCount = countOf('forbidden-configuration');
  const stage5WorkInjuryCount = countOf('work-injury-insurance');
  // 4.36 复查补全（诊断可见性）：以下 6 步此前无计数引用，仅它们命中时重建门不触发（下）
  const stage5TemplatedLabelCount = countOf('templated-labels');
  const stage5StructureCleanCount = countOf('structure-integrity');
  const stage5RepeatedWordCount = countOf('repeated-words');
  const stage5CollisionHeadingCount = countOf('collision-numbered-heading');
  const stage5InvertedDateCount = countOf('inverted-date-range');
  const stage5InternalTermCount = countOf('internal-term-heading');
  // 4.36 A2 小节编号重放（链尾）：删行类修复器造成编号空档时的原子重排计数
  const stage5SectionRenumberCount = countOf('section-renumber');
  // 重建判定（4.36 复查修正）：由「逐键列举」改为「注册表计数集合任意命中」——历史缺陷：门条件漏列
  // 6 个步骤键（templated-labels/structure-integrity/repeated-words/collision-numbered-heading/
  // inverted-date-range/internal-term-heading），仅这些步命中时章节侧修复不触发 rebuild、不进入
  // finalMarkdown（修复丢失且检测复报死区；「叠词收敛命中即参与重建判定」的注释口径此前未兑现）；
  // 集合判定与 SURFACE_FIX_STEPS 天然同步，新增步骤零维护、防复发
  if (stage5TableDup.removedCount > 0 || surfaceFixCounts.size > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    const stage5SurfaceFixStage = displayStage({ type: 'validation', roleId: 'deterministic-surface-fix', status: 'success', message: `交付前确定性清洗：跨章表格去重 ${stage5TableDup.removedCount} 行、断行残片合并 ${stage5ResidueCount} 处、装饰层厚度修复 ${stage5FinishFixCount} 处、埋深槽位错位删除 ${stage5SlotDepthCount} 处、劳动力峰值统一 ${stage5LaborFixCount} 处、阶段劳动力统一 ${stage5PhaseLaborFixCount} 处、资源数值统一 ${stage5ResourceFixCount} 处、两可表述归一 ${stage5AmbiguousFixCount} 处、段首机械重复剥离 ${stage5OpeningFixCount} 处、截断句残留收敛 ${stage5TruncatedFixCount} 处、元话语声明清洗 ${stage5MetaFixCount} 处、公式形态清洗 ${stage5FormulaFixCount} 处、自伤句式改写 ${stage5SelfFixCount} 处、空响应句改写 ${stage5EmptyRespCount} 处、招标元语言清理 ${stage5TenderMetaCount} 处、重复响应行去重 ${stage5DupResponseCount} 行、图集引用清洗 ${stage5AtlasRefCount} 处、表内重复行删除 ${stage5TableRowDupCount} 行、基础信息表合并 ${stage5DupInfoTableCount} 组、兜底话术表行删除 ${stage5FallbackRowCount} 行、绿化养护期统一 ${stage5MaintenanceFixCount} 处、标题工程类别覆盖修正 ${stage5HeadingCoverCount} 处、编制依据法规补写 ${stage5BasisRegCount} 处、配置禁用词清洗 ${stage5ForbiddenCfgCount} 处、工伤保险缴纳表述补写 ${stage5WorkInjuryCount} 处、小节编号重放 ${stage5SectionRenumberCount} 行、段内句级复读剥离 ${stage5TailRepeatCount} 处、模板标签清洗 ${stage5TemplatedLabelCount} 处、结构完整性清理 ${stage5StructureCleanCount} 处、重复编号标题删除 ${stage5CollisionHeadingCount} 行、倒置日期区间修复 ${stage5InvertedDateCount} 处、内部术语标题替换 ${stage5InternalTermCount} 处、叠词收敛 ${stage5RepeatedWordCount} 处` }, { subtitle: '交付前确定性清洗' });
    // 4.36.2 复查修正：finalStages=executionStages(快照)+finalGateRepairStages，修复轮事件必须双写
    upsertProgressStage(session.progressStages, stage5SurfaceFixStage);
    upsertProgressStage(session.finalGateRepairStages, stage5SurfaceFixStage);
  }
  const stage5MarkdownFix = await applyDeterministicConsistencyFixesToMarkdown(session.finalMarkdown, session.factsModel, session.scopeConflicts);
  if (stage5MarkdownFix.fixedCount > 0) session.finalMarkdown = stage5MarkdownFix.markdown;
  // S5 蓝图引用语义判定（全文坐标=finalMarkdown）：工程量冲突锚点直连确定性修复；判定记录
  // 双写进度阶段（修复轮事件须入持久化 executionStages，复盘可见）
  let stage5CitationAnchors: QuantityConflictAnchor[] = [];
  if (session.blueprintData) {
    const stage5CitationVerdict = await blueprintCitationVerdict(session.finalMarkdown, session.blueprintData, {
      diagnostics: session.generationDiagnostics,
      signal: session.signal,
      onAdjudication: summary => {
        console.log(`[gen] citation-adjudication(stage5): 候选 ${summary.total} 条（冲突 ${summary.conflicts}、未决 ${summary.uncertain}、一致 ${summary.consistent}）`);
        const citationStage = displayStage({ type: 'validation', roleId: 'citation-adjudication', status: summary.conflicts > 0 ? 'failed' : 'success', message: `蓝图引用语义判定：候选 ${summary.total} 条（冲突 ${summary.conflicts}、未决 ${summary.uncertain}、一致 ${summary.consistent}）${summary.unavailable ? `；判定不可用：${summary.unavailable}` : ''}`, details: summary.records.filter(record => record.conclusion !== 'consistent').slice(0, 20).map(record => `[${record.conclusion}] ${record.subject}：${record.rationale}`) }, { subtitle: '交付前确定性清洗' });
        upsertProgressStage(session.progressStages, citationStage);
        upsertProgressStage(session.finalGateRepairStages, citationStage);
      },
    });
    stage5CitationAnchors = stage5CitationVerdict.anchors;
  }
  // 跨章数值矛盾（劳动力峰值/节点工期/材料设备数量）确定性定点替换：检测定位=修复定位同源；
  // 工程量引用以判定层锚点直连（finalMarkdown 即全文，无需章级重定位）
  const stage5NumericFix = applyNumericConsistencyDeterministicFixes(session.finalMarkdown, { authorityIndex: session.blueprintData ? buildAuthorityIndex(session.blueprintData) : undefined, scheduleAuthority: session.scheduleAuthority, assemblyRateAuthority: session.assemblyRateAuthority, supportAuthority: session.supportAuthority, quantityAnchors: stage5CitationAnchors });
  if (stage5NumericFix.fixedCount > 0) session.finalMarkdown = stage5NumericFix.markdown;
  // B3 表格承载正文机器拼段兜底已删除（V2 批1-4 零兜底写入）：全表格小节由检测器
  // major-content-governance 阻断，交写作侧约束（主要施工内容须段落承载）与 LLM 定向重写
  if (stage5ChapterFix.fixedCount > 0 || stage5MarkdownFix.fixedCount > 0 || stage5NumericFix.fixedCount > 0) {
    await session.recomputeFinalValidationBundle();
    const totalFixed = stage5ChapterFix.fixedCount + stage5MarkdownFix.fixedCount + stage5NumericFix.fixedCount;
    const totalDetails = [...new Set([...stage5ChapterFix.details, ...stage5MarkdownFix.details, ...stage5NumericFix.details])];
    const stage5ConsistencyFixStage = displayStage({ type: 'validation', roleId: 'deterministic-consistency-fix', status: 'success', message: `交付前确定性清洗：${totalFixed} 处（${totalDetails.slice(0, 4).join('、')}）`, details: totalDetails.slice(4) }, { subtitle: '交付前确定性清洗' });
    upsertProgressStage(session.progressStages, stage5ConsistencyFixStage);
    upsertProgressStage(session.finalGateRepairStages, stage5ConsistencyFixStage);
  }
  // 来源罗列话术确定性清洗兜底（十一度实测缺陷）：patch 类修复更新章节内容后若 未触发 rebuild，最终校验用
  // markdown 可能残留“依据招标文件…”罗列句被导出门禁硬阻断；交付前用与导出侧一致的清洗函数兜底再重算
  const cleanedFinalMarkdown = cleanFormalSourcePhrases(session.finalMarkdown);
  if (cleanedFinalMarkdown !== session.finalMarkdown) {
    session.finalMarkdown = cleanedFinalMarkdown;
    await session.recomputeFinalValidationBundle();
    // 4.36.2 复查修正（诊断可见性）：清洗器修改最终成稿后此前无任何事件，复盘不可见（同 stage5 scoring 先例）——
    // 修复轮事件（快照后）必须双写，单写 progressStages 不进入持久化 executionStages
    const formalSourceCleanStage = displayStage({ type: 'validation', roleId: 'formal-source-clean', status: 'success', message: '来源罗列话术确定性清洗兜底：最终成稿来源罗列残留已收敛' }, { subtitle: '交付前确定性清洗' });
    upsertProgressStage(session.progressStages, formalSourceCleanStage);
    upsertProgressStage(session.finalGateRepairStages, formalSourceCleanStage);
  }
}
