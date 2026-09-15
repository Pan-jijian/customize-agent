/**
 * stageBlueprint：阶段 3 —— 蓝图构建/参数桶（含并发池与跨章基础事实缓存）。
 * P1 六阶段拆分（方案 5.1）：由 documentGenerator.generateDocumentDraft 阶段 3 代码块机械搬迁而来，
 * 变量读写经 session 子对象显式化，业务生成语义与原巨型函数逐字一致（行为保持）。
 */
import type { GenerationSession } from './generationSession';
import { buildIntegratedBlueprint, estimateChapterMinFeasibleWords, findBlueprintChapter, renderBasicFactsForBlueprint, resolveBillOfQuantities, saveBlueprintAsset } from '../integratedBlueprint';
import { reanchorChapterTargetsByFeasibility } from '../budget';
import type { DocumentTemplateChapter } from '../types';
import { buildBillFactLock } from '../billFactLock';
import { assignTenderRequirementsToChapters, saveRequirementAssignmentsAsset } from '../tenderRequirements';
import { displayStage, upsertProgressStage } from '../progress';
import { Semaphore, runWithAdaptiveConcurrency } from '../utils';
import { PROJECT_BASIC_FACT_QUERIES } from '../documentGeneratorHelpers';
import { tuningProfile } from '../tuningProfile';

