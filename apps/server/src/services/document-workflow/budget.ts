import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentDraftChapter, DocumentExportSettings, DocumentGenerationSettings, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from './types';

export function estimateDocumentPages(markdown: string, settings?: DocumentGenerationSettings | DocumentExportSettings) {
  const textLength = documentTextLength(markdown);
  return Math.ceil(textLength / charsPerPageForSettings(settings));
}

export function documentTextLength(markdown: string) {
  return markdown.replace(/<[^>]+>/gu, '').replace(/\s+/gu, '').length;
}

export function charsPerPageForSettings(settings?: DocumentGenerationSettings | DocumentExportSettings) {
  const bodyFontSize = Number(String(settings && 'typography' in settings ? settings.typography?.bodySize || '' : '').replace(/[^\d.]/gu, '')) || 14;
  const lineHeight = Number(String(settings && 'typography' in settings ? settings.typography?.lineHeight || '' : '').replace(/[^\d.]/gu, '')) || 22;
  return bodyFontSize >= 14 && lineHeight >= 22 ? 900 : 1050;
}

export interface DocumentBudget {
  targetPages?: number;
  minPages?: number;
  maxPages?: number;
  targetChars?: number;
  minChars?: number;
  maxChars?: number;
  charsPerPage: number;
  chapterTargets: Map<string, number>;
  source: 'explicit' | 'template' | 'spec' | 'default';
  mode: ExplicitLengthMode;
  longformStrict: boolean;
}

export function parseChineseNumber(value: string) {
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(normalized)) return Number(normalized);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (normalized === '十') return 10;
  const ten = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(normalized);
  if (ten) return (ten[1] ? digits[ten[1]] : 1) * 10 + (ten[2] ? digits[ten[2]] : 0);
  return undefined;
}

export type ExplicitLengthMode = 'minimum' | 'approximate' | 'exact';

function explicitLengthMode(prefix = '', suffix = ''): ExplicitLengthMode {
  const text = `${prefix}${suffix}`;
  if (/不少于|至少|不低于|以上|起码/u.test(text)) return 'minimum';
  if (/约|大概|左右|大约|约为|附近/u.test(text)) return 'approximate';
  return 'exact';
}

export function explicitLengthTargets(text: string) {
  const normalized = text.replace(/\s+/gu, ' ');
  const pageMatches = [...normalized.matchAll(/(不少于|至少|不低于|约为|约|大概|大约|左右|生成|输出|达到|共)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(?:页|頁)\s*(以上|左右|以内|以下)?/gu)];
  const wordMatches = [...normalized.matchAll(/(不少于|至少|不低于|约为|约|大概|大约|左右|生成|输出|达到|共)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(万)?\s*(?:字|字符)\s*(以上|左右|以内|以下)?/gu)];
  const pageTarget = pageMatches.map(match => {
    const value = parseChineseNumber(match[2] || '');
    return Number.isFinite(value) ? { value, mode: explicitLengthMode(match[1], match[3]) } : undefined;
  }).filter((item): item is { value: number; mode: ExplicitLengthMode } => Boolean(item)).at(-1);
  const charTarget = wordMatches.map(match => {
    const value = parseChineseNumber(match[2] || '');
    return value ? { value: Math.round(value * (match[3] ? 10000 : 1)), mode: explicitLengthMode(match[1], match[4]) } : undefined;
  }).filter((item): item is { value: number; mode: ExplicitLengthMode } => Boolean(item)).at(-1);
  return { targetPages: pageTarget?.value, pageMode: pageTarget?.mode, targetChars: charTarget?.value, charMode: charTarget?.mode };
}

/** 章详略级别（容量需求估算档位：详写/标准/概述三档，预算因子参数化） */
export type ChapterDetailLevel = 'detailed' | 'standard' | 'brief';

/** 详略级别需求因子：详写 1.3 / 标准 1 / 概述 0.75（与历史 chapterBudgetWeight 权重同源） */
export const CHAPTER_DETAIL_LEVEL_FACTORS: Record<ChapterDetailLevel, number> = { detailed: 1.3, standard: 1, brief: 0.75 };

