/**
 * repairRounds/requirementVerification：生成后用户要求执行核验闭环（C3）。
 *
 * 背景（用户提示词作用小的收口治理）：A2/A3 已把用户提示词解析为结构化要求并在生成全链注入
 * （最高优先级），但注入不等于落实——模型可能选择性忽略要求。本轮在 finalize 修复链末尾对
 * 每章正文逐条核验「全局要求 + 章级要求」的落实状态：未满足条目进入 LLM 定向补写修复轮
 * （V5 P4.2 收敛修复：每章最多 2 轮，修复落地后复验，复验残留数下降才继续下一轮，不降/回滚即停止，
 * 残留转 warning 兜底不阻断交付），核验与修复结果回写进度 stage 与诊断信息（生效报告）。
 *
 * 核验以 LLM 零温度 JSON 调用执行；修复沿用 repairChapterByQuality + patchGuard + 回滚保护
 * 既有惯例。无 requirementSemantics（提示词过短未解析/解析失败）时本轮零成本跳过。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { callDocumentLlmJson } from '../../llmClient';
import type { FinalizeSession } from '../finalizeSession';

/** 核验结果：每条要求的落实状态 */
interface RequirementVerificationResult {
  satisfied: boolean;
  unmet: string[];
}

/** 要求关键词提取（同步回滚复检用）：2+ 字 token 去重截断，前后同口径计数即可 */
function requirementKeywords(requirements: string[]): string[] {
  return [...new Set(requirements
    .flatMap(req => req.match(/[\p{Script=Han}]{2,}|[A-Za-z]{3,}|\d+(?:\.\d+)?/gu) || [])
    .filter(Boolean))]
    .slice(0, 60);
}

/** 章级用户要求汇总：全局要求 + 匹配本章的章级要求（标题包含匹配） */
function chapterRequirementTexts(session: FinalizeSession, chapterTitle: string): string[] {
  const plan = session.requirementSemantics;
  if (!plan) return [];
  const chapterReqs = (plan.chapterRequirements || [])
    .filter(item => item.chapterTitle && (chapterTitle.includes(item.chapterTitle) || item.chapterTitle.includes(chapterTitle)))
    .flatMap(item => item.requirements);
  return [...new Set([...(plan.globalRequirements || []), ...chapterReqs])].filter(Boolean).slice(0, 24);
}

/** V5 P4.2 收敛修复：每章定向补写轮上限（修复落地后复验，复验残留数下降才继续下一轮；不降/回滚即停止转 warning 兜底） */
const MAX_REQUIREMENT_REPAIR_ROUNDS = 2;

