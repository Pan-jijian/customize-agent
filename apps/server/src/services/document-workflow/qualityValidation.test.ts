/**
 * h13d qualityValidation 单测：目录三级小节完整性 + 截断词表扩展。
 * 均为 L2 确定性结构检测，无需语义通道。
 */
import { describe, expect, it } from 'vitest';
import { formalContentIntegrityIssues, formalPlaceholderIssues, tocThirdLevelCompletenessIssues } from './qualityValidation';

describe('tocThirdLevelCompletenessIssues（h13d 目录三级小节完整性）', () => {
  it('正文存在三级小节而目录未收录 → 报 blocker', () => {
    const markdown = [
      '## 目录',
      '第三章 施工部署',
      '  3.1 施工部署与施工流水组织',
      '<div class="page-break"></div>',
      '## 第三章 施工部署',
      '#### 3.1.1 土方外运及基坑支护工程',
      '本小节内容。',
      '#### 3.1.2 地基与基础工程',
      '本小节内容。',
    ].join('\n');
    const issues = tocThirdLevelCompletenessIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('缺失');
  });

  it('目录收录全部三级小节 → 不报', () => {
    const markdown = [
      '## 目录',
      '第三章 施工部署',
      '  3.1 施工部署与施工流水组织',
      '    3.1.1 土方外运及基坑支护工程',
      '    3.1.2 地基与基础工程',
      '<div class="page-break"></div>',
      '## 第三章 施工部署',
      '#### 3.1.1 土方外运及基坑支护工程',
      '本小节内容。',
      '#### 3.1.2 地基与基础工程',
      '本小节内容。',
    ].join('\n');
    expect(tocThirdLevelCompletenessIssues(markdown)).toEqual([]);
  });

  it('正文无三级小节 → 不检测', () => {
    const markdown = [
      '## 目录',
      '第三章 施工部署',
      '  3.1 施工部署与施工流水组织',
      '<div class="page-break"></div>',
      '## 第三章 施工部署',
      '本段为二级小节正文。',
    ].join('\n');
    expect(tocThirdLevelCompletenessIssues(markdown)).toEqual([]);
  });
});

describe('formalContentIntegrityIssues 截断词表扩展（h13c）', () => {
  it('以「复查合格后」结尾且无句号 → 报截断句', () => {
    const issues = formalContentIntegrityIssues('材料进场检查发现不合格品立即隔离退场，复查合格后');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });

  it('以「设计风」结尾（行尾截断形态）→ 报截断句', () => {
    const issues = formalContentIntegrityIssues('风管严密性试验压力按系统工作压力确定，实测风量与设计风');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });

  it('完整成句（句号收尾）→ 不报截断句', () => {
    const issues = formalContentIntegrityIssues('质检员每周对库存材料进行1次状态检查，复查合格后方可投入使用。');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(false);
  });
});

describe('formalPlaceholderIssues 占位式表达（h13c 词表扩展）', () => {
  it('「依据本项目已确认资料」占位式表达 → 报', () => {
    const issues = formalPlaceholderIssues('锚杆注浆压力依据本项目已确认资料确定。');
    expect(issues.some(issue => /占位式表达/u.test(issue.message))).toBe(true);
  });

  it('正常事实表述 → 不报', () => {
    const issues = formalPlaceholderIssues('锚杆注浆压力按0.4MPa～0.6MPa控制。');
    expect(issues.some(issue => /占位式表达/u.test(issue.message))).toBe(false);
  });
});
