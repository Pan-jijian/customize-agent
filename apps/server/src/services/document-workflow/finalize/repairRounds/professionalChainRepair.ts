/**
 * repairRounds/professionalChainRepair：工序链与项目属性适配修复轮（D-T9，根治 #30/#31）。
 *
 * 背景（r28f 实机归因）：终检 construction-org-professional-chain 两处缺陷无修复轮消费（哑火），
 * 且旧判定为全文级口径误报族——#30 全文级 forbidden 词跨章叠加（质保法定话术「主体结构」+
 * 混合项目公厕房建单位工程「外脚手架」）被判为市政错位；#31 链词表组合词全字面匹配
 *（「防水闭水」）漏判自然写作用词「防水」「铺装」。
 *
 * D-T9 收口：检测端升级为节级 mixed（域约束绑定工序组织节）+ 文档级 insufficient（词表簇化，
 * professionalChainScan 单源扫描，warning 带 chapterId + provenance）。本轮链尾消费——章级定位
 *（chapterId 直连 + 扫描实时重算剔除过期快照）→ LLM 定向修复（错位节改写为匹配工序 / 缺失链
 * 环节自然补写，标准工序名落位）→ 复检缺陷数（下降才继续；变差回滚，汉字数大幅减少=删除式
 * 修复同判回滚）→ 落地后 rebuild + recompute（终检重跑判定，适配后清除 warning）。
 * 位置在 content-depth-repair 之后（同族补写轮）、post-review-surface 之前（其复读剥离/
 * 格式清洗覆盖本轮补写引入的残留）。
 */
import { repairOutcomeReason, repairOutcomeStatus } from './repairOutcome';
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { professionalChainScan, type ProfessionalChainDeficit } from '../../constructionOrgQualityRules';
import type { DocumentDraftChapter } from '../../types';
import type { FinalizeSession } from '../finalizeSession';

/** 每章定向修复轮上限（缺陷可能多节多项：每轮修复全部当前缺陷，复检清零即停） */
const MAX_CHAIN_REPAIR_ROUNDS = 2;

/** 汉字数守卫阈值（删除式修复判定）：修复轮为增量修复/改写，汉字数大幅减少即视为改写事故回滚 */
const HAN_SHRINK_TOLERANCE = 40;

function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
}

/** 缺陷度（复检残差单源）：mixed=命中禁配词数；insufficient=缺失链环节数 */
function deficitWeight(deficit: ProfessionalChainDeficit): number {
  return deficit.kind === 'mixed' ? deficit.hits.length : deficit.missing.length;
}

/** 定向修复指令：缺陷分型描述（错位节改写 / 缺链补写）+ 局部修改约束 + 标准工序名落位要求 */
function instructionFor(draftChapter: DocumentDraftChapter, deficits: ProfessionalChainDeficit[]): string {
  const lines: string[] = [
    '【工序链与项目属性适配定向修复】',
    `《${draftChapter.title}》存在下列工序链与项目属性不匹配问题，请在对应位置自然修复：`,
  ];
  for (const deficit of deficits) {
    if (deficit.kind === 'mixed') {
      lines.push(`- 小节「${deficit.sectionTitle}」疑似${deficit.label}内容混入不匹配工序（命中：${deficit.hits.join('、')}）：${deficit.prompt}请按本节所属工程类型的正确工序链改写相关工序叙述，保持本节其余内容不变。`);
    } else {
      lines.push(`- ${deficit.label}工序链覆盖不足（已识别：${deficit.hits.join('、') || '未识别到关键工序'}；缺：${deficit.missing.join('、')}）：${deficit.prompt}请在本章内自然补写缺失工序环节，形成完整工序链。`);
    }
  }
  lines.push(
    '修复要求：',
    '1. 只做局部修改：在对应小节内改写错位叙述或扩写补实，或自然融入一段补写文字；不得新增、删除或合并小节，不得改动无关内容；',
    '2. 工序叙述须结合本章既有语境（工程部位、材料、机具、检查要求），与既有句子自然衔接，不得出现“本节按…重新组织”类改写痕迹；',
    '3. 工序环节按标准工序名落位（如“基层处理”“成品保护”“回填”），不得以近义改述代替；',
    '4. 禁止「按招标文件要求：」类条幅前缀与任何元话语，必须为正式施工组织设计正文行文，不得编造参数。',
  );
  return lines.join('\n');
}

