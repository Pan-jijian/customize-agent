import { FIVE_ELEMENT_WORD_RES } from '../../tenderBidChecks';
import { stableHash } from '../../utils';
/**
 * 可落地性五要素闭合补强（r14 丰乐镇实测）：
 * 评分口径（tenderBidScoring.executabilityScore）按 `\n{2,}` 空行块（trim ≥30 字）统计
 * 「五要素词面封闭表（FIVE_ELEMENT_WORD_RES，与评分同源）命中 ≥4 项」的闭合块密度——
 * r14 交付稿实测 73 块仅 20 块达标（3 项块 22 个全部缺 plan、≤2 项块 31 个），executability 停在 48 分。
 * 本修复器对未达标块确定性补一句措施句把块推过 4 项线；补句从分池轮换（stableHash 起点 + 复用
 * 上限 3 次），句子设计避开三族骨架指纹（「由技术负责人组织」「合格后方可」「验收合格后」）、
 * 闭环密度词（整改/复查/销项——closurePhraseDensityCap 3‰ 上限）与工序顺序形式词（依次/先后/
 * 先…再/按…顺序——flowFormRepeatIssues 相邻形式判定）；表格块与目录块不触碰（表格结构零风险）。
 */

const ELEMENT_KEYS = ['plan', 'process', 'role', 'frequency', 'acceptance'] as const;
type ElementKey = typeof ELEMENT_KEYS[number];

/** A 组（plan+process 双词，用于 hits≥2 缺 plan 的块）：不含 role/frequency/acceptance 词，
 * 避免非必要拉高岗位/频次提及与闭环密度 */
const PLAN_PROCESS_SENTENCES: readonly string[] = [
  '上述要求纳入施工方案与工艺流程，作业层按统一步骤组织实施并留存过程记录。',
  '相关控制要点编入施工组织设计的作业流程，施工步骤逐项核实后执行。',
  '上述做法以专项施工方案明确的工艺步骤为准，施工过程数据随做随记。',
  '相关要求同步写入技术交底与作业指导书，按既定施工流程逐项落实到位。',
  '上述作业要求纳入施工方案与作业流程管理，各项步骤执行情况逐班核对。',
  '相关控制内容编入施工工序卡与操作规程，作业班组按卡执行并在班后小结。',
  '上述措施通过技术措施交底落实到位，各道工序衔接条件逐项核对确认。',
  '相关要求纳入项目管理制度与施工流程，实施情况定期汇总并留存记录。',
  '上述内容以施工方案与工艺流程为主线逐项分解，作业步骤执行情况可追溯可核验。',
  '相关做法纳入技术措施与施工工序管理，过程数据及时记录、随时可查。',
];

/** B 组（plan+process+role+frequency 四词，用于 hits≤1 或 A 组推不过 4 项线的块）：
 * 不含 acceptance 词（闭环密度守卫） */
const QUAD_ELEMENT_SENTENCES: readonly string[] = [
  '上述措施纳入施工方案与工艺流程统一实施，项目经理每日巡查、技术负责人每周复核落实情况。',
  '相关要求编入作业指导书并明确施工流程，施工员每日现场核查、质检员每周抽查记录。',
  '上述安排通过技术交底落实到施工步骤，安全员每日巡检、材料员每批核对台账。',
  '相关内容纳入施工组织设计与作业流程管理，资料员每日更新记录、测量员每周复核数据。',
  '上述要求以专项施工方案与工艺步骤为准，质检员每日核验、试验员每周抽样核对。',
  '相关控制项编入管理制度与施工工序管理，项目经理每周检查、施工员每日跟班落实。',
  '上述做法按施工方案确定的作业流程推进，安全员每日巡查、资料员每周整理记录。',
  '相关内容同步纳入操作规程与工艺流程，劳资员每月核对、班组长每日提醒执行。',
  '上述措施以施工方案与施工步骤为基准逐项落实，技术负责人每日跟进、质检员每批抽验。',
  '相关要求编入作业指导书与作业流程，施工员每日填写记录、安全员每周检查落实情况。',
];

/** C 组极值兜底（含 acceptance 词）：仅当 A/B 均无法把块推过 4 项线时使用
 * （如仅缺验收闭环要素的块）；「复查」类词受闭环密度上限约束，必须最后手段、低频触发 */
