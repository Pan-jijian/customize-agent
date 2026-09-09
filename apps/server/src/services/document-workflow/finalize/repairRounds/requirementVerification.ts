/**
 * repairRounds/requirementVerification：生成后用户要求执行核验闭环（C3）。
 *
 * 背景（用户提示词作用小的收口治理）：A2/A3 已把用户提示词解析为结构化要求并在生成全链注入
 * （最高优先级），但注入不等于落实——模型可能选择性忽略要求。本轮在 finalize 修复链末尾对
 * 每章正文逐条核验「全局要求 + 章级要求」的落实状态：未满足条目进入 LLM 定向补写修复轮
 * （单轮，失败即放弃），核验与修复结果回写进度 stage 与诊断信息（生效报告）。
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

export async function stageRequirementVerification(session: FinalizeSession): Promise<void> {
  const plan = session.requirementSemantics;
  if (!plan || !plan.parsed || ((plan.globalRequirements || []).length === 0 && (plan.chapterRequirements || []).length === 0)) return;
  const totalRequirements = [...(plan.globalRequirements || []), ...(plan.chapterRequirements || []).flatMap(item => item.requirements)].filter(Boolean).length;
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
    // 核验轮：LLM 零温度 JSON 逐条判定要求落实状态
    const verification = await session.withProgressHeartbeat(() => callDocumentLlmJson<RequirementVerificationResult>([
      '你是投标文档用户要求核验专家。逐条核对「用户要求」是否已在章节正文中落实。',
      '判定口径：正文存在明确满足该要求的实质性内容即算落实；仅泛泛提及、半句带过、被其他内容顶替均算未落实。',
      '不得因为正文有其他内容就降低标准；用户要求是最高优先级，未落实必须如实列入 unmet。',
      '只返回 JSON：{"satisfied":true/false,"unmet":["未落实要求原文"]}。',
    ].join('\n\n'), [
      `章节标题：${draftChapter.title}`,
      `用户要求（逐条核验）：\n${chapterRequirements.map((req, index) => `${index + 1}. ${req}`).join('\n')}`,
      `章节正文：\n${draftChapter.content.slice(0, 12000)}`,
    ].filter(Boolean).join('\n\n'), {
      maxTokens: 1200,
      temperature: 0,
      signal: session.signal,
      diagnostics: session.generationDiagnostics,
      prefixKey: 'requirement-verification',
    }));
    const unmet = Array.isArray(verification?.unmet) ? verification.unmet.filter(Boolean).slice(0, 12) : [];
    if (!verification || verification.satisfied === true || unmet.length === 0) {
      satisfiedChapters += 1;
      const okStage = displayStage({ type: 'llm_review', roleId: `agent-requirement-verification-${draftChapter.id}`, status: 'success', message: `用户要求核验通过：${draftChapter.title}（${chapterRequirements.length} 条要求全部落实）`, details: chapterRequirements.map(req => `- ${req}`) }, { subtitle: '用户要求核验' });
      upsertProgressStage(session.progressStages, okStage);
      upsertProgressStage(session.finalGateRepairStages, okStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      continue;
    }
    // 未满足 → 定向补写修复轮（单轮，失败即放弃）：用户要求以最高优先级注入，逐条落实
    const requirementInstruction = [
      '【用户要求定向补写修复】',
      '下列用户要求经核验未在本章正文中落实。请逐条在正文最合适的位置补充落实，用户要求是最高优先级：',
      '用户要求与系统默认规则冲突时以用户要求为准；已落实内容不得删除或改写；只做局部修改，不得新增、删除或合并小节。',
      unmet.map(req => `- ${req}`).join('\n'),
      ...(plan?.styleRequirements?.length ? [`\n风格要求（补写内容同样必须遵守）：\n${plan.styleRequirements.map(style => `- ${style}`).join('\n')}`] : []),
    ].join('\n');
    const keywords = requirementKeywords(unmet);
    const beforeHits = keywords.reduce((sum, keyword) => sum + (draftChapter.content.includes(keyword) ? 1 : 0), 0);
    const requirementOutcome = await withPatchRollback({
      originalContent: draftChapter.content,
      repairRound: 'requirement-verification',
      diagnostics: session.generationDiagnostics,
      beforeMetrics: [beforeHits],
      apply: async () => {
        const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
          template: session.template,
          chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
          issues: unmet.map(req => `用户要求未落实：${req}`),
          promptTexts: requirementInstruction,
          requirement: session.requirement,
          forbidDrawingImages: false,
          diagnostics: session.generationDiagnostics,
          signal: session.signal,
          patchGuard: repairPatchGuard('requirement-verification', session.generationDiagnostics),
        }));
        return repaired.content && repaired.content !== draftChapter.content ? repaired.content : draftChapter.content;
      },
      recheck: (content) => {
        const hits = keywords.reduce((sum, keyword) => sum + (content.includes(keyword) ? 1 : 0), 0);
        return [hits];
      },
      // 指标语义：要求关键词命中数越低越差 → 修复后命中数下降即回滚（默认判定为指标上升即回滚，需显式覆盖）
      shouldRollback: (before, after) => after[0] < before[0],
    });
    if (!requirementOutcome.rolledBack && requirementOutcome.content !== draftChapter.content) {
      session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: requirementOutcome.content };
      repairedChapters += 1;
    }
    const completedStage = displayStage({ type: 'llm_review', roleId: `agent-requirement-verification-${draftChapter.id}`, status: requirementOutcome.rolledBack ? 'failed' : 'success', message: requirementOutcome.rolledBack ? `用户要求补写已回滚：${draftChapter.title}（修复后要求关键词命中减少，保留修复前正文）` : `用户要求补写完成：${draftChapter.title}（${unmet.length} 条未落实要求已定向补写）`, details: unmet.map(req => `- ${req}`) }, { subtitle: '用户要求核验' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  session.generationDiagnostics.llm.lastInfo = `用户要求执行核验闭环：${totalRequirements} 条要求，核验 ${verifiedChapters} 章，${satisfiedChapters} 章全部落实，${repairedChapters} 章完成定向补写（单轮失败即放弃）`;
}
