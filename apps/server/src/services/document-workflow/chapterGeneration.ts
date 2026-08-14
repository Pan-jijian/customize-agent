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
import { callDocumentLlm, callDocumentLlmJson, callWithTimeout, getActiveModelWithProvider } from './llmClient';
import { stringifyFactValue, throwIfAborted } from './utils';
import { selectByScore, factImportanceScore } from './selection';
import { lightweightChapterIssues, measureGenerationStep } from './rolePipeline';
import { displayChapterTitle } from './outline';
import { displayStage, elapsedMessage } from './progress';
import { normalizePlannedSections, professionalSectionTaskCard } from './promptRuleExtraction';

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
    projectBasicFacts.length ? `项目基础事实卡片（资料已明确，项目概况、项目基本信息表、进度和质量相关内容必须优先使用，不得写“资料未明确”）：\n${projectBasicFacts.map(fact => `- ${fact.key || fact.fieldName}：${cleanEvidenceText(stringifyFactValue(fact.value)).slice(0, 220)}${fact.sourceFile ? `（来源：${fact.sourceFile.split('/').pop()}）` : ''}`).join('\n')}\n项目基本信息表必须使用固定表头：| 信息项 | 内容 |，不得使用“序号｜项目名称｜内容参数”表头，不得输出后台溯源列。` : '',
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
export async function buildLlmChapterContent(template: DocumentTemplate, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[], promptTexts: string, projectContext: string, requirement?: string, roleContext = '', options: { forbidDrawingImages?: boolean; minWords?: number; targetWords?: number; maxWords?: number; maxTokens?: number; factCoverageContext?: string; signal?: AbortSignal; userWriterRules?: string } = {}) {
  const bundle = buildEvidenceBundle(chapter, evidence);
  const evidenceText = evidenceBundlePrompt(bundle, { maxChars: evidencePromptBudgetForTarget(options.targetWords || options.minWords) });
  // 即使 evidenceText 和 roleContext 为空，也让 LLM 基于 projectContext 和 promptTexts 尝试生成
  const sectionInstruction = chapter.sections?.length
    ? `本章小节由生成前规划得到，请完整包含并展开以下小节：\n${chapter.sections.map(section => `- ${section}`).join('\n')}`
    : '本章没有预设小节；请按用户提示词、模板章节、角色要求和绑定材料自然组织正文。';
  const sectionBudgetInstruction = buildSectionBudgetInstruction(chapter, options.targetWords || options.minWords || 0);
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
    requirement ? `用户要求：${requirement}` : '',
    projectContext ? `上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${projectContext}` : '',
    roleContext ? roleContext : '',
    options.factCoverageContext || '',
    missingFacts.length ? `需要特别补足的信息：${missingFacts.join('、')}` : '',
    '请生成可直接导出的 Markdown 章节，要求：',
    `- 保留章节标题；内容不少于 ${options.minWords || 1000} 字${options.targetWords ? `，目标约 ${options.targetWords} 字` : ''}${options.maxWords ? `，最多不超过 ${options.maxWords} 字` : ''}。`,
    chapter.sections?.length ? '- 必须完整包含已规划小节；不要新增未规划的二级小节。' : '- 未预设小节时，不要为了凑结构强行新增小节。',
    chapter.tableSections?.length ? `- 以下小节可使用表格辅助表达：${chapter.tableSections.join('、')}。` : '',
    '- 内容必须遵循用户提示词、模板章节、提示词角色、项目资料包和自动识别的资料类型；不得编造材料未提供的事实。',
    '- 将材料要点自然融入正文；不要输出系统证据清单、中间分析过程或后台流程话术。',
    SECTION_GENERATION_SAFETY_RULES,
    '',
    evidenceText ? '绑定材料：' : '',
    evidenceText,
    options.userWriterRules ? `\n【用户写作指令——必须严格遵守】\n${options.userWriterRules}` : '',
  ].filter(Boolean).join('\n');
  const content = await callDocumentLlm(system, prompt, false, { maxTokens: options.maxTokens, signal: options.signal });
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
  return selected.length > 0 ? selected : evidence;
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

