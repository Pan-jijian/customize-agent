import { createHash } from 'node:crypto';
import { documentTextLength } from './budget';

// 工作包型关键小节：标题后以同级 H4 工作包（施工概况/施工流程/施工方法）展开正文。
// 深度口径必须向下包含这些同级 H4，否则只提取到标题后的概述段，关键小节永远“深度不足”并触发破坏性修复
export const WORK_PACKAGE_SECTION_RE = /项目主要施工内容|主要分部分项工程施工方案|主要施工方法/u;

// 按标题定位正文小节：精确模式（默认）按“标题行含目标字符串 + 同级/上级标题定界”返回整节（含标题行）；
// fuzzy 模式按归一化标题模糊匹配（剥离编号/空白/常见泛化词）返回最长命中正文（不含标题行）。
// 供关键小节深度/密度检查（documentPipeline）与 Reviewer 小节定位（agentPlanner）共用，避免三处重复实现漂移。
export function extractSection(content: string, title: string, options: { fuzzy?: boolean } = {}): string {
  if (!options.fuzzy) {
    const primary = extractSectionExact(content, title, /^###\s+(?:\d+(?:\.\d+)*\s+)?/u);
    if (primary) return primary;
    return extractSectionExact(content, title, /^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?/u);
  }
  return extractSectionFuzzy(content, title);
}

function extractSectionExact(content: string, title: string, headingStartRe: RegExp) {
  const lines = content.split('\n');
  const start = lines.findIndex(line => headingStartRe.test(line.trim()) && line.includes(title));
  if (start < 0) return '';
  const startLevel = (/^(#{2,6})\s+/u.exec(lines[start].trim())?.[1].length) || 3;
  // 工作包型关键小节（H4 标题 + 同级 H4 工作包展开）：同级 H4 是正文而非边界，
  // 仅上级标题（H2/H3）定界，向下包含全部工作包正文
  const includePeerH4 = startLevel === 4 && WORK_PACKAGE_SECTION_RE.test(title);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = /^(#{2,6})\s+/u.exec(lines[index].trim());
    if (heading && heading[1].length <= startLevel && !(includePeerH4 && heading[1].length === startLevel)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function sectionHeadingTitleText(line: string) {
  return line
    .replace(/^\s*#{2,4}\s*/u, '')
    .replace(/^\s*(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)(?:[、.．]|\s+)\s*/u, '')
    .trim();
}

/**
 * 标题可比归一化：去除编号、空白与高频修饰词后比较，供小节定位与深度提取共用。
 * 定位口径必须与 extractSectionFuzzy 一致：验收器按可比标题找到的小节，修复器也要能用同口径定位替换，
 * 否则出现“验收器报深度不足、修复器未定位到原小节块”的错配（真实生成缺陷：项目特点、重点、难点分析 ↔ 项目重点难点分析）。
 */
export function comparableSectionTitleText(value: string) {
  return sectionHeadingTitleText(value)
    .replace(/\s+/gu, '')
    .toLowerCase()
    .replace(/施工(?=方案|流程|方法)/gu, '')
    .replace(/专项(?=方案)/gu, '')
    .replace(/项目|工程|主要|重点|技术/gu, '')
    // 连接词与顿号不参与可比性：成稿标题常把细目顿号改写为“与/及”（如“项目特点、重点、难点分析”→“工程特点与重点难点分析”），
    // 不剥离会永久匹配失败，关键小节被误报“正文不足”且修复轮次空转（真实生成缺陷：3 轮修复后仍 2 个阻断问题）
    .replace(/[、，,；;·．.／/]+/gu, '')
    .replace(/与|及|和|暨/gu, '');
}

function extractSectionFuzzy(content: string, sectionTitle: string) {
  const lines = content.split('\n');
  const normalizedTitle = sectionHeadingTitleText(sectionTitle).replace(/\s+/gu, '').toLowerCase();
  const comparableTitle = comparableSectionTitleText(sectionTitle);
  const matches: string[] = [];
  let start = -1;
  let startLevel = 0;
  let startWorkPackage = false;
  const flush = (end: number) => {
    if (start < 0) return;
    const body = lines.slice(start, end).join('\n').trim();
    if (body) matches.push(body);
    start = -1;
    startLevel = 0;
    startWorkPackage = false;
  };
  for (let index = 0; index < lines.length; index += 1) {
    // H4 必须纳入标题扫描：主题块成稿正文以 `### 主题块` + `#### H4 要点` 组织，
    // Reviewer 的 plannedCoverage 锚点是 H4 要点标题；旧实现只扫 H2/H3 导致锚点全部匹配失败，
    // 产生"未匹配到独立小节标题"误报与 Repairer 修复无效循环
    if (!/^\s*#{2,4}\s+/u.test(lines[index])) continue;
    const level = (/^\s*(#{2,4})\s+/u.exec(lines[index])?.[1].length) || 3;
    // H3 小节命中后向下包含 H4 子节：H3 小节正文常全部承载于其 H4 子节（H3 自身零正文），
    // 若在 H4 处截断会提取 0 字并误报“正文不足” blocker（真实生成缺陷：危大工程专项施工方案审批流程
    // 下 4 个 H4 共 1298 字仍被报不足，修复 3 轮空转）；工作包型小节命中后同级 H4 同理是正文而非边界
    if (start >= 0 && (startWorkPackage || startLevel === 3) && level === 4) continue;
    flush(index);
    const normalizedHeading = sectionHeadingTitleText(lines[index]).replace(/\s+/gu, '').toLowerCase();
    const comparableHeading = comparableSectionTitleText(lines[index]);
    if (normalizedHeading === normalizedTitle || normalizedHeading.includes(normalizedTitle) || normalizedTitle.includes(normalizedHeading) || comparableHeading === comparableTitle || comparableHeading.includes(comparableTitle) || comparableTitle.includes(comparableHeading)) {
      start = index + 1;
      startLevel = level;
      startWorkPackage = level <= 4 && WORK_PACKAGE_SECTION_RE.test(lines[index]);
    }
  }
  flush(lines.length);
  return matches.sort((a, b) => documentTextLength(b) - documentTextLength(a))[0] || '';
}

export function stableHash(value: unknown) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function asObjectArray<T extends object>(value: unknown): T[] {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object') as T[];
  if (value && typeof value === 'object') return [value as T];
  return [];
}

export function safePlanId(value: string, fallback: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/giu, '-').replace(/^-|-$/gu, '').slice(0, 48);
  return normalized || fallback;
}

export function stringifyFactValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('用户中止');
}

export function adaptiveConcurrency(input: { total: number; kind: 'chapter' | 'search' | 'deepRetrieval' | 'sectionRepair' | 'llmRepair'; targetWords?: number; highRisk?: boolean }) {
  const total = Math.max(1, input.total);
  if (input.kind === 'chapter') {
    if (total <= 3) return total;
    if (total <= 6) return Math.min(total, 4);
    if (total <= 10) return Math.min(total, 6);
    return Math.min(total, 8);
  }
  if (input.kind === 'search') return total <= 6 ? total : Math.min(total, 8);
  if (input.kind === 'deepRetrieval') return Math.min(total, input.highRisk ? 6 : 4);
  if (input.kind === 'sectionRepair') {
    if (total <= 3) return total;
    if (total <= 8) return 4;
    return Math.min(total, 6);
  }
  return Math.min(total, 4);
}

export async function runWithAdaptiveConcurrency<T, R>(items: T[], worker: (item: T, index: number) => Promise<R>, options: { kind: 'chapter' | 'search' | 'deepRetrieval' | 'sectionRepair' | 'llmRepair'; targetWords?: number; highRisk?: boolean; concurrency?: number }) {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(items.length, options.concurrency || adaptiveConcurrency({ total: items.length, kind: options.kind, targetWords: options.targetWords, highRisk: options.highRisk })));
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

/** 轻量信号量：章节生成与审查流水线重叠时分别限制两类并发 */
export class Semaphore {
  private queue: Array<() => void> = [];
  private available: number;

  constructor(limit: number) {
    this.available = Math.max(1, Math.floor(limit));
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.available += 1;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }
}
