import type { DocumentTemplate, DocumentTemplateChapter } from './types';
import { displayChapterTitle, isTenderClauseFragmentTitle } from './outline';
import { inferConstructionOrgProjectTypes, type ConstructionOrgProjectType } from './constructionOrgCatalog';

/**
 * L1 结构引擎：评标结构知识库与前置结构校验。
 *
 * 目标：在章节生成开始前，将"评标导向的施工组织设计结构"约束注入章节规划，
 * 并在规划完成后执行结构符合性校验（阻断级），避免生成后才发现章节结构失真
 * （例如某章膨胀至 46 个小节、缺少主要施工内容、缺少质量/安全保障结构）。
 */

export type BidStructureGroupId =
  | 'overview'        // 工程概况与总体理解
  | 'major-content'   // 项目主要施工内容（工作包）
  | 'key-difficulty'  // 重难点分析与对策
  | 'deployment'      // 施工部署与组织
  | 'schedule'        // 进度计划与工期保障
  | 'quality'         // 质量保证体系
  | 'safety'          // 安全文明与危大工程
  | 'resources'       // 人材机资源配置
  | 'environment'     // 绿色文明施工
  | 'emergency';      // 应急管理

export interface BidStructureGroup {
  id: BidStructureGroupId;
  title: string;
  /** 该结构组必须承载的最小内容集合（小节标题关键词） */
  requiredSectionPatterns: RegExp[];
  /** 挂靠章标题的匹配正则（决定该结构组应落在哪一章） */
  chapterPatterns: RegExp[];
  /** 结构组缺失时的补救说明 */
  remedy: string;
  /** 最低要求级别：required=评标必查结构，recommended=加分结构 */
  level: 'required' | 'recommended';
}

/**
 * 评标结构知识库：面向整个建筑领域的通用评标结构基准。
 * 参考入围施工组织设计的评标结构（整体理解→主要施工内容→重难点→部署→进度→质量→安全→人材机→文明绿色→应急），
 * 同时兼容常见的"六章制/八章制"技术标结构。
 */
export const BID_STRUCTURE_GROUPS: BidStructureGroup[] = [
  {
    id: 'overview',
    title: '工程概况与总体理解',
    requiredSectionPatterns: [/编制依据|编制说明/u, /工程概况|项目概况|基本概况/u, /现场踏勘|施工条件|现场条件/u],
    chapterPatterns: [/概况|总体|理解|说明|编制|项目/u],
    remedy: '应设置工程概况章节，包含编制依据、工程基本概况、现场条件与总体理解。',
    level: 'required',
  },
  {
    id: 'major-content',
    title: '项目主要施工内容',
    requiredSectionPatterns: [/主要施工内容|主要施工项目|施工内容/u],
    chapterPatterns: [/概况|总体|理解|主要施工|工程/u],
    remedy: '必须包含"项目主要施工内容"小节，按工作包展开施工概况、施工流程、施工方法。',
    level: 'required',
  },
  {
    id: 'key-difficulty',
    title: '重难点分析与对策',
    requiredSectionPatterns: [/重点.*难点|难点.*对策|重难点/u],
    chapterPatterns: [/概况|总体|理解|重点|难点|施工/u],
    remedy: '应设置项目特点、重点、难点分析小节，并逐项给出应对措施与责任闭环。',
    level: 'required',
  },
  {
    id: 'deployment',
    title: '施工部署与施工组织',
    requiredSectionPatterns: [/施工部署|总体部署|流水|施工顺序|施工区段/u],
    chapterPatterns: [/部署|组织|总体|方案/u],
    remedy: '应设置施工部署小节，明确流水段划分、施工顺序与资源调配。',
    level: 'required',
  },
  {
    id: 'schedule',
    title: '进度计划与工期保障',
    requiredSectionPatterns: [/进度计划|工期|节点/u],
    chapterPatterns: [/进度|工期|计划|保障/u],
    remedy: '应设置进度计划与工期保障小节，含总进度计划、关键节点与纠偏措施。',
    level: 'required',
  },
  {
    id: 'quality',
    title: '质量保证体系与措施',
    requiredSectionPatterns: [/质量/u],
    chapterPatterns: [/质量|验收|保障|措施/u],
    remedy: '应设置质量保证体系与措施小节，含质量目标、三检、隐蔽验收、通病防治。',
    level: 'required',
  },
  {
    id: 'safety',
    title: '安全文明施工与危大工程管控',
    requiredSectionPatterns: [/安全/u, /危大/u],
    chapterPatterns: [/安全|文明|风险|危大|保障|措施/u],
    remedy: '应设置安全管理与危大工程管控小节，含危险源辨识、危大清单、专项方案。',
    level: 'required',
  },
  {
    id: 'resources',
    title: '劳动力材料机械设备配置',
    requiredSectionPatterns: [/劳动力|机械设备|材料.*计划|资源配置|人材机/u],
    chapterPatterns: [/资源|劳动力|机械|材料|设备|计划/u],
    remedy: '应设置资源配置小节，含分阶段劳动力、机械设备投入与材料进场计划。',
    level: 'required',
  },
  {
    id: 'environment',
    title: '绿色文明施工与环保措施',
    requiredSectionPatterns: [/文明施工|扬尘|噪声|绿色|环保|四节/u],
    chapterPatterns: [/文明|绿色|环保|扬尘|噪声|保障|措施/u],
    remedy: '应设置文明施工与绿色施工小节，含扬尘噪声管控与四节一环保措施。',
    level: 'required',
  },
  {
    id: 'emergency',
    title: '应急管理体系',
    requiredSectionPatterns: [/应急/u],
    chapterPatterns: [/应急|安全|保障|措施/u],
    remedy: '应设置应急管理小节，含应急组织、物资储备与专项预案。',
    level: 'recommended',
  },
];

