import type { DocumentWorkflowVersion } from './types';

export const DOCUMENT_WORKFLOW_VERSION: DocumentWorkflowVersion = {
  version: 'professional-document-workflow-v3',
  rules: [
    'complete-local-knowledge-assumption',
    'knowledge-coverage-recovery',
    'fact-trace-placement',
    'chapter-coverage-gate',
    'structured-quality-report',
    'post-repair-verification',
  ],
};
