import type { DocumentWorkflowVersion } from './types';

export const DOCUMENT_WORKFLOW_VERSION: DocumentWorkflowVersion = {
  // round-26（评分项要求提取治理）：字段级定向补提闭环覆盖全部评分项要求字段（P0/P1 缓存优化
  // L0 公共前缀/证据预算/两步瘦身/评审瘦身/patch 容错/同前缀调度/截断修复）+ 评标办法/篇幅要求
  // 字段从提取链路移除——评分项要求提取结果口径变化，bump 使旧 checkpoint（旧提取结果快照）不再被复用
  version: 'professional-document-workflow-v9',
  rules: [
    'complete-local-knowledge-assumption',
    'knowledge-coverage-recovery',
    'fact-trace-placement',
    'chapter-coverage-gate',
    'structured-quality-report',
    'post-repair-verification',
  ],
};
