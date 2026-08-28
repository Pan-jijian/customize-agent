import { buildTenderBidScores, buildTenderBidTemplatingReport } from './tenderBidScoring';
import type { DocumentDraftChapter, DocumentFactTrace, DocumentKnowledgeCoverageReport, DocumentQualityReport, DocumentTemplate, ValidationIssue } from './types';

/**
 * 招标技术标评审口径评分（确定性计算，非 LLM）：
 * 维度依据《施组设计汇总方案.md》第二节"高频评审逻辑"表（六维），
 * 权重依据用户"青天大模型 AI 评标"提示词：资料完整性 30%、方案针对性 25%、合规性 20%、可落地性 15%、编制规范性 10%。
 * 低雷同性在评审逻辑中是触发式否决项（与公开模板重合度超 30% 触发雷同判定），
 * 不作为线性权重维度，而是对五维加权结果做乘数修正（uniqueness 低于 90 分开始拉低 overall）。
 * 内部质量门禁（error 级：事实安全/污染/结构缺陷）与评分分离，继续通过 blockingIssues 阻断交付置信度。
 */
export function buildDocumentQualityReport(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  issues: ValidationIssue[];
  knowledgeCoverage: DocumentKnowledgeCoverageReport;
  factTraces: DocumentFactTrace[];
  template?: DocumentTemplate | null;
  /** 参考库同类工程完整五要素块均值（可选）：提供时作为可落地性评分的目标基准 */
  referenceCompleteBlocks?: number;
}): DocumentQualityReport {
  const scores = buildTenderBidScores({
    markdown: input.markdown,
    chapters: input.chapters,
    template: input.template,
    factTraces: input.factTraces,
    issues: input.issues,
    referenceCompleteBlocks: input.referenceCompleteBlocks,
  });
  const weighted = scores.completeness * 0.30 + scores.specificity * 0.25 + scores.compliance * 0.20
    + scores.executability * 0.15 + scores.normalization * 0.10;
  const overall = Math.round(weighted * Math.min(1, scores.uniqueness / 90));
  const blockingIssues = input.issues.filter(issue => issue.level === 'error').length;
  const deliveryProbability = Math.max(0, Math.min(99, Math.round(overall - blockingIssues * 8)));
  const target = input.knowledgeCoverage.score >= 95 ? 95 : 85;
  const templating = buildTenderBidTemplatingReport(input.markdown);
  return {
    overall,
    deliveryProbability,
    target,
    passed: deliveryProbability >= target && blockingIssues === 0,
    scores,
    templating,
    summary: `交付置信度 ${deliveryProbability}% / 目标 ${target}%，综合评分 ${overall}/100（资料完整性 ${scores.completeness}、方案针对性 ${scores.specificity}、合规性 ${scores.compliance}、可落地性 ${scores.executability}、编制规范性 ${scores.normalization}、低雷同性 ${scores.uniqueness}）`,
    actions: deliveryProbability >= target && blockingIssues === 0
      ? ['已达到当前质量目标，建议保持事实口径和导出前复核。']
      : [
          '按招标评审口径补齐短板维度：章节与强制模块缺失补完整性、项目专属数据补针对性、危大闭环与强制制度补合规性、责任频次闭环句式补可落地性、表格层级与数据一致补规范性、清理空话禁用词与重复句式降雷同。',
          '系统需优先修复阻断问题、扩大本地知识库检索、补抽结构化事实，并将未落位事实写入对应章节。',
        ],
  };
}

export function qualityReportIssues(report: DocumentQualityReport): ValidationIssue[] {
  if (report.passed) return [];
  return [{
    // 交付置信度说明是质量报告结论而非正文缺陷，按 info 计入，避免污染缺陷计分
    level: 'info',
    message: `交付置信度未达目标：${report.deliveryProbability}% / ${report.target}%`,
    suggestion: report.actions.join(' '),
  }];
}
