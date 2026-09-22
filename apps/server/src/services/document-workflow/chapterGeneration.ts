import * as path from 'node:path';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentDraftChapter, DocumentEvidence, DocumentFact, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ResolvedFactNeed, SpecAuthorityMap, ValidationIssue } from './types';
import { documentTextLength } from './budget';
import { buildChapterEvidencePool, buildEvidenceBundle, cleanEvidenceText, evidenceBundlePrompt, evidencePromptBudgetForTarget, extractKeyFactLines } from './evidence';
import { reconcileContentNumbers, renderNumericFeedback } from './numericalConsistency';
import { FORMAL_WRITING_RULES, SECTION_GENERATION_SAFETY_RULES, docSystemPrefix, removeUnwantedDrawingImages, sanitizeFormalMarkdown, writerSystemPrefix } from './markdownComposer';
import { callDocumentLlm, callDocumentLlmJson, contextLayerChars, getDocumentLlmMaxConcurrency } from './llmClient';
import { alignSimilarHeadingsToPlan, dedupeRepeatedSubsections, findDuplicateH4Titles, findExtraneousBlockTitles, normalizeSubsectionTitleForDedup, stringifyFactValue, stripExtraneousBlockHeadings, throwIfAborted } from './utils';
import { measureGenerationStep } from './rolePipeline';
import { normalizePlannedSections, sectionTitleEquivalent } from './promptRuleExtraction';
import { diagramRequirementsPrompt, tablePlansPrompt, unassignedSectionTablePlans } from './constructionOrgTablePlan';
import { bidCompositionWritingRules, isBodyTableForbidden, type BidCompositionSpec } from './bidComposition';
import { constructionOrgBonusModulePrompt, constructionOrgChapterRulePrompt, constructionOrgProjectTypePrompt } from './constructionOrgQualityRules';
import { renderBlueprintBlockSlice, renderBlueprintDataTextForBlock } from './integratedBlueprint';
import type { BlueprintChapter, BlueprintData } from './integratedBlueprint';
import { criticalSectionBlockerMinChars, ensureGroupTertiaryShell, isCriticalDeepSection, matchBlockSkeletonNames, sectionStructureIssue, stripMarkdownTableBlocks, workPackageSkeletonPrompt, workPackageSkeletonTitles } from './chapterPostProcessing';
// V2 批1 结构完整性单源（扫描/清理/反馈/终检包装四件套）：写时块质检与小节质检共用，检测定位=清理定位
import { cleanStructureDefects, scanStructureDefects, structureIntegrityFeedback } from './structureIntegrityRules';
// 4.44 写时表名混表头归一（门禁链源头根治）：表题独立成行后再进入结构扫描/清理（判据与 scanTables 同源）
import { normalizeTableTitleInHeaders } from './tableRepairHelpers';
import { HAS_QUANTIFIED_VALUE_RE, PRECISE_TOKEN_RE, QUANTIFIED_FACT_RE } from './parameterPatterns';
import { det } from './detectorFixerRegistry';
import { BLOCK_FACT_DENSITY_PER1000, assessBlockFactDensity, attributionBlockingOf, backstageFallbackHits, requiresAttributionQuantification, scanAttributionQuantification, scanBlockTemplating, templatingBlockingOf, type AttributionQuantificationVerdict, type BlockTemplatingVerdict } from './blockQualityExecutors';
import { buildSemanticGate } from './semanticGate';
import type { PlannedChapterBlock, PlannedChapterStructure } from './integratedBlueprint';
import { cleanFactValue, isActionableFactValue } from './documentFactTrace';
import { DIVISION_SECTION_RE, MAJOR_CONTENT_SECTION_RE, chapterAnchoredRules } from './writingSpec';
import { flowFormForBlockIndex, flowRotationDirective, primaryFlowForm } from './templatingGovernance';
import { tuningProfile } from './tuningProfile';

export * from './chapterPostProcessing';


export function buildValidationIssues(validation: { warnings: string[]; errors: string[] }, factsModel: DocumentFactsModel, draftChapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...validation.errors.map(message => ({ level: 'error' as const, message, suggestion: '请补充配置或资料后重新生成。' })),
    ...validation.warnings.map(message => ({ level: 'warning' as const, message, suggestion: '建议人工确认或补充对应资料。' })),
  ];
  if (draftChapters.some(chapter => /资料未提供|系统暂未从知识库确认/u.test(chapter.content))) issues.push({ level: 'warning', message: '存在系统暂未从知识库确认的章节内容', suggestion: '请检查项目角色配置、文件绑定顺序和事实抽取落位结果。' });
  if (factsModel.conflicts.length > 0) issues.push(...factsModel.conflicts.map(message => ({ level: 'warning' as const, message, suggestion: '请根据当前模板绑定的角色、文件证据和用户要求复核取值口径。' })));
  return issues;
}

/** 中文单位量化值补充提取：PRECISE_TOKEN_RE 单位组后跟 \b，中文单位（日历天/台/套/个等）后接中文标点时
 * \b 不成立（两侧均非 \w），导致「540日历天」「3台」类工期/数量参数漏提；用标点/空白/结尾前瞻替代尾部 \b。 */
const CHINESE_UNIT_TOKEN_RE = /\b\d+(?:\.\d+)?\s*(?:日历天|小时|分钟|天|周|月|年|万元|元|台|套|个|项|批|次|份|人)(?=[。，,；;：:、\s]|$)/gu;

export function extractChapterPreciseTokens(evidence: DocumentEvidence[]) {
  const tokens = new Set<string>();
  for (const item of evidence) {
    const content = stringifyFactValue(item.content).replace(/\s+/gu, ' ');
    if (/报价明细|投标报价|单价|合价|综合单价|预留金|税率|增值税|利润|结算/u.test(content) && !/合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(content)) continue;
    if (/OCR|识别错误|乱码|无法确认|疑似|不确定|语义断裂/u.test(content)) continue;
    for (const match of content.matchAll(PRECISE_TOKEN_RE)) tokens.add(match[0].trim());
    for (const match of content.matchAll(CHINESE_UNIT_TOKEN_RE)) tokens.add(match[0].trim());
    if (tokens.size >= 40) break;
  }
  return [...tokens].slice(0, 40);
}

/** F12 规格-部位对照表提示行：同一规格维度（混凝土强度等级/砂浆强度等级/厚度）多规格时
 *  按「部位:规格」渲染，供 Writer 按分部分项区分使用；单规格维度无混淆风险不渲染（省 token） */
function buildSpecAuthorityPromptLines(map?: SpecAuthorityMap): string[] {
  if (!map) return [];
  const lines: string[] = [];
  for (const [dimension, placements] of Object.entries(map)) {
    if (placements.length < 2) continue;
    const unique = placements.filter((item, index, array) => array.findIndex(candidate => candidate.location === item.location && candidate.spec === item.spec) === index);
    if (unique.length < 2) continue;
    lines.push(`- ${dimension}：${unique.slice(0, 8).map(item => `${item.location}:${item.spec}`).join('｜')}`);
  }
  return lines.slice(0, 12);
}

