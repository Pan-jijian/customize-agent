import { describe, expect, it } from 'vitest';
import { listDocumentTemplates, validateDocumentTemplateRun } from '../src/services/documentWorkflowService';

describe('document workflow templates', () => {
  it('does not expose built-in demo templates', async () => {
    expect(listDocumentTemplates().some(template => template.builtIn)).toBe(false);
    const validation = await validateDocumentTemplateRun('delta-force-hot-operators-guide');
    expect(validation.issues.some(issue => issue.level === 'error')).toBe(true);
  });
});
