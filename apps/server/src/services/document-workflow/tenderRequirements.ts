import type { DocumentEvidence, DocumentGenerationDiagnostics, TenderRequirementItem, TenderRequirementModel, ValidationIssue } from './types';
import { callDocumentLlmJson, type DocumentJsonSchema } from './llmClient';
import { documentTextLength } from './budget';
import { cleanPdfHeadingNoise } from './factsModel';
import { buildSemanticSimilarity, type SemanticSimilarityFn } from './semanticSimilarity';

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
 * 提取失败/资料为空时返回 extracted=false 的空模型，下游不得据此阻断生成（LLM 不可用不得阻塞）。
 */

/** 空模型（LLM 不可用/无绑定资料时的降级产物） */
export function emptyTenderRequirements(extracted = false): TenderRequirementModel {
  return {
    awardObjectives: [],
    specialQualityStandards: [],
    awardClauses: [],
    systematicBenchmarks: [],
    frontScheduleClauses: [],
    dateFabricationProhibited: false,
    prohibitionNotes: [],
    extracted,
  };
}

export const REQUIREMENTS_JSON_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['awardObjectives', 'specialQualityStandards', 'awardClauses', 'systematicBenchmarks', 'prohibitionNotes'],
  properties: {
    // round-21 S6：maxLength 整体放宽（历史缺陷：奖项条款/评标办法原文单条常超旧上限 60/80 字符，
    // 模型忠实引用原文即触发 schema 校验失败 → callDocumentLlmJson 返回 undefined → 空模型 → skipped）
    awardObjectives: { type: 'array', maxItems: 6, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    specialQualityStandards: { type: 'array', maxItems: 6, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    awardClauses: { type: 'array', maxItems: 6, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 200 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    greenBuildingGrade: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } },
    smartSiteGrade: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } },
    assemblyRate: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } },
    systematicBenchmarks: { type: 'array', maxItems: 8, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    // 投标人须知前附表响应条款（施组响应类实质条款；投标程序类不提取）
    frontScheduleClauses: { type: 'array', maxItems: 12, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 200 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    dateFabricationProhibited: { type: 'boolean' },
    prohibitionNotes: { type: 'array', maxItems: 8, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 200 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    pageLimit: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } },
    evaluationScheme: { type: 'object', properties: { text: { type: 'string', minLength: 4, maxLength: 400 }, coreTerms: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } },
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
  frontScheduleClauses?: RawRequirementItem[];
  dateFabricationProhibited?: boolean;
  prohibitionNotes?: RawRequirementItem[];
  pageLimit?: RawRequirementItem;
  evaluationScheme?: RawRequirementItem;
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
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; /** 输入字符上限（窄通道小输入用，默认 150000） */ maxSourceChars?: number } = {},
): Promise<TenderRequirementModel> {
  const empty = emptyTenderRequirements(false);
  if (!evidence || evidence.length === 0) return empty;
  // round-21 S6：直读全文通道输入总量控制（招标文件 200+ 切片直读时防极端超长挤爆上下文；
  // 按原文顺序累计，超限即止——评标办法位于招标文件中前部，顺序截断不会丢评标办法正文）
  const MAX_SOURCE_CHARS = options.maxSourceChars ?? 150000;
  const sourceTextsParts: string[] = [];
  let sourceChars = 0;
  for (const item of evidence) {
    if (!item.content || !(item.content as string).trim()) continue;
    // round-23 P0-3：提取输入清 PDF 标题标记噪声（“平方\n\n### 米”夹断句会诱导模型输出截断坏值）
    const line = `【${item.filePath || '资料'}｜${item.sectionTitle || '正文'}】\n${cleanPdfHeadingNoise(item.content)}`;
    if (sourceChars > 0 && sourceChars + line.length > MAX_SOURCE_CHARS) break;
    sourceTextsParts.push(line);
    sourceChars += line.length;
  }
  const sourceTexts = sourceTextsParts.join('\n\n');
  if (!sourceTexts.trim()) return empty;
  const sourceHash = tenderRequirementsSourceHash(sourceTexts.slice(0, 6000));
  // round-21 S6 修复：三处根因一并治理（历史缺陷：无输出骨架时模型自由发挥输出 coreTerms 罗列清单内容、
  // 2600 maxTokens 截断 finish_reason=length、评标办法正文因证据预算单文件上限截断进不了输入）。
  // ① prompt 内嵌 JSON 字段骨架（schema 仅代码侧后置校验，模型此前看不到字段结构）；
  // ② maxTokens 2600→5000（实测 2.6 万 token 输入下 2600 必截断，JSON 解析失败 → 空模型 → skipped）；
  // ③ 排除指令：工程量清单项目特征不是评分项要求（输入混入清单内容时模型会罗列 coreTerms）。
  const skeleton = [
    '必须输出且仅输出一个 JSON 对象，字段结构如下（没有内容的字段输出空数组 [] 或省略可选字段，绝不输出其他字段名）：',
    '{',
    '  "awardObjectives": [{ "text": "创优目标原文", "coreTerms": ["核心词"], "source": "来源文件" }],',
    '  "specialQualityStandards": [{ "text": "...", "coreTerms": [], "source": "..." }],',
    '  "awardClauses": [{ "text": "...", "coreTerms": [], "source": "..." }],',
    '  "greenBuildingGrade": { "text": "...", "coreTerms": [], "source": "..." },',
    '  "smartSiteGrade": { "text": "...", "coreTerms": [], "source": "..." },',
    '  "assemblyRate": { "text": "...", "coreTerms": [], "source": "..." },',
    '  "systematicBenchmarks": [{ "text": "...", "coreTerms": [], "source": "..." }],',
    '  "frontScheduleClauses": [{ "text": "...", "coreTerms": [], "source": "..." }],',
    '  "dateFabricationProhibited": false,',
    '  "prohibitionNotes": [{ "text": "...", "coreTerms": [], "source": "..." }],',
    '  "pageLimit": { "text": "...", "coreTerms": [], "source": "..." },',
    '  "evaluationScheme": { "text": "...", "coreTerms": [], "source": "..." }',
    '}',
  ].join('\n');
  const result = await callDocumentLlmJson<RawTenderRequirements>(
    [
      '你是招标文件“要求与标准”结构化提取器。',
      '从施工项目绑定资料（招标文件/合同条款/技术标准/检查规范等）中提取文本性评分项要求——这些是评标专家会核对文档是否响应、且影响否决与得分的实质要求。',
      '只提取资料中明确写出的要求，绝不臆造；资料没有该类别时输出空数组或缺省。',
      'coreTerms 是用于在正文中核对该要求是否被响应的核心词（2-4 个），必须选最能代表该要求的专有名词/等级/体系名（如“黄山杯”“二星级”“六个百分百”），不要泛化词。',
      'dateFabricationProhibited：资料写明“以开工令为准/开工日期以监理开工令为准/不得自定开工日期”时为 true，否则 false。',
      'systematicBenchmarks 提取体系化基准要求（如“扬尘治理六个百分百”“四节一环保”），单条零散要求放 prohibitionNotes。',
      'frontScheduleClauses：从“投标人须知前附表/投标人须知”章节提取施工组织设计必须响应的实质条款——计划工期与质量要求、创优目标与奖惩（如“确保黄山杯，支付300万元”）、缺陷责任期与质保金、履约担保、工期延误赔偿、项目经理/关键人员要求、分包限制、装配式/绿色建筑/智慧工地等级、安全文明与扬尘要求、付款方式（影响资金安排）。只提取施组正文需要写入或必须遵守的条款；投标程序类条款（开标时间地点、保证金账户、投标文件递交/解密方式、评标委员会组成等纯程序信息）一律不提取。',
      'pageLimit：资料含篇幅/编制要求（如“不超过 50 页”）时提取。',
      'evaluationScheme：从评标办法章节提取结构性评分信息——评标办法类型、分值构成（技术文件/商务文件/报价文件分值）、技术文件详细评审内容项（逐项列出）、评分档位线（一般/良好/优秀分值区间）。text 用“；”分隔罗列原文关键信息；资料无评标办法章节时省略。',
      '工程量清单的项目特征描述不是评分项要求，不要提取。',
      skeleton,
      '只返回 JSON。',
    ].join('\n'),
    sourceTexts,
    {
      maxTokens: 5000,
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
    frontScheduleClauses: cleanItems(result.frontScheduleClauses),
    dateFabricationProhibited: result.dateFabricationProhibited === true,
    prohibitionNotes: cleanItems(result.prohibitionNotes),
    pageLimit: cleanItem(result.pageLimit),
    evaluationScheme: cleanItem(result.evaluationScheme),
    extracted: true,
    sourceHash,
  };
}

/**
 * 必提条款候选证据语义召回（round-23 P0-1 升级）：主提取的 150k 全量输入会稀释模型注意力，
 * 「确保黄山杯」等短条必提条款在全文长输入中漏提（外部评分否决级：全文零落位且写作层
 * 杜撰“庐州杯”替代）。召回由本地 bge-small 语义模型完成：必提条款语义特征集与证据切片
 * 余弦相似度排序取 top-k，不再使用词面词表正则（词表覆盖不全必漏变体奖项名与政策新词）。
 * 语义提取仍归 LLM 独立小输入，与主提取结果字段级合并。
 */
const MANDATORY_CLAUSE_SEMANTIC_FEATURES = [
  '工程创优奖项申报要求：争创或确保获得市级、省级或国家级优质工程奖，含具体奖项名称',
  '绿色建筑星级等级要求',
  '智慧工地等级要求',
  '装配式建筑装配率要求',
  '特殊质量标准与质量要求条款',
  '扬尘治理六个百分百要求',
  '质量目标必须确保达到合格或优良标准的要求',
];

/** 必提条款语义召回：证据切片与语义特征集余弦相似度 ≥0.5 为候选，按最高相似度排序取 top 40（去重保序） */
export async function filterMandatoryClauseEvidence(evidence: DocumentEvidence[]): Promise<DocumentEvidence[]> {
  if (evidence.length === 0) return [];
  const candidates = evidence.slice(0, 160);
  const texts = candidates.map(item => cleanPdfHeadingNoise(`${item.sectionTitle || ''}\n${item.content || ''}`).slice(0, 400));
  const similarity = await buildSemanticSimilarity(MANDATORY_CLAUSE_SEMANTIC_FEATURES, texts);
  const scored = candidates
    .map((item, index) => ({ item, text: texts[index], score: Math.max(...MANDATORY_CLAUSE_SEMANTIC_FEATURES.map(feature => similarity(feature, texts[index]))) }))
    .filter(entry => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, 40);
  const seen = new Set<string>();
  const result: DocumentEvidence[] = [];
  for (const entry of selected) {
    const clean = cleanPdfHeadingNoise(`${entry.item.sectionTitle || ''}\n${entry.item.content || ''}`);
    const key = `${entry.item.filePath}|${entry.item.sectionTitle || ''}|${clean.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...entry.item, content: clean });
  }
  return result;
}

/** 必提字段是否整体缺失（奖项/绿色/智慧工地/装配/体系基准全空才触发窄通道，避免无要求项目空跑） */
export function missingMandatoryFields(model: TenderRequirementModel | undefined): boolean {
  if (!model) return true;
  return (
    model.awardObjectives.length === 0 &&
    model.awardClauses.length === 0 &&
    !model.greenBuildingGrade &&
    !model.smartSiteGrade &&
    !model.assemblyRate &&
    model.systematicBenchmarks.length === 0
  );
}

/** 主提取与窄通道提取字段级合并：主结果非空字段优先（主输入覆盖全文），窄通道仅补齐缺失字段 */
export function mergeTenderRequirements(main: TenderRequirementModel, narrow: TenderRequirementModel): TenderRequirementModel {
  const pick = (a: TenderRequirementItem[], b: TenderRequirementItem[]) => (a.length > 0 ? a : b);
  return {
    ...main,
    awardObjectives: pick(main.awardObjectives, narrow.awardObjectives),
    specialQualityStandards: pick(main.specialQualityStandards, narrow.specialQualityStandards),
    awardClauses: pick(main.awardClauses, narrow.awardClauses),
    greenBuildingGrade: main.greenBuildingGrade || narrow.greenBuildingGrade,
    smartSiteGrade: main.smartSiteGrade || narrow.smartSiteGrade,
    assemblyRate: main.assemblyRate || narrow.assemblyRate,
    systematicBenchmarks: pick(main.systematicBenchmarks, narrow.systematicBenchmarks),
    frontScheduleClauses: pick(main.frontScheduleClauses, narrow.frontScheduleClauses),
    prohibitionNotes: pick(main.prohibitionNotes, narrow.prohibitionNotes),
    pageLimit: main.pageLimit || narrow.pageLimit,
    evaluationScheme: main.evaluationScheme || narrow.evaluationScheme,
    dateFabricationProhibited: main.dateFabricationProhibited || narrow.dateFabricationProhibited,
    extracted: main.extracted || narrow.extracted,
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
    model.frontScheduleClauses.length > 0 ||
    model.dateFabricationProhibited ||
    model.prohibitionNotes.length > 0 ||
    Boolean(model.evaluationScheme)
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
  itemLine('本项目创优目标（必须全文显性响应，质量目标章节必须逐条承接并配套创优保证措施；奖项名称必须与招标文件原文逐字一致，禁止替换、降级或省略为其他奖项名称，“确保/达到”不得弱化为“争创”）', model.awardObjectives);
  itemLine('特殊质量标准（实质性要求，质量目标必须显性写明）', model.specialQualityStandards);
  itemLine('奖项条款（与创优目标关联，创优保证措施须覆盖申报与兑现条件）', model.awardClauses);
  if (model.greenBuildingGrade) {
    lines.push(`绿色建筑等级要求：${model.greenBuildingGrade.text}。必须编制系统性绿色施工保证方案（节能/节地/节水/节材/室内环境指标控制与验收），不得仅以单一指标替代整体响应。`);
  }
  if (model.smartSiteGrade) lines.push(`智慧工地等级要求：${model.smartSiteGrade.text}，智慧工地建设方案须达到该等级。`);
  if (model.assemblyRate) lines.push(`装配率要求：${model.assemblyRate.text}，装配式施工方案须覆盖水平构件与相关部品。`);
  itemLine('体系基准要求（必须逐项覆盖表述，不得零散遗漏）', model.systematicBenchmarks);
  itemLine('投标人须知前附表响应条款（施组必须逐条响应或遵守，零响应即评标失分）', model.frontScheduleClauses);
  if (model.dateFabricationProhibited) {
    lines.push('禁止编造开工日期：招标文件以开工令时间为准，正文不得自行设定具体日历开工日期，一律表述为“以开工令时间为准”。');
  }
  itemLine('禁止性/约束性要求（正文不得违反）', model.prohibitionNotes);
  if (model.pageLimit) lines.push(`篇幅建议：${model.pageLimit.text}，注意控制篇幅与语言精练度。`);
  if (model.evaluationScheme) {
    lines.push(`评标办法（章节结构的最强约束）：${model.evaluationScheme.text}。正文章节结构必须逐项覆盖技术文件详细评审内容项，各评审项内容要对应到具体章节并做到针对性强、可落地；语言精练、不重复堆砌。`);
  }
  if (lines.length === 0) return '';
  return `【招标文件评分项要求（系统从绑定资料提取，必须逐条响应，零响应即评标失分）】\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
}

/**
 * 语义比对查询文本（单一来源）：核心词拼接优先，无核心词退回条款原文。
 * 构建语义相似度函数（leftTexts）与查询闭包（requirementsCoverageIssues/routeTenderRequirementsToChapters）
 * 必须同口径使用本函数——闭包缓存以文本字符串为 key，口径不一致会静默 cache miss 恒 0，
 * 导致「正文已响应仍报零命中（相似度 0.00）」的整组误报（合肥师范实测 6 条前附表条款全部误报）。
 */
export function tenderRequirementSemanticQuery(item: TenderRequirementItem): string {
  return item.coreTerms.length > 0 ? item.coreTerms.join(' ') : item.text;
}

/** 零响应检测项收集：展平模型中所有“必须被正文响应”的要求项 */
export function tenderRequirementCheckItems(model: TenderRequirementModel | undefined): Array<{ kind: string; item: TenderRequirementItem }> {
  if (!model) return [];
  const entries: Array<{ kind: string; item: TenderRequirementItem }> = [];
  for (const item of model.awardObjectives) entries.push({ kind: '创优目标', item });
  for (const item of model.specialQualityStandards) entries.push({ kind: '特殊质量标准', item });
  for (const item of model.awardClauses) entries.push({ kind: '奖项条款', item });
  for (const item of model.systematicBenchmarks) entries.push({ kind: '体系基准要求', item });
  for (const item of model.frontScheduleClauses) entries.push({ kind: '前附表响应条款', item });
  if (model.greenBuildingGrade) entries.push({ kind: '绿色建筑等级', item: model.greenBuildingGrade });
  if (model.smartSiteGrade) entries.push({ kind: '智慧工地等级', item: model.smartSiteGrade });
  if (model.assemblyRate) entries.push({ kind: '装配率要求', item: model.assemblyRate });
  return entries;
}

/** 程序性/实质性语义分类 schema（一次批量调用判定全部要求项是否施组应响应） */
const RESPONSIVENESS_JSON_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      required: true,
      minItems: 1,
      items: {
        type: 'object',
        required: true,
        properties: {
          index: { type: 'number', required: true },
          responsive: { type: 'boolean', required: true },
        },
      },
    },
  },
};

