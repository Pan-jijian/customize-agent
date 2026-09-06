import type { DocumentEvidence, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from './types';
import { buildEvidenceBundle, evidenceBundlePrompt, evidencePromptBudgetForTarget } from './evidence';
import { callDocumentLlmJson, contextLayerChars, type DocumentJsonSchema } from './llmClient';
import { buildSemanticSimilarity, type SemanticSimilarityFn } from './semanticSimilarity';
import { displayChapterTitle } from './outline';
import { CRITICAL_SECTION_ANCHORS, DIVISION_SECTION_RE, MAJOR_CONTENT_SECTION_RE, isCriticalSectionTitle } from './writingSpec';
import { docSystemPrefix } from './markdownComposer';

/**
 * 章级规划者（Chapter Planner）：把模板/OUTLINE 显式提供的细目清单重排为「三级主题块 + H4 要点」结构，
 * 从根本上解决「小节数 = LLM 调用数」的碎片化生成问题。
 *
 * 职责：
 * 1. 块候选聚类：确定性/轻量地把多达数十条的输入细目聚类为块候选（语义域粗分 + bge-small 余弦相似度细聚）；
 * 2. 逐块小步规划：每块一次小 LLM 调用产出该块 H4 结构（输出 ≤2000 token，远离 8192 共享输出池），块间并发；
 * 3. 语义合并：语义相近的细目由 LLM 合并进同一个重写标题的 H4 要点（sources 逐字保留被合并细目），
 *    从根本上消除「每条细目一个标题」的目录碎片化；代码侧确定性校验 100% 覆盖；
 * 4. 事实分配：关键证据只分配给唯一主题块，消除逐节现场检索导致的跨节重复引用；
 * 5. 字数预算：按 subPoints 数量加权分配每块目标字数（1200~2200），保证单节深度。
 *
 * 上下文：LLM 规划时注入项目图谱章节定向摘要与文档蓝图（本章任务卡/实施方案/事实覆盖矩阵），
 * 让合并决策基于项目实际结构（工程/工法/资源/工期/标准/风险/要求）而非标题表面相似度。
 *
 * 失败回退：块级失败隔离——单个块 LLM 失败/JSON 无效时该块由语义域确定性分组接管，不影响其他块。
 */

export interface PlannedChapterSubPoint {
  /** H4 要点标题（成稿时作为四级小节标题，LLM 可重写为更概括的标题） */
  title: string;
  /** 本 H4 覆盖的输入细目原文（逐字；多条 = 语义合并，覆盖校验与溯源用） */
  sources: string[];
}

export interface PlannedChapterBlock {
  /** 三级主题块标题（目录级小节） */
  title: string;
  /** 本块必须输出的 H4 要点（原细目映射） */
  subPoints: PlannedChapterSubPoint[];
  /** 分配给本块的事实线索（证据关键句，≤60 字/条，来自绑定资料原文） */
  facts: string[];
  /** 本块目标字数（1200~2200） */
  targetWords: number;
}

export interface PlannedChapterStructure {
  blocks: PlannedChapterBlock[];
  /** 已被映射的输入细目 */
  coveredSections: string[];
  /** 未映射成功、由兜底逻辑挂回的输入细目 */
  fallbackSections: string[];
  /** 是否由 LLM 规划（false=确定性回退结构） */
  llmPlanned: boolean;
  /** LLM 规划未命中原因（诊断与进度展示用） */
  llmFailure?: string;
}

const LF = String.fromCharCode(10);

/** 复刻 promptRuleExtraction 的标题规范化（仅取必要规则，避免引入私有依赖） */
function normalizePlannedTitle(title: string) {
  return displayChapterTitle(title.replace(/\*+/gu, ''))
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分、.．\s-]*/u, '')
    .replace(/^\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/^[-—–]\s*/u, '')
    .replace(/[<>]/gu, '')
    .replace(/[：:。；;,.，]+$/gu, '')
    .replace(/\s*[（(][^（）()]{0,40}[a-zA-Z]{3,}[^（）()]{0,40}[)）]\s*$/u, '')
    .trim();
}

function isInvalidTitle(title: string, chapterTitle: string) {
  const normalized = normalizePlannedTitle(title);
  if (normalized.length < 4 || normalized.length > 60) return true;
  if (normalized === normalizePlannedTitle(chapterTitle)) return true;
  if (/^(?:目录|章节|大纲|要求|说明|注意|输出|格式|示例|占位|提示|概述|总体要求)$/u.test(normalized)) return true;
  if (/如需|应由|大模型|提示词|上下文|OUTLINE|JSON|小节标题/u.test(normalized)) return true;
  // 评分项标题污染拦截：评分细目泄漏进目录时产生「2技术文件施工组织5分赋分」类标题，
  // 评分项只可写进正文内容，禁止作为小节/要点标题（生成缺陷实证：6.6 节标题被评分项顶替）
  if (/\d+\s*分(?:赋分|评[分判]|得)?|赋分|评分细则|评[分判]标准/u.test(normalized)) return true;
  if (/(.)\1/u.test(normalized)) return true;
  return false;
}

/** 二字滑窗重叠率：衡量两个标题的语义近似程度（挂接兜底用） */
function bigramOverlap(left: string, right: string) {
  const bigrams = (text: string) => {
    const set = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
    return set;
  };
  const target = bigrams(right);
  const source = [...bigrams(left)];
  if (source.length === 0) return 0;
  return source.filter(pair => target.has(pair)).length / source.length;
}

