import { closedLoopDensityIssues, plannedAutoSpecGateIssues, basisRegulationsCoverageIssues, resourceBreakdownConsistencyIssues, punctuationArtifactIssues, boqPlacementIssues, crossChapterConsistencyIssues, degenerateContentIssues, drawingReferenceIssues, duplicateBasicInfoIssues, evaluationCriteriaCoverageIssues, formalContentIntegrityIssues, formalHeadingHierarchyIssues, formalPlaceholderIssues, formalStyleIssues, generatedFactVerificationIssuesAsync, genericProfessionalContentIssues, headingDuplicateIssues, innovationTechCoverageIssues, instructionLikeHeadingIssues, managementMeasureNumberIssues, markdownTableQualityIssues, minChapterSectionIssues, preciseFactUsageIssues, processSpecConflictIssues, professionalContentIssues, professionalScoreIssues, promptExampleLeakIssues, sectionContentIntegrityIssues, sectionCountOverflowIssues, sectionNumberingIssues, tableSpamIssues, tocBodyConsistencyIssues, tocHierarchyIssues } from './qualityValidation';
import { majorContentGovernanceIssues } from './constructionOrgQualityRules';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type { ProfessionalDepthAnalysis, ProfessionalDepthClassifier } from './professionalDepthClassifier';
import { boqDivisionCoverageIssues, boqRowTraceIssues, buildBoqRowTraces, numericTraceabilityIssues } from './documentFactTrace';
import { chapterDependencyIssues, documentDeliveryScoreIssues, evidenceUsageCoverageIssues, paragraphGenericIssues } from './documentDeliveryReport';
import { bodyCompositionFigureIssues, bodyCompositionTableIssues, plannedStructureIssues, promptDocumentRuleIssues, tableCaptionIssues, tertiaryHeadingIssues } from './markdownComposer';
import { webEvidenceLeakageIssues } from './webResearchService';
import { constructionOrgChapterDataCoverageIssues, constructionOrgConsistencyIssues } from './constructionOrgConsistency';
import { constructionOrgBonusModuleIssues, constructionOrgControlLoopIssues, constructionOrgDivisionSectionIssues, constructionOrgGenericLanguageIssues, constructionOrgMajorContentIssues, constructionOrgProfessionalChainIssues } from './constructionOrgQualityRules';
import { ambiguousEitherOrIssues, areaArithmeticIssues, basicInfoScheduleFieldIssues, bidderQualificationSectionIssues, bodySentencesForSemantic, REQUIREMENTS_SEMANTIC_SENTENCE_LIMIT, closurePhraseDensityCapIssues, commercialDataInBodyIssues, crossProjectValueCopyIssues, crossSectionNumericConflictIssues, dangerousListConsistencyIssues, duplicateParagraphIssues, duplicateTableIssues, equipmentBatchConflicts, equipmentEntryTimingIssues, excavationDepthLockIssues, excavationHazardClassificationIssues, extractSupportSystemAuthority, fabricatedAwardIssues, fabricatedStartDateIssues, fieldValueMismatchIssues, foundationFormResidueIssues, greeningMaintenanceMismatchIssues, hazardExclusionContradictionIssues, identityLeakageIssues, invertedDateRangeIssues, collisionNumberedHeadingIssues, localAdaptationKeywordIssues, nodeScheduleConsistencyIssues, overviewRecapIssues, paragraphOpeningRepeatIssues, paragraphTailRepeatIssues, phaseLaborMixingIssues, preliminaryActionTimingIssues, repeatedWordIssues, resourceConsistencyIssues, resourceTriadSectionHierarchyIssues, selfUnderminingCandidateIssues, sixHundredPercentCoverageIssues, specLocationMismatchIssues, streetLightCountMismatchIssues, supportFormFactConsistencyIssues, supportSystemConflictIssues, tableArithmeticInconsistencyIssues } from './documentIntegrityChecks';
import { buildSemanticSimilarity } from './semanticSimilarity';
import { normalizeChapterTitleLine, requirementAcceptanceIssues, tenderRequirementCheckItems, tenderRequirementSemanticQuery } from './tenderRequirements';
import { internalTerminologyAnchorIssues } from './internalTerminologyAnchors';
import { parameterConceptConflictIssues } from './parameterConceptConflicts';
import { parameterObligationUsageIssues } from './chapterParameterFacts';
import type { BillFactLock } from './billFactLock';
import type { DrawingFactLock } from './drawingFactLock';
import { constructionSystemCoverageIssues } from './constructionSystemCoverage';
import { dangerousApplicabilityIssues } from './dangerousApplicability';
import { stagePhrasingIssues } from './stagePhrasing';
import { emergencySectionDepthIssues } from './emergencySectionDepth';
import { displayChapterTitle } from './outline';
import { blueprintCitationConsistencyIssues } from './integratedBlueprint';
import type { BlueprintData } from './integratedBlueprint';
import { blueprintEquipmentAuthorities, blueprintLaborPeakAuthority, blueprintPhaseLaborAuthorities, blueprintQuantityGroupAuthorities } from './authorityIndex';
import { det, detSafe } from './detectorFixerRegistry';
import { structureIntegrityIssues } from './structureIntegrityRules';
import { flowFormRepeatIssues, sentencePatternRepeatIssues, skeletonFingerprintIssues, templatedLabelIssues, titleIntegrityIssues } from './templatingGovernance';
import { factReconciliationIssues } from './factReconciliation';
import { basisRegulationsCrossIssues } from './basisRegulationsCross';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplate, DocumentTemplateChapter, NumericScopeConflict, PromptBinding, PromptDocumentRuleSet, TenderRequirementModel, ValidationIssue } from './types';

