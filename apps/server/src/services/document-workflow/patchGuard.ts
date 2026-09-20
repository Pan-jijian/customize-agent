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
import { punctuationArtifactIssues, scanTablePlaceholderCells } from './qualityValidation';
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
const TRUNCATED_SENTENCE_ARTIFACT_RES = [/：\s*：/u, /；：/u, /。：/u, /。；/u, /；。/u, /。，/u, /，。/u, /。{2,}/u, /、{2,}/u] as const;

/**
 * 对单个修复 patch 的 replacement 做确定性缺陷预检，返回命中的缺陷描述数组（空数组=通过）。
 * 十类内容型检测器与确定性检测层同源同口径（P11 扩展，原四类保留）：
 * 1. 资料来源罗列句（E4）：SOURCE_ENUMERATION_PHRASE_RE 与 markdownComposer.sourcePhraseIssues 同源；
 * 2. 后台内部术语（E7）：词集与 internalTerminologyAnchors L1 精确词 + agentPlanner 禁止话术同源；
 * 3. 编造绝对日期（R5）：CALENDAR_DATE_RE 与 documentIntegrityChecks.fabricatedStartDateIssues 同源
 *    （纯正则版无事实模型可比对，命中一律 flag 供修复复核）；
 * 4. 叠词（Q8）：REPEATED_WORD_RE 与 documentIntegrityChecks.repeatedWordIssues 同源；
 * 5. 未完成小节标记：WRITER_MISSING_SECTION/Writer 未完成 字符串与 buildFullValidationIssues 同源；
 * 6. 元话语声明句（F17）：直接复用 metaDiscourseDeclarationIssues（同函数即同源）；
 * 7. 公式形态残留（F18）：直接复用 formulaResidueIssues（同函数即同源）；
 * 8. 装饰层工艺参数异常：直接复用 finishThicknessIssues（同函数即同源）；
 * 9. 占位符：FORMAL_PLACEHOLDER_PATTERNS 短语词表 + scanTablePlaceholderCells（与 formalPlaceholderIssues/
 *    markdownTableQualityIssues 同源同口径：表格数据格豁免列「—」不判——D-T5 口径统一）；
 * 10. 截断句残留双冒号形态：与 fixTruncatedSentenceArtifacts 同源同口径。
 * 4.36 A3 结构类预检（11-14，修复轮 patch 不得破坏结构不变量 INV-1）：
 * 11. 防撞名后缀标题（与装配层 A1 剥离口径同正则）：「（数字/中文数字）」结尾的标题行不得进正文；
 * 12. 小节标题降级形态：H4 位置出现 X.Y 两段编号（H3 被降级强信号；H4 合法形态为 X.Y.Z 或纯文本）；
 * 13. 空节形态：连续标题堆叠 / 片段尾裸标题（前面有实质行）——「（一）标题后无内容」类空节根因；
 * 14. 对偶结构预检（original 可用时）：replacement 删除了原 H3 小节标题或将其降级为 H4/粗体。
 * observe 模式只计数（新规则灰度采集），enforce 模式拒绝；结构变更由确定性结构操作通道承担（宁缺不假）。
 */
export function deterministicDefectPrecheck(replacement: string, original?: string): string[] {
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
  // D-T5：表格数据格占位符与阻断层同源（豁免口径一致：合计行/规格类列「—」合法不判，
  // 否则修复轮按指令补「—」的合法 patch 会被误征）；片段含完整表块（表头+分隔线+数据行）时按
  // 表头语境判定，行级片段由各修复轮同源复检兜底
  if (placeholderHits.length > 0 || scanTablePlaceholderCells(replacement).length > 0) hits.push('占位符');
  if (TRUNCATED_SENTENCE_ARTIFACT_RES.some(re => re.test(replacement))) hits.push('截断句残留双冒号');
  // 11. 句读标点叠用/括号与书名号不闭合（拼接删节残留）：直接复用 punctuationArtifactIssues 同函数即同源
  if (punctuationArtifactIssues(replacement).length > 0) hits.push('句读标点叠用/括号不闭合');
  // 12-14. 结构类预检（与 A1/A2 结构不变量守护同层：装配拦截 + 链尾重放之外的修复轮入口守护）
  const nonEmptyLines = replacement.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const headingLines = nonEmptyLines.filter(line => /^#{2,6}\s+\S/u.test(line));
  const collisionSuffixed = headingLines.filter(line => /[（(]\s*(?:\d{1,3}|[一二三四五六七八九十]{1,3})\s*[）)]\s*$/u.test(line));
  if (collisionSuffixed.length > 0) hits.push(`防撞名后缀标题“${collisionSuffixed[0]}”`);
  const downgradedForm = headingLines.filter(line => /^####\s+\d+\.\d+(?!\.)\s+\S/u.test(line));
  if (downgradedForm.length > 0) hits.push(`小节标题降级形态“${downgradedForm[0]}”`);
  const stackedHeadings = nonEmptyLines.some((line, index) => index > 0 && /^#{2,6}\s+\S/u.test(line) && /^#{2,6}\s+\S/u.test(nonEmptyLines[index - 1]));
  if (stackedHeadings) hits.push('连续标题堆叠（空节风险）');
  if (nonEmptyLines.length > 1 && /^#{2,6}\s+\S/u.test(nonEmptyLines[nonEmptyLines.length - 1])) hits.push('尾部裸标题（空节风险）');
  if (original) {
    const h3Of = (text: string) => [...text.matchAll(/^###\s+(\S.*)$/gmu)].map(match => (match[1] || '').trim());
    const originalH3 = h3Of(original);
    const replacementH3 = h3Of(replacement);
    if (replacementH3.length < originalH3.length) {
      hits.push('删除小节标题');
    } else if (originalH3.length > 0) {
      const bareKey = (text: string) => text.replace(/^\d+(?:\.\d+)*\s+/u, '').trim();
      const replacementH3Keys = new Set(replacementH3.map(bareKey));
      const h4Keys = [...replacement.matchAll(/^#{4,6}\s+(.+)$/gmu)].map(match => bareKey(match[1] || ''));
      const boldKeys = [...replacement.matchAll(/^\*\*(.+)\*\*\s*$/gmu)].map(match => (match[1] || '').trim());
      const degraded = originalH3.map(bareKey).filter(key => key && !replacementH3Keys.has(key) && (h4Keys.includes(key) || boldKeys.includes(key)));
      if (degraded.length > 0) hits.push(`小节标题降级“${degraded[0]}”`);
    }
  }
  return hits;
}