/** 小节语义域：确定性回退分组用（与 chapterGeneration.sectionDomain 保持同口径） */
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

/** 人材机三合一章资源三小节判定（结构补挂产物）：
 * 「确保人/材/机的保障体系与措施」必须各自独立成主题块（H3）与 H4 要点，
 * 不得被语义域分组/聚类/兜底挂接合并吞并（历史缺陷：三节同落「综合管理」域且 bigram 重叠 ≥0.75，
 * 被合并成单 H4，材/机保障体系降级挂在「确保人的保障体系与措施」H3 之下形成层级错位） */
function isResourceTriadSection(title: string) {
  return /^(?:确保\s*)?[人材机](?:员|力|料|械|工)?\s*的保障体系与措施$/u.test(title);
}

/** 主题块内 H4 要点上限：超过则切分新块，控制单次调用输出量 */
const MAX_SUB_POINTS_PER_BLOCK = 6;
/** 主题块最小/最大目标字数：上限 4000 与成稿侧 maxTokens = 目标×1.5 ≤ 6000 对应，
 * 8192 共享输出池内安全；长文目标（如 5 万字）靠目标驱动拆块增加块数承载，不再截断章级目标 */
const MIN_BLOCK_TARGET_WORDS = 1200;
const MAX_BLOCK_TARGET_WORDS = 4000;

/**
 * 评标必查细目锚定清单：从 writingSpec 单点消费（含关键小节写法规则的唯一来源），
 * 含锚定词的输入细目必须保留为独立 H4 要点（标题可微调但关键词必须保留），
 * 不得被主题块聚类合并吞并（历史缺陷：“项目主要施工内容”被并入“项目概况与施工内容综述”导致目录缺评标必查词）。
 */
export function isCriticalSection(title: string) {
  return isCriticalSectionTitle(title);
}

/** 输入细目清洗：过滤无效标题（指令型/占位型）并去重 */
export function cleanInputSections(chapter: DocumentTemplateChapter) {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of chapter.sections || []) {
    const title = normalizePlannedTitle(raw);
    if (!title || isInvalidTitle(title, chapter.title)) continue;
    const key = title.replace(/\s+/gu, '');
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(title);
  }
  return cleaned;
}

/** 细目文本匹配：去空白后相等或互相包含（LLM 输出的 sources 与输入细目对齐用） */
function sameSectionText(left: string, right: string) {
  const a = left.replace(/\s+/gu, '');
  const b = right.replace(/\s+/gu, '');
  return a === b || a.includes(b) || b.includes(a);
}

/** 细目是否已被某块映射（块标题或任一 subPoint.sources 包含匹配） */
function sectionMappedInBlock(section: string, block: PlannedChapterBlock) {
  if (sameSectionText(block.title, section)) return true;
  return block.subPoints.some(point => point.sources.some(source => sameSectionText(source, section)) || sameSectionText(point.title, section));
}

/**
 * 确定性覆盖校验与兜底：所有输入细目必须被某个块映射；
 * 未映射细目优先按二字滑窗相似度归并进最相似的既有 H4（sources 追加，不再新增标题），
 * 相似度过低时才新增 H4，保证评分条目 100% 承接且目录不碎片化。
 */
function ensureSectionCoverage(inputSections: string[], blocks: PlannedChapterBlock[]): PlannedChapterStructure {
  const coveredSections: string[] = [];
  const fallbackSections: string[] = [];
  const enriched = blocks.map(block => ({ ...block, subPoints: [...block.subPoints] }));
  for (const section of inputSections) {
    if (enriched.some(block => sectionMappedInBlock(section, block))) {
      coveredSections.push(section);
      continue;
    }
    let bestPoint: PlannedChapterSubPoint | undefined;
    let bestBlock: PlannedChapterBlock | undefined;
    let bestScore = -1;
    for (const block of enriched) {
      for (const point of block.subPoints) {
        const score = Math.max(bigramOverlap(section, point.title), ...point.sources.map(source => bigramOverlap(section, source)));
        if (score > bestScore) {
          bestScore = score;
          bestPoint = point;
          bestBlock = block;
        }
      }
    }
    // 容器小节与人材机三小节独立成块（H3 块标题）而非 H4 要点——H4 要点形态三缺陷（轮7 实测）：
    // 目录缺评标必查词（H4 不入目录）、骨架工作包 H4 与容器小节同级层级混淆、
    // 单要点预算被 12+ 工作包摊薄（22 个 H4 挤 2527 字 → 每包仅 100~300 字）；
    // 范围仅限工作包容器（项目主要施工内容/主要分部分项工程施工方案）+ 人材机三小节——
    // 非容器必查细目（危大工程/应急预案等）保持原 H4 挂接行为，不引入 3600 保底虚胖；
    // 先从既有块剥离同名映射（容器小节独占），再尾插独立块——保持块序稳定（目录顺序不变），
    // 且避免 dedupeCrossBlockOverlaps 按块序 claim 时前块先占导致新块 sources 被剥离整块删除
    if (isResourceTriadSection(section) || MAJOR_CONTENT_SECTION_RE.test(section) || DIVISION_SECTION_RE.test(section)) {
      for (const other of enriched) {
        other.subPoints = other.subPoints.filter(point => !sameSectionText(point.title, section) && !point.sources.some(source => sameSectionText(source, section)));
      }
      enriched.push({ title: section, subPoints: [{ title: section, sources: [section] }], facts: [], targetWords: MIN_BLOCK_TARGET_WORDS });
      fallbackSections.push(section);
      continue;
    }
    // 评标必查细目兜底保真：无论相似度多高都不得并入既有 H4，必须新增独立 H4 保留原标题，
    // 否则"危大工程/应急预案"等必查词会被语义合并吞掉，目录失分
    if (isCriticalSection(section)) {
      const targetBlock = bestBlock || enriched[enriched.length - 1];
      if (targetBlock) {
        targetBlock.subPoints.push({ title: section, sources: [section] });
        fallbackSections.push(section);
        continue;
      }
    }
    if (bestPoint && bestScore >= 0.5) {
      // 归并进既有 H4：LLM 的合并意图保留，代码只做承接挂接
      bestPoint.sources.push(section);
      fallbackSections.push(section);
    } else if (bestBlock) {
      bestBlock.subPoints.push({ title: section, sources: [section] });
      fallbackSections.push(section);
    } else {
      coveredSections.push(section);
    }
  }
  return { blocks: enriched, coveredSections, fallbackSections, llmPlanned: blocks.length > 0 };
}

