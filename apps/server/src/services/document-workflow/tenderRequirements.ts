import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DocumentEvidence, DocumentGenerationDiagnostics, TenderRequirementItem, TenderRequirementModel, ValidationIssue } from './types';
import { callDocumentLlmJson, type DocumentJsonSchema } from './llmClient';
import { documentTextLength } from './budget';
import { cleanPdfHeadingNoise } from './factsModel';
import { buildSemanticSimilarity, type SemanticSimilarityFn } from './semanticSimilarity';
import { isBidDisciplineSentence, stableHash, systemConstraintLine } from './utils';

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
    // 模型忠实引用原文即触发 schema 校验失败 → callDocumentLlmJson 返回 undefined → 空模型 → skipped）；
    // maxItems 放宽（真实生成回归：条款条数超上限时模型会自行截断丢弃尾部条款——上限应仅防失控，
    // 不应成为条款丢失源；提取后仍在 cleanItems 按 text 去重）
    awardObjectives: { type: 'array', maxItems: 10, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    specialQualityStandards: { type: 'array', maxItems: 10, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    awardClauses: { type: 'array', maxItems: 10, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 200 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    greenBuildingGrade: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } },
    smartSiteGrade: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } },
    assemblyRate: { type: 'object', properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } },
    systematicBenchmarks: { type: 'array', maxItems: 10, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 120 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    // 投标人须知前附表响应条款（施组响应类实质条款；投标程序类不提取）
    frontScheduleClauses: { type: 'array', maxItems: 20, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 200 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
    dateFabricationProhibited: { type: 'boolean' },
    prohibitionNotes: { type: 'array', maxItems: 12, items: { type: 'object', required: true, properties: { text: { type: 'string', minLength: 2, maxLength: 200 }, coreTerms: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 24 } }, source: { type: 'string', maxLength: 80 } } } },
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
 * 输入 evidence 全量进入提取（无丢弃式截断）；单次输入超 SOURCE_SLICE_CHARS 时按原文顺序分片多轮提取，
 * 各片结果经 mergeTenderRequirements 字段级合并（数据零丢失，仅适配单次模型上下文）。
 */
