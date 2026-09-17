/**
 * integrity/fixers：确定性修复器组（P4 拆分，逐字机械搬移自 documentIntegrityChecks.ts）。
 * 依赖 detectors/authorities（SURFACE_FIX_STEPS 注册表锚定侧）。
 */
import { normalizeSubsectionTitleForDedup, workPackageThemeLabel } from '../../utils';
import { MARKDOWN_TABLE_DIVIDER_RE, MARKDOWN_TABLE_ROW_RE } from '../../../constants';
import { PEAK_LABOR_RE, PILE_SUPPORT_LITERAL_RE, SLOPE_SUPPORT_LITERAL_RE, cnNumberToArabic, laborPeakStageOf, tablePeakLabor } from '../authorities/authorities';
import type { SupportSystemAuthorityKind } from '../authorities/authorities';
import { locateDecisionOptionAnchor, matchDecisionCategory } from '../../integratedBlueprint';
import type { DecisionLockEntry, QuantityConflictAnchor } from '../../integratedBlueprint';
import { COMMERCIAL_RATE_RE, COMMERCIAL_TERM_RE, CROSS_SECTION_ANCHORS, CROSS_SECTION_ANCHOR_ENTITY_RE, ENUMERATION_VALUE_RE, FINISH_THICKNESS_CONTEXT_WORD, LABOR_COUNT_RE, META_DECLARATION_RE, NEGATIVE_DECLARATION_RE, PARAGRAPH_START_RE, REPEATED_WORD_RE, SCHEDULE_NODE_ANCHORS, ambiguousEitherOrIssues, cellCoverage, extractMarkdownTables, jaccard, laborGroupOf, locationGroupForMatch, PARAGRAPH_TAIL_REPEAT_MIN_CHARS, paragraphFingerprint, scanCollisionNumberedHeadings, scanEquipmentBatchConflicts, scanInvertedDateRanges, scanPhaseLaborClaims, scanUncoveredEngineeringHeadings, splitConcatenatedPhaseName, textCellsOf } from '../detectors/detectors';
import type { AuthorityDomain, AuthorityIndex } from '../../authorityIndex';

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
    // 4.32 扩围（丰乐镇复测 #54/55 标点叠用残留）：「提升泵参数为H=5.5m、。沟渠系统」
    // 「型号H=5.5m、，进场时核验」——顿号后接句读标点是括号补注删除后的拼接残留，
    // 确定性收敛：保留后一标点（顿号语义被后续句读覆盖）
    [/、。/gu, '。'],
    [/、；/gu, '；'],
    [/、，/gu, '，'],
    [/，、/gu, '，'],
    [/；、/gu, '；'],
    [/。{2,}/gu, '……'],
  ];
  let result = markdown;
  let fixedCount = 0;
  for (const [re, to] of steps) {
    const before = result;
    result = result.replace(re, to);
    fixedCount += (before.match(new RegExp(re.source, 'gu')) || []).length;
  }
  // r15 丰乐镇 B2 归因：段落行以分号收尾且下一行为列表项（编号/项目符号）——分号在承启列表处
  // 属标点错用（合规形态为句号收句或冒号引导），检测器 softWrapped 软换行豁免要求下一行为
  // 普通正文，该形态未被豁免必判截断 blocker；确定性收敛：行尾「；」改「。」（仅改标点不改
  // 字词，语义无损、幂等；列表行本身以分号收尾属合法形态、行尾冒号引导列表由检测器
  // listLeadInColon 豁免，两者均不在本修复范围）
  const listLineRe = /^(?:[-*+]\s+|[（(]?\d+[）).、]\s*)/u;
  const sentenceLines = result.split('\n');
  let tailFixed = 0;
  for (let index = 0; index < sentenceLines.length - 1; index += 1) {
    const line = sentenceLines[index];
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s+/u.test(trimmed) || /^\s*\|/u.test(trimmed) || listLineRe.test(trimmed)) continue;
    if (!/[；;]$/u.test(trimmed)) continue;
    const next = sentenceLines[index + 1].trim();
    if (!next || !listLineRe.test(next)) continue;
    sentenceLines[index] = line.replace(/[；;]\s*$/u, '。');
    tailFixed += 1;
  }
  if (tailFixed > 0) {
    result = sentenceLines.join('\n');
    fixedCount += tailFixed;
  }
  if (result === markdown) return { markdown, fixedCount: 0, details: [] };
  return { markdown: result, fixedCount, details: [`截断句残留清洗 ${fixedCount} 处`] };
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
  // eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
  result = result.replace(/([，,])\s*(?:不再另行[^。；;\u000A，,]{0,40}|以[^，,。；;\u000A]{0,16}为唯一[^，,。；;\u000A]{0,24}不再[^，,。；;\u000A]{0,20})/gu, (_full, comma: string) => {
    fixedCount += 1;
    return comma;
  });
  // 句首声明句整句删除：句边界后紧跟「不再另行…/以X为唯一控制基准」且句内无其他数据（句尾删除）
  // eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
  const sentenceRe = /(?:^|[。；;\u000A])([^。；;\u000A]*?(?:不再另行[^。；;\u000A]{0,40}|以[^。；;\u000A]{0,16}为唯一[^。；;\u000A]{0,24}不再[^。；;\u000A]{0,20})[^。；;\u000A]*)(?=[。；;\u000A]|$)/gu;
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
  // eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
  result = result.replace(/，+/gu, '，').replace(/，(?=[。；;\u000A])/gu, '').replace(/(?:^|[。；;\u000A])\s*，/gu, (_full, prefix: string) => prefix).replace(/([。；;])\1+/gu, '$1').replace(/^[。；;\s]+/u, '').replace(/\u000A{3,}/gu, '\u000A\u000A');
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
  // eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
  const FORMULA_FRAGMENT_RE = /(?:[Pp]\s*=\s*[^。；;\u000A，,]*|[qQ]\s*=\s*[^。；;\u000A，,]{0,80}|Σ\s*[Pp][12]?(?:\s*\/\s*cos\s*φ)?[^。；;\u000A，,]{0,40}|[Kk][12]\s*[×*]?\s*Σ\s*[Pp][12]?[^。；;\u000A，,]{0,40}|cos\s*φ[^。；;\u000A，,]{0,20})/gu;
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
  // D1 蓝图权威存在时：零漂移豁免——蓝图劳动力峰值（清单工效推导）是最高权威，任何与权威不一致的
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

/** 阶段劳动力确定性修复（V5 P4b-2，与检测器同源单源）：scanPhaseLaborClaims 定位（双通道）
 * → 权威值硬替换 → 复检（复检仍残留即整体回滚，返回原文本）。
 * 4.31 丰乐镇 v6 #63/64 扩展：阶段名拼接歧义（「景观与绿化亮化与收尾工程」= 两阶段名连写）
 * 由 LLM 修复轮改述的历史实现实测无效（评审轮未改述直接进终检 blocker）——现按
 * splitConcatenatedPhaseName（与检测器同一 ambiguity 单源）确定性拆分重写为
 * 「leading阶段X人，trailing阶段Y人」（各取权威值）；拆分不可判定（命中 <4 字）仍留 LLM。
 * 调用方在章节写时就绪后立即对齐，把跨章漂移消灭在写时。 */
