import type { DocumentWorkflowVersion } from './types';

export const DOCUMENT_WORKFLOW_VERSION: DocumentWorkflowVersion = {
  // round-26（P0/P1 缓存优化）：L0 全流程公共前缀（P0-2）+ 规划证据预算（P0-1）+ 两步瘦身（P0-3）+
  // 证据预算收紧（P0-4）+ 评审复检瘦身（P1-1）+ patch 空白容错（P1-2）+ 同前缀相邻调度（P1-3）+
  // 截断 JSON 确定性修复（P1-4）；system/user 输入结构整体变化，bump 使旧 checkpoint（旧前缀缓存快照）不再被复用
  version: 'professional-document-workflow-v8',
  rules: [
    'complete-local-knowledge-assumption',
    'knowledge-coverage-recovery',
    'fact-trace-placement',
    'chapter-coverage-gate',
    'structured-quality-report',
    'post-repair-verification',
  ],
};