/** 确定性回退结构：LLM 规划失败时按语义域分组，域内高相似细目合并进同一 H4（每块 ≤6 个 H4） */
export function fallbackStructureForSections(inputSections: string[], chapterTitle: string, targetWords: number): PlannedChapterStructure {
  const byDomain = new Map<string, string[]>();
  // 人材机三小节 bypass 语义域分组，各自独立成块（H3）：三节词面同构（bigram 重叠 ≥0.75）且同落
  // 「综合管理」域，混域处理必然被合并吞并（层级错位根因）；工作包容器小节（项目主要施工内容/
  // 主要分部分项工程施工方案）同理独立成块——H4 要点形态会目录缺词、层级混淆、预算摊薄（轮7 实测）；
  // 非容器必查细目（危大工程/应急预案等）不独立成块，按语义域正常分组（非容器无 3600 保底需求）
  const triadSections: string[] = [];
  const containerSections: string[] = [];
  for (const section of inputSections) {
    if (isResourceTriadSection(section)) { triadSections.push(section); continue; }
    if (MAJOR_CONTENT_SECTION_RE.test(section) || DIVISION_SECTION_RE.test(section)) { containerSections.push(section); continue; }
    const key = sectionDomain(section);
    const items = byDomain.get(key) || [];
    items.push(section);
    byDomain.set(key, items);
  }
  // 域内确定性合并：与上一条细目互为包含（如「X」与「X编制/记录」）或二字滑窗重叠率 ≥75% 时并入同一 H4（无 LLM 可用时仍保持目录瘦身）；评标必查细目不参与合并
  const mergeDomainSections = (items: string[]): PlannedChapterSubPoint[] => {
    const merged: PlannedChapterSubPoint[] = [];
    for (const section of items) {
      const last = merged[merged.length - 1];
      const lastSource = last ? last.sources[last.sources.length - 1] : '';
      if (!isCriticalSection(section) && !isResourceTriadSection(section) && last && (sameSectionText(section, lastSource) || bigramOverlap(section, lastSource) >= 0.75)) {
        last.sources.push(section);
        if (section.length > last.title.length) last.title = section;
      } else {
        merged.push({ title: section, sources: [section] });
      }
    }
    return merged;
  };
  const blocks: PlannedChapterBlock[] = [...triadSections, ...containerSections].map(section => ({ title: section, subPoints: [{ title: section, sources: [section] }], facts: [], targetWords: MIN_BLOCK_TARGET_WORDS }));
  for (const items of byDomain.values()) {
    const mergedPoints = mergeDomainSections(items);
    for (let offset = 0; offset < mergedPoints.length; offset += MAX_SUB_POINTS_PER_BLOCK) {
      const chunk = mergedPoints.slice(offset, offset + MAX_SUB_POINTS_PER_BLOCK);
      blocks.push({ title: chunk[0].title || chapterTitle, subPoints: chunk, facts: [], targetWords: MIN_BLOCK_TARGET_WORDS });
    }
  }
  // 4.12.17 章目标按块数+点数加权重分配（与 LLM 规划路径同口径）：
  // 原公式按 ceil(细目数/6) 预估块数把单块目标虚高到 4000（章 8333 字、7 条细目 4 域时每块 4000），
  // 块质检 0.5×目标=2000 字卡在模型单块自然输出（1600~2000 字）上方，实测 4/6 章大面积块判失败 → 整章降级 → 字数雪崩
  allocateBlockTargetWords(blocks, targetWords);
  return { blocks, coveredSections: inputSections.slice(), fallbackSections: [], llmPlanned: false };
}

/** 按 subPoints 数量加权分配每块目标字数（基数=章目标/块数，浮动 ±25%，封顶 1200~4000）；
 * 长文目标下达：章目标/块数超过单块安全上限时，按 H4 要点对半拆分大块直到均分目标不超上限，
 * 保证提示词篇幅预算（如 5 万字）不被块级封顶静默截断 */
