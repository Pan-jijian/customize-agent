/**
 * 参考文件语义画像补充层（embedding 语义模型 + LLM 离线标注）。
 *
 * 画像分层依据（"正则 vs 语义"评估结论）：
 * - 确定性统计层（字数/表格数/章节层级/参数密度/标题结构）保留正则：这些是"形"的可数特征，
 *   正则口径与人工点验一致、可复现、零成本，LLM 统计反而引入随机性；
 * - 语义层用 embedding + LLM 离线标注：段落重复（同义改写型）、措施五要素闭合（同义岗位/频次表述）、
 *   工序链（自然语言流程，无"→"符号）是正则词表/符号匹配的盲区。
 *
 * 调用时机：仅在参考文件上传/画像版本迁移时离线调用一次，结果缓存于画像 semantic 字段
 * （PROFILE_VERSION 控制重算），生成链路只读缓存保证评分确定性；
 * 本层任一环节失败降级 undefined 或部分结果，回退正则层口径，不阻塞参考库可用性。
 */
import { getLocalSemanticProvider } from './semanticSimilarity';
import { callDocumentLlmJson } from './llmClient';

export interface SemanticProfileEnrichment {
  /** embedding 段落语义去重率：余弦 ≥0.85 的段落对占比（0-1），识别同义改写型重复（正则骨架去重的盲区） */
  semanticDuplicationRate: number;
  /** 参与语义去重计算的抽样段落数（供聚合加权与诊断） */
  semanticSegmentCount: number;
  /** LLM 五要素闭合块判定（方案+流程+责任人+时间节点+验收标准逐块标注，抽样口径） */
  llmFiveElement?: { completeBlocks: number; sampledBlocks: number; totalBlocks: number };
  /** LLM 工序链判定（段落是否描述工序先后关系，含自然语言流程表述，抽样口径） */
  llmArrowChain?: { chainSegments: number; sampledSegments: number; totalSegments: number };
  /** LLM 质量点评（亮点/短板/可对标点：管理页展示与生成侧范式参考，不参与评分公式） */
  qualityNotes?: { highlights: string[]; weaknesses: string[]; benchmarkable: string };
  /** 补充层构建时间戳（诊断用） */
  enrichedAt: number;
}

/** 语义去重抽样段数上限：O(n²) 点积，250 段 = 3.1 万次比较，本地向量零成本 */
const SEMANTIC_DUP_SAMPLE_LIMIT = 250;
/** 语义重复阈值：bge-small 归一化向量余弦 ≥0.85 视为语义重复段落（5 真实样本标定：字面重复对 ≥0.90，真重复间隙在 0.88 以下） */
const SEMANTIC_DUP_THRESHOLD = 0.85;
/** LLM 批注每批块数 */
const ANNOTATE_BATCH_SIZE = 60;
/** LLM 批注最大批次数（10 万字文档约 500-800 块，抽样 300 块 = 5 批） */
const ANNOTATE_MAX_BATCHES = 5;

/** 与正则画像同口径的正文段落切分（单行成段、≥16 字、含中文） */
function semanticSegments(text: string): string[] {
  return text
    .split(/\n+/u)
    .map(line => line.replace(/\s+/gu, ' ').trim())
    .filter(line => line.length >= 16 && /[\u4e00-\u9fa5]/u.test(line));
}

/** 与五要素闭合块评分同口径的块切分（空行分块、≥30 字） */
function measureBlocks(text: string): string[] {
  return text.split(/\n{2,}/u).map(block => block.replace(/\s+/gu, ' ').trim()).filter(block => block.length >= 30);
}

/** 均匀抽样：保持原文分布，控制 LLM 与向量计算成本 */
function evenSample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const step = items.length / limit;
  const sampled: T[] = [];
  for (let i = 0; sampled.length < limit && i < limit; i += 1) sampled.push(items[Math.floor(i * step)] || items[0]!);
  return sampled;
}

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += left[i] * right[i];
  return sum;
}