/** 项目类型专属的加分结构组 */
const PROJECT_TYPE_EXTRA_GROUPS: Record<Exclude<ConstructionOrgProjectType, 'general'>, BidStructureGroup[]> = {
  building: [
    {
      id: 'key-difficulty',
      title: '危大工程专项管控（房建）',
      requiredSectionPatterns: [/深基坑|高支模|起重吊装|脚手架/u],
      chapterPatterns: [/危大|安全|专项/u],
      remedy: '房建项目应对深基坑、高支模、起重吊装、脚手架等危大工程逐项给出专项方案与安全管理措施。',
      level: 'recommended',
    },
  ],
  municipal: [
    {
      id: 'key-difficulty',
      title: '交通导改与管线保护（市政）',
      requiredSectionPatterns: [/交通导改|交通导行|占道施工/u, /管线保护|管线探测/u],
      chapterPatterns: [/交通|管线|安全|专项|保障/u],
      remedy: '市政项目应设置交通导改与既有管线保护专项内容。',
      level: 'recommended',
    },
  ],
  renovation: [
    {
      id: 'key-difficulty',
      title: '居民协调与既有保护（改造）',
      requiredSectionPatterns: [/居民|扰民|既有.*保护|不中断/u],
      chapterPatterns: [/居民|协调|保护|保障|专项/u],
      remedy: '改造项目应设置居民沟通协调与既有设施保护专项内容。',
      level: 'recommended',
    },
  ],
  decoration: [
    {
      id: 'key-difficulty',
      title: '成品保护与交叉施工（装饰）',
      requiredSectionPatterns: [/成品保护/u, /交叉施工|工序穿插/u],
      chapterPatterns: [/成品保护|交叉|协调|保障|专项/u],
      remedy: '装饰项目应设置成品保护与交叉施工工序优化专项内容。',
      level: 'recommended',
    },
  ],
};

function normalize(text: string) {
  return displayChapterTitle(text).replace(/\s+/gu, '').toLowerCase();
}

/** 章节承接判定的规范文本（标题+小节拼接后规范化截断）；语义相似度闭包按此文本缓存向量，调用方必须用同一函数取 key 才能命中缓存 */
export function chapterCriteriaText(chapter: DocumentTemplateChapter): string {
  return normalize(`${chapter.title} ${(chapter.sections || []).join(' ')}`).slice(0, 800);
}

// ===== 评分标准条目提取与承接审计 =====
// 招标文件常以“1.针对…；2.…；3.…”形式给出技术文件评审条目（评分标准），
// 章节结构必须逐条承接；未承接条目（如“新技术、新工艺…”）由前置校验自动补小节，
// 避免评分标准明确要求的内容因显式大纲未覆盖而整篇缺失（历史缺陷：新技术新工艺 0 次出现）。
// 承接判定不再用 2 字滑窗词面命中率（通用词稀释导致误判已承接），
// 改为“显式包含 → 本地语义相似度（bge-small 余弦）→ 未承接”两级判定。