/**
 * 要求项程序性/实质性语义分类（h5 升级）：REQUIREMENT_BLACKLIST_RE 宽黑名单词面过滤
 * 会整条误滤（历史缺陷：「投标人须确保黄山杯」含「投标」被整条跳过、「合同工期」含「合同」
 * 被跳过——前附表实质条款零响应检测全面失效），改为 LLM 一次批量语义分类：
 * responsive=true 为施组正文必须响应的实质要求，false 为投标程序性条款（开标时间/保证金账户等）。
 * 分类调用失败时保守全检（宁多检不漏检——评标失分风险大于多余修复成本）。
 */
export async function classifyRequirementResponsiveness(items: Array<{ kind: string; text: string }>, options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {}): Promise<Map<number, boolean>> {
  const trimmed = items.map(item => ({ kind: item.kind, text: item.text.trim() })).filter(item => item.text.length > 0);
  if (trimmed.length === 0) return new Map();
  const raw = await callDocumentLlmJson<{ results?: Array<{ index?: number; responsive?: boolean }> }>(
    [
      '你是招标文件要求项程序性/实质性分类器。',
      '对每个要求项判定其是否属于施工组织设计正文必须响应的实质要求：',
      '- 实质要求（responsive=true）：创优目标与奖项、质量/工期/安全/环保目标、绿色建筑/智慧工地/装配式等级、扬尘治理、四节一环保、人员与分包要求、付款履约约束等施组需写入或遵守的条款',
      '- 程序性条款（responsive=false）：开标时间地点、保证金账户、投标文件递交/解密方式、评标委员会组成、投标有效期等纯投标程序信息',
      '只输出 JSON，不得输出其他内容。',
    ].join('\n'),
    trimmed.map((item, index) => `${index + 1}. [${item.kind}] ${item.text}`).join('\n'),
    {
      maxTokens: 2000,
      temperature: 0.1,
      signal: options.signal,
      diagnostics: options.diagnostics,
      schema: RESPONSIVENESS_JSON_SCHEMA,
      taskKind: 'structuredGeneration',
    },
  );
  if (!raw?.results?.length) return new Map(trimmed.map((_, index) => [index, true]));
  const judged = new Map<number, boolean>();
  for (const entry of raw.results) {
    if (typeof entry.index === 'number') judged.set(entry.index, entry.responsive !== false);
  }
  return new Map(trimmed.map((_, index) => [index, judged.get(index) ?? true]));
}