/**
 * 1.4 形态 B：跨章同名 H3 小节检测（各章独立并发成稿、章间无标题归属感知的串章实锤：
 * 「周边环境、管线与既有建构筑物保护」同现 1.3 与 6.4，「竣工清理、验收移交与保修」同现 1.4 与 6.5）。
 * 去编号后同名小节标题跨章出现即报；归属章按模板计划匹配裁决（模板 sections 含同名小节的章为归属章），
 * 模板未安排时首现章保留；模板计划本身多章安排同名小节（有意分工）不纳入。
 * 短通用标题（去编号 <8 字符，如「质量控制」「安全措施」）跨章重复属正常分工，不纳入（防误报）。
 * （原 DOCUMENT_TITLE_ALIGNMENT_CHECK 回退已固化删除：检测恒开）
 */
export function crossChapterDuplicateSectionIssues(chapters: DocumentDraftChapter[], templateChapters: DocumentTemplateChapter[]): ValidationIssue[] {
  const normalizeSection = (raw: string) => raw.replace(/^\d+(?:\.\d+)*[、.．\s]*/u, '').replace(/[\s,，、]/gu, '');
  // 成稿章标题归一化索引（模板章 → 成稿章按标题映射）
  const chapterIndexByTitle = new Map<string, number>();
  chapters.forEach((chapter, index) => {
    const key = displayChapterTitle(chapter.title).replace(/[\s,，、]/gu, '');
    if (key && !chapterIndexByTitle.has(key)) chapterIndexByTitle.set(key, index);
  });
  // 每章 H3 小节标题（去编号）→ 出现的章位列表 + 首现原文（消息展示用）
  const ownersByTitle = new Map<string, number[]>();
  const rawByTitle = new Map<string, string>();
  chapters.forEach((chapter, chapterIndex) => {
    const seen = new Set<string>();
    for (const line of (chapter.content || '').split(/\r?\n/u)) {
      const heading = /^###\s+(.+?)\s*$/u.exec(line.trim());
      if (!heading) continue;
      const key = normalizeSection(heading[1]);
      if (key.length < 8 || seen.has(key)) continue;
      seen.add(key);
      if (!rawByTitle.has(key)) rawByTitle.set(key, heading[1].replace(/^\d+(?:\.\d+)*[、.．\s]*/u, '').trim());
      const list = ownersByTitle.get(key) || [];
      list.push(chapterIndex);
      ownersByTitle.set(key, list);
    }
  });
  // 模板计划小节归属索引（同 normalize 口径）：title → 安排该小节的模板章对应成稿章位列表
  const plannedChapterIndexesByTitle = new Map<string, number[]>();
  templateChapters.forEach(templateChapter => {
    const chapterIndex = chapterIndexByTitle.get(displayChapterTitle(templateChapter.title).replace(/[\s,，、]/gu, ''));
    if (chapterIndex === undefined) return;
    for (const section of templateChapter.sections || []) {
      const key = normalizeSection(section);
      if (key.length < 8) continue;
      const list = plannedChapterIndexesByTitle.get(key) || [];
      if (!list.includes(chapterIndex)) list.push(chapterIndex);
      plannedChapterIndexesByTitle.set(key, list);
    }
  });
  const issues: ValidationIssue[] = [];
  for (const [title, chapterIndexes] of ownersByTitle) {
    if (chapterIndexes.length < 2) continue;
    const planned = plannedChapterIndexesByTitle.get(title) || [];
    // 模板计划多章安排同名小节 = 有意分工，不属串章漂移
    if (planned.length >= 2) continue;
    const ownerIndex = planned.length === 1 ? planned[0] : chapterIndexes[0];
    const displayTitle = rawByTitle.get(title) || title;
    for (const chapterIndex of chapterIndexes) {
      if (chapterIndex === ownerIndex) continue;
      const chapter = chapters[chapterIndex];
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        chapterId: chapter.id,
        sectionTitle: displayTitle,
        message: `跨章同名小节：“${displayTitle}”已在「${chapters[ownerIndex].title}」落位，本章（「${chapter.title}」）同名小节属跨章串章重复，须改写归并`,
        suggestion: '同一主题小节全文只保留一处（归属章）；非归属章的同名小节：内容与本章主题相关则改写标题为可区分的具体主题并归并内容，与本章无关则整节删除（含标题行）；修复后全文不得再出现跨章同名小节。',
      });
    }
  }
  return issues;
}

