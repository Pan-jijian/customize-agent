import type { DocumentEvidence, DocumentGenerationDiagnostics, TenderRequirementItem, TenderRequirementModel, ValidationIssue } from './types';
import { callDocumentLlmJson, type DocumentJsonSchema } from './llmClient';
import { documentTextLength } from './budget';
import type { SemanticSimilarityFn } from './semanticSimilarity';

/**
 * 招标文件“要求与标准”层：把招标绑定资料中的文本性评分项要求（创优目标/绿色等级/特殊质量标准/
 * 体系基准/禁编条款等）LLM 结构化提取为 TenderRequirementModel，取代“只在评审标准章节里用正则抓
 * 编号条目”的旧通道。
 *
 * 历史缺陷（外部验收报告）：
 * - “确保黄山杯”位于投标人须知前附表 10.9 / 专用合同条款 5.1.1，不在评审标准章节，旧通道提取不到 → 零响应（否决级）；
 * - “绿色建筑国标二星级”位于第七章技术标准和要求，同样不在评审范围 → 弱响应；
 * - “以开工令为准”的禁编日期条款无人消费 → 正文编造开工日期。
 *
 * 架构定位：LLM 是执行器（提取+生成），代码是规范器（schema 校验+确定性检测+修复循环）。
 * 提取失败/资料为空时返回 extracted=false 的空模型，下游不得据此阻断生成（语义模型不可用不得阻塞）。
 */

/** 空模型（LLM 不可用/无绑定资料时的降级产物） */
export function emptyTenderRequirements(extracted = false): TenderRequirementModel {
  return {
    awardObjectives: [],
    specialQualityStandards: [],
    awardClauses: [],
    systematicBenchmarks: [],
    dateFabricationProhibited: false,
    prohibitionNotes: [],
    extracted,
  };
}

const REQUIREMENTS_JSON_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['awardObjectives', 'specialQualityStandards', 'awardClauses', 'systematicBenchmarks', 'prohibitionNotes'],
  properties: {
    awardObjectives: { type: 'array', maxItems: 6, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 60 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } }, source: { type: 'string', maxLength: 60 } } } },
    specialQualityStandards: { type: 'array', maxItems: 6, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 80 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } }, source: { type: 'string', maxLength: 60 } } } },
    awardClauses: { type: 'array', maxItems: 6, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 80 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } }, source: { type: 'string', maxLength: 60 } } } },
    greenBuildingGrade: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 60 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } }, source: { type: 'string', maxLength: 60 } } },
    smartSiteGrade: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 60 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } }, source: { type: 'string', maxLength: 60 } } },
    assemblyRate: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 60 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } }, source: { type: 'string', maxLength: 60 } } },
    systematicBenchmarks: { type: 'array', maxItems: 8, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 80 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } }, source: { type: 'string', maxLength: 60 } } } },
    dateFabricationProhibited: { type: 'boolean' },
    prohibitionNotes: { type: 'array', maxItems: 8, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 100 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } }, source: { type: 'string', maxLength: 60 } } } },
    pageLimit: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 60 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 16 } }, source: { type: 'string', maxLength: 60 } } },
  },
};

interface RawRequirementItem {
  text?: string;
  coreTerms?: string[];
  source?: string;
}

interface RawTenderRequirements {
  awardObjectives?: RawRequirementItem[];
  specialQualityStandards?: RawRequirementItem[];
  awardClauses?: RawRequirementItem[];
  greenBuildingGrade?: RawRequirementItem;
  smartSiteGrade?: RawRequirementItem;
  assemblyRate?: RawRequirementItem;
  systematicBenchmarks?: RawRequirementItem[];
  dateFabricationProhibited?: boolean;
  prohibitionNotes?: RawRequirementItem[];
  pageLimit?: RawRequirementItem;
}

function cleanItem(raw: RawRequirementItem | undefined): TenderRequirementItem | undefined {
  if (!raw?.text || raw.text.trim().length < 2) return undefined;
  return {
    text: raw.text.trim(),
    coreTerms: (raw.coreTerms || []).map(term => term.trim()).filter(term => term.length >= 2 && term.length <= 16).slice(0, 4),
    source: raw.source?.trim() || undefined,
  };
}

