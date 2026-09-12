/**
 * stageBlueprint：阶段 3 —— 蓝图构建/参数桶（含并发池与跨章基础事实缓存）。
 * P1 六阶段拆分（方案 5.1）：由 documentGenerator.generateDocumentDraft 阶段 3 代码块机械搬迁而来，
 * 变量读写经 session 子对象显式化，业务生成语义与原巨型函数逐字一致（行为保持）。
 */
import type { GenerationSession } from './generationSession';
import type { IntegratedBlueprint } from '../integratedBlueprint';
import { buildIntegratedBlueprint, renderBasicFactsForBlueprint, renderBlueprintDataText, resolveBillOfQuantities, saveBlueprintAsset } from '../integratedBlueprint';
import { buildBillFactLock } from '../billFactLock';
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
      signal: session.global.input.signal,
      diagnostics: session.planning.generationDiagnostics,
    });
    const blueprintAssetPath = saveBlueprintAsset(session.prepare.projectRoot, session.blueprint.integratedBlueprint);
    const blueprintPackageCount = session.blueprint.integratedBlueprint.outline.chapters.reduce((sum, chapter) => sum + chapter.subSections.reduce((acc, section) => acc + section.workPackages.length, 0), 0);
    upsertProgressStage(session.global.progressStages, displayStage({
      type: 'validation',
      roleId: 'integrated-blueprint',
      status: session.blueprint.integratedBlueprint.validation.passed ? 'success' : 'failed',
      message: session.blueprint.integratedBlueprint.validation.passed
        ? `一体化蓝图已构建并落盘：清单 ${session.blueprint.integratedBlueprint.diagnostics.boq?.totalEntries ?? 0} 条目、标准板块 ${session.blueprint.integratedBlueprint.diagnostics.standardBlocksLoaded} 个、工作包 ${blueprintPackageCount} 个（校验通过，参数桶与章切片接管各章写作）`
        : `一体化蓝图已构建但校验未通过（参数桶不注入，不阻断生成）：${session.blueprint.integratedBlueprint.validation.checks.filter(check => !check.passed).map(check => check.name).join('、')}`,
      details: [
        `耗时 ${Date.now() - blueprintStartedAt}ms`,
        `落盘：${blueprintAssetPath}`,
        `清单解析：${session.blueprint.integratedBlueprint.diagnostics.boq ? `${session.blueprint.integratedBlueprint.diagnostics.boq.totalEntries} 条目 / ${session.blueprint.integratedBlueprint.diagnostics.boq.villageCount} 村 / 完整性校验${session.blueprint.integratedBlueprint.diagnostics.boq.complete ? '通过' : '未通过'}` : '未解析（见警告）'}`,
        `标准板块缺口：${session.blueprint.integratedBlueprint.diagnostics.standardBlockGaps.length > 0 ? session.blueprint.integratedBlueprint.diagnostics.standardBlockGaps.join('、') : '无'}`,
        `四道校验：${session.blueprint.integratedBlueprint.validation.checks.map(check => `${check.name}${check.passed ? '✓' : '✗'}`).join(' / ')}`,
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
  // 蓝图接管（三期收口：旧 planDataMaster/decisionLock 管线已删除，蓝图是唯一计划类数值权威源）：
  // 四道校验通过的蓝图，其参数桶渲染文本注入各章写作；章切片渲染文本逐章注入执行层
  // （同章各块值相同 → 章内 prefix cache 共享前缀）；蓝图缺失/校验失败时参数桶为空、各章按证据独立成稿
  session.blueprint.blueprintActive = Boolean(session.blueprint.integratedBlueprint?.validation.passed);
  session.blueprint.blueprintDataText = session.blueprint.integratedBlueprint?.validation.passed ? renderBlueprintDataText(session.blueprint.integratedBlueprint.data) : '';
}
