import { describe, expect, it } from 'vitest';
import { evaluationCriteriaCoreKeywords, evaluationCriteriaCoverageIssues } from '../src/services/document-workflow/qualityValidation';

describe('evaluationCriteriaCoreKeywords', () => {
  it('extracts core keywords from criterion titles, stripping framework prefixes and brackets', () => {
    const keywords = evaluationCriteriaCoreKeywords('拟采用的新技术、新工艺（如有）');
    expect(keywords).toContain('新技术');
    expect(keywords).toContain('新工艺');
  });

  it('splits compound titles on conjunction separators and drops framework stop words', () => {
    const keywords = evaluationCriteriaCoreKeywords('施工进度计划与工期保障措施');
    expect(keywords).toContain('施工进度计划');
    expect(keywords).toContain('工期保障措施');
  });

  it('returns empty array for titles with no usable core words', () => {
    expect(evaluationCriteriaCoreKeywords('如有（如有）')).toEqual([]);
  });
});

describe('evaluationCriteriaCoverageIssues（评分条目正文命中后置校验）', () => {
  it('reports warning when no core keyword of the criterion appears in the final markdown', () => {
    const issues = evaluationCriteriaCoverageIssues('### 施工方案\n\n本章按传统做法组织施工。', ['拟采用的新技术、新工艺（如有）']);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toContain('新技术');
  });

  it('passes when any core keyword appears in the markdown', () => {
    const issues = evaluationCriteriaCoverageIssues('### 新技术新工艺应用\n\n本项目采用新技术与新工艺组织施工。', ['拟采用的新技术、新工艺（如有）']);
    expect(issues).toHaveLength(0);
  });

  it('passes silently for items without extractable core keywords', () => {
    const issues = evaluationCriteriaCoverageIssues('### 施工方案\n\n本章按传统做法组织施工。', ['如有']);
    expect(issues).toHaveLength(0);
  });
});
