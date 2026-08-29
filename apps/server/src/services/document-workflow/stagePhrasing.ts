import { buildSemanticSimilarity } from './semanticSimilarity';
import type { ValidationIssue } from './types';

/**
 * Q5 施工阶段划分口径一致性检测（round-17）：
 * 施组正文多处出现阶段划分句（“分三个阶段实施”“共分四个阶段”等），互异口径并存即自相矛盾、
 * 评审硬伤。与四层分离架构对齐：
 * - L1 封闭结构提取：含阶段划分动词形态（分为/划分为/共分/分…个阶段/…个阶段）的正文句；
 * - L3 本地 bge 语义聚类：两两余弦 ≥0.62 合并为同口径簇（并查集），互异簇 ≥2 且簇间阶段数互异 → error；
 * - 本地 bge 恒可用（本地 ONNX 推理），嵌入失败直接抛出。
 * 修复链：llm_repairable 进交付阻断修复轮（统一口径指令），复检与检测同源（重跑本检测器）。
 */

/** 阶段划分句封闭结构：含“阶段”且含划分动词形态（“分两个阶段”“划分为三阶段”“三个阶段”等） */
const STAGE_DIVISION_RE = /分[为成]?[^。；;，,\n]{0,12}阶段|共[分设]?[^。；;，,\n]{0,12}阶段|划[分]?为[^。；;，,\n]{0,12}阶段|[二三四五六七八九十]个阶段/u;

/** 同口径簇合并阈值：短句语义聚类取 0.62，防近义表述误并（如“分三个阶段”与“按阶段施工”不应并簇） */
const STAGE_CLUSTER_THRESHOLD = 0.62;

/** 中文数字数值映射（支持“十四”“二十”“十”等连写形式） */
const CN_DIGIT_VALUE: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 提取划分句中的阶段数 token（“四个阶段”“4 个阶段”“三阶段”等紧邻形态） */
function stageCountToken(sentence: string): string | null {
  return /(\d+|[一二三四五六七八九十]+)\s*个?\s*阶段/u.exec(sentence)?.[1] ?? null;
}

/** 阶段数 token → 数值（阿拉伯数字直接解析，中文数字支持连写形式） */
function stageCountNumber(token: string): number | null {
  if (/^\d+$/u.test(token)) return parseInt(token, 10);
  if (!/^[一二三四五六七八九十]+$/u.test(token)) return null;
  if (token === '十') return 10;
  if (token.length === 1) return CN_DIGIT_VALUE[token] ?? null;
  if (token.startsWith('十')) return 10 + (CN_DIGIT_VALUE[token[1]] ?? 0);
  if (token.endsWith('十')) return (CN_DIGIT_VALUE[token[0]] ?? 0) * 10;
  return (CN_DIGIT_VALUE[token[0]] ?? 0) * 10 + (CN_DIGIT_VALUE[token[2]] ?? 0);
}

/** 簇的阶段数口径：簇内各句提取阶段数全部一致才返回该数值，否则 null（该簇口径无法确定） */
function clusterStageCount(group: string[]): number | null {
  const numbers = group
    .map(stageCountToken)
    .filter((token): token is string => token !== null)
    .map(token => stageCountNumber(token))
    .filter((value): value is number => value !== null);
  if (numbers.length === 0) return null;
  return new Set(numbers).size === 1 ? numbers[0] : null;
}

export async function stagePhrasingIssues(markdown: string): Promise<ValidationIssue[]> {
  // L1：按句提取阶段划分句（去标题行/表格行；句长 8-60 字防整段与标题混入，句子太短无聚类意义）
  const sentences = markdown
    .split(/\n+/u)
    .filter(line => line.trim() && !/^\s*(#{1,6}\s+|\|)/u.test(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.replace(/\s+/gu, '').trim())
    .filter(sentence => sentence.length >= 8 && sentence.length <= 60 && STAGE_DIVISION_RE.test(sentence));
  const unique = [...new Set(sentences)];
  if (unique.length < 2) return [];
  // L3：语义聚类——同口径划分句互相似，互异簇（不同划分口径）才计数
  const similarity = await buildSemanticSimilarity(unique, unique);
  const parent = unique.map((_, index) => index);
  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) root = parent[root];
    let cursor = node;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (left: number, right: number) => { parent[find(right)] = find(left); };
  for (let left = 0; left < unique.length; left += 1) {
    for (let right = left + 1; right < unique.length; right += 1) {
      if (similarity(unique[left], unique[right]) >= STAGE_CLUSTER_THRESHOLD) union(left, right);
    }
  }
  const clusters = new Map<number, string[]>();
  for (let index = 0; index < unique.length; index += 1) {
    const root = find(index);
    const group = clusters.get(root) || [];
    group.push(unique[index]);
    clusters.set(root, group);
  }
  if (clusters.size < 2) return [];
  // round-18 E8 灵敏度修复：互异簇阈值 3→2（现场“按九个阶段编制”vs“划分为四个阶段”仅两簇未触发）。
  // 双证据防线：语义互异簇 ≥2 且簇间阶段数互异（确定性数字校验）才判定冲突——
  // 语义模型对短句聚类存在抖动，同数字的同义表述（如“分三个阶段”vs“共分三阶段”误分两簇）不报，零误伤优先。
  const clusterCounts = [...clusters.values()].map(clusterStageCount);
  if (new Set(clusterCounts.filter((value): value is number => value !== null)).size < 2) return [];
  const representatives = [...clusters.values()]
    .map(group => group.sort((a, b) => b.length - a.length)[0])
    .slice(0, 4);
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `施工阶段划分口径不统一：正文出现 ${clusters.size} 种互异阶段划分口径（${representatives.map(item => `“${item.slice(0, 16)}”`).join('、')}）`,
    suggestion: '全文统一阶段划分口径：以总进度计划/施工部署章节的划分为唯一口径，其余章节划分句逐字对齐或删除。',
  }];
}
