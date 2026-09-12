/**
 * 小节标题指纹池（跨文档防雷同 L3）：
 * 每份定稿文档的 H3/H4 标题写入 ~/.customize-agent/section-fingerprints.json（滚动 200 条）；
 * 新一轮生成时对全池做撞名检测，命中项交由条目级改名轮定向重命名。
 * 撞名判定：逐字相等 ∥ 归一化相等 ∥ 最长公共连续子串 ≥3 字且占较短标题比率 ≥40%。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizePlannedSectionTitle } from './outline';

export interface SectionFingerprintEntry {
  documentId: string;
  templateId: string;
  /** 成稿 H3 标题清单 */
  h3: string[];
  /** 成稿 H4 标题清单 */
  h4: string[];
  createdAt: string;
}

export interface SectionFingerprintPool {
  version: 1;
  entries: SectionFingerprintEntry[];
}

const MAX_POOL_ENTRIES = 200;
/** 撞名判定：最长公共连续子串最小命中字数 */
const COLLISION_MIN_RUN = 3;
/** 撞名判定：最长公共连续子串占较短标题的最低比率 */
const COLLISION_MIN_RATIO = 0.4;

function fingerprintBaseDir() {
  return process.env.CUSTOMIZE_AGENT_HOME
    ? path.join(process.env.CUSTOMIZE_AGENT_HOME, '.customize-agent')
    : path.join(os.homedir(), '.customize-agent');
}

export function fingerprintPoolPath() {
  return path.join(fingerprintBaseDir(), 'section-fingerprints.json');
}

/** 读取指纹池（容错：文件缺失/损坏回退空池，不阻断生成） */
export function loadFingerprintPool(): SectionFingerprintPool {
  const file = fingerprintPoolPath();
  if (!fs.existsSync(file)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SectionFingerprintPool>;
    const entries = Array.isArray(parsed?.entries)
      ? parsed.entries.filter((entry): entry is SectionFingerprintEntry => Boolean(entry) && typeof entry === 'object' && typeof (entry as SectionFingerprintEntry).documentId === 'string')
      : [];
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

/** 追加一条指纹（读-合并-滚动 200 条-写；失败静默，不阻断生成） */
export function appendFingerprintEntry(entry: SectionFingerprintEntry): void {
  try {
    const pool = loadFingerprintPool();
    pool.entries = pool.entries.filter(existing => existing.documentId !== entry.documentId);
    pool.entries.push(entry);
    while (pool.entries.length > MAX_POOL_ENTRIES) pool.entries.shift();
    const file = fingerprintPoolPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pool, null, 2), 'utf8');
  } catch (error) {
    console.error(`[fingerprint] 指纹池写入失败（不阻断生成）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 最长公共连续子串长度（汉字场景 O(len²)，先经字符集粗筛控制调用量） */
function longestCommonSubstringLength(left: string, right: string) {
  const a = left;
  const b = right;
  let best = 0;
  const previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const carry = previous[j]!;
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      if (previous[j]! > best) best = previous[j]!;
      diagonal = carry;
    }
  }
  return best;
}

/** 撞名判定：逐字相等 ∥ 归一化相等 ∥ 最长公共连续子串 ≥3 字且占较短标题比率 ≥40% */
export function titlesCollide(left: string, right: string) {
  const rawLeft = String(left || '').trim();
  const rawRight = String(right || '').trim();
  if (!rawLeft || !rawRight) return false;
  if (rawLeft === rawRight) return true;
  const a = normalizePlannedSectionTitle(rawLeft).replace(/\s+/gu, '');
  const b = normalizePlannedSectionTitle(rawRight).replace(/\s+/gu, '');
  if (!a || !b) return false;
  if (a === b) return true;
  // 字符集粗筛：公共字符 <3 必不满足连续子串 ≥3
  const charsB = new Set(b);
  const shared = [...new Set(a)].filter(ch => charsB.has(ch)).length;
  if (shared < COLLISION_MIN_RUN) return false;
  const run = longestCommonSubstringLength(a, b);
  if (run < COLLISION_MIN_RUN) return false;
  return run / Math.min(a.length, b.length) >= COLLISION_MIN_RATIO;
}

export interface FingerprintCollision {
  /** 本次生成的小节标题 */
  title: string;
  /** 池中撞上的历史标题 */
  collidedWith: string;
  /** 历史条目所属文档 */
  documentId: string;
}

/** 撞名检测：本次标题清单 vs 历史池（同批标题内部重复不在此层判定，由命名治理器负责） */
export function findFingerprintCollisions(titles: string[], pool: SectionFingerprintPool, options: { excludeDocumentId?: string } = {}): FingerprintCollision[] {
  const collisions: FingerprintCollision[] = [];
  const history: Array<{ title: string; documentId: string }> = [];
  for (const entry of pool.entries) {
    if (options.excludeDocumentId && entry.documentId === options.excludeDocumentId) continue;
    for (const title of [...(entry.h3 || []), ...(entry.h4 || [])]) {
      if (typeof title === 'string' && title.trim()) history.push({ title, documentId: entry.documentId });
    }
  }
  if (history.length === 0) return collisions;
  for (const title of titles) {
    if (!title || !String(title).trim()) continue;
    const hit = history.find(item => titlesCollide(title, item.title));
    if (hit) collisions.push({ title, collidedWith: hit.title, documentId: hit.documentId });
  }
  return collisions;
}

/** 从成稿 markdown 提取 H3/H4 标题（指纹入池用） */
export function extractHeadingTitles(markdown: string): { h3: string[]; h4: string[] } {
  const h3: string[] = [];
  const h4: string[] = [];
  for (const rawLine of String(markdown || '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^(#{3,4})\s+(.+)$/u.exec(line);
    if (!match) continue;
    const title = match[2]!.replace(/#+\s*$/u, '').trim();
    if (!title) continue;
    (match[1]!.length === 3 ? h3 : h4).push(title);
  }
  return { h3, h4 };
}