export async function buildLlmSectionContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; sectionTitle: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; qualityFeedback?: string; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; timeoutMs?: number }) {
  const sectionEvidence = evidenceForSection(input.sectionTitle, input.chapter, input.evidence);
  const sectionFactCard = buildSectionFactCard(input.sectionTitle, sectionEvidence);
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, sectionEvidence), { maxChars: evidencePromptBudgetForTarget(input.targetWords, 3500, 9000) });
  const prompt = [
    `文档模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    `当前二级小节：${input.sectionTitle}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `上下文：\n${input.projectContext}` : '',
    input.factCoverageContext || '',
    professionalSectionTaskCard(input.chapter.title, input.sectionTitle),
    sectionFactCard.prompt,
    input.roleContext,
    input.missingFacts.length ? `需要特别补足的信息：${input.missingFacts.join('、')}` : '',
    input.qualityFeedback ? `上轮小节未通过质量检查，必须修正：${input.qualityFeedback}` : '',
    `请只生成当前二级小节正文，使用“### ${input.sectionTitle}”作为小节标题，目标约 ${input.targetWords} 字${input.maxWords ? `，最多不超过 ${input.maxWords} 字` : ''}。`,
    '本章二级小节结构已由系统按模板和提示词锁定；不得删除、重命名、合并或重排当前小节标题。',
    SECTION_GENERATION_SAFETY_RULES,
    evidenceText ? `绑定材料：\n${evidenceText}` : '',
  ].filter(Boolean).join('\n\n');
  const llmCall = (signal = input.signal) => callDocumentLlm([
    '你是专业文档的小节生成专家。',
    FORMAL_WRITING_RULES,
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), prompt, false, { maxTokens: Math.min(outputTokensForChapter(input.targetWords), Math.max(1800, Math.ceil(input.targetWords * 1.8))), temperature: 0.25, signal, timeoutMs: input.timeoutMs });
  const timedCall = () => callWithTimeout(signal => llmCall(signal), input.timeoutMs!, input.signal);
  const content = input.timeoutMs
    ? await (input.diagnostics
      ? measureGenerationStep(input.diagnostics, `section-draft:${input.chapter.id}:${input.sectionTitle}`, timedCall)
      : timedCall())
    : await llmCall();
  if (!content || content.length < 80) return undefined;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('### ') ? content : `### ${input.sectionTitle}\n\n${content}`, input.forbidDrawingImages));
  return normalized.replace(/^##\s+.*\n+/u, '').trim();
}

interface SectionWritingTask {
  sectionTitle: string;
  taskTitle: string;
  targetWords: number;
  index: number;
  total: number;
}

function writingTopicTitle(sectionTitle: string, index: number, total: number) {
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
  const maxTaskWords = Math.max(1400, Math.floor(Number(process.env.DOCUMENT_WRITING_TASK_MAX_WORDS ?? 2800)));
  const taskCount = targetWords > maxTaskWords * 1.5 ? Math.ceil(targetWords / maxTaskWords) : 1;
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

async function supplementSectionContent(input: Parameters<typeof buildLlmSectionContent>[0] & { currentContent: string; targetWords: number }) {
  const currentLength = documentTextLength(input.currentContent);
  const missing = input.targetWords - currentLength;
  const sectionEvidence = evidenceForSection(input.sectionTitle, input.chapter, input.evidence);
  const sectionFactCard = buildSectionFactCard(input.sectionTitle, sectionEvidence);
  if (missing <= Math.max(260, Math.floor(input.targetWords * 0.12))) return input.currentContent;
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, sectionEvidence), { maxChars: evidencePromptBudgetForTarget(Math.min(input.targetWords, 2600), 3500, 9000) });
  const patchTarget = Math.max(500, missing);
  const patch = await callWithTimeout(signal => callDocumentLlm([
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
  ].filter(Boolean).join('\n\n'), false, { maxTokens: outputTokensForChapter(patchTarget), temperature: 0.25, signal }), Math.max(120000, Math.min(300000, timeoutMsForChapter(patchTarget))), input.signal);
  const normalizedPatch = sanitizeFormalMarkdown(removeUnwantedDrawingImages(patch || '', input.forbidDrawingImages)).replace(/^#{3,4}\s+.*\n+/u, '').trim();
  return normalizedPatch ? `${input.currentContent.trim()}\n\n${normalizedPatch}` : input.currentContent;
}