/** 章最低可写预算（水填锚点下限）：目标足以覆盖时保证每章不低于此值（方案可写区间下限） */
export const CHAPTER_MIN_BUDGET = 800;

export function chapterDetailLevel(chapter: DocumentTemplateChapter): ChapterDetailLevel {
  const title = chapter.title + chapter.purpose;
  if (/方法|技术|质量|安全|进度|资源|保障|措施|部署|方案|流程|执行/u.test(title)) return 'detailed';
  if (/概况|结语|附录/u.test(title)) return 'brief';
  return 'standard';
}

export function chapterBudgetWeight(chapter: DocumentTemplateChapter) {
  return CHAPTER_DETAIL_LEVEL_FACTORS[chapterDetailLevel(chapter)];
}

/** 章预算分配（预算契约）：内容单元需求估算（规划小节数 × 详略因子）→ 全局归一化到 T → 水填下限。
 * 确定性逻辑无 LLM；Σ章预算 = T 精确守恒（末位取余额）。
 * 下限不可满足（目标不足以覆盖全部章最低预算）时按下限比例压缩并显式告警——不静默放大。 */
export function allocateChapterTargets(chapters: DocumentTemplateChapter[], targetChars: number, floorOf: (chapter: DocumentTemplateChapter) => number) {
  const target = Math.max(0, Math.round(targetChars));
  const budgets = new Map<string, number>();
  if (chapters.length === 0) return budgets;
  const needs = chapters.map(chapter => Math.max(1, (chapter.sections || []).filter(Boolean).length) * chapterBudgetWeight(chapter));
  const floors = chapters.map(chapter => Math.max(CHAPTER_MIN_BUDGET, Math.round(floorOf(chapter))));
  const anchored = new Map<number, number>();
  for (let guard = 0; guard <= chapters.length; guard += 1) {
    const flexible = chapters.map((_, index) => index).filter(index => !anchored.has(index));
    if (flexible.length === 0) break;
    const remaining = target - [...anchored.values()].reduce((sum, value) => sum + value, 0);
    const needSum = flexible.reduce((sum, index) => sum + needs[index]!, 0) || flexible.length;
    const under = flexible.find(index => remaining * needs[index]! / needSum < floors[index]!);
    if (under === undefined) {
      // 收敛路径：锚定章取下限，灵活章按需求归一化分配余额（末位取余额 → Σ = T 精确守恒）
      let assigned = 0;
      for (const [index, floor] of anchored) {
        budgets.set(chapters[index]!.id, floor);
        assigned += floor;
      }
      flexible.forEach((index, position) => {
        const value = position === flexible.length - 1 ? Math.max(1, target - assigned) : Math.max(1, Math.round(remaining * needs[index]! / needSum));
        budgets.set(chapters[index]!.id, value);
        assigned += value;
      });
      return budgets;
    }
    anchored.set(under, floors[under]!);
  }
  // 下限不可满足：按下限比例压缩到 T（保留相对差异），显式告警不阻断（目标与章数量的真实约束冲突）
  const floorSum = floors.reduce((sum, floor) => sum + floor, 0) || chapters.length;
  console.error(`[budget] 篇幅预算不足：目标 ${target} 字不足以覆盖 ${chapters.length} 章最低预算（下限合计 ${floorSum} 字），按下限比例压缩分配`);
  let assigned = 0;
  chapters.forEach((chapter, index) => {
    const value = index === chapters.length - 1 ? Math.max(1, target - assigned) : Math.max(1, Math.round(target * floors[index]! / floorSum));
    budgets.set(chapter.id, value);
    assigned += value;
  });
  return budgets;
}

