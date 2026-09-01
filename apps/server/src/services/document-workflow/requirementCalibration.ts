import type { DocumentTemplateChapter } from './types';
import { callDocumentLlmJson } from './llmClient';
import { displayChapterTitle, isTenderClauseFragmentTitle } from './outline';
import { cleanSectionTitleArtifacts, isInvalidPlannedSectionTitle, normalizePlannedSectionTitle, sectionTitleEquivalent } from './promptRuleExtraction';
import { docSystemPrefix } from './markdownComposer';

/**
 * C2 大纲要求校准：评分项要求在结构层显性承接（创优目标与奖惩/绿色等级/智慧工地/装配率等必提要求，
 * 在大纲层就有显性承接小节，而非写章时临场发挥——与确定性补挂回路形成「语义校准（LLM）+ 结构补挂（确定性）」双保险）。
 *
 * 防幻觉设计（additions-only）：LLM 只允许输出「新增小节」清单，原大纲小节列表不经过 LLM 修订路径——
 * 结构守恒由构造保证（不可能删小节）；纯代码校验只负责：章名匹配、标题清洗、重复剔除、条款碎片过滤与数量上限。
 * 空响应/LLM 失败/校验无产出均返回空数组，由调用方回退原规划。
 */

export interface RequirementSectionAddition {
  chapterTitle: string;
  sections: string[];
}

/** 恒定 system（A5a 模式：跨生成共享前缀缓存，可变输入全部在 user 消息） */
const REQUIREMENT_CALIBRATION_SYSTEM = [
  '你是施工组织设计大纲校准专家。输入各章已有小节与招标评分项要求，只输出需要新增的小节。',
  '新增小节必须显性承接评分项要求（如"创优目标与奖惩承诺""绿色建筑等级达标专项""智慧工地实施""装配式专项施工方案"），只允许新增，不得修改或删除任何已有小节。',
  '只有当前章节结构确实缺少对应承接小节时才新增；已有小节已覆盖该要求时不要重复新增。',
  '新增小节标题必须具体、可直接成稿，控制在 16 个汉字以内；不得新增与评分项要求无关的小节，不得输出条款碎片（如"1委员会确定中"）。',
  '只返回 JSON，不要返回 markdown。',
].join('\n\n');

const MAX_ADDITIONS_PER_CHAPTER = 2;
const MAX_TOTAL_ADDITIONS = 8;

/** 章名匹配：先精确匹配（去序号归一化），再包含关系兜底（LLM 可能输出带序号或缩写的章标题） */
function findChapterIndex(chapters: DocumentTemplateChapter[], rawTitle: string) {
  const normalized = normalizePlannedSectionTitle(rawTitle);
  if (!normalized) return -1;
  const exact = chapters.findIndex(chapter => displayChapterTitle(chapter.title) === normalized || normalizePlannedSectionTitle(chapter.title) === normalized);
  if (exact >= 0) return exact;
  return chapters.findIndex(chapter => {
    const chapterTitle = normalizePlannedSectionTitle(chapter.title);
    return chapterTitle.length >= 4 && (chapterTitle.includes(normalized) || normalized.includes(chapterTitle));
  });
}

/**
 * 大纲要求校准（一次全局轻量 LLM 调用）：输入 = 评分项要求摘要 + 各章小节列表，输出 = 校验后的新增小节清单。
 * 返回空数组表示「无新增需求/调用失败/无有效产出」，调用方回退原规划。
 */
