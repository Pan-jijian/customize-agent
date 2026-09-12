import * as path from 'node:path';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentDraftChapter, DocumentEvidence, DocumentFact, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ResolvedFactNeed, SpecAuthorityMap, ValidationIssue } from './types';
import { documentTextLength } from './budget';
import { buildChapterEvidencePool, buildEvidenceBundle, cleanEvidenceText, evidenceBundlePrompt, evidencePromptBudgetForTarget, extractKeyFactLines } from './evidence';
import { extractNumericTokens, reconcileContentNumbers, renderNumericFeedback } from './numericalConsistency';
import { FORMAL_WRITING_RULES, SECTION_GENERATION_SAFETY_RULES, docSystemPrefix, removeUnwantedDrawingImages, sanitizeFormalMarkdown, writerSystemPrefix } from './markdownComposer';
import { callDocumentLlm, callDocumentLlmJson, contextLayerChars, getDocumentLlmMaxConcurrency } from './llmClient';
import { dedupeRepeatedSubsections, findDuplicateH4Titles, findExtraneousBlockTitles, normalizeSubsectionTitleForDedup, stringifyFactValue, stripExtraneousBlockHeadings, throwIfAborted, workPackageElementsMeetLenientGate } from './utils';
import { measureGenerationStep } from './rolePipeline';
import { normalizePlannedSections, professionalSectionTaskCard } from './promptRuleExtraction';
import { tablePlansPrompt, unassignedSectionTablePlans } from './constructionOrgTablePlan';
import { constructionOrgBonusModulePrompt, constructionOrgChapterRulePrompt } from './constructionOrgQualityRules';
import { buildProcessKnowledgePrompt, matchProcessKnowledgeCards } from './constructionProcessKnowledge';
import { criticalSectionBlockerMinChars, currentSectionBlock, ensureGroupTertiaryShell, ensureTertiarySectionShell, isCriticalDeepSection, majorContentPollutionIssue, matchBlockSkeletonNames, mergeDuplicateWorkPackageSubsections, parseMajorConstructionPackages, sectionContentBody, sectionStructureIssue, stripMarkdownTableBlocks, workPackageCrossSectionIssue, workPackageSkeletonPrompt, workPackageSkeletonTitles } from './chapterPostProcessing';
import { HAS_QUANTIFIED_VALUE_RE, PRECISE_TOKEN_RE, QUANTIFIED_FACT_RE } from './parameterPatterns';
import { buildSemanticGate } from './semanticGate';
import type { PlannedChapterBlock, PlannedChapterStructure } from './integratedBlueprint';
import { cleanFactValue, isActionableFactValue } from './documentFactTrace';
import { DIVISION_SECTION_RE, MAJOR_CONTENT_SECTION_RE, chapterAnchoredRules, sectionAnchoredRules } from './writingSpec';
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

function extractChapterPreciseTokens(evidence: DocumentEvidence[]) {
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
    input.factNeedsPrompt || '',
    indexedFactLines.length ? `全局资料事实索引匹配到的本章可写事实：\n${indexedFactLines.join('\n')}` : '',
    specAuthorityLines.length ? `本章材料规格-部位对照表（同一材料的多种规格必须按所属部位/分部分项分别使用，禁止全文统一为一种规格；对照关系以工程量清单为准，写错部位视同数据错误）：\n${specAuthorityLines.join('\n')}` : '',
    preciseTokens.length ? `本章资料中可直接使用的可靠精确参数/编号：${preciseTokens.join('、')}。这些参数来自绑定资料，不属于编造；涉及对应对象、部位、工序、材料、设备、项目概况、质量验收或安全控制时必须自然写入正文，并保持原样或等价专业表达。量化参数落位是硬性验收项：本章正文必须达到每千字不少于 2 个不同量化参数的密度（以上方清单参数优先），同一参数不得反复堆砌凑数；当本章绑定材料可落位参数不足 2 个/千字时，以材料全部参数落位为准，不得从行业惯例或相邻章节借参数凑数——参数不足仅在「材料中仍有未落位参数」时构成打回理由。项目基础事实中的合同估算价、计划工期可用于项目概况；不得写入报价明细、单价、税率、预留金。` : '',
    unresolvedNeeds.length ? `当前事实需求仍未充分确认：${unresolvedNeeds.join('、')}。未确认项不得编造；但已满足事实需求中的资料事实必须写入对应小节。` : '',
    input.missingFacts.length ? `模板显式要求中当前检索未充分命中的项：${input.missingFacts.join('、')}。未命中项不得编造，但不得因此省略上方已经明确的可靠参数。` : '',
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
 * 前端段（事实要求/角色事实/基础事实卡片）天然优先保留；factCoverageCap（DOCUMENT_TUNING_PROFILE）可调，0 关闭封顶。
 * 被截断的事实索引仍存在于绑定材料证据中（evidenceText 按块相关性注入），不影响事实落位兜底。
 */
export function capFactCoverageContext(text: string): string {
  const configured = tuningProfile().factCoverageCap;
  // factCoverageCap=0 显式关闭封顶（全量注入）；未配置或非法值走默认预算 26000
  if (configured === 0) return text;
  const cap = Number.isFinite(configured) && configured! > 0 ? Math.floor(configured!) : 26000;
  if (!text || text.length <= cap) return text;
  const kept: string[] = [];
  let total = 0;
  for (const line of text.split('\n')) {
    if (total + line.length + 1 > cap) break;
    kept.push(line);
    total += line.length + 1;
  }
  return `${kept.join('\n')}\n（本章事实索引过长已截断，其余事实见绑定材料与证据，正文以材料为准）`;
}

/** 两步生成第一步产出的事实大纲 */
interface ChapterFactOutline {
  sections: Array<{ title?: string; facts?: string[]; quantifiedFacts?: string[]; missingFacts?: string[] }>;
}

/** 两步生成（事实大纲 → 写作）第一步（P2 归类替代提炼）：绑定材料先经确定性事实行提取（extractKeyFactLines），
 * LLM 只做「事实行编号 → 小节」的归类决策，不做内容提炼——事实行文本全程不走 LLM，
 * 从源头消除转述失真（抄错数值/合并规格/幻觉事实）。JSON 解析失败反馈后重试一次；
 * 仍失败返回 undefined 由调用方退化为单步生成（非模板兜底）。 */
async function buildChapterFactOutline(input: { template: DocumentTemplate; chapter: DocumentTemplate['chapters'][number]; sections: string[]; requiredFacts: string[]; missingFacts: string[]; promptTexts: string; factLines: string[]; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics }): Promise<ChapterFactOutline | undefined> {
  const sectionLines = input.sections.length
    ? input.sections.map((section, index) => `${index + 1}. ${section}`).join('\n')
    : '（本章无预设小节，请按材料自然归纳 2-5 个主题作为大纲小节）';
  const factIndexLines = input.factLines.map((fact, index) => `F${index + 1}｜${fact}`).join('\n');
  const system = [
    docSystemPrefix('你是文档事实分配专家。绑定材料已由系统提取出事实行清单（每条均为材料原文、逐字保留）。你的任务是把每条事实分配到最合适的小节，供 Writer 逐条落位。'),
    '只做分配，不改写事实：factIds 必须引用事实行编号，正文写作使用事实行原文；不得转述、合并、拆分或编造事实。',
    'missingFacts 放该小节需要但事实行清单中确实没有的事实（供 Writer 用公共专业知识补做法与要求；补做法时不得引入任何具体数值、规格、型号、品牌、参数，此类内容一律不得出现在 missingFacts 或补做表述中）。',
    '只返回 JSON，不要返回 markdown。',
  ].filter(Boolean).join('\n\n');
  const prompt = [
    // A5a 前缀缓存：可变提示词从 system 移入 user（system 恒定化，跨调用共享 prefix cache）
    input.promptTexts ? `配置写作主控提示词：\n${input.promptTexts}` : '',
    `文档模板：${input.template.name}`,
    // F6 前缀收敛：块路径下「章节标题/预设小节/事实行清单」均为块级变化值（每块一次大纲规划），
    // 章级恒定段（章节目的/事实要求/缺失事实/JSON 指令）前置——同章各块大纲调用共享前缀延续至
    // 「章节标题」处才分叉（历史顺序下章节标题紧随模板名，恒定段全在分叉点后不可共享）
    `章节目的：${input.chapter.purpose}`,
    input.requiredFacts.length ? `模板要求覆盖的事实：${input.requiredFacts.join('、')}` : '',
    input.missingFacts.length ? `当前检索未充分命中的事实（如材料中确实没有，写入对应小节的 missingFacts）：${input.missingFacts.join('、')}` : '',
    '返回 JSON：{"sections":[{"title":"小节名","factIds":["F1","F3"],"missingFacts":["该小节需要但清单缺失的事实"]}]}；factIds 必须是上方清单中的编号，不得编造编号；每条事实只分配给一个小节，不得跨小节重复分配；每条事实都必须分配出去，不得遗漏。',
    // ── 块级变化段起点（同章各块以下内容互不相同；保持其在 prompt 尾部，共享前缀到此为止恒定）──
    `章节标题：${input.chapter.title}`,
    `预设小节：\n${sectionLines}`,
    `事实行清单（编号｜事实原文）：\n${factIndexLines}`,
  ].filter(Boolean).join('\n\n');
  // F6 分层统计：与上方 prompt 组装同源表达式（l0 system 恒定段 / l1 任务级恒定指令 /
  // l2 章级共享段 / l3 块级变化段），供「可缓存前缀 vs 不可缓存变化段」占比验收
  const contextLayers = {
    l0: system.length,
    l1: contextLayerChars([
      input.promptTexts ? `配置写作主控提示词：\n${input.promptTexts}` : '',
    ]),
    l2: contextLayerChars([
      `文档模板：${input.template.name}`,
      `章节目的：${input.chapter.purpose}`,
      input.requiredFacts.length ? `模板要求覆盖的事实：${input.requiredFacts.join('、')}` : '',
      input.missingFacts.length ? `当前检索未充分命中的事实（如材料中确实没有，写入对应小节的 missingFacts）：${input.missingFacts.join('、')}` : '',
      '返回 JSON：{"sections":[{"title":"小节名","factIds":["F1","F3"],"missingFacts":["该小节需要但清单缺失的事实"]}]}；factIds 必须是上方清单中的编号，不得编造编号；每条事实只分配给一个小节，不得跨小节重复分配；每条事实都必须分配出去，不得遗漏。',
    ]),
    l3: contextLayerChars([
      `章节标题：${input.chapter.title}`,
      `预设小节：\n${sectionLines}`,
      `事实行清单（编号｜事实原文）：\n${factIndexLines}`,
    ]),
  };
  const factMap = new Map(input.factLines.map((fact, index) => [`F${index + 1}`, fact]));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await callDocumentLlmJson<{ sections: Array<{ title?: string; factIds?: string[]; missingFacts?: string[] }> }>(system, prompt, { maxTokens: 1600, temperature: 0, signal: input.signal, diagnostics: input.diagnostics, contextLayers, prefixKey: `outline:${input.chapter.id}` });
    if (raw && Array.isArray(raw.sections) && raw.sections.length > 0) {
      // 编号校验：非法编号剔除并观测（LLM 编造编号防御），合法编号映射回事实原文——
      // 下游 renderChapterFactOutline 结构不变，补充检索/重渲染链路零改动
      const invalidIds = new Set<string>();
      const sections = raw.sections.map(section => {
        const facts = (section.factIds || []).filter(id => {
          const valid = factMap.has(id);
          if (!valid) invalidIds.add(id);
          return valid;
        }).map(id => factMap.get(id)!);
        return { title: section.title, facts, missingFacts: section.missingFacts || [] };
      });
      if (invalidIds.size > 0 && input.diagnostics) input.diagnostics.llm.lastInfo = `大纲编号校验：剔除非法编号 ${[...invalidIds].join('、')}`;
      return { sections };
    }
  }
  return undefined;
}

