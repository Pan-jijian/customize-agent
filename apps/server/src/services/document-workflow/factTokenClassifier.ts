import { getLocalSemanticProvider } from './semanticSimilarity';

/**
 * 总量口径语义分类器（round-13）：把“模糊单位 token 的上下文是否属于项目总量口径（工期/金额/面积）”
 * 的判断从正则关键词封闭集迁移到本地 bge-small 嵌入的语义分类。
 *
 * 背景（十一度实测误伤）：“4次”是专项应急演练频次计数，因 ±36 字上下文出现“日历天”关键词被正则
 * 升级为工期总量口径判为编造（跨口径误伤）；同时正则关键词封闭集必然漏判变体表述（漏检）。
 * 协同边界：结构门控（单位后缀/标准编号等确定性格式信息）仍由正则处理，语义判断（上下文口径归属）
 * 由本分类器完成；模型不可用时调用方降级为纯正则门控，语义模型不可用不得阻塞生成。
 */

/** 总量口径语义锚点：工期/金额/建设规模三类评标可复核的硬口径 */
const SCOPE_ANCHORS = [
  '计划总工期为300日历天',
  '合同工期为300日历天',
  '施工总工期为300日历天',
  '招标控制价为6000万元',
  '合同估算价为6000万元',
  '投资估算为6000万元',
  '总建筑面积为28000平方米',
  '总用地面积为15000平方米',
  '总占地面积为15000平方米',
  '建设规模为28000平方米',
] as const;

/** 频次计数口径语义锚点：管理制度类计数表述，不得升级为总量口径 */
const COUNT_ANCHORS = [
  '专项应急演练4次',
  '每日巡查2次',
  '每周检查1次',
  '每月安全培训2次',
  '监理旁站24小时',
  '三级安全教育培训20学时',
] as const;

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
  return sum;
}

/** 总量口径语义分类器：批量分类 token+context 组合文本 */
export interface FactTokenScopeClassifier {
  /** 批量分类：queries 为 `${token} ${context}` 组合文本，返回与输入等长的 'scope'|'other' 数组 */
  batchClassify: (queries: string[]) => Promise<Array<'scope' | 'other'>>;
}

/** 构建总量口径语义分类器：预嵌入锚点向量；模型加载失败返回 undefined（调用方降级正则门控） */
export async function buildFactTokenScopeClassifier(): Promise<FactTokenScopeClassifier | undefined> {
  try {
    const provider = getLocalSemanticProvider();
    if (!provider) return undefined;
    const [scopeVectors, countVectors] = await Promise.all([
      provider.embedDocuments([...SCOPE_ANCHORS]),
      provider.embedDocuments([...COUNT_ANCHORS]),
    ]);
    if (scopeVectors.length !== SCOPE_ANCHORS.length || countVectors.length !== COUNT_ANCHORS.length) return undefined;
    return {
      async batchClassify(queries) {
        try {
          if (queries.length === 0) return [];
          const queryVectors = await provider.embedDocuments(queries);
          return queries.map((_, index) => {
            const vector = queryVectors[index];
            if (!vector || vector.length === 0) return 'other' as const;
            const scopeSim = Math.max(...scopeVectors.map(anchor => dot(vector, anchor)));
            const countSim = Math.max(...countVectors.map(anchor => dot(vector, anchor)));
            // 频次计数口径显著且强于总量口径时不升级；总量口径锚点显著时升级 scope（余弦 ≥0.6）
            if (countSim >= 0.62 && countSim > scopeSim) return 'other' as const;
            return scopeSim >= 0.6 ? 'scope' as const : 'other' as const;
          });
        } catch {
          // 单次批量分类失败不阻塞校验：全部降级 other（保持正则门控基类结果）
          return queries.map(() => 'other' as const);
        }
      },
    };
  } catch {
    return undefined;
  }
}
