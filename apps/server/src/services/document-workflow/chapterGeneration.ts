import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProvider } from '@customize-agent/llm';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { MarkdownSectionContentGap } from './qualityValidation';
import type { ChapterReviewSummary, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentGenerationStrategy, DocumentTemplate, DocumentTemplateChapter, ResolvedFactNeed, ValidationIssue } from './types';
import type { DocumentBudget } from './budget';
import { documentTextLength } from './budget';
import { buildEvidenceBundle, cleanEvidenceText, evidenceBundlePrompt, evidencePromptBudgetForTarget } from './evidence';
import { FORMAL_WRITING_RULES, SECTION_GENERATION_SAFETY_RULES, removeUnwantedDrawingImages, sanitizeFormalMarkdown } from './markdownComposer';
import { callDocumentLlm, callDocumentLlmJson, getActiveModelWithProvider, getDocumentLlmFailureStreak } from './llmClient';
import { stringifyFactValue, throwIfAborted } from './utils';
import { selectByScore, factImportanceScore } from './selection';
import { measureGenerationStep } from './rolePipeline';
import { displayChapterTitle } from './outline';
import { displayStage } from './progress';
import { normalizePlannedSections, professionalSectionTaskCard } from './promptRuleExtraction';
import { tablePlansPrompt } from './constructionOrgTablePlan';
import { constructionOrgBonusModulePrompt, constructionOrgChapterRulePrompt } from './constructionOrgQualityRules';
import { buildProcessKnowledgePrompt, matchProcessKnowledgeCards } from './constructionProcessKnowledge';


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
  const tokenRe = /(?:\b[A-Z]{1,8}[\w./-]*\d[\w./-]*\b|\b\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年|万元|元)\b|\b\d+\s*[×xX]\s*\d+(?:\s*[×xX]\s*\d+)?\b|\b(?:GB|GB\/T|ISO|IEC|IEEE|RFC|API|DB\d*|T\/[A-Z]+)\s*[\w.-]+\b)/giu;
  for (const item of evidence) {
    const content = stringifyFactValue(item.content).replace(/\s+/gu, ' ');
    if (/报价明细|投标报价|单价|合价|综合单价|预留金|税率|增值税|利润|结算/u.test(content) && !/合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(content)) continue;
    if (/OCR|识别错误|乱码|无法确认|疑似|不确定|语义断裂/u.test(content)) continue;
    for (const match of content.matchAll(tokenRe)) tokens.add(match[0].trim());
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
  const preciseTokensAll = [...new Set([...extractChapterPreciseTokens(input.evidence), ...resolvedFacts.map(fact => stringifyFactValue(fact.value)).filter(value => /\d|DN|φ|Φ|mm|cm|m²|m3|m³|MPa|kPa|℃|%|GB|JGJ|ISO|台|套|个|项|批|次|份|人|㎡|日历天|万元|元/iu.test(value)), ...allIndexedFacts.map(fact => stringifyFactValue(fact.value)).filter(value => /\d|DN|φ|Φ|mm|cm|m²|m3|m³|MPa|kPa|℃|%|GB|JGJ|ISO|台|套|个|项|批|次|份|人|㎡|日历天|万元|元/iu.test(value))])];
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
    '- 内容必须遵循用户提示词、模板章节、提示词角色、项目资料包和自动识别的资料类型；不得编造材料未提供的事实。',
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
    const parameterScore = /\d|DN|φ|Φ|mm|cm|m²|m3|m³|MPa|kPa|℃|%|GB|JGJ|ISO|台|套|个|项|批|次|份|人|㎡|日历天|万元|元|规格|型号|数量|合同估算价|合同估算价格|计划工期/iu.test(rawText) ? 1.5 : 0;
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

const QUANTIFIED_FACT_RE = /\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年)|DN\s*\d+|φ\s*\d+|Φ\s*\d+|GB\s*\d+|JGJ\s*\d+/iu;
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

function buildSectionFactCard(sectionTitle: string, evidence: DocumentEvidence[]): SectionFactCard {
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

function sectionFactUsageIssue(sectionTitle: string, content: string, factCard: SectionFactCard) {
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
    /项目主要施工内容/u.test(input.sectionTitle) ? '【项目主要施工内容专项结构】只能根据绑定材料中的当前项目事实识别施工对象和工作包；不得套用固定行业模板，不得复述完整工程概况，不得写“以图纸清单为准”式空话；不得使用 Markdown 表格。必须按专业工程/分部分项工程逐项展开，每项使用“#### 工作包名称”作为三级小节标题，并固定包含“施工概况：”“施工流程：”“施工方法：”三段。施工概况必须写该工作包对应的本项目作业对象、部位、规模/工程量、材料设备或系统边界，写成连贯叙述段落，不得出现“1．xxx 2．xxx”编号清单或“xxx｜工程量”式清单原文罗列；施工流程必须使用“→”串联关键工序；施工方法必须写成连贯叙述，落到具体工具机具、测量/检测方法、工艺参数、材料规格、穿插关系、质量验收、复试检测和资料闭环，禁止“按规范施工”“结合实际执行”式空话。至少形成 5 个施工工作包，工作包必须来自绑定材料证据。' : '',
    /主要分部分项工程施工方案/u.test(input.sectionTitle) ? '【主要分部分项工程施工方案专项要求】每个“#### 分项工程方案”三级小节必须包含施工概况（本项目作业对象、部位、工程量）、工艺流程（用“→”串联关键工序）和施工方法（工具机具、材料规格、验收标准）。每个分项方案正文必须落位至少 4 个工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定材料或行业通用规范值，不得编造；纯设备配置型小节必须写型号、规格、容量、数量参数；不得写“按规范施工”“结合实际执行”式空话。' : '',
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
    if (/项目主要施工内容/u.test(input.sectionTitle)) {
      const deterministic = buildMajorConstructionFallbackSection(input.sectionTitle, input.projectContext, input.evidence);
      if (deterministic) return deterministic;
    }
    return undefined;
  }
  const criticalMinChars = criticalSectionBlockerMinChars(input.sectionTitle);
  // 单次任务的最小字数不得超过任务目标字数：任务拆分会把小节拆成多个 targetWords≈800 的主题任务，
  // 此时全局 criticalMinChars（如 1800）远大于任务目标，每个任务都无法达标而被整体拒绝，反而产出空小节。
  const minSectionChars = Math.min(Math.max(Math.floor(input.targetWords * 0.7), criticalMinChars), Math.max(500, input.targetWords));
  if (isCriticalDeepSection(input.sectionTitle) && documentTextLength(normalizedContent) < minSectionChars) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `section writer 正文不足：${input.chapter.title} / ${input.sectionTitle} / ${documentTextLength(normalizedContent)}/${minSectionChars}字`;
    if (/项目主要施工内容/u.test(input.sectionTitle)) {
      const deterministic = buildMajorConstructionFallbackSection(input.sectionTitle, input.projectContext, input.evidence);
      if (deterministic) return deterministic;
    }
    return undefined;
  }
  return ensureTertiarySectionShell(input.sectionTitle, normalizedContent);
}

