/**
 * 小节命名治理器（L1 确定性层 + L2 章级定名轮，命名质量单源）：
 * L1：规划层、蓝图层、成稿层共用同一套拼接规范化 / 重名消解 / 退化检测，
 *     杜绝各生成点自建黑名单副本（历史缺陷：集成蓝图与规划器两套正则黑名单互不同步）；
 * L2：撞名（指纹池）/ 退化信号门控触发一次轻量 LLM 改名轮，无信号零调用，失败静默回退。
 */
import { callDocumentLlmJson } from './llmClient';
import { normalizePlannedSectionTitle } from './outline';
import { docSystemPrefix } from './markdownComposer';
import { DIVERSITY_PLANNING_TEMPERATURE } from './diversityProfile';
import { findFingerprintCollisions, titlesCollide } from './sectionFingerprint';
import type { SectionFingerprintPool } from './sectionFingerprint';
import type { DiversityProfile } from './diversityProfile';
import type { DocumentGenerationDiagnostics } from './types';

/** 归一化比对键：剥编号/标点/空白后的紧缩形（重名与撞名判定统一口径） */
export function sectionTitleKey(title: string) {
  return normalizePlannedSectionTitle(String(title || '')).replace(/[\s()（）:：.。；;,，、\-—·]/gu, '');
}

/** 主题块拼接命名：消除 base 尾部与 label 首部的最长公共串（「装饰」+「装饰装修工程」→「装饰装修工程」，
 * 防「装饰装饰装修工程」类粘连怪名；「公厕」+「结构与基础工程」→「公厕结构与基础工程」原样拼接） */
export function composeBlockTitle(base: string, label: string) {
  const left = String(base || '').trim();
  const right = String(label || '').trim();
  if (!left) return right;
  if (!right) return left;
  const max = Math.min(left.length, right.length);
  for (let overlap = max; overlap > 0; overlap -= 1) {
    if (left.slice(-overlap) === right.slice(0, overlap)) return `${left.slice(0, -overlap)}${right}`;
  }
  return `${left}${right}`;
}

/** 块标题归属：owner = 单位工程短名（重名消解时注入以消歧） */
export interface BlockTitleOwnership {
  title: string;
  owner?: string;
}

const CHINESE_ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 章内块标题重名消解（确定性）：重名组成员统一注入 owner 前缀（「零星装饰工程」×4 →
 * 「装饰零星装饰工程」「公厕零星装饰工程」…）；owner 注入后仍撞（同归属同名工作包）追加中文序号兜底。
 * 返回与输入等长的标题数组（不重名的标题原样保留）。 */
export function disambiguateBlockTitles(entries: BlockTitleOwnership[]) {
  const keys = entries.map(entry => sectionTitleKey(entry.title));
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  const used = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    let title = String(entry.title || '').trim();
    if ((counts.get(keys[index]!) || 0) > 1) {
      const owner = String(entry.owner || '').trim();
      const ownerKey = sectionTitleKey(owner);
      if (ownerKey && !sectionTitleKey(title).startsWith(ownerKey)) {
        // 注入前先剥编号/标点（防「2.1 零星装饰工程」被拼成「装饰2.1 零星装饰工程」）
        title = composeBlockTitle(owner, normalizePlannedSectionTitle(title));
      }
    }
    let candidate = title;
    let ordinal = 1;
    while (used.has(sectionTitleKey(candidate))) {
      ordinal += 1;
      candidate = `${title}（${CHINESE_ORDINALS[ordinal - 1] || ordinal}）`;
    }
    used.add(sectionTitleKey(candidate));
    result.push(candidate);
  }
  return result;
}

/** 退化标题检测（治理器单源）：空/过短、整体短单元重复（「装饰装饰」）、相邻字符重复（「要点要点」） */
export function isDegenerateSectionTitle(title: string) {
  const normalized = normalizePlannedSectionTitle(String(title || '')).replace(/\s+/gu, '');
  if (normalized.length < 4) return true;
  if (/^(.{2,5})\1$/u.test(normalized)) return true;
  if (/(.)\1/u.test(normalized)) return true;
  return false;
}

/** L2 定名轮输入 */
export interface ChapterNamingInput {
  chapterTitle: string;
  /** 章内块（标题 + 要点名，供 LLM 理解小节语义） */
  blocks: Array<{ title: string; pointTitles: string[] }>;
  /** 历史指纹池（undefined = 跳过池检测；空池自然无信号） */
  fingerprintPool?: SectionFingerprintPool;
  /** 重检场景排除自身文档 */
  excludeDocumentId?: string;
  /** 多样性画像（命名风格引导，可选） */
  profile?: DiversityProfile;
  signal?: AbortSignal;
  diagnostics?: DocumentGenerationDiagnostics;
}