export function buildChapterFactCoverageContext(input: { chapter: DocumentTemplateChapter; plan?: { requiredContents?: string[]; evidenceNeeds?: string[] }; spec?: AutoDocumentSpecPackage; roleFacts: Array<{ fact: { key: string; value: unknown } }>; evidence: DocumentEvidence[]; missingFacts: string[]; indexedFacts?: DocumentFact[]; resolvedFactNeeds?: ResolvedFactNeed[]; factNeedsPrompt?: string; specAuthorityMap?: SpecAuthorityMap }) {
  const specRule = input.spec?.chapterRules.find(rule => rule.id === input.chapter.id || rule.title === input.chapter.title);
  const specFactNames = (specRule?.requiredFactIds || [])
    .map(id => input.spec?.factFields.find(field => field.id === id)?.name)
    .filter(Boolean) as string[];
  const requiredFacts = [...new Set([
    ...input.chapter.requiredFacts,
    ...specFactNames,
    ...(input.plan?.requiredContents || []),
    ...(input.plan?.evidenceNeeds || []),
    ...(input.resolvedFactNeeds || []).filter(item => item.need.required).map(item => item.need.label),
  ].filter(Boolean))];
  const roleFactLines = input.roleFacts.map(({ fact }) => `- ${fact.key}：${cleanEvidenceText(stringifyFactValue(fact.value))}`);
  const resolvedFacts = (input.resolvedFactNeeds || []).flatMap(item => item.facts);
  // 全局资料事实全量注入（不再做条目/字符预算截断：截断即事实丢失，LLM 输入容量足够）
  const allIndexedFacts = input.indexedFacts || [];
  const indexedFactLines = resolvedFacts.length > 0
    ? []
    : allIndexedFacts.map(fact => `- ${fact.key || fact.fieldName || '资料事实'}：${cleanEvidenceText(stringifyFactValue(fact.value))}${fact.sourceFile ? `（来源：${fact.sourceFile.split('/').pop()}）` : ''}`);
  const projectBasicFacts = [...resolvedFacts, ...allIndexedFacts]
    .filter(fact => /建设地点|建设规模|招标范围|计划工期|合同工期|周期要求|质量标准|合同估算|投资估算|最高投标限价|招标控制价/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`))
    .filter((fact, index, array) => array.findIndex(item => `${item.key || item.fieldName}:${stringifyFactValue(item.value)}` === `${fact.key || fact.fieldName}:${stringifyFactValue(fact.value)}`) === index);
  // 精确参数：保留所有数值事实全量注入（参数种类是专业评分硬性验收项，截断会丢 LLM 可落位的参数清单）
  const preciseTokens = [...new Set([...extractChapterPreciseTokens(input.evidence), ...resolvedFacts.map(fact => stringifyFactValue(fact.value)).filter(value => HAS_QUANTIFIED_VALUE_RE.test(value)), ...allIndexedFacts.map(fact => stringifyFactValue(fact.value)).filter(value => HAS_QUANTIFIED_VALUE_RE.test(value))])];
  const evidenceSourceCount = new Set([...input.evidence.map(item => item.filePath), ...resolvedFacts.map(item => item.sourceFile), ...(input.indexedFacts || []).map(item => item.sourceFile)]).size;
  const unresolvedNeeds = (input.resolvedFactNeeds || []).filter(item => item.status !== 'satisfied' && item.need.required).map(item => item.need.label);
  // F12 规格-部位对照表：同物多规格（垫层 C15/主体 C35）按部位区分的确定性依据，
  // 只有 ≥2 规格的维度才有对照价值（单规格无混淆风险，省 token）
  const specAuthorityLines = buildSpecAuthorityPromptLines(input.specAuthorityMap);
  return [
    '【本章事实覆盖与参数落位要求】',
    requiredFacts.length ? `必须优先覆盖的事实/要求：\n${requiredFacts.map(item => `- ${item}`).join('\n')}` : '',
    roleFactLines.length ? `角色节点已抽取事实：\n${roleFactLines.join('\n')}` : '',
    projectBasicFacts.length ? `项目基础事实卡片（资料已明确，必须优先使用，不得输出任何占位话术；其中工程地点、建设规模、计划工期等总述数据只在项目概况/工程概况类章节集中交代，其他章节仅可引用所需的具体数字，不得复述完整概况段）：\n${projectBasicFacts.map(fact => `- ${fact.key || fact.fieldName}：${cleanEvidenceText(stringifyFactValue(fact.value))}${fact.sourceFile ? `（来源：${fact.sourceFile.split('/').pop()}）` : ''}`).join('\n')}\n项目基本信息表必须使用固定表头：| 信息项 | 内容 |，不得使用“序号｜项目名称｜内容参数”表头，不得输出后台溯源列。` : '',
    // s1-slim 段序重排：capFactCoverageCap 默认收紧到 6000 字符后，段级顺序决定截断牺牲者——
    // 参数密度硬依赖段（规格对照/精确参数）前置到截断保护区；
    // factNeedsPrompt/indexedFactLines（长文本全量事实索引，绑定材料证据可兜底）后置为截断牺牲区
    specAuthorityLines.length ? `本章材料规格-部位对照表（同一材料的多种规格必须按所属部位/分部分项分别使用，禁止全文统一为一种规格；对照关系以工程量清单为准，写错部位视同数据错误）：\n${specAuthorityLines.join('\n')}` : '',
    preciseTokens.length ? `本章资料中可直接使用的可靠精确参数/编号：${preciseTokens.join('、')}。这些参数来自绑定资料，不属于编造；涉及对应对象、部位、工序、材料、设备、项目概况、质量验收或安全控制时必须自然写入正文，并保持原样或等价专业表达。量化参数落位是硬性验收项：本章正文必须达到每千字不少于 2 个不同量化参数的密度（以上方清单参数优先），同一参数不得反复堆砌凑数；当本章绑定材料可落位参数不足 2 个/千字时，以材料全部参数落位为准，不得从行业惯例或相邻章节借参数凑数——参数不足仅在「材料中仍有未落位参数」时构成打回理由。项目基础事实中的合同估算价、计划工期可用于项目概况；不得写入报价明细、单价、税率、预留金。` : '',
    unresolvedNeeds.length ? `当前事实需求仍未充分确认：${unresolvedNeeds.join('、')}。未确认项不得编造；但已满足事实需求中的资料事实必须写入对应小节。` : '',
    input.missingFacts.length ? `模板显式要求中当前检索未充分命中的项：${input.missingFacts.join('、')}。未命中项不得编造，但不得因此省略上方已经明确的可靠参数。` : '',
    input.factNeedsPrompt || '',
    indexedFactLines.length ? `全局资料事实索引匹配到的本章可写事实：\n${indexedFactLines.join('\n')}` : '',
    `本章可用材料来源约 ${evidenceSourceCount} 个文件，正文必须按事实需求把可用事实内化到对应小节，不得单列后台资料清单。`,
  ].filter(Boolean).join('\n');
}

/** 用户提示词中明确给定的事实性表述（工期/地点/规模/范围/金额/目标等）：作为最高优先级事实源注入。
 * 对齐「长提示词直接承载项目事实」的工作流（用户手动 OCR + 长提示词即可稳定生成）；
 * 若与绑定材料数值冲突，以绑定材料为准。 */
export function extractUserRequirementFacts(requirement?: string): string[] {
  if (!requirement) return [];
  const facts: string[] = [];
  for (const rawLine of requirement.split(/\r?\n|[。；;]/u)) {
    const line = rawLine.trim();
    if (line.length < 4 || line.length > 240) continue;
    if (!/计划工期|合同工期|工期|日历天|建设地点|工程地点|建设规模|工程规模|建筑面积|质量标准|质量目标|招标范围|施工范围|工作内容|合同估算|投资估算|最高投标限价|招标控制价|暂列金额|安全目标|文明施工目标|项目名称|工程名称/u.test(line)) continue;
    // 纯指令句（无数值/单位支撑）不算事实，避免把写作要求误当事实注入
    if (/(?:请|务必|不得|禁止|不要|要求你|你需要|生成|输出|格式|模板)/u.test(line) && !/(?:日历天|㎡|m2|平方米|万元|元|米|天|%|层|栋|台|套)/u.test(line)) continue;
    facts.push(line);
    if (facts.length >= 24) break;
  }
  return [...new Set(facts)];
}

export function userRequirementFactsPrompt(requirement?: string) {
  const facts = extractUserRequirementFacts(requirement);
  if (facts.length === 0) return '';
  return [
    '【用户提示词明确给定的事实——最高优先级，必须原样写入正文相关小节】',
    ...facts.map(fact => `- ${fact}`),
    '这些事实来自用户要求；若与绑定材料中的数值冲突，以绑定材料为准。',
  ].join('\n');
}

/**
 * F3 事实覆盖清单预算封顶：factCoverageContext 的「全局资料事实索引全量注入」是块级输入 L3 爆炸
 * 的主因（真实生成单章索引可达数十万字符，同章每块全量注入一次）。按行完整截断到字符预算，
 * 前端段（事实要求/角色事实/基础事实卡片/精确参数）天然优先保留；factCoverageCap（DOCUMENT_TUNING_PROFILE）可调，0 关闭封顶。
 * 被截断的事实索引仍存在于绑定材料证据中（evidenceText 按块相关性注入），不影响事实落位兜底。
 * s1-slim 单块输入瘦身：默认封顶 26000 → 6000（事实覆盖段应与全局资料事实索引解耦，
 * 参数密度硬依赖段（精确参数/规格对照）在 buildChapterFactCoverageContext 内已前置到截断保护区）。
 */
export function capFactCoverageContext(text: string): string {
  const configured = tuningProfile().factCoverageCap;
  // factCoverageCap=0 显式关闭封顶（全量注入）；未配置或非法值走默认预算 6000
  if (configured === 0) return text;
  const cap = Number.isFinite(configured) && configured! > 0 ? Math.floor(configured!) : 6000;
  if (!text || text.length <= cap) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length + 1 > cap) break;
    kept.push(line);
    total += line.length + 1;
  }
  // 上限治理：截断必须**如实说明**（原提示「其余事实见绑定材料与证据」是**误导**——
  // 绑定材料与证据注入本身另有预算截断，指向那里等于让用户白找）。
  // 并把被截条目在有限预算内**列名**，给出可追溯的缺口清单。
  const omitted = lines.slice(kept.length).filter(Boolean);
  const NAME_BUDGET = 600;
  const omittedNames: string[] = [];
  let nameChars = 0;
  for (const line of omitted) {
    const label = line.slice(0, 40);
    if (nameChars + label.length + 1 > NAME_BUDGET) break;
    omittedNames.push(label);
    nameChars += label.length + 1;
  }
  const omittedNote = omitted.length > 0
    ? `（本章事实索引超出注入预算已截断 ${omitted.length} 条${omittedNames.length > 0 ? `，缺口清单：${omittedNames.join('；')}${omittedNames.length < omitted.length ? ' 等' : ''}` : ''}。` +
      `注意：这部分事实**本次未注入写作上下文**，绑定材料与证据注入另有独立预算、不保证覆盖它们；` +
      `如需全量注入，可将 DOCUMENT_TUNING_PROFILE.factCoverageCap 设为 0）`
    : '';
  return omittedNote ? `${kept.join('\n')}\n${omittedNote}` : text;
}

/** 两步生成第一步产出的事实大纲 */
export async function buildLlmChapterContent(template: DocumentTemplate, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[], promptTexts: string, projectContext: string, requirement?: string, roleContext = '', options: { forbidDrawingImages?: boolean; minWords?: number; targetWords?: number; sectionQuotas?: SectionQuotaItem[]; maxTokens?: number; factCoverageContext?: string; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; evidenceFloorChars?: number; evidenceCeilingChars?: number; compactProjectContext?: boolean; scopedProjectContext?: boolean; sharedFactLayerText?: string; evidenceRankBoost?: (item: DocumentEvidence) => number; onlyRankBoosted?: boolean; chapterLevelContext?: string; blueprintDataText?: string; blueprintSliceText?: string; /** 4.55.22：蓝图锁定数值（渲染后的值，非 path）——首轮提示词即须注入，不能只在重试反馈里给 */ blueprintMustCiteHint?: string; skipT2Catalog?: boolean; /** 标书编制规格（阶段 1 判定）：暗标正文禁表/禁图/身份禁语写作口径注入 */ bidComposition?: BidCompositionSpec } = {}) {
  const bundle = buildEvidenceBundle(chapter, evidence);
  // 证据注入预算与 generationBudget 的证据区间（7k-26k 档）对齐：未显式传入时保持旧默认，
  // 由 documentGenerator 主路径统一传入按章节目标字计算的 floor/ceiling
  // D1 共享卡片上移：sharedFactLayerText（章级 T0 事实层）已注入 L2 共享段时，块级证据跳过 T0，
  // 避免同章各块重复注入同一份全量事实行（块级调用输入 token 大头，prefix cache 命中率提升）
  const sharedFactLayer = Boolean(options.sharedFactLayerText);
  // 4.17.6 块级/整章写作 L3 压缩：skipT2Catalog 透传（主题块管线传 true——目录由 L2 章级
  // 证据摘要池承载追溯语义）；两步法主证据（P4 补充检索重建/slim 重建）同口径跳过目录
  const evidencePromptOptions = {
    requiredFacts: chapter.requiredFacts,
    skipT0: sharedFactLayer,
    skipT2Catalog: Boolean(options.skipT2Catalog),
    rankBoost: options.evidenceRankBoost,
    onlyRankBoosted: options.onlyRankBoosted,
    diagnostics: options.diagnostics,
  };
  const evidenceText = evidenceBundlePrompt(bundle, { maxChars: evidencePromptBudgetForTarget(options.targetWords || options.minWords, options.evidenceFloorChars, options.evidenceCeilingChars), ...evidencePromptOptions });
  const userFactBlock = userRequirementFactsPrompt(requirement);
  // 即使 evidenceText 和 roleContext 为空，也让 LLM 基于 projectContext 和 promptTexts 尝试生成
  // 4.55.14 小节清单下发硬化（巢湖实测）：旧措辞「请完整包含并展开以下小节」+ 编号清单形态，
  // 使模型把清单当成「要点枚举」——章级小节被写成块内 `#### 5 工程概况`（H4，用户 OUTLINE 固定
  // 小节在正文大纲里消失），或整节漏写（「编制依据与说明」章草稿 0 次）。现明确标题层级与序号语义。
  const sectionInstruction = chapter.sections?.length
    ? `本章小节由生成前规划得到（含用户提示词/大纲声明的固定小节），必须**逐节**以下列名称输出为三级标题（形如「### X.X 小节名」），顺序与之保持一致：\n${chapter.sections.map(section => `- ${section}`).join('\n')}\n约束：小节名必须与本清单逐字一致（不得改名、不得合并、不得省略）；下列条目的列表符号仅用于排序，禁止把编号或列表符号写进标题；禁止把小节降级为四级标题、也禁止把小节名写成正文中的列举条目；每个小节标题下必须有实质正文。`
    : '本章没有预设小节；请按用户提示词、模板章节、角色要求和绑定材料自然组织正文。';
  const sectionBudgetInstruction = buildSectionBudgetInstruction(chapter, options.targetWords || options.minWords || 0, options.sectionQuotas);
  // 标书编制规格（阶段 1 证据判定）：正文禁表（bodyTablePolicy=forbidden，招标显式禁表句）时表格计划指令短路；
  // 允许口径（暗标允许句/无证据默认）自然放行，表格按系统表格计划注入
  const tablePlanInstruction = isBodyTableForbidden(options.bidComposition) ? '' : tablePlansPrompt(chapter);
  // R20 C1 图类呈现指令（文字框图/时间轴承载；正文禁表口径时短路，图类数据化输出归附表区）
  const diagramInstruction = isBodyTableForbidden(options.bidComposition) ? '' : diagramRequirementsPrompt(chapter);
  const constructionOrgRuleInstruction = constructionOrgChapterRulePrompt(chapter);
  const constructionOrgBonusInstruction = constructionOrgBonusModulePrompt(chapter);
  // D-T9 专业工序链约束（两级判定：章标题+小节标题优先，回退资料文本——资料内容驱动，不依赖
  // 项目名称）：与本节域匹配的工序链组织要求（混合项目中公厕装饰装修章只受装饰约束）
  const constructionOrgProjectTypeInstruction = constructionOrgProjectTypePrompt({ templateName: template.name, requirement, chapters: [chapter], materialText: projectContext });
  // 锚定专项规则（章标题+要点清单整体判别）：blockChapter.sections 是主题块的 H4 要点标题，
  // 统一按章标题+要点清单注入分部分项/主要施工内容专项要求（历史缺陷：仅按小节标题判别时拿不到专项规则导致概略）
  const anchoredRuleInstructions = chapterAnchoredRules(chapter.title, chapter.sections || []);
  // 3.5 scoped 专用紧凑化：章级 scoped 上下文（蓝图+任务卡+实施方案）走专用紧凑函数；
  // 全局上下文继续用通用紧凑化（DOCUMENT_CONTEXT_SLIM_CHAPTER=0 的非 scoped 路径不受影响）
  const compactProjectContextText = options.compactProjectContext
    ? (options.scopedProjectContext ? compactScopedProjectContext(projectContext) : compactSectionProjectContext(projectContext))
    : projectContext;
  const system = [
    // 3.2 L0 恒定前缀（跨 Writer 类型共享 prefix cache）；DOCUMENT_L0_SYSTEM_PREFIX=0 回退原前缀
    writerSystemPrefix(),
    options.forbidDrawingImages ? '图片类材料只作为文本事实依据；禁止插入图片或 Markdown 图片语法。' : '',
    // 标书编制规格写作口径（正文表格计划口径/禁图/身份禁语硬约束；无口径差异时返回空串不注入）
    bidCompositionWritingRules(options.bidComposition),
    // A5a 前缀缓存：可变 promptTexts 已移入 user 首部，system 保持恒定（跨章共享 prefix cache）
  ].filter(Boolean).join('\n\n');
  // 4.43 篇幅上限语义 + 显示校准系数（根治字数控不住）：
  // 实验链实证（R/V8~V13 共 80+ 次直连调用）——① 模型对绝对字数无计数能力：最简指令
  //「请写约 1500 字」实测 2434 字（1.62x，R 组 15 次调用）；② 目标语义（「约 N 字」/「篇幅目标 N」）
  // 零咬合：全信号缩放 0.85 后产出不变（V11 实测）；③ 上限语义（「不超过 N」）有效咬合
  //（X2 单小节 1.21x vs 目标语义 1.64x）；④ 块级/点位/骨架全信号一致缩放 0.75 后（V13 定标 22 样本）：
  // 产出落到 0.81~1.25x 块目标、82% 直通质检窗（缩放 0.70 则 100% 直通但文档总量偏低）。
  // 取 0.75：文档总量 ≈0.97x 用户目标（贴合要求字数），欠产侧尾距 0.7 阻断线远、
  // 超产侧 ~18% 由二轮压缩反馈收敛。
  const writingTarget = options.targetWords || options.minWords || 1000;
  const lengthContractLine = renderLengthContractLine(writingTarget);
  const prompt = [
    promptTexts ? `配置写作主控提示词：\n${promptTexts}` : '',
    `文档模板：${template.name}`,
    // P5 前缀缓存收敛：章内各块共享的恒定段全部前置（主控提示词/模板/用户要求/项目上下文/通用生成要求），
    // 块级变化段（章节标题、章级指令、角色上下文、字数预算、绑定材料）统一后置——
    // 同章主题块并发成稿时前缀逐块分叉是缓存命中率低的根因之一（实测命中率 29%，仅 system 层命中）
    `章节目的：${chapter.purpose}`,
    requirement ? `用户要求：${requirement}` : '',
    userFactBlock,
    // s1-slim 块级聚焦（前缀优化）：蓝图参数桶与蓝图片段从 L1 移至块变化段尾部——
    // 全量注入是单块输入 10 万字符级超标的根因（实测 quantity+material 全量 34328 字符、
    // 整章切片 103488 字符），块级筛选后每块只携带块相关条目，L1/L2 共享前缀反而更完整；
    // 具体注入点见下方「块级变化段」锚点
    projectContext ? `上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${compactProjectContextText}` : '',
    // D1 共享卡片上移：章级 T0 关键事实层置于 L2 共享段——同章各块值完全相同，
    // 共享前缀变长 → prefix cache 命中率提升；块级证据（L3 尾部）只带块相关 T1 片段
    options.sharedFactLayerText || '',
    // F1/F2 章级恒定段上移 L2：factCoverageContext（事实覆盖与参数落位要求）与 missingFacts
    // 均为章级构建一次、同章各块值完全相同，历史缺陷误置于 L3 块级变化段——同章各块前缀在
    // 此处即分叉，L3 占比 95%+（其中 factCoverageContext 全量事实索引为大头），prefix cache
    // 命中率仅 26-29%；上移后同章各块共享前缀显著变长，命中率应大幅回升
    options.factCoverageContext || '',
    missingFacts.length ? `需要特别补足的信息：${missingFacts.join('、')}` : '',
    // F9 章级恒定段上移：章级角色上下文（评分项要求路由/数据口径约束）与章级事实大纲
    // 均为章级构建一次、同章各块值完全相同——历史缺陷置于块级变化段（L3）使同章各块
    // 共享前缀在此处即分叉，L2 占比被压短；上移后同章各块共享前缀显著变长，prefix cache 命中率回升
    options.chapterLevelContext || '',
    '请生成可直接导出的 Markdown 章节，要求：',
    '- 内容必须遵循用户提示词、模板章节、提示词角色、项目资料包和自动识别的资料类型；不得编造材料未提供的项目专属事实；任何带数值、工程量、规格、型号、品牌、参数的表述必须逐字来自绑定材料、蓝图参数桶或清单事实锁，材料中没有对应值时不得猜测填充、不得以行业惯例或公共知识为由虚构数值；公共知识豁免仅限法律法规名称、标准规范名称与编号（不带本项目数值）以及通用工艺做法表述，可依据现行有效版本直接引用。',
    '- 将材料要点自然融入正文；不要输出系统证据清单、中间分析过程或后台流程话术。',
    SECTION_GENERATION_SAFETY_RULES,
    // ── 块级变化段起点（同章各块以下内容互不相同；保持其在 prompt 尾部，共享前缀到此为止恒定）──
    `章节标题：${chapter.title}`,
    lengthContractLine,
    chapter.sections?.length ? '- 必须完整包含已规划小节，每节以「### X.X 小节名」三级标题逐节输出（小节名逐字一致，不得改名/合并/省略，不得降级为四级标题或写成列举条目）；不要新增未规划的二级小节。' : '- 未预设小节时，不要为了凑结构强行新增小节。',
    isBodyTableForbidden(options.bidComposition) ? '' : chapter.tablePlans?.length ? '- 本章存在结构化表格规划时，必须输出正式 Markdown 表格；表头必须严格使用规划字段，不得擅自改字段、删字段或增加后台溯源列。' : chapter.tableSections?.length ? `- 以下小节可使用表格辅助表达：${chapter.tableSections.join('、')}。` : '',
    isBodyTableForbidden(options.bidComposition) ? '' : chapter.tablePlans?.length ? '- 表格字段值必须优先来自项目图谱、可信事实和绑定材料；projectFactOnly 字段不得编造，也不得写任何固定占位话术。' : '',
    sectionInstruction,
    sectionBudgetInstruction,
    tablePlanInstruction,
    diagramInstruction,
    constructionOrgRuleInstruction,
    constructionOrgBonusInstruction,
    constructionOrgProjectTypeInstruction,
    ...anchoredRuleInstructions,
    // s1-slim 块级聚焦：蓝图参数桶（块 token 条目级筛选后）与蓝图片段（只展开块相关工作包）在此注入——
    // 块变化段（各块互不相同、本就不可缓存），不影响上文共享前缀；行文案与全量渲染同一来源
    options.blueprintDataText || '',
    options.blueprintSliceText || '',
    // 4.55.22 修复：蓝图锁定数值（「劳动力峰值 85 人」这类**渲染后的值**）此前只在
    // `buildBlockDefectFeedback`（attempt>0 的重试反馈）里注入 → 多数块首轮即过，
    // **首轮提示词从未拿到必须引用的权威数值**，只能省略或从旧证据里取数；
    // 而写后对齐 `alignChapterContentToBlueprint` 只替换数字本身、无法凭空补出缺失的数。
    // 现与 blueprintDataText/Slice 同段注入首轮（后者只给 path，本行给出值）。
    options.blueprintMustCiteHint ? `【本章蓝图锁定数值（正文必须逐条原样出现且与给定值完全一致）】${options.blueprintMustCiteHint}` : '',
    roleContext ? roleContext : '',
    '',
    evidenceText ? '绑定材料：' : '',
    evidenceText,
  ].filter(Boolean).join('\n');
  // 3.4 上下文分层统计（L0-L3）：与上方 prompt 组装同源表达式；P5 前缀收敛后口径 =
  // L0 system 恒定段 / L1 任务级恒定指令 / L2 章级共享段（L0-L2 为章内各块共享的 prompt 前缀，
  // DeepSeek prefix cache 可命中部分）/ L3 块级变化段（章内各块互不相同，置于 prompt 尾部不可缓存），
  // 供「可缓存前缀 vs 不可缓存变化段」占比验收
  const contextLayers = {
    l0: system.length,
    l1: contextLayerChars([
      promptTexts ? `配置写作主控提示词：\n${promptTexts}` : '',
      requirement ? `用户要求：${requirement}` : '',
      userFactBlock,
      '请生成可直接导出的 Markdown 章节，要求：',
      '- 内容必须遵循用户提示词、模板章节、提示词角色、项目资料包和自动识别的资料类型；不得编造材料未提供的项目专属事实；任何带数值、工程量、规格、型号、品牌、参数的表述必须逐字来自绑定材料、蓝图参数桶或清单事实锁，材料中没有对应值时不得猜测填充、不得以行业惯例或公共知识为由虚构数值；公共知识豁免仅限法律法规名称、标准规范名称与编号（不带本项目数值）以及通用工艺做法表述，可依据现行有效版本直接引用。',
      '- 将材料要点自然融入正文；不要输出系统证据清单、中间分析过程或后台流程话术。',
      SECTION_GENERATION_SAFETY_RULES,
    ]),
    l2: contextLayerChars([
      `文档模板：${template.name}`,
      `章节目的：${chapter.purpose}`,
      projectContext ? `上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${compactProjectContextText}` : '',
      // D1：章级共享 T0 事实层计入 L2（同章各块值相同 → 可缓存前缀组成部分）
      options.sharedFactLayerText || '',
      // F1/F2：章级恒定段计入 L2（同章各块值相同 → 可缓存前缀组成部分）
      options.factCoverageContext || '',
      missingFacts.length ? `需要特别补足的信息：${missingFacts.join('、')}` : '',
      // F9：章级角色上下文计入 L2（同章各块值相同 → 可缓存前缀组成部分）
      options.chapterLevelContext || '',
    ]),
    l3: contextLayerChars([
      `章节标题：${chapter.title}`,
      lengthContractLine,
      chapter.sections?.length ? '- 必须完整包含已规划小节；不要新增未规划的二级小节。' : '- 未预设小节时，不要为了凑结构强行新增小节。',
      chapter.tablePlans?.length ? '- 本章存在结构化表格规划时，必须输出正式 Markdown 表格；表头必须严格使用规划字段，不得擅自改字段、删字段或增加后台溯源列。' : chapter.tableSections?.length ? `- 以下小节可使用表格辅助表达：${chapter.tableSections.join('、')}。` : '',
      chapter.tablePlans?.length ? '- 表格字段值必须优先来自项目图谱、可信事实和绑定材料；projectFactOnly 字段不得编造，也不得写任何固定占位话术。' : '',
      sectionInstruction,
      sectionBudgetInstruction,
      tablePlanInstruction,
      diagramInstruction,
      constructionOrgRuleInstruction,
      constructionOrgBonusInstruction,
      constructionOrgProjectTypeInstruction,
      ...anchoredRuleInstructions,
      // s1-slim 块级聚焦两段计入 L3（块变化段；与上方 prompt 组装同源表达式）
      options.blueprintDataText || '',
      options.blueprintSliceText || '',
      roleContext ? roleContext : '',
      evidenceText ? '绑定材料：' : '',
      evidenceText,
      ]),
  };
  const content = await callDocumentLlm(system, prompt, false, { maxTokens: options.maxTokens, signal: options.signal, diagnostics: options.diagnostics, contextLayers, prefixKey: `writer-block:${chapter.id}` });
  if (!content || content.length < 120) return undefined;
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('## ') ? content : `## ${chapter.title}\n\n${content}`, Boolean(options.forbidDrawingImages)));
}

/** 逐要点守恒配额项（容量规划 quotaWords 的写作层投影；Σ ≤ 块预算） */
export interface SectionQuotaItem {
  title: string;
  words: number;
}

/** 小节篇幅计划配额（4.42 守恒链单一来源）：优先采用容量规划点配额（quotas——与覆盖清单
 * 「篇幅约 X 字」同源同数，Σ=块预算）；标题匹配不齐时确定性均分（floor + 余数补首项，
 * Σ 恒 = targetWords）。任何路径下 Σ 逐点配额 ≤ 目标字数，不存在越过块合同上限的可能。
 * 旧实现（已删除）为链外固定地板 max(520, rawBase)：块内要点数 N≥4 时 Σ=520N≥2080
 * 必然突破 1800 块上限 2070；prompt 内双配额冲突（篇幅计划 520/要点 vs 覆盖清单 quotaWords）
 * 是 4.41 首轮 22/22 全超产（1.19~2.29x，模型执行 Σ520N 精度 0.95~1.06x）的确定性根因——
 * 第八轮 V 组对照实验：Σ 自洽（V3）1.04x 全达标 / Σ 超线（V1/V2）1.45x/1.57x 全超产。 */
export function sectionTargets(chapter: DocumentTemplateChapter, targetWords: number, quotas?: SectionQuotaItem[]) {
  const sections = normalizePlannedSections(chapter.sections?.filter(Boolean) || [], chapter.title);
  if (sections.length === 0) return [];
  if (quotas && quotas.length > 0) {
    const words = sections.map(section => {
      const exact = quotas.find(item => item.words > 0 && item.title === section);
      if (exact) return exact.words;
      return quotas.find(item => item.words > 0 && sectionTitleEquivalent(item.title, section))?.words;
    });
    if (words.every((value): value is number => typeof value === 'number' && value > 0)) {
      return sections.map((section, index) => ({ title: section, targetWords: words[index]! }));
    }
  }
  // 退化均分（防御：targetWords 小于小节数时每项至少 1 字，避免 0 字配额）
  const base = Math.max(1, Math.floor(targetWords / sections.length));
  const remainder = Math.max(0, targetWords - base * sections.length);
  return sections.map((section, index) => ({ title: section, targetWords: index === 0 ? base + remainder : base }));
}

