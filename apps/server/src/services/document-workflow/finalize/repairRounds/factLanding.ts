/**
 * repairRounds/factLanding：重要事实落位补写轮（FINALIZE_REPAIR_ROUNDS: fact-landing-round）。
 * P2 拆分（方案 5.2）：由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { finalizeChapterContentQuality, uncoveredImportantFacts } from '../../documentGeneratorHelpers';
import type { DocumentFact } from '../../types';
import type { FinalizeSession } from '../finalizeSession';

export async function stageFactLanding(session: FinalizeSession): Promise<void> {
  // 重要事实落位补写轮（P1-3）：结构缺陷修复收敛后，若项目基础字段类硬数据仍未落位（建筑面积、标段数、编号、工期等），
  // 按事实标签映射目标章节做一轮定向 patch 落位（保持数值口径，不新增小节、不改表头结构）。
  // 十度实测缺陷：建设规模“建筑面积约为4646㎡”、招标范围“本项目分为1个标段”未落位直达交付（针对性维度 68 分）
  const importantUnplacedFacts = uncoveredImportantFacts(session.finalMarkdown, [...session.structuredFacts, ...session.factsModel.preciseFacts], { maxItems: 60 });
  if (importantUnplacedFacts.length > 0) {
    // 标签→章节关键词映射：项目基础字段 → 概况/基本信息章；工期 → 进度部署章；质量 → 质量章；危大安全 → 安全章；资源材料机械 → 资源投入章
    const factChapterMatchers: Array<[RegExp, RegExp]> = [
      [/项目名称|工程名称|项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|施工范围/u, /概况|基本信息|概述|总述|简介/u],
      [/计划工期|合同工期|天数/u, /工期|进度|施工部署|总体部署|流水/u],
      [/质量标准|质量目标/u, /质量/u],
      [/危大|安全/u, /安全/u],
      [/资源|材料|机械|设备|机具/u, /资源|投入|物资|机械|设备|机具|周转/u],
      // B5 关键精确参数落位：面积/长度/强度/管径等工程参数 → 概况章或施工方法章（与 preciseFactUsageIssues 关键参数抽查同源）
      [/面积|占地|建筑面积|长度|宽度|高度|厚度|深度|强度|等级|坡度|管径|直径|规格|跨度|周长|体积|重量/u, /概况|施工方法|主要施工|方案/u],
    ];
    const chapterFactGroups = new Map<string, Array<{ label: string; value: string; fact: DocumentFact }>>();
    const unmatchedFacts: string[] = [];
    // B5 参数落位限幅：每组最多 12 条，防参数池过大时 LLM patch 膨胀（每章一次调用，组内超限丢弃并记录）
    const droppedParamFacts: string[] = [];
    for (const item of importantUnplacedFacts) {
      const matcher = factChapterMatchers.find(([labelRe]) => labelRe.test(item.label));
      const targetChapter = matcher ? session.finalChapterDrafts.find(chapter => matcher[1].test(chapter.title)) : undefined;
      if (!targetChapter) {
        unmatchedFacts.push(`${item.label}=${item.value}`);
        continue;
      }
      const group = chapterFactGroups.get(targetChapter.id) || [];
      if (group.length >= 12) {
        droppedParamFacts.push(`${item.label}=${item.value}`);
        continue;
      }
      group.push({ label: item.label, value: item.value, fact: item.fact });
      chapterFactGroups.set(targetChapter.id, group);
    }
    let factLandingPatches = 0;
    for (const [chapterId, factsGroup] of chapterFactGroups) {
      const chapterIndex = session.finalChapterDrafts.findIndex(chapter => chapter.id === chapterId);
      if (chapterIndex < 0) continue;
      const draftChapter = session.finalChapterDrafts[chapterIndex];
      const templateChapter = session.effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
      const runningStage = displayStage({ type: 'llm_review', roleId: `agent-fact-landing-${chapterId}`, status: 'running', message: `正在落位 ${factsGroup.length} 条重要事实：${draftChapter.title}`, details: [...factsGroup.map(item => `${item.label}=${item.value}`), ...unmatchedFacts.map(item => `跳过：${item}（无匹配章节）`), ...droppedParamFacts.map(item => `超限跳过：${item}`)] }, { subtitle: '事实落位修复' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const factLandingInstruction = [
        '【事实落位定向修复】',
        '下列资料事实是项目硬数据，当前正文未出现。请逐条定位到本章最合适的位置（项目概况引导段、项目基本信息表对应行或对应小节），以局部 patch 方式自然写入，保持原始数值、单位与表述口径，不得改写、换算或编造。',
        '不得新增、删除或合并小节；表格内补充必须保持表头结构不变；只修改与落位事实直接相关的局部文本。',
        factsGroup.map(item => `- ${item.label}＝${item.value}`).join('\n'),
      ].join('\n');
      let factPatchCount = 0;
      // P12 回滚保护：落位后同源复检该组事实缺失数（uncoveredImportantFacts 章级隔离），
      // 缺失不降反升（LLM 删改已落位事实）即回滚保留修复前正文
      const factLandingOutcome = await withPatchRollback({
        originalContent: draftChapter.content,
        repairRound: 'fact-landing',
        diagnostics: session.generationDiagnostics,
        apply: async () => {
          const repairedFact = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
            issues: factsGroup.map(item => `已确认事实未在正文中落位：${item.label}=${item.value}`),
            promptTexts: factLandingInstruction,
            requirement: session.requirement,
            forbidDrawingImages: false,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('fact-landing', session.generationDiagnostics),
          }));
          if (repairedFact.content && repairedFact.content !== draftChapter.content) {
            factPatchCount = repairedFact.appliedCount;
            return templateChapter ? finalizeChapterContentQuality(repairedFact.content, templateChapter) : repairedFact.content;
          }
          return draftChapter.content;
        },
        recheck: (content) => [uncoveredImportantFacts(content, factsGroup.map(item => item.fact)).length],
      });
      if (!factLandingOutcome.rolledBack && factLandingOutcome.content !== draftChapter.content) {
        session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: factLandingOutcome.content };
        factLandingPatches += factPatchCount;
      }
      const completedStage = displayStage({ type: 'llm_review', roleId: `agent-fact-landing-${chapterId}`, status: factLandingOutcome.rolledBack || factPatchCount === 0 ? 'failed' : 'success', message: factLandingOutcome.rolledBack ? `重要事实落位已回滚：${draftChapter.title}（修复后事实缺失增多，保留修复前正文）` : factPatchCount > 0 ? `重要事实落位完成：${draftChapter.title}（${factPatchCount} 处 patch）` : `重要事实落位未生效：${draftChapter.title}`, details: factsGroup.map(item => `${item.label}=${item.value}`) }, { subtitle: '事实落位修复' });
      upsertProgressStage(session.progressStages, completedStage);
      upsertProgressStage(session.finalGateRepairStages, completedStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
    }
    if (factLandingPatches > 0) {
      session.finalMarkdown = session.rebuildFinalMarkdown();
      await session.recomputeFinalValidationBundle();
    }
  }}
