import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { DocumentEvidence, DocumentGenerationDiagnostics, DocumentTemplateChapter, EvidenceBundle, ResourceEvidence } from './types';
import { CAD_ENTITY_TOKEN_RE, FILE_NAME_RE } from './constants';
import { EVIDENCE_PARAMETER_RE, HAS_QUANTIFIED_VALUE_RE } from './parameterPatterns';
import { evidenceMatchesFact } from './factMatching';
import { selectByScore, textImportanceScore } from './selection';

export function readableSourceLabel(item: Pick<DocumentEvidence, 'roleId' | 'processingType' | 'sectionTitle'>, index = 0) {
  const role = item.processingType === 'drawing' || item.roleId?.includes('drawing') ? '视觉资料'
    : item.processingType === 'table' || item.roleId?.includes('bill') ? '表格资料'
      : item.processingType === 'rule' || item.roleId?.includes('tender') ? '规则资料'
        : '文本资料';
  return `${role}片段${index + 1}${item.sectionTitle ? `（${item.sectionTitle.replace(FILE_NAME_RE, '')}）` : ''}`;
}

export function cleanEvidenceText(content: string) {
  return [...content]
    .filter(char => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join('')
    .replace(CAD_ENTITY_TOKEN_RE, '')
    .replace(FILE_NAME_RE, '')
    .replace(/\b(?:Model|Layout\d*|Entity|Handle|ObjectId|ByLayer|Continuous)\b/giu, '')
    .replace(/[\t ]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function evidenceQualityScore(content: string) {
  const text = cleanEvidenceText(content);
  const chars = Math.max(1, text.length);
  const chinese = (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
  const digits = (text.match(/\d/gu) || []).length;
  const semanticTerms = (text.match(/项目|任务|质量|安全|周期|验收|材料|设备|表格|数据|参数|规范|标准|流程|资源|风险/gu) || []).length;
  const noiseHits = (text.match(/CAD|AcDb|Polyline|ByLayer|ObjectId|Handle|Model|Layout|图层|页码|第\s*\d+\s*页|打印|版权所有|^[\s\W\d_]+$/gimu) || []).length;
  const repeatedHeaders = (text.match(/(?:序号|项目名称|事项|单位|数量|单价|金额|备注)/gu) || []).length;
  const factDensity = Math.min(1, (chinese / chars) * 0.7 + Math.min(0.3, (digits + semanticTerms * 3) / 120));
  const noiseScore = Math.min(1, noiseHits * 0.18 + Math.max(0, repeatedHeaders - 8) * 0.04 + (chinese / chars < 0.25 ? 0.35 : 0));
  return { noiseScore, factDensity, shouldUse: text.length >= 30 && noiseScore < 0.72 && factDensity > 0.08 };
}

/**
 * 关键事实行提取（T0 事实层来源）：数值参数行、项目基础事实行、标准规范编号行。
 * 用于证据三层注入的关键事实层——全量保留（评分只决定顺序不决定去留），
 * 重要数据（数值/参数/工期/金额/标高/强度等级/规范编号）经此通道不参与预算裁剪。
 */
export function extractKeyFactLines(content: string) {
  const lines = cleanEvidenceText(content).split('\n').map(line => line.trim()).filter(Boolean);
  const keyLines = lines.filter(line => {
    const isProjectBasicValue = /计划工期|合同工期|工期|合同估算价|合同估算价格|投资估算|估算价格|工程估算价|最高投标限价|招标控制价|建设地点|建设规模|质量标准/u.test(line);
    if (!isProjectBasicValue && /综合单价|合价|报价明细|投标报价|税率|增值税|利润|预留金|暂列金额|结算/u.test(line)) return false;
    const hasParameter = EVIDENCE_PARAMETER_RE.test(line);
    const hasStdCode = /(?:GB\s*\/?\s*T?|JGJ|CJJ|DB\s*\/?\s*T?|CECS|ISO|IEC)\s*[\w./-]*\d/u.test(line);
    const hasContext = /项目|工程|工期|合同|估算|价格|地点|规模|清单|图纸|设计|规格|型号|数量|单位|材料|设备|管|线|电缆|混凝土|钢筋|砌体|门窗|防水|标准|规范|验收|做法|参数|尺寸|标高|厚度|强度|等级|系统|安装/u.test(line);
    return isProjectBasicValue || hasParameter || hasStdCode || (hasContext && /\d/u.test(line) && line.length <= 260);
  });
  // 参数行全量保留（无数量/字符截断）：按重要性排序后全部进入，评分只决定顺序不决定去留
  const uniqueLines = [...new Set(keyLines)];
  // 超长无换行段落（PDF 提取常见）整行进 T0 会在预算裁剪时被整行丢弃（重要数据全丢）：
  // 先行内提取参数短语（数值+单位/基础事实短语/规范编号），保留全部重要数据、压缩叙述体积
  const compactLines = uniqueLines.map(line => extractKeyFactPhrases(line)).filter(Boolean);
  const selected = selectByScore([...new Set(compactLines)], l => textImportanceScore(l), {}, 'key-fact-lines');
  return selected.selected.join('\n');
}

/** 超长行参数短语提取：行 >160 字时抽取「数值+单位」「基础事实短语」「规范编号」子串，
 * 保证长段落中的关键数值不因行截断/预算裁剪丢失（重要数据零丢失通道） */
function extractKeyFactPhrases(line: string): string {
  if (line.length <= 160) return line;
  const phrases = line.match(/\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年)|DN\s*\d+|Φ\s*\d+|φ\s*\d+|C\d{2,}|HRB\d+|(?:计划工期|合同工期|合同估算价|投资估算|最高投标限价|招标控制价|建设地点|建设规模|质量标准)[^。；;，,]{0,40}|(?:GB|JGJ|CJJ|DB|CECS|ISO|IEC)\s*\/?\s*T?\s*[\w./-]*\d/gu);
  return phrases && phrases.length > 0 ? [...new Set(phrases)].join('；') : line.slice(0, 160);
}

/**
 * 2.1 T0 白名单字段（与 factsModel 项目事实字段口径同源）：项目级关键事实
 * （名称/编号/主体/地点/规模/范围/工期/质量/安全/造价/结构/层数/基础/抗震/绿建/装配/支护/质保/投标有效期，≤20 类）。
 * 白名单外的关键事实行（工艺参数/规范编号等）不再占用 T0 全量保留特权，降级进 T1 按相关度排序——
 * 只降层不删除（零丢失原则：完整证据池继续参与检索与质量校验）。
 */
const T0_WHITELIST_FIELD_RE = /项目名称|工程名称|项目编号|招标项目编号|标段编号|招标人|建设单位|发包人|建设地点|工程地点|建设规模|建筑面积|招标范围|计划工期|合同工期|总工期|周期要求|质量标准|质量目标|安全目标|安全生产|合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价|工程估算价|结构形式|层数|建筑高度|基础形式|抗震设防|绿色建筑等级|装配率|支护形式|质保期|质量保修|投标有效期/u;

/** T0 白名单行值截断上限（防「值截断回源」前的长叙述段型事实行占满 T0 预算） */
const T0_WHITELIST_LINE_MAX_CHARS = 200;

/** 2.1 单次写作调用证据注入硬顶（字符）：实测 L3 变化段占比 80.6%（目标 ≤50%），证据注入是 L3 大头 */
const DOCUMENT_EVIDENCE_HARD_CAP_CHARS = 8000;

/** T0 白名单瘦身开关（2.1）：默认开启；env DOCUMENT_T0_WHITELIST=0 回退 T0 全量保留并解除 8000 硬顶 */
export function t0WhitelistEnabled(): boolean {
  return process.env.DOCUMENT_T0_WHITELIST !== '0';
}

/** T0 白名单行形态整理：超长行截断至 200 字符（保留字段名与值首部，防叙述段占层） */
function truncateT0WhitelistLine(line: string): string {
  return line.length > T0_WHITELIST_LINE_MAX_CHARS ? `${line.slice(0, T0_WHITELIST_LINE_MAX_CHARS)}…` : line;
}

export function sanitizeEvidenceContent(filePath: string, content: string) {
  const ext = path.extname(filePath).toLowerCase();
  const cleaned = cleanEvidenceText(content)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^第\s*\d+\s*页\s*(?:共\s*\d+\s*页)?$/u.test(line))
    .join('\n');
  const quality = evidenceQualityScore(cleaned);
  if (cleaned.length > 20 && quality.shouldUse) return cleaned;
  const parameterSummary = extractKeyFactLines(cleaned);
  if (parameterSummary.length > 20) return `资料参数行摘要：\n${parameterSummary}`;
  if (cleaned.length > 80 && quality.noiseScore < 0.9) return cleaned;
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.webp', '.dwg'].includes(ext)) {
    return `该资料为${ext.replace('.', '').toUpperCase()}格式附件，仅作为内部事实提取依据；正式正文不得引用文件名。`;
  }
  return cleaned;
}

/**
 * 超长证据关键参数窗口提取：CAD 图纸/大文件经 expandContext 父块回溯后，单条证据动辄 10 万+ 字符，
 * 关键参数（基坑底标高、坡率、开挖深度等）常位于全文尾部，头部截断会永久丢失参数数据。
 * 历史缺陷：基坑支护图父块全文 153642 字，标高标注位于 147000+ 字符处，渲染层 slice(0,1200) 只保留
 * 文件头元数据，写手从未见到「15.65(基坑底标高)」等真实设计参数，导致基坑深度数值在正文中缺失。
 * 本函数扫描全文定位参数载体片段（CAD 标注字段/标高/坡率/相对标高数值/比例），
 * 合并重叠窗口后按预算拼接，返回长度保证 ≤ maxChars。
 */
export function extractKeyParameterWindows(content: string, maxChars: number): string {
  const budget = Math.max(400, Math.floor(maxChars));
  const text = cleanEvidenceText(content);
  if (text.length <= budget) return text;
  // 行粒度提取：CAD 标注流以「图纸节点 + └── 标注文本」行为单位，
  // 整行提取可保证「标注文本: 15.65(基坑底标高) | 关联对象: 邻近标注 坡率 1:1.0」中的关联参数不丢
  const lines = text.split('\n');
  // 行价值分级：基坑/开挖/坡率等结构安全设计参数最高优先，
  // 管底/井底/中心标高等常规标注次之，裸负小数/比例最低。
  // 历史缺陷：真实基坑支护图全文命中 1204 处（多为给排水管底标高等常规标注与标题行噪声），
  // 前部噪声先占满预算，尾部「15.65(基坑底标高)」「坡率 1:1.0」被挤出渲染窗口
  const rankedLinePatterns: Array<{ re: RegExp; value: number }> = [
    { re: /基坑底标高|换填底标高|整平标高|开挖深度|放坡系数|支护形式|坡率/u, value: 20 },
    { re: /标高/u, value: 10 },
    { re: /[±＋]\s*0[.,]0{2,}/u, value: 8 },
    { re: /[±＋-]\s*\d+\.\d{2,}/u, value: 3 },
  ];
  const scoredLines = lines
    .map((line, index) => {
      let value = 0;
      for (const { re, value: v } of rankedLinePatterns) {
        if (re.test(line)) { value = v; break; }
      }
      return { line, index, value };
    })
    .filter(entry => entry.value > 0);
  if (!scoredLines.length) return text.slice(0, budget);
  // 高价值优先、同价值按行号升序：尾部关键参数行进入预算而非被前部噪声行挤出
  scoredLines.sort((a, b) => b.value - a.value || a.index - b.index);
  // 头部元数据自适应压缩：极小预算（如 focused writer 520 字）下固定 300 字头部会把参数行空间挤到
  // 只剩 1 行（历史缺陷：真实 CAD 全文 520 预算验证时「基坑底标高」被「22.00(整平标高)」关联行挤出窗口）
  const header = text.slice(0, Math.min(300, Math.max(80, Math.floor(budget * 0.22)))).trimEnd();
  const note = `（超长证据参数窗口提取：${scoredLines.length} 行参数命中，尾部关键参数已前置展示）`;
  let remaining = budget - header.length - note.length - 4;
  const parts: string[] = [];
  const pickedIndexes = new Set<number>();
  const contextCap = Math.max(50, Math.floor(budget * 0.15));
  for (const { line, index } of scoredLines) {
    if (remaining <= 30) break;
    if (pickedIndexes.has(index)) continue;
    const contextLine = index > 0 && /图纸节点:/u.test(lines[index - 1]) ? lines[index - 1].slice(0, contextCap) : '';
    const piece = [contextLine, line].filter(Boolean).join('\n');
    const chunk = piece.length > remaining ? piece.slice(0, remaining) : piece;
    parts.push(chunk);
    remaining -= chunk.length + 1;
    pickedIndexes.add(index);
    if (contextLine) pickedIndexes.add(index - 1);
  }
  const body = parts.length ? parts.join('\n') : text.slice(0, remaining + header.length);
  const result = `${header}\n${note}\n${body}`;
  return result.length > budget ? result.slice(0, budget) : result;
}

function evidenceDedupeKey(item: DocumentEvidence): string {
  const normalized = item.content.replace(/\s+/gu, ' ').trim();
  return `${item.filePath}:${item.sectionTitle || ''}:${createHash('sha1').update(normalized).digest('hex')}`;
}

export function uniqueEvidence(items: DocumentEvidence[], limit?: number, diagnostics?: DocumentGenerationDiagnostics): DocumentEvidence[] {
  const seen = new Set<string>();
  const scored = items.map(item => {
    const content = sanitizeEvidenceContent(item.filePath, item.content);
    const quality = evidenceQualityScore(content);
    return { item: { ...item, content, score: item.score * (1 + quality.factDensity) * (1 - quality.noiseScore * 0.45) }, quality };
  });
  const usable = scored.filter(entry => entry.quality.shouldUse || /附件，仅作为内部事实提取依据/u.test(entry.item.content));
  const resolvedLimit = Number.isFinite(limit) && limit! > 0 ? Math.ceil(limit!) : undefined;
  const deduped = (usable.length >= Math.min(3, items.length) ? usable : scored)
    .sort((a, b) => b.item.score - a.item.score)
    .filter(entry => {
      const key = evidenceDedupeKey(entry.item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const selected = resolvedLimit ? deduped.slice(0, resolvedLimit) : deduped;
  if (diagnostics) {
    const totalNoise = scored.reduce((sum, entry) => sum + entry.quality.noiseScore, 0);
    const totalDensity = scored.reduce((sum, entry) => sum + entry.quality.factDensity, 0);
    diagnostics.evidence.raw += items.length;
    diagnostics.evidence.used += selected.length;
    diagnostics.evidence.filteredNoise += Math.max(0, scored.length - usable.length);
    diagnostics.evidence.avgNoiseScore = scored.length ? Number((totalNoise / scored.length).toFixed(3)) : 0;
    diagnostics.evidence.avgFactDensity = scored.length ? Number((totalDensity / scored.length).toFixed(3)) : 0;
  }
  return selected.map(entry => entry.item);
}

// evidenceDedupeKey 仅在模块内部使用，不对外导出

/** 证据声明结果 */
export type EvidenceClaimResult = 'new' | 'claimed-by-other-chapter' | 'duplicate-in-chapter';

/** 排除源（固定/绑定/需求事实/多模态证据）在跨章节去重中保持豁免 */
export function isExemptEvidenceSource(item: DocumentEvidence): boolean {
  return item.source === 'pinned-evidence' || item.source === 'bound-file' || item.source === 'required-fact-evidence' || item.source === 'multimodal';
}

/** 跨章节证据声明注册表，用于去重和复用追踪 */
export class EvidenceClaimRegistry {
  private claims = new Map<string, { chapterIds: Set<string>; item: DocumentEvidence }>();

  claim(item: DocumentEvidence, chapterId: string): EvidenceClaimResult {
    const key = evidenceDedupeKey(item);
    const existing = this.claims.get(key);
    if (!existing) {
      this.claims.set(key, { chapterIds: new Set([chapterId]), item });
      return 'new';
    }
    existing.chapterIds.add(chapterId);
    if (existing.chapterIds.has(chapterId) && existing.chapterIds.size === 1) return 'duplicate-in-chapter';
    return isExemptEvidenceSource(item) ? 'new' : 'claimed-by-other-chapter';
  }

  /** 返回被多个章节复用的证据条目 */
  duplicateItems(): Array<{ key: string; filePath: string; chapterIds: string[]; count: number }> {
    return [...this.claims.entries()]
      .filter(([, entry]) => entry.chapterIds.size > 1)
      .map(([key, entry]) => ({ key, filePath: entry.item.filePath, chapterIds: [...entry.chapterIds], count: entry.chapterIds.size }))
      .sort((a, b) => b.count - a.count);
  }
}

/** 在章节证据中加入跨章节去重过滤，安全底限 minRemaining 防止证据不足 */
export function dedupeChapterEvidence(
  evidence: DocumentEvidence[],
  chapterId: string,
  registry: EvidenceClaimRegistry,
  opts?: { minRemaining?: number },
): DocumentEvidence[] {
  const minRemaining = opts?.minRemaining ?? 8;
  const sorted = [...evidence].sort((a, b) => b.score - a.score);
  const kept: DocumentEvidence[] = [];
  const dropped: DocumentEvidence[] = [];
  for (const item of sorted) {
    const result = registry.claim(item, chapterId);
    if (result === 'claimed-by-other-chapter') {
      dropped.push(item);
    } else {
      kept.push(item);
    }
  }
  // 安全底限：如果去重后证据太少，从被丢弃的高分条目中补齐
  if (kept.length < minRemaining && dropped.length > 0) {
    const needed = minRemaining - kept.length;
    kept.push(...dropped.slice(0, needed));
  }
  return kept;
}

/** 全局证据去重：对全量证据按内容 key 保留最高分 */
export function dedupeGlobalEvidence(evidence: DocumentEvidence[]): DocumentEvidence[] {
  const best = new Map<string, DocumentEvidence>();
  for (const item of evidence) {
    if (isExemptEvidenceSource(item)) {
      best.set(`${evidenceDedupeKey(item)}:${item.chapterId}`, item);
      continue;
    }
    const key = evidenceDedupeKey(item);
    const existing = best.get(key);
    if (!existing || item.score > existing.score) best.set(key, item);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export function selectEvidenceByBudget(items: DocumentEvidence[], options: { maxItems?: number; maxChars?: number; preservePinned?: boolean; maxItemsPerFile?: number } = {}, diagnostics?: DocumentGenerationDiagnostics): DocumentEvidence[] {
  const maxItems = Number.isFinite(options.maxItems) && options.maxItems! > 0 ? Math.floor(options.maxItems!) : undefined;
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars! > 0 ? Math.floor(options.maxChars!) : undefined;
  // 单文件条目上限默认不限制（全量保留）：大文件（招标文件全文）不再被拆碎，证据完整性优先；
  // 仅显式传入 maxItemsPerFile 时才启用（兼容存量调用点），pinned 证据始终不受单文件上限约束
  const maxItemsPerFile = Number.isFinite(options.maxItemsPerFile) && options.maxItemsPerFile! > 0 ? Math.floor(options.maxItemsPerFile!) : undefined;
  const ranked = uniqueEvidence(items, undefined, diagnostics);
  const pinned = options.preservePinned ? ranked.filter(item => item.source === 'pinned-evidence' || item.source === 'bound-file' || item.source === 'required-fact-evidence') : [];
  const normal = ranked.filter(item => !pinned.includes(item));
  const selected: DocumentEvidence[] = [];
  const perFileCounts = new Map<string, number>();
  let chars = 0;
  const tryPush = (item: DocumentEvidence, priority = false) => {
    if (maxItems && selected.length >= maxItems) return;
    const fileCount = perFileCounts.get(item.filePath) || 0;
    if (!priority && maxItemsPerFile !== undefined && fileCount >= maxItemsPerFile) return;
    let content = cleanEvidenceText(item.content);
    // 超长证据（CAD 父块全文等）压缩为关键参数窗口再入池：单条 15 万字全文占满预算会把其他来源证据全部挤出，
    // 且尾部关键参数在后续渲染截断中仍会丢失——入池前压缩保证参数可见且预算留给多文件证据
    if (maxChars && content.length > 4000) {
      content = extractKeyParameterWindows(content, Math.min(12000, maxChars));
    }
    const nextChars = chars + content.length;
    if (maxChars && selected.length > 0 && nextChars > maxChars) return;
    selected.push({ ...item, content });
    perFileCounts.set(item.filePath, fileCount + 1);
    chars = nextChars;
  };
  for (const item of pinned) tryPush(item, true);
  for (const item of normal) tryPush(item);
  // 裁剪量记录：被显式 maxItems/maxChars/maxItemsPerFile 裁掉的条目写入诊断，使预算软限制可观测
  if (diagnostics) diagnostics.evidence.budgetDropped += Math.max(0, ranked.length - selected.length);
  return selected;
}


export function evidenceLine(item: DocumentEvidence, index = 0): string {
  return `- ${readableSourceLabel(item, index)}：${cleanEvidenceText(item.content).replace(/\s+/gu, ' ').slice(0, 260)}`;
}

function resourceKind(filePath: string, processingType?: string): ResourceEvidence['kind'] {
  const ext = path.extname(filePath).toLowerCase();
  if (processingType === 'drawing' || /地图|map|drawing|design/iu.test(filePath)) return 'map';
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'image';
  if (processingType === 'table') return 'table';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'spreadsheet';
  if (['.pdf', '.doc', '.docx'].includes(ext)) return 'document';
  if (ext && !['.md', '.txt'].includes(ext)) return 'attachment';
  return 'text';
}

function semanticResourceTitle(filePath: string, kind: ResourceEvidence['kind']) {
  const name = path.basename(filePath).replace(/\.[^.]+$/u, '');
  if (kind === 'map') return name.replace(/^地图-/u, '').replace(/-完整地图$/u, '完整地图');
  if (kind === 'image') return name.replace(/-/gu, ' ');
  if (kind === 'spreadsheet') return `${name}（结构化表格）`;
  if (kind === 'document') return `${name}（文档附件）`;
  return name;
}

function relatedFactsForResource(item: DocumentEvidence, chapter?: DocumentTemplateChapter) {
  const haystack = `${item.filePath}\n${item.content}`;
  const candidates = [...(chapter?.requiredFacts || []), '表格数据', '规范要求', '基础事实', '附件资料', '视觉资料', '图片资料'];
  return [...new Set(candidates.filter(fact => evidenceMatchesFact(item, fact) || haystack.includes(fact)))];
}

function resourceContentUse(kind: ResourceEvidence['kind']) {
  if (kind === 'map') return '作为视觉/地图证据，用于说明空间关系、区域划分、点位、路线或布局。';
  if (kind === 'image') return '作为图片证据，用于视觉说明、参考图或章节配图。';
  if (kind === 'spreadsheet' || kind === 'table') return '作为表格/数据证据，用于字段对比、明细、数量和结构化结论。';
  if (kind === 'document') return '作为 PDF/Word 文档证据，用于提取规范、事实、说明、约束和附件来源。';
  if (kind === 'attachment') return '作为附件证据，用于提供补充来源、文件级约束或可追溯引用。';
  return '作为文本证据，用于事实抽取、章节论据和来源引用。';
}

function emptyEvidenceByKind(): Record<ResourceEvidence['kind'], ResourceEvidence[]> {
  return { map: [], image: [], table: [], document: [], spreadsheet: [], text: [], attachment: [] };
}

/** 3.4 证据确定性全序比较器：(filePath, 小节标题, 内容长度, 内容全文)——与输入数组顺序无关；
 * 同证据池（检索召回序/并发完成序抖动）多次组装输出逐字节一致，消除"同输入不同 prompt"的隐性前缀分叉 */
function compareEvidenceDeterministic(left: DocumentEvidence, right: DocumentEvidence): number {
  if (left.filePath !== right.filePath) return left.filePath < right.filePath ? -1 : 1;
  const leftSection = left.sectionTitle || '';
  const rightSection = right.sectionTitle || '';
  if (leftSection !== rightSection) return leftSection < rightSection ? -1 : 1;
  if (left.content.length !== right.content.length) return left.content.length - right.content.length;
  if (left.content !== right.content) return left.content < right.content ? -1 : 1;
  return 0;
}

/** 构建章节证据包，将原始证据分类为文本片段和结构化资源（图片、表格、文档、地图等） */
export function buildEvidenceBundle(chapter: DocumentTemplateChapter, evidence: DocumentEvidence[]): EvidenceBundle {
  // 3.4 确定性组装：输入证据先按 (filePath, 小节, 内容) 全序归一化——下游 T0/T1/T2 各层
  // 组装与省略清单全部继承该确定顺序，同证据池多次组装输出逐字节一致
  const orderedEvidence = [...evidence].sort(compareEvidenceDeterministic);
  const textEvidence = orderedEvidence;
  const resourceMap = new Map<string, ResourceEvidence>();
  for (const item of orderedEvidence) {
    const kind = resourceKind(item.filePath, item.processingType);
    const existing = resourceMap.get(item.filePath);
    const resource: ResourceEvidence = existing || {
      filePath: item.filePath,
      kind,
      roleId: item.roleId,
      processingType: item.processingType,
      score: item.score,
      semanticTitle: semanticResourceTitle(item.filePath, kind),
      contentUse: resourceContentUse(kind),
      relatedFacts: [],
      relatedChapters: [],
      snippets: [],
    };
    resource.score = Math.max(resource.score, item.score);
    resource.relatedFacts = [...new Set([...resource.relatedFacts, ...relatedFactsForResource(item, chapter)])];
    resource.relatedChapters = [...new Set([...resource.relatedChapters, chapter.title])];
    // 全量保留内容片段（不做 600 字截断与 4 条上限：截断即丢材料事实）
    const snippet = item.content.replace(/\s+/gu, ' ');
    if (snippet && !resource.snippets.includes(snippet)) resource.snippets.push(snippet);
    resourceMap.set(item.filePath, resource);
  }
  const resources = [...resourceMap.values()].sort((a, b) => b.score - a.score);
  const byKind = emptyEvidenceByKind();
  for (const resource of resources) byKind[resource.kind].push(resource);
  const summary = [
    `绑定材料包：文本片段 ${textEvidence.length} 条、结构化材料 ${resources.length} 个。`,
    `材料类型分布：文本 ${byKind.text.length}、文档 ${byKind.document.length}、表格/数据 ${byKind.spreadsheet.length + byKind.table.length}、图片 ${byKind.image.length}、视觉/地图 ${byKind.map.length}、其他 ${byKind.attachment.length}。`,
    '正文必须只写材料中的事实、参数、数量、做法和要求，不得出现文件名、来源清单或后台证据描述。',
  ].filter(Boolean).join('\n');
  return { chapterId: chapter.id, textEvidence, resources, byKind, summary };
}

export interface EvidencePromptOptions {
  maxChars?: number;
  /** 模板要求覆盖的事实：注入排序时对命中项加权，保证关键参数块不被高分泛化块挤出预算 */
  requiredFacts?: string[];
  /** D1 共享卡片上移：T0 关键事实层已由调用方注入 L2 共享段时跳过，避免同章各块重复注入 */
  skipT0?: boolean;
  /** 块级相关性加权：主题块管线按块标题/要点 token 命中给证据加分，让预算花在块相关证据上
   * （历史缺陷：块证据按块相关性排序后传入，但 T1 选取内部按 requiredFacts 重要性重排，
   * 块排序被覆盖——同章各块注入几乎相同的 T1，块级差异化注入落空） */
  rankBoost?: (item: DocumentEvidence) => number;
  /** A2 块级增量压缩：只选取块相关性命中（rankBoost>0）的证据片段；命中为空时回退全量选取，
   * 章级全貌由 L2 章级证据池承载——块级 L3 只带块专属增量（1k-3k 字符） */
  onlyRankBoosted?: boolean;
  /** 分层统计出口：写入 T0/T1/T2 字符量与省略量，供真实生成对账 */
  diagnostics?: DocumentGenerationDiagnostics;
}

export function evidencePromptBudgetForTarget(targetWords?: number, floorChars = 8000, ceilingChars = 24000) {
  const words = Number.isFinite(targetWords) && targetWords! > 0 ? Math.ceil(targetWords!) : 1200;
  // 事实/字数比：每目标字配 8 字符证据（含结构化开销），证据不足是空话灌水的直接原因；
  // 实测 12 字符/字时单次调用输入可达 36K 字符证据（占输入大头），8 字符/字在 T0 全量保留
  // 前提下仍可覆盖关键参数；比例按 env 可调（DOCUMENT_EVIDENCE_BUDGET_RATIO）
  // 天花板按 env 可调（DOCUMENT_EVIDENCE_BUDGET_CEILING），默认 24000 平衡「深召回注入」与
  // 「单次输入体积」（T0 关键参数层全量保留不受影响，T1 片段缩量、T2 目录追溯零丢失）
  const configuredCeiling = Number(process.env.DOCUMENT_EVIDENCE_BUDGET_CEILING);
  const ceiling = Number.isFinite(configuredCeiling) && configuredCeiling > 0 ? Math.floor(configuredCeiling) : ceilingChars;
  const configuredRatio = Number(process.env.DOCUMENT_EVIDENCE_BUDGET_RATIO);
  const ratio = Number.isFinite(configuredRatio) && configuredRatio > 0 ? configuredRatio : 8;
  const dynamic = Math.ceil(words * ratio);
  const budget = Math.max(floorChars, Math.min(ceiling, dynamic));
  // 2.1 单次写作调用证据注入 8000 字符硬顶（实测 L3 变化段占比 80.6% 的输入大头）；
  // DOCUMENT_EVIDENCE_BUDGET_CEILING 显式设置优先于硬顶；DOCUMENT_T0_WHITELIST=0 回退时同步解除
  const hardCap = (Number.isFinite(configuredCeiling) && configuredCeiling > 0) || !t0WhitelistEnabled()
    ? Number.POSITIVE_INFINITY
    : DOCUMENT_EVIDENCE_HARD_CAP_CHARS;
  return Math.min(budget, hardCap);
}

function appendWithinBudget(parts: string[], next: string, state: { chars: number; omitted: number }, maxChars?: number) {
  const normalized = next.trim();
  if (!normalized) return;
  if (!Number.isFinite(maxChars) || !maxChars || state.chars + normalized.length <= maxChars) {
    parts.push(normalized);
    state.chars += normalized.length;
    return;
  }
  state.omitted += 1;
}

/** 证据注入排序分：检索分数 + 事实价值（量化参数/项目基础事实/requiredFacts 命中/标准编号）。
 * 事实覆盖优先于文件多样性：旧 byFile top-1 启发式会牺牲文件内第 2 条关键参数块，已移除 */
export function evidencePromptImportance(item: DocumentEvidence, requiredFacts: string[]): number {
  const text = `${item.sectionTitle || ''}\n${item.content}`;
  let score = item.score;
  if (HAS_QUANTIFIED_VALUE_RE.test(text)) score += 8;
  if (/计划工期|合同工期|合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价|建设地点|建设规模|质量标准|招标范围/u.test(text)) score += 10;
  for (const fact of requiredFacts) {
    if (fact && (text.includes(fact) || evidenceMatchesFact(item, fact))) score += 6;
  }
  if (/GB\s*\/?\s*T?|JGJ|CJJ|DB\s*\/?\s*T?|CECS|ISO/iu.test(text)) score += 3;
  return score;
}

function selectEvidenceForPrompt<T extends { filePath: string }>(items: T[], maxChars: number | undefined, render: (item: T, index: number) => string, rank: (item: T) => number) {
  const state = { chars: 0, omitted: 0 };
  const selected: string[] = [];
  const selectedKeys = new Set<T>();
  const perFile = new Map<string, number>();
  const ranked = [...items].sort((a, b) => rank(b) - rank(a));
  // 第一轮：每文件 top-1（文件覆盖公平性，防高分单文件霸占预算挤出其余文件的关键证据）
  for (const item of ranked) {
    if (perFile.has(item.filePath)) continue;
    const before = selected.length;
    appendWithinBudget(selected, render(item, selected.length), state, maxChars);
    if (selected.length > before) {
      perFile.set(item.filePath, 1);
      selectedKeys.add(item);
    }
  }
  // 第二轮：按重要性继续填充（单文件最多 6 条：保留多来源覆盖，但不再强制每文件只取 1 条）
  for (const item of ranked) {
    if (selectedKeys.has(item)) continue;
    const fileCount = perFile.get(item.filePath) || 0;
    if (fileCount >= 6) continue;
    const before = selected.length;
    appendWithinBudget(selected, render(item, selected.length), state, maxChars);
    if (selected.length > before) {
      perFile.set(item.filePath, fileCount + 1);
      selectedKeys.add(item);
    }
  }
  return { lines: selected, omittedItems: ranked.filter(item => !selectedKeys.has(item)), omitted: state.omitted };
}

/** T2 证据目录行：未全文注入的片段一行索引（来源标签 + 首段要点），保证证据池全貌可见、编号可回溯 */
function evidenceCatalogLine(item: DocumentEvidence | ResourceEvidence, index: number) {
  const snippetText = 'content' in item ? item.content : (item.snippets[0] || '');
  const firstLine = cleanEvidenceText(snippetText).split('\n').map(line => line.trim()).filter(Boolean)[0] || '';
  const digest = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  return `- [${index}] ${readableSourceLabel(item)}${digest ? `｜${digest}` : ''}`;
}

export interface EvidenceLayerStats {
  t0Chars: number;
  t1Chars: number;
  t2Lines: number;
  t2Chars: number;
  omittedChars: number;
  omittedCount: number;
}

export interface EvidenceLayers {
  t0Text: string;
  t1Text: string;
  t2Text: string;
  omittedNote: string;
  stats: EvidenceLayerStats;
}

/**
 * 证据三层注入（T0/T1/T2）：重要数据零丢失的无损分层。
 * - T0 关键事实层：数值参数/项目基础事实/规范编号行全量保留，永不参与预算裁剪（唯一例外：
 *   事实行总量超过预算 60% 时按重要性排序裁剪并记录，防占满预算挤掉全部上下文）；
 * - T1 高相关证据原文：资源层 35% + 文本层 65% 按剩余预算填充，每文件至少 1 条；
 * - T2 证据目录：未进 T1 的片段一行索引，证据池全貌可见（数据本身不删除，后续检索/校验继续参与）。
 * skipT0（D1 共享卡片上移）：章级共享事实层已由调用方单独注入 L2 共享段时，此处跳过 T0，
 * 避免同章各块重复注入同一份全量事实行（块级调用输入 token 大头）。
 */
export function buildEvidenceLayers(bundle: EvidenceBundle, maxChars: number | undefined, requiredFacts: string[], skipT0 = false, rankBoost?: (item: DocumentEvidence) => number, onlyRankBoosted = false): EvidenceLayers {
  const whitelistEnabled = t0WhitelistEnabled();
  const allFactLines = skipT0 ? [] : [...new Set(bundle.textEvidence.flatMap(item => extractKeyFactLines(item.content).split('\n').filter(Boolean)))];
  // 2.1 T0 白名单瘦身：T0 只保留项目级白名单字段行（值截断 200 字符）；白名单外事实行
  // （工艺参数/规范编号等）降级进 T1 文本层前段按相关度排序——降层不删除，完整证据池继续参与检索与校验
  const t0FactLines = whitelistEnabled
    ? allFactLines.filter(line => T0_WHITELIST_FIELD_RE.test(line)).map(truncateT0WhitelistLine)
    : allFactLines;
  const demotedFactLines = whitelistEnabled ? allFactLines.filter(line => !T0_WHITELIST_FIELD_RE.test(line)) : [];
  const t0Budget = maxChars ? Math.floor(maxChars * 0.6) : undefined;
  let t0Lines = t0FactLines;
  let t0Trimmed = 0;
  if (t0Budget && t0Lines.join('\n').length > t0Budget) {
    const trimmed = selectByScore(t0Lines, l => textImportanceScore(l), { maxChars: t0Budget }, 't0-fact-lines');
    t0Trimmed = trimmed.dropped.length;
    t0Lines = trimmed.selected;
  }
  const t0Text = t0Lines.length
    ? `【关键事实层——来自绑定材料的数值、参数与标准编号，正文必须原样落位，不得改写、不得编造层内没有的数值】\n${t0Lines.map(line => `- ${line}`).join('\n')}${t0Trimmed > 0 ? `\n（事实行总量超出预算上限，已按重要性保留前 ${t0Lines.length} 行）` : ''}`
    : '';
  // T1 预算 = 总预算 - T0（T0 全量优先）；T0 吃满预算时给 T1 保留 2000 字符（不超过总预算），
  // 极小总预算（<2000）时不做保底放大，按原预算裁剪并如实提示省略
  const maxCharsValue = maxChars;
  let remaining = maxCharsValue ? maxCharsValue - t0Text.length : undefined;
  if (remaining !== undefined && maxCharsValue !== undefined && remaining < Math.min(2000, maxCharsValue)) {
    remaining = Math.min(2000, maxCharsValue);
  }
  // A2 资源层增量过滤：onlyRankBoosted 时同样只保留块相关命中（rankBoost>0）的结构化资源，
  // 命中为空回退全量（与文本层同口径——资源 snippets 泄漏非块相关内容同样是块级 L3 变化段膨胀来源）
  const filteredResources = onlyRankBoosted && rankBoost
    ? bundle.resources.filter(res => res.snippets.some(snippet => rankBoost({ chapterId: bundle.chapterId, filePath: res.filePath, score: res.score, content: snippet } as DocumentEvidence) > 0))
    : bundle.resources;
  const resourcesForPrompt = filteredResources.length > 0 ? filteredResources : bundle.resources;
  const resourcePrompt = selectEvidenceForPrompt(resourcesForPrompt, remaining ? Math.floor(remaining * 0.35) : undefined, (item, index) => [
    `- 资料：${readableSourceLabel(item, index)}`,
    `  资料类型：${item.kind}`,
    `  正文用途：${item.contentUse}`,
    item.relatedFacts.length ? `  可用事实方向：${item.relatedFacts.join('、')}` : '',
    item.snippets.length ? `  可用内容：${item.snippets.map(cleanEvidenceText).filter(Boolean).join(' / ')}` : '',
  ].filter(Boolean).join('\n'), item => item.score);
  // 文本证据保留结构化换行（表格、键值对、清单行），不做单行压缩——单行压缩会把多列表格变成文字墙
  // A2 块级增量压缩：onlyRankBoosted 时只选取块相关性命中（rankBoost>0）的文本证据，
  // 命中为空回退全量选取（块相关证据不足时保证正文仍有证据支撑，不牺牲事实安全）
  const boostedTextEvidence = onlyRankBoosted && rankBoost ? bundle.textEvidence.filter(item => rankBoost(item) > 0) : bundle.textEvidence;
  const textEvidencePool = onlyRankBoosted && boostedTextEvidence.length === 0 ? bundle.textEvidence : boostedTextEvidence;
  // 2.1 降级事实行：占 T1 文本层预算前段，按重要性排序填充；超预算行省略计数（降层不删除——
  // 完整事实仍在证据池，继续参与检索与质量校验）
  const textLayerBudget = remaining ? Math.floor(remaining * 0.65) : undefined;
  let demotedText = '';
  let textEvidenceBudget = textLayerBudget;
  if (demotedFactLines.length > 0) {
    const demotedSelection = selectByScore(demotedFactLines, line => textImportanceScore(line), { maxChars: textLayerBudget }, 't0-demoted-fact-lines');
    if (demotedSelection.selected.length > 0) {
      demotedText = `工艺参数与规范事实行（按相关度排序）：\n${demotedSelection.selected.map(line => `- ${line}`).join('\n')}${demotedSelection.dropped.length > 0 ? `\n（另有 ${demotedSelection.dropped.length} 行因预算省略，完整事实仍参与检索与质量校验）` : ''}`;
      if (textEvidenceBudget !== undefined) textEvidenceBudget = Math.max(0, textEvidenceBudget - demotedText.length);
    }
  }
  const textPrompt = selectEvidenceForPrompt(textEvidencePool, textEvidenceBudget, (item, index) => {
    const body = cleanEvidenceText(item.content);
    // 超长证据（CAD 父块全文等）截断前先做关键参数窗口提取：头部盲截会丢失尾部标高/坡率等真实设计参数
    const truncated = body.length > 1200 ? extractKeyParameterWindows(body, 1200) : body;
    return `${readableSourceLabel(item, index)}\n类型：${item.processingType || 'reference'}\n章节/片段：${item.sectionTitle?.replace(FILE_NAME_RE, '') || '资料片段'}\n内容：\n${truncated}`;
  }, item => evidencePromptImportance(item, requiredFacts) + (rankBoost ? rankBoost(item) : 0));
  const t1Parts: string[] = [];
  if (resourcePrompt.lines.length) t1Parts.push(`结构化资料：\n${resourcePrompt.lines.join('\n')}`);
  if (demotedText) t1Parts.push(demotedText);
  if (textPrompt.lines.length) t1Parts.push(`文本/附件片段：\n${textPrompt.lines.join('\n\n---\n\n')}`);
  const t1Text = t1Parts.join('\n\n');
  const t2Items = [...resourcePrompt.omittedItems, ...textPrompt.omittedItems];
  const t2Lines = t2Items.map((item, index) => evidenceCatalogLine(item, index));
  const t2Text = t2Lines.length
    ? `【证据目录——未全文注入的片段索引（正文写作不使用目录内容；目录供覆盖检索与修复追溯，完整片段仍参与后续检索与质量校验）】\n${t2Lines.join('\n')}`
    : '';
  const omittedChars = t2Items.reduce((sum, item) => sum + ('content' in item ? item.content.length : (item.snippets[0] || '').length), 0);
  const stats: EvidenceLayerStats = {
    t0Chars: t0Text.length,
    t1Chars: t1Text.length,
    t2Lines: t2Lines.length,
    t2Chars: t2Text.length,
    omittedChars,
    omittedCount: t2Items.length,
  };
  const omittedNote = stats.omittedCount > 0
    ? `提示：完整证据池仍保留 ${bundle.textEvidence.length} 条文本片段、${bundle.resources.length} 个结构化材料；本次已注入关键事实层 ${stats.t0Chars} 字（数值参数全量）与高相关片段 ${stats.t1Chars} 字，另有 ${stats.omittedCount} 条片段（${stats.omittedChars} 字）仅以目录索引呈现，将在章节/小节相关检索和质量校验中继续参与。`
    : '';
  return { t0Text, t1Text, t2Text, omittedNote, stats };
}

export function evidenceBundlePrompt(bundle: EvidenceBundle, options: EvidencePromptOptions = {}) {
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars! > 0 ? Math.ceil(options.maxChars!) : undefined;
  const requiredFacts = options.requiredFacts || [];
  const layers = buildEvidenceLayers(bundle, maxChars, requiredFacts, Boolean(options.skipT0), options.rankBoost, Boolean(options.onlyRankBoosted));
  if (options.diagnostics) {
    // T0/T1/T2 分层统计：供每次真实生成对账（重要数据零丢失断言 + 裁剪可观测）
    const evidenceDiagnostics = options.diagnostics.evidence;
    evidenceDiagnostics.t0Chars += layers.stats.t0Chars;
    evidenceDiagnostics.t1Chars += layers.stats.t1Chars;
    evidenceDiagnostics.t2Lines += layers.stats.t2Lines;
    evidenceDiagnostics.omittedChars += layers.stats.omittedChars;
  }
  // 4.17.1 omittedNote 移至证据段尾部：其文本含 per-call 统计计数（t0/t1/omitted 字符数），
  // 置于第 2 位会让其后的 T0/T1/T2 证据大头在参数差异时整体错过前缀缓存（前缀在 omittedNote 处即分叉）
  return [bundle.summary, layers.t0Text, layers.t1Text, layers.t2Text, layers.omittedNote].filter(Boolean).join('\n\n');
}

/**
 * A1 章级证据池：T0 关键事实层（数值参数全量零丢失）+ 章级 T1 摘要池（每证据一行要点摘要）+
 * T2 目录索引，一次构建后同章各块共享注入 L2——同章各块值完全相同 → prefix cache 共享命中；
 * 块级 L3 只保留块相关增量（A2 onlyRankBoosted），全章证据概貌由本池承载。
 * 摘要池预算上限 env DOCUMENT_CHAPTER_POOL_CHARS（默认 8000 字符）。
 */
export function buildChapterEvidencePool(bundle: EvidenceBundle, requiredFacts: string[], maxChars: number): string {
  const poolChars = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 8000;
  const t0Budget = Math.floor(poolChars * 0.5);
  const layers = buildEvidenceLayers(bundle, t0Budget, requiredFacts, false);
  const remaining = Math.max(1500, poolChars - layers.t0Text.length);
  const pool = selectEvidenceForPrompt(bundle.textEvidence, remaining, (item, index) => {
    const body = cleanEvidenceText(item.content);
    const digest = body.length > 300 ? `${body.slice(0, 300)}…` : body;
    return `- [${index}] ${readableSourceLabel(item)}｜${digest}`;
  }, item => evidencePromptImportance(item, requiredFacts));
  const poolText = pool.lines.length
    ? `【章级证据摘要池——全章证据要点概览（正文事实必须以关键事实层与绑定材料为准，摘要仅供定位材料方向）】\n${pool.lines.join('\n')}`
    : '';
  // 目录索引限行：目录用途是追溯定位，不占写作输入大头
  const catalogLines = pool.omittedItems.slice(0, 40).map((item, index) => evidenceCatalogLine(item, index));
  const catalogText = catalogLines.length
    ? `【证据目录——未进摘要池的片段索引（正文写作不使用目录内容；完整片段仍参与后续检索与质量校验）】\n${catalogLines.join('\n')}`
    : '';
  return [layers.t0Text, poolText, catalogText].filter(Boolean).join('\n\n');
}