/** 结构化评分条目：提取自招标文件评审标准文本，以对象形式在管线中传递 */
export interface EvaluationCriteriaItem {
  /** 条目编号（原文数字编号，如 3） */
  index: number;
  /** 条目原文（清理引号后） */
  text: string;
  /** 可作小节标题的清理短语（cleanEvaluationItemTitle），可能为空 */
  title: string;
}

/** 从证据文本中提取评分标准编号条目（数字编号 + 短标题短语，纯结构提取） */
export function extractEvaluationCriteriaItems(texts: string[]): EvaluationCriteriaItem[] {
  const merged = texts.join('\n');
  const items = new Map<number, EvaluationCriteriaItem>();
  for (const match of merged.matchAll(/(\d{1,2})\s*[.、．]\s*([^；。\n]{4,60})/gu)) {
    const raw = match[2].trim().replace(/[“”"'"]/gu, '');
    // 汉字阈值 4→3：短条目（如“确保黄山杯”清理后仅 3 字）必须保留，否则创优类条目被静默丢弃零承接
    if (!/[\u4e00-\u9fa5]{3}/u.test(raw) && !/[杯奖]/u.test(raw)) continue;
    if (/AI|大模型|评审|评分|分值|分项|子项|满分|得分|投标人须|详见|招标文件/u.test(raw)) continue;
    if (/公共资源|电子交易|加密|投标|开标|评标委员会/u.test(raw)) continue;
    const index = Number(match[1]);
    if (!items.has(index)) {
      const cleanedTitle = cleanEvaluationItemTitle(raw);
      // 条款碎片过滤（真实生成回归）：评标办法文本被序号切分后的条款碎片
      // （「1委员会确定中」「7.3项规定」「00天，计划完成时间：」「如我方中标，我方承诺：」等）
      // 不是评分标准条目；提取为条目后会被承接审计补挂成小节 → 碎片小节无事实/证据支撑
      // → 章节任务未就绪失败。原文与清理标题任一命中即不提取（编号粘连/剥离两种形态）
      if (cleanedTitle && isTenderClauseFragmentTitle(cleanedTitle)) continue;
      if (isTenderClauseFragmentTitle(raw)) continue;
      items.set(index, { index, text: raw, title: cleanedTitle });
    }
  }
  return [...items.values()];
}

/** 章节文本是否显式承接了条目（条目标题短语直接出现在章节标题/小节中，确定性第一道） */
function chapterCoversCriterionExplicitly(chapterText: string, title: string) {
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) return false;
  return chapterText.includes(normalizedTitle) || normalizedTitle.includes(chapterText.slice(0, 40));
}

export interface EvaluationCriteriaAudit {
  items: EvaluationCriteriaItem[];
  uncovered: Array<{ item: EvaluationCriteriaItem; title: string; bestSimilarity?: number }>;
}

/**
 * 评分标准条目 ↔ 大纲承接审计：返回未被任何章节承接的条目。
 * 判定顺序：显式包含 → 语义相似度（≥0.6）→ 未承接；
 * 调用方未提供相似度函数时仅显式承接判定（生成主链路恒提供，本地 bge 恒可用）。
 */
export function auditEvaluationCriteriaCoverage(
  chapters: DocumentTemplateChapter[],
  items: EvaluationCriteriaItem[],
  options?: { semanticSimilarity?: (leftText: string, rightText: string) => number },
): EvaluationCriteriaAudit {
  const uncovered: Array<{ item: EvaluationCriteriaItem; title: string; bestSimilarity?: number }> = [];
  const chapterTexts = chapters.map(chapterCriteriaText);
  for (const item of items) {
    const title = item.title;
    if (!title) continue;
    if (chapterTexts.some(text => chapterCoversCriterionExplicitly(text, title))) continue;
    let bestSimilarity = 0;
    if (options?.semanticSimilarity) {
      for (const text of chapterTexts) bestSimilarity = Math.max(bestSimilarity, options.semanticSimilarity(title, text));
    }
    if (bestSimilarity >= 0.6) continue;
    uncovered.push({ item, title, bestSimilarity: options?.semanticSimilarity ? bestSimilarity : undefined });
  }
  return { items, uncovered };
}

