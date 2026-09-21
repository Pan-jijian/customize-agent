/**
 * repairRounds/basisRegulationsCrossRepair：编制依据↔正文双向对账链尾收口轮（C5 一致性类 P6）。
 *
 * 背景（r28l/s28l 实测）：编制依据声明与正文引用双向失衡——r28l 声明未用 8/引用未声明 7、
 * s28l 声明未用 4/引用未声明 15，此前只有终检 basis-regulations-cross 报出、修复链无轮消费
 * （used_not_declared 为 blocker 级），缺口直坠终门禁。本轮链尾收口（位置在 basisRegulationsRepair
 * 之后：前者管「编制依据有没有法规/规范条目」，本轮管「条目与正文引用是否一一对应」）：
 *
 * - Phase A（确定性零 LLM）：used_not_declared → 从正文引用上下文回补标准全名（纯编号缺口按
 *   邻近窗口回补书名），插入编制依据小节条目最密集行的同类目尾部（《名》（编号）成对形态）；
 * - Phase B（分类消费）：declared_not_used → 区分性 token 滑窗匹配定位应用章——命中章 LLM 定向
 *   补写应用引用句（落到工序/验收语境；复检引用数下降才继续下一轮）；无任何章命中 = 不适用 →
 *   确定性从编制依据移除（span 手术含分隔符/整行残留清理，移除后复验条目确已消失）；
 * - Phase C（全局复检）：重建正文后重新审计——双向缺口须净减少且两个方向均不得上升
 *   （防误报回滚），汉字数不低于「修复前 − 设计移除量 − max(40, 5%)」门槛（防删除式修复），
 *   任一违反即整体回滚（恢复章草稿 + 重建 + 重算）。
 *
 * 口径单源：审计/匹配/标签渲染复用 basisRegulationsCross（检测定位=修复定位）；区段范围复用
 * qualityValidation.basisRegulationSectionRanges（与检测端排除区段同源）。编制依据区段位于
 * 章外结构（章级无区段）时确定性插入/移除无定向目标，显性记录交终门禁，不猜测改写。
 */
import { basisRegulationSectionRanges, extractBasisRegulationSection } from '../../qualityValidation';
import {
  auditBasisRegulationsCross,
  extractRegulationBookNames,
  extractRegulationCodes,
  normalizeRegulationName,
  REGULATION_BOOK_RE,
  REGULATION_CODE_RE,
  regulationNameMatches,
  renderGapLabel,
  sameRegulationCodeFamily,
  type BasisRegulationCrossGap,
} from '../../basisRegulationsCross';
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import type { FinalizeSession } from '../finalizeSession';

/** Phase B 单轮 LLM 应用章预算（超出按分值降序留守，交终门禁照常复核） */
const MAX_APPLICATION_CHAPTERS = 6;

/** 每章应用引用补写轮上限（残留条目数下降才继续下一轮） */
const MAX_APPLICATION_ROUNDS = 2;

/** 区分性 token 命中下限（低于该分值 = 全文无应用证据 → 不适用 → 确定性移除） */
const MIN_APPLICATION_SCORE = 3;

/** 单枚 token 计入上限（防高频通用词刷分淹没区分性判断） */
const TOKEN_HIT_CAP = 3;

/** 纯编号缺口从正文邻近窗口回补书名的半窗（字符） */
const CODE_NAME_WINDOW = 30;

/** 条目「书名↔编号」合并手术的邻近上限（超出视为两处独立条目分别移除） */
const ENTRY_SPAN_GAP = 14;

/** 防删除式修复：汉字数守卫（不低于修复前 − 设计移除量 − max(40, 5%)） */
const HAN_GUARD_BASE = 40;
const HAN_GUARD_RATIO = 0.05;

/** 移除手术后仅剩列表序号/项目符号/标点的残留行（整行移除） */
const RESIDUE_LINE_RE = /^\s*(?:[-*•·]|\d{1,4}[.、)）]|[一二三四五六七八九十]{1,3}、|（\d{1,4}）)?[\s。.；;，,、]*$/u;