function allocateBlockTargetWords(blocks: PlannedChapterBlock[], targetWords: number) {
  const maxSplitRounds = 2;
  for (let round = 0; round < maxSplitRounds && blocks.length > 0; round += 1) {
    const perBlock = Math.floor(targetWords / blocks.length);
    if (perBlock <= MAX_BLOCK_TARGET_WORDS) break;
    const biggest = blocks.reduce((left, right) => (right.subPoints.length > left.subPoints.length ? right : left), blocks[0]);
    if (biggest.subPoints.length < 2) break;
    const mid = Math.ceil(biggest.subPoints.length / 2);
    blocks.push({ title: biggest.subPoints[mid].title || biggest.title, subPoints: biggest.subPoints.slice(mid), facts: [], targetWords: 0 });
    biggest.subPoints = biggest.subPoints.slice(0, mid);
  }
  const totalPoints = blocks.reduce((sum, block) => sum + block.subPoints.length, 0) || blocks.length;
  for (const block of blocks) {
    const base = Math.max(1200, Math.floor(targetWords / Math.max(1, blocks.length)));
    const weighted = Math.floor((base * 0.75) + (targetWords * 0.25) * (block.subPoints.length / totalPoints));
    block.targetWords = Math.min(MAX_BLOCK_TARGET_WORDS, Math.max(MIN_BLOCK_TARGET_WORDS, weighted));
    // 容器小节块预算保底：工作包容器（项目主要施工内容/主要分部分项工程施工方案）内部
    // 承载 12 个骨架工作包三要素正文（每包 ≥300 字），块预算低于 3600 时工作包被摊薄
    //（轮7 实测 22 个 H4 挤 2527 字块 → 每包仅 100~300 字）；3600×1.5=5400 ≤ 成稿 maxTokens 6000 安全
    if (MAJOR_CONTENT_SECTION_RE.test(block.title) || DIVISION_SECTION_RE.test(block.title)) block.targetWords = Math.min(MAX_BLOCK_TARGET_WORDS, Math.max(block.targetWords, 3600));
  }
}

/** 单块最多输入细目数：控制单块 prompt 与输出规模（小步化） */
const MAX_SECTIONS_PER_BLOCK = 8;
/** 语义聚类合并阈值：域内两条细目余弦 ≥0.5 归入同一块候选 */
const BLOCK_CLUSTER_SIMILARITY = 0.5;
/** 单块规划 LLM 调用输出上限（token）：小步化核心；deepseek 思考 token 与正文共享输出池，
 * 预算过小会被思考耗尽产生空响应（实测：2000 token 时「思考阶段耗尽输出预算」空响应，
 * 4096 给思考留出空间，JSON 输出本身 ≤2000 token，仍远离 8192 共享池） */
const BLOCK_PLAN_MAX_TOKENS = 4096;

/** 单块规划 LLM 输出（p3-s1）：一个主题块的 title/subPoints/facts */
interface PlannerBlockPlan {
  title?: string;
  subPoints?: Array<{ title?: string; source?: string; sources?: string[] }>;
  facts?: string[];
}

/** 单块规划输出 JSON Schema：约束单块结构，校验失败可诊断缺失字段与截断位置 */
const BLOCK_PLAN_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['title', 'subPoints'],
  properties: {
    title: { type: 'string', required: true, minLength: 2, maxLength: 80 },
    subPoints: {
      type: 'array',
      required: true,
      minItems: 1,
      maxItems: MAX_SUB_POINTS_PER_BLOCK,
      items: {
        type: 'object',
        required: true,
        properties: {
          title: { type: 'string', required: true, minLength: 2, maxLength: 60 },
          sources: { type: 'array', required: true, maxItems: MAX_SECTIONS_PER_BLOCK, items: { type: 'string', maxLength: 120 } },
        },
      },
    },
    facts: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 100 } },
  },
};

/**
 * 阶段 1 块候选聚类：评标必查细目独立成块（保真防吞并）；其余按语义域分组，
 * 域内用余弦相似度贪心聚类（最高相似度 ≥0.5 且块未满则并入，否则新块）。
 */
function clusterBlockCandidates(inputSections: string[], similarity: SemanticSimilarityFn): string[][] {
  // 必查细目不每条独立成块（实测缺陷：徽光阁 52 条细目命中 10 个锚定词 → 21 块，
  // LLM 调用数从基线 56 次膨胀至 132 次，块成稿大面积失败触发整章降级）：
  // 必查细目并入语义域分组参与聚类，块内 H4 保真由规划 prompt 规则（必查关键词必须独立 H4）
  // 与 ensureSectionCoverage 必查兜底（未映射必查必新增独立 H4）双重保证
  const byDomain = new Map<string, string[]>();
  // 人材机三小节强制独立成块（结构补挂产物必须各自成 H3，禁止语义聚类与其他细目同块）
  const triadBlocks: string[][] = [];
  for (const section of inputSections) {
    if (isResourceTriadSection(section)) { triadBlocks.push([section]); continue; }
    const key = sectionDomain(section);
    const items = byDomain.get(key) || [];
    items.push(section);
    byDomain.set(key, items);
  }
  const domainBlocks: string[][] = [];
  for (const items of byDomain.values()) {
    const blocks: string[][] = [];
    for (const section of items) {
      let bestBlock: string[] | undefined;
      let bestScore = -1;
      for (const block of blocks) {
        if (block.length >= MAX_SECTIONS_PER_BLOCK) continue;
        const score = Math.max(...block.map(member => similarity(section, member)));
        if (score > bestScore) {
          bestScore = score;
          bestBlock = block;
        }
      }
      if (bestBlock && bestScore >= BLOCK_CLUSTER_SIMILARITY) bestBlock.push(section);
      else blocks.push([section]);
    }
    domainBlocks.push(...blocks);
  }
  return [...triadBlocks, ...domainBlocks];
}

