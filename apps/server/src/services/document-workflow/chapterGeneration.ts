import * as path from 'node:path';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentDraftChapter, DocumentEvidence, DocumentFact, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ResolvedFactNeed, ValidationIssue } from './types';
import type { DocumentBudget } from './budget';
import { documentTextLength } from './budget';
import { buildEvidenceBundle, cleanEvidenceText, evidenceBundlePrompt, evidencePromptBudgetForTarget } from './evidence';
import { FORMAL_WRITING_RULES, SECTION_GENERATION_SAFETY_RULES, removeUnwantedDrawingImages, sanitizeFormalMarkdown } from './markdownComposer';
import { callDocumentLlm, getDocumentLlmFailureStreak } from './llmClient';
import { stringifyFactValue, throwIfAborted } from './utils';
import { selectByScore, factImportanceScore } from './selection';
import { measureGenerationStep } from './rolePipeline';
import { normalizePlannedSections, professionalSectionTaskCard } from './promptRuleExtraction';
import { tablePlansPrompt } from './constructionOrgTablePlan';
import { constructionOrgBonusModulePrompt, constructionOrgChapterRulePrompt } from './constructionOrgQualityRules';
import { buildProcessKnowledgePrompt, matchProcessKnowledgeCards } from './constructionProcessKnowledge';
import { criticalSectionBlockerMinChars, ensureGroupTertiaryShell, ensureTertiarySectionShell, groupHasMajorConstructionSection, isCriticalDeepSection, isGeneralManagementSection, keySectionWritingRequirement, mergeDuplicateWorkPackageSubsections, outputTokensForChapter, parseMajorConstructionPackages, sectionContentBody, sectionStructureIssue } from './chapterPostProcessing';
import { HAS_QUANTIFIED_VALUE_RE, PRECISE_TOKEN_RE, QUANTIFIED_FACT_RE } from './parameterPatterns';

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

function extractChapterPreciseTokens(evidence: DocumentEvidence[]) {
  const tokens = new Set<string>();
  for (const item of evidence) {
    const content = stringifyFactValue(item.content).replace(/\s+/gu, ' ');
    if (/报价明细|投标报价|单价|合价|综合单价|预留金|税率|增值税|利润|结算/u.test(content) && !/合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(content)) continue;
    if (/OCR|识别错误|乱码|无法确认|疑似|不确定|语义断裂/u.test(content)) continue;
    for (const match of content.matchAll(PRECISE_TOKEN_RE)) tokens.add(match[0].trim());
    if (tokens.size >= 40) break;
  }
  return [...tokens].slice(0, 40);
}