export async function calibrateOutlineSectionsToRequirements(input: {
  chapters: DocumentTemplateChapter[];
  requirementSummary: string[];
  templateName: string;
  signal?: AbortSignal;
}): Promise<RequirementSectionAddition[]> {
  if (input.requirementSummary.length === 0 || input.chapters.length === 0) return [];
  const chapterLines = input.chapters
    .map(chapter => `【${displayChapterTitle(chapter.title)}】\n${(chapter.sections || []).filter(Boolean).map(section => `- ${section}`).join('\n') || '（本章暂无预设小节）'}`)
    .join('\n\n');
  const result = await callDocumentLlmJson<{ additions?: Array<{ chapterTitle?: string; sections?: string[] }> }>(
    docSystemPrefix(REQUIREMENT_CALIBRATION_SYSTEM),
    [
      `文档模板：${input.templateName}`,
      `招标评分项要求摘要（必须逐条在结构层显性承接）：\n${input.requirementSummary.map(item => `- ${item}`).join('\n')}`,
      `各章当前小节列表：\n${chapterLines}`,
      '请输出需要新增的小节；没有需要新增的章节不要出现在 additions 中，整体无新增则输出空数组。',
      'JSON 格式：{"additions":[{"chapterTitle":"章标题（必须与上方章节名一致）","sections":["新增小节标题"]}]}',
    ].join('\n\n'),
    { maxTokens: 2000, temperature: 0.1, signal: input.signal },
  );
  // 纯代码校验（防幻觉）：章名必须匹配现有章节；标题清洗归一（与规划同口径）；重复剔除；数量上限
  const validated: RequirementSectionAddition[] = [];
  let totalCount = 0;
  for (const raw of result?.additions || []) {
    if (!raw?.chapterTitle || !Array.isArray(raw.sections)) continue;
    const chapterIndex = findChapterIndex(input.chapters, raw.chapterTitle);
    if (chapterIndex < 0) continue;
    const chapter = input.chapters[chapterIndex];
    const cleaned: string[] = [];
    for (const rawSection of raw.sections) {
      const title = cleanSectionTitleArtifacts(normalizePlannedSectionTitle(String(rawSection || '')));
      if (!title || isInvalidPlannedSectionTitle(title, chapter.title)) continue;
      // 条款碎片提前拦截（与大纲主题过滤同口径，如"1委员会确定中"）：下游 filterOffTopicSectionsForChapters
      // 是最终兜底，此处提前拦截避免碎片小节进入写作计划
      if (isTenderClauseFragmentTitle(title)) continue;
      if ((chapter.sections || []).some(existing => sectionTitleEquivalent(existing, title))) continue;
      if (cleaned.some(existing => sectionTitleEquivalent(existing, title))) continue;
      cleaned.push(title);
    }
    const budget = Math.min(MAX_ADDITIONS_PER_CHAPTER, cleaned.length, Math.max(0, MAX_TOTAL_ADDITIONS - totalCount));
    const capped = cleaned.slice(0, budget);
    if (capped.length === 0) continue;
    totalCount += capped.length;
    validated.push({ chapterTitle: chapter.title, sections: capped });
    if (totalCount >= MAX_TOTAL_ADDITIONS) break;
  }
  return validated;
}

/**
 * 应用新增小节到章节（结构守恒校验）：新增只挂到匹配章节尾部，原小节逐条保留；
 * 应用后按「原章数与原小节逐项比对」做显性守恒校验，任一缺失即整体回退原大纲（防幻觉漏硬性结构）。
 */
export function applyRequirementSectionAdditions(
  chapters: DocumentTemplateChapter[],
  additions: RequirementSectionAddition[],
): { chapters: DocumentTemplateChapter[]; applied: RequirementSectionAddition[] } {
  if (!additions.length) return { chapters, applied: [] };
  const applied: RequirementSectionAddition[] = [];
  const next = chapters.map(chapter => ({ ...chapter, sections: [...(chapter.sections || [])] }));
  for (const addition of additions) {
    const chapterIndex = next.findIndex(chapter => displayChapterTitle(chapter.title) === displayChapterTitle(addition.chapterTitle) || normalizePlannedSectionTitle(chapter.title) === normalizePlannedSectionTitle(addition.chapterTitle));
    if (chapterIndex < 0) continue;
    const chapter = next[chapterIndex];
    const fresh = addition.sections.filter(title => !(chapter.sections || []).some(existing => sectionTitleEquivalent(existing, title)));
    if (fresh.length === 0) continue;
    chapter.sections.push(...fresh);
    applied.push({ chapterTitle: addition.chapterTitle, sections: fresh });
  }
  // 结构守恒校验（用户要求：校准后小节列表必须包含原大纲所有必填固定章节/小节）
  const conserved = chapters.every((original, index) => {
    const target = next[index];
    if (!target) return false;
    return (original.sections || []).every(section => (target.sections || []).some(existing => sectionTitleEquivalent(existing, section)));
  });
  if (!conserved) return { chapters, applied: [] };
  return { chapters: next, applied };
}