export interface BidStructureDiagnostic {
  groupId: BidStructureGroupId;
  groupTitle: string;
  level: 'required' | 'recommended';
  status: 'satisfied' | 'missing' | 'fragmented';
  /** 承载该结构组的章节标题（satisfied 时） */
  carrierChapters: string[];
  missingSections: string[];
  remedy: string;
}

/**
 * 结构符合性校验：检查章节规划是否满足评标结构基准。
 * - satisfied：结构组的小节全部落到至少一个章节
 * - fragmented：小节散落在 2 个以上章节（结构失真信号，如某章膨胀 46 小节）
 * - missing：必查小节缺失
 */
export function auditBidStructure(chapters: DocumentTemplateChapter[]): BidStructureDiagnostic[] {
  const groups = [...BID_STRUCTURE_GROUPS];
  return groups.map(group => {
    const carriers: string[] = [];
    const coveredPatterns = new Set<RegExp>();
    for (const chapter of chapters) {
      const chapterText = normalize(`${chapter.title} ${(chapter.sections || []).join(' ')}`);
      for (const pattern of group.requiredSectionPatterns) {
        if (pattern.test(chapterText) && !coveredPatterns.has(pattern)) {
          coveredPatterns.add(pattern);
          carriers.push(chapter.title);
        }
      }
    }
    const uniqueCarriers = [...new Set(carriers)];
    const missingSections = group.requiredSectionPatterns
      .filter(pattern => !coveredPatterns.has(pattern))
      .map(pattern => representativeTitleForPattern(pattern));
    const status: BidStructureDiagnostic['status'] = coveredPatterns.size === group.requiredSectionPatterns.length
      ? (uniqueCarriers.length > 1 ? 'fragmented' : 'satisfied')
      : 'missing';
    return { groupId: group.id, groupTitle: group.title, level: group.level, status, carrierChapters: uniqueCarriers, missingSections, remedy: group.remedy };
  });
}

/** 必查小节正则 → 代表标题：候选词以 | 连接，取首个候选词为代表。
 * 历史缺陷：直接对正则 source 整体剥离 | 会把候选词粘连成脏标题（如「现场踏勘施工条件现场条件」），
 * 补挂到章节清单后被 Writer 原样写成正文小节。 */
export function representativeTitleForPattern(pattern: RegExp) {
  const source = pattern.source.replace(/[\\/^$.*+?()[\]{}]/gu, '').replace(/u$/u, '');
  const firstAlternative = source.split('|').map(item => item.trim()).find(Boolean);
  return firstAlternative || source;
}

/** 粘连产物 → 代表词 精确回退表：必查小节正则（候选词以 | 连接）整体剥离 | 后的粘连串，
 * 逐字映射回首个候选词。仅精确匹配才回退（不会误伤合法标题），
 * 用于清单层修复历史上由上述 bug 产生的脏小节标题。 */
export function concatenatedSectionTitleFixes(): Record<string, string> {
  const fixes: Record<string, string> = {};
  for (const group of BID_STRUCTURE_GROUPS) {
    for (const pattern of group.requiredSectionPatterns) {
      const representative = representativeTitleForPattern(pattern);
      // 粘连产物 = 历史 bug 的生成口径：正则 source 整体剥离 |（候选词直接拼接）
      const concatenated = pattern.source.replace(/[\\/^$.*+?()[\]{}|]/gu, '').replace(/u$/u, '');
      if (concatenated !== representative && !fixes[concatenated]) fixes[concatenated] = representative;
    }
  }
  return fixes;
}

/** 概况类小节置首（确定性结构清洗，仅调序）：
 * 施工组织设计惯例——首章以「编制说明与工程概况」类小节开篇（用户明确要求第一章第一节）；
 * 将首章（或标题含概况/编制/说明/总体的承载章）中匹配概况语义的小节稳定移到最前，
 * 其余小节相对顺序不变。只调序，不增删不改写标题（不属于内容兜底）。 */
export function prioritizeOverviewSections<T extends DocumentTemplateChapter>(chapters: T[]): T[] {
  if (!chapters.length) return chapters;
  return chapters.map((chapter, index) => {
    const sections = chapter.sections || [];
    if (sections.length < 2) return chapter;
    const isOverviewCarrier = index === 0 || /概况|总体理解|编制说明|编制依据/u.test(chapter.title);
    if (!isOverviewCarrier) return chapter;
    const overviewIndex = sections.findIndex(section => /^(?:编制说明|编制依据)/u.test(section) || /工程概况|项目概况|基本概况/u.test(section));
    if (overviewIndex <= 0) return chapter;
    const reordered = [sections[overviewIndex], ...sections.filter((_, i) => i !== overviewIndex)];
    return { ...chapter, sections: reordered };
  });
}

