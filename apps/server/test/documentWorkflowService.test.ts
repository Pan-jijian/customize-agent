import { describe, expect, it } from 'vitest';
import { validateDocumentTemplateRun } from '../src/services/documentWorkflowService';

describe('built-in document workflow templates', () => {
  it('allows the official built-in template to pass preflight validation', async () => {
    const validation = await validateDocumentTemplateRun('delta-force-hot-operators-guide');
    expect(validation.fileDiagnostics.length).toBeGreaterThan(0);
    expect(validation.promptDiagnostics.length).toBeGreaterThan(0);
    expect(validation.issues.filter(issue => issue.level === 'error')).toEqual([]);
  });
});