export function buildChapterFactCoverageContext(input: { chapter: DocumentTemplateChapter; plan?: { requiredContents?: string[]; evidenceNeeds?: string[] }; spec?: AutoDocumentSpecPackage; roleFacts: Array<{ fact: { key: string; value: unknown } }>; evidence: DocumentEvidence[]; missingFacts: string[]; indexedFacts?: DocumentFact[]; resolvedFactNeeds?: ResolvedFactNeed[]; factNeedsPrompt?: string }) {
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
  // 用评分函数选择最重要的全局事实（而非硬截断前 40 个）
  const allIndexedFacts = input.indexedFacts || [];
  const indexedFactSelection = selectByScore(
    allIndexedFacts,
    f => factImportanceScore(f),
    { maxItems: 48, maxChars: 12000 },
    'indexedFacts',
  );
  const indexedFactLines = resolvedFacts.length > 0
    ? []
    : indexedFactSelection.selected.map(fact => `- ${fact.key || fact.fieldName || '资料事实'}：${cleanEvidenceText(stringifyFactValue(fact.value)).slice(0, 180)}${fact.sourceFile ? `（来源：${fact.sourceFile.split('/').pop()}）` : ''}`);
  const droppedIndexedNote = indexedFactSelection.dropped.length > 0
    ? [`⚠️ ${indexedFactSelection.dropped.length} 个低优先级事实未列出（完整列表见事实主表）`]
    : [];
  const projectBasicFacts = [...resolvedFacts, ...allIndexedFacts]
    .filter(fact => /建设地点|建设规模|招标范围|计划工期|合同工期|周期要求|质量标准|合同估算|投资估算|最高投标限价|招标控制价/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`))
    .filter((fact, index, array) => array.findIndex(item => `${item.key || item.fieldName}:${stringifyFactValue(item.value)}` === `${fact.key || fact.fieldName}:${stringifyFactValue(fact.value)}`) === index);
  // 精确参数：保留所有数值事实，限制连接后的总字符数不超过 3000
  const preciseTokensAll = [...new Set([...extractChapterPreciseTokens(input.evidence), ...resolvedFacts.map(fact => stringifyFactValue(fact.value)).filter(value => HAS_QUANTIFIED_VALUE_RE.test(value)), ...allIndexedFacts.map(fact => stringifyFactValue(fact.value)).filter(value => HAS_QUANTIFIED_VALUE_RE.test(value))])];
  let preciseChars = 0;
  const preciseTokens: string[] = [];
  for (const t of preciseTokensAll) {
    if (preciseChars + t.length > 3000 && preciseTokens.length >= 10) break;
    preciseTokens.push(t);
    preciseChars += t.length + 1;
  }
  const evidenceSourceCount = new Set([...input.evidence.map(item => item.filePath), ...resolvedFacts.map(item => item.sourceFile), ...(input.indexedFacts || []).map(item => item.sourceFile)]).size;
  const unresolvedNeeds = (input.resolvedFactNeeds || []).filter(item => item.status !== 'satisfied' && item.need.required).map(item => item.need.label);
  return [
    '【本章事实覆盖与参数落位要求】',
    requiredFacts.length ? `必须优先覆盖的事实/要求：\n${requiredFacts.map(item => `- ${item}`).join('\n')}` : '',
    roleFactLines.length ? `角色节点已抽取事实：\n${roleFactLines.join('\n')}` : '',
    projectBasicFacts.length ? `项目基础事实卡片（资料已明确，项目概况、项目基本信息表、进度和质量相关内容必须优先使用，不得输出任何占位话术）：\n${projectBasicFacts.map(fact => `- ${fact.key || fact.fieldName}：${cleanEvidenceText(stringifyFactValue(fact.value)).slice(0, 220)}${fact.sourceFile ? `（来源：${fact.sourceFile.split('/').pop()}）` : ''}`).join('\n')}\n项目基本信息表必须使用固定表头：| 信息项 | 内容 |，不得使用“序号｜项目名称｜内容参数”表头，不得输出后台溯源列。` : '',
    input.factNeedsPrompt || '',
    indexedFactLines.length ? `全局资料事实索引匹配到的本章可写事实：\n${indexedFactLines.join('\n')}` : '',
    preciseTokens.length ? `本章资料中可直接使用的可靠精确参数/编号：${preciseTokens.join('、')}。这些参数来自绑定资料，不属于编造；涉及对应对象、部位、工序、材料、设备、项目概况、质量验收或安全控制时必须自然写入正文，并保持原样或等价专业表达。项目基础事实中的合同估算价、计划工期可用于项目概况；不得写入报价明细、单价、税率、预留金。` : '',
    unresolvedNeeds.length ? `当前事实需求仍未充分确认：${unresolvedNeeds.join('、')}。未确认项不得编造；但已满足事实需求中的资料事实必须写入对应小节。` : '',
    input.missingFacts.length ? `模板显式要求中当前检索未充分命中的项：${input.missingFacts.join('、')}。未命中项不得编造，但不得因此省略上方已经明确的可靠参数。` : '',
    `本章可用材料来源约 ${evidenceSourceCount} 个文件，正文必须按事实需求把可用事实内化到对应小节，不得单列后台资料清单。`,
    ...droppedIndexedNote,
  ].filter(Boolean).join('\n');
}

/** 使用 LLM 生成单章内容，基于证据包、提示词角色和用户需求 */
export async function buildLlmChapterContent(template: DocumentTemplate, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[], promptTexts: string, projectContext: string, requirement?: string, roleContext = '', options: { forbidDrawingImages?: boolean; minWords?: number; targetWords?: number; maxWords?: number; maxTokens?: number; factCoverageContext?: string; signal?: AbortSignal; userWriterRules?: string; diagnostics?: DocumentGenerationDiagnostics } = {}) {
  const bundle = buildEvidenceBundle(chapter, evidence);
  const evidenceText = evidenceBundlePrompt(bundle, { maxChars: evidencePromptBudgetForTarget(options.targetWords || options.minWords) });
  // 即使 evidenceText 和 roleContext 为空，也让 LLM 基于 projectContext 和 promptTexts 尝试生成
  const sectionInstruction = chapter.sections?.length
    ? `本章小节由生成前规划得到，请完整包含并展开以下小节：\n${chapter.sections.map(section => `- ${section}`).join('\n')}`
    : '本章没有预设小节；请按用户提示词、模板章节、角色要求和绑定材料自然组织正文。';
  const sectionBudgetInstruction = buildSectionBudgetInstruction(chapter, options.targetWords || options.minWords || 0);
  const tablePlanInstruction = tablePlansPrompt(chapter);
  const constructionOrgRuleInstruction = constructionOrgChapterRulePrompt(chapter);
  const constructionOrgBonusInstruction = constructionOrgBonusModulePrompt(chapter);
  const system = [
    FORMAL_WRITING_RULES,
    options.forbidDrawingImages ? '图片类材料只作为文本事实依据；禁止插入图片或 Markdown 图片语法。' : '',
    promptTexts,
  ].filter(Boolean).join('\n\n');
  const prompt = [
    `文档模板：${template.name}`,
    `章节标题：${chapter.title}`,
    `章节目的：${chapter.purpose}`,
    sectionInstruction,
    sectionBudgetInstruction,
    tablePlanInstruction,
    constructionOrgRuleInstruction,
    constructionOrgBonusInstruction,
    requirement ? `用户要求：${requirement}` : '',
    projectContext ? `上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${projectContext}` : '',
    roleContext ? roleContext : '',
    options.factCoverageContext || '',
    missingFacts.length ? `需要特别补足的信息：${missingFacts.join('、')}` : '',
    '请生成可直接导出的 Markdown 章节，要求：',
    `- 保留章节标题；内容不少于 ${options.minWords || 1000} 字${options.targetWords ? `，目标约 ${options.targetWords} 字` : ''}${options.maxWords ? `，最多不超过 ${options.maxWords} 字` : ''}。`,
    chapter.sections?.length ? '- 必须完整包含已规划小节；不要新增未规划的二级小节。' : '- 未预设小节时，不要为了凑结构强行新增小节。',
    chapter.tablePlans?.length ? '- 本章存在结构化表格规划时，必须输出正式 Markdown 表格；表头必须严格使用规划字段，不得擅自改字段、删字段或增加后台溯源列。' : chapter.tableSections?.length ? `- 以下小节可使用表格辅助表达：${chapter.tableSections.join('、')}。` : '',
    chapter.tablePlans?.length ? '- 表格字段值必须优先来自项目图谱、可信事实和绑定材料；projectFactOnly 字段不得编造，也不得写任何固定占位话术。' : '',
    '- 内容必须遵循用户提示词、模板章节、提示词角色、项目资料包和自动识别的资料类型；不得编造材料未提供的项目专属事实；法律法规名称、标准规范编号等公共知识可依据现行有效版本直接引用。',
    '- 将材料要点自然融入正文；不要输出系统证据清单、中间分析过程或后台流程话术。',
    SECTION_GENERATION_SAFETY_RULES,
    '',
    evidenceText ? '绑定材料：' : '',
    evidenceText,
    options.userWriterRules ? `\n【用户写作指令——必须严格遵守】\n${options.userWriterRules}` : '',
  ].filter(Boolean).join('\n');
  const content = await callDocumentLlm(system, prompt, false, { maxTokens: options.maxTokens, signal: options.signal, diagnostics: options.diagnostics });
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
    ...targets.map(item => `- ${item.title}：约 ${item.targetWords} 字，至少达到 ${Math.floor(item.targetWords * 0.8)} 字，并写入与该小节相关的材料事实、适用边界和必要说明。`),
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
    .slice(0, 12)
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
  prompt: string;
}

const DETAIL_FACT_RE = /计划工期|合同工期|建设地点|建设规模|质量标准|招标范围|施工范围|工作内容|项目特征|材料|设备|规格|型号|数量|单位|做法|节点|系统|管径|标高|尺寸|厚度|强度|等级|验收|检测|试验|安全|文明|扬尘|环保|消防|临时用电|临水|排水|交叉施工|地下管线|有限空间|危大|专项方案|专家论证|进度节点|保修|移交/iu;
const COMMERCIAL_SENSITIVE_RE = /报价明细|综合单价|税率|增值税|利润|结算|预留金|暂列金额|暂估价/u;
const ALLOWED_COMMERCIAL_FACT_RE = /合同估算价|合同估算价格|投资估算|估算价格|工程估算价|最高投标限价|招标控制价/u;

function normalizeFactUsageText(value: string) {
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
  if (/投标人|第二章投标人须知|不得存在|报价|中标后不予调整|清单不再单独列项|自行踏勘|罚款|违约金额|元\/条|注册建造师|安全生产考核合格证书|安全生产许可证|营业执照|联合体投标|项目经理要求|投标人资格|投标人资质|资质要求|资格审查|资格后审|业绩要求|信誉要求|财务要求|中标通知书|签订合同|评标办法|电子交易系统|踏勘现场|投标预备会/u.test(line)) return true;
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

export function buildSectionFactCard(sectionTitle: string, evidence: DocumentEvidence[]): SectionFactCard {
  const items: SectionFactCardItem[] = [];
  const seen = new Set<string>();
  const sectionTokens = tokenizeForRelevance(sectionTitle).filter(token => token.length >= 2);
  for (const item of evidence) {
    for (const rawLine of stringifyFactValue(item.content).split(/\r?\n/u)) {
      const line = cleanFactLine(rawLine);
      if (line.length < 4 || line.length > 280) continue;
      if (isNoisyFactLine(line)) continue;
      if (COMMERCIAL_SENSITIVE_RE.test(line) && !ALLOWED_COMMERCIAL_FACT_RE.test(line)) continue;
      const quantified = QUANTIFIED_FACT_RE.test(line);
      const detailed = DETAIL_FACT_RE.test(line);
      const sectionRelated = sectionTokens.some(token => line.includes(token));
      if (!quantified && !detailed && !sectionRelated) continue;
      const key = normalizeFactUsageText(line).slice(0, 160);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ text: line, sourceFile: item.filePath, roleId: item.roleId, quantified });
      if (items.length >= 16) break;
    }
    if (items.length >= 16) break;
  }
  const lines = items.map(item => `- ${item.text}（来源：${path.basename(item.sourceFile)}${item.roleId ? `，角色：${item.roleId}` : ''}）`);
  return {
    items,
    quantifiedCount: items.filter(item => item.quantified).length,
    prompt: lines.length ? `【当前小节写作任务卡】\n小节：${sectionTitle}\n必须优先落位的资料事实：\n${lines.join('\n')}\n成稿要求：1）至少自然写入其中 2 条资料事实；2）如存在数字、规格、标准编号、数量、工期，必须至少原样写入 1 条；3）围绕“资料依据—对象范围—实施做法—检查验收/闭环”展开，不得写成“结合实际、按规范执行”的泛化空话；4）不得改写、换算或编造资料未提供的参数。` : '',
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

/** 小节级调用的紧凑上下文：优先保留结构化事实行与蓝图约束行，避免每个小节重复携带全量全局叙述 */
function compactSectionProjectContext(projectContext: string, maxChars = 2000) {
  const lines = projectContext.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const structured = lines.filter(line => /【.+】/u.test(line) || /=/u.test(line) || /^\d+\.\s+/u.test(line) || /：\S{1,40}$/u.test(line));
  const keep = structured.length >= 8 ? structured : lines;
  const compact = keep.join('\n').trim();
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars)}\n（上下文已截断，完整信息见绑定材料与证据）`;
}

export async function buildLlmSectionContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; sectionTitle: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; qualityFeedback?: string; compactProjectContext?: boolean; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; timeoutMs?: number }) {
  const sectionEvidence = evidenceForSection(input.sectionTitle, input.chapter, input.evidence);
  const sectionFactCard = buildSectionFactCard(input.sectionTitle, sectionEvidence);
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, sectionEvidence), { maxChars: evidencePromptBudgetForTarget(input.targetWords, 3500, 9000) });
  // 工作包级小节：从项目图谱/上下文识别工作包，匹配工艺知识卡，注入工序链与工艺参数参考
  const majorConstructionPackages = /项目主要施工内容/u.test(input.sectionTitle) ? parseMajorConstructionPackages(input.projectContext, sectionEvidence) : [];
  const processKnowledgeCards = majorConstructionPackages.length > 0 ? matchProcessKnowledgeCards(majorConstructionPackages.map(pkg => pkg.name)) : [];
  const processKnowledgePrompt = processKnowledgeCards.length > 0 ? buildProcessKnowledgePrompt(processKnowledgeCards, majorConstructionPackages.map(pkg => pkg.name)) : '';
  const prompt = [
    `文档模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    `当前二级小节：${input.sectionTitle}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `上下文：\n${input.compactProjectContext ? compactSectionProjectContext(input.projectContext) : input.projectContext}` : '',
    input.factCoverageContext || '',
    professionalSectionTaskCard(input.chapter.title, input.sectionTitle),
    sectionFactCard.prompt,
    input.roleContext,
    input.missingFacts.length ? `需要特别补足的信息：${input.missingFacts.join('、')}` : '',
    input.qualityFeedback ? `上轮小节未通过质量检查，必须修正：${input.qualityFeedback}` : '',
    /项目主要施工内容/u.test(input.sectionTitle) ? '【项目主要施工内容专项结构】只能根据绑定材料中的当前项目事实识别施工对象和工作包；不得套用固定行业模板，不得复述完整工程概况，不得写“以图纸清单为准”式空话；不得使用 Markdown 表格。必须按专业工程/分部分项工程逐项展开，每项使用“#### 工作包名称”作为三级小节标题，并固定包含“施工概况：”“施工流程：”“施工方法：”三段。工作包小节必须与上下文“主要施工工作包”列表一一对应，每个工作包只允许展开一次；严禁把同一个工作包以“X工程”“X工作包”两种口径重复写成两个小节，也不得新增图谱之外的工作包小节。施工概况必须写该工作包对应的本项目作业对象、部位、规模/工程量、材料设备或系统边界，写成连贯叙述段落，不得出现“1．xxx 2．xxx”编号清单或“xxx｜工程量”式清单原文罗列；施工流程必须使用“→”串联关键工序；施工方法必须写成连贯叙述，落到具体工具机具、测量/检测方法、工艺参数、材料规格、穿插关系、质量验收、复试检测和资料闭环，方法叙述中的连续工序序列同样用“→”串联（如“基层清理→放线定位→分层摊铺→碾压→压实度检测→验收”），每个工作包的方法段正文至少 1 条不少于 4 个环节的箭头工序链，不得只把箭头局限在施工流程行；每个工作包施工方法必须落位至少 3 个具体工艺参数（厚度、间距、偏差、含水率、饱满度、坡度、压实度等），参数来自绑定材料或行业通用规范值，禁止“按规范施工”“结合实际执行”式空话，严禁把工程量清单条目原样罗列成“xxx：2台；xxx：1台；”式参数堆砌。施工方法写法样例（句式参照，内容按本项目事实替换）：“配电箱采用挂墙方式安装，箱体中心距地1.5m，盘面垂直度偏差不超过1.5/1000；柜内元器件按系统图接线，导线分色标识，接线紧固力矩按规格控制；安装完成后进行绝缘电阻测试并形成通电试运行记录。”至少形成 5 个施工工作包，工作包必须来自绑定材料证据。' : '',
    /主要分部分项工程施工方案/u.test(input.sectionTitle) ? '【主要分部分项工程施工方案专项要求】每个“#### 分项工程方案”三级小节必须包含施工概况（本项目作业对象、部位、工程量）、工艺流程（用“→”串联关键工序）和施工方法（工具机具、材料规格、验收标准）。施工方法叙述中的连续工序序列同样用“→”串联（如“基层清理→放线定位→分层摊铺→碾压→压实度检测→验收”），每个分项方案的方法段正文至少 1 条不少于 4 个环节的箭头工序链，不得只把箭头局限在工艺流程行；每个分项方案正文必须落位至少 4 个工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定材料或行业通用规范值，不得编造；纯设备配置型小节必须写型号、规格、容量、数量参数；不得写“按规范施工”“结合实际执行”式空话。' : '',
    processKnowledgePrompt,
    `请只生成当前节内容，使用“### ${input.sectionTitle}”作为节标题；正文必须下沉到若干“#### 三级小节标题”下面，不得在 ### 标题后直接写大段正文。目标约 ${input.targetWords} 字${input.maxWords ? `，最多不超过 ${input.maxWords} 字` : ''}。`,
    '本章节结构已由系统按模板和提示词锁定；不得删除、重命名、合并或重排当前节标题；每个节下必须自然展开三级小节，三级小节承载正文。',
    SECTION_GENERATION_SAFETY_RULES,
    evidenceText ? `绑定材料：\n${evidenceText}` : '',
  ].filter(Boolean).join('\n\n');
  const llmCall = () => callDocumentLlm([
    '你是专业文档的小节生成专家。',
    FORMAL_WRITING_RULES,
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), prompt, false, { maxTokens: Math.min(outputTokensForChapter(input.targetWords), Math.max(1800, Math.ceil(input.targetWords * 1.8))), temperature: 0.25, signal: input.signal, diagnostics: input.diagnostics });
  const content = input.diagnostics
    ? await measureGenerationStep(input.diagnostics, `section-draft:${input.chapter.id}:${input.sectionTitle}`, llmCall)
    : await llmCall();
  if (!content || content.length < 80) return undefined;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('### ') ? content : `### ${input.sectionTitle}\n\n${content}`, input.forbidDrawingImages));
  const normalizedContent = normalized.replace(/^##\s+.*\n+/u, '').trim();
  const structureIssue = sectionStructureIssue(input.sectionTitle, normalizedContent);
  if (structureIssue) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `${structureIssue}：${input.chapter.title} / ${input.sectionTitle}`;
    return undefined;
  }
  const criticalMinChars = criticalSectionBlockerMinChars(input.sectionTitle);
  // 单次任务的最小字数不得超过任务目标字数：任务拆分会把小节拆成多个 targetWords≈800 的主题任务，
  // 此时全局 criticalMinChars（如 1800）远大于任务目标，每个任务都无法达标而被整体拒绝，反而产出空小节。
  const minSectionChars = Math.min(Math.max(Math.floor(input.targetWords * 0.7), criticalMinChars), Math.max(500, input.targetWords));
  if (isCriticalDeepSection(input.sectionTitle) && documentTextLength(normalizedContent) < minSectionChars) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `section writer 正文不足：${input.chapter.title} / ${input.sectionTitle} / ${documentTextLength(normalizedContent)}/${minSectionChars}字`;
    return undefined;
  }
  // “项目主要施工内容”节去重：LLM 可能把同一工作包按“X工程”“X工作包”两遍展开，确定性合并删除重复小节
  const finalContent = /项目主要施工内容/u.test(input.sectionTitle) ? mergeDuplicateWorkPackageSubsections(normalizedContent) : normalizedContent;
  return ensureTertiarySectionShell(input.sectionTitle, finalContent);
}