export function chapterSectionFactUsageIssues(input: { chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[] }) {
  return sectionTargets(input.chapter, Math.max(1000, documentTextLength(input.content))).flatMap(target => {
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = input.content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu'));
    const body = match?.[1] || '';
    const factCard = buildSectionFactCard(target.title, evidenceForSection(target.title, input.chapter, input.evidence));
    const issue = sectionFactUsageIssue(target.title, body, factCard);
    return issue ? [`${target.title}：${issue}`] : [];
  });
}

function ensureNonEmptySectionContent(content: string, sectionTitle: string, evidence: DocumentEvidence[] = []) {
  const normalized = sanitizeFormalMarkdown(content || '').trim();
  const body = normalized.replace(/^#{3,4}\s+.+$/gmu, '').trim();
  if (documentTextLength(body) >= 180) return normalized;
  const factCard = buildSectionFactCard(sectionTitle, evidenceForSection(sectionTitle, { id: '', title: sectionTitle, purpose: '', queries: [], requiredFacts: [], sections: [sectionTitle] }, evidence));
  const facts = factCard.items.slice(0, 3).map(item => item.text);
  return sanitizeFormalMarkdown(`### ${sectionTitle}\n\n【本小节生成未达标，需重新生成】\n\n原因：大模型未返回有效正文或正文篇幅不足，系统未将兜底模板伪装为正式内容。${facts.length ? `\n\n已匹配资料：${facts.join('；')}。` : ''}`);
}

async function buildTaskBasedSectionContent(input: Parameters<typeof buildLlmSectionContent>[0]) {
  const tasks = writingTasksForSection(input.sectionTitle, input.targetWords);
  const parts: string[] = [];
  for (const task of tasks) {
    throwIfAborted(input.signal);
    const taskContent = await buildLlmSectionContent({
      ...input,
      sectionTitle: task.sectionTitle,
      targetWords: task.targetWords,
      maxWords: Math.ceil(task.targetWords * 1.18),
      qualityFeedback: task.total > 1 ? `这是首轮生成的主题任务 ${task.index}/${task.total}，只聚焦“${task.taskTitle}”。不得重复同小节其他主题的通用表述；优先写入与本主题相关的资料事实、规格、数量、标准、检查要求和执行动作。` : input.qualityFeedback,
    });
    if (taskContent) parts.push(sectionContentBody(taskContent));
  }
  if (parts.length === 0) return undefined;
  let merged = `### ${input.sectionTitle}\n\n${parts.join('\n\n')}`;
  merged = await supplementSectionContent({ ...input, currentContent: merged, targetWords: input.targetWords });
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(merged, input.forbidDrawingImages));
}