/**
 * embedding 段落语义去重：抽样段两两余弦，≥阈值视为语义重复对。
 * 与正则骨架去重互补：同义改写（换词换序）骨架不同但语义相同，只有向量才能识别。
 */
async function embeddingDuplicationRate(segments: string[], embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<{ semanticDuplicationRate: number; semanticSegmentCount: number } | undefined> {
  const sampled = evenSample(segments, SEMANTIC_DUP_SAMPLE_LIMIT);
  if (sampled.length < 8) return undefined;
  try {
    // 注入 embedDocuments 时不依赖本地模型实例（单测/替换实现），否则惰性获取共享 bge-small 实例
    const provider = embedDocuments ? null : getLocalSemanticProvider();
    const vectors = embedDocuments ? await embedDocuments(sampled) : provider ? await provider.embedDocuments(sampled) : [];
    if (vectors.length !== sampled.length) return undefined;
    let duplicatePairs = 0;
    let comparedPairs = 0;
    for (let i = 0; i < sampled.length; i += 1) {
      for (let j = i + 1; j < sampled.length; j += 1) {
        comparedPairs += 1;
        if (dot(vectors[i] || [], vectors[j] || []) >= SEMANTIC_DUP_THRESHOLD) duplicatePairs += 1;
      }
    }
    return { semanticDuplicationRate: comparedPairs > 0 ? duplicatePairs / comparedPairs : 0, semanticSegmentCount: sampled.length };
  } catch {
    return undefined;
  }
}

interface BlockAnnotation { fiveElementComplete: boolean; arrowChain: boolean }

/**
 * LLM 联合批注（五要素闭合 + 工序链，一次调用内完成两类判定）：
 * 每批 60 块，均匀抽样 ≤300 块；任何一批失败即中止并返回已成功批次聚合结果。
 */
async function llmBlockAnnotations(blocks: string[]): Promise<Array<{ batch: BlockAnnotation[]; totalBlocks: number }> | undefined> {
  const sampled = evenSample(blocks, ANNOTATE_BATCH_SIZE * ANNOTATE_MAX_BATCHES);
  if (sampled.length === 0) return undefined;
  const batches: Array<{ batch: BlockAnnotation[]; totalBlocks: number }> = [];
  for (let start = 0; start < sampled.length; start += ANNOTATE_BATCH_SIZE) {
    const batchBlocks = sampled.slice(start, start + ANNOTATE_BATCH_SIZE);
    const prompt = batchBlocks.map((block, index) => `【块${index}】${block.slice(0, 400)}`).join('\n');
    const result = await callDocumentLlmJson<{ blocks?: Array<{ fiveElementComplete?: boolean; arrowChain?: boolean }> }>(
      '你是施工组织设计质量标注专家。逐块判定（只依据该块文本，不联想上下文）：\n'
      + '1. fiveElementComplete：该块是否同时具备措施五要素——方案（制定/编制/建立/采用…制度、方案、措施）、流程（工序/步骤/顺序）、责任人（项目经理/技术负责人/施工员/质检员/安全员等具体岗位）、时间节点（每日/每周/每月/不少于X次/24小时等量化频次）、验收标准（验收/整改/复查/销项/闭环/合格）。五要素齐备才判 true，缺任一要素判 false。\n'
      + '2. arrowChain：该块是否描述施工工序先后关系或流程推进顺序（含"先…再…后…"自然语言表述，不要求出现"→"符号）。\n'
      + '只输出 JSON，格式：{"blocks":[{"fiveElementComplete":true,"arrowChain":false}]}，与输入块顺序一一对应。',
      prompt,
      { maxTokens: 4000, temperature: 0, disableThinkingBoost: true },
    );
    if (!result?.blocks || result.blocks.length === 0) break;
    const batch: BlockAnnotation[] = [];
    for (let i = 0; i < batchBlocks.length; i += 1) {
      const item = result.blocks[i];
      batch.push({ fiveElementComplete: Boolean(item?.fiveElementComplete), arrowChain: Boolean(item?.arrowChain) });
    }
    batches.push({ batch, totalBlocks: blocks.length });
  }
  return batches.length > 0 ? batches : undefined;
}

/** LLM 质量点评：亮点/短板/可对标点（管理页展示与生成侧范式参考，不参与评分公式）；
 * 异常静默降级 undefined，不得中断语义层其余环节（与“各环节独立降级”一致） */
async function llmQualityNotes(text: string, headingStructure: string[]): Promise<SemanticProfileEnrichment['qualityNotes'] | undefined> {
  try {
    const sample = text.slice(0, 12000);
    const result = await callDocumentLlmJson<{ highlights?: string[]; weaknesses?: string[]; benchmarkable?: string }>(
      '你是施工组织设计评审专家。基于提供的参考施组样本（节选），输出质量点评 JSON：\n'
      + '{"highlights":["值得对标的亮点，每条≤40字，最多5条"],"weaknesses":["明显短板，每条≤40字，最多5条"],"benchmarkable":"一段≤80字的最值得对标点总结"}。只输出 JSON。',
      `章节结构：${headingStructure.slice(0, 12).join(' / ')}\n\n样本节选：\n${sample}`,
      { maxTokens: 1200, temperature: 0, disableThinkingBoost: true },
    );
    if (!result) return undefined;
    return {
      highlights: Array.isArray(result.highlights) ? result.highlights.slice(0, 5) : [],
      weaknesses: Array.isArray(result.weaknesses) ? result.weaknesses.slice(0, 5) : [],
      benchmarkable: typeof result.benchmarkable === 'string' ? result.benchmarkable : '',
    };
  } catch {
    return undefined;
  }
}

/**
 * 构建语义画像补充层：embedding 去重 + LLM 批注 + LLM 点评。
 * 各环节独立降级：embedding 失败不影响 LLM 批注，全部失败返回 undefined。
 */
export async function buildSemanticProfileEnrichment(text: string, headingStructure: string[], embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<SemanticProfileEnrichment | undefined> {
  const segments = semanticSegments(text);
  const blocks = measureBlocks(text);
  if (segments.length === 0 && blocks.length === 0) return undefined;
  const enrichment: SemanticProfileEnrichment = { semanticDuplicationRate: 0, semanticSegmentCount: 0, enrichedAt: Date.now() };

  const semanticDup = await embeddingDuplicationRate(segments, embedDocuments);
  if (semanticDup) {
    enrichment.semanticDuplicationRate = semanticDup.semanticDuplicationRate;
    enrichment.semanticSegmentCount = semanticDup.semanticSegmentCount;
  }

  const annotationBatches = await llmBlockAnnotations(blocks);
  if (annotationBatches) {
    let completeBlocks = 0;
    let chainSegments = 0;
    let sampledBlocks = 0;
    for (const item of annotationBatches) {
      completeBlocks += item.batch.filter(annotation => annotation.fiveElementComplete).length;
      chainSegments += item.batch.filter(annotation => annotation.arrowChain).length;
      sampledBlocks += item.batch.length;
    }
    if (sampledBlocks > 0) {
      // 抽样密度还原为全文口径：LLM 判定率 × 全文块数，与正则层完整块数同口径可对比
      const totalBlocks = annotationBatches[0]?.totalBlocks || blocks.length;
      enrichment.llmFiveElement = { completeBlocks: Math.round((completeBlocks / sampledBlocks) * totalBlocks), sampledBlocks, totalBlocks };
      // 工序链判定同样基于块口径（与工序链正则统计的段落口径不同，字段注释已说明）
      enrichment.llmArrowChain = { chainSegments, sampledSegments: sampledBlocks, totalSegments: blocks.length };
    }
  }

  enrichment.qualityNotes = await llmQualityNotes(text, headingStructure);

  const hasAny = semanticDup || annotationBatches || enrichment.qualityNotes;
  return hasAny ? enrichment : undefined;
}