interface SectionWritingTask {
  sectionTitle: string;
  taskTitle: string;
  targetWords: number;
  index: number;
  total: number;
}

function writingTopicTitle(sectionTitle: string, index: number, total: number) {
  if (/项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle)) return ['项目特点与基础事实', '施工重点识别', '施工难点成因与影响', '应对措施与责任闭环', '重点难点与施工内容对应关系'][index % 5];
  if (/项目主要施工内容/u.test(sectionTitle)) return ['专业工程工作包识别与施工概况', '专业工程施工流程', '专业工程施工方法', '工程量参数与资源穿插', '验收检测与资料闭环'][index % 5];
  if (/主要分部分项工程施工方案|主要施工方法/u.test(sectionTitle)) return ['当前项目分部分项对象', '主要工艺流程与施工顺序', '材料设备与参数控制', '质量安全控制点', '验收移交与资料闭环'][index % 5];
  const lower = sectionTitle.toLowerCase();
  const generic = ['资料依据与适用范围', '对象范围与关键参数', '实施方法与组织安排', '质量安全控制要求', '检查验收与闭环管理'];
  const resource = ['资源配置依据', '材料设备规格与数量', '进场组织与保管要求', '使用调配与过程核验', '验收记录与动态调整'];
  const technical = ['施工准备与技术依据', '主要工艺流程', '材料设备与参数控制', '质量验收要点', '成品保护与问题处置'];
  const safety = ['风险识别与控制边界', '防护设施与作业条件', '人员设备安全管理', '检查频次与整改闭环', '应急响应与资料留存'];
  const quality = ['质量目标与验收依据', '过程控制点', '材料设备复核', '检验批与验收资料', '问题整改与成品保护'];
  const topics = /资源|材料|设备|人材机/u.test(sectionTitle) ? resource
    : /施工|工艺|技术|安装|土建|结构|给排水|电气/u.test(sectionTitle) || /method|technical/u.test(lower) ? technical
      : /安全|文明|危大|风险/u.test(sectionTitle) ? safety
        : /质量|验收|标准/u.test(sectionTitle) ? quality
          : generic;
  return total <= 1 ? sectionTitle : `${sectionTitle}：${topics[index % topics.length]}`;
}

