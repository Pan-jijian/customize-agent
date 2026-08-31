import { FORMAL_FORBIDDEN_PHRASES } from './agentPlanner';
import { CALENDAR_DATE_RE, REPEATED_WORD_RE } from './documentIntegrityChecks';
import { INTERNAL_TERM_EXACT_RE } from './internalTerminologyAnchors';
import { SOURCE_ENUMERATION_PHRASE_RE } from './markdownComposer';
import { BID_DISCIPLINE_PHRASES } from './utils';

/**
 * 评审轮修复 patch 前置校验（二期 2.1）：评审轮修复走 LLM 局部 patch，历史缺陷是修复
 * 过程会重新引入确定性检测器已拦下的缺陷（E4 资料来源罗列句/E7 内部术语/R5 编造绝对日期/Q8 叠词），
 * 只能靠交付前轮二次兜底。本模块在 patch 应用前对其 replacement 做纯正则/词表预检，
 * 命中时 observe 模式只计数、enforce 模式拒绝该 patch（修复语义不变，只是拦截「已知坏内容」）。
 *
 * 只包含四类零误伤的确定性检测器；不含语义模型类（商务数据/概况复述，需事实模型比对，成本高）。
 */

/** 内部术语封闭词集：后台话术（FORMAL_FORBIDDEN_PHRASES 排除商务投标函纪律词）+ 内部术语精确词。
 * 词表单一来源复用，不在本文件私造第二份。 */
const PATCH_GUARD_INTERNAL_TERMS = [
  ...FORMAL_FORBIDDEN_PHRASES.filter(phrase => !(BID_DISCIPLINE_PHRASES as readonly string[]).includes(phrase)),
  ...INTERNAL_TERM_EXACT_RE.source.split('|'),
];

/** 对单个修复 patch 的 replacement 做确定性缺陷预检，返回命中的缺陷描述数组（空数组=通过）。
 * 四类检测器与确定性检测层同源同口径：
 * 1. 资料来源罗列句（E4）：SOURCE_ENUMERATION_PHRASE_RE 与 markdownComposer.sourcePhraseIssues 同源；
 * 2. 后台内部术语（E7）：词集与 internalTerminologyAnchors L1 精确词 + agentPlanner 禁止话术同源；
 * 3. 编造绝对日期（R5）：CALENDAR_DATE_RE 与 documentIntegrityChecks.fabricatedStartDateIssues 同源
 *    （纯正则版无事实模型可比对，命中一律 flag 供修复复核）；
 * 4. 叠词（Q8）：REPEATED_WORD_RE 与 documentIntegrityChecks.repeatedWordIssues 同源。 */
export function deterministicDefectPrecheck(replacement: string): string[] {
  const hits: string[] = [];
  if (SOURCE_ENUMERATION_PHRASE_RE.test(replacement)) hits.push('资料来源罗列句');
  const terms = PATCH_GUARD_INTERNAL_TERMS.filter(term => replacement.includes(term));
  if (terms.length > 0) hits.push(`内部术语“${terms.join('”“')}”`);
  for (const match of replacement.matchAll(CALENDAR_DATE_RE)) {
    hits.push(`具体日历日期“${match[1]}年${match[2]}月${match[3]}日”`);
  }
  const repeated = [...new Set(replacement.match(REPEATED_WORD_RE) || [])];
  if (repeated.length > 0) hits.push(`叠词“${repeated.join('”“')}”`);
  return hits;
}