/** P1 大纲-证据数值对账：大纲 fact 条目的数值 token 未在注入证据/完整证据池中命中时剔除——
 * 「不构成编造」的背书只覆盖对账通过的部分；纯叙述 fact（无数值）不做数值对账（避免正则误杀）。 */
function reconcileOutlineFacts(outline: ChapterFactOutline, evidenceText: string, poolText: string, diagnostics?: DocumentGenerationDiagnostics): ChapterFactOutline {
  let removed = 0;
  const keepFact = (fact: string): boolean => {
    const tokens = extractNumericTokens(fact);
    if (tokens.length === 0) return true;
    return tokens.every(token => evidenceText.includes(token) || poolText.includes(token));
  };
  const sections = outline.sections.map(section => {
    const facts = (section.facts || []).filter(fact => {
      const keep = keepFact(fact);
      if (!keep) removed += 1;
      return keep;
    });
    return { ...section, facts };
  });
  if (removed > 0 && diagnostics) diagnostics.llm.lastInfo = `大纲事实对账：剔除 ${removed} 条未在绑定材料中命中的事实（疑似编造）`;
  return { sections };
}

function renderChapterFactOutline(outline: ChapterFactOutline, stillMissingFacts: Set<string>) {
  const blocks = outline.sections.map(section => {
    const facts = [...new Set([...(section.facts || []), ...(section.quantifiedFacts || [])])].filter(Boolean);
    // 仅保留「补充检索后仍缺失」的事实标注缺失（已被覆盖的已在证据池提示中转为落位指令）
    const missing = (section.missingFacts || []).filter(fact => fact && stillMissingFacts.has(fact));
    return [
      `### ${section.title || '正文'}`,
      facts.length ? `必须写入的事实（数值必须原样）：\n${facts.map(fact => `- ${fact}`).join('\n')}` : '',
      missing.length ? `材料缺失（禁止编造具体值；可用公共专业知识补做法与要求，补做法不得引入任何数值/规格/型号/参数）：${missing.join('、')}` : '',
    ].filter(Boolean).join('\n');
  });
  return [
    '【事实大纲——由事实规划阶段生成，写作时必须逐条落位】',
    '大纲事实为绑定材料事实行原文（已通过确定性数值对账），落位不构成编造；数值、单位、标准编号必须与大纲完全一致。',
    ...blocks,
  ].join('\n\n');
}

/** 判断大纲中标记缺失的事实是否被定向补充检索覆盖（保守策略：至少两个有效 token 或一段 6+ 字连续片段命中才认为覆盖，
 * 避免误判导致 Writer 编造数值） */
function factCoveredByEvidence(fact: string, evidence: DocumentEvidence[]): boolean {
  const haystack = evidence.map(item => `${item.sectionTitle || ''}\n${item.content}`).join('\n');
  const tokens = fact.split(/[\s、，,。；;：:（）()【】[\]《》]/u).map(token => token.trim()).filter(token => token.length >= 4);
  if (tokens.length === 0) return false;
  const hitTokens = tokens.filter(token => haystack.includes(token)).length;
  if (hitTokens >= 2) return true;
  const chunks = [...new Set(fact.match(/.{6,}/gu) || [])];
  return chunks.some(chunk => haystack.includes(chunk));
}