export function buildDocumentBudget(input: { requirement?: string; promptTexts: string; template: DocumentTemplate; chapters: DocumentTemplateChapter[]; spec?: AutoDocumentSpecPackage }): DocumentBudget {
  const settings = input.template.generationSettings || input.template.exportSettings;
  const charsPerPage = charsPerPageForSettings(input.template.exportSettings || input.template.generationSettings);
  const requirementExplicit = explicitLengthTargets(input.requirement || '');
  const promptExplicit = explicitLengthTargets(input.promptTexts || '');
  const explicit = requirementExplicit.targetChars || requirementExplicit.targetPages ? requirementExplicit : promptExplicit;
  const hasExplicitTarget = Boolean(explicit.targetChars || explicit.targetPages);
  const settingPages = hasExplicitTarget ? undefined : settings?.targetPages?.target || settings?.targetPages?.min;
  const explicitPageChars = explicit.targetPages ? explicit.targetPages * charsPerPage : undefined;
  const settingPageChars = settingPages ? settingPages * charsPerPage : undefined;
  const targetPages = explicit.targetPages || settingPages;
  const source: DocumentBudget['source'] = hasExplicitTarget ? 'explicit' : settingPages ? 'template' : input.spec?.chapterRules.some(rule => rule.minWords) || input.spec?.dynamicChapterRule.minWordsPerChapter ? 'spec' : 'default';
  const targetChars = hasExplicitTarget ? Math.max(explicit.targetChars || 0, explicitPageChars || 0) || undefined : Math.max(settingPageChars || 0) || undefined;
  const pageMode = explicit.pageMode || 'exact';
  const charMode = explicit.charMode || pageMode;
  const explicitApproximate = hasExplicitTarget && charMode === 'approximate';
  const explicitMinimum = hasExplicitTarget && charMode === 'minimum';
  const minPages = hasExplicitTarget
    ? (targetPages ? Math.floor(targetPages * (explicitMinimum ? 1 : 0.9)) : undefined)
    : settings?.targetPages?.min || (targetPages ? Math.floor(targetPages * 0.95) : undefined);
  const maxPages = hasExplicitTarget && targetPages && !explicitMinimum
    ? Math.ceil(targetPages * (explicitApproximate ? 1.15 : 1.08))
    : settings?.targetPages?.max;
  const minChars = targetChars ? Math.floor(targetChars * (explicitMinimum ? 1 : 0.9)) : (minPages ? minPages * charsPerPage : undefined);
  const maxChars = targetChars && !explicitMinimum ? Math.ceil(targetChars * (explicitApproximate ? 1.15 : 1.08)) : (maxPages ? maxPages * charsPerPage : undefined);
  const chapters = input.chapters.length > 0 ? input.chapters : input.template.chapters;
  const specMinimumOf = (chapter: DocumentTemplateChapter) => Math.max(
    input.spec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title)?.minWords || 0,
    input.spec?.dynamicChapterRule.minWordsPerChapter || 0,
  );
  let chapterTargets: Map<string, number>;
  if (targetChars) {
    // 预算契约：需求估算 → 全局归一化 → 水填下限，Σ章预算 = T 精确守恒
    //（旧实现 Math.max(fallback, 加权值) 让最低值兜底突破守恒——14 万目标预算合计 17.8 万的 27% 基准放大即源于此）
    chapterTargets = allocateChapterTargets(chapters, targetChars, specMinimumOf);
    // 守恒断言（防御性）：偏差超容差即算法回归，抛错显性暴露（容差 ≥ 章数，包容每章至少 1 字的舍入极限）
    const sum = [...chapterTargets.values()].reduce((acc, value) => acc + value, 0);
    if (Math.abs(sum - targetChars) > Math.max(chapters.length, Math.floor(targetChars * 0.02))) {
      throw new Error(`篇幅预算契约违约：Σ章预算 ${sum} 与目标 ${targetChars} 偏差超出容差（算法回归防御）`);
    }
  } else {
    // 无显式目标：保留 spec/默认下限兜底（无 T 不存在守恒约束）
    chapterTargets = new Map(chapters.map(chapter => [chapter.id, Math.max(1200, specMinimumOf(chapter))]));
  }
  const mode = charMode;
  const longformStrict = Boolean(hasExplicitTarget && (explicitMinimum || mode === 'exact') && (targetChars || minChars || 0) >= 40000);
  return { targetPages, minPages, maxPages, targetChars, minChars, maxChars, charsPerPage, chapterTargets, source, mode, longformStrict };
}