/** 标准名称 token 化停用片段（通用词与连接词；其余相邻字 bigram 作区分性 token） */
const NAME_STOP_FRAGMENTS = ['中华人民共和国', '国家标准', '标准', '规范', '规程', '技术', '工程', '施工', '质量', '验收', '设计', '安全', '管理', '方法', '要求', '统一', '国家', '及', '与', '和', '的'];

function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
}

/** 行起点字符偏移表（区段行号 → 字符偏移换算） */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

/** 剔除编制依据区段行（评分/引用判定口径与检测端一致：声明区段不计为正文引用） */
function stripBasisSectionLines(text: string): string {
  const ranges = basisRegulationSectionRanges(text);
  if (ranges.length === 0) return text;
  const excluded = new Set<number>();
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) excluded.add(index);
  }
  return text.split(/\r?\n/u).filter((_, index) => !excluded.has(index)).join('\n');
}

/** 区分性 token：归一化去停用片段后取相邻字 bigram（含数字/字母的碎片不参与） */
function distinctiveTokens(name: string): string[] {
  let residual = normalizeRegulationName(name);
  for (const fragment of NAME_STOP_FRAGMENTS) residual = residual.split(fragment).join('');
  const tokens = new Set<string>();
  for (let index = 0; index + 2 <= residual.length; index += 1) {
    const token = residual.slice(index, index + 2);
    if (/^[\u4e00-\u9fa5]{2}$/u.test(token)) tokens.add(token);
  }
  return [...tokens];
}

/** 章内区分性 token 命中分值（出区段正文；单 token 计入上限防通用词刷分） */
function chapterApplicationScore(content: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const body = stripBasisSectionLines(content).replace(/[\s\u200b-\u200d\ufeff]/gu, '');
  let score = 0;
  for (const token of tokens) {
    let hits = 0;
    let from = 0;
    while (hits < TOKEN_HIT_CAP) {
      const index = body.indexOf(token, from);
      if (index < 0) break;
      hits += 1;
      from = index + token.length;
    }
    score += hits;
  }
  return score;
}

/** 缺口条目是否已在目标正文获正式引用（出区段；与检测端匹配原语同源） */
function gapCitedInBody(content: string, gap: BasisRegulationCrossGap): boolean {
  const body = stripBasisSectionLines(content);
  if (gap.code && extractRegulationCodes(body).some(code => sameRegulationCodeFamily(code, gap.code!))) return true;
  if (gap.name && extractRegulationBookNames(body).some(name => regulationNameMatches(name, gap.name!))) return true;
  return false;
}

/** 缺口条目是否仍存在于编制依据声明区（移除手术的复验判据） */
function gapDeclaredInSection(sectionText: string, gap: BasisRegulationCrossGap): boolean {
  if (gap.name && extractRegulationBookNames(sectionText).some(name => regulationNameMatches(name, gap.name!))) return true;
  if (gap.code && extractRegulationCodes(sectionText).some(code => sameRegulationCodeFamily(code, gap.code!))) return true;
  return false;
}

// ═══════════════════════ Phase A：used_not_declared 确定性补写 ═══════════════════════

/** 纯编号缺口从全文邻近窗口回补书名（检测端配对失败的编号单独出现时；最近者优先） */
function recoverCodeName(markdown: string, code: string): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const match of markdown.matchAll(REGULATION_CODE_RE)) {
    if (!sameRegulationCodeFamily(match[0], code)) continue;
    const index = match.index ?? 0;
    const windowStart = Math.max(0, index - CODE_NAME_WINDOW);
    const windowEnd = Math.min(markdown.length, index + match[0].length + CODE_NAME_WINDOW);
    const window = markdown.slice(windowStart, windowEnd);
    for (const nameMatch of window.matchAll(REGULATION_BOOK_RE)) {
      const nameIndex = windowStart + (nameMatch.index ?? 0);
      const distance = Math.abs(nameIndex - index);
      if (!best || distance < best.distance) best = { name: nameMatch[0].replace(/《|》/gu, ''), distance };
    }
  }
  return best?.name;
}