export function fixPhaseLaborValues(
  markdown: string,
  phaseAuthorities?: Array<{ phase: string; value: number; trace?: string }>,
): { markdown: string; fixedCount: number; details: string[]; residualCount: number } {
  if (!phaseAuthorities || phaseAuthorities.length === 0) return { markdown, fixedCount: 0, details: [], residualCount: 0 };
  const { claims, ambiguities } = scanPhaseLaborClaims(markdown, phaseAuthorities);
  if (claims.length === 0 && ambiguities.length === 0) return { markdown, fixedCount: 0, details: [], residualCount: 0 };
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  for (const claim of claims) {
    replacements.push({
      start: claim.start,
      end: claim.end,
      replacement: String(claim.expected),
      detail: `阶段劳动力 ${claim.phase} ${claim.actual}人→${claim.expected}人`,
    });
  }
  for (const ambiguity of ambiguities) {
    const split = splitConcatenatedPhaseName(ambiguity);
    if (!split) continue;
    // 短语起始定位：连写短语在正文中可能带「阶段」后缀（枚举通道）；短语与数值之间仅允许
    // 「约/为/达/共/计」+空白（与扫描侧归属窗口同源，防跨短语错位定位）
    let phraseStart = -1;
    for (const candidate of [`${ambiguity.phrase}阶段`, ambiguity.phrase]) {
      const found = markdown.lastIndexOf(candidate, ambiguity.start);
      if (found === -1 || found + candidate.length > ambiguity.start) continue;
      if (!/^(?:约|为|达|共|计)?\s*$/u.test(markdown.slice(found + candidate.length, ambiguity.start))) continue;
      phraseStart = found;
      break;
    }
    if (phraseStart === -1) continue;
    const rawEnd = ambiguity.start + ambiguity.raw.length;
    if (markdown.slice(rawEnd, rawEnd + 1) !== '人') continue;
    replacements.push({
      start: phraseStart,
      end: rawEnd + 1,
      replacement: `${split.leading.phase}阶段${split.leading.value}人，${split.trailing.phase}阶段${split.trailing.value}人`,
      detail: `阶段名拼接拆分：${ambiguity.phrase} → ${split.leading.phase}（${split.leading.value}人）＋${split.trailing.phase}（${split.trailing.value}人）`,
    });
  }
  if (replacements.length === 0) return { markdown, fixedCount: 0, details: [], residualCount: 0 };
  const sorted = [...replacements].sort((left, right) => right.start - left.start);
  let result = markdown;
  const applied: Array<{ detail: string }> = [];
  let boundary = Number.POSITIVE_INFINITY;
  for (const replacement of sorted) {
    if (replacement.end > boundary) continue; // 区间重叠防护（理论不发生；保守跳过）
    result = `${result.slice(0, replacement.start)}${replacement.replacement}${result.slice(replacement.end)}`;
    applied.push(replacement);
    boundary = replacement.start;
  }
  const residual = scanPhaseLaborClaims(result, phaseAuthorities);
  if (residual.claims.length > 0) return { markdown, fixedCount: 0, details: [], residualCount: residual.claims.length };
  return { markdown: result, fixedCount: applied.length, details: applied.map(item => item.detail), residualCount: 0 };
}

/** 基础信息表重复合并修复（4.31 丰乐镇 v6 #70，与检测器 markdownTableQualityIssues 同源）：
 * 正文多处「| 信息项 | 内容 |」基础信息表（内容含项目名称/招标人/建设地点/工期/质量等
 * 字段词）时，保留第一张，后续表独有的字段行按原样并入第一张表尾，并删除后续表块
 * （表头/分隔线/数据行/前导空行）与紧邻引导句（「…汇总成表」类，防悬空引用）。
 * 值格为兜底话术（资料未明确类，#86/87）的字段行跳过不并入——随重复块一并消失，
 * 主表不携带兜底值；孤立兜底行由 fixFallbackPlaceholderRows 继续兜底。 */
export function fixDuplicateBasicInfoTables(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const isBasicInfoHeader = (line: string): boolean => /^\|\s*信息项\s*\|\s*内容\s*\|\s*$/u.test(line.trim());
  interface BasicInfoBlock { header: number; end: number; rows: Array<{ name: string; value: string; index: number }> }
  const blocks: BasicInfoBlock[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    if (!isBasicInfoHeader(lines[cursor]!)) { cursor += 1; continue; }
    const rows: BasicInfoBlock['rows'] = [];
    let probe = cursor + 1;
    if (probe < lines.length && MARKDOWN_TABLE_DIVIDER_RE.test(lines[probe]!)) probe += 1;
    while (probe < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[probe]!) && !MARKDOWN_TABLE_DIVIDER_RE.test(lines[probe]!)) {
      const cells = lines[probe]!.split('|').map(cell => cell.trim());
      const name = cells[1] ?? '';
      if (cells.length >= 4 && name) rows.push({ name, value: cells[2] ?? '', index: probe });
      probe += 1;
    }
    blocks.push({ header: cursor, end: probe - 1, rows });
    cursor = Math.max(probe, cursor + 1);
  }
  const BASIC_INFO_FIELD_RE = /项目名称|招标人|建设单位|发包人|建设地点|招标范围|计划工期|合同估算价|质量标准/u;
  const FALLBACK_VALUE_RE = /资料未明确|暂未明确|待资料复核|未检索到|资料不足|无法确认|建议补充|不适用|可核验信息|系统暂未|项目资料暂未|待确认|待系统|通用兜底|兜底(?:占位|模板|内容)|以本项目招标文件明确内容为准/u;
  const fieldBlocks = blocks.filter(block => block.rows.some(row => BASIC_INFO_FIELD_RE.test(row.name)));
  if (fieldBlocks.length <= 1) return { markdown, fixedCount: 0, details: [] };
  const primary = fieldBlocks[0]!;
  const remove = new Set<number>();
  const additions: string[] = [];
  const details: string[] = [];
  const existingNames = new Set(primary.rows.map(row => row.name));
  for (const block of fieldBlocks.slice(1)) {
    const intaken: string[] = [];
    for (const row of block.rows) {
      if (existingNames.has(row.name)) continue;
      if (FALLBACK_VALUE_RE.test(row.value) && row.value.trim().length <= 24) continue;
      existingNames.add(row.name);
      additions.push(lines[row.index]!);
      intaken.push(row.name);
    }
    for (let q = block.header; q <= block.end; q += 1) remove.add(q);
    for (let q = block.header - 1; q >= 0 && lines[q]!.trim() === ''; q -= 1) remove.add(q);
    // 块后首个空行随块删除（块前引导句区域已释放间隔空行，防连续空行）
    if (block.end + 1 < lines.length && lines[block.end + 1]!.trim() === '') remove.add(block.end + 1);
    // 紧邻上方的「…汇总成表」引导句一并删除（防「汇总成表」悬空引用）
    let lead = block.header - 1;
    while (lead >= 0 && lines[lead]!.trim() === '') lead -= 1;
    if (lead >= 0 && !/^[|#]/u.test(lines[lead]!.trim()) && /汇总(?:成表|为表|如下|列出)|如下表|见下表|形成(?:如下)?表|汇总表/u.test(lines[lead]!)) remove.add(lead);
    details.push(`基础信息表重复合并：删除第 ${fieldBlocks.indexOf(block) + 1} 处重复表${intaken.length > 0 ? `，并入字段 ${intaken.join('、')}` : ''}`);
  }
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!remove.has(index)) output.push(lines[index]!);
    if (index === primary.end) output.push(...additions);
  }
  return { markdown: output.join('\n'), fixedCount: fieldBlocks.length - 1, details };
}

/** 表格兜底话术行确定性删除（4.31 丰乐镇 v6 #86/87，与门禁 formalTextGateIssues 行级扫描同口径）：
 * 表格数据行的单元格出现「资料未明确/暂未明确/待资料复核/…」类后台话术时整行删除
 * （正式交付表格不得出现资料缺失兜底话术）。表头行与分隔线不动；块内数据行全命中时
 * 保守放弃（防删空表），残留转门禁。 */
export function fixFallbackPlaceholderRows(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const FALLBACK_CELL_RE = /资料未明确|暂未明确|待资料复核|未检索到|资料不足|无法确认|建议补充|不适用|可核验信息|系统暂未|项目资料暂未|待确认|待系统|通用兜底|兜底(?:占位|模板|内容)|以本项目招标文件明确内容为准/u;
  const remove = new Set<number>();
  const details: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!MARKDOWN_TABLE_ROW_RE.test(lines[index]!) || MARKDOWN_TABLE_DIVIDER_RE.test(lines[index]!)) { index += 1; continue; }
    let end = index;
    while (end + 1 < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[end + 1]!)) end += 1;
    const dataIndexes: number[] = [];
    for (let q = index + 1; q <= end; q += 1) {
      if (!MARKDOWN_TABLE_DIVIDER_RE.test(lines[q]!)) dataIndexes.push(q);
    }
    const targets = dataIndexes.filter(q => {
      const cells = lines[q]!.split('|').map(cell => cell.trim()).filter(cell => cell.length > 0);
      return cells.some(cell => cell.length <= 24 && FALLBACK_CELL_RE.test(cell));
    });
    // 全命中时保守放弃（防删空表）；部分命中即删除命中行，残留转门禁
    if (targets.length > 0 && targets.length < dataIndexes.length) {
      for (const q of targets) { remove.add(q); details.push(`删除兜底话术表行：${lines[q]!.trim().slice(0, 48)}`); }
    }
    index = end + 1;
  }
  if (remove.size === 0) return { markdown, fixedCount: 0, details: [] };
  return { markdown: lines.filter((_, lineIndex) => !remove.has(lineIndex)).join('\n'), fixedCount: remove.size, details };
}

/** 埋深/覆土槽位数值错位确定性修复（4.31 丰乐镇 v6 #3，与检测器 factReconciliation D4.3
 * SLOT_DEPTH_RE 同源）：槽位数值折算后 >10m（物理合理上限，管道埋深一般 <10m）时几乎必然
 * 是长度/总长口径误塞槽位（实测「接地母线…埋深不小于 23.45m」= 接地母线长度 23.45m）。
 * 修复=删除该槽位短语（含紧邻前导逗号/顿号），保留句子其余部分，残标点收敛；
 * 不编造替代值（宁缺不假），语义完整性由原句其余部分承担。 */