export async function stageBlueprint(session: GenerationSession): Promise<void> {
  const avgChapterTarget = Math.round(([...session.planning.documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0) || session.planning.documentBudget.targetChars || 0) / Math.max(1, session.planning.effectiveChapters.length));
  const configuredChapterConcurrency = tuningProfile().chapterConcurrency || 0;
  // P1：并发预算统一由预算模型给出；P2：审查修复与生成流水线重叠（审查池与生成批独立限流）
  session.blueprint.chapterConcurrency = session.planning.generationBudget.chapterConcurrency;
  session.blueprint.reviewConcurrency = session.planning.generationBudget.reviewConcurrency;
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'chapter-concurrency', status: 'success', message: `章节流水线调度：${session.planning.effectiveChapters.length} 章全部同批并行生成，审查修复 ${session.blueprint.reviewConcurrency} 路流水线（章节生成完立即进入审查，与后续章节生成重叠）`, details: [`有效章节数：${session.planning.effectiveChapters.length}`, `平均章节目标：${avgChapterTarget} 字`, Number.isFinite(configuredChapterConcurrency) && configuredChapterConcurrency > 0 ? `章节并发来自 tuningProfile.chapterConcurrency=${Math.floor(configuredChapterConcurrency)}` : `全部章节并行生成，在飞调用不设并发上限；每章单轮修复（失败即放弃）`] }, { subtitle: '章节流水线策略' }));
  session.global.emitProgress();
  // P2 审查流水线：章节生成完成后立即收口（章级审查修复已删除，跨章审查与最终门禁在所有章节完成后按章节序执行）
  // 跨章引用安全：统一修复仅改全部章节成稿后的完整初稿，章节收口任务只做写入与进度汇报
  session.blueprint.reviewSemaphore = new Semaphore(session.blueprint.reviewConcurrency);
  session.blueprint.reviewTaskPool = [];
  // P1-5 基础事实查询跨章缓存：PROJECT_BASIC_FACT_QUERIES 不含章节标题，概况/质量/进度类章节会并入每章查询集重复全链路检索；
  // 在章节循环外预执行一次（默认权重），章节内直接取用结果
  const basicFactScopePaths = [...session.understanding.availableEvidenceScopePaths].filter(Boolean).sort();
  const basicFactSearchStartedAt = Date.now();
  session.blueprint.basicFactSearchResults = basicFactScopePaths.length > 0
    ? (await runWithAdaptiveConcurrency(PROJECT_BASIC_FACT_QUERIES, async query => session.understanding.searchWithCache(query, basicFactScopePaths, Math.min(session.understanding.requestedEvidencePerChapter, 12), ''), { kind: 'search' })).flat()
    : [];
  session.planning.generationDiagnostics.evidence.searchQueries += PROJECT_BASIC_FACT_QUERIES.length;
  session.planning.generationDiagnostics.evidence.searchMs += Date.now() - basicFactSearchStartedAt;
  // ── 一体化蓝图（唯一计划类数值权威源）：构建蓝图、落盘 assets/blueprint.json；校验通过后参数桶+章切片接管执行层 ──
  // 构建异常仅记录警告不阻断（蓝图不活跃时各章按证据独立成稿）；决策锁类目表在蓝图构建内确定性提取
  const blueprintStartedAt = Date.now();
  try {
    session.blueprint.integratedBlueprint = buildIntegratedBlueprint({
      projectRoot: session.prepare.projectRoot,
      boundFilePaths: session.prepare.materialFilePaths,
      chapterTitles: session.planning.effectiveChapters.map(chapter => chapter.title),
      templateName: session.prepare.template.name,
      basicFacts: renderBasicFactsForBlueprint(session.understanding.canonicalFacts),
      evidence: session.understanding.writerEvidence,
      facts: [...session.understanding.earlyFactPool.localFacts, ...session.understanding.earlyFactPool.projectBasicFacts, ...session.understanding.earlyFactPool.preciseFacts],
      composition: session.understanding.bidComposition,
      signal: session.global.input.signal,
      diagnostics: session.planning.generationDiagnostics,
    });
    const blueprintAssetPath = saveBlueprintAsset(session.prepare.projectRoot, session.blueprint.integratedBlueprint);
    const blueprintPackageCount = session.blueprint.integratedBlueprint.outline.chapters.reduce((sum, chapter) => sum + chapter.subSections.reduce((acc, section) => acc + section.workPackages.length, 0), 0);
    // 标书编制规格展示（防御：阶段 1 判定缺失时降级文案——展示行不得阻断蓝图挂载）
    const compositionSpec = session.understanding.bidComposition;
    const compositionLabel = compositionSpec
      ? `${compositionSpec.bidType === 'blind' ? '暗标（正文禁表格/禁图片，图表转文末附表区）' : compositionSpec.bidType === 'open' ? '明标（正文可含表格）' : '未识别勾选标记（按常规口径）'}${compositionSpec.appendixPlan.length > 0 ? `；文末附表 ${compositionSpec.appendixPlan.length} 项` : ''}`
      : '未识别（阶段 1 判定缺失，按常规口径）';
    upsertProgressStage(session.global.progressStages, displayStage({
      type: 'validation',
      roleId: 'integrated-blueprint',
      status: session.blueprint.integratedBlueprint.validation.passed ? 'success' : 'failed',
      message: session.blueprint.integratedBlueprint.validation.passed
        ? `一体化蓝图已构建并落盘：清单 ${session.blueprint.integratedBlueprint.diagnostics.boq?.totalEntries ?? 0} 条目、工作包 ${blueprintPackageCount} 个（校验通过，参数桶与章切片接管各章写作）`
        : `一体化蓝图已构建但校验未通过（参数桶不注入，不阻断生成）：${session.blueprint.integratedBlueprint.validation.checks.filter(check => !check.passed).map(check => check.name).join('、')}`,
      details: [
        `耗时 ${Date.now() - blueprintStartedAt}ms`,
        `落盘：${blueprintAssetPath}`,
        `清单解析：${session.blueprint.integratedBlueprint.diagnostics.boq ? `${session.blueprint.integratedBlueprint.diagnostics.boq.totalEntries} 条目 / ${session.blueprint.integratedBlueprint.diagnostics.boq.villageCount} 村 / 完整性校验${session.blueprint.integratedBlueprint.diagnostics.boq.complete ? '通过' : '未通过'}` : '未解析（见警告）'}`,
        `标书编制规格：${compositionLabel}`,
        `校验链：${session.blueprint.integratedBlueprint.validation.checks.map(check => `${check.name}${check.passed ? '✓' : '✗'}`).join(' / ')}`,
        ...session.blueprint.integratedBlueprint.diagnostics.warnings.slice(0, 6).map(warning => `警告：${warning}`),
      ],
    }, { subtitle: '一体化蓝图' }));
    session.global.emitProgress();
  } catch (error) {
    session.blueprint.integratedBlueprint = undefined;
    upsertProgressStage(session.global.progressStages, displayStage({
      type: 'validation',
      roleId: 'integrated-blueprint',
      status: 'failed',
      message: `一体化蓝图构建异常（参数桶不注入，不阻断生成）：${error instanceof Error ? error.message : String(error)}`,
      details: [`耗时 ${Date.now() - blueprintStartedAt}ms`, '蓝图异常时参数桶与章切片不注入，各章按证据独立成稿'],
    }, { subtitle: '一体化蓝图' }));
    session.global.emitProgress();
  }
  if (session.blueprint.integratedBlueprint) {
    // B1 清单事实锁构建：蓝图与清单解析同源（阶段 0 确定性解析），但 blueprint 对象不暴露完整条目库；
    // 此处单独解析一次（sqlite 读 + 纯确定性解析，仅在有清单绑定的项目触发），固化行级事实锁：
    // 写作侧清单行直读（不经检索召回/注入截断）+ 生成后正文数值确定性核对轮共用同一锁
    try {
      const boqResult = resolveBillOfQuantities({ projectRoot: session.prepare.projectRoot, boundFilePaths: session.prepare.materialFilePaths });
      session.blueprint.billFactLock = buildBillFactLock({ boq: boqResult.boq });
      if (session.blueprint.billFactLock) {
        session.planning.generationDiagnostics.llm.lastInfo = `清单事实锁：锁定 ${session.blueprint.billFactLock.totalEntries} 条目（完整性校验${session.blueprint.billFactLock.complete ? '通过' : '未通过'}），写作直读与数值核对轮生效`;
      }
    } catch (error) {
      console.error(`[blueprint] 清单事实锁构建失败（章节按证据独立成稿）：${error instanceof Error ? error.message : String(error)}`);
      session.blueprint.billFactLock = undefined;
    }
  }
  // ── 招标要求分配（唯一权威分配：每条要求唯一主责章；章级注入/章级验收/终局对账共用同一份分配） ──
  // 分配对账：assignments.length === entries.length（结构性不变量：未分配恒为 0）；低置信分配标记供审计
  {
    const requirementEntries = session.planning.tenderRequirements.entries;
    const assignmentResult = assignTenderRequirementsToChapters(requirementEntries, session.planning.effectiveChapters, session.planning.requirementsSimilarity);
    session.blueprint.requirementAssignments = assignmentResult.assignments;
    if (assignmentResult.assignments.length !== requirementEntries.length) {
      throw new Error(`招标要求分配对账失败：要求 ${requirementEntries.length} 条，分配 ${assignmentResult.assignments.length} 条`);
    }
    if (requirementEntries.length > 0) {
      const assetPath = saveRequirementAssignmentsAsset(session.prepare.projectRoot, assignmentResult.assignments);
      const byChapter = new Map<string, number>();
      for (const assignment of assignmentResult.assignments) byChapter.set(assignment.chapterTitle, (byChapter.get(assignment.chapterTitle) || 0) + 1);
      upsertProgressStage(session.global.progressStages, displayStage({
        type: 'validation',
        roleId: 'tender-requirement-assignment',
        status: 'success',
        message: `招标要求分配：${assignmentResult.assignments.length} 条要求全部落位 ${byChapter.size} 个责任章${assignmentResult.lowConfidenceCount > 0 ? `（低置信 ${assignmentResult.lowConfidenceCount} 条，已分配唯一主责章）` : ''}`,
        details: [
          `分配对账：要求 ${requirementEntries.length} 条 = 分配 ${assignmentResult.assignments.length} 条（未分配 0）`,
          `落盘：${assetPath}`,
          ...[...byChapter.entries()].map(([title, count]) => `${title}：${count} 条`),
          ...assignmentResult.assignments.filter(assignment => assignment.lowConfidence).slice(0, 8).map(assignment => `低置信：${assignment.entry.text} → ${assignment.chapterTitle}（相似度 ${assignment.score.toFixed(2)}）`),
        ],
      }, { subtitle: '招标要求分配', order: session.global.progressStages.length }));
      session.global.emitProgress();
    }
  }
  // ── 4.35 容量密度可行性闭环：蓝图落盘且校验通过后，按真实要点密度重校准章预算（写作前） ──
  // 根因（舒城 4.34 自测「主要施工方法」章阻断实证）：章预算按模板小节数估算（7 节 → 1.56 万字），
  // 与蓝图实际展开的 96 工作包体量脱节——每要点预算 150 字 < 单要点最小可写量 300 字 → 骨架质检
  //（每 H4 三要素）物理不可达 → 块必败、章必败。本块按蓝图真实要点数（工作包数 + 未覆盖模板小节数）
  // 估算每章最小可行预算 minFeasible = ceil(要点数/6) × 1800：低于下限的章抬升、其余章按需归一化
  // 缩减（Σ章预算 = T 精确守恒）。仅长文显式目标（longformStrict）且蓝图校验通过时执行，其余情形
  // 完全跳过（零影响）；tuningProfile.capacityFeasibilityRecalibration=0 应急回退。
  const budgetTargetChars = session.planning.documentBudget.targetChars;
  if (session.planning.documentBudget.longformStrict && tuningProfile().capacityFeasibilityRecalibration !== 0 && budgetTargetChars && session.blueprint.integratedBlueprint?.validation.passed) {
    const blueprint = session.blueprint.integratedBlueprint;
    const recalibrationStartedAt = Date.now();
    try {
      const feasibilityCache = new Map<string, ReturnType<typeof estimateChapterMinFeasibleWords>>();
      const feasibilityOf = (chapter: DocumentTemplateChapter) => {
        let cached = feasibilityCache.get(chapter.id);
        if (!cached) {
          cached = estimateChapterMinFeasibleWords(findBlueprintChapter(blueprint, chapter.title), chapter.sections || []);
          feasibilityCache.set(chapter.id, cached);
        }
        return cached;
      };
      const docSpec = session.prepare.documentSpec;
      const specMinimumOf = (chapter: DocumentTemplateChapter) => Math.max(
        docSpec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title)?.minWords || 0,
        docSpec?.dynamicChapterRule.minWordsPerChapter || 0,
      );
      const { chapterTargets, adjustments, compressed } = reanchorChapterTargetsByFeasibility({
        chapters: session.planning.effectiveChapters,
        targetChars: budgetTargetChars,
        floorOf: specMinimumOf,
        feasibilityFloorOf: chapter => feasibilityOf(chapter).minFeasibleWords,
        currentTargets: session.planning.documentBudget.chapterTargets,
      });
      // 原位更新 chapterTargets（Map 原地变更——session.planning 下所有别名引用同一 Map，写作层取用即新预算）
      session.planning.documentBudget.chapterTargets.clear();
      for (const [chapterId, value] of chapterTargets) session.planning.documentBudget.chapterTargets.set(chapterId, value);
      upsertProgressStage(session.global.progressStages, displayStage({
        type: 'validation',
        roleId: 'chapter-budget-feasibility',
        status: compressed ? 'failed' : 'success',
        message: compressed
          ? '章预算可行性校准：最低密度预算合计超出全文目标，按下限比例压缩（不阻断；容量密度需求与目标字数冲突已显式暴露）'
          : adjustments.length > 0
            ? `章预算可行性校准：${adjustments.length} 章按真实要点密度重锚（Σ章预算 = ${budgetTargetChars} 字守恒）`
            : '章预算可行性校准：各章预算均满足密度可行性下限，无需调整',
        details: [
          ...adjustments.map(item => {
            const chapter = session.planning.effectiveChapters.find(candidate => candidate.id === item.id);
            const points = chapter ? feasibilityOf(chapter).points : 0;
            return `${item.title}：${item.from} → ${item.to} 字（要点 ${points} 个 × 密度下限 1800 字/块）`;
          }).slice(0, 12),
          `本地校准时耗 ${Date.now() - recalibrationStartedAt}ms`,
          `开关：tuningProfile.capacityFeasibilityRecalibration=${tuningProfile().capacityFeasibilityRecalibration ?? '缺省开启'}`,
        ],
      }, { subtitle: '章预算可行性校准' }));
      if (adjustments.length > 0 || compressed) console.warn(`[blueprint] 章预算可行性校准：${adjustments.length} 章调整能量；Σ章预算 = ${budgetTargetChars} 字守恒`);
      session.global.emitProgress();
    } catch (error) {
      console.error(`[blueprint] 章预算可行性校准失败（沿用原章预算，不阻断）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 蓝图接管（三期收口：旧 planDataMaster/decisionLock 管线已删除，蓝图是唯一计划类数值权威源）：
  // 四道校验通过的蓝图，其 data 与章切片对象注入执行层，由块级按块 token 聚焦渲染
  // （s1-slim：参数桶/切片不再文档级预渲染全量文本，单块输入从 10 万字符级降到块相关量级）；
  // 蓝图缺失/校验失败时参数桶为空、各章按证据独立成稿
  session.blueprint.blueprintActive = Boolean(session.blueprint.integratedBlueprint?.validation.passed);
}