/** 单块 LLM 输出 → PlannedChapterBlock：sources 仅保留能与块细目对齐的原文，防编造；无效返回 undefined */
function buildPlannedBlock(result: PlannerBlockPlan, sections: string[], chapterTitle: string): PlannedChapterBlock | undefined {
  const title = normalizePlannedTitle(result.title || '');
  if (!title || isInvalidTitle(title, chapterTitle)) return undefined;
  const subPoints = (result.subPoints || [])
    .map(point => {
      // 兼容旧格式 source（单条）与新格式 sources（多条合并）
      const rawSources = Array.isArray(point.sources) && point.sources.length > 0 ? point.sources : (point.source ? [point.source] : []);
      // 仅保留能与输入细目对齐的 sources，防止 LLM 编造细目原文；去重保证不重复映射
      const sources: string[] = [];
      for (const rawSource of rawSources) {
        const normalized = normalizePlannedTitle(rawSource || '');
        if (normalized.length < 4) continue;
        if (!sections.some(section => sameSectionText(normalized, section))) continue;
        if (!sources.some(existing => sameSectionText(existing, normalized))) sources.push(normalized);
      }
      const subTitle = normalizePlannedTitle(point.title || '');
      // H4 标题有效即保留（LLM 的合并意图）；sources 未对齐时交由 ensureSectionCoverage 按相似度挂接
      if (!subTitle || subTitle.length < 4) return sources.length > 0 ? { title: sources[0], sources } : undefined;
      // H4 标题重写：优先 LLM 给的概括标题；照抄细目时取首条细目（不截断，原标题全量保真）
      const titleCandidate = subTitle && !sources.some(source => sameSectionText(subTitle, source)) ? subTitle : (sources[0] || subTitle);
      return { title: titleCandidate, sources };
    })
    .filter((point): point is PlannedChapterSubPoint => Boolean(point));
  if (subPoints.length === 0) return undefined;
  const facts = (result.facts || []).map(item => item.trim()).filter(Boolean);
  return { title, subPoints, facts, targetWords: MIN_BLOCK_TARGET_WORDS };
}

/** 块级证据排序：按块细目首尾关键词匹配证据内容，只排序不丢弃（全量保留进规划输入） */
function blockEvidenceForSections(sections: string[], evidence: DocumentEvidence[]): DocumentEvidence[] {
  const keywords = sections.flatMap(section => [section.slice(0, 4), section.slice(-4)]).filter(keyword => keyword.length >= 2);
  return evidence
    .map(item => ({ item, score: keywords.reduce((sum, keyword) => sum + (item.content.includes(keyword) ? 1 : 0), 0) }))
    .sort((left, right) => right.score - left.score)
    .map(entry => entry.item);
}

/**
 * 章级 LLM 规划（p3-s1 逐主题块小步规划）：细目先经语义聚类切分为块候选，再逐块一次小调用产出该块 H4 结构
 * （输出 ≤2000 token），块间并发、块级失败隔离（失败块由语义域确定性结构接管），合并后统一覆盖校验。
 * 彻底 LLM 化：不再按输入细目数量跳过规划——细目少（≤8）时同样由 LLM 规划，杜绝确定性回退路径的
 * 「主题块标题=细目标题」同名结构（历史缺陷：H3/H4 同名诱发模型重复展开 → 重复 H4 质检卡死 → 章阻断）。
 * 返回 undefined 表示规划失败，调用方走 fallbackStructureForSections。
 */