export async function stageProfessionalChainRepair(session: FinalizeSession): Promise<void> {
  // 文档文本单源（与检测端 constructionOrgProfessionalChainIssues 同口径：markdown + 事实值）
  const projectValues = (session.factsModel?.project || []).map(fact => fact.value);
  const preciseValues = (session.factsModel?.preciseFacts || []).map(fact => fact.value);
  const factsText = `${projectValues.join(' ')} ${preciseValues.join(' ')}`;
  // 消费集合：provenance 精确过滤（检测端节级/文档级判定产出的 warning，非 blocker）
  const warnings = session.validationIssues.filter(issue => issue.provenance?.detectorId === 'construction-org-professional-chain' && issue.chapterId);
  // 章级定位 + 实时重算（快照过期剔除：重算后已适配的章不再注入修复）
  const initialScan = professionalChainScan({ chapters: session.finalChapterDrafts, documentText: `${session.finalMarkdown} ${factsText}` });
  const targets = new Map<number, ProfessionalChainDeficit[]>();
  for (const issue of warnings) {
    const index = session.finalChapterDrafts.findIndex(chapter => chapter.id === issue.chapterId);
    if (index < 0) continue;
    const deficits = initialScan.filter(item => item.chapter.id === issue.chapterId);
    if (deficits.length === 0) continue;
    if (!targets.has(index)) targets.set(index, deficits);
  }
  if (targets.size === 0) {
    // 全链适配（或快照过期已达线）：写验收事件（D-T9 验收判据「属性错位 0」显性出口）
    const passStage = displayStage({ type: 'validation', roleId: 'professional-chain-repair', status: 'success', message: '工序链适配验收通过：各章工序链与项目属性一致' }, { subtitle: '工序链适配核验' });
    upsertProgressStage(session.progressStages, passStage);
    upsertProgressStage(session.finalGateRepairStages, passStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  let repairedChapters = 0;
  let unresolvedChapters = 0;
  for (const [chapterIndex, initialDeficits] of targets) {
    const draftChapter = session.finalChapterDrafts[chapterIndex];
    if (!draftChapter) continue;
    // 残差单源：全量扫描（节级+文档级与检测端同源）后取本章缺陷总数
    const scanWith = (content: string): ProfessionalChainDeficit[] => {
      const chapters = session.finalChapterDrafts.map((chapter, index) => (index === chapterIndex ? { ...chapter, content } : chapter));
      const documentText = `${chapters.map(chapter => chapter.content || '').join('\n\n')} ${factsText}`;
      return professionalChainScan({ chapters, documentText }).filter(item => item.chapter.id === draftChapter.id);
    };
    const residualOf = (content: string): number => scanWith(content).reduce((sum, deficit) => sum + deficitWeight(deficit), 0);
    let chapterContent = draftChapter.content;
    let beforeResidual = residualOf(chapterContent);
    // 防御：快照与当前正文不同源时跳过（交由终门禁照常复核）
    if (beforeResidual === 0) continue;
    let rounds = 0;
    let chapterRepaired = false;
    let anyRollback = false;
    const roleId = `agent-professional-chain-repair-${draftChapter.id}`;
    const residualTrajectory = [beforeResidual];
    while (rounds < MAX_CHAIN_REPAIR_ROUNDS) {
      rounds += 1;
      // 当前残留缺陷（每轮以最新文本重新定位，检测定位=修复定位）
      const pendingDeficits = scanWith(chapterContent);
      if (pendingDeficits.length === 0) break;
      const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `工序链适配修复中（第 ${rounds}/${MAX_CHAIN_REPAIR_ROUNDS} 轮）：${draftChapter.title}（${pendingDeficits.map(deficit => deficit.kind === 'mixed' ? `「${deficit.sectionTitle}」错位` : `${deficit.label}缺${deficit.missing.length}项`).join('、')}）` }, { subtitle: '工序链适配核验' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const outcome = await withPatchRollback({
        originalContent: chapterContent,
        repairRound: 'professional-chain-repair',
        diagnostics: session.generationDiagnostics,
        beforeMetrics: [beforeResidual, -hanCount(chapterContent)],
        apply: async () => {
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: draftChapter.id, title: draftChapter.title, content: chapterContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
            issues: pendingDeficits.map(deficit => deficit.kind === 'mixed' ? `「${deficit.sectionTitle}」疑似${deficit.label}内容混入不匹配工序：${deficit.hits.join('、')}` : `${deficit.label}工序链覆盖不足：缺 ${deficit.missing.join('、')}`),
            promptTexts: instructionFor(draftChapter, pendingDeficits),
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（正文表格口径）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('professional-chain-repair', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
        },
        // 指标 1：缺陷总数（越大越差）；指标 2：负汉字数（汉字数大幅减少=删除式修复，越大越差）
        recheck: (content) => [residualOf(content), -hanCount(content)],
        shouldRollback: (before, after) => after[0] > before[0] || after[1] > before[1] + Math.max(HAN_SHRINK_TOLERANCE, Math.abs(before[1]) * 0.03),
      });
      if (outcome.rolledBack) anyRollback = true;
      if (outcome.rolledBack || outcome.content === chapterContent) break;
      chapterContent = outcome.content;
      session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: chapterContent };
      chapterRepaired = true;
      const afterResidual = outcome.afterMetrics[0] ?? residualOf(chapterContent);
      residualTrajectory.push(afterResidual);
      // 收敛判定：清零即通过；未下降（含回滚/空修复）即停止；下降且未达上限 → 再修一轮
      if (afterResidual === 0 || afterResidual >= beforeResidual || rounds >= MAX_CHAIN_REPAIR_ROUNDS) break;
      beforeResidual = afterResidual;
    }
    if (chapterRepaired) repairedChapters += 1;
    const finalResidual = chapterRepaired ? (residualTrajectory[residualTrajectory.length - 1] ?? beforeResidual) : beforeResidual;
    if (finalResidual > 0) unresolvedChapters += 1;
    const residualNote = `残留工序链缺陷 ${finalResidual} 项（由终门禁照常复核）`;
    let message: string;
    if (finalResidual === 0 && chapterRepaired) message = `工序链适配修复完成：${draftChapter.title}（${rounds} 轮修复后缺陷清零，工序链与项目属性一致）`;
    else if (chapterRepaired) message = `工序链适配修复部分生效：${draftChapter.title}（残留轨迹 ${residualTrajectory.join('→')}，已执行 ${rounds} 轮；${residualNote}）`;
    else if (anyRollback) message = `工序链适配修复已回滚：${draftChapter.title}（修复后缺陷数未下降或汉字大幅减少，保留修复前正文；${residualNote}）`;
    else message = `工序链适配修复未生效：${draftChapter.title}（模型未产生有效修改；${residualNote}）`;
    const completedStage = displayStage({ type: 'llm_review', roleId, status: repairOutcomeStatus({ before: initialDeficits.length, after: finalResidual }), message, details: initialDeficits.map(deficit => `缺陷：${deficit.kind === 'mixed' ? `「${deficit.sectionTitle}」${deficit.label}内容混入不匹配工序（${deficit.hits.join('、')}）` : `${deficit.label}缺${deficit.missing.join('、')}`}`) }, { subtitle: '工序链适配核验' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  // 终态残留=重算后全文扫描（与检测端同源；残留由终门禁照常复核）
  const residualChains = professionalChainScan({ chapters: session.finalChapterDrafts, documentText: `${session.finalMarkdown} ${factsText}` }).length;
  session.generationDiagnostics.llm.lastInfo = `工序链与项目属性适配修复：${targets.size} 章缺陷定位，${repairedChapters} 章次落地修复，${unresolvedChapters} 章残留，终态残留 ${residualChains} 条工序链缺陷（由终门禁照常复核）`;
}