interface SectionWritingTask {
  sectionTitle: string;
  taskTitle: string;
  targetWords: number;
  index: number;
  total: number;
}

function hasMajorConstructionContentStructure(content: string) {
  const body = sectionContentBody(content);
  const packageCount = (body.match(/^####\s+(?:\d+\.\d+\.\d+\s+)?[一二三四五六七八九十\d]*[、.．]?\s*\S+/gmu) || []).length
    || (body.match(/^[一二三四五六七八九十]+、\S+/gmu) || []).length;
  const conceptCount = ['施工概况', '施工流程', '施工方法'].filter(keyword => body.includes(keyword)).length;
  return packageCount >= 3 && conceptCount === 3 && /→|->|测量|放线|验收|复试|检测|闭环/u.test(body);
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

function sectionContentBody(content: string) {
  return content.replace(/^#{3,4}\s+.*\n+/u, '').trim();
}

function currentSectionBlock(sectionTitle: string, content: string) {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = content.match(new RegExp(`^###\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s+|^##\\s+|$)`, 'mu'));
  return match ? match[0] : content;
}

function hasTertiarySubsections(content: string, sectionTitle?: string) {
  const target = sectionTitle ? currentSectionBlock(sectionTitle, content) : content;
  return /^####\s+\S+/mu.test(target);
}

type MajorConstructionPackage = { name: string; scope: string; quantities: string[]; process: string[]; acceptance: string[] };

function cleanMajorConstructionFact(text: string) {
  return cleanEvidenceText(text)
    .replace(/#{2,6}\s*[^；;。\n]+/gu, '')
    .replace(/资料内容事实[；;：:]?/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

// 将「1．xxx 2．xxx｜19.79m3」这类清单原文转为可读的叙述短语：
// 1）去除编号前缀（数字/中文序号/带圈数字）；2）将「｜量」转为「（量）」；3）去重并截断。
function narrateConstructionFacts(facts: string[], max = 6) {
  return [...new Set(facts)]
    .map(fact => cleanMajorConstructionFact(fact)
      .replace(/^[①-⑳㈠-㈩⑴-⒇]\s*/u, '')
      .replace(/^\d+\s*[．.、:：)）]\s*/u, '')
      .replace(/^[一二三四五六七八九十]+\s*[、．.]\s*/u, '')
      .replace(/｜\s*([^；;、，,\n]+)/gu, '（$1）'))
    .filter(item => item && item.length >= 4)
    .slice(0, max);
}

function isUsableMajorConstructionFact(text: string) {
  const value = cleanMajorConstructionFact(text);
  if (!value || value.length < 4 || value.length > 120) return false;
  if (/资料内容事实|#{2,6}|未尽事宜|项目编号\s*[:：]?\s*[一二三四五六七八九十]?$/u.test(value)) return false;
  if (/本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围还包含|具备有效的.*资质/u.test(value)) return false;
  if ((value.match(/工程|维修|改造|安装|设备/gu) || []).length >= 4 && !/\d|㎡|m2|m²|mm|厚|验收|检测|调试|试验|复试/u.test(value)) return false;
  return /\d|㎡|m2|m²|mm|厚|工程|材料|设备|系统|范围|改造|维修|加固|消防|水电|智能化|管网|屋面|门窗|验收|检测|调试/u.test(value);
}

function splitFactItems(text: string) {
  return text.split(/[；;、，,]/u).map(item => cleanMajorConstructionFact(item)).filter(isUsableMajorConstructionFact);
}

function splitConstructionSteps(text: string) {
  return text.split(/→|；|;|、|，|,/u)
    .map(item => cleanMajorConstructionFact(item))
    .filter(item => item && item.length >= 2 && item.length <= 40)
    .filter(item => !/^按?施工准备$|^实施$|^检查$|^验收组织?$|^按规范和资料闭环$/u.test(item))
    .filter(item => !/本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围|未尽事宜|具备有效/u.test(item));
}

function isWorkPackageListFact(text: string) {
  const value = cleanMajorConstructionFact(text);
  if (!value) return true;
  const packageLikeCount = (value.match(/工程|维修|改造|安装|设备|系统|管网|屋面|门窗|消防|智能化/gu) || []).length;
  return packageLikeCount >= 5 && !/\d|㎡|m2|m²|mm|厚|验收|检测|调试|试验|复试|记录|报告|材料|设备|规格|标准|检验批/u.test(value);
}

function parseMajorConstructionPackages(projectContext: string, evidence: DocumentEvidence[]): MajorConstructionPackage[] {
  const packages: MajorConstructionPackage[] = [];
  const structuredMatch = projectContext.match(/施工工作包结构化数据：\s*(\[[^\n]*\])/u);
  if (structuredMatch) {
    try {
      const items = JSON.parse(structuredMatch[1]) as Array<{ name?: string; scope?: string; quantities?: string[]; materials?: string[]; process?: string[]; methods?: string[]; acceptance?: string[] }>;
      for (const item of items) {
        const name = cleanMajorConstructionFact(item.name || '');
        const scope = cleanMajorConstructionFact(item.scope || '');
        const quantities = [...(item.quantities || []), ...(item.materials || []), ...(item.methods || [])].map(cleanMajorConstructionFact).filter(isUsableMajorConstructionFact).filter(item => !isWorkPackageListFact(item));
        const process = (item.process || []).flatMap(splitConstructionSteps);
        const acceptance = (item.acceptance || []).map(cleanMajorConstructionFact).filter(item => item && !isWorkPackageListFact(item));
        if (!name || /^\d*徽光阁项目施工$/u.test(name) || name === '徽光阁项目施工') continue;
        if (!scope || /资料内容事实|#{2,6}/u.test(scope)) continue;
        packages.push({ name, scope, quantities, process, acceptance });
      }
      if (packages.length > 0) return packages.slice(0, 16);
    } catch {
      packages.length = 0;
    }
  }
  const graphLines = projectContext.split(/\r?\n/u).filter(line => /^\d+\.\s+.+?｜范围：/u.test(line));
  for (const line of graphLines) {
    const match = line.match(/^\d+\.\s+(.+?)｜范围：(.+?)｜工程量\/材料：(.+?)｜流程：(.+?)｜验收：(.+)$/u);
    if (!match) continue;
    const name = cleanMajorConstructionFact(match[1]);
    const scope = cleanMajorConstructionFact(match[2]);
    const quantities = splitFactItems(match[3]).filter(item => item !== '按证据展开');
    const process = splitConstructionSteps(match[4]);
    const acceptance = match[5].split(/[；;、，,]/u)
      .map(item => cleanMajorConstructionFact(item))
      .filter(item => item && item !== '按规范和资料闭环')
      .filter(item => !isWorkPackageListFact(item));
    if (!name || /^\d*徽光阁项目施工$/u.test(name) || name === '徽光阁项目施工') continue;
    if (!scope || /资料内容事实|#{2,6}/u.test(scope)) continue;
    packages.push({ name, scope, quantities, process, acceptance });
  }
  return packages.slice(0, 8);
}

function projectFactSummary(projectContext: string, evidence: DocumentEvidence[]) {
  const text = `${projectContext}\n${evidence.map(item => cleanEvidenceText(stringifyFactValue(item.content))).join('\n')}`;
  const facts = [
    text.match(/建筑面积(?:约)?\s*[\d.]+\s*(?:㎡|m²)/u)?.[0],
    text.match(/地上\s*[一二三四五六七八九十\d]+\s*层/u)?.[0],
    text.match(/[一二三四五六七八九十\d]+\s*层框架结构/u)?.[0],
    text.match(/保留在营业商铺\s*[\d.]+\s*㎡/u)?.[0],
    text.match(/闲置空间(?:约)?\s*[\d.]+\s*㎡/u)?.[0],
    text.match(/计划工期\s*[\d.]+\s*日历天/u)?.[0],
    text.match(/质量标准[:：]?\s*合格/u)?.[0],
  ].filter(Boolean) as string[];
  return [...new Set(facts)].slice(0, 6).join('，');
}

function buildMajorConstructionFallbackSection(sectionTitle: string, projectContext = '', evidence: DocumentEvidence[] = []) {
  const packages = parseMajorConstructionPackages(projectContext, evidence)
    .filter(pkg => pkg.scope && (pkg.quantities.length > 0 || pkg.process.length > 0 || pkg.acceptance.length > 0));
  if (packages.length < 5) return undefined;
  const projectFacts = projectFactSummary(projectContext, evidence);
  const validPackages = packages.map(pkg => {
    const process = pkg.process.length >= 3 ? pkg.process : [];
    const methodFacts = [...pkg.quantities, ...pkg.acceptance]
      .filter(item => !/本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围还包含|具备有效/u.test(item))
      .filter(item => !((item.match(/工程|维修|改造|安装|设备/gu) || []).length >= 4 && !/\d|㎡|m2|m²|mm|厚|验收|检测|调试|试验|复试/u.test(item)))
      .slice(0, 8);
    return { pkg, process, methodFacts };
  }).filter(item => item.methodFacts.length >= 2 && item.process.length >= 2);
  if (validPackages.length < 5) return undefined;
  return [
    `### ${sectionTitle}`,
    '',
    ...validPackages.flatMap(({ pkg, process, methodFacts }) => {
      const quantities = narrateConstructionFacts(pkg.quantities, 6);
      const acceptance = narrateConstructionFacts(pkg.acceptance, 4);
      const methods = narrateConstructionFacts(methodFacts, 8);
      const quantityLead = quantities.length
        ? `该工作包涉及的工程量、材料与设备包括${quantities.join('；')}。`
        : acceptance.length ? `该工作包涉及的验收与检测要求包括${acceptance.join('；')}。` : '';
      const methodLead = methods.length
        ? methods.join('；') + '。'
        : '按施工准备→过程实施→检查验收→问题整改→资料归档组织，重点控制工具机具、工艺参数、材料规格与验收检测。';
      return [
        `#### ${pkg.name}`,
        '',
        `施工概况：${pkg.name}属于本项目主要施工内容，实施范围为${pkg.scope}。${projectFacts ? `本项目已确认的基础条件包括${projectFacts}。` : ''}${quantityLead}`,
        '',
        `施工流程：${process.join('→')}。`,
        '',
        `施工方法：${methodLead}`,
        '',
      ];
    }),
  ].join('\n');
}

// “主要分部分项工程施工方案/主要施工方法”确定性兜底：
// 用施工工作包结构化数据按分项工程叙述施工方案，落位工程量/验收参数，避免空小节与纯套话残留。
function buildMethodSectionFallback(sectionTitle: string, projectContext = '', evidence: DocumentEvidence[] = []) {
  const packages = parseMajorConstructionPackages(projectContext, evidence)
    .filter(pkg => pkg.scope && (pkg.quantities.length > 0 || pkg.process.length > 0 || pkg.acceptance.length > 0));
  if (packages.length < 2) return undefined;
  const blocks = packages.slice(0, 8).map(pkg => {
    const quantities = narrateConstructionFacts(pkg.quantities, 6);
    const acceptance = narrateConstructionFacts(pkg.acceptance, 4);
    const process = [...new Set(pkg.process)].slice(0, 8);
    const lines = [
      `本分部分项工程实施范围为${pkg.scope}。`,
      quantities.length ? `涉及主要工程量与材料设备：${quantities.join('；')}。` : '',
      process.length ? `施工流程按${process.join('→')}组织。` : '',
      acceptance.length ? `验收要点：${acceptance.join('；')}。` : '',
      '过程控制执行样板引路、工序交接检、隐蔽验收和问题整改闭环，关键参数由责任岗位复核后签字确认。',
    ].filter(Boolean);
    return `#### ${pkg.name}\n\n${lines.join('')}`;
  });
  return [`### ${sectionTitle}`, '', ...blocks].join('\n\n');
}

function buildGenericFallbackSection(sectionTitle: string) {
  const isKeyDifficulty = /项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle);
  const topicCount = isKeyDifficulty ? 5 : 3;
  const topics = Array.from({ length: topicCount }, (_, index) => writingTopicTitle(sectionTitle, index, topicCount));
  // 通用兜底正文必须与特定项目解耦：只写结构化的过程要求，具体事实由绑定资料在后续补齐；
  // 禁止套用“本小节围绕……展开”式模板空话（重复段检测会阻断此类段落）。
  const topicBodies: Record<number, string> = {
    0: '依据本项目已确认资料中的项目边界、工程量与设计做法，逐项明确作业对象、部位范围与过程控制目标，作为作业条件确认、技术交底和过程实施的输入。',
    1: '按“作业条件确认→技术交底→过程实施→自检互检→整改复查→资料归档”组织，交底覆盖到直接作业人员，实施过程留存检查记录与影像，问题整改定人、定时限、定复查。',
    2: '过程控制重点落到材料规格与验收、工序交接、测量复核和成品保护；关键节点由责任岗位复核后签字确认，发现偏差当日反馈、限期整改并销项。',
    3: '按项目质量与安全目标分解到责任岗位，执行日巡查、周复核、节点验收三级检查，形成台账与闭环记录。',
    4: '收尾阶段完成缺陷自查、整改销项、验收资料整理与移交，确保与总体进度计划和质量验收要求衔接。',
  };
  return [
    `### ${sectionTitle}`,
    '',
    ...topics.flatMap((topic, topicIndex) => [
      `#### ${topic}`,
      '',
      topicBodies[topicIndex % 5] || topicBodies[0],
      '',
    ]),
  ].join('\n');
}

function sectionStructureIssue(sectionTitle: string, content: string) {
  if (/项目主要施工内容/u.test(sectionTitle)) {
    const block = currentSectionBlock(sectionTitle, content);
    if (!hasTertiarySubsections(content, sectionTitle)) return `${sectionTitle} 缺少施工工作包三级小节`;
    if (!hasMajorConstructionContentStructure(block)) return `${sectionTitle} 未按施工工作包展开`;
    const packageBlocks = block.split(/^####\s+/gmu).slice(1).map(item => item.trim()).filter(Boolean);
    if (packageBlocks.some(item => !item.includes('施工概况') || !item.includes('施工流程') || !item.includes('施工方法'))) return `${sectionTitle} 存在工作包结构不完整`;
    if (/资料内容事实|#{2,6}\s+|\*\*[^*]+\*\*|未尽事宜|专业施工内容统筹|招标范围还包含|具备有效的.*资质|安全生产考核合格证书|注册建造师|联合体投标|项目经理要求|投标人资格|投标人资质|营业执照|安全生产许可证|资格审查|资格后审|中标通知书|签订合同|电子交易系统|投标保证金|评标办法|踏勘现场|投标预备会/u.test(block)) return `${sectionTitle} 存在脏事实或标题污染`;
    if (packageBlocks.some(item => /施工流程[:：][\s\S]*?(未尽事宜|本项目为|总建筑面积|保留现状|专业施工内容统筹|招标文件列明|招标范围|安全生产考核合格证书|联合体投标|注册建造师)/u.test(item))) return `${sectionTitle} 存在工作包流程污染`;
    if (packageBlocks.some(item => {
      const method = item.match(/施工方法[:：]([\s\S]*?)(?=\n施工|$)/u)?.[1] || '';
      if (/安全生产考核合格证书|联合体投标|注册建造师|投标人资格|资质要求|营业执照|安全生产许可证/u.test(method)) return true;
      return method.length < 30 || ((method.match(/工程|维修|改造|安装|设备/gu) || []).length >= 4 && !/\d|㎡|m2|m²|mm|厚|验收|检测|调试|试验|复试|记录|报告/u.test(method));
    })) return `${sectionTitle} 存在工作包施工方法过弱`;
    const body = sectionContentBody(block);
    if (/^\s*\|.+\|\s*$/mu.test(body)) return `${sectionTitle} 不应使用 Markdown 表格替代工作包正文`;
  }
  return '';
}

function ensureTertiarySectionShell(sectionTitle: string, content: string) {
  if (hasTertiarySubsections(content)) return content;
  const body = sectionContentBody(content);
  if (!body) return content;
  return `### ${sectionTitle}\n\n#### ${sectionTitle}\n\n${body}`;
}

function ensureGroupTertiaryShell(groupSections: string[], content: string) {
  let normalized = content;
  for (const section of groupSections) {
    if (/项目主要施工内容/u.test(section)) continue;
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    normalized = normalized.replace(new RegExp(`(^###\\s+(?:\\d+\\.\\d+\\s+)?${escaped}\\s*\\n)([\\s\\S]*?)(?=^###\\s+|^##\\s+|$)`, 'gmu'), (_match, heading: string, body: string) => {
      return /^####\\s+\\S+/mu.test(body) ? `${heading}${body}` : `${heading}\n#### ${section}\n\n${body.trim()}\n`;
    });
  }
  return normalized;
}

function groupHasMajorConstructionSection(groupSections: string[]) {
  return groupSections.some(section => /项目主要施工内容/u.test(section));
}

function isCriticalDeepSection(sectionTitle: string) {
  return /项目特点.*重点.*难点|重点.*难点.*分析|项目主要施工内容|主要分部分项工程施工方案|主要施工方法|危大工程专项施工方案审批流程|原材料进场复试|见证取样/u.test(sectionTitle);
}

function isGeneralManagementSection(sectionTitle: string) {
  return /项目管理组织|组织架构|岗位职责|施工部署|施工流水|交通组织|人车分流/u.test(sectionTitle);
}

function keySectionWritingRequirement(sectionTitle: string) {
  if (/项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle)) return [
    '关键小节结构要求：必须分为“项目特点分析、施工重点识别、施工难点及应对措施、重点难点与施工内容对应关系”。',
    '必须落位项目具体数据：项目名称、建设地点、建筑面积、层数、结构形式、装配式范围、计划工期、质量标准、施工专业范围、现场场地约束、既有管网接驳等已确认事实。',
    '必须用正式表格或分项清单表达：重点/难点、形成原因、影响范围、对应施工内容、控制措施、责任岗位、验收节点。',
  ].join('\n');
  if (/项目主要施工内容/u.test(sectionTitle)) return [
    '关键小节结构要求：必须参照优秀施工组织设计的“主要施工内容”写法，按当前项目资料识别专业工程/分部分项工作包，不得只写综合概述。',
    '每个工作包固定采用段落式三段：施工概况、施工流程、施工方法；不得使用 Markdown 表格，避免导出时产生表格分隔线残留。',
    '施工概况必须写清对象范围、工程量或规模、材料设备规格、施工部位；施工流程必须用箭头串联工序；施工方法必须写工艺做法、穿插组织、质量验收、检测复试、资料闭环。',
    '工作包类别必须从资料事实中识别，可覆盖但不限于结构加固、消防、装饰、水电、通风空调、弱电智能化、室外道排、屋面、立面、附属工程。',
  ].join('\n');
  if (/主要分部分项工程施工方案|主要施工方法/u.test(sectionTitle)) return [
    '关键小节结构要求：必须按专业工程和关键工序展开，不得只写概述流程。',
    '必须覆盖资料明确的专业工程范围。',
    '必须逐项响应“项目特点、重点、难点分析”中的控制对象，写明施工范围、施工方法、工艺流程、关键控制点、检查验收和资料闭环。',
  ].join('\n');
  return '';
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

export function criticalSectionBlockerMinChars(sectionTitle: string) {
  if (/危大工程专项施工方案审批流程|原材料进场复试|见证取样/u.test(sectionTitle)) return 650;
  if (/项目主要施工内容/u.test(sectionTitle)) return 1800;
  // “主要分部分项工程施工方案/主要施工方法”的全局门槛收敛到 1200：1800 字超过单次 LLM 稳定产出上限，
  // 导致 Writer/Repairer/Final Gate 补写永远被拒（真实生成中 1489 字也被判不足），空小节无法自愈。
  if (/主要分部分项工程施工方案|主要施工方法/u.test(sectionTitle)) return 1200;
  if (/项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle)) return 1500;
  return 0;
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

export function chapterSectionFactUsageIssues(input: { chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[] }) {
  return sectionTargets(input.chapter, Math.max(1000, documentTextLength(input.content))).flatMap(target => {
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = input.content.match(new RegExp(`^#{2,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{2,4}\\s+|$)`, 'mu'));
    const body = match?.[1] || '';
    const factCard = buildSectionFactCard(target.title, evidenceForSection(target.title, input.chapter, input.evidence));
    const issue = sectionFactUsageIssue(target.title, body, factCard);
    return issue ? [`${target.title}：${issue}`] : [];
  });
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
            attempt > 0 ? `上一轮未生成有效正文。本轮必须直接输出“### ${input.sectionTitle}”及正式正文，优先完成可审查、可落位事实的核心内容。` : ''
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
            qualityFeedback: `前序 Writer 未完成。本轮使用轻量定向 Writer，只完成“${input.sectionTitle}”正式正文。`,
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
    if (/项目主要施工内容/u.test(input.sectionTitle)) {
      const deterministic = buildMajorConstructionFallbackSection(input.sectionTitle, input.projectContext, input.evidence);
      if (deterministic) return sanitizeFormalMarkdown(removeUnwantedDrawingImages(deterministic, input.forbidDrawingImages));
    }
    if (/主要分部分项工程施工方案|主要施工方法/u.test(input.sectionTitle)) {
      const deterministic = buildMethodSectionFallback(input.sectionTitle, input.projectContext, input.evidence);
      if (deterministic) return sanitizeFormalMarkdown(removeUnwantedDrawingImages(deterministic, input.forbidDrawingImages));
    }
    return undefined;
  }
  let merged = `### ${input.sectionTitle}\n\n${parts.join('\n\n')}`;
  // 空壳保护：任务正文若在清洗链中被删除只剩标题，应判定失败并触发上层兜底，而不是把空小节传给后续流程。
  if (documentTextLength(sectionContentBody(merged)) < 200) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `task writer 正文空壳：${input.chapter.title} / ${input.sectionTitle} / ${documentTextLength(sectionContentBody(merged))}字`;
    if (/主要分部分项工程施工方案|主要施工方法/u.test(input.sectionTitle)) {
      const deterministic = buildMethodSectionFallback(input.sectionTitle, input.projectContext, input.evidence);
      if (deterministic) return sanitizeFormalMarkdown(removeUnwantedDrawingImages(deterministic, input.forbidDrawingImages));
    }
    return undefined;
  }
  const structureIssue = sectionStructureIssue(input.sectionTitle, merged);
  if (structureIssue) {
    if (input.diagnostics) input.diagnostics.llm.lastError = `task writer ${structureIssue}：${input.chapter.title} / ${input.sectionTitle}`;
    if (/项目主要施工内容/u.test(input.sectionTitle)) {
      const deterministic = buildMajorConstructionFallbackSection(input.sectionTitle, input.projectContext, input.evidence);
      if (deterministic) return sanitizeFormalMarkdown(removeUnwantedDrawingImages(deterministic, input.forbidDrawingImages));
    }
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
  const defaultGroupConcurrency = 2;
  const configuredConcurrency = Number(process.env.DOCUMENT_SECTION_GROUP_CONCURRENCY || defaultGroupConcurrency);
  const concurrency = Math.max(1, Math.min(groups.length, targets.length >= 30 ? 1 : groups.length, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : defaultGroupConcurrency));
  const results: string[] = new Array(groups.length).fill('');
  let emptyLlmGroupCount = 0;
  const runGroup = async (group: typeof targets): Promise<{ content: string; llmChars: number }> => {
    const groupSections = group.map(item => item.title);
    const groupLabel = groupSections.join('、');
    const rawGroupTargetWords = group.reduce((sum, item) => sum + item.targetWords, 0);
    const groupTargetWords = Math.min(rawGroupTargetWords, targets.length >= 30 ? 1200 : 2800);
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
        const sectionExtraEvidence: DocumentEvidence[] = input.sectionEvidenceProvider
          ? await input.sectionEvidenceProvider(item.title).catch(() => [])
          : [];
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
  for (const index of missingIndexes) {
    const title = targets[index].title;
    results[index] = /项目主要施工内容/u.test(title)
      ? (buildMajorConstructionFallbackSection(title, input.projectContext, input.evidence) || undefined)
      : /主要分部分项工程施工方案|主要施工方法/u.test(title)
        ? (buildMethodSectionFallback(title, input.projectContext, input.evidence) || buildGenericFallbackSection(title))
        : buildGenericFallbackSection(title);
  }
  const sectionContents = results.map(content => content || '');
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${sectionContents.join('\n\n')}`, input.forbidDrawingImages));
}

function isGenericFillerSentence(sentence: string) {
  return /^(?:本节围绕|本小节依据|项目实施时应|实施过程中应|当前绑定资料|当前项目绑定资料)/u.test(sentence)
    || /确保各项措施与本工程实施条件相匹配/u.test(sentence)
    || /形成责任明确、过程可控、资料完整的管理闭环/u.test(sentence)
    || /确保现场管理要求与施工进度、资源组织和验收节点同步推进/u.test(sentence)
    || /^管理闭环[。；;]?$/u.test(sentence);
}

function isNonConstructionEvidenceSentence(sentence: string) {
  return /资料参数行摘要|房建市政施工评定分离招标示范文本|我方已仔细研究|中标通知书|签订合同|履约保证金|投标函|投标人须知|招标公告|开标|评标|保证金|电子交易系统|公共资源交易|监管部门|专用账户监管协议书|资金托管专用账号/u.test(sentence)
    || /^#+\s*/u.test(sentence)
    || /^（?\d+）/u.test(sentence);
}

function evidenceSentencesForSection(sectionTitle: string, chapter: DocumentTemplateChapter, evidence: DocumentEvidence[]) {
  const sectionTokens = [sectionTitle, chapter.title, ...sectionTitle.split(/[、，,；;\s]+/u)].filter(token => token.length >= 2);
  const scored = evidence.map(item => {
    const content = cleanEvidenceText(item.content || '').replace(/\s+/gu, ' ').trim();
    const score = sectionTokens.reduce((sum, token) => sum + (content.includes(token) || (item.sectionTitle || '').includes(token) ? 1 : 0), 0) + item.score;
    return { content, score };
  }).filter(item => item.content.length >= 30).sort((a, b) => b.score - a.score);
  const sentences: string[] = [];
  for (const entry of scored.slice(0, 8)) {
    for (const sentence of entry.content.split(/[。；;\n]/u).map(part => part.trim()).filter(Boolean)) {
      if (sentence.length < 18 || sentence.length > 180) continue;
      if (/报价|单价|税率|利润|后台|知识库|提示词|OCR|文件路径/u.test(sentence)) continue;
      if (isGenericFillerSentence(sentence) || isNonConstructionEvidenceSentence(sentence)) continue;
      if (!sentences.some(existing => existing.includes(sentence) || sentence.includes(existing))) sentences.push(sentence);
      if (sentences.length >= 10) break;
    }
    if (sentences.length >= 10) break;
  }
  return sentences;
}

export function buildEvidenceOnlyChapterContent(input: { chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; targetWords: number; forbidDrawingImages: boolean }) {
  const sections = input.chapter.sections?.length ? input.chapter.sections : ['资料依据与施工对象', '主要控制措施', '检查验收与闭环管理'];
  const parts = sections.flatMap(sectionTitle => {
    const facts = evidenceSentencesForSection(sectionTitle, input.chapter, input.evidence).slice(0, 8);
    if (facts.length === 0) return [];
    return [[`### ${sectionTitle}`, '', ...facts.map(fact => `- ${fact}。`)].join('\n')];
  });
  if (parts.length === 0) return '';
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${parts.join('\n\n')}`, input.forbidDrawingImages));
}

export function outputTokensForChapter(minWords: number, targetWords?: number) {
  const words = targetWords || minWords;
  return Math.min(24000, Math.max(5000, Math.ceil(words * 1.45)));
}


export function expansionRoundsForDeficit(deficitChars: number) {
  if (deficitChars <= 0) return 0;
  return Math.max(1, Math.ceil(deficitChars / 4000));
}

export function acceptExpandedChapter(previous: string, next: string, chapterTitle: string, targetChars: number, maxChars = Math.ceil(targetChars * 1.12)) {
  const beforeLength = documentTextLength(previous);
  const afterLength = documentTextLength(next);
  const normalizedTitle = displayChapterTitle(chapterTitle);
  const remaining = Math.max(0, targetChars - beforeLength);
  const minimumGrowth = Math.min(300, Math.max(80, Math.floor(remaining * 0.2)));
  if (afterLength > maxChars) return false;
  if (remaining > 0 && afterLength < beforeLength + minimumGrowth) return false;
  if (afterLength < beforeLength * 0.98) return false;
  if (normalizedTitle && !next.includes(normalizedTitle)) return false;
  return true;
}

export async function expandChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; currentContent: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; maxTokens?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics }) {
  const currentLength = documentTextLength(input.currentContent);
  const maxChars = input.maxChars ?? Math.ceil(input.targetChars * 1.12);
  const missing = input.targetChars - currentLength;
  if (currentLength >= maxChars || missing <= 300) return input.currentContent;
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, input.evidence), { maxChars: evidencePromptBudgetForTarget(Math.ceil(input.targetChars / 2), 6000, 16000) });
  const expanded = await callDocumentLlm([
    '你是章节正文扩写专家。你的任务是在保持章节结构和已有内容连续性的基础上，对当前章节进行局部扩写、补充和衔接优化。',
    FORMAL_WRITING_RULES,
    '返回扩写后的完整本章 Markdown，而不是整篇文档；必须保留本章一级标题，不得新增、删除或重命名一级章节。',
    '不得删除、压缩、总结已有正文中的有效事实和已成文内容；可以在已有二级小节内部补充段落、补充三级小节、补充表格前后说明、增强段落衔接。',
    '可以对局部语句做轻微衔接性改写，但不得改变事实含义，不得减少有效字数；不得把所有新增内容堆到章末，应优先补到对应的小节或语义位置。',
    SECTION_GENERATION_SAFETY_RULES,
    '不得输出“已满足要求”“由于信息有限”“以下是补充”等说明性话术。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    `当前本章有效字数约 ${currentLength} 字，目标约 ${input.targetChars} 字，最多不超过 ${maxChars} 字；本轮只补足必要缺口，不要过度展开。`,
    '扩写重点：围绕尚未充分展开的对象范围、关键事实、执行要求、资源条件、风险约束、检查确认和结果说明补充。材料没有新的精确数值时，可以扩展过程性正文，但不得编造具体数值。',
    input.roleContext,
    evidenceText ? `绑定材料：\n${evidenceText}` : '',
    '当前章节 Markdown 分片（必须保留并覆盖全部已有内容，不得只基于末尾扩写）：',
    chunkTextForReview(input.currentContent, 12000),
  ].filter(Boolean).join('\n\n'), false, { maxTokens: input.maxTokens ?? outputTokensForChapter(currentLength, input.targetChars), temperature: 0.25, signal: input.signal, diagnostics: input.diagnostics });
  if (!expanded || expanded.length < 120) return input.currentContent;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(expanded.startsWith('## ') ? expanded : `## ${input.chapter.title}\n\n${expanded}`, input.forbidDrawingImages));
  return acceptExpandedChapter(input.currentContent, normalized, input.chapter.title, input.targetChars, maxChars) ? normalized : input.currentContent;
}

export function mergeSectionSupplementBody(currentBody: string, replacementBody: string) {
  const current = currentBody.trim();
  const replacement = replacementBody.trim();
  if (!replacement) return '';
  if (/【本小节生成未达标，需重新生成】/u.test(current)) return replacement;
  if (!current) return replacement;
  if (current.includes(replacement)) return '';
  if (replacement.includes(current)) return replacement.slice(replacement.indexOf(current) + current.length).trim();
  const currentTail = current.slice(-240);
  const overlapAt = currentTail.length >= 80 ? replacement.indexOf(currentTail) : -1;
  if (overlapAt >= 0) return replacement.slice(overlapAt + currentTail.length).trim();
  return replacement;
}

export function replaceSectionContent(markdown: string, sectionTitle: string, replacement: string) {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`(^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n)([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu');
  const normalizedReplacement = replacement.trim().replace(/^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]+\n+/u, '').trim();
  if (pattern.test(markdown)) {
    return markdown.replace(pattern, (_match, heading: string, body: string) => {
      const supplement = mergeSectionSupplementBody(body, normalizedReplacement);
      if (/【本小节生成未达标，需重新生成】/u.test(body)) return supplement ? `${heading}${supplement}\n\n` : `${heading}${body.trim()}\n\n`;
      return supplement ? `${heading}${body.trim()}\n\n${supplement}\n\n` : `${heading}${body.trim()}\n\n`;
    });
  }
  return normalizedReplacement ? `${markdown.trim()}\n\n### ${sectionTitle}\n\n${normalizedReplacement}` : markdown;
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

function sectionSupplementAttempts(totalTargets: number) {
  const configured = Number(process.env.DOCUMENT_SECTION_SUPPLEMENT_ATTEMPTS ?? 2);
  return Math.max(1, Math.min(3, Number.isFinite(configured) ? Math.floor(configured) : 2, totalTargets));
}

async function buildQualifiedSectionSupplement(input: Parameters<typeof buildLlmSectionContent>[0], maxAttempts: number) {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const generated = await buildLlmSectionContent({ ...input, qualityFeedback: feedback });
    if (!generated) {
      feedback = '上一轮未生成有效正文，请重新生成完整小节正文。';
      continue;
    }
    const issue = sectionSupplementQualityIssue(input.sectionTitle, generated);
    if (!issue) return generated;
    feedback = issue;
  }
  return undefined;
}

export async function supplementShortSections(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; forcedSections?: MarkdownSectionContentGap[]; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics }) {
  const plannedTargets = sectionTargets(input.chapter, input.targetWords);
  const targetByTitle = new Map(plannedTargets.map(target => [target.title, target]));
  const forcedTargets = (input.forcedSections || [])
    .filter(gap => gap.chapterTitle === input.chapter.title && (gap.reason === 'empty' || gap.reason === 'missing_planned_section'))
    .map(gap => ({ title: gap.sectionTitle, targetWords: Math.max(targetByTitle.get(gap.sectionTitle)?.targetWords || 0, Math.floor(input.targetWords / Math.max(1, plannedTargets.length || input.forcedSections?.length || 1))), forced: true, reason: gap.reason }));
  const targets = [...plannedTargets];
  for (const forced of forcedTargets) {
    if (!targets.some(target => target.title === forced.title)) targets.push(forced);
  }
  if (targets.length < 1) return input.content;
  let content = input.content;
  const forcedTitleSet = new Set(forcedTargets.map(target => target.title));
  const allSupplementTargets = targets.map(target => {
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu'));
    const currentWords = documentTextLength(match?.[1] || '');
    const isEmptyOrNearlyEmpty = currentWords < 80;
    const forced = forcedTitleSet.has(target.title);
    return { ...target, currentWords, priority: forced ? 0 : isEmptyOrNearlyEmpty ? 1 : 2, forced, reason: forcedTargets.find(item => item.title === target.title)?.reason };
  }).filter(target => target.forced || target.currentWords < Math.max(360, Math.floor(target.targetWords * 0.7)))
    .sort((a, b) => a.priority - b.priority || a.currentWords - b.currentWords);
  const maxRepairTargets = Number(process.env.DOCUMENT_SECTION_REPAIR_MAX_TARGETS || 0);
  const supplementTargets = maxRepairTargets > 0 ? allSupplementTargets.slice(0, maxRepairTargets) : allSupplementTargets;
  const supplements = new Map<string, string | undefined>();
  const configuredConcurrency = Number(process.env.DOCUMENT_SECTION_SUPPLEMENT_CONCURRENCY || 2);
  const concurrency = Math.max(1, Math.min(supplementTargets.length || 1, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : 2));
  for (let offset = 0; offset < supplementTargets.length; offset += concurrency) {
    const batch = supplementTargets.slice(offset, offset + concurrency);
    const attempts = sectionSupplementAttempts(supplementTargets.length);
    const batchResults = await Promise.all(batch.map(async target => {
      try {
        const gapWords = Math.max(0, target.targetWords - target.currentWords);
        const strictSection = /概况|范围|工期|质量|安全|危大|资源|材料|设备|验收|清单|图纸|设计/u.test(target.title);
        const desiredRatio = strictSection ? 0.8 : 0.65;
        const minimumRatio = strictSection ? 0.5 : 0.35;
        const desiredTotalWords = Math.max(280, Math.ceil(target.targetWords * desiredRatio));
        const minimumSupplementWords = Math.max(220, Math.ceil(target.targetWords * minimumRatio));
        const forcedTargetWords = Math.max(desiredTotalWords - target.currentWords, minimumSupplementWords);
        const targetWords = Math.max(target.forced ? forcedTargetWords : gapWords, Math.ceil(target.targetWords * 0.35));
        return await buildQualifiedSectionSupplement({
          ...input,
          evidence: input.evidence,
          sectionTitle: target.title,
          targetWords,
          maxWords: Math.ceil(targetWords * 1.25),
        }, attempts);
      } catch {
        return undefined;
      }
    }));
    batch.forEach((target, index) => { supplements.set(target.title, batchResults[index]); });
  }
  for (const target of supplementTargets) {
    const supplement = supplements.get(target.title);
    if (supplement) content = replaceSectionContent(content, target.title, supplement);
  }
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(content, input.forbidDrawingImages));
}

const EXPANSION_INCREMENT_CHARS = 2000;
const EXPANSION_DEGRADED_INCREMENT_CHARS = 1000;
const EXPANSION_MAX_ROUNDS = 6;

export async function expandChapterToTarget(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; signal?: AbortSignal; strictBudget?: boolean; diagnostics?: DocumentGenerationDiagnostics }) {
  let content = input.content;
  let rounds = 0;
  const targetChars = input.targetChars;
  const maxChars = input.maxChars ?? Math.ceil(input.targetChars * 1.12);
  const totalDeficit = targetChars - documentTextLength(content);
  const maxRounds = totalDeficit <= 0 ? 0 : Math.min(EXPANSION_MAX_ROUNDS, Math.max(1, Math.ceil(totalDeficit / EXPANSION_INCREMENT_CHARS)));
  let noGrowthStreak = 0;
  for (; rounds < maxRounds && documentTextLength(content) < targetChars && documentTextLength(content) < maxChars; rounds += 1) {
    throwIfAborted(input.signal);
    const beforeChars = documentTextLength(content);
    const remaining = Math.max(0, targetChars - beforeChars);
    if (remaining <= 300) break;
    let grown = false;
    // 常规增量 → 超时/被拒后降档（增量减半）再试一次；成功后不再追加
    for (const increment of [Math.min(input.strictBudget ? 2400 : EXPANSION_INCREMENT_CHARS, remaining), Math.min(EXPANSION_DEGRADED_INCREMENT_CHARS, remaining)]) {
      if (increment <= 0 || grown) continue;
      throwIfAborted(input.signal);
      const currentChars = documentTextLength(content);
      const incrementalTarget = Math.min(targetChars, currentChars + increment);
      const roundMaxChars = Math.min(maxChars, currentChars + increment + (input.strictBudget ? 2200 : 1600));
      try {
        const expanded = await expandChapterContent({
          template: input.template,
          chapter: input.chapter,
          currentContent: content,
          evidence: input.evidence,
          promptTexts: input.promptTexts,
          requirement: input.requirement,
          roleContext: input.roleContext,
          targetChars: incrementalTarget,
          maxChars: roundMaxChars,
          forbidDrawingImages: input.forbidDrawingImages,
          maxTokens: outputTokensForChapter(currentChars + increment, incrementalTarget),
          signal: input.signal,
          diagnostics: input.diagnostics,
        });
        if (expanded && expanded !== content) {
          content = expanded;
          grown = true;
          break;
        }
        // 产出为空或被 acceptExpandedChapter 拒绝 → 降档增量再试
      } catch {
        // 模型失败 → 降档增量再试；用户中止直接抛出
        if (input.signal?.aborted) throw new Error('用户中止');
      }
    }
    if (grown && documentTextLength(content) > beforeChars + 200) {
      noGrowthStreak = 0;
    } else {
      noGrowthStreak += 1;
    }
    // 连续两轮无实质增长即停，避免轮轮空烧
    if (noGrowthStreak >= 2) break;
  }
  return { content, rounds };
}





/** 对生成的 Markdown 进行非重写式审查，只产出质量状态，不接管正文。 */


function splitTextForReview(text: string, chunkChars: number) {
  const normalized = text.trim(); if (!normalized) return [];
  const size = Math.max(1000, Math.ceil(chunkChars)); const chunks: string[] = []; let start = 0;
  while (start < normalized.length) { const end = Math.min(start + size, normalized.length); let cut = normalized.lastIndexOf('\n\n', end); if (cut <= start || end - cut > size * 0.25) { cut = normalized.lastIndexOf('\n', end); } if (cut <= start || end - cut > size * 0.2) { cut = end; } chunks.push(normalized.slice(start, cut).trim()); start = cut; }
  return chunks.filter(Boolean);
}
function chunkTextForReview(text: string, chunkChars: number) { return splitTextForReview(text, chunkChars).map((chunk, index) => `**第 ${index + 1}/${splitTextForReview(text, chunkChars).length} 部分**\n\n${chunk}`); }
function reviewItemToString(item: unknown) { return typeof item === 'string' ? item : (item && typeof item === 'object' && 'message' in (item as Record<string,unknown>) ? String((item as Record<string,unknown>).message) : JSON.stringify(item)); }
function mergeUniqueStrings(items: unknown[]) { return [...new Set(items.map(reviewItemToString).filter(Boolean))]; }
function envPositiveInt(name: string) { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0; }
function adaptiveReviewPlan(input: { totalChars: number; chapterCount: number; chunkChars: number; phase: string }) {
  const baseChunks = Math.ceil(input.totalChars / Math.max(1000, input.chunkChars));
  const chunks = input.phase === 'chapter' ? envPositiveInt('DOCUMENT_CHAPTER_REVIEW_MAX_CHUNKS') || Math.min(Math.max(2, Math.floor(input.totalChars / input.chapterCount / 4000)), baseChunks) : input.phase === 'global' ? envPositiveInt('DOCUMENT_GLOBAL_REVIEW_MAX_CHUNKS') || Math.min(4, baseChunks) : envPositiveInt('DOCUMENT_FINAL_REVIEW_MAX_CHUNKS') || Math.min(6, baseChunks);
  return { chunks, budgetPerChunk: Math.ceil(input.totalChars / Math.max(1, chunks)), maxIssues: Math.max(4, Math.min(28, Math.ceil(chunks * 2.5))) };
}

export async function understandReferenceFiles(projectRoot: string, evidence: DocumentEvidence[], signal?: AbortSignal): Promise<{ notes: string[]; stage: DocumentExecutionStage }> {
  const active = getActiveModelWithProvider(); if (!active) return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前模型不可用' }, { subtitle: '多模态参考文件' }) };
  let provider: ReturnType<typeof createProvider>;
  try {
    provider = createProvider(active.model.provider, { apiKey: active.provider.apiKey, baseUrl: active.provider.baseUrl, modelName: active.model.name, directEndpoint: active.provider.directEndpoint });
  } catch {
    return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: `当前模型服务 ${active.model.provider} 不支持多模态文件理解，已跳过` }, { subtitle: '多模态参考文件' }) };
  }
  const maxFiles = 4; const maxBytes = 8 * 1024 * 1024;
  const candidates = [...new Set(evidence.map(item => item.filePath).filter(file => /\.(png|jpe?g|webp|pdf|docx|xlsx)$/iu.test(file)))].slice(0, maxFiles);
  if (candidates.length === 0) return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '未找到多模态参考文件' }, { subtitle: '多模态参考文件' }) };
  const files: Array<{ name: string; buffer: Buffer; mimeType: string }> = [];
  for (const filePath of candidates) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath); if (!fs.existsSync(absPath)) continue;
    const stat = fs.statSync(absPath); if (stat.size > maxBytes) continue;
    files.push({ name: path.basename(filePath), buffer: fs.readFileSync(absPath), mimeType: /\.png$/iu.test(filePath) ? 'image/png' : /\.jpe?g$/iu.test(filePath) ? 'image/jpeg' : /\.webp$/iu.test(filePath) ? 'image/webp' : 'application/pdf' });
    if (files.length >= maxFiles) break;
  }
  if (files.length === 0) return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '未找到可读取的多模态文件' }, { subtitle: '多模态参考文件' }) };
  try { if (signal?.aborted) throw new Error('aborted'); const result = await (provider as any).understandFiles?.({ files }); if (!result?.length) return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'failed', message: '多模态模型未返回文件理解结果' }, { subtitle: '多模态参考文件' }) }; return { notes: result, stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'success', message: `已完成 ${result.length} 个多模态文件理解` }, { subtitle: '多模态参考文件' }) }; }
  catch (err) { console.error('[multimodal] failed:', err); return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'failed', message: '多模态文件理解失败' }, { subtitle: '多模态参考文件' }) }; }
}