export async function planChapterStructureWithLlm(input: {
  template: DocumentTemplate;
  chapter: DocumentTemplateChapter;
  evidence: DocumentEvidence[];
  projectContext: string;
  requirement?: string;
  roleContext: string;
  targetWords: number;
  /** 项目图谱章节定向摘要（工程/工法/资源/工期/标准/风险/要求节点），供合并决策参考 */
  graphContext?: string;
  /** 文档蓝图（本章专业任务卡/实施方案/事实覆盖矩阵），供合并决策参考 */
  blueprintContext?: string;
  /** 语义嵌入注入（单测替换本地 bge-small 模型）；缺省时使用本地语义模型 */
  semanticEmbedder?: (texts: string[]) => Promise<number[][]>;
  signal?: AbortSignal;
  diagnostics?: DocumentGenerationDiagnostics;
}): Promise<PlannedChapterStructure | undefined> {
  const inputSections = cleanInputSections(input.chapter);
  // 阶段 1：块候选聚类（本地 bge 语义域贪心聚类，嵌入失败直接抛出）
  const similarity = await buildSemanticSimilarity(inputSections, inputSections, input.semanticEmbedder);
  const clusters = clusterBlockCandidates(inputSections, similarity);
  const halfTarget = Math.max(800, Math.floor(input.targetWords / Math.max(1, clusters.length)));
  // 阶段 2：逐块小调用（输出 ≤2000 token，远离 8192 共享输出池），块间并发、块级失败隔离
  const planBlockWithLlm = async (sections: string[], blockIndex: number): Promise<{ blocks: PlannedChapterBlock[]; llmPlanned: boolean; failure?: string }> => {
    const blockEvidence = blockEvidenceForSections(sections, input.evidence);
    // 规划调用只做合并决策 + facts 摘取（0~2 条短句），证据按块目标字数动态预算（floor 5000/ceiling 12000）：
    // 此前无预算上限全量注入，是规划调用输入超大的根因（实测单次输入可达数十万字符），
    // T0 关键参数层由 evidenceBundlePrompt 全量保留，零丢失保护不受预算影响
    const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, blockEvidence), {
      maxChars: evidencePromptBudgetForTarget(halfTarget, 5000, 12000),
      requiredFacts: input.chapter.requiredFacts,
      diagnostics: input.diagnostics,
    });
    const promptLines = [
      docSystemPrefix('你是专业施工组织设计文档结构规划专家。'),
      '任务：把一个主题块内的输入细目重排为 H4 要点结构；语义相近、内容连贯的细目必须合并进同一个 H4 要点。',
      '硬性规则：',
      `1. 合并决策：语义相近、内容连贯的输入细目必须合并进同一个 H4 要点；H4 要点标题必须重写为更概括、更专业的标题（16 字以内），不得直接照抄任一输入细目标题；每个 H4 要点的 sources 字段逐字列出它所覆盖的全部输入细目标题，不得改写、不得遗漏、不得重复映射。例外：含评标必查关键词的输入细目（${CRITICAL_SECTION_ANCHORS.join('/')}等）必须保留为独立 H4 要点，不得与其他细目合并吞并，其 H4 标题必须保留该关键词。`,
      `2. 合并依据：优先参考项目图谱与文档蓝图，把对应同一套工程对象/管理闭环的细目合并（如「三检制度」「样板引路」「隐蔽工程验收」同属质量管控闭环）；不得把内容无关的细目强行合并。`,
      `3. 主题块标题必须具体、专业、能承载其要点（16 字以内），不得使用"目标与范围""资料依据""总体要求"等通用占位标题。`,
      `4. 数量约束：本主题块 1~${MAX_SUB_POINTS_PER_BLOCK} 个 H4 要点。`,
      '5. facts 字段：从绑定资料中摘取与本主题块直接相关的关键事实短句（每条 ≤60 字，0~2 条）。',
      '6. 只返回 JSON，不要输出任何其他文字。',
      'JSON 格式：{"title":"主题块标题","subPoints":[{"title":"H4要点标题","sources":["输入细目原文"]}],"facts":["事实短句"]}',
    ];
    const userLines = [
      `文档模板：${input.template.name}`,
      `章节标题：${input.chapter.title}`,
      input.requirement ? `用户要求：${input.requirement}` : '',
      input.graphContext ? `项目图谱（本章定向）：${input.graphContext}` : '',
      input.blueprintContext ? `文档蓝图（本章任务卡与实施方案）：${input.blueprintContext}` : '',
      input.projectContext ? `上下文：${input.projectContext}` : '',
      input.roleContext ? `角色要求：${input.roleContext}` : '',
      evidenceText ? `真实绑定资料：${evidenceText}` : '',
      `输入细目清单（本主题块共 ${sections.length} 条，必须全部覆盖，允许合并进同一 H4）：${sections.join('、')}`,
      `请输出 1 个主题块，1~${MAX_SUB_POINTS_PER_BLOCK} 个 H4 要点，确保所有输入细目被覆盖。`,
    ];
    // 块间并发共享 diagnostics.llm.lastError：失败原因经 outFailure 独立带出（每块各自的对象，无竞态），
    // 不读共享 lastError 避免前序块/并发块写下的陈旧错误串号
    const blockFailure: { value?: string } = {};
    // F7 分层统计：system 恒定段（l0）/ 章级共享段（l2：模板/章标题/用户要求/图谱/蓝图/上下文/角色，
    // 同章各块规划调用值完全相同）/ 块级变化段（l3：块证据与块细目清单）。与 prompt 组装同源表达式
    const contextLayers = {
      l0: promptLines.join(LF).length,
      l2: contextLayerChars([
        `文档模板：${input.template.name}`,
        `章节标题：${input.chapter.title}`,
        input.requirement ? `用户要求：${input.requirement}` : '',
        input.graphContext ? `项目图谱（本章定向）：${input.graphContext}` : '',
        input.blueprintContext ? `文档蓝图（本章任务卡与实施方案）：${input.blueprintContext}` : '',
        input.projectContext ? `上下文：${input.projectContext}` : '',
        input.roleContext ? `角色要求：${input.roleContext}` : '',
      ]),
      l3: contextLayerChars([
        evidenceText ? `真实绑定资料：${evidenceText}` : '',
        `输入细目清单（本主题块共 ${sections.length} 条，必须全部覆盖，允许合并进同一 H4）：${sections.join('、')}`,
        `请输出 1 个主题块，1~${MAX_SUB_POINTS_PER_BLOCK} 个 H4 要点，确保所有输入细目被覆盖。`,
      ]),
    };
    const result = await callDocumentLlmJson<PlannerBlockPlan>(promptLines.join(LF), userLines.filter(Boolean).join(LF + LF), {
      maxTokens: BLOCK_PLAN_MAX_TOKENS,
      temperature: 0.1,
      signal: input.signal,
      diagnostics: input.diagnostics,
      schema: BLOCK_PLAN_SCHEMA,
      disableThinkingBoost: true,
      outFailure: blockFailure,
      contextLayers,
      prefixKey: `plan-block:${input.chapter.id}`,
    });
    if (!result) {
      // 透传 llmClient/schema 校验记录的失败原因（空响应/限流/超时/截断位置/缺失字段），避免「LLM 无响应」不可诊断
      const failure = blockFailure.value ? `第 ${blockIndex + 1} 块未通过校验（${blockFailure.value}）` : `第 ${blockIndex + 1} 块 LLM 无响应`;
      // 块级失败隔离：失败块由语义域确定性结构接管，不影响其他块
      return { blocks: fallbackStructureForSections(sections, input.chapter.title, halfTarget).blocks, llmPlanned: false, failure };
    }
    const block = buildPlannedBlock(result, sections, input.chapter.title);
    if (!block) {
      return { blocks: fallbackStructureForSections(sections, input.chapter.title, halfTarget).blocks, llmPlanned: false, failure: `第 ${blockIndex + 1} 块 LLM 结构无效（title/subPoints 缺失或未对齐）` };
    }
    return { blocks: [block], llmPlanned: true };
  };
  const results = await Promise.all(clusters.map((sections, index) => planBlockWithLlm(sections, index)));
  const blocks = results.flatMap(result => result.blocks);
  const failures = results.map(result => result.failure).filter(Boolean);
  if (blocks.length === 0) {
    return { blocks: [], coveredSections: [], fallbackSections: [], llmPlanned: false, llmFailure: failures.join('；') || '未知原因' };
  }
  allocateBlockTargetWords(blocks, input.targetWords);
  const merged = ensureSectionCoverage(inputSections, blocks);
  const deduped = dedupeCrossBlockOverlaps(merged);
  // 4.19 块标题级去重：LLM 逐块独立规划时，不同细目簇常被命名为同名主题块（真实回归：
  // 第六章「安全文明生产管理体系与措施」块 ×2、第二章「重点难点与危大工程保障」块 ×2），
  // 同名块各自成稿产出两个同名 H3（finalize 仅去 H3 重复，目录规划镜像 sections 仍残留重复）。
  // 归一化同名块后块 subPoints 并入前块（同主题合并），杜绝同名 H3 双写与规划镜像重复。
  // 合并/拆半后重跑目标分配：合并把块数与点数集中，原 allocate 结果（相加目标）膨胀至
  // 0.9×目标质检阈值超出模型单块自然输出（真实回归：2113/1927 字两轮不达标 → 章生成失败）
  const dedupedTitles = dedupeBlockTitleDuplicates(deduped);
  allocateBlockTargetWords(dedupedTitles.blocks, input.targetWords);
  return { ...dedupedTitles, llmPlanned: results.some(result => result.llmPlanned), llmFailure: failures.length > 0 ? `块级降级（${failures.join('；')}）` : undefined };
}

