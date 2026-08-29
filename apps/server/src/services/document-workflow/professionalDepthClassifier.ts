import { getLocalSemanticProvider, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';

/**
 * 专业深度语义分类器（round-14）：把“章节专业深度六维打分 / 专业内容缺项 / 泛化套话 / 闭环缺失 /
 * 章节依赖”等语义定性判断从关键词正则打分（0/1/2 关键词命中计分）迁移到本地 bge-small 嵌入的
 * 语义覆盖判定（余弦 ≥0.6 视为该维度已覆盖）。
 *
 * 背景（外部验收报告模板化缺陷 + 正则误伤根因）：关键词正则给语义质量打分必然误伤——
 * 正文写出“关键线路法（CPM）”而未出现“关键线路”四字即判结构分缺失；写出“动态纠偏机制”
 * 而未出现“纠偏”二字即判进度章节缺项；反之仅罗列关键词的模板段却拿满分（漏检）。
 * 协同边界：主题召回（标题属于哪类专业章节）与字面封闭词表（套话词/管理数字本身）仍由正则
 * 处理，语义定性（维度是否覆盖、是否具备闭环、是否绑定项目事实）由本分类器判定；
 * 本地语义模型恒可用（本地 ONNX 推理），构建失败直接抛出暴露缺陷，无不可用降级路径。
 */

export type DepthDimension = 'factuality' | 'structure' | 'depth' | 'executable' | 'specificity' | 'consistency';

export type ContentNeedKey = 'schedule' | 'quality' | 'safety' | 'resource' | 'construction';

export interface ProfessionalDepthAnalysis {
  /** 六维专业深度覆盖（每维 true = 语义上已覆盖该维度） */
  dimensions: Record<DepthDimension, boolean>;
  /** 五类专业章节内容要求覆盖 */
  contentNeeds: Record<ContentNeedKey, boolean>;
  /** 是否绑定项目事实/工序控制点（具体内容，非泛化套话） */
  concrete: boolean;
  /** 是否具备检查整改验收闭环 */
  closedLoop: boolean;
}

export interface ProfessionalDepthClassifier {
  /** 分析单段文本（章节正文或段落），返回全部语义判定；
   * 空文本返回 undefined（输入边界：无内容可分析，调用方跳过——不得用全 false 替身冒充判定结果） */
  analyze: (text: string) => Promise<ProfessionalDepthAnalysis | undefined>;
}

/** 六维专业深度语义锚点（每维 3 条，覆盖该维度的典型专业表述） */
const DIMENSION_ANCHORS: Record<DepthDimension, string[]> = {
  factuality: [
    '本章关键数据以招标文件、工程量清单与施工图纸为依据',
    '正文引用的工期、面积、金额与绑定资料口径一致',
    '施工内容与项目实际工程范围对应而非通用模板描述',
  ],
  structure: [
    '内容按施工准备、工艺流程、施工方法、验收标准的顺序组织',
    '章节内有清晰的工作阶段划分与工序步骤',
    '段落之间有先后衔接与层次递进关系',
  ],
  depth: [
    '包含关键工序控制点、隐蔽工程验收与检验批划分',
    '关键技术环节给出工艺参数与质量标准',
    '针对本项目特点展开专业分析而非通用做法罗列',
  ],
  executable: [
    '明确责任主体、检查频次与记录台账要求',
    '给出可执行的资源进场、调配与投入安排',
    '措施可落地执行并配验收复核机制',
  ],
  specificity: [
    '结合本项目建设地点、工程规模与计划工期展开',
    '引用本项目工程量数据支撑施工部署',
    '措施针对本项目工程特点制定而非通用套话',
  ],
  consistency: [
    '章节间工期、质量、安全数据口径一致',
    '本章内容与总进度计划、质量目标相互呼应',
    '章节内前后表述无矛盾冲突',
  ],
};

/** 五类专业章节内容要求锚点（进度/质量/安全/资源/施工技术） */
const CONTENT_NEED_ANCHORS: Record<ContentNeedKey, string[]> = {
  schedule: [
    '采用关键线路法编制进度计划，明确关键节点与动态纠偏措施',
    '计划节点与资源投入相匹配，含穿插施工与资源保障安排',
  ],
  quality: [
    '材料进场验收与复验、隐蔽工程验收、质量问题整改与复验闭环',
    '质量资料归档与检验批验收记录',
  ],
  safety: [
    '风险源辨识、临电消防管理、安全检查与隐患整改闭环',
    '应急预案、应急物资与演练安排',
  ],
  resource: [
    '劳动力、材料、设备进场计划、验收、保管与调配',
    '资源投入与进度节点相匹配',
  ],
  construction: [
    '施工准备、工艺流程、工序控制点与验收标准交底',
    '施工方法与工艺参数明确具体',
  ],
};

/** 具体性锚点：绑定项目事实/工序控制点/验收闭环的专业内容 */
const CONCRETE_ANCHORS = [
  '材料进场验收、工序控制点、隐蔽工程验收记录',
  '检验批划分、技术交底、整改复查闭环',
  '引用本项目工程量清单与设计图纸参数',
] as const;

/** 闭环锚点：检查—整改—复查—归档类管理闭环 */
const CLOSED_LOOP_ANCHORS = [
  '自检互检交接检、整改复查、资料归档',
  '风险辨识、专项交底、现场检查、隐患整改、复查销项',
  '计划分解、偏差识别、资源纠偏、节点复核',
] as const;

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
  return sum;
}