export async function reviewGlobalConsistency(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; chapterReviews: ChapterReviewSummary[]; promptTexts: string; requirement?: string; projectContext?: string; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  throwIfAborted(input.signal); const summaries = input.chapters.map(ch => { const p = ch.content.replace(/#{1,6}\s+/gu,'').replace(/\*\*/gu,'').replace(/\|/gu,' ').replace(/[\n\r]+/gu,' ').trim(); return `章节：${ch.title}\n${p.slice(0,1600)}`; });
  const text = summaries.join('\n\n---\n\n'); const plan = adaptiveReviewPlan({ totalChars: text.length, chapterCount: input.chapters.length, chunkChars: 16000, phase: 'global' });
  const chunks = chunkTextForReview(text, 16000).slice(0, plan.chunks);
  const chunkReviews = await Promise.all(chunks.map(chunk => callDocumentLlmJson<{ issues?: string[] }>('你是专业文档审查专家。检查跨章节一致性。只返回 JSON。', `${input.promptTexts}\n\n${input.projectContext || ''}\n\n${chunk}\n\n返回 JSON：{"issues":[]}`, { maxTokens: 1000, temperature: 0.1, signal: input.signal, diagnostics: input.diagnostics })));
  const issues = mergeUniqueStrings(chunkReviews.flatMap(r => Array.isArray(r?.issues) ? r.issues : []));
  return { issues, stage: displayStage({ type: 'llm_review', roleId: 'global-consistency-review', status: issues.length > 0 ? 'failed' : 'success', message: issues.length > 0 ? `全局一致性审查完成：发现 ${issues.length} 个跨章问题` : '全局一致性审查通过' }, { subtitle: '全局一致性审查' }) };
}