/**
 * 评分项要求零响应检测：每个要求项在正文中必须命中，零命中即评标失分风险 → error 进入交付阻断定向修复轮补写。
 * h5 升级：①程序性/实质性判定由 LLM 语义分类（删词面黑名单正则）；②覆盖判定纯语义——
 * 章节标题（响应路由锚点）+ 正文句（实质落位判定）bge 余弦 ≥0.6，删除显式词面快路径与双路径口径。
 */
export async function requirementsCoverageIssues(
  markdown: string,
  model: TenderRequirementModel | undefined,
  options: { semanticSimilarity: SemanticSimilarityFn; /** 正文句（语义判定的右侧文本，与章节标题同口径 join 后判定） */ bodyTexts?: string[]; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics },
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const items = tenderRequirementCheckItems(model);
  if (items.length === 0) return issues;
  const normalized = markdown.replace(/\s+/gu, '');
  const chapterLines = markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => normalizeChapterTitleLine(line)).filter(Boolean).slice(0, 80);
  // 程序性/实质性语义分类：程序性条款（开标时间/保证金账户等）不参与零响应检测
  const responsiveness = await classifyRequirementResponsiveness(items.map(item => ({ kind: item.kind, text: item.item.text })), { signal: options.signal, diagnostics: options.diagnostics });
  const targets = options.bodyTexts && options.bodyTexts.length > 0 ? [...chapterLines, ...options.bodyTexts] : chapterLines;
  for (const [index, { kind, item }] of items.entries()) {
    if (responsiveness.get(index) === false) continue;
    const query = tenderRequirementSemanticQuery(item);
    let bestSimilarity = 0;
    for (const target of targets) {
      const score = options.semanticSimilarity(query, target);
      if (score > bestSimilarity) bestSimilarity = score;
    }
    if (bestSimilarity >= 0.6) continue;
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `评分项要求未响应：${kind}“${item.text}”在正文中零命中（最佳语义相似度 ${bestSimilarity.toFixed(2)}）`,
      suggestion: `招标文件明确要求的${kind}必须显性响应：在对应章节补写“${item.text}”及配套保证措施。`,
    });
  }
  // round-23 P0-2 兜底：正文出现要求模型之外的具名奖项（“XX杯/XX奖”）时提示替换/杜撰风险
  // （外部评分否决级实测：“确保黄山杯”被写作层写成“争创庐州杯”）。通用词形检测不硬编码
  // 奖项名；“优质工程/样板工程”等通用荣誉措辞不算具名奖项，不误报。
  if (model) {
    const modelAwardTexts = [...model.awardObjectives, ...model.awardClauses].map(item => item.text);
    if (modelAwardTexts.length > 0) {
      // 奖项名主体提取：从「杯/奖」向左取 12 字窗口，杯/奖字左邻成对引号/括号内汉字段优先
      // （“黄山杯”/（庐州杯）——窗口正则会吞入前置从句词导致主体识别失败），否则回溯连续汉字段；
      // 提取后拼回杯/奖字保证奖项名完整（“庐州杯”而非“庐州”），再循环剥离前导动词（“为争创黄山杯”→“黄山杯”）
      const stripAwardVerb = (award: string) => {
        let result = award;
        for (;;) {
          const stripped = result.replace(/^(?:争创|争取|力争|争获|确保|获得|创建|力创|评为|荣获|标为|目标为|承诺|为)/u, '');
          if (stripped === result || !stripped) break;
          result = stripped;
        }
        return result;
      };
      const namedAwards = new Set<string>();
      for (const match of normalized.matchAll(/[杯奖]/gu)) {
        const end = (match.index || 0) + 1;
        // 窗口取杯/奖字之前 12 字符（end-13 起、end-1 止，排除杯/奖字本身避免重复拼字）
        const before = normalized.slice(Math.max(0, end - 13), end - 1);
        const inside = before.match(/(?:（|\(|\u201c)([\u4e00-\u9fa5]{2,6})$/u);
        const body = inside ? inside[1] : before.match(/[\u4e00-\u9fa5]{2,6}$/u)?.[0];
        if (!body) continue;
        const award = stripAwardVerb(body) + match[0];
        if (!/^[\u4e00-\u9fa5]{2,7}$/u.test(award)) continue;
        namedAwards.add(award);
      }
      for (const award of namedAwards) {
        if (/优质工程|优良工程|样板工程|示范工程|文明工地|标准化工地/u.test(award)) continue;
        if (modelAwardTexts.some(text => text.includes(award))) continue;
        issues.unshift({
          level: 'error',
          severity: 'blocker',
          category: 'structure',
          owner: 'llm',
          repairability: 'llm_repairable',
          message: `奖项名称疑似杜撰/替换：正文出现“${award}”，不在招标文件奖项要求原文中（招标文件要求：${modelAwardTexts.map(text => text.slice(0, 60)).join('；')}）`,
          suggestion: `奖项名称必须与招标文件原文逐字一致：把正文“${award}”改为招标文件原文奖项名称，禁止替换、降级或省略；招标文件“确保/达到”类要求不得弱化为“争创/争取”。`,
        });
      }
      // “确保/达到”被弱化为“争创”的降级检测：要求原文含强制性措辞时，正文同奖项不得用争取类动词
      if (modelAwardTexts.some(text => /确保|必须|须/u.test(text))) {
        for (const award of namedAwards) {
          if (!modelAwardTexts.some(text => text.includes(award))) continue;
          if (!new RegExp(`(?:争创|争取|力争|争获)${award}`).test(normalized)) continue;
          issues.unshift({
            level: 'error',
            severity: 'blocker',
            category: 'structure',
            owner: 'llm',
            repairability: 'llm_repairable',
            message: `奖项承诺强度弱化：“${award}”前使用了争取类措辞（争创/争取/力争），招标文件要求为“确保/必须”级别`,
            suggestion: `招标文件“确保/达到”类等级要求不得弱化为“争创/争取”：把正文争取类措辞改为“确保${award}”并配套创优保证措施。`,
          });
        }
      }
    }
  }
  return issues.slice(0, 8);
}