/** 补写条目文本：pair → 《名》（编号）；name → 《名》；code → 回补书名后 《名》（编号），无书名则裸编号 */
function buildInsertionEntry(gap: BasisRegulationCrossGap, markdown: string): string {
  if (gap.kind === 'pair') return `《${gap.name}》（${gap.code}）`;
  if (gap.kind === 'name') return `《${gap.value}》`;
  const code = gap.code ?? gap.value;
  const name = gap.counterpart || recoverCodeName(markdown, code);
  return name ? `《${name}》（${code}）` : code;
}

/** 按行尾标点选择条目挂接形态（句号前插「、」；冒号/分号后直接续写；其余补「、」） */
function appendEntriesToLine(line: string, joined: string): string {
  const mark = /([。；;：:])\s*$/u.exec(line);
  if (mark) {
    const markText = mark[1];
    if (markText === '。') {
      return `${line.slice(0, mark.index)}、${joined}。${line.slice(mark.index + markText.length)}`;
    }
    return `${line}${joined}`;
  }
  if (/[、，,]\s*$/u.test(line)) return `${line}${joined}`;
  return `${line}、${joined}`;
}

/** Phase A 主体：把缺口条目插入编制依据区段条目最密集的非表格行尾（同类目追加；无则表格块后新起一行） */
function insertUsedEntries(content: string, entries: string[]): string | undefined {
  if (entries.length === 0) return undefined;
  const ranges = basisRegulationSectionRanges(content);
  if (ranges.length === 0) return undefined;
  const lines = content.split(/\r?\n/u);
  let bestNonTable: { index: number; score: number } | undefined;
  let bestTable: { index: number; score: number } | undefined;
  for (const range of ranges) {
    for (let index = range.start + 1; index < range.end; index += 1) {
      const line = lines[index];
      if (!line?.trim()) continue;
      const score = (line.match(REGULATION_BOOK_RE)?.length ?? 0) + (line.match(REGULATION_CODE_RE)?.length ?? 0);
      if (score === 0) continue;
      const isTable = line.trim().startsWith('|');
      if (isTable) {
        if (!bestTable || score >= bestTable.score) bestTable = { index, score };
      } else if (!bestNonTable || score >= bestNonTable.score) {
        bestNonTable = { index, score };
      }
    }
  }
  const joined = entries.join('、');
  if (bestNonTable) {
    lines[bestNonTable.index] = appendEntriesToLine(lines[bestNonTable.index], joined);
  } else if (bestTable) {
    // 表格锚点：不改表格结构（列数未知不猜表行），在表格块结束行后新起条目行
    let blockEnd = bestTable.index;
    while (blockEnd + 1 < lines.length && (lines[blockEnd + 1] ?? '').trim().startsWith('|')) blockEnd += 1;
    lines.splice(blockEnd + 1, 0, joined);
  } else {
    // 区段内无条目行（罕见形态）：末段末尾（下一标题行之前）新起条目行
    const lastRange = ranges[ranges.length - 1];
    lines.splice(Math.max(lastRange.start + 1, lastRange.end), 0, joined);
  }
  const updated = lines.join('\n');
  if (updated === content || hanCount(updated) <= hanCount(content)) return undefined;
  return updated;
}

// ═══════════════════════ Phase B ③：不适用声明的确定性移除 ═══════════════════════

interface SurgerySpan { start: number; end: number }

/** 书名 span（归一化匹配首个命中） */
function findNameSpan(text: string, name: string): SurgerySpan | undefined {
  for (const match of text.matchAll(REGULATION_BOOK_RE)) {
    if (!regulationNameMatches(match[0], name)) continue;
    const start = match.index ?? 0;
    return { start, end: start + match[0].length };
  }
  return undefined;
}

