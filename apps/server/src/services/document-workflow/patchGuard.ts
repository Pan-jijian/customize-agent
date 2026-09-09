import { FORMAL_FORBIDDEN_PHRASES } from './agentPlanner';
import {
  CALENDAR_DATE_RE,
  REPEATED_WORD_RE,
  finishThicknessIssues,
  formulaResidueIssues,
  metaDiscourseDeclarationIssues,
} from './documentIntegrityChecks';
import { INTERNAL_TERM_EXACT_RE } from './internalTerminologyAnchors';
import { SOURCE_ENUMERATION_PHRASE_RE } from './markdownComposer';
import { punctuationArtifactIssues } from './qualityValidation';
import { BID_DISCIPLINE_PHRASES } from './utils';
import { FORMAL_PLACEHOLDER_PATTERNS } from '../constants/qualityValidationConstants';

/**
 * 修复轮 patch 前置校验（二期 2.1 → 第 2 期 P11 全链扩展）：LLM 局部 patch 的历史缺陷是
 * 修复过程会重新引入确定性检测器已拦下的缺陷，只能靠交付前轮二次兜底。本模块在 patch 应用前
 * 对其 replacement 做纯正则/词表预检，命中时 observe 模式只计数、enforce 模式拒绝该 patch
 * （修复语义不变，只是拦截「已知坏内容」）。
 *
 * 收录原则（与注册表 deterministicSafe 口径一致）：只包含零误伤的确定性检测器，且词表/正则
 * 全部引用检测层同源常量或直接复用同源检测函数（禁止私造第二份词表）；不含语义模型类
 * （商务数据/概况复述/自伤句，需事实模型或语义比对，成本高且存在误伤风险）。
 */

/** 内部术语封闭词集：后台话术（FORMAL_FORBIDDEN_PHRASES 排除商务投标函纪律词）+ 内部术语精确词。
 * 词表单一来源复用，不在本文件私造第二份。 */
const PATCH_GUARD_INTERNAL_TERMS = [
  ...FORMAL_FORBIDDEN_PHRASES.filter(phrase => !(BID_DISCIPLINE_PHRASES as readonly string[]).includes(phrase)),
  ...INTERNAL_TERM_EXACT_RE.source.split('|'),
];

/** 未完成小节标记（与 documentPipeline.buildFullValidationIssues 的 writer-missing-section 检测同源口径） */
const WRITER_MISSING_SECTION_MARKERS = ['WRITER_MISSING_SECTION', 'Writer 未完成'] as const;

/** 截断句残留双冒号/标点叠用形态（与 documentIntegrityChecks.fixTruncatedSentenceArtifacts B2 步骤同源同口径） */
const TRUNCATED_SENTENCE_ARTIFACT_RES = [/：\s*：/u, /；：/u, /。：/u, /。；/u, /；。/u, /。，/u, /，。/u, /。{2,}/u] as const;

/**
 * 对单个修复 patch 的 replacement 做确定性缺陷预检，返回命中的缺陷描述数组（空数组=通过）。
 * 十类检测器与确定性检测层同源同口径（P11 扩展，原四类保留）：
 * 1. 资料来源罗列句（E4）：SOURCE_ENUMERATION_PHRASE_RE 与 markdownComposer.sourcePhraseIssues 同源；
 * 2. 后台内部术语（E7）：词集与 internalTerminologyAnchors L1 精确词 + agentPlanner 禁止话术同源；
 * 3. 编造绝对日期（R5）：CALENDAR_DATE_RE 与 documentIntegrityChecks.fabricatedStartDateIssues 同源
 *    （纯正则版无事实模型可比对，命中一律 flag 供修复复核）；
 * 4. 叠词（Q8）：REPEATED_WORD_RE 与 documentIntegrityChecks.repeatedWordIssues 同源；
 * 5. 未完成小节标记：WRITER_MISSING_SECTION/Writer 未完成 字符串与 buildFullValidationIssues 同源；
 * 6. 元话语声明句（F17）：直接复用 metaDiscourseDeclarationIssues（同函数即同源）；
 * 7. 公式形态残留（F18）：直接复用 formulaResidueIssues（同函数即同源）；
 * 8. 装饰层工艺参数异常：直接复用 finishThicknessIssues（同函数即同源）；
 * 9. 占位符：FORMAL_PLACEHOLDER_PATTERNS 与 formalPlaceholderIssues 同源词表；
 * 10. 截断句残留双冒号形态：与 fixTruncatedSentenceArtifacts 同源同口径。
 */
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
  const missingSectionMarkers = WRITER_MISSING_SECTION_MARKERS.filter(marker => replacement.includes(marker));
  if (missingSectionMarkers.length > 0) hits.push(`未完成小节标记“${missingSectionMarkers.join('”“')}”`);
  if (metaDiscourseDeclarationIssues(replacement).length > 0) hits.push('元话语声明句');
  if (formulaResidueIssues(replacement).length > 0) hits.push('公式形态残留');
  if (finishThicknessIssues(replacement).length > 0) hits.push('装饰层工艺参数异常');
  const placeholderHits = FORMAL_PLACEHOLDER_PATTERNS.filter(pattern => pattern.test(replacement));
  if (placeholderHits.length > 0) hits.push('占位符');
  if (TRUNCATED_SENTENCE_ARTIFACT_RES.some(re => re.test(replacement))) hits.push('截断句残留双冒号');
  // 11. 句读标点叠用/括号与书名号不闭合（拼接删节残留）：直接复用 punctuationArtifactIssues 同函数即同源
  if (punctuationArtifactIssues(replacement).length > 0) hits.push('句读标点叠用/括号不闭合');
  return hits;
}