/**
 * 跨块重叠去重：同一输入细目被多个主题块的 H4 重复映射时（LLM 聚类块边界模糊导致），
 * 仅保留首个块中的映射，后续块从 sources 剥离；sources 被清空的 H4 整点删除。
 * 避免成稿时同一套内容在不同主题块下重复展开（实测“3.1.1 施工部署与流水组织”H4 与“3.3 施工部署与流水组织”H3 同章双写）。
 */
export function dedupeCrossBlockOverlaps(structure: PlannedChapterStructure): PlannedChapterStructure {
  const claimed: string[] = [];
  const blocks = structure.blocks.map(block => ({
    ...block,
    subPoints: block.subPoints
      .map(point => {
        const keptSources = point.sources.filter(source => {
          if (claimed.some(existing => sameSectionText(existing, source))) return false;
          claimed.push(source);
          return true;
        });
        return { ...point, sources: keptSources };
      })
      .filter(point => point.sources.length > 0),
  }));
  return { ...structure, blocks };
}

/** 4.19 块标题级去重：归一化（去空白）同名的主题块合并——后块 subPoints 去重后并入前块（同名 H4 去重后追加），
 * facts 合并，coveredSections/fallbackSections 同并。同名块各自成稿会产出两个同名 H3 双写内容，
 * 目录规划镜像 sections 也会残留重复（真实回归：第六章/第二章各一对同名块实锤）。
 * 合并块 >3 点时对半拆为带（一）（二）后缀的主题块（每块 ≤3 点）：目标字数相加膨胀后
 * 0.9×目标质检阈值超出模型单块自然输出（真实回归：2113/1927 字两轮不达标 → 章生成失败）；
 * 拆后调用方重跑 allocateBlockTargetWords 重分配，单块目标回落可达成 */