/** 编号 span（同族匹配首个命中） */
function findCodeSpan(text: string, code: string): SurgerySpan | undefined {
  for (const match of text.matchAll(REGULATION_CODE_RE)) {
    if (!sameRegulationCodeFamily(match[0], code)) continue;
    const start = match.index ?? 0;
    return { start, end: start + match[0].length };
  }
  return undefined;
}

/** 条目 span 解析：书名与编号紧邻（≤ 14 字）合并为一段（含包裹括号），否则分别移除 */
function resolveEntrySpans(slice: string, gap: BasisRegulationCrossGap): SurgerySpan[] {
  const nameSpan = gap.name ? findNameSpan(slice, gap.name) : undefined;
  const codeSpan = gap.code ? findCodeSpan(slice, gap.code) : undefined;
  if (nameSpan && codeSpan) {
    const forward = codeSpan.start >= nameSpan.end && codeSpan.start - nameSpan.end <= ENTRY_SPAN_GAP;
    const backward = nameSpan.start >= codeSpan.end && nameSpan.start - codeSpan.end <= ENTRY_SPAN_GAP;
    if (forward || backward) {
      let end = Math.max(nameSpan.end, codeSpan.end);
      if (end < slice.length && (slice[end] === '）' || slice[end] === ')')) end += 1;
      return [{ start: Math.min(nameSpan.start, codeSpan.start), end }];
    }
    return [nameSpan, codeSpan];
  }
  if (nameSpan) return [nameSpan];
  if (codeSpan) {
    // 编号被括号单独包裹时连括号一并移除（开闭括号同现才扩展，防误伤）
    if (codeSpan.start > 0 && (slice[codeSpan.start - 1] === '（' || slice[codeSpan.start - 1] === '(')
      && codeSpan.end < slice.length && (slice[codeSpan.end] === '）' || slice[codeSpan.end] === ')')) {
      return [{ start: codeSpan.start - 1, end: codeSpan.end + 1 }];
    }
    return [codeSpan];
  }
  return [];
}

/** 区段字符切片内定位缺口条目 span（按区段行号换算字符偏移；首个含命中的区段） */
function locateGapSpans(content: string, gap: BasisRegulationCrossGap): SurgerySpan[] | undefined {
  const ranges = basisRegulationSectionRanges(content);
  if (ranges.length === 0) return undefined;
  const offsets = lineOffsets(content);
  for (const range of ranges) {
    const startOffset = offsets[range.start] ?? 0;
    const endOffset = offsets[range.end] ?? content.length;
    const slice = content.slice(startOffset, endOffset);
    const spans = resolveEntrySpans(slice, gap);
    if (spans.length > 0) {
      return spans.map(span => ({ start: startOffset + span.start, end: startOffset + span.end }));
    }
  }
  return undefined;
}

/** 术后标点治理：连续顿号折叠、标点前悬挂顿号剔除 */
function collapseSeparators(text: string): string {
  return text.replace(/、{2,}/gu, '、').replace(/、(?=[。.；;，,])/gu, '');
}

/** span 手术（含分隔符吸收与整行残留清理；哨兵标记保证只清理被改动的行） */
function applySurgery(content: string, spans: SurgerySpan[]): string {
  const sentinel = '\u0000';
  let working = content;
  for (const span of [...spans].sort((left, right) => right.start - left.start)) {
    let start = span.start;
    let end = span.end;
    let absorbedRight = 0;
    while (end < working.length && absorbedRight < 2 && /[、，,；;]/u.test(working[end])) {
      end += 1;
      absorbedRight += 1;
    }
    if (absorbedRight === 0) {
      let absorbedLeft = 0;
      while (start > 0 && absorbedLeft < 2 && /[、，,；;]/u.test(working[start - 1])) {
        start -= 1;
        absorbedLeft += 1;
      }
    }
    working = `${working.slice(0, start)}${sentinel}${working.slice(end)}`;
  }
  const kept: string[] = [];
  for (const line of working.split(/\r?\n/u)) {
    if (!line.includes(sentinel)) {
      kept.push(line);
      continue;
    }
    const cleaned = collapseSeparators(line.split(sentinel).join(''));
    if (RESIDUE_LINE_RE.test(cleaned)) continue;
    kept.push(cleaned);
  }
  return kept.join('\n');
}