/** 结构组数量约束：单章小节数上限（防止某章膨胀） */
export const MAX_SECTIONS_PER_CHAPTER = 18;
/** 关键承载章最小小节数下限（概况/方案类章不能空壳） */
export const MIN_SECTIONS_FOR_CARRIER = 4;

export interface BidStructureIssue {
  level: 'error' | 'warning';
  severity: 'blocker' | 'warning';
  message: string;
  suggestion: string;
}

/** 前置结构校验：在生成开始前调用，返回阻断级问题（用于章节规划修正） */
export function validateBidStructureBeforeGeneration(input: {
  template: DocumentTemplate;
  chapters: DocumentTemplateChapter[];
  requirement?: string;
  /** 结构化评分条目（对象化，替代旧 evaluationTexts 文本切片） */
  evaluationItems?: EvaluationCriteriaItem[];
  /** 语义相似度函数（本地 bge-small 余弦），缺省时仅显式承接判定 */
  semanticSimilarity?: (leftText: string, rightText: string) => number;
}): { diagnostics: BidStructureDiagnostic[]; issues: BidStructureIssue[]; enrichedChapters: DocumentTemplateChapter[]; criteriaAudit?: EvaluationCriteriaAudit } {
  const diagnostics = auditBidStructure(input.chapters);
  const issues: BidStructureIssue[] = [];
  const missingRequired = diagnostics.filter(item => item.level === 'required' && item.status === 'missing');
  for (const diagnostic of missingRequired) {
    issues.push({ level: 'error', severity: 'blocker', message: `评标结构缺失：${diagnostic.groupTitle}（缺少：${diagnostic.missingSections.join('、')}）`, suggestion: diagnostic.remedy });
  }
  const fragmented = diagnostics.filter(item => item.status === 'fragmented');
  for (const diagnostic of fragmented) {
    issues.push({ level: 'warning', severity: 'warning', message: `${diagnostic.groupTitle} 小节散落在 ${diagnostic.carrierChapters.length} 个章节（${diagnostic.carrierChapters.join('、')}），结构可能失真`, suggestion: '建议将同类内容集中到一个承载章节，避免章节间职责重叠。' });
  }
  for (const chapter of input.chapters) {
    const sectionCount = (chapter.sections || []).length;
    if (sectionCount > MAX_SECTIONS_PER_CHAPTER) {
      issues.push({ level: 'warning', severity: 'warning', message: `${chapter.title} 规划小节 ${sectionCount} 个，超过 ${MAX_SECTIONS_PER_CHAPTER} 个上限，易产生内容膨胀与重复`, suggestion: '合并语义相近的小节，或将细分内容下移为三级小节而非二级小节。' });
    }
  }

  // 自动补全缺失的必查结构组小节（挂靠到最佳承载章）
  const enriched = input.chapters.map(chapter => ({ ...chapter, sections: [...(chapter.sections || [])] }));
  const used = new Set<string>();
  for (const diagnostic of missingRequired) {
    const group = BID_STRUCTURE_GROUPS.find(item => item.id === diagnostic.groupId);
    if (!group) continue;
    const carrierIndex = enriched.findIndex(chapter => {
      const title = normalize(chapter.title);
      return group.chapterPatterns.some(pattern => pattern.test(title)) && !/雨季|冬季|高温|防汛|扬尘|噪声|工资|劳务|实名|应急|BIM|智慧|管线/u.test(title);
    });
    const target = enriched[carrierIndex >= 0 ? carrierIndex : 0];
    const additions = diagnostic.missingSections.filter(section => !used.has(section));
    for (const section of additions) {
      used.add(section);
      if (!target.sections.some(item => normalize(item).includes(normalize(section)) || normalize(section).includes(normalize(item)))) {
        target.sections.push(section);
      }
    }
  }

  // 评分标准条目承接审计：招标文件评审条目必须被章节结构承接；
  // 未承接条目自动补为小节（挂靠公共特征词最多的章节），保证评分标准要求的内容不会被整篇遗漏
  // 注意：审计与承载章打分必须基于 input.chapters（与调用方构建语义相似度闭包时的缓存 key 同源），
  // 不得用上面已补全小节的 enriched——补全后 chapterCriteriaText 不在闭包缓存内会静默返回 0，
  // 导致被补全章节的承接判定/承载打分全部失效、误补冗余小节（历史缺陷：缓存 key 跨阶段不一致）
  let criteriaAudit: EvaluationCriteriaAudit | undefined;
  if (input.evaluationItems?.length) {
    const chapterTexts = input.chapters.map(chapterCriteriaText);
    criteriaAudit = auditEvaluationCriteriaCoverage(input.chapters, input.evaluationItems, { semanticSimilarity: input.semanticSimilarity });
    for (const { item } of criteriaAudit.uncovered) {
      const sectionTitle = item.title;
      if (!sectionTitle) continue;
      // 条款碎片不补挂（补挂回路二次治理）：评分条目标题若为招标条款碎片
      // （编号残留/承诺断言/委员会动作等），补挂进章节后无证据支撑会阻断章节任务；
      // 二次过滤（documentGenerator 补挂后）为最终兜底，此处提前拦截避免补挂噪音
      if (isTenderClauseFragmentTitle(sectionTitle)) continue;
      const carrierIndex = chapterTexts.reduce((best, text, index) => {
        // 挂靠评分：语义相似度可用时用余弦打分；否则用条目标题的显式包含计数兜底
        const score = input.semanticSimilarity ? input.semanticSimilarity(sectionTitle, text) : (text.includes(normalize(sectionTitle)) ? 1 : 0);
        return score > best.score ? { index, score } : best;
      }, { index: -1, score: -1 }).index;
      const target = enriched[carrierIndex >= 0 ? carrierIndex : 0];
      if (!target.sections.some(existing => normalize(existing).includes(normalize(sectionTitle)) || normalize(sectionTitle).includes(normalize(existing)))) {
        target.sections.push(sectionTitle);
        target.purpose = `${target.purpose || ''}；系统已按招标文件技术评审条目自动补足小节“${sectionTitle}”，必须基于项目资料与适用技术展开实质内容。`;
        issues.push({ level: 'warning', severity: 'warning', message: `评分标准条目“${sectionTitle}”无承接章节，已自动补小节“${sectionTitle}”至“${target.title}”`, suggestion: '请确认补充小节与招标文件评审条目口径一致。' });
      }
    }
  }

  // 项目类型专属加分结构
  const projectTypes = inferConstructionOrgProjectTypes(input);
  for (const type of projectTypes) {
    if (type === 'general') continue;
    for (const extra of PROJECT_TYPE_EXTRA_GROUPS[type]) {
      const chapterText = normalize(enriched.map(chapter => `${chapter.title} ${(chapter.sections || []).join(' ')}`).join(' '));
      if (extra.requiredSectionPatterns.some(pattern => pattern.test(chapterText))) continue;
      const carrierIndex = enriched.findIndex(chapter => {
        const title = normalize(chapter.title);
        return extra.chapterPatterns.some(pattern => pattern.test(title));
      });
      const target = enriched[carrierIndex >= 0 ? carrierIndex : 0];
      target.sections.push(extra.title);
    }
  }

  return { diagnostics, issues, enrichedChapters: enriched, criteriaAudit };
}

/** 评分条目标题清理：去掉“针对/确保”等框架前缀与“的保障体系与措施”等尾缀，得到可作小节标题的短语 */
function cleanEvaluationItemTitle(item: string) {
  const title = item.replace(/^针对/u, '').replace(/^确保/u, '').replace(/的保障体系与措施$/u, '').replace(/的管理体系与措施$/u, '').replace(/保障体系与措施$/u, '').replace(/管理体系与措施$/u, '').replace(/[，、；,;]+$/u, '').trim();
  // 汉字阈值 4→3（创优类短条目如“黄山杯”必须保留）；2 字含“杯/奖”的奖项条目同样保留
  if (!/[\u4e00-\u9fa5]{3}/u.test(title) && !/[杯奖]/u.test(title)) return '';
  if (/工期与质量/u.test(title)) return ''; // 框架条目，正文结构已由大纲承接
  return title.length > 24 ? title.slice(0, 24) : title;
}
