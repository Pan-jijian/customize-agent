import { isFillerPoolExcludedLine } from './tenderBidChecks';

/**
 * 叙述语境共享单源（C0 评分机制校准）：标题/表格/列表/引用/目录行不是叙述语境——
 * 密度型分量（事实落位/工艺参数）的 token 提取与词面型分量（评标响应）的响应判定
 * 必须建立在叙述句之上，罗列段（词表/参数堆叠）不构成专业内容证据。
 * 校准依据（r28l/s28l 离线复算）：参数叙述语境保留率 93.3%/96.5%——语境约束对真实成稿
 * 影响可控；无完整句的堆词文档（词表+参数串堆叠）在旧口径下专业分 87 分（事实落位/工艺参数/
 * 评标响应 100），语境约束后 token 池与响应判定归零。
 * 本模块为唯一权威：评分三端（tenderBidScoring 命中单元、documentProfessionalScore 四维、
 * 对抗套件）禁止各自内联叙述判定。
 */

/** 目录聚簇行（C0-1 标题党通道之二）：多章节/多编号条目堆叠且无句读——真实目录条目行特征。
 * r28l 实测「第一章 工程概况 1.1 编制说明与工程概况 1.2 …」类目录行曾作为独立判定位
 * 命中「编制专项施工方案」类查询（假阳性）。章节标记与编号条目合计 ≥3 即判目录聚簇行。 */
export function isTocClusterLine(line: string): boolean {
  const trimmed = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim();
  if (!trimmed || /[。！？]/u.test(trimmed)) return false;
  const chapterMarks = (trimmed.match(/第[一二三四五六七八九十百千\d]+[章节篇]/gu) || []).length;
  const numberedItems = (trimmed.match(/\d+(?:\.\d+)+/gu) || []).length;
  return chapterMarks + numberedItems >= 3;
}

/** 罗列串判定（C0-2 堆词通道）：逗号/顿号/空白分隔的子段数 ≥8 且平均子段长度 <8 字，
 * 属词表/参数堆叠（「C30，C25，C35，…」「工程概况 主要施工内容 重难点分析 …」），不构成叙述句。
 * 门槛校准（C0 实测）：6 段/10 字口径误伤「总则明确，应急组织机构…，应急演练按计划开展」类
 * 多短句叙述行（8 段均 9.1 字）；8 段/8 字口径下该类行保留、词表（10 段均 3.5 字）与参数串
 * （17 段均 4.7 字）仍稳定排除。 */
export function isListingText(text: string): boolean {
  const parts = text.split(/[，,、\s]+/u).map(part => part.trim()).filter(Boolean);
  if (parts.length < 8) return false;
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  return total / parts.length < 8;
}

/** 叙述行判定（单元级，与句池行级过滤同源）：非标题/表格/列表/引用/目录条目行/目录聚簇行、
 * 非罗列串（词表/参数堆叠行不构成实质正文）且 ≥12 字——评分判定单元的「实质正文」存在性条件 */
export function isNarrativeLine(line: string): boolean {
  const trimmed = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim();
  if (trimmed.length < 12) return false;
  if (isFillerPoolExcludedLine(trimmed)) return false;
  if (isTocClusterLine(trimmed)) return false;
  return !isListingText(trimmed);
}

/** 结构证据文本（complianceScore 危大两步/应急八部分词面型分量专用）：剥离 markdown 标题行、
 * 目录聚簇行与目录条目行（章节号/编号 + 标题、无句读）——空壳标题与目录行不得构成结构证据
 * （C0 基线：纯标题文档在旧口径下骗得应急覆盖率分数）；表格/列表/正文行保留（危大清单表、
 * 应急组织列表、专家论证记录是合法结构化载体），且不设切句长度门槛——短句是合法证据
 * （「基坑工程施工方案已编制。」类别词是全篇危大类别命中的唯一证据，切句 ≥12 字门槛会丢失）。 */
export function stripHeadingLines(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim())
    .filter(line => {
      if (!line) return false;
      if (/^#{1,6}\s+/u.test(line)) return false;
      if (isTocClusterLine(line)) return false;
      return !/^(?:第[一二三四五六七八九十百\d]+[章节篇]|\d+(?:\.\d+){0,3})\s+[^。；;，,]*$/u.test(line);
    })
    .join('\n');
}

/** 叙述句提取（C0-2 共享单源）：行级排除 + 句级「≥12 字、汉字 ≥8 且汉字占比 ≥0.15、非罗列串」 */
export function narrativeSentences(text: string): string[] {
  return text
    .split('\n')
    .filter(line => !isFillerPoolExcludedLine(line) && !isTocClusterLine(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 12)
    .filter(sentence => {
      const hanCount = (sentence.match(/[\u4e00-\u9fff]/gu) || []).length;
      const compactLength = sentence.replace(/\s+/gu, '').length;
      return hanCount >= 8 && hanCount / Math.max(1, compactLength) >= 0.15;
    })
    .filter(sentence => !isListingText(sentence));
}

/** 叙述字数（章级 gate / 篇幅归一用）：叙述句长度合计 */
export function narrativeCharCount(text: string): number {
  return narrativeSentences(text).reduce((sum, sentence) => sum + sentence.length, 0);
}

/** 叙述语境 token 提取（密度型分量专用）：仅从叙述句提取 pattern 命中的 token；
 * pattern 需带 g flag（QUANTIFIED_BODY_PARAM_RE 等权威口径常量直接传入）。 */
export function extractContextualTokens(text: string, pattern: RegExp): Set<string> {
  const tokens = new Set<string>();
  for (const sentence of narrativeSentences(text)) {
    for (const token of sentence.match(pattern) || []) tokens.add(token);
  }
  return tokens;
}

/** 承诺/响应语境判定（评标响应词面型分量专用）：「响应词 + 承诺语境」必须同句出现，
 * 词表堆叠行内出现响应词不构成响应。语境 = 量化数字（量化承诺）或响应动词；
 * 不含「负责」——防「项目负责人」岗位词误中（岗位词本身不是承诺语境）。 */
const COMMITMENT_CONTEXT_RE = /\d|确保|保证|杜绝|实行|采用|落实|建立|执行|达到|不低于|不少于|控制在|符合|按照|承诺/u;

export function sentenceHasCommitmentContext(sentence: string): boolean {
  return COMMITMENT_CONTEXT_RE.test(sentence);
}
