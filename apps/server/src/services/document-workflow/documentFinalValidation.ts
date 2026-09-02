import { closedLoopDensityIssues, plannedAutoSpecGateIssues, boqPlacementIssues, crossChapterConsistencyIssues, degenerateContentIssues, drawingReferenceIssues, duplicateBasicInfoIssues, evaluationCriteriaCoverageIssues, formalContentIntegrityIssues, formalHeadingHierarchyIssues, formalPlaceholderIssues, formalStyleIssues, generatedFactVerificationIssuesAsync, genericProfessionalContentIssues, headingDuplicateIssues, innovationTechCoverageIssues, instructionLikeHeadingIssues, managementMeasureNumberIssues, markdownTableQualityIssues, minChapterSectionIssues, preciseFactUsageIssues, processSpecConflictIssues, professionalContentIssues, professionalScoreIssues, promptExampleLeakIssues, sectionContentIntegrityIssues, tableSpamIssues, tocBodyConsistencyIssues, tocHierarchyIssues } from './qualityValidation';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type { ProfessionalDepthAnalysis, ProfessionalDepthClassifier } from './professionalDepthClassifier';
import { boqRowTraceIssues, buildBoqRowTraces } from './documentFactTrace';
import { chapterDependencyIssues, documentDeliveryScoreIssues, evidenceUsageCoverageIssues, paragraphGenericIssues } from './documentDeliveryReport';
import { plannedStructureIssues, promptDocumentRuleIssues, tertiaryHeadingIssues } from './markdownComposer';
import { webEvidenceLeakageIssues } from './webResearchService';
import { constructionOrgChapterDataCoverageIssues, constructionOrgConsistencyIssues } from './constructionOrgConsistency';
import { constructionOrgBonusModuleIssues, constructionOrgControlLoopIssues, constructionOrgDivisionSectionIssues, constructionOrgGenericLanguageIssues, constructionOrgMajorContentIssues, constructionOrgProfessionalChainIssues } from './constructionOrgQualityRules';
import { ambiguousEitherOrIssues, areaArithmeticIssues, basicInfoScheduleFieldIssues, bidderQualificationSectionIssues, bodySentencesForSemantic, closurePhraseDensityCapIssues, collapseRepeatedWords, commercialDataInBodyIssues, crossSectionNumericConflictIssues, dangerousListConsistencyIssues, duplicateParagraphIssues, duplicateTableIssues, excavationDepthLockIssues, fabricatedAwardIssues, fabricatedStartDateIssues, fieldValueMismatchIssues, foundationFormResidueIssues, localAdaptationKeywordIssues, nodeScheduleConsistencyIssues, overviewRecapCandidates, overviewRecapIssues, paragraphOpeningRepeatIssues, repeatedWordIssues, resourceConsistencyIssues, resourceTriadSectionHierarchyIssues, selfUnderminingCandidateIssues, sixHundredPercentCoverageIssues, stripCommercialDataSentences, supportSystemConflictIssues } from './documentIntegrityChecks';
import { buildSemanticSimilarity } from './semanticSimilarity';
import { normalizeChapterTitleLine, requirementsCoverageIssues, tenderRequirementCheckItems, tenderRequirementSemanticQuery } from './tenderRequirements';
import { internalTerminologyAnchorIssues } from './internalTerminologyAnchors';
import { parameterConceptConflictIssues } from './parameterConceptConflicts';
import { constructionSystemCoverageIssues } from './constructionSystemCoverage';
import { dangerousApplicabilityIssues } from './dangerousApplicability';
import { stagePhrasingIssues } from './stagePhrasing';
import { emergencySectionDepthIssues } from './emergencySectionDepth';
import { displayChapterTitle } from './outline';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplate, DocumentTemplateChapter, NumericScopeConflict, PromptBinding, PromptDocumentRuleSet, TenderRequirementModel, ValidationIssue } from './types';

