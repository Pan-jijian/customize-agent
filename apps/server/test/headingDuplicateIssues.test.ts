import { describe, expect, it } from 'vitest';
import { headingDuplicateIssues } from '../src/services/document-workflow/qualityValidation';

describe('同章同名小节重复检测（headingDuplicateIssues）', () => {
  it('同章内同名三级小节重复 2 次及以上给 warning', () => {
    const markdown = [
      '## 第一章 工程重点难点',
      '### 1.4 项目特点、重点、难点分析',
      '#### 1.4.1 工程难点分析',
      '难点一内容。',
      '#### 1.4.2 工程难点分析',
      '难点二内容。',
      '#### 1.4.3 工程难点分析',
      '难点三内容。',
    ].join('\n');
    const issues = headingDuplicateIssues(markdown);
    expect(issues.some(issue => issue.level === 'warning' && issue.message.includes('工程难点分析') && issue.message.includes('3 次'))).toBe(true);
  });

  it('同名小节仅出现一次不告警', () => {
    const markdown = [
      '## 第一章 工程重点难点',
      '#### 1.4.1 工程难点分析',
      '内容。',
      '#### 1.4.2 工程重点分析',
      '内容。',
    ].join('\n');
    expect(headingDuplicateIssues(markdown)).toEqual([]);
  });

  it('编号不同但名称相同的标题视为重复（1.4.3/1.4.5 均归一化为“工程难点分析”）', () => {
    const markdown = [
      '## 第一章 工程重点难点',
      '#### 1.4.3 工程难点分析',
      '内容一。',
      '#### 1.4.5 工程难点分析',
      '内容二。',
    ].join('\n');
    const issues = headingDuplicateIssues(markdown);
    expect(issues.some(issue => issue.message.includes('工程难点分析') && issue.message.includes('2 次'))).toBe(true);
  });

  it('不同章的同名小节互不干扰', () => {
    const markdown = [
      '## 第一章 工程重点难点',
      '#### 1.4.1 工程难点分析',
      '内容。',
      '## 第二章 确保工期与质量',
      '#### 2.14.1 工程难点分析',
      '内容。',
    ].join('\n');
    expect(headingDuplicateIssues(markdown)).toEqual([]);
  });

  it('重复告警数量上限 6 条（防风暴）', () => {
    const blocks: string[] = ['## 某章'];
    for (let index = 1; index <= 8; index += 1) {
      blocks.push(`#### 1.${index} 重复小节`);
      blocks.push(`内容${index}。`);
      blocks.push(`#### 1.${index}b 重复小节`);
      blocks.push(`内容${index}b。`);
    }
    const issues = headingDuplicateIssues(blocks.join('\n'));
    expect(issues.length).toBeLessThanOrEqual(6);
  });
});
