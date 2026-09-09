/**
 * repairRounds/qingtianReview：全维度评审轮（FINALIZE_REPAIR_ROUNDS: qingtian-full-review）。
 * P2 拆分（方案 5.2）：由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 */
import type { DocumentFact, DocumentTemplateChapter, TenderRequirementItem, TenderRequirementModel } from '../../types';
import { qingtianReviewValidationIssues, runFullDimensionReview } from '../../fullDimensionReview';
import { displayStage, upsertProgressStage } from '../../progress';
import type { FinalizeSession } from '../finalizeSession';

/** 评审轮招标对标材料（round-21 S6）：工程概况事实 + 评标办法条目 + 评分项要求 + 清单特征摘要。
 * 评审轮零检出根因修复：不注入对标材料时评审模型无招标依据可对照，只能按通用规范空评
 * （实测 5 块评审零检出而外部评分按同一青天规范+招标材料检出 207 条） */
function buildTenderReviewContext(input: { factsModel: any; evaluationCriteriaItems?: string[]; tenderRequirements?: TenderRequirementModel }): string {
  const sections: string[] = [];
  const canonical = input.factsModel?.canonical;
  const valueOf = (fact: { value?: string } | undefined) => fact?.value;
  if (canonical) {
    const firstOf = (fact: { value?: string } | Array<{ value?: string }> | undefined) => (Array.isArray(fact) ? fact.map(item => item?.value).filter(Boolean) : fact?.value ? [fact.value] : []);
    const identityLines = [
      valueOf(canonical.projectIdentity?.projectName) ? `项目名称：${valueOf(canonical.projectIdentity.projectName)}` : '',
      valueOf(canonical.projectIdentity?.owner) ? `招标人：${valueOf(canonical.projectIdentity.owner)}` : '',
      valueOf(canonical.projectIdentity?.location) ? `建设地点：${valueOf(canonical.projectIdentity.location)}` : '',
      ...firstOf(canonical.projectScope?.scale).map(value => `建设规模：${value}`),
      ...firstOf(canonical.schedule?.duration).map(value => `计划工期：${value}`),
      ...firstOf(canonical.quality?.target).map(value => `质量目标：${value}`),
    ].filter(Boolean);
    if (identityLines.length) sections.push(`工程概况事实：\n${identityLines.join('\n')}`);
  }
  const criteria = (input.evaluationCriteriaItems || []).filter(Boolean);
  if (criteria.length) sections.push(`评标办法技术评审条目：\n${criteria.map(item => `- ${item}`).join('\n')}`);
  const req = input.tenderRequirements;
  if (req && req.extracted) {
    const reqLines: string[] = [];
    const pushItems = (label: string, items: TenderRequirementItem[] | undefined) => {
      for (const item of items || []) reqLines.push(`${label}：${item.text}`);
    };
    pushItems('创优目标', req.awardObjectives);
    pushItems('特殊质量标准', req.specialQualityStandards);
    pushItems('奖项条款', req.awardClauses);
    if (req.greenBuildingGrade) reqLines.push(`绿色建筑等级：${req.greenBuildingGrade.text}`);
    if (req.smartSiteGrade) reqLines.push(`智慧工地等级：${req.smartSiteGrade.text}`);
    if (req.assemblyRate) reqLines.push(`装配率要求：${req.assemblyRate.text}`);
    pushItems('体系基准', req.systematicBenchmarks);
    pushItems('禁止性约束', req.prohibitionNotes);
    if (req.dateFabricationProhibited) reqLines.push('禁编日期条款：正文不得自设具体开工/竣工日期');
    if (reqLines.length) sections.push(`招标文件评分项要求：\n${reqLines.map(line => `- ${line}`).join('\n')}`);
  }
  const bills: string[] = (input.factsModel?.bills || []).slice(0, 10).map((fact: DocumentFact) => `${fact.fieldName || fact.key} ${fact.value}`.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  if (bills.length) sections.push(`工程量清单特征摘要：\n${bills.map(line => `- ${line}`).join('\n')}`);
  return sections.join('\n\n');
}

export async function stageQingtianReview(session: FinalizeSession): Promise<void> {
  // ── 全维度评审轮（round-20 S4/W5）：青天规范内置，分块评审→问题清单→定向修复→复评 ──
  // 九维评审逻辑（合规红线/内容质量/数据逻辑/内容完整/本地适配/模板化/围串标残留）不再依赖代码正则围栏，
  // 由 LLM 按内置青天规范提示词对全文分块评审（首评 ≤7 块+修复 ≤3 章+复评 ≤2 块，全轮 ≤12 次调用），
  // 检出问题按风险等级分流：否决级/高风险进定向修复（局部 patch，修复后复评验证），中低风险进报告。
  // 评审调用只产出问题清单（只检测不改写铁律），改写一律走 repairChapterByQuality。
  const fullDimensionReviewResult = await runFullDimensionReview({
    template: session.template,
    chapters: session.finalChapterDrafts,
    effectiveChapters: session.effectiveChapters,
    requirement: session.requirement,
    projectName: session.projectMaterialSummary?.projectName || '',
    tenderContext: buildTenderReviewContext({ factsModel: session.factsModel, evaluationCriteriaItems: session.evaluationCriteriaItems, tenderRequirements: session.tenderRequirements }),
    diagnostics: session.generationDiagnostics,
    signal: session.signal,
    heartbeat: session.withProgressHeartbeat,
    onStage: stage => {
      const reviewStage = displayStage({ type: 'llm_review', roleId: 'agent-qingtian-review', status: stage.status, message: stage.message, details: stage.details }, { subtitle: '全维度评审' });
      upsertProgressStage(session.progressStages, reviewStage);
      upsertProgressStage(session.finalGateRepairStages, reviewStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
    },
  });
  // round-20 S5/W8：评审轮残留问题转门禁校验问题（否决级/高风险 error 硬阻断，中低风险 warning），
  // 并入重算校验组后由导出门禁按 category 'qingtian_review' 阻断
  session.qingtianReviewBlockingIssues = fullDimensionReviewResult.reviewed ? qingtianReviewValidationIssues(fullDimensionReviewResult.remainingIssues) : [];
  if (fullDimensionReviewResult.fixedCount > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  } else if (session.qingtianReviewBlockingIssues.length > 0) {
    // 无修复但评审轮检出残留问题：不重建正文，仅重算校验组让门禁消费评审轮阻断
    await session.recomputeFinalValidationBundle();
  }
}