export async function buildSectionParallelChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext?: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; projectRoot?: string; modelName?: string; materialContextHash?: string; allowPartialResult?: boolean; sectionEvidenceProvider?: (sectionTitle: string) => Promise<DocumentEvidence[]>; onSectionProgress?: (event: { completed: number; total: number; sectionTitle?: string; phase: 'start' | 'complete' | 'retry' }) => void; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const targets = sectionTargets(input.chapter, input.targetWords);
  if (targets.length < 2) return undefined;
  const configuredSectionConcurrency = Number(process.env.DOCUMENT_SECTION_CONCURRENCY || targets.length || 1);
  const concurrency = Math.max(1, Math.min(targets.length, Number.isFinite(configuredSectionConcurrency) ? Math.floor(configuredSectionConcurrency) : (targets.length || 1)));
  const results: Array<string | undefined> = new Array(targets.length);
  let completedCount = 0;
  const runSection = async (item: { title: string; targetWords: number }, compact = false) => {
    input.onSectionProgress?.({ completed: completedCount, total: targets.length, sectionTitle: item.title, phase: compact ? 'retry' : 'start' });
    try {
      // 小节级超时与模型输出速度校准（实测 10-16 字/秒）：~1600 字小节需 100-160 秒，
      // 原 75-120s 上限必然超时；紧凑重试与最终补写同步放宽
      const sectionTimeoutMs = compact ? Math.max(120_000, Math.min(180_000, Math.ceil(timeoutMsForChapter(item.targetWords) * 0.8))) : Math.max(150_000, Math.min(240_000, Math.ceil(timeoutMsForChapter(item.targetWords) * 1.2)));
      const sectionExtraEvidence = input.sectionEvidenceProvider
        ? (await callWithTimeout(() => input.sectionEvidenceProvider!(item.title), Math.min(25_000, Math.floor(sectionTimeoutMs * 0.25)), input.signal)) || []
        : [];
      const sectionInput = {
        ...input,
        evidence: sectionExtraEvidence.length ? [...input.evidence, ...sectionExtraEvidence] : input.evidence,
        projectContext: input.projectContext,
        roleContext: input.roleContext || '',
        factCoverageContext: input.factCoverageContext,
        sectionTitle: item.title,
        targetWords: item.targetWords,
        maxWords: input.maxWords ? Math.max(item.targetWords, Math.ceil(input.maxWords / targets.length)) : Math.ceil(item.targetWords * 1.12),
        timeoutMs: sectionTimeoutMs,
      };
      const content = (await callWithTimeout(signal => item.targetWords >= 1400
        ? buildTaskBasedSectionContent({ ...sectionInput, signal })
        : buildQualifiedSectionSupplement({ ...sectionInput, signal }, sectionSupplementAttempts(targets.length)), sectionTimeoutMs, input.signal)) || undefined;
      if (content) {
        completedCount += 1;
        input.onSectionProgress?.({ completed: completedCount, total: targets.length, sectionTitle: item.title, phase: 'complete' });
      }
      return content;
    } catch (error) {
      console.warn(`[document-workflow] 小节生成失败：${input.chapter.title} / ${item.title}`, error);
      return undefined;
    }
  };
  const llmSectionLimit = targets.length;
  for (let offset = 0; offset < llmSectionLimit; offset += concurrency) {
    throwIfAborted(input.signal);
    const batch = targets.slice(offset, Math.min(llmSectionLimit, offset + concurrency));
    const batchResults = await Promise.all(batch.map(item => runSection(item)));
    batchResults.forEach((content, index) => { results[offset + index] = content; });
  }
  let missingIndexes = results.map((content, index) => content ? -1 : index).filter(index => index >= 0);
  if (input.allowPartialResult) {
    const sectionContents = results.map((content, index) => ensureNonEmptySectionContent(content || '', targets[index].title, input.evidence));
    return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${sectionContents.join('\n\n')}`, input.forbidDrawingImages));
  }
  const retryIndexes = missingIndexes;
  if (retryIndexes.length > 0) {
    for (let offset = 0; offset < retryIndexes.length; offset += concurrency) {
      throwIfAborted(input.signal);
      const batchIndexes = retryIndexes.slice(offset, offset + concurrency);
      const batchResults = await Promise.all(batchIndexes.map(index => runSection(targets[index], true)));
      batchResults.forEach((content, index) => { if (content) results[batchIndexes[index]] = content; });
    }
    missingIndexes = results.map((content, index) => content ? -1 : index).filter(index => index >= 0);
    // 最终补写：并发批次执行（原为逐个串行，单节 150s 超时下多节串行轻易超出外层总控）
    const finalRetryIndexes = missingIndexes.slice(0, concurrency);
    if (finalRetryIndexes.length > 0) {
      throwIfAborted(input.signal);
      const finalResults = await Promise.all(finalRetryIndexes.map(index => runSection({ ...targets[index], targetWords: Math.max(targets[index].targetWords, 900) }, true)));
      finalResults.forEach((content, position) => { if (content) results[finalRetryIndexes[position]] = content; });
    }
  }
  const sectionContents = results.map((content, index) => ensureNonEmptySectionContent(content || '', targets[index].title, input.evidence));
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${sectionContents.join('\n\n')}`, input.forbidDrawingImages));
}

export function outputTokensForChapter(minWords: number, targetWords?: number) {
  const words = targetWords || minWords;
  return Math.min(24000, Math.max(5000, Math.ceil(words * 1.45)));
}

export function timeoutMsForChapter(targetWords?: number) {
  const words = targetWords || 1200;
  if (words >= 8000) return 300000;
  if (words >= 5000) return 240000;
  if (words >= 3000) return 180000;
  return 120000;
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

export async function expandChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; currentContent: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; maxTokens?: number; signal?: AbortSignal }) {
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
  ].filter(Boolean).join('\n\n'), false, { maxTokens: input.maxTokens ?? outputTokensForChapter(currentLength, input.targetChars), temperature: 0.25, signal: input.signal });
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