export function fixSlotDepthValue(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const SLOT_DEPTH_FIX_RE = /(?:埋深|覆土(?:厚度|深度)?|管顶覆土)(?:不小于|不大于|不低于|不超过|约|为|达|控制在|一般|宜|应)?[^。；;\n|]{0,10}?([\d,，]+(?:\.\d+)?)\s*(mm|cm|米|m)(?![a-zA-Z0-9²³])/gu;
  const removals: Array<{ start: number; end: number; detail: string }> = [];
  for (const match of markdown.matchAll(SLOT_DEPTH_FIX_RE)) {
    const raw = Number((match[1] || '').replace(/[,，]/gu, ''));
    if (!Number.isFinite(raw)) continue;
    const unit = match[2];
    const meters = unit === 'mm' ? raw / 1000 : unit === 'cm' ? raw / 100 : raw;
    if (meters <= 10) continue;
    const matchStart = match.index ?? 0;
    // 前导逗号/顿号随短语一起删除（「敷设，埋深不小于 23.45m，」→「敷设，」）
    const prefixLength = matchStart > 0 && /[，,、]/u.test(markdown[matchStart - 1]!) ? 1 : 0;
    removals.push({ start: matchStart - prefixLength, end: matchStart + match[0].length, detail: `埋深/覆土槽位数值删除：${match[0].trim()}` });
  }
  if (removals.length === 0) return { markdown, fixedCount: 0, details: [] };
  let result = markdown;
  for (const item of [...removals].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, item.start)}${result.slice(item.end)}`;
  }
  // 残标点收敛（删除可能留下的标点组合）
  result = result.replace(/，，/gu, '，').replace(/，；/gu, '；').replace(/，。/gu, '。').replace(/，、/gu, '、').replace(/、，/gu, '、').replace(/；，/gu, '；').replace(/。，/gu, '。');
  return { markdown: result, fixedCount: removals.length, details: removals.map(item => item.detail) };
}

/** 小节标题工程类别未覆盖确定性改名（4.31 丰乐镇 v6 #90，与检测器 headingUncoveredEngineeringItems
 * 同源单扫描 scanUncoveredEngineeringHeadings）：标题以「工程」结尾且含多个词段
 * （「给排水、采暖、燃气工程」），正文未覆盖的词段从标题中移除（新标题=已覆盖词段+工程）；
 * 编号前缀（如「2.11.4 」）保留；全部词段未覆盖时不动作（防生成空标题）。
 * 标题改动后目录同步由后续 tocConsistencyFix（fixTocFromBody）承担。 */
export function fixHeadingUncoveredItems(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const hits = scanUncoveredEngineeringHeadings(markdown);
  if (hits.length === 0) return { markdown, fixedCount: 0, details: [] };
  const lines = markdown.split(/\r?\n/u);
  const details: string[] = [];
  for (const hit of hits) {
    const covered = hit.parts.filter(part => !hit.uncovered.includes(part));
    if (covered.length === 0) continue;
    const raw = lines[hit.lineIndex];
    if (raw === undefined) continue;
    const lineMatch = /^(\s*#{3,4}\s+)(.*?)\s*$/u.exec(raw);
    if (!lineMatch) continue;
    const numberMatch = /^([\d.]+[\s\u00a0]+)/u.exec(lineMatch[2]!);
    const newTitle = `${covered.join('、')}工程`;
    lines[hit.lineIndex] = `${lineMatch[1]}${numberMatch ? numberMatch[1] : ''}${newTitle}`;
    details.push(`标题工程类别覆盖修正：${hit.title} → ${numberMatch ? numberMatch[1] : ''}${newTitle}`);
  }
  if (details.length === 0) return { markdown, fixedCount: 0, details: [] };
  return { markdown: lines.join('\n'), fixedCount: details.length, details };
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
    // 零商务句口径：正文无豁免——含商务词/税率的句一律删除（商务域条款已在判定层排除，
    // 正文任何位置不应出现商务数据；历史「定性响应句豁免」通道随 4.40.0 全链清理删除）。
    return parts.filter(part => {
      return !(COMMERCIAL_TERM_RE.test(part) || COMMERCIAL_RATE_RE.test(part));
    }).join('');
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

/** 从后往前应用定点替换（避免索引偏移；detail 去重保序）；4.27.0 导出供数值裁决器按章应用跨章 span */

export function applySpanReplacements(markdown: string, replacements: Array<{ start: number; end: number; replacement: string; detail: string }>): { markdown: string; fixedCount: number; details: string[] } {
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
 * 与检测器同源同口径：与表格峰值不一致即替换、阶段限定峰值不参与（laborPeakStageOf 同源判定）。 */

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
 * ① 体系缩放：factsModel 锁定总工期（如 540 日历天）与文档主流节点体系终点（如 365 日）不一致时，
 *   全文「开工(令下发)后第N日/天」及竣工验收语境裸「第N日」按 scale 统一缩放，三列进度表行链式重算
 *   开始/持续列保证表内自洽（合肥师范实测：365 体系与总工期 540 并存，三表互相矛盾且权威表标题
 *   不含「总进度计划」导致历史逻辑零产出）；
 * ② 权威表提取：「总进度计划/施工总进度/总进度安排/总工期控制」标题表格块按行名→完成日建立节点权威口径
 *   （行级提取覆盖「开工令下发后第N日」表格式，历史三形态正则抓不到该形态）；
 * ③ 多表对齐：非权威表格行按行名关键词归类节点键，行内完成日与权威不一致 → 替换为权威值；
 *   正文句矛盾沿用三形态正则 + 权威口径定点替换（与检测器 nodeScheduleConsistencyIssues 同源同口径）。 */

function fixNodeScheduleConflicts(markdown: string, options?: { scheduleAuthority?: number; nodeAuthorities?: Array<{ node: string; offset: string }> }): { markdown: string; fixedCount: number; details: string[] } {
  let next = markdown;
  const allDetails: string[] = [];
  const scheduleAuthority = options?.scheduleAuthority;
  // ── ① 体系缩放 ──
  if (scheduleAuthority !== undefined && scheduleAuthority > 0) {
    const absoluteDays = [...next.matchAll(/(?:开工令下发后|开工后)第(\d{1,3})[日天]/gu)].map(match => Number(match[1]));
    const systemMax = absoluteDays.length > 0 ? Math.max(...absoluteDays) : 0;
    if (systemMax > 0 && systemMax !== scheduleAuthority) {
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
  // 主表值覆盖文档内权威表提取值（主表为唯一口径源），冲突不一致时权威表行也纳入③对齐
  for (const entry of options?.nodeAuthorities ?? []) {
    const dayMatch = entry.offset.match(/第(\d{1,3})[日天]/u);
    if (!dayMatch) continue;
    const day = Number(dayMatch[1]);
    if (!Number.isFinite(day) || day < 1 || day > 3000) continue;
    const key = SCHEDULE_NODE_ANCHORS.find(anchor => anchor.re.test(entry.node))?.key;
    if (key === undefined) continue;
    const existing = authorityByKey.get(key);
    if (existing !== undefined && existing !== day) authoritySpans.length = 0;
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
    if (day.value === authority) continue;
    const label = SCHEDULE_NODE_ANCHORS.find(anchor => stageKeysOf(rowName).includes(anchor.key))?.label || rowName.slice(0, 12);
    replacements.push({ start: lineSpans[index].start + day.start, end: lineSpans[index].start + day.end, replacement: String(authority), detail: `表格节点“${label}”${day.value}日→${authority}日（以总进度计划/总工期控制表为准）` });
  }
  const keyOf = (text: string) => SCHEDULE_NODE_ANCHORS.find(anchor => anchor.re.test(text))?.key;
  const pushReplacement = (nodeText: string, day: number, dayStart: number, dayEnd: number) => {
    const key = keyOf(nodeText);
    if (key === undefined || !Number.isFinite(day) || day < 1 || day > 3000) return;
    const authority = authorityByKey.get(key);
    if (authority === undefined) return;
    if (day === authority) return;
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
    pushReplacement(match[2], Number(match[1]), dayStart, dayStart + match[1].length);
  }
  // 形态 D 竣工验收倒序式：竣工验收节点第N日——负向前瞻排除「后」（相对量句「竣工验收合格后第90日」
  // 不缩放）与节点分隔符，覆盖「主体结构封顶节点第311日与竣工验收节点第365日为刚性控制点」形态
  for (const match of next.matchAll(/(竣工验收)(?:(?!(?:后|第\d{2,3}[日天]|，|、|→)).){0,10}?第(\d{2,3})[日天]/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length);
  }
  for (const match of next.matchAll(/(基坑支护|正负零|封顶|装饰装修|机电安装|竣工验收)(?:(?!(?:第\d{2,3}[日天]|，|、)).){0,8}?完成[^。；;\n]{0,10}?第(\d{2,3})[日天]/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length);
  }
  // 形态 C 倒序锁定式：封顶节点第N日——h18 与检测器同源排除「，、/完成/|/句界」；
  // 「后」只在节点名后定点排除（「主体结构封顶后第10日」相对量句），窗口内不排除——
  // 防设备表行「主体封顶 | 商品混凝土泵送 | 开工后第158日进场」误采的同时不误杀「开工后第N日」倒序式
  for (const match of next.matchAll(/(主体(?:结构)?封顶)(?!后)(?:(?!(?:第\d{2,3}[日天]|，|、|完成|\||[。；;\n])).){0,20}?第(\d{2,3})日/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length);
  }
  const applied = applySpanReplacements(next, replacements);
  return { markdown: applied.markdown, fixedCount: applied.fixedCount + (allDetails.length > 0 ? 1 : 0), details: [...allDetails, ...applied.details].slice(0, 12) };
}

/** 材料/设备数量确定性修复：表格行数值为权威口径，正文矛盾数值（差异 >20%）改为表格值。
 * 与检测器 crossSectionNumericConflictIssues 同源（同锚点/同豁免：并列枚举、否定声明句）；
 * 表格口径不唯一（多表互相矛盾）时不动，交 LLM 修复路径（V2 批1-4：设备保守台数/同组众数
 * 等机器盲选兜底已删除，多值冲突一律阻断交 LLM 定向修复裁决，机器不盲选口径）。
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
    // 权威优先级（V2 批1-4 零兜底写入：设备保守台数/同组众数等机器盲选兜底已全部删除）：
    // 外部锁定口径（factsModel 计划工期/装配率等）> 表格唯一值；多值冲突时无权威可依不修复——
    // 由检测器阻断 + LLM 定向修复裁决（机器不得在多套口径中盲选一套写入，宁缺毋假）；
    // 正文/表格行存在与权威不一致的值才修复（与检测器同口径）
    const externalAuthority = authorities?.[anchor.key];
    const authority = externalAuthority !== undefined && externalAuthority > 0 ? externalAuthority
      : tableValues.size === 1 ? [...tableValues][0]
      : undefined;
    if (authority === undefined) continue;
    // 外部权威时表格行全量参与修复（多表互相矛盾时表格行本身就是要统一的对象）；
    // F15 部位组豁免：部位组正文值不参与差异判定
    const fixCandidates = [...bodyMatches.filter(item => item.group === ''), ...(externalAuthority !== undefined ? tableMatches : [])];
    if (!fixCandidates.some(item => item.value !== authority)) continue;
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        const line = markdown.slice(lineStart, lineEnd);
        if (NEGATIVE_DECLARATION_RE.test(line)) continue;
        if (/^\s*\|/u.test(line) && externalAuthority === undefined) continue;
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) continue;
        // F15 部位组豁免：正文分部位的数量配置（分区灭火器等）不做确定性归一，防止修复器制造数据矛盾
        if (!/^\s*\|/u.test(line) && locationGroupForMatch(markdown, match.index || 0, raw, lineStart) !== '') continue;
        if (value === authority) continue;
        const valueIndex = match.index + match[0].indexOf(match[1]);
        const source = externalAuthority !== undefined && externalAuthority > 0 ? (anchor.key === 'scheduleDays' ? '以绑定资料计划工期为准' : '以绑定资料锁定口径为准') : '以表格口径为准';
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

// ── G3 清单工程量权威定点校正（S5 判定层锚点直连版）──
// 判定层（integratedBlueprint.blueprintCitationVerdict）对正文引用做三态语义裁决，只有裁决为
// conflict 的引用才产生锚点（全文坐标 + 冲突值 + 清单汇总权威值）；本修复器只做坐标切片校验
// 与定点替换——判定与修复单一事实源，语义豁免（规格/频次/分区/村名/单体/分部量/子集拆分）
// 全部在判定层完成，修复侧无任何平行豁免。

/** S5 锚点直连修复：只消费判定层裁决为 conflict 的工程量锚点（全文坐标 + 冲突值 + 权威值）——
 * 切片数值校验（坐标处文本须仍等于裁决冲突值，上游替换致坐标失效时跳过）后定点替换，
 * 词表/语境/分部/村名等一切语义豁免均不在此层判断（判定与修复单一事实源）。 */
export function fixQuantityAuthorityConflicts(markdown: string, anchors: QuantityConflictAnchor[] = []): { markdown: string; fixedCount: number; details: string[] } {
  if (anchors.length === 0) return { markdown, fixedCount: 0, details: [] };
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  for (const anchor of anchors) {
    if (anchor.start < 0 || anchor.end <= anchor.start || anchor.end > markdown.length) continue;
    const raw = markdown.slice(anchor.start, anchor.end);
    const value = Number(raw.replace(/,/gu, ''));
    // 切片防漂移校验：坐标处文本必须仍是判定层裁决的冲突值（错位坐标绝不做替换）
    if (!Number.isFinite(value) || Math.abs(value - anchor.value) > 1e-6) continue;
    replacements.push({ start: anchor.start, end: anchor.end, replacement: String(anchor.authorityValue), detail: `${anchor.name} ${anchor.value}${anchor.unit}→${anchor.authorityValue}${anchor.unit}（以工程量清单汇总值为准）` });
  }
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

/** V5 P4：修复权威统一从 AuthorityIndex 全量派生（替代 blueprintPlanAuthorities 人工映射白名单）。
 * 1. 跨节数值锚点：CROSS_SECTION_ANCHOR_ENTITY_RE 实体词 × equipment/quantity 域自动对接——
 *    挖掘机等任意新增设备入蓝图即自动获得权威（原 7 类 key 白名单是「挖掘机 1 vs 5 无修复通道」根因）；
 *    villageCount/slackDays/scheduleDays 从 redline/schedule/contract 域直取；
 * 2. 节点工期/劳动力峰值/规格：schedule/labor/spec 域直取；
 * 3. 工程量权威不经由此处派生（S5）：判定层锚点（blueprintCitationVerdict.anchors）直连修复器。 */
export interface RepairPlanAuthorities {
  nodeAuthorities: Array<{ node: string; offset: string }>;
  crossSectionAuthorities: Record<string, number>;
  codeAuthorities: Record<string, string>;
  laborPeakAuthority?: number;
}

export function deriveRepairAuthorities(index?: AuthorityIndex): RepairPlanAuthorities {
  const empty: RepairPlanAuthorities = { nodeAuthorities: [], crossSectionAuthorities: {}, codeAuthorities: {} };
  if (!index) return empty;
  const nodeAuthorities: Array<{ node: string; offset: string }> = [];
  for (const entry of index.byDomain.get('schedule') ?? []) {
    if (!entry.label.startsWith('里程碑:') || typeof entry.value !== 'number' || entry.value <= 0) continue;
    // offset 与消费端正则（fixNodeScheduleConflicts 的 /第(\d{1,3})[日天]/）对齐——「N 天」形态曾被
    // 消费端静默丢弃（节点权威注入断链），“第N日”形态保证注入生效
    nodeAuthorities.push({ node: entry.label.slice('里程碑:'.length), offset: `第${entry.value}日` });
  }
  // 跨节数值锚点：实体词自动对接（equipment 域优先，quantity 域兜底——与旧「设备投入计划表优先」同口径）
  const crossSectionAuthorities: Record<string, number> = {};
  const equipmentEntries = index.byDomain.get('equipment') ?? [];
  const quantityEntries = index.byDomain.get('quantity') ?? [];
  const entityEntries = [...equipmentEntries, ...quantityEntries];
  for (const [key, entityRe] of Object.entries(CROSS_SECTION_ANCHOR_ENTITY_RE)) {
    const entry = entityEntries.find(item => entityRe.test(item.label) || item.anchors.some(alias => entityRe.test(alias)));
    if (entry && typeof entry.value === 'number' && entry.value > 0) crossSectionAuthorities[key] = entry.value;
  }
  const directByDomain: Array<{ key: string; domain: AuthorityDomain; label: string }> = [
    { key: 'villageCount', domain: 'redline', label: '自然村数量' },
    { key: 'slackDays', domain: 'schedule', label: '机动工期' },
    { key: 'scheduleDays', domain: 'contract', label: '总工期' },
  ];
  for (const mapping of directByDomain) {
    // 数值型条目筛选：同 label 可能既有资料原文条目（string value，如红线事实原文）又有数值提取条目
    // （如「自然村数量」），必须命中数值型，否则 find 首命中字符串条目导致权威静默缺失
    const entry = (index.byDomain.get(mapping.domain) ?? []).find(item => item.label === mapping.label && typeof item.value === 'number');
    if (entry && typeof entry.value === 'number' && entry.value > 0) crossSectionAuthorities[mapping.key] = entry.value;
  }
  const codeAuthorities: Record<string, string> = {};
  for (const entry of index.byDomain.get('spec') ?? []) {
    if (typeof entry.value === 'string' && entry.value) codeAuthorities[entry.anchors[0] ?? entry.label] = entry.value;
  }
  const laborPeakEntry = (index.byDomain.get('labor') ?? []).find(entry => entry.label === '劳动力峰值');
  const laborPeakAuthority = laborPeakEntry && typeof laborPeakEntry.value === 'number' && laborPeakEntry.value > 0 ? laborPeakEntry.value : undefined;
  return { nodeAuthorities, crossSectionAuthorities, codeAuthorities, laborPeakAuthority };
}

/** 计划总工期权威口径提取：factsModel 计划工期事实卡（schedule_requirement「计划工期」字段）
 * 或 canonical 锁定值的日历天数值。4.17.3 庐江实测：45 vs 210 两套体系并存时表格口径不唯一，
 * 必须以绑定资料提取的锁定工期为准做确定性替换（修复节点 failed 根因之一）。
 * 事实卡值为混合口径长句（“计划工期：…起，210日历天”）时取首个「N日历天」数值。 */

// ── 21c. 误入数字粘连清洗 + 日区间超限截断（4.28.4 舒城实测）──
// ① 「…的顺序组织17679主要工程量包括…」：工程量枚举句被 4~6 位误入数字粘连（正确句式
// 「…的顺序组织，主要工程量包括…」，数字非工程量数据——工程量数字均带单位，为上游文本
// 拼接残片）；② 「第345日至第4469日」：日区间终点编造远超总工期权威 360 日。

/** 误入数字粘连清洗：“汉字 + 4~6 位裸数字 +（主）要工程量”形态删除裸数字并补逗号分隔。
 * 「第」前缀与已带逗号形态排除（防误伤「第300日」类正常数字与重复清洗）。 */
export function fixGluedQuantityNumbers(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let fixedCount = 0;
  const details: string[] = [];
  const next = markdown.replace(/(?<=[\u4e00-\u9fa5])(?<!第)(?<!，)(\d{4,6})(?=主?\s*要?\s*工程量(?!清单))/gu, (match: string) => {
    fixedCount += 1;
    if (details.length < 12) details.push(`误入数字粘连清洗：删除“${match}”并补逗号`);
    return '，';
  });
  return { markdown: next, fixedCount, details };
}

/** 日区间超限截断：区间终点超出总工期权威（「第345日至第4469日」而权威 360 日）时终点截断为
 * 权威值；起点超限或终点未超限（正常区间）不动；无权威时静默跳过。分隔符原样保留。 */
export function fixOversizedDayRanges(markdown: string, scheduleAuthority?: number): { markdown: string; fixedCount: number; details: string[] } {
  if (!scheduleAuthority || scheduleAuthority <= 0) return { markdown, fixedCount: 0, details: [] };
  let fixedCount = 0;
  const details: string[] = [];
  const next = markdown.replace(/第(\d{1,3})日[ \t\u00a0]*(至|～|~)[ \t\u00a0]*第(\d{4,6})[ \t\u00a0]*日/gu, (match: string, startText: string, separator: string, endText: string) => {
    const start = Number(startText);
    const end = Number(endText);
    if (start > scheduleAuthority || end <= scheduleAuthority) return match;
    fixedCount += 1;
    if (details.length < 12) details.push(`日区间超限截断：“${match.replace(/\s+/gu, '')}”→“第${startText}日${separator}第${scheduleAuthority}日”`);
    return `第${startText}日${separator}第${scheduleAuthority}日`;
  });
  return { markdown: next, fixedCount, details };
}

export function applyNumericConsistencyDeterministicFixes(markdown: string, options?: {
  /** V5 P4 单一权威索引：机械/节点/规格/峰值由索引全量派生（未提供时相关步骤静默跳过） */
  authorityIndex?: AuthorityIndex;
  /** 外部锁定口径（factsModel 计划工期事实卡）：优先级高于蓝图索引（45 vs 210 两套体系确定性裁决） */
  scheduleAuthority?: number;
  assemblyRateAuthority?: number;
  supportAuthority?: SupportSystemAuthorityKind | null;
  /** 外部回退峰值（蓝图缺失时全文表峰值扫描）：覆盖索引值 */
  laborPeakAuthority?: number;
  /** S5 判定层冲突锚点（blueprintCitationVerdict.anchors）：章级调用须先经
   * rebaseCitationAnchorsForChapters 重定位（未提供时工程量校正静默跳过） */
  quantityAnchors?: QuantityConflictAnchor[];
}): NumericConsistencyFixResult {
  let next = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  const plan = deriveRepairAuthorities(options?.authorityIndex);
  const authorities: Record<string, number> = { ...plan.crossSectionAuthorities };
  if (options?.scheduleAuthority !== undefined && options.scheduleAuthority > 0) authorities.scheduleDays = options.scheduleAuthority;
  if (options?.assemblyRateAuthority !== undefined && options.assemblyRateAuthority > 0) authorities.prefabRatio = options.assemblyRateAuthority;
  const laborPeakAuthority = options?.laborPeakAuthority ?? plan.laborPeakAuthority;
  // S5 坐标契约：工程量锚点坐标与入参 markdown 同源，必须最先消费——峰值/工期/支护等步骤
  // 会增删字符，锚点后置会整体漂移导致切片校验静默跳过（锚点直连不重定位）
  const quantityAnchors = options?.quantityAnchors ?? [];
  const steps: Array<(text: string) => { markdown: string; fixedCount: number; details: string[] }> = [
    (text: string) => fixQuantityAuthorityConflicts(text, quantityAnchors),
    (text: string) => fixLaborPeakConflicts(text, laborPeakAuthority),
    (text: string) => fixNodeScheduleConflicts(text, { scheduleAuthority: options?.scheduleAuthority, nodeAuthorities: plan.nodeAuthorities }),
    (text: string) => fixCrossSectionNumericConflicts(text, authorities, plan.codeAuthorities),
    (text: string) => fixSupportSystemConflicts(text, options?.supportAuthority),
    (text: string) => fixRegulationNumberTypos(text),
    (text: string) => fixGluedQuantityNumbers(text),
    (text: string) => fixOversizedDayRanges(text, options?.scheduleAuthority),
  ];
  for (const step of steps) {
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

// ── A6 自伤表述确定性收口（丰乐镇 79 分基线对照实测）：首轮生成自伤类表述（LLM 修复轮定位能力不足，
// 残留被导出门禁硬阻断），此处按检测器同源口径确定性改写（检测定位=修复定位）；危大辨识清单
// 补写与扬尘六个百分百补写已随「零确定性正文注入」治理删除（4.41）。

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
      // 第十六版漏网修复：「新技术、新工艺、新设备或新材料」四新枚举词序不固定，
      // 原正则按固定词序「技术、材料、工艺、设备」匹配，与实测「技术、工艺、设备、材料」词序失配漏改
      from: /本项目以成熟可靠的常规工艺为主，未采用(?:行业认定的)?新(?:技术|材料|工艺|设备)(?:、新(?:技术|材料|工艺|设备)){1,3}(?:或新(?:技术|材料|工艺|设备))?[^。；;\n]{0,20}?。?/gu,
      to: '本项目工艺选择以成熟可靠为原则，全部采用经工程实践验证的成熟工艺、常规材料和标准化设备，确保各分项施工质量稳定可控。',
      detail: '「未采用新技术」短板自曝改写为成熟工艺正向表述',
    },
    // R9 八轮实测两形态（丰乐镇第八轮生成逐字命中，导出门禁硬阻断残留）；
    // 4.28.0 D2 去前缀依赖扩围：4.27.0 终稿实测变体「…不接受联合体投标；不允许分包。本工程不进行分包…」，
    // 原 from 要求「本招标项目不允许分包。」紧邻前缀，前缀一变即失配漏改——改为核心句匹配，
    // 前文响应句保留不动；from 不吞句尾标点（替换句无尾句号，沿用原文标点，防句号丢失/双标点）
    {
      from: /本工程不进行分包，全部施工内容由我方自行组织完成/gu,
      to: '本工程全部施工任务由我公司项目部自行组织实施，严禁违法分包、转包及挂靠行为',
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

// ── A11 内部术语清洗（丰乐镇第二轮实测：LLM 将后台术语写进正式正文）────────────────
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

// ── A16 关键设计决策两可表述归一（丰乐镇第三轮实测；4.27.0 A4 扩展）──────────
// 阻断实测：「钢板桩或型钢支撑支护、放坡或钢板桩支护」以并列/悬置形态表述。
// 无清单权威可锁定时按正文自身主流口径归一（全文「放坡」7处、「钢板桩」2处、「型钢」1处）：
// 「钢板桩或型钢支撑」→「钢板桩」；「放坡或支护」→「放坡支护」；「放坡或钢板桩支护」→「1:0.5放坡加钢板桩支护」。
// 与 ambiguousEitherOrIssues 检测器同源（检测定位=修复定位），只替换检测器会报的实测短语。
// 4.27.0 A4 扩展：候选侧机制——supportForm 权威选定值命中 sides[1].keyword 时取选定值侧，否则默认侧；
// 新增基线实测句式「打桩机打入或混凝土基础固定」（同文另处「立柱采用打入式安装」锚定打入侧）、
// 「放坡或加设挡板支护」「放坡或挡板支护」（1:0.5 坡率实义锚定放坡侧）；
// 修复后重扫检测器，无法归一的残留句式记录待复核缺口（不静默；残留仍由终检 blocking 检出）。
// 4.36 D3：句式表之外接入决策项注册表裁决——「A或B」命中决策类目（matchDecisionCategory）时
// 按决策锁归一（有锁）或转缺口（无锁/不可安全定位）；与检测器同源同扫描，句式追不上形态的问题
// 由注册表模式化解决（远端 4.35.0 实锤：「同步或分段浇筑」「柔性或半刚性」）。

interface AmbiguousDecisionSide {
  /** 归一目标文本（整短语替换） */
  text: string;
  /** 选定值命中正则（对 supportForm 权威值匹配） */
  keyword: RegExp;
}

interface AmbiguousDecisionFix {
  from: RegExp;
  /** [默认侧, 选定值侧]：无权威选定值或权威不匹配选定值侧时取默认侧 */
  sides: [AmbiguousDecisionSide, AmbiguousDecisionSide];
  detail: string;
}

const AMBIGUOUS_DECISION_FIXES: AmbiguousDecisionFix[] = [
  { from: /钢板桩或型钢支撑支护/gu, sides: [{ text: '钢板桩支护', keyword: /钢板桩/ }, { text: '型钢支撑支护', keyword: /型钢/ }], detail: '钢板桩型钢两可归一为钢板桩' },
  // 4.32.0 扩围（丰乐镇复测 #78）：「沟槽开挖深度超过1.5m的区段采用钢板桩或木挡板支护」——
  // 沟槽支护形态两可（与「放坡或挡板支护」先例同源，按正文主流侧/权威supportForm 归一）
  { from: /钢板桩或木挡板支护/gu, sides: [{ text: '钢板桩支护', keyword: /钢板桩/ }, { text: '木挡板支护', keyword: /木挡板|挡板/ }], detail: '沟槽支护两可归一为钢板桩支护' },
  { from: /放坡或钢板桩支护/gu, sides: [{ text: '1:0.5放坡加钢板桩支护', keyword: /放坡|坡率/ }, { text: '钢板桩支护', keyword: /钢板桩|排桩/ }], detail: '放坡钢板桩两可归一为组合支护' },
  // A4 基线实测：波形梁护栏立柱安装方式两可（无清单权威，按正文主流侧默认归一）
  { from: /打桩机打入或混凝土基础固定/gu, sides: [{ text: '打桩机打入', keyword: /打入|打桩/ }, { text: '混凝土基础固定', keyword: /混凝土基础|现浇|基础固定/ }], detail: '护栏立柱安装两可归一为打桩机打入' },
  // A4 基线实测：沟槽支护两可（加设长形态先行，与「放坡或挡板支护」不交叠）
  { from: /放坡或加设挡板支护/gu, sides: [{ text: '放坡支护', keyword: /放坡|坡率/ }, { text: '挡板支护', keyword: /挡板|钢板桩/ }], detail: '沟槽支护两可归一为放坡支护' },
  { from: /放坡或挡板支护/gu, sides: [{ text: '放坡支护', keyword: /放坡|坡率/ }, { text: '挡板支护', keyword: /挡板|钢板桩/ }], detail: '沟槽支护两可归一为放坡支护' },
  { from: /放坡或支护/gu, sides: [{ text: '放坡支护', keyword: /放坡|坡率/ }, { text: '挡板支护', keyword: /挡板|钢板桩/ }], detail: '放坡支护两可归一' },
];

export function fixAmbiguousEitherOrCandidates(markdown: string, options?: { supportForm?: string; decisionLock?: readonly DecisionLockEntry[] }): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of AMBIGUOUS_DECISION_FIXES) {
    const matches = [...result.matchAll(item.from)];
    if (matches.length === 0) continue;
    const side = options?.supportForm && item.sides[1].keyword.test(options.supportForm) ? item.sides[1] : item.sides[0];
    result = result.replace(item.from, side.text);
    fixedCount += matches.length;
    details.push(`${item.detail} ${matches.length} 处`);
  }
  // ── D3 决策项两可裁决（4.36）：「A或B」命中决策类目选项（matchDecisionCategory 与检测器单源）——
  // 有锁按锁定值归一、无锁/不可安全定位转缺口（下方重扫记录，LLM 修复轮裁决）。
  // 安全约束（双侧贴缘）：左组命中词须为左组后缀（其右缘即「或」前缘）、右组命中词须为右组前缀——
  // 防子串误命中（「管道采用柔性接口或刚性接口」的「柔性」非后缀，吞「接口」破坏语义，走缺口路径）；
  // 替换范围为「左组命中词起点 → 右组命中词终点」，两侧邻接正文全保留
  // （「混凝土采用同步或分段浇筑工艺」→「混凝土采用」+锁定值+「工艺」）。
  if (options?.decisionLock?.length) {
    const decisionHits: Array<{ start: number; end: number; target: string; detail: string }> = [];
    for (const match of result.matchAll(/([一-龥]{2,12})或([一-龥]{2,12})/gu)) {
      const category = matchDecisionCategory(match[1], match[2]);
      if (!category) continue;
      const lockEntry = options.decisionLock.find(entry => entry.id === category.id);
      if (!lockEntry || lockEntry.values.length === 0) continue;
      const leftAnchor = locateDecisionOptionAnchor(category, match[1]);
      if (!leftAnchor || leftAnchor.end !== match[1].length) continue;
      const rightAnchor = locateDecisionOptionAnchor(category, match[2]);
      if (!rightAnchor || rightAnchor.index !== 0) continue;
      const lockedOption = category.options.find(option => lockEntry.values.includes(option.value) && (option.aliases.test(match[1]) || option.aliases.test(match[2])));
      const target = lockedOption?.value ?? lockEntry.values[0];
      decisionHits.push({
        start: (match.index ?? 0) + leftAnchor.index,
        end: (match.index ?? 0) + match[1].length + 1 + rightAnchor.end,
        target,
        detail: `“${match[1]}或${match[2]}”→“${target}”（${category.label}）`,
      });
    }
    for (const hit of decisionHits.reverse()) result = result.slice(0, hit.start) + hit.target + result.slice(hit.end);
    if (decisionHits.length > 0) {
      fixedCount += decisionHits.length;
      details.push(`决策项两可归一 ${decisionHits.length} 处：${decisionHits.map(hit => hit.detail).join('、')}`);
    }
  }
  // 缺口不静默：重扫检测器，句式表未覆盖的两可形态记录待复核清单（不参与 fixedCount 防哑火循环）
  const residual = ambiguousEitherOrIssues(result);
  if (residual.length > 0) {
    const hitText = residual[0].message.replace(/^关键设计决策两可表述：/u, '').replace(/ 以并列\/悬置形态表述.*$/u, '');
    details.push(`两可表述缺口待复核：${hitText}`);
  }
  return { markdown: result, fixedCount, details };
}

// ── A22 配置要求不得出现类污染清洗（丰乐镇第三轮实测）──────────
// 阻断实测：「配置要求不得出现：公共资源交易监督管理」。模板 forbiddenTexts 阻断词进入正文时
// （LLM 把招标人角色行为写入投标正文），按角色归属改写：投标人无权“报监管部门处理”，
// 改为主语归属招标人按程序处理。只替换实测短语，非全局删词。

const FORBIDDEN_CONFIG_FIXES: Array<{ from: RegExp; to: string; detail: string }> = [
  { from: /，将报公共资源交易监督管理部门处理/gu, to: '，由招标人按招标文件规定程序处理', detail: '公共资源交易监督管理' },
  // 舒城第二轮实测：「工程量/面积按设计要求控制/考虑」留白引用触发 blocker（config forbiddenTexts）。
  // 「按设计要求」是责任模糊式留白，全文档改写为具体出处「按施工图设计文件」，与 containsForbiddenText 同口径豁免
  { from: /按设计要求(?!目录|清单|索引|汇总)/gu, to: '按施工图设计文件', detail: '按设计要求留白改写' },
  // r6 实机归因（#10 配置禁止词「按图纸」正文残留）：留白改写规则此前只对表格数据行生效
  //（TABLE_ROW_DEFERRAL_FIXES），正文段落（实机「道路破复按图纸上的大样施工」）不清洗直坠终检
  // forbiddenTexts blocker——同口径并入正文级清洗（合法交叉引用后缀豁免与 containsForbiddenText 一致）
  { from: /按图纸(?!目录|清单|索引|汇总)/gu, to: '按施工图设计文件', detail: '正文「按图纸」留白改写' },
  { from: /见图纸(?!目录|清单|索引|汇总)/gu, to: '见施工图设计文件', detail: '正文「（详）见图纸」留白改写' },
];

/** 表格数据行留白改写规则（舒城第二轮实测：数据行照抄清单特征「建筑物檐口高度、层数：详见图纸」
 * → 终检 forbiddenTexts「见图纸」blocker）。合法交叉引用「见图纸目录/清单/索引/汇总」豁免，
 * 与 containsForbiddenText 同口径。 */
const TABLE_ROW_DEFERRAL_FIXES: Array<{ from: RegExp; to: string; detail: string }> = [
  { from: /详见设计图纸(?!目录|清单|索引|汇总)/gu, to: '详见施工图设计文件', detail: '数据行「详见设计图纸」留白' },
  { from: /按设计图纸(?!目录|清单|索引|汇总)/gu, to: '按施工图设计文件', detail: '数据行「按设计图纸」留白' },
  { from: /按图纸(?!目录|清单|索引|汇总)/gu, to: '按施工图设计文件', detail: '数据行「按图纸」留白' },
  { from: /见图纸(?!目录|清单|索引|汇总)/gu, to: '见施工图设计文件', detail: '数据行「（详）见图纸」留白' },
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
  // 数据行留白清洗：只处理表格行（| 开头）——工作包/分项方案正文的留白仍由
  // constructionOrgQualityRules 打回由 LLM 用真实参数重写，不在此处掩盖正文质量问题
  let rowFixedCount = 0;
  const rowDetails: string[] = [];
  result = result.split('\n').map(line => {
    if (!/^\s*\|/u.test(line)) return line;
    let next = line;
    for (const item of TABLE_ROW_DEFERRAL_FIXES) {
      const matches = [...next.matchAll(item.from)];
      if (matches.length === 0) continue;
      next = next.replace(item.from, item.to);
      rowFixedCount += matches.length;
      rowDetails.push(`${item.detail} ${matches.length} 处`);
    }
    return next;
  }).join('\n');
  if (rowFixedCount > 0) {
    fixedCount += rowFixedCount;
    details.push(...rowDetails);
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

// ── 段落内句级复读确定性剥离（十五版评分报告实测 7 处段尾复读）──
// 各章 LLM 写作/模板化修复环节在段尾复读段内已有句子；duplicateParagraphIssues 只抓跨位置
// 整段重复，抓不到段内句级复读。本修复与检测器 paragraphTailRepeatIssues 同源复用
// scanParagraphTailRepeats 扫描口径（检测定位=修复定位）：段内相同句（去空白 ≥15 字）
// 只保留首次出现，删除后续复读句（含段尾复读 1~3 句形态）。
// r11 块级同源重写（丰乐镇实测 #5 机制归因）：旧实现行级切句——真实复读形态为「行内编号版 +
// 换行列表版」同块跨行复读（去空白后整句逐字相同），行级 seen 集合看不到跨行构成的句，
// 且长句与行级碎片的后缀包含关系不成立（长度差远超 15 字容差）→ 检测器报 blocker、修复器零修复。
// 新实现：与 scanParagraphTailRepeats 完全同源（块 trim → 剥标题/表格行 → join('\n') →
// 按「。！？!?」切句 → 归一化去空白 ≥15 字 → 相同/长句以短句结尾（长度差 ≤15 字）判重），
// 重复句经「prose 字符 → 块 index」位置映射回原块删除第二次及以后出现（含句尾终止标点，
// 前置空白回退不跨句界），原文其余结构逐字保留。

export function fixParagraphTailRepeats(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  // split 保留分隔符：奇数位是块间分隔（\n\s*\n），偶数位是块内容（与检测器 split(/\n\s*\n/) 块边界同源）
  const segments = markdown.split(/(\n\s*\n)/u);
  let fixedCount = 0;
  const details: string[] = [];
  const rebuilt = segments.map((segment, index) => {
    if (index % 2 === 1 || !segment) return segment;
    const outcome = dedupeTailRepeatsInBlock(segment);
    if (outcome.removedCount === 0) return segment;
    fixedCount += outcome.removedCount;
    details.push(...outcome.samples);
    return outcome.block;
  });
  return { markdown: rebuilt.join(''), fixedCount, details: details.slice(0, 8) };
}

/** 单块内句级复读剥离（与 scanParagraphTailRepeats 同源判定）：返回去除复读句后的块文本。
 * 实现：①块内容构造 prose（剥标题/表格行后 join('\n')）与「prose 字符 → 块 index」位置映射；
 * ②prose 按 [。！？!?] 切句（终止标点不入句体），归一化句子（trim + 去空白）同源判重；
 * ③第 2 次及以后出现的重复句删除：删除区间 = 句体起止（映射回块位置）+ 句尾终止标点 +
 * 前置空白回退（不越句界）；④删除区间重叠合并后从后往前应用（防位移）。 */

function dedupeTailRepeatsInBlock(segment: string): { block: string; removedCount: number; samples: string[] } {
  if (!/[。！？!?]/u.test(segment)) return { block: segment, removedCount: 0, samples: [] };
  const leading = /^\s*/u.exec(segment)?.[0] ?? '';
  const trailing = /\s*$/u.exec(segment)?.[0] ?? '';
  const block = segment.slice(leading.length, segment.length - trailing.length);
  if (!block || !/[。！？!?]/u.test(block)) return { block: segment, removedCount: 0, samples: [] };
  // prose 构造 + 位置映射（与检测器逐行过滤口径一致：空行剔除、标题/表格行剔除，行间 join('\n')）
  const proseChars: string[] = [];
  const originIndex: number[] = [];
  let offset = 0;
  for (const line of block.split('\n')) {
    const t = line.trim();
    const keep = Boolean(t) && !/^#{1,6}\s/u.test(t) && !t.startsWith('|');
    if (keep) {
      if (proseChars.length > 0) {
        proseChars.push('\n');
        originIndex.push(Math.max(0, offset - 1));
      }
      for (let k = 0; k < line.length; k += 1) {
        proseChars.push(line[k]!);
        originIndex.push(offset + k);
      }
    }
    offset += line.length + 1;
  }
  const prose = proseChars.join('');
  if (!prose) return { block: segment, removedCount: 0, samples: [] };
  // 切句区间（句体不含终止标点；尾段无标点即到 prose 尾）
  const sentenceRanges: Array<{ start: number; end: number; terminator: number }> = [];
  let cursor = 0;
  for (const match of prose.matchAll(/[。！？!?]/gu)) {
    sentenceRanges.push({ start: cursor, end: match.index, terminator: match.index });
    cursor = match.index + 1;
  }
  if (cursor < prose.length) sentenceRanges.push({ start: cursor, end: prose.length, terminator: -1 });
  const seen: string[] = [];
  const deletes: Array<{ start: number; end: number }> = [];
  const samples: string[] = [];
  for (const range of sentenceRanges) {
    const rawSentence = prose.slice(range.start, range.end);
    const sentence = rawSentence.trim().replace(/\s+/gu, '');
    if (sentence.length < PARAGRAPH_TAIL_REPEAT_MIN_CHARS) continue;
    const isDup = seen.some(entry =>
      entry === sentence ||
      (entry.length > sentence.length &&
        entry.length - sentence.length <= PARAGRAPH_TAIL_REPEAT_MIN_CHARS &&
        entry.endsWith(sentence)),
    );
    if (!isDup) {
      seen.push(sentence);
      continue;
    }
    // 重复出现 → 计算删除区间（块坐标）
    const bodyStart = range.start + (rawSentence.length - rawSentence.trimStart().length);
    const bodyEnd = range.end - (rawSentence.length - rawSentence.trimEnd().length);
    let blockStart = bodyStart < originIndex.length ? originIndex[bodyStart]! : -1;
    const blockEnd = range.terminator >= 0
      ? (originIndex[range.terminator] ?? -1) + 1
      : bodyEnd > 0 && bodyEnd - 1 < originIndex.length ? originIndex[bodyEnd - 1]! + 1 : -1;
    if (blockStart < 0 || blockEnd <= blockStart) continue;
    // 前置空白回退（含跨行换行；不吞上一句终止标点——空白字符类不含句号）
    while (blockStart > 0 && /\s/u.test(block[blockStart - 1]!)) blockStart -= 1;
    deletes.push({ start: blockStart, end: blockEnd });
    samples.push(sentence.slice(0, 24));
  }
  if (deletes.length === 0) return { block: segment, removedCount: 0, samples: [] };
  // 重叠合并 + 从后往前删除（防位移）
  deletes.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const item of deletes) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }
  let next = block;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    next = next.slice(0, merged[i]!.start) + next.slice(merged[i]!.end);
  }
  return { block: next, removedCount: deletes.length, samples };
}

// ── 时间区间倒挂确定性剥离（十五版评分报告实测「开工令下发后第90日至第3日完成」）──
// 「第X日至第Y日」X>Y 必为时间拼接病句；删除倒挂起点（「第X日至」）保留终点即恢复
// 有效时间点表述。与检测器 invertedDateRangeIssues 同源复用 scanInvertedDateRanges
// （检测定位=修复定位）；从后往前删防索引 shift 错位。

export function fixInvertedDateRanges(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const hits = scanInvertedDateRanges(markdown);
  if (hits.length === 0) return { markdown, fixedCount: 0, details: [] };
  const details: string[] = [];
  let next = markdown;
  for (const hit of [...hits].reverse()) {
    const source = next.slice(hit.start, hit.end);
    // V5 P6 修复（run1 实测残留 2 条）：旧实现只匹配「至」，「第120日～第3日」（波浪线
    // 连接符）落修——必须与检测器 INVERTED_DATE_RANGE_RE 同源字符类，防检测到但修不掉的残留
    const dayMatch = /第\d{1,3}日(?:至|到|～|~|—|－)/u.exec(source);
    if (!dayMatch) continue;
    next = next.slice(0, hit.start) + next.slice(hit.start + dayMatch[0].length);
    details.push(source);
  }
  return { markdown: next, fixedCount: details.length, details };
}

// ── H3 防撞名标题确定性修复（丰乐镇 doc-1788954795698 实测「公厕（1）」「公厕（1）（二）」）──
// 主题块切分/拆半的编号后缀防撞名泄漏进目录：正式投标目录不允许「（1）（2）」编号后缀小节。
// 与检测器 collisionNumberedHeadingIssues 同源复用 scanCollisionNumberedHeadings 扫描口径
// （检测定位=修复定位）：
// 1. 拆半变体（剥一层编号后缀后与文中已有 H3 同名）→ 整行 H3 删除，内容并入同基线小节；
// 2. 切块防撞名（「公厕（1）」）→ 按块内 H4 标题主题域多数票重命名为语义化标题
//    （「公厕结构与基础工程」），与蓝图层切块同源引用 workPackageThemeLabel，防口径漂移。

export function fixCollisionNumberedHeadings(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const hits = scanCollisionNumberedHeadings(markdown);
  if (hits.length === 0) return { markdown, fixedCount: 0, details: [] };
  const lines = markdown.split('\n');
  // 拆半判定用不剥括号的归一化：normalizeSubsectionTitleForDedup 会剥掉「（1）（二）」
  // 括号后缀，导致「公厕（1）」被误判为「公厕（1）（二）」的同基线壳而整行删除；
  // 重命名防二次冲突仍用剥括号归一化（新标题无括号，两口径等价）
  const normalizeShell = (title: string): string => title
    .replace(/^\d+(?:\.\d+)*[.．]?\s*/u, '')
    .replace(/[\s:：、。，,;；/|—-]/gu, '')
    .replace(/工程$/u, '');
  const h3Titles = new Set(lines.filter(line => /^###\s/u.test(line.trim())).map(line => normalizeSubsectionTitleForDedup(line.replace(/^###\s+/u, '').trim())));
  const h3ShellTitles = new Set(lines.filter(line => /^###\s/u.test(line.trim())).map(line => normalizeShell(line.replace(/^###\s+/u, '').trim())));
  const removedLines = new Set<number>();
  const details: string[] = [];
  const lineIndexOf = (charIndex: number) => markdown.slice(0, charIndex).split('\n').length - 1;
  // 先处理拆半变体（剥一层后缀后与已有 H3 同名 → 整行删除合并），再处理切块防撞名重命名
  const splits: Array<{ line: number; raw: string }> = [];
  const renames: Array<{ line: number; raw: string }> = [];
  for (const hit of hits) {
    const line = lineIndexOf(hit.index);
    const singleStripped = hit.raw.replace(/（(?:\d+|[一二三四五六七八九十]+)）$/u, '');
    if (h3ShellTitles.has(normalizeShell(singleStripped))) splits.push({ line, raw: hit.raw });
    else renames.push({ line, raw: hit.raw });
  }
  for (const { line, raw } of splits) {
    removedLines.add(line);
    details.push(`合并拆半小节：${raw}`);
  }
  // 重命名撞名防二次冲突：修复前 H3 集合 + 本轮已重命名标题动态去重
  const renamed = new Set<string>();
  for (const { line, raw } of renames) {
    const domains: string[] = [];
    for (let j = line + 1; j < lines.length; j += 1) {
      if (/^#{2,3}\s/u.test(lines[j]!)) break;
      const h4 = /^####\s+(.+)$/u.exec(lines[j]!.trim());
      if (h4) domains.push(workPackageThemeLabel(h4[1]!.trim()));
    }
    if (domains.length === 0) continue;
    const votes = new Map<string, number>();
    for (const domain of domains) votes.set(domain, (votes.get(domain) ?? 0) + 1);
    const topDomain = [...votes.entries()].reduce((left, right) => (right[1] > left[1] ? right : left))[0];
    const base = raw.replace(/(?:（(?:\d+|[一二三四五六七八九十]+)）)+$/u, '').replace(/工程$/u, '');
    const newTitle = `${base}${topDomain}`;
    const newNorm = normalizeSubsectionTitleForDedup(newTitle);
    if (h3Titles.has(newNorm) || renamed.has(newNorm)) continue;
    renamed.add(newNorm);
    lines[line] = lines[line]!.replace(/^(###\s+).+$/u, `$1${newTitle}`);
    details.push(`防撞名重命名：${raw} → ${newTitle}`);
  }
  const rebuilt = lines.filter((_, index) => !removedLines.has(index));
  return { markdown: rebuilt.join('\n'), fixedCount: details.length, details };
}

/** 机械设备分批台数矛盾确定性修复（r17 丰乐镇归因 #B2/B3：「首批进场挖掘机5台…剩余挖掘机5台…共同形成5台挖掘机…满配」——
 * 各批组合之和 5+5 均不等于蓝图机械汇总 5）：与检测器 scanEquipmentBatchConflicts 同源单扫描——命中
 * 「各批组合之和 ≠ 蓝图汇总」时删除 later 批「N 台/辆」数字单元（含约/共/计前缀量词，保留「剩余挖掘机、
 * 自卸汽车在第4日至第5日补充进场」的批次表述形态）——later 批无数值后检测口径（首批+剩余并存才判）
 * 必然不再命中；应用全部 span 后复扫至无命中（上限 3 轮防振荡）；权威缺失/零命中/空 removals 时零变更
 * （幂等零成本；无法确定性覆盖的形态保守放弃，交 LLM 修复轮/门禁）。 */
export function fixEquipmentBatchConflicts(
  markdown: string,
  equipment?: Array<{ name: string; count: number }>,
): { markdown: string; fixedCount: number; details: string[] } {
  if (!equipment || equipment.length === 0) return { markdown, fixedCount: 0, details: [] };
  let result = markdown;
  const details: string[] = [];
  for (let round = 1; round <= 3; round += 1) {
    const findings = scanEquipmentBatchConflicts(result, equipment);
    if (findings.length === 0) break;
    const spans = findings
      .flatMap(finding => finding.removals)
      .sort((left, right) => right.start - left.start);
    if (spans.length === 0) break;
    let applied = 0;
    let lastStart = Number.POSITIVE_INFINITY;
    for (const span of spans) {
      if (span.end > lastStart) continue; // 区间重叠防护（理论不发生；保守跳过）
      result = result.slice(0, span.start) + result.slice(span.end);
      lastStart = span.start;
      applied += 1;
      details.push(`分批台数补数删除：「${span.excerpt}」`);
    }
    if (applied === 0) break;
  }
  return { markdown: result, fixedCount: details.length, details };
}
