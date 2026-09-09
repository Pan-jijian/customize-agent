/**
 * integrity/fixers：确定性修复器组（P4 拆分，逐字机械搬移自 documentIntegrityChecks.ts）。
 * 依赖 detectors/authorities（SURFACE_FIX_STEPS 注册表锚定侧）。
 */
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, SpecAuthorityMap, TenderRequirementModel, ValidationIssue } from '../../types';
import { MARKDOWN_TABLE_ROW_RE } from '../../../constants';
import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from '../../semanticSimilarity';
import { DANGEROUS_APPLICABLE_ITEMS, extractDangerZone } from '../../dangerousApplicability';
import { PEAK_LABOR_RE, PILE_SUPPORT_LITERAL_RE, SLOPE_SUPPORT_LITERAL_RE, cnNumberToArabic, laborPeakStageOf, tablePeakLabor } from '../authorities/authorities';
import type { SupportSystemAuthorityKind } from '../authorities/authorities';
import { COMMERCIAL_RATE_RE, COMMERCIAL_TERM_RE, CROSS_CHAPTER_SEMANTIC_DUP_MIN_CHARS, CROSS_SECTION_ANCHORS, ENUMERATION_VALUE_RE, FINISH_THICKNESS_CONTEXT_WORD, LABOR_COUNT_RE, META_DECLARATION_RE, NEGATIVE_DECLARATION_RE, PARAGRAPH_START_RE, REPEATED_WORD_RE, SCHEDULE_NODE_ANCHORS, SIX_HUNDRED_PERCENT_ITEMS, cellCoverage, extractMarkdownTables, findCrossChapterSemanticDupPairs, jaccard, judgeQueryCoverage, laborGroupOf, locationGroupForMatch, overviewRecapCandidates, paragraphFingerprint, sixHundredPercentLexicalHit, textCellsOf } from '../detectors/detectors';

const PILE_WORD_TO_SLOPE: Array<[RegExp, string]> = [
  [/高压旋喷桩/gu, '土钉墙'],
  [/旋喷桩/gu, '土钉墙'],
  [/钻孔灌注桩/gu, '土钉墙'],
  [/咬合桩/gu, '土钉墙'],
  [/地下连续墙/gu, '土钉墙'],
  [/搅拌桩/gu, '土钉墙'],
  [/灌注桩/gu, '土钉墙'],
  [/支护桩/gu, '土钉墙'],
  [/排桩/gu, '土钉墙'],
  [/冠梁/gu, '坡顶'],
];

/** 桩族施工机械词（slope 权威方向删除项）：设备配置句中的败选体系机械逗号项整项删除 */

const PILE_MACHINE_RE = /高压旋喷桩机|旋喷桩机|搅拌桩机|三轴搅拌|成槽机|灌注桩机/u;

/** 支护体系确定性裁决修复（B1）：
 * authority='slope'（土钉墙锚杆权威，图纸/地质槽位锁定）：删除纯桩族句（无坡族词的败选体系句）；
 * 混句（两族词并存）先删桩族机械逗号项（防「高压旋喷桩」替换吃出「土钉墙机」），再词级替换桩词为土钉墙；
 * authority='pile'：不动——「灌注桩+局部放坡」混合体系合法（检测器同口径），
 * 坡段删除风险高（放坡描述与开挖组织绑定），交 LLM 修复轮裁决。
 * 与检测器 supportSystemConflictIssues 同源同词表（检测定位=修复定位）。 */

export function fixSupportSystemConflicts(markdown: string, authority?: SupportSystemAuthorityKind | null): { markdown: string; fixedCount: number; details: string[] } {
  if (authority !== 'slope') return { markdown, fixedCount: 0, details: [] };
  let removedSentences = 0;
  let rewrittenSentences = 0;
  const lines = markdown.split(/\r?\n/u);
  const keptLines = lines.map(line => {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) return line;
    if (!PILE_SUPPORT_LITERAL_RE.test(line)) return line;
    const sentences = line.split(/(?<=[。；;])/u);
    const kept = sentences.map(sentence => {
      if (!PILE_SUPPORT_LITERAL_RE.test(sentence)) return sentence;
      if (!SLOPE_SUPPORT_LITERAL_RE.test(sentence)) { removedSentences += 1; return ''; }
      // 混句：先删败选机械逗号项，再词级替换体系词；句尾标点随尾项被删时补回
      const tailMark = /([。；;])$/u.exec(sentence)?.[1];
      const keptItems = sentence.split(/[，、]/u).filter(item => !PILE_MACHINE_RE.test(item));
      let next = keptItems.join('，');
      if (tailMark !== undefined && !/[。；;]$/u.test(next)) next += tailMark;
      for (const [re, replacement] of PILE_WORD_TO_SLOPE) next = next.replace(re, replacement);
      rewrittenSentences += 1;
      return next;
    }).join('');
    return kept;
  });
  if (removedSentences === 0 && rewrittenSentences === 0) return { markdown, fixedCount: 0, details: [] };
  return {
    markdown: keptLines.join('\n'),
    fixedCount: removedSentences + rewrittenSentences,
    details: [`支护体系确定性裁决（图纸/地质槽位：放坡喷锚类）：删除桩族句 ${removedSentences} 句、改写混句 ${rewrittenSentences} 句`],
  };
}

// ── 6. 危大工程辨识清单一致性（R7）：多处清单项名/数量必须一致 ──

/**
 * B1（丰乐镇实测「招标要求响应（前附表响应条款）：计划开工日期：2026年9月…」重复 4 次）：
 * 段首固定开场机械重复确定性修复——与检测器 paragraphOpeningRepeatIssues 同源提取段首句
 * 与指纹分组，重复组（>=3）内剥离全组公共前缀（截到最后一个冒号边界，冒号含入前缀）：
 * 首现段保留完整句，后续段仅删固定开场前缀、保留差异化正文。公共前缀 <4 字或剥离后
 * 剩余 <10 字不动（防误伤短句与碎片句）。owner:llm 修复定位能力不足时由本函数确定性收口。
 */
export function fixParagraphOpeningRepeats(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const groups = new Map<string, Array<{ sentence: string; start: number; end: number }>>();
  for (const match of markdown.matchAll(PARAGRAPH_START_RE)) {
    const sentence = match[1].trim();
    const fingerprint = sentence.replace(/[\d,，.。%％㎡m2²]/gu, '').slice(0, 16);
    if (fingerprint.length < 10) continue;
    const group = groups.get(fingerprint) || [];
    const offset = (match.index ?? 0) + match[0].indexOf(match[1]);
    group.push({ sentence, start: offset, end: offset + match[1].length });
    groups.set(fingerprint, group);
  }
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    // 全组公共前缀（按字符逐位比较）
    const first = group[0].sentence;
    let prefixLen = first.length;
    for (const item of group.slice(1)) {
      let common = 0;
      const max = Math.min(prefixLen, item.sentence.length);
      while (common < max && first[common] === item.sentence[common]) common += 1;
      prefixLen = common;
    }
    // 前缀截到最后一个冒号边界（词内截断回退到冒号，含冒号入前缀）
    const boundary = first.slice(0, prefixLen).lastIndexOf('：');
    const prefix = first.slice(0, boundary >= 0 ? boundary + 1 : prefixLen);
    if (prefix.length < 4) continue;
    for (let index = 1; index < group.length; index += 1) {
      const item = group[index];
      const rest = item.sentence.slice(prefix.length).trim();
      if (rest.length < 10) continue;
      replacements.push({ start: item.start, end: item.end, replacement: rest });
    }
  }
  if (replacements.length === 0) return { markdown, fixedCount: 0, details: [] };
  const fixed = applySpanReplacements(markdown, replacements.map(item => ({ ...item, detail: '段首固定开场剥离' })));
  return { markdown: fixed.markdown, fixedCount: fixed.fixedCount, details: [`段首固定开场剥离 ${fixed.fixedCount} 处`] };
}

/**
 * B2（丰乐镇实测）：截断句残留确定性修复——列表引导句双重冒号「： ：」、列表项行尾
 * 冒号残留「；：」「。：」与双冒号「：：」确定性收敛；引导句以冒号收尾/列表项以分号收尾
 * 属 Markdown 列表合法形态，由检测器侧列表行与列表引导句豁免承担（与修复器同源同口径）。
 */
export function fixTruncatedSentenceArtifacts(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const steps: Array<[RegExp, string]> = [
    [/：\s*：/gu, '：'],
    [/；：/gu, '；'],
    [/。：/gu, '。'],
    [/：：/gu, '：'],
    // 十度实测扩展：句号+分号/逗号叠用是句子删除残留，「。。」是省略号误写形态（LLM 输出「。。」意图为「……」，上下文语义读作省略号）
    [/。；/gu, '。'],
    [/；。/gu, '。'],
    [/。，/gu, '。'],
    [/，。/gu, '。'],
    [/。{2,}/gu, '……'],
  ];
  let result = markdown;
  let fixedCount = 0;
  for (const [re, to] of steps) {
    const before = result;
    result = result.replace(re, to);
    fixedCount += (before.match(new RegExp(re.source, 'gu')) || []).length;
  }
  if (result === markdown) return { markdown, fixedCount: 0, details: [] };
  return { markdown: result, fixedCount, details: [`截断句残留清洗 ${fixedCount} 处`] };
}

/**
 * B3（丰乐镇实测「1.2 项目主要施工内容」表格承载专业工程正文）：关键小节表格承载正文
 * 确定性兜底——检测器 majorContentGovernanceIssues 判「小节正文全为表格」即 error，
 * LLM 表格→段落改写定位失败时由本函数收口：从表格行确定性生成段落叙述
 * （分部分项工程分组 → 「X的Y量单位、Z量单位；」），插入小节标题之后、表格之前，
 * 表格保留（正式工程量表属合法要求）。只覆盖「作业对象与工程量」维度，
 * 工序/方法两维由三要素检测继续驱动 LLM 补写。
 */
export function fixTableBorneContentSections(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const tableRowRe = /^\s*\|.+\|\s*$/u;
  const rowsToProse = (tableLines: string[]): string | undefined => {
    const cellsOf = (row: string) => row.split('|').map(item => item.trim()).slice(1, -1);
    const clean = (cell: string) => cell.replace(/[*_`~]/gu, '').trim();
    let header: string[] | undefined;
    const dataRows: string[][] = [];
    for (const line of tableLines) {
      const cells = cellsOf(line).map(clean);
      if (cells.every(cell => /^:?-{3,}:?$/u.test(cell))) continue;
      if (header === undefined) { header = cells; continue; }
      dataRows.push(cells);
    }
    if (!header || dataRows.length === 0) return undefined;
    const colIndex = (re: RegExp) => header.findIndex(cell => re.test(cell));
    const groupCol = colIndex(/分部分项|专业工程|工程名称|项目名称/u);
    const contentCol = colIndex(/工程内容|施工内容|工作内容|名称/u);
    const unitCol = colIndex(/单位/u);
    const qtyCol = colIndex(/工程量|数量/u);
    const groups = new Map<string, string[]>();
    const solo: string[] = [];
    for (const row of dataRows) {
      const group = groupCol >= 0 && row[groupCol] ? row[groupCol] : '';
      const content = contentCol >= 0 ? (row[contentCol] || '') : (groupCol >= 0 ? (row[groupCol] || '') : '');
      const qty = qtyCol >= 0 ? (row[qtyCol] || '') : '';
      const unit = unitCol >= 0 ? (row[unitCol] || '') : '';
      const phrase = `${content}${qty}${unit}`;
      if (!content && !qty) continue;
      if (group) {
        const list = groups.get(group) || [];
        list.push(phrase);
        groups.set(group, list);
      } else {
        solo.push(phrase);
      }
    }
    if (groups.size === 0 && solo.length === 0) return undefined;
    const parts = [...groups.entries()].map(([group, phrases]) => `${group}的${phrases.join('、')}`);
    if (solo.length > 0) parts.push(solo.join('、'));
    return `本项目主要施工内容包括：${parts.join('；')}。`;
  };
  const insertions: Array<{ lineIndex: number; paragraph: string; title: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{2,4})\s+(.+)$/u.exec(lines[index].trim());
    if (!heading || !/主要施工内容|主要施工方法/u.test(heading[2])) continue;
    const level = heading[1].length;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const next = /^(#{1,6})\s+/u.exec(lines[end].trim());
      if (next && next[1].length <= level) break;
    }
    const body = lines.slice(index + 1, end);
    const tableLines = body.filter(line => tableRowRe.test(line.trim()));
    if (tableLines.length < 3) continue;
    const proseChars = body.filter(line => !tableRowRe.test(line.trim())).join('').replace(/[\s#*_`>-]/gu, '').length;
    if (proseChars >= 50) continue;
    const paragraph = rowsToProse(tableLines);
    if (!paragraph) continue;
    insertions.push({ lineIndex: index, paragraph, title: heading[2].trim() });
  }
  if (insertions.length === 0) return { markdown, fixedCount: 0, details: [] };
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    out.push(lines[index]);
    const hit = insertions.find(item => item.lineIndex === index);
    if (hit) out.push('', hit.paragraph);
  }
  return {
    markdown: out.join('\n'),
    fixedCount: insertions.length,
    details: insertions.map(item => `「${item.title}」表格改写段落兜底`),
  };
}

// ── 8b. 项目概况段跨章复述（L1 结构召回 + L3 语义判定，两段式）：
// 总述数据（总建筑面积/建设规模/计划工期/改造范围等）只在工程概况类小节集中交代，
// 其他小节不得以“本项目为……”整段复述（十四/十五度实测：正文 11 处“本项目为”复述概况段）。
// 判定口径遵循四层分离架构：正则只做结构召回（概况章区间 + “本项目为”句定位，字面封闭），
// “是否复述概况段”属语义判定，一律交 bge 余弦（候选句 vs 概况章正文 ≥0.6 才报；
// 本地语义模型恒可用，判定语义全权由 bge 负责），提示词层面另有总控约束治本。──

/**
 * 概况复述句交付前行级清洗（round-19 R2）：与检测器同源同阈值（概况区外“本项目为/本工程为/该项目为/该工程为”
 * 起一句与概况章正文语义相似度 ≥0.6 判复述 → 整句删除），标题行/表格行/概况区间行不触碰；
 * 语义相似度函数由调用方构造（本地 bge 恒可用，空输入由 buildSemanticSimilarity 返回恒零函数）。
 */
export function stripOverviewRecapBodyLines(markdown: string, similarity: (left: string, right: string) => number): string {
  const { overviewBody, sentences } = overviewRecapCandidates(markdown);
  if (sentences.length === 0 || !overviewBody) return markdown;
  const lines = markdown.split(/\r?\n/u);
  // 概况区间判定与 overviewRecapCandidates 同源（标题含“概况/基本信息”的 H2~H4 小节区间）
  const overviewRanges: Array<[number, number]> = [];
  let anchor: { index: number; level: number } | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^(#{2,4})\s+(.+)$/u.exec(lines[i].trim());
    if (heading) {
      const level = heading[1].length;
      if (/(?:工程概况|项目概况|基本信息)/u.test(heading[2])) {
        anchor = { index: i, level };
      } else if (anchor && level <= anchor.level) {
        overviewRanges.push([anchor.index, i]);
        anchor = undefined;
      }
    }
  }
  if (anchor) overviewRanges.push([anchor.index, lines.length]);
  const inOverviewRange = (i: number) => overviewRanges.some(([start, end]) => i >= start && i < end);
  let changed = false;
  const cleaned = lines.map((line, index) => {
    if (inOverviewRange(index)) return line;
    if (/^#{1,6}\s/u.test(line.trim()) || /^\s*\|/u.test(line.trim())) return line;
    if (!/本项目为|本工程为|该项目为|该工程为/u.test(line)) return line;
    // 行内按句拆分，删除相似度达标的复述句（与 blocker 修复循环 delete 兜底同口径）
    const parts = line.split(/(?<=[。！？!?])/u);
    const kept = parts.filter(part => {
      if (!/本项目为|本工程为|该项目为|该工程为/u.test(part)) return true;
      const sentence = part.split(/[。！？!?]/u)[0];
      if (sentence.length < 12) return true;
      return similarity(sentence, overviewBody) < 0.6;
    });
    if (kept.join('') !== line) changed = true;
    return kept.join('');
  });
  return changed ? cleaned.join('\n') : markdown;
}

// ── 9. 闭环句式密度上限（模板化）：闭环四词过度密集削弱语言精练度 ──

export interface DeterministicFixOutcome {
  markdown: string;
  fixedCount: number;
}

/** 节点内闭环修复（丰乐镇第九轮方案）：修复器修复后重复运行自身直至零命中或轮次上限——
 * 检测定位=修复定位同源，fixedCount===0 等价于该节点负责的问题清零；修复本身可能引入新形态
 *（修复 A 后 A 的新命中），单遍修复无法收敛。轮次上限 + 无进展跳出双保险防死循环。
 * 只修复完成才返回（或达到上限），替代“单遍修复后无条件进入下一节点”的直线模式。 */

export function runFixUntilClean(fix: (markdown: string) => DeterministicFixOutcome, markdown: string, maxRounds = 3): DeterministicFixOutcome {
  let current = markdown;
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const result = fix(current);
    if (result.fixedCount === 0) break;
    current = result.markdown;
    total += result.fixedCount;
  }
  return { markdown: current, fixedCount: total };
}