export async function stageRequirementVerification(session: FinalizeSession): Promise<void> {
  const plan = session.requirementSemantics;
  if (!plan || !plan.parsed || ((plan.globalRequirements || []).length === 0 && (plan.chapterRequirements || []).length === 0)) return;
  const totalRequirements = [...(plan.globalRequirements || []), ...(plan.chapterRequirements || []).flatMap(item => item.requirements)].filter(Boolean).length;
  // 核验调用（首核验与修复后复验同源同 prompt）：LLM 零温度 JSON 逐条判定要求落实状态
  const verifyChapterRequirements = (chapterTitle: string, content: string, requirements: string[]) => session.withProgressHeartbeat(() => callDocumentLlmJson<RequirementVerificationResult>([
    '你是投标文档用户要求核验专家。逐条核对「用户要求」是否已在章节正文中落实。',
    '判定口径：正文存在明确满足该要求的实质性内容即算落实；仅泛泛提及、半句带过、被其他内容顶替均算未落实。',
    '不得因为正文有其他内容就降低标准；用户要求是最高优先级，未落实必须如实列入 unmet。',
    '只返回 JSON：{"satisfied":true/false,"unmet":["未落实要求原文"]}。',
  ].join('\n\n'), [
    `章节标题：${chapterTitle}`,
    `用户要求（逐条核验）：\n${requirements.map((req, index) => `${index + 1}. ${req}`).join('\n')}`,
    `章节正文：\n${content.slice(0, 12000)}`,
  ].filter(Boolean).join('\n\n'), {
    maxTokens: 1200,
    temperature: 0,
    signal: session.signal,
    diagnostics: session.generationDiagnostics,
    prefixKey: 'requirement-verification',
  }));
  // 定向补写轮执行（沿既有惯例：repairChapterByQuality + patchGuard + 回滚保护；要求关键词命中数下降即回滚）
  const repairUnmetRequirements = (draftChapter: FinalizeSession['finalChapterDrafts'][number], unmet: string[], currentContent: string, round: number) => {
    const requirementInstruction = [
      '【用户要求定向补写修复】',
      ...(round > 1 ? [`本轮为第 ${round} 轮（最多 ${MAX_REQUIREMENT_REPAIR_ROUNDS} 轮）：上一轮补写后复验仍判定未落实，请务必逐条直接补写实质性内容。`] : []),
      '下列用户要求经核验未在本章正文中落实。请逐条在正文最合适的位置补充落实，用户要求是最高优先级：',
      '用户要求与系统默认规则冲突时以用户要求为准；已落实内容不得删除或改写；只做局部修改，不得新增、删除或合并小节。',
      unmet.map(req => `- ${req}`).join('\n'),
      ...(plan?.styleRequirements?.length ? [`\n风格要求（补写内容同样必须遵守）：\n${plan.styleRequirements.map(style => `- ${style}`).join('\n')}`] : []),
    ].join('\n');
    const keywords = requirementKeywords(unmet);
    const beforeHits = keywords.reduce((sum, keyword) => sum + (currentContent.includes(keyword) ? 1 : 0), 0);
    return withPatchRollback({
      originalContent: currentContent,
      repairRound: 'requirement-verification',
      diagnostics: session.generationDiagnostics,
      beforeMetrics: [beforeHits],
      apply: async () => {
        const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
          template: session.template,
          chapter: { id: draftChapter.id, title: draftChapter.title, content: currentContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
          issues: unmet.map(req => `用户要求未落实：${req}`),
          promptTexts: requirementInstruction,
          requirement: session.requirement,
          forbidDrawingImages: false,
          diagnostics: session.generationDiagnostics,
          signal: session.signal,
          patchGuard: repairPatchGuard('requirement-verification', session.generationDiagnostics),
        }));
        return repaired.content && repaired.content !== currentContent ? repaired.content : currentContent;
      },
      recheck: (content) => {
        const hits = keywords.reduce((sum, keyword) => sum + (content.includes(keyword) ? 1 : 0), 0);
        return [hits];
      },
      // 指标语义：要求关键词命中数越低越差 → 修复后命中数下降即回滚（默认判定为指标上升即回滚，需显式覆盖）
      shouldRollback: (before, after) => after[0] < before[0],
    });
  };
  let verifiedChapters = 0;
  let satisfiedChapters = 0;
  let repairedChapters = 0;
  for (const draftChapter of session.finalChapterDrafts) {
    const chapterRequirements = chapterRequirementTexts(session, draftChapter.title);
    if (chapterRequirements.length === 0) continue;
    verifiedChapters += 1;
    const chapterIndex = session.finalChapterDrafts.findIndex(chapter => chapter.id === draftChapter.id);
    if (chapterIndex < 0) continue;
    const runningStage = displayStage({ type: 'llm_review', roleId: `agent-requirement-verification-${draftChapter.id}`, status: 'running', message: `用户要求执行核验：${draftChapter.title}（${chapterRequirements.length} 条要求）`, details: chapterRequirements.map(req => `- ${req}`) }, { subtitle: '用户要求核验' });
    upsertProgressStage(session.progressStages, runningStage);
    upsertProgressStage(session.finalGateRepairStages, runningStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    // 首核验：LLM 零温度 JSON 逐条判定要求落实状态
    const verification = await verifyChapterRequirements(draftChapter.title, draftChapter.content, chapterRequirements);
    const unmet = Array.isArray(verification?.unmet) ? verification.unmet.filter(Boolean).slice(0, 12) : [];
    if (!verification || verification.satisfied === true || unmet.length === 0) {
      satisfiedChapters += 1;
      const okStage = displayStage({ type: 'llm_review', roleId: `agent-requirement-verification-${draftChapter.id}`, status: 'success', message: `用户要求核验通过：${draftChapter.title}（${chapterRequirements.length} 条要求全部落实）`, details: chapterRequirements.map(req => `- ${req}`) }, { subtitle: '用户要求核验' });
      upsertProgressStage(session.progressStages, okStage);
      upsertProgressStage(session.finalGateRepairStages, okStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      continue;
    }
    // 未满足 → 定向补写轮（V5 P4.2 收敛修复：≤2 轮，修复落地后复验，复验残留数下降才继续下一轮）
    let chapterContent = draftChapter.content;
    let pending = unmet;
    let residualUnmet = unmet;
    let rounds = 0;
    let chapterRepaired = false;
    let anyRollback = false;
    let verifiedSatisfied = false;
    let stopKind: 'verified' | 'no-drop' | 'limit' | 'not-landed' = 'not-landed';
    while (pending.length > 0 && rounds < MAX_REQUIREMENT_REPAIR_ROUNDS) {
      rounds += 1;
      const roundStage = displayStage({ type: 'llm_review', roleId: `agent-requirement-verification-${draftChapter.id}`, status: 'running', message: `用户要求定向补写中（第 ${rounds}/${MAX_REQUIREMENT_REPAIR_ROUNDS} 轮）：${draftChapter.title}（${pending.length} 条未落实）`, details: pending.map(req => `- ${req}`) }, { subtitle: '用户要求核验' });
      upsertProgressStage(session.progressStages, roundStage);
      upsertProgressStage(session.finalGateRepairStages, roundStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const requirementOutcome = await repairUnmetRequirements(draftChapter, pending, chapterContent, rounds);
      if (requirementOutcome.rolledBack) anyRollback = true;
      if (requirementOutcome.rolledBack || requirementOutcome.content === chapterContent) {
        // 补写未落地（回滚/空修复）：内容未变即无复验价值，停止并转 warning 兜底
        stopKind = 'not-landed';
        break;
      }
      chapterContent = requirementOutcome.content;
      session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: chapterContent };
      chapterRepaired = true;
      if (rounds >= MAX_REQUIREMENT_REPAIR_ROUNDS) {
        // 已达轮次上限：末次复验残留作为终态残留转 warning 兜底（不再追加复验调用）
        stopKind = 'limit';
        break;
      }
      // 收敛判定（补写落地后复验）：复验残留数下降才继续下一轮；不降即停止
      const reverification = await verifyChapterRequirements(draftChapter.title, chapterContent, chapterRequirements);
      const reverifiedUnmet = Array.isArray(reverification?.unmet) ? reverification.unmet.filter(Boolean).slice(0, 12) : [];
      if (!reverification || reverification.satisfied === true || reverifiedUnmet.length === 0) {
        verifiedSatisfied = true;
        residualUnmet = [];
        stopKind = 'verified';
        break;
      }
      residualUnmet = reverifiedUnmet;
      if (reverifiedUnmet.length >= pending.length) {
        stopKind = 'no-drop';
        break;
      }
      pending = reverifiedUnmet;
    }
    if (chapterRepaired) repairedChapters += 1;
    let message: string;
    if (verifiedSatisfied) message = `用户要求核验闭环通过：${draftChapter.title}（${unmet.length} 条未落实要求经 ${rounds} 轮定向补写后复验全部落实）`;
    else if (!chapterRepaired && anyRollback) message = `用户要求补写已回滚：${draftChapter.title}（修复后要求关键词命中减少，保留修复前正文；残留 ${residualUnmet.length} 条以 warning 记录，不阻断交付）`;
    else if (!chapterRepaired) message = `用户要求补写未生效：${draftChapter.title}（模型未产生有效修改；残留 ${residualUnmet.length} 条以 warning 记录，不阻断交付）`;
    else if (stopKind === 'no-drop') message = `用户要求补写部分生效：${draftChapter.title}（第 ${rounds} 轮补写后复验残留 ${residualUnmet.length} 条未继续下降，停止继续修复；残留以 warning 记录，不阻断交付）`;
    else if (stopKind === 'limit') message = `用户要求补写部分生效：${draftChapter.title}（已执行 ${rounds} 轮定向补写，达最多 ${MAX_REQUIREMENT_REPAIR_ROUNDS} 轮上限；末次复验残留 ${residualUnmet.length} 条以 warning 记录，不阻断交付）`;
    else message = `用户要求补写部分生效：${draftChapter.title}（第 ${rounds} 轮补写未落地（回滚或模型未修改），保留上一轮修复后正文；复验残留 ${residualUnmet.length} 条以 warning 记录，不阻断交付）`;
    const completedStage = displayStage({ type: 'llm_review', roleId: `agent-requirement-verification-${draftChapter.id}`, status: verifiedSatisfied ? 'success' : 'failed', message, details: [...unmet.map(req => `- ${req}`), ...(!verifiedSatisfied && residualUnmet.length > 0 ? [`残留未落实 ${residualUnmet.length} 条：${residualUnmet.join('；')}`] : [])] }, { subtitle: '用户要求核验' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  session.generationDiagnostics.llm.lastInfo = `用户要求执行核验闭环：${totalRequirements} 条要求，核验 ${verifiedChapters} 章，${satisfiedChapters} 章全部落实，${repairedChapters} 章完成定向补写（每章最多 ${MAX_REQUIREMENT_REPAIR_ROUNDS} 轮收敛修复，未收敛残留以 warning 记录，不阻断交付）`;
}