/** 4.43 块级篇幅显示校准系数（「系数」的来由与实证见 buildLlmChapterContent 内 4.43 注释）：
 * 渲染给模型的字数 = 真实目标 × 本系数。模型对被展示数字的执行偏差 ~1.3x（无法计数），
 * 校准后实机产出落回质检窗 [0.7,1.15]×真实目标（V13 定标：s=0.75 → 82% 直通、中位 0.9xT）。 */
export const BLOCK_LENGTH_DISPLAY_SCALE = 0.75;

/** 显示字数换算：真实目标 × 校准系数（下限 1 字防止 0 渲染）。 */
export function displayWordCap(words: number) {
  return Math.max(1, Math.round(words * BLOCK_LENGTH_DISPLAY_SCALE));
}

/** 块级字数合同行（4.43 上限语义）：目标语义措辞零咬合（V8~V11 实测），上限语义为唯一
 * 有效字数指令（X2/V13 实证）；显示值经校准系数折算，实际产出回落到合同窗内。 */
export function renderLengthContractLine(targetWords: number) {
  const cap = displayWordCap(targetWords);
  return `- 保留章节标题；本节正文总字数不超过 ${cap} 字（控制在 ${Math.round(cap * 0.85)}~${cap} 字之间），超出即不合格。`;
}

/** 小节篇幅上限指令（4.43 上限语义 + 显示校准）：逐点上限控制；
 * 旧文案「首轮生成应尽量一次达成，避免后续补写」为篇幅向上诱导句（dump 法证 25/25 在案），已删除。 */
export function buildSectionBudgetInstruction(chapter: DocumentTemplateChapter, targetWords: number, quotas?: SectionQuotaItem[]) {
  const targets = sectionTargets(chapter, targetWords, quotas);
  if (targets.length === 0) return '';
  return [
    '本节小节篇幅上限（逐点控制、不得超出；在各自上限内按材料深度展开）：',
    ...targets.map(item => `- ${item.title}：不超过 ${displayWordCap(item.targetWords)} 字，并写入与该小节相关的材料事实、适用边界和必要说明。`),
  ].join('\n');
}

export function tokenizeForRelevance(text: string) {
  return [...new Set((text.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9_-]{3,}/gu) || []).map(item => item.toLowerCase()))];
}

export function evidenceForSection(sectionTitle: string, chapter: DocumentTemplateChapter, evidence: DocumentEvidence[]) {
  const tokens = tokenizeForRelevance([sectionTitle, chapter.title, ...(chapter.requiredFacts || [])].join(' '));
  const basicFactSection = /项目概况|工程概况|总体|部署|施工方案|工期|进度|质量|安全|资源|材料|设备/u.test(sectionTitle);
  const scored = evidence.map((item, index) => {
    const text = `${item.filePath}\n${item.sectionTitle || ''}\n${item.content}`.toLowerCase();
    const rawText = `${item.filePath}\n${item.sectionTitle || ''}\n${item.content}`;
    const hitScore = tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
    const sectionScore = item.sectionTitle && (sectionTitle.includes(item.sectionTitle) || item.sectionTitle.includes(sectionTitle)) ? 4 : 0;
    const parameterScore = (HAS_QUANTIFIED_VALUE_RE.test(rawText) || /合同估算价|合同估算价格|计划工期/u.test(rawText)) ? 1.5 : 0;
    const basicFactScore = basicFactSection && /计划工期|合同工期|合同估算价|合同估算价格|投资估算|建设地点|建设规模|质量标准|招标范围/u.test(rawText) ? 5 : 0;
    const typeScore = /table|sheet|bill|data|drawing|图纸|表格|清单|参数|数据|说明/u.test(`${item.roleId || ''} ${item.processingType || ''} ${item.filePath}`) ? 0.8 : 0;
    return { item, score: hitScore + sectionScore + parameterScore + basicFactScore + typeScore + item.score * 0.1 - index * 0.001 };
  }).sort((a, b) => b.score - a.score);
  const selected = scored.filter(item => item.score > 0).map(item => item.item);
  if (selected.length === 0) return evidence;
  const selectedSet = new Set(selected);
  const globalFacts = scored
    .filter(({ item }) => !selectedSet.has(item))
    .filter(({ item }) => /招标范围|建设规模|建设地点|计划工期|质量标准|施工内容|管理机构|岗位职责|施工部署|现场交通|人车分流/u.test(`${item.sectionTitle || ''}\n${item.content}`))
    .map(item => item.item);
  return [...selected, ...globalFacts];
}
interface SectionFactCardItem {
  text: string;
  sourceFile: string;
  roleId?: string;
  quantified: boolean;
}

interface SectionFactCard {
  items: SectionFactCardItem[];
  quantifiedCount: number;
  /** 4.1 量化参数落位清单：extractChapterPreciseTokens 产出（词粒度精确参数，零 LLM） */
  preciseTokens: string[];
  prompt: string;
}

const DETAIL_FACT_RE = /计划工期|合同工期|建设地点|建设规模|质量标准|招标范围|施工范围|工作内容|项目特征|材料|设备|规格|型号|数量|单位|做法|节点|系统|管径|标高|尺寸|厚度|强度|等级|验收|检测|试验|安全|文明|扬尘|环保|消防|临时用电|临水|排水|交叉施工|地下管线|有限空间|危大|专项方案|专家论证|进度节点|保修|移交/iu;
// 阶段五语义升级：强词（COMMERCIAL_SENSITIVE_RE）纯行保留确定性过滤；变体弱词（材料价格/商务报价类）
// 仅词面召回，语义复核确认商务语义才过滤；允许事实（估算价/限价类）词面放行 + 语义负例保护。
const COMMERCIAL_SENSITIVE_RE = /报价明细|综合单价|税率|增值税|利润|结算|预留金|暂列金额|暂估价/u;
const ALLOWED_COMMERCIAL_FACT_RE = /合同估算价|合同估算价格|投资估算|估算价格|工程估算价|最高投标限价|招标控制价/u;
/** 商务变体弱召回：词面命中仅召回，语义复核确认商务语义才过滤（词面变体漏网治理） */
const COMMERCIAL_VARIANT_HINT_RE = /材料价格|商务报价|投标总价|合同总价|工程总价/u;

/** 商务行语义原型（正例）：报价/单价类商务数据表述基准 */
const COMMERCIAL_LINE_SEMANTIC_PROTOTYPES = [
  '暂列金额与暂估价的报价明细',
  '综合单价与清单合价的商务数据',
  '材料价格与商务报价的商务条款',
] as const;
/** 允许事实语义原型（负例保护）：估算价/限价类项目公开信息不得误过滤 */
const COMMERCIAL_LINE_LEGAL_PROTOTYPES = [
  '合同估算价与投资估算的项目信息',
  '最高投标限价与招标控制价的公开信息',
] as const;

/** 构建商务行语义 gate（semanticGate 统一入口）：混合/变体行语义裁决 */
async function buildCommercialLineGate(embedDocuments?: (texts: string[]) => Promise<number[][]>) {
  return buildSemanticGate({
    prototypes: [...COMMERCIAL_LINE_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...COMMERCIAL_LINE_LEGAL_PROTOTYPES],
    embedDocuments,
  });
}