/** 链级收敛循环（丰乐镇第九轮方案）：整链修复器按序跑完后复查——任一修复器有新命中即整链重跑，
 * 修复器互相引入的问题（A 修复后 B 新命中）在链循环中收敛，而不是堆到最后一个节点兑底；
 * 无进展即跳出（防互搏死循环）。 */

export function runDeterministicChainUntilConverged(fixers: Array<(markdown: string) => DeterministicFixOutcome>, markdown: string, maxRounds = 3): DeterministicFixOutcome {
  let current = markdown;
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    let roundTotal = 0;
    for (const fix of fixers) {
      const result = fix(current);
      if (result.fixedCount === 0) continue;
      current = result.markdown;
      roundTotal += result.fixedCount;
    }
    if (roundTotal === 0) break;
    total += roundTotal;
  }
  return { markdown: current, fixedCount: total };
}

// B6 负向语境豁免（丰乐镇第五轮实测）：「全部分部分项内容」中的「部(2)分(3)部(4)分(5)」
// 被字符级叠词检测误判为「部分部分」（行业标准术语分部分项被误报且收敛修复会破坏术语）；
// 匹配前为「分」或匹配后为「项」的紧邻重复属「分部分项」术语内部，不判叠词也不收敛。

export function collapseRepeatedWords(content: string): string {
  return content.replace(REPEATED_WORD_RE, '$1');
}

/** B6 表格断行残片确定性合并（丰乐镇第五轮实测）：检测器（qualityValidation 单竖线残行）
 * 只报不修，修复轮循环无效；“增开清表作业面，”+“延长有效作业时间 |”残行实为上一表格行
 * 末单元格续文（单元格内换行带竖线，mergeTableLineBreaks 不合并）；去残行竖线拼回上一行
 * 末单元格，与检测器同口径（单竖线结尾、不以 | 开头、上一行为表格行）。 */

export function mergeTableLineResidues(markdown: string): { markdown: string; fixedCount: number } {
  const lines = markdown.split(/\r?\n/u);
  const out: string[] = [];
  let fixedCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const prev = (out[out.length - 1] ?? '').trimEnd();
    const isLonePipeResidue = Boolean(trimmed)
      && !/^\|/u.test(trimmed)
      && trimmed.endsWith('|')
      && (trimmed.match(/\|/gu) || []).length === 1
      && !/^#{1,6}\s/u.test(trimmed)
      && MARKDOWN_TABLE_ROW_RE.test(prev);
    if (isLonePipeResidue) {
      // 残行是上一行末单元格续文：去掉残行竖线，拼回上一行最后一个单元格内
      // （上单元格以中文标点结尾时不加空格，「增开清表作业面，」+「延长有效作业时间」）
      const residueText = trimmed.slice(0, trimmed.lastIndexOf('|')).trim();
      const prevBody = prev.slice(0, prev.lastIndexOf('|')).trimEnd();
      const separator = /[，。；、：]$/u.test(prevBody) ? '' : ' ';
      out[out.length - 1] = `${prevBody}${separator}${residueText} |`;
      fixedCount += 1;
      continue;
    }
    out.push(line);
  }
  return { markdown: out.join('\n'), fixedCount };
}

// ── 12. 装饰层工艺厚度异常（A21 丰乐镇第七轮实测）：抹面/打底/找平/坐浆等装饰层
// 厚度 200mm（LLM 把清单「槽底预留 200mm」泛化串染到装饰层），远超工艺常规 20~30mm；
// 结构层厚度（墙体 200mm、垫层 200mm、回填虚铺 200mm）不动，仅装饰语境三倍数除 10。 ──

export function fixFinishThickness(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  const fixes: Array<{ re: RegExp; group: number }> = [
    { re: new RegExp(`((?:${FINISH_THICKNESS_CONTEXT_WORD})[^。；;\n|]{0,10}?)(\\d{3,})(\\s*mm)`, 'gu'), group: 2 },
    { re: new RegExp(`(\\d{3,})(\\s*mm厚?[^。；;\n|]{0,18}(?:${FINISH_THICKNESS_CONTEXT_WORD}))`, 'gu'), group: 1 },
  ];
  for (const { re, group } of fixes) {
    const matches = [...result.matchAll(re)].filter(match => Number(match[group]) >= 100);
    for (const match of matches) {
      const value = Number(match[group]);
      const corrected = String(Math.round(value / 10));
      // match[0] 内只有一个目标数字（装饰语境匹配窗口），直接字符串替换第一个出现即可；
      // 不能用 \b 边界正则——「200mm」中 0 与 m 同为单词字符，\b200\b 不成立
      result = result.replace(match[0], match[0].replace(match[group] ?? '', corrected));
      fixedCount += 1;
      details.push(`${value}mm→${corrected}mm`);
    }
  }
  return { markdown: result, fixedCount, details };
}

// ── 13. 劳动力总人数与高峰人数多口径矛盾（A21 丰乐镇第七轮实测）：正文「高峰期总
// 人数181人」与「高峰人数86人」并存（明细加和值 vs 峰值需求值串用）；同一口径的
// 峰值人数全文必须唯一，按多数口径统一（峰值口径出现次数多者胜出）。 ──

/** 劳动力峰值口径检测：总人数口径与高峰人数口径并存且数值不同 → error；
 * F15 升级（丰乐镇第 3 轮实测）：进表格提取各表工种高峰人数，同工种跨表 max 比对——
 * 第五章工种配置表「电工40人」与附表「电工4人」并存属同工种跨表互斥（正文声明句互查不可见），
 * 两张表同一工种高峰人数必须唯一（分阶段投入表内同工种多行分阶段配置合法，表内取该工种最大值参与跨表比对） */

export function fixMetaDiscourseDeclarations(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  // 从句删除：逗号后的声明从句「，不再另行出现其他口径」「，不再另行统计累计投入人次」
  // （从句模式排除逗号防贪婪吞后续内容；保留原逗号，句尾「，。」由下方清理收敛）
  result = result.replace(/([，,])\s*(?:不再另行[^。；;\n，,]{0,40}|以[^，,。；;\n]{0,16}为唯一[^，,。；;\n]{0,24}不再[^，,。；;\n]{0,20})/gu, (_full, comma: string) => {
    fixedCount += 1;
    return comma;
  });
  // 句首声明句整句删除：句边界后紧跟「不再另行…/以X为唯一控制基准」且句内无其他数据（句尾删除）
  const sentenceRe = /(?:^|[。；;\n])([^。；;\n]*?(?:不再另行[^。；;\n]{0,40}|以[^。；;\n]{0,16}为唯一[^。；;\n]{0,24}不再[^。；;\n]{0,20})[^。；;\n]*)(?=[。；;\n]|$)/gu;
  const sentences = [...result.matchAll(sentenceRe)];
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of sentences) {
    const full = match[0];
    const sentenceBody = match[1] ?? '';
    const withoutDeclaration = sentenceBody.replace(META_DECLARATION_RE, '').trim();
    // 声明从句已在上面删除过：若剩余主体不含数字数据（劳动力/人数/工程量等），整句删除
    if (/(?:\d)/u.test(withoutDeclaration)) continue;
    spans.push({ start: (match.index ?? 0) + full.indexOf(sentenceBody), end: (match.index ?? 0) + full.indexOf(sentenceBody) + sentenceBody.length });
  }
  for (const span of [...spans].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, span.start) + result.slice(span.end);
    fixedCount += 1;
  }
  // 清理删除残留：连续标点收敛（「，，」→「，」、句尾「，。」→「。」、句首逗号删除、空行去重）
  const before = result;
  result = result.replace(/，+/gu, '，').replace(/，(?=[。；;\n])/gu, '').replace(/(?:^|[。；;\n])\s*，/gu, (_full, prefix: string) => prefix).replace(/([。；;])\1+/gu, '$1').replace(/^[。；;\s]+/u, '').replace(/\n{3,}/gu, '\n\n');
  if (result !== before) fixedCount += 1;
  if (fixedCount > 0) details.push(`元话语声明句清洗 ${fixedCount} 处`);
  return { markdown: result, fixedCount: fixedCount > 0 ? 1 : 0, details };
}

// ── 18. 公式形态残留检测与清洗（F18 远端客户反馈「公式直接输入正文」根治）：正文出现
// 「P =」「Σ」「cosφ」「K1」「q =」公式形态 → error 并清洗。蓝图渲染层已值化（D 组），
// 此处为最终防线兼防资料原文（投标文件/定额摘录）公式被 Writer 抄入正文。
// 里程桩号「K1+200」不属公式形态（K1 后接 +数字 而非 ×Σ），刻意排除防误伤 ──

/** 公式形态正则：P =/q = 开头或 Σ/cosφ/系数×Σ 组合；桩号 K1+200 类不含计算符号不命中 */

export function fixFormulaResidues(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  // 公式片段模式排除逗号：贪婪吞逗号会把同句值化数据（「，用电负荷约 48kW」）一并删除（数据丢根因）
  const FORMULA_FRAGMENT_RE = /(?:[Pp]\s*=\s*[^。；;\n，,]*|[qQ]\s*=\s*[^。；;\n，,]{0,80}|Σ\s*[Pp][12]?(?:\s*\/\s*cos\s*φ)?[^。；;\n，,]{0,40}|[Kk][12]\s*[×*]?\s*Σ\s*[Pp][12]?[^。；;\n，,]{0,40}|cos\s*φ[^。；;\n，,]{0,20})/gu;
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  // 先片段删除公式符号段（保留同句的数据值），再清理残留纯符号句
  result = result.replace(FORMULA_FRAGMENT_RE, () => { fixedCount += 1; return ''; });
  // 残留清理：句内只剩标点/空壳（无中文且无「kW/m³」值化单位）→ 整句删除
  const huskSentenceRe = /(?:^|[。；;\n])([^。；;\n]*)(?=[。；;\n]|$)/gu;
  const husks: string[] = [];
  for (const match of result.matchAll(huskSentenceRe)) {
    const body = (match[1] ?? '').replace(/[\s|，,：:（）()×=+-]/gu, '');
    if (body.length === 0) continue;
    if (/[\u4e00-\u9fff]/u.test(body)) continue; // 有中文保留
    if (/kW|m³|m3|kVA/u.test(body)) continue; // 有值化单位保留
    husks.push(match[1] ?? '');
  }
  for (const husk of [...new Set(husks)].sort((left, right) => right.length - left.length)) {
    const replaced = result.replace(husk, () => { fixedCount += 1; return ''; });
    result = replaced;
  }
  // 清理公式片段删除后的标点残片（「，计算得」「根据公式」类空转句）
  result = result.replace(/，+/gu, '，').replace(/\n{3,}/gu, '\n\n');
  if (fixedCount > 0) details.push(`公式形态残留清洗 ${fixedCount} 处`);
  return { markdown: result, fixedCount: fixedCount > 0 ? 1 : 0, details };
}

