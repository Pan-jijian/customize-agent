/**
 * billFactLock：清单事实锁——清单条目级数据的确定性保护（B1）。
 *
 * 背景（清单数据编造/偏差的根因治理）：canonical 裁决（PROJECT_BASIC_FIELD_SPECS）只覆盖 14 个
 * 项目基本字段，清单几千条目行的「条目名→特征→工程量」数据没有确定性保护：检索注入受
 * 8000 字符硬顶截断、写作温度漂移、模型自行分配规格拆分（丰乐镇实测：路灯 100W 109+120W 9
 * 被写成 111+7）——条目级数据错误零拦截。
 *
 * 本模块把清单解析结果（billOfQuantitiesParser，蓝图阶段 0 同源、确定性零 LLM）固化为行级事实锁：
 * - 锁记录：条目名 + 特征描述 + 工程量 + 单位 + 分部 + 规格-数量拆分对（逐项照抄原值）；
 * - 写作侧直读：renderBillFactLockText 按章节相关性全量渲染清单行注入写作提示词（清单行直读通道，
 *   数据不经检索召回/注入截断，模型直接看到权威原文行）；
 * - 生成后核对：正文数值 vs 锁数值的确定性核对轮（见 numericVerification.ts）消费同一锁。
 */
import type { BillOfQuantitiesResult } from './billOfQuantitiesParser';

export interface BillFactLockEntry {
  seq: number;
  name: string;
  description: string;
  quantity: number;
  unit: string;
  section: string;
  subsection: string;
  villageGroup: string;
  sourceFile: string;
  /** 特征描述中的规格 token（如 100W、C30、DN100、HRB400）与数量拆分对：逐项照抄锁 */
  specQuantityPairs: Array<{ spec: string; quantity: string }>;
}

export interface BillFactLock {
  entries: BillFactLockEntry[];
  totalEntries: number;
  sourceFile: string;
  complete: boolean;
}

/** 规格 token：功率/长度/强度/管径/钢筋等级/直径/尺寸等，用于规格-数量拆分对提取 */
const SPEC_TOKEN_RE = /(?:\d+(?:\.\d+)?\s*(?:W|kW|kV|V|A|Hz|mm|cm|m|km|kg|g|t|K|MPa|kN|℃|%|L|mL|s|h|min)\b|C\d{2,}|HRB\d+|HPB\d+|DN\s*\d+|Φ\s*\d+(?:\.\d+)?|φ\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*[×x*]\s*\d+(?:\.\d+)?)/giu;

/** 从条目特征描述中提取规格 token（去重、保持原样） */
export function extractSpecTokens(text: string): string[] {
  return [...new Set((text.match(SPEC_TOKEN_RE) || []).map(item => item.replace(/\s+/gu, '').trim()))].filter(Boolean).slice(0, 8);
}

/** 构建清单事实锁：清单解析结果 → 行级确定性锁；无清单/解析为空返回 undefined */
export function buildBillFactLock(input: { boq?: BillOfQuantitiesResult | null }): BillFactLock | undefined {
  const boq = input.boq;
  if (!boq || boq.totalEntries === 0) return undefined;
  return {
    entries: boq.entries.map(entry => ({
      seq: entry.seq,
      name: String(entry.name || '').trim(),
      description: String(entry.description || '').trim(),
      quantity: entry.quantity,
      unit: String(entry.unit || '').trim(),
      section: String(entry.section || '').trim(),
      subsection: String(entry.subsection || '').trim(),
      villageGroup: String(entry.villageGroup || '').trim(),
      sourceFile: entry.sourceFile,
      specQuantityPairs: extractSpecTokens(entry.description).map(spec => ({ spec, quantity: `${entry.quantity}${entry.unit}` })),
    })),
    totalEntries: boq.totalEntries,
    sourceFile: boq.sourceFile,
    complete: boq.complete,
  };
}

/** 章节相关性 token：章节标题/小节标题切词，用于清单条目筛选 */
export function chapterRelevanceTokens(chapterTitle: string, sections: string[] = []): string[] {
  return [...new Set(`${chapterTitle} ${sections.join(' ')}`.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9_-]{3,}/gu) || [])].filter(token => token.length >= 2);
}

/** 条目与章节的相关性分：名称/特征/分部命中章节 token 越多越相关 */
function entryRelevanceScore(entry: BillFactLockEntry, tokens: string[]): number {
  const text = `${entry.name} ${entry.description} ${entry.section} ${entry.subsection}`;
  return tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
}

/**
 * 渲染清单事实锁注入文本（B2 清单行直读通道）：按章节相关性筛选条目后全量渲染权威清单行，
 * 数据不经检索召回与注入截断直接进入写作提示词。
 * 清单/施工内容/施工方法类章节放宽预算（条目级数据是这类章节的核心正文素材）。
 */
export function renderBillFactLockText(lock: BillFactLock, chapterTitle: string, opts: { sections?: string[]; maxEntries?: number; maxChars?: number; maxSpecChars?: number } = {}): string {
  if (!lock || lock.entries.length === 0) return '';
  const isQuantityHeavy = /清单|工程量|主要施工内容|主要施工方法|主要分部分项|资源配置|材料|物资/u.test(chapterTitle);
  const defaultMaxEntries = isQuantityHeavy ? 120 : 60;
  const defaultMaxChars = isQuantityHeavy ? 9000 : 6000;
  const maxEntries = Math.max(1, opts.maxEntries ?? defaultMaxEntries);
  const maxChars = Math.max(1, opts.maxChars ?? defaultMaxChars);
  const tokens = chapterRelevanceTokens(chapterTitle, opts.sections || []);
  const scored = lock.entries
    .map(entry => ({ entry, score: entryRelevanceScore(entry, tokens) }))
    .sort((a, b) => b.score - a.score || a.entry.seq - b.entry.seq);
  const selected = scored.map(item => item.entry).slice(0, maxEntries);
  const lines: string[] = [];
  let total = 0;
  for (const entry of selected) {
    const specText = entry.specQuantityPairs.length > 0 ? ` [${entry.specQuantityPairs.map(pair => `${pair.spec} ${pair.quantity}`).join('；')}]` : '';
    const line = `${entry.seq}. ${entry.name}${entry.description ? `（${entry.description}）` : ''}：${entry.quantity}${entry.unit}${entry.section ? `｜${entry.section}` : ''}${specText}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  if (lines.length === 0) return '';
  return [
    '【工程量清单事实锁——确定性权威数据（逐项照抄，不得改动或重新分配）】',
    `清单来源：${lock.sourceFile.split('/').pop()}（${lock.totalEntries} 条目，本节锁定 ${lines.length} 条）`,
    '清单给出规格-数量拆分的必须逐项照抄原值（如 100W 109套、120W 9套），不得自行拆分或重新分配；清单只给总量的不得自行拆分；同一规格-数量拆分在全文各章必须一致。',
    ...lines,
  ].join('\n');
}