/** 评分项要求↔章节路由（生成侧注入用）：语义相似度最高的章节为该要求的责任章节 */
export interface TenderRequirementRoute {
  kind: string;
  item: TenderRequirementItem;
  /** 目标章节标题（normalizeChapterTitleLine 归一化口径） */
  chapterTitle: string;
  score: number;
}

/** 路由相似度下限：低于该值不路由（要求项与任何章节语义都不近，走检测+修复轮兜底） */
const ROUTE_SCORE_MIN = 0.45;

/** 章节标题行归一化：去 markdown 标题前缀与编号前缀，保证与相似度闭包缓存 key 一致（缓存 miss 会静默返回 0） */
export function normalizeChapterTitleLine(line: string): string {
  return line.trim().replace(/^#{2,4}\s+/u, '').replace(/^\d+(?:\.\d+)*[\s、.]+/u, '').trim();
}

/**
 * 评分项要求章节级路由（W4/P3）：每个要求项路由到语义最相似章节，
 * 生成时注入该章 roleContext（“本章必须显性响应”），检测与生成同源同口径。
 * h5 升级：程序性/实质性判定由 LLM 语义分类（与零响应检测同口径），删词面黑名单正则。
 */
export async function routeTenderRequirementsToChapters(
  model: TenderRequirementModel | undefined,
  chapters: Array<{ title: string }>,
  similarity: SemanticSimilarityFn,
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<TenderRequirementRoute[]> {
  const routes: TenderRequirementRoute[] = [];
  if (!model) return routes;
  const chapterTitles = chapters.map(chapter => normalizeChapterTitleLine(chapter.title)).filter(Boolean);
  if (chapterTitles.length === 0) return routes;
  const items = tenderRequirementCheckItems(model);
  const responsiveness = await classifyRequirementResponsiveness(items.map(entry => ({ kind: entry.kind, text: entry.item.text })), { signal: options.signal, diagnostics: options.diagnostics });
  for (const [index, { kind, item }] of items.entries()) {
    if (responsiveness.get(index) === false) continue;
    const query = tenderRequirementSemanticQuery(item);
    let bestTitle = '';
    let bestScore = 0;
    for (const title of chapterTitles) {
      const score = similarity(query, title);
      if (score > bestScore) {
        bestScore = score;
        bestTitle = title;
      }
    }
    if (bestScore >= ROUTE_SCORE_MIN) routes.push({ kind, item, chapterTitle: bestTitle, score: bestScore });
  }
  return routes;
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
  if (model.frontScheduleClauses.length) summary.push(`前附表响应条款 ${model.frontScheduleClauses.length} 条：${model.frontScheduleClauses.map(item => item.text).slice(0, 8).join('、')}`);
  if (model.evaluationScheme) summary.push(`评标办法：${model.evaluationScheme.text.slice(0, 80)}`);
  if (model.dateFabricationProhibited) summary.push('禁编日期：以开工令为准');
  if (model.pageLimit) summary.push(`篇幅建议：${model.pageLimit.text}`);
  if (!model.extracted) summary.push('评分项要求未提取（无绑定资料或模型不可用），零响应检测跳过');
  return summary;
}

/** 正文文本长度工具（零响应检测场景重导出，供外部复用避免多路 import） */
export { documentTextLength };
