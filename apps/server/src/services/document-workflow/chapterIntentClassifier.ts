import type { BlueprintAuthorityId } from './integratedBlueprint';
import { getLocalSemanticProvider } from './semanticSimilarity';

/**
 * P17 章标题意图语义分类器（第 4 期）：三处标题意图判定从正则关键词封闭集迁移到
 * 本地 bge-small 嵌入的语义分类（语义优先、正则兜底）。
 *
 * 迁移背景：正则关键词封闭集必然漏判变体表述（如「施工部署」实为进度类章但正则无「进度」二字），
 * 且同词异义误伤（如「资源配置」命中蓝图权威但实际为无关小节）。语义模型本地恒可用（本地 ONNX 推理），
 * 构建失败直接抛出暴露缺陷，无不可用降级路径（与 factTokenClassifier 同款模式）。
 *
 * 行为保持：判定为语义命中（余弦 ≥0.6）OR 历史正则命中（union）——原正则命中集不变，
 * 语义仅扩展变体标题的命中，不收缩既有命中（与正则并存一版本，对比真实生成命中差异后下线正则）。
 */

/** 蓝图数值密集章原型（按权威分组；「施工部署/总体部署」为方案指定的进度类语义变体） */
const BLUEPRINT_ANCHOR_GROUPS: ReadonlyArray<{ authority: BlueprintAuthorityId; anchors: readonly string[] }> = [
  { authority: 'laborPeak', anchors: ['劳动力安排计划', '劳动力配置计划', '劳动力投入计划', '主要劳动力计划', '劳动力使用计划'] },
  { authority: 'schedule', anchors: ['施工进度计划', '施工总进度计划', '工程进度计划', '进度计划', '工期计划', '施工部署', '总体部署'] },
  { authority: 'blueprint', anchors: ['主要资源配置计划', '资源配置计划', '资源需求计划', '机械设备配置计划', '材料供应计划', '主要施工机械设备表'] },
];

/** 概况类章基础事实注入原型（事实池前置注入的标题口径） */
const BASIC_FACTS_ANCHORS = ['工程概况', '项目概况', '工程总体概况', '施工总体部署', '施工部署', '工程目标', '工程质量目标', '工程进度目标'] as const;

/** 扬尘六项百分百注入原型（国家规范固定封闭集写作侧前置注入的标题口径） */
const DUST_CONTROL_ANCHORS = ['扬尘治理措施', '扬尘污染防治措施', '文明施工措施', '环境保护措施', '绿色施工措施', '安全文明施工措施', '扬尘控制措施'] as const;

/** 兜底正则：与迁移前历史正则逐字一致（语义未命中时保持原命中集不变） */
const BLUEPRINT_LABOR_RE = /劳动力/u;
const BLUEPRINT_RESOURCE_RE = /资源配置|资源|机械|设备|机具/u;
const BLUEPRINT_SCHEDULE_RE = /进度计划|进度|工期/u;
const BASIC_FACTS_RE = /概况|工程|项目|总体|部署|进度|工期|质量/u;
const DUST_CONTROL_RE = /扬尘|文明施工|环境保护|绿色施工|安全文明|环保/u;

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
  return sum;
}

function maxSimilarity(vector: number[], anchors: number[][]): number {
  return Math.max(...anchors.map(anchor => dot(vector, anchor)));
}

/** 章标题意图分类器：三意图判定均语义优先、正则兜底（union 只增不减） */
export interface ChapterIntentClassifier {
  /** 数值密集章所需蓝图权威清单（语义扩展变体标题命中，正则保持历史口径） */
  needsBlueprintAuthority(title: string): BlueprintAuthorityId[];
  /** 概况类章基础事实注入判定 */
  needsBasicFacts(title: string): boolean;
  /** 扬尘六项百分百注入判定 */
  needsDustControl(title: string): boolean;
}

/** 构建章标题意图分类器：预嵌入全部原型与全部章标题（一次批量，语义模型失败直接抛出） */
export async function buildChapterIntentClassifier(chapterTitles: readonly string[]): Promise<ChapterIntentClassifier> {
  const provider = getLocalSemanticProvider();
  const allAnchors: string[] = [
    ...BLUEPRINT_ANCHOR_GROUPS.flatMap(group => group.anchors),
    ...BASIC_FACTS_ANCHORS,
    ...DUST_CONTROL_ANCHORS,
  ];
  const vectors = await provider.embedDocuments([...allAnchors, ...chapterTitles]);
  if (vectors.length !== allAnchors.length + chapterTitles.length) {
    throw new Error(`本地语义模型锚点嵌入数量不一致：预期 ${allAnchors.length + chapterTitles.length}，实际 ${vectors.length}`);
  }
  const anchorVectors = vectors.slice(0, allAnchors.length);
  const titleVectors = new Map<string, number[]>();
  chapterTitles.forEach((title, index) => titleVectors.set(title, vectors[allAnchors.length + index] ?? []));
  let offset = 0;
  const groupVectors = BLUEPRINT_ANCHOR_GROUPS.map(group => {
    const groupSlice = anchorVectors.slice(offset, offset + group.anchors.length);
    offset += group.anchors.length;
    return groupSlice;
  });
  const basicVectors = anchorVectors.slice(offset, offset + BASIC_FACTS_ANCHORS.length);
  offset += BASIC_FACTS_ANCHORS.length;
  const dustVectors = anchorVectors.slice(offset, offset + DUST_CONTROL_ANCHORS.length);

  const semanticHit = (title: string, anchorVecs: number[][]): boolean => {
    const vector = titleVectors.get(title);
    return Boolean(vector && vector.length > 0 && maxSimilarity(vector, anchorVecs) >= 0.6);
  };

  return {
    needsBlueprintAuthority(title) {
      const needed: BlueprintAuthorityId[] = [];
      BLUEPRINT_ANCHOR_GROUPS.forEach((group, index) => {
        if (semanticHit(title, groupVectors[index])) needed.push(group.authority);
      });
      // 语义优先、正则兜底（union）：原正则映射保持，语义扩展变体标题命中
      if (!needed.includes('laborPeak') && BLUEPRINT_LABOR_RE.test(title)) needed.push('laborPeak');
      if (!needed.includes('blueprint') && BLUEPRINT_RESOURCE_RE.test(title)) needed.push('blueprint');
      if (!needed.includes('schedule') && BLUEPRINT_SCHEDULE_RE.test(title)) needed.push('schedule');
      return needed;
    },
    needsBasicFacts(title) {
      return semanticHit(title, basicVectors) || BASIC_FACTS_RE.test(title);
    },
    needsDustControl(title) {
      return semanticHit(title, dustVectors) || DUST_CONTROL_RE.test(title);
    },
  };
}