function writingTasksForSection(sectionTitle: string, targetWords: number): SectionWritingTask[] {
  if (/项目主要施工内容/u.test(sectionTitle)) return [{ sectionTitle, taskTitle: sectionTitle, targetWords: Math.max(targetWords, 2200), index: 1, total: 1 }];
  const maxTaskWords = isCriticalDeepSection(sectionTitle) ? 760 : Math.max(1400, Math.floor(Number(process.env.DOCUMENT_WRITING_TASK_MAX_WORDS ?? 2800)));
  const taskCount = isCriticalDeepSection(sectionTitle) ? Math.max(3, Math.ceil(targetWords / maxTaskWords)) : targetWords > maxTaskWords * 1.5 ? Math.ceil(targetWords / maxTaskWords) : 1;
  const perTask = Math.max(800, Math.ceil(targetWords / taskCount));
  if (taskCount <= 1) return [{ sectionTitle, taskTitle: sectionTitle, targetWords, index: 1, total: 1 }];
  return Array.from({ length: taskCount }, (_, index) => ({
    sectionTitle,
    taskTitle: writingTopicTitle(sectionTitle, index, taskCount),
    targetWords: perTask,
    index: index + 1,
    total: taskCount,
  }));
}

async function buildFocusedSectionDraft(input: Parameters<typeof buildLlmSectionContent>[0]) {
  const sectionEvidence = (isGeneralManagementSection(input.sectionTitle)
    ? [...evidenceForSection(input.sectionTitle, input.chapter, input.evidence), ...input.evidence]
    : evidenceForSection(input.sectionTitle, input.chapter, input.evidence))
    .filter((item, index, array) => array.findIndex(candidate => candidate.filePath === item.filePath && candidate.content === item.content) === index)
    .slice(0, 24);
  const sectionFactCard = buildSectionFactCard(input.sectionTitle, sectionEvidence);
  const evidenceText = sectionEvidence
    .map((item, index) => `${index + 1}. ${cleanEvidenceText(item.content).slice(0, 520)}`)
    .filter(Boolean)
    .join('\n');
  const previousLastError = input.diagnostics?.llm.lastError;
  const content = await callDocumentLlm([
    '你是专业文档节内小节 Writer。只生成一个指定节，不生成整章。',
    FORMAL_WRITING_RULES,
    SECTION_GENERATION_SAFETY_RULES,
    '必须直接输出 Markdown：先输出指定 ### 节标题，再在其下生成若干 #### 三级小节承载正文；不得在 ### 后直接写大段正文；不得解释过程，不得输出资料不足、待确认、兜底等话术。',
  ].join('\n\n'), [
    `章节标题：${input.chapter.title}`,
    `指定节标题：### ${input.sectionTitle}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    professionalSectionTaskCard(input.chapter.title, input.sectionTitle),
    keySectionWritingRequirement(input.sectionTitle),
    sectionFactCard.prompt,
    `目标正文约 ${input.targetWords} 字，最多 ${input.maxWords || Math.ceil(input.targetWords * 1.18)} 字。正文必须分布在 #### 三级小节下，包含对象范围、执行措施、检查验收和资料闭环；没有精确数值时写正式过程控制，不编造数值。`,
    '禁止写“根据/依据招标文件、补疑澄清文件、工程量清单及设计图纸”等资料来源罗列话术；直接写项目事实、施工内容、控制措施和验收要求。',
    isGeneralManagementSection(input.sectionTitle) ? '该小节属于施工组织设计通用管理小节：允许基于项目基础事实、招标范围、工期质量目标、现场组织要求和施工总承包管理逻辑形成正式措施，但不得编造具体姓名、品牌、型号、金额或不存在的日期。' : '',
    input.qualityFeedback || '',
    evidenceText ? `压缩证据：\n${evidenceText}` : '',
  ].filter(Boolean).join('\n\n'), false, {
    maxTokens: Math.min(4800, Math.max(2200, Math.ceil(input.targetWords * 1.65))),
    temperature: 0.2,
    signal: input.signal,
    diagnostics: input.diagnostics,
  });
  if (!content || content.length < 40) {
    const currentLastError = input.diagnostics?.llm.lastError;
    const localError = currentLastError && currentLastError !== previousLastError ? currentLastError : '空响应';
    if (input.diagnostics) input.diagnostics.llm.lastError = `focused writer 无正文：${input.chapter.title} / ${input.sectionTitle} / ${localError}`;
    return undefined;
  }
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('### ') ? content : `### ${input.sectionTitle}\n\n${content}`, input.forbidDrawingImages));
  const body = sectionContentBody(normalized);
  if (body.length < 40) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `focused writer 正文过短：${input.chapter.title} / ${input.sectionTitle} / ${body.length}字`;
    return undefined;
  }
  const structureIssue = sectionStructureIssue(input.sectionTitle, normalized);
  if (structureIssue) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `focused writer ${structureIssue}：${input.chapter.title} / ${input.sectionTitle}`;
    return undefined;
  }
  return ensureTertiarySectionShell(input.sectionTitle, normalized.replace(/^##\s+.*\n+/u, '').trim());
}
async function supplementSectionContent(input: Parameters<typeof buildLlmSectionContent>[0] & { currentContent: string; targetWords: number }) {
  const currentLength = documentTextLength(input.currentContent);
  const safeMinChars = criticalSectionBlockerMinChars(input.sectionTitle);
  const effectiveTargetWords = Math.max(input.targetWords, safeMinChars);
  const missing = effectiveTargetWords - currentLength;
  const sectionEvidence = evidenceForSection(input.sectionTitle, input.chapter, input.evidence);
  const sectionFactCard = buildSectionFactCard(input.sectionTitle, sectionEvidence);
  if (missing <= Math.max(260, Math.floor(input.targetWords * 0.12))) return input.currentContent;
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, sectionEvidence), { maxChars: evidencePromptBudgetForTarget(Math.min(input.targetWords, 2600), 3500, 9000) });
  const patchTarget = Math.max(500, missing);
  const patch = await callDocumentLlm([
    '你是专业文档小节补写专家。只做补写，不重写全文。',
    FORMAL_WRITING_RULES,
    '必须保留已有正文中的事实、参数、编号和结构；只补充缺口段落，不删除、不压缩已有内容。',
    SECTION_GENERATION_SAFETY_RULES,
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `章节标题：${input.chapter.title}`,
    `当前小节：${input.sectionTitle}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.factCoverageContext || '',
    professionalSectionTaskCard(input.chapter.title, input.sectionTitle),
    sectionFactCard.prompt,
    `当前小节约 ${currentLength} 字，目标约 ${input.targetWords} 字，本轮补充约 ${patchTarget} 字。`,
    '请输出可直接追加或插入到本小节的补充段落；不要重复小节标题，不要解释生成过程；优先使用绑定资料中的事实和量化参数，不得输出“该小节围绕”等模板化占位句。',
    evidenceText ? `绑定材料：\n${evidenceText}` : '',
    `已有小节正文：\n${sectionContentBody(input.currentContent).slice(0, 12000)}`,
  ].filter(Boolean).join('\n\n'), false, { maxTokens: outputTokensForChapter(patchTarget), temperature: 0.25, signal: input.signal, diagnostics: input.diagnostics });
  const normalizedPatch = sanitizeFormalMarkdown(removeUnwantedDrawingImages(patch || '', input.forbidDrawingImages)).replace(/^#{3,4}\s+.*\n+/u, '').trim();
  return normalizedPatch ? `${input.currentContent.trim()}\n\n${normalizedPatch}` : input.currentContent;
}
async function buildTaskBasedSectionContent(input: Parameters<typeof buildLlmSectionContent>[0]) {
  if (isGeneralManagementSection(input.sectionTitle)) {
    const focused = await buildFocusedSectionDraft({
      ...input,
      targetWords: Math.max(620, Math.floor(input.targetWords * 0.75)),
      maxWords: Math.ceil(Math.max(620, Math.floor(input.targetWords * 0.75)) * 1.22),
      qualityFeedback: `本小节使用 focused writer 优先成稿。必须直接输出“### ${input.sectionTitle}”及正式正文。`,
    }).catch(error => {
      if (input.diagnostics) input.diagnostics.llm.lastError = `focused writer 异常：${input.chapter.title} / ${input.sectionTitle} / ${error instanceof Error ? error.message : String(error)}`;
      return undefined;
    });
    if (focused) return sanitizeFormalMarkdown(removeUnwantedDrawingImages(focused, input.forbidDrawingImages));
  }
  const tasks = writingTasksForSection(input.sectionTitle, input.targetWords);
  const parts: string[] = [];
  for (const task of tasks) {
    throwIfAborted(input.signal);
    let taskContent: string | undefined;
    const maxAttempts = task.total > 1 ? 2 : 3;
    for (let attempt = 0; attempt < maxAttempts && !taskContent; attempt += 1) {
      const retryTargetWords = attempt === 0 ? task.targetWords : Math.max(560, Math.floor(task.targetWords * (attempt === 1 ? 0.85 : 0.7)));
      try {
        taskContent = await buildLlmSectionContent({
          ...input,
          sectionTitle: task.sectionTitle,
          targetWords: retryTargetWords,
          maxWords: Math.ceil(retryTargetWords * 1.18),
          qualityFeedback: [
            task.total > 1 ? `这是首轮生成的主题任务 ${task.index}/${task.total}，只聚焦“${task.taskTitle}”。不得重复同小节其他主题的通用表述；优先写入与本主题相关的资料事实、规格、数量、标准、检查要求和执行动作。` : input.qualityFeedback,
            attempt > 0 ? `上一轮未生成有效正文${input.diagnostics?.llm.lastError ? `（被拒原因：${input.diagnostics.llm.lastError}）` : ''}。本轮必须直接输出“### ${input.sectionTitle}”及正式正文，逐条修正被拒原因，优先完成可审查、可落位事实的核心内容。` : ''
          ].filter(Boolean).join('\n'),
        });
      } catch {
        taskContent = undefined;
      }
      if (!taskContent && attempt === maxAttempts - 1) {
        try {
          taskContent = await buildFocusedSectionDraft({
            ...input,
            sectionTitle: task.sectionTitle,
            targetWords: Math.max(520, Math.floor(retryTargetWords * 0.85)),
            maxWords: Math.ceil(Math.max(520, Math.floor(retryTargetWords * 0.85)) * 1.18),
            qualityFeedback: `前序 Writer 未完成${input.diagnostics?.llm.lastError ? `（被拒原因：${input.diagnostics.llm.lastError}）` : ''}。本轮使用轻量定向 Writer，只完成“${input.sectionTitle}”正式正文，逐条修正被拒原因。`,
          });
        } catch (error) {
          if (input.diagnostics) input.diagnostics.llm.lastError = `focused writer 后置异常：${input.chapter.title} / ${task.sectionTitle} / ${error instanceof Error ? error.message : String(error)}`;
          taskContent = undefined;
        }
      }
    }
    if (taskContent) parts.push(sectionContentBody(taskContent));
  }
  if (parts.length === 0) {
    // 全部任务未产出有效正文：不做模板拼接兜底，返回 undefined 交由上层重试/Reviewer 修复链路处理
    if (input.diagnostics && !input.diagnostics.llm.lastError) input.diagnostics.llm.lastError = `task writer 未产出有效正文：${input.chapter.title} / ${input.sectionTitle}`;
    return undefined;
  }
  let merged = `### ${input.sectionTitle}\n\n${parts.join('\n\n')}`;
  // 空壳保护：任务正文若在清洗链中被删除只剩标题，判定失败交由上层修复，不落模板拼接兜底
  if (documentTextLength(sectionContentBody(merged)) < 200) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `task writer 正文空壳：${input.chapter.title} / ${input.sectionTitle} / ${documentTextLength(sectionContentBody(merged))}字`;
    return undefined;
  }
  const structureIssue = sectionStructureIssue(input.sectionTitle, merged);
  if (structureIssue) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `task writer ${structureIssue}：${input.chapter.title} / ${input.sectionTitle}`;
    return undefined;
  }
  merged = await supplementSectionContent({ ...input, currentContent: merged, targetWords: input.targetWords });
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(merged, input.forbidDrawingImages));
}