/** L2 章级定名轮：撞名（指纹池）/退化标题信号门控触发一次轻量 LLM 调用（maxTokens 800，
 * 温度=DIVERSITY_PLANNING_TEMPERATURE），产出改名映射并经确定性校验后应用：
 * 新名须非退化、不得与本章组外标题撞、不得撞历史池；同名拆半对组内统一改名；未命中/校验不过的改名丢弃。
 * 无信号 → 零 LLM 调用、标题原样返回；调用失败 → 原样返回（不阻断生成）。 */
export async function governChapterBlockNames(input: ChapterNamingInput): Promise<{ titles: string[]; renamed: number; summary: string | null }> {
  const titles = input.blocks.map(block => block.title);
  const collisions = input.fingerprintPool
    ? findFingerprintCollisions(titles, input.fingerprintPool, { excludeDocumentId: input.excludeDocumentId })
    : [];
  const degenerate = titles.filter(title => isDegenerateSectionTitle(title));
  const targets = [...new Set([...collisions.map(item => item.title), ...degenerate])];
  if (targets.length === 0) return { titles, renamed: 0, summary: null };
  let renames: Record<string, string>;
  try {
    const result = await callDocumentLlmJson<{ renames?: Record<string, string> }>([
      docSystemPrefix('你是施工组织设计目录命名审查专家。'),
      '输入某章的小节标题清单与点名需改名的标题（与历史文档撞名或命名退化），只输出改名映射。',
      '改名规则：只改点名标题，不改未点名标题；新标题必须仍是同一专业对象或同一工程内容的具体表述，不得改变小节实质；16 个汉字以内；不得仅通过添加“工作/内容/相关/方案”等尾词规避撞名，必须实质性更换措辞；不得与本章其他小节标题用词高度相似（防章内撞名）。',
      input.profile ? input.profile.prompt : '',
      '只返回 JSON。',
    ].filter(Boolean).join('\n'), [
      `章标题：${input.chapterTitle}`,
      `本章小节清单：\n${input.blocks.map(block => `- ${block.title}${block.pointTitles.length ? `（要点：${block.pointTitles.slice(0, 3).join('、')}）` : ''}`).join('\n')}`,
      `需要改名的标题：${targets.join('、')}`,
      collisions.length ? `历史撞名对照（本次 ↔ 历史文档）：\n${collisions.map(item => `「${item.title}」↔「${item.collidedWith}」`).join('\n')}` : '',
      degenerate.length ? `命名退化（重复/残片）标题：${degenerate.join('、')}` : '',
      'JSON 格式：{"renames":{"原标题":"新标题"}}（只包含需要改名的标题）',
    ].filter(Boolean).join('\n\n'), { maxTokens: 800, temperature: DIVERSITY_PLANNING_TEMPERATURE, signal: input.signal, diagnostics: input.diagnostics });
    renames = result?.renames && typeof result.renames === 'object' ? result.renames : {};
  } catch (error) {
    console.error(`[naming] 定名轮调用失败（保留原命名）：${input.chapterTitle}，${error instanceof Error ? error.message : String(error)}`);
    return { titles, renamed: 0, summary: null };
  }
  let renamed = 0;
  for (const [from, toRaw] of Object.entries(renames)) {
    const fromKey = sectionTitleKey(from);
    if (!fromKey) continue;
    // 拆半对安全：同名拆半块共享父标题（同名×N），改名必须对组内全部同名索引统一应用——
    // 只改第一个会破坏写作层相邻同标题合并（mergeHalfBlockShells），成稿出现两个独立小节
    const groupIndexes = titles.flatMap((title, index) => (sectionTitleKey(title) === fromKey ? [index] : []));
    if (groupIndexes.length === 0 || !targets.some(target => sectionTitleKey(target) === fromKey)) continue;
    const to = normalizePlannedSectionTitle(String(toRaw || ''));
    if (!to || to.length > 24 || isDegenerateSectionTitle(to)) continue;
    // 新名不得与本章组外标题撞（含未点名标题与已确认新名；组内统一改名后同名不判撞），不得撞历史池
    if (titles.some((title, position) => !groupIndexes.includes(position) && titlesCollide(title, to))) continue;
    if (input.fingerprintPool && findFingerprintCollisions([to], input.fingerprintPool, { excludeDocumentId: input.excludeDocumentId }).length > 0) continue;
    for (const index of groupIndexes) titles[index] = to;
    renamed += 1;
  }
  if (renamed === 0) return { titles, renamed: 0, summary: null };
  return {
    titles,
    renamed,
    summary: `命名定名轮：改名 ${renamed} 个（撞名 ${collisions.length} 个/退化 ${degenerate.length} 个信号）`,
  };
}
