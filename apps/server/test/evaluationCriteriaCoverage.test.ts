import { describe, expect, it } from 'vitest';
import { evaluationCriteriaCoreKeywords, evaluationCriteriaCoverageIssues, innovationTechCoverageIssues, internalTerminologyIssues } from '../src/services/document-workflow/qualityValidation';

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
    const issues = evaluationCriteriaCoverageIssues('### 施工方案\n\n本章按传统 做法组织施工。', ['如有']);
    expect(issues).toHaveLength(0);
  });
});

describe('internalTerminologyIssues（内部术语泄漏保险丝）', () => {
  it('reports blocker when 后台术语"工作包"残留于正式正文', () => {
    const issues = internalTerminologyIssues('#### 1.3.1 拆除工程工作包\n\n以下按工作包逐项说明。');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.message).toContain('工作包');
  });

  it('passes when 正文已使用正式术语', () => {
    const issues = internalTerminologyIssues('#### 1.3.1 拆除工程\n\n以下按专业工程逐项说明。');
    expect(issues).toHaveLength(0);
  });
});

describe('innovationTechCoverageIssues（四新技术后置承接检查）', () => {
  it('大纲承诺四新但正文 0 次出现时报 warning', () => {
    const issues = innovationTechCoverageIssues('### 施工方案\n\n本章按传统做法组织施工。', [{ title: '确保工期与质量的保障体系与措施', sections: ['新技术、新工艺、新材料、新设备的应用'] }]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toContain('新技术');
  });

  it('正文已落位四新表述时不报', () => {
    const issues = innovationTechCoverageIssues('### 新技术新工艺应用\n\n本项目采用新材料与新设备组织施工。', [{ title: '确保工期与质量的保障体系与措施', sections: ['新技术、新工艺、新材料、新设备的应用'] }]);
    expect(issues).toHaveLength(0);
  });

  it('大纲未承诺四新时不制造新义务', () => {
    const issues = innovationTechCoverageIssues('### 施工方案\n\n传统做法。', [{ title: '工程概况', sections: ['项目基本信息'] }]);
    expect(issues).toHaveLength(0);
  });
});