export async function extractTenderRequirements(
  evidence: DocumentEvidence[],
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<TenderRequirementModel> {
  const empty = emptyTenderRequirements(false);
  if (!evidence || evidence.length === 0) return empty;
  // 分片阈值：每片约 4 万字符（注意力聚焦粒度，非上下文容量限制——DeepSeek-V4-Pro 上下文 1M token，
  // 不存在截断；真实生成回归根因是注意力稀释：招标文件 12 万字符分 2 片进主提取，黄山杯实质条款
  // （专用合同条款 5.1.1「确保黄山杯/300万元/二星级」）被前后海量噪声稀释漏提，且全程无任何信号）。
  // 按原文顺序累计分片——不是截断丢弃，而是全部内容分片完整进入提取，片间结果并集合并。
  const SOURCE_SLICE_CHARS = 40000;
  let sourceLines: string[] = [];
  let sourceChars = 0;
  const slices: string[][] = [];
  for (const item of evidence) {
    if (!item.content || !(item.content as string).trim()) continue;
    // round-23 P0-3：提取输入清 PDF 标题标记噪声（“平方\n\n### 米”夹断句会诱导模型输出截断坏值）
    const line = `【${item.filePath || '资料'}｜${item.sectionTitle || '正文'}】\n${cleanPdfHeadingNoise(item.content)}`;
    if (sourceLines.length > 0 && sourceChars + line.length > SOURCE_SLICE_CHARS) {
      slices.push(sourceLines);
      sourceLines = [];
      sourceChars = 0;
    }
    sourceLines.push(line);
    sourceChars += line.length;
  }
  if (sourceLines.length > 0) slices.push(sourceLines);

  async function extractSlice(lines: string[]): Promise<TenderRequirementModel> {
    const sourceTexts = lines.join('\n\n');
    if (!sourceTexts.trim()) return empty;
    const sourceHash = tenderRequirementsSourceHash(sourceTexts);
    // round-21 S6 修复：三处根因一并治理（历史缺陷：无输出骨架时模型自由发挥输出 coreTerms 罗列清单内容、
    // 2600 maxTokens 截断 finish_reason=length、评标办法正文因证据预算单文件上限截断进不了输入）。
    // ① prompt 内嵌 JSON 字段骨架（schema 仅代码侧后置校验，模型此前看不到字段结构）；
    // ② maxTokens 5000→16000（全量输入对应更大 JSON，输出截断会直接丢字段）；
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
        maxTokens: 16000,
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
      // 商务纪律类条款确定性过滤（评分报告问题2）：投标/评标纪律承诺、廉洁承诺类条款
      // 属商务投标函内容而非施组实质要求，提取后即丢弃——不注入写作、不参与零响应检测，
      // 从源头阻断「正文响应纪律条款」的产生（LLM 分类不稳定，确定性过滤兜底）
      frontScheduleClauses: cleanItems(result.frontScheduleClauses).filter(item => !isBidDisciplineSentence(item.text)),
      dateFabricationProhibited: result.dateFabricationProhibited === true,
      prohibitionNotes: cleanItems(result.prohibitionNotes).filter(item => !isBidDisciplineSentence(item.text)),
      pageLimit: cleanItem(result.pageLimit),
      evaluationScheme: cleanItem(result.evaluationScheme),
      extracted: true,
      sourceHash,
    };
  }

  // 分片结果并集合并（真实生成回归加固）：各片都是全文子集，任何片提到即保留——
  // 不能用窄通道的 mergeTenderRequirements（主结果优先）：4 万字符分 3 片后同一字段
  // （如 frontScheduleClauses/awardClauses）跨片分布，「前片优先」会把后片补充整体丢弃。
  let merged: TenderRequirementModel | undefined;
  for (const slice of slices) {
    const result = await extractSlice(slice);
    merged = merged ? mergeTenderRequirementSlices(merged, result) : result;
  }
  return merged || empty;
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

/**
 * 必提条款词形提示（召回兜底，仅用于证据定位非语义判断）：语义召回受 bge 相似度阈值 0.5
 * 与嵌入质量影响，短条必提条款切片可能低分漏网（真实生成回归：黄山杯条款位于专用合同条款
 * 5.1.1 长段落切片，语义特征相似度可能不足）——词形命中的切片直接纳入窄通道输入，
 * 由 LLM 小输入提取过滤无关内容。
 */
const MANDATORY_CLAUSE_LEXICAL_HINTS = /确保|争创|创优|获得.{0,10}[杯奖]|优质工程奖|绿色建筑|星级|智慧工地|装配率|装配式|六个百分百|四节一环保/u;

/** 要求类语义特征集（主提取有用数据预筛用）：覆盖创优/等级/质量/工期/人员/分包/付款等
 * 施组响应类条款语义——主提取不再全量吞入招标文件（12 万+字符中约半数属投标程序/清单/
 * 目录/格式类无用内容，稀释模型注意力），仅召回与要求语义相近的切片进提取输入 */
const REQUIREMENT_SEMANTIC_FEATURES = [
  ...MANDATORY_CLAUSE_SEMANTIC_FEATURES,
  '计划工期与工期延误违约赔偿条款',
  '质量目标必须达到合格或优良标准',
  '安全文明施工与扬尘治理要求',
  '项目经理与关键人员配置要求',
  '分包与转包限制条款',
  '材料设备采购与进场验收要求',
  '付款方式与资金安排条款',
  '缺陷责任期与质量保证金条款',
];

/** 主提取预筛义务词形：含施组响应类要求语气的切片直接保留（保宽不保窄，误杀条款是灾难）。
 * 严谨化（真实生成回归）：不采用宽泛的「应…满足|符合」模式——投标程序条款大量含该模式，
 * 会放行无用内容；聚焦奖项/等级/质量/工期/安全/材料工艺/人员管理六类施组实质响应词形 */
const OBLIGATION_LEXICAL_HINTS = /确保|争创|创优|优质工程奖|获得.{0,10}[杯奖]|鲁班奖|绿色建筑|星级|智慧工地|装配率|装配式|六个百分百|四节一环保|达到.{0,6}(合格|优良)|质量标准|验收标准|特殊要求|按最高标准执行|按计划|违约金|工期延误|计划工期|日历天|安全文明|文明施工|扬尘|实名制|劳资专管|承插型盘扣|钢板防护网|商品砼|预拌砂浆|见证取样|送样|项目经理|技术负责人|分包|转包|履约担保|质保金|缺陷责任期|施工组织方案|施工进度计划|专项施工方案|施工工艺|须达到|必须达到|不低于|不少于|不得超过|不得超出/u;

/** 纯投标程序/格式表格词形：仅当切片无义务词形且无语义命中时才据此剔除（三条件齐备才删，防误杀）。
 * 不含「中标通知书」——其常出现于合同文件组成清单等要求类上下文，误剔会连带丢要求条款 */
const PROGRAM_PROCEDURE_HINTS = /盖单位章|签字或盖章|年月日|投标总价|汇总表|计日工表|综合单价分析|单价小计|未计价材料费|开标时间|开标地点|递交截止|投标截止|解密|电子交易系统|保证金账户|开户银行|投标保证金|异议|投诉|技术热线|评标委员会由.{0,10}人|评标委员会组成|资格审查|四库一平台|保函|担保机构|受益人|开立人|签字盖章|密封|正本.{0,4}副本|联合体|清标/u;

/**
 * 主提取有用数据预筛（上下文聚焦治理）：招标文件全量直读中约半数切片属投标程序/清单/
 * 目录/格式类内容，与「要求与标准」提取无关——全量吞入既浪费上下文又稀释模型注意力
 * （真实生成回归：12 万字符全量分片下黄山杯等短条款被前后噪声稀释漏提）。
 * 预筛保守设计：义务词形或语义命中即保留；仅「无义务词形 + 无语义命中 + 纯程序词形」
 * 三条件齐备才剔除；预筛零命中回退全量（防误杀导致零输入）。
 */
export async function preselectTenderRequirementEvidence(evidence: DocumentEvidence[]): Promise<DocumentEvidence[]> {
  if (evidence.length <= 1) return evidence;
  const texts = evidence.map(item => cleanPdfHeadingNoise(`${item.sectionTitle || ''}\n${item.content || ''}`));
  const similarity = await buildSemanticSimilarity(REQUIREMENT_SEMANTIC_FEATURES, texts);
  const kept = evidence.filter((item, index) => {
    const text = texts[index];
    if (OBLIGATION_LEXICAL_HINTS.test(text)) return true;
    const semanticScore = Math.max(...REQUIREMENT_SEMANTIC_FEATURES.map(feature => similarity(feature, text)));
    if (semanticScore >= 0.45) return true;
    if (PROGRAM_PROCEDURE_HINTS.test(text)) return false;
    return true;
  });
  if (kept.length === 0) return evidence;
  return kept;
}

/** 必提条款语义召回：证据切片全量参与（无数量截断）与语义特征集余弦相似度 ≥0.5 为候选，
 * 按最高相似度排序（去重保序）；词形命中切片无条件纳入（兜底），避免 bge 低分漏网 */
export async function filterMandatoryClauseEvidence(evidence: DocumentEvidence[]): Promise<DocumentEvidence[]> {
  if (evidence.length === 0) return [];
  const candidates = evidence;
  const texts = candidates.map(item => cleanPdfHeadingNoise(`${item.sectionTitle || ''}\n${item.content || ''}`));
  const similarity = await buildSemanticSimilarity(MANDATORY_CLAUSE_SEMANTIC_FEATURES, texts);
  const scored = candidates
    .map((item, index) => ({ item, text: texts[index], score: Math.max(...MANDATORY_CLAUSE_SEMANTIC_FEATURES.map(feature => similarity(feature, texts[index]))) }))
    .filter(entry => entry.score >= 0.5 || MANDATORY_CLAUSE_LEXICAL_HINTS.test(entry.text))
    .sort((a, b) => b.score - a.score);
  const selected = scored;
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

/** 必提字段是否缺失：任一必提字段为空即触发窄通道补提（真实生成回归：主提取已拿到
 * 绿色/智慧工地/装配率但漏提「确保黄山杯」奖项条款时，旧的全空判定为 false → 窄通道整体
 * 被跳过 → 奖项零落位且零响应检测无警报）。窄通道前提是语义召回存在候选证据
 * （filterMandatoryClauseEvidence ≥0.5），无要求项目召回无候选不会触发 LLM 空跑。 */
export function missingMandatoryFields(model: TenderRequirementModel | undefined): boolean {
  if (!model) return true;
  return (
    model.awardObjectives.length === 0 ||
    model.awardClauses.length === 0 ||
    !model.greenBuildingGrade ||
    !model.smartSiteGrade ||
    !model.assemblyRate ||
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

/** 列表字段并集合并（按 text 去重保序） */
function unionItems(a: TenderRequirementItem[], b: TenderRequirementItem[]): TenderRequirementItem[] {
  const seen = new Set<string>();
  const result: TenderRequirementItem[] = [];
  for (const item of [...a, ...b]) {
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    result.push(item);
  }
  return result;
}

/**
 * 主提取分片结果并集合并：各片都是同一份资料的子集，任何片提到即保留（列表字段按 text 去重，
 * 标量字段取第一个非空值）——与窄通道合并的「主结果优先」语义不同。
 */
export function mergeTenderRequirementSlices(a: TenderRequirementModel, b: TenderRequirementModel): TenderRequirementModel {
  const first = (x: TenderRequirementItem | undefined, y: TenderRequirementItem | undefined) => x || y;
  return {
    ...a,
    awardObjectives: unionItems(a.awardObjectives, b.awardObjectives),
    specialQualityStandards: unionItems(a.specialQualityStandards, b.specialQualityStandards),
    awardClauses: unionItems(a.awardClauses, b.awardClauses),
    greenBuildingGrade: first(a.greenBuildingGrade, b.greenBuildingGrade),
    smartSiteGrade: first(a.smartSiteGrade, b.smartSiteGrade),
    assemblyRate: first(a.assemblyRate, b.assemblyRate),
    systematicBenchmarks: unionItems(a.systematicBenchmarks, b.systematicBenchmarks),
    frontScheduleClauses: unionItems(a.frontScheduleClauses, b.frontScheduleClauses),
    prohibitionNotes: unionItems(a.prohibitionNotes, b.prohibitionNotes),
    pageLimit: first(a.pageLimit, b.pageLimit),
    evaluationScheme: first(a.evaluationScheme, b.evaluationScheme),
    dateFabricationProhibited: a.dateFabricationProhibited || b.dateFabricationProhibited,
    extracted: a.extracted || b.extracted,
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

// ---------------------------------------------------------------------------
// 提取结果磁盘缓存（B 阶段）：同一项目资料未变化时跳过主提取/窄通道 2 次 LLM。
// 防脏双门禁：写门禁（坏结果永不固化——仅非空且必提字段齐全才落盘）+ 读门禁
// （结构无效/空模型/必提字段缺失的缓存一律不采用，历史脏数据无法复用）。
// 哈希失效：key = 提取器版本 + 招标文件直读集合哈希 + 预筛输入哈希，任一输入字节变化即失效；
// 提取 prompt / bge 召回特征集变更时递增版本号强制全体失效。
// ---------------------------------------------------------------------------

const TENDER_REQUIREMENTS_CACHE_VERSION = 'tender-requirements-extraction-v1';

function tenderRequirementsCacheRoot(projectRoot?: string) {
  const root = path.join(process.env.HOME || process.cwd(), '.customize-agent', 'cache', 'document-workflow', stableHash(projectRoot || 'default'));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 证据集合指纹：全内容哈希（非 head/tail 抽样）——专业文档条件/证据/数据必须精准，
 * 抽样哈希存在漏判变更风险，此处不省 */
function evidenceContentFingerprint(evidence: DocumentEvidence[]) {
  return evidence
    .map(item => ({ filePath: item.filePath || '', sectionTitle: item.sectionTitle || '', contentHash: stableHash(item.content || '') }))
    .sort((a, b) => `${a.filePath}|${a.sectionTitle}`.localeCompare(`${b.filePath}|${b.sectionTitle}`));
}

/** 提取缓存 key：提取器版本 + 招标文件直读集合 + 预筛输入（窄通道召回输入由直读集合确定性派生，已被覆盖） */
export function tenderRequirementsCacheKey(input: { collectionEvidence: DocumentEvidence[]; preselectEvidence: DocumentEvidence[] }) {
  return stableHash({
    version: TENDER_REQUIREMENTS_CACHE_VERSION,
    collection: evidenceContentFingerprint(input.collectionEvidence),
    preselectInput: evidenceContentFingerprint(input.preselectEvidence),
  });
}

/** 读缓存（防脏读门禁：文件损坏/空模型/必提字段缺失一律不采用） */
export function readCachedTenderRequirements(projectRoot: string | undefined, key: string): TenderRequirementModel | undefined {
  try {
    const file = path.join(tenderRequirementsCacheRoot(projectRoot), `tender-requirements-${key}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TenderRequirementModel;
    if (!hasTenderRequirements(parsed) || missingMandatoryFields(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 写缓存（防脏写门禁：空结果/必提字段缺失不落盘，坏数据永不固化；写失败静默降级为无缓存路径） */
export function writeCachedTenderRequirements(projectRoot: string | undefined, key: string, model: TenderRequirementModel | undefined) {
  if (!model || !hasTenderRequirements(model) || missingMandatoryFields(model)) return;
  try {
    fs.writeFileSync(path.join(tenderRequirementsCacheRoot(projectRoot), `tender-requirements-${key}.json`), JSON.stringify(model, null, 2));
  } catch {
    // 缓存写失败不影响生成
  }
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
    // 评标办法改系统侧消费：章节结构已按评标办法生成，正文不得复述评标办法、分值构成、评审程序
    // （评分报告 N3：评标办法原文注入写手 projectContext 后被整段复述进正文）
    lines.push(`评标办法已由系统消费为章节结构（六章），正文不得复述评标办法原文、分值构成与评审程序；各评审项内容要对应到具体章节并做到针对性强、可落地。`);
  }
  if (lines.length === 0) return '';
  return `【招标文件评分项要求（系统从绑定资料提取，必须逐条响应，零响应即评标失分）】\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}\n${systemConstraintLine('以上为系统提取的评分项要求内容：实质要求（奖项名称、数字参数、等级指标等）必须显性响应进正文；本段提示词文字本身（编号、括号说明等元话语）禁止复述进正文')}`;
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
  // 商务纪律类条款确定性兜底（评分报告问题2）：投标/评标纪律承诺、廉洁承诺类条款属商务投标函
  // 内容，无论 LLM 分类结果如何一律 responsive=false——不进入零响应检测、不注入写作规则。
  // 词表与 utils.isBidDisciplineSentence 同口径（提取层已过滤，此处兜底提取漏网与 merge 残留）。
  const forcedProgrammatic = new Set<number>();
  trimmed.forEach((item, index) => {
    if (isBidDisciplineSentence(item.text)) forcedProgrammatic.add(index);
  });
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
  if (!raw?.results?.length) return new Map(trimmed.map((_, index) => [index, forcedProgrammatic.has(index) ? false : true]));
  const judged = new Map<number, boolean>();
  for (const entry of raw.results) {
    if (typeof entry.index === 'number') judged.set(entry.index, entry.responsive !== false);
  }
  return new Map(trimmed.map((_, index) => [index, forcedProgrammatic.has(index) ? false : (judged.get(index) ?? true)]));
}

/** 锚点或选型判定 schema（一次批量调用判定部分响应条款的锚点是否为"任一即可"关系） */
const ANCHOR_ALTERNATIVE_JSON_SCHEMA: DocumentJsonSchema = {
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
          alternative: { type: 'boolean', required: true },
        },
      },
    },
  },
};

/**
 * 锚点或选型批量判定（300万根治防误报）：条款锚点为"或/及/任选其一"关系
 * （如"省级或国家级奖项""A、B、C任选一项"）时，部分锚点命中不算部分响应；
 * 并列承诺/金额+奖项共存条款（"确保黄山杯，支付300万元"）必须全部锚点命中。
 * 分类调用失败时保守判定非或选型（宁报部分响应不漏检——评标失分风险大于多余修复成本）。
 */
export async function classifyAnchorAlternativeClauses(
  items: Array<{ text: string; missingAnchors: string[] }>,
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<Map<number, boolean>> {
  const trimmed = items.filter(item => item.text.trim());
  if (trimmed.length === 0) return new Map();
  const raw = await callDocumentLlmJson<{ results?: Array<{ index?: number; alternative?: boolean }> }>(
    [
      '你是招标要求条款锚点关系判定器。',
      '对每条条款判定其锚点之间的关系：',
      '- alternative=true：条款锚点为"或/及/任选其一"关系（如"省级或国家级奖项""A、B、C任选"），满足任一锚点即算完整响应',
      '- alternative=false：条款锚点必须全部满足（并列承诺、金额与奖项共存条款），缺任一锚点即部分响应',
      '只输出 JSON，不得输出其他内容。',
    ].join('\n'),
    trimmed.map((item, index) => `${index + 1}. 条款：${item.text}\n   未命中锚点：${item.missingAnchors.join('、') || '（无）'}`).join('\n'),
    {
      maxTokens: 1000,
      temperature: 0.1,
      signal: options.signal,
      diagnostics: options.diagnostics,
      schema: ANCHOR_ALTERNATIVE_JSON_SCHEMA,
      taskKind: 'structuredGeneration',
    },
  );
  if (!raw?.results?.length) return new Map(trimmed.map((_, index) => [index, false]));
  const judged = new Map<number, boolean>();
  for (const entry of raw.results) {
    if (typeof entry.index === 'number') judged.set(entry.index, entry.alternative === true);
  }
  return new Map(trimmed.map((_, index) => [index, judged.get(index) ?? false]));
}

/**
 * 剥离奖项名前导动词/承诺词（"为争创黄山杯"→"黄山杯"），循环剥离直至稳定。
 * requirementAnchorCoverage 与奖项杜撰检测共用，保证锚点提取口径一致
 * （具名奖项正则贪婪会吞入前导动词，如"确保黄山杯"整体成锚，与 coreTerms"黄山杯"口径分裂导致误报）。
 */
function stripAwardLeadVerb(award: string): string {
  let result = award;
  for (;;) {
    const stripped = result.replace(/^(?:争创|争取|力争|争获|确保|获得|创建|力创|评为|荣获|标为|目标为|承诺|为)/u, '');
    if (stripped === result || !stripped) break;
    result = stripped;
  }
  return result;
}

/**
 * 条款锚点覆盖判定（300万缺失根治，评分报告可优化项）：条款内全部关键锚点
 * （每个 coreTerms 专有名词、每个"数字+单位"、每个具名奖项/等级）必须各自字面命中正文。
 * 原 literalAnchorHit 任一锚点命中即放行整条条款——"确保黄山杯，支付300万元"条款中
 * "黄山杯"命中即整体放行，条款内数字参数"300万元"静默漏检（正文黄山杯13处/300万0处）。
 * 字面兜底保留（黄山杯实测 bge 0.50 < 0.6 被误报零响应——语义通道对短专有名词区分度不足），
 * 但升级为锚点全覆盖：全部命中才算完全响应，部分命中报"部分响应"定向补写缺失锚点。
 */
function requirementAnchorCoverage(item: TenderRequirementItem, normalizedMarkdown: string): { total: number; hit: string[]; missing: string[] } {
  const text = item.text.replace(/\s+/gu, '');
  const anchors = new Set<string>();
  // 专有名词：coreTerms 全部作为锚点（长度≥2；「或/及」条款的锚点必要性由 LLM 或选型判定兜底）
  for (const term of item.coreTerms) {
    const clean = term.replace(/\s+/gu, '');
    if (clean.length >= 2) anchors.add(clean);
  }
  // 数字参数：每个"数字+单位"组合都是独立锚点（正文数字繁多，纯数字不作锚点；单位词表限工程条款常用单位）
  for (const match of text.matchAll(/(?:\d+(?:\.\d+)?\s*(?:%|％|天|日|万元|亿元|元|米|m|M|mm|毫米|层|年|个|月|周|小时|分钟|项|处|台|套|辆|人|家|次|遍|道|吨|kPa|MPa))/giu)) {
    anchors.add(match[0].replace(/\s+/gu, ''));
  }
  // 具名奖项/等级：条款原文里的「XX杯/XX奖/XX星」锚点（「级」后缀过宽不取，靠 coreTerms/数字锚点覆盖）；
  // 正则贪婪会吞入前导动词（"确保黄山杯"），stripAwardLeadVerb 循环剥离保证与 coreTerms 口径一致
  for (const match of text.matchAll(/[\u4e00-\u9fa5]{2,6}[杯奖星]/gu)) {
    const award = stripAwardLeadVerb(match[0]);
    if (/^[\u4e00-\u9fa5]{2,7}$/u.test(award)) anchors.add(award);
  }
  const hit: string[] = [];
  const missing: string[] = [];
  for (const anchor of anchors) {
    (normalizedMarkdown.includes(anchor) ? hit : missing).push(anchor);
  }
  return { total: anchors.size, hit, missing };
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
  const partialResponseCandidates: Array<{ item: TenderRequirementItem; kind: string; bestSimilarity: number; hit: string[]; missing: string[] }> = [];
  for (const [index, { kind, item }] of items.entries()) {
    if (responsiveness.get(index) === false) continue;
    const query = tenderRequirementSemanticQuery(item);
    let bestSimilarity = 0;
    for (const target of targets) {
      const score = options.semanticSimilarity(query, target);
      if (score > bestSimilarity) bestSimilarity = score;
    }
    if (bestSimilarity >= 0.6) continue;
    // 字面锚点兜底升级（300万缺失根治）：语义未过阈值时，条款内全部关键锚点
    // （coreTerms 专有名词/数字+单位/具名奖项）各自字面命中才算完全响应（黄山杯 0.50 误报修复保留）
    const coverage = requirementAnchorCoverage(item, normalized);
    if (coverage.total > 0 && coverage.missing.length === 0) continue;
    if (coverage.hit.length > 0) {
      // 部分响应候选：锚点部分命中（实测"确保黄山杯，支付300万元"条款：黄山杯命中、300万元缺失），
      // "或/及"条款（任一锚点即可）由 LLM 批量判定兜底防误报
      partialResponseCandidates.push({ item, kind, bestSimilarity, hit: coverage.hit, missing: coverage.missing });
      continue;
    }
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
  // 部分响应：LLM 批量判定锚点是否"或/及"关系（任一即可），非或选型报部分响应定向补写缺失锚点
  if (partialResponseCandidates.length > 0) {
    const alternatives = await classifyAnchorAlternativeClauses(
      partialResponseCandidates.map(candidate => ({ text: candidate.item.text, missingAnchors: candidate.missing })),
      { signal: options.signal, diagnostics: options.diagnostics },
    );
    for (const [candidateIndex, candidate] of partialResponseCandidates.entries()) {
      if (alternatives.get(candidateIndex)) continue;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `评分项要求部分响应：${candidate.kind}“${candidate.item.text}”已命中“${candidate.hit.join('、')}”，但缺少“${candidate.missing.join('、')}”（最佳语义相似度 ${candidate.bestSimilarity.toFixed(2)}）`,
        suggestion: `条款内全部关键数据与奖项必须逐项显性响应：在对应章节补写“${candidate.missing.join('、')}”对应内容（缺一即部分响应）。`,
      });
    }
  }
  // round-23 P0-2 兜底：正文出现要求模型之外的具名奖项（“XX杯/XX奖”）时提示替换/杜撰风险
  // （外部评分否决级实测：“确保黄山杯”被写作层写成“争创庐州杯”）。通用词形检测不硬编码
  // 奖项名；“优质工程/样板工程”等通用荣誉措辞不算具名奖项，不误报。
  if (model) {
    const modelAwardTexts = [...model.awardObjectives, ...model.awardClauses].map(item => item.text);
    if (modelAwardTexts.length > 0) {
      // 奖项名主体提取：从「杯/奖」向左取 12 字窗口，杯/奖字左邻成对引号/括号内汉字段优先
      // （“黄山杯”/（庐州杯）——窗口正则会吞入前置从句词导致主体识别失败），否则回溯连续汉字段；
      // 提取后拼回杯/奖字保证奖项名完整（“庐州杯”而非“庐州”），再剥离前导动词（“为争创黄山杯”→“黄山杯”，
      // stripAwardLeadVerb 模块级函数与 requirementAnchorCoverage 共用保证口径一致）
      const namedAwards = new Set<string>();
      for (const match of normalized.matchAll(/[杯奖]/gu)) {
        // 4.12.13 真实生成回归：「奖」后紧跟励/金/惩/罚是「奖励/奖金/奖惩/奖罚」语素续接、
        // 紧跟「项」是通用词「奖项」（如「创优目标与奖项申报」），均非具名奖项——
        // 8 处假阻断全部来自奖惩管理/奖项申报词汇被截断为「XX奖」，修复者无错可修导致修复空转；
        // 杯字无此形态不检查
        const afterChar = normalized[(match.index || 0) + 1];
        if (match[0] === '奖' && afterChar !== undefined && /[励金惩罚项]/u.test(afterChar)) continue;
        const end = (match.index || 0) + 1;
        // 窗口取杯/奖字之前 12 字符（end-13 起、end-1 止，排除杯/奖字本身避免重复拼字）
        const before = normalized.slice(Math.max(0, end - 13), end - 1);
        const inside = before.match(/(?:（|\(|\u201c)([\u4e00-\u9fa5]{2,6})$/u);
        const body = inside ? inside[1] : before.match(/[\u4e00-\u9fa5]{2,6}$/u)?.[0];
        if (!body) continue;
        const award = stripAwardLeadVerb(body) + match[0];
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
