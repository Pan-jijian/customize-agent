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

export function chapterBudgetWeight(chapter: DocumentTemplateChapter) {
  const title = chapter.title + chapter.purpose;
  if (/方法|技术|质量|安全|进度|资源|保障|措施|部署|方案|流程|执行/u.test(title)) return 1.3;
  if (/概况|结语|附录/u.test(title)) return 0.75;
  return 1;
}

export function buildDocumentBudget(input: { requirement?: string; promptTexts: string; template: DocumentTemplate; chapters: DocumentTemplateChapter[]; spec?: AutoDocumentSpecPackage }): DocumentBudget {
  const settings = input.template.generationSettings || input.template.exportSettings;
  const charsPerPage = charsPerPageForSettings(input.template.exportSettings || input.template.generationSettings);
  const explicit = explicitLengthTargets([input.requirement || '', input.promptTexts].join('\n'));
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
  const totalWeight = chapters.reduce((sum, chapter) => sum + chapterBudgetWeight(chapter), 0) || 1;
  const chapterTargets = new Map<string, number>();
  const weightedTargets = chapters.map(chapter => ({ chapter, target: targetChars ? Math.round(targetChars * chapterBudgetWeight(chapter) / totalWeight) : 0 }));
  const fallbackTotal = chapters.reduce((sum, chapter) => sum + Math.max(
    input.spec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title)?.minWords || 0,
    input.spec?.dynamicChapterRule.minWordsPerChapter || 0,
    targetChars ? Math.min(900, Math.max(450, Math.floor(targetChars / Math.max(1, chapters.length) * 0.35))) : 1200,
  ), 0);
  const targetScale = targetChars && fallbackTotal > targetChars * 0.92 ? Math.max(0.45, targetChars * 0.92 / fallbackTotal) : 1;
  for (const { chapter, target } of weightedTargets) {
    const specMinimum = Math.max(
      input.spec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title)?.minWords || 0,
      input.spec?.dynamicChapterRule.minWordsPerChapter || 0,
    );
    const dynamicFallback = targetChars ? Math.min(900, Math.max(450, Math.floor(targetChars / Math.max(1, chapters.length) * 0.35))) : 1200;
    const fallback = Math.floor(Math.max(specMinimum, dynamicFallback) * targetScale);
    chapterTargets.set(chapter.id, Math.max(fallback, target));
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
  if (min && estimatedPages < min) issues.push({ level: 'error', message: `正文篇幅低于目标页数：预计约 ${estimatedPages} 页，目标不少于 ${min} 页`, suggestion: '请重新生成或增加章节正文深度后再导出正式文件。' });
  if (max && estimatedPages > max + 4) issues.push({ level: 'warning', message: `正文篇幅可能超过目标页数：预计约 ${estimatedPages} 页，目标不超过 ${max} 页`, suggestion: '建议检查是否存在重复段落或过度展开。' });
  return issues;
}

export function documentBudgetIssues(budget: DocumentBudget, markdown: string): ValidationIssue[] {
  const { currentChars, estimatedPages } = documentBudgetStatus(budget, markdown);
  const issues: ValidationIssue[] = [];
  if (budget.minChars && currentChars < budget.minChars) {
    issues.push({ level: 'error', message: `正文篇幅低于目标字数：当前 ${currentChars} 字，目标不少于 ${budget.minChars} 字`, suggestion: '请继续扩写缺口章节，或降低目标字数/页数后重新生成。' });
  }
  if (budget.maxChars && currentChars > Math.ceil(budget.maxChars * 1.12)) {
    issues.push({ level: 'error', message: `正文篇幅超过目标字数区间：当前 ${currentChars} 字，建议不超过 ${budget.maxChars} 字`, suggestion: '请压缩重复段落、过细小节或过度展开内容后再导出。' });
  } else if (budget.maxChars && currentChars > budget.maxChars) {
    issues.push({ level: 'warning', message: `正文篇幅超过目标字数区间：当前 ${currentChars} 字，建议不超过 ${budget.maxChars} 字`, suggestion: '建议减少重复段落、过细小节或过度展开内容。' });
  }
  if (budget.minPages && estimatedPages < budget.minPages) {
    issues.push({ level: 'error', message: `正文篇幅低于目标页数：预计约 ${estimatedPages} 页，目标不少于 ${budget.minPages} 页`, suggestion: '请继续扩写正文，或调整导出字号/行距后再导出。' });
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