/** 移除单条不适用声明（含重复声明多轮清理）；移除后复验条目确已消失，失败返回 undefined 保留原文 */
function removeDeclaredGap(content: string, gap: BasisRegulationCrossGap): string | undefined {
  let working = content;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const spans = locateGapSpans(working, gap);
    if (!spans) break;
    working = applySurgery(working, spans);
  }
  if (working === content || working.length >= content.length) return undefined;
  if (basisRegulationSectionRanges(working).length === 0) return undefined;
  if (gapDeclaredInSection(extractBasisRegulationSection(working), gap)) return undefined;
  return working;
}

/** Phase B 应用引用补写指令（落到工序/验收语境的正式引用，禁止口号句/纯清单句） */
function buildApplicationInstruction(chapterTitle: string, gaps: BasisRegulationCrossGap[]): string {
  return [
    '【编制依据双向对账定向修复】',
    `本章（${chapterTitle}）被判定为以下编制依据条目的应用章节：这些标准已在编制依据小节声明，但全文正文缺少实际应用引用。`,
    '待落位条目（补写后必须在本章正文出现正式引用——书名号全名；条目带编号时须一并写全编号）：',
    ...gaps.map(gap => `- ${renderGapLabel(gap)}`),
    '修复要求：',
    '1. 在本章对应工序/质量验收要求的既有段落中补写自然应用引用句（写清该标准用于哪个工序环节的什么控制指标或验收要求），引用必须使用《标准名称》（编号）正式形态；',
    '2. 引用句须镶嵌进既有施工或验收语境，不得写成孤立口号句、纯清单句或文末罗列；',
    '3. 不改写、不删除既有内容，不新增/删除小节标题，不调整表格结构；其余内容一字不动。',
  ].join('\n');
}