export function normalizeFactUsageText(value: string) {
  return stringifyFactValue(value).replace(/\s+/gu, '').replace(/[，。,.;；:：、（）()【】[\]《》“”"'`]/gu, '');
}

function cleanFactLine(value: string) {
  return stringifyFactValue(value)
    .replace(/^\s*#{1,6}\s*/u, '')
    .replace(/^\s*\d+(?:\.\d+)*\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function factUsageTokens(value: string) {
  const raw = cleanFactLine(value);
  const normalized = normalizeFactUsageText(raw);
  const tokens = new Set<string>();
  const addToken = (token: string) => {
    const clean = normalizeFactUsageText(token);
    if (clean.length < 2 || /^(本项目|施工|工程|资料|要求|进行|应当|按照|落实|管理|检查|验收)$/u.test(clean)) return;
    tokens.add(clean);
  };
  for (const part of raw.split(/[，。,.;；:：、（）()【】[\]\s]+/u)) addToken(part);
  const labelValue = raw.match(/^\s*([^:：]{2,12})[:：]\s*(.+)$/u);
  if (labelValue) {
    addToken(labelValue[1] || '');
    addToken(labelValue[2] || '');
  }
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年)?|DN\d+|φ\d+|Φ\d+|GB\d+|JGJ\d+/giu)) addToken(match[0]);
  return [...tokens].slice(0, 18);
}

function isNoisyFactLine(line: string) {
  if (/^(?:工作表|序号|COL\d+|资料类型|PDF\s*第|第\d+页)/iu.test(line)) return true;
  if (/\|.*\|/u.test(line) && !/(工程名称|建设地点|建设规模|计划工期|招标范围|合同估算|暂列金额|建筑面积)/u.test(line)) return true;
  if (/^(?:[.。；;、\s]+)?(?:工程重点难点|确保安全文明生产|项目概况与招标范围)$/u.test(line)) return true;
  if (/^[.。；;、\s]*[^:：]{2,40}(?:是否|符合|在采购范围内).{0,30}\d{3,}$/u.test(line)) return true;
  if (/^[.。；;、\s]*(?:系统|综合布线系统|智能化设备).{0,40}\d{3,}$/u.test(line)) return true;
  if (/^[.。；;、\s]*(?:工程重点难点及危大工程的保障体系与措施|确保安全文明生产的管理体系与措施)$/u.test(line)) return true;
  // 窄过滤（模块1b）：只排除投标程序/商务程序行，放行前附表实质条款行。
  // 历史缺陷：裸「投标人」误伤所有含「投标人」的实质条款行（前附表条款几乎均含）；「项目经理要求」「注册建造师」
  // 是施组必须响应的项目管理配置依据却被排除；「罚款/违约金额」误伤工期延误赔偿条款（进度保障措施依据）。
  if (/第二章投标人须知|不得存在|报价|中标后不予调整|清单不再单独列项|自行踏勘|元\/条|安全生产许可证|营业执照|联合体投标|投标人资格|投标人资质|资质要求|资格审查|资格后审|业绩要求|信誉要求|财务要求|中标通知书|签订合同|评标办法|电子交易系统|踏勘现场|投标预备会/u.test(line)) return true;
  return false;
}

function factLineUsages(line: string, markdown: string) {
  const normalizedMarkdown = normalizeFactUsageText(markdown);
  const tokens = factUsageTokens(line);
  if (tokens.length === 0) return 0;
  const quantifiedTokens = tokens.filter(token => /\d/u.test(token));
  if (quantifiedTokens.length > 0) return quantifiedTokens.filter(token => normalizedMarkdown.includes(token)).length;
  return tokens.filter(token => normalizedMarkdown.includes(token)).length;
}

export async function buildSectionFactCard(sectionTitle: string, evidence: DocumentEvidence[], embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<SectionFactCard> {
  const items: SectionFactCardItem[] = [];
  const seen = new Set<string>();
  const sectionTokens = tokenizeForRelevance(sectionTitle).filter(token => token.length >= 2);
  // 先收集清洗后的候选行（含来源元数据），商务行过滤统一在收集后做语义批量判定
  const rawLines: Array<{ line: string; filePath: string; roleId?: string }> = [];
  for (const item of evidence) {
    for (const rawLine of stringifyFactValue(item.content).split(/\r?\n/u)) {
      // 与 documentFactTrace 已修口径贯通：先清洗指向值（见XXX）、表格尾巴、标题混合值，再判断可执行性
      const line = cleanFactValue(cleanFactLine(rawLine));
      if (line.length < 4 || line.length > 280) continue;
      if (!isActionableFactValue(line)) continue;
      if (isNoisyFactLine(line)) continue;
      rawLines.push({ line, filePath: item.filePath, roleId: item.roleId });
    }
  }
  // 商务行语义过滤：强词纯行确定性过滤（保留原行为）；含允许词面或变体词的混合/变体行由语义 gate 裁决
  const gate = await buildCommercialLineGate(embedDocuments);
  const uncertain = rawLines.filter(({ line }) => {
    const hasSensitive = COMMERCIAL_SENSITIVE_RE.test(line);
    const hasAllowed = ALLOWED_COMMERCIAL_FACT_RE.test(line);
    const hasVariant = COMMERCIAL_VARIANT_HINT_RE.test(line);
    return (hasSensitive && (hasAllowed || hasVariant)) || (hasVariant && !hasSensitive);
  });
  const uncertainFlags = uncertain.length > 0 ? await gate(uncertain.map(({ line }) => line)) : [];
  const semanticSkip = new Set(uncertain.filter((_, index) => uncertainFlags[index]).map(({ line }) => line));
  for (const { line, filePath, roleId } of rawLines) {
    const hasSensitive = COMMERCIAL_SENSITIVE_RE.test(line);
    const hasAllowed = ALLOWED_COMMERCIAL_FACT_RE.test(line);
    const hasVariant = COMMERCIAL_VARIANT_HINT_RE.test(line);
    if ((hasSensitive && !hasAllowed && !hasVariant) || semanticSkip.has(line)) continue;
    const quantified = QUANTIFIED_FACT_RE.test(line);
    const detailed = DETAIL_FACT_RE.test(line);
    const sectionRelated = sectionTokens.some(token => line.includes(token));
    if (!quantified && !detailed && !sectionRelated) continue;
    const key = normalizeFactUsageText(line).slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ text: line, sourceFile: filePath, roleId, quantified });
    if (items.length >= 16) break;
  }
  const lines = items.map(item => `- ${item.text}（来源：${path.basename(item.sourceFile)}${item.roleId ? `，角色：${item.roleId}` : ''}）`);
  const taskCardPrompt = lines.length ? `【当前小节写作任务卡】\n小节：${sectionTitle}\n必须优先落位的资料事实：\n${lines.join('\n')}\n成稿要求：1）至少自然写入其中 2 条资料事实；2）如存在数字、规格、标准编号、数量、工期，必须至少原样写入 1 条；3）围绕“资料依据—对象范围—实施做法—检查验收/闭环”展开，不得写成“结合实际、按规范执行”的泛化空话；4）不得改写、换算或编造资料未提供的参数；5）量化参数落位硬性要求：本节正文每千字不少于 2 个不同量化参数（优先使用上方清单参数与资料原文参数），同一参数不得反复堆砌凑数；当本节资料可落位参数不足 2 个/千字时，以全部可落位参数写入为准，不得虚构参数凑数——「参数不足」仅在资料中仍有未落位参数时构成打回理由。` : '';
  // 4.1 量化参数落位清单（两步生成第一步，零 LLM）：复用 extractChapterPreciseTokens 纯本地提取，
  // 在任务卡事实行（句粒度）之外单列精炼参数清单（词粒度），直接引导 LLM 逐参数落位，
  // 弥补「事实行被整行跳过时量化参数一并丢失」的规划缺位。（原 DOCUMENT_SECTION_QUANT_PLAN 回退已固化删除：注入恒开）
  const preciseTokens = extractChapterPreciseTokens(evidence);
  const quantPlanPrompt = preciseTokens.length
    ? `【量化参数落位清单】\n本节资料中可直接落位的可靠精确参数/编号：${preciseTokens.join('、')}。这些参数来自绑定资料，不属于编造；涉及对应对象、部位、工序、材料、设备、质量验收或安全控制时必须自然写入正文，并保持原样或等价专业表达。`
    : '';
  return {
    items,
    quantifiedCount: items.filter(item => item.quantified).length,
    preciseTokens,
    prompt: [taskCardPrompt, quantPlanPrompt].filter(Boolean).join('\n\n'),
  };
}

export function sectionFactUsageIssue(sectionTitle: string, content: string, factCard: SectionFactCard) {
  if (factCard.items.length === 0) return undefined;
  const bodyLength = documentTextLength(content);
  if (bodyLength < 180) return `小节正文过短，需补写专业做法和证据依据`;
  const strictSection = /概况|范围|清单|图纸|设计|材料|设备|工期|质量|安全|危大|资源|验收/u.test(sectionTitle);
  const usedFacts = factCard.items.filter(item => factLineUsages(item.text, content) >= (item.quantified ? 1 : 2));
  const usedQuantified = factCard.items.filter(item => item.quantified && factLineUsages(item.text, content) >= 1);
  const minFacts = strictSection ? Math.min(factCard.items.length, 2) : Math.min(factCard.items.length, 1);
  const minQuantified = strictSection && factCard.quantifiedCount > 0 ? 1 : 0;
  if (usedFacts.length >= minFacts && usedQuantified.length >= minQuantified) return undefined;
  if (!strictSection && bodyLength >= 650 && /复核|检查|验收|交底|台账|整改|闭环|进场|协调|保护/u.test(content)) return undefined;
  const missing = factCard.items.filter(item => !usedFacts.includes(item)).slice(0, strictSection ? 4 : 2).map(item => item.text);
  return `知识库事实落位不足：当前小节已落位 ${usedFacts.length}/${factCard.items.length} 条知识库事实、${usedQuantified.length}/${factCard.quantifiedCount} 条量化事实；建议补入：${missing.join('；')}`;
}

/**
 * 小节级调用的紧凑上下文：优先保留结构化事实行与蓝图约束行，避免每个小节重复携带全量全局叙述。
 * 置顶保护「招标文件评分项要求」段（历史缺陷：4.12.x 正文丢「确保黄山杯」——评分项要求段位于
 * projectContext 末尾，slice(0, maxChars) 切尾部即丢创优目标，写作上下文无要求可响应 → 零响应，
 * 修复后该段整段置顶保留，只截断其余上下文）。
 * A2 双保护升级：同时置顶保护「可信基础事实主表」段（章级 scoped 上下文中的本章精确事实）——
 * 专业文档要求"给到的条件、证据、数据精准"，事实主表与要求段同样不可被截断（宁超预算不丢事实）。
 */
export function compactSectionProjectContext(projectContext: string, maxChars = 2000) {
  const lines = projectContext.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  // 拆出评分项要求段（从「【招标文件评分项要求」标记行到下一「【」标记行之前的全部编号行）
  const requirementsLines: string[] = [];
  const restLines: string[] = [];
  let inRequirements = false;
  for (const line of lines) {
    if (line.startsWith('【招标文件评分项要求')) {
      inRequirements = true;
      requirementsLines.push(line);
      continue;
    }
    if (inRequirements && line.startsWith('【')) inRequirements = false;
    (inRequirements ? requirementsLines : restLines).push(line);
  }
  // 拆出可信基础事实主表段（标记行 + 后续以 "- " 开头的全部事实行，直到下一个非列表行）
  const factsLines: string[] = [];
  const bodyLines: string[] = [];
  let inFacts = false;
  for (const line of restLines) {
    if (line.startsWith('可信基础事实主表')) {
      inFacts = true;
      factsLines.push(line);
      continue;
    }
    if (inFacts && line.startsWith('- ')) {
      factsLines.push(line);
      continue;
    }
    if (inFacts && !line.startsWith('- ')) inFacts = false;
    bodyLines.push(line);
  }
  const structured = bodyLines.filter(line => /【.+】/u.test(line) || /=/u.test(line) || /^\d+\.\s+/u.test(line) || /：\S{1,40}$/u.test(line));
  const keep = structured.length >= 8 ? structured : bodyLines;
  const requirementsBlock = requirementsLines.join('\n').trim();
  const factsBlock = factsLines.join('\n').trim();
  const compactBody = keep.join('\n').trim();
  const truncate = (text: string, budget: number) => (text.length <= budget ? text : `${text.slice(0, budget)}\n（上下文已截断，完整信息见绑定材料与证据）`);
  // 保护段整段优先保留（宁超预算不丢要求/事实——零响应是评标失分，事实丢失是编造风险，上下文冗长只是冗余）
  const protectedBlock = [requirementsBlock, factsBlock].filter(Boolean).join('\n');
  if (protectedBlock) {
    return `${protectedBlock}\n${truncate(compactBody, Math.max(400, maxChars - protectedBlock.length - 20))}`;
  }
  return truncate(compactBody, maxChars);
}

/**
 * scoped 上下文的专用紧凑化（3.5）：章级 scoped 上下文含「章节专业任务卡」「章节实施方案」等章级专用段
 * （内容行为 `- ` 缩进行，不匹配 structured 行特征），通用 compactSectionProjectContext 会把它们截丢。
 * 保护段（整段保留，宁超预算）= 事实主表段、评分项要求段、章节任务卡段、章节实施方案段；
 * 截断段 = 全局段/矩阵段/其余（structured 过滤后按预算截断，与通用紧凑化同策略）。
 */
export function compactScopedProjectContext(projectContext: string, maxChars = 2000) {
  const lines = projectContext.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const requirementsLines: string[] = [];
  const factsLines: string[] = [];
  const taskCardLines: string[] = [];
  const executionPlanLines: string[] = [];
  const bodyLines: string[] = [];
  let zone: 'body' | 'requirements' | 'facts' | 'taskCard' | 'executionPlan' = 'body';
  for (const line of lines) {
    // 段头优先级：评分项要求标记 > 事实主表 > 任务卡 > 实施方案（均与当前 zone 无关，段头出现即切换）
    if (line.startsWith('【招标文件评分项要求')) {
      zone = 'requirements';
      requirementsLines.push(line);
      continue;
    }
    if (line.startsWith('可信基础事实主表')) {
      zone = 'facts';
      factsLines.push(line);
      continue;
    }
    if (line.startsWith('章节专业任务卡：')) {
      zone = 'taskCard';
      taskCardLines.push(line);
      continue;
    }
    if (line.startsWith('章节实施方案：')) {
      zone = 'executionPlan';
      executionPlanLines.push(line);
      continue;
    }
    if (zone === 'requirements') {
      if (line.startsWith('【')) zone = 'body';
      else { requirementsLines.push(line); continue; }
    }
    if (zone === 'facts') {
      if (line.startsWith('- ')) { factsLines.push(line); continue; }
      zone = 'body';
    }
    if (zone === 'taskCard') {
      // 任务卡内容行延续到「章节实施方案：」段头（段头在上方分支已切换）
      taskCardLines.push(line);
      continue;
    }
    if (zone === 'executionPlan') {
      // 实施方案内容行为「章节实施方案：{标题}」或 `- ` 缩进行；非缩进行（如 ⚠️ 提示、下一段）回到 body
      if (line.startsWith('- ')) { executionPlanLines.push(line); continue; }
      zone = 'body';
    }
    bodyLines.push(line);
  }
  const structured = bodyLines.filter(line => /【.+】/u.test(line) || /=/u.test(line) || /^\d+\.\s+/u.test(line) || /：\S{1,40}$/u.test(line));
  const keep = structured.length >= 8 ? structured : bodyLines;
  const protectedBlock = [
    requirementsLines.join('\n').trim(),
    factsLines.join('\n').trim(),
    taskCardLines.join('\n').trim(),
    executionPlanLines.join('\n').trim(),
  ].filter(Boolean).join('\n');
  const compactBody = keep.join('\n').trim();
  const truncate = (text: string, budget: number) => (text.length <= budget ? text : `${text.slice(0, budget)}\n（上下文已截断，完整信息见绑定材料与证据）`);
  // 保护段整段优先保留（任务卡/实施方案截丢 = 小节失去专业展开方向，事实丢失 = 编造风险，上下文冗长只是冗余）
  if (protectedBlock) {
    return `${protectedBlock}\n${truncate(compactBody, Math.max(400, maxChars - protectedBlock.length - 20))}`;
  }
  return truncate(compactBody, maxChars);
}

/**
 * 规划驱动块级写手：消费章级规划结构（PlannedChapterStructure），每个主题块一次 LLM 调用成稿
 * （含全部 H4 要点与专属事实），块间全并发推进，从根源上把「LLM 调用数」与「输入细目数」解耦。
 * 单块质检（H4 锚点完整性 + 字数下限）失败整块重试一次；要点 ≥4 的块仍失败时对半拆为子块再试
 * （自愈仍在块级管线内，不降级逐小节）；仍有块失败时返回 undefined，由上层走整章单次生成兜底。
 */
export interface PlannedChapterContentInput {
  template: DocumentTemplate;
  chapter: DocumentTemplateChapter;
  evidence: DocumentEvidence[];
  missingFacts: string[];
  promptTexts: string;
  projectContext: string;
  /** 骨架提取专用完整上下文（工作包骨架锁定/工艺知识匹配用）：章节写作上下文中 context 瘦身
   * 裁剪后不含招标范围/图谱包段，导致 majorConstructionSkeletonNames 三来源全部哑火 → 骨架锁定不触发；
   * 提供时骨架提取改用此完整上下文，其余写作段仍用瘦身 context */
  skeletonProjectContext?: string;
  requirement?: string;
  roleContext?: string;
  targetWords: number;
  // 章级字数上限不再作为入参下发（4.43 起 buildLlmChapterContent 无 maxWords 选项；上限由块级质检
  // 承担：Σ块目标 = 章目标，单块超产线 1.15×块目标，见 writeBlock 内 overProduceLine）
  forbidDrawingImages: boolean;
  /** 标书编制规格（阶段 1 证据判定）：正文表格/图片口径与块级传递 */
  bidComposition?: BidCompositionSpec;
  factCoverageContext?: string;
  compactProjectContext?: boolean;
  scopedProjectContext?: boolean;
  /** s1-slim 块级聚焦：蓝图数据（每块按块 token 条目级筛选 quantity/material 域，替代全量参数桶注入） */
  blueprintData?: BlueprintData;
  /** s1-slim 块级聚焦：本章蓝图切片（每块只展开块相关工作包，替代整章切片全量注入） */
  blueprintChapter?: BlueprintChapter;
  /** 二期蓝图接管：must_cite+strict 参数数值清单（块质检第二轮反馈挂接，未引用时定向重试） */
  blueprintMustCiteHint?: string;
  sectionEvidenceProvider?: (sectionTitle: string) => Promise<DocumentEvidence[]>;
  /** 块级进度回调：块成稿完成即触发（phase='complete'，partialSections 为已完成块正文），供 checkpoint 快照写盘 */
  onSectionProgress?: (event: { completed: number; total: number; sectionTitle?: string; phase: 'start' | 'complete' | 'retry'; partialSections?: Array<string | undefined> }) => void;
  diagnostics?: DocumentGenerationDiagnostics;
  signal?: AbortSignal;
  /** C3 隔离重写定向反馈（可选）：上一轮该块失败原因原文——单块重写 attempt=0 即注入，
   * 避免从零重写复现同一漏点（默认轮仅在 attempt≥1 注入缺陷反馈） */
  initialFeedback?: string;
}

/** C3 块级失败隔离结果：部分块失败时返回已成功块 + 失败块清单，由上层只重试失败块，
 * 不再整章降级重写（历史缺陷：单块质检未达标 → 整章平铺备用 → 全文字数雪崩） */
export interface PlannedChapterContentResult {
  /** 按 structure.blocks 顺序的块成稿正文（失败块为 undefined） */
  sections: Array<string | undefined>;
  /** 成稿失败的主题块（含原 index 与缺陷反馈原文），供上层 C3 块级隔离重试定向重写；
   * C7 补充 lastAttempt/failureKinds：块最近一次有效尝试原文与失败类别清单——
   * 供上层（stageChapterLoop）在隔离重写耗尽后判定「章级超产对冲接纳」 */
  failedBlocks: Array<{ index: number; block: PlannedChapterBlock; retryFeedback?: string; lastAttempt?: string; failureKinds?: string[] }>;
  /** 全部块成稿成功 */
  allSucceeded: boolean;
  /** 成功块拼接的章节 Markdown（含章标题外壳；失败块缺失时不包含该块正文） */
  markdown: string;
}

/** C7 章级超产对冲接纳线（与块末轮容差线同口径 1.2×）：隔离重写耗尽后，失守块全部仅篇幅超产时，
 * 接纳后章总量落在此区间内即可对冲接纳末轮内容成章；下限 0.85× 与块达标区下限同源（防欠产侧混入） */
export const CHAPTER_OVER_PRODUCE_ACCEPTANCE_MAX_RATIO = 1.2;
export const CHAPTER_OVER_PRODUCE_ACCEPTANCE_MIN_RATIO = 0.85;

export interface ChapterOverProduceAcceptanceInput {
  /** 章级块成稿结果（隔离重写后：成功块为正文，失守块为 undefined） */
  sections: Array<string | undefined>;
  /** 隔离重写耗尽后仍失守的块（带最近一次有效尝试原文与失败类别清单） */
  exhaustedBlocks: Array<{ index: number; lastAttempt?: string; failureKinds?: string[] }>;
  /** 各块目标字数（章级总量守恒分母 = 块预算合计，Σ 与章预算守恒由容量规划保证） */
  blockTargetWords: number[];
}

/** C7 章级超产对冲接纳（纯函数，单测锚点）：隔离重写耗尽后，失守块若全部满足——
 *  ① 携带非空末轮内容；② 失败类别严格为 ['over-produce']（结构/数值/密度/套话/归因/格式等任何
 *  内容类缺陷混入即拒绝）；③ 填回后无剩余缺口块；④ 章总量 ∈ [0.85,1.2]×块预算合计——
 * 则接纳末轮内容成章（返回拼接后 sections 与审计详情）；任一条件不满足返回 undefined（照旧章阻断）。
 *  动机（r28m 实机）：块内容质量全达标、仅篇幅超产（末轮 1.30×）被判块死 → 整章阻断 → 文档缺章；
 * 而章总量 3776 ≈ 章预算 3703 本守恒——块容差只吸收末轮抖动，累计放大由章级审计（>1.2× 告警）
 * 与文档级阻断线（目标总额 +20%）兜底（4.51 分层容差设计意图的缺口补链，零静默降级不变：
 * 非篇幅类失守/严重超产/无末轮内容一律照旧显式失败）。 */
export function salvageChapterByOverProduceAcceptance(input: ChapterOverProduceAcceptanceInput): { sections: string[]; detail: string } | undefined {
  const { sections, exhaustedBlocks, blockTargetWords } = input;
  if (exhaustedBlocks.length === 0 || sections.length !== blockTargetWords.length) return undefined;
  const filled = [...sections];
  const acceptedIndexes: number[] = [];
  for (const item of exhaustedBlocks) {
    if (item.index < 0 || item.index >= filled.length) return undefined;
    const lastAttempt = item.lastAttempt;
    if (!lastAttempt || !lastAttempt.trim()) return undefined;
    const kinds = item.failureKinds || [];
    if (kinds.length !== 1 || kinds[0] !== 'over-produce') return undefined;
    const existing = filled[item.index];
    if (existing && existing.trim()) return undefined;
    filled[item.index] = lastAttempt;
    acceptedIndexes.push(item.index);
  }
  if (filled.some(section => !section || !section.trim())) return undefined;
  const total = documentTextLength(filled.join('\n\n'));
  const budget = blockTargetWords.reduce((sum, words) => sum + (Number.isFinite(words) && words > 0 ? words : 0), 0);
  const minAcceptance = Math.floor(budget * CHAPTER_OVER_PRODUCE_ACCEPTANCE_MIN_RATIO);
  const maxAcceptance = Math.ceil(budget * CHAPTER_OVER_PRODUCE_ACCEPTANCE_MAX_RATIO);
  if (budget <= 0 || total < minAcceptance || total > maxAcceptance) return undefined;
  return {
    sections: filled as string[],
    detail: `章级超产对冲接纳 ${acceptedIndexes.length} 块（块序号 ${acceptedIndexes.join('、')}，末轮仅篇幅超产）：章总量 ${total} 字 vs 块预算合计 ${budget} 字（接纳区间 ${minAcceptance}~${maxAcceptance} 字，累计放大由章/文档级观测兜底）`,
  };
}

/** 4.19.5 分部章容器块总述提示词（丰乐镇第二轮验收）：分部章容器块（「主要分部分项工程施工方案」在
 * 「主要施工方法」章内）是全章总述小节——各分部方案已在本章其他小节展开，容器块不得复写任何单个
 * 分部工程的施工方案，也不得使用本章其他小节标题。正文直接展开（无需四级标题），按
 * 分部划分/总体部署/组织资源/质量安全进度接口四部分组织；禁止 Markdown 表格（块质检对关键小节
 * 确定性剥表）与空泛原则表述。 */
export function divisionContainerOverviewPrompt(targetWords: number): string {
  return [
    '【分部分项工程施工方案总述】本节为本章各分部分项工程施工方案的总体概述小节：各分部工程的具体施工方案已在本章其他小节逐项展开，本节不得复写任何单个分部工程的施工方案，也不得把本章其他小节（各分部工程方案）标题作为本节任何标题。正文直接展开、无需四级标题，禁止 Markdown 表格，按以下四部分组织：',
    '一、分部工程划分与专业分组：按专业分组（如道路、排水、景观绿化、电气照明、公建配套等）列明本章覆盖的分部工程范围与作业内容，说明各专业间的相互关系；',
    '二、施工总体部署：施工分区与流水段划分、总体施工顺序安排、关键线路与节点控制、各专业施工穿插衔接原则；',
    '三、施工组织与资源配置：按专业划分的施工队伍与作业面安排、总体资源投入与调配原则、多专业协调管理机制；',
    '四、质量、安全与进度接口：各分部工程间的成品保护与工序交接安排、总体质量控制与检测验收安排、安全文明施工总体要求。',
    `每部分不少于 ${Math.floor(targetWords / 4)} 字，全文合计不少于 ${targetWords} 字；结合本项目资料中的具体工程内容（单体、部位、专业、工程量）展开，禁止空泛原则表述。`,
  ].join('\n');
}

/** M4 工程对象（工程归属）提取后缀词表：分村/分工程事实隔离的提取锚点（地理归属类对象） */
const ENGINEERING_OBJECT_SUFFIXES = ['村', '社区', '小区', '家园', '片区', '工区', '标段'];
/** 泛称噪声词（非具体工程对象）：提取结果按「包含」判定过滤，避免「农村/全村」类泛称与跨词边界长串
 *  （「居环境整治全村」）参与隔离判定 */
const ENGINEERING_OBJECT_STOPWORDS = ['农村', '村村', '全村', '本村', '各村', '每村', '乡村', '跨村', '入村', '出村', '邻村', '沿村', '自然村', '所有村', '多村'];
const ENGINEERING_OBJECT_RES = ENGINEERING_OBJECT_SUFFIXES.map(suffix => new RegExp(`[\\u4e00-\\u9fa5A-Za-z0-9]{1,6}${suffix}`, 'gu'));

/** M4 工程对象提取：从标题/事实行中提取「X村」「X社区」等工程归属对象（前缀贪婪回退取最短合法词：
 *  「李庄村改造项目」→「李庄村」），用于事实分配的工程归属隔离与同对象互含判定 */
export function extractEngineeringObjectNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const re of ENGINEERING_OBJECT_RES) {
    for (const match of text.matchAll(re)) {
      if (!ENGINEERING_OBJECT_STOPWORDS.some(stopword => match[0].includes(stopword))) names.add(match[0]);
    }
  }
  return names;
}

/** 事实分配工程归属加分：块标题与事实行命中同一工程对象时的 token 得分加成 */
const ENGINEERING_OBJECT_ASSIGN_BONUS = 100;

/** M4 事实分配工程归属隔离（纯函数，单测锚点）：章级事实行按块标题/要点相关性分配——
 *  ① 每条事实行只归属一个块（得分最高者，先到先得），与历史分配一致；
 *  ② 块标题（含要点）命中工程对象（村/社区等）时执行归属隔离：事实行含其他对象且不含本块对象 → 本块不认领
 *  （防「A 村数值写入 B 村块」的跨工程串位）；含本块对象 → 加高分优先归位；
 *  ③ 全块零命中的事实行不强制分配（留章级共享事实层），与历史行为一致。 */