/** 使用 LLM 生成单章内容，基于证据包、提示词角色和用户需求 */
export async function buildLlmChapterContent(template: DocumentTemplate, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[], promptTexts: string, projectContext: string, requirement?: string, roleContext = '', options: { forbidDrawingImages?: boolean; minWords?: number; targetWords?: number; maxWords?: number; maxTokens?: number; factCoverageContext?: string; signal?: AbortSignal; userWriterRules?: string; twoStep?: boolean; supplementEvidenceProvider?: (missingFacts: string[]) => Promise<DocumentEvidence[]>; diagnostics?: DocumentGenerationDiagnostics; evidenceFloorChars?: number; evidenceCeilingChars?: number; compactProjectContext?: boolean; scopedProjectContext?: boolean; sharedFactLayerText?: string; evidenceRankBoost?: (item: DocumentEvidence) => number; onlyRankBoosted?: boolean; chapterLevelContext?: string; blueprintDataText?: string; blueprintSliceText?: string; skipT2Catalog?: boolean } = {}) {
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
  let evidenceText = evidenceBundlePrompt(bundle, { maxChars: evidencePromptBudgetForTarget(options.targetWords || options.minWords, options.evidenceFloorChars, options.evidenceCeilingChars), ...evidencePromptOptions });
  // 两步生成（事实大纲 → 写作）：第一步先让 LLM 基于绑定材料规划可写事实清单，
  // 第二步按大纲逐条落位写作，根治「要求具体但证据碎片化导致空话灌水」的不稳定。
  // （原 DOCUMENT_TWO_STEP_GENERATION 回退已固化删除：两步法恒开，options.twoStep 仍可关闭；大纲阶段失败退化为单步生成非模板兜底）
  const twoStepEnabled = options.twoStep !== false && evidence.length >= 3 && evidenceText.length > 0;
  let outlineBlock = '';
  let outline: ChapterFactOutline | undefined;
  let stillMissingFacts = new Set<string>();
  // P0-3 两步瘦身：跟踪当前证据池（P4 定向补充检索会扩充），大纲成功后第二步按降档预算重建证据
  let outlineEvidence = evidence;
  if (twoStepEnabled) {
    // 4.17.6 大纲证据独立构建（P2 归类替代提炼）：事实大纲输入从证据全文改为确定性事实行清单
    // （extractKeyFactLines 提取——数值参数行/项目基础事实行/规范编号行），LLM 只做编号→小节归类，
    // 事实行文本不走 LLM。目录对大纲无消费价值且是逐调用不可缓存变化段——独立小预算（outlineEvidenceChars，
    // DOCUMENT_TUNING_PROFILE 可调，默认 2500 字符）跳过目录，把 outline L3 从 ~16K 压到 ~3K（前缀缓存命中率 90% 目标参数之一）
    const outlineEvidenceCharsValue = tuningProfile().outlineEvidenceChars || 2500;
    const outlineEvidenceChars = Number.isFinite(outlineEvidenceCharsValue) && outlineEvidenceCharsValue > 0 ? Math.floor(outlineEvidenceCharsValue) : 2500;
    const outlineFactPoolText = [...new Set(outlineEvidence.flatMap(item => extractKeyFactLines(item.content).split('\n').filter(Boolean)))].join('\n');
    const outlineFactLines = outlineFactPoolText.length > outlineEvidenceChars ? outlineFactPoolText.slice(0, outlineEvidenceChars).split('\n').filter(Boolean) : outlineFactPoolText.split('\n').filter(Boolean);
    outline = await buildChapterFactOutline({ template, chapter, sections: chapter.sections?.filter(Boolean) || [], requiredFacts: chapter.requiredFacts, missingFacts, promptTexts, factLines: outlineFactLines, signal: options.signal, diagnostics: options.diagnostics });
    if (outline) {
      // P1 大纲-证据数值对账：fact 数值 token 未在注入证据/完整证据池命中即剔除（背只覆盖对账通过部分）
      outline = reconcileOutlineFacts(outline, outlineFactPoolText, outlineEvidence.map(item => item.content).join('\n'), options.diagnostics);
      // P4 硬回路：大纲报告的材料缺失事实 → 定向补充检索 → 命中材料并入证据池后重渲染大纲
      const allOutlinedMissing = [...new Set(outline.sections.flatMap(section => (section.missingFacts || []).filter(Boolean)))];
      const outlinedMissingFacts = allOutlinedMissing;
      if (outlinedMissingFacts.length > 0 && options.supplementEvidenceProvider) {
        const supplements = await options.supplementEvidenceProvider(outlinedMissingFacts).catch(() => []);
        const fresh = supplements.filter(item => !evidence.some(existing => existing.filePath === item.filePath && (existing.sectionTitle || '') === (item.sectionTitle || '')));
        if (fresh.length > 0) {
          const mergedEvidence = [...evidence, ...fresh];
          outlineEvidence = mergedEvidence;
          evidenceText = evidenceBundlePrompt(buildEvidenceBundle(chapter, mergedEvidence), { maxChars: evidencePromptBudgetForTarget(options.targetWords || options.minWords, options.evidenceFloorChars, options.evidenceCeilingChars), ...evidencePromptOptions });
          // 覆盖判断基于合并后证据池：原证据已覆盖的事实不算缺失，避免误标
          stillMissingFacts = new Set(allOutlinedMissing.filter(fact => !factCoveredByEvidence(fact, mergedEvidence)));
          if (stillMissingFacts.size < allOutlinedMissing.length) {
            evidenceText = `${evidenceText}\n\n【定向补充检索】以下大纲缺失事实已找到对应材料并追加在上方，请一并落位：${allOutlinedMissing.filter(fact => !stillMissingFacts.has(fact)).join('、')}`;
          }
        } else {
          stillMissingFacts = new Set(allOutlinedMissing);
        }
      } else {
        stillMissingFacts = new Set(allOutlinedMissing);
      }
      outlineBlock = renderChapterFactOutline(outline, stillMissingFacts);
      // P0-3 两步瘦身：事实大纲已产出可写事实清单（facts + quantifiedFacts），第二步写作只需
      // 大纲事实对应的细节原文；证据预算降为基准的 60%——T0 关键参数层全量保留（零丢失原则），
      // T1 高相关片段缩量，T2 目录索引保留全貌与追溯。两步路径第二步输入与第一步相当，
      // 降档后两步总输入收敛到单步路径水平；（原 DOCUMENT_TWO_STEP_SLIM 回退已固化删除：0.6× 瘦身恒开）
      {
        const slimBudget = Math.floor(evidencePromptBudgetForTarget(options.targetWords || options.minWords, options.evidenceFloorChars, options.evidenceCeilingChars) * 0.6);
        const supplementNote = evidenceText.split('\n\n【定向补充检索】')[1];
        evidenceText = evidenceBundlePrompt(buildEvidenceBundle(chapter, outlineEvidence), { maxChars: slimBudget, ...evidencePromptOptions }) + (supplementNote ? `\n\n【定向补充检索】${supplementNote}` : '');
      }
    }
  }
  const userFactBlock = userRequirementFactsPrompt(requirement);
  // 即使 evidenceText 和 roleContext 为空，也让 LLM 基于 projectContext 和 promptTexts 尝试生成
  const sectionInstruction = chapter.sections?.length
    ? `本章小节由生成前规划得到，请完整包含并展开以下小节：\n${chapter.sections.map(section => `- ${section}`).join('\n')}`
    : '本章没有预设小节；请按用户提示词、模板章节、角色要求和绑定材料自然组织正文。';
  const sectionBudgetInstruction = buildSectionBudgetInstruction(chapter, options.targetWords || options.minWords || 0);
  const tablePlanInstruction = tablePlansPrompt(chapter);
  const constructionOrgRuleInstruction = constructionOrgChapterRulePrompt(chapter);
  const constructionOrgBonusInstruction = constructionOrgBonusModulePrompt(chapter);
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
    writerSystemPrefix(FORMAL_WRITING_RULES),
    options.forbidDrawingImages ? '图片类材料只作为文本事实依据；禁止插入图片或 Markdown 图片语法。' : '',
    // A5a 前缀缓存：可变 promptTexts 已移入 user 首部，system 保持恒定（跨章共享 prefix cache）
  ].filter(Boolean).join('\n\n');
  const prompt = [
    promptTexts ? `配置写作主控提示词：\n${promptTexts}` : '',
    `文档模板：${template.name}`,
    // P5 前缀缓存收敛：章内各块共享的恒定段全部前置（主控提示词/模板/用户要求/项目上下文/通用生成要求），
    // 块级变化段（章节标题、章级指令、角色上下文、字数预算、绑定材料）统一后置——
    // 同章主题块并发成稿时前缀逐块分叉是缓存命中率低的根因之一（实测命中率 29%，仅 system 层命中）
    `章节目的：${chapter.purpose}`,
    requirement ? `用户要求：${requirement}` : '',
    userFactBlock,
    // B2 一体化蓝图参数桶注入 L1：全项目共享一次的恒定段（计划类数值唯一权威源，同章各块值完全相同 → prefix cache 共享命中）
    options.blueprintDataText || '',
    // 章切片注入（章级恒定段，同章各块值相同 → 章内共享前缀）
    options.blueprintSliceText || '',
    // 块级调用必须压缩上下文：planned 块路径按块并发成稿，每块全量注入 projectContext（蓝图+事实主表+图谱映射）
    // 会让单块输入 token 数倍于输出预算，实测单块调用 30~40 分钟（真实性能缺陷：徽光阁 3 章块草稿累计 112 分钟）；
    // 压缩只保留结构化事实行与蓝图约束行，专业叙述由块级证据承载
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
    outlineBlock,
    '请生成可直接导出的 Markdown 章节，要求：',
    '- 内容必须遵循用户提示词、模板章节、提示词角色、项目资料包和自动识别的资料类型；不得编造材料未提供的项目专属事实；任何带数值、工程量、规格、型号、品牌、参数的表述必须逐字来自绑定材料、蓝图参数桶或清单事实锁，材料中没有对应值时不得猜测填充、不得以行业惯例或公共知识为由虚构数值；公共知识豁免仅限法律法规名称、标准规范名称与编号（不带本项目数值）以及通用工艺做法表述，可依据现行有效版本直接引用。',
    '- 将材料要点自然融入正文；不要输出系统证据清单、中间分析过程或后台流程话术。',
    SECTION_GENERATION_SAFETY_RULES,
    // ── 块级变化段起点（同章各块以下内容互不相同；保持其在 prompt 尾部，共享前缀到此为止恒定）──
    `章节标题：${chapter.title}`,
    `- 保留章节标题；内容不少于 ${options.minWords || 1000} 字${options.targetWords ? `，目标约 ${options.targetWords} 字` : ''}${options.maxWords ? `，最多不超过 ${options.maxWords} 字` : ''}。`,
    chapter.sections?.length ? '- 必须完整包含已规划小节；不要新增未规划的二级小节。' : '- 未预设小节时，不要为了凑结构强行新增小节。',
    chapter.tablePlans?.length ? '- 本章存在结构化表格规划时，必须输出正式 Markdown 表格；表头必须严格使用规划字段，不得擅自改字段、删字段或增加后台溯源列。' : chapter.tableSections?.length ? `- 以下小节可使用表格辅助表达：${chapter.tableSections.join('、')}。` : '',
    chapter.tablePlans?.length ? '- 表格字段值必须优先来自项目图谱、可信事实和绑定材料；projectFactOnly 字段不得编造，也不得写任何固定占位话术。' : '',
    sectionInstruction,
    sectionBudgetInstruction,
    tablePlanInstruction,
    constructionOrgRuleInstruction,
    constructionOrgBonusInstruction,
    ...anchoredRuleInstructions,
    roleContext ? roleContext : '',
    '',
    evidenceText ? '绑定材料：' : '',
    evidenceText,
    options.userWriterRules ? `\n【用户写作指令——必须严格遵守】\n${options.userWriterRules}` : '',
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
      options.blueprintDataText || '',
      options.blueprintSliceText || '',
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
      // F9：章级角色上下文与章级事实大纲计入 L2（同章各块值相同 → 可缓存前缀组成部分）
      options.chapterLevelContext || '',
      outlineBlock,
    ]),
    l3: contextLayerChars([
      `章节标题：${chapter.title}`,
      `- 保留章节标题；内容不少于 ${options.minWords || 1000} 字${options.targetWords ? `，目标约 ${options.targetWords} 字` : ''}${options.maxWords ? `，最多不超过 ${options.maxWords} 字` : ''}。`,
      chapter.sections?.length ? '- 必须完整包含已规划小节；不要新增未规划的二级小节。' : '- 未预设小节时，不要为了凑结构强行新增小节。',
      chapter.tablePlans?.length ? '- 本章存在结构化表格规划时，必须输出正式 Markdown 表格；表头必须严格使用规划字段，不得擅自改字段、删字段或增加后台溯源列。' : chapter.tableSections?.length ? `- 以下小节可使用表格辅助表达：${chapter.tableSections.join('、')}。` : '',
      chapter.tablePlans?.length ? '- 表格字段值必须优先来自项目图谱、可信事实和绑定材料；projectFactOnly 字段不得编造，也不得写任何固定占位话术。' : '',
      sectionInstruction,
      sectionBudgetInstruction,
      tablePlanInstruction,
      constructionOrgRuleInstruction,
      constructionOrgBonusInstruction,
      ...anchoredRuleInstructions,
      roleContext ? roleContext : '',
      evidenceText ? '绑定材料：' : '',
      evidenceText,
      options.userWriterRules ? `\n【用户写作指令——必须严格遵守】\n${options.userWriterRules}` : '',
    ]),
  };
  const content = await callDocumentLlm(system, prompt, false, { maxTokens: options.maxTokens, signal: options.signal, diagnostics: options.diagnostics, contextLayers, prefixKey: `writer-block:${chapter.id}` });
  if (!content || content.length < 120) return undefined;
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('## ') ? content : `## ${chapter.title}\n\n${content}`, Boolean(options.forbidDrawingImages)));
}

export function sectionTargets(chapter: DocumentTemplateChapter, targetWords: number) {
  const sections = normalizePlannedSections(chapter.sections?.filter(Boolean) || [], chapter.title);
  if (sections.length === 0) return [];
  const rawBase = Math.floor(targetWords / sections.length);
  const minimum = targetWords >= sections.length * 900 ? 900 : Math.max(520, Math.floor(rawBase * 0.9));
  const base = Math.max(minimum, rawBase);
  return sections.map(section => ({ title: section, targetWords: base }));
}