export function pageTargetIssues(settings: DocumentGenerationSettings | DocumentExportSettings | undefined, markdown: string): ValidationIssue[] {
  const target = settings?.targetPages;
  if (!target?.min && !target?.target && !target?.max) return [];
  const estimatedPages = estimateDocumentPages(markdown, settings);
  const min = target.min || target.target;
  const max = target.max || target.target;
  const issues: ValidationIssue[] = [];
  if (min && estimatedPages < min) issues.push({ level: 'warning', message: `正文篇幅低于目标页数：预计约 ${estimatedPages} 页，目标不少于 ${min} 页`, suggestion: '建议增加章节正文深度，或根据实际需求调整目标页数。' });
  if (max && estimatedPages > max + 4) issues.push({ level: 'warning', message: `正文篇幅可能超过目标页数：预计约 ${estimatedPages} 页，目标不超过 ${max} 页`, suggestion: '建议检查是否存在重复段落或过度展开。' });
  return issues;
}

export function documentBudgetIssues(budget: DocumentBudget, markdown: string): ValidationIssue[] {
  const { currentChars, estimatedPages } = documentBudgetStatus(budget, markdown);
  const issues: ValidationIssue[] = [];
  if (budget.minChars && currentChars < budget.minChars) {
    issues.push({ level: 'warning', message: `正文篇幅低于目标字数：当前 ${currentChars} 字，目标不少于 ${budget.minChars} 字`, suggestion: '建议继续扩写缺口章节，或根据实际需求调整目标字数/页数。' });
  }
  if (budget.maxChars && currentChars > Math.ceil(budget.maxChars * 1.12)) {
    issues.push({ level: 'error', message: `正文篇幅超过目标字数区间：当前 ${currentChars} 字，建议不超过 ${budget.maxChars} 字`, suggestion: '请压缩重复段落、过细小节或过度展开内容后再导出。' });
  } else if (budget.maxChars && currentChars > budget.maxChars) {
    issues.push({ level: 'warning', message: `正文篇幅超过目标字数区间：当前 ${currentChars} 字，建议不超过 ${budget.maxChars} 字`, suggestion: '建议减少重复段落、过细小节或过度展开内容。' });
  } else if (budget.mode === 'minimum' && budget.targetChars && currentChars > Math.ceil(budget.targetChars * 1.15)) {
    // 4.33 minimum 语义软上限：旧实现「不少于 X 字」只设下限，超产无感（丰乐镇 5 万目标产出 10 万字仅靠人工发现）；
    // 超出目标 15% 置 warning（不阻断导出），供修复轮与人工收敛定位篇幅异常
    issues.push({ level: 'warning', message: `正文篇幅超出目标字数：当前 ${currentChars} 字，目标约 ${budget.targetChars} 字（超出 ${Math.round((currentChars / budget.targetChars - 1) * 100)}%）`, suggestion: '建议压缩重复段落与过度展开内容，使正文接近目标篇幅。' });
  }
  if (budget.minPages && estimatedPages < budget.minPages) {
    issues.push({ level: 'warning', message: `正文篇幅低于目标页数：预计约 ${estimatedPages} 页，目标不少于 ${budget.minPages} 页`, suggestion: '建议继续扩写正文，或根据实际导出版式调整目标页数。' });
  }
  if (budget.maxPages && estimatedPages > budget.maxPages) {
    issues.push({ level: 'warning', message: `正文篇幅超过目标页数区间：预计约 ${estimatedPages} 页，建议不超过 ${budget.maxPages} 页`, suggestion: '建议压缩过度展开内容或调整目标页数。' });
  }
  return issues;
}

export function documentBudgetStatus(budget: DocumentBudget, markdown: string) {
  const currentChars = documentTextLength(markdown);
  const estimatedPages = Math.ceil(currentChars / budget.charsPerPage);
  return { currentChars, estimatedPages };
}