/**
 * 1.4 形态 B：跨章同名 H3 小节检测（各章独立并发成稿、章间无标题归属感知的串章实锤：
 * 「周边环境、管线与既有建构筑物保护」同现 1.3 与 6.4，「竣工清理、验收移交与保修」同现 1.4 与 6.5）。
 * 去编号后同名小节标题跨章出现即报；归属章按模板计划匹配裁决（模板 sections 含同名小节的章为归属章），
 * 模板未安排时首现章保留；模板计划本身多章安排同名小节（有意分工）不纳入。
 * 短通用标题（去编号 <8 字符，如「质量控制」「安全措施」）跨章重复属正常分工，不纳入（防误报）。
 * env DOCUMENT_TITLE_ALIGNMENT_CHECK=0 回退。
 */
export function crossChapterDuplicateSectionIssues(chapters: DocumentDraftChapter[], templateChapters: DocumentTemplateChapter[]): ValidationIssue[] {
  if (process.env.DOCUMENT_TITLE_ALIGNMENT_CHECK === '0') return [];
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
  /** 总量口径语义分类器（round-13）：事实反查的口径归属语义复核（本地 bge 恒可用） */
  factTokenScopeClassifier: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定（本地 bge 恒可用） */
  professionalDepthClassifier: ProfessionalDepthClassifier;
}): Promise<ValidationIssue[]> {
  const factVerification = await generatedFactVerificationIssuesAsync(input.markdown, input.factsModel, { scopeClassifier: input.factTokenScopeClassifier });
  // W4/P3 评分项要求正文级语义检测：要求项 ↔（章节标题 + 正文句）同闭包 embedding，
  // 正文句采样与 documentIntegrityChecks.bodySentencesForSemantic 同口径（历史缺陷：只查章节标题，
  // 正文未落位而标题语义接近即误判为已响应）；语义模型恒可用，空输入由 buildSemanticSimilarity 返回恒零函数
  const requirementQueries = tenderRequirementCheckItems(input.tenderRequirements).map(({ item }) => tenderRequirementSemanticQuery(item));
  const requirementChapterLines = input.markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => normalizeChapterTitleLine(line)).filter(Boolean).slice(0, 80);
  const requirementBodySentences = bodySentencesForSemantic(input.markdown);
  const requirementsSimilarityForCoverage = await buildSemanticSimilarity(requirementQueries, [...requirementChapterLines, ...requirementBodySentences]);
  // 评分条目标题语义兑底专用闭包：evaluationCriteriaCoverageIssues 以条目标题原文为查询 key，
  // 必须与构建侧同口径（历史缺陷：误传 requirementsSimilarity——前附表条款闭包缓存 key 与条目标题不一致，语义兑底恒 0）
  const evaluationCriteriaSimilarity = await buildSemanticSimilarity(input.evaluationCriteriaItems || [], requirementChapterLines);
  // 预计算全部章节的专业深度语义分析（同一章节文本被多个校验器复用，只嵌入一次）；
  // 空文本章节返回 undefined 不入 Map（输入边界：无内容可分析，消费方按缺失跳过，不得用全 false 替身）
  const analyses = new Map((await Promise.all(input.chapters.map(async chapter => [chapter.title, await input.professionalDepthClassifier.analyze(chapter.content)] as const)))
    .filter((entry): entry is [string, ProfessionalDepthAnalysis] => Boolean(entry[1])));
  // 概况复述语义兑底：结构召回“本项目为”句 + bge 余弦 vs 概况章正文；空输入由恒零函数承接
  const recapCandidates = overviewRecapCandidates(input.markdown);
  const overviewSimilarity = await buildSemanticSimilarity(recapCandidates.sentences, recapCandidates.overviewBody ? [recapCandidates.overviewBody] : []);
  return [
    ...(input.promptDocumentRules?.forbidToc ? [] : [...tocHierarchyIssues(input.markdown), ...tocBodyConsistencyIssues(input.markdown)]),
    ...headingDuplicateIssues(input.markdown),
    ...evaluationCriteriaCoverageIssues(input.markdown, input.evaluationCriteriaItems || [], { semanticSimilarity: evaluationCriteriaSimilarity }),
    ...await requirementsCoverageIssues(input.markdown, input.tenderRequirements, { semanticSimilarity: requirementsSimilarityForCoverage, bodyTexts: requirementBodySentences }),
    ...fabricatedStartDateIssues(input.markdown, input.factsModel),
    ...fieldValueMismatchIssues(input.markdown, input.factsModel),
    ...areaArithmeticIssues(input.markdown),
    ...resourceConsistencyIssues(input.markdown),
    // h13：节点工期口径互查（基坑支护/封顶/装饰多套第N日口径）
    ...nodeScheduleConsistencyIssues(input.markdown),
    // h13：跨节数值口径冲突（XPS/垫层/变压器/模板周转/砌块/灭火器/潜水泵/急救箱确定性锚点）
    ...crossSectionNumericConflictIssues(input.markdown),
    // h13：桩基表述残留（地基与基础无桩基工序但全文残留桩基表述）
    ...foundationFormResidueIssues(input.markdown),
    // h14：关键设计决策两可表述阻断（评分报告 P4「桩基（或独立基础/筏板基础按图纸实施）」）
    ...ambiguousEitherOrIssues(input.markdown),
    // h14：基坑深度数值锁定（评分报告 P1 资料有 5.85m 正文 0 处，危大分级失去依据）
    ...excavationDepthLockIssues(input.markdown),
    // h14：奖项白名单（正文具名奖项必须来自招标要求/绑定资料，杜撰奖项即阻断）
    ...fabricatedAwardIssues(input.markdown, input.factsModel, input.tenderRequirements),
    // h17：投标人资格内容串章（评分报告 P1：营业执照/资质证书/安全生产许可证小节属资格文件内容，
    // 非施组正文；与生成前大纲过滤 isQualificationSectionTitle 同源，穿透生成前防线时由阻断修复轮确定性删除兜底）
    ...bidderQualificationSectionIssues(input.markdown),
    // 1.4 形态 B：跨章同名 H3 小节（各章独立成稿串章实锤 1.3↔6.4、1.4↔6.5），归属按模板计划匹配章裁决
    ...crossChapterDuplicateSectionIssues(input.chapters, input.effectiveChapters || input.template.chapters || []),
    // h13d：基本信息表「计划工期」字段违约词校验（工期行误填违约条款文字）
    ...basicInfoScheduleFieldIssues(input.markdown),
    // h15：表格/段落完全重复（青天高风险「重复表格 2 张、重复段落」；结构冗余删除兜底与生成闭环同源）
    ...duplicateTableIssues(input.markdown),
    ...duplicateParagraphIssues(input.markdown),
    // h16：人材机三合一章结构层级（第五章层级错位缺陷：材/机保障体系降级 H4 挂在 5.1 下）
    ...resourceTriadSectionHierarchyIssues(input.markdown),
    ...await supportSystemConflictIssues(input.markdown),
    ...dangerousListConsistencyIssues(input.markdown),
    ...await sixHundredPercentCoverageIssues(input.markdown),
    ...await selfUnderminingCandidateIssues(input.markdown),
    ...paragraphOpeningRepeatIssues(input.markdown),
    // Q8 叠词重复表述（L1 封闭结构提取 + 确定性去重）
    ...repeatedWordIssues(input.markdown),
    // Q3 商务条款数据入正文（商务词封闭集确定性 + 变体弱词语义复核，徽光阁实测暂列金额 60 万入正文）
    ...await commercialDataInBodyIssues(input.markdown),
    ...overviewRecapIssues(input.markdown, { semanticSimilarity: overviewSimilarity }),
    ...closurePhraseDensityCapIssues(input.markdown),
    // C1 参数概念多口径冲突（bge 概念自组织聚类 + 同簇数值冲突）
    ...await parameterConceptConflictIssues(input.markdown),
    // C2 内部话术语义锚点泄漏（bge 句子级锚点匹配 + 精确词兜底）
    ...await internalTerminologyAnchorIssues(input.markdown),
    // C3 招标范围工程系统零覆盖（章节标题义务提取 + 正文词面覆盖，确定性判定）
    ...constructionSystemCoverageIssues(input.chapters),
    // C4 危大工程兜底适用性（前提参数阈值判定 + 辨识区别名覆盖，确定性判定）
    ...dangerousApplicabilityIssues(input.markdown),
    ...innovationTechCoverageIssues(input.markdown, input.effectiveChapters || input.template.chapters || []),
    ...instructionLikeHeadingIssues(input.markdown),
    ...formalHeadingHierarchyIssues(input.markdown),
    ...formalContentIntegrityIssues(input.markdown),
    ...markdownTableQualityIssues(input.markdown),
    ...tableSpamIssues(input.markdown),
    ...sectionContentIntegrityIssues(input.markdown, input.chapters),
    ...professionalContentIssues(input.chapters, analyses),
    ...professionalScoreIssues(input.chapters, analyses),
    ...genericProfessionalContentIssues(input.chapters, analyses),
    ...managementMeasureNumberIssues(input.chapters, analyses),
    ...await closedLoopDensityIssues(input.markdown),
    ...await crossChapterConsistencyIssues(input.markdown, input.factsModel, input.scopeConflicts, analyses),
    ...await processSpecConflictIssues(input.markdown, input.factsModel),
    ...evidenceUsageCoverageIssues(input.markdown, input.factsModel),
    ...await paragraphGenericIssues(input.markdown, input.professionalDepthClassifier),
    ...await constructionOrgGenericLanguageIssues(input.chapters),
    ...constructionOrgControlLoopIssues(input.chapters),
    ...constructionOrgProfessionalChainIssues({ markdown: input.markdown, factsModel: input.factsModel, chapters: input.chapters }),
    ...constructionOrgConsistencyIssues(input.markdown, input.factsModel),
    ...constructionOrgChapterDataCoverageIssues(input.chapters, input.factsModel),
    ...constructionOrgMajorContentIssues(input.chapters, input.markdown),
    ...constructionOrgDivisionSectionIssues(input.chapters, input.markdown),
    ...constructionOrgBonusModuleIssues(input.chapters),
    ...chapterDependencyIssues(input.chapters, analyses),
    ...documentDeliveryScoreIssues(input.markdown, input.chapters, input.factsModel, analyses),
    ...factVerification,
    ...duplicateBasicInfoIssues(input.markdown),
    ...await formalStyleIssues(input.markdown),
    ...tertiaryHeadingIssues(input.markdown),
    ...minChapterSectionIssues(input.chapters),
    // Q11 事实落位（关键参数抽查）：字面匹配 + 本地 bge 语义兜底
    ...await preciseFactUsageIssues(input.markdown, input.factsModel, input.chapters),
    // Q1 清单落位：字面匹配 + 本地 bge 语义兜底，落位率 <60% 升 error 进修复循环
    ...await boqPlacementIssues(input.markdown, input.chapters, input.factsModel),
    // Q5 施工阶段划分口径（L1 提取阶段划分句 + bge 语义聚类互异簇 → error）
    ...await stagePhrasingIssues(input.markdown),
    // C5 应急预案小节深度门槛（≥300 字 + 组织/流程/物资三要素，标题召回 + bge 语义判定）
    ...await emergencySectionDepthIssues(input.markdown),
    ...boqRowTraceIssues(buildBoqRowTraces(input.markdown, input.factsModel)),
    ...drawingReferenceIssues(input.markdown, input.factsModel),
    ...webEvidenceLeakageIssues(input.markdown),
    ...formalPlaceholderIssues(input.markdown),
    ...promptExampleLeakIssues(input.markdown, input.promptBindings),
    ...degenerateContentIssues(input.markdown, input.chapters),
    ...plannedAutoSpecGateIssues(input.markdown, input.template),
    ...plannedStructureIssues(input.markdown, input.template),
    ...await promptDocumentRuleIssues(input.markdown, input.promptDocumentRules),
    // round-18 E11：安徽省属地适配与政策合规（创优目标/四节一环保量化/工伤保险），
    // 排在末尾使修复循环 slice 截断时让位高优先级 blocker；round-20 S1 已加语义判定（async）
    ...await localAdaptationKeywordIssues(input.markdown, input.factsModel),
  ];
}
