import type { DocumentWorkflowVersion } from './types';

export const DOCUMENT_WORKFLOW_VERSION: DocumentWorkflowVersion = {
  // 4.50 交付解耦 + 门禁链两波根治（r8/r9 定因）：①终态语义变化——门禁未过由 failed 改为
  // completed_with_issues（交付解耦：不阻断查看与导出，残留转人工复核清单）；②检测/修复口径变化
  // （precise 池清洗与归一双端匹配、requirements-coverage 链尾收口、pump 词面分池校准等）。
  // bump 使旧口径 checkpoint（含 failed 终态时期的章节快照）不再被复用
  version: 'professional-document-workflow-v12',
  rules: [
    'complete-local-knowledge-assumption',
    'knowledge-coverage-recovery',
    'fact-trace-placement',
    'chapter-coverage-gate',
    'structured-quality-report',
    'post-repair-verification',
  ],
};