function cleanItems(raw: RawRequirementItem[] | undefined): TenderRequirementItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: TenderRequirementItem[] = [];
  for (const item of raw) {
    const cleaned = cleanItem(item);
    if (!cleaned) continue;
    const key = cleaned.text;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

/** 简单文本哈希（与提示词规则 sourceHash 同族算法） */
export function tenderRequirementsSourceHash(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/**
 * 从绑定资料 LLM 结构化提取招标评分项要求。
 * 输入 evidence 应已由调用方 selectEvidenceByBudget 限幅（全量招标+合同类资料优先）。
 */
export async function extractTenderRequirements(
  evidence: DocumentEvidence[],
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<TenderRequirementModel> {
  const empty = emptyTenderRequirements(false);
  if (!evidence || evidence.length === 0) return empty;
  const sourceTexts = evidence
    .filter(item => item.content && (item.content as string).trim())
    .map(item => `【${item.filePath || '资料'}｜${item.sectionTitle || '正文'}】\n${item.content}`)
    .join('\n\n');
  if (!sourceTexts.trim()) return empty;
  const sourceHash = tenderRequirementsSourceHash(sourceTexts.slice(0, 6000));
  const result = await callDocumentLlmJson<RawTenderRequirements>(
    [
      '你是招标文件“要求与标准”结构化提取器。',
      '从施工项目绑定资料（招标文件/合同条款/技术标准/检查规范等）中提取文本性评分项要求——这些是评标专家会核对文档是否响应、且影响否决与得分的实质要求。',
      '只提取资料中明确写出的要求，绝不臆造；资料没有该类别时输出空数组或缺省。',
      'coreTerms 是用于在正文中核对该要求是否被响应的核心词（2-4 个），必须选最能代表该要求的专有名词/等级/体系名（如“黄山杯”“二星级”“六个百分百”），不要泛化词。',
      'dateFabricationProhibited：资料写明“以开工令为准/开工日期以监理开工令为准/不得自定开工日期”时为 true，否则 false。',
      'systematicBenchmarks 提取体系化基准要求（如“扬尘治理六个百分百”“四节一环保”），单条零散要求放 prohibitionNotes。',
      '只返回 JSON。',
    ].join('\n'),
    sourceTexts,
    {
      maxTokens: 2600,
      temperature: 0.1,
      signal: options.signal,
      diagnostics: options.diagnostics,
      schema: REQUIREMENTS_JSON_SCHEMA,
      taskKind: 'structuredGeneration',
    },
  );
  if (!result) return { ...empty, sourceHash };
  return {
    awardObjectives: cleanItems(result.awardObjectives),
    specialQualityStandards: cleanItems(result.specialQualityStandards),
    awardClauses: cleanItems(result.awardClauses),
    greenBuildingGrade: cleanItem(result.greenBuildingGrade),
    smartSiteGrade: cleanItem(result.smartSiteGrade),
    assemblyRate: cleanItem(result.assemblyRate),
    systematicBenchmarks: cleanItems(result.systematicBenchmarks),
    dateFabricationProhibited: result.dateFabricationProhibited === true,
    prohibitionNotes: cleanItems(result.prohibitionNotes),
    pageLimit: cleanItem(result.pageLimit),
    extracted: true,
    sourceHash,
  };
}

/** 模型是否含有任何实质要求 */
export function hasTenderRequirements(model: TenderRequirementModel | undefined) {
  if (!model) return false;
  return (
    model.awardObjectives.length > 0 ||
    model.specialQualityStandards.length > 0 ||
    model.awardClauses.length > 0 ||
    Boolean(model.greenBuildingGrade) ||
    Boolean(model.smartSiteGrade) ||
    Boolean(model.assemblyRate) ||
    model.systematicBenchmarks.length > 0 ||
    model.dateFabricationProhibited ||
    model.prohibitionNotes.length > 0
  );
}

/**
 * 生成章节写作规则文本：注入 projectContext，要求生成时显性响应评分项要求。
 * 这是“要求层”的生成侧出口——不响应即评标失分，写作时必须逐条落位。
 */
export function tenderRequirementsWritingRules(model: TenderRequirementModel | undefined): string {
  if (!model || !hasTenderRequirements(model)) return '';
  const lines: string[] = [];
  const itemLine = (label: string, items: TenderRequirementItem[]) => {
    for (const item of items) {
      lines.push(`${label}：${item.text}${item.source ? `（来源：${item.source}）` : ''}。`);
    }
  };
  itemLine('本项目创优目标（必须全文显性响应，质量目标章节必须逐条承接并配套创优保证措施）', model.awardObjectives);
  itemLine('特殊质量标准（实质性要求，质量目标必须显性写明）', model.specialQualityStandards);
  itemLine('奖项条款（与创优目标关联，创优保证措施须覆盖申报与兑现条件）', model.awardClauses);
  if (model.greenBuildingGrade) {
    lines.push(`绿色建筑等级要求：${model.greenBuildingGrade.text}。必须编制系统性绿色施工保证方案（节能/节地/节水/节材/室内环境指标控制与验收），不得仅以单一指标替代整体响应。`);
  }
  if (model.smartSiteGrade) lines.push(`智慧工地等级要求：${model.smartSiteGrade.text}，智慧工地建设方案须达到该等级。`);
  if (model.assemblyRate) lines.push(`装配率要求：${model.assemblyRate.text}，装配式施工方案须覆盖水平构件与相关部品。`);
  itemLine('体系基准要求（必须逐项覆盖表述，不得零散遗漏）', model.systematicBenchmarks);
  if (model.dateFabricationProhibited) {
    lines.push('禁止编造开工日期：招标文件以开工令时间为准，正文不得自行设定具体日历开工日期，一律表述为“以开工令时间为准”。');
  }
  itemLine('禁止性/约束性要求（正文不得违反）', model.prohibitionNotes);
  if (model.pageLimit) lines.push(`篇幅建议：${model.pageLimit.text}，注意控制篇幅与语言精练度。`);
  if (lines.length === 0) return '';
  return `【招标文件评分项要求（系统从绑定资料提取，必须逐条响应，零响应即评标失分）】\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
}

/** 零响应检测项收集：展平模型中所有“必须被正文响应”的要求项 */
export function tenderRequirementCheckItems(model: TenderRequirementModel | undefined): Array<{ kind: string; item: TenderRequirementItem }> {
  if (!model) return [];
  const entries: Array<{ kind: string; item: TenderRequirementItem }> = [];
  for (const item of model.awardObjectives) entries.push({ kind: '创优目标', item });
  for (const item of model.specialQualityStandards) entries.push({ kind: '特殊质量标准', item });
  for (const item of model.awardClauses) entries.push({ kind: '奖项条款', item });
  for (const item of model.systematicBenchmarks) entries.push({ kind: '体系基准要求', item });
  if (model.greenBuildingGrade) entries.push({ kind: '绿色建筑等级', item: model.greenBuildingGrade });
  if (model.smartSiteGrade) entries.push({ kind: '智慧工地等级', item: model.smartSiteGrade });
  if (model.assemblyRate) entries.push({ kind: '装配率要求', item: model.assemblyRate });
  return entries;
}

const REQUIREMENT_BLACKLIST_RE = /投标|评标|招标|开标|合同|保证金|发票|账户|投诉|举报|credential|公共资源交易/u;

/** 章节标题行归一化：去 markdown 标题前缀与编号前缀，保证与相似度闭包缓存 key 一致（缓存 miss 会静默返回 0） */
export function normalizeChapterTitleLine(line: string): string {
  return line.trim().replace(/^#{2,4}\s+/u, '').replace(/^\d+(?:\.\d+)*[\s、.]+/u, '').trim();
}

/**
 * 评分项要求零响应检测：每个要求项在正文中必须命中（显式核心词包含 → 语义相似度），
 * 零命中即评标失分风险 → error 进入交付阻断定向修复轮补写。
 * 语义判定归语义模型：显式包含为确定性第一道，语义相似度为第二道（变体表述兜底），
 * 均不可用时仅显式判定（语义模型不可用不得阻塞生成）。
 */
export function requirementsCoverageIssues(
  markdown: string,
  model: TenderRequirementModel | undefined,
  options: { semanticSimilarity?: SemanticSimilarityFn } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const items = tenderRequirementCheckItems(model);
  if (items.length === 0) return issues;
  const normalized = markdown.replace(/\s+/gu, '');
  const chapterLines = markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => normalizeChapterTitleLine(line)).filter(Boolean).slice(0, 80);
  const chapterTexts = chapterLines.join(' ');
  for (const { kind, item } of items) {
    if (REQUIREMENT_BLACKLIST_RE.test(item.text) && !/创优|质量|绿色|星级|装配|智慧|扬尘|环保|安全|文明/u.test(item.text)) continue;
    const terms = item.coreTerms.filter(term => !REQUIREMENT_BLACKLIST_RE.test(term)).slice(0, 4);
    const explicitHit = terms.length > 0 ? terms.some(term => normalized.includes(term)) : normalized.includes(item.text);
    if (explicitHit) continue;
    let semanticHit = false;
    let bestSimilarity = 0;
    if (options.semanticSimilarity) {
      const query = item.coreTerms.join(' ') || item.text;
      for (const chapterTitle of chapterLines) {
        const score = options.semanticSimilarity(query, chapterTitle);
        if (score > bestSimilarity) bestSimilarity = score;
      }
      semanticHit = bestSimilarity >= 0.6;
    }
    if (semanticHit) continue;
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `评分项要求未响应：${kind}“${item.text}”在正文中零命中（核心词：${terms.join('/') || '无'}${options.semanticSimilarity ? `，最佳语义相似度 ${bestSimilarity.toFixed(2)}` : ''}）`,
      suggestion: `招标文件明确要求的${kind}必须显性响应：在对应章节补写“${item.text}”及配套保证措施，并确保核心词“${terms.join('、') || item.text}”落位。`,
    });
  }
  return issues.slice(0, 6);
}

/** 提取模型摘要（进度展示/诊断用） */
export function tenderRequirementsSummary(model: TenderRequirementModel | undefined): string[] {
  if (!model) return [];
  const summary: string[] = [];
  if (model.extracted) summary.push(`已从绑定资料结构化提取评分项要求（哈希 ${model.sourceHash?.slice(0, 8)}）`);
  if (model.awardObjectives.length) summary.push(`创优目标 ${model.awardObjectives.length} 条：${model.awardObjectives.map(item => item.text).join('、')}`);
  if (model.specialQualityStandards.length) summary.push(`特殊质量标准 ${model.specialQualityStandards.length} 条`);
  if (model.awardClauses.length) summary.push(`奖项条款 ${model.awardClauses.length} 条`);
  if (model.greenBuildingGrade) summary.push(`绿色建筑等级：${model.greenBuildingGrade.text}`);
  if (model.smartSiteGrade) summary.push(`智慧工地等级：${model.smartSiteGrade.text}`);
  if (model.assemblyRate) summary.push(`装配率：${model.assemblyRate.text}`);
  if (model.systematicBenchmarks.length) summary.push(`体系基准 ${model.systematicBenchmarks.length} 条：${model.systematicBenchmarks.map(item => item.text).join('、')}`);
  if (model.dateFabricationProhibited) summary.push('禁编日期：以开工令为准');
  if (model.pageLimit) summary.push(`篇幅建议：${model.pageLimit.text}`);
  if (!model.extracted) summary.push('评分项要求未提取（无绑定资料或模型不可用），零响应检测跳过');
  return summary;
}

/** 正文文本长度工具（零响应检测场景重导出，供外部复用避免多路 import） */
export { documentTextLength };