export async function supplementShortSections(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; forcedSections?: MarkdownSectionContentGap[]; signal?: AbortSignal }) {
  const plannedTargets = sectionTargets(input.chapter, input.targetWords);
  const targetByTitle = new Map(plannedTargets.map(target => [target.title, target]));
  const forcedTargets = (input.forcedSections || [])
    .filter(gap => gap.chapterTitle === input.chapter.title && ['empty', 'table_only'].includes(gap.reason))
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
  const concurrency = Math.max(1, supplementTargets.length || 1);
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
          timeoutMs: Math.max(75_000, Math.min(150_000, Math.ceil(timeoutMsForChapter(targetWords) * 0.55))),
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

// 扩写收敛器参数：与当前模型输出速度匹配（实测约 13-16 字/秒）。
// 小步增量保证单轮在超时内可写完；超时/被拒后降档增量重试一次，避免"大增量 + 严格超时"轮轮落空
const EXPANSION_INCREMENT_CHARS = 2000;
const EXPANSION_DEGRADED_INCREMENT_CHARS = 1000;
const EXPANSION_MAX_ROUNDS = 6;

export async function expandChapterToTarget(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; signal?: AbortSignal; strictBudget?: boolean }) {
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
      const timeoutMs = increment >= EXPANSION_INCREMENT_CHARS ? 240_000 : 180_000;
      try {
        const expanded = await callWithTimeout(
          signal => expandChapterContent({
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
            // token 预算按"全文重写（当前字数 + 本轮增量）"计算，避免输出截断导致 acceptExpandedChapter 拒绝
            maxTokens: outputTokensForChapter(currentChars + increment, incrementalTarget),
            signal,
          }),
          timeoutMs,
          input.signal,
        );
        if (expanded && expanded !== content) {
          content = expanded;
          grown = true;
          break;
        }
        // 产出为空或被 acceptExpandedChapter 拒绝 → 降档增量再试
      } catch {
        // 超时/失败 → 降档增量再试；用户中止直接抛出
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


export async function expandDocumentToBudget(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; budget: DocumentBudget; promptTexts: string; requirement?: string; forbidDrawingImages: boolean; signal?: AbortSignal; onRoundProgress?: (chapters: DocumentDraftChapter[], context: { round: number; totalChars: number; addedChars: number; maxRounds: number }) => void }) {
  if (!input.budget.minChars) return input.chapters;
  let chapters = input.chapters;
  let totalChars = documentTextLength(chapters.map(chapter => chapter.content).join('\n\n'));
  const maxDocumentRounds = Math.min(input.budget.longformStrict ? 10 : 6, expansionRoundsForDeficit(input.budget.minChars - totalChars) + 4);
  const concurrency = Math.max(1, input.chapters.length || 1);
  const lowGrowthChapterIds = new Set<string>();
  const documentMaxChars = input.budget.maxChars;
  for (let round = 0; round < maxDocumentRounds && totalChars < input.budget.minChars && (!documentMaxChars || totalChars < documentMaxChars); round += 1) {
    throwIfAborted(input.signal);
    const roundStartChars = totalChars;
    const remainingDeficit = Math.max(0, input.budget.minChars - totalChars);
    const expandableChapters = chapters.filter(chapter => !lowGrowthChapterIds.has(chapter.id));
    if (expandableChapters.length === 0 && totalChars < input.budget.minChars) lowGrowthChapterIds.clear();
    const activeChapters = chapters.filter(chapter => !lowGrowthChapterIds.has(chapter.id));
    const perChapterShare = Math.ceil(remainingDeficit / Math.max(1, activeChapters.length));
    const deficits = activeChapters
      .map(chapter => {
        const current = documentTextLength(chapter.content);
        const weightedTarget = input.budget.chapterTargets.get(chapter.id) || current;
        const target = Math.max(weightedTarget, current + Math.ceil(perChapterShare * (input.budget.longformStrict ? 1.35 : 1)));
        return { chapter, target, current, deficit: target - current };
      })
      .filter(item => item.deficit > (input.budget.longformStrict ? 120 : 500))
      .sort((a, b) => b.deficit - a.deficit);
    if (deficits.length === 0) break;
    for (let offset = 0; offset < deficits.length && totalChars < input.budget.minChars && (!documentMaxChars || totalChars < documentMaxChars); offset += concurrency) {
      throwIfAborted(input.signal);
      const remainingDocumentRoom = documentMaxChars ? Math.max(0, documentMaxChars - totalChars) : Number.POSITIVE_INFINITY;
      if (remainingDocumentRoom <= 300) break;
      const batchSize = documentMaxChars ? Math.max(1, Math.min(concurrency, Math.floor(remainingDocumentRoom / 800) || 1)) : concurrency;
      const batch = deficits.slice(offset, offset + batchSize);
      const perChapterRoom = Number.isFinite(remainingDocumentRoom) ? Math.max(500, Math.floor(remainingDocumentRoom / batch.length)) : undefined;
      const results = await Promise.all(batch.map(async item => {
        try {
          // 与章节扩写共用收敛器：小步增量 + 降档重试，避免慢模型下"大增量 + 严格超时"轮轮落空
          const increment = Math.min(item.deficit, input.budget.longformStrict ? 2400 : EXPANSION_INCREMENT_CHARS);
          const incrementalTarget = Math.min(item.target, item.current + increment);
          const maxChars = perChapterRoom ? Math.min(Math.ceil(incrementalTarget * 1.15), item.current + perChapterRoom) : Math.ceil(incrementalTarget * 1.15);
          const expanded = await expandChapterToTarget({ template: input.template, chapter: { id: item.chapter.id, title: item.chapter.title, purpose: item.chapter.title, queries: [], requiredFacts: [], sections: item.chapter.sections }, content: item.chapter.content, evidence: item.chapter.evidence, promptTexts: input.promptTexts, requirement: input.requirement, roleContext: '', targetChars: incrementalTarget, maxChars, forbidDrawingImages: input.forbidDrawingImages, signal: input.signal, strictBudget: input.budget.longformStrict });
          return { id: item.chapter.id, beforeChars: item.current, content: expanded.content };
        } catch {
          return { id: item.chapter.id, beforeChars: item.current, content: item.chapter.content };
        }
      }));
      for (const result of results) {
        const afterChars = documentTextLength(result.content);
        if (!input.budget.longformStrict && afterChars <= result.beforeChars + 300) lowGrowthChapterIds.add(result.id);
        chapters = chapters.map(chapter => chapter.id === result.id ? { ...chapter, content: result.content } : chapter);
      }
      totalChars = documentTextLength(chapters.map(chapter => chapter.content).join('\n\n'));
      input.onRoundProgress?.(chapters, { round: round + 1, totalChars, addedChars: Math.max(0, totalChars - roundStartChars), maxRounds: maxDocumentRounds });
    }
    const lowGrowthThreshold = input.budget.longformStrict ? 80 : 300;
    if (totalChars <= roundStartChars + lowGrowthThreshold) break;
  }
  return chapters;
}






/** 对生成的 Markdown 进行非重写式审查，只产出质量状态，不接管正文。 */


function splitTextForReview(text: string, chunkChars: number) {
  const normalized = text.trim(); if (!normalized) return [];
  const size = Math.max(1000, Math.ceil(chunkChars)); const chunks: string[] = []; let start = 0;
  while (start < normalized.length) { const end = Math.min(start + size, normalized.length); let cut = normalized.lastIndexOf('\n\n', end); if (cut <= start || end - cut > size * 0.25) { cut = normalized.lastIndexOf('\n', end); } if (cut <= start || end - cut > size * 0.2) { cut = end; } chunks.push(normalized.slice(start, cut).trim()); start = cut; }
  return chunks.filter(Boolean);
}
function chunkTextForReview(text: string, chunkChars: number) { return splitTextForReview(text, chunkChars).map((chunk, index) => `**第 ${index + 1}/${splitTextForReview(text, chunkChars).length} 部分**\n\n${chunk}`); }
function parseReviewJson(text: string | undefined) { if (!text) return undefined; const n = text.replace(/^```(?:json)?\s*/u, '').replace(/```$/u, '').trim(); try { return JSON.parse(n); } catch { return undefined; } }
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
  const provider = createProvider(active.model.provider, { apiKey: active.provider.apiKey, baseUrl: active.provider.baseUrl, modelName: active.model.name, directEndpoint: active.provider.directEndpoint });
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
  try { if (signal?.aborted) throw new Error('aborted'); const result = await (provider as any).understandFiles?.({ files }); if (!result?.length) return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'fallback', message: '多模态模型未返回文件理解结果' }, { subtitle: '多模态参考文件' }) }; return { notes: result, stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'success', message: `已完成 ${result.length} 个多模态文件理解` }, { subtitle: '多模态参考文件' }) }; }
  catch (err) { console.error('[multimodal] failed:', err); return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'failed', message: '多模态文件理解失败' }, { subtitle: '多模态参考文件' }) }; }
}