export async function stageBasisRegulationsCrossRepair(session: FinalizeSession): Promise<void> {
  const entryAudit = auditBasisRegulationsCross(session.finalMarkdown);
  // 无编制依据声明条目（含区段缺失）：与检测端同口径静默跳过（模板结构差异不误伤）
  if (entryAudit.stats.declaredCodes + entryAudit.stats.declaredNames === 0) return;
  // 双向缺口均为零：零成本通过（链尾静默，不写进度事件）
  if (entryAudit.declaredNotUsed.length === 0 && entryAudit.usedNotDeclared.length === 0) return;
  const han0 = hanCount(session.finalMarkdown);
  const initialGapCount = entryAudit.declaredNotUsed.length + entryAudit.usedNotDeclared.length;
  const workingContents = new Map<number, string>();
  const contentOf = (index: number): string => workingContents.get(index) ?? session.finalChapterDrafts[index].content;
  const emitRecord = (stage: ReturnType<typeof displayStage>): void => {
    upsertProgressStage(session.progressStages, stage);
    upsertProgressStage(session.finalGateRepairStages, stage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  };

  // 编制依据所在章定位（确定性插入/移除的定向目标；区段位于章外结构时不猜测改写）
  const basisChapterIndex = session.finalChapterDrafts.findIndex(chapter => basisRegulationSectionRanges(chapter.content).length > 0);
  if (basisChapterIndex < 0) {
    emitRecord(displayStage({ type: 'validation', roleId: 'basis-regulations-cross-repair', status: 'failed', message: '编制依据双向对账收口：全文存在对账缺口但各章均无编制依据区段（区段位于章外结构），确定性插入/移除无定向目标，由终门禁照常复核' }, { subtitle: '评审后兜底' }));
  }

  // ── Phase A：used_not_declared 确定性补写（零 LLM；从正文引用上下文回补标准全名）──
  let insertedCount = 0;
  if (basisChapterIndex >= 0 && entryAudit.usedNotDeclared.length > 0) {
    const basisContent = contentOf(basisChapterIndex);
    const sectionText = extractBasisRegulationSection(basisContent);
    const missing = entryAudit.usedNotDeclared.filter(gap => !gapDeclaredInSection(sectionText, gap));
    if (missing.length > 0) {
      const inserted = insertUsedEntries(basisContent, missing.map(gap => buildInsertionEntry(gap, session.finalMarkdown)));
      if (inserted) {
        workingContents.set(basisChapterIndex, inserted);
        insertedCount = missing.length;
        emitRecord(displayStage({ type: 'validation', roleId: 'basis-regulations-cross-repair', status: 'success', message: `编制依据双向对账：引用未声明 ${insertedCount} 条确定性补入编制依据小节（${missing.map(renderGapLabel).join('、')}）` }, { subtitle: '评审后兜底' }));
      } else {
        emitRecord(displayStage({ type: 'validation', roleId: 'basis-regulations-cross-repair', status: 'failed', message: `编制依据双向对账：引用未声明 ${missing.length} 条确定性补入失败（区段无可用锚点行），由终门禁照常复核` }, { subtitle: '评审后兜底' }));
      }
    }
  }

  // ── Phase B：declared_not_used 分类消费（区分性 token 定位应用章 → LLM 补引用；零命中 → 不适用移除）──
  const assignmentTargets = new Map<number, { score: number; gaps: BasisRegulationCrossGap[] }>();
  const removalGaps: BasisRegulationCrossGap[] = [];
  for (const gap of entryAudit.declaredNotUsed) {
    const tokens = distinctiveTokens(gap.name ?? gap.value);
    let bestIndex = -1;
    let bestScore = 0;
    session.finalChapterDrafts.forEach((_, index) => {
      const score = chapterApplicationScore(contentOf(index), tokens);
      if (score >= MIN_APPLICATION_SCORE && score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    });
    if (bestIndex >= 0) {
      const bucket = assignmentTargets.get(bestIndex) ?? { score: 0, gaps: [] };
      bucket.gaps.push(gap);
      bucket.score = Math.max(bucket.score, bestScore);
      assignmentTargets.set(bestIndex, bucket);
    } else {
      removalGaps.push(gap);
    }
  }
  const ranked = [...assignmentTargets.entries()].sort((left, right) => right[1].score - left[1].score);
  const selected = ranked.slice(0, MAX_APPLICATION_CHAPTERS);
  const overflowGapCount = ranked.slice(MAX_APPLICATION_CHAPTERS).reduce((sum, entry) => sum + entry[1].gaps.length, 0);
  let applicationChapters = 0;
  let applicationResolved = 0;
  let applicationResidual = overflowGapCount;
  for (const [chapterIndex, assignment] of selected) {
    const chapter = session.finalChapterDrafts[chapterIndex];
    const baseline = contentOf(chapterIndex);
    const baselinePending = assignment.gaps.filter(gap => !gapCitedInBody(baseline, gap)).length;
    if (baselinePending === 0) continue;
    let content = baseline;
    let pending = assignment.gaps.filter(gap => !gapCitedInBody(content, gap));
    let rounds = 0;
    let anyRollback = false;
    let chapterRepaired = false;
    const roleId = `agent-basis-regulations-cross-repair-${chapter.id}`;
    while (rounds < MAX_APPLICATION_ROUNDS && pending.length > 0) {
      rounds += 1;
      const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `编制依据双向对账应用引用补写中（第 ${rounds}/${MAX_APPLICATION_ROUNDS} 轮）：${chapter.title}（待落位 ${pending.length} 条）` }, { subtitle: '评审后兜底' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const pendingBefore = pending.length;
      const outcome = await withPatchRollback({
        originalContent: content,
        repairRound: 'basis-regulations-cross-repair',
        diagnostics: session.generationDiagnostics,
        apply: async () => {
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: chapter.id, title: chapter.title, content, evidence: chapter.evidence, missingFacts: chapter.missingFacts, sections: chapter.sections },
            issues: pending.map(gap => `编制依据对账缺口：正文未引用 ${renderGapLabel(gap)}`),
            promptTexts: buildApplicationInstruction(chapter.title, pending),
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（正文表格口径）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('basis-regulations-cross-repair', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== content ? repaired.content : content;
        },
        // 指标 1：本章待落位条目未获引用数（越大越差）；指标 2：负汉字数（防删除式修复）
        recheck: (value) => [assignment.gaps.filter(gap => !gapCitedInBody(value, gap)).length, -hanCount(value)],
        shouldRollback: (before, after) => after[0] > before[0] || after[1] > before[1] + Math.max(40, Math.abs(before[1]) * 0.05),
      });
      if (outcome.rolledBack) {
        anyRollback = true;
        break;
      }
      if (outcome.content === content) break;
      const nextPending = assignment.gaps.filter(gap => !gapCitedInBody(outcome.content, gap));
      content = outcome.content;
      chapterRepaired = true;
      if (nextPending.length >= pendingBefore) {
        pending = nextPending;
        break;
      }
      pending = nextPending;
    }
    if (content !== baseline) {
      workingContents.set(chapterIndex, content);
      applicationChapters += 1;
      applicationResolved += baselinePending - pending.length;
      applicationResidual += pending.length;
    } else {
      applicationResidual += baselinePending;
    }
    const residual = pending.length;
    let message: string;
    if (residual === 0) message = `编制依据双向对账应用引用补写完成：${chapter.title}（${rounds} 轮，待落位条目全部获正文引用）`;
    else if (chapterRepaired) message = `编制依据双向对账应用引用补写部分生效：${chapter.title}（已执行 ${rounds} 轮，残留 ${residual} 条未获引用，由终门禁照常复核）`;
    else if (anyRollback) message = `编制依据双向对账应用引用补写已回滚：${chapter.title}（复检未通过，保留修复前正文；残留 ${residual} 条，由终门禁照常复核）`;
    else message = `编制依据双向对账应用引用补写未生效：${chapter.title}（模型未产生有效修改；残留 ${residual} 条，由终门禁照常复核）`;
    const completedStage = displayStage({ type: 'llm_review', roleId, status: residual === 0 ? 'success' : 'failed', message, details: residual > 0 ? pending.map(gap => `未获引用：${renderGapLabel(gap)}`) : ['复检：本章待落位编制依据条目全部获正文引用'] }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }

  // ── Phase B ③：不适用声明确定性移除（全文无任何章含区分性 token 应用证据）──
  let removedCount = 0;
  let designedRemovalHan = 0;
  if (basisChapterIndex >= 0 && removalGaps.length > 0) {
    let content = contentOf(basisChapterIndex);
    const removed: BasisRegulationCrossGap[] = [];
    for (const gap of removalGaps) {
      const next = removeDeclaredGap(content, gap);
      if (!next) continue;
      designedRemovalHan += hanCount(content) - hanCount(next);
      content = next;
      removed.push(gap);
    }
    if (removed.length > 0) workingContents.set(basisChapterIndex, content);
    removedCount = removed.length;
    const failedCount = removalGaps.length - removed.length;
    emitRecord(displayStage({
      type: 'validation',
      roleId: 'basis-regulations-cross-repair',
      status: failedCount === 0 ? 'success' : 'failed',
      message: failedCount === 0
        ? `编制依据双向对账：不适用声明 ${removedCount} 条确定性移除（正文零引用且无匹配章节：${removed.map(renderGapLabel).join('、')}）`
        : `编制依据双向对账：不适用声明移除 ${removedCount}/${removalGaps.length} 条（${failedCount} 条未定位条目 span 保留原文，由终门禁照常复核）`,
    }, { subtitle: '评审后兜底' }));
  }

  // ── Phase C：全局复检（净减少 + 双方向不上升 + 防删除式汉字门槛；违反即整体回滚）──
  const changed = [...workingContents.entries()].filter(([index, content]) => content !== session.finalChapterDrafts[index].content);
  if (changed.length === 0) {
    session.generationDiagnostics.llm.lastInfo = `编制依据双向对账收口：无有效变更落地（引用未声明 ${entryAudit.usedNotDeclared.length} 条、声明未用 ${entryAudit.declaredNotUsed.length} 条残留，由终门禁照常复核）`;
    return;
  }
  const originals = changed.map(([index]) => ({ index, draft: session.finalChapterDrafts[index] }));
  for (const [index, content] of changed) {
    session.finalChapterDrafts[index] = { ...session.finalChapterDrafts[index], content };
  }
  session.finalMarkdown = session.rebuildFinalMarkdown();
  await session.recomputeFinalValidationBundle();
  const endAudit = auditBasisRegulationsCross(session.finalMarkdown);
  const endGapCount = endAudit.declaredNotUsed.length + endAudit.usedNotDeclared.length;
  const hanEnd = hanCount(session.finalMarkdown);
  const improved = endGapCount < initialGapCount
    && endAudit.usedNotDeclared.length <= entryAudit.usedNotDeclared.length
    && endAudit.declaredNotUsed.length <= entryAudit.declaredNotUsed.length;
  const hanOk = hanEnd >= han0 - designedRemovalHan - Math.max(HAN_GUARD_BASE, Math.round(han0 * HAN_GUARD_RATIO));
  if (!improved || !hanOk) {
    for (const { index, draft } of originals) session.finalChapterDrafts[index] = draft;
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
    const reasons = [...(improved ? [] : ['双向缺口未净减少']), ...(hanOk ? [] : ['汉字数低于防删除门槛'])].join('且');
    emitRecord(displayStage({ type: 'validation', roleId: 'basis-regulations-cross-repair', status: 'failed', message: `编制依据双向对账收口整体回滚：复检未通过（${reasons}）——补写/移除变更全部撤销，缺口由终门禁照常复核` }, { subtitle: '评审后兜底' }));
    session.generationDiagnostics.llm.lastInfo = `编制依据双向对账收口：${changed.length} 章变更因复检未通过整体回滚（缺口 ${initialGapCount} 条残留，由终门禁照常复核）`;
    return;
  }
  emitRecord(displayStage({ type: 'validation', roleId: 'basis-regulations-cross-repair', status: endGapCount === 0 ? 'success' : 'failed', message: `编制依据双向对账收口完成：补入 ${insertedCount} 条、应用 ${applicationChapters} 章（解决 ${applicationResolved} 条）、移除 ${removedCount} 条；缺口 ${initialGapCount}→${endGapCount}${endGapCount > 0 ? '（残留由终门禁照常复核）' : '（双向清零）'}` }, { subtitle: '评审后兜底' }));
  session.generationDiagnostics.llm.lastInfo = `编制依据双向对账收口：引用未声明 ${entryAudit.usedNotDeclared.length}→${endAudit.usedNotDeclared.length}、声明未用 ${entryAudit.declaredNotUsed.length}→${endAudit.declaredNotUsed.length}（补入 ${insertedCount} 条、应用 ${applicationChapters} 章、移除 ${removedCount} 条；LLM 侧残留 ${applicationResidual} 条含超预算 ${overflowGapCount} 条）`;
}