export function dedupeBlockTitleDuplicates(structure: PlannedChapterStructure): PlannedChapterStructure {
  // 先按归一化标题分组（保序），再逐组合并/拆半，避免拆半插入导致 seen 索引错位
  const groups: Array<{ blocks: PlannedChapterBlock[] }> = [];
  const groupIndex = new Map<string, number>();
  for (const block of structure.blocks) {
    const key = block.title.replace(/\s+/gu, '');
    if (!key) {
      groups.push({ blocks: [block] });
      continue;
    }
    const existingIndex = groupIndex.get(key);
    if (existingIndex === undefined) {
      groupIndex.set(key, groups.length);
      groups.push({ blocks: [block] });
      continue;
    }
    groups[existingIndex].blocks.push(block);
  }
  const blocks: PlannedChapterBlock[] = [];
  for (const group of groups) {
    if (group.blocks.length === 1) {
      blocks.push({ ...group.blocks[0], subPoints: [...group.blocks[0].subPoints] });
      continue;
    }
    const existing = group.blocks[0];
    const mergedSubPoints: PlannedChapterSubPoint[] = [];
    const mergedFacts: string[] = [];
    for (const block of group.blocks) {
      for (const point of block.subPoints) {
        const pointKey = point.title.replace(/\s+/gu, '');
        if (mergedSubPoints.some(merged => merged.title.replace(/\s+/gu, '') === pointKey)) continue;
        mergedSubPoints.push(point);
      }
      for (const fact of block.facts) {
        if (!mergedFacts.includes(fact)) mergedFacts.push(fact);
      }
    }
    const mergedTarget = group.blocks.reduce((sum, block) => sum + block.targetWords, 0);
    if (mergedSubPoints.length <= 3) {
      blocks.push({ ...existing, subPoints: mergedSubPoints, facts: mergedFacts, targetWords: mergedTarget });
      continue;
    }
    // 拆半（每块 ≤3 点）：标题加中文序号后缀，目录镜像与正文 H3 一致（与拆半自愈同形态）
    const partSize = Math.ceil(mergedSubPoints.length / Math.ceil(mergedSubPoints.length / 3));
    const suffixes = ['一', '二', '三', '四', '五'];
    for (let index = 0, part = 0; index < mergedSubPoints.length; index += partSize, part += 1) {
      blocks.push({
        ...existing,
        title: `${existing.title}（${suffixes[part]}）`,
        subPoints: mergedSubPoints.slice(index, index + partSize),
        facts: part === 0 ? mergedFacts : [],
        // 目标暂记合并总量，由调用方重跑 allocateBlockTargetWords 按点数重分配（拆分块不膨胀）
        targetWords: mergedTarget,
      });
    }
  }
  return { ...structure, blocks };
}

/** 规划结果中未被覆盖的细目：用于诊断与提示（确保评分条目承接可追踪） */
export function uncoveredPlannerSections(inputSections: string[], structure: PlannedChapterStructure) {
  const mapped = new Set<string>([...structure.coveredSections, ...structure.fallbackSections]);
  return inputSections.filter(section => !mapped.has(section));
}

/**
 * 覆盖映射表：输入细目 → 承接它的 H4 要点标题（可能多条）。Reviewer/Repairer 按此表校验评分条目承接，
 * 不再要求成稿正文中出现与输入细目同名的标题，真正语义合并（标题重写）后也不会被误判为缺节。
 */
export function plannedSectionCoverageMap(inputSections: string[], structure: PlannedChapterStructure): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const section of inputSections) {
    for (const block of structure.blocks) {
      const matched = block.subPoints.filter(point => point.sources.some(source => sameSectionText(source, section)) || sameSectionText(point.title, section));
      if (matched.length > 0) {
        map[section] = matched.map(point => point.title);
        break;
      }
    }
  }
  return map;
}

/**
 * 章级规划组合入口（永不回退逐小节路径）：
 * 优先 LLM 语义聚类+语义合并（注入图谱/蓝图上下文）；LLM 失败/JSON 无效/细目过少时降级为确定性语义域分组，
 * 两条路径产出同一个 PlannedChapterStructure，下游块级写手无感。
 * 仅当清洗后无有效细目时返回空结构（blocks 为空），由调用方走整章单次生成兜底。
 */
export async function planChapterStructure(input: {
  template: DocumentTemplate;
  chapter: DocumentTemplateChapter;
  evidence: DocumentEvidence[];
  projectContext: string;
  requirement?: string;
  roleContext: string;
  targetWords: number;
  graphContext?: string;
  blueprintContext?: string;
  /** 语义嵌入注入（单测替换本地 bge-small 模型）；缺省时使用本地语义模型 */
  semanticEmbedder?: (texts: string[]) => Promise<number[][]>;
  signal?: AbortSignal;
  diagnostics?: DocumentGenerationDiagnostics;
}): Promise<PlannedChapterStructure> {
  const planned = (await planChapterStructureWithLlm(input).catch(error => {
    const failed: PlannedChapterStructure = { blocks: [], coveredSections: [], fallbackSections: [], llmPlanned: false, llmFailure: error instanceof Error ? error.message : String(error) };
    return failed;
  })) ?? { blocks: [], coveredSections: [], fallbackSections: [], llmPlanned: false, llmFailure: 'LLM 规划未返回有效结构' };
  if (planned.blocks.length > 0) return planned;
  const inputSections = cleanInputSections(input.chapter);
  const fallback = fallbackStructureForSections(inputSections, input.chapter.title, input.targetWords);
  return { ...fallback, llmFailure: planned.llmFailure || 'LLM 调用异常' };
}