export async function reviewChapterSummaries(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; budget: DocumentBudget; promptTexts: string; requirement?: string; strategy: DocumentGenerationStrategy; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  throwIfAborted(input.signal); const plan = adaptiveReviewPlan({ totalChars: input.chapters.reduce((s,ch) => s + documentTextLength(ch.content), 0), chapterCount: input.chapters.length, chunkChars: 12000, phase: 'chapter' });
  // 章节并行审查（原为串行遍历每章，长文档耗时随章节数线性增长）
  const summaries: ChapterReviewSummary[] = await Promise.all(input.chapters.map(async chapter => {
    throwIfAborted(input.signal); const chunks = chunkTextForReview(chapter.content, 12000).slice(0, plan.chunks);
    const bundle = buildEvidenceBundle({ id: chapter.id, title: chapter.title, purpose: chapter.title, queries: [], requiredFacts: [] }, chapter.evidence);
    const evidenceText = evidenceBundlePrompt(bundle, { maxChars: plan.budgetPerChunk });
    const plain = chapter.content.replace(/#{1,6}\s+/gu, '').replace(/\*\*/gu, '').replace(/\|/gu, ' ').replace(/[\n\r]+/gu, ' ').trim();
    const head = plain.slice(0, Math.max(600, Math.floor(plan.budgetPerChunk * 0.7)));
    const tail = plain.length > head.length + 200 ? plain.slice(-Math.max(200, plan.budgetPerChunk - head.length)) : '';
    const summary = [`章节：${chapter.title}`, `字数：${documentTextLength(chapter.content)}`, evidenceText ? `证据：${evidenceText}` : '', `正文摘要：${head}${tail ? '\n尾部：'+tail : ''}`].filter(Boolean).join('\n').slice(0, plan.budgetPerChunk);
    const chunkReviews = await Promise.all(chunks.map(chunk => callDocumentLlmJson<{ issues?: string[]; suggestions?: string[] }>('你是专业文档审查专家。审查章节质量。只返回 JSON。', `${input.promptTexts}\n\n${summary}\n\n${chunk}\n\n返回 JSON：{"issues":[],"suggestions":[]}`, { maxTokens: 1200, temperature: 0.1, signal: input.signal, diagnostics: input.diagnostics })));
    const issues = mergeUniqueStrings(chunkReviews.flatMap(r => Array.isArray(r?.issues) ? r.issues : [])).slice(0, plan.maxIssues);
    const suggestions = mergeUniqueStrings(chunkReviews.flatMap(r => Array.isArray(r?.suggestions) ? r.suggestions : [])).slice(0, plan.maxIssues);
    return { chapterId: chapter.id, title: chapter.title, status: issues.length > 0 ? 'fail' as const : 'pass' as const, issues, suggestions, chars: documentTextLength(chapter.content) };
  }));
  const failCount = summaries.filter(s => s.status !== 'pass').length;
  return { summaries, stage: displayStage({ type: 'llm_review', roleId: 'chapter-review', status: failCount > 0 ? 'fallback' : 'success', message: failCount > 0 ? `章节审查完成：${failCount}/${summaries.length} 章需要修复` : '章节审查完成，全部通过' }, { subtitle: '章节级质量审查' }) };
}

export async function reviewGlobalConsistency(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; chapterReviews: ChapterReviewSummary[]; promptTexts: string; requirement?: string; projectContext?: string; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  throwIfAborted(input.signal); const summaries = input.chapters.map(ch => { const p = ch.content.replace(/#{1,6}\s+/gu,'').replace(/\*\*/gu,'').replace(/\|/gu,' ').replace(/[\n\r]+/gu,' ').trim(); return `章节：${ch.title}\n${p.slice(0,1600)}`; });
  const text = summaries.join('\n\n---\n\n'); const plan = adaptiveReviewPlan({ totalChars: text.length, chapterCount: input.chapters.length, chunkChars: 16000, phase: 'global' });
  const chunks = chunkTextForReview(text, 16000).slice(0, plan.chunks);
  const chunkReviews = await Promise.all(chunks.map(chunk => callDocumentLlmJson<{ issues?: string[] }>('你是专业文档审查专家。检查跨章节一致性。只返回 JSON。', `${input.promptTexts}\n\n${input.projectContext || ''}\n\n${chunk}\n\n返回 JSON：{"issues":[]}`, { maxTokens: 1000, temperature: 0.1, signal: input.signal, diagnostics: input.diagnostics })));
  const issues = mergeUniqueStrings(chunkReviews.flatMap(r => Array.isArray(r?.issues) ? r.issues : []));
  return { issues, stage: displayStage({ type: 'llm_review', roleId: 'global-consistency-review', status: issues.length > 0 ? 'fallback' : 'success', message: issues.length > 0 ? `全局一致性审查完成：发现 ${issues.length} 个跨章问题` : '全局一致性审查通过' }, { subtitle: '全局一致性审查' }) };
}

function stripReviewChunkHeader(text: string) {
  return text.replace(/^\s*\*\*\s*第\s*\d+\s*\/\s*\d+\s*部分\s*\*\*\s*\n+/u, '').trim();
}

export async function reviewAndOptimizeMarkdown(input: { template: DocumentTemplate; spec?: any; markdown: string; evidence?: DocumentEvidence[]; promptTexts: string; requirement?: string; projectContext?: string; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  throwIfAborted(input.signal); const totalChars = documentTextLength(input.markdown); const plan = adaptiveReviewPlan({ totalChars, chapterCount: 1, chunkChars: 12000, phase: 'final' });
  const allParts = splitTextForReview(input.markdown, 12000);
  const reviewedParts = allParts.slice(0, plan.chunks);
  // 超出审查分片预算的尾部原文不参与 LLM 审查，但重建文档时必须原样保留，避免整篇内容丢失
  const unreviewedTail = allParts.slice(plan.chunks).join('\n\n');
  const chunks = reviewedParts.map((part, index) => `**第 ${index + 1}/${allParts.length} 部分**\n\n${part}`);
  const reviewedBatches = await Promise.all(chunks.map(chunk => callDocumentLlmJson<{ issues?: Array<{ message: string }>; optimized?: string }>('你是专业文档审查与优化专家。审查 Markdown 质量并输出优化建议。只返回 JSON。', `${input.promptTexts}\n\n${input.projectContext || ''}\n\n${chunk}\n\n返回 JSON：{"issues":[{"message":"问题描述"}],"optimized":"优化后的 Markdown 片段"}`, { maxTokens: 2000, temperature: 0.1, signal: input.signal, diagnostics: input.diagnostics })));
  const issues = reviewedBatches.flatMap(r => Array.isArray(r?.issues) ? r.issues.filter((i: any) => i?.message) : []).slice(0, plan.maxIssues);
  // 逐分片合并：只有审查返回有效 optimized 时才采用优化片段，否则保留原分片；
  // 避免"部分分片未返回 optimized 时整篇文档被少数片段替换"的内容丢失；同时剥离分片头部标记
  let optimizedCount = 0;
  const merged = chunks.map((chunk, index) => {
    const original = stripReviewChunkHeader(chunk);
    const candidate = reviewedBatches[index]?.optimized;
    const optimized = typeof candidate === 'string' && candidate.trim() ? stripReviewChunkHeader(candidate) : '';
    // 优化片段显著缩水（不足原文 60%）或与原文一致视为无效，保留原分片
    if (optimized && optimized !== original && optimized.length >= Math.floor(Math.max(1, original.length) * 0.6)) {
      optimizedCount += 1;
      return optimized;
    }
    return original;
  }).filter(Boolean);
  const markdown = [...merged, unreviewedTail].filter(Boolean).join('\n\n');
  const summaryMsg = optimizedCount > 0 ? `最终质量审查优化完成：生成 ${optimizedCount} 个优化片段（其余分片保留原文）` : issues.length > 0 ? `最终质量审查完成：发现 ${issues.length} 个问题` : '最终质量审查通过';
  return { markdown, stage: displayStage({ type: 'llm_review', roleId: 'final-quality-review', status: issues.length > 0 && optimizedCount === 0 ? 'fallback' : 'success', message: summaryMsg }, { subtitle: '最终质量审查' }) };
}