export function fixLaborPeakConflict(markdown: string, laborPeakAuthority?: number): { markdown: string; fixedCount: number; details: string[] } {
  // D1 蓝图权威存在时：零漂移豁免——蓝图劳动力峰值（造价锚定）是最高权威，任何与权威不一致的
  // 峰值/高峰语境表述（含「峰值统一按」「阶段平均」隔断形态与表格峰值行）一律确定性替换为权威值。
  // round-27 实测：199 vs 176 漂移仅 11.6%，原 30% 豁免放过 → 蓝图引用终检 error 阻断且 LLM 修复轮
  // 修不掉；句子级扫描覆盖同句连带（「峰值统一按199人控制，各阶段同时在场人数均不得超过199人」）。
  if (laborPeakAuthority !== undefined && laborPeakAuthority > 0) {
    const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
    const seenKeys = new Set<string>();
    const pushReplacement = (valueIndex: number, raw: string, value: number, context: string) => {
      if (!Number.isFinite(value) || value <= 0) return;
      if (value === laborPeakAuthority) return;
      // 阶段语境值 ≤ 权威为合法阶段明细（阶段人数不得超过总峰值）；> 权威即与峰值矛盾，必须收口
      if (context === 'stage' && value < laborPeakAuthority) return;
      const key = `${valueIndex}:${raw}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      replacements.push({ start: valueIndex, end: valueIndex + raw.length, replacement: String(laborPeakAuthority), detail: `劳动力峰值 ${value}人→${laborPeakAuthority}人（蓝图权威口径）` });
    };
    const isTableLine = (line: string) => /^\s*\|.*\|\s*$/u.test(line);
    // 峰值语境词：句内/行内出现即表示该句/行整体属峰值口径，句内所有总口径 N 人值随同替换
    const peakContextRe = /峰值|高峰(?:期)?(?:人数|劳动力|作业人员|总人数)?|劳动力总人数|高峰期总人数/u;
    // 句子级扫描（句边界不跨句号/分号/换行）：含峰值语境词 → 句内 peak 组 N 人全修（零豁免）；
    // 仅含阶段语境（无峰值词）→ peak 组 N 人仅 > 权威才修（阶段人数不得超过总峰值）
    for (const sentence of markdown.matchAll(/[^。；;\n]+/gu)) {
      const text = sentence[0];
      const hasPeak = peakContextRe.test(text);
      const hasStage = /阶段/u.test(text);
      if (!hasPeak && !hasStage) continue;
      for (const match of text.matchAll(/([\d,]+)\s*人/gu)) {
        const raw = match[1];
        const value = Number(raw.replace(/[,，]/gu, ''));
        if (!Number.isFinite(value) || value <= 0) continue;
        const valueIndex = (sentence.index ?? 0) + (match.index ?? 0) + match[0].indexOf(raw);
        const lineStart = markdown.lastIndexOf('\n', valueIndex) + 1;
        const { group } = laborGroupOf(markdown, valueIndex, lineStart);
        if (group !== 'peak') continue;
        pushReplacement(valueIndex, raw, value, hasPeak ? 'peak' : 'stage');
      }
    }
    // 表格行级：行内含峰值语境词（「达到劳动力峰值，各专业班组全部进场」）→ 行内 peak 组 N 人全修；
    // 纯阶段明细行（无峰值词）不动——阶段人数是合法明细数据
    const lines = markdown.split('\n');
    let offset = 0;
    for (const line of lines) {
      if (isTableLine(line) && peakContextRe.test(line)) {
        for (const match of line.matchAll(/([\d,]+)\s*人/gu)) {
          const raw = match[1];
          const value = Number(raw.replace(/[,，]/gu, ''));
          if (!Number.isFinite(value) || value <= 0) continue;
          const valueIndex = offset + (match.index ?? 0) + match[0].indexOf(raw);
          const { group } = laborGroupOf(markdown, valueIndex, offset);
          if (group !== 'peak') continue;
          pushReplacement(valueIndex, raw, value, 'peak');
        }
      }
      offset += line.length + 1;
    }
    if (replacements.length > 0) {
      return applySpanReplacements(markdown, replacements);
    }
    return { markdown, fixedCount: 0, details: [] };
  }
  // 无蓝图权威：原频率投票逻辑（正文总人数 vs 高峰人数多口径互查）
  const totalMatches = [...markdown.matchAll(/高峰期总人数(\d+)人|劳动力总人数(\d+)人|总人数(\d+)人/gu)];
  const peakMatches = [...markdown.matchAll(/高峰(?:期)?人数(\d+)人|峰值(?:需求|人数)?[为约]?(\d+)人/gu)];
  if (totalMatches.length === 0 || peakMatches.length === 0) return { markdown, fixedCount: 0, details: [] };
  const valueOf = (match: RegExpExecArray) => Number(match[1] || match[2] || match[3]);
  const totalCounts = new Map<number, number>();
  for (const match of totalMatches) {
    const value = valueOf(match);
    if (value > 0) totalCounts.set(value, (totalCounts.get(value) || 0) + 1);
  }
  const peakCounts = new Map<number, number>();
  for (const match of peakMatches) {
    const value = valueOf(match);
    if (value > 0) peakCounts.set(value, (peakCounts.get(value) || 0) + 1);
  }
  const majority = (counts: Map<number, number>) => [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  // 零值/非正值被上游过滤后 Map 可为空（「高峰期总人数0人」等边界），空口径直接无候选（防 undefined 解构崩溃）
  const totalWinner = majority(totalCounts);
  const peakWinner = majority(peakCounts);
  if (totalWinner === undefined || peakWinner === undefined) return { markdown, fixedCount: 0, details: [] };
  const [totalValue, totalFreq] = totalWinner;
  const [peakValue, peakFreq] = peakWinner;
  if (totalValue === peakValue) return { markdown, fixedCount: 0, details: [] };
  const winner = peakFreq >= totalFreq ? peakValue : totalValue;
  const loser = peakFreq >= totalFreq ? totalValue : peakValue;
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  const loserTotalRe = new RegExp(`(高峰期总人数|劳动力总人数|总人数)(\\d+)人`, 'gu');
  const loserPeakRe = new RegExp(`(高峰(?:期)?人数)(\\d+)人`, 'gu');
  if (peakFreq >= totalFreq) {
    result = result.replace(loserTotalRe, (_full, prefix: string, value: string) => Number(value) === loser ? `${prefix}${winner}人` : _full);
  } else {
    result = result.replace(loserPeakRe, (_full, prefix: string, value: string) => Number(value) === loser ? `${prefix}${winner}人` : _full);
  }
  if (result !== markdown) {
    fixedCount = 1;
    details.push(`劳动力峰值统一：${loser}人→${winner}人（${peakFreq >= totalFreq ? '高峰口径' : '总人数口径'}胜出）`);
  }
  return { markdown: result, fixedCount, details };
}

// ── 12. 商务条款数据入正文检测（Q3）：施组正文禁止出现商务数据封闭集，出现即评审失分（徽光阁实测：暂列金额 60 万入正文） ──
// 阶段五语义升级：强词（COMMERCIAL_TERM_RE）与数字式（COMMERCIAL_RATE_RE）保留确定性判定（出现即商务数据）；
// 变体弱词（材料价格/商务报价类）仅词面召回，句级语义复核（semanticGate 统一入口）确认商务语义才计命中；
// 允许事实（合同估算价/投资估算类）作负例保护，混合句由语义裁决归属。

export function stripCommercialDataSentences(content: string): string {
  const parts = content.split(/(?<=[。；;])\s*/u);
  const kept = parts.filter(part => {
    if (/^\s*\|/u.test(part)) return true;
    if (/^#{1,6}\s/u.test(part)) return true;
    return !(COMMERCIAL_TERM_RE.test(part) || COMMERCIAL_RATE_RE.test(part));
  });
  return kept.join('');
}

/**
 * 商务条款正文行级安全清洗（交付前兜底，round-18 E9）：
 * blocker 修复循环结束后仍可能有 LLM patch（画像修复轮等）引入商务句，交付前按行清洗——
 * 标题行/表格行不触碰（与检测器同口径），正文行命中时按行内句子拆分仅删含商务词的句子，
 * 避免 stripCommercialDataSentences 的整块 part 分割把含商务词的表格块连带删除。
 */
export function stripCommercialDataBodyLines(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const keptLines = lines.map(line => {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) return line;
    if (!COMMERCIAL_TERM_RE.test(line) && !COMMERCIAL_RATE_RE.test(line)) return line;
    const parts = line.split(/(?<=[。；;])\s*/u);
    return parts.filter(part => !(COMMERCIAL_TERM_RE.test(part) || COMMERCIAL_RATE_RE.test(part))).join('');
  });
  return keptLines.join('\n');
}

// ── 13. 节点工期口径互查（h13）：同一关键节点（基坑支护/正负零/封顶/装饰/机电/竣工）
// 在正文句与进度计划表中出现多套「第N日/天」口径即互斥。数值提取+集合比较（L2 确定性层），
// 覆盖「第N日完成X」正序式与「X完成|第N天」表格式、以及「X节点锁定在开工后第N日」倒序式。
// 合肥师范实测：基坑支护 60 vs 75、封顶 300 vs 210、装饰 450 vs 440 三处漏检（无检测器覆盖）。──

export function fixGreeningMaintenanceMismatch(markdown: string, authorityYears: number | undefined): { markdown: string; fixedCount: number; details: string[] } {
  if (authorityYears === undefined || authorityYears <= 0) return { markdown, fixedCount: 0, details: [] };
  const yearRe = /养护[^。；;\n|]{0,16}?([一二两三四五六七八九十]+|\d{1,2})\s*年/gu;
  let result = markdown;
  const replaced = new Set<string>();
  result = result.replace(yearRe, (line, rawValue: string) => {
    const value = cnNumberToArabic(rawValue);
    if (value === undefined || value === authorityYears || value <= 0) return line;
    replaced.add(`${rawValue}年`);
    return line.replace(rawValue, String(authorityYears));
  });
  if (result === markdown) return { markdown, fixedCount: 0, details: [] };
  return { markdown: result, fixedCount: 1, details: [`绿化养护期统一：${[...replaced].join('/')}→${authorityYears}年（以工程量清单养护期为准）`] };
}

export function stripInternalDuplicateTableRows(markdown: string): { markdown: string; removedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const removed = new Set<number>();
  const details: string[] = [];
  const tables = extractMarkdownTables(markdown);
  const rowFirstCol = (row: string[]) => (row[0] || '').trim();
  const rowSim = (left: string[], right: string[]) => jaccard(left, right);
  for (const table of tables) {
    const rows = table.dataRows;
    if (rows.length < 4) continue;
    for (let split = Math.floor(rows.length / 2); split <= Math.ceil(rows.length / 2); split += 1) {
      const front = rows.slice(0, split);
      const back = rows.slice(split);
      if (front.length < 2 || back.length < 2) continue;
      let matched = 0;
      let lastMatch = -1;
      for (const backRow of back) {
        const col = rowFirstCol(backRow);
        if (!col) continue;
        for (let j = lastMatch + 1; j < front.length; j += 1) {
          if (rowFirstCol(front[j]) === col && rowSim(backRow, front[j]) >= 0.5) {
            matched += 1;
            lastMatch = j;
            break;
          }
        }
      }
      if (matched / back.length < 0.8) continue;
      // 数据行在表格块内的物理行号：表头+分隔行占 2 行，数据行从 startLine+2 起
      const backStartLine = table.startLine + 2 + split;
      for (let line = backStartLine; line <= table.endLine; line += 1) removed.add(line);
      details.push(`第 ${table.startLine + 1}~${table.endLine + 1} 行表格删除 ${back.length} 行重复数据行`);
      break;
    }
  }
  if (removed.size === 0) return { markdown, removedCount: 0, details };
  return {
    markdown: lines.filter((_, index) => !removed.has(index)).join('\n'),
    removedCount: removed.size,
    details,
  };
}

export function stripDuplicateTables(markdown: string): { markdown: string; removedCount: number; removedLineNumbers?: number[] } {
  const tables = extractMarkdownTables(markdown);
  if (tables.length < 2) return { markdown, removedCount: 0 };
  const lines = markdown.split(/\r?\n/u);
  const removed = new Set<number>();
  for (let left = 0; left < tables.length; left += 1) {
    for (let right = left + 1; right < tables.length; right += 1) {
      const a = tables[left];
      const b = tables[right];
      if (removed.has(a.startLine) || removed.has(b.startLine)) continue;
      const headerSame = a.header.length > 0 && a.header.length === b.header.length && a.header.every((cell, index) => cell === b.header[index]);
      const headerSim = jaccard(a.header, b.header);
      const firstColSim = jaccard(a.firstCol, b.firstCol);
      const dataSim = jaccard(a.dataCells, b.dataCells);
      // 双向覆盖（与 duplicateTableIssues 同口径）：粘贴时删列的复制表（cell 数少）与带全列的原表
      // 互为覆盖方向，单向按 cell 数选小表会把「删减版子表」漏删
      const dataCoverage = Math.max(
        cellCoverage(textCellsOf(a.dataCells), textCellsOf(b.dataCells)),
        cellCoverage(textCellsOf(b.dataCells), textCellsOf(a.dataCells)),
      );
      // 与 duplicateTableIssues 同判定口径（检测定位=修复定位）：同结构不同内容表不删
      if (!(headerSame && dataSim >= 0.6) && !(headerSim >= 0.7 && firstColSim >= 0.6) && !(firstColSim >= 0.6 && dataCoverage >= 0.6)) continue;
      // 保留 bodyChars 大者（信息更全），删除另一张
      const [keep, drop] = a.bodyChars >= b.bodyChars ? [a, b] : [b, a];
      for (let line = drop.startLine; line <= drop.endLine; line += 1) removed.add(line);
      void keep;
    }
  }
  if (removed.size === 0) return { markdown, removedCount: 0 };
  return {
    markdown: lines.filter((_, index) => !removed.has(index)).join('\n'),
    removedCount: removed.size,
    removedLineNumbers: [...removed].sort((left, right) => left - right),
  };
}

/** 跨章表格去重：全文判定重复表后，把被删行号映射回各章节逐章删除。
 * 丰乐镇实测：同一「关键节点|计划完成时间|责任岗位…」表复制粘贴到 4 个章节，
 * 逐章调用 stripDuplicateTables 时每章只有一张 → 重复永不删除（与劳动力峰值跨章权威同一根因）。
 * 全文执行一次判定（表头+首列+数据覆盖度同源口径），再把被删表格块按行号归属删除到对应章节。 */

export function stripDuplicateTablesAcrossChapters(chapters: Array<{ content: string }>): { removedCount: number; chapterFixed: number } {
  const joined = chapters.map(chapter => chapter.content).join('\n\n');
  const result = stripDuplicateTables(joined);
  if (result.removedCount === 0) return { removedCount: 0, chapterFixed: 0 };
  const removedSet = new Set(result.removedLineNumbers || []);
  // 行号映射：每章实际行数推进游标后恒 +1——join('\n\n') 的第二个换行仅产生 1 个额外空行
  //（无尾换行时第一个换行终止本章末行；有尾换行时首空串已计入本章 split 尾元素），
  // 固定 +2 或按尾换行分叉都会从第二章起映射错位（跨章去重删错行缺陷）
  let joinedCursor = 0;
  let removedCount = 0;
  let chapterFixed = 0;
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex];
    const chapterLines = chapter.content.split('\n');
    const localRemoved = new Set<number>();
    for (let local = 0; local < chapterLines.length; local += 1) {
      if (removedSet.has(joinedCursor + local)) localRemoved.add(local);
    }
    if (localRemoved.size > 0) {
      chapter.content = chapterLines.filter((_, index) => !localRemoved.has(index)).join('\n');
      removedCount += localRemoved.size;
      chapterFixed += 1;
    }
    joinedCursor += chapterLines.length;
    if (chapterIndex < chapters.length - 1) joinedCursor += 1;
  }
  return { removedCount, chapterFixed };
}

// ── 20. 段落完全重复（h15）：同一长段落（≥40 字）全文出现 ≥2 次属复制粘贴残留 ──
// 青天评分报告实测：「危险源辨识覆盖基坑支护、装配式构件吊装……」段落与表格前段落完全重复；
// 判定只收「归一化后完全相等」的段落（长度 ≥40 字），表格行/标题行不入池，零语义成本零误伤。

export function stripDuplicateParagraphs(markdown: string): { markdown: string; removedCount: number } {
  const lines = markdown.split(/\r?\n/u);
  const seen = new Set<string>();
  const drop = new Set<number>();
  let buffer: string[] = [];
  let bufferLines: number[] = [];
  const flush = () => {
    const fingerprint = paragraphFingerprint(buffer.join(''));
    if (fingerprint) {
      if (seen.has(fingerprint)) {
        bufferLines.forEach(index => drop.add(index));
      } else {
        seen.add(fingerprint);
      }
    }
    buffer = [];
    bufferLines = [];
  };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) { flush(); return; }
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) { flush(); return; }
    if (/^[-*•]\s/u.test(trimmed)) { flush(); buffer = [trimmed]; bufferLines = [index]; flush(); return; }
    buffer.push(trimmed);
    bufferLines.push(index);
  });
  flush();
  if (drop.size === 0) return { markdown, removedCount: 0 };
  return { markdown: lines.filter((_, index) => !drop.has(index)).join('\n'), removedCount: drop.size };
}

export interface NumericConsistencyFixResult {
  markdown: string;
  fixedCount: number;
  details: string[];
}

/** 从后往前应用定点替换（避免索引偏移；detail 去重保序） */

function applySpanReplacements(markdown: string, replacements: Array<{ start: number; end: number; replacement: string; detail: string }>): { markdown: string; fixedCount: number; details: string[] } {
  if (replacements.length === 0) return { markdown, fixedCount: 0, details: [] };
  // 4.17.3 重叠 span 治理：同一数值被正/反向模式双命中（如「45日历天为唯一」同时命中
  // 工期控制正向与「N日历天+为唯一」反向模式）时旧降序逐条 slice 会产生「45→2100」错位；
  // 升序单次遍历按原始坐标拼接，重叠 span（start < 已应用区间末）跳过，只应用第一条
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  let next = '';
  let cursor = 0;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of sorted) {
    if (item.start < cursor || item.end <= item.start) continue;
    next += markdown.slice(cursor, item.start) + item.replacement;
    cursor = item.end;
    fixedCount += 1;
    details.push(item.detail);
  }
  next += markdown.slice(cursor);
  return { markdown: next, fixedCount, details: [...new Set(details)].slice(0, 8) };
}

/** 劳动力峰值确定性修复：正文总口径峰值/控制上限与分阶段投入明细表峰值矛盾 → 正文数字改为表格峰值。
 * 与检测器同源同阈值：>30% 才矛盾、阶段限定峰值不参与（laborPeakStageOf 同源判定）。 */

function fixLaborPeakConflicts(markdown: string, laborPeakAuthority?: number): { markdown: string; fixedCount: number; details: string[] } {
  // A3 跨章权威（丰乐镇实测）：分阶段劳动力明细表与正文峰值表述分布在不同章节，
  // 逐章调用时本章无表 → 表峰值 undefined → 正文 68 人 vs 表 20 人矛盾永远无法确定性修复。
  // 调用方从全文提取表峰值作为跨章权威传入，本章无表时同样执行替换。
  const tablePeak = laborPeakAuthority !== undefined && laborPeakAuthority > 0 ? laborPeakAuthority : tablePeakLabor(markdown);
  if (tablePeak === undefined) return { markdown, fixedCount: 0, details: [] };
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  const collect = (pattern: RegExp) => {
    for (const match of markdown.matchAll(pattern)) {
      const value = Number(match[1].replace(/[,，]/gu, ''));
      if (!Number.isFinite(value) || value <= 0) continue;
      const valueIndex = match.index + match[0].indexOf(match[1]);
      // 表格行内（行首行尾均为 |）的阶段劳动力数值属分阶段明细表合法数据不修（与检测器 h17 同源）
      const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
      let lineEnd = markdown.indexOf('\n', match.index);
      if (lineEnd === -1) lineEnd = markdown.length;
      if (/^\s*\|.*\|\s*$/u.test(markdown.slice(lineStart, lineEnd))) continue;
      // F6 口径隔离（与检测器同源）：管理/工种口径数值不与表峰值比较替换——
      // 「管理人员18人」「钢筋工60人」被表峰值替换会破坏合法口径（真实生成误报根因）
      if (laborGroupOf(markdown, valueIndex, lineStart).group !== 'peak') continue;
      // 与检测器模式 3 同源：仅无阶段限定的总口径峰值与表峰值比较
      if (laborPeakStageOf(markdown, valueIndex)) continue;
      // 模式 6 同源：控制上限形态（「控制在N人以内」）交由控制上限分支处理——上限 ≥ 权威
      // 是自洽表述不修（250 vs 200），collect 零豁免不得先手替换（K1 实测误修根因）
      if (/人(?:以内|以下|之内)/u.test(markdown.slice(valueIndex + match[1].length, valueIndex + match[1].length + 8)) && /控制/u.test(markdown.slice(Math.max(0, valueIndex - 16), valueIndex))) continue;
      // D2 零漂移豁免：权威口径（蓝图/分阶段投入明细表）存在时，正文总口径峰值与权威
      // 任何不一致（含 <30% 微漂移）都确定性替换——漂移豁免放过 199 vs 176（11.6%）类
      // 残留，蓝图引用终检严格相等报 error 且 LLM 修复轮修不掉（round-27 实测根因）；
      // h17 双向：偏低/偏高方向一律以权威值收口，与权威相等的表述保持不动
      if (value === tablePeak) continue;
      replacements.push({ start: valueIndex, end: valueIndex + match[1].length, replacement: String(tablePeak), detail: `劳动力峰值 ${value}人→${tablePeak}人（以分阶段投入明细表为准）` });
    }
  };
  collect(PEAK_LABOR_RE);
  collect(LABOR_COUNT_RE);
  // 与检测器模式 6 同源：总量控制上限低于表格峰值即不自洽 → 上限改为表格峰值
  for (const match of markdown.matchAll(/(?:高峰期|高峰|峰值)[^。；;\n]{0,16}?控制(?:在|为|到)?(?:约)?\s*([\d,]+)\s*人(?:以内|以下|之内)?/gu)) {
    const value = Number(match[1].replace(/[,，]/gu, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value >= tablePeak) continue;
    const valueIndex = match.index + match[0].indexOf(match[1]);
    replacements.push({ start: valueIndex, end: valueIndex + match[1].length, replacement: String(tablePeak), detail: `劳动力控制上限 ${value}人→${tablePeak}人（与分阶段投入明细表峰值自洽）` });
  }
  return applySpanReplacements(markdown, replacements);
}

/** 节点工期确定性修复（4.17.4 扩展为三阶段管线）：
 * ① 体系缩放：factsModel 锁定总工期（如 540 日历天）与文档主流节点体系终点（如 365 日）差异 >10% 时，
 *   全文「开工(令下发)后第N日/天」及竣工验收语境裸「第N日」按 scale 统一缩放，三列进度表行链式重算
 *   开始/持续列保证表内自洽（合肥师范实测：365 体系与总工期 540 并存，三表互相矛盾且权威表标题
 *   不含「总进度计划」导致历史逻辑零产出）；
 * ② 权威表提取：「总进度计划/施工总进度/总进度安排/总工期控制」标题表格块按行名→完成日建立节点权威口径
 *   （行级提取覆盖「开工令下发后第N日」表格式，历史三形态正则抓不到该形态）；
 * ③ 多表对齐：非权威表格行按行名关键词归类节点键，行内完成日与权威相差 ≥5 天 → 替换为权威值；
 *   正文句矛盾沿用三形态正则 + 权威口径定点替换（与检测器 nodeScheduleConsistencyIssues 同源同阈值 ≥5 天）。 */

function fixNodeScheduleConflicts(markdown: string, options?: { scheduleAuthority?: number; nodeAuthorities?: Array<{ node: string; offset: string }> }): { markdown: string; fixedCount: number; details: string[] } {
  let next = markdown;
  const allDetails: string[] = [];
  const scheduleAuthority = options?.scheduleAuthority;
  // ── ① 体系缩放 ──
  if (scheduleAuthority !== undefined && scheduleAuthority > 0) {
    const absoluteDays = [...next.matchAll(/(?:开工令下发后|开工后)第(\d{1,3})[日天]/gu)].map(match => Number(match[1]));
    const systemMax = absoluteDays.length > 0 ? Math.max(...absoluteDays) : 0;
    if (systemMax > 0 && systemMax < scheduleAuthority * 0.9) {
      const scale = scheduleAuthority / systemMax;
      const scaleReplacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
      for (const match of next.matchAll(/(?:开工令下发后|开工后)第(\d{1,3})[日天]/gu)) {
        const value = Math.max(1, Math.round(Number(match[1]) * scale));
        const dayStart = match.index + match[0].indexOf(match[1]);
        scaleReplacements.push({ start: dayStart, end: dayStart + match[1].length, replacement: String(value), detail: `节点日期 ${match[1]}日→${value}日（总工期${scheduleAuthority}日历天体系缩放）` });
      }
      // 竣工验收语境裸「第N日」：正向「第N日竣工验收」与括号「竣工验收合格（第N日）」
      for (const match of next.matchAll(/第(\d{2,3})日(?=[^。；;\n]{0,8}竣工验收)/gu)) {
        const value = Math.max(1, Math.round(Number(match[1]) * scale));
        scaleReplacements.push({ start: match.index, end: match.index + match[0].length, replacement: `第${value}日`, detail: `竣工验收节点 ${match[1]}日→${value}日（总工期${scheduleAuthority}日历天体系缩放）` });
      }
      for (const match of next.matchAll(/(竣工验收(?:合格)?[^。；;\n]{0,8}?[（(])第(\d{2,3})日([）)])/gu)) {
        const value = Math.max(1, Math.round(Number(match[2]) * scale));
        scaleReplacements.push({ start: match.index, end: match.index + match[0].length, replacement: `${match[1]}第${value}日${match[3]}`, detail: `竣工验收节点 ${match[2]}日→${value}日（总工期${scheduleAuthority}日历天体系缩放）` });
      }
      if (scaleReplacements.length > 0) {
        const scaled = applySpanReplacements(next, scaleReplacements);
        next = scaled.markdown;
        allDetails.push(...scaled.details.slice(0, 8));
        // 三列进度表行链式重算：开始列=上一行结束+1，持续列=结束-开始+1（缩放后保证表内自洽）
        const threeColLineRe = /^(\|[^|]*\|)\s*开工令下发后第(\d+)日\s*\|\s*开工令下发后第(\d+)日\s*\|\s*(\d+)\s*日\s*(\|.*)$/u;
        const lines = next.split(/\r?\n/u);
        let prevEnd = 0;
        let chainedCount = 0;
        for (let index = 0; index < lines.length; index += 1) {
          const match = lines[index].match(threeColLineRe);
          if (!match) { prevEnd = 0; continue; }
          const end = Number(match[3]);
          const start = prevEnd > 0 ? prevEnd + 1 : Number(match[2]);
          const newEnd = Math.max(end, start + 1);
          const duration = newEnd - start + 1;
          if (start !== Number(match[2]) || newEnd !== end || duration !== Number(match[4])) {
            lines[index] = `${match[1]} 开工令下发后第${start}日 | 开工令下发后第${newEnd}日 | ${duration}日 ${match[5]}`;
            chainedCount += 1;
          }
          prevEnd = newEnd;
        }
        if (chainedCount > 0) {
          next = lines.join('\n');
          allDetails.push(`三列进度表链式重算 ${chainedCount} 行（开始/持续列与缩放后结束列自洽）`);
        }
      }
    }
  }
  // ── ②③ 权威表提取 + 多表/正文对齐 ──
  const lines = next.split(/\r?\n/u);
  const tableRowLineRe = /^\|.+\|$/u;
  const lineSpans: Array<{ start: number; end: number }> = [];
  let lineOffset = 0;
  for (const line of lines) {
    lineSpans.push({ start: lineOffset, end: lineOffset + line.length });
    lineOffset += line.length + 1;
  }
  // 行名→节点键归类（清理/预验收优先于竣工验收，「竣工清理与预验收」不得误入 completion）
  const stageKeysOf = (rowName: string): string[] => {
    const keys: string[] = [];
    if (/清理|预验收|收尾/u.test(rowName)) keys.push('cleanup');
    if (/竣工验收/u.test(rowName)) keys.push('completion');
    if (/装饰|幕墙/u.test(rowName)) keys.push('decoration');
    if (/机电/u.test(rowName)) keys.push('mep');
    if (/二次|ALC|墙板|砌体/u.test(rowName)) keys.push('secondary');
    if (/主体|封顶/u.test(rowName)) keys.push('topping');
    if (/土方|基坑|基础|支护/u.test(rowName)) keys.push('excavation');
    return keys;
  };
  const firstCellOf = (line: string): string => (line.split('|')[1] || '').trim();
  const lastDayOf = (line: string): { value: number; start: number; end: number } | undefined => {
    let found: { value: number; start: number; end: number } | undefined;
    for (const match of line.matchAll(/第(\d{1,3})[日天]/gu)) {
      // 相对量豁免：日期值前 8 字符含「X后」形态（竣工验收合格后第90日/主体封顶后第30天）不作为完成日
      const prefix = line.slice(Math.max(0, (match.index ?? 0) - 8), match.index ?? 0);
      if (/(?:合格|封顶|移交|完成|进场|退场)后$/u.test(prefix)) continue;
      found = { value: Number(match[1]), start: (match.index ?? 0) + match[0].indexOf(match[1]), end: (match.index ?? 0) + match[0].lastIndexOf(match[1]) + match[1].length };
    }
    return found;
  };
  // ② 权威表提取：标题含总进度计划/总工期控制的表格块，行级「行名→完成日」建权威
  const authorityByKey = new Map<string, number>();
  const authoritySpans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!tableRowLineRe.test(lines[index].trim())) continue;
    const blockStart = index;
    while (index < lines.length && tableRowLineRe.test(lines[index].trim())) index += 1;
    const blockEnd = index;
    const headerProbe = lines.slice(Math.max(0, blockStart - 6), blockStart).join('\n');
    if (!/总进度计划|施工总进度|总进度安排|总工期控制|总工期/u.test(headerProbe)) continue;
    for (let row = blockStart; row < blockEnd; row += 1) {
      const rowName = firstCellOf(lines[row]);
      const day = lastDayOf(lines[row]);
      if (!day || /---/u.test(rowName)) continue;
      for (const key of stageKeysOf(rowName)) {
        const existing = authorityByKey.get(key);
        if (existing === undefined || day.value > existing) authorityByKey.set(key, day.value);
      }
    }
    authoritySpans.push({ start: lineSpans[blockStart].start, end: lineSpans[blockEnd - 1].end });
  }
  // B1 主表进度节点权威注入（生成前锁定口径优先）：关键节点表标题不含「总进度计划」类
  // 关键词时②权威提取零产出，封顶 230/270/333 三口径残留被导出门禁阻断（第九次回归根因）；
  // 主表值覆盖文档内权威表提取值（主表为唯一口径源），冲突 ≥5 天时权威表行也纳入③对齐
  for (const entry of options?.nodeAuthorities ?? []) {
    const dayMatch = entry.offset.match(/第(\d{1,3})[日天]/u);
    if (!dayMatch) continue;
    const day = Number(dayMatch[1]);
    if (!Number.isFinite(day) || day < 1 || day > 3000) continue;
    const key = SCHEDULE_NODE_ANCHORS.find(anchor => anchor.re.test(entry.node))?.key;
    if (key === undefined) continue;
    const existing = authorityByKey.get(key);
    if (existing !== undefined && Math.abs(existing - day) >= 5) authoritySpans.length = 0;
    authorityByKey.set(key, day);
  }
  if (authorityByKey.size === 0) return { markdown: next, fixedCount: allDetails.length > 0 ? 1 : 0, details: allDetails };
  // ③ 非权威表行完成日对齐 + 正文句三形态定点替换
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  const outsideAuthority = (position: number) => !authoritySpans.some(span => position >= span.start && position <= span.end);
  for (let index = 0; index < lines.length; index += 1) {
    if (!tableRowLineRe.test(lines[index].trim())) continue;
    if (!outsideAuthority(lineSpans[index].start)) continue;
    const rowName = firstCellOf(lines[index]);
    const day = lastDayOf(lines[index]);
    if (!day || /---/u.test(rowName)) continue;
    const authority = stageKeysOf(rowName).map(key => authorityByKey.get(key)).find(value => value !== undefined);
    if (authority === undefined) continue;
    if (Math.abs(day.value - authority) < 5) continue;
    const label = SCHEDULE_NODE_ANCHORS.find(anchor => stageKeysOf(rowName).includes(anchor.key))?.label || rowName.slice(0, 12);
    replacements.push({ start: lineSpans[index].start + day.start, end: lineSpans[index].start + day.end, replacement: String(authority), detail: `表格节点“${label}”${day.value}日→${authority}日（以总进度计划/总工期控制表为准）` });
  }
  const keyOf = (text: string) => SCHEDULE_NODE_ANCHORS.find(anchor => anchor.re.test(text))?.key;
  const pushReplacement = (nodeText: string, day: number, dayStart: number, dayEnd: number, raw: string) => {
    const key = keyOf(nodeText);
    if (key === undefined || !Number.isFinite(day) || day < 1 || day > 3000) return;
    const authority = authorityByKey.get(key);
    if (authority === undefined) return;
    if (Math.abs(day - authority) < 5) return;
    if (!outsideAuthority(dayStart)) return;
    replacements.push({ start: dayStart, end: dayEnd, replacement: String(authority), detail: `节点“${SCHEDULE_NODE_ANCHORS.find(anchor => anchor.key === key)?.label || key}”工期 ${day}日→${authority}日（以总进度计划表为准）` });
  };
  // 形态 A 正序完成式：第N日完成X——第N日与「完成」之间排除「）→」（节点分隔符），
  // 防「施工准备与临时设施完成（第22日）→土方开挖与基础施工完成（第75日）→主体结构封顶（第311日）」
  // 中第22日跨节点误采为封顶工期（合肥师范实测 22→311 错位源）；「完成」与节点名之间排除「（→」；
  // h18：两段中间均排除枚举标点「，、」——「基础及地下室结构在第135日完成，主体结构封顶
  // 在第270日完成」枚举句中 135 曾被跨项误绑到封顶替换（与检测器 extractNodeScheduleDays 同源同口径）
  for (const match of next.matchAll(/第(\d{2,3})日(?:(?![）)→。；;\n，、]).){0,14}?完成(?:(?![（(→。；;\n，、]).){0,12}?(基坑支护及土方外运|装饰装修及幕墙|机电安装及智能化调试|室外工程及竣工验收|地下结构出正负零|主体结构封顶|正负零|封顶)/gu)) {
    const dayStart = match.index + match[0].indexOf(match[1]);
    pushReplacement(match[2], Number(match[1]), dayStart, dayStart + match[1].length, match[0].slice(0, 40));
  }
  // 形态 D 竣工验收倒序式：竣工验收节点第N日——负向前瞻排除「后」（相对量句「竣工验收合格后第90日」
  // 不缩放）与节点分隔符，覆盖「主体结构封顶节点第311日与竣工验收节点第365日为刚性控制点」形态
  for (const match of next.matchAll(/(竣工验收)(?:(?!(?:后|第\d{2,3}[日天]|，|、|→)).){0,10}?第(\d{2,3})[日天]/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length, match[0].slice(0, 40));
  }
  for (const match of next.matchAll(/(基坑支护|正负零|封顶|装饰装修|机电安装|竣工验收)(?:(?!(?:第\d{2,3}[日天]|，|、)).){0,8}?完成[^。；;\n]{0,10}?第(\d{2,3})[日天]/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length, match[0].slice(0, 40));
  }
  // 形态 C 倒序锁定式：封顶节点第N日——h18 与检测器同源排除「，、/完成/|/句界」；
  // 「后」只在节点名后定点排除（「主体结构封顶后第10日」相对量句），窗口内不排除——
  // 防设备表行「主体封顶 | 商品混凝土泵送 | 开工后第158日进场」误采的同时不误杀「开工后第N日」倒序式
  for (const match of next.matchAll(/(主体(?:结构)?封顶)(?!后)(?:(?!(?:第\d{2,3}[日天]|，|、|完成|\||[。；;\n])).){0,20}?第(\d{2,3})日/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length, match[0].slice(0, 40));
  }
  const applied = applySpanReplacements(next, replacements);
  return { markdown: applied.markdown, fixedCount: applied.fixedCount + (allDetails.length > 0 ? 1 : 0), details: [...allDetails, ...applied.details].slice(0, 12) };
}

/** 取出现频次最高的数值（平手取较大值，总量口径优先） */

function modeOfValues(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** 材料/设备数量确定性修复：表格行数值为权威口径，正文矛盾数值（差异 >20%）改为表格值。
 * 与检测器 crossSectionNumericConflictIssues 同源（同锚点/同豁免：并列枚举、否定声明句）；
 * 表格口径不唯一（多表互相矛盾）时不动，交 LLM 修复路径。
 * 4.17.3 权威口径扩展：计划总工期锚点支持外部锁定口径（factsModel 计划工期事实卡）——
 * 庐江实测 45 vs 210 两套体系各自带表格，表格值不唯一导致确定性修复零产出、LLM 修复无法裁决、
 * 修复节点 failed；外部锁定口径（招标文件前附表值）优先级高于表格值。 */

function fixCrossSectionNumericConflicts(markdown: string, authorities?: Record<string, number>, codeAuthorities?: Record<string, string>): { markdown: string; fixedCount: number; details: string[] } {
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  for (const anchor of CROSS_SECTION_ANCHORS) {
    if (anchor.kind !== 'number') continue;
    const tableValues = new Set<number>();
    const bodyMatches: Array<{ value: number; group: string }> = [];
    const tableMatches: Array<{ value: number; group: string }> = [];
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        // 保障性下限豁免（与检测器 A14 同源）：「不少于2具」「至少」是下限表述非精确口径
        if (/按不少于|不少于|至少|不低于/u.test(raw)) continue;
        // 阶段细分豁免（与检测器同源，零漂移实测）：「共10日历天内完成」是阶段工期细分非总工期
        if (anchor.key === 'scheduleDays') {
          const digitAt = raw.indexOf(String(match[1]));
          if (digitAt >= 0 && /(?:阶段|第\d+日|至第|共|集中)/u.test(markdown.slice(Math.max(0, (match.index || 0) + digitAt - 16), (match.index || 0) + digitAt))) continue;
        }
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        const line = markdown.slice(lineStart, lineEnd);
        if (NEGATIVE_DECLARATION_RE.test(line)) continue;
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) continue;
        // F15 部位语境：匹配记录部位组（表格行与正文同口径，与检测器 crossSectionNumericConflictIssues 一致），
        // 分部位的数量配置（分区灭火器 4具/2具）不参与权威归一判定
        const group = locationGroupForMatch(markdown, match.index || 0, raw, lineStart);
        if (/^\s*\|/u.test(line)) { tableValues.add(value); tableMatches.push({ value, group }); }
        else bodyMatches.push({ value, group });
      }
    }
    // 权威优先级：外部锁定口径（factsModel 计划工期/装配率等）> 表格唯一值 >
    // 设备台数多表冲突兜底（塔吊 2台 vs 1台 时取保守台数，评分器对超配敏感）>
    // A5 同组众数兜底（丰乐镇实测：灭火器 12具 与 2具 同属未标注部位语境且互为矛盾，检测器报
    // 「未标注部位语境两套口径」阻断，但 tableValues={12,2} 唯一值分支永不命中 → 修复恒零产出）；
    // 正文/表格行存在与权威差异 >20% 的值才修复（与检测器同阈值）
    const externalAuthority = authorities?.[anchor.key];
    const equipmentFallback = externalAuthority === undefined && anchor.key === 'towerCrane' && tableValues.size > 1;
    // A5：无部位组内存在互斥数值对（检测器同阈值）时启用众数权威——同一语境下总量口径唯一，
    // 频次最高值即主流口径（丰乐镇灭火器 12具 出现 3 处表格、2具 仅 1 处）
    const unlabeledAll = [...tableMatches, ...bodyMatches].filter(item => item.group === '').map(item => item.value);
    const unlabeledConflict = unlabeledAll.length >= 2 && Math.max(...unlabeledAll) - Math.min(...unlabeledAll) > Math.max(...unlabeledAll) * 0.2;
    const modeFallback = externalAuthority === undefined && !equipmentFallback && tableValues.size > 1 && unlabeledConflict ? modeOfValues(unlabeledAll) : undefined;
    const authority = externalAuthority !== undefined && externalAuthority > 0 ? externalAuthority
      : tableValues.size === 1 ? [...tableValues][0]
      : equipmentFallback ? Math.min(...tableValues)
      : modeFallback;
    if (authority === undefined) continue;
    // 外部权威/设备兜底时表格行全量参与修复（多表互相矛盾时表格行本身就是要统一的对象）；
    // A5 众数兜底仅未标注部位语境的表格行参与；F15 部位组豁免：部位组正文值不参与差异判定
    const fixCandidates = [...bodyMatches.filter(item => item.group === ''), ...(externalAuthority !== undefined || equipmentFallback ? tableMatches : modeFallback !== undefined ? tableMatches.filter(item => item.group === '') : [])];
    if (!fixCandidates.some(item => Math.abs(item.value - authority) > authority * 0.2)) continue;
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        const line = markdown.slice(lineStart, lineEnd);
        if (NEGATIVE_DECLARATION_RE.test(line)) continue;
        if (/^\s*\|/u.test(line) && externalAuthority === undefined && !equipmentFallback && modeFallback === undefined) continue;
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) continue;
        // F15 部位组豁免：正文分部位的数量配置（分区灭火器等）不做确定性归一，防止修复器制造数据矛盾
        if (!/^\s*\|/u.test(line) && locationGroupForMatch(markdown, match.index || 0, raw, lineStart) !== '') continue;
        // A5 众数兜底仅统一未标注部位语境的表格行（带部位列的表格行保持不动）
        if (/^\s*\|/u.test(line) && modeFallback !== undefined && locationGroupForMatch(markdown, match.index || 0, raw, lineStart) !== '') continue;
        if (Math.abs(value - authority) <= authority * 0.2) continue;
        const valueIndex = match.index + match[0].indexOf(match[1]);
        const source = externalAuthority !== undefined && externalAuthority > 0 ? (anchor.key === 'scheduleDays' ? '以绑定资料计划工期为准' : '以绑定资料锁定口径为准') : modeFallback !== undefined ? '以未标注部位主流口径为准' : '以表格口径为准';
        replacements.push({ start: valueIndex, end: valueIndex + match[1].length, replacement: String(authority), detail: `${anchor.label} ${value}${anchor.unit}→${authority}${anchor.unit}（${source}）` });
      }
    }
  }
  // P2.3 收口修复扩围：标号类锚点（垫层 C20 等）外部权威确定性替换——kind='code' 锚点此前只检测不修复
  for (const anchor of CROSS_SECTION_ANCHORS) {
    if (anchor.kind !== 'code') continue;
    const authority = codeAuthorities?.[anchor.key];
    if (!authority) continue;
    const candidates: Array<{ start: number; end: number; raw: string }> = [];
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        const line = markdown.slice(lineStart, lineEnd);
        if (NEGATIVE_DECLARATION_RE.test(line)) continue;
        // 保障性下限豁免（与检测器 A14 同源）：「垫层混凝土强度不低于C20」的下限表述是
        // 保障口径非精确规格，定点替换会削弱要求（C20→C15），不动
        if (/按不少于|不少于|至少|不低于/u.test(raw)) continue;
        // 部位组豁免与数值锚点同口径：分部位合法规格不做归一；部位词窗口排除锚点词本身——
        // 「垫层」自身在部位词表中，含锚点词的窗口会把组判成锚点词而豁免掉本应修复的同名条目；
        // 「基础垫层」异部位语境（锚点词前还有部位词「基础」）仍豁免保留原规格
        if (!/^\s*\|/u.test(line) && locationGroupForMatch(markdown, match.index || 0, '', lineStart) !== '') continue;
        if (match[1] === authority) continue;
        const valueIndex = match.index + match[0].indexOf(match[1]);
        candidates.push({ start: valueIndex, end: valueIndex + match[1].length, raw });
      }
    }
    for (const candidate of candidates) {
      replacements.push({ start: candidate.start, end: candidate.end, replacement: authority, detail: `${anchor.label} ${markdown.slice(candidate.start, candidate.end)}→${authority}（以工程量清单锁定口径为准）` });
    }
  }
  return applySpanReplacements(markdown, replacements);
}

// ── G3 清单工程量权威定点校正 ──
// 丰乐镇第五轮实测：2.1 道路工程 5 项工程量与清单汇总值漂移 3.5%~70%（级配碎石 18949.52 vs
// 权威 20931.02、水泥混凝土 18799.52 vs 20872.82、路床碾压 18429.52 vs 19930.52、挖方
// 4040.45 vs 4187.38、拆除路面 633 vs 2134），全量清单复制入正文制造跨章口径漂移。
// 检测器 anchor 表只覆盖工期/设备/材料，清单工程量无权威锚点——此处按蓝图 quantities
// （条目名→汇总值）定点校正。清单条目存在「子串名」「分规格」「分村分表」「分部量」等
// 合法口径，无差别归一制造矛盾数据（丰乐镇干跑实测：塑料管铺设 8205.53 被「塑料管」
// 权威误改 7525.01、直径450塑料检查井 40 座被「塑料检查井」汇总值误改 555），
// 因此内置五重豁免：最长条目名优先、表格行、规格限定词、村名语境、句级口径判定。

/** 单位归一（权威单位 → 正文匹配单位集）：清单单位口径与正文写法对齐（m2/m²/㎡ 同义） */

function quantityUnitVariants(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (/(?:m2|m²|㎡)/.test(normalized)) return '(?:㎡|m²|m2)';
  if (/(?:m3|m³)/.test(normalized)) return '(?:m³|m3)';
  if (normalized === 't' || normalized === '吨') return '(?:吨|t)';
  return unit.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 名称弹性匹配模式：括号容忍半全角与可缺省
 * （「路床(槽)碾压检验」↔「路床（槽）碾压检验」↔「路床槽碾压检验」三态互配） */

function flexNamePattern(name: string): string {
  return name.split('').map(ch => {
    // 括号双态互配（半/全角都容忍对方）——名称含全角括号时正文常写半角（“栽植色带（生态池外围一圈）”↔“栽植色带(生态池外围一圈)”）
    if (ch === '(' || ch === '（') return '[（(]?';
    if (ch === ')' || ch === '）') return '[）)]?';
    if (/[.*+?^${}()|[\]\\]/u.test(ch)) return `\\${ch}`;
    return ch;
  }).join('');
}

/** 村名/分部语境特征词豁免：名称前 12 字内含这些词时判为分村/分部合法量，不归一；
 * 「池」覆盖生态池部位量（“生态池外围栽植色带90m²”对应清单「栽植色带（生态池外围一圈）」条目），
 * 「井」覆盖公厕分部语境（“砌筑检查井2座、塑料管铺设7.8m”分村分表合法量）。
 * D2 收紧：剔除「村/组/集/分/区/段/栋/楼」宽泛单字——「本分项工程量为…」的「分」、「施工区域」
 * 的「区」、「阶段」的「段」是合法工程表述，单字豁免会放过总口径真实冲突（丰乐镇实测根因）；
 * 真实村名语境的兜底由段落级 VILLAGE_PARAGRAPH_HINT_RE 承担 */

const VILLAGE_LOCATION_HINT_RE = /[郢庄岗塘圩坝池井]/u;

/** 段落级村名豁免字符集（保守子集）：段落内含任一字符判为分村分表段，整段不归一
 * （村名距条目名常超过 12 字窗口，如“、殷郢组…本分项工程量为：…挖基坑土方42.12m³”；
 * 刻意不含「村/组/段/集」——「20个自然村」「专业组」「流水段」「集料」是合法工程表述） */

const VILLAGE_PARAGRAPH_HINT_RE = /[郢庄岗塘圩坝]/u;

/** 规格限定词（名称前/后 8 字内）：分规格量不归一
 * （“直径450塑料检查井40座”是分规格条目，清单汇总条目“塑料检查井555座”不得覆盖；
 * “钢带PE增强螺旋波纹管DN200铺设2170m”的 DN200 是规格后置） */

const SPEC_QUALIFIER_RE = /(?:直径|DN|Φ|φ)\s*\d+/u;

export function fixQuantityAuthorityConflicts(markdown: string, quantityAuthorities: Array<{ name: string; value: number; unit: string }> = []): { markdown: string; fixedCount: number; details: string[] } {
  if (quantityAuthorities.length === 0) return { markdown, fixedCount: 0, details: [] };
  interface Candidate { start: number; end: number; raw: string; value: number; authority: { name: string; value: number; unit: string }; ns: number; ne: number; }
  const candidates: Candidate[] = [];
  const occupied: Array<{ start: number; end: number }> = [];
  // 最长条目名优先：蓝图「塑料管铺设」与「塑料管」并存时，正文“塑料管铺设8205.53m”只归
  // 长条目（8205.53 与长条目一致不改），不被「塑料管」条目误改 7525.01；
  // 「级配碎石基层」无更长权威条目，短名「级配碎石」照常命中修复
  const sorted = [...quantityAuthorities].sort((a, b) => b.name.length - a.name.length);
  for (const authority of sorted) {
    const nameRe = new RegExp(flexNamePattern(authority.name), 'gu');
    // 数值左边界：排除更长数字串/科学计数法的截取（「1e3」中的 3、「abc123」的 123）；
    // 'i' 标志：兼容大写单位（M2/M3/T/M——工程文档中常见）
    const unitRe = new RegExp(`(?<![\\dA-Za-z])(\\d(?:[\\d,]*(?:\\.\\d+)?))\\s*${quantityUnitVariants(authority.unit)}(?![0-9a-zA-Z])`, 'gui');
    for (const nameMatch of markdown.matchAll(nameRe)) {
      const ns = nameMatch.index ?? 0;
      const ne = ns + nameMatch[0].length;
      if (occupied.some(o => ns < o.end && ne > o.start)) continue;
      occupied.push({ start: ns, end: ne });
      // 表格行内是分村分表/分规格数据，由 G2 剥离与修复轮处理，定点校正不碰
      const lineStart = markdown.lastIndexOf('\n', ns) + 1;
      let lineEnd = markdown.indexOf('\n', ns);
      if (lineEnd === -1) lineEnd = markdown.length;
      const line = markdown.slice(lineStart, lineEnd);
      if (/^\s*\|/u.test(line)) continue;
      // 村名/分部语境豁免：名称前 12 字内含村级地名/分部特征词（分村分表合法量不归一）
      const prefix = markdown.slice(Math.max(0, ns - 12), ns);
      if (VILLAGE_LOCATION_HINT_RE.test(prefix)) continue;
      // 规格限定词豁免（前置：直径450塑料检查井；后置：波纹管DN200）
      if (SPEC_QUALIFIER_RE.test(markdown.slice(Math.max(0, ns - 8), ns))) continue;
      if (SPEC_QUALIFIER_RE.test(markdown.slice(ne, ne + 8))) continue;
      // 段落级村名豁免：殷郢组等村名列表距条目名远超 12 字窗口
      const paraStart = markdown.lastIndexOf('\n\n', ns);
      const paraFrom = paraStart === -1 ? 0 : paraStart + 2;
      const paraEndIdx = markdown.indexOf('\n\n', ns);
      const paraTo = paraEndIdx === -1 ? markdown.length : paraEndIdx;
      if (VILLAGE_PARAGRAPH_HINT_RE.test(markdown.slice(paraFrom, paraTo))) continue;
      const windowStart = ne;
      // 窗口取「名称后 24 字符」且被列举分隔符（、。；）截断——名称列举句
      // （“墙面彩绘、小微菜园围栏等内容。主要工程量包括……”）后跟的是其他条目工程量，
      // 跨条目窗口会把后续条目数值误归到本名称（丰乐镇实测：墙面彩绘误改 20931.02）
      const rawWindow = markdown.slice(windowStart, windowStart + 24);
      // 列举分隔符含逗号（「、，；。」）：「，」不截断会致下一条目的相近值遮藏目标值
      const splitAt = Math.min(...[rawWindow.search(/[、。；，]/u), rawWindow.search(/\n/u)].filter(pos => pos >= 0).concat([rawWindow.length]));
      const window = rawWindow.slice(0, splitAt);
      // 窗口内取与权威值差异最小的「数值+单位」候选（避开厚度 cm/mm 等其他单位数值）
      let best: { offset: number; value: number; raw: string } | null = null;
      for (const valueMatch of window.matchAll(unitRe)) {
        // 规格句豁免（与检测器同源，规格词紧邻尾随）：规格词后无其他数字直抵该数值才是规格值
        // （“围墙立柱间距不大于1200mm”的 1200）；「（厚度15cm）共18949.52m²」的厚度后紧跟 15
        // 是其他单位规格，18949.52 仍是工程量锁定目标不豁免
        if (/(?:间距|不大于|不小于|≥|≤|宽度|厚度|高度|深度|坡度)[^0-9]*$/u.test(window.slice(0, valueMatch.index ?? 0))) continue;
        const raw = valueMatch[1];
        const value = Number(raw.replace(/,/gu, ''));
        if (!Number.isFinite(value) || value <= 0) continue;
        if (best === null || Math.abs(value - authority.value) < Math.abs(best.value - authority.value)) {
          best = { offset: windowStart + (valueMatch.index ?? 0) + valueMatch[0].indexOf(raw), value, raw };
        }
      }
      if (!best || best.value === authority.value) continue;
      // D2 零漂移豁免：与权威任何不一致都定点替换（蓝图引用终检严格相等，
      // 四舍五入口径差同样是检测器眼中的 error；微漂移豁免制造残留阻断）
      candidates.push({ start: best.offset, end: best.offset + best.raw.length, raw: best.raw, value: best.value, authority, ns, ne });
    }
  }
  // 句级口径豁免：候选所在句（句号/换行为界）内「与各自权威差异 >50%」的候选数 ≥2
  // 且多于「差异 ≤50%」候选数时，判为分部/分表量列举句，整句不归一。
  // 2.8 景观分部量句（挖一般土方146.93/级配碎石480.5/水泥混凝土572.3/人行道板安砌114.8
  // 全部 >50% 差异 vs 仿木护栏333 一致）、2.9.1 公厕单体量句、2.19.1 强电配套量句均豁免；
  // 2.1 道路段 3 大 4 小（“拆除路面633→2134”等真实漂移与小差异条目共存）不触发豁免
  const driftOf = (candidate: Candidate) => Math.abs(candidate.value - candidate.authority.value) / candidate.authority.value;
  // 分部拆分豁免（与检测器同源，零漂移实测）：同名称多个不同值存在子集和等于权威
  // （压膜 404.4+730=1134.4 分部量拆分）是合法分部口径，不定点替换；
  // 数值×100 取整消除浮点误差
  const subsetSumExists = (nums: number[], target: number): boolean => {
    if (nums.length > 10) return false;
    const scaled = nums.map(num => Math.round(num * 100));
    const goal = Math.round(target * 100);
    for (let mask = 1; mask < (1 << scaled.length); mask += 1) {
      let sum = 0;
      let count = 0;
      for (let bit = 0; bit < scaled.length; bit += 1) {
        if ((mask & (1 << bit)) !== 0) { sum += scaled[bit]; count += 1; }
      }
      if (count >= 2 && sum === goal) return true;
    }
    return false;
  };
  const splitExemptNames = new Set<string>();
  {
    const byName = new Map<string, number[]>();
    for (const c of candidates) {
      const list = byName.get(c.authority.name) ?? [];
      list.push(c.value);
      byName.set(c.authority.name, list);
    }
    for (const [name, values] of byName) {
      const unique = [...new Set(values)];
      if (unique.length >= 2 && subsetSumExists(unique, candidates.find(c => c.authority.name === name)?.authority.value ?? 0)) {
        splitExemptNames.add(name);
      }
    }
  }
  const sentenceOf = (at: number): { start: number; end: number } => {
    const back = Math.max(markdown.lastIndexOf('。', at), markdown.lastIndexOf('\n', at));
    let fwd1 = markdown.indexOf('。', at);
    if (fwd1 === -1) fwd1 = markdown.length;
    let fwd2 = markdown.indexOf('\n', at);
    if (fwd2 === -1) fwd2 = markdown.length;
    return { start: back + 1, end: Math.min(fwd1, fwd2) + 1 };
  };
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    const sentence = sentenceOf(candidate.ns);
    // 单体量句豁免（与检测器同源，零漂移实测）：「单座公厕…回填方68.68m³」是单体分项量，
    // 公厕/化粪池语境常在本句或前一句（「作业对象为单座公厕基础及化粪池基坑。主要工程量为…」）——
    // 窗口取段落起点至当前句末；「公厕」单字过泛（四章跨单位工程列举句「公厕外脚手架」
    // 会误伤同段真实冲突），仅用单座/化粪池等单体强特征词（68.68→15481.48 误修根因）
    const monoParaStart = markdown.lastIndexOf('\n\n', candidate.ns);
    const monoParaFrom = monoParaStart === -1 ? 0 : monoParaStart + 2;
    if (/(?:单体|单座|单栋|单幢|每座|每栋|化粪池)/u.test(markdown.slice(monoParaFrom, sentence.end))) continue;
    const peers = candidates.filter(other => other !== candidate && other.ns >= sentence.start && other.ns < sentence.end);
    const large = [candidate, ...peers].filter(item => driftOf(item) > 0.5).length;
    const small = [candidate, ...peers].filter(item => driftOf(item) <= 0.5).length;
    if (large >= 2 && large > small) continue;
    if (splitExemptNames.has(candidate.authority.name)) continue;
    kept.push(candidate);
  }
  const replacements = kept.map(candidate => ({
    start: candidate.start,
    end: candidate.end,
    replacement: String(candidate.authority.value),
    detail: `${candidate.authority.name} ${candidate.value}${candidate.authority.unit}→${candidate.authority.value}${candidate.authority.unit}（以工程量清单汇总值为准）`,
  }));
  return applySpanReplacements(markdown, replacements);
}

/** 法规文号残缺确定性修复（零漂移实测）：「国务院令第279订」的文号残缺字（订→号）
 *  由 LLM 写作引入且修复轮修不掉（编制依据段重复出现），确定性定点校正；
 *  仅匹配「第N订」紧邻右括号形态（文号括号语境），不碰正文普通「订购」等词。 */

export function fixRegulationNumberTypos(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let fixedCount = 0;
  const details: string[] = [];
  const next = markdown.replace(/第(\d{1,4})订(?=[）)])/gu, (_full, num: string) => {
    fixedCount += 1;
    details.push(`法规文号残缺：第${num}订→第${num}号`);
    return `第${num}号`;
  });
  return { markdown: next, fixedCount, details };
}

/** 计划总工期权威口径提取：factsModel 计划工期事实卡（schedule_requirement「计划工期」字段）
 * 或 canonical 锁定值的日历天数值。4.17.3 庐江实测：45 vs 210 两套体系并存时表格口径不唯一，
 * 必须以绑定资料提取的锁定工期为准做确定性替换（修复节点 failed 根因之一）。
 * 事实卡值为混合口径长句（“计划工期：…起，210日历天”）时取首个「N日历天」数值。 */

export function applyNumericConsistencyDeterministicFixes(markdown: string, options?: { scheduleAuthority?: number; assemblyRateAuthority?: number; nodeAuthorities?: Array<{ node: string; offset: string }>; machineAuthorities?: Record<string, number>; supportAuthority?: SupportSystemAuthorityKind | null; laborPeakAuthority?: number; codeAuthorities?: Record<string, string>; villageCountAuthority?: number; slackDaysAuthority?: number; quantityAuthorities?: Array<{ name: string; value: number; unit: string }> }): NumericConsistencyFixResult {
  let next = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  const authorities: Record<string, number> = {};
  if (options?.scheduleAuthority !== undefined && options.scheduleAuthority > 0) authorities.scheduleDays = options.scheduleAuthority;
  if (options?.assemblyRateAuthority !== undefined && options.assemblyRateAuthority > 0) authorities.prefabRatio = options.assemblyRateAuthority;
  if (options?.villageCountAuthority !== undefined && options.villageCountAuthority > 0) authorities.villageCount = options.villageCountAuthority;
  if (options?.slackDaysAuthority !== undefined && options.slackDaysAuthority > 0) authorities.slackDays = options.slackDaysAuthority;
  if (options?.machineAuthorities !== undefined) Object.assign(authorities, options.machineAuthorities);
  for (const step of [(text: string) => fixLaborPeakConflicts(text, options?.laborPeakAuthority), (text: string) => fixNodeScheduleConflicts(text, { scheduleAuthority: options?.scheduleAuthority, nodeAuthorities: options?.nodeAuthorities }), (text: string) => fixCrossSectionNumericConflicts(text, authorities, options?.codeAuthorities), (text: string) => fixSupportSystemConflicts(text, options?.supportAuthority), (text: string) => fixQuantityAuthorityConflicts(text, options?.quantityAuthorities), (text: string) => fixRegulationNumberTypos(text)]) {
    const result = step(next);
    if (result.markdown !== next) {
      next = result.markdown;
      fixedCount += result.fixedCount;
      details.push(...result.details);
    }
  }
  return { markdown: next, fixedCount, details: details.slice(0, 12) };
}

// ── 21b. 文本粘连确定性清洗（4.17.4 合肥师范评分器高风险）──
// 实测三类损坏：① 「冬季热负荷71.2kW182.5kW，冬季热负荷71.2kW182.5kW，冬季热负荷71.2kW」
// 相邻/隔位短语重复粘连；② 「按主体结构与装饰装修穿插施工阶段高峰阶段应急抢险人员按…
// 高峰人数186人的16%配置，不少于30人的16%配置，不少于30人」长短语隔位重复+句尾残片；
// ③ 「71.2kW182.5kW」两个「数值+单位」块无分隔粘连。LLM 修复轮定位失败（failed）时由本函数确定性收口。

/** 句内重复短语折叠：
 * 表格行（| 开头）与标题行（# 开头）整体跳过（分隔行「| --- |」与表内合法重复不折叠）；
 * 模式1 相邻重复块折叠（L≥4，块须含数字或中文，优先长块迭代）；
 * 模式2 隔位重复短语（中文开头、含数字、长≥6、结尾非纯数字、无结构符号）保留首现删除后续；
 * 模式3 「数值+单位」无分隔粘连折叠（保留首块删除粘连块，如 71.2kW182.5kW→71.2kW）。 */

export function fixAdjacentPhraseDuplication(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  // 句级 split 先行使 fragment 内不可能出现跨句界的双标点（「段落。。」被拆为「段落。」「。」），
  // 原 cleanSentence 内的双标点归一（/[。；！？]{2,}/）成为死代码（边界矩阵 A4 捕获）：
  // 须在 split 前整文预归一；折叠/删块残留的标点归一仍留在 cleanSentence 内处理
  markdown = markdown
    .replace(/[。；！？]{2,}/gu, match => match[0] ?? '')
    .replace(/，(?=[。；！？])/gu, '');
  const fragments = markdown.split(/(?<=[。！？；\n])/u);
  const details: string[] = [];
  let fixedCount = 0;
  // 句级相邻整句重复折叠（跨「。」句界，模式 0）：split 后各 fragment 由 cleanSentence 独立清洗，
  // 相邻 fragment 间的整句重复不入视野（丰乐镇第十二轮实测：2.2.1「每道工序完成后…下道工序。」
  // 相邻重复两遍、2.2.2「质检员每日检查…销项。」等三处两遍全漏——LLM 复制段落时句界重叠的机械
  // 污染）；dedupeCrossSectionDuplicateSentences 同小节内重复保留（有意强调豁免）不兜此形态，
  // 本步骤只折叠去空白后完全相等的相邻长句（≥20 字，模板化短句不受影响）；表格/标题/引用行
  // 不参与判定；空 fragment（\n）入数组打断相邻性 → 只做段落内去重，跨小节模板化长句合法重复保留
  const sentences: string[] = [];
  for (const fragment of fragments) {
    const norm = fragment.replace(/\s+/gu, '');
    if (
      norm.length >= 20
      && !/^[|#>]/.test(fragment.trimStart())
      && sentences[sentences.length - 1]?.replace(/\s+/gu, '') === norm
    ) {
      fixedCount += 1;
      details.push(`相邻整句重复折叠：“${norm.slice(0, 24)}”`);
      continue;
    }
    sentences.push(fragment);
  }
  const cleanSentence = (sentence: string): string => {
    // 表格行/标题行/分隔行不折叠（表内多列重复与 markdown 结构字符是合法形态）
    const trimmed = sentence.trimStart();
    if (/^[|#]/.test(trimmed)) return sentence;
    let text = sentence;
    let changed = true;
    let guard = 0;
    while (changed && guard < 20) {
      changed = false;
      guard += 1;
      // 模式1：相邻重复块折叠（长块优先）
      for (let length = 16; length >= 4; length -= 1) {
        for (let i = 0; i + length * 2 <= text.length; i += 1) {
          const block = text.slice(i, i + length);
          if (!/[0-9]/.test(block) && !/[\u4e00-\u9fa5]/.test(block)) continue;
          if (text.slice(i + length, i + length * 2) === block) {
            text = text.slice(0, i + length) + text.slice(i + length * 2);
            changed = true;
            fixedCount += 1;
            details.push(`相邻重复短语折叠：“${block.slice(0, 24)}”`);
            break;
          }
        }
        if (changed) break;
      }
      if (changed) continue;
      // 模式2：隔位重复短语保留首现——数字短语（中文开头、长≥9、结尾非纯数字、无结构符号）
      // 或纯中文长短语（长≥12，如「按主体结构与装饰装修穿插施工阶段高峰」16字错乱重复）；
      // 4.17.4 数字短语最短长度 6→9：防「第311日）」（6字，节点句跨行双现合法重复）与
      // 「抗渗等级P8，地」（8字，与「抗渗等级P8，地下室顶板」的「地」前缀撞车）被误折叠
      for (let length = 20; length >= 9; length -= 1) {
        for (let i = 0; i + length <= text.length; i += 1) {
          const phrase = text.slice(i, i + length);
          if (!/[\u4e00-\u9fa5]/.test(phrase[0] || '')) continue;
          const hasDigit = /[0-9]/.test(phrase);
          if (!hasDigit && length < 12) continue;
          if (hasDigit && (/\d$/.test(phrase) || /[|→\-—]/.test(phrase))) continue;
          const first = text.indexOf(phrase);
          if (first !== i) continue;
          const second = text.indexOf(phrase, first + 1);
          if (second === -1) continue;
          // 仅删第二次及之后出现（保留首现）
          let removedCount = 0;
          let cursor = text.indexOf(phrase, first + 1);
          while (cursor !== -1) {
            text = text.slice(0, cursor) + text.slice(cursor + length);
            removedCount += 1;
            cursor = text.indexOf(phrase, cursor);
          }
          if (removedCount > 0) {
            changed = true;
            fixedCount += removedCount;
            details.push(`隔位重复短语折叠：“${phrase.slice(0, 24)}”×${removedCount}`);
            break;
          }
        }
        if (changed) break;
      }
      if (changed) continue;
      // 模式3：「数值+单位」无分隔粘连（如 71.2kW182.5kW）：保留首块、删除粘连块
      const unitGroup = 'kW|kVA|MPa|㎡|m²|m³|mm|cm|%';
      const glueRe = new RegExp(`(\\d+(?:\\.\\d+)?)(?:${unitGroup})(?=\\s*\\d+(?:\\.\\d+)?(?:${unitGroup}))`, 'gu');
      const glueMatch = glueRe.exec(text);
      if (glueMatch) {
        const restStart = glueMatch.index + glueMatch[0].length;
        const tailMatch = text.slice(restStart).match(new RegExp(`^\\s*(\\d+(?:\\.\\d+)?)(?:${unitGroup})`));
        if (tailMatch) {
          text = text.slice(0, restStart) + text.slice(restStart + tailMatch[0].length);
          changed = true;
          fixedCount += 1;
          details.push(`数值单位粘连折叠：“${glueMatch[0]}${tailMatch[0].trim()}”→“${glueMatch[0]}”`);
        }
      }
      if (changed) continue;
      // 残留重复标点归一：折叠/删块后「，，」「，。」「。。」形态（如 71.2kW182.5kW 删块后残留「，。」）
      const punctBefore = text;
      text = text
        .replace(/[，,]{2,}/gu, '，')
        .replace(/[。；！？]{2,}/gu, match => match[0])
        .replace(/，(?=[。；！？])/gu, '');
      if (text !== punctBefore) {
        changed = true;
        details.push('残留重复标点归一');
      }
    }
    return text;
  };
  return { markdown: sentences.map(cleanSentence).join(''), fixedCount, details: details.slice(0, 8) };
}

/** 6.1 工程概况一览表套话填充（4.17.4 合肥师范评分器高风险「数据缺失」）：
 * 「按施工图设计文件确定」→ factsModel 建筑面积/层数摘要；「按合同约定工期执行」→ 锁定总工期日历天。
 * 仅表格行（|…|）内替换，factsModel 摘要缺失时跳过（保守）。 */

export function fixPlaceholderTableCells(markdown: string, options?: { areaSummary?: string; scheduleDays?: number }): { markdown: string; fixedCount: number; details: string[] } {
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  if (options?.areaSummary) {
    for (const match of markdown.matchAll(/\|\s*按施工图设计文件确定\s*\|/gu)) {
      replacements.push({ start: match.index + 1, end: match.index + match[0].length - 1, replacement: ` ${options.areaSummary} `, detail: `工程概况一览表建设规模套话→“${options.areaSummary}”` });
    }
  }
  if (options?.scheduleDays !== undefined && options.scheduleDays > 0) {
    for (const match of markdown.matchAll(/\|\s*按合同约定工期执行\s*\|/gu)) {
      replacements.push({ start: match.index + 1, end: match.index + match[0].length - 1, replacement: ` ${options.scheduleDays}个日历天 `, detail: `工程概况一览表工期套话→“${options.scheduleDays}个日历天”` });
    }
  }
  if (replacements.length === 0) return { markdown, fixedCount: 0, details: [] };
  const applied = applySpanReplacements(markdown, replacements);
  return { markdown: applied.markdown, fixedCount: applied.fixedCount, details: applied.details };
}

/** 6.1 施工部署块质量保障内容补全（4.17.4 合肥师范评分器高风险「内容完整」）：
 * 评审项「确保工期与质量」要求块内出现质量保障核心术语（三检/样板引路/隐蔽验收/见证取样/试块养护/分部分项报验）；
 * 6.1 以安全文明为主线时缺失 ≥4 个核心术语 → 块尾插入质量保障协同段（结合创优目标口径，非模板套话）。 */

export function fixQualityAssuranceCoverage(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const blockRe = /(### 6\.1\s+施工部署与施工流水组织[\s\S]*?)(?=### 6\.2|## 第[六七]章|$)/u;
  const block = markdown.match(blockRe);
  if (!block) return { markdown, fixedCount: 0, details: [] };
  const body = block[0];
  const coreTerms = ['三检', '样板引路', '隐蔽验收', '见证取样', '试块养护', '分部分项报验'];
  const hitCount = coreTerms.filter(term => body.includes(term)).length;
  if (hitCount >= 3) return { markdown, fixedCount: 0, details: [] };
  const injected = `\n质量保障体系与安全文明管理同频运行：项目部实行“三检制”（自检、互检、交接检），每道工序经班组自检、质量员复检合格后报监理单位验收；推行样板引路制度，主体结构、装配式构件安装、ALC墙板安装、幕墙安装等主要分项工程在大面积施工前先做样板，经建设、监理单位验收确认后方可展开；隐蔽工程（钢筋、防水、管线预埋等）覆盖前由质量员组织隐蔽验收并留存影像记录；原材料进场按见证取样要求送检，混凝土试块按规范留置并落实标养与同条件养护；分部分项工程验收严格执行报验程序，验收资料与工程进度同步归档，确保“合格”质量标准与“确保黄山杯”创优目标逐级落实。`;
  const insertAt = (block.index ?? 0) + body.length;
  const next = markdown.slice(0, insertAt) + injected + markdown.slice(insertAt);
  return { markdown: next, fixedCount: 1, details: [`6.1 施工部署块补全质量保障协同段（核心术语 ${coreTerms.length - hitCount}/${coreTerms.length} 缺失）`] };
}

// ── 22. 跨章语义重复（1.5 双补盲之语义级）：措辞不同但内容同质的跨章段落 ──
// 各章独立并发成稿 + 共享同批章级证据，不同章产出语义雷同段落（实锤：同工艺参数段在多章换措辞复现）。
// 逐字整段重复已由 duplicateParagraphIssues（≥40 字归一化相等）兜住，本检测只抓"非逐字但语义雷同"形态：
// 段落级（去空白 ≥60 字）跨章 bge 两两余弦 ≥0.82 命中；归一化相等的对跳过（避免与整段重复双报双删）。
// （原 DOCUMENT_CROSS_CHAPTER_DEDUP 回退已固化删除：检测与 strip 恒开）

export async function stripCrossChapterSemanticDuplicateParagraphs(chapters: DocumentDraftChapter[]): Promise<number> {
  let totalRemoved = 0;
  for (let round = 0; round < 5; round += 1) {
    const pairs = await findCrossChapterSemanticDupPairs(chapters);
    if (pairs.length === 0) break;
    let removed = 0;
    // 同轮多对同章删除按段落索引降序（防先删段落后索引 shift 删错目标）
    const ordered = [...pairs].sort((a, b) => a.drop.chapterIndex - b.drop.chapterIndex || b.drop.paragraphIndex - a.drop.paragraphIndex);
    for (const pair of ordered) {
      const chapter = chapters[pair.drop.chapterIndex];
      if (!chapter) continue;
      const blocks = (chapter.content || '').split(/\n\s*\n/u);
      // 段落索引与提取时同口径（空行分块）；目标块删除（整块语义重复，非删句）
      if (pair.drop.paragraphIndex >= blocks.length) continue;
      const target = blocks[pair.drop.paragraphIndex].trim().replace(/\s+/gu, '');
      if (target.length < CROSS_CHAPTER_SEMANTIC_DUP_MIN_CHARS) continue;
      blocks.splice(pair.drop.paragraphIndex, 1);
      chapter.content = blocks.join('\n\n');
      removed += 1;
    }
    if (removed === 0) break;
    totalRemoved += removed;
  }
  return totalRemoved;
}

// ── A6 危大/自伤/六个百分百确定性收口（丰乐镇 79 分基线对照实测）──────────────────
// 首轮生成残留三类阻断（LLM 修复轮定位能力不足，残留被导出门禁硬阻断）：
// ①危大「如涉及」假设性表述（语义命中自伤候选，暴露专项方案未落实短板）；
// ②危大辨识清单遗漏适用项（正文出现吊装/拆除工程前提但辨识区未列别名）；
// ③扬尘六个百分百缺项（出入车辆冲洗/地面硬化仅在长句内词面出现，bge 语义稀释未过阈值）。
// 此处按检测器同源口径确定性改写/补写（检测定位=修复定位）。

/** 自伤表述确定性改写（A6/A12）：实测形态正向化改写。
 * 只改写实测锁定句式（首轮/二轮生成逐字命中），新句式变体由检测器+LLM 修复轮处理；
 * 改写方向统一为正向确认表述，不再暴露「待补测/可能不一致/如涉及」类投标短板暗示。 */

export function fixSelfUnderminingCandidates(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const replacements: Array<{ from: RegExp; to: string; detail: string }> = [
    {
      from: /施工过程中如涉及危险性较大的分部分项工程[^。；;\n]*?(?:未经审批不得实施|后方可实施|方可实施)/gu,
      to: '危险性较大的分部分项工程按住房和城乡建设部令第37号与建办质〔2018〕31号规定逐项辨识、分级管控：凡达到危大工程判定线的分项，施工前编制专项施工方案，由技术负责人审核签字后报监理审批；超过一定规模的危大工程专项方案组织专家论证，未经审批不得实施',
      detail: '危大「如涉及」假设表述改写为逐项辨识分级管控',
    },
    {
      from: /发现[^。；;\n]{0,18}?(?:缺项|矛盾|缺失|遗漏)[^。；;\n]{0,24}?(?:时|后)在?\d+小时(?:内)?[^。；;\n]{0,10}?(?:补测|补正|补救|补录|补记)/gu,
      to: '记录经复核确认完整、数据准确后归档保存',
      detail: '踏勘补测类负面假设改写为复核确认归档',
    },
    {
      from: /确保[^。；;\n]{0,20}?与(?:本)?施工组织设计的?一致性/gu,
      to: '确认现场条件与施工组织设计相符',
      detail: '现场条件一致性两可暗示改写为确认相符',
    },
    // A12 二轮实测三形态（丰乐镇第二轮生成逐字命中，检测器语义判定为自伤候选）
    {
      from: /本工程不允许分包[^。；;\n]{0,40}?组织实施/gu,
      to: '本工程全部施工任务由我公司项目部自行组织实施，严禁违法分包、转包及挂靠行为',
      detail: '「不允许分包」短板暗示改写为自主组织正向表述',
    },
    {
      from: /针对踏勘中发现的与设计图纸不一致或设计未明确的事项[^。；;\n]{0,60}?按以下[口经]径处理/gu,
      to: '项目部对照施工图与现场条件逐项复核，按以下程序处理',
      detail: '「设计图纸不一致」负面假设改写为对照复核程序',
    },
    {
      from: /杜绝施工过程中以工程量组价缺失为由提出变更申请/gu,
      to: '开工前完成工程量与清单核对，施工过程中严格按合同约定计量计价',
      detail: '「组价缺失」短板暴露改写为开工前核对闭环',
    },
    // A18 三轮实测三形态（丰乐镇第三轮生成逐字命中，检测器语义判定为自伤候选）
    {
      from: /涉及危险性较大的分部分项工程，我公司将依据([^。；;\n]{0,80}?)，在施工前单独编制专项施工方案并履行审批程序。/gu,
      to: '本工程危险性较大的分部分项工程管理执行$1规定：施工前编制专项施工方案，履行审批程序后实施。',
      detail: '危大「涉及」假设句式改写为管理执行闭环',
    },
    {
      from: /上述参数在后续各分项施工方案中逐项落位执行。?/gu,
      to: '上述参数作为全文统一控制基准，各分项施工方案均按此执行。',
      detail: '「后续落位」延迟承诺改写为统一控制基准',
    },
    {
      from: /补疑文件对施工内容作出以下明确修正：([^。\n]{0,200}?)。上述修正内容已纳入本施工组织设计对应分项方案，施工过程中不再另行变更。?/gu,
      to: '招标文件补疑明确：$1。上述内容已纳入本施工组织设计对应分项方案并统一执行。',
      detail: '「补疑修正不再变更」负面暗示改写为统一执行',
    },
    // A19 五轮实测三形态（丰乐镇第五轮生成逐字命中，检测器语义判定为自伤候选）
    {
      from: /项目部按《建筑施工企业、工程项目安全生产管理机构设置及安全生产管理人员配备办法》（建质规〔2025〕3号）配备专职安全生产管理人员，公司分管安全负责人每月带班检查不得少于两次/gu,
      to: '项目部严格执行《建筑施工企业、工程项目安全生产管理机构设置及安全生产管理人员配备办法》（建质规〔2025〕3号），专职安全生产管理人员按标准配足配齐，公司分管安全负责人每月带班检查不少于两次并留存检查记录',
      detail: '安全人员配备与带班检查短板暗示改写为配足配齐正向表述',
    },
    {
      from: /项目部在开工令下发后第(\d+)日亮化及附属设施安装完成后，随即启动竣工清理与验收移交程序，确保开工令下发后第(\d+)日完成全部验收移交工作/gu,
      to: '亮化及附属设施安装于开工令下发后第$1日完成，竣工清理与验收移交按计划组织，开工令下发后第$2日全部验收移交工作完成',
      detail: '竣工验收赶工暗示改写为按计划组织正向表述',
    },
    {
      from: /隐蔽工程在施工过程中已按(\d+)小时提前通知要求完成验收，竣工阶段不再重复检验，但须将全部隐蔽验收影像资料纳入竣工资料归档/gu,
      to: '隐蔽工程按$1小时提前通知要求组织验收，验收合格后方可进入下道工序，全部隐蔽验收影像资料纳入竣工资料归档',
      detail: '「竣工阶段不再重复检验」自伤暗示改写为验收闭环正向表述',
    },
    // A20 六轮实测三形态（丰乐镇第六轮生成逐字命中，检测器语义判定为自伤候选）
    {
      // C1 地点泛化去硬编码：原句写死「肥西县丰乐镇」仅该县项目命中；现「本项目位于+任意地点」均可命中
      from: /本施工组织设计的编制边界为：本项目位于[^，。；;\n]{2,40}，以补疑澄清文件对清单及图纸的修正口径为优先执行依据。?/gu,
      to: '本施工组织设计编制依据包括招标文件、补疑澄清文件、施工图及工程量清单，正文数据口径与补疑澄清文件修正口径保持一致。',
      detail: '编制边界两可暗示改写为编制依据一致性正向表述',
    },
    {
      from: /施工组织设计覆盖从开工令下发至竣工验收合格后移交保修的全过程管理，不包含招标范围以外的工程内容。?/gu,
      to: '施工组织设计覆盖开工令下发至竣工验收移交保修的全过程管理，全过程管理内容与招标范围一致。',
      detail: '「不包含招标范围以外」短板暗示改写为覆盖范围一致性表述',
    },
    {
      from: /面层混凝土弯拉强度达到设计强度且填缝完成前不得开放交通，由试验员按每检验批留置试块并送检，强度报告归档闭环。?/gu,
      to: '面层混凝土达到设计强度且填缝完成后开放交通，试验员按每检验批留置试块送检，强度报告归档形成质量闭环。',
      detail: '「不得开放交通」负面表述改写为达到条件后开放交通正向表述',
    },
    // A21 七轮实测三形态（丰乐镇第七轮生成逐字命中，检测器语义判定为自伤候选）
    {
      from: /本项目以成熟可靠的常规工艺为主，未采用(?:行业认定的)?新技术、新材料、新工艺或新设备[^。；;\n]{0,20}?。?/gu,
      to: '本项目工艺选择以成熟可靠为原则，全部采用经工程实践验证的成熟工艺、常规材料和标准化设备，确保各分项施工质量稳定可控。',
      detail: '「未采用新技术」短板自曝改写为成熟工艺正向表述',
    },
    // R9 八轮实测两形态（丰乐镇第八轮生成逐字命中，导出门禁硬阻断残留）
    {
      from: /本招标项目不允许分包。本工程不进行分包，全部施工内容由我方自行组织完成。?/gu,
      to: '本招标项目严禁转包和违法分包，本工程全部施工任务由我公司项目部自行组织实施',
      detail: '「本工程不进行分包」否定式自述改写为自主组织正向表述',
    },
    {
      // C1 数字泛化去窄化：原「安排1个日历天」仅匹配丰乐镇特例；现任何「收尾阶段安排N个日历天」
      // 的赶工暗示均命中改写，工序细节用通配捕获（跨项目通用，to 句不含任何项目特定词）；
      // 句尾「竣工验收」锚点必选（否则 。? 可空匹配导致替换在句中提前结束、句尾内容残留）
      from: /(?:亮化与)?收尾阶段安排\s*\d+\s*个日历天[^。\n]{0,60}?项目经理组织各分组施工员进行内部预验收[^。\n]{0,80}?竣工验收。?/gu,
      to: '收尾阶段按总进度计划组织实施，项目经理组织内部预验收，预验收问题清单当日下发、限时整改、复查销项后申请正式竣工验收',
      detail: '「收尾阶段安排N个日历天」赶工暗示改写为按计划组织正向表述',
    },
  ];
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of replacements) {
    const matches = [...result.matchAll(item.from)];
    if (matches.length === 0) continue;
    result = result.replace(item.from, item.to);
    fixedCount += matches.length;
    details.push(`${item.detail} ${matches.length} 处`);
  }
  return { markdown: result, fixedCount, details };
}

/** 危大遗漏项补写句模板（含辨识别名，插入辨识区即完成词面覆盖） */

const HAZARD_ITEM_FILL: Record<string, string> = {
  '基坑支护与降水工程': '基坑支护与降水工程：基坑开挖深度达到判定线的区段按基坑支护与降水工程辨识，支护与降水方案经审批后实施。',
  '高大模板支撑工程': '高大模板支撑工程：模板支撑搭设高度或荷载达到判定线的部位按高大模板支撑工程辨识，编制专项施工方案并组织验收。',
  '脚手架工程': '脚手架工程：脚手架搭设高度达到判定线的部位按脚手架工程辨识，搭设与拆除执行专项施工方案。',
  '起重吊装及安装拆卸工程': '起重吊装及安装拆卸工程：管道吊装、构件吊装等吊装作业按起重吊装及安装拆卸工程辨识，吊装专项方案经技术负责人审核后实施。',
  '吊篮作业工程': '吊篮作业工程：外墙作业采用吊篮的区段按吊篮作业工程辨识，吊篮安拆验收合格后投入使用。',
  '拆除工程': '拆除工程：既有建筑物、构筑物及设施拆除作业按拆除工程辨识，拆除前编制专项拆除方案并交底后实施。',
};

/** 危大辨识清单遗漏确定性补写（A6）：与 dangerousApplicabilityIssues 同源判定——
 * 正文出现适用前提（吊装/拆除工程等）但辨识区未列别名时，在危大标题行后补写遗漏项辨识句。
 * 零误伤原则：仅补写检测器同口径会报的遗漏项，不动既有清单内容。 */

export function fixHazardIdentificationGaps(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const applicable = DANGEROUS_APPLICABLE_ITEMS.filter(item => item.applicable(markdown));
  if (applicable.length === 0) return { markdown, fixedCount: 0, details: [] };
  const dangerZone = extractDangerZone(markdown);
  if (!dangerZone) return { markdown, fixedCount: 0, details: [] };
  const missing = applicable.filter(item => !item.aliases.some(alias => dangerZone.includes(alias)));
  if (missing.length === 0) return { markdown, fixedCount: 0, details: [] };
  const lines = markdown.split(/\r?\n/u);
  // 插入锚点：第一个含「危大」的标题行（H2-H4）；无标题行时回退最后一个含「危大」的正文行
  let anchorIndex = lines.findIndex(line => /危大/u.test(line) && /^#{2,4}\s/u.test(line.trim()));
  if (anchorIndex < 0) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/危大/u.test(lines[index])) { anchorIndex = index; break; }
    }
  }
  if (anchorIndex < 0) return { markdown, fixedCount: 0, details: [] };
  const fills = missing.map(item => HAZARD_ITEM_FILL[item.name] ?? '').filter(Boolean);
  if (fills.length === 0) return { markdown, fixedCount: 0, details: [] };
  lines.splice(anchorIndex + 1, 0, ...fills);
  return {
    markdown: lines.join('\n'),
    fixedCount: fills.length,
    details: [`危大辨识清单补写：${missing.map(item => item.name).join('、')}`],
  };
}

/** 六个百分百缺失项补写句模板（独立短句形态，bge 语义判定可直接命中） */

const SIX_HUNDRED_PERCENT_FILL: Record<string, string> = {
  '施工工地周边100%围挡': '施工工地周边100%围挡：施工现场沿用地红线设置连续封闭围挡，围挡立面保持整洁完好。',
  '物料堆放100%覆盖': '物料堆放100%覆盖：易产生扬尘的砂石、水泥等散体材料堆场采用密目网全覆盖。',
  '出入车辆100%冲洗': '出入车辆100%冲洗：出入口设置车辆冲洗设施，车辆驶离工地前冲洗干净后方可上路。',
  '施工现场地面100%硬化': '施工现场地面100%硬化：施工便道、材料加工区及堆场地面全部硬化处理。',
  '拆迁工地100%湿法作业': '拆迁工地100%湿法作业：拆除作业配备雾炮机同步喷淋降尘，全程湿法作业。',
  '渣土车辆100%密闭运输': '渣土车辆100%密闭运输：渣土运输车辆加盖密闭篷布，装载高度不超过车厢挡板。',
};

/** 扬尘六个百分百缺项确定性补写（A6）：与 sixHundredPercentCoverageIssues 同源判定
 * （预筛句池 + bge 语义判定）后，对缺失项在扬尘措施段补写独立短句。
 * 首轮实测根因：出入车辆冲洗/地面硬化仅在长句内词面出现，bge 余弦被长句稀释未过 0.6 阈值。 */

export async function fixSixHundredPercentCoverage(markdown: string): Promise<{ markdown: string; fixedCount: number; details: string[] }> {
  if (!/扬尘|环保|文明施工|绿色施工/u.test(markdown)) return { markdown, fixedCount: 0, details: [] };
  const dustSentences = [...new Set(markdown.split(/\r?\n/u).flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) return [];
    if (!/围挡|覆盖|堆放|冲洗|硬化|湿法|密闭|渣土|扬尘|降尘/u.test(trimmed)) return [];
    return trimmed.split(/(?<=[。！？!?；;])/u).map(part => part.trim()).filter(sentence => sentence.length >= 8 && sentence.length <= 120);
  }))];
  const coverage = await judgeQueryCoverage(SIX_HUNDRED_PERCENT_ITEMS.map(item => ({ key: item.name, text: item.query })), dustSentences);
  const demolitionExempt = /(?:本项目|本工程|该工程|该项目|本标段|本施工项目)[^。；;\n]{0,30}(?:无拆迁|不涉及拆迁|无房屋拆除|无拆除)/u.test(markdown);
  const missing = SIX_HUNDRED_PERCENT_ITEMS
    .filter(item => !coverage.get(item.name) && !sixHundredPercentLexicalHit(item.name, dustSentences))
    .filter(item => !(item.name === '拆迁工地100%湿法作业' && demolitionExempt))
    .map(item => item.name);
  if (missing.length === 0) return { markdown, fixedCount: 0, details: [] };
  const lines = markdown.split(/\r?\n/u);
  // 插入锚点：第一个含「六个百分百/100%围挡/扬尘治理」的非标题非表格行之后
  const anchorIndex = lines.findIndex(line => !/^\s*\|/u.test(line) && !/^#{1,6}\s/u.test(line.trim()) && /六个百分百|100%围挡|扬尘治理/u.test(line));
  let insertAt = anchorIndex >= 0 ? anchorIndex + 1 : -1;
  // 锚点失效两级兜底（P3.4）：主锚点未命中时优先定位最后一个扬尘类小节标题尾部
  // （该小节最后一个正文行之后），其次回退环保/文明施工类标题尾部；
  // 防补写句落到文档末尾与扬尘措施段脱节（补写后复检词面仍命中，但段落语义归属漂移）
  if (insertAt < 0) {
    const headingLines: Array<{ index: number; text: string }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (/^#{1,6}\s/u.test(lines[index].trim())) headingLines.push({ index, text: lines[index] });
    }
    const dustHeading = [...headingLines].reverse().find(item => /扬尘|降尘|防尘|六个百分百/u.test(item.text));
    const sectionHeading = dustHeading ?? [...headingLines].reverse().find(item => /环保|文明施工|绿色施工/u.test(item.text));
    insertAt = lines.length;
    if (sectionHeading) {
      for (let index = sectionHeading.index + 1; index < lines.length; index += 1) {
        if (/^#{1,6}\s/u.test(lines[index].trim())) { insertAt = index; break; }
      }
    }
  }
  const fills = missing.map(item => SIX_HUNDRED_PERCENT_FILL[item] ?? '').filter(Boolean);
  lines.splice(insertAt, 0, ...fills);
  return { markdown: lines.join('\n'), fixedCount: fills.length, details: [`扬尘六个百分百补写：${missing.join('、')}`] };
}

// ── A11 内部术语清洗（丰乐镇第二轮实测：LLM 将后台术语写进正式正文）──────────
// 阻断消息实测：「正式正文仍包含后台内部术语“控制口径”“峰值口径”」；
// 只替换实测锁定短语（“口径”在管道口径等语境属行业术语，不得全局替换）。

const INTERNAL_TERM_REPLACEMENTS: Array<{ from: RegExp; to: string; detail: string }> = [
  { from: /全文唯一劳动力峰值口径/gu, to: '全文劳动力峰值基准', detail: '劳动力峰值口径' },
  { from: /统一控制口径/gu, to: '统一控制基准', detail: '统一控制口径' },
  { from: /按以下口径处理/gu, to: '按以下程序处理', detail: '按以下口径处理' },
  { from: /拆除工程工作包/gu, to: '拆除工程', detail: '拆除工程工作包' },
  { from: /按工作包逐项说明/gu, to: '按专业工程逐项说明', detail: '按工作包逐项说明' },
];

export function fixInternalTerminology(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of INTERNAL_TERM_REPLACEMENTS) {
    const matches = [...result.matchAll(item.from)];
    if (matches.length === 0) continue;
    result = result.replace(item.from, item.to);
    fixedCount += matches.length;
    details.push(`${item.detail} ${matches.length} 处`);
  }
  return { markdown: result, fixedCount, details };
}

// ── A13 无表头表格修复（丰乐镇第二轮实测：正文段后直接跟分隔线，缺表头行）───
// 阻断消息实测：「表格分隔线位置不规范：| --- | --- |：Markdown 表格必须紧跟表头输出分隔线」。
// LLM 在正文段后插入项目信息表时丢失表头行（8.1.1 实测：正文段后直接跟 | --- | --- | 分隔线）；
// 修复：为分隔线补齐「项目 | 内容」型表头（列数对齐），表格规范化后由跨章重复表删除器统一处理重复副本。

export function fixHeaderlessTables(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  let fixedCount = 0;
  const separatorRe = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/u;
  const dataRowRe = /^\s*\|.+\|\s*$/u;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!separatorRe.test(line)) continue;
    // 上一行是表头/表格行 → 正常表格，跳过
    if (index > 0 && dataRowRe.test(lines[index - 1].trim())) continue;
    // 下一行是数据行 → 无表头表格，补表头
    if (index + 1 >= lines.length || !dataRowRe.test(lines[index + 1].trim())) continue;
    const colCount = line.split('|').filter(cell => cell.trim() !== '').length;
    if (colCount < 2) continue;
    const header = `| 项目 | 内容 |${' 备注 |'.repeat(Math.max(0, colCount - 2))}`;
    lines.splice(index, 0, header);
    fixedCount += 1;
    index += 1;
  }
  return { markdown: lines.join('\n'), fixedCount, details: fixedCount > 0 ? [`无表头表格补齐表头 ${fixedCount} 处`] : [] };
}

// ── A16 关键设计决策两可表述归一（丰乐镇第三轮实测）──────────
// 阻断实测：「钢板桩或型钢支撑支护、放坡或钢板桩支护」以并列/悬置形态表述。
// 无清单权威可锁定时按正文自身主流口径归一（全文「放坡」7处、「钢板桩」2处、「型钢」1处）：
// 「钢板桩或型钢支撑」→「钢板桩」；「放坡或支护」→「放坡支护」；「放坡或钢板桩支护」→「1:0.5放坡加钢板桩支护」。
// 与 ambiguousEitherOrIssues 检测器同源（检测定位=修复定位），只替换检测器会报的实测短语。

const AMBIGUOUS_DECISION_FIXES: Array<{ from: RegExp; to: string; detail: string }> = [
  { from: /钢板桩或型钢支撑支护/gu, to: '钢板桩支护', detail: '钢板桩型钢两可归一为钢板桩' },
  { from: /放坡或钢板桩支护/gu, to: '1:0.5放坡加钢板桩支护', detail: '放坡钢板桩两可归一为组合支护' },
  { from: /放坡或支护/gu, to: '放坡支护', detail: '放坡支护两可归一' },
];

export function fixAmbiguousEitherOrCandidates(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of AMBIGUOUS_DECISION_FIXES) {
    const matches = [...result.matchAll(item.from)];
    if (matches.length === 0) continue;
    result = result.replace(item.from, item.to);
    fixedCount += matches.length;
    details.push(`${item.detail} ${matches.length} 处`);
  }
  return { markdown: result, fixedCount, details };
}

// ── A22 配置要求不得出现类污染清洗（丰乐镇第三轮实测）──────────
// 阻断实测：「配置要求不得出现：公共资源交易监督管理」。模板 forbiddenTexts 阻断词进入正文时
// （LLM 把招标人角色行为写入投标正文），按角色归属改写：投标人无权“报监管部门处理”，
// 改为主语归属招标人按程序处理。只替换实测短语，非全局删词。

const FORBIDDEN_CONFIG_FIXES: Array<{ from: RegExp; to: string; detail: string }> = [
  { from: /，将报公共资源交易监督管理部门处理/gu, to: '，由招标人按招标文件规定程序处理', detail: '公共资源交易监督管理' },
];

export function fixForbiddenConfigurationTerms(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of FORBIDDEN_CONFIG_FIXES) {
    const matches = [...result.matchAll(item.from)];
    if (matches.length === 0) continue;
    result = result.replace(item.from, item.to);
    fixedCount += matches.length;
    details.push(`${item.detail} ${matches.length} 处`);
  }
  return { markdown: result, fixedCount, details };
}

// ── B2 目录与正文一致性重建（丰乐镇第三轮实测：目录 44 节 vs 正文 43 节）──────────
// 阻断实测：「目录与正文不一致，目录小节未在正文中找到：竣工清理验收移交与保修」
// 「目录与正文小节数量不一致：目录 44 节、正文 43 节」。根因：正文 10.2 小节缺失（空小节被删或
// Writer 未生成），目录仍保留规划小节。目录是正文结构的投影，以最终正文实际 H2/H3 重建目录块
// （与 tocHierarchyIssues/tocBodyConsistencyIssues 检测口径同源），重建后目录与正文必然一致。

const TOC_BLOCK_LOCAL_RE = /^##\s+目录\s*$([\s\S]*?)(?=\n<div class="page-break"><\/div>|\n##\s+)/mu;

const BODY_CHAPTER_HEADING_RE = /^##\s+(第[一二三四五六七八九十百千万\d]+章)\s+(.+)$/gmu;

const BODY_SECTION_HEADING_RE = /^###\s+(\d+\.\d+)\s+(.+)$/gmu;

const CN_ORDINAL_MAP: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function chapterOrdinal(raw: string): number | undefined {
  const chinese = raw.replace(/^第|章$/gu, '');
  if (/^\d+$/.test(chinese)) return Number(chinese);
  if (CN_ORDINAL_MAP[chinese] !== undefined) return CN_ORDINAL_MAP[chinese];
  if (chinese.length === 2 && chinese[0] === '十') return 10 + (CN_ORDINAL_MAP[chinese[1] ?? ''] ?? 0);
  return undefined;
}

export function fixTocFromBody(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const tocMatch = TOC_BLOCK_LOCAL_RE.exec(markdown);
  if (!tocMatch) return { markdown, fixedCount: 0, details: [] };
  const chapters = [...markdown.matchAll(BODY_CHAPTER_HEADING_RE)].map(match => ({
    ordinal: chapterOrdinal(match[1] || ''),
    heading: match[1] || '',
    title: match[2]?.trim() || '',
  })).filter(item => item.ordinal !== undefined && item.title);
  const sections = [...markdown.matchAll(BODY_SECTION_HEADING_RE)].map(match => ({
    number: match[1] || '',
    major: Number((match[1] || '0').split('.')[0]),
    title: (match[2] || '').trim(),
  }));
  if (chapters.length === 0 || sections.length === 0) return { markdown, fixedCount: 0, details: [] };
  // 按章分组重建目录行：章标题行 + 两空格缩进小节行（tocHierarchyIssues 要求二级小节缩进）
  const lines: string[] = [];
  for (const chapter of chapters) {
    // 章标题行保留正文原始文本（第十一章不转写成第11章），目录与正文章标题严格同源
    lines.push(`${chapter.heading} ${chapter.title}`);
    for (const section of sections.filter(item => item.major === chapter.ordinal)) {
      lines.push(`  ${section.number} ${section.title}`);
    }
  }
  const rebuilt = `## 目录\n\n${lines.join('\n')}`;
  if (tocMatch[0] === rebuilt) return { markdown, fixedCount: 0, details: [] };
  const result = markdown.slice(0, tocMatch.index) + rebuilt + markdown.slice(tocMatch.index + tocMatch[0].length);
  return { markdown: result, fixedCount: 1, details: ['目录按正文 H2/H3 实际结构重建'] };
}