export async function buildStandardFinalValidationIssues(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  factsModel: DocumentFactsModel;
  template: DocumentTemplate;
  promptBindings: PromptBinding[];
  promptDocumentRules?: PromptDocumentRuleSet;
  /** 源级同口径冲突裁决（校验基准与生成裁决同源） */
  scopeConflicts?: NumericScopeConflict[];
  /** 招标文件评分条目标题（承接审计产物），用于后置正文命中检查 */
  evaluationCriteriaItems?: string[];
  /** 模块挂靠后的大纲（含四新等承诺小节）：承诺承接检查的基准，缺省回退 template.chapters */
  effectiveChapters?: DocumentTemplateChapter[];
  /** 招标文件文本性评分项要求（LLM 结构化提取产物），零响应检测锚点 */
  tenderRequirements?: TenderRequirementModel;
  /** 评分项要求↔章节语义相似度函数（本地 bge 余弦），变体表述响应兜底 */
  requirementsSimilarity?: (leftText: string, rightText: string) => number;
  /** 总量口径语义分类器（round-13）：事实反查口径归属语义复核（本地 bge 恒可用） */
  factTokenScopeClassifier: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定（本地 bge 恒可用） */
  professionalDepthClassifier: ProfessionalDepthClassifier;
  /** 一体化蓝图参数桶（生成前锁定口径）：蓝图引用冲突终检兑底（实时 finalMarkdown 重跑，替除生成阶段全卷快照） */
  blueprintData?: BlueprintData;
  /** 标书编制规格：正文禁表（招标显式禁表句）——缺表类门禁豁免与正文残留表格反向阻断依据 */
  bodyTableForbidden?: boolean;
  /** 标书编制规格：正文禁图（暗标/招标禁图片证据）——正文残留图片/图件占位反向阻断依据（F-T3） */
  bodyFigureForbidden?: boolean;
  /** 标书编制规格：投标人身份禁语（暗标）——正文身份标记零容忍终检依据（F-T3） */
  identityMarksForbidden?: boolean;
  /** 标书编制规格：封面口径（招标「不设内封面」优先于提示词要求） */
  coverForbidden?: boolean;
  /** B1 清单事实锁（4.27.0 A1）：参数口径冲突组多值分别命中不同清单条目时判误报降级 info（不阻断） */
  billFactLock?: BillFactLock;
  /** B-T3 图纸事实锁：可用图纸引用率验收（图纸事实在正文落位 ≥1 处/份）的判定源 */
  drawingFactLock?: DrawingFactLock;
  /** 绑定资料证据池：日期溯源检测用（资料里出现过的日期视为可溯源）——传数组本体而非拷贝，便于检测器按身份记忆化 */
  materialEvidence?: readonly { content?: string }[];
}): Promise<ValidationIssue[]> {
  const factVerification = await generatedFactVerificationIssuesAsync(input.markdown, input.factsModel, { scopeClassifier: input.factTokenScopeClassifier });
  // 招标要求正文级语义检测（终局全量对账）：要求条目 ↔（章节标题 + 正文句）同闭包 embedding，
  // 正文句采样与 documentIntegrityChecks.bodySentencesForSemantic 同口径；语义模型恒可用，空输入返回恒零函数
  const requirementQueries = tenderRequirementCheckItems(input.tenderRequirements).map(({ item }) => tenderRequirementSemanticQuery(item));
  const requirementChapterLines = input.markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => normalizeChapterTitleLine(line)).filter(Boolean).slice(0, 80);
  const requirementBodySentences = bodySentencesForSemantic(input.markdown, REQUIREMENTS_SEMANTIC_SENTENCE_LIMIT);
  const requirementsSimilarityForCoverage = await buildSemanticSimilarity(requirementQueries, [...requirementChapterLines, ...requirementBodySentences]);
  // 评分条目标题语义兑底专用闭包：evaluationCriteriaCoverageIssues 以条目标题原文为查询 key，
  // 必须与构建侧同口径（历史缺陷：误传 requirementsSimilarity——前附表条款闭包缓存 key 与条目标题不一致，语义兑底恒 0）
  const evaluationCriteriaSimilarity = await buildSemanticSimilarity(input.evaluationCriteriaItems || [], requirementChapterLines);
  // 预计算全部章节的专业深度语义分析（同一章节文本被多个校验器复用，只嵌入一次）；
  // 空文本章节返回 undefined 不入 Map（输入边界：无内容可分析，消费方按缺失跳过，不得用全 false 替身）
  const analyses = new Map((await Promise.all(input.chapters.map(async chapter => [chapter.title, await input.professionalDepthClassifier.analyze(chapter.content)] as const)))
    .filter((entry): entry is [string, ProfessionalDepthAnalysis] => Boolean(entry[1])));
  return [
    ...det('toc-consistency', () => input.promptDocumentRules?.forbidToc ? [] : [...tocHierarchyIssues(input.markdown), ...tocBodyConsistencyIssues(input.markdown)]),
    // L5 结构完整性门禁：正文 H3 编号连续性（章号=章序、节号 1..N 连续无跳号无重复）——
    // 降级合并重排的交付前兜底（缺号=blocker；不复用 toc-consistency 的 forbidToc 豁免，无目录也须编号连续）
    ...det('section-numbering', () => sectionNumberingIssues(input.markdown)),
    // L5 结构完整性门禁：成稿 H3 数不得超过主题块数（多节方向；缺节方向由 section-content-integrity 覆盖）
    ...det('section-count-overflow', () => sectionCountOverflowIssues(input.chapters)),
    ...det('heading-duplicate', () => headingDuplicateIssues(input.markdown)),
    // V2 批1 结构完整性终检（安全网，与写时质检/确定性清理器同源单扫描）：编号跳号/孤立编号/孤立
    // 单项列表/重复表头/表内重复行/完全重复行/相邻重复句（cleanable——确定性清理器 structure-integrity
    // 步收口，残留即暴露不静默）+ 句尾截断/空小节/表名混入表头/空表/标点断裂（blocking——须重写，宁缺毋假）
    ...det('structure-integrity', () => structureIntegrityIssues(input.markdown)),
    // WS1 结构标签残留终检（templatedLabelIssues）：标签标题/段首标签前缀——确定性修复器
    // fixTemplatedLabels（SURFACE_FIX_STEPS templated-labels 步）先行动作，此处兜底报告残留
    ...det('templated-label', () => templatedLabelIssues(input.markdown)),
    // WS1 标题完整性终检：残缺标题（「6.5 危大」<4 汉字）/句化标题（含逗号）/悬挂连接词结尾；
    // 规划层双闸（isInvalidPlannedSectionTitle / isInvalidTitle）的交付前兜底
    ...det('title-integrity', () => titleIntegrityIssues(input.markdown)),
    ...det('evaluation-criteria-coverage', () => evaluationCriteriaCoverageIssues(input.markdown, input.evaluationCriteriaItems || [], { semanticSimilarity: evaluationCriteriaSimilarity })),
    ...await detSafe('requirements-coverage', () => requirementAcceptanceIssues({ markdown: input.markdown, entries: tenderRequirementCheckItems(input.tenderRequirements).map(({ item }) => item), bodyTexts: requirementBodySentences, semanticSimilarity: requirementsSimilarityForCoverage })),
    ...det('fabricated-start-date', () => fabricatedStartDateIssues(input.markdown, input.factsModel, input.materialEvidence)),
    ...det('field-value-mismatch', () => fieldValueMismatchIssues(input.markdown, input.factsModel)),
    ...det('area-arithmetic', () => areaArithmeticIssues(input.markdown)),
    ...det('resource-consistency', () => resourceConsistencyIssues(input.markdown, { laborPeakAuthority: blueprintLaborPeakAuthority(input.blueprintData) })),
    // h13：节点工期口径互查（基坑支护/封顶/装饰多套第N日口径）
    ...det('node-schedule-consistency', () => nodeScheduleConsistencyIssues(input.markdown)),
    // h13：跨节数值口径冲突（XPS/垫层/变压器/模板周转/砌块/灭火器/潜水泵/急救箱确定性锚点）
    ...det('cross-section-numeric-conflict', () => crossSectionNumericConflictIssues(input.markdown)),
    // D4 数值对账六类（批 1 事实溯源专项机制化）：合计推导/规格-数值绑定/语义槽位/近似口径/
    // 分项显式/名称口径——正文数值 vs 清单事实锁 + 蓝图参数桶的关系型对账（权威缺失的规则自行跳过）
    ...det('fact-reconciliation', () => factReconciliationIssues({ markdown: input.markdown, billFactLock: input.billFactLock, blueprintData: input.blueprintData, factsModel: input.factsModel })),
    // 4.18.10 清单红线权威比对（丰乐镇第五版实测）：绿化养护期（P1 正文一年 vs 清单两年）/
    // 路灯数量（P3 正文 20 套 vs 清单 118 套）——清单权威单向判定，正文矛盾即 blocker；
    // 无对应清单条目不检测（不误伤无清单项目），分型号明细按总数口径与清单比对
    ...det('greening-maintenance-mismatch', () => greeningMaintenanceMismatchIssues(input.markdown, input.factsModel)),
    ...det('street-light-count-mismatch', () => streetLightCountMismatchIssues(input.markdown, input.factsModel)),
    // F14：规格错位终检兑底（正文规格 vs 清单权威按部位比对；权威映射缺失时静默跳过）
    ...det('spec-location-mismatch', () => specLocationMismatchIssues(input.markdown, input.factsModel.specAuthorityMap)),
    // 4.19.9 蓝图引用冲突终检兑底（与 globalQualityGates 生成阶段同源检测器的实时 finalMarkdown 重跑）：
    // 生成阶段全卷快照消息已在 recomputeFinalValidationBundle 中剔除，终稿蓝图口径冲突由本实时版唯一报告
    //（第五轮实测：终稿已把塑料管拆为 DN200 污水管 8205.53m / DN110 雨水管 7525.01m 两口径后，旧快照仍报单一蓝图冲突）
    ...await detSafe('blueprint-citation-consistency', async () => input.blueprintData ? (await blueprintCitationConsistencyIssues(input.markdown, input.blueprintData)).filter(issue => issue.level === 'error') : []),
    // V5 P4b 跨工程同值复制终检兑底：多村/多标段清单条目分组明细（groups）与正文分工程语境比对
    // （值恰为其他工程明细值 / 同值出现在多个工程对象语境且明细值不同）——与生成阶段检测器同源
    ...await detSafe('cross-project-value-copy', () => crossProjectValueCopyIssues(input.markdown, blueprintQuantityGroupAuthorities(input.blueprintData))),
    // V5 P4b 阶段人数混用终检兑底：正文「XX阶段 + N 人」vs byPhase 推导权威（阶段名命中但数值不符）
    ...det('phase-labor-mixing', () => phaseLaborMixingIssues(input.markdown, blueprintPhaseLaborAuthorities(input.blueprintData))),
    // 批2-1 机械分批求和终检兑底：句内「首批/剩余补充」分批台数并存但无组合等于权威总数
    //（丰乐镇实测「首批挖掘机 5 台…剩余挖掘机 5 台补充进场」5+5≠权威 5）
    ...det('equipment-batch-conflict', () => equipmentBatchConflicts(input.markdown, blueprintEquipmentAuthorities(input.blueprintData))),
    // 批2-1 前期动作时限终检兑底：前期准备动作（交底/考察/封样/编制审批…）时限落在开工后第 N 日且 N≥总工期
    //（丰乐镇实测「开工令下发后第 90 日内办理完成」占满全工期）
    ...det('preliminary-action-timing', () => preliminaryActionTimingIssues(input.markdown, input.blueprintData?.contract.totalDays)),
    // h13：桩基表述残留（地基与基础无桩基工序但全文残留桩基表述）
    ...det('foundation-form-residue', () => foundationFormResidueIssues(input.markdown)),
    // h14：关键设计决策两可表述阻断（评分报告 P4「桩基（或独立基础/筏板基础按图纸实施）」）
    ...det('ambiguous-either-or', () => ambiguousEitherOrIssues(input.markdown)),
    // h14：基坑深度数值锁定（评分报告 P1 资料有 5.85m 正文 0 处，危大分级失去依据）
    ...det('excavation-depth-lock', () => excavationDepthLockIssues(input.markdown)),
    // 4.19：危大分级判定交叉质检（资料深度 ≥3m 必标危大、≥5m 必标超危大+专家论证）
    ...det('excavation-hazard-classification', () => excavationHazardClassificationIssues(input.markdown, input.factsModel)),
    // 4.19：支护形式事实一致性（资料外支护体系词阻断 + 资料支护形式反向完整性落地）
    ...det('support-form-fact-consistency', () => supportFormFactConsistencyIssues(input.markdown, input.factsModel)),
    // 4.19：设备进场时间合理性（尾期进场荒谬 + 基坑阶段设备工序倒挂）
    ...det('equipment-entry-timing', () => equipmentEntryTimingIssues(input.markdown, input.factsModel)),
    // h14：奖项白名单（正文具名奖项必须来自招标要求/绑定资料，杜撰奖项即阻断）
    ...det('fabricated-award', () => fabricatedAwardIssues(input.markdown, input.factsModel, input.tenderRequirements)),
    // h17：投标人资格内容串章（评分报告 P1：营业执照/资质证书/安全生产许可证小节属资格文件内容，
    // 非施组正文；与生成前大纲过滤 isQualificationSectionTitle 同源，穿透生成前防线时由阻断修复轮确定性删除兜底）
    ...det('bidder-qualification-section', () => bidderQualificationSectionIssues(input.markdown)),
    // 1.4 形态 B：跨章同名 H3 小节（各章独立成稿串章实锤 1.3↔6.4、1.4↔6.5），归属按模板计划匹配章裁决
    ...det('cross-chapter-duplicate-section', () => crossChapterDuplicateSectionIssues(input.chapters, input.effectiveChapters || input.template.chapters || [])),
    // h13d：基本信息表「计划工期」字段违约词校验（工期行误填违约条款文字）
    ...det('basic-info-schedule-field', () => basicInfoScheduleFieldIssues(input.markdown)),
    // h15：表格/段落完全重复（青天高风险「重复表格 2 张、重复段落」；结构冗余删除兜底与生成闭环同源）
    ...det('duplicate-table', () => duplicateTableIssues(input.markdown)),
    ...det('duplicate-paragraph', () => duplicateParagraphIssues(input.markdown)),
    // 第十五版报告 A①：段落内句级复读（段尾复读剥离，跨位置整段重复的段内补充口径）
    ...det('paragraph-tail-repeat', () => paragraphTailRepeatIssues(input.markdown)),
    // 丰乐镇 doc-1788954795698 实测：主题块切分/拆半防撞名「公厕（1）」「公厕（1）（二）」泄漏目录，
    // 正式投标目录不允许编号后缀小节 → error 阻断 + 确定性修复器按主题域重命名/合并
    ...det('collision-numbered-heading', () => collisionNumberedHeadingIssues(input.markdown)),
    // 第十五版报告 A②：时间区间倒挂（「第90日至第3日」类病句，确定性剥离保留终点）
    ...det('inverted-date-range', () => invertedDateRangeIssues(input.markdown)),
    // h16：人材机三合一章结构层级（第五章层级错位缺陷：材/机保障体系降级 H4 挂在 5.1 下）
    ...det('resource-triad-section-hierarchy', () => resourceTriadSectionHierarchyIssues(input.markdown)),
    ...await det('support-system-conflict', () => supportSystemConflictIssues(input.markdown, extractSupportSystemAuthority(input.factsModel))),
    ...det('dangerous-list-consistency', () => dangerousListConsistencyIssues(input.markdown)),
    // R12 危大排除声明 vs 危大清单表格矛盾（舒城第二轮实测：声明无24m脚手架/无10kN吊装，
    // 危大清单表格却列为危大工程——评标专家可直接质疑辨识可靠性，llm 修复轮二选一归并口径）
    ...det('hazard-exclusion-contradiction', () => hazardExclusionContradictionIssues(input.markdown)),
    ...await det('six-hundred-percent-coverage', () => sixHundredPercentCoverageIssues(input.markdown)),
    ...await det('self-undermining-candidate', () => selfUnderminingCandidateIssues(input.markdown)),
    ...det('paragraph-opening-repeat', () => paragraphOpeningRepeatIssues(input.markdown)),
    // WS3 分部分项章相邻块工序表达形式重复（写作侧 index%4 轮换指定与首轮块质检的生后验收兜底）
    ...det('flow-form-repeat', () => flowFormRepeatIssues(input.markdown)),
    // WS4 骨架指纹复读（由技术负责人组织 / 合格后方可 / 验收合格后 各全文 ≤2 次 + 4.40 d5e 变体形态单形态 ≤8 次，round-2 确定性兜底同源清零）
    ...det('skeleton-fingerprint', () => skeletonFingerprintIssues(input.markdown)),
    // C4 句模聚类复读（D3 检测器扩面）：同模式句 ≥6 次即命中（多段顺序词链/完成即转入/验收衔接/
    // 资料闭环式/形式宣告式），语义套话原型不覆盖的结构句式复读改由本通道判定；修复轮 repairTemplatingIssues
    // 消费同源句模修复目标（检测定位=修复定位）
    ...det('sentence-pattern-repeat', () => sentencePatternRepeatIssues(input.markdown)),
    // Q8 叠词重复表述（L1 封闭结构提取 + 确定性去重）
    ...det('repeated-word', () => repeatedWordIssues(input.markdown)),
    // Q3 商务条款数据入正文（商务词封闭集确定性 + 变体弱词语义复核，徽光阁实测暂列金额 60 万入正文）
    ...await det('commercial-data-in-body', () => commercialDataInBodyIssues(input.markdown)),
    ...det('overview-recap', () => overviewRecapIssues(input.markdown)),
    ...det('closure-phrase-density-cap', () => closurePhraseDensityCapIssues(input.markdown)),
    // C1 参数概念多口径冲突（bge 概念自组织聚类 + 同簇数值冲突；末期安全包装：失败降级为待复核不硬停）
    ...await detSafe('parameter-concept-conflict', () => parameterConceptConflictIssues(input.markdown, { billFactLock: input.billFactLock, blueprintQuantities: input.blueprintData?.quantities })),
    // C2 内部话术语义锚点泄漏（bge 句子级锚点匹配 + 精确词兜底；末期安全包装）
    ...await detSafe('internal-terminology-anchor', () => internalTerminologyAnchorIssues(input.markdown)),
    // C3 招标范围工程系统零覆盖（章节标题义务提取 + 正文词面覆盖，确定性判定）
    ...det('construction-system-coverage', () => constructionSystemCoverageIssues(input.chapters)),
    // C4 危大工程兜底适用性（前提参数阈值判定 + 辨识区别名覆盖，确定性判定）
    ...det('dangerous-applicability', () => dangerousApplicabilityIssues(input.markdown)),
    ...det('innovation-tech-coverage', () => innovationTechCoverageIssues(input.markdown, input.effectiveChapters || input.template.chapters || [])),
    ...det('instruction-like-heading', () => instructionLikeHeadingIssues(input.markdown)),
    ...det('formal-heading-hierarchy', () => formalHeadingHierarchyIssues(input.markdown)),
    ...det('formal-content-integrity', () => formalContentIntegrityIssues(input.markdown)),
    // 十度实测缺陷：法规长列举句 LLM 输出自吞噬中间段（「2017年修正）、《中华人民共和国」丢失后直接拼接）、
    // 句子删除残留「。；」标点叠用——交付前确定性兑底（括号/书名号成对性 + 标点叠用），穿透即 error 进修复轮
    ...det('punctuation-artifact', () => punctuationArtifactIssues(input.markdown)),
    ...det('table-quality', () => markdownTableQualityIssues(input.markdown)),
    ...det('table-spam', () => tableSpamIssues(input.markdown)),
    // 十度实测缺陷：编制依据法规/规范四段式（国家法规、地方性法规、验收规范、招标文件法规）LLM 偶发漏写，
    // 交付前确定性兑底（法规/条例/规范由写作模型自行列写，本检测只兑底具体条目存在），漏写即 error 进修复轮
    ...det('basis-regulations-coverage', () => basisRegulationsCoverageIssues(input.markdown, input.blueprintData)),
    // C5 一致性类（P6）：编制依据↔正文双向对账（声明未用/用了未声明逐条带证据）——
    // coverage 查条目存在性（五类各自 ≥1），本检测查双向引用一致性（缺口独立成 blocker/warning，
    // 修复轮 basis-regulations-cross-repair 同源消费；区段/匹配原语与修复端单源）
    ...det('basis-regulations-cross', () => basisRegulationsCrossIssues(input.markdown)),
    // 十度实测缺陷：资源章工种构成人数/机械台数/同名多规格材料拆分数量 LLM 自行分配与蓝图权威漂移，
    // 交付前确定性兑底（保守口径只比对「名称后紧邻数字+单位」形态），漂移即 error 进修复轮
    ...det('resource-breakdown-consistency', () => resourceBreakdownConsistencyIssues(input.markdown, input.blueprintData)),
    ...det('section-content-integrity', () => sectionContentIntegrityIssues(input.markdown, input.chapters)),
    ...det('professional-content', () => professionalContentIssues(input.chapters, analyses)),
    ...det('professional-score', () => professionalScoreIssues(input.chapters, analyses)),
    ...det('generic-professional-content', () => genericProfessionalContentIssues(input.chapters, analyses)),
    ...det('management-measure-number', () => managementMeasureNumberIssues(input.chapters, analyses)),
    ...await det('closed-loop-density', () => closedLoopDensityIssues(input.markdown)),
    ...await det('cross-chapter-consistency', () => crossChapterConsistencyIssues(input.markdown, input.factsModel, input.scopeConflicts, analyses)),
    ...await det('process-spec-conflict', () => processSpecConflictIssues(input.markdown, input.factsModel)),
    ...det('evidence-usage-coverage', () => evidenceUsageCoverageIssues(input.markdown, input.factsModel)),
    ...await det('paragraph-generic', () => paragraphGenericIssues(input.markdown, input.professionalDepthClassifier)),
    ...await det('construction-org-generic-language', () => constructionOrgGenericLanguageIssues(input.chapters)),
    ...det('construction-org-control-loop', () => constructionOrgControlLoopIssues(input.chapters)),
    ...det('construction-org-professional-chain', () => constructionOrgProfessionalChainIssues({ markdown: input.markdown, factsModel: input.factsModel, chapters: input.chapters })),
    ...det('construction-org-consistency', () => constructionOrgConsistencyIssues(input.markdown, input.factsModel)),
    ...det('construction-org-chapter-data-coverage', () => constructionOrgChapterDataCoverageIssues(input.chapters, input.factsModel)),
    ...det('construction-org-major-content', () => constructionOrgMajorContentIssues(input.chapters, input.markdown)),
    ...det('construction-org-division-section', () => constructionOrgDivisionSectionIssues(input.chapters, input.markdown)),
    // G2 关键小节清单口径治理（禁表格承载正文 + 禁清单内部口径词，与生成闭环同源）
    ...det('major-content-governance', () => majorContentGovernanceIssues(input.markdown)),
    ...det('construction-org-bonus-module', () => constructionOrgBonusModuleIssues(input.chapters)),
    ...det('chapter-dependency', () => chapterDependencyIssues(input.chapters, analyses)),
    ...det('document-delivery-score', () => documentDeliveryScoreIssues(input.markdown, input.chapters, input.factsModel, analyses)),
    ...det('generated-fact-verification', () => factVerification),
    // C-T2 未溯源数值验收（扫描口径与分类器/修复器单源）：终稿未溯源数字 = 0（规范常数/管理数字
    // 已豁免；真未溯源由 llm_repairable 进修复链，链尾 demote 确定性改定性兜底；不硬阻断导出）
    ...det('numeric-traceability', () => numericTraceabilityIssues(input.markdown, input.factsModel)),
    // C-T3 表内算术自洽验收（含显性合计标记的表格：分项和=合计；与修复轮 stageTableArithmeticRepair
    // 同源重扫，检测定位=修复定位；llm_repairable 进修复链，不硬阻断导出）
    ...det('table-arithmetic-consistency', () => tableArithmeticInconsistencyIssues(input.markdown)),
    ...det('duplicate-basic-info', () => duplicateBasicInfoIssues(input.markdown)),
    ...await det('formal-style', () => formalStyleIssues(input.markdown)),
    ...det('tertiary-heading', () => tertiaryHeadingIssues(input.markdown)),
    ...det('min-chapter-section', () => minChapterSectionIssues(input.chapters)),
    // Q11 事实落位（关键参数抽查）：字面匹配 + 本地 bge 语义兜底
    ...await det('precise-fact-usage', () => preciseFactUsageIssues(input.markdown, input.factsModel, input.chapters)),
    // C3-4 可靠参数义务落位（参数池净化后义务满足率 <90% → error）：与报告出口 parameterUsageAudit.rate /
    // 修复出口 assignMissingParameterChapters 同源（classifyParameterUsage）——此前参数义务缺口仅在关键参数
    // blocker 存在时随轮消费（挂靠缺口，s28l 关键池达标其余额 94 条零消费直坠终门禁）
    ...det('parameter-obligation-usage', () => parameterObligationUsageIssues(input.markdown, input.factsModel, input.chapters)),
    // Q1 清单落位（C3-5 单源化）：行识别/豁免/落位判定消费 buildBoqRowTraces（与报告出口同源），
    // 字面三通道（首段 12/整名 12/编码 8）+ 本地 bge 语义兜底，有效行处置率 <90% 升 error（provenance
    // 锚定 'boq-placement' 供修复轮消费；历史挂靠缺口：17 轮修复无一消费直坠终门禁）
    ...await det('boq-placement', () => boqPlacementIssues(input.markdown, input.chapters, input.factsModel)),
    // Q5 施工阶段划分口径（L1 提取阶段划分句 + bge 语义聚类互异簇 → error）
    ...await det('stage-phrasing', () => stagePhrasingIssues(input.markdown)),
    // C5 应急预案小节深度门槛（≥300 字 + 组织/流程/物资三要素，标题召回 + bge 语义判定）
    ...await det('emergency-section-depth', () => emergencySectionDepthIssues(input.markdown)),
    ...det('boq-row-trace', () => boqRowTraceIssues(buildBoqRowTraces(input.markdown, input.factsModel))),
    ...det('drawing-reference', () => drawingReferenceIssues(input.markdown, input.drawingFactLock)),
    ...det('web-evidence-leakage', () => webEvidenceLeakageIssues(input.markdown)),
    ...det('formal-placeholder', () => formalPlaceholderIssues(input.markdown)),
    ...det('prompt-example-leak', () => promptExampleLeakIssues(input.markdown, input.promptBindings)),
    ...det('degenerate-content', () => degenerateContentIssues(input.markdown, input.chapters)),
    ...det('planned-auto-spec-gate', () => plannedAutoSpecGateIssues(input.markdown, input.template)),
    // 正文表格授权门禁（标书编制规格 C1 证据驱动口径）：
    // ① 显式禁表句（bodyTableForbidden）：正文残留任何表格即 blocker；
    // ② 允许口径（默认）：未列入表格授权计划的章出现表格即 blocker——授权章 = 有表格计划/静态表格
    //    声明/图类承载指令的章（表格须来自系统计划，不得自设）；提示词必需表格按表名豁免（兜底插入防拆）
    ...det('bid-composition-body-table', () => bodyCompositionTableIssues(input.markdown, {
      bodyTableForbidden: input.bodyTableForbidden,
      plannedChapterTitles: (input.effectiveChapters?.length ? input.effectiveChapters : input.template.chapters)
        .filter(chapter => (chapter.tablePlans?.length || 0) > 0 || (chapter.tableSections?.length || 0) > 0 || (chapter.diagramRequirements?.length || 0) > 0)
        .map(chapter => chapter.title),
      requiredTableTitles: input.promptDocumentRules?.requiredTables || [],
    })),
    // F-T3 暗标正文禁图（标书编制规格）：残留图片/图件占位反向阻断（确定性剥离链的终检兜底）
    ...det('bid-composition-body-figure', () => bodyCompositionFigureIssues(input.markdown, input.bodyFigureForbidden)),
    // F-T3 暗标身份禁语零容忍终检（identityMarksForbidden）：业绩/获奖表述与证书编号类自我标识即 blocker
    ...det('identity-marks-forbidden', () => identityLeakageIssues(input.markdown, input.identityMarksForbidden)),
    ...det('planned-structure', () => plannedStructureIssues(input.markdown, input.template, input.bodyTableForbidden)),
    // R20 C3 表题注终检：正文区表格逐张核验「表X-Y」（注入器安全网，昭标豁免）
    ...det('table-caption', () => tableCaptionIssues(input.markdown, input.bodyTableForbidden)),
    ...await det('prompt-document-rule', () => promptDocumentRuleIssues(input.markdown, input.promptDocumentRules, undefined, { bodyTableForbidden: input.bodyTableForbidden, coverForbidden: input.coverForbidden })),
    // E11：属地适配与政策合规（创优目标/四节一环保量化/工伤保险），
    // 排在末尾使修复循环 slice 截断时让位高优先级 blocker；round-20 S1 已加语义判定（async）
    ...await det('local-adaptation-keyword', () => localAdaptationKeywordIssues(input.markdown, input.factsModel)),
    // P2/P4 清单分项覆盖义务（评分报告公厕/过路涵/污水管网/排水沟/沟塘清淤/小菜园整体缺失）：
    // 排在末位与 E11 同原则——让位高优先级 blocker，修复循环截断时不被优先处理
    ...det('boq-division-coverage', () => boqDivisionCoverageIssues(input.markdown, input.chapters, input.factsModel)),
  ];
}