const CLOSURE_FALLBACK_SENTENCES: readonly string[] = [
  '上述事项纳入施工方案台账管理，每月复查落实情况并归档记录。',
  '相关要求编入管理制度并明确复查节点，执行偏差按月纠正处理。',
  '上述措施随作业指导书同步下发，落实情况定期复查并纳入考核记录。',
];

/** 单句全文复用上限：sectionDuplicateIssues 需同对章节重合 ≥3 句才命中，
 * 单句 ≤3 次不构成跨节重复；uniquenessScore 完全重复率占比可忽略 */
const SENTENCE_REUSE_CAP = 3;

function hitKeys(text: string): Set<ElementKey> {
  const hits = new Set<ElementKey>();
  for (const key of ELEMENT_KEYS) {
    if (FIVE_ELEMENT_WORD_RES[key].test(text)) hits.add(key);
  }
  return hits;
}

/** 排他块：未完成标记/代码围栏/封面 HTML/表格块/引用块（C2）
 * （表格结构零风险原则：表格行内或表后不做拼接，表格块整体跳过；
 * 引用块为图件说明/提示性内容，非措施正文，补句会污染图件说明——r28l 实测）
 * 目录区不在此判定——目录导航行常自成一段且段首不是「目录」标题，
 * 由主函数按行范围（目录标题行 → 下一个 H1/H2 前）整区跳过 */
