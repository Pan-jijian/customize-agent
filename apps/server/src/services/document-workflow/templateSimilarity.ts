import { buildSemanticSimilarity } from './semanticSimilarity';

/**
 * A3 模板化语义相似度检测（对标 docx 判定标尺"文本相似度三档"）：
 * 把生成文档核心句与模板参考库同类样本切片的语义相似度量化到三档判定——
 * <30% 独立编制 / 30%-60% 参考改编 / >60% 抄袭风险（docx 超 30% 触发雷同判定）。
 *
 * 设计边界（与 semanticSimilarity.ts 一致）：
 * - 只用本地 bge-small-zh-v1.5 嵌入做短句级对比，长正文语义仍由 LLM 承接；
 * - 嵌入模型不可用、参考库无样本、文本过短 → 返回 undefined，调用方降级不阻塞；
 * - 相似度是"与同类优秀样本的重合度"信号而非抄袭实锤，报告仅供降档与提示。
 */

export type TemplateSimilarityLevel = 'independent' | 'adapted' | 'risky';

export interface TemplateSimilarityReport {
  /** 三档判定：<0.3 独立编制 / 0.3-0.6 参考改编 / >0.6 抄袭风险 */
  level: TemplateSimilarityLevel;
  /** 生成文档与参考库的最高单句相似度（0-1） */
  maxSimilarity: number;
  /** 全部抽样句的平均最高相似度（0-1） */
  avgSimilarity: number;
  /** 参与对比的生成侧抽样句数 */
  sampledSentences: number;
  /** 参与对比的参考切片数 */
  referenceSlices: number;
}

/** 相似度三档阈值（docx：<30% 独立 / 30-60% 参考改编 / >60% 抄袭风险） */
export const SIMILARITY_ADAPTED_THRESHOLD = 0.3;
export const SIMILARITY_RISKY_THRESHOLD = 0.6;

export function classifyTemplateSimilarity(maxSimilarity: number): TemplateSimilarityLevel {
  if (maxSimilarity >= SIMILARITY_RISKY_THRESHOLD) return 'risky';
  if (maxSimilarity >= SIMILARITY_ADAPTED_THRESHOLD) return 'adapted';
  return 'independent';
}

/** 生成文档核心句抽样：按长度自适应抽样（每 ~2000 字 1 句，至少 4 句最多 16 句，≥20 字正文句） */
export function sampleGeneratedSentences(markdown: string, targetCount = 12): string[] {
  const sentences = markdown
    .split(/\n+/u)
    .filter(line => line.trim() && !/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.replace(/\s+/gu, ' ').trim())
    .filter(sentence => sentence.length >= 20 && sentence.length <= 160);
  if (sentences.length <= targetCount) return sentences;
  const step = sentences.length / targetCount;
  const sampled: string[] = [];
  for (let i = 0; i < targetCount; i++) sampled.push(sentences[Math.floor(i * step)] as string);
  return [...new Set(sampled)];
}

/** 参考库切片规范化：去空白、限长（过长切片语义被稀释，只保留前 300 字） */
export function normalizeReferenceSlices(slices: string[]): string[] {
  return [...new Set(slices
    .map(slice => slice.replace(/\s+/gu, ' ').trim())
    .filter(slice => slice.length >= 20)
    .map(slice => slice.slice(0, 300)))]
    .slice(0, 48);
}

/**
 * 构建模板相似度报告：生成侧抽样句 × 参考库切片做余弦相似度。
 * embedDocuments 注入时走注入实现（单测/替换），否则用本地 bge-small；失败返回 undefined。
 */
export async function buildTemplateSimilarityReport(
  markdown: string,
  referenceSlices: string[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<TemplateSimilarityReport | undefined> {
  const leftTexts = sampleGeneratedSentences(markdown);
  const rightTexts = normalizeReferenceSlices(referenceSlices);
  if (leftTexts.length === 0 || rightTexts.length === 0) return undefined;
  const similarity = await buildSemanticSimilarity(leftTexts, rightTexts, embedDocuments);
  if (!similarity) return undefined;
  const perSentenceMax = leftTexts.map(left =>
    Math.max(...rightTexts.map(right => similarity(left, right))),
  );
  const maxSimilarity = Math.max(...perSentenceMax);
  const avgSimilarity = perSentenceMax.reduce((sum, value) => sum + value, 0) / perSentenceMax.length;
  return {
    level: classifyTemplateSimilarity(maxSimilarity),
    maxSimilarity,
    avgSimilarity,
    sampledSentences: leftTexts.length,
    referenceSlices: rightTexts.length,
  };
}