export function buildSectionBudgetInstruction(chapter: DocumentTemplateChapter, targetWords: number) {
  const targets = sectionTargets(chapter, targetWords);
  if (targets.length === 0) return '';
  return [
    '本章小节篇幅计划（首轮生成应尽量一次达成，避免后续补写）：',
    ...targets.map(item => `- ${item.title}：约 ${item.targetWords} 字，至少达到 ${Math.floor(item.targetWords * 0.9)} 字，并写入与该小节相关的材料事实、适用边界和必要说明。`),
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

/** 危大工程判定规则卡（4.19 闭环）：节含基坑/危大时注入——从项目上下文与节事实卡锁定实际开挖深度，
 * 按住建部令第 37 号强制落位危大/超危大分级结论；深度缺时不得编造，要求从绑定证据锁定。 */
function excavationHazardRuleCard(sectionTitle: string, projectContext: string, factCardPrompt: string) {
  if (!/基坑|危大/u.test(sectionTitle)) return '';
  const contextText = `${projectContext || ''}\n${factCardPrompt || ''}`;
  // 窗口排除数字防贪婪回溯（「开挖深度5.15m」窗口吞「5.1」后捕获组拿到 5，深度缩水影响分级）
  const depthValues = [...contextText.matchAll(/(?:开挖深度|基坑深度|坡底线|坑底标高)[^。；;\n\d]{0,16}?-?(\d+(?:\.\d+)?)/gu)]
    .map(match => Math.abs(Number(match[1])))
    .filter(value => Number.isFinite(value) && value >= 1 && value < 50);
  const maxDepth = depthValues.length > 0 ? Math.max(...depthValues) : undefined;
  const depthFact = maxDepth !== undefined
    ? `本工程资料基坑开挖深度为 ${maxDepth}m${maxDepth >= 5 ? '（属超过一定规模的危大工程，专项方案必须专家论证）' : maxDepth >= 3 ? '（属危大工程，必须编制专项施工方案）' : '（未达危大工程判定阈值，仍须按一般土方工程管控）'}`
    : '资料中暂未锁定本工程基坑开挖深度数值：不得编造深度数值，必须从绑定证据（基坑支护设计图/地质勘察报告）锁定实际深度后落位危大分级结论。';
  return [
    '【危大工程判定规则卡】依据住建部《危险性较大的分部分项工程安全管理规定》（住建部令第37号）：开挖深度≥3m 的基坑工程属危大工程，必须编制专项施工方案并组织专家论证以外的审核流程；开挖深度≥5m 的基坑工程属超过一定规模的危大工程，专项施工方案必须经专家论证。',
    depthFact,
    '本节基坑内容必须同时写明：①本工程实际开挖深度数值，②对应的危大分级判定结论（危大工程/超过一定规模的危大工程+专家论证）与管控要求，不得只写判定规则不落地本项目深度与分级。',
    // 4.19 外部评审 P1 销项：支护形式与参数必须量化写死，与资料一致；
    // 「按设计坡率」「放坡或支护」类留白/两可表述是评审扣分点，禁止出现
    '本节若涉及基坑支护形式与做法，必须写明具体支护参数并与资料支护形式一致：土钉墙写明土钉规格（钢管Φ及壁厚）、长度、竖向/水平间距、喷射混凝土面层厚度与钢筋网规格；放坡开挖写明放坡坡率（如1:0.75）与坡面防护做法；禁止「按设计坡率」「放坡或支护」类参数留白或两可表述。',
    // R12 舒城第二轮实测：正文声明「无落地式钢管脚手架搭设高度24m及以上」「无10kN及以上起重吊装」
    // 与危大清单表格行（24m 脚手架、10kN 吊装列为危大工程）自相矛盾
    '若本节输出危大工程（辨识）清单表格或排除性声明，两者必须同口径：清单只列资料参数确认达到判定阈值的类别；正文声明「本工程无/未涉及某类危大工程」的类别不得再列入危大清单表格（反之亦然），参数阈值表述不得两处不一致。',
  ].join('\n');
}

export async function buildLlmSectionContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; sectionTitle: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; skeletonProjectContext?: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; qualityFeedback?: string; compactProjectContext?: boolean; scopedProjectContext?: boolean; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; timeoutMs?: number; allowLenientStructureGate?: boolean; tablePlanInstruction?: string; blueprintDataText?: string; blueprintSliceText?: string; sharedFactLayerText?: string; sectionRankBoost?: (item: DocumentEvidence) => number }) {
  const sectionEvidence = evidenceForSection(input.sectionTitle, input.chapter, input.evidence);
  const sectionFactCard = await buildSectionFactCard(input.sectionTitle, sectionEvidence);
  // A2 块级增量压缩（拆半自愈节与主题块同口径）：章级 T0 关键事实层与摘要池已由
  // sharedFactLayerText 注入 L2 共享段，节级 L3 只带节相关命中片段（onlyRankBoosted + 1k-3k 预算）；
  // 历史缺陷：早期逐节成稿每节注入 3.5k-9k 字符证据且同章各节内容近似 → L3 占 79% 且前缀提前分叉
  const blockEvidenceCeiling = tuningProfile().blockEvidenceChars || 1000;
  const blockEvidenceCeilingChars = Number.isFinite(blockEvidenceCeiling) && blockEvidenceCeiling > 0 ? Math.floor(blockEvidenceCeiling) : 1000;
  const sharedFactLayer = Boolean(input.sharedFactLayerText);
  // 4.17.6 节级 L3 压缩：写作只消费事实本身（T0 已由 L2 共享段承载 + T1 节相关命中片段 1K），
  // T2 目录跳过（目录是逐调用不同的不可缓存变化段，追溯语义由章级证据池与 repair 轮承载）
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, sectionEvidence), { maxChars: evidencePromptBudgetForTarget(input.targetWords, 1000, blockEvidenceCeilingChars), requiredFacts: input.chapter.requiredFacts, skipT0: sharedFactLayer, skipT2Catalog: true, rankBoost: input.sectionRankBoost, onlyRankBoosted: Boolean(input.sectionRankBoost), diagnostics: input.diagnostics });
  // 3.5 scoped 专用紧凑化：章级 scoped 上下文走专用紧凑函数（任务卡/实施方案段不被截丢）
  const compactProjectContextText = input.compactProjectContext
    ? (input.scopedProjectContext ? compactScopedProjectContext(input.projectContext) : compactSectionProjectContext(input.projectContext))
    : input.projectContext;
  // 工作包级小节（项目主要施工内容/主要分部分项工程施工方案/主要施工方法）：从项目图谱/上下文识别工作包，匹配工艺知识卡，注入工序链与工艺参数参考
  const skeletonContext = input.skeletonProjectContext ?? input.projectContext;
  const majorConstructionPackages = (MAJOR_CONTENT_SECTION_RE.test(input.sectionTitle) || DIVISION_SECTION_RE.test(input.sectionTitle)) ? parseMajorConstructionPackages(skeletonContext, sectionEvidence) : [];
  const processKnowledgeCards = majorConstructionPackages.length > 0 ? matchProcessKnowledgeCards(majorConstructionPackages.map(pkg => pkg.name)) : [];
  const processKnowledgePrompt = processKnowledgeCards.length > 0 ? buildProcessKnowledgePrompt(processKnowledgeCards, majorConstructionPackages.map(pkg => pkg.name)) : '';
  // 骨架锁定（稳定版）：识别到足够工作包时把小节内部 #### 标题锁死为系统清单，LLM 只填内容不编结构
  const workPackageSkeleton = (MAJOR_CONTENT_SECTION_RE.test(input.sectionTitle) || DIVISION_SECTION_RE.test(input.sectionTitle)) ? workPackageSkeletonPrompt(skeletonContext, sectionEvidence) : '';
  const prompt = [
    input.promptTexts ? `配置写作主控提示词：\n${input.promptTexts}` : '',
    `文档模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    // P5 前缀缓存收敛：同章各节共享段（用户要求/项目上下文/角色/缺失事实/结构锁定/安全规则）全部前置，
    // 节级变化段（小节标题、任务卡、事实卡、专项规则、工艺知识、字数预算、绑定材料）统一后置——
    // 同章各节并发成稿时前缀逐节分叉是命中率低的根因之一，共享段收敛后同章 30+ 节可命中同一前缀
    input.requirement ? `用户要求：${input.requirement}` : '',
    userRequirementFactsPrompt(input.requirement),
    // B2 一体化蓝图参数桶注入 L1：全项目共享一次的恒定段（同章各节值完全相同 → prefix cache 共享命中）
    input.blueprintDataText || '',
    // 章切片注入（章级恒定段，同章各节值相同 → 章内共享前缀）
    input.blueprintSliceText || '',
    input.projectContext ? `上下文：\n${compactProjectContextText}` : '',
    input.factCoverageContext || '',
    // D1/A1 章级证据池上移 L2：同章各节值完全相同 → prefix cache 共享命中；节级 L3 只带节相关增量（A2）
    input.sharedFactLayerText || '',
    input.roleContext,
    input.missingFacts.length ? `需要特别补足的信息：${input.missingFacts.join('、')}` : '',
    '本章节结构已由系统按模板和提示词锁定；不得删除、重命名、合并或重排当前节标题；每个节下必须自然展开三级小节，三级小节承载正文。',
    SECTION_GENERATION_SAFETY_RULES,
    // ── 节级变化段起点（同章各小节以下内容互不相同；保持其在 prompt 尾部，共享前缀到此为止恒定）──
    `当前二级小节：${input.sectionTitle}`,
    professionalSectionTaskCard(input.chapter.title, input.sectionTitle),
    input.tablePlanInstruction || '',
    sectionFactCard.prompt,
    // 专项写法规则单点注入：从 writingSpec 查表（含分部分项专项要求），三管线同源同口径
    ...sectionAnchoredRules(input.sectionTitle),
    processKnowledgePrompt,
    workPackageSkeleton,
    `请只生成当前节内容，使用“### ${input.sectionTitle}”作为节标题；正文必须下沉到若干“#### 三级小节标题”下面，不得在 ### 标题后直接写大段正文。目标约 ${input.targetWords} 字${input.maxWords ? `，最多不超过 ${input.maxWords} 字` : ''}。`,
    input.qualityFeedback ? `上轮小节未通过质量检查，必须修正：${input.qualityFeedback}` : '',
    evidenceText ? `绑定材料：\n${evidenceText}` : '',
  ].filter(Boolean).join('\n\n');
  const system = [
    // 3.2 L0 恒定前缀（跨 Writer 类型共享 prefix cache）；DOCUMENT_L0_SYSTEM_PREFIX=0 回退原前缀
    writerSystemPrefix('你是专业文档的小节生成专家。\n\n' + FORMAL_WRITING_RULES),
    // A5a 前缀缓存：可变 promptTexts 已移入 user 首部，system 保持恒定（跨章共享 prefix cache）
    // 输出池扩容：小节正文含多个 #### 三级小节标题（实测 9 个 H4 均分输出池导致靠后小节
    // 「工艺流程：」被 maxTokens 截断）。中文约 1.5 token/字，按 2.6 倍系数 + 2800 下限留足
    // H4 标题与 markdown 结构开销；正文总量仍由 prompt 的 maxWords 约束，不因池放大而灌水
  ].filter(Boolean).join('\n\n');
  // 3.4 上下文分层统计（L0-L3）：与上方 prompt 组装同源表达式；P5 前缀收敛后口径 =
  // L0 system 恒定段 / L1 任务级恒定指令 / L2 章级共享段（L0-L2 为同章各小节共享的 prompt 前缀，
  // DeepSeek prefix cache 可命中部分）/ L3 节级变化段（同章各小节互不相同，置于 prompt 尾部不可缓存）
  const contextLayers = {
    l0: system.length,
    l1: contextLayerChars([
      input.promptTexts ? `配置写作主控提示词：\n${input.promptTexts}` : '',
      input.requirement ? `用户要求：${input.requirement}` : '',
      userRequirementFactsPrompt(input.requirement),
      input.blueprintDataText || '',
      input.blueprintSliceText || '',
      '本章节结构已由系统按模板和提示词锁定；不得删除、重命名、合并或重排当前节标题；每个节下必须自然展开三级小节，三级小节承载正文。',
      SECTION_GENERATION_SAFETY_RULES,
    ]),
    l2: contextLayerChars([
      `文档模板：${input.template.name}`,
      `章节标题：${input.chapter.title}`,
      input.projectContext ? `上下文：\n${compactProjectContextText}` : '',
      input.factCoverageContext || '',
      input.sharedFactLayerText || '',
      input.roleContext,
      input.missingFacts.length ? `需要特别补足的信息：${input.missingFacts.join('、')}` : '',
    ]),
    l3: contextLayerChars([
      `当前二级小节：${input.sectionTitle}`,
      professionalSectionTaskCard(input.chapter.title, input.sectionTitle),
      input.tablePlanInstruction || '',
      sectionFactCard.prompt,
      excavationHazardRuleCard(input.sectionTitle, input.projectContext, sectionFactCard.prompt),
      ...sectionAnchoredRules(input.sectionTitle),
      processKnowledgePrompt,
      workPackageSkeleton,
      `请只生成当前节内容，使用“### ${input.sectionTitle}”作为节标题；正文必须下沉到若干“#### 三级小节标题”下面，不得在 ### 标题后直接写大段正文。目标约 ${input.targetWords} 字${input.maxWords ? `，最多不超过 ${input.maxWords} 字` : ''}。`,
      input.qualityFeedback ? `上轮小节未通过质量检查，必须修正：${input.qualityFeedback}` : '',
      evidenceText ? `绑定材料：\n${evidenceText}` : '',
    ]),
  };
  // 4b 补写预算边界修复：历史公式 min(outputTokensForChapter(target), ceil(target×2.6)) 在目标 >1924 字时
  // 被 outputTokensForChapter 的 5000 token 下限卡死（目标 2750 字需 ~5000 token 零富余，>3000 字必然截断）
  // → 补写截断 → 复审驳回 → 轮次耗尽 → 章节 failed 的确定性失败链；改为 2.6 系数直通 8192 上限，
  // 3750 字档仍有 20%+ 富余（思考已关闭时正文独占输出池，预算只保正文不保思考）
  const llmCall = () => callDocumentLlm(system, prompt, false, { maxTokens: Math.min(8192, Math.max(2800, Math.ceil(input.targetWords * 2.6))), temperature: 0, signal: input.signal, diagnostics: input.diagnostics, contextLayers, prefixKey: `writer-section:${input.chapter.id}` });
  const content = input.diagnostics
    ? await measureGenerationStep(input.diagnostics, `section-draft:${input.chapter.id}:${input.sectionTitle}`, llmCall)
    : await llmCall();
  if (!content || content.length < 80) return undefined;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('### ') ? content : `### ${input.sectionTitle}\n\n${content}`, input.forbidDrawingImages));
  const normalizedContent = normalized.replace(/^##\s+.*\n+/u, '').trim();
  const criticalMinChars = criticalSectionBlockerMinChars(input.sectionTitle);
  // 单次任务的最小字数不得超过任务目标字数：任务拆分会把小节拆成多个 targetWords≈800 的主题任务，
  // 此时全局 criticalMinChars（如 1800）远大于任务目标，每个任务都无法达标而被整体拒绝，反而产出空小节。
  const minSectionChars = Math.min(Math.max(Math.floor(input.targetWords * 0.7), criticalMinChars), Math.max(500, input.targetWords));
  let structureIssue = sectionStructureIssue(input.sectionTitle, normalizedContent);
  let finalContent = normalizedContent;
  // 骨架锁定复核（稳定版）：工作包级小节先做确定性清洗（表格剥离 + 串位检测），再与结构门禁同步把关
  const workPackageSection = MAJOR_CONTENT_SECTION_RE.test(input.sectionTitle) || DIVISION_SECTION_RE.test(input.sectionTitle);
  if (workPackageSection) {
    const crossIssue = workPackageCrossSectionIssue(sectionContentBody(finalContent));
    if (crossIssue) structureIssue ||= crossIssue;
    const tableStripped = stripMarkdownTableBlocks(finalContent);
    if (tableStripped !== finalContent) {
      finalContent = tableStripped;
      structureIssue = sectionStructureIssue(input.sectionTitle, finalContent);
    }
  }
  // WS1 治理：原 repairMajorContentWorkPackageLabels 兜底已删除——其给裸文本补“施工概况：/施工流程：/
  // 施工方法：”前缀骗过 workPackageContentElementsComplete 字面检测（形式作弊），且补出的标签会被
  // 终检 templatedLabelIssues 报错、被确定性修复器 templated-labels 剥离，构成自我抵消回路；
  // 要素不全沿 lastError 反馈重写，或经下方宽松门（真三要素齐全才放行）降级处理
  if (structureIssue && input.allowLenientStructureGate && workPackageSection) {
    // 修复链路降级验收：深度关键小节多次被门禁拒绝会导致小节永久缺失（初稿起标题就不写入）。
    // 只要三级工作包结构存在、字数达标且无脏事实污染，就保留内容交由清洗链与终检把关，
    // 避免小节整体消失造成的结构缺陷。4.19 三要素硬门：降级放行不得绕过三要素——
    // 每包至少 2 要素且工序顺序全部工作包必备（workPackageElementsMeetLenientGate），
    // 否则照常拒绝并反馈 Writer 重写，不再把要素不全的“只有流程”型工作包放行出厂。
    // 扩围：主要分部分项工程施工方案/主要施工方法小节与项目主要施工内容同口径（此前只覆盖
    // 项目主要施工内容，分部分项小节被拒后无降级验收路径，整节重试仍失败即永久缺失）
    const block = currentSectionBlock(input.sectionTitle, finalContent);
    const packageCount = (block.match(/^####\s+/gmu) || []).length;
    const packageBlocks = block.split(/^####\s+/gmu).slice(1).map(item => item.trim()).filter(Boolean);
    const elementsGateMet = packageBlocks.length > 0 && packageBlocks.every(item => workPackageElementsMeetLenientGate(item));
    const polluted = majorContentPollutionIssue(sectionContentBody(block));
    if (packageCount >= 3 && elementsGateMet && !polluted && documentTextLength(finalContent) >= minSectionChars) structureIssue = '';
  }
  if (structureIssue) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `${structureIssue}：${input.chapter.title} / ${input.sectionTitle}`;
    return undefined;
  }
  if (isCriticalDeepSection(input.sectionTitle) && documentTextLength(finalContent) < minSectionChars) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `section writer 正文不足：${input.chapter.title} / ${input.sectionTitle} / ${documentTextLength(finalContent)}/${minSectionChars}字`;
    return undefined;
  }
  // “项目主要施工内容”节去重：LLM 可能把同一工作包按“X工程”“X工作包”两遍展开，确定性合并删除重复小节
  const dedupedContent = /项目主要施工内容/u.test(input.sectionTitle) ? mergeDuplicateWorkPackageSubsections(finalContent) : finalContent;
  return ensureTertiarySectionShell(input.sectionTitle, dedupedContent);
}

function sectionSupplementQualityIssue(sectionTitle: string, content: string) {
  const body = content.replace(/^#{3,4}\s+.*\n+/u, '').split(/\r?\n/u)
    .filter(line => !/^\s*\|/u.test(line))
    .filter(line => !/^\s*\|?\s*:?-{3,}:?/u.test(line))
    .join('\n');
  const effectiveLength = documentTextLength(body);
  if (effectiveLength < 360) return `正文有效内容不足：${sectionTitle} 当前约 ${effectiveLength} 字`;
  if (/资料未提供|信息有限|无法确定|待补充|建议扩大本地知识库检索|以下是|本文档|本小节围绕/u.test(body)) return `存在空泛或说明性话术：${sectionTitle}`;
  return undefined;
}

export function sectionSupplementAttempts(totalTargets: number) {
  // （原 DOCUMENT_SECTION_SUPPLEMENT_ATTEMPTS 已固化删除：上限恒为 2）
  return Math.max(1, Math.min(3, 2, totalTargets));
}

export async function buildQualifiedSectionSupplement(input: Parameters<typeof buildLlmSectionContent>[0], maxAttempts: number) {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const generated = await buildLlmSectionContent({ ...input, qualityFeedback: feedback });
    if (!generated) {
      // 定向补写（C2）：被拒后不整节重写——保留上一轮已通过检查的内容，只补缺失要素段，
      // 避免整节重写把已正确的部分再次写乱（轮7 实测两套形态混用：前段一段式、后段标签式）
      feedback = `上一轮未生成有效正文${input.diagnostics?.llm.lastError ? `（被拒原因：${input.diagnostics.llm.lastError}）` : ''}。请定向修正：保留上一轮已通过检查的内容不变，只补写缺失的要素段（作业对象与工程量/工序顺序/施工方法，缺哪项补哪项），不得整体重写已正确的部分。`;
      continue;
    }
    const issue = sectionSupplementQualityIssue(input.sectionTitle, generated);
    // P4/P5 节级补写数值核验：首轮成稿与证据对账，确定性错误（同位置不同值）进入反馈重试；
    // 反馈携带正确值与已核验正确数值保留清单（重写保护）；第二轮仍错误时放行交由后续审查链兑底
    let numericIssue: string | undefined;
    if (attempt === 0 && !issue) {
      const reconciliation = reconcileContentNumbers(generated, input.evidence.map(item => item.content).join('\n'));
      if (reconciliation.mismatched.length > 0) {
        if (input.diagnostics) input.diagnostics.llm.lastInfo = `数值核验：${input.sectionTitle} 发现 ${reconciliation.mismatched.length} 处疑似错误数值（${reconciliation.mismatched.map(item => `${item.found}→${item.expected}`).join('、')}）`;
        numericIssue = renderNumericFeedback(reconciliation);
      }
    }
    if (!issue && !numericIssue) return generated;
    feedback = issue || numericIssue;
  }
  return undefined;
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
  maxWords?: number;
  forbidDrawingImages: boolean;
  factCoverageContext?: string;
  compactProjectContext?: boolean;
  scopedProjectContext?: boolean;
  /** B2 一体化蓝图参数桶注入文本（L1 恒定段，全项目共享一次） */
  blueprintDataText?: string;
  /** 二期蓝图接管：章切片渲染文本（章级恒定段，同章各块值相同 → 章内共享前缀） */
  blueprintSliceText?: string;
  /** 二期蓝图接管：must_cite+strict 参数数值清单（块质检第二轮反馈挂接，未引用时定向重试） */
  blueprintMustCiteHint?: string;
  sectionEvidenceProvider?: (sectionTitle: string) => Promise<DocumentEvidence[]>;
  /** 块级进度回调：块成稿完成即触发（phase='complete'，partialSections 为已完成块正文），供 checkpoint 快照写盘 */
  onSectionProgress?: (event: { completed: number; total: number; sectionTitle?: string; phase: 'start' | 'complete' | 'retry'; partialSections?: Array<string | undefined> }) => void;
  diagnostics?: DocumentGenerationDiagnostics;
  signal?: AbortSignal;
}

/** C3 块级失败隔离结果：部分块失败时返回已成功块 + 失败块清单，由上层只重试失败块，
 * 不再整章降级重写（历史缺陷：单块质检未达标 → 整章平铺备用 → 全文字数雪崩） */
export interface PlannedChapterContentResult {
  /** 按 structure.blocks 顺序的块成稿正文（失败块为 undefined） */
  sections: Array<string | undefined>;
  /** 成稿失败的主题块（含原 index），供上层块级隔离重试 */
  failedBlocks: Array<{ index: number; block: PlannedChapterBlock }>;
  /** 全部块成稿成功 */
  allSucceeded: boolean;
  /** 成功块拼接的章节 Markdown（含章标题外壳；失败块缺失时不包含该块正文） */
  markdown: string;
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
  /** 剥离块成稿开头的同标题 H3 外壳（拆半子块/规划层拆半共享父块标题，拼接时后块标题行剥壳，
   * 目录只保留一个小节；模型自行改名的 H3 不剥，由块质检清单外判定拦截） */
  const stripLeadingShellTitle = (content: string, normalizedShellTitle: string): string => content.replace(/^###\s+[^\n]*\n+/u, match => {
    const heading = match.replace(/^###\s+/u, '').trim();
    return normalizeSubsectionTitleForDedup(heading) === normalizedShellTitle ? '' : match;
  });
  /** 拆半子块同标题 H3 外壳合并：后半块开头与父块标题归一化同名的 H3 行剥离后拼入前半块 */
  const mergeHalfBlockShells = (firstHalf: string, secondHalf: string, shellTitle: string): string => `${firstHalf}\n\n${stripLeadingShellTitle(secondHalf, normalizeSubsectionTitleForDedup(shellTitle))}`;  // 表格计划按主题块挂接：块内 subPoint 覆盖的源细目标题命中的表挂到该块；未命中必写表挂最后一块兜底，保证必写表不丢失
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
  const chapterPoolChars = tuningProfile().chapterPoolChars || 8000;
  const sharedFactLayerText = buildChapterEvidencePool(buildEvidenceBundle(input.chapter, input.evidence), input.chapter.requiredFacts || [], Number.isFinite(chapterPoolChars) ? Math.floor(chapterPoolChars) : 8000);
  // A2 块级增量压缩：块级证据预算 1k（blockEvidenceChars，DOCUMENT_TUNING_PROFILE 可调，默认 1000），
  // 且只保留块相关命中片段（onlyRankBoosted）——块级 L3 从 7k-26k 压缩到 1k 量级
  const blockEvidenceCeiling = tuningProfile().blockEvidenceChars || 1000;
  const blockEvidenceCeilingChars = Number.isFinite(blockEvidenceCeiling) && blockEvidenceCeiling > 0 ? Math.floor(blockEvidenceCeiling) : 1000;
  const writeBlock = async (block: (typeof blocks)[number], index: number): Promise<string | undefined> => {
    // 彻底修复同名结构：与主题块标题同名的 H4 要点由 H3 外壳直接承担，不再要求输出同名 H4
    // （历史缺陷：H3/H4 同名诱发模型把同名 H4 重复展开多轮 → 重复质检两轮失败 → dedupe 兜底字数不足 → 章阻断）
    const normalizedBlockTitle = normalizeSubsectionTitleForDedup(block.title);
    const sectionTitles = block.subPoints.filter(point => normalizeSubsectionTitleForDedup(point.title) !== normalizedBlockTitle).map(point => point.title);
    // 4.19 串章骨架防线：本章其他主题块的块标题+要点标题（归一化）作为禁词集合——
    // LLM 在主题块成稿时照抄整章其他主题块骨架（6.4 块输出 6.1~6.3 全部小节标题）属质检盲区：
    // missing 只查缺失、duplicates 只查同 H3 内重名，串章标题全数漏网（真实回归：目录小节串章实锤）
    // 排除口径用归一化标题而非引用比较：拆半自愈递归调用传新块对象，candidate !== block 引用比较
    // 永远成立 → 父块自身标题全部算入禁词 → 子块自己的 H4 被 extraneous 误判（4.19 全量回归：
    // 拆半自愈用例调用次数 4→6 次、块隔离用例全块失败）
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
    const extraEvidence = input.sectionEvidenceProvider ? await input.sectionEvidenceProvider(block.title).catch(() => []) : [];
    const blockEvidence = [...scoredEvidence, ...extraEvidence];
    // 骨架锁定（稳定版）：仅当块 H3 标题本身是工作包级小节时才锁定骨架。块内 H4 要点命中关键小节
    // 不触发块级骨架锁定——「项目主要施工内容」作为其他章（如重点难点章）的 H4 要点时，
    // 该 H4 小节的骨架由修复链 enforceWorkPackageSkeletons 阶段 0 补建 + 锚点直连补写兜底；
    // 历史缺陷（轮4 实测）：块内 H4 命中即整块锁骨架，scopeEngineeringNames 把证据里的约束文本
    //（工程量/系统约束/不得编造等）当工作包名，块质检要求模型输出垃圾标题 → 两轮+拆半全失败 → 章失败
    // P2.5 骨架锁定兑底：块标题本身是工作包级小节，或本章标题是「主要施工方法」类分部章
    //（块标题为分部名，如「道路工程」）时锁定骨架——分部章的块标题不匹配 DIVISION_SECTION_RE，
    // 历史缺陷（丰乐镇第十轮实测）：「主要施工方法」章 23 个蓝图分部名块因 keySectionKind 为空
    // 从不触发骨架锁定，三来源提取又哑火（图谱包被项目名过滤/招标范围叙述式提取不足/证据无清单正文）→
    // 整章自由发挥丢分部结构
    const keySectionKind = MAJOR_CONTENT_SECTION_RE.test(block.title) ? 'major' : (DIVISION_SECTION_RE.test(block.title) || DIVISION_SECTION_RE.test(input.chapter.title)) ? 'division' : '';
    // 4.19.5 回归（丰乐镇第二轮验收）：分部章容器块（「主要分部分项工程施工方案」在「主要施工方法」章内）
    // 是全章总述小节，不得套用单分部要素融合 divisionElementFusionPrompt——历史缺陷：容器块按三段式展开时 LLM 把本章全部
    // 分部名写成 H4（清单外）+ 每分部三段标签重复展开（重复）→ 两轮重试+确定性兑底全灭 → 章阻断；
    // 容器块改发总述提示词（不锁骨架、正文直接展开、禁止使用其他小节标题），清单外 H4 由块质检确定性修复剥离。
    const isDivisionChapterContainer = DIVISION_SECTION_RE.test(input.chapter.title) && DIVISION_SECTION_RE.test(block.title);
    // 骨架提取专用完整上下文：瘦身 context 缺招标范围/图谱包段时骨架名提取哑火，回退到完整上下文
    const skeletonContext = input.skeletonProjectContext ?? input.projectContext;
    // 拆半自愈子块只要求自身 subPoints 内的骨架名：半块字数预算（≥1800 字）物理装不下全部
    // 工作包 × 三要素，历史缺陷是半块质检要求全量骨架名 → 两半块各写全部包 → 必败；
    // 主块（subPoints 已骨架展开）与骨架名同源，过滤后仍是全量名
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
    // P2.5 骨架名兑底：三来源提取不足 minCount（3）时，用块规划层 subPoints 标题兜底——
    // 块规划与蓝图 outline 分部名同源（P1.3 已把 outline 分部名展开进容器块 subPoints），
    // 是「主要施工方法」章在证据不足时唯一可靠的骨架来源；兜底不足时骨架锁定整体回退软约束
    // 发布前实测（丰乐镇 doc-1788970810155）：域聚合块（公厕装饰装修 6 工作包）提取名
    // 只匹配到门窗 → 要素融合接管，注入的 6 包覆盖清单 LLM 只写首包，其余 5 包内容丢失；
    // 兑底条件去除 raw.length < 3 限制：subPoints ≥ 3 的多工作包块一律用 subPoints 锁
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
    const blockChapter = { ...input.chapter, title: block.title, sections: sectionTitles, tablePlans: blockTablePlans[index] || [] };
    // P3/P7 专属事实注入：blockFacts 为章级分配表分配给本块的事实行（每条只归属一个块）；
    // 蓝图规划层 block.facts 历史恒为空数组（factsHint 载体存在但从未填充），现由分配表确定性填充
    const blockFacts = [...(block.facts || []), ...blockFactAssignments[index]].slice(0, 8);
    const factsHint = blockFacts.length
      ? `【本主题块专属事实（只能在本节使用，不得重复出现在本章其他节；本章其他节已认领各自专属事实，本节不得重复展开其他节专属事实）】${blockFacts.map(item => `- ${item}`).join('\n')}`
      : '';
    // 覆盖清单：语义合并后的 H4 标注其承载的全部评分细目，写手按清单展开内容但不得为细目单独开设标题；
    // 与块标题同名的要点由 H3 外壳直接承担（不再输出同名 H4），清单中仅提示其覆盖细目
    const coverageList = block.subPoints.map(point => (normalizeSubsectionTitleForDedup(point.title) === normalizedBlockTitle
      ? `- ### ${block.title}（本节标题，覆盖评分细目：${point.sources.join('、')}；正文直接展开，无需四级标题；如按细目分节，仅可使用上述细目标题作为四级标题）`
      : (point.sources.length > 1
        ? `- #### ${point.title}（覆盖评分细目：${point.sources.join('、')}）`
        : `- #### ${point.title}`))).join('\n');
    // F9：章级角色上下文（评分项要求路由/数据口径约束）拆出上移 L2 共享段（同章各块完全相同），
    // 块级 roleContext 只保留块专属段（factsHint/coverageList）——共享前缀变长，命中率回升
    const forbiddenTitlesLine = otherBlockTitleSet.size > 0 ? `严禁将以下属于本章其他小节的标题作为本节任何标题输出（H3 仅允许「${block.title}」，H4 仅允许上面清单中的标题）：${[...otherBlockTitleSet].join('、')}。` : '';
    // A22 单要点大块拆半分工指令（丰乐镇第九轮）：两半块共享同一 H4 要点，靠 halfFocus
    // 划定内容边界（前半=总体构成/框架，后半=具体展开/实施），防止两半块产出雷同正文
    const halfFocusLine = block.halfFocus ? `\n${block.halfFocus}` : '';
    const blockRoleContext = [factsHint, blockSkeletonPrompt, divisionContainerPrompt, divisionElementFusionPrompt, keySectionKind && !isDivisionChapterContainer ? flowRotationDirective(index) : '', block.subPoints.length > 0
      ? `本节是「${input.chapter.title}」章的一个主题小节，只写本节标题覆盖的内容，不得重复本章其他节内容；必须按以下清单逐点写出实施性正文，标题必须与给定标题完全一致，不得改名、合并或遗漏；每个要点必须覆盖其标注的全部评分细目内容，但不得为这些细目单独开设小节标题：\n${coverageList}${forbiddenTitlesLine ? `\n${forbiddenTitlesLine}` : ''}${halfFocusLine}`
      : `本节是「${input.chapter.title}」章的唯一小节（本章无细分小节规划）：正文在 H3 标题下直接展开为连贯的正式叙述，不使用四级标题；覆盖本节标题对应的全部实质内容，不得重复章外内容。${halfFocusLine}`, '【防复读硬约束】本节内同一句话只允许出现一次：同一段落内不得复读任何已写出的句子，不同段落之间不得整句复制，同一工艺/措施只在一处完整表述、其余位置引用结论不重述原文；段落结尾不得复读段内前句（禁止“为此/综上/因此”后接照抄句）。'].filter(Boolean).join('\n\n');
    let lastMissing: string[] = [];
    let lastDuplicates: string[] = [];
    let lastExtraneous: string[] = [];
    let lastChars = 0;
    let lastNumericFeedback = '';
    let lastFlowFeedback = '';
    // 2.6 补写上限收紧：块级写作/反馈重试循环上限显式化（固化为 2，与既有行为一致）
    // ——上限超出即判失败转上层紧凑备用（原 DOCUMENT_BLOCK_MAX_ATTEMPTS 已固化删除）
    const blockMaxAttempts = 2;
    for (let attempt = 0; attempt < blockMaxAttempts; attempt += 1) {
      // 第二轮反馈针对性列出缺失/重复 H4 标题，让重试有的放矢，避免通用反馈反复缺失要点后被迫拆半/整章降级
      const feedback = attempt === 0 ? '' : [
        '【上一轮未通过质检】',
        lastMissing.length ? `缺失 H4 要点标题：${lastMissing.join('、')}。必须逐点补齐以上 H4 标题并展开正式正文，H4 标题与给定标题完全一致。` : '',
        lastDuplicates.length ? `重复展开的 H4 要点标题：${lastDuplicates.join('、')}。同一小节内相同要点被重复展开多轮，必须只保留一轮完整展开，其余重复小节连同标题整体删除，不得以换编号方式重复同一内容。` : '',
        lastExtraneous.length ? `清单外标题（属于本章其他小节或不在本节要点清单内）：${lastExtraneous.join('、')}。这些标题连同其正文整块删除，本节只允许输出上面清单中的 H4 标题与「${block.title}」H3 标题。` : '',
        lastMissing.length === 0 && lastDuplicates.length === 0 && lastExtraneous.length === 0 ? '必须完整包含每个 H4 要点标题并展开正文，不得合并或遗漏要点。' : '',
        // P4/P5 数值核验反馈（第二轮注入）：错误数值修正指令 + 已核验正确数值保留清单
        lastNumericFeedback,
        // WS3 工序表达形式反馈（第二轮注入）：指定形式未落地时定向重写
        lastFlowFeedback,
        // 二期蓝图接管：must_cite+strict 数值清单挂进第二轮反馈（未引用/数值不一致时定向重试）
        input.blueprintMustCiteHint ? `【蓝图锁定数值检查】正文必须逐条出现以下蓝图锁定数值且与给定值完全一致：${input.blueprintMustCiteHint}。` : '',
        // A22 缺口数字反馈（丰乐镇第九轮）：只报“不少于目标字数”不报缺口时模型输出不升反降
        //（第八轮实测 1742→1377 字）；带当前字数与缺口数字的反馈比笼统指令收敛有效得多
        lastChars > 0 ? `当前输出仅 ${lastChars} 字，距目标 ${block.targetWords} 字还缺 ${Math.max(0, block.targetWords - lastChars)} 字，必须逐点展开到不少于 ${Math.floor(block.targetWords * 0.9)} 字。` : '总字数不少于目标字数。',
      ].filter(Boolean).join('');
      try {
        // 2.6 串行链观测拆解：块内每次写作调用单独记 measure（含 attempt 序），
        // 定位 chapter-planned-block-draft 总段内 写作/重试/拆半 各环节的耗时分布（观测恒开，只记数据）
        const writeCall = () => buildLlmChapterContent(input.template, blockChapter, blockEvidence, input.missingFacts, input.promptTexts, input.projectContext, input.requirement, feedback ? `${blockRoleContext}\n\n${feedback}` : blockRoleContext, {
          forbidDrawingImages: input.forbidDrawingImages,
          compactProjectContext: input.compactProjectContext,
          scopedProjectContext: input.scopedProjectContext,
          // F9：章级角色上下文上移 L2 共享段（同章各块完全相同 → prefix cache 共享命中）
          chapterLevelContext: input.roleContext || '',
          // 达标契约：minWords = 块目标（不打折）。实测 deepseek-v4-pro 单次可稳定输出 4000~6300 字，
          // 提示词"不少于 X 字"即必然达标；0.6 折扣是历史人为降标，是"初稿不达标→补写"链的源头
          minWords: block.targetWords,
          targetWords: block.targetWords,
          maxWords: Math.ceil(block.targetWords * 1.1),
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
          // B2 一体化蓝图参数桶注入 L1（全项目共享一次的恒定段）
          blueprintDataText: input.blueprintDataText,
          blueprintSliceText: input.blueprintSliceText,
          twoStep: false,
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
        // 骨架锁定质检（稳定版）：关键小节块先确定性清洗（表格剥离），再做骨架工作包标题齐全校验
        let skeletonMissing: string[] = [];
        if (keySectionKind) {
          const tableStripped = stripMarkdownTableBlocks(withBlockShell);
          if (tableStripped !== withBlockShell) withBlockShell = tableStripped;
          const headingLines = (withBlockShell.match(/^#{3,4}\s+(.+)$/gmu) || []).map(line => line.replace(/^#{3,4}\s+/u, ''));
          skeletonMissing = blockSkeletonNames.filter(name => !headingLines.some(line => normalizeSubsectionTitleForDedup(line).includes(normalizeSubsectionTitleForDedup(name))));
        }
        const chars = documentTextLength(withBlockShell);
        lastChars = chars;
        // P4 落位数值一致性核验：块成稿与证据对账（注入证据=章级共享事实层+块级证据；完整证据池=全章证据）。
        // 只标记不删改：mismatched（同位置不同值）首轮阻断重试、第二轮放行交由后续审查链兑底；unsourced 仅观测
        const numericHaystack = `${sharedFactLayerText}\n${blockEvidence.map(item => item.content).join('\n')}`;
        const numericPoolText = input.evidence.map(item => item.content).join('\n');
        const numericReconciliation = reconcileContentNumbers(withBlockShell, numericHaystack, numericPoolText);
        if (numericReconciliation.mismatched.length > 0 && input.diagnostics) {
          input.diagnostics.llm.lastInfo = `数值核验：${block.title} 发现 ${numericReconciliation.mismatched.length} 处疑似错误数值（${numericReconciliation.mismatched.map(item => `${item.found}→${item.expected}`).join('、')}）`;
        }
        // 稳定版：骨架小缺口豁免阻断（缺口 ≤2 个包时交全卷修复链 enforceWorkPackageSkeletons 锚点直连补写兑底，
        // 补 1-2 个包成功率高）——历史缺陷：差 1-2 个包导致整块重试/拆半耗尽 → 章失败 → 修复链根本没机会跑；
        // 缺口 >2 仍阻断（骨架大面积缺失说明写作未遵循骨架要求，重试/拆半有价值）
        if (skeletonMissing.length > 0 && skeletonMissing.length <= 2) {
          console.error(`[gen][block-qc] 骨架小缺口豁免（交修复链兑底 ${skeletonMissing.length} 个）: ${block.title}: ${skeletonMissing.join('、')}`);
        }
        const skeletonMissingBlocking = skeletonMissing.length <= 2 ? [] : skeletonMissing;
        // 稳定版：要点标题缺失判定归一化包含匹配（与骨架/清单外同口径）——模型微调要点标题
        // （如“主要分部分项施工方案”中间加“工程”、编号格式变化）时精确子串匹配会误判缺失 → 重试/拆半耗尽；
        // 按行归一化比较（行内提及要点标题即视为覆盖，保留对自然成文形态的宽容）；归一化行池预计算一次，
        // 块质检每轮 attempt 都跑，避免行级正则重复展开
        const normalizedLines = withBlockShell.split('\n').map(line => normalizeSubsectionTitleForDedup(line)).filter(Boolean);
        const sectionTitlesMissing = sectionTitles.filter(title => {
          const normalizedTitle = normalizeSubsectionTitleForDedup(title);
          if (!normalizedTitle) return false;
          return !normalizedLines.some(line => line.includes(normalizedTitle));
        });
        const missing = [...sectionTitlesMissing, ...skeletonMissingBlocking.map(title => `工作包小节：${title}`)];
        // 同 H3 内同名 H4 重复展开同样视为质检不达标（实测一轮输出三轮相同改造项/危大工程三连），阻断重复进入二轮后处理
        const duplicates = findDuplicateH4Titles(withBlockShell);
        // 4.19 清单外标题（串章骨架/自由发挥）视为质检不达标：H3 只允许块标题、H4 只允许本块要点标题；
        // 本块要点承载的评分细目原标题（sources）入白名单——单要点块模型按证据写出细目原标题 H4 属内容归位，
        // 不算清单外（第七次回归实证：块「项目理解与编制边界」输出「#### 编制说明与工程概况」被误杀 → 章失败）
        const extraneous = findExtraneousBlockTitles(withBlockShell, block.title, sectionTitles, [...otherBlockTitleSet], [...block.subPoints.flatMap(point => point.sources), ...blockSkeletonNames]);
        // 达标契约：质检阈值 = 0.9×块目标。minWords 已不打折（提示词硬要求写满目标字数），
        // 实测模型单次输出 4000~6300 字无压力——"自然输出仅 44%"是历史 minWords 折扣导致的伪观测，
        // 折扣拆除后 0.9 阈值即必然达标；字数缺口不再交由补写轮补齐（补写轮已删除）
        // P4：首轮确定性错误数值阻断重试（feedback 携带正确值）；第二轮仍错误时放行（避免无限重试，
        // 错误数值交由下游 Reviewer/跨章一致性审查兑底）
        const numericBlocking = attempt === 0 && numericReconciliation.mismatched.length > 0;
        // WS3 首轮工序表达形式核验：块内已有工序顺序表达但形式与指定不符时首轮阻断重试（照 numericBlocking
        // 首轮模式：二轮放行交终检 flowFormRepeatIssues + 修复轮兜底）；完全无工序表达不在此阻断——
        // 由分部分项质量规则的三要素检查承担（避免两处阻断口径打架）
        const expectedFlowForm = keySectionKind && !isDivisionChapterContainer ? flowFormForBlockIndex(index) : undefined;
        const actualFlowForm = expectedFlowForm ? primaryFlowForm(withBlockShell) : undefined;
        const flowFormBlocking = attempt === 0 && expectedFlowForm !== undefined && actualFlowForm !== undefined && actualFlowForm !== expectedFlowForm;
        if (chars >= Math.floor(block.targetWords * 0.9) && missing.length === 0 && duplicates.length === 0 && extraneous.length === 0 && !numericBlocking && !flowFormBlocking) {
          return withBlockShell;
        }
        lastMissing = missing;
        lastDuplicates = duplicates;
        lastExtraneous = extraneous;
        // P5 重写保护：数值核验反馈存入下一轮 feedback（错误修正 + 正确保留清单）
        lastNumericFeedback = renderNumericFeedback(numericReconciliation);
        // WS3 工序表达形式反馈：指定形式未落地（含未见明确表达）时定向提示二轮重写
        lastFlowFeedback = expectedFlowForm !== undefined && actualFlowForm !== expectedFlowForm
          ? `【上一轮工序表达形式不符】本块指定的工序顺序表达形式为「${expectedFlowForm}」，上一轮正文${actualFlowForm ? `使用了「${actualFlowForm}」形式` : '未见明确的工序顺序表达'}。必须改用「${expectedFlowForm}」形式重写工序顺序表达，内容与数值保持不变。`
          : '';
        // 4.12.17 确定性清洗兜底（每一轮不达标都先试）：同 H3 重复 H4 去重 + 清单外标题块删除后重检字数，
        // 结构性重复/清单外骨架由代码兜底，避免内容合格的块整块作废 → 整章降级 → 字数雪崩。
        // 第五次回归实证：首轮仅因清单外 H4（模型自由发挥/标题微调）不达标（4083 字达标块仍失败），
        // 首轮兜底删后字数达标即通过；二轮同样兜底（原只 attempt===1，二轮删后字数不足 → 块死亡 → 章失败）
        if (missing.length === 0) {
          // 4.19.1 确定性修复优先：先同 H3 重复 H4 去重，再清单外标题行剥离（正文零丢失），
          // 修复后字数达标即通过——标题层问题由代码确定性修复，不因整块删除掉档触发重试/失败
          const repaired = stripExtraneousBlockHeadings(dedupeRepeatedSubsections(withBlockShell), block.title, sectionTitles, [...block.subPoints.flatMap(point => point.sources)]);
          const repairedChars = documentTextLength(repaired);
          if (repairedChars >= Math.floor(block.targetWords * 0.9)) {
            if (input.diagnostics && (extraneous.length > 0 || duplicates.length > 0)) input.diagnostics.llm.lastInfo = `块标题层已确定性修复：${block.title}（清单外 ${extraneous.length} 个、重复 H4 ${duplicates.length} 个；${chars}→${repairedChars} 字）`;
            return repaired;
          }
        }
        if (input.diagnostics) input.diagnostics.llm.lastError = `规划块质检未达标：${block.title}（${chars} 字，缺 ${missing.join('、') || '无'}${duplicates.length ? `，重复 H4 ${duplicates.join('、')}` : ''}${extraneous.length ? `，清单外 ${extraneous.slice(0, 5).join('、')}${extraneous.length > 5 ? ' 等' : ''}` : ''}）`;
        // 章失败归因诊断日志：块级质检不达标详情落盘（轮3 实测“重点难点/新技术”两章拆半后仍未成稿，
        // failures=0 表示 LLM 正常返回但质检不过，必须拿到具体不达标项才能定向修复）
        console.error(`[gen][block-qc] 块质检不达标 attempt=${attempt}: ${block.title}（目标 ${block.targetWords} 字，实际 ${chars} 字，缺 ${missing.join('、') || '无'}，重复 ${duplicates.join('、') || '无'}，清单外 ${extraneous.join('、') || '无'}，keySection=${keySectionKind || 'none'}）`);
      } catch (error) {
        if (input.diagnostics) input.diagnostics.llm.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    // 自愈拆半：要点 ≥4 的块两次尝试仍未达标时，对半拆为两个子块各自成稿（仍在块级管线内，不降级逐小节）；
    // 目标 ≥2400 且要点 ≥2 的大块同样拆半（第五次回归：3 点块目标 2000+ 时模型单块输出不足，无拆半退路 → 章失败）
    if (block.subPoints.length >= 4 || (block.subPoints.length >= 2 && block.targetWords > 2400)) {
      const mid = Math.ceil(block.subPoints.length / 2);
      const halfTarget = Math.max(800, Math.floor(block.targetWords / 2));
      // 拆半子块共享父块标题（不加后缀）：两半块补出的相同 H3 外壳由 mergeHalfBlockShells
      // 拼接时合并为一个，目录只出现一个小节（历史缺陷：标题加（一）/（二）后缀防撞名 → 泄漏进目录）
      const halfBlocks = [
        { ...block, subPoints: block.subPoints.slice(0, mid), targetWords: halfTarget },
        { ...block, subPoints: block.subPoints.slice(mid), targetWords: halfTarget },
      ];
      const halfParts = await Promise.all(halfBlocks.map(half => writeBlock(half, index)));
      if (halfParts.every((part): part is string => Boolean(part))) return mergeHalfBlockShells(halfParts[0], halfParts[1], block.title);
      // 稳定版：一半成稿时保留成功半块，失败半块逐要点走小节级管线兜底（要点级目标字数小、成功率远高于整块，
      // 小节级输出自带质检反馈循环）。全部要点成稿即拼回；仍有失败才放弃整块（达标契约拒绝静默成文，
      // 失败半块的残缺正文不得并入成稿）。历史缺陷：拆半一个半块失败即整块 undefined → 章失败，
      // 已成功的半块内容被一并作废，章级修复链根本没机会跑。
      const salvageHalf = async (halfBlock: (typeof halfBlocks)[number], partIndex: number): Promise<string | undefined> => {
        if (halfParts[partIndex]) return halfParts[partIndex];
        const perPointTarget = Math.max(600, Math.floor(halfBlock.targetWords / Math.max(1, halfBlock.subPoints.length)));
        const perPointAttempts = Math.max(1, sectionSupplementAttempts(halfBlock.subPoints.length));
        const settled = await Promise.all(halfBlock.subPoints.map(point => buildQualifiedSectionSupplement({
          template: input.template,
          chapter: input.chapter,
          sectionTitle: point.title,
          evidence: input.evidence,
          missingFacts: input.missingFacts,
          promptTexts: input.promptTexts,
          projectContext: input.projectContext,
          requirement: input.requirement,
          roleContext: input.roleContext || '',
          targetWords: perPointTarget,
          forbidDrawingImages: input.forbidDrawingImages,
          factCoverageContext: input.factCoverageContext,
          compactProjectContext: input.compactProjectContext,
          scopedProjectContext: input.scopedProjectContext,
          blueprintDataText: input.blueprintDataText,
          blueprintSliceText: input.blueprintSliceText,
          signal: input.signal,
          diagnostics: input.diagnostics,
        }, perPointAttempts)));
        if (!settled.every(Boolean)) return undefined;
        const pointSections = settled.map((section, pointIndex) => {
          const body = (section || '').replace(/^###\s+.+$/mu, '').trim();
          return `#### ${halfBlock.subPoints[pointIndex].title}\n\n${body}`;
        });
        return `### ${halfBlock.title}\n\n${pointSections.join('\n\n')}`;
      };
      const salvaged = [await salvageHalf(halfBlocks[0], 0), await salvageHalf(halfBlocks[1], 1)];
      if (salvaged.every((part): part is string => Boolean(part))) return mergeHalfBlockShells(salvaged[0], salvaged[1], block.title);
      if (input.diagnostics) input.diagnostics.llm.lastError = `规划块拆半后仍未成稿：${block.title}`;
      console.error(`[gen][block-qc] 拆半后仍未成稿: ${block.title}（一半=${salvaged[0] ? '成稿' : '失败'}，二半=${salvaged[1] ? '成稿' : '失败'}，目标 ${block.targetWords} 字，要点 ${block.subPoints.length} 个）`);
    }
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
  if (results.every(content => !content)) return undefined;
  const failedBlocks = blocks
    .map((block, index) => ({ index, block }))
    .filter(({ index }) => !results[index]);
  // 章级相邻同标题块 H3 外壳合并：规划层拆半（splitSinglePointOversizedBlocks）两半块共享标题，
  // 拼接时剥离后块开头的同标题 H3（内容续接同一小节），目录不出现「XX（一）（二）」防撞名
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
    input.diagnostics.llm.lastError = `规划块部分失败：${failedBlocks.map(({ block }) => block.title).join('、')}`;
  }
  return { sections: results, failedBlocks, allSucceeded: false, markdown };
}
