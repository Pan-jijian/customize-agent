import type { DocumentWorkflowVersion } from './types';

export const DOCUMENT_WORKFLOW_VERSION: DocumentWorkflowVersion = {
  // round-25d：focused writer/组级证据头部盲截根治（520/1400 字 slice(0,n) → 关键参数窗口提取）+ 窗口 header 自适应；
  // round-25c 的窗口提取只覆盖 evidenceBundlePrompt 渲染层，本轮长文管线实际走 focused writer 路径仍盲截，
  // 基坑底标高/坡率参数从未进入写手上下文；bump 使旧 checkpoint（缺基坑参数证据）不再被复用
  version: 'professional-document-workflow-v7',
  rules: [
    'complete-local-knowledge-assumption',
    'knowledge-coverage-recovery',
    'fact-trace-placement',
    'chapter-coverage-gate',
    'structured-quality-report',
    'post-repair-verification',
  ],
};
