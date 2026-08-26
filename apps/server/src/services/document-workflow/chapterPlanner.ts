import type { DocumentEvidence, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from './types';
import { buildEvidenceBundle, evidenceBundlePrompt, evidencePromptBudgetForTarget } from './evidence';
import { callDocumentLlm, extractJsonPayload } from './llmClient';
import { displayChapterTitle } from './outline';

/**
 * 章级规划者（Chapter Planner）：把模板/OUTLINE 显式提供的细目清单重排为「三级主题块 + H4 要点」结构，
 * 从根本上解决「小节数 = LLM 调用数」的碎片化生成问题。
 *
 * 职责：
 * 1. 语义聚类：把多达数十条的输入细目聚类为 6~12 个目录级主题块（三级小节）；
 * 2. 语义合并：语义相近的细目由 LLM 合并进同一个重写标题的 H4 要点（sources 逐字保留被合并细目），
 *    从根本上消除「每条细目一个标题」的目录碎片化；代码侧确定性校验 100% 覆盖；
 * 3. 事实分配：关键证据只分配给唯一主题块，消除逐节现场检索导致的跨节重复引用；
 * 4. 字数预算：按 subPoints 数量加权分配每块目标字数（1200~2200），保证单节深度。
 *
 * 上下文：LLM 规划时注入项目图谱章节定向摘要与文档蓝图（本章任务卡/实施方案/事实覆盖矩阵），
 * 让合并决策基于项目实际结构（工程/工法/资源/工期/标准/风险/要求）而非标题表面相似度。
 *
 * 失败回退：LLM JSON 无效时降级为确定性语义域分组（域内高相似细目合并，每块 ≤6 个 H4），保证管线永远可用。
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

/** 主题块内 H4 要点上限：超过则切分新块，控制单次调用输出量 */
const MAX_SUB_POINTS_PER_BLOCK = 6;
/** 主题块最小/最大目标字数 */
const MIN_BLOCK_TARGET_WORDS = 1200;
const MAX_BLOCK_TARGET_WORDS = 2200;

/**
 * 评标必查细目关键词：含这些词的输入细目必须保留为独立 H4 要点（标题可微调但关键词必须保留），
 * 不得被主题块聚类合并吞并（历史缺陷：“项目主要施工内容”被并入“项目概况与施工内容综述”导致目录缺评标必查词）。
 * 工期/质量/安全等高频词不进此表：章节内多条细目含这些词时全部保真会碎片化目录，由其自然聚类。
 */
const CRITICAL_SECTION_KEYWORDS = ['主要施工内容', '工程概况', '项目概况', '重点难点', '危大工程', '应急预案', '施工部署', '总平面'];

export function isCriticalSection(title: string) {
  return CRITICAL_SECTION_KEYWORDS.some(keyword => title.includes(keyword));
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
    // 评标必查细目兜底保真：无论相似度多高都不得并入既有 H4，必须新增独立 H4 保留原标题，
    // 否则“项目主要施工内容/危大工程/应急预案”等必查词会被语义合并吞掉，目录失分
    if (isCriticalSection(section)) {
      const targetBlock = bestBlock || enriched[enriched.length - 1];
      if (targetBlock) {
        targetBlock.subPoints.push({ title: section.slice(0, 30), sources: [section] });
        fallbackSections.push(section);
        continue;
      }
    }
    if (bestPoint && bestScore >= 0.5) {
      // 归并进既有 H4：LLM 的合并意图保留，代码只做承接挂接
      bestPoint.sources.push(section);
      fallbackSections.push(section);
    } else if (bestBlock) {
      bestBlock.subPoints.push({ title: section.slice(0, 30), sources: [section] });
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
  for (const section of inputSections) {
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
      if (!isCriticalSection(section) && last && (sameSectionText(section, lastSource) || bigramOverlap(section, lastSource) >= 0.75)) {
        last.sources.push(section);
        if (section.length > last.title.length) last.title = section.slice(0, 30);
      } else {
        merged.push({ title: section.slice(0, 30), sources: [section] });
      }
    }
    return merged;
  };
  const blocks: PlannedChapterBlock[] = [];
  for (const items of byDomain.values()) {
    const mergedPoints = mergeDomainSections(items);
    for (let offset = 0; offset < mergedPoints.length; offset += MAX_SUB_POINTS_PER_BLOCK) {
      const chunk = mergedPoints.slice(offset, offset + MAX_SUB_POINTS_PER_BLOCK);
      const pointCount = mergedPoints.length;
      blocks.push({ title: chunk[0].title || chapterTitle, subPoints: chunk, facts: [], targetWords: Math.min(MAX_BLOCK_TARGET_WORDS, Math.max(MIN_BLOCK_TARGET_WORDS, Math.floor(targetWords / Math.max(1, Math.ceil(pointCount / MAX_SUB_POINTS_PER_BLOCK))))) });
    }
  }
  return { blocks, coveredSections: inputSections.slice(), fallbackSections: [], llmPlanned: false };
}

/** 按 subPoints 数量加权分配每块目标字数（基数=章目标/块数，浮动 ±25%，封顶 1200~2200） */
function allocateBlockTargetWords(blocks: PlannedChapterBlock[], targetWords: number) {
  const totalPoints = blocks.reduce((sum, block) => sum + block.subPoints.length, 0) || blocks.length;
  for (const block of blocks) {
    const base = Math.max(1200, Math.floor(targetWords / Math.max(1, blocks.length)));
    const weighted = Math.floor((base * 0.75) + (targetWords * 0.25) * (block.subPoints.length / totalPoints));
    block.targetWords = Math.min(MAX_BLOCK_TARGET_WORDS, Math.max(MIN_BLOCK_TARGET_WORDS, weighted));
  }
}

interface PlannerLlmBlock {
  title?: string;
  subPoints?: Array<{ title?: string; source?: string; sources?: string[] }>;
  facts?: string[];
}

/**
 * 章级 LLM 规划：输入细目 ≤8 条时不调用 Planner（逐节路径更高效），由调用方判断；
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
  signal?: AbortSignal;
  diagnostics?: DocumentGenerationDiagnostics;
}): Promise<PlannedChapterStructure | undefined> {
  const inputSections = cleanInputSections(input.chapter);
  if (inputSections.length <= 8) return undefined;
  // 分而治之：推理模型的思考阶段占 70%+ 输出预算，细目过多时单次合并 JSON 会被截断或空响应；
  // 已验证 11/13 条稳定命中、25 条空响应、50 条截断 → 每批 ≤16 条（50 条递归拆成 13/12/13/12 四批），
  // 两批结果拼接后统一覆盖校验；任一批失败则整体未命中交由确定性兜底
  const BATCH_MAX_SECTIONS = 16;
  if (inputSections.length > BATCH_MAX_SECTIONS) {
    const mid = Math.ceil(inputSections.length / 2);
    const batchChapter = (sections: string[]): DocumentTemplateChapter => ({ ...input.chapter, sections });
    const first = await planChapterStructureWithLlm({ ...input, chapter: batchChapter(inputSections.slice(0, mid)), targetWords: Math.ceil(input.targetWords / 2) });
    const second = first && first.blocks.length > 0
      ? await planChapterStructureWithLlm({ ...input, chapter: batchChapter(inputSections.slice(mid)), targetWords: Math.floor(input.targetWords / 2) })
      : undefined;
    if (first && first.blocks.length > 0 && second && second.blocks.length > 0) {
      const blocks = [...first.blocks, ...second.blocks];
      allocateBlockTargetWords(blocks, input.targetWords);
      return ensureSectionCoverage(inputSections, blocks);
    }
    const failure = first && !first.blocks.length ? first.llmFailure : (second && !second.blocks.length ? second.llmFailure : undefined);
    return { blocks: [], coveredSections: [], fallbackSections: [], llmPlanned: false, llmFailure: failure ? `分批规划未命中（${failure}）` : '分批规划未命中' };
  }
  const maxBlocks = Math.min(12, Math.ceil(inputSections.length / 2.5));
  // 块数下限：细目较多时目录不应压成 2~3 块（历史缺陷：11 细目聚类成 3 块最终只剩 2 个三级节，目录粒度与评标预期不符）
  const minBlocks = Math.max(3, Math.min(maxBlocks, Math.ceil(inputSections.length / 3)));
  // H4 总数目标：评标必查细目不计入压缩预算（必查细目强制独立 H4），其余细目按 35%~60% 压缩，保证目录真正瘦身又不吞必查点
  const criticalCount = inputSections.filter(isCriticalSection).length;
  const compressibleCount = Math.max(0, inputSections.length - criticalCount);
  const minH4 = Math.max(2, criticalCount + Math.max(1, Math.round(compressibleCount * 0.35)));
  const maxH4 = Math.max(minH4, criticalCount + Math.round(compressibleCount * 0.6));
  // 单次规划尝试：attempt 0 完整上下文；attempt 1 精简上下文（证据预算与 facts 减半）。
  // 推理模型思考阶段随机挤占 8192 输出预算，JSON 截断/空响应呈随机性（同规模同输入时而命中时而失败），
  // 失败后以更短输入重试一次可显著提升命中率；全部失败则透传首因+重试因供进度展示诊断
  const planOnce = async (attempt: number): Promise<{ blocks: PlannedChapterBlock[]; failure?: string }> => {
    const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, input.evidence), { maxChars: evidencePromptBudgetForTarget(input.targetWords, attempt === 0 ? 5000 : 3000, attempt === 0 ? 12000 : 8000) });
    const factsLimit = attempt === 0 ? 4 : 2;
    const promptLines = [
      '你是专业施工组织设计文档结构规划专家。',
      '任务：把章节的细目清单重排为目录级主题块（三级小节），每个主题块下挂 2~4 个 H4 要点；语义相近、内容连贯的细目必须合并进同一个 H4 要点。',
      '硬性规则：',
      `1. 合并决策：语义相近、内容连贯的输入细目必须合并进同一个 H4 要点；H4 要点标题必须重写为更概括、更专业的标题（16 字以内），不得直接照抄任一输入细目标题；每个 H4 要点的 sources 字段逐字列出它所覆盖的全部输入细目标题，不得改写、不得遗漏、不得重复映射。例外：含评标必查关键词的输入细目（主要施工内容/工程概况/重点难点/危大工程/应急预案/施工部署/总平面等）必须保留为独立 H4 要点，不得与其他细目合并吞并，其 H4 标题必须保留该关键词。`,
      `2. 合并依据：优先参考项目图谱与文档蓝图，把在项目中对应同一套工程对象/管理闭环的细目合并（如「三检制度」「样板引路」「隐蔽工程验收」同属质量管控闭环）；不得把内容无关的细目强行合并。`,
      `3. 主题块标题必须具体、专业、能承载其要点（16 字以内），不得使用"目标与范围""资料依据""总体要求"等通用占位标题；同一内容不得在两个块重复出现。`,
      `4. 数量约束：整章 H4 要点总数必须控制在 ${minH4}~${maxH4} 个之间；每个主题块 2~4 个 H4 要点。`,
      `5. facts 字段：从绑定资料中摘取与本主题块直接相关的关键事实短句（每条 ≤60 字，1~${factsLimit} 条）；同一条事实只能分配给一个主题块。`,
      '6. 只返回 JSON，不要输出任何其他文字。',
      `JSON 格式：{"blocks":[{"title":"主题块标题","subPoints":[{"title":"H4要点标题","sources":["输入细目原文"]}],"facts":["事实短句"]}]}`,
    ];
    const userLines = [
      `文档模板：${input.template.name}`,
      `章节标题：${input.chapter.title}`,
      input.requirement ? `用户要求：${input.requirement}` : '',
      input.graphContext ? `项目图谱（本章定向，工程/工法/资源/工期/标准/风险/要求）：${input.graphContext.slice(0, 2500)}` : '',
      input.blueprintContext ? `文档蓝图（本章任务卡与实施方案）：${input.blueprintContext.slice(0, 4000)}` : '',
      input.projectContext ? `上下文：${input.projectContext.slice(0, 2000)}` : '',
      input.roleContext ? `角色要求：${input.roleContext.slice(0, 2000)}` : '',
      evidenceText ? `真实绑定资料：${evidenceText}` : '',
      `输入细目清单（共 ${inputSections.length} 条，必须全部覆盖，允许合并进同一 H4）：${inputSections.join('、')}`,
      `请输出 ${minBlocks}-${maxBlocks} 个主题块，整章 H4 要点 ${minH4}-${maxH4} 个，确保所有输入细目被覆盖。`,
    ];
    const rawResponse = await callDocumentLlm(promptLines.join(LF), userLines.filter(Boolean).join(LF + LF), true, { maxTokens: Math.max(3200, inputSections.length * 120), temperature: 0.1, signal: input.signal, diagnostics: input.diagnostics });
    if (!rawResponse) {
      // 透传 llmClient 记录的失败原因（空响应/限流/超时/连接失败），避免「LLM 无响应」不可诊断
      const lastError = input.diagnostics?.llm.lastError;
      return { blocks: [], failure: lastError ? `LLM 无响应（${lastError}）` : 'LLM 无响应' };
    }
    let result: { blocks?: PlannerLlmBlock[] };
    try {
      result = JSON.parse(extractJsonPayload(rawResponse)) as { blocks?: PlannerLlmBlock[] };
    } catch {
      const tail = rawResponse.slice(-100).replace(/\s+/gu, ' ');
      return { blocks: [], failure: `JSON 解析失败，响应末段：${tail}` };
    }
    if (!result?.blocks?.length) return { blocks: [], failure: 'LLM 返回 JSON 但 blocks 为空' };
    const blocks: PlannedChapterBlock[] = [];
    for (const raw of result.blocks) {
      const title = normalizePlannedTitle(raw.title || '');
      if (!title || isInvalidTitle(title, input.chapter.title)) continue;
      const subPoints = (raw.subPoints || [])
        .map(point => {
          // 兼容旧格式 source（单条）与新格式 sources（多条合并）
          const rawSources = Array.isArray(point.sources) && point.sources.length > 0 ? point.sources : (point.source ? [point.source] : []);
          // 仅保留能与输入细目对齐的 sources，防止 LLM 编造细目原文；去重保证不重复映射
          const sources: string[] = [];
          for (const rawSource of rawSources) {
            const normalized = normalizePlannedTitle(rawSource || '');
            if (normalized.length < 4) continue;
            if (!inputSections.some(section => sameSectionText(normalized, section))) continue;
            if (!sources.some(existing => sameSectionText(existing, normalized))) sources.push(normalized);
          }
          const subTitle = normalizePlannedTitle(point.title || '');
          // H4 标题有效即保留（LLM 的合并意图）；sources 未对齐时交由 ensureSectionCoverage 按相似度挂接
          if (!subTitle || subTitle.length < 4) return sources.length > 0 ? { title: sources[0].slice(0, 30), sources } : undefined;
          // H4 标题重写：优先 LLM 给的概括标题；照抄细目时取首条细目截断兜底
          const titleCandidate = subTitle && !sources.some(source => sameSectionText(subTitle, source)) ? subTitle : (sources[0] || subTitle);
          return { title: titleCandidate.slice(0, 30), sources };
        })
        .filter((point): point is PlannedChapterSubPoint => Boolean(point));
      if (subPoints.length === 0) continue;
      const facts = (raw.facts || []).map(item => item.trim().slice(0, 80)).filter(Boolean).slice(0, factsLimit);
      blocks.push({ title, subPoints, facts, targetWords: MIN_BLOCK_TARGET_WORDS });
    }
    if (blocks.length < 2) return { blocks: [], failure: `LLM 主题块有效数不足（仅 ${blocks.length} 个）` };
    return { blocks };
  };
  const firstAttempt = await planOnce(0);
  if (firstAttempt.blocks.length > 0) {
    allocateBlockTargetWords(firstAttempt.blocks, input.targetWords);
    return ensureSectionCoverage(inputSections, firstAttempt.blocks);
  }
  const retryAttempt = await planOnce(1);
  if (retryAttempt.blocks.length > 0) {
    allocateBlockTargetWords(retryAttempt.blocks, input.targetWords);
    return ensureSectionCoverage(inputSections, retryAttempt.blocks);
  }
  return { blocks: [], coveredSections: [], fallbackSections: [], llmPlanned: false, llmFailure: `重试后仍未命中（${retryAttempt.failure || '未知原因'}；首因：${firstAttempt.failure || '未知原因'}）` };
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
  signal?: AbortSignal;
  diagnostics?: DocumentGenerationDiagnostics;
}): Promise<PlannedChapterStructure> {
  const planned = (await planChapterStructureWithLlm(input).catch(error => {
    const failed: PlannedChapterStructure = { blocks: [], coveredSections: [], fallbackSections: [], llmPlanned: false, llmFailure: error instanceof Error ? error.message : String(error) };
    return failed;
  })) ?? { blocks: [], coveredSections: [], fallbackSections: [], llmPlanned: false, llmFailure: 'LLM 调用异常' };
  if (planned.blocks.length > 0) return planned;
  const inputSections = cleanInputSections(input.chapter);
  const fallback = fallbackStructureForSections(inputSections, input.chapter.title, input.targetWords);
  return { ...fallback, llmFailure: planned.llmFailure || 'LLM 调用异常' };
}