/** 长正文分块：按段落聚合至 ≤400 字符（bge 512 token 安全窗口内），块数上限 MAX_CHUNKS；
 * 超限时首中尾均匀采样而非截断——历史缺陷：8 块硬截断只分析前 3200 字，长章节（主要施工方法等
 * 6000+ 字）后半的具体工艺/闭环内容不可见，concrete/closedLoop 误判 false 触发 error 级误伤 */
const MAX_CHUNKS = 20;
function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n+/u).map(item => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > 400) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length <= MAX_CHUNKS) return chunks;
  // 均匀采样：保留首尾块，中间按固定步长取样，保证长章节首中尾全程覆盖
  const sampled: string[] = [chunks[0]];
  const step = (chunks.length - 2) / (MAX_CHUNKS - 2);
  for (let index = 1; index < MAX_CHUNKS - 1; index += 1) {
    sampled.push(chunks[Math.min(chunks.length - 2, Math.round(1 + (index - 1) * step))]);
  }
  sampled.push(chunks[chunks.length - 1]);
  return sampled;
}

function maxSimilarity(blockVectors: number[][], anchorVectors: number[][]): number {
  let max = 0;
  for (const block of blockVectors) {
    for (const anchor of anchorVectors) {
      const similarity = dot(block, anchor);
      if (similarity > max) max = similarity;
    }
  }
  return max;
}

function dimensionCoverage(blockVectors: number[][], anchorCache: Map<string, number[][]>): Record<DepthDimension, boolean> {
  const coverage = {} as Record<DepthDimension, boolean>;
  for (const dimension of Object.keys(DIMENSION_ANCHORS) as DepthDimension[]) {
    const vectors = anchorCache.get(`dimension:${dimension}`) || [];
    coverage[dimension] = maxSimilarity(blockVectors, vectors) >= SEMANTIC_COVERAGE_THRESHOLD;
  }
  return coverage;
}

function contentNeedCoverage(blockVectors: number[][], anchorCache: Map<string, number[][]>): Record<ContentNeedKey, boolean> {
  const coverage = {} as Record<ContentNeedKey, boolean>;
  for (const needKey of Object.keys(CONTENT_NEED_ANCHORS) as ContentNeedKey[]) {
    const vectors = anchorCache.get(`need:${needKey}`) || [];
    coverage[needKey] = maxSimilarity(blockVectors, vectors) >= SEMANTIC_COVERAGE_THRESHOLD;
  }
  return coverage;
}

/** 构建专业深度语义分类器：预嵌入全部锚点；本地语义模型恒可用（本地 ONNX 推理），失败直接抛出 */
export async function buildProfessionalDepthClassifier(): Promise<ProfessionalDepthClassifier> {
  const provider = getLocalSemanticProvider();
  const anchorGroups: Array<[string, string[]]> = [
    ...(Object.keys(DIMENSION_ANCHORS) as DepthDimension[]).map(dimension => [`dimension:${dimension}`, DIMENSION_ANCHORS[dimension]] as [string, string[]]),
    ...(Object.keys(CONTENT_NEED_ANCHORS) as ContentNeedKey[]).map(needKey => [`need:${needKey}`, CONTENT_NEED_ANCHORS[needKey]] as [string, string[]]),
    ['concrete', [...CONCRETE_ANCHORS]],
    ['closedLoop', [...CLOSED_LOOP_ANCHORS]],
  ];
  const anchorCache = new Map<string, number[][]>();
  for (const [key, anchors] of anchorGroups) {
    const vectors = await provider.embedDocuments(anchors);
    if (vectors.length !== anchors.length) {
      throw new Error(`本地语义模型锚点嵌入数量不一致：${key} ${vectors.length}/${anchors.length}`);
    }
    anchorCache.set(key, vectors);
  }
  // 闭包块向量缓存：同一章节文本被多个校验器复用时不重复嵌入
  const blockCache = new Map<string, number[][]>();
  const embedBlocks = async (text: string): Promise<number[][]> => {
    const cached = blockCache.get(text);
    if (cached !== undefined) return cached;
    const chunks = chunkText(text);
    const vectors = await provider.embedDocuments(chunks);
    blockCache.set(text, vectors);
    return vectors;
  };
  return {
    async analyze(text: string): Promise<ProfessionalDepthAnalysis | undefined> {
      if (!text.trim()) return undefined;
      const blocks = await embedBlocks(text);
      // 空文本返回 undefined（输入边界：无内容可分析，调用方跳过）；
      // 全 false 替身会被 genericProfessionalContentIssues 等消费方当真实判定使用，
      // concrete=false 触发 error 误伤（判定不了就不判）
      if (blocks.length === 0) return undefined;
      return {
        dimensions: dimensionCoverage(blocks, anchorCache),
        contentNeeds: contentNeedCoverage(blocks, anchorCache),
        concrete: maxSimilarity(blocks, anchorCache.get('concrete') || []) >= SEMANTIC_COVERAGE_THRESHOLD,
        closedLoop: maxSimilarity(blocks, anchorCache.get('closedLoop') || []) >= SEMANTIC_COVERAGE_THRESHOLD,
      };
    },
  };
}