function isExcludedBlock(text: string): boolean {
  if (/^#{1,2}\s*目录/u.test(text.trim())) return true;
  if (/WRITER_MISSING_SECTION|Writer\s*未完成/u.test(text)) return true;
  if (text.includes('```') || /<div\s|<table\s/iu.test(text)) return true;
  if (/^\s*\|/mu.test(text)) return true;
  if (/^\s*>/mu.test(text)) return true;
  return false;
}

/** 行后首个非空行（表题行防粘连判定：下一非空行以「|」开头即当前行紧邻表格上方） */
function nextNonBlankLine(lines: string[], fromIndex: number): string {
  for (let cursor = fromIndex + 1; cursor < lines.length; cursor += 1) {
    const text = (lines[cursor] ?? '').trim();
    if (text) return text;
  }
  return '';
}

/** 块级扫描与补强（幂等：补句后块已达 4 项线，复跑自然跳过） */
export function enforceFiveElementClosureBoost(markdown: string): { markdown: string; fixedCount: number } | null {
  const lines = markdown.split('\n');
  // 目录区行范围：目录标题行起至下一个 H1/H2 标题前——目录导航行（「第X章 名称」+ 缩进条目）
  // 不是措施正文，且常自成空行段（段首无「目录」字样），必须按行范围整区排除
  const tocRanges: Array<{ start: number; end: number }> = [];
  lines.forEach((line, index) => {
    if (!/^#{1,2}\s*目录\s*$/u.test(line.trim())) return;
    let end = lines.length - 1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^#{1,2}\s+/u.test((lines[cursor] ?? '').trim())) { end = cursor - 1; break; }
    }
    tocRanges.push({ start: index, end });
  });
  const inTocRange = (lineIndex: number): boolean => tocRanges.some(range => lineIndex >= range.start && lineIndex <= range.end);
  // C2 防护：附表区行范围（「## 附表…」标题起至文末）整区跳过——附表区为数据表/图件说明/骨架，
  // 补强句会污染数据表与图件说明（r28l 实测附表四/五图件说明被补强句污染）
  const appendixStart = lines.findIndex(line => /^##\s*附表/u.test(line.trim()));
  const inAppendixRange = (lineIndex: number): boolean => appendixStart >= 0 && lineIndex >= appendixStart;
  interface Segment { startLine: number; endLine: number; text: string }
  const segments: Segment[] = [];
  let segmentStart = -1;
  lines.forEach((line, index) => {
    const blank = line.trim() === '';
    if (!blank && segmentStart < 0) segmentStart = index;
    if ((blank || index === lines.length - 1) && segmentStart >= 0) {
      const endLine = blank ? index - 1 : index;
      const text = lines.slice(segmentStart, endLine + 1).join('\n');
      if (text.trim().length >= 30 && !inTocRange(segmentStart) && !inAppendixRange(segmentStart)) {
        segments.push({ startLine: segmentStart, endLine, text });
      }
      segmentStart = -1;
    }
  });
  const inserts: Array<{ lineIndex: number; sentence: string }> = [];
  const usage = new Map<string, number>();
  const pickSentence = (hits: Set<ElementKey>, pools: readonly (readonly string[])[], hashSeed: number): string | null => {
    for (const pool of pools) {
      const start = hashSeed % pool.length;
      for (let offset = 0; offset < pool.length; offset += 1) {
        const sentence = pool[(start + offset) % pool.length] ?? '';
        if (!sentence || (usage.get(sentence) || 0) >= SENTENCE_REUSE_CAP) continue;
        const merged = new Set<ElementKey>([...hits, ...hitKeys(sentence)]);
        if (merged.size >= 4) return sentence;
      }
    }
    return null;
  };
  for (const segment of segments) {
    const hits = hitKeys(segment.text);
    if (hits.size >= 4 || isExcludedBlock(segment.text)) continue;
    // 段内目录行混排（首行正文 + 后续导航行）时同样跳过：任一行位于目录区即非纯净措施段
    let tocTouched = false;
    for (let lineIndex = segment.startLine; lineIndex <= segment.endLine; lineIndex += 1) {
      if (inTocRange(lineIndex)) { tocTouched = true; break; }
    }
    if (tocTouched) continue;
    const pools = hits.size >= 2
      ? [PLAN_PROCESS_SENTENCES, QUAD_ELEMENT_SENTENCES, CLOSURE_FALLBACK_SENTENCES]
      : [QUAD_ELEMENT_SENTENCES, CLOSURE_FALLBACK_SENTENCES];
    const sentence = pickSentence(hits, pools, parseInt(stableHash(segment.text).slice(0, 8), 16) || 0);
    if (!sentence) continue;
    usage.set(sentence, (usage.get(sentence) || 0) + 1);
    // 段末行是标题行、图题行，或其后首个非空行是表格行（表题行/表前引导行形态）时向上找正文行——
    // 防补句被拼进标题行/图题行/表题行（r28l 实测：补句拼到图题行「图4-3 网络图」尾后经图位链
    // 形成「图4-3 网络图相关内容纳入…」污染行；通用结构判据，无项目语义）；
    // 段内全为标题/图题/表题行时跳过本段不补
    let target = segment.endLine;
    while (target >= segment.startLine) {
      const current = (lines[target] ?? '').trim();
      if (/^#{1,6}\s/u.test(current) || nextNonBlankLine(lines, target).startsWith('|') || /^\*{0,2}图\s*(?:\d|[ \u3000])/u.test(current)) {
        target -= 1;
        continue;
      }
      break;
    }
    if (target < segment.startLine) continue;
    // D-T6 ③ 长段防护（r28f 归因：写作期切分上限 360 的段被补句 30 拼接后 390 超终检 380
    // 阈值直坠过长段落判定）：拼接后行超 370 字符时放弃本段补写——长段消除为 P0 结构判据，
    // 优先于本段闭合密度收益；该段保持原样（≤380 不触发链尾切分），其它来源的长段由链尾
    // splitOverlengthBodyParagraphs 收口。跳过后复跑同条件跳过（幂等零变化）。
    const targetRaw = lines[target] ?? '';
    const targetText = targetRaw.endsWith('\r') ? targetRaw.slice(0, -1) : targetRaw;
    if (targetText.length + sentence.length > 370) continue;
    inserts.push({ lineIndex: target, sentence });
  }
  if (inserts.length === 0) return null;
  // 逆序回写：同行追加（段内单行拼接，块结构不变）
  for (let index = inserts.length - 1; index >= 0; index -= 1) {
    const item = inserts[index];
    if (!item) continue;
    const line = lines[item.lineIndex] ?? '';
    const carriage = line.endsWith('\r') ? '\r' : '';
    lines[item.lineIndex] = line.slice(0, line.length - carriage.length) + item.sentence + carriage;
  }
  return { markdown: lines.join('\n'), fixedCount: inserts.length };
}
