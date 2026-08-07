import type { DocumentQualityReport, DocumentReviewChecklistItem, ExportGateResult, RepairStrategy } from './types';

export function buildDocumentReviewChecklist(input: { exportGate: ExportGateResult; qualityReport: DocumentQualityReport; repairStrategies: RepairStrategy[] }): DocumentReviewChecklistItem[] {
  return [
    { key: 'export-gate', label: '导出门禁', passed: input.exportGate.passed, message: input.exportGate.passed ? '导出门禁通过' : `仍有 ${input.exportGate.blockingIssues.length} 个阻断问题` },
    { key: 'delivery-probability', label: '交付置信度', passed: input.qualityReport.passed, message: `${input.qualityReport.deliveryProbability}% / ${input.qualityReport.target}%` },
    { key: 'factuality', label: '事实准确性', passed: input.qualityReport.scores.factuality >= 85, message: `${input.qualityReport.scores.factuality}/100` },
    { key: 'evidence-coverage', label: '知识库证据覆盖', passed: input.qualityReport.scores.evidenceCoverage >= 85, message: `${input.qualityReport.scores.evidenceCoverage}/100` },
    { key: 'professional-depth', label: '专业深度', passed: input.qualityReport.scores.professionalDepth >= 80, message: `${input.qualityReport.scores.professionalDepth}/100` },
    { key: 'repair-strategies', label: '修复策略', passed: input.repairStrategies.filter(strategy => strategy.priority === 'high').length === 0, message: input.repairStrategies.map(strategy => strategy.title).join('、') || '无高优先级修复策略' },
  ];
}
