/**
 * 质量对标评分：把生成文档的质量画像与模板参考库中同工程类型的基准画像对比，
 * 产出逐项对标结果与总分（0-100）。纯计算，无 LLM。
 */
import { buildReferenceQualityProfile, suggestProjectType, type ReferenceProjectType } from './referenceQualityProfile';
import { referenceBenchmarkForType } from './templateReferenceService';

export interface QualityBenchmarkItem {
  /** 指标标识：paramDensity/arrowChainCoverage/duplicationRate/tableCount/sectionCount */
  key: string;
  /** 展示名称（中文，与画像维度一一对应） */
  label: string;
  /** 生成文档实测值 */
  generated: number;
  /** 参考基准值（主参考画像或同类型均值口径） */
  reference: number;
  /** 单项达成率（0-100，可超 100 截断） */
  score: number;
  /** 单项是否达到基准 */
  passed: boolean;
  /** 数值说明（格式：百分比/每千字等） */
  unit: 'percent' | 'count' | 'perKChars';
}

export interface QualityBenchmarkResult {
  /** 对标所用工程类型（自动按生成内容分类） */
  projectType: ReferenceProjectType;
  /** 参与对标的参考文件数量 */
  referenceSourceCount: number;
  /** 总分（0-100） */
  overallScore: number;
  items: QualityBenchmarkItem[];
}

/** 单项达成率（生成值 / 目标值，封顶 120） */
function ratioScore(generated: number, target: number): number {
  if (target <= 0) return generated > 0 ? 100 : 0;
  return Math.min(120, (generated / target) * 100);
}

/** 重复率单项：越低越好（生成 ≤ 基准即满分，超标线性扣分） */
function duplicationScore(generated: number, reference: number): number {
  if (generated <= reference) return 100;
  return Math.max(0, Math.round(100 - (generated - reference) * 400));
}

/** 对生成文档做质量对标（按内容自动识别工程类型，取参考库同类型基准） */
export function benchmarkGeneratedMarkdown(markdown: string): QualityBenchmarkResult | undefined {
  if (!markdown || markdown.trim().length < 500) return undefined;
  const projectType = suggestProjectType(markdown);
  const benchmark = referenceBenchmarkForType(projectType);
  if (!benchmark) return undefined;
  const generated = buildReferenceQualityProfile(markdown);
  const reference = benchmark.profile;
  // 工序链目标：参考文件该特征普遍偏弱，取 max(参考值, 8%) 作为最低目标（生成侧有门禁要求）
  const arrowTarget = Math.max(reference.arrowChainCoverage, 0.08);
  const items: QualityBenchmarkItem[] = [
    {
      key: 'paramDensity', label: '参数密度', generated: generated.paramDensity, reference: reference.paramDensity,
      score: ratioScore(generated.paramDensity, reference.paramDensity * 0.8), unit: 'perKChars' as const,
    },
    {
      key: 'arrowChainCoverage', label: '工序链覆盖率', generated: generated.arrowChainCoverage, reference: arrowTarget,
      score: ratioScore(generated.arrowChainCoverage, arrowTarget), unit: 'percent' as const,
    },
    {
      key: 'duplicationRate', label: '段落重复率', generated: generated.duplicationRate, reference: reference.duplicationRate,
      score: duplicationScore(generated.duplicationRate, reference.duplicationRate), unit: 'percent' as const,
    },
    {
      key: 'tableCount', label: '表格数量', generated: generated.tableCount, reference: reference.tableCount,
      score: ratioScore(generated.tableCount, reference.tableCount * 0.6), unit: 'count' as const,
    },
    {
      key: 'sectionCount', label: '章节结构', generated: generated.sectionCount, reference: reference.sectionCount,
      score: generated.sectionCount >= reference.sectionCount * 0.4 ? 100 : ratioScore(generated.sectionCount, reference.sectionCount), unit: 'count' as const,
    },
  ].map(item => ({ ...item, score: Math.round(Math.min(120, item.score)), passed: item.score >= 80 }));
  // 加权总分：参数密度 30 / 工序链 20 / 重复率 20 / 表格 15 / 章节 15
  const weights: Record<string, number> = { paramDensity: 0.3, arrowChainCoverage: 0.2, duplicationRate: 0.2, tableCount: 0.15, sectionCount: 0.15 };
  const overallScore = Math.round(Math.min(100, items.reduce((sum, item) => sum + item.score * (weights[item.key] || 0), 0)));
  return { projectType, referenceSourceCount: benchmark.sourceCount, overallScore, items };
}