function sectionDomain(sectionTitle: string) {
  if (/工期|进度|节点|计划|纠偏|预警/u.test(sectionTitle)) return '工期进度';
  if (/质量|验收|三检|样板|隐蔽|复试|实测|通病/u.test(sectionTitle)) return '质量验收';
  if (/安全|危大|风险|隐患|应急|临边|洞口|消防|临电/u.test(sectionTitle)) return '安全风险';
  if (/文明|扬尘|噪声|绿色|废水|垃圾|环保|智慧/u.test(sectionTitle)) return '文明绿色';
  if (/劳务|工资|实名|银行|考勤|人员|岗位|组织|职责/u.test(sectionTitle)) return '组织劳务';
  if (/资源|材料|设备|机械|人材机|调配/u.test(sectionTitle)) return '资源保障';
  if (/施工|工艺|流程|顺序|穿插|部署|区段|流水/u.test(sectionTitle)) return '施工组织';
  return '综合管理';
}

function groupSectionTargets(targets: ReturnType<typeof sectionTargets>, maxGroupSize: number) {
  const groups: Array<typeof targets> = [];
  const byDomain = new Map<string, typeof targets>();
  for (const target of targets) {
    const key = sectionDomain(target.title);
    const items = byDomain.get(key) || [];
    items.push(target);
    byDomain.set(key, items);
  }
  const effectiveMaxGroupSize = maxGroupSize;
  for (const items of byDomain.values()) {
    for (let offset = 0; offset < items.length; offset += effectiveMaxGroupSize) groups.push(items.slice(offset, offset + effectiveMaxGroupSize));
  }
  return groups;
}
export async function buildSectionGroupChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext?: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; compactProjectContext?: boolean; sectionEvidenceProvider?: (sectionTitle: string) => Promise<DocumentEvidence[]>; onSectionProgress?: (event: { completed: number; total: number; sectionTitle?: string; phase: 'start' | 'complete' | 'retry'; partialSections?: Array<string | undefined> }) => void; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const targets = sectionTargets(input.chapter, input.targetWords);
  if ((input.chapter.sections || []).filter(Boolean).length > 0) return buildSectionParallelChapterContent(input);
  if (targets.length < 2) return undefined;
  const defaultGroupSize = targets.length >= 30 ? 4 : 5;
  const configuredGroupSize = Number(process.env.DOCUMENT_SECTION_GROUP_SIZE || defaultGroupSize);
  const maxGroupSize = Math.max(2, Math.min(targets.length >= 30 ? 5 : 6, Number.isFinite(configuredGroupSize) ? Math.floor(configuredGroupSize) : defaultGroupSize));
  const chapterHasMajorConstructionSection = targets.some(target => /项目主要施工内容/u.test(target.title));
  const groups = groupSectionTargets(targets, maxGroupSize);
  const defaultGroupConcurrency = 3;
  const configuredConcurrency = Number(process.env.DOCUMENT_SECTION_GROUP_CONCURRENCY || defaultGroupConcurrency);
  // 大章节（≥30 小节）历史原因组间强制串行导致 50 小节章节耗时 50+ 分钟；
  // 改为允许组间并发（默认 3），失败降级串行由上层失败 streak 机制兜底
  const concurrency = Math.max(1, Math.min(groups.length, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : defaultGroupConcurrency));
  const results: string[] = new Array(groups.length).fill('');
  let emptyLlmGroupCount = 0;
  const runGroup = async (group: typeof targets): Promise<{ content: string; llmChars: number }> => {
    const groupSections = group.map(item => item.title);
    const groupLabel = groupSections.join('、');
    const rawGroupTargetWords = group.reduce((sum, item) => sum + item.targetWords, 0);
    // 大章节组级目标字数上限过小会导致每小节只分得 300 字、批量触发“正文过短”修复循环；
    // 放宽到 2400，让组级一次成稿接近小节目标字数
    const groupTargetWords = Math.min(rawGroupTargetWords, targets.length >= 30 ? 2400 : 2800);
    const groupEvidenceLists = await Promise.all(groupSections.map(section => input.sectionEvidenceProvider
      ? input.sectionEvidenceProvider(section).catch(() => [])
      : Promise.resolve([])));
    const groupEvidence = [...input.evidence, ...groupEvidenceLists.flat().filter((item): item is DocumentEvidence => Boolean(item))]
      .filter(item => !/违约金额|元\/条|罚款|处罚|检查项目检查内容|清单不再单独列项/u.test(item.content.slice(0, 500)))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(item => ({ ...item, content: item.content.slice(0, 1400) }));
    const groupChapter = { ...input.chapter, sections: targets.length >= 30 ? groupSections.slice(0, 12) : groupSections };
    if (emptyLlmGroupCount >= (targets.length >= 30 ? 1 : 2)) {
      throw new Error(`小节组 ${groupSections.join('、')} 连续空响应，已阻断以避免标题占位正文`);
    }
    const buildSectionTaskGroup = async () => {
      const parts: Array<string | undefined> = new Array(group.length);
      const failures: string[] = [];
      const taskConcurrency = Math.max(1, Math.min(group.length, Number(process.env.DOCUMENT_SECTION_GROUP_TASK_CONCURRENCY || 2)));
      const writeOne = async (item: typeof group[number], batchSignal: AbortSignal = input.signal as AbortSignal) => {
        const activeSignal = batchSignal || input.signal;
        // 复用组级汇总时已检索的小节证据（groupEvidenceLists 按 groupSections 顺序构建），
        // 避免同一小节在组级汇总与逐节生成中重复触发两次知识库检索
        const itemIndex = group.indexOf(item);
        const sectionExtraEvidence: DocumentEvidence[] = itemIndex >= 0 ? groupEvidenceLists[itemIndex] : [];
        const previousGlobalError = input.diagnostics?.llm.lastError;
        try {
          const content = await buildTaskBasedSectionContent({
            template: input.template,
            chapter: input.chapter,
            sectionTitle: item.title,
            evidence: sectionExtraEvidence.length ? [...groupEvidence, ...sectionExtraEvidence] : groupEvidence,
            missingFacts: input.missingFacts,
            promptTexts: input.promptTexts,
            projectContext: input.projectContext,
            requirement: input.requirement,
            roleContext: input.roleContext || '',
            targetWords: Math.max(item.targetWords, 900),
            maxWords: Math.ceil(Math.max(item.targetWords, 900) * 1.16),
            forbidDrawingImages: input.forbidDrawingImages,
            factCoverageContext: input.factCoverageContext,
            signal: activeSignal,
            diagnostics: input.diagnostics,
          });
          if (!content) {
            const currentError = input.diagnostics?.llm.lastError;
            failures.push(`${item.title}：${currentError && currentError !== previousGlobalError ? currentError : 'Writer 返回空正文'}`);
          }
          return content;
        } catch (error) {
          failures.push(`${item.title}：${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      };
      for (let offset = 0; offset < group.length; offset += taskConcurrency) {
        throwIfAborted(input.signal);
        const batch = group.slice(offset, offset + taskConcurrency);
        const batchResults = await Promise.all(batch.map(item => writeOne(item, input.signal as AbortSignal)));
        batchResults.forEach((content, index) => { parts[offset + index] = content; });
      }
      const missing = groupSections.filter((_, index) => !parts[index]);
      if (missing.length > 0) {
        throw new Error(`${input.chapter.title} 小节组生成未完成：${missing.map(title => `${title}（${failures.filter(item => item.startsWith(`${title}：`)).join('；') || '未记录到具体异常'}）`).join('、')}`);
      }
      const content = parts.filter(Boolean).join('\n\n');
      return { content, llmChars: documentTextLength(content) };
    };
    if (!chapterHasMajorConstructionSection && !groupHasMajorConstructionSection(groupSections)) {
      try {
        const content = await buildLlmChapterContent(input.template, groupChapter, groupEvidence, input.missingFacts, input.promptTexts, input.projectContext, input.requirement, input.roleContext || '', {
          forbidDrawingImages: input.forbidDrawingImages,
          minWords: Math.floor(groupTargetWords * 0.45),
          targetWords: groupTargetWords,
          maxWords: Math.ceil(groupTargetWords * 1.08),
          maxTokens: outputTokensForChapter(Math.floor(groupTargetWords * 0.45), groupTargetWords),
          factCoverageContext: `${input.factCoverageContext || ''}\n本轮输出多个节时，每个 ### 节下必须至少有一个 #### 三级小节承载正文。`,
          signal: input.signal,
          diagnostics: input.diagnostics,
        });
        const normalized = ensureGroupTertiaryShell(groupSections, content?.replace(new RegExp(`^##\\s+${input.chapter.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*`, 'mu'), '').trim() || '');
        const llmChars = documentTextLength(normalized);
        if (llmChars >= Math.max(500, Math.floor(groupTargetWords * 0.25))) return { content: normalized, llmChars };
      } catch {
        // 降级逐节生成
      }
    }
    void groupLabel;
    void rawGroupTargetWords;
    return buildSectionTaskGroup();
  };
  for (let offset = 0; offset < groups.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batch = groups.slice(offset, offset + concurrency);
    const batchResults = await Promise.all(batch.map(group => runGroup(group)));
    batchResults.forEach((result, index) => {
      results[offset + index] = result.content;
      if (result.llmChars < 120) emptyLlmGroupCount += 1;
    });
  }
  const missingGroups = groups.filter((_, index) => !results[index]);
  if (missingGroups.length > 0) {
    throw new Error(`${input.chapter.title} 小节组生成未完成：${missingGroups.flatMap(group => group.map(item => item.title)).join('、')}`);
  }
  const body = results.filter(Boolean).join('\n\n');
  if (!body.trim()) return undefined;
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${body}`, input.forbidDrawingImages));
}

export async function buildSectionParallelChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext?: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; projectRoot?: string; modelName?: string; materialContextHash?: string; allowPartialResult?: boolean; compactProjectContext?: boolean; sectionEvidenceProvider?: (sectionTitle: string) => Promise<DocumentEvidence[]>; onSectionProgress?: (event: { completed: number; total: number; sectionTitle?: string; phase: 'start' | 'complete' | 'retry'; partialSections?: Array<string | undefined> }) => void; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const targets = sectionTargets(input.chapter, input.targetWords);
  if (targets.length < 2) return undefined;
  const configuredSectionConcurrency = Number(process.env.DOCUMENT_SECTION_CONCURRENCY || targets.length || 1);
  const concurrency = Math.max(1, Math.min(targets.length, Number.isFinite(configuredSectionConcurrency) ? Math.floor(configuredSectionConcurrency) : (targets.length || 1)));
  const results: Array<string | undefined> = new Array(targets.length);
  const completedSections: Array<string | undefined> = new Array(targets.length);
  let completedCount = 0;
  const runSection = async (item: { title: string; targetWords: number; index: number }, compact = false) => {
    input.onSectionProgress?.({ completed: completedCount, total: targets.length, sectionTitle: item.title, phase: compact ? 'retry' : 'start', partialSections: [...completedSections] });
    try {
      const sectionExtraEvidence = input.sectionEvidenceProvider
        ? await input.sectionEvidenceProvider(item.title).catch(() => [])
        : [];
      const sectionInput = {
        ...input,
        evidence: sectionExtraEvidence.length ? [...input.evidence, ...sectionExtraEvidence] : input.evidence,
        projectContext: input.projectContext,
        roleContext: input.roleContext || '',
        factCoverageContext: input.factCoverageContext,
        compactProjectContext: input.compactProjectContext,
        sectionTitle: item.title,
        targetWords: item.targetWords,
        maxWords: input.maxWords ? Math.max(item.targetWords, Math.ceil(input.maxWords / targets.length)) : Math.ceil(item.targetWords * 1.12),
      };
      const content = item.targetWords >= 1400
        ? await buildTaskBasedSectionContent({ ...sectionInput, signal: input.signal })
        : await buildQualifiedSectionSupplement({ ...sectionInput, signal: input.signal }, sectionSupplementAttempts(targets.length));
      if (content) {
        completedCount += 1;
        completedSections[item.index] = content;
        input.onSectionProgress?.({ completed: completedCount, total: targets.length, sectionTitle: item.title, phase: 'complete', partialSections: [...completedSections] });
      }
      return content;
    } catch (error) {
      console.warn(`[document-workflow] 小节生成失败：${input.chapter.title} / ${item.title}`, error);
      return undefined;
    }
  };
  const llmSectionLimit = targets.length;
  for (let offset = 0; offset < llmSectionLimit;) {
    throwIfAborted(input.signal);
    // 连续失败≥2 时批次降为串行，避免失败率高的模型被无脑并发反复击穿
    const batchSize = getDocumentLlmFailureStreak() >= 2 ? 1 : concurrency;
    const batch = targets.slice(offset, Math.min(llmSectionLimit, offset + batchSize));
    const batchResults = await Promise.all(batch.map((item, index) => runSection({ ...item, index: offset + index })));
    batchResults.forEach((content, index) => { results[offset + index] = content; });
    offset += batchSize;
  }
  let missingIndexes = results.map((content, index) => content ? -1 : index).filter(index => index >= 0);
  const retryIndexes = missingIndexes;
  if (retryIndexes.length > 0) {
    for (let offset = 0; offset < retryIndexes.length;) {
      throwIfAborted(input.signal);
      const batchSize = getDocumentLlmFailureStreak() >= 2 ? 1 : concurrency;
      const batchIndexes = retryIndexes.slice(offset, offset + batchSize);
      const batchResults = await Promise.all(batchIndexes.map(index => runSection({ ...targets[index], index }, true)));
      batchResults.forEach((content, index) => { if (content) results[batchIndexes[index]] = content; });
      offset += batchSize;
    }
    missingIndexes = results.map((content, index) => content ? -1 : index).filter(index => index >= 0);
    // 最终补写：并发批次处理全部缺失小节，避免只修复首批缺失导致后续关键小节被空置。
    for (let offset = 0; offset < missingIndexes.length;) {
      throwIfAborted(input.signal);
      const batchSize = getDocumentLlmFailureStreak() >= 2 ? 1 : concurrency;
      const finalRetryIndexes = missingIndexes.slice(offset, offset + batchSize);
      const finalResults = await Promise.all(finalRetryIndexes.map(index => runSection({ ...targets[index], targetWords: Math.max(targets[index].targetWords, 900), index }, true)));
      finalResults.forEach((content, position) => { if (content) results[finalRetryIndexes[position]] = content; });
      offset += batchSize;
    }
  }
  missingIndexes = results.map((content, index) => content ? -1 : index).filter(index => index >= 0);
  // 最终缺失小节不做确定性模板拼接兜底：留空由后续 Reviewer/Repairer/Final Gate 的 LLM 修复链路处理
  if (missingIndexes.length > 0 && input.diagnostics) input.diagnostics.llm.lastError = `章级生成缺失小节：${input.chapter.title} / ${missingIndexes.map(index => targets[index].title).join('、')}`;
  const sectionContents = results.map(content => content || '');
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${sectionContents.join('\n\n')}`, input.forbidDrawingImages));
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
  const configured = Number(process.env.DOCUMENT_SECTION_SUPPLEMENT_ATTEMPTS ?? 2);
  return Math.max(1, Math.min(3, Number.isFinite(configured) ? Math.floor(configured) : 2, totalTargets));
}

export async function buildQualifiedSectionSupplement(input: Parameters<typeof buildLlmSectionContent>[0], maxAttempts: number) {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const generated = await buildLlmSectionContent({ ...input, qualityFeedback: feedback });
    if (!generated) {
      feedback = `上一轮未生成有效正文${input.diagnostics?.llm.lastError ? `（被拒原因：${input.diagnostics.llm.lastError}）` : ''}，请针对被拒原因重新生成完整小节正文。`;
      continue;
    }
    const issue = sectionSupplementQualityIssue(input.sectionTitle, generated);
    if (!issue) return generated;
    feedback = issue;
  }
  return undefined;
}
