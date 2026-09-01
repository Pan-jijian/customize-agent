/**
 * documentWorkflowVersion 单测：工作流版本对象口径。
 */
import { describe, expect, it } from 'vitest';
import { DOCUMENT_WORKFLOW_VERSION } from './documentWorkflowVersion';

describe('DOCUMENT_WORKFLOW_VERSION', () => {
  it('版本与规则清单', () => {
    expect(DOCUMENT_WORKFLOW_VERSION.version).toBe('professional-document-workflow-v8');
    expect(DOCUMENT_WORKFLOW_VERSION.rules).toHaveLength(6);
    expect(DOCUMENT_WORKFLOW_VERSION.rules).toContain('fact-trace-placement');
    expect(DOCUMENT_WORKFLOW_VERSION.rules).toContain('post-repair-verification');
  });
});