export function assignChapterFactsToBlocks(
  blocks: Array<{ title: string; subPoints: Array<{ title: string }> }>,
  factPool: string[],
): string[][] {
  const blockTexts = blocks.map(block => `${block.title} ${block.subPoints.map(point => point.title).join(' ')}`);
  const blockTokenSets = blockTexts.map(text => new Set(tokenizeForRelevance(text).filter(token => token.length >= 2)));
  const blockObjectSets = blockTexts.map(text => extractEngineeringObjectNames(text));
  const assignments: string[][] = blocks.map(() => []);
  if (factPool.length === 0) return assignments;
  for (const factLine of factPool) {
    const factTokens = tokenizeForRelevance(factLine).filter(token => token.length >= 2);
    const factObjects = extractEngineeringObjectNames(factLine);
    let bestIndex = -1;
    let bestScore = 0;
    blockTokenSets.forEach((tokenSet, index) => {
      const blockObjects = blockObjectSets[index];
      let objectBonus = 0;
      if (blockObjects.size > 0 && factObjects.size > 0) {
        // 同对象判定按互含容错：「小菜园村」与「义井乡小菜园村」视为同一对象
        const sameObject = [...factObjects].some(factObject => [...blockObjects].some(blockObject => factObject.includes(blockObject) || blockObject.includes(factObject)));
        if (!sameObject) return; // 块已明确工程对象、事实行涉及的是其他对象 → 本块不认领（M4 跨工程串位防线）
        objectBonus = ENGINEERING_OBJECT_ASSIGN_BONUS;
      }
      const score = factTokens.reduce((sum, token) => sum + (tokenSet.has(token) ? 1 : 0), 0) + objectBonus;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestScore > 0) assignments[bestIndex].push(factLine);
  }
  return assignments;
}

export async function buildPlannedChapterContent(input: PlannedChapterContentInput, structure: PlannedChapterStructure): Promise<PlannedChapterContentResult | undefined> {
  const blocks = structure.blocks;
  if (blocks.length === 0) return undefined;
  /** 剥离块成稿开头的同标题 H3 外壳（相邻同名块拼接时后块标题行剥壳，目录只保留一个小节；
   * 模型自行改名的 H3 不剥，由块质检清单外判定拦截） */
  const stripLeadingShellTitle = (content: string, normalizedShellTitle: string): string => content.replace(/^###\s+[^\n]*\n+/u, match => {
    const heading = match.replace(/^###\s+/u, '').trim();
    return normalizeSubsectionTitleForDedup(heading) === normalizedShellTitle ? '' : match;
  });
  // 表格计划按主题块挂接：块内 subPoint 覆盖的源细目标题命中的表挂到该块；未命中必写表挂最后一块兜底，保证必写表不丢失
  const allSubPointTitles = blocks.flatMap(block => block.subPoints.flatMap(point => point.sources));
  const unassignedPlans = unassignedSectionTablePlans(input.chapter, allSubPointTitles);
  const blockTablePlans = blocks.map((block, index) => {
    const own = (input.chapter.tablePlans || []).filter(plan => {
      if (unassignedPlans.includes(plan)) return false;
      const title = plan.title || '';
      return block.subPoints.some(point => point.sources.some(source => title.includes(source) || source.includes(title)) || title.includes(point.title) || point.title.includes(title));
    });
    return index === blocks.length - 1 ? [...own, ...unassignedPlans] : own;
  });
  const configuredConcurrency = tuningProfile().plannedBlockConcurrency || blocks.length;
  const concurrency = Math.max(1, Math.min(blocks.length, getDocumentLlmMaxConcurrency(), Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : blocks.length));
  const results: Array<string | undefined> = new Array(blocks.length).fill(undefined);
  // P3 全局事实分配表（章级确定性分配，零 LLM）：章级证据池事实行按块标题/要点相关性分配——
  // 每条事实行只归属一个块（得分最高者），杜绝同一事实被多块重复落位（重复在规划层被固化的问题）。
  // M4 工程归属隔离：块标题命中工程对象（村/社区等）时只认领本工程的事实行（防跨工程数值串位），
  // 分配实现单点化在 assignChapterFactsToBlocks（纯函数可测）。
  // 分配结果经 factsHint 注入（「本主题块专属事实，只能在本节使用，不得重复出现在本章其他节」），
  // 已预分配给他块的事实行在本块不得重复展开——P7 邻节事实认领约束同一载体。
  const chapterFactPool = [...new Set(input.evidence.flatMap(item => extractKeyFactLines(item.content).split('\n').filter(Boolean)))];
  const blockFactAssignments = assignChapterFactsToBlocks(blocks, chapterFactPool);
  // D1/A1 章级证据池上移 L2：T0 关键事实层 + 章级 T1 摘要池 + T2 目录一次构建、同章各块共享注入
  // （各块值完全相同 → prefix cache 共享命中），块级 L3 只带块相关增量（A2）——N 个块各注入一份
  // 全量事实行+全章 T1 片段是块级调用输入 token 的大头，也是「前三章写很久 + 命中率低」的根因之一
  const chapterPoolChars = tuningProfile().chapterPoolChars || 5000;
  const sharedFactLayerText = buildChapterEvidencePool(buildEvidenceBundle(input.chapter, input.evidence), input.chapter.requiredFacts || [], Number.isFinite(chapterPoolChars) ? Math.floor(chapterPoolChars) : 8000);
  // A2 块级增量压缩：块级证据预算 1k（blockEvidenceChars，DOCUMENT_TUNING_PROFILE 可调，默认 1000），
  // 且只保留块相关命中片段（onlyRankBoosted）——块级 L3 从 7k-26k 压缩到 1k 量级
  const blockEvidenceCeiling = tuningProfile().blockEvidenceChars || 1000;
  const blockEvidenceCeilingChars = Number.isFinite(blockEvidenceCeiling) && blockEvidenceCeiling > 0 ? Math.floor(blockEvidenceCeiling) : 1000;
  // C3 隔离重写定向反馈收集（key=块 index）：块失败时把缺陷反馈原文交给上层——
  // 单块重写（stageChapterLoop.retryFailedBlocks）attempt=0 注入 initialFeedback，避免从零复现同一漏点
  const blockRetryFeedbacks = new Map<number, string>();
  // C7 章级超产对冲接纳痕迹（key=块 index）：块每次质检失败即覆盖记录最近一次有效尝试原文与失败类别——
  // 隔离重写耗尽后由上层判定「失守块全部仅篇幅超产 + 章总量守恒」即对冲接纳，否则照旧章阻断
  const blockLastAttempts = new Map<number, string>();
  const blockFailureKinds = new Map<number, string[]>();
  const writeBlock = async (block: (typeof blocks)[number], index: number): Promise<string | undefined> => {
    // 彻底修复同名结构：与主题块标题同名的 H4 要点由 H3 外壳直接承担，不再要求输出同名 H4
    // （历史缺陷：H3/H4 同名诱发模型把同名 H4 重复展开多轮 → 重复质检两轮失败 → dedupe 兜底字数不足 → 章阻断）
    const normalizedBlockTitle = normalizeSubsectionTitleForDedup(block.title);
    const blockSectionPoints = block.subPoints.filter(point => normalizeSubsectionTitleForDedup(point.title) !== normalizedBlockTitle);
    const sectionTitles = blockSectionPoints.map(point => point.title);
    // 4.19 串章骨架防线：本章其他主题块的块标题+要点标题（归一化）作为禁词集合——
    // LLM 在主题块成稿时照抄整章其他主题块骨架（6.4 块输出 6.1~6.3 全部小节标题）属质检盲区：
    // missing 只查缺失、duplicates 只查同 H3 内重名，串章标题全数漏网（真实回归：目录小节串章实锤）
    // 排除口径用归一化标题而非引用比较（块对象可能与 blocks 数组不同源，候选用引用比较会失效 →
    // 自身标题全部算入禁词 → 块内 H4 被 extraneous 误判，4.19 回归实证：块隔离用例全块失败）
    const ownTitleSet = new Set([block.title, ...block.subPoints.map(point => point.title)].map(normalizeSubsectionTitleForDedup).filter(Boolean));
    const otherBlockTitles = blocks
      .flatMap(candidate => [candidate.title, ...candidate.subPoints.map(point => point.title)])
      .filter(title => !ownTitleSet.has(normalizeSubsectionTitleForDedup(title)));
    const otherBlockTitleSet = new Set(otherBlockTitles.map(normalizeSubsectionTitleForDedup).filter(Boolean));
    // 块级证据：全章证据按块标题与要点关键词相关性排序（只排序不丢弃，全量保留进输入）+ 块标题定向检索补充
    const blockTokens = tokenizeForRelevance(`${block.title} ${sectionTitles.join(' ')}`).filter(token => token.length >= 2);
    // 修复2/A2：块级相关性加权注入——evidenceBundlePrompt 的 T1 选取内部按 requiredFacts 重要性重排，
    // 本处的块相关性排序对最终注入内容无影响（历史缺陷：同章各块注入几乎相同的 T1）；
    // 通过 evidenceRankBoost 把块相关性叠加进 T1 排序分（单 token 命中 +6、封顶 +24，
    // 不挤占量化参数/基础事实类证据的高分），并配合 onlyRankBoosted 只保留块相关命中片段，
    // 让块级 L3 真正只带块专属增量（A2 增量压缩，1k-3k 预算）
    const blockRankBoost = (item: DocumentEvidence) => Math.min(24, blockTokens.reduce((sum, token) => sum + (item.content.includes(token) ? 6 : 0), 0));
    const scoredEvidence = input.evidence
      .map(item => ({ item, score: blockTokens.reduce((sum, token) => sum + (item.content.includes(token) ? 1 : 0), 0) }))
      .sort((left, right) => right.score - left.score)
      .map(entry => entry.item);
    const extraEvidence = input.sectionEvidenceProvider ? await input.sectionEvidenceProvider(block.title).catch((error: unknown) => {
      // 降级治理：失败 ≠ 无块级专属证据（原实现让块级差异化注入静默消失且无任何信号）
      if (input.diagnostics) input.diagnostics.llm.lastError = `块级专属证据召回失败（${block.title}）：${error instanceof Error ? error.message : String(error)}`;
      console.error(`[gen] 块级专属证据召回失败（${block.title}）`, error);
      return [];
    }) : [];
    const blockEvidence = [...scoredEvidence, ...extraEvidence];
    // 骨架锁定（稳定版）：仅当块 H3 标题本身是工作包级小节时才锁定骨架。块内 H4 要点命中关键小节
    // 不触发块级骨架锁定——「项目主要施工内容」作为其他章（如重点难点章）的 H4 要点时，
    // 该 H4 小节的骨架由修复链 enforceWorkPackageSkeletons 阶段 0 补建 + 锚点直连补写兜底；
    // 历史缺陷（轮4 实测）：块内 H4 命中即整块锁骨架，scopeEngineeringNames 把证据里的约束文本
    //（工程量/系统约束/不得编造等）当工作包名，块质检要求模型输出垃圾标题 → 两轮全失败 → 章失败
    // P2.5 骨架锁定兜底：块标题本身是工作包级小节，或本章标题是「主要施工方法」类分部章
    //（块标题为分部名，如「道路工程」）时锁定骨架——分部章的块标题不匹配 DIVISION_SECTION_RE，
    // 历史缺陷（丰乐镇第十轮实测）：「主要施工方法」章 23 个蓝图分部名块因 keySectionKind 为空
    // 从不触发骨架锁定，三来源提取又哑火（图谱包被项目名过滤/招标范围叙述式提取不足/证据无清单正文）→
    // 整章自由发挥丢分部结构
    const keySectionKind = MAJOR_CONTENT_SECTION_RE.test(block.title) ? 'major' : (DIVISION_SECTION_RE.test(block.title) || DIVISION_SECTION_RE.test(input.chapter.title)) ? 'division' : '';
    // 4.19.5 回归（丰乐镇第二轮验收）：分部章容器块（「主要分部分项工程施工方案」在「主要施工方法」章内）
    // 是全章总述小节，不得套用单分部要素融合 divisionElementFusionPrompt——历史缺陷：容器块按三段式展开时 LLM 把本章全部
    // 分部名写成 H4（清单外）+ 每分部三段标签重复展开（重复）→ 两轮重试+确定性兜底全灭 → 章阻断；
    // 容器块改发总述提示词（不锁骨架、正文直接展开、禁止使用其他小节标题），清单外 H4 由块质检确定性修复剥离。
    const isDivisionChapterContainer = DIVISION_SECTION_RE.test(input.chapter.title) && DIVISION_SECTION_RE.test(block.title);
    // 骨架提取专用完整上下文：瘦身 context 缺招标范围/图谱包段时骨架名提取哑火，回退到完整上下文
    const skeletonContext = input.skeletonProjectContext ?? input.projectContext;
    // 骨架名按块要点标题过滤（历史缺陷：块预算物理装不下全部工作包 × 三要素时，质检仍要求
    // 全量骨架名 → 块必败）；块要点（subPoints 已骨架展开）与骨架名同源，过滤后仍是全量名
    const blockSkeletonNamesRaw = keySectionKind && !isDivisionChapterContainer ? workPackageSkeletonTitles(skeletonContext, blockEvidence) : [];
    // P2.7 骨架名一律按块要点标题过滤（单要点分部块修复，P0 验收实测）：
    // 原实现 subPoints 仅 1 个时全量保留章级工作包骨架名 → 「主要施工方法」章每个分部块
    // （小菜园/门窗工程等）被要求写全章级工作包（终端--白水塘、景观工程等）→ 与
    // coverageList「同名要点由 H3 外壳承担、无需四级标题」矛盾 → 两轮重试全灭 → 章失败。
    // 统一按 subPoints 标题包含匹配过滤：单要点分部块匹配不到章级工作包名 → 空 →
    // divisionElementFusionPrompt 要素融合接管；容器块 subPoints 已骨架展开（同源）→ 全量保留；
    // 过滤后不足 minCount(3) 视为无骨架可锁（与 workPackageSkeletonPrompt 内部
    // minCount 语义对齐，1-2 个骨架名时提示词不注入但质检仍要求是历史不对称残留）
    const subPointSkeletonNames = block.subPoints.map(point => point.title).filter(Boolean);
    const matchedSkeletonNames = isDivisionChapterContainer ? [] : matchBlockSkeletonNames(blockSkeletonNamesRaw, subPointSkeletonNames);
    // P2.5 骨架名兜底：三来源提取不足 minCount（3）时，用块规划层 subPoints 标题兜底——
    // 块规划与蓝图 outline 分部名同源（P1.3 已把 outline 分部名展开进容器块 subPoints），
    // 是「主要施工方法」章在证据不足时唯一可靠的骨架来源；兜底不足时骨架锁定整体回退软约束
    // 发布前实测（丰乐镇 doc-1788970810155）：域聚合块（公厕装饰装修 6 工作包）提取名
    // 只匹配到门窗 → 要素融合接管，注入的 6 包覆盖清单 LLM 只写首包，其余 5 包内容丢失；
    // 过滤条件去除 raw.length < 3 限制：subPoints ≥ 3 的多工作包块一律用 subPoints 锁
    // H4 骨架逐包写（机电块 6 包锁骨架 3535 字全覆盖的成功模式），单要点块仍走要素融合
    const blockSkeletonNames = isDivisionChapterContainer
      ? []
      : (matchedSkeletonNames.length > 0
        ? matchedSkeletonNames
        : (subPointSkeletonNames.length >= 3 ? subPointSkeletonNames : []));
    const blockSkeletonPrompt = keySectionKind ? workPackageSkeletonPrompt(skeletonContext, blockEvidence, 3, blockSkeletonNames) : '';
    // WS5 分部块要素融合结构：蓝图分部章（如「主要施工方法」）的分部块（标题=清单分部名，如「道路工程」）
    // subPoints 仅同名 1 个、无 H4 骨架可锁——五要素（作业对象与工程量/工序顺序/工艺参数/验收闭环/
    // 数值来源）融入连贯散文，H3 直接承载正文；原三段标签链（施工概况/施工流程/施工方法）已删除
    //（历史缺陷：段首标签 40 处 + 同名标签 H4 三组——结构入后台、表达回前台）
    const divisionElementFusionPrompt = keySectionKind === 'division' && blockSkeletonNames.length === 0 && !isDivisionChapterContainer
      ? `【分部工程施工方案要素要求】本节为一个分部分项工程的施工方案，写成连贯散文叙述（禁止 Markdown 表格；禁止以“施工概况/施工流程/施工方法”等结构标签充当小节标题或段落开头）：\n要素自然融入叙述：作业对象与部位、工程量或规模、材料设备规格型号（数量类数值优先取工程量清单数据）；工序先后顺序清晰；工艺做法与工艺参数（数值+单位）；验收检测与记录闭环。\n数值来源优先级：工程量、材料规格、设备型号等数量类数值优先取工程量清单数据；清单未覆盖的参数（标高、坡率、构造做法等）才取图纸数据；禁止“按设计图纸执行”“详见设计图纸”“按设计文件确定”式概括话术——必须落到具体数值或具体规范条文。${sectionTitles.length > 0 ? `\n本节覆盖以下分部分项工作内容，正文必须逐项落实、不得遗漏任何一项：${sectionTitles.join('、')}。` : ''}`
      : '';
    const divisionContainerPrompt = isDivisionChapterContainer ? divisionContainerOverviewPrompt(block.targetWords) : '';
    // s1-slim 块级聚焦（单块输入瘦身核心）：① 参数桶按块 token 条目级筛选
    // （实测全量 36413 字符 → 块相关数千字符）；② 章切片只展开块相关工作包
    // （实测整章 103488 字符 → 块相关 5~10 个工作包）。两段均位于块变化段注入（同章各块互不相同）
    const blueprintBlockTokens = [...new Set([
      block.title,
      ...block.subPoints.map(point => point.title),
      ...block.subPoints.flatMap(point => point.sources || []),
      ...blockSkeletonNames,
    ].filter(Boolean))];
    const blockBlueprintDataText = input.blueprintData
      ? renderBlueprintDataTextForBlock(input.blueprintData, {
        blockTokens: blueprintBlockTokens,
        quantityCharsCap: tuningProfile().blueprintBlockQuantityCap,
        materialCharsCap: tuningProfile().blueprintBlockMaterialCap,
      })
      : '';
    const blockBlueprintSliceText = input.blueprintChapter && input.blueprintData
      ? renderBlueprintBlockSlice(input.blueprintChapter, input.blueprintData, {
        blockTitle: block.title,
        subPointTitles: sectionTitles,
        skeletonNames: blockSkeletonNames,
        sliceCharsCap: tuningProfile().blueprintBlockSliceCap,
      })
      : '';
    const blockChapter = { ...input.chapter, title: block.title, sections: sectionTitles, tablePlans: blockTablePlans[index] || [] };
    // 4.42 逐要点守恒配额直连写作层：容量规划 quotaWords（Σ=块预算，与覆盖清单同源同数）——
    // 旧写作层 sectionTargets 独立计算（固定 520 地板）Σ=520N 在 N≥4 时必然突破块合同上限，
    // 是 4.41 首轮 22/22 全超产（1.19~2.29x）的确定性根因（第八轮 V 组对照实验实证）
    const blockSectionQuotas: SectionQuotaItem[] = blockSectionPoints.map(point => ({ title: point.title, words: point.quotaWords || 0 }));
    // P3/P7 专属事实注入：blockFacts 为章级分配表分配给本块的事实行（每条只归属一个块）；
    // 蓝图规划层 block.facts 历史恒为空数组（factsHint 载体存在但从未填充），现由分配表确定性填充
    // 上限治理：**不截断块专属事实**（原 slice(0,8)）。分配是**互斥**的（每条事实只归属一个块），
    // 故被截掉的事实**任何块都拿不到**——不是「本块少注入」，是「该事实在写作层彻底消失」。
    const blockFacts = [...(block.facts || []), ...blockFactAssignments[index]];
    const factsHint = blockFacts.length
      ? `【本主题块专属事实（只能在本节使用，不得重复出现在本章其他节；本章其他节已认领各自专属事实，本节不得重复展开其他节专属事实）】${blockFacts.map(item => `- ${item}`).join('\n')}`
      : '';
    // 覆盖清单：语义合并后的 H4 标注其承载的全部评分细目，写手按清单展开内容但不得为细目单独开设标题；
    // 与块标题同名的要点由 H3 外壳直接承担（不再输出同名 H4），清单中仅提示其覆盖细目。
    // 容量规划配额随清单下发（指令层：告诉模型每个要点写多深）——块质检只查块总字数区间，
    // 不逐点核对配额，写作口径与检测口径同源
    const coverageList = block.subPoints.map(point => {
      // 4.43 上限语义 + 显示校准：点位配额同样按系数折算（点位目标语义零咬合，V13 全信号上限化后落窗）
      const quota = point.quotaWords && point.quotaWords > 0 ? `篇幅不超过 ${displayWordCap(point.quotaWords)} 字` : '';
      return normalizeSubsectionTitleForDedup(point.title) === normalizedBlockTitle
        ? `- ### ${block.title}（本节标题，覆盖评分细目：${point.sources.join('、')}；正文直接展开，无需四级标题；如按细目分节，仅可使用上述细目标题作为四级标题${quota ? `；${quota}` : ''}）`
        : (point.sources.length > 1
          ? `- #### ${point.title}（覆盖评分细目：${point.sources.join('、')}${quota ? `；${quota}` : ''}）`
          : `- #### ${point.title}${quota ? `（${quota}）` : ''}`);
    }).join('\n');
    // F9：章级角色上下文（评分项要求路由/数据口径约束）拆出上移 L2 共享段（同章各块完全相同），
    // 块级 roleContext 只保留块专属段（factsHint/coverageList）——共享前缀变长，命中率回升
    const forbiddenTitlesLine = otherBlockTitleSet.size > 0 ? `严禁将以下属于本章其他小节的标题作为本节任何标题输出（H3 仅允许「${block.title}」，H4 仅允许上面清单中的标题）：${[...otherBlockTitleSet].join('、')}。` : '';
    const blockRoleContext = [factsHint, blockSkeletonPrompt, divisionContainerPrompt, divisionElementFusionPrompt, keySectionKind && !isDivisionChapterContainer ? flowRotationDirective(index) : '', block.subPoints.length > 0
      ? `本节是「${input.chapter.title}」章的一个主题小节，只写本节标题覆盖的内容，不得重复本章其他节内容；必须按以下清单逐点写出实施性正文，标题必须与给定标题完全一致，不得改名、合并或遗漏；每个要点必须覆盖其标注的全部评分细目内容，但不得为这些细目单独开设小节标题；清单标注的篇幅为该要点字数上限，按标注控制详略、不得超出：\n${coverageList}${forbiddenTitlesLine ? `\n${forbiddenTitlesLine}` : ''}`
      : `本节是「${input.chapter.title}」章的唯一小节（本章无细分小节规划）：正文在 H3 标题下直接展开为连贯的正式叙述，不使用四级标题；覆盖本节标题对应的全部实质内容，不得重复章外内容。`, '【防复读硬约束】本节内同一句话只允许出现一次：同一段落内不得复读任何已写出的句子，不同段落之间不得整句复制，同一工艺/措施只在一处完整表述、其余位置引用结论不重述原文；段落结尾不得复读段内前句（禁止“为此/综上/因此”后接照抄句）。'].filter(Boolean).join('\n\n');
    let lastMissing: string[] = [];
    let lastDuplicates: string[] = [];
    let lastExtraneous: string[] = [];
    let lastChars = 0;
    let lastNumericFeedback = '';
    let lastFlowFeedback = '';
    // C3 生成期套话反馈（第二轮注入）：首轮套话句阻断时携带命中句原文定向重写
    let lastFillerFeedback = '';
    // 方案 2.2 执行器反馈（第二轮注入）：密度缺口/归因量化/格式硬约束定向重写
    let lastDensityFeedback = '';
    let lastAttributionFeedback = '';
    let lastFormatFeedback = '';
    // V2 批1 结构完整性反馈（第二轮注入）：首轮 blocking 类结构缺陷原文定向重写
    let lastStructureFeedback = '';
    // 4.40 块超产反馈（第二轮注入）：模型对小目标块系统性超产（舒城实测 505 字目标实写 1858 字，
    // 全章 59473 = 目标 3.68 倍），验收只查下限时超产零拦截——超产阻断携带压缩指令定向重写；
    // 二轮仍超产不再放行（旧 4.35「二轮一律放行」是超产进入成稿的最后失守环节）
    let lastOverProduceFeedback = '';
    // 4.55.22 关键小节绝对深度门槛反馈（第二轮注入）：比例线达标但未达绝对门槛时的缺口数字与要求
    let lastDepthFeedback = '';
    // 4.55.22 工作包节结构/要素门禁反馈（第二轮注入）：缺陷原文（要素不全/方法过弱/工序顺序缺失/污染）
    let lastElementFeedback = '';
    // 2.6 补写上限收紧：块级写作/反馈重试循环上限显式化（固化为 2，与既有行为一致）
    // ——上限超出即判失败转上层紧凑备用（原 DOCUMENT_BLOCK_MAX_ATTEMPTS 已固化删除）
    const blockMaxAttempts = 2;
    // 4.55.22 关键小节绝对深度门槛（生成侧，与块级比例线**并行追加**而非替代）：
    // 块标题命中关键小节（workflowRules.writingSpec.criticalDeepSections + blockerMinChars，
    // 项目级可经 {projectRoot}/.customize-agent/workflow-rules.json 覆盖）时，欠产线取
    // 「比例线 0.7×块目标」与「绝对门槛」的严格者。门槛上限为块目标（min(门槛, max(500, 块目标))）——
    // 容量规划把关键小节拆成多个小目标块时，全局门槛（1800 等）不得恒拒小目标块，否则每块都被整体
    // 拒绝反而产出空小节（已删的逐节写手即因此夹取）。仅首轮（attempt 0）生效：与块级各内容执行器
    // 同契约（首轮定向反馈重写一次、末轮放行），末轮由终检链兜底（finalize critical-section-depth
    // 检测器 → content-depth-repair 补写轮，severity=blocker），块级不新增终局失败面。
    const criticalDepthFloor = isCriticalDeepSection(block.title)
      ? Math.min(criticalSectionBlockerMinChars(block.title), Math.max(500, block.targetWords))
      : 0;
    /**
     * 欠产硬门线；末轮不设欠产门（照既有「微缺口重写收敛期望为负」契约放行交终检链兜底）。
     *
     * **4.55.22 修复（真实用户实测回归）**：绝对深度门槛一度被并入本线
     *（`max(0.7×块目标, criticalDepthFloor)`）——而 `criticalDepthFloor = min(blockerMinChars, max(500,块目标))`，
     * 对「主要施工内容」这类关键小节（blockerMinChars=1800）会把接受区间从 [0.7×目标, 1.15×目标]
     * **收窄到 [≈目标, 1.15×目标]**：模型一次写不到接近目标字数即被拒 → 全部块失败 → 整章阻断
     *（用户实测报错「规划块全部失败：主要施工内容」）。绝对门槛的正当职责是**驱动首轮定向补写反馈**
     *（见 lastDepthFeedback），终态那层已由终检 `critical-section-depth` + `content-depth-repair` 兜底——
     * 块级不得新增终局失败面（上一段注释本就写明该契约，此次是执行偏离了它）。
     */
    const underProduceLine = Math.floor(block.targetWords * 0.7);
    /** 首轮反馈下达的篇幅下限：可接受区下沿；绝对门槛作为**更高目标**只出现在反馈措辞中 */
    const charFloor = Math.max(Math.floor(block.targetWords * 0.85), criticalDepthFloor);
    // 4.55.22 工作包节结构与要素门禁（生成侧）：复用 sectionStructureIssue 单源（与终检
    // construction-org-major-content / construction-org-division-section 及 utils 三要素判定同源），
    // 把「工作包三要素不全 / 方法段过弱 / 工序顺序表达缺失 / 脏事实与流程污染 / 表格承载正文」
    // 挡在块成稿之前——此前这些判据只存在于逐节写手（死代码）与终检检测器，块级质检盲区。
    // 适用面按 H4 契约收窄（门禁内部阈值与写作清单必须同口径，否则形成自我抵消回路）：
    // ① 块标题须为工作包级小节（项目主要施工内容 / 主要分部分项工程施工方案类）；
    // ② major 门禁要求 H4 契约 ≥3（门禁内部按「工作包 ≥3」判定：契约不足 3 时模型只能新增清单外 H4
    //    凑数 → 被清单外标题判定拦回）；division 门禁要求 ≥1（其内部只要求「有分项块」）；
    // ③ 分部章容器块按总述提示词「正文直接展开、无需四级标题」写作，结构门禁口径不适用，排除。
    const isMajorWorkPackageBlock = MAJOR_CONTENT_SECTION_RE.test(block.title);
    const isDivisionWorkPackageBlock = !isMajorWorkPackageBlock && DIVISION_SECTION_RE.test(block.title);
    const workPackageElementGateApplies = !isDivisionChapterContainer
      && (isMajorWorkPackageBlock ? sectionTitles.length >= 3 : isDivisionWorkPackageBlock && sectionTitles.length > 0);
    // 质检缺陷是否出现过（供失败块隔离重写反馈收集判定：纯异常失败不携带"质检未通过"话术）
    let sawQcDefect = false;
    // 块缺陷反馈渲染（第二轮重试与 C3 隔离重写共用）：缺失/重复/清单外标题点名 + 各执行器定向反馈；
    // includeCharFeedback 仅第二轮启用（此时已知上一轮字数；隔离重写为全新调用、字数反馈无锚点）。
    // 隔离重写携带反馈的动机（4.44 丰乐镇工期章实机实证）：块两轮漏写要点后，无反馈的单块重写
    // 从零生成极易复现同一漏点，空转最后一轮机会
    const buildBlockDefectFeedback = (includeCharFeedback: boolean): string => [
      '【上一轮未通过质检】',
        lastMissing.length ? `缺失 H4 要点标题：${lastMissing.join('、')}。必须逐点补齐以上 H4 标题并展开正式正文，H4 标题与给定标题完全一致。` : '',
        lastDuplicates.length ? `重复展开的 H4 要点标题：${lastDuplicates.join('、')}。同一小节内相同要点被重复展开多轮，必须只保留一轮完整展开，其余重复小节连同标题整体删除，不得以换编号方式重复同一内容。` : '',
        lastExtraneous.length ? `清单外标题（属于本章其他小节或不在本节要点清单内）：${lastExtraneous.join('、')}。这些标题连同其正文整块删除，本节只允许输出上面清单中的 H4 标题与「${block.title}」H3 标题。` : '',
        lastMissing.length === 0 && lastDuplicates.length === 0 && lastExtraneous.length === 0 ? '必须完整包含每个 H4 要点标题并展开正文，不得合并或遗漏要点。' : '',
        // P4/P5 数值核验反馈（第二轮注入）：错误数值修正指令 + 已核验正确数值保留清单
        lastNumericFeedback,
        // WS3 工序表达形式反馈（第二轮注入）：指定形式未落地时定向重写
        lastFlowFeedback,
        // C3 套话句反馈（第二轮注入）：首轮命中句原文定向重写为可核查措施
        lastFillerFeedback,
        // 方案 2.2 执行器反馈（第二轮注入）：密度缺口/归因量化/格式硬约束定向重写
        lastDensityFeedback,
        lastAttributionFeedback,
        lastFormatFeedback,
        // V2 批1 结构完整性反馈（第二轮注入）：截断/空节/表名混入表头等缺陷原文 + 修正方向
        lastStructureFeedback,
        // 4.34 超产压缩反馈（第二轮注入）：原文超限字数 + 压缩目标区间
        lastOverProduceFeedback,
        // 4.55.22 关键小节绝对深度门槛反馈（第二轮注入）：比例线内但未达绝对门槛时给缺口与深度要求
        lastDepthFeedback,
        // 4.55.22 工作包节结构/要素门禁反馈（第二轮注入）：缺陷原文 + 逐包补齐三要素的定向要求
        lastElementFeedback,
        // 二期蓝图接管：must_cite+strict 数值清单挂进第二轮反馈（未引用/数值不一致时定向重试）
        input.blueprintMustCiteHint ? `【蓝图锁定数值检查】正文必须逐条出现以下蓝图锁定数值且与给定值完全一致：${input.blueprintMustCiteHint}。` : '',
        // A22 缺口数字反馈（丰乐镇第九轮）：只报“不少于目标字数”不报缺口时模型输出不升反降
        //（第八轮实测 1742→1377 字）；带当前字数与缺口数字的反馈比笼统指令收敛有效得多。
        // 块合同区间化：低于下限报缺口数字（下限 = 达标区下沿与关键小节绝对门槛取严）；越上限由
        // lastOverProduceFeedback 携带压缩指令
        includeCharFeedback
          ? (lastChars > 0
            ? (lastChars < charFloor
              ? `当前输出仅 ${lastChars} 字，距篇幅下限 ${charFloor} 字还缺 ${charFloor - lastChars} 字，必须逐点展开补足（区间上限 ${Math.ceil(block.targetWords * 1.15)} 字）。`
              : (lastChars > Math.ceil(block.targetWords * 1.15)
                ? ''
                : `当前输出 ${lastChars} 字（本节合同区间 ${charFloor}~${Math.ceil(block.targetWords * 1.15)} 字），保持篇幅并修正上述缺陷。`))
            : `本节篇幅合同区间为 ${charFloor}~${Math.ceil(block.targetWords * 1.15)} 字（目标 ${block.targetWords} 字）。`)
          : '',
    ].filter(Boolean).join('');
    for (let attempt = 0; attempt < blockMaxAttempts; attempt += 1) {
      // 第二轮反馈针对性列出缺失/重复 H4 标题，让重试有的放矢，避免通用反馈反复缺失要点后整章失败；
      // C3 隔离重写（initialFeedback 注入）首轮即携带上一轮缺陷反馈——隔离重写是该块最后一次成稿
      // 机会（同标准不降标），从零重写不携带漏点反馈时极易复现同一失败模式（4.44 丰乐镇工期章实证）
      const feedback = attempt === 0 ? (input.initialFeedback || '') : buildBlockDefectFeedback(true);
      try {
        // 2.6 串行链观测拆解：块内每次写作调用单独记 measure（含 attempt 序），
        // 定位 chapter-planned-block-draft 总段内 写作/重试 各环节的耗时分布（观测恒开，只记数据）
        const writeCall = () => buildLlmChapterContent(input.template, blockChapter, blockEvidence, input.missingFacts, input.promptTexts, input.projectContext, input.requirement, feedback ? `${blockRoleContext}\n\n${feedback}` : blockRoleContext, {
          forbidDrawingImages: input.forbidDrawingImages,
          bidComposition: input.bidComposition,
          compactProjectContext: input.compactProjectContext,
          scopedProjectContext: input.scopedProjectContext,
          // F9：章级角色上下文上移 L2 共享段（同章各块完全相同 → prefix cache 共享命中）
          chapterLevelContext: input.roleContext || '',
          // 4.43 字数合同（单通道）：minWords/targetWords = 块目标真实值（质检口径），展示给模型的
          // 合同行经显示校准系数下达（上限语义）——真实值与展示值分离：质检用真实值、写作指令用
          // 校准值，两者经 V13 定标对齐（产出回落到真实窗口内）；maxWords 旧参数保持删除
          minWords: block.targetWords,
          targetWords: block.targetWords,
          sectionQuotas: blockSectionQuotas,
          // deepseek 思考 token 与正文共享输出池，目标字数 ×1.5 且下限 3200 留足输出空间
          //（实测 6300 字仅耗 4202 token，8192 共享池富余充足）
          maxTokens: Math.max(3200, Math.ceil(block.targetWords * 1.5)),
          // D1：章级共享 T0 事实层由 sharedFactLayerText 注入（L2 共享段，同章各块完全相同），块级证据 skipT0
          sharedFactLayerText,
          // 修复2/A2：块级相关性加权注入（T1 选取叠加块标题/要点相关性分）+ 只保留块相关命中片段
          evidenceRankBoost: blockRankBoost,
          onlyRankBoosted: true,
          // 4.17.6 块级 L3 压缩：T2 目录跳过（目录由 L2 章级证据摘要池承载追溯语义，
          // 块级证据只带块相关 T1 增量——目录是逐调用不可缓存变化段，跳过后块级 L3 再压 ~7.4K）
          skipT2Catalog: true,
          // A2 块级增量压缩：块级证据预算压缩到 1k（章级全貌由 L2 章级证据池承载）
          evidenceFloorChars: 1000,
          evidenceCeilingChars: blockEvidenceCeilingChars,
          // P5 去重：factsHint 已并入 blockRoleContext（roleContext 参数）注入，此处再拼会导致
          // 同一块专属事实清单在 prompt 中重复出现两次（浪费输入 token 且稀释前缀缓存）
          factCoverageContext: input.factCoverageContext || '',
          // s1-slim 块级聚焦：参数桶与蓝图片段均为块级筛选文本（块变化段注入，见上方构建）
          blueprintDataText: blockBlueprintDataText,
          blueprintSliceText: blockBlueprintSliceText,
          blueprintMustCiteHint: input.blueprintMustCiteHint,
          signal: input.signal,
          diagnostics: input.diagnostics,
        });
        const content = input.diagnostics
          ? await measureGenerationStep(input.diagnostics, `block-draft:${input.chapter.id}:${index}:a${attempt}`, writeCall)
          : await writeCall();
        if (!content) {
          console.error(`[gen][block-qc] 块写作返回空内容 attempt=${attempt}: ${block.title}（目标 ${block.targetWords} 字）`);
          continue;
        }
        const stripped = content.replace(/^##\s+.+$/mu, '').trim();
        const normalized = ensureGroupTertiaryShell(sectionTitles, stripped);
        // 主题块必须挂 H3 块标题：模型未输出 H3 时强制补外壳，避免全部 H4 要点直接挂在章标题下
        // 被 normalizeFormalChapterHeadings 归并到首个小节（历史缺陷：21 个 H4 挤在 2.1 一个 H3 下）
        let withBlockShell = /^###\s+\S+/mu.test(normalized) ? normalized : `### ${block.title}\n\n${normalized}`;
        // r7 防御纵深（主根因修复在 sanitizeFormalMarkdown 出口清洗，见 markdownComposer）：H4 要点标题
        // 近似对齐（写层质检前确定性清洗）——模型对生僻/书面化规划标题做单字/双字同义微调
        // （实测：「季候条件影响与工期应对」被改写为「气候条件影响与工期应对」）时，行级精确包含匹配
        // 会误判已写要点缺失 → 重试 + 隔离重写空转 → 章阻断；对齐先于缺失判定执行，修正后标题与规划
        // 同源（缺失判定「完全一致」口径不放松）；防误容：数字/季节气象字差异不容忍
        const headingAlignment = alignSimilarHeadingsToPlan(withBlockShell, sectionTitles);
        if (headingAlignment.aligned.length > 0) {
          withBlockShell = headingAlignment.markdown;
          if (input.diagnostics) input.diagnostics.llm.lastInfo = `块要点标题近似对齐：${block.title}（${headingAlignment.aligned.join('、')}）`;
        }
        // 骨架锁定质检（稳定版）：关键小节块先确定性清洗（表格剥离），再做骨架工作包标题齐全校验
        let skeletonMissing: string[] = [];
        if (keySectionKind) {
          const tableStripped = stripMarkdownTableBlocks(withBlockShell);
          if (tableStripped !== withBlockShell) withBlockShell = tableStripped;
          const headingLines = (withBlockShell.match(/^#{3,4}\s+(.+)$/gmu) || []).map(line => line.replace(/^#{3,4}\s+/u, ''));
          skeletonMissing = blockSkeletonNames.filter(name => !headingLines.some(line => normalizeSubsectionTitleForDedup(line).includes(normalizeSubsectionTitleForDedup(name))));
        }
        // V2 批1 写时七查（块成稿输出即检）：cleanable 类结构缺陷确定性就地清理（零内容生成，与终检清理器
        // 同一扫描源）——清理先于字数/数值/结构判定，防重复行/孤立编号凑字数与缺陷进入下游链条；
        // 4.44 门禁链源头根治：表名混表头先经写时确定性归一（normalizeTableTitleInHeaders：表题独立成行+
        // 规划字段名归位）在进入扫描前消灭；残余 blocking 类（截断/空节/空表/标点断裂）任何轮次一律
        // 阻断——末轮仍残留即块失败 → C3 块级隔离重试（同标准）→ 仍失败即章阻断、文档显式失败。
        //（历史「最后一轮放行交终检链兜底」为虚构通道：终检仅报告阻断、无修复轮锚定 structure-integrity，
        // 是 4.43 截断/表名混表头带病成稿的直接缺口；防块级无限重试由 blockMaxAttempts=2 上限保证）
        const titleNormalizedBlock = normalizeTableTitleInHeaders(withBlockShell, input.chapter.tablePlans);
        if (titleNormalizedBlock.normalized > 0) {
          withBlockShell = titleNormalizedBlock.markdown;
          if (input.diagnostics) input.diagnostics.llm.lastInfo = `块表格表题归一：${block.title}（${titleNormalizedBlock.normalized} 处表名混入表头）`;
        }
        const structureCleaned = cleanStructureDefects(withBlockShell);
        if (structureCleaned.cleaned.length > 0) {
          withBlockShell = structureCleaned.markdown;
          if (input.diagnostics) input.diagnostics.llm.lastInfo = `块结构确定性清理：${block.title}（${structureCleaned.cleaned.length} 项）`;
        }
        const blockStructureScan = scanStructureDefects(withBlockShell);
        // 4.44：结构 blocking 不再限 attempt 0——与 4.40 超产「任何轮次一律阻断」同契约
        const structureBlocking = blockStructureScan.blocking.length > 0;
        if (structureBlocking) {
          lastStructureFeedback = structureIntegrityFeedback(blockStructureScan, block.title) || '';
          console.error(`[gen][block-qc] 结构完整性阻断 attempt=${attempt}（${blockStructureScan.blocking.length} 处）: ${block.title}: ${blockStructureScan.blocking.slice(0, 3).map(defect => defect.message).join(' / ')}`);
        }
        const chars = documentTextLength(withBlockShell);
        lastChars = chars;
        // P4 落位数值一致性核验：块成稿与证据对账（注入证据=章级共享事实层+块级证据；完整证据池=全章证据）。
        // 只标记不删改：mismatched（同位置不同值）首轮阻断重试、第二轮放行交由后续审查链兜底；unsourced 仅观测
        const numericHaystack = `${sharedFactLayerText}\n${blockEvidence.map(item => item.content).join('\n')}`;
        const numericPoolText = input.evidence.map(item => item.content).join('\n');
        // 方案 2.2 ⑤ 数值执行器（det 登记：block-numeric-reconciliation）：正文数值 vs 证据池对账，
        // 同位置不同值首轮阻断二轮放行（错误数值交由 Reviewer/跨章一致性兜底）
        const numericReconciliation = det('block-numeric-reconciliation', () => reconcileContentNumbers(withBlockShell, numericHaystack, numericPoolText));
        if (numericReconciliation.mismatched.length > 0 && input.diagnostics) {
          input.diagnostics.llm.lastInfo = `数值核验：${block.title} 发现 ${numericReconciliation.mismatched.length} 处疑似错误数值（${numericReconciliation.mismatched.map(item => `${item.found}→${item.expected}`).join('、')}）`;
        }
        // 骨架缺口分级（4.50.x 实战修正）：首轮 >2 阻断重试（骨架大面积缺失说明写作未遵循骨架要求，重试有价值），
        // 末轮（attempt≥1）一律放行——丰乐镇 09-17 实机实证：清单兜底骨架（资料贫瘠项目的清单行名）模型存在
        // 系统性不写，主要施工内容块 3 次尝试缺同 3 个、道路排水与景观分区施工块 2 次缺同 5 个（LLM 调用零失败、
        // failures=0 retries=0，纯质检判定）——全轮硬阻断 = 块死 → 章死 → 整章剔除交付（含已成功块，损失远大于缺口本身）；
        // 缺口 ≤2 任何轮次豁免（历史既有行为）；末轮放行照数值核验「首轮阻断、二轮放行」既有模式，缺失交全卷
        // 修复链 enforceWorkPackageSkeletons 锚点直连补写与终检结构扫描兜底（复核清单不静默）
        if (skeletonMissing.length > 0) {
          const skeletonHoldBack = attempt === 0 && skeletonMissing.length > 2;
          console.error(`[gen][block-qc] 骨架缺口 ${skeletonMissing.length} 个 attempt=${attempt}（${skeletonHoldBack ? '阻断重试' : '放行交修复链'}）: ${block.title}: ${skeletonMissing.join('、')}`);
        }
        const skeletonMissingBlocking = attempt === 0 && skeletonMissing.length > 2 ? skeletonMissing : [];
        // 方案 2.2 ③ 模板化执行器（首轮模式）：套话句占比 >10%（与终检 fillerDensityReport 达标线同源，
        // filler=semantic||vague 同口径）或模糊句式 ≥3 处/块即阻断重试并反馈命中句原文（定向重写）；
        // 二轮放行交终检链兜底（照 numericBlocking 首轮模式）。
        // 扫描失败不阻断写作（检测故障≠内容缺陷，本地模型异常不应杀块）。
        let blockTemplating: BlockTemplatingVerdict | undefined;
        // 上限治理 · 异常不得等于通过：原实现在扫描器抛错时留 undefined ⇒ fillerBlocking 恒 false
        // ⇒ 该块**放行成稿**。这是「做不到就当作做到了」的教科书写法，直接违背「宁缺毋假」：
        // 套话内容在扫描器故障时可整章成稿，且没有任何「本轮未完成质检」的痕迹。
        // 现口径：重试一次；仍失败则**按未通过处理**（该块走重写路径；持续失败则章阻断、
        // 文档明确失败），并把失败原因写进 lastError 供定位。确定性扫描器崩溃属代码缺陷，
        // 让它显性失败远比让它静默放行安全。
        let templatingScanFailure: string | undefined;
        if (attempt === 0) {
          for (let scanTry = 0; scanTry < 2 && blockTemplating === undefined; scanTry += 1) {
            try {
              blockTemplating = await det('block-templating', () => scanBlockTemplating(withBlockShell));
            } catch (error) {
              templatingScanFailure = error instanceof Error ? error.message : String(error);
              console.error(`[gen][block-qc] 模板化扫描第 ${scanTry + 1} 次失败: ${block.title}`, error);
            }
          }
          if (templatingScanFailure && input.diagnostics) {
            input.diagnostics.llm.lastError = `块级模板化质检未完成（按未通过处理）：${block.title} —— ${templatingScanFailure}`;
          }
        }
        const fillerBlocking = attempt === 0 && (templatingScanFailure !== undefined || (blockTemplating !== undefined && templatingBlockingOf(blockTemplating)));
        if (fillerBlocking && blockTemplating) {
          console.error(`[gen][block-qc] 首轮模板化阻断（套话 ${blockTemplating.fillerSentences}/${blockTemplating.totalSentences} 句、占比 ${(blockTemplating.fillerRatio * 100).toFixed(1)}%、模糊 ${blockTemplating.vagueCount} 处）: ${block.title}: ${blockTemplating.fillerDetails.slice(0, 3).join(' / ')}`);
        }
        // 方案 2.2 ② 密度执行器（比例口径 ≥1.5/千字，首轮模式）：材料中仍有未落位参数才构成打回理由
        //（与提示词单源语义一致：材料参数不足时以全部参数落位为准，不得借参数凑数）
        const densityMaterialText = [
          ...blockEvidence.filter(item => blockTokens.some(token => item.content.includes(token))).map(item => item.content),
          ...blockFacts,
        ].join('\n');
        const densityAssessment = det('block-fact-density', () => assessBlockFactDensity(withBlockShell, densityMaterialText));
        const densityBlocking = attempt === 0 && densityAssessment.blocking;
        if (densityBlocking) {
          console.error(`[gen][block-qc] 首轮密度缺口阻断（${densityAssessment.verdict.params}/${densityAssessment.verdict.required} 参数，材料 ${densityAssessment.materialParams} 个）: ${block.title}`);
        }
        // 方案 2.2 ④ 归因量化执行器（重难点类章，首轮模式）：条目双达标率 <50% 阻断（与终检
        // difficultyCountermeasureReport 同源、同验收线）；非重难点章不启用（质量/安全章执行器按 S3 扩展）
        const attributionApplicable = requiresAttributionQuantification(`${input.chapter.title} ${block.title}`);
        let attributionVerdict: AttributionQuantificationVerdict | undefined;
        let attributionScanFailure: string | undefined;
        if (attempt === 0 && attributionApplicable) {
          for (let scanTry = 0; scanTry < 2 && attributionVerdict === undefined; scanTry += 1) {
            try {
              attributionVerdict = await det('block-attribution-quantification', () => scanAttributionQuantification(withBlockShell));
            } catch (error) {
              attributionScanFailure = error instanceof Error ? error.message : String(error);
              console.error(`[gen][block-qc] 归因量化扫描第 ${scanTry + 1} 次失败: ${block.title}`, error);
            }
          }
          if (attributionScanFailure && input.diagnostics) {
            input.diagnostics.llm.lastError = `块级归因量化质检未完成（按未通过处理）：${block.title} —— ${attributionScanFailure}`;
          }
        }
        const attributionBlocking = attempt === 0 && (attributionScanFailure !== undefined || (attributionVerdict !== undefined && attributionBlockingOf(attributionVerdict)));
        if (attributionBlocking && attributionVerdict) {
          console.error(`[gen][block-qc] 首轮归因量化阻断（双达标率 ${(attributionVerdict.bothRatio * 100).toFixed(0)}%，${attributionVerdict.entries} 条目）: ${block.title}`);
        }
        // 方案 2.2 ⑥ 格式执行器（首轮模式）：后台/兜底话术命中即阻断（词表与终检 formalTextGateIssues 同源）
        const formatHits = det('block-format-constraints', () => backstageFallbackHits(withBlockShell));
        const formatBlocking = attempt === 0 && formatHits.length > 0;
        if (formatBlocking) {
          console.error(`[gen][block-qc] 首轮格式硬约束阻断（后台话术 ${formatHits.length} 行）: ${block.title}: ${formatHits.slice(0, 2).join(' / ')}`);
        }
        // 方案 2.2 ① 结构执行器（det 登记：block-structure-contract）：契约小节全覆盖、清单外标题
        //（发明编号/串章标题）判定。要点标题缺失判定归一化包含匹配（与骨架/清单外同口径）——模型微调要点标题
        // （如“主要分部分项施工方案”中间加“工程”、编号格式变化）时精确子串匹配会误判缺失 → 重试耗尽；
        // 按行归一化比较（行内提及要点标题即视为覆盖，保留对自然成文形态的宽容）；归一化行池预计算一次，
        // 块质检每轮 attempt 都跑，避免行级正则重复展开
        const { missing, duplicates, extraneous } = det('block-structure-contract', () => {
          const normalizedLines = withBlockShell.split('\n').map(line => normalizeSubsectionTitleForDedup(line)).filter(Boolean);
          const sectionTitlesMissing = sectionTitles.filter(title => {
            const normalizedTitle = normalizeSubsectionTitleForDedup(title);
            if (!normalizedTitle) return false;
            return !normalizedLines.some(line => line.includes(normalizedTitle));
          });
          return {
            missing: [...sectionTitlesMissing, ...skeletonMissingBlocking.map(title => `工作包小节：${title}`)],
            // 同 H3 内同名 H4 重复展开同样视为质检不达标（实测一轮输出三轮相同改造项/危大工程三连），阻断重复进入二轮后处理
            duplicates: findDuplicateH4Titles(withBlockShell),
            // 4.19 清单外标题（串章骨架/自由发挥）视为质检不达标：H3 只允许块标题、H4 只允许本块要点标题；
            // 本块要点承载的评分细目原标题（sources）入白名单——单要点块模型按证据写出细目原标题 H4 属内容归位，
            // 不算清单外（第七次回归实证：块「项目理解与编制边界」输出「#### 编制说明与工程概况」被误杀 → 章失败）
            extraneous: findExtraneousBlockTitles(withBlockShell, block.title, sectionTitles, [...otherBlockTitleSet], [...block.subPoints.flatMap(point => point.sources), ...blockSkeletonNames]),
          };
        });
        // 4.55.22 工作包节结构/要素门禁（首轮模式）：sectionStructureIssue 单源复用——逐工作包校验
        // 「作业对象与工程量/工序顺序/施工方法」三要素、方法段强弱、工序顺序表达、脏事实与流程污染，
        // 命中即首轮阻断并把缺陷原文交给二轮定向反馈；末轮放行交终检链（construction-org-major-content /
        // construction-org-division-section 检测器 + content-depth-repair 补写轮，与 numeric/filler/density
        // 同契约：块级只做一次定向重写，不新增终局失败面）。适用面判定见 writeBlock 顶部的
        // workPackageElementGateApplies（H4 契约与门禁计数口径一致、容器块除外）。
        const sectionElementIssue = workPackageElementGateApplies ? sectionStructureIssue(block.title, withBlockShell) : '';
        const elementBlocking = attempt === 0 && sectionElementIssue !== '';
        if (elementBlocking) {
          console.error(`[gen][block-qc] 首轮工作包结构/要素门禁阻断: ${block.title}: ${sectionElementIssue}`);
        }
        // 4.40 块写作字数双向硬合同 = [0.85,1.15]×块目标（4.51 末轮容差 1.2×；详见下方字数判定段的完整口径）
        // G 线 P1-2：取消「二轮放行」——与证据冲突的数值一律阻断该块（首轮阻断重试带正确值；
        // 重试后仍冲突则该块失败，不再放行）。
        // 原注释称「错误数值交由下游 Reviewer/跨章一致性审查兜底」，但**下游并不存在能兜住它的校验**：
        // 引用一致性判定（integratedBlueprint/citation.ts）只覆盖 4 类权威域
        // （labor-peak / total-days / village-count / quantity），而蓝图 derive.ts 推导出的其余
        // 10 类（里程碑工期 / 机械台数 / 材料计划量 / 土方平衡 / 临水临电 / 检验批次 / 临时用地 /
        // 试验仪器 / 规格权威 / 施工部署）没有任何正文级核对。
        // 于是「把有权威的数值写错」恰好落在「二轮放行 + 下游不覆盖」的交集里，可以零拦截交付。
        const numericBlocking = numericReconciliation.mismatched.length > 0;
        // WS3 首轮工序表达形式核验：块内已有工序顺序表达但形式与指定不符时首轮阻断重试（照 numericBlocking
        // 首轮模式：二轮放行交终检 flowFormRepeatIssues + 修复轮兜底）；完全无工序表达不在此阻断——
        // 由分部分项质量规则的三要素检查承担（避免两处阻断口径打架）
        const expectedFlowForm = keySectionKind && !isDivisionChapterContainer ? flowFormForBlockIndex(index) : undefined;
        const actualFlowForm = expectedFlowForm ? primaryFlowForm(withBlockShell) : undefined;
        const flowFormBlocking = attempt === 0 && expectedFlowForm !== undefined && actualFlowForm !== undefined && actualFlowForm !== expectedFlowForm;
        // 4.40 块写作字数双向硬合同（根治超产：旧 4.35「接受区 [0.7,1.4] 放行」使超产 40% 也可成稿，
        // 全章块级超产叠加即文档级篇幅膨胀的失守环节；旧「二轮一律放行」使超产零拦截）：
        //  - 达标区 [0.85,1.15]：直通；
        //  - 欠产侧 [0.7,0.85)：记录放行（规划层已把块预算校准到模型自然输出区间，微缺口重写
        //    收敛期望为负）；<0.7 仅首轮（attempt 0）阻断补足重写一次，二轮仍欠产放行交终检链兜底
        //    （照 numericBlocking「首轮阻断、二轮放行」成熟模式）；
        //  - 超产侧 >1.15：前轮（attempt 0）一律阻断携压缩指令重写；4.51 末轮容差（r28 实机修正）：
        //    压缩反馈（目标 0.8~0.95×）下模型收敛不完全（机械块二轮 2141 字=1.19×、概况块二轮
        //    1496 字仅超合同线 1 字均仍被阻断）——「末轮仍超产 → 块失败」在单块章上放大为整章阻断、
        //    文档缺章，损失远大于微超产本身；末轮放宽到 1.2× 容差线内接受（记录观测，交终检链复核），
        //    仍 >1.2× 才判块失败（上层隔离重写，仍失败即章阻断、文档显式失败：严重超产零降级、
        //    宁缺毋假不变）。1.2× 与章级超产审计线（stageChapterLoop 章完成率 >1.2× 告警）及文档级
        //    阻断线（目标总额 +20%）分层对齐：块容差只吸收末轮抖动，累计放大由章/文档级观测兜底。
        //    C7 补链：隔离重写耗尽后，失守块全部仅篇幅超产且章总量 ∈[0.85,1.2]×块预算合计时，
        //    由 stageChapterLoop 章级对冲接纳（salvageChapterByOverProduceAcceptance）——块容差吸收
        //    末轮抖动、章级接纳吸收累计抖动、文档级观测兜底，三层链闭合。
        const overProduceLine = Math.ceil(block.targetWords * 1.15);
        // 4.51 末轮容差线：仅最后一轮生效（前轮仍 1.15× 全阻断，压缩收敛方向不变）
        const overProduceToleranceLine = Math.ceil(block.targetWords * 1.2);
        const effectiveOverLine = attempt === blockMaxAttempts - 1 ? overProduceToleranceLine : overProduceLine;
        // 欠产硬门线 = 比例线（0.7×块目标）与关键小节绝对深度门槛的严格者（4.55.22：绝对门槛并行追加）
        const underProduceBlocking = attempt === 0 && chars < underProduceLine;
        const overProduceBlocking = chars > effectiveOverLine;
        // 关键小节绝对深度门槛阻断（仅首轮）：比例线内但未达绝对门槛（如块目标 2600 的关键小节
        // 首轮 1500 字）——与欠产线同族，仅触发二轮定向补足反馈，不改变末轮验收口径
        const criticalDepthBlocking = attempt === 0 && criticalDepthFloor > 0 && chars < criticalDepthFloor;
        if (underProduceBlocking || overProduceBlocking) {
          console.error(`[gen][block-qc] 篇幅失守阻断 attempt=${attempt}（${chars} 字 vs 块目标 ${block.targetWords} 字，欠产线 <${underProduceLine}${criticalDepthFloor > 0 ? `（含关键小节深度门槛 ${criticalDepthFloor}）` : ''} / 超产线 >${effectiveOverLine}）${attempt > 0 && overProduceBlocking ? '［二轮仍超产 → 块失败］' : ''}: ${block.title}`);
        } else if (chars > overProduceLine) {
          // 4.51 末轮容差放行观测（仅末轮可达：前轮超合同线即入上方阻断分支）
          console.error(`[gen][block-qc] 篇幅超产末轮容差放行（${chars} 字 vs 块目标 ${block.targetWords} 字，合同超产线 ${overProduceLine} / 容差线 ${overProduceToleranceLine}）: ${block.title}`);
          if (input.diagnostics) input.diagnostics.llm.lastInfo = `块篇幅超产末轮容差放行：${block.title}（${chars} 字，合同超产线 ${overProduceLine} / 容差线 ${overProduceToleranceLine}）`;
        } else if (chars < Math.floor(block.targetWords * 0.85)) {
          console.error(`[gen][block-qc] 篇幅欠产接受区放行（${chars} 字 vs 块目标 ${block.targetWords} 字，达标区 ${Math.floor(block.targetWords * 0.85)}~${Math.ceil(block.targetWords * 1.15)}）: ${block.title}`);
        }
        if (criticalDepthBlocking) {
          console.error(`[gen][block-qc] 关键小节深度门槛阻断 attempt=${attempt}（${chars} 字 vs 绝对门槛 ${criticalDepthFloor} 字，块目标 ${block.targetWords} 字）: ${block.title}`);
        }
        if (!underProduceBlocking && !overProduceBlocking && !criticalDepthBlocking && !elementBlocking && missing.length === 0 && duplicates.length === 0 && extraneous.length === 0 && !numericBlocking && !flowFormBlocking && !fillerBlocking && !structureBlocking && !densityBlocking && !attributionBlocking && !formatBlocking) {
          return withBlockShell;
        }
        lastMissing = missing;
        lastDuplicates = duplicates;
        lastExtraneous = extraneous;
        sawQcDefect = true;
        // P5 重写保护：数值核验反馈存入下一轮 feedback（错误修正 + 正确保留清单）
        lastNumericFeedback = renderNumericFeedback(numericReconciliation);
        // WS3 工序表达形式反馈：指定形式未落地（含未见明确表达）时定向提示二轮重写
        lastFlowFeedback = expectedFlowForm !== undefined && actualFlowForm !== expectedFlowForm
          ? `【上一轮工序表达形式不符】本块指定的工序顺序表达形式为「${expectedFlowForm}」，上一轮正文${actualFlowForm ? `使用了「${actualFlowForm}」形式` : '未见明确的工序顺序表达'}。必须改用「${expectedFlowForm}」形式重写工序顺序表达，内容与数值保持不变。`
          : '';
        lastFillerFeedback = fillerBlocking && blockTemplating
          ? `【上一轮空话套话句】以下句子是空泛口号（无责任岗位、量化标准、检查频次等可核查信息）：${blockTemplating.fillerDetails.map(sentence => `“${sentence}”`).join('、')}。必须删除或改写为“责任岗位 + 执行动作 + 量化标准 + 检查频次 + 整改时限”式具体措施，并嵌入本节项目事实（不得编造数值）。`
          : '';
        // 方案 2.2 执行器反馈（首轮阻断定向重写）：密度缺口/归因量化/格式硬约束
        lastDensityFeedback = densityBlocking
          ? `【上一轮量化参数密度不足】本节 ${densityAssessment.verdict.chars} 字仅落位 ${densityAssessment.verdict.params} 个不同量化参数（要求 ≥${densityAssessment.verdict.required} 个，约 ${BLOCK_FACT_DENSITY_PER1000} 个/千字），材料中仍有未落位参数。必须从本节材料事实/证据中选取适用参数自然写入对应部位与工序（同一参数不得反复堆砌，不得从行业惯例或相邻章节借参数，不得编造）。`
          : '';
        lastAttributionFeedback = attributionBlocking && attributionVerdict
          ? `【上一轮归因量化不达标】以下条目缺少“成因归因链”或“量化控制目标”的完整表达：${attributionVerdict.missing.map(item => `“${item.text.slice(0, 60)}”`).join('、')}。必须逐条补齐：先写难点/特点成因分析（为什么难），再写可核查的量化目标与控制措施（数值/指标），不得只写口号式措施。`
          : '';
        lastFormatFeedback = formatBlocking
          ? `【上一轮后台/兜底话术】以下句子属于后台处理话术（不得出现在正式正文）：${formatHits.map(line => `“${line.slice(0, 60)}”`).join('、')}。必须删除或改写为正式表述——用绑定资料中的明确事实替换“待确认/不适用/以招标文件为准”类表述；确实无资料支撑的内容直接删除该句，不得保留任何后台痕迹。`
          : '';
        // 4.43 超产压缩反馈（上限语义 + 压缩目标下压到真实目标 0.8~0.95x）：压缩任务模型执行偏差
        // ~1.3x（V9 实测），目标给到窗口下沿保证压缩后落回 [0.7,1.15]×真实目标；保 H4 标题与关键数值
        lastOverProduceFeedback = overProduceBlocking
          ? `【上一轮篇幅超限】当前输出 ${chars} 字，超出本节篇幅上限 ${Math.ceil(block.targetWords * 1.15)} 字（目标 ${block.targetWords} 字）。必须压缩重写：同类工序/措施合并叙述，相同内容只完整表述一次，删除重复铺陈与并列复述；保留全部 H4 标题与关键数值，把总字数压缩到 ${Math.floor(block.targetWords * 0.8)}~${Math.floor(block.targetWords * 0.95)} 字。`
          : '';
        // 4.55.22 关键小节绝对深度门槛反馈（首轮阻断定向重写）：带缺口数字与三要素展开要求
        //（只报"不少于目标字数"不报缺口的反馈收敛无效——见上方 A22 注释）
        lastDepthFeedback = criticalDepthBlocking
          ? `【上一轮关键小节深度不足】本节「${block.title}」为关键小节，首轮正文仅 ${chars} 字，低于绝对深度门槛 ${criticalDepthFloor} 字（篇幅下限 ${charFloor} 字，块目标 ${block.targetWords} 字）。必须逐点补足至 ${charFloor}~${Math.ceil(block.targetWords * 1.15)} 字：每个要点按「作业对象与工程量、工序顺序、施工方法」三方面要素展开，落到具体部位/规模、工序环节与工艺参数、验收检测与资料闭环上；材料中已确认的事实优先落位，不得编造数值，不得以空泛表述凑数。`
          : '';
        // 4.55.22 工作包结构/要素门禁反馈（首轮阻断定向重写）：缺陷原文 + 逐包补齐三要素要求
        lastElementFeedback = elementBlocking
          ? `【上一轮工作包结构/要素未达门禁】${sectionElementIssue}。必须按上面给定的小节/要点清单逐包展开，每个工作包正文覆盖「作业对象与工程量（部位、规模、工程量）、工序顺序（先后顺序清晰）、施工方法（工具机具、工艺参数、验收检测与记录闭环）」三方面要素并融入连贯散文叙述；不得以“施工概况/施工流程/施工方法”等结构标签充当小节标题或段落开头，不得以表格替代工作包正文，不得混入项目概况、招标范围、未尽事宜、资格审查等非本节事实；标题必须与清单完全一致，不得新增清单外标题，也不得为凑数重复同一工作包。`
          : '';
        // 4.12.17 确定性清洗兜底（每一轮不达标都先试）：同 H3 重复 H4 去重 + 清单外标题块删除后重检字数，
        // 结构性重复/清单外骨架由代码兜底，避免内容合格的块整块作废 → 整章降级 → 字数雪崩。
        // 第五次回归实证：首轮仅因清单外 H4（模型自由发挥/标题微调）不达标（4083 字达标块仍失败），
        // 首轮兜底删后字数达标即通过；二轮同样兜底（原只 attempt===1，二轮删后字数不足 → 块死亡 → 章失败）。
        // V2 批1：结构缺陷阻断时禁用本修复通道（任何轮次——否则未修复的截断/空节会被字数达标直接放行，破坏重试）
        // 方案 2.2 执行器同步排除：内容质量阻断（数值/模板化/密度/归因/格式/工作包要素）不得被标题层修复
        // 通道放行——修复动作（去重/剥标题）不解决内容质量问题，放行会架空「写作时阻断」
        //（照 V2 批1 structureBlocking 先例；工作包要素门禁为 attempt 0 条件，故其排除同样只作用于首轮）
        // 4.55.22：`criticalDepthBlocking` 必须与 elementBlocking 同列——它是**内容质量阻断**
        //（篇幅深度不足），标题层修复（去重/剥标题）不解决内容量问题。原实现漏列 → 深度不足的块
        // 经标题清洗后由本通道**直接放行**（且首轮即放行，因 repairedUnderProduce 按比例线判、
        // 而绝对门槛当时被折进了比例线才侥幸未暴露），深度门因此被架空。
        if (missing.length === 0 && !structureBlocking && !numericBlocking && !fillerBlocking && !densityBlocking && !attributionBlocking && !formatBlocking && !elementBlocking && !criticalDepthBlocking) {
          // 4.19.1 确定性修复优先：先同 H3 重复 H4 去重，再清单外标题行剥离（正文零丢失），
          // 修复后字数达标即通过——标题层问题由代码确定性修复，不因整块删除掉档触发重试/失败
          const repaired = stripExtraneousBlockHeadings(dedupeRepeatedSubsections(withBlockShell), block.title, sectionTitles, [...block.subPoints.flatMap(point => point.sources)]);
          const repairedChars = documentTextLength(repaired);
          // 字数合同同步复核（4.40 双向硬合同 + 4.51 末轮容差）：修复只会减字数（标题剥离会掉档）——
          // 修复后仍超产（前轮 >1.15× / 末轮 >1.2× 容差线，与直通路径同一口径）不得经本通道放行；
          // 欠产侧低于欠产硬门线（比例线 0.7× 与关键小节绝对深度门槛取严）仅首轮不放行、二轮放行
          //（与直通路径同一口径）
          const repairedOverProduce = repairedChars > effectiveOverLine;
          const repairedUnderProduce = repairedChars < underProduceLine;
          if (!repairedOverProduce && (attempt > 0 || !repairedUnderProduce)) {
            if (input.diagnostics && (extraneous.length > 0 || duplicates.length > 0)) input.diagnostics.llm.lastInfo = `块标题层已确定性修复：${block.title}（清单外 ${extraneous.length} 个、重复 H4 ${duplicates.length} 个；${chars}→${repairedChars} 字）`;
            return repaired;
          }
        }
        // C7 章级超产对冲接纳痕迹收集：记录本块最近一次有效尝试原文与失败类别清单（每轮覆盖，
        // 最终留末轮或最近一次有效尝试）——隔离重写仍失败时，上层在全链条件满足（失守块全部仅
        // 篇幅超产 + 填回后章总量 ∈ [0.85,1.2]×块预算合计）时可对冲接纳末轮内容成章；
        // 结构/数值/密度/套话/归因/格式等任何内容类缺陷混入即拒绝（零静默降级：非篇幅类失守照旧章阻断）
        blockLastAttempts.set(index, withBlockShell);
        blockFailureKinds.set(index, [
          ...(overProduceBlocking ? ['over-produce'] : []),
          ...(underProduceBlocking ? ['under-produce'] : []),
          // 4.55.22：`criticalDepthBlocking` 与 `elementBlocking` **仅首轮生效**（attempt===0），
          // 不是末轮失败原因，**不进 failureKinds**——否则会与 'over-produce' 组成双元素，
          // 使章级超产对冲接纳（要求 kinds 恰为 ['over-produce']）拒收本可交付的块，
          // 制造与用户实测同族的整章阻断。二者仍进下方诊断消息与 console.error。
          ...(missing.length > 0 || duplicates.length > 0 || extraneous.length > 0 ? ['structure-titles'] : []),
          ...(structureBlocking ? ['structure-integrity'] : []),
          // （elementBlocking 同理：仅首轮生效，不进终态失败类别）
          ...(numericBlocking ? ['numeric'] : []),
          ...(flowFormBlocking ? ['flow-form'] : []),
          ...(fillerBlocking ? ['templating'] : []),
          ...(densityBlocking ? ['density'] : []),
          ...(attributionBlocking ? ['attribution'] : []),
          ...(formatBlocking ? ['format'] : []),
        ]);
        if (input.diagnostics) input.diagnostics.llm.lastError = `规划块质检未达标：${block.title}（${chars} 字，缺 ${missing.join('、') || '无'}${duplicates.length ? `，重复 H4 ${duplicates.join('、')}` : ''}${extraneous.length ? `，清单外 ${extraneous.slice(0, 5).join('、')}${extraneous.length > 5 ? ' 等' : ''}` : ''}${criticalDepthBlocking ? `，关键小节深度不足 ${chars}/${criticalDepthFloor} 字` : ''}${elementBlocking ? `，工作包结构/要素门禁 ${sectionElementIssue}` : ''}${blockStructureScan.blocking.length ? `，结构缺陷 ${blockStructureScan.blocking.length} 处` : ''}${densityBlocking ? `，密度缺口 ${densityAssessment.verdict.params}/${densityAssessment.verdict.required}` : ''}${attributionBlocking && attributionVerdict ? `，归因量化 ${(attributionVerdict.bothRatio * 100).toFixed(0)}%` : ''}${formatBlocking ? `，后台话术 ${formatHits.length} 行` : ''}）`;
        // 章失败归因诊断日志：块级质检不达标详情落盘（轮3 实测“重点难点/新技术”两章两次尝试仍未成稿，
        // failures=0 表示 LLM 正常返回但质检不过，必须拿到具体不达标项才能定向修复）
        console.error(`[gen][block-qc] 块质检不达标 attempt=${attempt}: ${block.title}（目标 ${block.targetWords} 字，实际 ${chars} 字，缺 ${missing.join('、') || '无'}，重复 ${duplicates.join('、') || '无'}，清单外 ${extraneous.join('、') || '无'}，结构缺陷 ${blockStructureScan.blocking.length} 处，关键小节深度 ${criticalDepthBlocking ? `${chars}<${criticalDepthFloor}` : '达标/不适用'}，工作包要素门禁 ${elementBlocking ? sectionElementIssue : '通过/不适用'}，密度缺口 ${densityBlocking ? '是' : '否'}，归因量化 ${attributionBlocking ? '不达标' : '达标'}，后台话术 ${formatBlocking ? '有' : '无'}，keySection=${keySectionKind || 'none'}）`);
      } catch (error) {
        if (input.diagnostics) input.diagnostics.llm.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    // C3 隔离重写反馈收集：质检判定出现过缺陷才携带（纯异常失败不套"质检未通过"话术）
    if (sawQcDefect) blockRetryFeedbacks.set(index, buildBlockDefectFeedback(false));
    // （原「自愈拆半 + salvage 逐点兜底」已删除：拆半在写作层之后改结构——半块重设预算使父块合同失效，
    //  与写作、检测、修复三方口径互相冲突；容量规划已在规划层一次成型保证块预算可写性。
    //  块两次尝试仍越出字数合同 → 块失败 → 上层隔离重试 → 仍失败即章阻断、文档显式失败：零降级，宁缺毋假）
    return undefined;
  };
  const runBlock = async (block: (typeof blocks)[number], index: number): Promise<void> => {
    results[index] = await writeBlock(block, index);
    // p3-s3 块级 checkpoint：块成稿完成即上报（partialSections 按 index 序保留已完成块），供 documentGenerator 节流写盘快照，中断续跑不重生成
    if (results[index]) input.onSectionProgress?.({ completed: results.filter(Boolean).length, total: blocks.length, sectionTitle: block.title, phase: 'complete', partialSections: [...results] });
  };
  // F5 缓存预热：首个块单独执行，先建立 L0-L2 共享前缀缓存（DeepSeek prefix cache 写入存在秒级延迟），
  // 后续块并发发出时即可命中共享前缀；历史全并发方案下同章各块同时发出、互相无法命中彼此前缀，
  // 是命中率低的成因之一。首块失败不阻断后续块（失败块由 C3 隔离重试闭环处理）
  if (blocks.length > 0) {
    throwIfAborted(input.signal);
    await runBlock(blocks[0], 0);
  }
  for (let offset = 1; offset < blocks.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batch = blocks.slice(offset, offset + concurrency);
    await Promise.all(batch.map((block, index) => runBlock(block, offset + index)));
  }
  // C3 全失败也返回隔离清单（历史缺陷：全块失败早退返回 undefined → stageChapterLoop 的
  // plannedFirst 为 falsy → C3 块级隔离重试被整体跳过 → 章直接阻断；4.44 丰乐镇实机实测：
  // 工期章 2 块全失败因此失去隔离重写机会——失败块清单照常返回，由上层决定隔离重写或章阻断）
  const failedBlocks = blocks
    .map((block, index) => ({ index, block, retryFeedback: blockRetryFeedbacks.get(index), lastAttempt: blockLastAttempts.get(index), failureKinds: blockFailureKinds.get(index) }))
    .filter(({ index }) => !results[index]);
  // 相邻同标题块 H3 外壳合并（防御性）：容量规划归并保序拼接时若相邻块标题归一化同名，
  // 剥离后块开头的同标题 H3（内容续接同一小节），目录不出现重复小节
  const mergedSections: string[] = [];
  let previousTitle: string | undefined;
  for (let index = 0; index < blocks.length; index += 1) {
    const part = results[index];
    if (!part) { previousTitle = undefined; continue; }
    const normalizedTitle = normalizeSubsectionTitleForDedup(blocks[index]!.title);
    if (previousTitle === normalizedTitle && mergedSections.length > 0) {
      mergedSections[mergedSections.length - 1] = `${mergedSections[mergedSections.length - 1]}\n\n${stripLeadingShellTitle(part, normalizedTitle)}`;
    } else {
      mergedSections.push(part);
    }
    previousTitle = normalizedTitle;
  }
  const markdown = sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${mergedSections.join('\n\n')}`, input.forbidDrawingImages));
  if (failedBlocks.length === 0) return { sections: results, failedBlocks, allSucceeded: true, markdown };
  // C3 块级失败隔离：部分块失败时返回已成功块与失败块清单，由上层只重试失败块，不再整章降级
  if (input.diagnostics && failedBlocks.length > 0) {
    input.diagnostics.llm.lastError = `规划块${failedBlocks.length === blocks.length ? '全部' : '部分'}失败：${failedBlocks.map(({ block }) => block.title).join('、')}`;
  }
  return { sections: results, failedBlocks, allSucceeded: false, markdown };
}
